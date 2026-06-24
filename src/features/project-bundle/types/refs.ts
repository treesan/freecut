/**
 * Path-Reference Format Types
 *
 * Defines the lightweight `.freecut.json` (freecut-refs/1.0) format that carries
 * a complete project + timeline with media *references* (path hints, size, mtime)
 * instead of media bytes. This enables sub-second project handoff when source
 * files already exist on the user's machine (e.g. video-use → FreeCut workflow).
 */

import type { Project, ProjectTimeline } from '@/types/project'

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** JSON discriminator — must be `"freecut-refs"` */
export const REFS_KIND = 'freecut-refs' as const

/** Format version — owns its own version line, separate from snapshot */
export const REFS_VERSION = '1.0' as const

/** File extension for path-reference projects */
export const REFS_EXTENSION = '.freecut.json' as const

/**
 * UUID v5 namespace for deterministic mediaRef derivation.
 *
 * Generated from `uuidv5(URL_NAMESPACE, 'freecut-refs/media')` so it is
 * globally unique and reproducible.
 */
export const FREECUT_REFS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8' as const

// ---------------------------------------------------------------------------
// Timeline adaptation (mirrors BundleTimeline pattern)
// ---------------------------------------------------------------------------

type RefsTimelineItem = Omit<ProjectTimeline['items'][number], 'mediaId'> & {
  mediaRef?: string
  [key: string]: unknown
}

type RefsComposition = Omit<NonNullable<ProjectTimeline['compositions']>[number], 'items'> & {
  items: RefsTimelineItem[]
}

type RefsTimeline = Omit<ProjectTimeline, 'items' | 'compositions'> & {
  items: RefsTimelineItem[]
  compositions?: RefsComposition[]
}

// ---------------------------------------------------------------------------
// Media entry (path-reference format)
// ---------------------------------------------------------------------------

/**
 * Path hints for locating a media file relative to the project JSON.
 */
export interface RefsPathHints {
  /**
   * Relative path from the `.freecut.json` file to the media file.
   * Always uses forward-slash separators (UNIX-style), regardless of host OS.
   * On import, Windows paths are normalised in both directions.
   */
  relativeToJson: string

  /**
   * Absolute path on the originating machine.
   * Optional — omitted when:
   *   - `stripPaths` export option is enabled, OR
   *   - The source media is a `FileSystemFileHandle` whose absolute path
   *     cannot be recovered in the browser.
   */
  absolute?: string
}

/**
 * A single media entry in the `.freecut.json` `media[]` array.
 *
 * Unlike `BundleMediaEntry`, this does NOT include `sha256` — identity is
 * established by `fileSize + fileLastModified` (strict, D2).
 */
export interface RefsMediaEntry {
  /**
   * Deterministic identifier derived from the source file's absolute path:
   * `uuidv5(FREECUT_REFS_NAMESPACE, sha256(absolutePath))`.
   * Stable across regenerations of the same source, enabling round-trip.
   */
  ref: string

  fileName: string

  /** File size in bytes — part of strict identity validation */
  fileSize: number

  /** File last-modified timestamp in milliseconds (matches `File.lastModified`) */
  fileLastModified: number

  mimeType: string

  metadata: {
    duration: number
    width: number
    height: number
    fps: number
    codec: string
    bitrate: number
  }

  pathHints: RefsPathHints
}

// ---------------------------------------------------------------------------
// Top-level format
// ---------------------------------------------------------------------------

/**
 * The complete `.freecut.json` document structure.
 */
export interface RefsProject {
  /** Format discriminator — always `"freecut-refs"` */
  kind: typeof REFS_KIND

  /** Format version — `"1.0"` */
  version: string

  /** ISO timestamp when the file was exported */
  exportedAt: string

  /** Editor version that created this file */
  editorVersion: string

  /** Complete project data (timeline, tracks, items, markers, etc.) */
  project: Omit<Project, 'timeline'> & {
    id: string
    timeline?: RefsTimeline
  }

  /** Media references (path-based, no bytes) */
  media: RefsMediaEntry[]

  /**
   * Optional SHA-256 integrity checksum over the document with the `checksum`
   * field blanked. Computed on export via the shared `computeProjectChecksum`
   * helper (same canonicalization as the snapshot format). Verified on import
   * as a non-fatal warning — the strict `fileSize + fileLastModified` identity
   * gate remains the authoritative media check. Omitted by older files.
   */
  checksum?: string
}

// ---------------------------------------------------------------------------
// Export options
// ---------------------------------------------------------------------------

export interface RefsExportOptions {
  /** Omit `pathHints.absolute` from every media entry for safe sharing */
  stripPaths?: boolean

  /** Pretty-print the JSON output (default: true) */
  prettyPrint?: boolean

  /** Override the display name of the output file (without extension) */
  displayName?: string

  /** Compute and write a `checksum` field (default: true). Mirrors the snapshot
   * format's `includeChecksum`. The export dialog does not expose a UI toggle
   * (checksum-on is always correct for real use); the option exists for parity
   * and for tests that want deterministic output without a checksum. */
  includeChecksum?: boolean
}

export interface RefsExportResult {
  /** The filename that was written (e.g. `"My Project.freecut.json"`) */
  filename: string
  /** Number of media entries in the exported file */
  mediaCount: number
  /** Whether any OPFS spillover occurred (`.media/` sibling directory) */
  opfsSpillover: boolean
}

// ---------------------------------------------------------------------------
// Import options & result
// ---------------------------------------------------------------------------

export interface RefsImportOptions {
  /** Override project name on import */
  newProjectName?: string
  /** Destination directory for the imported project */
  destinationDirectory?: FileSystemDirectoryHandle
}

/**
 * Reason a media reference could not be resolved.
 */
export type RefsResolutionFailureKind =
  | 'not-found'
  | 'identity-mismatch'
  | 'permission-denied'
  | 'user-cancelled'

/**
 * Details about a single media resolution failure.
 */
export interface RefsResolutionFailure {
  /** The `media[i].ref` that failed */
  ref: string
  /** The `media[i].fileName` for display */
  fileName: string
  /** Why resolution failed */
  kind: RefsResolutionFailureKind
  /** Human-readable description */
  message: string
  /** Present when `kind === 'identity-mismatch'` */
  expected?: { fileSize: number; fileLastModified: number }
  actual?: { fileSize: number; fileLastModified: number }
}

export interface RefsImportResult {
  /** The created project */
  project: Project
  /** Number of media entries successfully resolved */
  mediaImported: number
  /** Number of media entries that could not be resolved */
  mediaUnresolved: number
  /** Per-media failure details for unresolved entries */
  failures: RefsResolutionFailure[]
}
