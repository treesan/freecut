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
import { validateRefsProject } from '../schemas/refs-schema'
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

const logger = createLogger('RefsImportService')

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
  // Step 1: Read + parse + validate the JSON file
  onProgress?.({ percent: 0, stage: 'validating' })

  const file = await jsonFileHandle.getFile()
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const validation = validateRefsProject(parsed)
  if (!validation.success || !validation.data) {
    const { formatValidationErrors } = await import('../schemas/refs-schema')
    const errors = validation.errors
      ? formatValidationErrors(validation.errors).join('; ')
      : 'Unknown validation error'
    throw new Error(`Invalid .freecut.json: ${errors}`)
  }

  const refsProject = validation.data as unknown as RefsProject
  onProgress?.({ percent: 10, stage: 'validating' })

  // Step 2: Migrate the inner project schema
  // migrateProject returns a MigrationResult wrapper ({ project, migrated, ... }),
  // not a Project — unwrap it. Using the wrapper directly would spread the
  // nested `project` field and leave the created project without an `id`.
  const migrationResult = migrateProject(refsProject.project as unknown as Project)
  const migratedProject = migrationResult.project

  // Step 3: Build resolution context
  onProgress?.({ percent: 15, stage: 'selecting_directory' })
  const workspaceMedia = await getAllMediaMetadata()
  const ctx = await buildResolutionContext(workspaceMedia, jsonDirectoryHandle)

  // Step 4: Resolve each media reference
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

  // Step 5: Create MediaMetadata for resolved refs
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

  // Step 6: Remap timeline mediaIds
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

  // Step 7: Persist the project
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

  // Step 8: Touch authorized roots that were used
  await touchUsedAuthorizedRoots(outcomes)

  onProgress?.({ percent: 100, stage: 'complete' })

  return {
    project,
    mediaImported,
    mediaUnresolved: failures.length,
    failures,
  }
}
