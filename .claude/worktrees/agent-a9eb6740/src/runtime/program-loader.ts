/**
 * Program memory loader — loads binary/hex data into a DataField.
 *
 * Entry point: loadProgram(data, format, target, options?)
 *
 * Supported formats: Intel HEX, raw binary, CSV, Logisim v2, Logisim v3.
 * Format auto-detection is available via detectFormatFromContent / detectFormatFromExtension.
 */

import type { DataField } from "../components/memory/ram.js";
import { parseIntelHex } from "./hex-parser.js";
import {
  parseCsv,
  parseLogisim,
  parseRawBinary,
  detectFormatFromExtension,
  detectFormatFromContent,
} from "./program-formats.js";
import type { ProgramFormat } from "./program-formats.js";

export type { ProgramFormat };
export { detectFormatFromExtension, detectFormatFromContent };

// ---------------------------------------------------------------------------
// Load options
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /**
   * If true, byte ordering within each word is big-endian for raw binary.
   * Only affects raw binary format with wordSize > 1.
   */
  bigEndian?: boolean;
  /**
   * Word size in bytes for raw binary parsing (1, 2, or 4).
   * Defaults to 1 (byte-per-word).
   */
  wordSize?: 1 | 2 | 4;
}

// ---------------------------------------------------------------------------
// loadProgram
// ---------------------------------------------------------------------------

/**
 * Load program data into the target DataField.
 *
 * For text formats (Intel HEX, CSV, Logisim), pass the file content as a
 * string. For raw binary, pass an ArrayBuffer.
 *
 * @param data    - File content: string for text formats, ArrayBuffer for binary
 * @param format  - Explicit format (or use detectFormatFromContent to auto-detect)
 * @param target  - DataField to write into
 * @param options - Optional load options (bigEndian, wordSize)
 */
export function loadProgram(
  data: ArrayBuffer | string,
  format: ProgramFormat,
  target: DataField,
  options: LoadOptions = {},
): void {
  switch (format) {
    case "intelHex": {
      const text = requireString(data, "intelHex");
      const bytes = parseIntelHex(text);
      for (const { address, value } of bytes) {
        target.write(address, value);
      }
      break;
    }
    case "rawBinary": {
      const buffer = requireBuffer(data, "rawBinary");
      const wordSize = options.wordSize ?? 1;
      const bigEndian = options.bigEndian ?? false;
      const entries = parseRawBinary(buffer, wordSize, bigEndian);
      for (const { address, value } of entries) {
        target.write(address, value);
      }
      break;
    }
    case "csv": {
      const text = requireString(data, "csv");
      const entries = parseCsv(text);
      for (const { address, value } of entries) {
        target.write(address, value);
      }
      break;
    }
    case "logisimV2":
    case "logisimV3": {
      const text = requireString(data, format);
      const entries = parseLogisim(text);
      for (const { address, value } of entries) {
        target.write(address, value);
      }
      break;
    }
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown program format: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function requireString(data: ArrayBuffer | string, format: string): string {
  if (typeof data !== "string") {
    throw new Error(`Format '${format}' requires string data, got ArrayBuffer`);
  }
  return data;
}

function requireBuffer(data: ArrayBuffer | string, format: string): ArrayBuffer {
  if (typeof data === "string") {
    throw new Error(`Format '${format}' requires ArrayBuffer data, got string`);
  }
  return data;
}
