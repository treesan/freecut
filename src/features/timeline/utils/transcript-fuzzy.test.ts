import { describe, expect, it } from 'vitest'
import {
  boundedLevenshtein,
  findTranscriptWordMatches,
  fuzzyThreshold,
  normalizeForSearch,
} from './transcript-fuzzy'

describe('normalizeForSearch', () => {
  it('folds case and diacritics', () => {
    expect(normalizeForSearch('CAFÉ')).toBe('cafe')
    expect(normalizeForSearch('Tüm')).toBe('tum')
  })
})

describe('boundedLevenshtein', () => {
  it('computes distance for near words', () => {
    expect(boundedLevenshtein('vid', 'ved', 2)).toBe(1)
    expect(boundedLevenshtein('silence', 'silences', 2)).toBe(1)
    expect(boundedLevenshtein('kitten', 'sitting', 3)).toBe(3)
  })

  it('returns 0 for identical strings', () => {
    expect(boundedLevenshtein('netherlands', 'netherlands', 2)).toBe(0)
  })

  it('early-exits beyond the ceiling', () => {
    // Distance is 7, ceiling is 2 → returns max + 1, never the true distance.
    expect(boundedLevenshtein('cat', 'elephant', 2)).toBe(3)
  })

  it('handles empty strings', () => {
    expect(boundedLevenshtein('', 'abc', 5)).toBe(3)
    expect(boundedLevenshtein('abc', '', 5)).toBe(3)
  })
})

describe('fuzzyThreshold', () => {
  it('scales with query length', () => {
    expect(fuzzyThreshold(3)).toBe(1)
    expect(fuzzyThreshold(6)).toBe(2)
    expect(fuzzyThreshold(12)).toBe(3)
  })
})

describe('findTranscriptWordMatches', () => {
  const words = ['How', 'to', 'trim', 'silences', 'in', 'Ved', 'editor']

  it('returns empty for a blank query', () => {
    expect(findTranscriptWordMatches(words, '   ')).toEqual({ indices: [], approximate: false })
  })

  it('matches exact substrings without approximation', () => {
    const result = findTranscriptWordMatches(words, 'sil')
    expect(result).toEqual({ indices: [3], approximate: false })
  })

  it('is case- and punctuation-insensitive on exact matches', () => {
    const result = findTranscriptWordMatches(['Trim,', 'TRIMMED'], 'trim')
    expect(result.approximate).toBe(false)
    expect(result.indices).toEqual([0, 1])
  })

  it('falls back to fuzzy only when exact finds nothing', () => {
    // "Vid" is not a substring of any token, but is one edit from "Ved".
    const result = findTranscriptWordMatches(words, 'Vid')
    expect(result.approximate).toBe(true)
    expect(result.indices).toEqual([5])
  })

  it('does not fuzz when an exact match exists', () => {
    // "trim" matches exactly, so "trip" is irrelevant — but "trim" itself stays exact.
    const result = findTranscriptWordMatches(words, 'trim')
    expect(result).toEqual({ indices: [2], approximate: false })
  })

  it('skips fuzzy for very short queries', () => {
    const result = findTranscriptWordMatches(['ax', 'by'], 'az')
    expect(result).toEqual({ indices: [], approximate: false })
  })

  it('treats multi-word queries as exact-only', () => {
    const result = findTranscriptWordMatches(['remove', 'silences'], 'remove silences')
    expect(result).toEqual({ indices: [], approximate: false })
  })
})
