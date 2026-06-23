import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  FolderArchive,
  Clock,
  HardDrive,
  FileVideo,
  Download,
  FileJson,
  Info,
} from 'lucide-react'
import type { ExportProgress, ExportResult } from '../types/bundle'
import type { RefsExportResult } from '../types/refs'
import {
  exportProjectBundle,
  exportProjectBundleStreaming,
  downloadBundle,
} from '../services/bundle-export-service'
import { exportProjectAsRefs } from '../services/refs-export-service'
import { formatDuration } from '@/shared/utils/time-utils'
import { formatBytes } from '@/shared/utils/format-utils'

export interface BundleExportDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  onBeforeExport?: () => Promise<void>
  /** Pre-acquired file handle for streaming export (avoids native picker inside modal) */
  fileHandle?: FileSystemFileHandle
  /** Pre-acquired directory handle for refs (.freecut.json) export (avoids native picker inside modal) */
  dirHandle?: FileSystemDirectoryHandle
  /** Pre-select format and skip the format-selection screen. */
  defaultFormat?: ExportFormat
}

type ExportStatus = 'idle' | 'selecting-format' | 'saving' | 'exporting' | 'completed' | 'failed'
type ExportFormat = 'zip' | 'json'

function getStageLabel(stage: ExportProgress['stage'], t: (key: string) => string): string {
  switch (stage) {
    case 'collecting':
      return t('projects.bundleExport.stageCollecting')
    case 'hashing':
      return t('projects.bundleExport.stageHashing')
    case 'packaging':
      return t('projects.bundleExport.stagePackaging')
    case 'complete':
      return t('projects.bundleExport.stageComplete')
    default:
      return t('projects.bundleExport.stageProcessing')
  }
}

export function BundleExportDialog({
  open,
  onClose,
  projectId,
  onBeforeExport,
  fileHandle,
  dirHandle,
  defaultFormat,
}: BundleExportDialogProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [format, setFormat] = useState<ExportFormat>('json')
  const [stripPaths, setStripPaths] = useState(false)
  const [progress, setProgress] = useState<ExportProgress>({ percent: 0, stage: 'collecting' })
  const [result, setResult] = useState<ExportResult | null>(null)
  const [refsResult, setRefsResult] = useState<RefsExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startTime, setStartTime] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // Guards against double-invoking the export when the auto-show effect and a
  // status transition both fire startExport.
  const exportStartedRef = useRef(false)

  const isExporting = status === 'saving' || status === 'exporting'
  const isSelectingFormat = status === 'selecting-format'
  const isCompleted = status === 'completed'
  const isFailed = status === 'failed'
  const preventClose = isExporting || isCompleted

  // Whether the completed export used streaming (file already on disk)
  const usedStreaming = isCompleted && !!fileHandle

  // Track elapsed time
  useEffect(() => {
    if (isExporting && !startTime) {
      setStartTime(Date.now())
    }
    if (!isExporting && !isCompleted) {
      setStartTime(null)
      setElapsedSeconds(0)
    }
  }, [isExporting, isCompleted, startTime])

  useEffect(() => {
    if (!startTime || !isExporting) return

    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [startTime, isExporting])

  // Start export for the given format. Takes the format as an argument so the
  // auto-show effect can kick it off without reading stale `format` state.
  const startExport = useCallback(
    async (fmt: ExportFormat) => {
      setError(null)
      setResult(null)
      setRefsResult(null)
      setProgress({ percent: 0, stage: 'collecting' })
      setStatus('saving')

      try {
        // Save project first if callback provided
        if (onBeforeExport) {
          await onBeforeExport()
        }

        setStatus('exporting')

        if (fmt === 'json') {
          // Refs export: use the pre-acquired directory handle when available
          // (avoids opening the native picker from inside the modal dialog,
          // which conflicts with Radix focus handling). Fall back to the picker
          // for the manual format-selection flow.
          let destDir = dirHandle
          if (!destDir) {
            destDir = await window.showDirectoryPicker({
              id: 'freecut-export-refs',
              mode: 'readwrite',
              startIn: 'documents',
            })
          }

          const refsExportResult = await exportProjectAsRefs(projectId, destDir, {
            stripPaths,
            prettyPrint: true,
          })
          setRefsResult(refsExportResult)
        } else {
          // Bundle export (existing path)
          let exportResult: ExportResult

          if (fileHandle) {
            exportResult = await exportProjectBundleStreaming(projectId, fileHandle, (p) => {
              setProgress(p)
            })
          } else {
            exportResult = await exportProjectBundle(projectId, (p) => {
              setProgress(p)
            })
          }

          setResult(exportResult)
        }

        setStatus('completed')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // User cancelled directory picker — go back to format selection
          exportStartedRef.current = false
          setStatus('selecting-format')
          return
        }
        setError(err instanceof Error ? err.message : t('projects.bundleExport.exportFailed'))
        setStatus('failed')
      }
    },
    [projectId, onBeforeExport, fileHandle, dirHandle, t, stripPaths],
  )

  // Auto-show format selection when dialog opens, or kick off the export
  // immediately when a defaultFormat is provided.
  useEffect(() => {
    if (!open || status !== 'idle') return
    if (defaultFormat) {
      setFormat(defaultFormat)
      if (!exportStartedRef.current) {
        exportStartedRef.current = true
        void startExport(defaultFormat)
      }
    } else {
      setStatus('selecting-format')
    }
  }, [open, status, defaultFormat, startExport])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setStatus('idle')
      setFormat('json')
      setStripPaths(false)
      setProgress({ percent: 0, stage: 'collecting' })
      setResult(null)
      setRefsResult(null)
      setError(null)
      setStartTime(null)
      setElapsedSeconds(0)
      exportStartedRef.current = false
    }
  }, [open])

  // Handle download
  const handleDownload = () => {
    if (result) {
      downloadBundle(result)
    }
  }

  // Prevent closing during export
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isExporting) {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal>
      <DialogContent
        className="sm:max-w-[425px] overflow-hidden"
        hideCloseButton={preventClose}
        onPointerDownOutside={(e) => preventClose && e.preventDefault()}
        onEscapeKeyDown={(e) => preventClose && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isExporting && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
            {isCompleted && <CheckCircle2 className="h-5 w-5 text-green-500" />}
            {isFailed && <AlertCircle className="h-5 w-5 text-destructive" />}
            {status === 'idle' && <FolderArchive className="h-5 w-5" />}
            {status === 'saving' && t('projects.bundleExport.savingProject')}
            {status === 'exporting' && t('projects.bundleExport.exportingProject')}
            {isCompleted && t('projects.bundleExport.exportComplete')}
            {isFailed && t('projects.bundleExport.exportFailed')}
            {status === 'idle' && t('projects.bundleExport.title')}
          </DialogTitle>
          <DialogDescription>
            {isExporting && t('projects.bundleExport.creatingBundle')}
            {isCompleted &&
              (refsResult || usedStreaming
                ? t('projects.bundleExport.bundleSavedDescription')
                : t('projects.bundleExport.bundleReadyDescription'))}
            {isFailed && t('projects.bundleExport.somethingWentWrong')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-hidden">
          {/* Format selection */}
          {isSelectingFormat && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {/* JSON format option */}
                <button
                  type="button"
                  onClick={() => setFormat('json')}
                  className={`flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors ${
                    format === 'json'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-muted-foreground/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileJson className="h-5 w-5" />
                    <span className="font-medium">{t('projects.bundleExport.formatJson')}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.bundleExport.formatJsonDesc')}
                  </span>
                </button>

                {/* ZIP format option */}
                <button
                  type="button"
                  onClick={() => setFormat('zip')}
                  className={`flex flex-col items-start gap-2 rounded-lg border-2 p-4 text-left transition-colors ${
                    format === 'zip'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-muted-foreground/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FolderArchive className="h-5 w-5" />
                    <span className="font-medium">{t('projects.bundleExport.formatZip')}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.bundleExport.formatZipDesc')}
                  </span>
                </button>
              </div>

              {/* Strip paths checkbox (JSON only) */}
              {format === 'json' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="strip-paths"
                      checked={stripPaths}
                      onChange={(e) => setStripPaths(e.target.checked)}
                      className="w-4 h-4 rounded border-border accent-primary"
                    />
                    <label htmlFor="strip-paths" className="text-sm cursor-pointer">
                      {t('projects.bundleExport.stripPaths')}
                    </label>
                  </div>

                  {stripPaths && (
                    <Alert>
                      <Info className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        {t('projects.bundleExport.stripPathsInfo')}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Progress section */}
          {isExporting && (
            <div className="space-y-4 min-w-0">
              {/* Progress bar with percentage */}
              <div className="space-y-2 min-w-0">
                <div className="w-full overflow-hidden">
                  <Progress value={progress.percent} className="h-2 w-full" />
                </div>
                <div className="flex items-center justify-between text-sm gap-2">
                  <span className="text-muted-foreground truncate">
                    {status === 'saving'
                      ? t('projects.bundleExport.savingLatestChanges')
                      : getStageLabel(progress.stage, t)}
                  </span>
                  <span className="font-medium tabular-nums flex-shrink-0">
                    {Math.round(progress.percent)}%
                  </span>
                </div>
              </div>

              {/* Current file */}
              {progress.currentFile && (
                <div className="rounded-md bg-muted/50 px-3 py-2 min-w-0 overflow-hidden">
                  <p className="text-xs text-muted-foreground mb-1">
                    {t('projects.bundleExport.currentFile')}
                  </p>
                  <p className="text-sm truncate" title={progress.currentFile}>
                    {progress.currentFile}
                  </p>
                </div>
              )}

              {/* Elapsed time */}
              {elapsedSeconds > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground">
                    {t('projects.bundleExport.elapsed')}
                  </span>
                  <span className="font-medium tabular-nums">{formatDuration(elapsedSeconds)}</span>
                </div>
              )}
            </div>
          )}

          {/* Success state (zip) */}
          {isCompleted && result && (
            <div className="space-y-4">
              <Alert className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-700 dark:text-green-400">
                  {usedStreaming
                    ? t('projects.bundleExport.savedSuccess')
                    : t('projects.bundleExport.createdSuccess')}
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <FolderArchive className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('projects.bundleExport.file')}</span>
                  <span className="font-medium truncate">{result.filename}</span>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <HardDrive className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{t('projects.bundleExport.size')}</span>
                    <span className="font-medium">{formatBytes(result.size)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <FileVideo className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {t('projects.bundleExport.mediaFiles')}
                    </span>
                    <span className="font-medium">{result.mediaCount}</span>
                  </div>
                  {elapsedSeconds > 0 && (
                    <div className="flex items-center gap-2 text-sm">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {t('projects.bundleExport.timeTaken')}
                      </span>
                      <span className="font-medium">{formatDuration(elapsedSeconds)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Success state (refs/JSON) */}
          {isCompleted && refsResult && (
            <div className="space-y-4">
              <Alert className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-700 dark:text-green-400">
                  {t('projects.bundleExport.refsExportSuccess')}
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <FileJson className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('projects.bundleExport.file')}</span>
                  <span className="font-medium truncate">{refsResult.filename}</span>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <FileVideo className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {t('projects.bundleExport.mediaFiles')}
                    </span>
                    <span className="font-medium">{refsResult.mediaCount}</span>
                  </div>
                  {refsResult.opfsSpillover && (
                    <div className="flex items-center gap-2 text-sm">
                      <Info className="h-4 w-4 text-yellow-500" />
                      <span className="text-muted-foreground">
                        {t('projects.bundleExport.opfsSpilloverNote')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Error state */}
          {isFailed && error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          {isSelectingFormat && (
            <>
              <Button variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button onClick={() => startExport(format)}>
                {t('projects.bundleExport.startExport')}
              </Button>
            </>
          )}

          {isCompleted && (
            <>
              <Button variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
              {result && !usedStreaming && (
                <Button onClick={handleDownload}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('projects.bundleExport.download')}
                </Button>
              )}
            </>
          )}

          {isFailed && (
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
