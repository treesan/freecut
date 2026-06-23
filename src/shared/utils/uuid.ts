/**
 * UUID v5 implementation — deterministic name-based UUIDs.
 *
 * Used by the freecut-refs/1.0 format to derive stable `mediaRef` values
 * from source file paths, enabling round-trip workflows without requiring
 * the `uuid` npm package.
 */

// SHA-1 is the hash function for UUID v5 (RFC 4122 §4.3)
async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-1', data as BufferSource)
  return new Uint8Array(hash)
}

function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate a UUID v5 (name-based, SHA-1) per RFC 4122 §4.3.
 *
 * @param name - The name string (e.g. file path)
 * @param namespace - UUID namespace (as a standard UUID string like "6ba7b810-...")
 * @returns UUID v5 string in lowercase with dashes
 */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  // Parse namespace UUID to bytes
  const nsBytes = hexToBytes(namespace.replace(/-/g, ''))

  // Concatenate namespace + name
  const nameBytes = stringToBytes(name)
  const data = new Uint8Array(nsBytes.length + nameBytes.length)
  data.set(nsBytes)
  data.set(nameBytes, nsBytes.length)

  // SHA-1 hash
  const hash = await sha1(data)

  // Set version (5) and variant bits per RFC 4122 §4.3
  hash[6] = (hash[6]! & 0x0f) | 0x50 // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80 // variant 10xx

  // Format as UUID string
  const hex = bytesToHex(hash.slice(0, 16))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
