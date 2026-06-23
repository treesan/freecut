/**
 * Authorized Roots — persisted directory authorizations for path-reference imports.
 *
 * Stores user-granted root `FileSystemDirectoryHandle`s in the existing
 * `freecut-handles-db` IndexedDB (using kind='authorized-root') so they
 * survive page reloads and new sessions. A single directory grant covers
 * all descendant media files.
 *
 * Re-exported from `@/infrastructure/storage`.
 */

import {
  getHandle,
  saveHandle,
  deleteHandle,
  listHandlesByKind,
  queryHandlePermission,
  requestHandlePermission,
  type HandleRecord,
} from './handles-db'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('AuthorizedRoots')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthorizedRoot {
  /** Stable unique id (UUID) */
  id: string
  /** Display name — defaults to the directory's `name` property */
  displayName: string
  /** The persisted directory handle */
  handle: FileSystemDirectoryHandle
  /** Timestamp when the root was first added */
  addedAt: number
  /** Timestamp when the root was last used to resolve media */
  lastUsedAt: number
}

// ---------------------------------------------------------------------------
// Internal mapping to HandleRecord
// ---------------------------------------------------------------------------

/**
 * We reuse the `handles` store in `freecut-handles-db` with kind='authorized-root'.
 * The `HandleRecord.key` is `authorized-root:{id}`.
 *
 * Field mapping:
 *   HandleRecord.key           → `authorized-root:{id}`
 *   HandleRecord.kind          → 'authorized-root'
 *   HandleRecord.id            → AuthorizedRoot.id
 *   HandleRecord.handle        → AuthorizedRoot.handle
 *   HandleRecord.name          → AuthorizedRoot.displayName
 *   HandleRecord.pickedAt      → AuthorizedRoot.addedAt
 *   HandleRecord.lastSeenPath  → (not used)
 *   HandleRecord.lastSeenMtime → AuthorizedRoot.lastUsedAt  (repurposed field)
 */

const KIND = 'authorized-root' as const

function fromRecord(record: HandleRecord): AuthorizedRoot {
  return {
    id: record.id,
    displayName: record.name,
    handle: record.handle as FileSystemDirectoryHandle,
    addedAt: record.pickedAt,
    lastUsedAt: record.lastSeenMtime ?? record.pickedAt,
  }
}

// ---------------------------------------------------------------------------
// CRUD API
// ---------------------------------------------------------------------------

/**
 * List all persisted authorized roots.
 */
export async function listAuthorizedRoots(): Promise<AuthorizedRoot[]> {
  const all = await listHandlesByKind(KIND)
  return all.map(fromRecord)
}

/**
 * Add a new authorized root. Persists the handle in IDB.
 * `displayName` defaults to `handle.name` if not provided.
 */
export async function addAuthorizedRoot(
  handle: FileSystemDirectoryHandle,
  displayName?: string,
): Promise<AuthorizedRoot> {
  const id = crypto.randomUUID()
  const now = Date.now()
  const name = displayName ?? handle.name

  await saveHandle({
    kind: KIND,
    id,
    handle,
    name,
    pickedAt: now,
    lastSeenMtime: now,
  })

  return { id, displayName: name, handle, addedAt: now, lastUsedAt: now }
}

/**
 * Remove an authorized root by id. Does NOT modify any `MediaMetadata`
 * records that previously resolved through this root.
 */
export async function removeAuthorizedRoot(id: string): Promise<void> {
  await deleteHandle(KIND, id)
}

/**
 * Update the `lastUsedAt` timestamp on an authorized root.
 * Called each time the resolution API successfully resolves media through it.
 */
export async function touchAuthorizedRoot(id: string): Promise<void> {
  const record = await getHandle(KIND, id)
  if (!record) {
    logger.warn(`touchAuthorizedRoot: root ${id} not found`)
    return
  }
  await saveHandle({
    ...record,
    lastSeenMtime: Date.now(),
  })
}

/**
 * Rename an authorized root's display name.
 */
export async function renameAuthorizedRoot(id: string, displayName: string): Promise<void> {
  const record = await getHandle(KIND, id)
  if (!record) {
    logger.warn(`renameAuthorizedRoot: root ${id} not found`)
    return
  }
  await saveHandle({
    ...record,
    name: displayName,
  })
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a directory handle has read permission. Calls `queryPermission`
 * first; if not `granted`, calls `requestPermission`. Returns `true` if
 * the handle is usable, `false` if the user denied or the browser revoked.
 */
export async function ensureRootPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const queryResult = await queryHandlePermission(handle, 'read')
  if (queryResult === 'granted') return true

  const requestResult = await requestHandlePermission(handle, 'read')
  return requestResult === 'granted'
}
