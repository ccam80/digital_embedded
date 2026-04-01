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
    CJO: { default: 0,    unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,    unit: "V",  description: "Junction built-in potential" },
    M:   { default: 0.5,              description: "Grading coefficient" },
    TT:  { default: 0,    unit: "s",  description: "Transit time" },
    FC:  { default: 0.5,              description: "Forward-bias capacitance coefficient" },
    BV:  { default: Infinity, unit: "V", description: "Reverse breakdown voltage" },
    IBV: { default: 1e-3, unit: "A",  description: "Reverse breakdown current" },
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
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  const params: Record<string, number> = {
    IS:  props.getModelParam<number>("IS"),
    N:   props.getModelParam<number>("N"),
    CJO: props.getModelParam<number>("CJO"),
    VJ:  props.getModelParam<number>("VJ"),
    M:   props.getModelParam<number>("M"),
    TT:  props.getModelParam<number>("TT"),
    FC:  props.getModelParam<number>("FC"),
    BV:  props.getModelParam<number>("BV"),
    IBV: props.getModelParam<number>("IBV"),
  };

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // NR linearization state
  let vd = 0;
  let geq = GMIN;
  let ieq = 0;
  let _id = 0; // cached junction current for getPinCurrents

  // Junction capacitance companion model state
  let capGeq = 0;
  let capIeq = 0;
  let vdPrev = NaN;
  let capFirstCall = true;

  const element: AnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,

    stamp(solver: SparseSolver): void {
      // Stamp junction capacitance companion model when active
      if (capGeq !== 0 || capIeq !== 0) {
        stampG(solver, nodeAnode, nodeAnode, capGeq);
        stampG(solver, nodeAnode, nodeCathode, -capGeq);
        stampG(solver, nodeCathode, nodeAnode, -capGeq);
        stampG(solver, nodeCathode, nodeCathode, capGeq);
        stampRHS(solver, nodeAnode, -capIeq);
        stampRHS(solver, nodeCathode, capIeq);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Stamp companion model: conductance geq in parallel, Norton offset ieq
      stampG(solver, nodeAnode, nodeAnode, geq);
      stampG(solver, nodeAnode, nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode, -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      // RHS: Norton current source
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Recompute derived values from mutable params
      const nVt = params.N * VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));

      // Apply pnjlim to prevent exponential runaway
      const vdLimited = pnjlim(vdRaw, vd, nVt, vcrit);

      // Write limited junction voltage back into voltages[]
      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vc + vdLimited;
      }

      vd = vdLimited;

      // Shockley equation and NR linearization at limited operating point
      const expArg = Math.min(vd / nVt, 700);
      const expVal = Math.exp(expArg);
      const id = params.IS * (expVal - 1);
      _id = id;
      geq = (params.IS * expVal) / nVt + GMIN;
      ieq = id - geq * vd;
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdNew = va - vc;

      const vaPrev = nodeAnode > 0 ? prevVoltages[nodeAnode - 1] : 0;
      const vcPrev = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      const vdPrevVal = vaPrev - vcPrev;

      const nVt = params.N * VT;
      return Math.abs(vdNew - vdPrevVal) <= 2 * nVt;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      return [_id, -_id];
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
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
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
      const iNow = capGeq * vNow + capIeq;
      const vPrevForFormula = capFirstCall ? vNow : vdPrev;
      vdPrev = vNow;
      capFirstCall = false;

      capGeq = capacitorConductance(Ctotal, dt, method);
      capIeq = capacitorHistoryCurrent(Ctotal, dt, method, vNow, vPrevForFormula, iNow);
      // capGeq/capIeq are stamped in stamp() on every NR iteration
    };
  }

  return element;
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
    "behavioral": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
