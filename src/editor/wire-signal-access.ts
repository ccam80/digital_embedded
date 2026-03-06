/**
 * WireSignalAccess — bridge between the wire renderer and the engine binding layer.
 *
 * The renderer uses this interface to read signal values from whatever engine
 * is currently connected. When no engine is active the renderer receives
 * undefined and falls back to the default wire colour.
 */

import type { Wire } from "@/core/circuit";

export interface WireSignalAccess {
  /**
   * Returns the current signal value for a wire, or undefined when no engine
   * is connected or the wire has no net assignment yet.
   *
   * `raw`   — the raw unsigned integer value on the net.
   * `width` — the bit-width (1 = single-bit, >1 = bus).
   */
  getWireValue(wire: Wire): { raw: number; width: number } | undefined;
}
