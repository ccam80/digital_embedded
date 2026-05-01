/**
 * AnalogScopeBuffer- ring buffer for analog oscilloscope sample capture.
 *
 * Stores Float64 (time, value) pairs at non-uniform time intervals produced
 * by the adaptive timestep controller. Supports time-range queries, min/max
 * envelope decimation, and zero-allocation reads via subarray views.
 *
 * Layout: double-buffer ring. Each push writes to both index `i` and
 * `i + capacity`, so any contiguous window of up to `capacity` samples is
 * always available as a single subarray slice regardless of wrap position.
 */

export class AnalogScopeBuffer {
  private readonly _capacity: number;
  private readonly _times: Float64Array;
  private readonly _values: Float64Array;
  private _head: number = 0;
  private _count: number = 0;

  /**
   * @param maxSamples Ring buffer capacity (default 65536).
   */
  constructor(maxSamples: number = 65536) {
    this._capacity = maxSamples;
    // Double-buffer: length = 2 × capacity. Each sample written at i and i+capacity.
    this._times = new Float64Array(maxSamples * 2);
    this._values = new Float64Array(maxSamples * 2);
  }

  /**
   * Append a sample. Time must be monotonically increasing.
   * When buffer is full, the oldest sample is evicted.
   */
  push(time: number, value: number): void {
    const i = this._head;
    this._times[i] = time;
    this._times[i + this._capacity] = time;
    this._values[i] = value;
    this._values[i + this._capacity] = value;

    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) {
      this._count++;
    }
  }

  /** Number of samples currently stored. */
  get sampleCount(): number {
    return this._count;
  }

  /** Time of the oldest stored sample, or 0 if empty. */
  get timeStart(): number {
    if (this._count === 0) return 0;
    const tailIndex = this._tailIndex();
    return this._times[tailIndex];
  }

  /** Time of the newest stored sample, or 0 if empty. */
  get timeEnd(): number {
    if (this._count === 0) return 0;
    const headIndex = (this._head - 1 + this._capacity) % this._capacity;
    return this._times[headIndex];
  }

  /** Clear all stored samples. */
  clear(): void {
    this._head = 0;
    this._count = 0;
  }

  /**
   * Returns all samples within [tStart, tEnd] as zero-copy subarray views.
   * Uses binary search for O(log n) range lookup.
   */
  getSamplesInRange(tStart: number, tEnd: number): { time: Float64Array; value: Float64Array } {
    if (this._count === 0 || tStart > tEnd) {
      return { time: new Float64Array(0), value: new Float64Array(0) };
    }

    const tail = this._tailIndex();

    // Find first index where time >= tStart
    const lo = this._binarySearchFirst(tStart, tail);
    // Find last index where time <= tEnd
    const hi = this._binarySearchLast(tEnd, tail);

    if (lo > hi) {
      return { time: new Float64Array(0), value: new Float64Array(0) };
    }

    // lo and hi are logical indices (0 = tail). Convert to physical.
    const physLo = (tail + lo) % this._capacity;
    const count = hi - lo + 1;

    return {
      time: this._times.subarray(physLo, physLo + count),
      value: this._values.subarray(physLo, physLo + count),
    };
  }

  /**
   * Divides [tStart, tEnd] into `bucketCount` equal-width buckets and returns
   * min and max value per bucket for zoomed-out envelope rendering.
   */
  getEnvelope(
    tStart: number,
    tEnd: number,
    bucketCount: number,
  ): { time: Float64Array; min: Float64Array; max: Float64Array } {
    const times = new Float64Array(bucketCount);
    const mins = new Float64Array(bucketCount);
    const maxs = new Float64Array(bucketCount);

    if (this._count === 0 || tStart > tEnd || bucketCount <= 0) {
      return { time: times, min: mins, max: maxs };
    }

    const span = tEnd - tStart;
    const bucketWidth = span / bucketCount;

    // Snap bucket boundaries to multiples of bucketWidth so they don't
    // shift as the view scrolls- eliminates discontinuous min/max jumps.
    const alignedStart = Math.floor(tStart / bucketWidth) * bucketWidth;

    // Track the last known value to fill empty buckets instead of
    // defaulting to 0 (which causes spikes).
    let lastMin = NaN;
    let lastMax = NaN;

    for (let b = 0; b < bucketCount; b++) {
      const bStart = alignedStart + b * bucketWidth;
      const bEnd = bStart + bucketWidth;
      times[b] = bStart + bucketWidth * 0.5;

      const range = this.getSamplesInRange(bStart, bEnd);
      if (range.value.length === 0) {
        // Carry forward last known value; filled in a second pass if
        // the first buckets are empty.
        mins[b] = lastMin;
        maxs[b] = lastMax;
        continue;
      }

      let mn = range.value[0];
      let mx = range.value[0];
      for (let k = 1; k < range.value.length; k++) {
        const v = range.value[k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[b] = mn;
      maxs[b] = mx;
      lastMin = mn;
      lastMax = mx;
    }

    // Back-fill any leading empty buckets (before the first sample).
    if (isNaN(mins[0])) {
      // Find the first populated bucket.
      let first = 0;
      while (first < bucketCount && isNaN(mins[first])) first++;
      const fillMin = first < bucketCount ? mins[first] : 0;
      const fillMax = first < bucketCount ? maxs[first] : 0;
      for (let b = 0; b < first; b++) {
        mins[b] = fillMin;
        maxs[b] = fillMax;
      }
    }

    return { time: times, min: mins, max: maxs };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Physical index of the oldest (tail) sample. */
  private _tailIndex(): number {
    if (this._count < this._capacity) {
      return 0;
    }
    return this._head;
  }

  /**
   * Binary search: returns the logical index (offset from tail) of the first
   * sample with time >= target, or _count if all samples are before target.
   */
  private _binarySearchFirst(target: number, tail: number): number {
    let lo = 0;
    let hi = this._count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const physMid = (tail + mid) % this._capacity;
      if (this._times[physMid] < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Binary search: returns the logical index (offset from tail) of the last
   * sample with time <= target, or -1 if all samples are after target.
   */
  private _binarySearchLast(target: number, tail: number): number {
    let lo = 0;
    let hi = this._count - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const physMid = (tail + mid) % this._capacity;
      if (this._times[physMid] <= target) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }
}
