import { describe, it, expect, beforeEach } from "vitest";
import { AnalogScopeBuffer } from "../analog-scope-buffer.js";

describe("ScopeBuffer", () => {
  let buf: AnalogScopeBuffer;

  beforeEach(() => {
    buf = new AnalogScopeBuffer(256);
  });

  it("push_and_query_range", () => {
    // Push 100 samples at non-uniform times
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += 0.001 + (i % 7) * 0.0001; // non-uniform spacing
      buf.push(t, Math.sin(i * 0.1));
    }

    const queryStart = 0.03;
    const queryEnd = 0.06;
    const result = buf.getSamplesInRange(queryStart, queryEnd);

    expect(result.time.length).toBeGreaterThan(0);
    expect(result.time.length).toBe(result.value.length);

    // All returned samples must be within [tStart, tEnd]
    for (let i = 0; i < result.time.length; i++) {
      expect(result.time[i]).toBeGreaterThanOrEqual(queryStart);
      expect(result.time[i]).toBeLessThanOrEqual(queryEnd);
    }

    // Samples must be in ascending time order
    for (let i = 1; i < result.time.length; i++) {
      expect(result.time[i]).toBeGreaterThanOrEqual(result.time[i - 1]);
    }
  });

  it("ring_buffer_eviction", () => {
    const capacity = 256;
    const buf2 = new AnalogScopeBuffer(capacity);

    // Push more than capacity
    for (let i = 0; i < capacity + 50; i++) {
      buf2.push(i * 0.001, i);
    }

    expect(buf2.sampleCount).toBe(capacity);

    // Oldest sample should be gone — time of first sample should be after t=0
    expect(buf2.timeStart).toBeGreaterThan(0);
    // timeStart should be around the 50th sample (index 50 * 0.001)
  });

  it("envelope_computes_min_max", () => {
    // Push sine wave samples over 1 second
    const N = 200;
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const v = Math.sin(2 * Math.PI * t);
      buf.push(t, v);
    }

    const bucketCount = 10;
    const env = buf.getEnvelope(0, 1.0, bucketCount);

    expect(env.time.length).toBe(bucketCount);
    expect(env.min.length).toBe(bucketCount);
    expect(env.max.length).toBe(bucketCount);

    // For each bucket, compare against actual samples in range
    for (let b = 0; b < bucketCount; b++) {
      const bStart = b * 0.1;
      const bEnd = bStart + 0.1;
      const range = buf.getSamplesInRange(bStart, bEnd);

      if (range.value.length === 0) continue;

      let actualMin = range.value[0];
      let actualMax = range.value[0];
      for (let k = 1; k < range.value.length; k++) {
        if (range.value[k] < actualMin) actualMin = range.value[k];
        if (range.value[k] > actualMax) actualMax = range.value[k];
      }

      expect(env.min[b]).toBeLessThanOrEqual(actualMin + 1e-9);
      expect(env.max[b]).toBeGreaterThanOrEqual(actualMax - 1e-9);
    }
  });

  it("binary_search_correct", () => {
    // Push 1000 samples at 1ms intervals (t = 0.000, 0.001, ..., 0.999)
    const buf2 = new AnalogScopeBuffer(2048);
    for (let i = 0; i < 1000; i++) {
      buf2.push(i * 0.001, i * 0.001);
    }

    // Query the sub-range [0.005, 0.006] — should return samples at t=0.005 and t=0.006
    const result = buf2.getSamplesInRange(0.005, 0.006);

    expect(result.time.length).toBeGreaterThan(0);
    for (let i = 0; i < result.time.length; i++) {
      expect(result.time[i]).toBeGreaterThanOrEqual(0.005);
      expect(result.time[i]).toBeLessThanOrEqual(0.006);
    }

    // Verify no sample just outside is included
    if (result.time.length > 0) {
      expect(result.time[0]).toBeGreaterThanOrEqual(0.005);
      expect(result.time[result.time.length - 1]).toBeLessThanOrEqual(0.006);
    }
  });

  it("empty_range_returns_empty", () => {
    // Buffer is empty
    const r1 = buf.getSamplesInRange(0, 1);
    expect(r1.time.length).toBe(0);
    expect(r1.value.length).toBe(0);

    // Buffer has samples but query range has none
    buf.push(5.0, 1.0);
    buf.push(6.0, 2.0);

    const r2 = buf.getSamplesInRange(0, 1);
    expect(r2.time.length).toBe(0);
    expect(r2.value.length).toBe(0);

    // Query after all samples
    const r3 = buf.getSamplesInRange(10, 20);
    expect(r3.time.length).toBe(0);
    expect(r3.value.length).toBe(0);
  });

  it("sampleCount_and_timeStart_timeEnd", () => {
    expect(buf.sampleCount).toBe(0);
    expect(buf.timeStart).toBe(0);
    expect(buf.timeEnd).toBe(0);

    buf.push(1.0, 10.0);
    expect(buf.sampleCount).toBe(1);

    buf.push(2.0, 20.0);
    buf.push(3.0, 30.0);
    expect(buf.sampleCount).toBe(3);
  });

  it("clear_resets_buffer", () => {
    for (let i = 0; i < 50; i++) {
      buf.push(i * 0.01, i);
    }
    expect(buf.sampleCount).toBe(50);

    buf.clear();
    expect(buf.sampleCount).toBe(0);
    expect(buf.timeStart).toBe(0);
    expect(buf.timeEnd).toBe(0);

    const result = buf.getSamplesInRange(0, 100);
    expect(result.time.length).toBe(0);
  });

  it("double_buffer_zero_copy_across_wrap", () => {
    // Fill buffer to capacity, then push a few more to wrap around.
    // The subarray view should still return contiguous data correctly.
    const capacity = 16;
    const buf2 = new AnalogScopeBuffer(capacity);

    // Fill exactly
    for (let i = 0; i < capacity; i++) {
      buf2.push(i * 1.0, i * 10.0);
    }
    // Push 4 more to wrap head to index 4
    for (let i = capacity; i < capacity + 4; i++) {
      buf2.push(i * 1.0, i * 10.0);
    }

    // Query the full range — should return all capacity samples
    const result = buf2.getSamplesInRange(4.0, (capacity + 3) * 1.0);
    expect(result.time.length).toBe(capacity);

    // Values must be in order
    for (let i = 1; i < result.time.length; i++) {
      expect(result.time[i]).toBeGreaterThan(result.time[i - 1]);
    }
  });
});
