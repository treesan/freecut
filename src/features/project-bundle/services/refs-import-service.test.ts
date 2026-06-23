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

    const mockFile = { text: vi.fn(async () => '{}') }
    const mockFileHandle = {
      getFile: vi.fn(async () => mockFile),
    } as unknown as FileSystemFileHandle

    await expect(importProjectFromRefs(mockFileHandle, undefined)).rejects.toThrow(
      'Invalid .freecut.json',
    )
  })
})
