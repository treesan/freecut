import { describe, expect, it, vi, beforeEach } from 'vite-plus/test'

// Round-trip integration test: export a project as refs → re-import the
// written JSON → assert a project is created, media is resolved, and the
// timeline mediaRef is remapped to a new mediaId via the mediaIdMap.

// Mock logger
vi.mock('@/shared/logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    event: vi.fn(),
    startEvent: () => ({ set: vi.fn(), merge: vi.fn(), success: vi.fn(), failure: vi.fn() }),
    child: vi.fn(),
    setLevel: vi.fn(),
  }),
  createOperationId: () => 'op-test',
}))

const mockProject = {
  id: 'proj-1',
  name: 'Round Trip',
  description: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  duration: 0,
  schemaVersion: 10,
  metadata: { width: 1920, height: 1080, fps: 29.97, backgroundColor: '#000000' },
  timeline: {
    tracks: [],
    items: [{ id: 'item-1', trackId: 'track-1', type: 'video', mediaId: 'media-1' }],
  },
}

// Storage: combine export needs (getProject, getProjectMediaIds) and import
// needs (createProject, createMedia, associateMediaWithProject, getAllMediaMetadata).
const createdProjects: Record<string, unknown>[] = []
vi.mock('@/infrastructure/storage', () => ({
  getProject: vi.fn(async () => mockProject),
  getProjectMediaIds: vi.fn(async () => ['media-1']),
  createProject: vi.fn(async (data: Record<string, unknown>) => {
    const project = { ...data, id: 'imported-proj-1' }
    createdProjects.push(project)
    return project
  }),
  createMedia: vi.fn(async () => {}),
  associateMediaWithProject: vi.fn(async () => {}),
  getAllMediaMetadata: vi.fn(async () => []),
}))

const mockMedia1 = {
  id: 'media-1',
  storageType: 'handle' as const,
  fileHandle: { name: 'clip1.mp4' } as FileSystemFileHandle,
  fileName: 'clip1.mp4',
  fileSize: 1000,
  fileLastModified: 1700000000000,
  mimeType: 'video/mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 29.97,
  codec: 'h264',
  bitrate: 5000000,
  tags: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

vi.mock('@/features/project-bundle/deps/media-library', () => ({
  importMediaLibraryService: vi.fn(async () => ({
    mediaLibraryService: { getMedia: vi.fn(async () => mockMedia1) },
  })),
  generateThumbnail: vi.fn(async () => null),
  computeContentHashFromBuffer: vi.fn(),
}))

// bundle-timeline: export stamps mediaRef from mediaId; import remaps
// mediaRef → new mediaId via the mediaIdMap. Implement both realistically.
vi.mock('./bundle-timeline', () => ({
  convertTimelineForBundle: vi.fn((tl: unknown) => {
    const timeline = tl as { items?: Array<Record<string, unknown>> }
    return {
      ...timeline,
      items: timeline.items?.map(({ mediaId, ...rest }) =>
        mediaId ? { ...rest, mediaRef: mediaId } : rest,
      ),
    }
  }),
  restoreTimelineFromBundle: vi.fn((tl: unknown, mediaIdMap: Map<string, string>) => {
    const timeline = tl as { items?: Array<Record<string, unknown>> }
    return {
      ...timeline,
      items: timeline.items?.map(({ mediaRef, ...rest }) => {
        if (typeof mediaRef === 'string' && mediaIdMap.has(mediaRef)) {
          return { ...rest, mediaId: mediaIdMap.get(mediaRef) }
        }
        return rest
      }),
    }
  }),
}))

// pure-utils: real checksum + real sanitizer.
vi.mock('./pure-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pure-utils')>()
  return {
    ...actual,
    sanitizeDownloadFilename: vi.fn((name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_')),
  }
})

// Schema: passthrough validation so the real exported JSON is consumed as-is.
vi.mock('../schemas/refs-schema', () => ({
  validateRefsProject: vi.fn((data: unknown) => ({ success: true, data })),
  isRefsVersionCompatible: vi.fn(() => true),
  formatValidationErrors: vi.fn(() => []),
}))

// path-resolution: resolve every ref to a fresh handle.
vi.mock('./path-resolution', () => ({
  resolveMediaRef: vi.fn(async () => ({
    kind: 'resolved',
    fileHandle: {} as FileSystemFileHandle,
    fileSize: 1000,
    fileLastModified: 1700000000000,
  })),
  buildResolutionContext: vi.fn(async () => ({
    workspaceMediaIndex: { byIdentity: new Map() },
    authorizedRoots: [],
  })),
  touchUsedAuthorizedRoots: vi.fn(async () => {}),
}))

vi.mock('@/shared/projects/migrations', () => ({
  migrateProject: vi.fn((p: unknown) => ({ project: p, migrated: false })),
}))

// Snapshot path shouldn't be reached for a refs round-trip, but the import
// service imports it at module load — provide a safe mock.
vi.mock('./json-import-service', () => ({
  importProjectFromJsonString: vi.fn(),
  validateSnapshotData: vi.fn(async () => ({
    valid: false,
    errors: [{ path: '', message: 'not a snapshot', code: 'schema_mismatch' }],
    warnings: [],
  })),
}))

import { exportProjectAsRefs } from './refs-export-service'
import { importProjectFromRefs } from './refs-import-service'
import { restoreTimelineFromBundle } from './bundle-timeline'
import { computeProjectChecksum } from './pure-utils'

function makeMockDirHandle() {
  const files = new Map<string, string>()
  const handle = {
    name: 'output',
    kind: 'directory',
    getFileHandle: vi.fn(async (name: string) => ({
      name,
      createWritable: vi.fn(async () => ({
        write: vi.fn(async (data: string) => {
          files.set(name, data)
        }),
        close: vi.fn(async () => {}),
      })),
    })),
    getDirectoryHandle: vi.fn(async (name: string) => ({
      name,
      kind: 'directory' as const,
      getFileHandle: vi.fn(async () => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        })),
      })),
    })),
  } as unknown as FileSystemDirectoryHandle
  return { handle, files }
}

describe('refs round-trip (export → import)', () => {
  beforeEach(() => {
    createdProjects.length = 0
    vi.mocked(restoreTimelineFromBundle).mockClear()
  })

  it('exports a project then re-imports the written JSON with media resolved and mediaRef remapped', async () => {
    // --- Export ---
    const { handle, files } = makeMockDirHandle()
    const exportResult = await exportProjectAsRefs('proj-1', handle)
    expect(exportResult.mediaCount).toBe(1)

    const writtenJson = files.get('Round_Trip.freecut.json')!
    const written = JSON.parse(writtenJson)
    const exportedRef = written.media[0].ref
    // The timeline item's mediaRef must equal media[].ref (handoff invariant).
    expect(written.project.timeline.items[0].mediaRef).toBe(exportedRef)
    // Checksum present and self-consistent.
    expect(written.checksum).toBe(await computeProjectChecksum({ ...written, checksum: undefined }))

    // --- Import the written JSON ---
    const mockFileHandle = {
      getFile: vi.fn(async () => ({ text: vi.fn(async () => writtenJson) })),
    } as unknown as FileSystemFileHandle

    const result = await importProjectFromRefs(mockFileHandle, undefined)

    // Project created.
    expect(result.project.id).toBe('imported-proj-1')
    // Media resolved.
    expect(result.mediaImported).toBe(1)
    expect(result.mediaUnresolved).toBe(0)

    // restoreTimelineFromBundle was called with a mediaIdMap that maps the
    // exported ref → a new mediaId, i.e. mediaRef was remapped to mediaId.
    expect(restoreTimelineFromBundle).toHaveBeenCalled()
    const [, mediaIdMap] = vi.mocked(restoreTimelineFromBundle).mock.calls[0]!
    expect(mediaIdMap.get(exportedRef)).toBeTruthy()
  })
})
