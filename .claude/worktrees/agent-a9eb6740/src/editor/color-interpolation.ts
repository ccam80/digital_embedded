/**
 * Color interpolation utilities for analog voltage gradient wire coloring.
 *
 * Provides linear RGB interpolation between two CSS hex colors.
 * Used by the wire renderer (voltage gradient) and power dissipation heat map.
 */

/**
 * Parse a CSS `#rrggbb` hex color string to [r, g, b] components (0–255 each).
 *
 * @param hex - Six-digit hex color string starting with `#`.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

/**
 * Linearly interpolate between two CSS `#rrggbb` hex colors.
 *
 * @param color1 - Start color (`#rrggbb`). Returned when `t === 0`.
 * @param color2 - End color (`#rrggbb`). Returned when `t === 1`.
 * @param t - Interpolation factor in [0, 1].
 * @returns CSS `rgb(r, g, b)` string with `Math.round()`-ed channel values.
 */
export function interpolateColor(color1: string, color2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(color1);
  const [r2, g2, b2] = hexToRgb(color2);

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return `rgb(${r}, ${g}, ${b})`;
}
