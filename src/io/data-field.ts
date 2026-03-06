/**
 * DataField — a resizable array of bigint words used for ROM/RAM content.
 *
 * Words are addressed by integer index. Addresses beyond the allocated size
 * read as 0n. The field grows automatically on setWord().
 *
 * Serialization format: comma-separated hex values with optional run-length
 * encoding for repeated values (e.g. "4*0,ff" expands to [0,0,0,0,255]).
 */

// ---------------------------------------------------------------------------
// DataField class
// ---------------------------------------------------------------------------

export class DataField {
  private _data: bigint[];
  /** Logical size: highest address written + 1. */
  private _logicalSize: number;

  constructor(size: number = 0) {
    this._data = new Array(size).fill(0n);
    this._logicalSize = size;
  }

  getWord(addr: number): bigint {
    if (addr < 0 || addr >= this._data.length) return 0n;
    return this._data[addr];
  }

  setWord(addr: number, val: bigint): void {
    if (addr < 0) throw new RangeError(`DataField address must be non-negative, got ${addr}`);
    if (addr >= this._data.length) {
      // Grow by doubling, but avoid minimum-32 floor for small writes
      let newLen = this._data.length === 0 ? addr + 1 : Math.max(addr + 1, this._data.length * 2);
      const extended = new Array(newLen).fill(0n);
      for (let i = 0; i < this._data.length; i++) extended[i] = this._data[i];
      this._data = extended;
    }
    this._data[addr] = val;
    if (addr + 1 > this._logicalSize) {
      this._logicalSize = addr + 1;
    }
  }

  /**
   * Returns the logical size: number of words from address 0 up to and
   * including the last address that was written (even if 0n was written there).
   */
  size(): number {
    return this._logicalSize;
  }

  /**
   * Remove trailing zero words and return this instance.
   * Updates both the internal buffer and the logical size.
   */
  trim(): DataField {
    let end = this._logicalSize;
    while (end > 0 && this.getWord(end - 1) === 0n) end--;
    this._data = this._data.slice(0, end);
    this._logicalSize = end;
    return this;
  }

  /** Raw data array (do not mutate). */
  getData(): readonly bigint[] {
    return this._data.slice(0, this._logicalSize);
  }
}

// ---------------------------------------------------------------------------
// parseDataFieldString — comma-separated hex with run-length encoding
// ---------------------------------------------------------------------------

/**
 * Parse a DataField from a comma-separated hex string.
 *
 * Format: optional whitespace, comma-separated tokens where each token is
 * either a hex number or `count*hexValue` run-length encoding.
 */
export function parseDataFieldString(s: string): DataField {
  const df = new DataField();
  const trimmed = s.trim();
  if (trimmed.length === 0) return df;

  const tokens = trimmed.split(/[\s,]+/).filter(t => t.length > 0);
  let addr = 0;

  for (const token of tokens) {
    const starIdx = token.indexOf("*");
    if (starIdx !== -1) {
      const countStr = token.slice(0, starIdx);
      const valueStr = token.slice(starIdx + 1);
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 0) {
        throw new Error(`Invalid run-length count in DataField token: "${token}"`);
      }
      const value = parseBigIntHex(valueStr, token);
      for (let i = 0; i < count; i++) {
        df.setWord(addr++, value);
      }
    } else {
      df.setWord(addr++, parseBigIntHex(token, token));
    }
  }

  return df;
}

function parseBigIntHex(s: string, context: string): bigint {
  const lower = s.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`Invalid hex value in DataField: "${context}"`);
  }
  return BigInt("0x" + hex);
}

// ---------------------------------------------------------------------------
// serializeDataField — produce comma-separated hex with run-length encoding
// ---------------------------------------------------------------------------

const RLE_THRESHOLD = 4;

/**
 * Serialize a DataField to a comma-separated hex string with run-length
 * encoding. Sequences of 4 or more identical values are encoded as
 * `count*hexValue`. Trailing zeros are stripped before serialization.
 */
export function serializeDataField(df: DataField): string {
  const trimmed = new DataField(df.size());
  for (let i = 0; i < df.size(); i++) {
    trimmed.setWord(i, df.getWord(i));
  }
  trimmed.trim();

  const n = trimmed.size();
  if (n === 0) return "";

  const chunks: string[] = [];
  let i = 0;

  while (i < n) {
    const val = trimmed.getWord(i);
    let run = 1;
    while (i + run < n && trimmed.getWord(i + run) === val) run++;

    if (run >= RLE_THRESHOLD) {
      chunks.push(`${run}*${val.toString(16)}`);
      i += run;
    } else {
      for (let j = 0; j < run; j++) {
        chunks.push(val.toString(16));
      }
      i += run;
    }
  }

  return chunks.join(",");
}
