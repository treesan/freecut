/**
 * Refs Export Service — exports a project as `.freecut.json` (freecut-refs/1.0).
 *
 * Produces a lightweight JSON with media *references* (path hints, size, mtime)
 * instead of media bytes. For `storageType: 'opfs'` items, copies the file to
 * a sibling `<jsonStem>.media/` directory.
 */

import { uuidv5 } from '@/shared/utils/uuid'
import type { ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import {
  type RefsProject,
  type RefsMediaEntry,
  type RefsPathHints,
  type RefsExportOptions,
  type RefsExportResult,
  REFS_KIND,
  REFS_VERSION,
  FREECUT_REFS_NAMESPACE,
} from '../types/refs'
import { validateRefsProject } from '../schemas/refs-schema'
import { getProject, getProjectMediaIds } from '@/infrastructure/storage'
import { importMediaLibraryService } from '@/features/project-bundle/deps/media-library'
import { convertTimelineForBundle } from './bundle-timeline'
import { sanitizeDownloadFilename } from './pure-utils'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('RefsExportService')

const APP_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Timeline conversion (reuse bundle-timeline pattern)
// ---------------------------------------------------------------------------

type RefsTimeline = NonNullable<RefsProject['project']['timeline']>

/**
 * Convert a project timeline into the refs format.
 *
 * CRITICAL: timeline item `mediaRef` MUST equal the corresponding
 * `media[].ref` — the importer remaps items via a `ref → new mediaId` map
 * keyed by `media[].ref`. `convertTimelineForBundle` sets `mediaRef` to the
 * raw `mediaId`, which the importer can never match (refs are deterministic
 * `uuidv5` values). We therefore re-stamp each item's `mediaRef` with the
 * exported `ref` using `mediaIdToRef`.
 */
function convertTimelineForRefs(
  timeline: ProjectTimeline,
  mediaIdToRef: Map<string, string>,
): RefsTimeline {
  const converted = convertTimelineForBundle(timeline) as unknown as {
    items: Array<{ mediaRef?: string } & Record<string, unknown>>
    compositions?: Array<{ items: Array<{ mediaRef?: string } & Record<string, unknown>> }>
  } & Record<string, unknown>

  const stampRef = (item: { mediaRef?: string } & Record<string, unknown>) => {
    if (item.mediaRef) {
      const ref = mediaIdToRef.get(item.mediaRef)
      // `mediaRef` currently holds the raw mediaId (set by
      // convertTimelineForBundle). Replace it with the exported ref.
      if (ref) item.mediaRef = ref
      else delete item.mediaRef
    }
  }

  for (const item of converted.items) stampRef(item)
  if (converted.compositions) {
    for (const comp of converted.compositions) {
      for (const item of comp.items) stampRef(item)
    }
  }

  return converted as unknown as RefsTimeline
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Compute a relative path from the JSON output directory to a media file.
 * Always uses forward slashes (D4).
 */
function computeRelativeToJson(
  jsonDirName: string,
  mediaFileName: string,
  storageType: MediaMetadata['storageType'],
): string {
  if (storageType === 'opfs') {
    // OPFS files are copied to a sibling `.media/` directory
    return `${jsonDirName}.media/${mediaFileName}`
  }
  // Handle-backed media: for now, just reference by filename.
  // In practice, the user is expected to have the media co-located.
  return mediaFileName
}

/**
 * Normalize a path to use forward slashes.
 */
function toForwardSlash(path: string): string {
  return path.replace(/\\/g, '/')
}

// ---------------------------------------------------------------------------
// Media entry builder
// ---------------------------------------------------------------------------

async function buildMediaEntry(
  media: MediaMetadata,
  options: RefsExportOptions,
  jsonDirName: string,
): Promise<RefsMediaEntry | null> {
  try {
    const relativeToJson = computeRelativeToJson(jsonDirName, media.fileName, media.storageType)

    const pathHints: RefsPathHints = {
      relativeToJson: toForwardSlash(relativeToJson),
    }

    // `absolute` is omitted when:
    //   - stripPaths is enabled, OR
    //   - The source is a handle (browser can't recover absolute paths)
    // In the browser, we never have an absolute path for handle-backed media.
    // We also don't have one for OPFS media.
    // So `absolute` is only set when explicitly provided by a non-browser exporter.
    if (!options.stripPaths && media.storageType === 'handle') {
      // Could potentially be set by a CLI exporter; not available in browser.
      // Omit for now.
    }

    // Deterministic mediaRef — since we can't recover absolute paths in the
    // browser, derive from relativeToJson as a stable fallback.
    // For OPFS media, use the OPFS path; for handle media, use the relative path.
    const refSource =
      media.storageType === 'opfs' ? (media.opfsPath ?? relativeToJson) : relativeToJson
    const ref = await uuidv5(refSource, FREECUT_REFS_NAMESPACE)

    return {
      ref,
      fileName: media.fileName,
      fileSize: media.fileSize,
      fileLastModified: media.fileLastModified ?? 0,
      mimeType: media.mimeType,
      metadata: {
        duration: media.duration,
        width: media.width,
        height: media.height,
        fps: media.fps,
        codec: media.codec,
        bitrate: media.bitrate,
      },
      pathHints,
    }
  } catch (error) {
    logger.warn(`Failed to build media entry for ${media.fileName}`, error)
    return null
  }
}

// ---------------------------------------------------------------------------
// OPFS spillover
// ---------------------------------------------------------------------------

/**
 * Copy OPFS-backed media to a sibling `.media/` directory next to the JSON.
 */
async function spillOpfsMedia(
  media: MediaMetadata,
  destinationDir: FileSystemDirectoryHandle,
  jsonDirName: string,
): Promise<void> {
  if (media.storageType !== 'opfs' || !media.opfsPath) return

  // Ensure `.media/` sibling directory exists
  const mediaDirName = `${jsonDirName}.media`
  const mediaDir = await destinationDir.getDirectoryHandle(mediaDirName, { create: true })

  // Read OPFS file
  const opfsRoot = await navigator.storage.getDirectory()
  const opfsFileHandle = await opfsRoot.getFileHandle(media.opfsPath)
  const file = await opfsFileHandle.getFile()

  // Write to the sibling directory
  const newFileHandle = await mediaDir.getFileHandle(media.fileName, { create: true })
  const writable = await newFileHandle.createWritable()
  await writable.write(file)
  await writable.close()
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

/**
 * Export a project as a `.freecut.json` path-reference file.
 *
 * @param projectId - The project to export
 * @param destinationDir - Directory to write the `.freecut.json` into
 * @param options - Export options (stripPaths, prettyPrint, displayName)
 */
export async function exportProjectAsRefs(
  projectId: string,
  destinationDir: FileSystemDirectoryHandle,
  options: RefsExportOptions = {},
): Promise<RefsExportResult> {
  const { stripPaths = false, prettyPrint = true, displayName } = options

  logger.info(`Exporting project ${projectId} as .freecut.json`)

  // Step 1: Get project data
  const project = await getProject(projectId)
  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }

  // Step 2: Collect media metadata
  const { mediaLibraryService } = await importMediaLibraryService()
  const mediaIds = await getProjectMediaIds(projectId)
  const mediaItems: MediaMetadata[] = []
  for (const mediaId of mediaIds) {
    const media = await mediaLibraryService.getMedia(mediaId)
    if (media) mediaItems.push(media)
  }

  // Determine output filename
  const baseName = displayName ?? sanitizeDownloadFilename(project.name)
  const jsonDirName = baseName // Used for the .media/ sibling directory name
  const filename = `${baseName}.freecut.json`

  // Step 3: Build media entries, recording mediaId → ref so the timeline
  // conversion can re-stamp each item's mediaRef to match media[].ref.
  const mediaEntries: RefsMediaEntry[] = []
  const mediaIdToRef = new Map<string, string>()
  let opfsSpillover = false

  for (const media of mediaItems) {
    const entry = await buildMediaEntry(media, options, jsonDirName)
    if (entry) {
      mediaEntries.push(entry)
      mediaIdToRef.set(media.id, entry.ref)
    }

    // Handle OPFS spillover
    if (media.storageType === 'opfs') {
      await spillOpfsMedia(media, destinationDir, jsonDirName)
      opfsSpillover = true
    }
  }

  // Step 4: Build the complete RefsProject
  const refsProject: RefsProject = {
    kind: REFS_KIND,
    version: REFS_VERSION,
    exportedAt: new Date().toISOString(),
    editorVersion: APP_VERSION,
    project: {
      ...project,
      timeline: project.timeline
        ? convertTimelineForRefs(project.timeline, mediaIdToRef)
        : undefined,
    } as RefsProject['project'],
    media: mediaEntries,
  }

  // Step 5: Validate against Zod schema
  const validation = validateRefsProject(refsProject)
  if (!validation.success) {
    logger.error('Refs project validation failed', validation.errors)
    throw new Error('Exported project failed schema validation')
  }

  // Step 6: Write JSON to destination directory
  const jsonString = prettyPrint
    ? JSON.stringify(refsProject, null, 2)
    : JSON.stringify(refsProject)

  const jsonFileHandle = await destinationDir.getFileHandle(filename, { create: true })
  const writable = await jsonFileHandle.createWritable()
  await writable.write(jsonString)
  await writable.close()

  if (stripPaths) {
    logger.info('Strip-paths mode: all pathHints.absolute omitted')
  }

  return {
    filename,
    mediaCount: mediaEntries.length,
    opfsSpillover,
  }
}
