/**
 * WaveformChannel — append-only ring buffer for waveform sample storage.
 *
 * Each channel records { time, value } samples. When the buffer is full the
 * oldest sample is overwritten (ring eviction). The buffer capacity is set at
 * construction time.
 *
 */

import type { SignalAddress } from "@/compile/types.js";

// ---------------------------------------------------------------------------
// Sample — one recorded data point
// ---------------------------------------------------------------------------

export interface WaveformSample {
  /** Simulation step count (logical time). */
  readonly time: number;
  /** Signal value at this time. 0 or 1 for single-bit; arbitrary for multi-bit. */
  readonly value: number;
}

// ---------------------------------------------------------------------------
// WaveformChannel — ring buffer holding samples for one signal
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer for waveform samples.
 *
 * Capacity is set at construction. When a new sample is appended beyond
 * capacity the oldest sample is silently evicted.
 */
export class WaveformChannel {
  private readonly _capacity: number;
  private readonly _buf: Array<WaveformSample>;
  /** Index of the slot that will be written next. */
  private _head = 0;
  /** Total number of samples ever appended (monotonically increasing). */
  private _totalAppended = 0;

  /** Signal name shown in the timing diagram label. */
  readonly name: string;
  /** Signal address used to read from the coordinator. */
  readonly addr: SignalAddress;
  /** Bit width of the signal (1 = digital, >1 = bus). */
  readonly width: number;

  constructor(name: string, addr: SignalAddress, width: number, capacity: number) {
    if (capacity < 1) throw new RangeError("WaveformChannel capacity must be >= 1");
    this._capacity = capacity;
    this._buf = new Array<WaveformSample>(capacity);
    this.name = name;
    this.addr = addr;
    this.width = width;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /** Append a sample. Evicts the oldest sample if the buffer is full. */
  append(time: number, value: number): void {
    this._buf[this._head] = { time, value };
    this._head = (this._head + 1) % this._capacity;
    this._totalAppended++;
  }

  /** Remove all stored samples. */
  clear(): void {
    this._head = 0;
    this._totalAppended = 0;
    this._buf.fill(undefined as unknown as WaveformSample);
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Number of samples currently stored (0..capacity). */
  get count(): number {
    return Math.min(this._totalAppended, this._capacity);
  }

  /** Maximum number of samples the buffer can hold. */
  get capacity(): number {
    return this._capacity;
  }

  /**
   * Return all stored samples in chronological order (oldest first).
   * Allocates a new array — use sparingly (for rendering, not the hot path).
   */
  getSamples(): WaveformSample[] {
    const n = this.count;
    if (n === 0) return [];

    const result: WaveformSample[] = new Array(n);

    if (this._totalAppended <= this._capacity) {
      // Buffer not yet wrapped — data starts at index 0
      for (let i = 0; i < n; i++) {
        result[i] = this._buf[i]!;
      }
    } else {
      // Buffer has wrapped — oldest sample is at _head
      for (let i = 0; i < n; i++) {
        result[i] = this._buf[(this._head + i) % this._capacity]!;
      }
    }

    return result;
  }

  /**
   * Return the sample at display index i (0 = oldest).
   * Throws if i is out of range.
   */
  getSample(i: number): WaveformSample {
    const n = this.count;
    if (i < 0 || i >= n) throw new RangeError(`Sample index ${i} out of range (count=${n})`);

    if (this._totalAppended <= this._capacity) {
      return this._buf[i]!;
    }
    return this._buf[(this._head + i) % this._capacity]!;
  }

  /**
   * Find the sample index whose time is closest to the given target time.
   * Returns -1 if the channel is empty.
   */
  findClosestIndex(targetTime: number): number {
    const n = this.count;
    if (n === 0) return -1;

    let bestIdx = 0;
    let bestDist = Math.abs(this.getSample(0).time - targetTime);

    for (let i = 1; i < n; i++) {
      const dist = Math.abs(this.getSample(i).time - targetTime);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    return bestIdx;
  }
}
