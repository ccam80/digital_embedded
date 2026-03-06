/**
 * Hex file import — auto-detects and parses Logisim raw hex, Intel HEX,
 * and raw binary formats into a DataField.
 */

import { DataField } from "./data-field";

// ---------------------------------------------------------------------------
// Auto-detecting entry point
// ---------------------------------------------------------------------------

/**
 * Import a hex/binary file into a DataField.
 *
 * Format detection:
 *   - Starts with "v2.0 raw" → Logisim raw hex format
 *   - First non-whitespace line starts with ":" → Intel HEX format
 *   - Otherwise → raw binary
 *
 * @param data      Raw file bytes
 * @param dataBits  Number of bits per word (used for binary and Intel HEX)
 * @param bigEndian Whether to use big-endian byte ordering (binary/Intel HEX)
 */
export function importHex(data: Uint8Array, dataBits: number, bigEndian: boolean = false): DataField {
  const text = new TextDecoder("utf-8").decode(data);
  const firstLine = text.split("\n")[0].trim();

  if (firstLine === "v2.0 raw") {
    return parseLogisimHex(text);
  }

  if (firstLine.startsWith(":")) {
    return parseIntelHex(text, dataBits, bigEndian);
  }

  return parseBinaryFile(data, dataBits, bigEndian);
}

// ---------------------------------------------------------------------------
// Logisim raw hex format
// ---------------------------------------------------------------------------

/**
 * Parse a Logisim raw hex file.
 *
 * Format:
 *   v2.0 raw
 *   <hex values separated by whitespace, with optional run-length N*value>
 *   # lines starting with # are comments
 */
export function parseLogisimHex(text: string): DataField {
  const lines = text.split("\n");
  const header = lines[0].trim();
  if (header !== "v2.0 raw") {
    throw new Error(`Invalid Logisim hex header: "${header}"`);
  }

  const df = new DataField();
  let addr = 0;

  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const commentIdx = line.indexOf("#");
    const content = commentIdx !== -1 ? line.slice(0, commentIdx) : line;
    const tokens = content.trim().split(/\s+/).filter(t => t.length > 0);

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      i++;

      if (i < tokens.length && tokens[i] === "*") {
        // count * value — next token after * is the value
        const count = parseInt(token, 10);
        if (isNaN(count)) {
          throw new Error(`Invalid run-length count in Logisim hex: "${token}"`);
        }
        i++; // consume "*"
        if (i >= tokens.length) {
          throw new Error("Unexpected end of Logisim hex after '*'");
        }
        const value = parseHexBigInt(tokens[i]);
        i++;
        for (let r = 0; r < count; r++) {
          df.setWord(addr++, value);
        }
      } else if (token.includes("*")) {
        // Compact form: count*value (no spaces around *)
        const starIdx = token.indexOf("*");
        const countStr = token.slice(0, starIdx);
        const valueStr = token.slice(starIdx + 1);
        const count = parseInt(countStr, 10);
        if (isNaN(count)) {
          throw new Error(`Invalid run-length in Logisim hex: "${token}"`);
        }
        const value = parseHexBigInt(valueStr);
        for (let r = 0; r < count; r++) {
          df.setWord(addr++, value);
        }
      } else {
        df.setWord(addr++, parseHexBigInt(token));
      }
    }
  }

  return df;
}

// ---------------------------------------------------------------------------
// Intel HEX format
// ---------------------------------------------------------------------------

/**
 * Parse an Intel HEX file.
 *
 * Record types handled:
 *   00 — Data
 *   01 — End of File
 *   02 — Extended Segment Address (shift by 4 bits)
 *   04 — Extended Linear Address (shift by 16 bits)
 *
 * Bytes are packed into dataBits-wide words using ByteArrayFromValueArray
 * semantics.
 */
export function parseIntelHex(text: string, dataBits: number, bigEndian: boolean): DataField {
  const bytesPerWord = Math.max(1, Math.ceil(dataBits / 8));
  const rawBytes = new Map<number, number>();
  let maxAddr = 0;
  let segment = 0;

  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line[0] !== ":") {
      throw new Error(`Invalid Intel HEX line: "${line}"`);
    }

    const bytes = parseIntelHexLine(line);
    const byteCount = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];

    switch (recordType) {
      case 0x00: {
        // Data record
        for (let i = 0; i < byteCount; i++) {
          const byteAddr = segment + addr + i;
          rawBytes.set(byteAddr, bytes[4 + i]);
          if (byteAddr > maxAddr) maxAddr = byteAddr;
        }
        break;
      }
      case 0x01:
        // End of file
        break;
      case 0x02: {
        // Extended segment address (left-shift by 4)
        if (byteCount !== 2) throw new Error("Invalid extended segment address record");
        segment = ((bytes[4] << 8) | bytes[5]) << 4;
        break;
      }
      case 0x04: {
        // Extended linear address (left-shift by 16)
        if (byteCount !== 2) throw new Error("Invalid extended linear address record");
        segment = ((bytes[4] << 8) | bytes[5]) << 16;
        break;
      }
      default:
        throw new Error(`Unsupported Intel HEX record type: ${recordType}`);
    }
  }

  // Pack bytes into words
  const df = new DataField();
  const totalWords = Math.ceil((maxAddr + 1) / bytesPerWord);

  for (let wordIdx = 0; wordIdx < totalWords; wordIdx++) {
    let word = 0n;
    for (let b = 0; b < bytesPerWord; b++) {
      const byteAddr = wordIdx * bytesPerWord + b;
      const byteVal = BigInt(rawBytes.get(byteAddr) ?? 0);
      const bitOffset = bigEndian ? (bytesPerWord - 1 - b) : b;
      word |= byteVal << BigInt(bitOffset * 8);
    }
    if (word !== 0n) {
      df.setWord(wordIdx, word);
    }
  }

  return df;
}

function parseIntelHexLine(line: string): number[] {
  const bytes: number[] = [];
  // Skip the leading ":"
  for (let p = 1; p + 1 < line.length; p += 2) {
    bytes.push(parseInt(line.slice(p, p + 2), 16));
  }

  if (bytes.length < 5) {
    throw new Error(`Intel HEX line too short: "${line}"`);
  }

  // Verify checksum: sum of all bytes must be 0 (mod 256)
  let sum = 0;
  for (const b of bytes) sum += b;
  if ((sum & 0xff) !== 0) {
    throw new Error(`Intel HEX checksum error in line: "${line}"`);
  }

  return bytes;
}

// ---------------------------------------------------------------------------
// Raw binary format
// ---------------------------------------------------------------------------

/**
 * Parse a raw binary file into a DataField.
 *
 * Bytes are packed into dataBits-wide words. With little-endian (default),
 * the first byte goes into the least significant byte of word 0. With
 * big-endian, it goes into the most significant byte.
 */
export function parseBinaryFile(data: Uint8Array, dataBits: number, bigEndian: boolean): DataField {
  const bytesPerWord = Math.max(1, Math.ceil(dataBits / 8));
  const df = new DataField();
  const totalWords = Math.ceil(data.length / bytesPerWord);

  for (let wordIdx = 0; wordIdx < totalWords; wordIdx++) {
    let word = 0n;
    for (let b = 0; b < bytesPerWord; b++) {
      const byteAddr = wordIdx * bytesPerWord + b;
      if (byteAddr >= data.length) break;
      const byteVal = BigInt(data[byteAddr]);
      const bitOffset = bigEndian ? (bytesPerWord - 1 - b) : b;
      word |= byteVal << BigInt(bitOffset * 8);
    }
    df.setWord(wordIdx, word);
  }

  return df;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHexBigInt(s: string): bigint {
  const lower = s.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Invalid hex value: "${s}"`);
  }
  return BigInt("0x" + hex);
}
