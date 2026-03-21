/**
 * Shared voltage-to-color mapping utility.
 *
 * Extracted from WireRenderer so both wire rendering and component body
 * rendering use the same voltage→CSS color pipeline.
 */

import type { ColorScheme } from "@/core/renderer-interface";
import type { VoltageRangeTracker } from "./voltage-range";
import { interpolateColor } from "./color-interpolation";

/**
 * Maps a voltage to a CSS color string using the active voltage range tracker
 * and color scheme.
 *
 * The color gradient is:
 *   normalized < 0.5: WIRE_VOLTAGE_NEG → WIRE_VOLTAGE_GND
 *   normalized > 0.5: WIRE_VOLTAGE_GND → WIRE_VOLTAGE_POS
 *   normalized === 0.5: WIRE_VOLTAGE_GND
 */
export function voltageToColor(
  voltage: number,
  tracker: VoltageRangeTracker,
  scheme: ColorScheme,
): string {
  const normalized = tracker.normalize(voltage);

  const posColor = scheme.resolve("WIRE_VOLTAGE_POS");
  const negColor = scheme.resolve("WIRE_VOLTAGE_NEG");
  const gndColor = scheme.resolve("WIRE_VOLTAGE_GND");

  if (normalized < 0.5) {
    const t = normalized / 0.5;
    return interpolateColor(negColor, gndColor, t);
  } else if (normalized > 0.5) {
    const t = (normalized - 0.5) / 0.5;
    return interpolateColor(gndColor, posColor, t);
  } else {
    return interpolateColor(gndColor, gndColor, 0);
  }
}
