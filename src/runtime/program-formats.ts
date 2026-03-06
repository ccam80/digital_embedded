/**
 * Program format detection, CSV parser, Logisim parser, and raw binary handler.
 *
 * Supported formats:
 *   - Intel HEX  (.hex, .ihex)
 *   - Raw binary (.bin)
 *   - CSV        (.csv)  — "address,value" pairs, one per line
 *   - Logisim v2 raw    — "v2.0 raw" header, space/newline separated hex words
 *   - Logisim v3 raw    — "v3.0 raw" header (same layout as v2)
 */

// ---------------------------------------------------------------------------
// ProgramFormat
// ---------------------------------------------------------------------------

export type ProgramFormat = "intelHex" | "rawBinary" | "csv" | "logisimV2" | "logisimV3";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Auto-detect the format from a file extension.
 *
 * @param filename - File name including extension (e.g. "program.hex")
 * @returns Detected ProgramFormat
 * @throws Error if the extension is unrecognised
 */
export function detectFormatFromExtension(filename: string): ProgramFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".hex") || lower.endsWith(".ihex")) return "intelHex";
  if (lower.endsWith(".bin")) return "rawBinary";
  if (lower.endsWith(".csv")) return "csv";
  throw new Error(`Unknown file extension for format detection: '${filename}'`);
}

/**
 * Auto-detect format from file content.
 * Checks the content header before falling back to extension-based detection.
 *
 * @param content - File content as string (for text formats) or first bytes as string
 * @param filename - Optional filename hint for extension-based detection
 */
export function detectFormatFromContent(content: string, filename?: string): ProgramFormat {
  const trimmed = content.trimStart();

  if (trimmed.startsWith("v2.0 raw")) return "logisimV2";
  if (trimmed.startsWith("v3.0 raw")) return "logisimV3";
  if (trimmed.startsWith(":")) return "intelHex";

  if (filename !== undefined) {
    try {
      return detectFormatFromExtension(filename);
    } catch {
      // fall through to CSV heuristic
    }
  }

  // CSV heuristic: first non-blank line contains a comma
  const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
  if (firstLine.includes(",")) return "csv";

  return "rawBinary";
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

export interface CsvEntry {
  address: number;
  value: number;
}

/**
 * Parse a CSV file of "address,value" pairs.
 *
 * - Lines beginning with '#' are comments and are skipped.
 * - Empty lines are skipped.
 * - Addresses and values may be decimal or hex (0x prefix).
 *
 * @param csv - CSV text content
 * @returns Array of parsed address/value pairs
 */
export function parseCsv(csv: string): CsvEntry[] {
  const entries: CsvEntry[] = [];
  const lines = csv.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const commaIdx = line.indexOf(",");
    if (commaIdx === -1) {
      throw new Error(`CSV: missing comma on line: '${line}'`);
    }

    const addrStr = line.slice(0, commaIdx).trim();
    const valStr  = line.slice(commaIdx + 1).trim();

    const address = parseIntAuto(addrStr);
    const value   = parseIntAuto(valStr);

    if (isNaN(address)) throw new Error(`CSV: invalid address: '${addrStr}'`);
    if (isNaN(value))   throw new Error(`CSV: invalid value: '${valStr}'`);

    entries.push({ address, value });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Logisim parser
// ---------------------------------------------------------------------------

export interface LogisimEntry {
  address: number;
  value: number;
}

/**
 * Parse a Logisim v2.0 raw or v3.0 raw file.
 *
 * Format: first line is "v2.0 raw" or "v3.0 raw", followed by space/newline
 * separated hex words. Supports run-length encoding: "N*value" means value
 * repeated N times at consecutive addresses.
 *
 * @param content - File text content
 * @returns Array of address/value pairs (address is sequential word index)
 */
export function parseLogisim(content: string): LogisimEntry[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) throw new Error("Logisim: empty file");

  const header = lines[0].trim().toLowerCase();
  if (!header.startsWith("v2.0 raw") && !header.startsWith("v3.0 raw")) {
    throw new Error(`Logisim: unrecognised header: '${lines[0]}'`);
  }

  const entries: LogisimEntry[] = [];
  let address = 0;

  // Join remaining lines and split on whitespace
  const tokens = lines.slice(1).join(" ").split(/\s+/).filter((t) => t.length > 0);

  for (const token of tokens) {
    // Run-length encoding: N*value
    const starIdx = token.indexOf("*");
    if (starIdx !== -1) {
      const count = parseInt(token.slice(0, starIdx), 10);
      const value = parseInt(token.slice(starIdx + 1), 16);
      if (isNaN(count) || isNaN(value)) {
        throw new Error(`Logisim: invalid run-length token: '${token}'`);
      }
      for (let i = 0; i < count; i++) {
        entries.push({ address: address++, value });
      }
    } else {
      const value = parseInt(token, 16);
      if (isNaN(value)) throw new Error(`Logisim: invalid hex token: '${token}'`);
      entries.push({ address: address++, value });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Raw binary handler
// ---------------------------------------------------------------------------

export interface BinaryEntry {
  address: number;
  value: number;
}

/**
 * Parse raw binary data into sequential byte/word entries.
 *
 * Each byte in the ArrayBuffer becomes one entry at consecutive addresses
 * starting from 0. For word-width memories, use the bigEndian option to
 * control byte ordering within each word.
 *
 * @param buffer   - Raw binary data
 * @param wordSize - Word size in bytes (1 = bytes, 2 = 16-bit words, 4 = 32-bit words)
 * @param bigEndian - If true, bytes within each word are big-endian
 */
export function parseRawBinary(
  buffer: ArrayBuffer,
  wordSize: 1 | 2 | 4 = 1,
  bigEndian: boolean = false,
): BinaryEntry[] {
  const bytes = new Uint8Array(buffer);
  const entries: BinaryEntry[] = [];
  let address = 0;

  for (let i = 0; i < bytes.length; i += wordSize) {
    let value = 0;
    if (wordSize === 1) {
      value = bytes[i];
    } else if (wordSize === 2) {
      if (bigEndian) {
        value = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
      } else {
        value = ((bytes[i + 1] ?? 0) << 8) | (bytes[i] ?? 0);
      }
    } else {
      if (bigEndian) {
        value = (
          ((bytes[i]     ?? 0) << 24) |
          ((bytes[i + 1] ?? 0) << 16) |
          ((bytes[i + 2] ?? 0) << 8)  |
           (bytes[i + 3] ?? 0)
        ) >>> 0;
      } else {
        value = (
          ((bytes[i + 3] ?? 0) << 24) |
          ((bytes[i + 2] ?? 0) << 16) |
          ((bytes[i + 1] ?? 0) << 8)  |
           (bytes[i]     ?? 0)
        ) >>> 0;
      }
    }
    entries.push({ address: address++, value });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function parseIntAuto(s: string): number {
  const trimmed = s.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    return parseInt(trimmed.slice(2), 16);
  }
  return parseInt(trimmed, 10);
}
