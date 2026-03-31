/**
 * Ground component — unified digital + analog.
 *
 * Digital mode: OUTPUT pin "out" always writes 0 to the simulation state.
 * Analog mode: topological marker — the analog compiler maps any node
 * connected to this component to node 0 (the MNA ground reference). The
 * AnalogElement stamp is a no-op; the constraint is enforced by node
 * assignment, not by stamping into the matrix.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildGroundPinDeclarations(bitWidth: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// GroundElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class GroundElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Ground", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildGroundPinDeclarations(bitWidth), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.6,
      y: this.position.y,
      width: 1.2,
      height: 1.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vPin = signals?.getPinVoltage("out");
    ctx.save();
    ctx.setLineWidth(1);
    // Vertical stem from pin (y=0) down to first bar
    drawColoredLead(ctx, signals, vPin, 0, 0, 0, 0.5);
    // Three decreasing-width horizontal bars
    ctx.setColor("COMPONENT");
    ctx.drawLine(-0.6, 0.5, 0.6, 0.5);
    ctx.drawLine(-0.4, 0.75, 0.4, 0.75);
    ctx.drawLine(-0.2, 1.0, 0.2, 1.0);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeGround — always writes 0 to output
// ---------------------------------------------------------------------------

export function executeGround(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  state[wt[layout.outputOffset(index)]] = 0;
}

// ---------------------------------------------------------------------------
// createGroundAnalogElement — AnalogElement factory (no-op stamp)
// ---------------------------------------------------------------------------

function createGroundAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  _props: PropertyBag,
): AnalogElementCore {
  pinNodes.get("out");
  return {
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_solver: SparseSolver): void {
      // Ground constraint is handled by the compiler's node mapping.
    },

    setParam(_key: string, _value: number) {},

    getPinCurrents(_voltages: Float64Array): number[] {
      // Ground constraint is enforced by node mapping (pin node = MNA node 0).
      // No current flows through the element stamp� return zero for the one pin.
      return [0];
    },
  };
}

// ---------------------------------------------------------------------------
// GROUND_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const GROUND_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const GROUND_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the output signal",
  },
];

// ---------------------------------------------------------------------------
// GroundDefinition
// ---------------------------------------------------------------------------

function groundFactory(props: PropertyBag): GroundElement {
  return new GroundElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const GroundDefinition: ComponentDefinition = {
  name: "Ground",
  typeId: -1,
  factory: groundFactory,
  pinLayout: buildGroundPinDeclarations(1),
  propertyDefs: GROUND_PROPERTY_DEFS,
  attributeMap: GROUND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "Ground — outputs logic 0 in digital mode. In analog mode, marks the connected node as the MNA ground reference (node 0).",
  models: {
    digital: { executeFn: executeGround, inputSchema: [], outputSchema: ["out"] },
  },
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: createGroundAnalogElement,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
