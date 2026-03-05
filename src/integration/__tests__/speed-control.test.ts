/**
 * Tests for SpeedControl — simulation speed value management.
 */

import { describe, it, expect } from "vitest";
import { SpeedControl, DEFAULT_SPEED, MIN_SPEED, MAX_SPEED } from "../speed-control";

describe("SpeedControl", () => {
  it("defaultSpeed — default speed is 1000", () => {
    const sc = new SpeedControl();
    expect(sc.speed).toBe(DEFAULT_SPEED);
    expect(sc.speed).toBe(1000);
  });

  it("multiply — speed 1000 → x2 → 2000 → x10 → 20000", () => {
    const sc = new SpeedControl();
    expect(sc.speed).toBe(1000);

    sc.multiplyBy2();
    expect(sc.speed).toBe(2000);

    sc.multiplyBy10();
    expect(sc.speed).toBe(20000);
  });

  it("divide — speed 1000 → /2 → 500 → /10 → 50", () => {
    const sc = new SpeedControl();
    expect(sc.speed).toBe(1000);

    sc.divideBy2();
    expect(sc.speed).toBe(500);

    sc.divideBy10();
    expect(sc.speed).toBe(50);
  });

  it("parseText — '500' → 500, '1e6' → 1000000, 'abc' → unchanged", () => {
    const sc = new SpeedControl();

    sc.parseText("500");
    expect(sc.speed).toBe(500);

    sc.parseText("1e6");
    expect(sc.speed).toBe(1000000);

    sc.parseText("abc");
    expect(sc.speed).toBe(1000000); // unchanged
  });

  it("clampMin — speed cannot go below 1", () => {
    const sc = new SpeedControl();
    sc.speed = 1;
    sc.divideBy2();
    expect(sc.speed).toBe(MIN_SPEED);
    expect(sc.speed).toBe(1);

    sc.speed = 0;
    expect(sc.speed).toBe(MIN_SPEED);

    sc.speed = -100;
    expect(sc.speed).toBe(MIN_SPEED);
  });

  it("clampMax — speed cannot exceed 10000000", () => {
    const sc = new SpeedControl();
    sc.speed = MAX_SPEED;
    sc.multiplyBy10();
    expect(sc.speed).toBe(MAX_SPEED);
    expect(sc.speed).toBe(10_000_000);

    sc.speed = 20_000_000;
    expect(sc.speed).toBe(MAX_SPEED);
  });
});
