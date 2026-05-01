/**
 * Intel HEX format parser.
 *
 * Parses the Intel HEX file format (also called IHEX) into a flat map of
 * address → byte value entries. Supports record types:
 *   00- Data record
 *   01- End-of-file record
 *   02- Extended segment address record
 *   04- Extended linear address record
 *
 * Reference: https://en.wikipedia.org/wiki/Intel_HEX
 */

// ---------------------------------------------------------------------------
// ParsedByte- one decoded byte from an Intel HEX file
// ---------------------------------------------------------------------------

export interface ParsedByte {
  /** Absolute byte address (extended address + offset). */
  address: number;
  /** Byte value (0–255). */
  value: number;
}

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

const RECORD_DATA = 0x00;
const RECORD_EOF  = 0x01;
const RECORD_EXTENDED_SEGMENT = 0x02;
const RECORD_EXTENDED_LINEAR  = 0x04;

// ---------------------------------------------------------------------------
// parseIntelHex
// ---------------------------------------------------------------------------

/**
 * Parse an Intel HEX string into a flat list of address/value byte pairs.
 *
 * @param hex - Intel HEX text (lines separated by \n or \r\n)
 * @returns Array of ParsedByte entries in the order they appear in the file
 * @throws Error if the file is malformed or a checksum fails
 */
export function parseIntelHex(hex: string): ParsedByte[] {
  const result: ParsedByte[] = [];
  let upperAddress = 0; // extended address (from record types 02 and 04)

  const lines = hex.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line[0] !== ":") {
      throw new Error(`Intel HEX: expected ':' at start of line, got '${line[0]}'`);
    }

    const bytes = hexStringToBytes(line.slice(1));
    if (bytes.length < 5) {
      throw new Error(`Intel HEX: record too short: '${line}'`);
    }

    const byteCount  = bytes[0];
    const addrHigh   = bytes[1];
    const addrLow    = bytes[2];
    const recordType = bytes[3];
    const data       = bytes.slice(4, 4 + byteCount);
    const checksum   = bytes[4 + byteCount];

    verifyChecksum(bytes.slice(0, 4 + byteCount), checksum);

    const baseAddress = (addrHigh << 8) | addrLow;

    switch (recordType) {
      case RECORD_DATA: {
        for (let i = 0; i < data.length; i++) {
          result.push({
            address: upperAddress + baseAddress + i,
            value: data[i],
          });
        }
        break;
      }
      case RECORD_EOF:
        return result;

      case RECORD_EXTENDED_SEGMENT:
        if (data.length < 2) throw new Error("Intel HEX: extended segment record too short");
        upperAddress = ((data[0] << 8) | data[1]) * 16;
        break;

      case RECORD_EXTENDED_LINEAR:
        if (data.length < 2) throw new Error("Intel HEX: extended linear record too short");
        upperAddress = ((data[0] << 8) | data[1]) << 16;
        break;

      default:
        // Unknown record types are silently ignored per the spec
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function hexStringToBytes(hex: string): number[] {
  if (hex.length % 2 !== 0) {
    throw new Error(`Intel HEX: odd-length hex string: '${hex}'`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) {
      throw new Error(`Intel HEX: invalid hex characters: '${hex.slice(i, i + 2)}'`);
    }
    bytes.push(byte);
  }
  return bytes;
}

function verifyChecksum(dataBytes: number[], expectedChecksum: number): void {
  let sum = 0;
  for (const b of dataBytes) {
    sum = (sum + b) & 0xFF;
  }
  const computed = ((~sum + 1) & 0xFF);
  if (computed !== expectedChecksum) {
    throw new Error(
      `Intel HEX: checksum mismatch- expected 0x${expectedChecksum.toString(16).padStart(2, "0")}, ` +
      `computed 0x${computed.toString(16).padStart(2, "0")}`,
    );
  }
}
