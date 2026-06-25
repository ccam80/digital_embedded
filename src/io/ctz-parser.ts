/**
 * CTZ URL parser- entry point for importing CircuitJS circuits.
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
import type { Diagnostic } from "../compile/types.js";
import { parseCtzText as parseCtzTextFormat, mapCtzToCircuit } from "./ctz-format.js";



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
