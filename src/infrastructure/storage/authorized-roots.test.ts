import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { HandleRecord } from './handles-db'

// Mock the logger
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

// Mock handles-db — authorized-roots delegates all IDB ops there
const store = new Map<string, HandleRecord>()

vi.mock('./handles-db', () => ({
  getHandle: vi.fn(async (_kind: string, id: string) => store.get(id) ?? null),
  saveHandle: vi.fn(async (record: Omit<HandleRecord, 'key'>) => {
    const key = `${record.kind}:${record.id}`
    store.set(record.id, { ...record, key })
  }),
  deleteHandle: vi.fn(async (_kind: string, id: string) => {
    store.delete(id)
  }),
  listHandlesByKind: vi.fn(async (kind: string) =>
    [...store.values()].filter((r) => r.kind === kind),
  ),
  queryHandlePermission: vi.fn(async () => 'granted' as const),
  requestHandlePermission: vi.fn(async () => 'granted' as const),
}))

import {
  listAuthorizedRoots,
  addAuthorizedRoot,
  removeAuthorizedRoot,
  touchAuthorizedRoot,
  renameAuthorizedRoot,
  ensureRootPermission,
} from './authorized-roots'

afterEach(() => {
  store.clear()
  vi.clearAllMocks()
})

function mockDirHandle(name: string): FileSystemDirectoryHandle {
  return { name, kind: 'directory' } as unknown as FileSystemDirectoryHandle
}

describe('authorized-roots', () => {
  describe('addAuthorizedRoot', () => {
    it('persists a root with default displayName from handle.name', async () => {
      const handle = mockDirHandle('Videos')
      const root = await addAuthorizedRoot(handle)

      expect(root.displayName).toBe('Videos')
      expect(root.id).toBeTruthy()
      expect(root.addedAt).toBeGreaterThan(0)
      expect(root.lastUsedAt).toBe(root.addedAt)

      // Verify persisted
      const all = await listAuthorizedRoots()
      expect(all).toHaveLength(1)
      expect(all[0]!.id).toBe(root.id)
    })

    it('uses explicit displayName when provided', async () => {
      const handle = mockDirHandle('data')
      const root = await addAuthorizedRoot(handle, 'Project Media')
      expect(root.displayName).toBe('Project Media')
    })
  })

  describe('listAuthorizedRoots', () => {
    it('returns empty array when no roots exist', async () => {
      const all = await listAuthorizedRoots()
      expect(all).toEqual([])
    })

    it('returns all added roots', async () => {
      await addAuthorizedRoot(mockDirHandle('dir1'))
      await addAuthorizedRoot(mockDirHandle('dir2'))
      const all = await listAuthorizedRoots()
      expect(all).toHaveLength(2)
    })
  })

  describe('removeAuthorizedRoot', () => {
    it('removes a root by id', async () => {
      const root = await addAuthorizedRoot(mockDirHandle('ToRemove'))
      await removeAuthorizedRoot(root.id)
      const all = await listAuthorizedRoots()
      expect(all).toHaveLength(0)
    })
  })

  describe('touchAuthorizedRoot', () => {
    it('updates lastUsedAt', async () => {
      const root = await addAuthorizedRoot(mockDirHandle('Touched'))
      const originalLastUsedAt = root.lastUsedAt

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5))
      await touchAuthorizedRoot(root.id)

      const all = await listAuthorizedRoots()
      expect(all[0]!.lastUsedAt).toBeGreaterThanOrEqual(originalLastUsedAt)
    })
  })

  describe('renameAuthorizedRoot', () => {
    it('updates displayName', async () => {
      const root = await addAuthorizedRoot(mockDirHandle('Original'))
      await renameAuthorizedRoot(root.id, 'Renamed')

      const all = await listAuthorizedRoots()
      expect(all[0]!.displayName).toBe('Renamed')
    })
  })

  describe('ensureRootPermission', () => {
    it('returns true when queryPermission grants', async () => {
      const result = await ensureRootPermission(mockDirHandle('ok') as FileSystemDirectoryHandle)
      expect(result).toBe(true)
    })

    it('requests permission when query returns prompt', async () => {
      const { queryHandlePermission, requestHandlePermission } = await import('./handles-db')
      vi.mocked(queryHandlePermission).mockResolvedValueOnce('prompt')
      vi.mocked(requestHandlePermission).mockResolvedValueOnce('granted')

      const result = await ensureRootPermission(
        mockDirHandle('prompt') as FileSystemDirectoryHandle,
      )
      expect(result).toBe(true)
      expect(requestHandlePermission).toHaveBeenCalled()
    })

    it('returns false when permission denied', async () => {
      const { queryHandlePermission, requestHandlePermission } = await import('./handles-db')
      vi.mocked(queryHandlePermission).mockResolvedValueOnce('prompt')
      vi.mocked(requestHandlePermission).mockResolvedValueOnce('denied')

      const result = await ensureRootPermission(
        mockDirHandle('denied') as FileSystemDirectoryHandle,
      )
      expect(result).toBe(false)
    })
  })
})
