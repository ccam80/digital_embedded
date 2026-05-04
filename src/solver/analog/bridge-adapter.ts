/**
 * Bridge adapter factories for digital/analog engine boundaries.
 *
 * The factories `makeBridgeOutputAdapter` and `makeBridgeInputAdapter` are the
 * sole engine integration points. Call sites in compiler.ts, coordinator.ts,
 * and compiled-analog-circuit.ts call these by their existing names without
 * any per-call-site changes.
 *
 * The bridge driver element classes live in:
 *   src/solver/analog/behavioral-drivers/bridge-output-driver.ts  (J-136)
 *   src/solver/analog/behavioral-drivers/bridge-input-driver.ts   (J-135)
 */

import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { BridgeOutputDriverElement } from "./behavioral-drivers/bridge-output-driver.js";
import { BridgeInputDriverElement } from "./behavioral-drivers/bridge-input-driver.js";

// ---------------------------------------------------------------------------
// Type aliases — keep existing typed-import sites in compiler.ts,
// coordinator.ts, and compiled-analog-circuit.ts compiling without
// per-call-site changes.
// ---------------------------------------------------------------------------

export type BridgeOutputAdapter = BridgeOutputDriverElement;
export type BridgeInputAdapter = BridgeInputDriverElement;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a BridgeOutputDriverElement from a ResolvedPinElectrical spec, a
 * pre-assigned MNA node ID, a branch variable index, and a loaded flag.
 */
export function makeBridgeOutputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
  branchIdx: number,
  loaded: boolean,
): BridgeOutputDriverElement {
  return new BridgeOutputDriverElement(spec, nodeId, branchIdx, loaded);
}

/**
 * Build a BridgeInputDriverElement from a ResolvedPinElectrical spec, a
 * pre-assigned MNA node ID, and a loaded flag.
 */
export function makeBridgeInputAdapter(
  spec: ResolvedPinElectrical,
  nodeId: number,
  loaded: boolean,
): BridgeInputDriverElement {
  return new BridgeInputDriverElement(spec, nodeId, loaded);
}
