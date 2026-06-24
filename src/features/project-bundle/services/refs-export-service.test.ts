import { describe, expect, it, vi } from 'vite-plus/test'

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

// Mock storage
const mockProject = {
  id: 'proj-1',
  name: 'Test Project',
  description: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  duration: 0,
  schemaVersion: 10,
  metadata: { width: 1920, height: 1080, fps: 29.97, backgroundColor: '#000000' },
  timeline: {
    tracks: [],
    items: [
      { id: 'item-1', trackId: 'track-1', type: 'video', mediaId: 'media-1' },
      { id: 'item-2', trackId: 'track-1', type: 'audio', mediaId: 'media-1' },
      { id: 'item-3', trackId: 'track-1', type: 'video', mediaId: 'media-2' },
    ],
  },
}

vi.mock('@/infrastructure/storage', () => ({
  getProject: vi.fn(async () => mockProject),
  getProjectMediaIds: vi.fn(async () => ['media-1', 'media-2']),
}))

// Mock media library deps
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

const mockMedia2 = {
  id: 'media-2',
  storageType: 'handle' as const,
  fileHandle: { name: 'clip2.mp4' } as FileSystemFileHandle,
  fileName: 'clip2.mp4',
  fileSize: 2000,
  fileLastModified: 1700000001000,
  mimeType: 'video/mp4',
  duration: 20,
  width: 1920,
  height: 1080,
  fps: 29.97,
  codec: 'h264',
  bitrate: 5000000,
  tags: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const mockMediaOpfs = {
  id: 'media-opfs',
  storageType: 'opfs' as const,
  opfsPath: 'opfs/clip3.mp4',
  fileName: 'clip3.mp4',
  fileSize: 3000,
  fileLastModified: 1700000002000,
  mimeType: 'video/mp4',
  duration: 5,
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
    mediaLibraryService: {
      getMedia: vi.fn(async (id: string) =>
        id === 'media-1'
          ? mockMedia1
          : id === 'media-2'
            ? mockMedia2
            : id === 'media-opfs'
              ? mockMediaOpfs
              : null,
      ),
    },
  })),
  generateThumbnail: vi.fn(),
  computeContentHashFromBuffer: vi.fn(),
}))

// Mock bundle-timeline — mirrors production: mediaId → mediaRef
vi.mock('./bundle-timeline', () => ({
  convertTimelineForBundle: vi.fn((tl: unknown) => {
    const timeline = tl as {
      items?: Array<Record<string, unknown>>
      compositions?: Array<{ items: Array<Record<string, unknown>> }>
    }
    const stamp = (item: Record<string, unknown>) => {
      const { mediaId, ...rest } = item
      return { ...rest, ...(mediaId ? { mediaRef: mediaId } : {}) }
    }
    return {
      ...timeline,
      items: timeline.items?.map(stamp),
      compositions: timeline.compositions?.map((c) => ({ ...c, items: c.items.map(stamp) })),
    }
  }),
}))

// Mock pure-utils — keep the real checksum helper so export checksum tests
// can assert against computeProjectChecksum, override only the sanitizer.
vi.mock('./pure-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pure-utils')>()
  return {
    ...actual,
    sanitizeDownloadFilename: vi.fn((name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_')),
  }
})

// Mock schema validation — the actual projectSchema is too complex for unit tests
vi.mock('../schemas/refs-schema', () => ({
  validateRefsProject: vi.fn(() => ({ success: true })),
  isRefsVersionCompatible: vi.fn(() => true),
}))

import { exportProjectAsRefs } from './refs-export-service'
import { computeProjectChecksum } from './pure-utils'

function makeMockDirHandle(): {
  handle: FileSystemDirectoryHandle
  files: Map<string, string>
} {
  const files = new Map<string, string>()
  const handle = {
    name: 'output',
    kind: 'directory',
    getFileHandle: vi.fn(async (name: string, _opts?: { create?: boolean }) => ({
      name,
      createWritable: vi.fn(async () => ({
        write: vi.fn(async (data: string) => {
          files.set(name, data)
        }),
        close: vi.fn(async () => {}),
      })),
    })),
    getDirectoryHandle: vi.fn(async (name: string, _opts?: { create?: boolean }) => ({
      name,
      kind: 'directory' as const,
      getFileHandle: vi.fn(async (fname: string, _opts?: { create?: boolean }) => ({
        name: fname,
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        })),
      })),
    })),
  } as unknown as FileSystemDirectoryHandle
  return { handle, files }
}

describe('refs-export-service', () => {
  describe('exportProjectAsRefs', () => {
    it('exports a project with handle-backed media (no copying)', async () => {
      const { handle } = makeMockDirHandle()
      const result = await exportProjectAsRefs('proj-1', handle)

      expect(result.filename).toBe('Test_Project.freecut.json')
      expect(result.mediaCount).toBe(2)
      expect(result.opfsSpillover).toBe(false)
    })

    it('stamps timeline item mediaRef to match media[].ref (round-trip integrity)', async () => {
      // Regression: timeline mediaRef used to hold the raw mediaId, which never
      // matched media[].ref (a uuidv5). The importer remaps via media[].ref,
      // so a mismatch left every clip without media.
      const { handle, files } = makeMockDirHandle()
      await exportProjectAsRefs('proj-1', handle)

      const written = JSON.parse(files.get('Test_Project.freecut.json')!)
      const refByMediaId = new Map<string, string>()
      // mockProject.getProjectMediaIds returns ['media-1','media-2'] in order,
      // matching the media[] order built from getMedia.
      const mediaRefs = written.media.map((m: { ref: string }) => m.ref)
      expect(mediaRefs).toHaveLength(2)

      const media1Ref = written.media[0].ref
      const media2Ref = written.media[1].ref
      refByMediaId.set('media-1', media1Ref)
      refByMediaId.set('media-2', media2Ref)

      // Every timeline item's mediaRef must be one of the exported media refs.
      for (const item of written.project.timeline.items) {
        expect([media1Ref, media2Ref]).toContain(item.mediaRef)
        // mediaRef must NOT be the raw mediaId ('media-1' / 'media-2')
        expect(item.mediaRef).not.toMatch(/^media-[12]$/)
      }

      // Items 1 & 2 (media-1) share the same ref; item 3 (media-2) differs.
      expect(written.project.timeline.items[0].mediaRef).toBe(media1Ref)
      expect(written.project.timeline.items[1].mediaRef).toBe(media1Ref)
      expect(written.project.timeline.items[2].mediaRef).toBe(media2Ref)
    })

    it('respects stripPaths option', async () => {
      const { handle } = makeMockDirHandle()
      await exportProjectAsRefs('proj-1', handle, { stripPaths: true })

      // Verify the JSON was written — check the file handle mock
      const getFileHandleMock = handle.getFileHandle as ReturnType<typeof vi.fn>
      expect(getFileHandleMock).toHaveBeenCalledWith('Test_Project.freecut.json', { create: true })
    })

    it('uses displayName when provided', async () => {
      const { handle } = makeMockDirHandle()
      const result = await exportProjectAsRefs('proj-1', handle, { displayName: 'My Export' })

      expect(result.filename).toBe('My Export.freecut.json')
    })

    it('spills OPFS-backed media to a sibling .media/ directory', async () => {
      const { getProjectMediaIds } = await import('@/infrastructure/storage')
      vi.mocked(getProjectMediaIds).mockResolvedValueOnce(['media-opfs'])

      const opfsRoot = {
        getFileHandle: vi.fn(async () => ({
          getFile: vi.fn(async () => new File(['bytes'], 'clip3.mp4')),
        })),
      }
      vi.stubGlobal('navigator', {
        ...navigator,
        storage: { getDirectory: vi.fn(async () => opfsRoot) },
      })

      const { handle } = makeMockDirHandle()
      const result = await exportProjectAsRefs('proj-1', handle)

      expect(result.opfsSpillover).toBe(true)
      // OPFS spillover must create the sibling .media/ dir with { create: true }
      // (regression: code previously called the non-existent createDirectoryHandle).
      const getDirectoryHandleMock = handle.getDirectoryHandle as ReturnType<typeof vi.fn>
      expect(getDirectoryHandleMock).toHaveBeenCalledWith('Test_Project.media', { create: true })

      vi.unstubAllGlobals()
    })

    it('throws if project not found', async () => {
      const { getProject } = await import('@/infrastructure/storage')
      vi.mocked(getProject).mockResolvedValueOnce(undefined)

      const { handle } = makeMockDirHandle()
      await expect(exportProjectAsRefs('missing', handle)).rejects.toThrow('Project not found')
    })

    it('writes a checksum matching computeProjectChecksum by default', async () => {
      const { handle, files } = makeMockDirHandle()
      await exportProjectAsRefs('proj-1', handle)

      const written = JSON.parse(files.get('Test_Project.freecut.json')!)
      expect(typeof written.checksum).toBe('string')
      // The stored checksum must equal a fresh recompute over the doc with
      // the checksum field blanked (self-consistent on read).
      const { checksum: _ignored, ...docWithoutChecksum } = written
      expect(written.checksum).toBe(await computeProjectChecksum(docWithoutChecksum))
    })

    it('omits the checksum when includeChecksum is false', async () => {
      const { handle, files } = makeMockDirHandle()
      await exportProjectAsRefs('proj-1', handle, { includeChecksum: false })

      const written = JSON.parse(files.get('Test_Project.freecut.json')!)
      expect(written.checksum).toBeUndefined()
    })
  })
})
