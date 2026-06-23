import { describe, expect, it, vi } from 'vite-plus/test'
import type { RefsMediaEntry } from '../types/refs'
import type { MediaMetadata } from '@/types/storage'
import type { ResolutionContext, ResolutionOutcome } from './path-resolution'

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

// Mock authorized-roots
vi.mock('@/infrastructure/storage/authorized-roots', () => ({
  listAuthorizedRoots: vi.fn(async () => []),
  addAuthorizedRoot: vi.fn(async (handle: FileSystemDirectoryHandle, displayName?: string) => ({
    id: 'root-1',
    displayName: displayName ?? handle.name,
    handle,
    addedAt: Date.now(),
    lastUsedAt: Date.now(),
  })),
  touchAuthorizedRoot: vi.fn(),
  ensureRootPermission: vi.fn(async () => true),
}))

import {
  resolveMediaRef,
  buildResolutionContext,
  resolveViaFilePicker,
  touchUsedAuthorizedRoots,
} from './path-resolution'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RefsMediaEntry> = {}): RefsMediaEntry {
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
    pathHints: { relativeToJson: 'videos/clip.mp4' },
    ...overrides,
  }
}

function makeMediaMetadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    id: 'media-001',
    storageType: 'handle',
    fileHandle: {} as FileSystemFileHandle,
    fileName: 'clip.mp4',
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Step 1: Workspace match tests
// ---------------------------------------------------------------------------

describe('path-resolution', () => {
  describe('Step 1: Workspace media library match', () => {
    it('resolves when workspace has matching identity triple', async () => {
      const entry = makeEntry()
      const media = makeMediaMetadata()
      const ctx: ResolutionContext = {
        workspaceMediaIndex: {
          byIdentity: new Map([['clip.mp4:1000:1700000000000', media]]),
        },
        authorizedRoots: [],
      }

      const result = await resolveMediaRef(entry, ctx)
      expect(result.kind).toBe('resolved')
      if (result.kind === 'resolved') {
        expect(result.existingMediaId).toBe('media-001')
      }
    })

    it('skips when fileSize mismatches', async () => {
      const entry = makeEntry({ fileSize: 2000 })
      const media = makeMediaMetadata({ fileSize: 1000 })
      const ctx: ResolutionContext = {
        workspaceMediaIndex: {
          byIdentity: new Map([['clip.mp4:1000:1700000000000', media]]),
        },
        authorizedRoots: [],
      }

      const result = await resolveMediaRef(entry, ctx)
      // Should fall through to not-found (no other steps available)
      expect(result.kind).toBe('not-found')
    })

    it('skips when fileName mismatches', async () => {
      const entry = makeEntry({ fileName: 'other.mp4' })
      const media = makeMediaMetadata({ fileName: 'clip.mp4' })
      const ctx: ResolutionContext = {
        workspaceMediaIndex: {
          byIdentity: new Map([['clip.mp4:1000:1700000000000', media]]),
        },
        authorizedRoots: [],
      }

      const result = await resolveMediaRef(entry, ctx)
      expect(result.kind).toBe('not-found')
    })
  })

  describe('resolveViaFilePicker', () => {
    it('returns identity-mismatch when picked file differs', async () => {
      const entry = makeEntry({ fileSize: 1000, fileLastModified: 1700000000000 })

      // Mock file handle that returns different identity
      const mockHandle = {
        getFile: vi.fn(async () => ({
          size: 999, // mismatch!
          lastModified: 1700000000000,
        })),
      } as unknown as FileSystemFileHandle

      const result = await resolveViaFilePicker(entry, mockHandle)
      expect(result.kind).toBe('identity-mismatch')
    })

    it('resolves when picked file matches identity', async () => {
      const entry = makeEntry({ fileSize: 1000, fileLastModified: 1700000000000 })

      const mockHandle = {
        getFile: vi.fn(async () => ({
          size: 1000,
          lastModified: 1700000000000,
        })),
      } as unknown as FileSystemFileHandle

      const result = await resolveViaFilePicker(entry, mockHandle)
      expect(result.kind).toBe('resolved')
    })

    it('resolves when mtime is within ±1ms (round vs floor drift)', async () => {
      // video-use exports mtime via round(st_mtime*1000); the browser's
      // File.lastModified is a floor. For mtimes with float drift these land
      // 1ms apart and the strict check wrongly rejected matching files.
      const entry = makeEntry({ fileSize: 1000, fileLastModified: 1700000001170 })

      const mockHandle = {
        getFile: vi.fn(async () => ({
          size: 1000, // exact
          lastModified: 1700000001169, // 1ms below the JSON value
        })),
      } as unknown as FileSystemFileHandle

      const result = await resolveViaFilePicker(entry, mockHandle)
      expect(result.kind).toBe('resolved')
    })

    it('still rejects mtime drift beyond the ±1ms tolerance', async () => {
      const entry = makeEntry({ fileSize: 1000, fileLastModified: 1700000001170 })

      const mockHandle = {
        getFile: vi.fn(async () => ({
          size: 1000, // exact
          lastModified: 1700000001168, // 2ms below — outside tolerance
        })),
      } as unknown as FileSystemFileHandle

      const result = await resolveViaFilePicker(entry, mockHandle)
      expect(result.kind).toBe('identity-mismatch')
    })
  })

  describe('touchUsedAuthorizedRoots', () => {
    it('touches roots that contributed to resolutions', async () => {
      const { touchAuthorizedRoot } = await import('@/infrastructure/storage/authorized-roots')

      const outcomes: ResolutionOutcome[] = [
        {
          kind: 'resolved',
          fileHandle: {} as FileSystemFileHandle,
          fileSize: 1,
          fileLastModified: 1,
          authorizedRootId: 'root-a',
        },
        {
          kind: 'resolved',
          fileHandle: {} as FileSystemFileHandle,
          fileSize: 2,
          fileLastModified: 2,
          authorizedRootId: 'root-a',
        },
        {
          kind: 'resolved',
          fileHandle: {} as FileSystemFileHandle,
          fileSize: 3,
          fileLastModified: 3,
          authorizedRootId: 'root-b',
        },
      ]

      await touchUsedAuthorizedRoots(outcomes)
      // root-a should be touched once (deduped), root-b once
      expect(touchAuthorizedRoot).toHaveBeenCalledTimes(2)
    })
  })

  describe('buildResolutionContext', () => {
    it('builds workspace index from media list', async () => {
      const media = [
        makeMediaMetadata({ fileName: 'a.mp4', fileSize: 100, fileLastModified: 1000 }),
        makeMediaMetadata({ fileName: 'b.mp4', fileSize: 200, fileLastModified: 2000 }),
      ]

      const ctx = await buildResolutionContext(media)
      expect(ctx.workspaceMediaIndex.byIdentity.size).toBe(2)
      expect(ctx.workspaceMediaIndex.byIdentity.has('a.mp4:100:1000')).toBe(true)
      expect(ctx.workspaceMediaIndex.byIdentity.has('b.mp4:200:2000')).toBe(true)
    })
  })
})
