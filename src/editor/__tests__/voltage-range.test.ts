/**
 * Tests for VoltageRangeTracker.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { VoltageRangeTracker } from "../voltage-range";

describe("VoltageRange", () => {
  let tracker: VoltageRangeTracker;

  beforeEach(() => {
    tracker = new VoltageRangeTracker();
  });

  it("auto_range_tracks_min_max", () => {
    tracker.update(-2.0, 5.0);

    expect(tracker.min).toBeLessThanOrEqual(-2.0);
    expect(tracker.max).toBeGreaterThanOrEqual(5.0);
  });

  it("normalize_ground_at_midpoint", () => {
    tracker.setFixedRange(-5, 5);

    expect(tracker.normalize(0)).toBe(0.5);
    expect(tracker.normalize(5)).toBe(1.0);
    expect(tracker.normalize(-5)).toBe(0.0);
  });

  it("fixed_range_overrides_auto", () => {
    tracker.setFixedRange(0, 3.3);

    // Feed voltages up to 12V — max must remain exactly 3.3 (fixed range).
    tracker.update(0, 12);

    expect(tracker.max).toBe(3.3);
  });

  it("clear_fixed_returns_to_auto", () => {
    tracker.setFixedRange(0, 3.3);
    tracker.clearFixedRange();
    expect(tracker.isAutoRange).toBe(true);

    // Feed new voltages — auto range should track them.
    tracker.update(0, 8);

    expect(tracker.max).toBeGreaterThanOrEqual(8);
  });

  it("latches_never_contracts", () => {
    // Establish a wide range.
    tracker.update(-10, 10);

    // Now feed a narrow range.
    tracker.update(-1, 1);

    // Range must NOT have contracted — latching holds the peak.
    expect(tracker.max).toBeGreaterThanOrEqual(10);
    expect(tracker.min).toBeLessThanOrEqual(-10);
  });

  it("reset_clears_latched_range", () => {
    tracker.update(-10, 10);
    expect(tracker.max).toBeGreaterThanOrEqual(10);

    // Reset and feed a narrow range.
    tracker.reset();
    tracker.update(-1, 1);

    // Range should now reflect the narrow values, not the old latched peak.
    expect(tracker.max).toBeLessThan(10);
  });

  it("normalize_logarithmic_curve", () => {
    tracker.setFixedRange(-10, 10);
    // 1V is 10% of range linearly; with log curve it should map to > 10% of color.
    const norm1V = tracker.normalize(1);
    // Linear would give (1/10 + 1)/2 = 0.55; log curve should push it further from 0.5.
    expect(norm1V).toBeGreaterThan(0.55);
    // But still less than 1.0.
    expect(norm1V).toBeLessThan(1.0);
    // Ground must still be 0.5.
    expect(tracker.normalize(0)).toBe(0.5);
  });

  it("expands_instantly", () => {
    // Start with narrow range.
    tracker.update(-1, 1);

    // Now feed a wide frame.
    tracker.update(-1, 10);

    // max must have expanded to ≥ 10 immediately.
    expect(tracker.max).toBeGreaterThanOrEqual(10);
  });
});
