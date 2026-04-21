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
import type { IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  MODEINITJCT,
  MODEINITFIX,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODEINITPRED,
  MODETRAN,
  MODEAC,
  MODETRANOP,
  MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h values)
// ---------------------------------------------------------------------------

const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;
const REFTEMP = 300.15;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// State schemas
// ---------------------------------------------------------------------------

// Slot index constants — shared between both schema variants.
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
// SLOT_CAP_CURRENT dual semantics (dioload.c:363): under MODETRAN holds iqcap (A);
// under MODEINITSMSIG holds capd (F) = raw total capacitance.
const SLOT_CAP_CURRENT = 4, SLOT_V = 5, SLOT_Q = 6;
const SLOT_CCAP = 7;

/** Schema for resistive diode (no junction capacitance): 4 slots. */
export const DIODE_SCHEMA: StateSchema = defineStateSchema("DiodeElement", [
  { name: "VD",          doc: "pnjlim-limited junction voltage",                  init: { kind: "zero" } },
  { name: "GEQ",         doc: "NR companion conductance",                         init: { kind: "constant", value: GMIN } },
  { name: "IEQ",         doc: "NR companion Norton current",                      init: { kind: "zero" } },
  { name: "ID",          doc: "Diode current at operating point",                 init: { kind: "zero" } },
]);

/** Schema for capacitive diode (CJO > 0 or TT > 0): 8 slots. */
export const DIODE_CAP_SCHEMA: StateSchema = defineStateSchema("DiodeElement_cap", [
  { name: "VD",          doc: "pnjlim-limited junction voltage",                  init: { kind: "zero" } },
  { name: "GEQ",         doc: "NR companion conductance",                         init: { kind: "constant", value: GMIN } },
  { name: "IEQ",         doc: "NR companion Norton current",                      init: { kind: "zero" } },
  { name: "ID",          doc: "Diode current at operating point",                 init: { kind: "zero" } },
  { name: "CAP_CURRENT", doc: "MODETRAN: iqcap (A); MODEINITSMSIG: capd (F) — dioload.c:363 DIOcapCurrent", init: { kind: "zero" } },
  { name: "V",           doc: "Junction voltage at current step (for companion)", init: { kind: "zero" } },
  { name: "Q",           doc: "Junction charge at current step (DIOcapCharge)",  init: { kind: "zero" } },
  { name: "CCAP",        doc: "Companion current (NIintegrate)",                  init: { kind: "zero" } },
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
    IKF: { default: Infinity, unit: "A", description: "High-injection knee current (forward)" },
    IKR: { default: Infinity, unit: "A", description: "High-injection knee current (reverse)" },
    EG:  { default: 1.11, unit: "eV", description: "Activation energy" },
    XTI: { default: 3,                description: "Saturation current temperature exponent" },
    KF:  { default: 0,                description: "Flicker noise coefficient" },
    AF:  { default: 1,                description: "Flicker noise exponent" },
    AREA: { default: 1,               description: "Area scaling factor" },
    TNOM: { default: REFTEMP, unit: "K", description: "Parameter measurement temperature" },
    OFF: { default: 0,                description: "Initial condition: device off (0=false, 1=true)" },
    IC:  { default: NaN,   unit: "V",  description: "Initial condition: junction voltage for UIC" },
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
// DioTempParams — result of dioTemp()
// ---------------------------------------------------------------------------

export interface DioTempParams {
  /** Temperature-scaled thermal voltage kT/q */
  vt: number;
  /** Temperature-scaled saturation current (DIOtSatCur) */
  tIS: number;
  /** Temperature-scaled junction potential (DIOtJctPot) */
  tVJ: number;
  /** Temperature-scaled zero-bias cap (DIOtJctCap) */
  tCJO: number;
  /** Critical voltage for pnjlim (DIOtVcrit) */
  tVcrit: number;
  /** Effective breakdown voltage after knee iteration (DIOtBrkdwnV) */
  tBV: number;
}

// ---------------------------------------------------------------------------
// dioTemp — ngspice diotemp.c temperature scaling
// ---------------------------------------------------------------------------

/**
 * Compute temperature-scaled diode parameters, matching ngspice diotemp.c.
 *
 * Scaling formulas (diotemp.c):
 *   fact1 = TNOM / REFTEMP
 *   fact2 = T / REFTEMP
 *   egfet = 1.16 - (7.02e-4 * T^2) / (T + 1108)
 *   pbfact = -2 * vt * (1.5 * log(fact2) + q * arg)
 *     where arg = -egfet/(2*k*T) + 1.1150877/(k*600.3)
 *   tIS = IS * exp((T/TNOM - 1) * EG / (N*vt) + XTI/N * log(T/TNOM))
 *   pbo = (VJ - pbfact1) / fact1
 *   tVJ = fact2 * pbo + pbfact
 *   capfact = (1 + M*(4e-4*(TNOM-REFTEMP) - gmaold)) / (1 + M*(4e-4*(T-REFTEMP) - gmanew))
 *   tCJO = CJO * capfact
 */
export function dioTemp(p: {
  IS: number; N: number; VJ: number; CJO: number; M: number;
  BV: number; IBV: number; NBV: number; EG: number; XTI: number; TNOM: number;
}, T: number = REFTEMP): DioTempParams {
  const vt = T * CONSTboltz / CHARGE;
  const vtnom = p.TNOM * CONSTboltz / CHARGE;

  const fact1 = p.TNOM / REFTEMP;
  const fact2 = T / REFTEMP;

  // egfet at operating temperature T
  const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
  const arg = -egfet / (2 * CONSTboltz * T) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

  // egfet at nominal temperature TNOM
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (2 * CONSTboltz * p.TNOM) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);

  // tIS: diotemp.c — IS * exp((T/TNOM - 1)*EG/(N*vt) + XTI/N * log(T/TNOM))
  const ratlog = Math.log(T / p.TNOM);
  const ratio1 = T / p.TNOM - 1;
  const factlog = ratio1 * p.EG / (p.N * vt) + (p.XTI / p.N) * ratlog;
  const tIS = p.IS * Math.exp(factlog);

  // tVJ: junction potential temperature scaling (diotemp.c)
  const pbo = (p.VJ - pbfact1) / fact1;
  const tVJ = fact2 * pbo + pbfact;

  // tCJO: capacitance temperature scaling (diotemp.c)
  let tCJO = p.CJO;
  if (p.CJO > 0 && p.VJ > 0) {
    const gmaold = (p.VJ - pbo) / pbo;
    const gmanew = (tVJ - pbo) / pbo;
    const capfact = (1 + p.M * (4e-4 * (p.TNOM - REFTEMP) - gmaold)) /
                    (1 + p.M * (4e-4 * (T - REFTEMP) - gmanew));
    tCJO = p.CJO * capfact;
  }

  // tVcrit: critical voltage for pnjlim (diotemp.c)
  const nVt = p.N * vt;
  const tVcrit = nVt * Math.log(nVt / (tIS * Math.SQRT2));

  // tBV: Newton-iterate to find effective breakdown voltage
  // diotemp.c: xbv = BV - vt*log(1 + cbv/IS)  (cbv = IBV, using NBV emission)
  let tBV = p.BV;
  if (isFinite(p.BV)) {
    const nbvVt = p.NBV * vt;
    let xbv = p.BV - nbvVt * Math.log(1 + p.IBV / tIS);
    for (let i = 0; i < 25; i++) {
      const f = tIS * (Math.exp((p.BV - xbv) / nbvVt) - 1) - p.IBV;
      const df = tIS * Math.exp((p.BV - xbv) / nbvVt) / nbvVt;
      const dx = f / df;
      xbv -= dx;
      if (Math.abs(dx) < 1e-12) break;
    }
    tBV = xbv;
  }

  return { vt, tIS, tVJ, tCJO, tVcrit, tBV };
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
    // Region 1 — Forward: dioload.c:247 evd = exp(vd/vte); no clamp
    const evd = Math.exp(vd / nVt);
    return { id: IS * (evd - 1), gd: IS * evd / nVt };
  } else if (BV >= Infinity || vd >= -BV) {
    // Region 2 — Smooth reverse (cubic): dioload.c:238-244
    const arg3 = 3 * nVt / (vd * Math.E);
    const arg = arg3 * arg3 * arg3;
    return { id: -IS * (1 + arg), gd: IS * 3 * arg / vd };
  } else {
    // Region 3 — Breakdown: dioload.c:246-252
    const evrev = Math.exp(-(BV + vd) / vtebrk);
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
    IKF: props.getModelParam<number>("IKF"),
    IKR: props.getModelParam<number>("IKR"),
    EG:  props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    KF:  props.getModelParam<number>("KF"),
    AF:  props.getModelParam<number>("AF"),
    AREA: props.getModelParam<number>("AREA"),
    TNOM: props.getModelParam<number>("TNOM"),
    OFF:  props.getModelParam<number>("OFF"),
    IC:   props.getModelParam<number>("IC"),
  };

  // diosetup.c:93-95: NBV defaults to N when not explicitly given
  if (isNaN(params.NBV)) params.NBV = params.N;

  // Area scaling — applied once at construction
  params.IS  *= params.AREA;
  if (params.RS > 0) params.RS /= params.AREA;
  params.CJO *= params.AREA;

  // Mutable temperature-scaled working values — recomputed when params change.
  let tIS: number;
  let tVJ: number;
  let tCJO: number;
  let tVcrit: number;
  let tBV: number;
  let vt: number;
  let nVt: number;

  function recomputeTemp(): void {
    const tp = dioTemp({
      IS: params.IS, N: params.N, VJ: params.VJ, CJO: params.CJO, M: params.M,
      BV: params.BV, IBV: params.IBV, NBV: params.NBV, EG: params.EG,
      XTI: params.XTI, TNOM: params.TNOM,
    }, REFTEMP);
    tIS = tp.tIS;
    tVJ = tp.tVJ;
    tCJO = tp.tCJO;
    tVcrit = tp.tVcrit;
    tBV = tp.tBV;
    vt = tp.vt;
    nVt = params.N * vt;
  }

  recomputeTemp();

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
    stateSize: hasCapacitance ? 8 : 4,
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

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array, _newS4: Float64Array, _newS5: Float64Array, _newS6: Float64Array, _newS7: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const mode = ctx.cktMode;   // F4: bitfield (ckt-mode.ts)

      // MODEINITPRED — #ifndef PREDICTOR path. dioload.c:98-99 (#ifndef
      // PREDICTOR block): adopt predictor-extrapolated vd, but since ngspice
      // ships with PREDICTOR #undef by default, this branch is NEVER entered
      // in reference builds (nipred.c:20 early-returns, cktdefs.h builds
      // never set MODEINITPRED). We retain an inert branch so state rotation
      // still works if a future engine re-enables the predictor, matching
      // dioload.c:128.
      if (mode & MODEINITPRED) {
        s0[base + SLOT_VD]  = s1[base + SLOT_VD];
        s0[base + SLOT_ID]  = s1[base + SLOT_ID];
        s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
      }

      // Select linearization voltage according to ngspice dioload.c:126-137.
      let vdRaw: number;
      if (mode & MODEINITSMSIG) {
        // dioload.c:126-127: MODEINITSMSIG seeds vd from CKTstate0.
        vdRaw = s0[base + SLOT_VD];
      } else if (mode & MODEINITTRAN) {
        // dioload.c:128-129: MODEINITTRAN seeds vd from CKTstate1.
        vdRaw = s1[base + SLOT_VD];
      } else if (mode & MODEINITJCT) {
        // dioload.c:130-136: MODEINITJCT dispatch verbatim.
        if ((mode & MODETRANOP) && (mode & MODEUIC)) {
          vdRaw = params.IC;  // dioload.c:131-132: DIOinitCond
        } else if (params.OFF) {
          vdRaw = 0;           // dioload.c:133-134
        } else {
          vdRaw = tVcrit;      // dioload.c:135-136: DIOtVcrit
        }
      } else if ((mode & MODEINITFIX) && params.OFF) {
        // dioload.c:137-138: MODEINITFIX && DIOoff → vd = 0
        vdRaw = 0;
      } else {
        // Normal linearization from the NR iterate.
        const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
        const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
        vdRaw = va - vc;
      }

      const vtebrk = params.NBV * vt;

      // Apply pnjlim — dioload.c:180-191.
      const vdOld = s0[base + SLOT_VD];
      let vdLimited: number;
      if (mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) {
        // dioload.c:126-135: these phases set vd directly — no pnjlim.
        vdLimited = vdRaw;
        pnjlimLimited = false;
      } else if (tBV < Infinity && vdRaw < Math.min(0, -tBV + 10 * vtebrk)) {
        // Breakdown reflection: limit in the reflected domain
        let vdtemp = -(vdRaw + tBV);
        const vdtempOld = -(vdOld + tBV);
        const reflResult = pnjlim(vdtemp, vdtempOld, vtebrk, tVcrit);
        vdtemp = reflResult.value;
        pnjlimLimited = reflResult.limited;
        vdLimited = -(vdtemp + tBV);
      } else {
        // Normal forward/reverse limiting: dioload.c:189-191
        const vdResult = pnjlim(vdRaw, vdOld, nVt, tVcrit);
        vdLimited = vdResult.value;
        pnjlimLimited = vdResult.limited;
      }

      if (pnjlimLimited) ctx.noncon.value++;

      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
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

      // 3-region I-V: dioload.c:232-252
      const { id: idRaw, gd: gdRaw } = computeDiodeIV(vdLimited, tIS, nVt, tBV, vtebrk);

      // High-injection correction (IKF forward, IKR reverse)
      let gdCorr = gdRaw;
      if (isFinite(params.IKF) && params.IKF > 0 && idRaw > 0) {
        const ikfRatio = idRaw / params.IKF;
        const sqrtTerm = Math.sqrt(1 + ikfRatio);
        gdCorr /= sqrtTerm * (1 + sqrtTerm);
      } else if (isFinite(params.IKR) && params.IKR > 0 && idRaw < 0) {
        const ikrRatio = (-idRaw) / params.IKR;
        const sqrtTerm = Math.sqrt(1 + ikrRatio);
        gdCorr /= sqrtTerm * (1 + sqrtTerm);
      }

      // Add GMIN — dioload.c:283-300
      const gd = gdCorr + GMIN;
      const id = idRaw + GMIN * vdLimited;  // DD5: store id + GMIN*vd

      s0[base + SLOT_ID] = id;
      s0[base + SLOT_GEQ] = gd;
      const ieq = id - gd * vdLimited;
      s0[base + SLOT_IEQ] = ieq;

      const solver = ctx.solver;

      // Stamp series resistance RS between anode pin and internal junction node
      if (params.RS > 0 && nodeJunction !== nodeAnode) {
        const gRS = 1 / params.RS;
        stampG(solver, nodeAnode, nodeAnode, gRS);
        stampG(solver, nodeAnode, nodeJunction, -gRS);
        stampG(solver, nodeJunction, nodeAnode, -gRS);
        stampG(solver, nodeJunction, nodeJunction, gRS);
      }

      // Stamp nonlinear companion model: conductance gd in parallel, Norton offset ieq
      // Junction is between nodeJunction and nodeCathode
      stampG(solver, nodeJunction, nodeJunction, gd);
      stampG(solver, nodeJunction, nodeCathode, -gd);
      stampG(solver, nodeCathode, nodeJunction, -gd);
      stampG(solver, nodeCathode, nodeCathode, gd);
      stampRHS(solver, nodeJunction, -ieq);
      stampRHS(solver, nodeCathode, ieq);

      // Reactive companion: junction capacitance + transit-time diffusion cap.
      // ngspice dioload.c:316-317: gated on MODETRAN | MODEAC | MODEINITSMSIG
      // OR (MODETRANOP && MODEUIC).
      const capGate =
        (mode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 ||
        ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);
      if (hasCapacitance && capGate) {
        const order = ctx.order;
        const method = ctx.method;

        // Depletion + transit-time capacitance at current operating point
        const Cj = computeJunctionCapacitance(vdLimited, tCJO, tVJ, params.M, params.FC);
        const Ct = params.TT * gd;  // dioload.c:338: diffcap = TT * gdb
        const Ctotal = Cj + Ct;

        const q0 = computeJunctionCharge(vdLimited, tCJO, tVJ, params.M, params.FC, params.TT, idRaw);
        let q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const q3 = s3[base + SLOT_Q];

        if (mode & MODEINITTRAN) {
          // dioload.c:391-393: MODEINITTRAN copies q0→q1 so first-step history matches
          s1[base + SLOT_Q] = q0;
          q1 = q0;
        }

        // NIintegrate via shared helper (niinteg.c:17-80).
        const ag = ctx.ag;
        const ccapPrev = s1[base + SLOT_CCAP];
        const { ccap, geq: capGeq } = niIntegrate(
          method,
          order,
          Ctotal,
          ag,
          q0, q1,
          [q2, q3, 0, 0, 0],
          ccapPrev,
        );
        const capIeq = ccap - capGeq * vdLimited;
        s0[base + SLOT_V] = vdLimited;
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (mode & MODEINITTRAN) {
          // dioload.c:399-402: MODEINITTRAN copies ccap0→ccap1
          s1[base + SLOT_CCAP] = ccap;
        }

        // Small-signal parameter store-back (dioload.c:360-374). Only during
        // MODEINITSMSIG, and only when NOT (MODETRANOP && MODEUIC).
        if ((mode & MODEINITSMSIG) &&
            !((mode & MODETRANOP) && (mode & MODEUIC))) {
          // dioload.c:363: store raw capd (Farads) into DIOcapCurrent slot.
          s0[base + SLOT_CAP_CURRENT] = Ctotal;
          // dioload.c:374: continue — skip niIntegrate companion stamp.
          return;
        }

        // dioload.c: MODETRAN path — store iqcap (A) into DIOcapCurrent slot.
        s0[base + SLOT_CAP_CURRENT] = ccap;

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

    checkConvergence(ctx: LoadContext): boolean {
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      // ngspice icheck gate: if voltage was limited in load(),
      // declare non-convergence immediately (DIOload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const voltages = ctx.voltages;
      const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
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

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id, -id];
    },


    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        recomputeTemp();
      }
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
// getDiodeInternalNodeCount — returns 1 when RS > 0, else 0
// ---------------------------------------------------------------------------

export function getDiodeInternalNodeCount(props: PropertyBag): number {
  return props.getModelParam<number>("RS") > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// getDiodeInternalNodeLabels — mirror of getDiodeInternalNodeCount's predicate
// ---------------------------------------------------------------------------

/**
 * Returns internal node labels for a diode instance.
 *
 * MUST use the same predicate as `getDiodeInternalNodeCount`: when RS > 0
 * we allocate a single internal anode-prime node between the external anode
 * pin and the junction ("A'").
 */
export function getDiodeInternalNodeLabels(props: PropertyBag): readonly string[] {
  return props.getModelParam<number>("RS") > 0 ? ["A'"] : [];
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
      getInternalNodeLabels: getDiodeInternalNodeLabels,
    },
  },
  defaultModel: "spice",
};
