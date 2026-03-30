/**
 * Shared test elements for flatten/subcircuit tests.
 *
 * Eliminates 3 duplicate TestLeafElement + TestSubcircuitElement pairs
 * across flatten.test.ts, flatten-port.test.ts, and flatten-pipeline-reorder.test.ts.
 */

import { AbstractCircuitElement } from "../core/element.js";
import type { Pin } from "../core/pin.js";
import { PinDirection } from "../core/pin.js";
import type { RenderContext, Rect } from "../core/renderer-interface.js";
import { PropertyBag } from "../core/properties.js";
import { Circuit } from "../core/circuit.js";
import type { SubcircuitHost } from "../solver/digital/flatten.js";

// ---------------------------------------------------------------------------
// TestLeafElement — simple leaf circuit element for flatten tests
// ---------------------------------------------------------------------------

/**
 * Minimal leaf circuit element. Used in flatten tests to represent
 * And-gates, In/Out elements, and other leaf components.
 */
export class TestLeafElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    props: PropertyBag,
    pins: Pin[],
  ) {
    super(typeId, instanceId, position, 0, false, props);
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
}

// ---------------------------------------------------------------------------
// TestSubcircuitElement — SubcircuitHost for flatten tests
// ---------------------------------------------------------------------------

/**
 * Subcircuit container element implementing SubcircuitHost.
 * Used in flatten tests to represent subcircuit instances.
 */
export class TestSubcircuitElement
  extends AbstractCircuitElement
  implements SubcircuitHost
{
  readonly internalCircuit: Circuit;
  readonly subcircuitName: string;
  private readonly _pins: readonly Pin[];

  constructor(
    name: string,
    instanceId: string,
    position: { x: number; y: number },
    internalCircuit: Circuit,
    pins: Pin[],
    extraProps?: Record<string, string>,
  ) {
    const props = new PropertyBag();
    if (extraProps) {
      for (const [k, v] of Object.entries(extraProps)) {
        props.set(k, v);
      }
    }
    super(`Subcircuit:${name}`, instanceId, position, 0, false, props);
    this.subcircuitName = name;
    this.internalCircuit = internalCircuit;
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {}

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 6, height: 4 };
  }
}

// ---------------------------------------------------------------------------
// Pin factory helpers for flatten tests
// ---------------------------------------------------------------------------

/**
 * Create a minimal signal Pin for use in leaf elements.
 */
export function makeLeafPin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
  bitWidth = 1,
): Pin {
  return {
    label,
    direction,
    position: { x, y },
    bitWidth,
    isNegated: false,
    isClock: false,
    kind: "signal",
  };
}

/**
 * Create a TestLeafElement with a single output pin at (2, 1).
 */
export function makeLeafElement(
  typeId: string,
  instanceId: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
  label?: string,
): TestLeafElement {
  const props = new PropertyBag();
  if (label !== undefined) {
    props.set("label", label);
  }
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: 2, y: 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
      kind: "signal",
    },
  ];
  return new TestLeafElement(typeId, instanceId, position, props, pins);
}

/**
 * Create a TestLeafElement representing an In element (output pin only).
 */
export function makeInElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.OUTPUT,
      position: { x: 2, y: 1 },
      label: "out",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
      kind: "signal",
    },
  ];
  return new TestLeafElement("In", instanceId, position, props, pins);
}

/**
 * Create a TestLeafElement representing an Out element (input pin only).
 */
export function makeOutElement(
  instanceId: string,
  label: string,
  position: { x: number; y: number } = { x: 10, y: 0 },
): TestLeafElement {
  const props = new PropertyBag();
  props.set("label", label);
  const pins: Pin[] = [
    {
      direction: PinDirection.INPUT,
      position: { x: 0, y: 1 },
      label: "in",
      bitWidth: 1,
      isNegated: false,
      isClock: false,
      kind: "signal",
    },
  ];
  return new TestLeafElement("Out", instanceId, position, props, pins);
}
