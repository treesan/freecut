/**
 * Path Resolution Waterfall for freecut-refs/1.0 imports.
 *
 * For each `media[i]` reference in a `.freecut.json`, the importer tries
 * resolution in this order (D3):
 *
 *   1. Workspace media library match (fileName + fileSize + fileLastModified)
 *   2. pathHints.relativeToJson (from JSON directory handle)
 *   3. pathHints.absolute (via authorized-root traversal)
 *   4. Authorized-root descendant scan (lazy, fileName + size + mtime)
 *   5. User-picker fallback (directory or per-file)
 *
 * Every successful resolution is identity-validated (fileSize + fileLastModified).
 * Mismatches produce `ResolutionFailure { kind: 'identity-mismatch' }`.
 */

import type { RefsMediaEntry, RefsResolutionFailure } from '../types/refs'
import type { MediaMetadata } from '@/types/storage'
import {
  listAuthorizedRoots,
  addAuthorizedRoot,
  touchAuthorizedRoot,
  ensureRootPermission,
} from '@/infrastructure/storage/authorized-roots'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('PathResolution')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context needed by the resolver — built once per import. */
export interface ResolutionContext {
  /** Handle for the directory containing the imported `.freecut.json` */
  jsonDirectoryHandle?: FileSystemDirectoryHandle
  /** Index of workspace media, keyed by identity triple */
  workspaceMediaIndex: WorkspaceMediaIndex
  /** Authorized roots (loaded + permission-checked) */
  authorizedRoots: AuthorizedRootEntry[]
}

export interface WorkspaceMediaIndex {
  /** Key: `${fileName}:${fileSize}:${fileLastModified}` → MediaMetadata */
  byIdentity: Map<string, MediaMetadata>
}

export interface AuthorizedRootEntry {
  id: string
  displayName: string
  handle: FileSystemDirectoryHandle
}

/** Successful resolution outcome. */
export interface ResolutionSuccess {
  kind: 'resolved'
  /** The file handle — import creates MediaMetadata { storageType: 'handle' } */
  fileHandle: FileSystemFileHandle
  /** File size in bytes (from the actual file) */
  fileSize: number
  /** File lastModified in ms (from the actual file) */
  fileLastModified: number
  /** If this was a workspace library match, the existing mediaId to reuse */
  existingMediaId?: string
  /** Which authorized root contributed to this resolution (for touch) */
  authorizedRootId?: string
}

export type ResolutionOutcome = ResolutionSuccess | RefsResolutionFailure

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max directory depth to scan during authorized-root descendant search. */
const SCAN_MAX_DEPTH = 8

/** Max total entries to scan per root before giving up. */
const SCAN_MAX_ENTRIES_PER_ROOT = 10_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function identityKey(fileName: string, fileSize: number, fileLastModified: number): string {
  return `${fileName}:${fileSize}:${fileLastModified}`
}

/**
 * Read identity from a FileSystemFileHandle by obtaining the File and
 * reading `size` + `lastModified`.
 */
async function readFileIdentity(
  handle: FileSystemFileHandle,
): Promise<{ size: number; lastModified: number } | null> {
  try {
    const file = await handle.getFile()
    return { size: file.size, lastModified: file.lastModified }
  } catch (error) {
    logger.warn('readFileIdentity failed', error)
    return null
  }
}

/**
 * Validate that a candidate file matches the expected identity.
 * Returns null on match, or a ResolutionFailure on mismatch.
 */
/**
 * Tolerance (ms) for the `fileLastModified` identity check.
 *
 * External exporters (e.g. the video-use Python tool) compute mtime with
 * `round(st_mtime * 1000)`, while the browser's `File.lastModified` is a
 * floor/truncation of the same value. For mtimes whose sub-second part has
 * floating-point representation drift (e.g. 1763180881.1699998 instead of
 * .17), `round` and `floor` land 1ms apart and the strict equality check
 * rejects a genuinely-matching file.
 *
 * `fileSize` remains an exact match (it is the stronger fingerprint and has
 * no rounding ambiguity). A ±1ms window only absorbs sub-millisecond
 * float representation noise — sync-client mtime rewrites (Dropbox/iCloud,
 * typically seconds-scale) still fall outside it and are correctly rejected
 * per the B1 strict-identity decision.
 */
const MTIME_TOLERANCE_MS = 1

function validateIdentity(
  entry: RefsMediaEntry,
  actualSize: number,
  actualLastModified: number,
): RefsResolutionFailure | null {
  const sizeMatches = actualSize === entry.fileSize
  const mtimeMatches = Math.abs(actualLastModified - entry.fileLastModified) <= MTIME_TOLERANCE_MS
  if (!sizeMatches || !mtimeMatches) {
    return {
      ref: entry.ref,
      fileName: entry.fileName,
      kind: 'identity-mismatch',
      message: `Identity mismatch for ${entry.fileName}: expected size=${entry.fileSize} mtime=${entry.fileLastModified}, got size=${actualSize} mtime=${actualLastModified}`,
      expected: { fileSize: entry.fileSize, fileLastModified: entry.fileLastModified },
      actual: { fileSize: actualSize, fileLastModified: actualLastModified },
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Step 1: Workspace media library match
// ---------------------------------------------------------------------------

async function resolveFromWorkspace(
  entry: RefsMediaEntry,
  ctx: ResolutionContext,
): Promise<ResolutionOutcome | null> {
  const key = identityKey(entry.fileName, entry.fileSize, entry.fileLastModified)
  const existing = ctx.workspaceMediaIndex.byIdentity.get(key)
  if (!existing) return null

  // Workspace match — reuse existing mediaId, no new handle needed
  return {
    kind: 'resolved',
    fileHandle: existing.fileHandle!,
    fileSize: existing.fileSize,
    fileLastModified: existing.fileLastModified ?? 0,
    existingMediaId: existing.id,
  }
}

// ---------------------------------------------------------------------------
// Step 2: pathHints.relativeToJson
// ---------------------------------------------------------------------------

async function resolveFromRelativePath(
  entry: RefsMediaEntry,
  ctx: ResolutionContext,
): Promise<ResolutionOutcome | null> {
  if (!ctx.jsonDirectoryHandle) return null

  const segments = entry.pathHints.relativeToJson.split('/').filter(Boolean)
  let current: FileSystemDirectoryHandle = ctx.jsonDirectoryHandle

  // Walk all segments except the last (which is the filename)
  for (let i = 0; i < segments.length - 1; i++) {
    try {
      current = await current.getDirectoryHandle(segments[i]!)
    } catch {
      return null // Path segment not found
    }
  }

  // The last segment is the filename
  const fileName = segments[segments.length - 1]
  if (!fileName) return null

  let fileHandle: FileSystemFileHandle
  try {
    fileHandle = await current.getFileHandle(fileName)
  } catch {
    return null // File not found
  }

  const identity = await readFileIdentity(fileHandle)
  if (!identity) return null

  const mismatch = validateIdentity(entry, identity.size, identity.lastModified)
  if (mismatch) return mismatch

  return {
    kind: 'resolved',
    fileHandle,
    fileSize: identity.size,
    fileLastModified: identity.lastModified,
  }
}

// ---------------------------------------------------------------------------
// Step 3: pathHints.absolute via authorized-root traversal
// ---------------------------------------------------------------------------

async function resolveFromAbsolutePath(
  entry: RefsMediaEntry,
  ctx: ResolutionContext,
): Promise<ResolutionOutcome | null> {
  if (!entry.pathHints.absolute) return null

  // The browser cannot compare handle paths to absolute path strings, so step 3
  // cannot deterministically match an absolute path to an authorized root. It's
  // kept as a stub for future non-browser consumers (e.g. a Node.js CLI that
  // can read real paths). Browser imports fall through to step 4's descendant
  // scan. Returning null here keeps the waterfall order intact.
  void entry
  void ctx
  return null
}

// ---------------------------------------------------------------------------
// Step 4: Authorized-root descendant scan
// ---------------------------------------------------------------------------

async function resolveFromAuthorizedRootScan(
  entry: RefsMediaEntry,
  ctx: ResolutionContext,
): Promise<ResolutionOutcome | null> {
  for (const root of ctx.authorizedRoots) {
    const result = await scanDirectoryForMatch(root.handle, entry, root.id, 0, { count: 0 })
    if (result) return result
  }
  return null
}

interface ScanCounter {
  count: number
}

/**
 * Recursively scan a directory for a file matching the identity triple.
 * Depth-first with shortcut on first match.
 */
async function scanDirectoryForMatch(
  dirHandle: FileSystemDirectoryHandle,
  entry: RefsMediaEntry,
  rootId: string,
  depth: number,
  counter: ScanCounter,
): Promise<ResolutionOutcome | null> {
  if (depth > SCAN_MAX_DEPTH || counter.count >= SCAN_MAX_ENTRIES_PER_ROOT) {
    return null
  }

  let dirEntries: AsyncIterableIterator<[string, FileSystemHandle]>
  try {
    dirEntries = dirHandle.entries()
  } catch {
    return null
  }

  for await (const [name, handle] of dirEntries) {
    counter.count++
    if (counter.count > SCAN_MAX_ENTRIES_PER_ROOT) return null

    if (handle.kind === 'file') {
      // Quick name filter before expensive identity check
      if (name !== entry.fileName) continue

      const fileHandle = handle as FileSystemFileHandle
      const identity = await readFileIdentity(fileHandle)
      if (!identity) continue

      const mismatch = validateIdentity(entry, identity.size, identity.lastModified)
      if (mismatch) return mismatch

      return {
        kind: 'resolved',
        fileHandle,
        fileSize: identity.size,
        fileLastModified: identity.lastModified,
        authorizedRootId: rootId,
      }
    }

    if (handle.kind === 'directory') {
      // Only recurse if the filename could be a descendant
      const result = await scanDirectoryForMatch(
        handle as FileSystemDirectoryHandle,
        entry,
        rootId,
        depth + 1,
        counter,
      )
      if (result) return result
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Step 5: User-picker fallback
// ---------------------------------------------------------------------------

/**
 * Interactive fallback — prompts user to locate unresolved media.
 * Returns updated resolution results for all entries the user resolved.
 *
 * This is designed to be called from the UI layer. The caller is responsible
 * for invoking `showDirectoryPicker()` / `showOpenFilePicker()` and feeding
 * the results back.
 */
export async function resolveViaPicker(
  unresolvedEntries: RefsMediaEntry[],
  userPickedDirectory: FileSystemDirectoryHandle,
  registerAsRoot: boolean,
): Promise<Map<string, ResolutionOutcome>> {
  const results = new Map<string, ResolutionOutcome>()

  // Optionally register as new authorized root
  let rootId: string | undefined
  if (registerAsRoot) {
    const root = await addAuthorizedRoot(userPickedDirectory)
    rootId = root.id
  }

  // Scan the picked directory for matches
  for (const entry of unresolvedEntries) {
    const result = await scanDirectoryForMatch(userPickedDirectory, entry, rootId ?? '', 0, {
      count: 0,
    })
    if (result && result.kind === 'resolved') {
      results.set(entry.ref, result)
    }
  }

  return results
}

/**
 * Resolve a single media ref via per-file picker.
 */
export async function resolveViaFilePicker(
  entry: RefsMediaEntry,
  fileHandle: FileSystemFileHandle,
): Promise<ResolutionOutcome> {
  const identity = await readFileIdentity(fileHandle)
  if (!identity) {
    return {
      ref: entry.ref,
      fileName: entry.fileName,
      kind: 'not-found',
      message: `Could not read identity from picked file for ${entry.fileName}`,
    }
  }

  const mismatch = validateIdentity(entry, identity.size, identity.lastModified)
  if (mismatch) return mismatch

  return {
    kind: 'resolved',
    fileHandle,
    fileSize: identity.size,
    fileLastModified: identity.lastModified,
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a single media reference through the 5-step waterfall.
 *
 * Stops at the first successful identity-validated match.
 * Returns `ResolutionOutcome` — either a success or a failure.
 */
export async function resolveMediaRef(
  entry: RefsMediaEntry,
  ctx: ResolutionContext,
): Promise<ResolutionOutcome> {
  // Step 1: Workspace media library match
  const workspaceResult = await resolveFromWorkspace(entry, ctx)
  if (workspaceResult) return workspaceResult

  // Step 2: pathHints.relativeToJson
  const relativeResult = await resolveFromRelativePath(entry, ctx)
  if (relativeResult) {
    if (relativeResult.kind === 'resolved') {
      logger.debug(`Resolved ${entry.fileName} via relativeToJson`)
    }
    return relativeResult
  }

  // Step 3: pathHints.absolute (via authorized-root traversal)
  const absoluteResult = await resolveFromAbsolutePath(entry, ctx)
  if (absoluteResult) {
    if (absoluteResult.kind === 'resolved') {
      logger.debug(`Resolved ${entry.fileName} via absolute path`)
    }
    return absoluteResult
  }

  // Step 4: Authorized-root descendant scan
  const scanResult = await resolveFromAuthorizedRootScan(entry, ctx)
  if (scanResult) {
    if (scanResult.kind === 'resolved') {
      logger.debug(`Resolved ${entry.fileName} via authorized-root scan`)
    }
    return scanResult
  }

  // Step 5: User-picker — not handled here, returned as unresolved
  return {
    ref: entry.ref,
    fileName: entry.fileName,
    kind: 'not-found',
    message: `Could not resolve ${entry.fileName} through automatic steps. User picker required.`,
  }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Build the resolution context needed for an import.
 * Loads authorized roots, checks permissions, and builds the workspace index.
 */
export async function buildResolutionContext(
  workspaceMedia: MediaMetadata[],
  jsonDirectoryHandle?: FileSystemDirectoryHandle,
): Promise<ResolutionContext> {
  // Build workspace media index
  const byIdentity = new Map<string, MediaMetadata>()
  for (const media of workspaceMedia) {
    const key = identityKey(media.fileName, media.fileSize, media.fileLastModified ?? 0)
    byIdentity.set(key, media)
  }

  // Load authorized roots with permission check
  const allRoots = await listAuthorizedRoots()
  const authorizedRoots: AuthorizedRootEntry[] = []

  for (const root of allRoots) {
    const permitted = await ensureRootPermission(root.handle)
    if (permitted) {
      authorizedRoots.push({
        id: root.id,
        displayName: root.displayName,
        handle: root.handle,
      })
    } else {
      logger.warn(`Authorized root "${root.displayName}" permission denied, skipping`)
    }
  }

  return {
    jsonDirectoryHandle,
    workspaceMediaIndex: { byIdentity },
    authorizedRoots,
  }
}

/**
 * Touch (update lastUsedAt) on all authorized roots that contributed
 * to successful resolutions.
 */
export async function touchUsedAuthorizedRoots(outcomes: ResolutionOutcome[]): Promise<void> {
  const touchedIds = new Set<string>()
  for (const outcome of outcomes) {
    if (
      outcome.kind === 'resolved' &&
      outcome.authorizedRootId &&
      !touchedIds.has(outcome.authorizedRootId)
    ) {
      await touchAuthorizedRoot(outcome.authorizedRootId)
      touchedIds.add(outcome.authorizedRootId)
    }
  }
}
