/**
 * Shared constants and helpers used by all behavioral flip-flop variant files.
 */

import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../digital-pin-model.js";
import type { PropertyBag } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// Default electrical spec (CMOS 3.3 V)
// ---------------------------------------------------------------------------

export const FALLBACK_SPEC: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function getPinSpecs(props: PropertyBag): Record<string, ResolvedPinElectrical> | undefined {
  return props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
}

export function makeInputPin(spec: ResolvedPinElectrical, nodeId: number): DigitalInputPinModel {
  const pin = new DigitalInputPinModel(spec);
  pin.init(nodeId, 0);
  return pin;
}

export function makeOutputPin(spec: ResolvedPinElectrical, nodeId: number): DigitalOutputPinModel {
  const pin = new DigitalOutputPinModel(spec);
  pin.init(nodeId, -1);
  return pin;
}
