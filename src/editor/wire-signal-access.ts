/**
 * WireSignalAccess — bridge between the wire renderer and the engine binding layer.
 *
 * The renderer uses this interface to read signal values from whatever engine
 * is currently connected. When no engine is active the renderer receives
 * undefined and falls back to the default wire colour.
 */

import type { Wire } from "@/core/circuit";

/** Digital wire value: raw unsigned integer + bit-width. */
export interface DigitalWireValue {
  raw: number;
  width: number;
}

/** Analog wire value: continuous voltage. */
export interface AnalogWireValue {
  voltage: number;
}

/** Discriminated union of wire value types. Use `'voltage' in value` to distinguish. */
export type WireValue = DigitalWireValue | AnalogWireValue;

export interface WireSignalAccess {
  /**
   * Returns the current signal value for a wire, or undefined when no engine
   * is connected or the wire has no net assignment yet.
   *
   * Digital: `{ raw, width }` — raw unsigned integer + bit-width.
   * Analog:  `{ voltage }` — continuous node voltage.
   */
  getWireValue(wire: Wire): WireValue | undefined;
}
