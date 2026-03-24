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

  it("latches_never_contracts", () => {
    // Node IDs start at 1; index 0 is ground (unused by tracker).
    // Establish a wide range: node1=-10, node2=10
    const wideEngine = makeEngine([0, -10, 10]);
    tracker.update(wideEngine, 2);

    // Now feed a narrow range: node1=-1, node2=1
    const narrowEngine = makeEngine([0, -1, 1]);
    tracker.update(narrowEngine, 2);

    // Range must NOT have contracted — latching holds the peak
    expect(tracker.max).toBeGreaterThanOrEqual(10);
    expect(tracker.min).toBeLessThanOrEqual(-10);
  });

  it("reset_clears_latched_range", () => {
    // Establish a wide range
    const wideEngine = makeEngine([0, -10, 10]);
    tracker.update(wideEngine, 2);
    expect(tracker.max).toBeGreaterThanOrEqual(10);

    // Reset and feed a narrow range
    tracker.reset();
    const narrowEngine = makeEngine([0, -1, 1]);
    tracker.update(narrowEngine, 2);

    // Range should now reflect the narrow values, not the old latched peak
    expect(tracker.max).toBeLessThan(10);
  });

  it("normalize_logarithmic_curve", () => {
    // With a fixed range, small voltages should map to > linear fraction
    tracker.setFixedRange(-10, 10);
    // 1V is 10% of range linearly; with log curve it should map to > 10% of color
    const norm1V = tracker.normalize(1);
    // Linear would give (1/10 + 1)/2 = 0.55; log curve should push it further from 0.5
    expect(norm1V).toBeGreaterThan(0.55);
    // But still less than 1.0
    expect(norm1V).toBeLessThan(1.0);
    // Ground must still be 0.5
    expect(tracker.normalize(0)).toBe(0.5);
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
