/**
 * Varactor Diode analog component — voltage-controlled junction capacitance.
 *
 * Implements a diode optimized for its voltage-dependent depletion capacitance.
 * The primary behavior is the C-V characteristic, not the I-V.
 *
 * C-V model (standard depletion capacitance):
 *   C_j(V_R) = CJO / (1 + V_R / VJ)^M
 *
 * where V_R = -V_d is the reverse bias voltage (positive for reverse bias).
 *
 * Also models standard Shockley forward conduction (not the primary use case).
 * The capacitance companion model is updated every timestep as C changes with
 * the applied reverse bias.
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
import type { ReactiveAnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import type { LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { integrateCapacitor } from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT } from "../../core/constants.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: VARACTOR_PARAM_DEFS, defaults: VARACTOR_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    cjo: { default: 20e-12, unit: "F", description: "Zero-bias junction capacitance" },
    vj:  { default: 0.7,    unit: "V", description: "Junction built-in potential" },
    m:   { default: 0.5,               description: "Junction grading coefficient (0.5 = abrupt junction)" },
    iS:  { default: 1e-14,  unit: "A", description: "Reverse saturation current" },
  },
});

// ---------------------------------------------------------------------------
// computeVaractorCapacitance — exported for tests
// ---------------------------------------------------------------------------

/**
 * Compute depletion capacitance for a varactor diode.
 *
 * Formula: C_j(V_R) = CJO / (1 + V_R / VJ)^M
 *
 * Where V_R = reverse bias voltage (positive for reverse-biased diode).
 * When V_R < 0 (forward bias), clamps to ensure denominator stays positive.
 *
 * @param vReverse - Reverse bias voltage V_R = -V_d (positive = reverse biased)
 * @param cjo      - Zero-bias junction capacitance (F)
 * @param vj       - Built-in potential (V), typically 0.7V
 * @param m        - Grading coefficient, typically 0.5 (abrupt junction)
 */
export function computeVaractorCapacitance(
  vReverse: number,
  cjo: number,
  vj: number,
  m: number,
): number {
  if (cjo <= 0) return 0;
  // Clamp to avoid singularity at V_R = -VJ (denominator = 0)
  const arg = Math.max(1 + vReverse / vj, 1e-4);
  return cjo / Math.pow(arg, m);
}

// ---------------------------------------------------------------------------
// State schema declaration
// ---------------------------------------------------------------------------

const VARACTOR_STATE_SCHEMA = defineStateSchema("VaractorElement", [
  { name: "VD",      doc: "Diode junction voltage (V)",                          init: { kind: "zero" } },
  { name: "GEQ",     doc: "Linearized junction conductance (S)",                  init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ",     doc: "Linearized current source (A)",                        init: { kind: "zero" } },
  { name: "ID",      doc: "Diode current (A)",                                    init: { kind: "zero" } },
  { name: "CAP_GEQ", doc: "Capacitance companion conductance (S)",                init: { kind: "zero" } },
  { name: "CAP_IEQ", doc: "Capacitance history current (A)",                      init: { kind: "zero" } },
  { name: "V",       doc: "Junction voltage at current step (for companion)",     init: { kind: "zero" } },
  { name: "Q",       doc: "Charge Cj*V at current step (history from s1/s2/s3)", init: { kind: "zero" } },
  { name: "CCAP",    doc: "Companion current (NIintegrate)",                      init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createVaractorElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createVaractorElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): ReactiveAnalogElementCore {
  const nodeAnode   = pinNodes.get("A")!; // anode (typically more negative in reverse bias)
  const nodeCathode = pinNodes.get("K")!; // cathode (typically more positive in reverse bias)

  const p = {
    cjo: props.getModelParam<number>("cjo"),
    vj:  props.getModelParam<number>("vj"),
    m:   props.getModelParam<number>("m"),
    iS:  props.getModelParam<number>("iS"),
  };
  const nParam = 1; // emission coefficient fixed at 1 for varactor

  const nVt = nParam * VT;
  let vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));

  // State pool slot indices
  const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
  const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_V = 6, SLOT_Q = 7;
  const SLOT_CCAP = 8;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, DIOload sets CKTnoncon++)
  let pnjlimLimited = false;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,
    poolBacked: true as const,
    stateSize: 9,
    stateSchema: VARACTOR_STATE_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(VARACTOR_STATE_SCHEMA, pool, base, {});
    },

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    stamp(_solver: SparseSolver): void {
      // No topology-constant entries.
      // Capacitance companion model entries are stamped in stampReactiveCompanion().
    },

    stampReactiveCompanion(solver: SparseSolver): void {
      const capGeq = s0[base + SLOT_CAP_GEQ];
      const capIeq = s0[base + SLOT_CAP_IEQ];
      if (capGeq !== 0 || capIeq !== 0) {
        stampG(solver, nodeAnode,   nodeAnode,   capGeq);
        stampG(solver, nodeAnode,   nodeCathode, -capGeq);
        stampG(solver, nodeCathode, nodeAnode,   -capGeq);
        stampG(solver, nodeCathode, nodeCathode, capGeq);
        stampRHS(solver, nodeAnode,   -capIeq);
        stampRHS(solver, nodeCathode, capIeq);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Stamp Shockley diode Norton equivalent
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      stampG(solver, nodeAnode,   nodeAnode,   geq);
      stampG(solver, nodeAnode,   nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode,   -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(solver, nodeAnode,   -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): void {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = vA - vC;

      // Apply pnjlim to prevent exponential runaway, using vold from pool
      const vdOld = s0[base + SLOT_VD];
      const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
      const vdLimited = vdResult.value;
      pnjlimLimited = vdResult.limited;

      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore: vdRaw,
          vAfter: vdLimited,
          wasLimited: pnjlimLimited,
        });
      }

      s0[base + SLOT_VD] = vdLimited;

      // Shockley equation linearized at operating point
      const expArg = Math.min(vdLimited / nVt, 700);
      const expVal = Math.exp(expArg);
      const id = p.iS * (expVal - 1);
      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = (p.iS * expVal) / nVt + GMIN;
      s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
    },

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array, order: number, deltaOld: readonly number[]): void {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vNow = vA - vC;

      // Reverse bias voltage: V_R = -V_d (positive when reverse biased)
      const vReverse = -vNow;
      const Cj = computeVaractorCapacitance(vReverse, p.cjo, p.vj, p.m);

      const q0 = Cj * vNow;
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      const { geq, ceq, ccap } = integrateCapacitor(Cj, vNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
      s0[base + SLOT_CAP_GEQ] = geq;
      s0[base + SLOT_CAP_IEQ] = ceq;
      s0[base + SLOT_V] = vNow;
      s0[base + SLOT_Q] = q0;
      s0[base + SLOT_CCAP] = ccap;
    },

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const q0 = s0[base + SLOT_Q];
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const q3 = s3[base + SLOT_Q];
      const ccap0 = s0[base + SLOT_CCAP];
      const ccap1 = s1[base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      // ngspice icheck gate: if voltage was limited in updateOperatingPoint,
      // declare non-convergence immediately (DIOload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = vA - vC;

      // ngspice DIOconvTest: current-prediction convergence
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + abstol;
      return Math.abs(cdhat - id) <= tol;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      const capGeq = s0[base + SLOT_CAP_GEQ];
      const capIeq = s0[base + SLOT_CAP_IEQ];
      const vNow = nodeAnode > 0 && nodeCathode > 0
        ? (_voltages[nodeAnode - 1] - _voltages[nodeCathode - 1])
        : 0;
      const iCap = capGeq * vNow + capIeq;
      const I = id + iCap;
      return [I, -I];
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        (p as Record<string, number>)[key] = value;
        vcrit = nVt * Math.log(nVt / (p.iS * Math.SQRT2));
      }
    },

    updateChargeFlux(voltages: Float64Array, _dt: number, _method: string, _order: number, _deltaOld: readonly number[]): void {
      const vA = nodeAnode   > 0 ? voltages[nodeAnode   - 1] : 0;
      const vC = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vNow = vA - vC;
      const vReverse = -vNow;
      const Cj = computeVaractorCapacitance(vReverse, p.cjo, p.vj, p.m);
      s0[base + SLOT_Q] = Cj * vNow;
      s0[base + SLOT_V] = vNow;
    },
  };
}

// ---------------------------------------------------------------------------
// VaractorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class VaractorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VaractorDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVaractorPinDeclarations(), []);
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

    // Body (triangle, plate bars) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Diode triangle: tip at platef=0.6 along lead1(1.5)→lead2(2.5) = x:2.1
    const hs = 0.5;
    ctx.drawPolygon([
      { x: 1.5, y: -hs },
      { x: 1.5, y: hs },
      { x: 2.1, y: 0 },
    ], true);

    // plate1 bar at x=2.1 (arrowTip)
    ctx.drawLine(2.1, -hs, 2.1, hs);
    // plate2 bar at x=2.5 (lead2)
    ctx.drawLine(2.5, -hs, 2.5, hs);

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

function buildVaractorPinDeclarations(): PinDeclaration[] {
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

const VARACTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const VARACTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VaractorDefinition
// ---------------------------------------------------------------------------

function varactorCircuitFactory(props: PropertyBag): VaractorElement {
  return new VaractorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VaractorDefinition: ComponentDefinition = {
  name: "VaractorDiode",
  typeId: -1,
  factory: varactorCircuitFactory,
  pinLayout: buildVaractorPinDeclarations(),
  propertyDefs: VARACTOR_PROPERTY_DEFS,
  attributeMap: VARACTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Varactor Diode — voltage-controlled junction capacitance.\n" +
    "C_j(V_R) = CJO / (1 + V_R/VJ)^M\n" +
    "Used for voltage-controlled oscillators and tuned circuits.",
  models: {},
  modelRegistry: {
    "simplified": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createVaractorElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: VARACTOR_PARAM_DEFS,
      params: VARACTOR_PARAM_DEFAULTS,
    },
  },
  defaultModel: "simplified",
};
