/**
 * Tests for color interpolation utilities.
 */

import { describe, it, expect } from "vitest";
import { interpolateColor, hexToRgb } from "../color-interpolation";

describe("ColorInterpolation", () => {
  it("midpoint_of_red_and_green", () => {
    // interpolate '#ff0000' and '#00ff00' at t=0.5 → 'rgb(128, 128, 0)'
    const result = interpolateColor("#ff0000", "#00ff00", 0.5);
    expect(result).toBe("rgb(128, 128, 0)");
  });

  it("t_zero_returns_first", () => {
    const color1 = "#ff0000";
    const color2 = "#00ff00";
    const result = interpolateColor(color1, color2, 0);
    // t=0 returns color1 as rgb
    const [r, g, b] = hexToRgb(color1);
    expect(result).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("t_one_returns_second", () => {
    const color1 = "#ff0000";
    const color2 = "#00ff00";
    const result = interpolateColor(color1, color2, 1);
    // t=1 returns color2 as rgb
    const [r, g, b] = hexToRgb(color2);
    expect(result).toBe(`rgb(${r}, ${g}, ${b})`);
  });
});
