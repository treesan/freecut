/**
 * Authorized Folders list component for the Settings dialog.
 *
 * Lists persisted authorized-root directory handles with Revoke action.
 * Adding new roots happens implicitly during `.freecut.json` import.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  listAuthorizedRoots,
  removeAuthorizedRoot,
  renameAuthorizedRoot,
  type AuthorizedRoot,
} from '@/infrastructure/storage/authorized-roots'
import { X, Pencil, FolderLock } from 'lucide-react'

export function AuthorizedFoldersList() {
  const { t } = useTranslation()
  const [roots, setRoots] = useState<AuthorizedRoot[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const loadRoots = useCallback(async () => {
    const list = await listAuthorizedRoots()
    setRoots(list)
  }, [])

  useEffect(() => {
    loadRoots()
  }, [loadRoots])

  const handleRevoke = async (id: string) => {
    await removeAuthorizedRoot(id)
    await loadRoots()
  }

  const handleStartRename = (root: AuthorizedRoot) => {
    setEditingId(root.id)
    setEditName(root.displayName)
  }

  const handleConfirmRename = async () => {
    if (editingId && editName.trim()) {
      await renameAuthorizedRoot(editingId, editName.trim())
      await loadRoots()
    }
    setEditingId(null)
    setEditName('')
  }

  const handleCancelRename = () => {
    setEditingId(null)
    setEditName('')
  }

  if (roots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <FolderLock className="h-10 w-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">
          {t('settings.authorizedFolders.emptyState')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {roots.map((root) => (
        <div key={root.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
          <FolderLock className="h-4 w-4 text-muted-foreground flex-shrink-0" />

          {editingId === root.id ? (
            <input
              className="flex-1 bg-transparent text-sm outline-none border-b border-primary"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmRename()
                if (e.key === 'Escape') handleCancelRename()
              }}
              onBlur={handleConfirmRename}
              autoFocus
            />
          ) : (
            <span className="flex-1 text-sm truncate">{root.displayName}</span>
          )}

          {editingId !== root.id && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => handleStartRename(root)}
                title={t('settings.authorizedFolders.rename')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => handleRevoke(root.id)}
                title={t('settings.authorizedFolders.revoke')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
