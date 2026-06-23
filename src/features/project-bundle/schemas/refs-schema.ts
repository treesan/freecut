/**
 * Zod Validation Schema for freecut-refs/1.0 (`.freecut.json`)
 *
 * Validates the path-reference project format including required `kind`,
 * `version`, every `media[]` field, and `pathHints.relativeToJson` requiredness.
 */

import { z } from 'zod'
import { REFS_KIND, REFS_VERSION } from '../types/refs'
import { projectSchema, formatValidationErrors } from './project-schema'

// ============================================================================
// Path Hints Schema
// ============================================================================

const pathHintsSchema = z.object({
  /** Always present; forward-slash separators regardless of OS */
  relativeToJson: z.string().min(1),
  /** Optional absolute path — omitted when stripPaths or handle-backed */
  absolute: z.string().min(1).optional(),
})

// ============================================================================
// Media Entry Schema
// ============================================================================

const mediaMetadataSchema = z.object({
  duration: z.number().min(0),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fps: z.number().min(0),
  codec: z.string(),
  bitrate: z.number().min(0),
})

const refsMediaEntrySchema = z.object({
  /** Deterministic UUID v5 — stable across regenerations */
  ref: z.string().uuid(),
  fileName: z.string().min(1),
  /** File size in bytes — strict identity field */
  fileSize: z.number().int().min(0),
  /** Last-modified timestamp in ms — strict identity field */
  fileLastModified: z.number().int().min(0),
  mimeType: z.string().min(1),
  metadata: mediaMetadataSchema,
  pathHints: pathHintsSchema,
})

// ============================================================================
// Top-Level RefsProject Schema
// ============================================================================

const refsProjectSchema = z
  .object({
    /** Format discriminator — must be `"freecut-refs"` */
    kind: z.literal(REFS_KIND),
    /** Format version — must be `"1.0"` */
    version: z.literal(REFS_VERSION),
    // ISO timestamp when exported. Lenient: external exporters (e.g. the
    // video-use Python tool) emit microsecond precision (`...17.591689+00:00`)
    // which Zod's strict `.datetime()` (≤3 fractional digits) rejects. The
    // field is informational only, so accept any non-empty string.
    exportedAt: z.string().min(1),
    /** Editor version that created this file */
    editorVersion: z.string(),
    /** Complete project data */
    project: projectSchema,
    /** Media references (path-based, no bytes) */
    media: z.array(refsMediaEntrySchema).min(0),
  })
  .passthrough()

// ============================================================================
// Inferred Types
// ============================================================================

type ValidatedRefsProject = z.infer<typeof refsProjectSchema>

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a `.freecut.json` document.
 *
 * Returns `{ success: true, data }` on valid input, or
 * `{ success: false, errors }` with field-level Zod errors on malformed input.
 */
export function validateRefsProject(data: unknown): {
  success: boolean
  data?: ValidatedRefsProject
  errors?: z.ZodError
} {
  const result = refsProjectSchema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return { success: false, errors: result.error }
}

/**
 * Check if the format version is compatible with this implementation.
 */
export function isRefsVersionCompatible(version: string): boolean {
  const [major] = version.split('.')
  const [currentMajor] = REFS_VERSION.split('.')
  return major === currentMajor
}

export { refsProjectSchema, refsMediaEntrySchema, pathHintsSchema, formatValidationErrors }
