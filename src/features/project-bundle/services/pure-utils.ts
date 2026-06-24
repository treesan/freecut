import type { BundleManifest } from '../types/bundle'
import type { ProjectSnapshot } from '../types/snapshot'

const HEX_RADIX = 16

export function sanitizeBundleDirectoryName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 100)
      .trim() || 'untitled'
  )
}

export function sanitizeBundleFileName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]/g, '_')
      .substring(0, 200)
      .trim() || 'unnamed'
  )
}

export function sanitizeDownloadFilename(
  name: string,
  options: { fallback?: string } = {},
): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
  return sanitized || options.fallback || ''
}

export function getUniqueBundleFileName(
  usedFilenames: ReadonlySet<string>,
  hash: string,
  fileName: string,
): string {
  let bundleFileName = fileName
  let counter = 1
  while (usedFilenames.has(`${hash}/${bundleFileName}`)) {
    const ext = fileName.lastIndexOf('.')
    if (ext > 0) {
      bundleFileName = `${fileName.substring(0, ext)}_${counter}${fileName.substring(ext)}`
    } else {
      bundleFileName = `${fileName}_${counter}`
    }
    counter++
  }
  return bundleFileName
}

/**
 * Compute a SHA-256 integrity checksum over a project document, blanking the
 * `checksum` field so the value is self-consistent regardless of whether it is
 * present. Shared by both the refs (`.freecut.json` freecut-refs/1.0) and the
 * debug `ProjectSnapshot` formats so both compute and verify integrity
 * identically — canonicalization lives in one place.
 */
export async function computeProjectChecksum(doc: object): Promise<string> {
  const dataForHash = { ...doc, checksum: undefined }
  return sha256Hex(JSON.stringify(dataForHash))
}

/**
 * Snapshot checksum — delegates to the shared {@link computeProjectChecksum}.
 * Preserved as a named export for existing callers.
 */
export async function computeSnapshotChecksum(snapshot: ProjectSnapshot): Promise<string> {
  return computeProjectChecksum(snapshot)
}

export async function computeBundleManifestChecksum(manifest: BundleManifest): Promise<string> {
  const manifestForHash = { ...manifest, checksum: '' }
  return sha256Hex(JSON.stringify(manifestForHash))
}

async function sha256Hex(value: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('')
}
