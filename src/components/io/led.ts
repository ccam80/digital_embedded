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
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;
const LED_RADIUS = 0.7;

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
// LED color model parameters
// Color-specific IS/N values produce correct forward voltages at 20mA:
//   Red:   Vf ≈ 1.8V at 20mA → IS=1e-20, N=1.8
//   Green: Vf ≈ 2.1V at 20mA → IS=1e-22, N=2.0
//   Blue:  Vf ≈ 3.2V at 20mA → IS=1e-26, N=2.5
// ---------------------------------------------------------------------------

const LED_COLOR_MODELS: Record<string, { IS: number; N: number }> = {
  red:    { IS: 3.17e-19, N: 1.8 },
  green:  { IS: 1e-21,   N: 2.0 },
  blue:   { IS: 6.26e-24, N: 2.5 },
  yellow: { IS: 1e-20,   N: 1.9 },
  white:  { IS: 6.26e-24, N: 2.5 },
};

const LED_DEFAULT_MODEL = { IS: 3.17e-19, N: 1.8 };

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

  const color = props.getOrDefault<string>("color", "red").toLowerCase();
  const colorModel = LED_COLOR_MODELS[color] ?? LED_DEFAULT_MODEL;
  const IS = colorModel.IS;
  const N = colorModel.N;
  const nVt = N * LED_VT;
  const vcrit = nVt * Math.log(nVt / (IS * Math.SQRT2));

  let vd = 0;
  let geq = LED_GMIN;
  let ieq = 0;
  let _id = 0;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      _ledStampG(solver, nodeAnode, nodeAnode, geq);
      _ledStampG(solver, nodeAnode, nodeCathode, -geq);
      _ledStampG(solver, nodeCathode, nodeAnode, -geq);
      _ledStampG(solver, nodeCathode, nodeCathode, geq);
      _ledStampRHS(solver, nodeAnode, -ieq);
      _ledStampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      const vdLimited = pnjlim(vdRaw, vd, nVt, vcrit);

      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vc + vdLimited;
      }

      vd = vdLimited;

      const expArg = Math.min(vd / nVt, 700);
      const expVal = Math.exp(expArg);
      const id = IS * (expVal - 1);
      _id = id;
      geq = (IS * expVal) / nVt + LED_GMIN;
      ieq = id - geq * vd;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [in (anode)]. Cathode is implicit ground.
      // Positive = current flowing INTO element at that pin.
      return [_id];
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdNew = va - vc;

      const vaPrev = nodeAnode > 0 ? prevVoltages[nodeAnode - 1] : 0;
      const vcPrev = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      const vdPrevVal = vaPrev - vcPrev;

      return Math.abs(vdNew - vdPrevVal) <= 2 * nVt;
    },
  };
}

function _ledStampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function _ledStampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
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
    mnaModels: {
      behavioral: { factory: createLedAnalogElement },
    },
  },
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: createLedAnalogElement,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
