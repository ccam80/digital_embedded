/**
 * Diode analog component  Shockley equation with NR linearization.
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
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
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h values)
// ---------------------------------------------------------------------------

const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;
// ngspice main.c:515 — precomputed to match diotemp.c:104 vt ordering
const CONSTKoverQ = CONSTboltz / CHARGE;
const REFTEMP = 300.15;

// ---------------------------------------------------------------------------
// State schemas
// ---------------------------------------------------------------------------

// Slot layout — single 5-slot schema mirroring ngspice diodefs.h:154-158
// (DIOvoltage..DIOcapCurrent). Allocated unconditionally per diosetup.c:199
// `*states += 5`, regardless of CJO/TT — the cap slots are unused when the
// junction has no capacitance but always exist. Companion-current `ieq` is
// recomputed inline as `cd - gd*vdLimited` per dioload.c (cdeq formula); no
// state slot is allocated for it. CAP_CURRENT and CCAP collapse to a single
// slot per niinteg.c:15 `#define ccap qcap+1`.
export const DIODE_SCHEMA: StateSchema = defineStateSchema("DiodeElement", [
  { name: "VD",   doc: "pnjlim-limited junction voltage — diodefs.h DIOvoltage (DIOstate+0)" },
  { name: "ID",   doc: "Diode current at operating point — diodefs.h DIOcurrent (DIOstate+1)" },
  { name: "GEQ",  doc: "NR companion conductance — diodefs.h DIOconduct (DIOstate+2)" },
  { name: "Q",    doc: "Junction charge — diodefs.h DIOcapCharge (DIOstate+3)" },
  { name: "CAP_CURRENT", doc: "MODETRAN: NIintegrate companion current iqcap; MODEINITSMSIG: capd (F) per dioload.c:363 — diodefs.h DIOcapCurrent (DIOstate+4)" },
]);

const SLOT_VD   = 0;
const SLOT_ID   = 1;
const SLOT_GEQ  = 2;
const SLOT_Q    = 3;
const SLOT_CCAP = 4;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DIODE_PARAM_DEFS, defaults: DIODE_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    IS:  { default: 1e-14, unit: "A",  description: "Saturation current" },
    N:   { default: 1,                 description: "Emission coefficient" },
  },
  secondary: {
    RS:  { default: 0,    unit: "ÃŽ",  description: "Ohmic (series) resistance" },
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
    TNOM: { default: REFTEMP, unit: "K", description: "Parameter measurement temperature", spiceConverter: kelvinToCelsius },
    // D-W3-6: sidewall saturation current params  dioload.c:209-243
    ISW:   { default: 0,    unit: "A",  spiceName: "JSW", description: "Sidewall saturation current (DIOsatSWCur)" },
    NSW:   { default: NaN,             description: "Sidewall emission coefficient (DIOswEmissionCoeff; default=N)" },
  },
  instance: {
    AREA: { default: 1,               description: "Area scaling factor" },
    OFF: { default: 0, emit: "flag",  description: "Initial condition: device off (0=false, 1=true)" },
    IC:  { default: NaN,   unit: "V",  description: "Initial condition: junction voltage for UIC" },
    TEMP:  { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// computeJunctionCapacitance
// ---------------------------------------------------------------------------

/**
 * Compute junction depletion capacitance using the SPICE depletion formula.
 *
 * For reverse bias (Vd < tDepCap = FC*tVJ):
 *   Cj = tCJO / (1 - Vd/tVJ)^M
 * For forward bias linearization (Vd >= tDepCap):
 *   Cj = tCJO / tF2 * (tF3 + M*Vd/tVJ)
 *
 * tDepCap, tF2, tF3 are pre-computed by dioTemp() / computeTemperature().
 * cite: dioload.c:321-342 — temperature-scaled cap formula uses DIOtDepCap, DIOtF2, DIOtF3.
 */
export function computeJunctionCapacitance(
  vd: number,
  tCJO: number,
  tVJ: number,
  M: number,
  tDepCap: number,
  tF2: number,
  tF3: number,
): number {
  if (tCJO <= 0) return 0;
  if (vd < tDepCap) {
    const arg = 1 - vd / tVJ;
    const safeArg = Math.max(arg, 1e-6);
    return tCJO / Math.pow(safeArg, M);
  } else {
    return (tCJO / tF2) * (tF3 + (M * vd) / tVJ);
  }
}

// ---------------------------------------------------------------------------
// computeJunctionCharge
// ---------------------------------------------------------------------------

/**
 * Compute total junction charge — integral of C(V) dV — matching ngspice
 * dioload.c:308-341.
 *
 * Depletion charge (reverse bias, vd < tDepCap = FC*tVJ):
 *   dioload.c:312: deplcharge = tJctPot * czero * (1 - arg*sarg) / (1-M)
 *   where arg = 1 - vd/tVJ, sarg = arg^(-M), so arg*sarg = (1-vd/tVJ)^(1-M)
 *   => Q_depl = tVJ * tCJO * (1 - (1-vd/tVJ)^(1-M)) / (1-M)
 *   Special case M=1: Q_depl = -tVJ * tCJO * ln(1-vd/tVJ)
 *
 * Depletion charge (forward bias, vd >= tDepCap):
 *   dioload.c:316: deplcharge = tF1*tCJO + czof2*(tF3*(vd-tDepCap) + M/(2*tVJ)*(vd^2-tDepCap^2))
 *   where czof2 = tCJO/tF2, tF1/tF2/tF3 pre-computed by dioTemp()
 *
 * Diffusion charge (dioload.c:333):
 *   diffcharge = TT * Id
 *   where Id is the GMIN-adjusted diode current from load()
 *
 * tF1, tF2, tF3, tDepCap are pre-computed by dioTemp() / computeTemperature().
 * cite: dioload.c:308-341 — junction charge integral using DIOtF1/DIOtF2/DIOtF3/DIOtDepCap.
 */
export function computeJunctionCharge(
  vd: number,
  tCJO: number,
  tVJ: number,
  M: number,
  tDepCap: number,
  tF1: number,
  tF2: number,
  tF3: number,
  TT: number,
  Id: number,
): number {
  let Q_depl = 0;
  if (tCJO > 0) {
    if (vd < tDepCap) {
      // cite: dioload.c:312 — reverse-bias depletion charge
      const arg = Math.max(1 - vd / tVJ, 1e-6);
      if (Math.abs(M - 1) < 1e-10) {
        Q_depl = -tVJ * tCJO * Math.log(arg);
      } else {
        Q_depl = tVJ * tCJO * (1 - Math.pow(arg, 1 - M)) / (1 - M);
      }
    } else {
      // cite: dioload.c:316 — forward-bias linearized depletion charge
      const czof2 = tCJO / tF2;
      Q_depl = tCJO * tF1 + czof2 * (tF3 * (vd - tDepCap) + (M / (2 * tVJ)) * (vd * vd - tDepCap * tDepCap));
    }
  }

  // cite: dioload.c:333 — diffusion charge = TT * Id
  const Q_diff = TT * Id;

  return Q_depl + Q_diff;
}

// ---------------------------------------------------------------------------
// DioTempParams  result of dioTemp()
// ---------------------------------------------------------------------------

export interface DioTempParams {
  /** Temperature-scaled thermal voltage kT/q */
  vt: number;
  /** Nominal thermal voltage kT_nom/q at TNOM (diotemp.c vtnom) */
  vtnom: number;
  /** Temperature-scaled saturation current (DIOtSatCur) — diotemp.c:152-156 */
  tIS: number;
  /** Temperature-scaled sidewall saturation current (DIOtSatSWCur) — diotemp.c:157-161 */
  tSatSWCur: number;
  /** Temperature-scaled junction potential (DIOtJctPot) — diotemp.c:126 */
  tVJ: number;
  /** Temperature-scaled sidewall junction potential (DIOtJctSWPot) — diotemp.c:143 */
  tJctSWPot: number;
  /** Temperature-scaled zero-bias cap (DIOtJctCap) — diotemp.c:123-129 */
  tCJO: number;
  /** Temperature-scaled sidewall zero-bias cap (DIOtJctSWCap) — diotemp.c:139-145 */
  tJctSWCap: number;
  /** Critical voltage for pnjlim (DIOtVcrit) — diotemp.c:187 */
  tVcrit: number;
  /** Effective breakdown voltage after knee iteration (DIOtBrkdwnV) — diotemp.c:244 */
  tBV: number;
  /** F1 for forward-bias cap linearization (DIOtF1) — diotemp.c:176-178 */
  tF1: number;
  /** F2 = exp((1+M)*xfc) (DIOtF2) — diotemp.c:260 */
  tF2: number;
  /** F3 = 1 - FC*(1+M) (DIOtF3) — diotemp.c:261 */
  tF3: number;
  /** Temperature-scaled depletion cap threshold FC*tVJ (DIOtDepCap) — diotemp.c:180-181 */
  tDepCap: number;
}

// ---------------------------------------------------------------------------
// dioTemp  ngspice diotemp.c temperature scaling
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
  ISW: number; NSW: number; FC: number;
  VJS?: number; MS?: number;
}, T: number): DioTempParams {
  const vt = CONSTKoverQ * T;
  const vtnom = CONSTKoverQ * p.TNOM;

  // cite: diotemp.c:107-108
  const fact1 = p.TNOM / REFTEMP;
  const fact2 = T / REFTEMP;

  // cite: diotemp.c:108-112: egfet at operating temperature T
  const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
  const arg = -egfet / (2 * CONSTboltz * T) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  // cite: diotemp.c:112: pbfact = -2*vt*(1.5*log(fact2)+CHARGE*arg)
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

  // cite: diotemp.c:113-118: egfet at nominal temperature TNOM
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (2 * CONSTboltz * p.TNOM) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  // cite: diotemp.c:118: pbfact1 = -2*vtnom*(1.5*log(fact1)+CHARGE*arg1)
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);

  // cite: diotemp.c:152-156: tSatCur = IS * exp((T/TNOM-1)*EG/(N*vt) + XTI/N*log(T/TNOM))
  const ratlog = Math.log(T / p.TNOM);
  const ratio1 = T / p.TNOM - 1;
  const factlog = ratio1 * p.EG / (p.N * vt) + (p.XTI / p.N) * ratlog;
  const tIS = p.IS * Math.exp(factlog);

  // cite: diotemp.c:157-161: tSatSWCur — mirrors tSatCur with NSW emission coeff
  const swFactlog = ratio1 * p.EG / (p.NSW * vt) + (p.XTI / p.NSW) * ratlog;
  const tSatSWCur = p.ISW * Math.exp(swFactlog);

  // cite: diotemp.c:120-129: tVJ (DIOtJctPot) — junction potential temperature scaling
  const pbo = (p.VJ - pbfact1) / fact1;
  const tVJ = fact2 * pbo + pbfact;

  // cite: diotemp.c:123-129: tCJO (DIOtJctCap) — capacitance temperature scaling
  let tCJO = p.CJO;
  if (p.CJO > 0 && p.VJ > 0) {
    const gmaold = (p.VJ - pbo) / pbo;
    const gmanew = (tVJ - pbo) / pbo;
    // cite: diotemp.c:123-124: divide by (1 + M*(400e-6*(TNOM-REFTEMP) - gmaold))
    // cite: diotemp.c:128-129: multiply by (1 + M*(400e-6*(T-REFTEMP) - gmanew))
    const capfact = (1 + p.M * (4e-4 * (p.TNOM - REFTEMP) - gmaold)) /
                    (1 + p.M * (4e-4 * (T - REFTEMP) - gmanew));
    tCJO = p.CJO * capfact;
  }

  // cite: diotemp.c:136-145: sidewall junction potential + capacitance scaling
  // VJS defaults to VJ, MS defaults to M when not given.
  const VJS = p.VJS ?? p.VJ;
  const MS  = p.MS  ?? p.M;
  const pboSW = (VJS - pbfact1) / fact1;
  const tJctSWPot = fact2 * pboSW + pbfact;
  let tJctSWCap = 0;
  if (p.CJO > 0 && VJS > 0) {
    // cite: diotemp.c:139-141: DIOtJctSWCap — sidewall zero-bias cap temperature scaling
    const gmaSWold = (VJS - pboSW) / pboSW;
    const gmaSWnew = (tJctSWPot - pboSW) / pboSW;
    const capfactSW = (1 + MS * (4e-4 * (p.TNOM - REFTEMP) - gmaSWold)) /
                      (1 + MS * (4e-4 * (T - REFTEMP) - gmaSWnew));
    tJctSWCap = p.CJO * capfactSW;
  }

  // cite: diotemp.c:185-187: vte = N*vt; DIOtVcrit = vte*log(vte/(CONSTroot2*DIOtSatCur))
  const nVt = p.N * vt;
  const tVcrit = nVt * Math.log(nVt / (tIS * Math.SQRT2));

  // cite: diotemp.c:208-244: breakdown voltage iteration
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

  // cite: diotemp.c:176-178: DIOtF1 = tVJ*(1 - exp((1-M)*xfc)) / (1-M)
  // where xfc = log(1 - FC)
  const xfc = Math.log(1 - p.FC);
  const tF1 = Math.abs(p.M - 1) < 1e-10
    ? -tVJ * Math.log(1 - p.FC)
    : tVJ * (1 - Math.exp((1 - p.M) * xfc)) / (1 - p.M);

  // cite: diotemp.c:260: DIOtF2 = exp((1+M)*xfc) = (1-FC)^(1+M)
  // Use Math.pow to preserve bit-exact parity with the original per-call computation.
  const tF2 = Math.pow(1 - p.FC, 1 + p.M);

  // cite: diotemp.c:261: DIOtF3 = 1 - FC*(1+M)
  const tF3 = 1 - p.FC * (1 + p.M);

  // cite: diotemp.c:180-181: DIOtDepCap = FC * tVJ
  const tDepCap = p.FC * tVJ;

  return {
    vt, vtnom,
    tIS, tSatSWCur,
    tVJ, tJctSWPot,
    tCJO, tJctSWCap,
    tVcrit, tBV,
    tF1, tF2, tF3, tDepCap,
  };
}

// ---------------------------------------------------------------------------
// computeDiodeIV  3-region I-V model
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
    // Region 1  Forward: dioload.c:247 evd = exp(vd/vte); no clamp
    const evd = Math.exp(vd / nVt);
    return { id: IS * (evd - 1), gd: IS * evd / nVt };
  } else if (BV >= Infinity || vd >= -BV) {
    // Region 2  Smooth reverse (cubic): dioload.c:238-244
    const arg3 = 3 * nVt / (vd * Math.E);
    const arg = arg3 * arg3 * arg3;
    return { id: -IS * (1 + arg), gd: IS * 3 * arg / vd };
  } else {
    // Region 3  Breakdown: dioload.c:246-252
    const evrev = Math.exp(-(BV + vd) / vtebrk);
    return { id: -IS * evrev, gd: IS * evrev / vtebrk };
  }
}

// ---------------------------------------------------------------------------
// createDiodeElement  AnalogElement factory
// ---------------------------------------------------------------------------

export function createDiodeElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  // Closure-captured pin node IDs assigned in setup() once `this.pinNodes` is
  // available. (Under the compile-time-expansion architecture, pinNodes is
  // already fully resolved at construction time, so a direct read here would
  // also be safe; the closure-let pattern is retained for parity with sibling
  // factories.)
  let nodeAnode = -1;
  let nodeCathode = -1;

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
    // D-W3-6: sidewall current params (dioload.c:209-243)
    ISW:  props.getModelParam<number>("ISW"),
    NSW:  props.getModelParam<number>("NSW"),
    TEMP: props.getModelParam<number>("TEMP"),
  };

  // diosetup.c:93-95: NBV defaults to N when not explicitly given
  if (isNaN(params.NBV)) params.NBV = params.N;

  // D-W3-6: NSW defaults to N when not explicitly given (mirrors DIOswEmissionCoeff default)
  if (isNaN(params.NSW)) params.NSW = params.N;

  // D-W3-5: BV_given semantics mirror ngspice DIObreakdownVoltageGiven (dioload.c:183).
  // Evaluated inline in load() as `isFinite(params.BV)` so setParam("BV", ...) is live.
  // ngspice DIObreakdownVoltageGiven is a model parse-time flag; here we mirror its
  // semantics: true iff BV is a finite value.

  // Area scaling  applied once at construction
  params.IS  *= params.AREA;
  if (params.RS > 0) params.RS /= params.AREA;
  params.CJO *= params.AREA;

  // Mutable temperature-scaled working values — recomputed by computeTemperature().
  // Names mirror DIOtemp() output fields from diotemp.c.
  let tIS: number;        // DIOtSatCur — diotemp.c:152
  let tSatSWCur: number;  // DIOtSatSWCur — diotemp.c:157
  let tVJ: number;        // DIOtJctPot — diotemp.c:126
  let tCJO: number;       // DIOtJctCap — diotemp.c:123
  let tVcrit: number;     // DIOtVcrit — diotemp.c:187
  let tBV: number;        // DIOtBrkdwnV — diotemp.c:244
  let tF1: number;        // DIOtF1 — diotemp.c:176
  let tF2: number;        // DIOtF2 — diotemp.c:260
  let tF3: number;        // DIOtF3 — diotemp.c:261
  let tDepCap: number;    // DIOtDepCap — diotemp.c:180
  let vt: number;
  let nVt: number;

  function applyDioTempResult(tp: DioTempParams): void {
    tIS       = tp.tIS;
    tSatSWCur = tp.tSatSWCur;
    tVJ       = tp.tVJ;
    tCJO      = tp.tCJO;
    tVcrit    = tp.tVcrit;
    tBV       = tp.tBV;
    tF1       = tp.tF1;
    tF2       = tp.tF2;
    tF3       = tp.tF3;
    tDepCap   = tp.tDepCap;
    vt        = tp.vt;
    nVt       = params.N * vt;
  }

  // Initial temperature pass at construction — uses params.TEMP as the device temperature.
  applyDioTempResult(dioTemp({
    IS: params.IS, N: params.N, VJ: params.VJ, CJO: params.CJO, M: params.M,
    BV: params.BV, IBV: params.IBV, NBV: params.NBV, EG: params.EG,
    XTI: params.XTI, TNOM: params.TNOM,
    ISW: params.ISW, NSW: params.NSW, FC: params.FC,
  }, params.TEMP));

  const hasCapacitance = params.CJO > 0 || params.TT > 0;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, DIOload sets CKTnoncon++)
  let pnjlimLimited = false;
  // cite: diotemp.c — DIOtempGiven mirrors PropertyBag givenness for TEMP.
  let _tempGiven = props.isModelParamGiven("TEMP");

  // Internal prime node (DIOposPrimeNode)- set during setup(), read by load()
  let _posPrimeNode = nodeAnode;

  // TSTALLOC handles- set during setup(), read inside load()
  let _hPosPP  = -1;
  let _hNegPP  = -1;
  let _hPPPos  = -1;
  let _hPPNeg  = -1;
  let _hPosPos = -1;
  let _hNegNeg = -1;
  let _hPPPP   = -1;

  // Internal node labels- recorded during setup() when RS > 0
  const internalLabels: string[] = [];

  class DiodeAnalogElement extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
    readonly deviceFamily: DeviceFamily = "DIO";
    readonly stateSize: number;
    readonly stateSchema: import("../../solver/analog/state-schema.js").StateSchema;

    constructor(pinNodes: ReadonlyMap<string, number>) {
      super(pinNodes);
      // diosetup.c:199 — `*states += 5` always, regardless of CJO/TT.
      this.stateSize = DIODE_SCHEMA.size;
      this.stateSchema = DIODE_SCHEMA;
    }

    setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
      const solver = ctx.solver;
      const posNode = this.pinNodes.get("A")!;
      const negNode = this.pinNodes.get("K")!;
      // Re-publish pin node IDs into the closure (compile-time-resolved by
      // `expandCompositeInstance` for composite leaves; identical for primitives).
      nodeAnode = posNode;
      nodeCathode = negNode;

      // State slots- diosetup.c:198-199 (*states += DIOstateCount; here->DIOstate = *states)
      // Idempotent guard mirrors mutual-inductor.ts:94-95. When a composite
      // (e.g. polarized-cap) pre-partitions _stateBase into its own state
      // region before forwarding setup(), don’t re-allocate and waste slots.
      if (this._stateBase === -1) {
        this._stateBase = ctx.allocStates(this.stateSize);
      }

      // Internal node- diosetup.c:204-224
      // ngspice gating: RC (series resistance) > 0 → allocate anode-prime node
      if (params.RS === 0) {
        _posPrimeNode = posNode;
      } else {
        _posPrimeNode = ctx.makeVolt(this.label ?? "D", "internal");
        internalLabels.push("internal");
      }

      // TSTALLOC sequence- diosetup.c:232-238
      _hPosPP  = solver.allocElement(posNode,       _posPrimeNode); // (1)
      _hNegPP  = solver.allocElement(negNode,       _posPrimeNode); // (2)
      _hPPPos  = solver.allocElement(_posPrimeNode, posNode);       // (3)
      _hPPNeg  = solver.allocElement(_posPrimeNode, negNode);       // (4)
      _hPosPos = solver.allocElement(posNode,       posNode);       // (5)
      _hNegNeg = solver.allocElement(negNode,       negNode);       // (6)
      _hPPPP   = solver.allocElement(_posPrimeNode, _posPrimeNode); // (7)
    }

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    }

    load(ctx: LoadContext): void {
      // Direct state-array access per call  no cached Float64Array refs.
      // Mirrors ngspice CKTstate0/1/2/3 pointer semantics in dioload.c.
      const pool = this._pool;
      const base = this._stateBase;
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];

      const voltages = ctx.rhsOld;
      const mode = ctx.cktMode;   // F4: bitfield (ckt-mode.ts)
      const nodeJunction = _posPrimeNode;

      // Select linearization voltage according to ngspice dioload.c:126-155.
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
        // dioload.c:137-138: MODEINITFIX && DIOoff  vd = 0
        vdRaw = 0;
      } else if (mode & MODEINITPRED) {
        // cite: dioload.c:141-152
        // dioload.c:142-148: state1state0 copies (DIOvoltage, DIOcurrent, DIOconduct).
        s0[base + SLOT_VD]  = s1[base + SLOT_VD];
        s0[base + SLOT_ID]  = s1[base + SLOT_ID];
        s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
        // dioload.c:144: vd = DEVpred(ckt, DIOvoltage) =
        //       (1+xfact)*state1[vd] - xfact*state2[vd] under #ifndef PREDICTOR.
        // xfact computed as function-local matching bjtload.c:279 / mos1load.c
        // pattern (CKTdelta / CKTdeltaOld[1]).
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vdRaw = (1 + xfact) * s1[base + SLOT_VD] - xfact * s2[base + SLOT_VD];
      } else {
        // dioload.c:151-152: normal NR  read from CKTrhsOld.
        const va = voltages[nodeJunction];
        const vc = voltages[nodeCathode];
        vdRaw = va - vc;
      }

      const vtebrk = params.NBV * vt;

      // Apply pnjlim  dioload.c:180-204.
      const vdOld = s0[base + SLOT_VD];
      let vdLimited: number;
      // dioload.c:126-138: MODEINITSMSIG/MODEINITTRAN/MODEINITJCT(+sub-cases) and
      // MODEINITFIX+DIOoff all terminate the if-else chain BEFORE the pnjlim
      // call in the trailing `else {}` block (dioload.c:139). Mirror the full
      // dispatch here so digiTS never calls pnjlim where ngspice doesn't.
      if ((mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) ||
          ((mode & MODEINITFIX) && params.OFF)) {
        vdLimited = vdRaw;
        pnjlimLimited = false;
      } else if (isFinite(params.BV) && vdRaw < Math.min(0, -tBV + 10 * vtebrk)) {
        // D-W3-5: use isFinite(params.BV) flag mirroring DIObreakdownVoltageGiven.
        // dioload.c:183-195: breakdown path  pnjlim in reflected domain.
        let vdtemp = -(vdRaw + tBV);
        const vdtempOld = -(vdOld + tBV);
        const reflResult = pnjlim(vdtemp, vdtempOld, vtebrk, tVcrit);
        vdtemp = reflResult.value;
        pnjlimLimited = reflResult.limited;
        vdLimited = -(vdtemp + tBV);
      } else {
        // dioload.c:196-204: standard forward/reverse pnjlim.
        const vdResult = pnjlim(vdRaw, vdOld, nVt, tVcrit);
        vdLimited = vdResult.value;
        pnjlimLimited = vdResult.limited;
      }

      if (pnjlimLimited) ctx.noncon.value++;

      // dioload.c:139-205 (post-init else{} block where pnjlim is invoked),
      // dioload.c:411 (CKTnoncon++ gating): emit limiting event only under the
      // same MODEINIT* mask that pnjlim itself uses.
      const skipLimitingMask = MODEINITJCT | MODEINITSMSIG | MODEINITTRAN
        | ((mode & MODEINITFIX) && params.OFF ? MODEINITFIX : 0);
      if (!(mode & skipLimitingMask) && ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore: vdRaw,
          vAfter: vdLimited,
          wasLimited: pnjlimLimited,
        });
      }

      s0[base + SLOT_VD] = vdLimited;

      // D-W3-6: sidewall current block  dioload.c:209-243.
      // cite: dioload.c:209 `if (model->DIOsatSWCurGiven)`
      // Use temperature-scaled tSatSWCur (DIOtSatSWCur) per diotemp.c:157-161.
      let cdsw = 0;
      let gdsw = 0;
      const csatsw = tSatSWCur;
      if (csatsw > 0) {
        if (params.NSW !== params.N) {
          // cite: dioload.c:211-235: sidewall has its own emission coefficient
          const vtesw = params.NSW * vt;
          if (vdLimited >= -3 * vtesw) {
            // cite: dioload.c:215-220: forward sidewall
            const evd = Math.exp(vdLimited / vtesw);
            cdsw = csatsw * (evd - 1);
            gdsw = csatsw * evd / vtesw;
          } else if (!isFinite(params.BV) || vdLimited >= -tBV) {
            // cite: dioload.c:221-228: reverse sidewall (cubic approximation)
            const argsw3 = 3 * vtesw / (vdLimited * Math.E);
            const argsw = argsw3 * argsw3 * argsw3;
            cdsw = -csatsw * (1 + argsw);
            gdsw = csatsw * 3 * argsw / vdLimited;
          } else {
            // cite: dioload.c:229-234: sidewall breakdown
            const evrev = Math.exp(-(tBV + vdLimited) / vtebrk);
            cdsw = -csatsw * evrev;
            gdsw = csatsw * evrev / vtebrk;
          }
        }
        // else: cite: dioload.c:237-240: merge into csat (handled below via cdb path)
      }

      // dioload.c:245-265: three-region I-V computation (bottom current, no evd clamp).
      // D-W3-6: when NSW===N (no own emission coeff), csatsw merges into csat via
      // dioload.c:239: `csat = csat + csatsw`. computeDiodeIV receives the merged csat.
      const mergedCsat = (csatsw > 0 && params.NSW === params.N) ? tIS + csatsw : tIS;
      const { id: cdb, gd: gdb } = computeDiodeIV(vdLimited, mergedCsat, nVt, tBV, vtebrk);

      // cite: dioload.c:287-288: cd = cdb + cdsw; gd = gdb + gdsw
      // Tunnel current contributions (dioload.c:267-285) hoisted to diodeLoadTunnel
      // and consumed by tunnel-diode.ts. Plain-Diode load path is tunnel-free.
      let cd = cdb + cdsw;
      let gd = gdb + gdsw;

      // D-W3-1/D-W3-2: IKF/IKR Norton-pair re-derivation  dioload.c:290-314.
      // cite: dioload.c:290 `if (vd >= -3*vte)`  forward region
      if (vdLimited >= -3 * nVt) {
        if (params.IKF > 0 && isFinite(params.IKF) && cd > 1e-18) {
          // cite: dioload.c:292-300: IKF high-injection Norton pair
          const ikf_area_m = params.IKF;
          const sqrt_ikf = Math.sqrt(cd / ikf_area_m);
          gd = ((1 + sqrt_ikf) * gd - cd * gd / (2 * sqrt_ikf * ikf_area_m)) /
               (1 + 2 * sqrt_ikf + cd / ikf_area_m) + ctx.cktGmin;
          cd = cd / (1 + sqrt_ikf) + ctx.cktGmin * vdLimited;
        } else {
          // cite: dioload.c:298-299
          gd = gd + ctx.cktGmin;
          cd = cd + ctx.cktGmin * vdLimited;
        }
      } else {
        // cite: dioload.c:302  reverse region
        if (params.IKR > 0 && isFinite(params.IKR) && cd < -1e-18) {
          // cite: dioload.c:304-312: IKR high-injection Norton pair
          const ikr_area_m = params.IKR;
          const sqrt_ikr = Math.sqrt(cd / (-ikr_area_m));
          gd = ((1 + sqrt_ikr) * gd + cd * gd / (2 * sqrt_ikr * ikr_area_m)) /
               (1 + 2 * sqrt_ikr - cd / ikr_area_m) + ctx.cktGmin;
          cd = cd / (1 + sqrt_ikr) + ctx.cktGmin * vdLimited;
        } else {
          // cite: dioload.c:310-311
          gd = gd + ctx.cktGmin;
          cd = cd + ctx.cktGmin * vdLimited;
        }
      }

      // cd and gd are now the GMIN-adjusted Norton pair (mirrors ngspice state0 writes
      // at dioload.c:417-419: DIOvoltage=vd, DIOcurrent=cd, DIOconduct=gd).
      // cite: dioload.c:417: `*(ckt->CKTstate0 + here->DIOcurrent) = cd`

      s0[base + SLOT_ID] = cd;
      s0[base + SLOT_GEQ] = gd;
      // ngspice has no DIOieq slot — companion Norton current is computed
      // inline as `cdeq = cd - gd*vd` at the stamp call site (dioload.c
      // pattern). Stamp uses `ieq` as a function-local below.
      const ieq = cd - gd * vdLimited;

      const solver = ctx.solver;

      // dioload.c:435: DIOposPosPtr += gspr (series resistance conductance)
      // Stamps through pre-allocated handles from setup()
      if (params.RS > 0 && _posPrimeNode !== nodeAnode) {
        const gRS = 1 / params.RS;
        solver.stampElement(_hPosPos, gRS);
        solver.stampElement(_hPosPP,  -gRS);
        solver.stampElement(_hPPPos,  -gRS);
        solver.stampElement(_hPPPP,   gRS);
      }

      // dioload.c:429-441: load current vector + junction conductance stamps.
      solver.stampElement(_hPPPP,   gd);
      solver.stampElement(_hPPNeg,  -gd);
      solver.stampElement(_hNegPP,  -gd);
      solver.stampElement(_hNegNeg, gd);
      stampRHS(ctx.rhs, nodeJunction, -ieq);
      stampRHS(ctx.rhs, nodeCathode, ieq);

      // dioload.c:316-317: capacitance gated on
      //   (MODETRAN | MODEAC | MODEINITSMSIG) || ((MODETRANOP) && (MODEUIC))
      const capGate =
        (mode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 ||
        ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);
      if (hasCapacitance && capGate) {
        const order = ctx.order;
        const method = ctx.method;

        // dioload.c:321-355: depletion + diffusion cap + total charge.
        // cite: dioload.c:351: diffcap = TT * gdb  (pre-IKF gd from bottom current alone)
        // We use gd (full GMIN-adjusted gd including sidewall) to match ngspice:
        //   diffcap = TT * gdb (bottom) + TT * gdsw (sidewall) per dioload.c:352
        const Cj = computeJunctionCapacitance(vdLimited, tCJO, tVJ, params.M, tDepCap, tF2, tF3);
        const Ct = params.TT * gd;  // dioload.c:351-352: diffcap + diffcapSW
        const Ctotal = Cj + Ct;

        // cite: dioload.c:346: diffcharge = TT * cdb (bottom current, pre-GMIN-adj)
        // Pass cd (GMIN-adjusted) — consistent with ngspice storing GMIN-adjusted pair.
        const q0 = computeJunctionCharge(vdLimited, tCJO, tVJ, params.M, tDepCap, tF1, tF2, tF3, params.TT, cd);
        let q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const q3 = s3[base + SLOT_Q];

        if (mode & MODEINITTRAN) {
          // dioload.c:391-393: MODEINITTRAN copies q0q1 so first-step history matches
          s1[base + SLOT_Q] = q0;
          q1 = q0;
        }

        // dioload.c:395: NIintegrate via shared helper (niinteg.c:17-80).
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
        // D-W3-4: SLOT_V write removed  vestigial, zero reads outside load().
        s0[base + SLOT_Q] = q0;
        s0[base + SLOT_CCAP] = ccap;

        if (mode & MODEINITTRAN) {
          // dioload.c:399-402: MODEINITTRAN copies ccap0ccap1
          s1[base + SLOT_CCAP] = ccap;
        }

        // dioload.c:360-374: small-signal store-back, gated on MODEINITSMSIG
        // and NOT (MODETRANOP && MODEUIC). D2  MODEINITSMSIG body.
        if ((mode & MODEINITSMSIG) &&
            !((mode & MODETRANOP) && (mode & MODEUIC))) {
          // dioload.c:363: *(CKTstate0 + DIOcapCurrent) = capd (Farads)
          s0[base + SLOT_CCAP] = Ctotal;
          // dioload.c:374: continue  skip matrix/RHS cap companion stamp.
          return;
        }

        // dioload.c:397-398: MODETRAN path  gd += geq, cd += ccap. We
        // mirror by stamping the capacitance companion below. SLOT_CCAP
        // stores iqcap (Amps) per dioload.c DIOcapCurrent semantics.
        s0[base + SLOT_CCAP] = ccap;

        if (capGeq !== 0 || capIeq !== 0) {
          solver.stampElement(_hPPPP,   capGeq);
          solver.stampElement(_hPPNeg,  -capGeq);
          solver.stampElement(_hNegPP,  -capGeq);
          solver.stampElement(_hNegNeg, capGeq);
          stampRHS(ctx.rhs, nodeJunction, -capIeq);
          stampRHS(ctx.rhs, nodeCathode, capIeq);
        }
      }
    }

    checkConvergence(ctx: LoadContext): boolean {
      const pool = this._pool;
      const base = this._stateBase;
      const s0 = pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      // dioload.c:411-416: CKTnoncon bump on pnjlim  non-convergence
      if (pnjlimLimited) return false;

      const voltages = ctx.rhsOld;
      const va = voltages[_posPrimeNode];
      const vc = voltages[nodeCathode];
      const vdRaw = va - vc;

      // dioconv.c: DIOconvTest  current-prediction convergence
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = this._pool.states[0][this._stateBase + SLOT_ID];
      return [id, -id];
    }

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      if (!hasCapacitance) return Infinity;
      const pool = this._pool;
      const base = this._stateBase;
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];
      const _q0 = s0[base + SLOT_Q];
      const _q1 = s1[base + SLOT_Q];
      const _q2 = s2[base + SLOT_Q];
      const _q3 = s3[base + SLOT_Q];
      const ccap0 = s0[base + SLOT_CCAP];
      const ccap1 = s1[base + SLOT_CCAP];
      return cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
    }

    /**
     * computeTemperature — engine-driven temperature pass per ckttemp.c:28-33.
     *
     * Resolves effective operating temperature T:
     *   - Per-instance TEMP override (params.TEMP) takes precedence.
     *   - Falls back to ctx.cktTemp (circuit ambient temperature) when
     *     params.TEMP equals the construction default (REFTEMP = 300.15 K).
     *
     * cite: diotemp.c:82-86 —
     *   if(!here->DIOtempGiven) here->DIOtemp = ckt->CKTtemp + here->DIOdtemp;
     *   (when DIOtempGiven is false, use CKTtemp; otherwise use DIOtemp)
     *
     * Updates all temperature-derived state in-place (matching DIOtemp() output):
     *   tIS, tSatSWCur, tVJ, tJctSWPot, tCJO, tJctSWCap, tVcrit, tBV,
     *   tF1, tF2, tF3, tDepCap, vt, nVt.
     */
    computeTemperature(ctx: TempContext): void {
      // cite: diotemp.c:84-85 — DIOtempGiven ? DIOtemp : CKTtemp + DIOdtemp
      const T = _tempGiven ? params.TEMP : ctx.cktTemp;
      applyDioTempResult(dioTemp({
        IS: params.IS, N: params.N, VJ: params.VJ, CJO: params.CJO, M: params.M,
        BV: params.BV, IBV: params.IBV, NBV: params.NBV, EG: params.EG,
        XTI: params.XTI, TNOM: params.TNOM,
        ISW: params.ISW, NSW: params.NSW, FC: params.FC,
      }, T));
    }

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        if (key === "TEMP") {
          _tempGiven = true;
          // cite: diotemp.c:82-87 — per-instance TEMP triggers DIOtemp() recompute.
          // Route through computeTemperature so the engine dispatch path and the
          // hot-load path share identical logic.
          this.computeTemperature({ cktTemp: value, cktNomTemp: params.TNOM });
        } else {
          // All other param changes also require a temperature recompute because
          // IS, VJ, CJO, EG, XTI, etc. feed directly into the dioTemp() formulas.
          this.computeTemperature({ cktTemp: params.TEMP, cktNomTemp: params.TNOM });
        }
      }
    }
  }

  return new DiodeAnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// getDiodeInternalNodeLabels  mirror of getDiodeInternalNodeCount's predicate
// ---------------------------------------------------------------------------

/**
 * Returns internal node labels for a diode instance.
 *
 * When RS > 0 we allocate a single internal anode-prime node between the
 * external anode pin and the junction ("internal").
 */
export function getDiodeInternalNodeLabels(props: PropertyBag): readonly string[] {
  return props.getModelParam<number>("RS") > 0 ? ["internal"] : [];
}

// ---------------------------------------------------------------------------
// DiodeElement  CircuitElement implementation
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

    // Triangle body pointing right (anode left, cathode right)  body stays COMPONENT
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

export const DiodeDefinition: StandaloneComponentDefinition = {
  name: "Diode",
  typeId: -1,
  factory: diodeCircuitFactory,
  pinLayout: buildDiodePinDeclarations(),
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diode  Shockley equation with NR linearization.\n" +
    "Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
    "Model parameters: IS, N, CJO, VJ, M, TT, FC.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
