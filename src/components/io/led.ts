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
import type { AnalogElementCore, PoolBackedAnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import {
  computeJunctionCapacitance,
  computeJunctionCharge,
} from "../semiconductors/diode.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT as LED_VT } from "../../core/constants.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

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
  secondary: {
    CJO: { default: 0,   unit: "F", description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,   unit: "V", description: "Junction built-in potential" },
    M:   { default: 0.5,            description: "Grading coefficient" },
    TT:  { default: 0,   unit: "s", description: "Transit time" },
    FC:  { default: 0.5,            description: "Forward-bias capacitance coefficient" },
  },
});

// LED_VT (thermal voltage) imported from ../../core/constants.js
/** Minimum conductance for numerical stability. */
const LED_GMIN = 1e-12;

// ---------------------------------------------------------------------------
// State schema declarations
// ---------------------------------------------------------------------------

// Slot index constants — shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_V = 6, SLOT_Q = 7;
const SLOT_CCAP = 8;

/** Schema for resistive LED (no junction capacitance): 4 slots. */
const LED_STATE_SCHEMA = defineStateSchema("LedAnalogElement", [
  { name: "VD",      doc: "LED junction voltage (V)",                           init: { kind: "zero" } },
  { name: "GEQ",     doc: "Linearized junction conductance (S)",                init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",     doc: "Linearized current source (A)",                      init: { kind: "zero" } },
  { name: "ID",      doc: "LED current (A)",                                    init: { kind: "zero" } },
]);

/** Schema for capacitive LED (CJO > 0 or TT > 0): 9 slots. */
const LED_CAP_STATE_SCHEMA = defineStateSchema("LedAnalogElement_cap", [
  { name: "VD",      doc: "LED junction voltage (V)",                           init: { kind: "zero" } },
  { name: "GEQ",     doc: "Linearized junction conductance (S)",                init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",     doc: "Linearized current source (A)",                      init: { kind: "zero" } },
  { name: "ID",      doc: "LED current (A)",                                    init: { kind: "zero" } },
  { name: "CAP_GEQ", doc: "Junction-capacitance companion conductance",         init: { kind: "zero" } },
  { name: "CAP_IEQ", doc: "Junction-capacitance companion history current",     init: { kind: "zero" } },
  { name: "V",       doc: "Junction voltage at current step (for companion)",   init: { kind: "zero" } },
  { name: "Q",       doc: "Junction charge at current step",                    init: { kind: "zero" } },
  { name: "CCAP",    doc: "Companion current (NIintegrate)",                    init: { kind: "zero" } },
]);

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

  const params: Record<string, number> = {
    IS:  props.getModelParam<number>("IS"),
    N:   props.getModelParam<number>("N"),
    CJO: props.getModelParam<number>("CJO"),
    VJ:  props.getModelParam<number>("VJ"),
    M:   props.getModelParam<number>("M"),
    TT:  props.getModelParam<number>("TT"),
    FC:  props.getModelParam<number>("FC"),
  };

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, DIOload sets CKTnoncon++)
  let pnjlimLimited = false;

  const element: PoolBackedAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSize: hasCapacitance ? 9 : 4,
    stateSchema: hasCapacitance ? LED_CAP_STATE_SCHEMA : LED_STATE_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0;
      this.s1 = s1;
      this.s2 = s2;
      this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(this.stateSchema, pool, base, params);
    },

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const nVt = params.N * LED_VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));

      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      const vdOld = s0[base + SLOT_VD];
      const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
      const vdLimited = vdResult.value;
      pnjlimLimited = vdResult.limited;
      if (pnjlimLimited) ctx.noncon.value++;

      s0[base + SLOT_VD] = vdLimited;

      const expArg = Math.min(vdLimited / nVt, 700);
      const expVal = Math.exp(expArg);
      const idRaw = params.IS * (expVal - 1);
      const gdRaw = (params.IS * expVal) / nVt;
      const gd = gdRaw + LED_GMIN;
      const id = idRaw + LED_GMIN * vdLimited;
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = gd;
      const ieq = id - gd * vdLimited;
      s0[base + SLOT_IEQ] = ieq;

      const solver = ctx.solver;
      stampG(solver, nodeAnode, nodeAnode, gd);
      stampG(solver, nodeAnode, nodeCathode, -gd);
      stampG(solver, nodeCathode, nodeAnode, -gd);
      stampG(solver, nodeCathode, nodeCathode, gd);
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);

      if (hasCapacitance && ctx.isTransient) {
        const order = ctx.order;
        const method = ctx.method;

        // Depletion + transit-time capacitance at current operating point
        const Cj = computeJunctionCapacitance(vdLimited, params.CJO, params.VJ, params.M, params.FC);
        const Ct = params.TT * gdRaw;
        const Ctotal = Cj + Ct;

        const q0 = computeJunctionCharge(vdLimited, params.CJO, params.VJ, params.M, params.FC, params.TT, idRaw);
        const q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        // Inline NIintegrate (niinteg.c:28-63). Mapping: ag[]=ctx.ag, q0/q1/q2=charges.
        // geq = ag[0] * Ctotal
        // ccap = ag[0]*q0 + ag[1]*q1 + ag[2]*q2 (order terms)
        // ceq  = ccap - geq * vdLimited
        const ag = ctx.ag;
        let ccap = ag[0] * q0 + ag[1] * q1;
        if (order >= 2 && method !== "trapezoidal") ccap += ag[2] * q2;
        const capGeq = ag[0] * Ctotal;
        const capIeq = ccap - capGeq * vdLimited;
        s0[base + SLOT_CAP_GEQ] = capGeq;
        s0[base + SLOT_CAP_IEQ] = capIeq;
        s0[base + SLOT_V] = vdLimited;
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (capGeq !== 0 || capIeq !== 0) {
          stampG(solver, nodeAnode, nodeAnode, capGeq);
          stampG(solver, nodeAnode, nodeCathode, -capGeq);
          stampG(solver, nodeCathode, nodeAnode, -capGeq);
          stampG(solver, nodeCathode, nodeCathode, capGeq);
          stampRHS(solver, nodeAnode, -capIeq);
          stampRHS(solver, nodeCathode, capIeq);
        }
      }
    },

    getPinCurrents(_voltages: Readonly<Float64Array>): number[] {
      // pinLayout order: [in (anode)]. Cathode is implicit ground.
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id];
    },

    checkConvergence(ctx: LoadContext): boolean {
      // ngspice icheck gate: if voltage was limited in load(),
      // declare non-convergence immediately (DIOload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const voltages = ctx.voltages;
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // ngspice DIOconvTest: current-prediction convergence
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
    },
  };

  // Attach getLteTimestep only when junction capacitance is present
  if (hasCapacitance) {
    (element as unknown as { getLteTimestep: (dt: number, deltaOld: readonly number[], order: number, method: IntegrationMethod, lteParams: LteParams) => number }).getLteTimestep = function (
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const _q0 = s0[base + SLOT_Q];
      const _q1 = s1[base + SLOT_Q];
      const _q2 = s2[base + SLOT_Q];
      const _q3 = s3[base + SLOT_Q];
      const ccap0 = s0[base + SLOT_CCAP];
      const ccap1 = s1[base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
    };
  }

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
