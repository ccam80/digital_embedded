/**
 * DataField- a resizable array of bigint words used for ROM/RAM content.
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
// parseDataFieldString- comma-separated hex with run-length encoding
// ---------------------------------------------------------------------------

