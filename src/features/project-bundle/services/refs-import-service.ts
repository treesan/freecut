/**
 * Refs Import Service — imports a `.freecut.json` (freecut-refs/1.0) project.
 *
 * Reads the JSON, validates it, resolves each media reference through the
 * 5-step path-resolution waterfall, creates MediaMetadata entries, and
 * persists the project.
 */

import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type {
  RefsProject,
  RefsImportOptions,
  RefsImportResult,
  RefsResolutionFailure,
} from '../types/refs'
import { validateRefsProject, formatValidationErrors } from '../schemas/refs-schema'
import {
  createProject,
  createMedia,
  associateMediaWithProject,
  getAllMediaMetadata,
} from '@/infrastructure/storage'
import { generateThumbnail } from '@/features/project-bundle/deps/media-library'
import { createLogger } from '@/shared/logging/logger'
import {
  resolveMediaRef,
  buildResolutionContext,
  touchUsedAuthorizedRoots,
  type ResolutionOutcome,
} from './path-resolution'
import { restoreTimelineFromBundle } from './bundle-timeline'
import { migrateProject } from '@/shared/projects/migrations'
import { computeProjectChecksum } from './pure-utils'
import { importProjectFromJsonString } from './json-import-service'
import { validateSnapshotData } from './json-import-service'

const logger = createLogger('RefsImportService')

// ---------------------------------------------------------------------------
// Format auto-detection
// ---------------------------------------------------------------------------

/**
 * A `freecut-refs/1.0` document carries an explicit `kind: "freecut-refs"`
 * discriminator. This is the authoritative refs marker (D1).
 */
function isRefsDocument(parsed: unknown): parsed is RefsProject {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === 'freecut-refs'
  )
}

/**
 * A debug `ProjectSnapshot` has a `project` field but no `kind` (snapshots
 * predate the discriminator). `mediaReferences` is typical but a snapshot
 * could in theory omit it; `project` is always present. Detection is only
 * routing — the snapshot's own `validateSnapshotData` does the real check.
 *
 * Any document carrying a `kind` that isn't `"freecut-refs"` (a future third
 * format) intentionally does NOT match here, so it falls through to the
 * aggregated error rather than misrouting to snapshot import.
 */
function isSnapshotDocument(parsed: unknown): boolean {
  return typeof parsed === 'object' && parsed !== null && !('kind' in parsed) && 'project' in parsed
}

/**
 * Map refs import options onto the snapshot import options where they
 * overlap. Snapshot media-matching flags are left at their own defaults
 * (true); snapshot import matches media only against the existing workspace.
 */
function toSnapshotImportOptions(options: RefsImportOptions): { newProjectName?: string } {
  const mapped: { newProjectName?: string } = {}
  if (options.newProjectName !== undefined) {
    mapped.newProjectName = options.newProjectName
  }
  return mapped
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

/**
 * Import a project from a `.freecut.json` path-reference file.
 *
 * @param jsonFileHandle - Handle for the `.freecut.json` file
 * @param jsonDirectoryHandle - Handle for the directory containing the JSON
 *   (may be undefined if the user hasn't granted directory access yet; step 2
 *   of the waterfall will prompt when needed per D10 strategy B)
 * @param options - Import options
 * @param onProgress - Progress callback (reuses ImportProgress shape)
 */
export async function importProjectFromRefs(
  jsonFileHandle: FileSystemFileHandle,
  jsonDirectoryHandle: FileSystemDirectoryHandle | undefined,
  options: RefsImportOptions = {},
  onProgress?: (progress: { percent: number; stage: string; currentFile?: string }) => void,
): Promise<RefsImportResult> {
  // Step 1: Read + parse the JSON file
  onProgress?.({ percent: 0, stage: 'validating' })

  const file = await jsonFileHandle.getFile()
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Step 2: Detect document format and dispatch. The `.freecut.json`
  // extension is shared by the refs (freecut-refs/1.0) format and the debug
  // `ProjectSnapshot` format. Detection is by document shape: `kind` is the
  // refs discriminator; a `project` field without `kind` denotes a snapshot.
  // Neither shape → aggregated error. See design D1/D2.
  if (!isRefsDocument(parsed)) {
    if (isSnapshotDocument(parsed)) {
      // Delegate to the snapshot import path. It takes the raw JSON string and
      // matches media only against the existing workspace library (snapshot
      // semantics). Snapshot import is fast (no file IO beyond reading the
      // JSON), so progress is best-effort: validate → complete.
      onProgress?.({ percent: 10, stage: 'validating' })
      const snapshotResult = await importProjectFromJsonString(
        text,
        toSnapshotImportOptions(options),
      )
      onProgress?.({ percent: 100, stage: 'complete' })

      // Adapt the snapshot result to the refs result shape.
      return {
        project: snapshotResult.project,
        mediaImported: snapshotResult.matchedMedia.length,
        mediaUnresolved: snapshotResult.unmatchedMedia.length,
        failures: [],
      }
    }

    // Neither shape matched — produce a single aggregated error combining
    // both validators' messages so the user sees why neither format applied.
    const refsValidation = validateRefsProject(parsed)
    const refsErrors = refsValidation.success
      ? []
      : refsValidation.errors
        ? formatValidationErrors(refsValidation.errors).map((m) => `refs: ${m}`)
        : ['refs: unknown validation error']
    let snapshotErrors: string[] = []
    try {
      const snapshotValidation = await validateSnapshotData(parsed)
      snapshotErrors = snapshotValidation.errors.map((m) => `snapshot: ${m.message}`)
    } catch {
      snapshotErrors = ['snapshot: could not validate']
    }
    const allErrors = [...refsErrors, ...snapshotErrors]
    throw new Error(
      `Unrecognized .freecut.json format — document is neither a refs nor a snapshot project${
        allErrors.length > 0 ? `: ${allErrors.join('; ')}` : ''
      }`,
    )
  }

  // Step 3: Validate as a refs document
  const validation = validateRefsProject(parsed)
  if (!validation.success || !validation.data) {
    const errors = validation.errors
      ? formatValidationErrors(validation.errors).join('; ')
      : 'Unknown validation error'
    throw new Error(`Invalid .freecut.json: ${errors}`)
  }

  const refsProject = validation.data as unknown as RefsProject
  onProgress?.({ percent: 10, stage: 'validating' })

  // Step 4: Verify the integrity checksum if present (warning-only). A
  // corrupted JSON is far more likely to fail Zod first; the checksum's real
  // value is catching subtle corruption Zod misses. Mismatch never aborts —
  // the strict `fileSize + fileLastModified` identity gate (later in this
  // flow) is the authoritative media check. See design D3.
  if (refsProject.checksum) {
    const recomputed = await computeProjectChecksum(refsProject)
    if (recomputed !== refsProject.checksum) {
      logger.warn(
        `Refs document checksum mismatch — data may have been modified. Proceeding with import (strict media-identity gate still applies).`,
      )
    }
  }

  // Step 5: Migrate the inner project schema
  // migrateProject returns a MigrationResult wrapper ({ project, migrated, ... }),
  // not a Project — unwrap it. Using the wrapper directly would spread the
  // nested `project` field and leave the created project without an `id`.
  const migrationResult = migrateProject(refsProject.project as unknown as Project)
  const migratedProject = migrationResult.project

  // Step 6: Build resolution context
  onProgress?.({ percent: 15, stage: 'selecting_directory' })
  const workspaceMedia = await getAllMediaMetadata()
  const ctx = await buildResolutionContext(workspaceMedia, jsonDirectoryHandle)

  // Step 7: Resolve each media reference
  onProgress?.({ percent: 20, stage: 'importing_media' })
  const totalMedia = refsProject.media.length
  const outcomes: ResolutionOutcome[] = []

  for (let i = 0; i < totalMedia; i++) {
    const entry = refsProject.media[i]!
    const outcome = await resolveMediaRef(entry, ctx)
    outcomes.push(outcome)

    onProgress?.({
      percent: 20 + Math.round((i / totalMedia) * 60),
      stage: 'importing_media',
      currentFile: entry.fileName,
    })
  }

  // Step 7b: Lazy picker fallback (waterfall Step 5). The automatic steps
  // (workspace library match + authorized-root scan) have run via
  // resolveMediaRef. Any reference still unresolved (not-found, identity
  // mismatch, etc.) is handed to the caller's `resolveMissing` callback, which
  // prompts the user (directory picker → per-file). Resolved outcomes fold
  // back into `outcomes`; refs still absent keep their original failure and
  // are marked missing in Step 9. When no callback is supplied (headless /
  // test), behavior is unchanged — refs stay unresolved. Keeping the picker in
  // the caller keeps the service browser-agnostic.
  if (options.resolveMissing) {
    const unresolvedIndices: number[] = []
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i]!.kind !== 'resolved') unresolvedIndices.push(i)
    }
    if (unresolvedIndices.length > 0) {
      onProgress?.({ percent: 80, stage: 'selecting_directory' })
      const unresolvedEntries = unresolvedIndices.map((i) => refsProject.media[i]!)
      const resolvedByPicker = await options.resolveMissing(unresolvedEntries)
      for (const i of unresolvedIndices) {
        const entry = refsProject.media[i]!
        const outcome = resolvedByPicker.get(entry.ref)
        // Only fold resolved outcomes; the picker helpers only place resolved
        // entries in their map, so absent keys keep their original failure.
        if (outcome && outcome.kind === 'resolved') {
          outcomes[i] = outcome
        }
      }
    }
  }

  // Step 8: Create MediaMetadata for resolved refs
  const mediaIdMap = new Map<string, string>() // ref → new mediaId
  const failures: RefsResolutionFailure[] = []
  let mediaImported = 0

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!
    const entry = refsProject.media[i]!

    if (outcome.kind === 'resolved') {
      if (outcome.existingMediaId) {
        // Workspace match — reuse existing mediaId
        mediaIdMap.set(entry.ref, outcome.existingMediaId)
      } else {
        // New file — create MediaMetadata
        const newMediaId = crypto.randomUUID()
        const metadata: MediaMetadata = {
          id: newMediaId,
          storageType: 'handle',
          fileHandle: outcome.fileHandle,
          fileName: entry.fileName,
          fileSize: outcome.fileSize,
          fileLastModified: outcome.fileLastModified,
          mimeType: entry.mimeType,
          duration: entry.metadata.duration,
          width: entry.metadata.width,
          height: entry.metadata.height,
          fps: entry.metadata.fps,
          codec: entry.metadata.codec,
          bitrate: entry.metadata.bitrate,
          tags: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        await createMedia(metadata)
        mediaIdMap.set(entry.ref, newMediaId)

        // Generate thumbnail (best-effort). The blob is intentionally not
        // persisted here — this only confirms the file is decodable; the media
        // library regenerates + stores the real thumbnail on demand.
        try {
          const file = await outcome.fileHandle.getFile()
          await generateThumbnail(file, { maxSize: 320, quality: 0.6 })
          mediaImported++
        } catch (error) {
          logger.warn(`Thumbnail generation failed for ${entry.fileName}`, error)
          mediaImported++
        }
      }
    } else {
      // Resolution failure
      failures.push(outcome as RefsResolutionFailure)
    }
  }

  // Step 9: Remap timeline mediaIds
  onProgress?.({ percent: 85, stage: 'linking' })
  const projectData = { ...migratedProject }

  // Mark unresolved items with missing media BEFORE remapping — at this point
  // the (still-bundle-shaped) timeline carries `mediaRef`, which is the key we
  // resolve against. restoreTimelineFromBundle would drop mediaRef and leave a
  // bare undefined mediaId, making the failure untraceable.
  if (failures.length > 0 && projectData.timeline) {
    const unresolvedRefs = new Set(failures.map((f) => f.ref))
    for (const item of projectData.timeline.items as Array<Record<string, unknown>>) {
      const ref = item.mediaRef
      if (typeof ref === 'string' && unresolvedRefs.has(ref)) {
        item.missingMediaRef = true
      }
    }
  }

  if (projectData.timeline) {
    projectData.timeline = restoreTimelineFromBundle(
      projectData.timeline as Parameters<typeof restoreTimelineFromBundle>[0],
      mediaIdMap,
    )
  }

  // Step 10: Persist the project
  onProgress?.({ percent: 90, stage: 'linking' })
  const projectName = options.newProjectName ?? projectData.name
  const project = await createProject({
    ...projectData,
    name: projectName,
  })

  // Associate media with the project
  for (const mediaId of mediaIdMap.values()) {
    await associateMediaWithProject(project.id, mediaId)
  }

  // Step 11: Touch authorized roots that were used
  await touchUsedAuthorizedRoots(outcomes)

  onProgress?.({ percent: 100, stage: 'complete' })

  return {
    project,
    mediaImported,
    mediaUnresolved: failures.length,
    failures,
  }
}
