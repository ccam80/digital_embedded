/**
 * Diode analog component — Shockley equation with NR linearization.
 *
 * Implements the ideal diode equation:
 *   Id = IS * (exp(Vd / (N*Vt)) - 1)
 *
 * Linearized at each NR iteration as a parallel conductance (geq) and
 * Norton current source (ieq). Uses pnjlim() to prevent exponential runaway.
 *
 * When CJO > 0 in model params, junction capacitance is added via
 * stampCompanion(). The depletion capacitance formula (reverse bias):
 *   Cj = CJO / (1 - Vd/VJ)^M
 * and forward-bias linearization (Vd >= FC*VJ):
 *   Cj = CJO / (1 - FC)^(1+M) * (1 - FC*(1+M) + M*Vd/VJ)
 * Plus transit time capacitance: Ct = TT * geq
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DIODE_PARAM_DEFS, defaults: DIODE_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    IS:  { default: 1e-14, unit: "A",  description: "Saturation current" },
    N:   { default: 1,                 description: "Emission coefficient" },
  },
  secondary: {
    RS:  { default: 0,    unit: "Ω",  description: "Ohmic (series) resistance" },
    CJO: { default: 0,    unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,    unit: "V",  description: "Junction built-in potential" },
    M:   { default: 0.5,              description: "Grading coefficient" },
    TT:  { default: 0,    unit: "s",  description: "Transit time" },
    FC:  { default: 0.5,              description: "Forward-bias capacitance coefficient" },
    BV:  { default: Infinity, unit: "V", description: "Reverse breakdown voltage" },
    IBV: { default: 1e-3, unit: "A",  description: "Reverse breakdown current" },
    EG:  { default: 1.11, unit: "eV", description: "Activation energy" },
    XTI: { default: 3,                description: "Saturation current temperature exponent" },
    KF:  { default: 0,                description: "Flicker noise coefficient" },
    AF:  { default: 1,                description: "Flicker noise exponent" },
  },
});

// ---------------------------------------------------------------------------
// computeJunctionCapacitance
// ---------------------------------------------------------------------------

/**
 * Compute junction depletion capacitance using the SPICE depletion formula.
 *
 * For reverse bias (Vd < FC*VJ):
 *   Cj = CJO / (1 - Vd/VJ)^M
 * For forward bias linearization (Vd >= FC*VJ):
 *   Cj = CJO / (1 - FC)^(1+M) * (1 - FC*(1+M) + M*Vd/VJ)
 */
export function computeJunctionCapacitance(
  vd: number,
  CJO: number,
  VJ: number,
  M: number,
  FC: number,
): number {
  if (CJO <= 0) return 0;
  const fcVj = FC * VJ;
  if (vd < fcVj) {
    const arg = 1 - vd / VJ;
    const safeArg = Math.max(arg, 1e-6);
    return CJO / Math.pow(safeArg, M);
  } else {
    const fac = Math.pow(1 - FC, 1 + M);
    return (CJO / fac) * (1 - FC * (1 + M) + (M * vd) / VJ);
  }
}

// ---------------------------------------------------------------------------
// createDiodeElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createDiodeElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  const params: Record<string, number> = {
    IS:  props.getModelParam<number>("IS"),
    N:   props.getModelParam<number>("N"),
    RS:  props.getModelParam<number>("RS"),
    CJO: props.getModelParam<number>("CJO"),
    VJ:  props.getModelParam<number>("VJ"),
    M:   props.getModelParam<number>("M"),
    TT:  props.getModelParam<number>("TT"),
    FC:  props.getModelParam<number>("FC"),
    BV:  props.getModelParam<number>("BV"),
    IBV: props.getModelParam<number>("IBV"),
    EG:  props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    KF:  props.getModelParam<number>("KF"),
    AF:  props.getModelParam<number>("AF"),
  };

  // When RS > 0, use an internal node between the anode pin and the junction.
  // nodeJunction is the node the Shockley junction connects from (internal side of RS).
  const nodeJunction = params.RS > 0 && internalNodeIds.length > 0
    ? internalNodeIds[0]
    : nodeAnode;

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // State pool slot indices
  const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
  const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_VD_PREV = 6;

  // Pool binding — set by initState
  let s0: Float64Array;
  let base: number;

  // Junction capacitance companion model state (non-pool: init sentinel only)
  let capFirstCall = true;

  const element: AnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    stateSize: hasCapacitance ? 7 : 4,
    stateBaseOffset: -1,

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      base = this.stateBaseOffset;
      s0[base + SLOT_GEQ] = GMIN;
    },

    stamp(solver: SparseSolver): void {
      // Stamp series resistance RS between anode pin and internal junction node
      if (params.RS > 0 && nodeJunction !== nodeAnode) {
        const gRS = 1 / params.RS;
        stampG(solver, nodeAnode, nodeAnode, gRS);
        stampG(solver, nodeAnode, nodeJunction, -gRS);
        stampG(solver, nodeJunction, nodeAnode, -gRS);
        stampG(solver, nodeJunction, nodeJunction, gRS);
      }
      // Stamp junction capacitance companion model when active
      if (hasCapacitance) {
        const capGeq = s0[base + SLOT_CAP_GEQ];
        const capIeq = s0[base + SLOT_CAP_IEQ];
        if (capGeq !== 0 || capIeq !== 0) {
          stampG(solver, nodeJunction, nodeJunction, capGeq);
          stampG(solver, nodeJunction, nodeCathode, -capGeq);
          stampG(solver, nodeCathode, nodeJunction, -capGeq);
          stampG(solver, nodeCathode, nodeCathode, capGeq);
          stampRHS(solver, nodeJunction, -capIeq);
          stampRHS(solver, nodeCathode, capIeq);
        }
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      // Stamp companion model: conductance geq in parallel, Norton offset ieq
      // Junction is between nodeJunction and nodeCathode
      stampG(solver, nodeJunction, nodeJunction, geq);
      stampG(solver, nodeJunction, nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeJunction, -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      // RHS: Norton current source
      stampRHS(solver, nodeJunction, -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): void {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Recompute derived values from mutable params
      const nVt = params.N * VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));

      // Apply pnjlim to prevent exponential runaway, using vold from pool
      const vdOld = s0[base + SLOT_VD];
      const vdLimited = pnjlim(vdRaw, vdOld, nVt, vcrit);

      // Save limited voltage to pool — no write-back to voltages[]
      s0[base + SLOT_VD] = vdLimited;

      // Shockley equation and NR linearization at limited operating point
      if (params.BV < Infinity && vdLimited < -params.BV) {
        // Reverse breakdown region: Id = -IBV * exp(-(Vd + BV) / (N*Vt))
        const bdExpArg = Math.min(-(vdLimited + params.BV) / nVt, 700);
        const bdExpVal = Math.exp(bdExpArg);
        const id = -params.IBV * bdExpVal;
        s0[base + SLOT_ID] = id;
        s0[base + SLOT_GEQ] = (params.IBV * bdExpVal) / nVt + GMIN;
        s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
      } else {
        const expArg = Math.min(vdLimited / nVt, 700);
        const expVal = Math.exp(expArg);
        const id = params.IS * (expVal - 1);
        s0[base + SLOT_ID] = id;
        s0[base + SLOT_GEQ] = (params.IS * expVal) / nVt + GMIN;
        s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
      }
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array): boolean {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Compare raw junction voltage against the last limited voltage stored in
      // the pool. Converged when the NR solution matches what pnjlim accepted.
      const nVt = params.N * VT;
      return Math.abs(vdRaw - s0[base + SLOT_VD]) <= 2 * nVt;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id, -id];
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
    },
  };

  // Attach stampCompanion only when junction capacitance is present
  if (hasCapacitance) {
    element.stampCompanion = function (
      dt: number,
      method: IntegrationMethod,
      voltages: Float64Array,
    ): void {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vNow = va - vc;

      // Recompute derived values from mutable params
      const nVt = params.N * VT;

      // Depletion + transit-time capacitance at current operating point
      const Cj = computeJunctionCapacitance(vNow, params.CJO, params.VJ, params.M, params.FC);
      const expArg = Math.min(vNow / nVt, 700);
      const expVal = Math.exp(expArg);
      const gDiode = (params.IS * expVal) / nVt;
      const Ct = params.TT * gDiode;
      const Ctotal = Cj + Ct;

      // Recover capacitor current at previous accepted step
      const prevCapGeq = s0[base + SLOT_CAP_GEQ];
      const prevCapIeq = s0[base + SLOT_CAP_IEQ];
      const iNow = prevCapGeq * vNow + prevCapIeq;
      const vPrevForFormula = capFirstCall ? vNow : s0[base + SLOT_VD_PREV];
      s0[base + SLOT_VD_PREV] = vNow;
      capFirstCall = false;

      s0[base + SLOT_CAP_GEQ] = capacitorConductance(Ctotal, dt, method);
      s0[base + SLOT_CAP_IEQ] = capacitorHistoryCurrent(Ctotal, dt, method, vNow, vPrevForFormula, iNow);
      // CAP_GEQ/CAP_IEQ are stamped in stamp() on every NR iteration
    };
  }

  return element;
}

// ---------------------------------------------------------------------------
// getDiodeInternalNodeCount — returns 1 when RS > 0, else 0
// ---------------------------------------------------------------------------

export function getDiodeInternalNodeCount(props: PropertyBag): number {
  return props.getModelParam<number>("RS") > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// DiodeElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DiodeElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Diode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildDiodePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, 1.5, 0);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, 2.5, 0, 4, 0);

    // Triangle body pointing right (anode left, cathode right) — body stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);

    // Cathode bar (vertical line at x=2.5)
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildDiodePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DIODE_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const DIODE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// DiodeDefinition
// ---------------------------------------------------------------------------

function diodeCircuitFactory(props: PropertyBag): DiodeElement {
  return new DiodeElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const DiodeDefinition: ComponentDefinition = {
  name: "Diode",
  typeId: -1,
  factory: diodeCircuitFactory,
  pinLayout: buildDiodePinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diode — Shockley equation with NR linearization.\n" +
    "Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
    "Model parameters: IS, N, CJO, VJ, M, TT, FC.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
      getInternalNodeCount: getDiodeInternalNodeCount,
    },
  },
  defaultModel: "spice",
};
