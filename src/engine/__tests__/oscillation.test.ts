/**
 * Tests for OscillationDetector — task 3.3.2.
 */

import { describe, it, expect } from "vitest";
import { OscillationDetector, DEFAULT_OSCILLATION_LIMIT } from "../oscillation.js";

describe("Oscillation", () => {
  it("detectsAfterLimit", () => {
    // Feed the detector DEFAULT_OSCILLATION_LIMIT + 1 ticks.
    // isOverLimit() should return true after exceeding the limit.
    const detector = new OscillationDetector(DEFAULT_OSCILLATION_LIMIT);

    // Not over limit before ticking enough
    expect(detector.isOverLimit()).toBe(false);

    for (let i = 0; i <= DEFAULT_OSCILLATION_LIMIT; i++) {
      detector.tick();
    }

    // After 1001 ticks with limit=1000, isOverLimit is true
    expect(detector.isOverLimit()).toBe(true);
  });

  it("collectsOscillators", () => {
    // After the limit is exceeded, collect for 100 steps with components
    // [3, 5] appearing in every step. getOscillatingComponents should
    // return [3, 5].
    const detector = new OscillationDetector(10);

    // Exceed the limit
    for (let i = 0; i <= 10; i++) {
      detector.tick();
    }
    expect(detector.isOverLimit()).toBe(true);

    // Simulate 100 collection steps where components 3 and 5 always appear
    for (let step = 0; step < 100; step++) {
      detector.collectOscillatingComponents([3, 5]);
    }

    const oscillators = detector.getOscillatingComponents();
    expect(oscillators).toEqual([3, 5]);
  });

  it("resetClearsState", () => {
    // Exceed the limit, then reset. isOverLimit() must return false after reset.
    const detector = new OscillationDetector(5);

    for (let i = 0; i <= 5; i++) {
      detector.tick();
    }
    expect(detector.isOverLimit()).toBe(true);

    // Collect some oscillators to ensure they are also cleared
    detector.collectOscillatingComponents([0, 1, 2]);

    detector.reset();

    expect(detector.isOverLimit()).toBe(false);
    expect(detector.getOscillatingComponents()).toEqual([]);
  });
});
