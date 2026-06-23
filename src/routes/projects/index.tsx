import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { createLogger } from '@/shared/logging/logger'

const logger = createLogger('ProjectsIndex')
import { Button } from '@/components/ui/button'
import { Plus, Upload, FolderOpen, File, Github, BookOpen, FileJson } from 'lucide-react'
import { FreeCutLogo } from '@/components/brand/freecut-logo'
import { ProjectList } from '@/features/projects/components/project-list'
import { EditProjectForm } from '@/features/projects/components/project-form'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { useProjectActions } from '@/features/projects/hooks/use-project-actions'
import {
  useProjects,
  useProjectsLoading,
  useProjectsError,
} from '@/features/projects/hooks/use-project-selectors'
import { cleanupBlobUrls } from '@/features/media-library/utils/media-resolver'
import type { Project } from '@/types/project'
import type { ProjectFormData } from '@/features/projects/utils/validation'
import type { ImportProgress } from '@/features/project-bundle/types/bundle'
import { BUNDLE_EXTENSION } from '@/features/project-bundle/types/bundle'
import { REFS_EXTENSION } from '@/features/project-bundle/types/refs'
import { LegacyMigrationBanner } from '@/features/projects/components/legacy-migration-banner'
import { LegacyMigrationErrors } from '@/features/projects/components/legacy-migration-errors'
import { TrashSection } from '@/features/projects/components/trash-section'
import { WorkspaceIndicator } from '@/features/workspace-gate'
import { LanguageSwitcher } from '@/shared/ui/language-switcher'

export const Route = createFileRoute('/projects/')({
  component: ProjectsIndex,
  // Clean up any media blob URLs when returning to projects page
  beforeLoad: async () => {
    cleanupBlobUrls()
    // Always reload projects from storage to get fresh data (thumbnails may have changed)
    const { loadProjects } = useProjectStore.getState()
    await loadProjects()
  },
})

function ProjectsIndex() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Import state - two-step flow
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [projectNameFromFile, setProjectNameFromFile] = useState<string | null>(null)
  const [destinationDir, setDestinationDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [destinationName, setDestinationName] = useState<string | null>(null)
  const [useProjectsFolder, setUseProjectsFolder] = useState(true) // Create FreeCutProjects subfolder
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)

  const PROJECTS_FOLDER_NAME = 'FreeCutProjects'

  // Extract project name from import filename
  // Handles .freecut.zip and .freecut.json, plus browser-renamed files
  const extractProjectName = (fileName: string): string => {
    // Remove .zip extension first (for .freecut.zip)
    let name = fileName.replace(/\.zip$/i, '')
    // Remove .json extension (for .freecut.json)
    name = name.replace(/\.json$/i, '')
    // Remove browser duplicate suffix like " (1)", " (2)", etc.
    name = name.replace(/\s*\(\d+\)$/, '')
    // Remove .freecut suffix
    name = name.replace(/\.freecut$/i, '')
    return name
  }

  // Check if file is a valid import (freecut.zip or freecut.json)
  const isValidImportFile = (fileName: string): boolean => {
    // Match: anything.freecut.zip or anything.freecut (N).zip
    if (/\.freecut(\s*\(\d+\))?\.zip$/i.test(fileName)) return true
    // Match: anything.freecut.json
    if (/\.freecut\.json$/i.test(fileName)) return true
    return false
  }

  // Check if file is a refs format (.freecut.json)
  const isRefsFile = (fileName: string): boolean => {
    return /\.freecut\.json$/i.test(fileName)
  }

  // Pick a .freecut.json file via showOpenFilePicker (D10 strategy B)
  // Returns [jsonFileHandle, jsonDirectoryHandle?] or [null, undefined]
  const pickRefsFile = async (): Promise<
    [FileSystemFileHandle | null, FileSystemDirectoryHandle | undefined]
  > => {
    try {
      const [jsonFileHandle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'FreeCut Path-Reference Project',
            accept: { 'application/json': ['.freecut.json'] },
          },
        ],
        multiple: false,
      })
      // Directory handle is deferred (D10 strategy B) — not prompted upfront.
      // The path-resolution waterfall will request it only if relativeToJson needs it.
      return [jsonFileHandle ?? null, undefined]
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return [null, undefined]
      }
      logger.error('Failed to pick refs file:', err)
      return [null, undefined]
    }
  }

  const isLoading = useProjectsLoading()
  const projects = useProjects()
  const error = useProjectsError()
  const { loadProjects, updateProject } = useProjectActions()

  // Only show the full-page spinner for the genuine initial load — mutations
  // (delete/duplicate/update) should never blank the populated list.
  const showInitialLoadingSpinner = isLoading && projects.length === 0

  // Load projects on mount
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // Handle import file selection (ZIP — hidden <input>)
  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  // Handle .freecut.json import — uses showOpenFilePicker for FileSystemFileHandle
  const handleImportRefsClick = async () => {
    // Step 1: Pick the .freecut.json file (blocks until user selects or cancels)
    let jsonFileHandle: FileSystemFileHandle | undefined
    try {
      ;[jsonFileHandle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'FreeCut Path-Reference Project',
            accept: { 'application/json': ['.freecut.json'] },
          },
        ],
        multiple: false,
      })
    } catch (err) {
      // User cancelled — nothing to do
      if (err instanceof DOMException && err.name === 'AbortError') return
      logger.error('File picker failed:', err)
      setImportError(t('projects.import.selectFileFailed'))
      setImportDialogOpen(true)
      return
    }

    // showOpenFilePicker with multiple:false always returns one handle; the
    // guard satisfies the type system (noUncheckedIndexedAccess types the
    // destructured element as possibly undefined).
    if (!jsonFileHandle) return

    // Step 2 (D10): Pick the folder that contains the media. The JSON references
    // media via `pathHints.relativeToJson`, which may walk upward (`../`) — and the
    // browser exposes no API to traverse `..` from a directory handle. So we ask
    // the user for a folder covering the media and register it as an authorized
    // root; the resolution waterfall's authorized-root scan (matches by fileName +
    // identity, ignoring path direction) then locates each file. Done in the same
    // user-gesture chain as step 1 so the directory picker is permitted.
    let mediaDirHandle: FileSystemDirectoryHandle | undefined
    try {
      mediaDirHandle = await window.showDirectoryPicker({
        id: 'freecut-import-refs-media',
        mode: 'read',
        startIn: 'documents',
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      logger.error('Media directory picker failed:', err)
      setImportError(t('projects.import.selectJsonDirFailed'))
      setImportDialogOpen(true)
      return
    }

    // Register the picked folder as an authorized root so the waterfall's
    // step-4 scan can resolve media under it (and so future re-imports work).
    try {
      const { addAuthorizedRoot } = await import('@/infrastructure/storage/authorized-roots')
      await addAuthorizedRoot(mediaDirHandle)
    } catch (err) {
      logger.error('Failed to register authorized root:', err)
      // Non-fatal — import proceeds; media may just go unresolved.
    }

    // Step 3: Start import with progress dialog
    setImportError(null)
    setImportProgress({ percent: 0, stage: 'validating' })
    setIsImporting(true)
    setImportDialogOpen(true)

    try {
      const { importProjectFromRefs } =
        await import('@/features/project-bundle/services/refs-import-service')

      const result = await importProjectFromRefs(
        jsonFileHandle,
        mediaDirHandle, // directory handle for step-2 relative resolution (downward paths)
        {},
        (progress) => {
          setImportProgress(progress as ImportProgress)
        },
      )

      await loadProjects()
      handleCloseImportDialog()
      navigate({ to: '/editor/$projectId', params: { projectId: result.project.id } })
    } catch (err) {
      logger.error('Refs import failed:', err)
      setImportError(err instanceof Error ? err.message : t('projects.import.importFailed'))
      setImportProgress(null)
      setIsImporting(false)
    }
  }

  // Step 1: File selected - show destination selection dialog
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // Reset file input for next selection
    event.target.value = ''

    // Validate file extension (handles browser-renamed files like "project.freecut (1).zip")
    if (!isValidImportFile(file.name)) {
      setImportError(
        t('projects.import.invalidFile', { extension: `${BUNDLE_EXTENSION} or ${REFS_EXTENSION}` }),
      )
      setImportDialogOpen(true)
      return
    }

    // Store file and extract project name, then show destination selection dialog
    setPendingImportFile(file)
    setProjectNameFromFile(extractProjectName(file.name))
    setDestinationDir(null)
    setDestinationName(null)
    setImportError(null)
    setImportProgress(null)
    setIsImporting(false)
    setImportDialogOpen(true)
  }

  // Step 2: User clicks to select destination folder (fresh user gesture!)
  const handleSelectDestination = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({
        id: 'freecut-import',
        mode: 'readwrite',
        startIn: 'documents',
      })
      setDestinationDir(dirHandle)
      setDestinationName(dirHandle.name)
      setImportError(null)
    } catch (err) {
      // User cancelled - ignore
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      // Handle "contains system files" or permission errors
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      ) {
        setImportError(t('projects.import.cannotSelectSystemFolders'))
        return
      }
      logger.error('Failed to select directory:', err)
      setImportError(t('projects.import.selectDestinationFailed'))
    }
  }

  // Step 3: User clicks "Start Import" - begin actual import
  const handleStartImport = async () => {
    if (!pendingImportFile || !destinationDir) return

    setIsImporting(true)
    setImportProgress({ percent: 0, stage: 'validating' })

    try {
      // If useProjectsFolder is enabled, create/get the FreeCutProjects subfolder first
      let finalDestination = destinationDir
      if (useProjectsFolder) {
        try {
          finalDestination = await destinationDir.getDirectoryHandle(PROJECTS_FOLDER_NAME, {
            create: true,
          })
        } catch (err) {
          logger.error('Failed to create FreeCutProjects folder:', err)
          throw new Error(t('projects.import.createFolderFailed', { folder: PROJECTS_FOLDER_NAME }))
        }
      }

      const { importProjectBundle } =
        await import('@/features/project-bundle/services/bundle-import-service')

      // Dispatch based on file type
      if (pendingImportFile && isRefsFile(pendingImportFile.name)) {
        // .freecut.json — refs import path (D10 strategy B)
        const { importProjectFromRefs } =
          await import('@/features/project-bundle/services/refs-import-service')

        // Use showOpenFilePicker to get a FileSystemFileHandle
        // (the hidden <input> gives us a File, not a handle)
        const [jsonFileHandle, jsonDirHandle] = await pickRefsFile()
        if (!jsonFileHandle) {
          setImportError(t('projects.import.noFileSelected'))
          setIsImporting(false)
          setImportProgress(null)
          return
        }

        const result = await importProjectFromRefs(
          jsonFileHandle,
          jsonDirHandle,
          {},
          (progress) => {
            setImportProgress(progress as ImportProgress)
          },
        )

        // Reload projects list
        await loadProjects()

        // Close dialog and navigate to the imported project
        handleCloseImportDialog()
        navigate({ to: '/editor/$projectId', params: { projectId: result.project.id } })
        return
      }

      // .freecut.zip — existing bundle import path
      const result = await importProjectBundle(
        pendingImportFile,
        finalDestination,
        {},
        (progress) => {
          setImportProgress(progress)
        },
      )

      // Reload projects list
      await loadProjects()

      // Close dialog and navigate to the imported project
      handleCloseImportDialog()
      navigate({ to: '/editor/$projectId', params: { projectId: result.project.id } })
    } catch (err) {
      logger.error('Import failed:', err)
      setImportError(err instanceof Error ? err.message : t('projects.import.importFailed'))
      setImportProgress(null)
      setIsImporting(false)
    }
  }

  // Reset import dialog state
  const handleCloseImportDialog = () => {
    if (isImporting) return // Don't close while importing
    setImportDialogOpen(false)
    setPendingImportFile(null)
    setProjectNameFromFile(null)
    setDestinationDir(null)
    setDestinationName(null)
    setImportError(null)
    setImportProgress(null)
    setIsImporting(false)
  }

  // Compute full destination path for display
  const getFullDestinationPath = (): string => {
    if (!destinationName) return ''
    const parts = [destinationName]
    if (useProjectsFolder) parts.push(PROJECTS_FOLDER_NAME)
    if (projectNameFromFile) parts.push(projectNameFromFile)
    return parts.join('/')
  }

  // Format file size for display
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const handleEditProject = (project: Project) => {
    setEditingProject(project)
  }

  const handleEditSubmit = async (data: ProjectFormData) => {
    if (!editingProject) return

    setIsSubmitting(true)
    try {
      await updateProject(editingProject.id, data)
      setEditingProject(null)
    } catch (error) {
      logger.error('Failed to update project:', error)
      toast.error(t('projects.toasts.updateFailed'), { description: t('projects.tryAgain') })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <div className="min-h-screen bg-background">
        {/* Header */}
        <div className="panel-header border-b border-border" data-no-marquee>
          <div className="max-w-[1920px] mx-auto px-6 py-5 flex items-center justify-between">
            <Link to="/">
              <FreeCutLogo
                variant="full"
                size="md"
                className="hover:opacity-80 transition-opacity"
              />
            </Link>
            <div className="flex items-center gap-3">
              <WorkspaceIndicator />
              <LanguageSwitcher size="md" align="end" side="bottom" />
              <Button variant="outline" size="lg" className="gap-2" asChild>
                <Link to="/docs">
                  <BookOpen className="w-4 h-4" />
                  Docs
                </Link>
              </Button>
              <Button variant="outline" size="icon" className="h-10 w-10" asChild>
                <a
                  href="https://github.com/walterlow/freecut"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-tooltip={t('projects.viewOnGitHub')}
                  data-tooltip-side="left"
                >
                  <Github className="w-5 h-5" />
                </a>
              </Button>
              <Button variant="outline" size="lg" className="gap-2" onClick={handleImportClick}>
                <Upload className="w-4 h-4" />
                {t('projects.importProject')}
              </Button>
              <Button variant="outline" size="lg" className="gap-2" onClick={handleImportRefsClick}>
                <FileJson className="w-4 h-4" />
                {t('projects.importRefsProject')}
              </Button>
              <Link to="/projects/new">
                <Button size="lg" className="gap-2">
                  <Plus className="w-4 h-4" />
                  {t('projects.newProject')}
                </Button>
              </Link>
            </div>

            {/* Hidden file input for import */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.freecut.json"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </div>

        {/* Error state */}
        {error && (
          <div className="max-w-[1920px] mx-auto px-6 py-4">
            <div className="panel-bg border border-destructive/50 rounded-lg p-4 text-destructive">
              <p className="font-medium">{t('projects.errorLoading')}</p>
              <p className="text-sm mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Legacy IDB migration banner — appears only when old data is present and unmigrated */}
        <div className="max-w-[1920px] mx-auto px-6 pt-6 space-y-3">
          <LegacyMigrationBanner onMigrated={loadProjects} />
          {/* Retry banner — appears only when a previous migration left failed items behind */}
          <LegacyMigrationErrors onRetried={loadProjects} />
        </div>

        {/* Loading state */}
        {showInitialLoadingSpinner ? (
          <div className="max-w-[1920px] mx-auto px-6 py-16 flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin mx-auto mb-4" />
              <p className="text-muted-foreground">{t('projects.loadingProjects')}</p>
            </div>
          </div>
        ) : (
          /* Projects List */
          <div className="max-w-[1920px] mx-auto px-6 py-8">
            <ProjectList onEditProject={handleEditProject} onImportProject={handleImportClick} />
            <TrashSection />
          </div>
        )}
      </div>

      {/* Edit Project Dialog */}
      <Dialog open={!!editingProject} onOpenChange={(open) => !open && setEditingProject(null)}>
        <DialogContent className="max-w-[1200px] w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl">{t('projects.form.editTitle')}</DialogTitle>
            <DialogDescription>{t('projects.form.editSubtitle')}</DialogDescription>
          </DialogHeader>
          {editingProject && (
            <EditProjectForm
              onSubmit={handleEditSubmit}
              onCancel={() => setEditingProject(null)}
              defaultValues={{
                name: editingProject.name,
                description: editingProject.description,
                width: editingProject.metadata.width,
                height: editingProject.metadata.height,
                fps: editingProject.metadata.fps,
              }}
              isSubmitting={isSubmitting}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Import Project Dialog - Two Step Flow */}
      <Dialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          if (!open) handleCloseImportDialog()
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {importError
                ? t('projects.import.importFailedTitle')
                : isImporting
                  ? t('projects.import.importingTitle')
                  : t('projects.import.importTitle')}
            </DialogTitle>
            {!importError && !isImporting && pendingImportFile && (
              <DialogDescription>{t('projects.import.selectWhereToExtract')}</DialogDescription>
            )}
            {!importError && isImporting && importProgress && (
              <DialogDescription>
                {importProgress.stage === 'validating' && t('projects.import.stageValidating')}
                {importProgress.stage === 'selecting_directory' &&
                  t('projects.import.stageResolving')}
                {importProgress.stage === 'extracting' &&
                  (importProgress.currentFile
                    ? t('projects.import.stageExtractingFile', {
                        file: importProgress.currentFile,
                      })
                    : t('projects.import.stageExtracting'))}
                {importProgress.stage === 'importing_media' &&
                  (importProgress.currentFile
                    ? t('projects.import.stageImportingFile', { file: importProgress.currentFile })
                    : t('projects.import.stageImporting'))}
                {importProgress.stage === 'linking' && t('projects.import.stageLinking')}
                {importProgress.stage === 'complete' && t('projects.import.stageComplete')}
              </DialogDescription>
            )}
          </DialogHeader>

          {importError && !pendingImportFile ? (
            /* Fatal error state - no file */
            <div className="space-y-4">
              <p className="text-sm text-destructive">{importError}</p>
              <Button variant="outline" className="w-full" onClick={handleCloseImportDialog}>
                {t('common.close')}
              </Button>
            </div>
          ) : isImporting && importProgress ? (
            /* Importing state - show progress */
            <div className="space-y-4">
              <Progress value={importProgress.percent} className="h-2" />
              <p className="text-sm text-muted-foreground text-center">
                {Math.round(importProgress.percent)}%
              </p>
            </div>
          ) : pendingImportFile ? (
            /* Destination selection state */
            <div className="space-y-4">
              {/* File info */}
              <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                <File className="w-8 h-8 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{pendingImportFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(pendingImportFile.size)}
                  </p>
                </div>
              </div>

              {/* Destination selection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{t('projects.import.destinationFolder')}</p>
                  {!destinationDir && (
                    <p className="text-xs text-muted-foreground">
                      {t('projects.import.useNewFolderIfNeeded')}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={handleSelectDestination}
                >
                  <FolderOpen className="w-4 h-4" />
                  {destinationName ? (
                    <span className="truncate">{destinationName}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('projects.import.selectOrCreateFolder')}
                    </span>
                  )}
                </Button>

                {/* FreeCutProjects subfolder option */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useProjectsFolder}
                    onChange={(e) => setUseProjectsFolder(e.target.checked)}
                    className="w-4 h-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm">
                    <Trans
                      i18nKey="projects.import.createInSubfolder"
                      values={{ folder: PROJECTS_FOLDER_NAME }}
                      components={{
                        code: <code className="text-xs bg-muted px-1 py-0.5 rounded" />,
                      }}
                    />
                  </span>
                </label>

                {importError && <p className="text-xs text-destructive">{importError}</p>}
                {destinationDir && !importError && (
                  <div className="p-3 bg-muted/50 rounded-lg border border-border">
                    <p className="text-xs text-muted-foreground mb-1">
                      {t('projects.import.mediaWillBeSavedTo')}
                    </p>
                    <p className="text-sm font-semibold text-foreground break-all">
                      {getFullDestinationPath()}
                    </p>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={handleCloseImportDialog}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleStartImport} disabled={!destinationDir}>
                  {t('projects.import.startImport')}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
