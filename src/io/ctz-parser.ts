/**
 * CTZ URL parser — entry point for importing CircuitJS circuits.
 *
 * CircuitJS encodes circuits as URL fragments containing raw-deflate-compressed
 * text, then base64-encoded. This module handles the full decode pipeline:
 *
 *   URL fragment → base64 decode → raw-deflate decompress → CTZ text → Circuit
 *
 * The browser-native DecompressionStream API is used for decompression.
 * In test environments (Node.js), install the polyfill from
 * src/test-utils/decompress-polyfill.ts before calling parseCtzUrl().
 */

import type { Circuit } from "../core/circuit.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { Diagnostic } from "../headless/netlist-types.js";
import { parseCtzText as parseCtzTextFormat, mapCtzToCircuit } from "./ctz-format.js";

// ---------------------------------------------------------------------------
// CTZ URL detection
// ---------------------------------------------------------------------------

/**
 * Known CircuitJS URL host patterns that indicate a CTZ-encoded circuit URL.
 *
 * Matches both the canonical falstad.com host and the common GitHub Pages
 * deployment path used by forks.
 */
const CTZ_URL_PATTERNS = [
  /falstad\.com\/circuit/,
  /circuitjs\.html/,
  /\/circuit\/circuitjs/,
];

/**
 * Return true when the given string looks like a CircuitJS CTZ URL.
 *
 * A CTZ URL is any URL that:
 * - Matches a known CircuitJS host/path pattern, AND
 * - Contains a `#` fragment (the compressed circuit data)
 *
 * This is used by the file loader and postMessage adapter to decide whether
 * to route a string to `parseCtzUrl()` instead of the JSON or .dig pipeline.
 */
export function isCtzUrl(url: string): boolean {
  if (!url.includes("#")) return false;
  return CTZ_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// ---------------------------------------------------------------------------
// Decompression — browser-native DecompressionStream
// ---------------------------------------------------------------------------

/**
 * Decompress a raw-deflate-compressed Uint8Array using the browser-native
 * DecompressionStream API (or the Node.js polyfill installed in test setup).
 *
 * CircuitJS URL fragments are compressed with raw deflate (no zlib wrapper),
 * so we use the 'deflate-raw' format where supported, with a fallback to
 * 'deflate' for environments that only expose the zlib-wrapped variant.
 */
async function decompressRawDeflate(compressed: Uint8Array): Promise<string> {
  // Try raw deflate first (correct for CircuitJS); fall back to zlib-wrapped
  // deflate for polyfill environments that only support 'deflate'.
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream("deflate-raw");
  } catch {
    ds = new DecompressionStream("deflate");
  }

  const stream = new Blob([compressed]).stream().pipeThrough(ds);
  const reader = stream.getReader();

  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    if (result.value) {
      chunks.push(result.value);
    }
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

// ---------------------------------------------------------------------------
// Base64 URL-safe decode
// ---------------------------------------------------------------------------

/**
 * Decode a base64 (or base64url) string to a Uint8Array.
 *
 * CircuitJS uses standard base64 in its URL fragments. Some variants use
 * base64url (- and _ instead of + and /); we normalise both.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const standard = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binaryStr = atob(standard);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// extractFragment
// ---------------------------------------------------------------------------

/**
 * Extract the fragment portion from a URL, stripping the leading `#`.
 *
 * Accepts:
 * - Full URLs: `https://www.falstad.com/circuit/circuitjs.html#...`
 * - Fragment-only with `#`: `#abc123`
 * - Fragment-only without `#`: `abc123`
 */
function extractFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx !== -1) {
    return url.slice(hashIdx + 1);
  }
  return url;
}

// ---------------------------------------------------------------------------
// parseCtzUrl — public API
// ---------------------------------------------------------------------------

/**
 * Parse a CircuitJS CTZ URL and return a digiTS Circuit.
 *
 * Pipeline:
 *   1. Extract the fragment from the URL (after `#`)
 *   2. Base64-decode the fragment
 *   3. Decompress using DecompressionStream('deflate-raw' or 'deflate')
 *   4. Parse the CTZ text format
 *   5. Map components to digiTS registry types
 *
 * @param url - Full CircuitJS URL, or just the fragment (with or without `#`)
 * @param registry - digiTS component registry
 * @param diagnostics - Optional mutable array to collect any import warnings
 * @returns The parsed Circuit
 */
export async function parseCtzUrl(
  url: string,
  registry: ComponentRegistry,
  diagnostics: Diagnostic[] = [],
): Promise<Circuit> {
  const fragment = extractFragment(url);
  const compressed = base64ToUint8Array(fragment);
  const text = await decompressRawDeflate(compressed);
  const components = parseCtzTextFormat(text);
  return mapCtzToCircuit(components, registry, diagnostics);
}

/**
 * Parse a CTZ text string (already decompressed) into a digiTS Circuit.
 *
 * Used when the caller has the raw CTZ text directly (e.g. from a .ctz file
 * or for testing without a URL).
 *
 * @param text - Raw CTZ text (decompressed line-based format)
 * @param registry - digiTS component registry
 * @param diagnostics - Optional mutable array to collect any import warnings
 * @returns The parsed Circuit
 */
export function parseCtzCircuitFromText(
  text: string,
  registry: ComponentRegistry,
  diagnostics: Diagnostic[] = [],
): Circuit {
  const components = parseCtzTextFormat(text);
  return mapCtzToCircuit(components, registry, diagnostics);
}
