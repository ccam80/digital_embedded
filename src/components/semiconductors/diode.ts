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
import type { LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { integrateCapacitor } from "../../solver/analog/integration.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { VT } from "../../core/constants.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// State schemas
// ---------------------------------------------------------------------------

// Slot index constants — shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
const SLOT_CAP_GEQ = 4, SLOT_CAP_IEQ = 5, SLOT_V = 6, SLOT_Q = 7;
const SLOT_CCAP = 8;

/** Schema for resistive diode (no junction capacitance): 4 slots. */
export const DIODE_SCHEMA: StateSchema = defineStateSchema("DiodeElement", [
  { name: "VD",      doc: "pnjlim-limited junction voltage",                  init: { kind: "zero" } },
  { name: "GEQ",     doc: "NR companion conductance",                         init: { kind: "constant", value: GMIN } },
  { name: "IEQ",     doc: "NR companion Norton current",                      init: { kind: "zero" } },
  { name: "ID",      doc: "Diode current at operating point",                 init: { kind: "zero" } },
]);

/** Schema for capacitive diode (CJO > 0 or TT > 0): 9 slots. */
export const DIODE_CAP_SCHEMA: StateSchema = defineStateSchema("DiodeElement_cap", [
  { name: "VD",      doc: "pnjlim-limited junction voltage",                  init: { kind: "zero" } },
  { name: "GEQ",     doc: "NR companion conductance",                         init: { kind: "constant", value: GMIN } },
  { name: "IEQ",     doc: "NR companion Norton current",                      init: { kind: "zero" } },
  { name: "ID",      doc: "Diode current at operating point",                 init: { kind: "zero" } },
  { name: "CAP_GEQ", doc: "Junction-capacitance companion conductance",       init: { kind: "zero" } },
  { name: "CAP_IEQ", doc: "Junction-capacitance companion history current",   init: { kind: "zero" } },
  { name: "V",       doc: "Junction voltage at current step (for companion)", init: { kind: "zero" } },
  { name: "Q",       doc: "Junction charge at current step",                  init: { kind: "zero" } },
  { name: "CCAP",    doc: "Companion current (NIintegrate)",                  init: { kind: "zero" } },
]);

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
    NBV: { default: NaN, unit: "",     description: "Breakdown emission coefficient (default=N)" },
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
// computeJunctionCharge
// ---------------------------------------------------------------------------

/**
 * Compute total junction charge — integral of C(V) dV — matching ngspice
 * dioload.c:308-341.
 *
 * Depletion charge (reverse bias, vd < FC*VJ):
 *   dioload.c:312: deplcharge = tJctPot * czero * (1 - arg*sarg) / (1-M)
 *   where arg = 1 - vd/VJ, sarg = arg^(-M), so arg*sarg = (1-vd/VJ)^(1-M)
 *   => Q_depl = VJ * CJO * (1 - (1 - vd/VJ)^(1-M)) / (1-M)
 *   Special case M=1: Q_depl = -VJ * CJO * ln(1 - vd/VJ)
 *
 * Depletion charge (forward bias, vd >= FC*VJ):
 *   dioload.c:316: deplcharge = F1*czero + czof2*(F3*(vd-depCap) + M/(2*VJ)*(vd^2-depCap^2))
 *   where F1 = VJ*(1-(1-FC)^(1-M))/(1-M), czof2 = CJO/(1-FC)^(1+M),
 *         F3 = 1-FC*(1+M), depCap = FC*VJ
 *
 * Diffusion charge (dioload.c:333):
 *   diffcharge = TT * Id
 *   where Id = IS*(exp(vd/(N*Vt))-1) is the diode current
 */
export function computeJunctionCharge(
  vd: number,
  CJO: number,
  VJ: number,
  M: number,
  FC: number,
  TT: number,
  Id: number,
): number {
  let Q_depl = 0;
  if (CJO > 0) {
    const depCap = FC * VJ;
    if (vd < depCap) {
      // Reverse-bias depletion charge
      const arg = Math.max(1 - vd / VJ, 1e-6);
      if (Math.abs(M - 1) < 1e-10) {
        // M=1 special case: integral of CJO/(1-vd/VJ) = -VJ*CJO*ln(1-vd/VJ)
        Q_depl = -VJ * Math.log(arg);
      } else {
        // dioload.c:312: VJ * CJO * (1 - (1-vd/VJ)^(1-M)) / (1-M)
        Q_depl = VJ * CJO * (1 - Math.pow(arg, 1 - M)) / (1 - M);
      }
    } else {
      // Forward-bias depletion charge (linearized region)
      // dioload.c:316: F1*CJO + czof2*(F3*(vd-depCap) + M/(2*VJ)*(vd^2-depCap^2))
      const xfc = Math.log(1 - FC);
      const F1 = Math.abs(M - 1) < 1e-10
        ? -VJ * Math.log(1 - FC)
        : VJ * (1 - Math.exp((1 - M) * xfc)) / (1 - M);
      const F2 = Math.exp((1 + M) * xfc);  // = (1-FC)^(1+M)
      const F3 = 1 - FC * (1 + M);
      const czof2 = CJO / F2;
      Q_depl = CJO * F1 + czof2 * (F3 * (vd - depCap) + (M / (2 * VJ)) * (vd * vd - depCap * depCap));
    }
  }

  // Diffusion charge: dioload.c:333
  const Q_diff = TT * Id;

  return Q_depl + Q_diff;
}

// ---------------------------------------------------------------------------
// computeDiodeIV — 3-region I-V model
// ---------------------------------------------------------------------------

/**
 * Compute diode DC current and conductance at the given operating point.
 * Returns { id, gd } WITHOUT GMIN (caller adds GMIN as needed).
 * Three regions matching dioload.c:232-252.
 */
export function computeDiodeIV(
  vd: number,
  IS: number,
  nVt: number,
  BV: number,
  vtebrk: number,
): { id: number; gd: number } {
  if (vd >= -3 * nVt) {
    // Region 1 — Forward: dioload.c:232-234
    const expArg = Math.min(vd / nVt, 700);
    const evd = Math.exp(expArg);
    return { id: IS * (evd - 1), gd: IS * evd / nVt };
  } else if (BV >= Infinity || vd >= -BV) {
    // Region 2 — Smooth reverse (cubic): dioload.c:238-244
    const arg3 = 3 * nVt / (vd * Math.E);
    const arg = arg3 * arg3 * arg3;
    return { id: -IS * (1 + arg), gd: IS * 3 * arg / vd };
  } else {
    // Region 3 — Breakdown: dioload.c:246-252
    const evrev = Math.exp(Math.min(-(BV + vd) / vtebrk, 700));
    return { id: -IS * evrev, gd: IS * evrev / vtebrk };
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
) {
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
    NBV: props.getModelParam<number>("NBV"),
    EG:  props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    KF:  props.getModelParam<number>("KF"),
    AF:  props.getModelParam<number>("AF"),
  };

  // diosetup.c:93-95: NBV defaults to N when not explicitly given
  if (isNaN(params.NBV)) params.NBV = params.N;

  // When RS > 0, use an internal node between the anode pin and the junction.
  // nodeJunction is the node the Shockley junction connects from (internal side of RS).
  const nodeJunction = params.RS > 0 && internalNodeIds.length > 0
    ? internalNodeIds[0]
    : nodeAnode;

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, DIOload sets CKTnoncon++)
  let pnjlimLimited = false;

  const element = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSize: hasCapacitance ? 9 : 4,
    stateSchema: hasCapacitance ? DIODE_CAP_SCHEMA : DIODE_SCHEMA,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      base = this.stateBaseOffset;
      applyInitialValues(this.stateSchema, pool, base, params);
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
      // Capacitance companion model entries are stamped in stampReactiveCompanion().
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

    updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): boolean {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Recompute derived values from mutable params
      const nVt = params.N * VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));

      const vtebrk = params.NBV * VT;  // DD3: breakdown emission voltage

      // Apply pnjlim — dioload.c:180-191
      const vdOld = s0[base + SLOT_VD];
      let vdLimited: number;
      if (params.BV < Infinity && vdRaw < Math.min(0, -params.BV + 10 * vtebrk)) {
        // Breakdown reflection: limit in the reflected domain
        let vdtemp = -(vdRaw + params.BV);
        const vdtempOld = -(vdOld + params.BV);
        const reflResult = pnjlim(vdtemp, vdtempOld, vtebrk, vcrit);
        vdtemp = reflResult.value;
        pnjlimLimited = reflResult.limited;
        vdLimited = -(vdtemp + params.BV);
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
      } else {
        // Normal forward/reverse limiting: dioload.c:189-191
        const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
        vdLimited = vdResult.value;
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
      }

      s0[base + SLOT_VD] = vdLimited;

      // 3-region I-V: dioload.c:232-252 (vtebrk already computed above for DD4)
      const { id: idRaw, gd: gdRaw } = computeDiodeIV(vdLimited, params.IS, nVt, params.BV, vtebrk);

      // Add GMIN — dioload.c:283-300
      const gd = gdRaw + GMIN;
      const id = idRaw + GMIN * vdLimited;  // DD5: store id + GMIN*vd

      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = gd;
      s0[base + SLOT_IEQ] = id - gd * vdLimited;
      return pnjlimLimited;
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      // ngspice icheck gate: if voltage was limited in updateOperatingPoint,
      // declare non-convergence immediately (DIOload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

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
      return [id, -id];
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
    },
  };

  // Attach stampCompanion only when junction capacitance is present
  if (hasCapacitance) {
    (element as unknown as { stampCompanion: AnalogElementCore["stampCompanion"] }).stampCompanion = function (
      dt: number,
      method: IntegrationMethod,
      voltages: Float64Array,
      order: number,
      deltaOld: readonly number[],
    ): void {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vNow = va - vc;

      // Recompute derived values from mutable params
      const nVt = params.N * VT;

      // Depletion + transit-time capacitance at current operating point
      const Cj = computeJunctionCapacitance(vNow, params.CJO, params.VJ, params.M, params.FC);
      const vtebrk = params.NBV * VT;
      const { gd: gDiode, id: idRaw } = computeDiodeIV(vNow, params.IS, nVt, params.BV, vtebrk);
      const Ct = params.TT * gDiode;  // dioload.c:338: diffcap = TT * gdb
      const Ctotal = Cj + Ct;

      const q0 = computeJunctionCharge(vNow, params.CJO, params.VJ, params.M, params.FC, params.TT, idRaw);
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      const { geq, ceq, ccap } = integrateCapacitor(Ctotal, vNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
      s0[base + SLOT_CAP_GEQ] = geq;
      s0[base + SLOT_CAP_IEQ] = ceq;
      s0[base + SLOT_V] = vNow;
      s0[base + SLOT_Q] = q0;
      s0[base + SLOT_CCAP] = ccap;
    };

    (element as unknown as { stampReactiveCompanion: AnalogElementCore["stampReactiveCompanion"] }).stampReactiveCompanion = function (
      solver: SparseSolver,
    ): void {
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
    };

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

    (element as unknown as { updateChargeFlux: (v: Float64Array, dt: number, method: string, order: number, deltaOld: readonly number[]) => void }).updateChargeFlux = function(voltages: Float64Array, _dt: number, _method: string, _order: number, _deltaOld: readonly number[]): void {
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vd = va - vc;
      const nVt = params.N * VT;
      const vtebrk = params.NBV * VT;
      const { id: idRaw } = computeDiodeIV(vd, params.IS, nVt, params.BV, vtebrk);
      s0[base + SLOT_Q] = computeJunctionCharge(vd, params.CJO, params.VJ, params.M, params.FC, params.TT, idRaw);
      s0[base + SLOT_V] = vd;
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
