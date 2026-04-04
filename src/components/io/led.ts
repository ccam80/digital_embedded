/**
 * LED component — single-color indicator.
 *
 * Circle shape, configurable color, lights up when input is non-zero.
 * 1-bit input: on when input = 1, off when input = 0.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildLedPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// LedElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class LedElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("LED", instanceId, position, rotation, mirror, props);
  }

  get color(): string {
    return this._properties.getOrDefault<string>("color", "red");
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildLedPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Circle at cx=0.8 r=0.75: minX = 0.8-0.75, maxX = 0.8+0.75, minY = -0.75, maxY = 0.75.
    // Use cx-r arithmetic to match ellipseSegments cardinal sentinel values exactly.
    const cx = 0.8, r = 0.75;
    return {
      x: this.position.x + (cx - r),
      y: this.position.y - r,
      width: 2 * r,
      height: 2 * r,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();

    // Outer filled circle (body) at (0.8, 0) r=0.75
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(0.8, 0, 0.75, true);

    // Inner color zone circle at (0.8, 0) r=0.65 (OTHER/filled)
    ctx.drawCircle(0.8, 0, 0.65, true);

    // Label to the right
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(label, 2.25, 0, {
      horizontal: "left",
      vertical: "middle",
    });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeLed — reads input, writes to output slot for display state
// ---------------------------------------------------------------------------

export function executeLed(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputVal = state[wt[layout.inputOffset(index)]];
  state[wt[layout.outputOffset(index)]] = inputVal !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// LED model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: LED_PARAM_DEFS, defaults: LED_DEFAULTS } = defineModelParams({
  primary: {
    IS: { default: 3.17e-19, unit: "A", description: "Saturation current" },
    N:  { default: 1.8,      unit: "",  description: "Ideality factor" },
  },
});

/** Thermal voltage at 300 K (kT/q). */
const LED_VT = 0.02585;
/** Minimum conductance for numerical stability. */
const LED_GMIN = 1e-12;

// ---------------------------------------------------------------------------
// createLedAnalogElement — AnalogElement factory
// ---------------------------------------------------------------------------

function createLedAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode = pinNodes.get("in")!;
  // Single-pin LED: cathode is implicitly ground (node 0)
  const nodeCathode = 0;

  const IS = props.getModelParam<number>("IS");
  const N = props.getModelParam<number>("N");
  const nVt = N * LED_VT;
  const vcrit = nVt * Math.log(nVt / (IS * Math.SQRT2));

  // State pool slot indices
  const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;

  // Pool binding — set by initState
  let s0: Float64Array;
  let base: number;

  const element: AnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,
    stateSize: 4,
    stateBaseOffset: -1,

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      base = this.stateBaseOffset;
      s0[base + SLOT_GEQ] = LED_GMIN;
    },

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      stampG(solver, nodeAnode, nodeAnode, geq);
      stampG(solver, nodeAnode, nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode, -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      const vdOld = s0[base + SLOT_VD];
      const vdLimited = pnjlim(vdRaw, vdOld, nVt, vcrit);

      s0[base + SLOT_VD] = vdLimited;

      const expArg = Math.min(vdLimited / nVt, 700);
      const expVal = Math.exp(expArg);
      const id = IS * (expVal - 1);
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = (IS * expVal) / nVt + LED_GMIN;
      s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
    },

    getPinCurrents(_voltages: Readonly<Float64Array>): number[] {
      // pinLayout order: [in (anode)]. Cathode is implicit ground.
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id];
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdNew = va - vc;

      const vdOld = s0[base + SLOT_VD];
      return Math.abs(vdNew - vdOld) <= 2 * nVt;
    },

    setParam(_key: string, _value: number) {},
  };

  return element;
}

// ---------------------------------------------------------------------------
// LED_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const LED_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "color",
    convert: (v) => v,
  },
  {
    xmlName: "Color",
    propertyKey: "model",
    convert: (v) => v.toLowerCase(),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const LED_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Label shown above the LED",
  },
  {
    key: "color",
    type: PropertyType.COLOR,
    label: "Color",
    defaultValue: "red",
    description: "LED color when lit",
  },
];

// ---------------------------------------------------------------------------
// LedDefinition
// ---------------------------------------------------------------------------

function ledFactory(props: PropertyBag): LedElement {
  return new LedElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const LedDefinition: ComponentDefinition = {
  name: "LED",
  typeId: -1,
  factory: ledFactory,
  pinLayout: buildLedPinDeclarations(),
  propertyDefs: LED_PROPERTY_DEFS,
  attributeMap: LED_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.IO,
  helpText:
    "LED — single-color light-emitting diode indicator.\n" +
    "Lights up (filled circle) when the input is non-zero.\n" +
    "Color is configurable. Label is shown above the component.",
  models: {
    digital: { executeFn: executeLed, inputSchema: ["in"], outputSchema: [] },
  },
  modelRegistry: {
    red:    { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 3.17e-19, N: 1.8 } },
    green:  { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 1e-21,    N: 2.0 } },
    blue:   { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 6.26e-24, N: 2.5 } },
    yellow: { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 1e-20,    N: 1.9 } },
    white:  { kind: "inline", factory: createLedAnalogElement, paramDefs: LED_PARAM_DEFS, params: { IS: 6.26e-24, N: 2.5 } },
  },
  defaultModel: "digital",
};
