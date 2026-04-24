/**
 * Shared constants and helpers used by all behavioral flip-flop variant files.
 */

import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  collectPinModelChildren,
} from "../digital-pin-model.js";
import type { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import type { PropertyBag } from "../../../core/properties.js";
import type { StatePoolRef } from "../element.js";
import { defineStateSchema } from "../state-schema.js";
import type { StateSchema } from "../state-schema.js";

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

// Empty composite schema — children carry their own schemas.
export const FLIPFLOP_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("BehavioralFlipflopComposite", []);

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function getPinSpecs(props: PropertyBag): Record<string, ResolvedPinElectrical> | undefined {
  return props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
}

export function getPinLoading(props: PropertyBag): Record<string, boolean> {
  return props.has("_pinLoading")
    ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
    : {};
}

export function makeInputPin(spec: ResolvedPinElectrical, nodeId: number, loaded = true): DigitalInputPinModel {
  const pin = new DigitalInputPinModel(spec, loaded);
  pin.init(nodeId, 0);
  return pin;
}

export function makeOutputPin(spec: ResolvedPinElectrical, nodeId: number, loaded = false): DigitalOutputPinModel {
  const pin = new DigitalOutputPinModel(spec, loaded, "direct");
  pin.init(nodeId, -1);
  return pin;
}

// ---------------------------------------------------------------------------
// Composite child-element helpers for pool-backed behavioral elements
// ---------------------------------------------------------------------------

/**
 * Build the _childElements array from a flat list of pin models.
 * Used by all pool-backed flip-flop elements to collect capacitor children.
 */
export function buildChildElements(
  pinModels: (DigitalInputPinModel | DigitalOutputPinModel | null)[],
): AnalogCapacitorElement[] {
  const nonNull = pinModels.filter((p): p is DigitalInputPinModel | DigitalOutputPinModel => p !== null);
  return collectPinModelChildren(nonNull);
}

/**
 * Compute total stateSize from an array of capacitor children.
 */
export function computeChildStateSize(children: AnalogCapacitorElement[]): number {
  return children.reduce((s, c) => s + c.stateSize, 0);
}

/**
 * initState for a pool-backed composite element.
 * Assigns consecutive stateBaseOffsets to each child starting from the
 * element's own stateBaseOffset, then calls each child's initState.
 */
export function initChildState(
  children: AnalogCapacitorElement[],
  elementBaseOffset: number,
  pool: StatePoolRef,
): void {
  let offset = elementBaseOffset;
  for (const child of children) {
    child.stateBaseOffset = offset;
    child.initState(pool);
    offset += child.stateSize;
  }
}

/**
 * Load all capacitor children in ctx.
 */
export function loadChildren(
  children: AnalogCapacitorElement[],
  ctx: import("../load-context.js").LoadContext,
): void {
  for (const child of children) {
    child.load(ctx);
  }
}

/**
 * checkConvergence for composite: returns true only if all children converge.
 */
export function checkChildConvergence(
  children: AnalogCapacitorElement[],
  ctx: import("../load-context.js").LoadContext,
): boolean {
  return children.every(c => !c.checkConvergence || c.checkConvergence(ctx));
}
