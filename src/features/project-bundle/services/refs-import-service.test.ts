import { describe, expect, it, vi, beforeEach } from 'vite-plus/test'

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

// Mock schema validation
vi.mock('../schemas/refs-schema', () => ({
  validateRefsProject: vi.fn(() => ({ success: true, data: null })),
  isRefsVersionCompatible: vi.fn(() => true),
  formatValidationErrors: vi.fn(() => []),
}))

// Mock storage
const createdMedia: MediaMetadata[] = []
vi.mock('@/infrastructure/storage', () => ({
  createProject: vi.fn(async (data: Record<string, unknown>) => ({
    ...data,
    id: 'new-proj-1',
  })),
  createMedia: vi.fn(async (media: MediaMetadata) => {
    createdMedia.push(media)
  }),
  associateMediaWithProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  getAllMediaMetadata: vi.fn(async () => []),
}))

// Mock deps
vi.mock('@/features/project-bundle/deps/media-library', () => ({
  generateThumbnail: vi.fn(async () => null),
  importMediaLibraryService: vi.fn(),
  computeContentHashFromBuffer: vi.fn(),
}))

// Mock path-resolution
vi.mock('./path-resolution', () => ({
  resolveMediaRef: vi.fn(),
  buildResolutionContext: vi.fn(async () => ({
    workspaceMediaIndex: { byIdentity: new Map() },
    authorizedRoots: [],
  })),
  touchUsedAuthorizedRoots: vi.fn(async () => {}),
}))

// Mock json-import-service (snapshot path) — used by format auto-detection
// when a snapshot-shaped document is delegated, and for the aggregated error
// of a document that matches neither shape.
vi.mock('./json-import-service', () => ({
  importProjectFromJsonString: vi.fn(
    async (_text: string, options: { newProjectName?: string }) => ({
      project: {
        id: 'snapshot-proj-1',
        name: options.newProjectName ?? 'Snapshot Project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      matchedMedia: [],
      unmatchedMedia: [],
      warnings: [],
    }),
  ),
  validateSnapshotData: vi.fn(async () => ({
    valid: false,
    errors: [{ path: '', message: 'not a snapshot', code: 'schema_mismatch' }],
    warnings: [],
  })),
}))

// Mock bundle-timeline
vi.mock('./bundle-timeline', () => ({
  restoreTimelineFromBundle: vi.fn((tl: unknown) => tl),
}))

// Mock migrations — matches the real migrateProject() return shape:
// a MigrationResult wrapper ({ project, migrated, ... }), NOT a bare Project.
vi.mock('@/shared/projects/migrations', () => ({
  migrateProject: vi.fn((p: unknown) => ({ project: p, migrated: false })),
}))

import type { MediaMetadata } from '@/types/storage'
import type { RefsProject, RefsMediaEntry } from '../types/refs'
import { REFS_KIND, REFS_VERSION } from '../types/refs'
import { importProjectFromRefs } from './refs-import-service'

function makeRefsProject(media: RefsMediaEntry[] = []): RefsProject {
  return {
    kind: REFS_KIND,
    version: REFS_VERSION,
    exportedAt: new Date().toISOString(),
    editorVersion: '1.0.0',
    project: {
      id: 'orig-proj',
      name: 'Test Project',
      description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 100,
      schemaVersion: 10,
      metadata: { width: 1920, height: 1080, fps: 29.97, backgroundColor: '#000000' },
    },
    media,
  }
}

function makeMediaEntry(overrides: Partial<RefsMediaEntry> = {}): RefsMediaEntry {
  return {
    ref: 'ref-001',
    fileName: 'clip.mp4',
    fileSize: 1000,
    fileLastModified: 1700000000000,
    mimeType: 'video/mp4',
    metadata: {
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 29.97,
      codec: 'h264',
      bitrate: 5000000,
    },
    pathHints: { relativeToJson: 'clip.mp4' },
    ...overrides,
  }
}

describe('refs-import-service', () => {
  beforeEach(() => {
    createdMedia.length = 0
  })

  it('creates project and media on successful resolution', async () => {
    const { validateRefsProject } = await import('../schemas/refs-schema')
    const refsProject = makeRefsProject([makeMediaEntry()])
    vi.mocked(validateRefsProject).mockReturnValueOnce({
      success: true,
      data: refsProject,
    } as never)

    const { resolveMediaRef } = await import('./path-resolution')
    vi.mocked(resolveMediaRef).mockResolvedValueOnce({
      kind: 'resolved',
      fileHandle: {} as FileSystemFileHandle,
      fileSize: 1000,
      fileLastModified: 1700000000000,
    })

    const jsonContent = JSON.stringify(refsProject)
    const mockFile = { text: vi.fn(async () => jsonContent) }
    const mockFileHandle = {
      getFile: vi.fn(async () => mockFile),
    } as unknown as FileSystemFileHandle

    const result = await importProjectFromRefs(mockFileHandle, undefined)

    expect(result.mediaImported).toBe(1)
    expect(result.mediaUnresolved).toBe(0)
    expect(result.failures).toHaveLength(0)
    // The created project must carry an id — without unwapping
    // migrateProject()'s MigrationResult wrapper the id is lost and the
    // editor route navigates to /editor/undefined.
    expect(result.project.id).toBe('new-proj-1')
  })

  it('records failures for unresolved media', async () => {
    const { validateRefsProject } = await import('../schemas/refs-schema')
    const refsProject = makeRefsProject([makeMediaEntry({ ref: 'ref-missing' })])
    vi.mocked(validateRefsProject).mockReturnValueOnce({
      success: true,
      data: refsProject,
    } as never)

    const { resolveMediaRef } = await import('./path-resolution')
    vi.mocked(resolveMediaRef).mockResolvedValueOnce({
      ref: 'ref-missing',
      fileName: 'missing.mp4',
      kind: 'not-found',
      message: 'Could not resolve missing.mp4',
    })

    const jsonContent = JSON.stringify(refsProject)
    const mockFile = { text: vi.fn(async () => jsonContent) }
    const mockFileHandle = {
      getFile: vi.fn(async () => mockFile),
    } as unknown as FileSystemFileHandle

    const result = await importProjectFromRefs(mockFileHandle, undefined)

    expect(result.mediaImported).toBe(0)
    expect(result.mediaUnresolved).toBe(1)
    expect(result.failures[0]!.kind).toBe('not-found')
  })

  it('throws on invalid JSON', async () => {
    const mockFile = { text: vi.fn(async () => 'not json') }
    const mockFileHandle = {
      getFile: vi.fn(async () => mockFile),
    } as unknown as FileSystemFileHandle

    await expect(importProjectFromRefs(mockFileHandle, undefined)).rejects.toThrow('Invalid JSON')
  })

  it('throws on schema validation failure', async () => {
    const { validateRefsProject } = await import('../schemas/refs-schema')
    vi.mocked(validateRefsProject).mockReturnValueOnce({
      success: false,
      errors: new Error('fail') as never,
    } as never)

    // Feed a refs-shaped document so detection routes it through refs
    // validation (a bare `{}` would now hit the aggregated-error branch).
    const mockFile = { text: vi.fn(async () => JSON.stringify({ kind: 'freecut-refs' })) }
    const mockFileHandle = {
      getFile: vi.fn(async () => mockFile),
    } as unknown as FileSystemFileHandle

    await expect(importProjectFromRefs(mockFileHandle, undefined)).rejects.toThrow(
      'Invalid .freecut.json',
    )
  })

  describe('format auto-detection', () => {
    function makeFileHandle(content: string): FileSystemFileHandle {
      const mockFile = { text: vi.fn(async () => content) }
      return { getFile: vi.fn(async () => mockFile) } as unknown as FileSystemFileHandle
    }

    it('delegates a snapshot document (no kind, has project) to snapshot import', async () => {
      const { importProjectFromJsonString } = await import('./json-import-service')
      const snapshotDoc = {
        version: '1.0',
        exportedAt: '2026-01-01T00:00:00.000Z',
        editorVersion: '1.0.0',
        project: { id: 'snap-proj', name: 'Snap' },
        mediaReferences: [],
      }

      const result = await importProjectFromRefs(
        makeFileHandle(JSON.stringify(snapshotDoc)),
        undefined,
        { newProjectName: 'Imported Snap' },
      )

      expect(importProjectFromJsonString).toHaveBeenCalledWith(JSON.stringify(snapshotDoc), {
        newProjectName: 'Imported Snap',
      })
      expect(result.project.id).toBe('snapshot-proj-1')
    })

    it('throws an aggregated error for a document matching neither shape', async () => {
      await expect(
        importProjectFromRefs(makeFileHandle(JSON.stringify({ foo: 'bar' })), undefined),
      ).rejects.toThrow('Unrecognized .freecut.json format')
    })

    it('does NOT route a kind-bearing non-refs document to snapshot import', async () => {
      // A future third format with a `kind` must fall through to the aggregated
      // error, not misroute to snapshot import (design risk mitigation).
      const { importProjectFromJsonString } = await import('./json-import-service')
      vi.mocked(importProjectFromJsonString).mockClear()

      await expect(
        importProjectFromRefs(
          makeFileHandle(JSON.stringify({ kind: 'some-future-format', project: { id: 'x' } })),
          undefined,
        ),
      ).rejects.toThrow('Unrecognized .freecut.json format')

      expect(importProjectFromJsonString).not.toHaveBeenCalled()
    })
  })

  describe('checksum verification', () => {
    it('warns (does not throw) on a tampered checksum', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const refsProject = makeRefsProject([makeMediaEntry()])
      // Attach a deliberately-wrong checksum.
      refsProject.checksum = 'deadbeef'
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      vi.mocked(resolveMediaRef).mockResolvedValueOnce({
        kind: 'resolved',
        fileHandle: {} as FileSystemFileHandle,
        fileSize: 1000,
        fileLastModified: 1700000000000,
      })

      // Should NOT throw despite the mismatch — import proceeds.
      const result = await importProjectFromRefs(
        {
          getFile: vi.fn(async () => ({ text: vi.fn(async () => JSON.stringify(refsProject)) })),
        } as unknown as FileSystemFileHandle,
        undefined,
      )
      expect(result.project.id).toBe('new-proj-1')
    })

    it('skips verification when checksum is absent', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const refsProject = makeRefsProject([makeMediaEntry()])
      // No checksum field — back-compat with older files.
      expect(refsProject.checksum).toBeUndefined()
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      vi.mocked(resolveMediaRef).mockResolvedValueOnce({
        kind: 'resolved',
        fileHandle: {} as FileSystemFileHandle,
        fileSize: 1000,
        fileLastModified: 1700000000000,
      })

      const result = await importProjectFromRefs(
        {
          getFile: vi.fn(async () => ({ text: vi.fn(async () => JSON.stringify(refsProject)) })),
        } as unknown as FileSystemFileHandle,
        undefined,
      )
      expect(result.mediaImported).toBe(1)
    })
  })

  describe('lazy media picker (resolveMissing)', () => {
    function makeFileHandle(content: string): FileSystemFileHandle {
      const mockFile = { text: vi.fn(async () => content) }
      return { getFile: vi.fn(async () => mockFile) } as unknown as FileSystemFileHandle
    }

    // XiangXi regression: media already registered in the workspace library →
    // resolveMediaRef returns resolved outcomes (Step 1 workspace match), so the
    // picker callback is NEVER invoked and no new MediaMetadata is created.
    it('does not call resolveMissing when all refs resolve automatically', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const refsProject = makeRefsProject([
        makeMediaEntry({ ref: 'ws-1', fileName: 'DSC_0227.MP4' }),
        makeMediaEntry({ ref: 'ws-2', fileName: 'DSC_0088.MP4' }),
      ])
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      // Every ref resolves via the workspace library match — picker stays idle.
      vi.mocked(resolveMediaRef).mockResolvedValue({
        kind: 'resolved',
        existingMediaId: 'existing-ws-media',
        fileHandle: {} as FileSystemFileHandle,
        fileSize: 1000,
        fileLastModified: 1700000000000,
      })

      const resolveMissing = vi.fn(async () => new Map())
      const result = await importProjectFromRefs(
        makeFileHandle(JSON.stringify(refsProject)),
        undefined,
        { resolveMissing },
      )

      expect(resolveMissing).not.toHaveBeenCalled()
      expect(result.mediaImported).toBe(0) // existing media reused, no new import
      expect(result.mediaUnresolved).toBe(0)
      expect(createdMedia).toHaveLength(0) // nothing created — ids reused
    })

    it('folds resolved outcomes from resolveMissing into the import', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const resolvedEntry = makeMediaEntry({ ref: 'ok-ref', fileName: 'ok.mp4' })
      const missingEntry = makeMediaEntry({ ref: 'miss-ref', fileName: 'miss.mp4' })
      const refsProject = makeRefsProject([resolvedEntry, missingEntry])
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      // First ref resolves via workspace match (reuses an existing id, so no new
      // media is created); second is not-found → triggers the picker.
      vi.mocked(resolveMediaRef)
        .mockResolvedValueOnce({
          kind: 'resolved',
          existingMediaId: 'existing-auto-media',
          fileHandle: {} as FileSystemFileHandle,
          fileSize: 1000,
          fileLastModified: 1700000000000,
        })
        .mockResolvedValueOnce({
          ref: 'miss-ref',
          fileName: 'miss.mp4',
          kind: 'not-found',
          message: 'not found',
        })

      const resolveMissing = vi.fn(async (unresolved) => {
        // Picker resolves the missing ref.
        expect(unresolved.map((e: RefsMediaEntry) => e.ref)).toEqual(['miss-ref'])
        const map = new Map<
          string,
          {
            kind: 'resolved'
            fileHandle: FileSystemFileHandle
            fileSize: number
            fileLastModified: number
          }
        >()
        map.set('miss-ref', {
          kind: 'resolved',
          fileHandle: {} as FileSystemFileHandle,
          fileSize: 2000,
          fileLastModified: 1800000000000,
        })
        return map
      })

      const result = await importProjectFromRefs(
        makeFileHandle(JSON.stringify(refsProject)),
        undefined,
        { resolveMissing },
      )

      expect(resolveMissing).toHaveBeenCalledTimes(1)
      expect(result.mediaUnresolved).toBe(0)
      // mediaImported counts NEW media created: the auto-resolved ref reused an
      // existing id (Step 1), so only the picker-resolved ref was newly created.
      expect(result.mediaImported).toBe(1)
      expect(createdMedia).toHaveLength(1) // only the picker-resolved one was new
      expect(createdMedia[0]!.fileName).toBe('miss.mp4')
    })

    it('leaves refs unresolved when resolveMissing returns nothing (per-file cancelled)', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const entry = makeMediaEntry({ ref: 'miss-ref', fileName: 'miss.mp4' })
      const refsProject = makeRefsProject([entry])
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      vi.mocked(resolveMediaRef).mockResolvedValueOnce({
        ref: 'miss-ref',
        fileName: 'miss.mp4',
        kind: 'not-found',
        message: 'not found',
      })

      // User cancelled every picker → empty map → ref stays not-found.
      const resolveMissing = vi.fn(async () => new Map())
      const result = await importProjectFromRefs(
        makeFileHandle(JSON.stringify(refsProject)),
        undefined,
        { resolveMissing },
      )

      expect(result.mediaUnresolved).toBe(1)
      expect(result.failures[0]!.kind).toBe('not-found')
      expect(createdMedia).toHaveLength(0)
    })

    it('omitting resolveMissing leaves unresolved refs as not-found (headless parity)', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const entry = makeMediaEntry({ ref: 'miss-ref', fileName: 'miss.mp4' })
      const refsProject = makeRefsProject([entry])
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      vi.mocked(resolveMediaRef).mockResolvedValueOnce({
        ref: 'miss-ref',
        fileName: 'miss.mp4',
        kind: 'not-found',
        message: 'not found',
      })

      // No callback — headless caller. Behavior must match the pre-change path.
      const result = await importProjectFromRefs(
        makeFileHandle(JSON.stringify(refsProject)),
        undefined,
      )

      expect(result.mediaUnresolved).toBe(1)
      expect(result.failures[0]!.kind).toBe('not-found')
      expect(result.project.id).toBe('new-proj-1') // project still created
    })

    it('invokes onProgress with selecting_directory before the picker', async () => {
      const { validateRefsProject } = await import('../schemas/refs-schema')
      const entry = makeMediaEntry({ ref: 'miss-ref', fileName: 'miss.mp4' })
      const refsProject = makeRefsProject([entry])
      vi.mocked(validateRefsProject).mockReturnValueOnce({
        success: true,
        data: refsProject,
      } as never)

      const { resolveMediaRef } = await import('./path-resolution')
      vi.mocked(resolveMediaRef).mockResolvedValueOnce({
        ref: 'miss-ref',
        fileName: 'miss.mp4',
        kind: 'not-found',
        message: 'not found',
      })

      const stages: string[] = []
      await importProjectFromRefs(
        makeFileHandle(JSON.stringify(refsProject)),
        undefined,
        { resolveMissing: async () => new Map() },
        (p) => stages.push(p.stage),
      )

      expect(stages).toContain('selecting_directory')
    })
  })
})
