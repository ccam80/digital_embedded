/**
 * Tests for VoltageRangeTracker.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { VoltageRangeTracker } from "../voltage-range";
import type { AnalogEngine } from "@/core/analog-engine-interface";

/** Build a minimal mock AnalogEngine for a given voltage map. */
function makeEngine(voltages: number[]): AnalogEngine {
  return {
    getNodeVoltage: (id: number) => voltages[id] ?? 0,
  } as unknown as AnalogEngine;
}

describe("VoltageRange", () => {
  let tracker: VoltageRangeTracker;

  beforeEach(() => {
    tracker = new VoltageRangeTracker();
  });

  it("auto_range_tracks_min_max", () => {
    // Feed voltages [0, 3.3, 5.0, -2.0]
    const engine = makeEngine([0, 3.3, 5.0, -2.0]);
    tracker.update(engine, 4);

    expect(tracker.min).toBeLessThanOrEqual(-2.0);
    expect(tracker.max).toBeGreaterThanOrEqual(5.0);
  });

  it("normalize_ground_at_midpoint", () => {
    // Symmetric range [-5, 5]
    tracker.setFixedRange(-5, 5);

    expect(tracker.normalize(0)).toBe(0.5);
    expect(tracker.normalize(5)).toBe(1.0);
    expect(tracker.normalize(-5)).toBe(0.0);
  });

  it("fixed_range_overrides_auto", () => {
    // Set fixed range [0, 3.3]
    tracker.setFixedRange(0, 3.3);

    // Feed voltages up to 12V
    const engine = makeEngine([0, 5, 10, 12]);
    tracker.update(engine, 4);

    // max must remain exactly 3.3 (fixed range)
    expect(tracker.max).toBe(3.3);
  });

  it("clear_fixed_returns_to_auto", () => {
    tracker.setFixedRange(0, 3.3);
    tracker.clearFixedRange();
    expect(tracker.isAutoRange).toBe(true);

    // Feed new voltages — auto range should track them
    const engine = makeEngine([0, 7, 8]);
    tracker.update(engine, 3);

    expect(tracker.max).toBeGreaterThanOrEqual(8);
  });

  it("smoothing_contracts_slowly", () => {
    // Establish a wide range first: [-10, 10]
    const wideEngine = makeEngine([-10, 10]);
    tracker.update(wideEngine, 2);

    const prevMax = tracker.max;
    const prevMin = tracker.min;

    // Now feed a narrow range: [-1, 1]
    const narrowEngine = makeEngine([-1, 1]);
    tracker.update(narrowEngine, 2);

    // Range must NOT have snapped to [-1, 1] — smoothing prevents instant contraction
    expect(tracker.max).toBeGreaterThan(1);
    expect(tracker.min).toBeLessThan(-1);

    // Sanity: the range did move toward [-1, 1] (it is not still the same as prevMax/prevMin)
    // After one frame: smoothedMax = 0.95 * 10 + 0.05 * 1 = 9.55
    expect(tracker.max).toBeLessThan(prevMax);
    expect(tracker.min).toBeGreaterThan(prevMin);
  });

  it("expands_instantly", () => {
    // Start with narrow range [-1, 1]
    const narrowEngine = makeEngine([-1, 1]);
    tracker.update(narrowEngine, 2);

    // Now feed a wide frame: [-1, 10]
    const wideEngine = makeEngine([-1, 10]);
    tracker.update(wideEngine, 2);

    // max must have expanded to ≥ 10 immediately
    expect(tracker.max).toBeGreaterThanOrEqual(10);
  });
});
