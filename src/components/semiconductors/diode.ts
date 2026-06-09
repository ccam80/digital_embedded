/**
 * Diode analog component — Shockley junction model with NR linearization,
 * self-heating, recombination, tunneling, sidewall and level=3 parasitic
 * geometry, matching ngspice's DIO device (diotemp.c / diosetup.c / dioload.c /
 * dioacld.c / dioconv.c).
 *
 * The DC junction current is the three-region Shockley form
 *   Id = IS*(exp(Vd/(N*Vt)) - 1)        (forward / reverse / breakdown arms),
 * linearized each NR iteration into a parallel conductance gd and a Norton
 * current source. DEVpnjlim() damps the junction-voltage step; DEVlimitlog()
 * damps the self-heating temperature step.
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
  type ParamDef,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
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
  MODEDCTRANCURVE,
} from "../../solver/analog/ckt-mode.js";
import { pnjlim, limitlog } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { defineModelParams, kelvinToCelsius, meterToAngstrom, type ParamSpec } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import {
  CONSTboltz,
  CHARGE,
  CONSTKoverQ,
  REFTEMP,
  CONSTepsSiO2,
} from "../../core/constants.js";

// ---------------------------------------------------------------------------
// State schema — diodefs.h:196-208, DIOnumStates = 9
// ---------------------------------------------------------------------------

export const DIODE_SCHEMA: StateSchema = defineStateSchema("DiodeElement", [
  { name: "VD",   doc: "pnjlim-limited junction voltage — diodefs.h:196 DIOvoltage (DIOstate+0)" },
  { name: "ID",   doc: "Diode current at operating point — diodefs.h:197 DIOcurrent (DIOstate+1)" },
  { name: "GEQ",  doc: "NR companion conductance — diodefs.h:198 DIOconduct (DIOstate+2)" },
  { name: "Q",    doc: "Junction charge — diodefs.h:199 DIOcapCharge (DIOstate+3)" },
  { name: "CAP_CURRENT", doc: "NIintegrate companion current iqcap / capd (MODEINITSMSIG) — diodefs.h:200 DIOcapCurrent (DIOstate+4)" },
  { name: "QTH",     doc: "Thermal-cap charge cth0*delTemp — diodefs.h:202 DIOqth (DIOstate+5)" },
  { name: "CQTH",    doc: "Thermal-cap NIintegrate companion current — diodefs.h:203 DIOcqth (DIOstate+6)" },
  { name: "DELTEMP", doc: "Temperature delta = Tj node voltage over rth0 — diodefs.h:205 DIOdeltemp (DIOstate+7)" },
  { name: "DIDIO_DT", doc: "dI_diode/dT, used by predictor + convergence — diodefs.h:206 DIOdIdio_dT (DIOstate+8)" },
]);

const SLOT_VD       = 0;
const SLOT_ID       = 1;
const SLOT_GEQ      = 2;
const SLOT_Q        = 3;
const SLOT_CCAP     = 4;
const SLOT_QTH      = 5;
const SLOT_CQTH     = 6;
const SLOT_DELTEMP  = 7;
const SLOT_DIDIO_DT = 8;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

const DIODE_PARAM_SPEC = {
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
    TNOM: { default: REFTEMP, unit: "K", description: "Parameter measurement temperature", spiceConverter: kelvinToCelsius },
    // dio.c:51 (DIO_MOD_JSW) — sidewall saturation current.
    ISW:   { default: 0,    unit: "A",  spiceName: "JSW", description: "Sidewall saturation current (DIOsatSWCur)" },
    NSW:   { default: NaN,             spiceName: "ns", description: "Sidewall emission coefficient (DIOswEmissionCoeff; dio.c:60; default=N)" },
    // diosetup.c:107-145 — temperature-coefficient selectors and coefficients.
    TLEV:  { default: 0,    spiceName: "tlev",  description: "Diode temperature equation selector (diosetup.c:107)" },
    TLEVC: { default: 0,    spiceName: "tlevc", description: "Capacitance temperature equation selector (diosetup.c:110)" },
    TM1:   { default: 0,    spiceName: "tm1",   description: "Grading coefficient 1st order temp. coeff. (diosetup.c:59)" },
    TM2:   { default: 0,    spiceName: "tm2",   description: "Grading coefficient 2nd order temp. coeff. (diosetup.c:62)" },
    TTT1:  { default: 0,    spiceName: "ttt1",  description: "Transit time 1st order temp. coeff. (diosetup.c:74)" },
    TTT2:  { default: 0,    spiceName: "ttt2",  description: "Transit time 2nd order temp. coeff. (diosetup.c:77)" },
    TRS:   { default: 0,    spiceName: "trs",   description: "Series resistance 1st order temp. coeff. (diosetup.c:137)" },
    TRS2:  { default: 0,    spiceName: "trs2",  description: "Series resistance 2nd order temp. coeff. (diosetup.c:140)" },
    CTA:   { default: 0,    spiceName: "cta",   description: "Area junction capacitance temp. coeff. (diosetup.c:119)" },
    CTP:   { default: 0,    spiceName: "ctp",   description: "Perimeter junction capacitance temp. coeff. (diosetup.c:122)" },
    TPB:   { default: 0,    spiceName: "tpb",   description: "Area junction potential temp. coeff. (diosetup.c:125)" },
    TPHP:  { default: 0,    spiceName: "tphp",  description: "Perimeter junction potential temp. coeff. (diosetup.c:128)" },
    TCV:   { default: 0,    spiceName: "tcv",   description: "Reverse breakdown voltage temp. coeff. (diosetup.c:143)" },
    JTUN:  { default: 0,    unit: "A", spiceName: "jtun",   description: "Tunneling saturation current (diosetup.c:152)" },
    JTUNSW:{ default: 0,    unit: "A", spiceName: "jtunsw", description: "Tunneling sidewall saturation current (diosetup.c:155)" },
    NTUN:  { default: 30,   spiceName: "ntun",   description: "Tunneling emission coefficient (diosetup.c:158)" },
    XTITUN:{ default: 3,    spiceName: "xtitun", description: "Tunneling saturation current exponential (diosetup.c:161)" },
    KEG:   { default: 1,    spiceName: "keg",    description: "EG correction factor for tunneling (diosetup.c:164)" },
    FCS:   { default: 0.5,  spiceName: "fcs",    description: "Forward-bias sidewall capacitance coefficient (diosetup.c:68)" },
    CJSW:  { default: 0,    unit: "F", spiceName: "cjp", description: "Sidewall zero-bias junction capacitance (diosetup.c:83)" },
    VJSW:  { default: 1,    unit: "V", spiceName: "php", description: "Sidewall junction potential (diosetup.c:86)" },
    MJSW:  { default: 0.33, spiceName: "mjsw",   description: "Sidewall grading coefficient (diosetup.c:89)" },
    // dio.c:111-112 (DIO_MOD_ISR/NR) — recombination current. diosetup.c:182-187.
    ISR:   { default: 1e-14, unit: "A", spiceName: "isr", description: "Recombination saturation current (diosetup.c:185)" },
    NR:    { default: 2,    spiceName: "nr",   description: "Recombination current emission coefficient (diosetup.c:182)" },
    // dio.c:115-119 (DIO_MOD_FV_MAX..PD_MAX) — safe-operating-area limits read by
    // DIOsoaCheck; default 1e99 (diosetup.c:167-181).
    FV_MAX: { default: 1e99, unit: "V", spiceName: "fv_max", description: "Maximum voltage in forward direction (diosetup.c:168)" },
    BV_MAX: { default: 1e99, unit: "V", spiceName: "bv_max", description: "Maximum voltage in reverse direction (diosetup.c:171)" },
    ID_MAX: { default: 1e99, unit: "A", spiceName: "id_max", description: "Maximum current (diosetup.c:174)" },
    TE_MAX: { default: 1e99, unit: "K", spiceName: "te_max", description: "Maximum temperature (diosetup.c:180)" },
    PD_MAX: { default: 1e99, unit: "W", spiceName: "pd_max", description: "Maximum power dissipation (diosetup.c:177)" },
    // dio.c:122-123 (DIO_MOD_RTH0/CTH0) — self-heating thermal RC. diosetup.c:203-208.
    RTH0:  { default: 0,    unit: "K/W", spiceName: "rth0", description: "Self-heating thermal resistance (diosetup.c:204)" },
    CTH0:  { default: 1e-5, unit: "J/K", spiceName: "cth0", description: "Self-heating thermal capacitance (diosetup.c:207)" },
    // dio.c:125-132 — level=3 parasitic metal/poly overlap geometry.
    LM:    { default: 0,    unit: "m", spiceName: "lm",  description: "Length of metal capacitor, level=3 (diosetup.c:210)" },
    LP:    { default: 0,    unit: "m", spiceName: "lp",  description: "Length of poly capacitor, level=3 (diosetup.c:213)" },
    WM:    { default: 0,    unit: "m", spiceName: "wm",  description: "Width of metal capacitor, level=3 (diosetup.c:216)" },
    WP:    { default: 0,    unit: "m", spiceName: "wp",  description: "Width of poly capacitor, level=3 (diosetup.c:219)" },
    // diompar.c:257-264 — DIOmParam scales the netlisted XOM/XOI by 1e-10 into
    // metres; the meterToAngstrom emit converter is the inverse so the harness
    // round-trip recovers the same metre value digiTS holds internally.
    XOM:   { default: 1e-6, unit: "m", spiceName: "xom", spiceConverter: meterToAngstrom, description: "Metal-to-bulk oxide thickness, level=3 (diosetup.c:222)" },
    XOI:   { default: 1e-6, unit: "m", spiceName: "xoi", spiceConverter: meterToAngstrom, description: "Poly-to-bulk oxide thickness, level=3 (diosetup.c:225)" },
    XM:    { default: 0,    unit: "m", spiceName: "xm",  description: "Metal mask/etch offset, level=3 (diosetup.c:228)" },
    XP:    { default: 0,    unit: "m", spiceName: "xp",  description: "Poly mask/etch offset, level=3 (diosetup.c:231)" },
    // dio.c:48 (DIO_MOD_LEVEL) — diode level selector (1 = standard, 3 = geometry).
    LEVEL: { default: 1,    spiceName: "level", description: "Diode level selector (diosetup.c:35)" },
  },
  instance: {
    AREA: { default: 1,               description: "Area scaling factor" },
    OFF: { default: 0, emit: "flag",  description: "Initial condition: device off (0=false, 1=true)" },
    IC:  { default: NaN,   unit: "V",  description: "Initial condition: junction voltage for UIC" },
    TEMP:  { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
    // dioparam.c:35-46 — per-instance geometry overrides.
    PJ:  { default: 0,     unit: "m", spiceName: "pj", description: "Perimeter factor (dio.c:18)" },
    W:   { default: 0,     unit: "m", spiceName: "w",  description: "Diode width (dio.c:19)" },
    L:   { default: 0,     unit: "m", spiceName: "l",  description: "Diode length (dio.c:20)" },
    // dio.c:21 (DIO_M) — instance multiplier. ngspice keeps it separate from the
    // model grading coeff (DIO_MOD_M); in digiTS's single param store the key is
    // MMULT to avoid colliding with the grading-coefficient param `M`.
    MMULT: { default: 1,              spiceName: "m",  description: "Device multiplier (dio.c:21)" },
    // dio.c:26 (DIO_THERMAL, IF_FLAG) — per-instance self-heating mode selector.
    THERMAL: { default: 0, emit: "flag", spiceName: "thermal", description: "Self-heating mode (0=off, 1=on)" },
  },
} satisfies Parameters<typeof defineModelParams>[0];

export const { paramDefs: DIODE_PARAM_DEFS, defaults: DIODE_PARAM_DEFAULTS } =
  defineModelParams(DIODE_PARAM_SPEC);

/**
 * Build a diode-variant param schema (schottky / varactor / …). Starts from the
 * full DIODE_PARAM_SPEC so the variant's property bag carries every diode param
 * through the standard compiler merge, then applies per-key overrides (variant
 * default values / metadata). createDiodeElement reads every param directly with
 * no per-key default lookup. Deck emission is unaffected: a variant default is
 * a paramDef default (not user-given), and modelCardSuffix emits only given
 * params, so the generated ngspice .model card is identical.
 */
export function defineDiodeVariant(overrides: {
  primary?: Record<string, Partial<ParamSpec>>;
  secondary?: Record<string, Partial<ParamSpec>>;
  instance?: Record<string, Partial<ParamSpec>>;
}): { paramDefs: ParamDef[]; defaults: Record<string, number> } {
  const merge = (
    base: Record<string, ParamSpec>,
    ov: Record<string, Partial<ParamSpec>> | undefined,
  ): Record<string, ParamSpec> => {
    if (!ov) return base;
    const out: Record<string, ParamSpec> = {};
    for (const [k, spec] of Object.entries(base)) out[k] = ov[k] ? { ...spec, ...ov[k] } : spec;
    return out;
  };
  return defineModelParams({
    primary: merge(DIODE_PARAM_SPEC.primary, overrides.primary),
    secondary: merge(DIODE_PARAM_SPEC.secondary, overrides.secondary),
    instance: merge(DIODE_PARAM_SPEC.instance, overrides.instance),
  });
}

// ---------------------------------------------------------------------------
// computeJunctionCapacitance — depletion-cap small-signal capacitance
// ---------------------------------------------------------------------------

/**
 * Junction depletion capacitance, matching dioload.c:425-435.
 *   reverse (vd < tDepCap): deplcap = czero * (1 - vd/tVJ)^(-M)
 *   forward (vd >= tDepCap): deplcap = czof2 * (tF3 + M*vd/tVJ)
 * The grading coefficient `M` here is the temperature-adjusted DIOtGradingCoeff.
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
    // dioload.c:426-429: sarg = exp(-M*log(arg)); deplcap = czero*sarg.
    const arg = 1 - vd / tVJ;
    const sarg = Math.exp(-M * Math.log(arg));
    return tCJO * sarg;
  } else {
    // dioload.c:431-434: czof2 = czero/tF2; deplcap = czof2*(tF3 + M*vd/tVJ).
    return (tCJO / tF2) * (tF3 + (M * vd) / tVJ);
  }
}

// ---------------------------------------------------------------------------
// computeJunctionCharge — integral of C(V) dV plus diffusion charge
// ---------------------------------------------------------------------------

/**
 * Total junction charge, matching dioload.c:425-451.
 *   reverse: deplcharge = tVJ*czero*(1 - arg*sarg)/(1-M), arg = 1-vd/tVJ,
 *            sarg = arg^(-M) so arg*sarg = (1-vd/tVJ)^(1-M)
 *   forward: deplcharge = czero*tF1 + czof2*(tF3*(vd-tDepCap)
 *            + M/(2*tVJ)*(vd^2 - tDepCap^2))
 *   diffusion: diffcharge = tTransitTime * Id (dioload.c:449)
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
      // dioload.c:426-428: reverse-bias depletion charge.
      const arg = 1 - vd / tVJ;
      const sarg = Math.exp(-M * Math.log(arg));
      Q_depl = tVJ * tCJO * (1 - arg * sarg) / (1 - M);
    } else {
      // dioload.c:431-433: forward-bias linearized depletion charge.
      const czof2 = tCJO / tF2;
      Q_depl = tCJO * tF1 + czof2 * (tF3 * (vd - tDepCap) + (M / (tVJ + tVJ)) * (vd * vd - tDepCap * tDepCap));
    }
  }
  // dioload.c:449: diffusion charge = TT * Id.
  const Q_diff = TT * Id;
  return Q_depl + Q_diff;
}

// ---------------------------------------------------------------------------
// DioTempParams — result of dioTemp() (DIOtempUpdate)
// ---------------------------------------------------------------------------

export interface DioTempParams {
  /** kT/q at the evaluation temperature. */
  vt: number;
  /** kT/q at TNOM (diotemp.c:46 vtnom). */
  vtnom: number;
  /** DIOtSatCur — diotemp.c:116. */
  tIS: number;
  /** DIOtSatCur_dT — diotemp.c:117. */
  tIS_dT: number;
  /** DIOtSatSWCur — diotemp.c:124. */
  tSatSWCur: number;
  /** DIOtSatSWCur_dT — diotemp.c:125. */
  tSatSWCur_dT: number;
  /** DIOtTunSatCur — diotemp.c:132. */
  tTunSatCur: number;
  /** DIOtTunSatCur_dT — diotemp.c:133. */
  tTunSatCur_dT: number;
  /** DIOtTunSatSWCur — diotemp.c:140. */
  tTunSatSWCur: number;
  /** DIOtTunSatSWCur_dT — diotemp.c:141. */
  tTunSatSWCur_dT: number;
  /** DIOtRecSatCur — diotemp.c:148. */
  tRecSatCur: number;
  /** DIOtRecSatCur_dT — diotemp.c:149. */
  tRecSatCur_dT: number;
  /** DIOtJctPot — diotemp.c:85 / 90. */
  tVJ: number;
  /** DIOtJctSWPot — diotemp.c:101 / 106. */
  tJctSWPot: number;
  /** DIOtJctCap — diotemp.c:82 / 91. */
  tCJO: number;
  /** DIOtJctSWCap — diotemp.c:98 / 107. */
  tJctSWCap: number;
  /** DIOtVcrit — diotemp.c:167. */
  tVcrit: number;
  /** DIOtBrkdwnV — diotemp.c:223. */
  tBV: number;
  /** DIOtGradingCoeff — diotemp.c:52,57-61. */
  tGradingCoeff: number;
  /** DIOtTransitTime — diotemp.c:229. */
  tTransitTime: number;
  /** DIOtConductance — diotemp.c:232,236 (area-folded, TRS/TRS2-adjusted). */
  tConductance: number;
  /** DIOtConductance_dT — diotemp.c:237-238. */
  tConductance_dT: number;
  /** DIOtF1 — diotemp.c:156-158. */
  tF1: number;
  /** DIOtF2 — diotemp.c:241. */
  tF2: number;
  /** DIOtF3 — diotemp.c:242-243. */
  tF3: number;
  /** DIOtF2SW — diotemp.c:244. */
  tF2SW: number;
  /** DIOtF3SW — diotemp.c:245-246. */
  tF3SW: number;
  /** DIOtDepCap — diotemp.c:160-161. */
  tDepCap: number;
  /** DIOtDepSWCap — diotemp.c:162-163. */
  tDepSWCap: number;
}

/** Geometry-resolved per-instance scaling fed into dioTemp (diosetup.c). */
export interface DioGeom {
  /** here->DIOarea (area-folded, m-folded, level-3 scaled) — diosetup.c:257,264,267. */
  area: number;
  /** here->DIOpj (perimeter, m-folded, level-3 scaled) — diosetup.c:258,265,268. */
  pj: number;
  /** here->DIOm (device multiplier) — diosetup.c:253-255. */
  m: number;
}

/** Model-parameter inputs to dioTemp — the merged param store. */
export interface DioTempInput {
  IS: number; N: number; VJ: number; CJO: number; M: number;
  BV: number; IBV: number; NBV: number; EG: number; XTI: number; TNOM: number;
  ISW: number; NSW: number; FC: number; FCS: number;
  CJSW: number; VJSW: number; MJSW: number;
  TLEV: number; TLEVC: number; TM1: number; TM2: number; TTT1: number; TTT2: number;
  TRS: number; TRS2: number; CTA: number; CTP: number; TPB: number; TPHP: number; TCV: number;
  JTUN: number; JTUNSW: number; NTUN: number; XTITUN: number; KEG: number;
  ISR: number; NR: number; TT: number; RS: number; LEVEL: number;
}

// ---------------------------------------------------------------------------
// dioTemp — port of DIOtempUpdate (diotemp.c:18-247)
// ---------------------------------------------------------------------------

/**
 * Compute every temperature-adjusted diode quantity at explicit temperature T,
 * matching ngspice DIOtempUpdate (diotemp.c:18-247). `geom.area` / `geom.pj`
 * are the geometry-resolved area/perimeter (diosetup.c); `geom.m` is the device
 * multiplier (used for the level-1 breakdown-current selection, diotemp.c:195).
 * `reltol` is CKTreltol, read by the breakdown match (diotemp.c:208).
 */
export function dioTemp(p: DioTempInput, T: number, geom: DioGeom, reltol: number): DioTempParams {
  // diotemp.c:38-39 — grading-coeff ceiling; cp_getvar default 0.9.
  const gclimit = 0.9;

  // diotemp.c:41-47 — emission-weighted thermal voltages and dt.
  const vt = CONSTKoverQ * T;
  const vte = p.N * vt;
  const vts = p.NSW * vt;
  const vtt = p.NTUN * vt;
  const vtr = p.NR * vt;
  const vtnom = CONSTKoverQ * p.TNOM;
  const dt = T - p.TNOM;

  // diotemp.c:50-52 — junction grading temperature adjust (TM1/TM2).
  let factor = 1.0 + (p.TM1 * dt) + (p.TM2 * dt * dt);
  let tGradingCoeff = p.M * factor;
  // diotemp.c:57-62 — limit to gclimit (front-end warning suppressed).
  if (tGradingCoeff > gclimit) {
    tGradingCoeff = gclimit;
  }

  // diotemp.c:66-77 — egfet / pbfact at T and at TNOM.
  const fact2 = T / REFTEMP;
  const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
  const arg = -egfet / (2 * CONSTboltz * T) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1c = -egfet1 / (CONSTboltz * 2 * p.TNOM) + 1.1150877 / (2 * CONSTboltz * REFTEMP);
  const fact1 = p.TNOM / REFTEMP;
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1c);

  // diotemp.c:82-93 — junction potential + capacitance, tlevc branch.
  // here->DIOjunctionCap = model->DIOjunctionCap * here->DIOarea (diosetup.c:294).
  const junctionCap = p.CJO * geom.area;
  let tVJ: number;
  let tCJO: number;
  if (p.TLEVC === 0) {
    const pbo = (p.VJ - pbfact1) / fact1;
    const gmaold = (p.VJ - pbo) / pbo;
    tCJO = junctionCap / (1 + tGradingCoeff * (400e-6 * (p.TNOM - REFTEMP) - gmaold));
    tVJ = pbfact + fact2 * pbo;
    const gmanew = (tVJ - pbo) / pbo;
    tCJO *= 1 + tGradingCoeff * (400e-6 * (T - REFTEMP) - gmanew);
  } else {
    tVJ = p.VJ - p.TPB * (T - REFTEMP);
    tCJO = junctionCap * (1 + p.CTA * (T - REFTEMP));
  }

  // diotemp.c:95-109 — sidewall potential + capacitance, tlevc branch.
  // here->DIOjunctionSWCap = model->DIOjunctionSWCap * here->DIOpj (diosetup.c:295).
  const junctionSWCap = p.CJSW * geom.pj;
  let tJctSWPot: number;
  let tJctSWCap: number;
  if (p.TLEVC === 0) {
    const pboSW = (p.VJSW - pbfact1) / fact1;
    const gmaSWold = (p.VJSW - pboSW) / pboSW;
    tJctSWCap = junctionSWCap / (1 + p.MJSW * (400e-6 * (p.TNOM - REFTEMP) - gmaSWold));
    tJctSWPot = pbfact + fact2 * pboSW;
    const gmaSWnew = (tJctSWPot - pboSW) / pboSW;
    tJctSWCap *= 1 + p.MJSW * (400e-6 * (T - REFTEMP) - gmaSWnew);
  } else {
    tJctSWPot = p.VJSW - p.TPHP * (T - REFTEMP);
    tJctSWCap = junctionSWCap * (1 + p.CTP * (T - REFTEMP));
  }

  // diotemp.c:111-117 — bottom saturation current + dT; area folded in.
  let a1 = ((T / p.TNOM) - 1) * p.EG / vte;
  let a1dt = p.EG / (vte * p.TNOM) - p.EG * (T / p.TNOM - 1) / (vte * T);
  let a2 = p.XTI / p.N * Math.log(T / p.TNOM);
  let a2dt = p.XTI / p.N / T;
  const tIS = p.IS * geom.area * Math.exp(a1 + a2);
  const tIS_dT = p.IS * geom.area * Math.exp(a1 + a2) * (a1dt + a2dt);

  // diotemp.c:119-125 — sidewall saturation current + dT; perimeter folded in.
  a1 = ((T / p.TNOM) - 1) * p.EG / vts;
  a1dt = p.EG / (vts * p.TNOM) - p.EG * (T / p.TNOM - 1) / (vts * T);
  a2 = p.XTI / p.NSW * Math.log(T / p.TNOM);
  a2dt = p.XTI / p.NSW / T;
  const tSatSWCur = p.ISW * geom.pj * Math.exp(a1 + a2);
  const tSatSWCur_dT = p.ISW * geom.pj * Math.exp(a1 + a2) * (a1dt + a2dt);

  // diotemp.c:127-133 — tunneling bottom current + dT; KEG*EG numerator.
  a1 = ((T / p.TNOM) - 1) * p.KEG * p.EG / vtt;
  a1dt = p.KEG * p.EG / (vtt * p.TNOM) - p.EG * (T / p.TNOM - 1) / (vtt * T);
  a2 = p.XTITUN / p.NTUN * Math.log(T / p.TNOM);
  a2dt = p.XTITUN / p.NTUN / T;
  const tTunSatCur = p.JTUN * geom.area * Math.exp(a1 + a2);
  const tTunSatCur_dT = p.JTUN * geom.area * Math.exp(a1 + a2) * (a1dt + a2dt);

  // diotemp.c:135-141 — tunneling sidewall current + dT.
  a1 = ((T / p.TNOM) - 1) * p.KEG * p.EG / vtt;
  a1dt = p.KEG * p.EG / (vtt * p.TNOM) - p.EG * (T / p.TNOM - 1) / (vtt * T);
  a2 = p.XTITUN / p.NTUN * Math.log(T / p.TNOM);
  a2dt = p.XTITUN / p.NTUN / T;
  const tTunSatSWCur = p.JTUNSW * geom.pj * Math.exp(a1 + a2);
  const tTunSatSWCur_dT = p.JTUNSW * geom.pj * Math.exp(a1 + a2) * (a1dt + a2dt);

  // diotemp.c:143-149 — recombination saturation current + dT.
  a1 = ((T / p.TNOM) - 1) * p.EG / vtr;
  a1dt = p.EG / (vtr * p.TNOM) - p.EG * (T / p.TNOM - 1) / (vtr * T);
  a2 = p.XTI / p.NR * Math.log(T / p.TNOM);
  a2dt = p.XTI / p.NR / T;
  const tRecSatCur = p.ISR * geom.area * Math.exp(a1 + a2);
  const tRecSatCur_dT = p.ISR * geom.area * Math.exp(a1 + a2) * (a1dt + a2dt);

  // diotemp.c:151-167 — xfc/xfcs, F1, depletion thresholds, Vcrit.
  const xfc = Math.log(1 - p.FC);
  const xfcs = Math.log(1 - p.FCS);
  const tF1 = tVJ * (1 - Math.exp((1 - tGradingCoeff) * xfc)) / (1 - tGradingCoeff);
  let tDepCap = p.FC * tVJ;
  let tDepSWCap = p.FCS * tJctSWPot;
  const vteVc = p.N * vt;
  const tVcrit = vteVc * Math.log(vteVc / (Math.SQRT2 * tIS));

  // diotemp.c:170-184 — clamp junction potentials to 1/FC and 1/FCS.
  if (tDepCap > 1.0) {
    tVJ = 1.0 / p.FC;
    tDepCap = p.FC * tVJ;
  }
  if (tDepSWCap > 1.0) {
    tJctSWPot = 1.0 / p.FCS;
    tDepSWCap = p.FCS * tJctSWPot;
  }

  // diotemp.c:186-224 — breakdown voltage temperature adjust + brkdEmissionCoeff match.
  let tBV = p.BV;
  if (isFinite(p.BV)) {
    const tBreakdownVoltage = p.TLEV === 0
      ? p.BV - p.TCV * dt
      : p.BV * (1 - p.TCV * dt);
    // diotemp.c:194-198 — level==1 uses m*IBV; level==3 uses IBV*area.
    const cbv = p.LEVEL === 1 ? geom.m * p.IBV : p.IBV * geom.area;
    if (cbv < tIS * tBreakdownVoltage / vt) {
      // diotemp.c:199-206 — cbv too small to resolve: take tBreakdownVoltage.
      tBV = tBreakdownVoltage;
    } else {
      const tol = reltol * cbv;
      let xbv = tBreakdownVoltage - p.NBV * vt * Math.log(1 + cbv / tIS);
      for (let iter = 0; iter < 25; iter++) {
        xbv = tBreakdownVoltage - p.NBV * vt * Math.log(cbv / tIS + 1 - xbv / vt);
        const xcbv = tIS * (Math.exp((tBreakdownVoltage - xbv) / (p.NBV * vt)) - 1 + xbv / vt);
        if (Math.abs(xcbv - cbv) <= tol) break;
      }
      tBV = xbv;
    }
  }

  // diotemp.c:226-229 — transit time temperature adjust (TTT1/TTT2).
  factor = 1.0 + (p.TTT1 * dt) + (p.TTT2 * dt * dt);
  const tTransitTime = p.TT * factor;

  // diotemp.c:231-239 — series-resistance conductance, area-folded + TRS adjust.
  // model->DIOconductance = (RS==0) ? 0 : 1/RS (diosetup.c:197-201).
  const conductance = p.RS === 0 ? 0 : 1 / p.RS;
  let tConductance = conductance * geom.area;
  let tConductance_dT = 0;
  if (p.RS !== 0) {
    factor = 1.0 + (p.TRS) * dt + (p.TRS2 * dt * dt);
    tConductance = conductance * geom.area / factor;
    tConductance_dT = -conductance * geom.area * (p.TRS + p.TRS2 * dt) / (factor * factor);
  }

  // diotemp.c:241-246 — F2/F3 and sidewall F2SW/F3SW.
  const tF2 = Math.exp((1 + tGradingCoeff) * xfc);
  const tF3 = 1 - p.FC * (1 + tGradingCoeff);
  const tF2SW = Math.exp((1 + p.MJSW) * xfcs);
  const tF3SW = 1 - p.FCS * (1 + p.MJSW);

  return {
    vt, vtnom,
    tIS, tIS_dT, tSatSWCur, tSatSWCur_dT,
    tTunSatCur, tTunSatCur_dT, tTunSatSWCur, tTunSatSWCur_dT,
    tRecSatCur, tRecSatCur_dT,
    tVJ, tJctSWPot, tCJO, tJctSWCap,
    tVcrit, tBV, tGradingCoeff, tTransitTime,
    tConductance, tConductance_dT,
    tF1, tF2, tF3, tF2SW, tF3SW, tDepCap, tDepSWCap,
  };
}

// ---------------------------------------------------------------------------
// createDiodeElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createDiodeElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  let nodeAnode = -1;
  let nodeCathode = -1;
  let nodeTemp = -1;

  // Every diode model param is declared in DIODE_PARAM_SPEC; variants
  // (schottky / varactor / …) extend that full schema via defineDiodeVariant, so
  // the unified compiler merge populates the bag with all of them. Read directly.
  const mp = (key: string): number => props.getModelParam<number>(key);

  const params: Record<string, number> = {
    IS:  mp("IS"),
    N:   mp("N"),
    RS:  mp("RS"),
    CJO: mp("CJO"),
    VJ:  mp("VJ"),
    M:   mp("M"),
    TT:  mp("TT"),
    FC:  mp("FC"),
    BV:  mp("BV"),
    IBV: mp("IBV"),
    NBV: mp("NBV"),
    IKF: mp("IKF"),
    IKR: mp("IKR"),
    EG:  mp("EG"),
    XTI: mp("XTI"),
    KF:  mp("KF"),
    AF:  mp("AF"),
    AREA: mp("AREA"),
    TNOM: mp("TNOM"),
    OFF:  mp("OFF"),
    IC:   mp("IC"),
    ISW:  mp("ISW"),
    NSW:  mp("NSW"),
    TEMP: mp("TEMP"),
    TLEV: mp("TLEV"),
    TLEVC: mp("TLEVC"),
    TM1: mp("TM1"),
    TM2: mp("TM2"),
    TTT1: mp("TTT1"),
    TTT2: mp("TTT2"),
    TRS: mp("TRS"),
    TRS2: mp("TRS2"),
    CTA: mp("CTA"),
    CTP: mp("CTP"),
    TPB: mp("TPB"),
    TPHP: mp("TPHP"),
    TCV: mp("TCV"),
    JTUN: mp("JTUN"),
    JTUNSW: mp("JTUNSW"),
    NTUN: mp("NTUN"),
    XTITUN: mp("XTITUN"),
    KEG: mp("KEG"),
    FCS: mp("FCS"),
    CJSW: mp("CJSW"),
    VJSW: mp("VJSW"),
    MJSW: mp("MJSW"),
    ISR: mp("ISR"),
    NR: mp("NR"),
    RTH0: mp("RTH0"),
    CTH0: mp("CTH0"),
    LM: mp("LM"),
    LP: mp("LP"),
    WM: mp("WM"),
    WP: mp("WP"),
    XOM: mp("XOM"),
    XOI: mp("XOI"),
    XM: mp("XM"),
    XP: mp("XP"),
    LEVEL: mp("LEVEL"),
    PJ: mp("PJ"),
    W: mp("W"),
    L: mp("L"),
    M_MULT: mp("MMULT"),
    THERMAL: mp("THERMAL"),
  };

  // diosetup.c:104-106: NBV (DIObrkdEmissionCoeff) defaults to N when not given.
  if (isNaN(params.NBV)) params.NBV = params.N;
  // diosetup.c:47-49: NSW (DIOswEmissionCoeff) defaults to 1; reuse-N convention
  // preserves the bottom characteristic when the sidewall coeff is unspecified.
  if (isNaN(params.NSW)) params.NSW = params.N;

  // Givenness flags mirroring ngspice DIO*Given.
  const _tempGivenInit = props.isModelParamGiven("TEMP");
  // diosetup.c:92/:98 (knee given), dioload.c:324 (recSatCur), diosetup.c:203
  // (rth0), level-3 geometry givens. The DIOresistGiven gate (diotemp.c:233)
  // collapses to `RS != 0` in dioTemp — RS defaults to 0 when unspecified, so
  // `RS != 0` holds iff RS was given a nonzero value, matching the C predicate.
  let _ikfGiven = props.isModelParamGiven("IKF") && isFinite(params.IKF);
  let _ikrGiven = props.isModelParamGiven("IKR") && isFinite(params.IKR);
  const _swCurGiven = props.isModelParamGiven("ISW");
  const _swEmissionGiven = props.isModelParamGiven("NSW");
  const _recSatCurGiven = props.isModelParamGiven("ISR");
  const _tunSatCurGiven = props.isModelParamGiven("JTUN");
  const _tunSatSWCurGiven = props.isModelParamGiven("JTUNSW");
  const _rth0Given = props.isModelParamGiven("RTH0");
  const _wGiven = props.isModelParamGiven("W");
  const _lGiven = props.isModelParamGiven("L");

  // ---------------------------------------------------------------------------
  // Geometry resolution — diosetup.c:239-291. area/perimeter/cmetal/cpoly.
  // scale (cp_getvar "scale", diosetup.c:29-30) is 1.0 — digiTS exposes no
  // .options scale value, so the engine option default stands.
  // ---------------------------------------------------------------------------
  const scale = 1.0;
  let geomArea = 0;
  let geomPj = 0;
  let _cmetal = 0.0;
  let _cpoly = 0.0;
  function resolveGeometry(): void {
    // diosetup.c:257-258 — fold the multiplier into area/perimeter.
    geomArea = params.AREA * params.M_MULT;
    geomPj = params.PJ * params.M_MULT;
    _cmetal = 0.0;
    _cpoly = 0.0;
    if (params.LEVEL === 3) {
      // diosetup.c:263-266 — derive area/perimeter from W*L when both given.
      if (_wGiven && _lGiven) {
        geomArea = params.W * params.L * params.M_MULT;
        geomPj = (2 * params.W + 2 * params.L) * params.M_MULT;
      }
      geomArea = geomArea * scale * scale;
      geomPj = geomPj * scale;
      // diosetup.c:269-284 — instance vs model overrides collapse to one read.
      const wm = params.WM;
      const lm = params.LM;
      const wp = params.WP;
      const lp = params.LP;
      // diosetup.c:285-290 — parasitic metal + poly overlap caps.
      _cmetal = CONSTepsSiO2 / params.XOM * params.M_MULT
              * (wm * scale + params.XM)
              * (lm * scale + params.XM);
      _cpoly = CONSTepsSiO2 / params.XOI * params.M_MULT
             * (wp * scale + params.XP)
             * (lp * scale + params.XP);
    }
  }
  resolveGeometry();

  // Mutable temperature-scaled working values — recomputed by computeTemperature().
  let tIS: number, tIS_dT: number;
  let tSatSWCur: number, tSatSWCur_dT: number;
  let tTunSatCur: number, tTunSatCur_dT: number;
  let tTunSatSWCur: number, tTunSatSWCur_dT: number;
  let tRecSatCur: number, tRecSatCur_dT: number;
  let tVJ: number, tJctSWPot: number;
  let tCJO: number, tJctSWCap: number;
  let tVcrit: number, tBV: number;
  let tGradingCoeff: number, tTransitTime: number;
  let tConductance: number, tConductance_dT: number;
  let tF1: number, tF2: number, tF3: number, tF2SW: number, tF3SW: number;
  let tDepCap: number, tDepSWCap: number;
  let vt: number;

  function geom(): DioGeom {
    return { area: geomArea, pj: geomPj, m: params.M_MULT };
  }

  function tempInput(): DioTempInput {
    return {
      IS: params.IS, N: params.N, VJ: params.VJ, CJO: params.CJO, M: params.M,
      BV: params.BV, IBV: params.IBV, NBV: params.NBV, EG: params.EG,
      XTI: params.XTI, TNOM: params.TNOM,
      ISW: params.ISW, NSW: params.NSW, FC: params.FC, FCS: params.FCS,
      CJSW: params.CJSW, VJSW: params.VJSW, MJSW: params.MJSW,
      TLEV: params.TLEV, TLEVC: params.TLEVC, TM1: params.TM1, TM2: params.TM2,
      TTT1: params.TTT1, TTT2: params.TTT2, TRS: params.TRS, TRS2: params.TRS2,
      CTA: params.CTA, CTP: params.CTP, TPB: params.TPB, TPHP: params.TPHP, TCV: params.TCV,
      JTUN: params.JTUN, JTUNSW: params.JTUNSW, NTUN: params.NTUN, XTITUN: params.XTITUN, KEG: params.KEG,
      ISR: params.ISR, NR: params.NR, TT: params.TT, RS: params.RS, LEVEL: params.LEVEL,
    };
  }

  function applyDioTempResult(tp: DioTempParams): void {
    tIS = tp.tIS; tIS_dT = tp.tIS_dT;
    tSatSWCur = tp.tSatSWCur; tSatSWCur_dT = tp.tSatSWCur_dT;
    tTunSatCur = tp.tTunSatCur; tTunSatCur_dT = tp.tTunSatCur_dT;
    tTunSatSWCur = tp.tTunSatSWCur; tTunSatSWCur_dT = tp.tTunSatSWCur_dT;
    tRecSatCur = tp.tRecSatCur; tRecSatCur_dT = tp.tRecSatCur_dT;
    tVJ = tp.tVJ; tJctSWPot = tp.tJctSWPot;
    tCJO = tp.tCJO; tJctSWCap = tp.tJctSWCap;
    tVcrit = tp.tVcrit; tBV = tp.tBV;
    tGradingCoeff = tp.tGradingCoeff; tTransitTime = tp.tTransitTime;
    tConductance = tp.tConductance; tConductance_dT = tp.tConductance_dT;
    tF1 = tp.tF1; tF2 = tp.tF2; tF3 = tp.tF3; tF2SW = tp.tF2SW; tF3SW = tp.tF3SW;
    tDepCap = tp.tDepCap; tDepSWCap = tp.tDepSWCap;
    vt = tp.vt;
  }

  // Last engine-provided TempContext; reused by setParam() hot-load (mirrors
  // mosfet.ts:861). Seeded with field-default reltol/epsmin until the engine
  // temperature pass supplies the live circuit values.
  let _lastCtx: TempContext = {
    cktTemp: REFTEMP, cktNomTemp: params.TNOM,
    reltol: 1e-3, epsmin: 1e-28, _indVerbosity: 2,
  };

  // Initial temperature pass — uses params.TEMP as the device temperature.
  applyDioTempResult(dioTemp(tempInput(), params.TEMP, geom(), _lastCtx.reltol));

  const hasCapacitance = () => params.CJO > 0 || params.TT > 0 || _cmetal > 0 || _cpoly > 0;

  let pnjlimLimited = false;
  let _tempGiven = _tempGivenInit;

  let _posPrimeNode = nodeAnode;

  // Junction TSTALLOC handles — diosetup.c:333-339.
  let _hPosPP  = -1;
  let _hNegPP  = -1;
  let _hPPPos  = -1;
  let _hPPNeg  = -1;
  let _hPosPos = -1;
  let _hNegNeg = -1;
  let _hPPPP   = -1;
  // Thermal TSTALLOC handles — diosetup.c:342-348.
  let _hTempPos      = -1;
  let _hTempPosPrime = -1;
  let _hTempNeg      = -1;
  let _hTempTemp     = -1;
  let _hPosTemp      = -1;
  let _hPosPrimeTemp = -1;
  let _hNegTemp      = -1;

  // Stored thermal Jacobian, written at end of DC load(), read by AC load
  // (dioload.c:552-556, dioacld.c:47-51).
  let _dIth_dVrs = 0;
  let _dIth_dVdio = 0;
  let _dIth_dT = 0;
  let _gcTt = 0;
  let _dIrs_dT = 0;

  const internalLabels: string[] = [];

  class DiodeAnalogElement extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
    readonly deviceFamily: DeviceFamily = "DIO";
    readonly stateSize: number;
    readonly stateSchema: import("../../solver/analog/state-schema.js").StateSchema;

    constructor(pinNodes: ReadonlyMap<string, number>) {
      super(pinNodes);
      // diosetup.c:298 — *states += DIOnumStates (9).
      this.stateSize = DIODE_SCHEMA.size;
      this.stateSchema = DIODE_SCHEMA;
    }

    private _selfheat(): boolean {
      // diosetup.c:325 / dioload.c:80 — selfheat gates thermal-node wiring.
      return nodeTemp > 0 && params.THERMAL !== 0 && _rth0Given;
    }

    setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
      // diosetup.c:190-191 — floor model saturation current to CKTepsmin. ngspice
      // floors model->DIOsatCur (un-area-scaled); dioTemp folds area in afterward.
      if (params.IS < ctx.epsmin) {
        params.IS = ctx.epsmin;
      }
      // diosetup.c:92-103 — disable the high-injection knee when below CKTepsmin.
      if (_ikfGiven && params.IKF < ctx.epsmin) {
        _ikfGiven = false;
      }
      if (_ikrGiven && params.IKR < ctx.epsmin) {
        _ikrGiven = false;
      }
      // diosetup.c:193-195 — DIOnomTemp defaults to CKTnomTemp.
      if (!props.isModelParamGiven("TNOM")) {
        params.TNOM = ctx.nomTemp;
      }
      // Re-run the temperature pass so tIS etc. derive from the floored IS and
      // resolved TNOM (the construction pass ran before these clamps applied).
      // SetupContext carries no reltol; the engine's post-setup temperature pass
      // (ckttemp.c:28-33) immediately re-runs DIOtempUpdate with the live
      // CKTreltol, so this seed uses the field-default reltol.
      applyDioTempResult(dioTemp(tempInput(), _tempGiven ? params.TEMP : ctx.temp, geom(), _lastCtx.reltol));

      const solver = ctx.solver;
      const posNode = this.pinNodes.get("A")!;
      const negNode = this.pinNodes.get("K")!;
      const tNode = this.pinNodes.get("Tj") ?? 0;
      nodeAnode = posNode;
      nodeCathode = negNode;
      nodeTemp = tNode;

      if (this._stateBase === -1) {
        this._stateBase = ctx.allocStates(this.stateSize);
      }

      // Internal prime node — diosetup.c:303-323 (allocated when RS != 0).
      if (params.RS === 0) {
        _posPrimeNode = posNode;
      } else {
        _posPrimeNode = ctx.makeVolt(this.label ?? "D", "internal");
        internalLabels.push("internal");
      }

      // Junction TSTALLOC sequence — diosetup.c:333-339.
      _hPosPP  = solver.allocElement(posNode,       _posPrimeNode);
      _hNegPP  = solver.allocElement(negNode,       _posPrimeNode);
      _hPPPos  = solver.allocElement(_posPrimeNode, posNode);
      _hPPNeg  = solver.allocElement(_posPrimeNode, negNode);
      _hPosPos = solver.allocElement(posNode,       posNode);
      _hNegNeg = solver.allocElement(negNode,       negNode);
      _hPPPP   = solver.allocElement(_posPrimeNode, _posPrimeNode);

      // Thermal TSTALLOC sequence — diosetup.c:341-349 (only when self-heating).
      // The Tj terminal is declared only for a self-heating-configured instance
      // (getPins gates it on the same predicate), so nodeTemp > 0 here implies
      // selfheat; ngspice leaves DIOtempNode = 0 (ground) otherwise.
      if (this._selfheat()) {
        _hTempPos      = solver.allocElement(nodeTemp,      posNode);
        _hTempPosPrime = solver.allocElement(nodeTemp,      _posPrimeNode);
        _hTempNeg      = solver.allocElement(nodeTemp,      negNode);
        _hTempTemp     = solver.allocElement(nodeTemp,      nodeTemp);
        _hPosTemp      = solver.allocElement(posNode,       nodeTemp);
        _hPosPrimeTemp = solver.allocElement(_posPrimeNode, nodeTemp);
        _hNegTemp      = solver.allocElement(negNode,       nodeTemp);
      }
    }

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    }

    load(ctx: LoadContext): void {
      const pool = this._pool;
      const base = this._stateBase;
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];

      const voltages = ctx.rhsOld;
      const mode = ctx.cktMode;
      const solver = ctx.solver;
      const selfheat = this._selfheat();

      // dioload.c:104-108 — initialization. deviceTemp is here->DIOtemp.
      const deviceTemp = _tempGiven ? params.TEMP : ctx.temp;
      let delTemp = 0.0;
      vt = CONSTKoverQ * deviceTemp;
      let vte = params.N * vt;
      let vtebrk = params.NBV * vt;
      let gspr = tConductance;

      let Check_th = selfheat ? 1 : 0;
      let Check_dio = 0;

      // dioload.c:134-249 — voltage / delTemp selection per CKTmode.
      let vd: number;
      Check_dio = 1;
      if (mode & MODEINITSMSIG) {
        vd = s0[base + SLOT_VD];
        delTemp = s0[base + SLOT_DELTEMP];
      } else if (mode & MODEINITTRAN) {
        vd = s1[base + SLOT_VD];
        delTemp = s1[base + SLOT_DELTEMP];
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        vd = params.IC;
      } else if ((mode & MODEINITJCT) && params.OFF) {
        vd = 0;
        delTemp = 0.0;
      } else if (mode & MODEINITJCT) {
        vd = tVcrit;
        delTemp = 0.0;
      } else if ((mode & MODEINITFIX) && params.OFF) {
        vd = 0;
        delTemp = 0.0;
      } else {
        if (mode & MODEINITPRED) {
          // dioload.c:155-169 — predictor copies state1→state0 then DEVpred.
          s0[base + SLOT_VD]       = s1[base + SLOT_VD];
          const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
          vd = (1 + xfact) * s1[base + SLOT_VD] - xfact * s2[base + SLOT_VD];
          s0[base + SLOT_ID]       = s1[base + SLOT_ID];
          s0[base + SLOT_GEQ]      = s1[base + SLOT_GEQ];
          s0[base + SLOT_DELTEMP]  = s1[base + SLOT_DELTEMP];
          delTemp = (1 + xfact) * s1[base + SLOT_DELTEMP] - xfact * s2[base + SLOT_DELTEMP];
          s0[base + SLOT_DIDIO_DT] = s1[base + SLOT_DIDIO_DT];
          s0[base + SLOT_QTH]      = s1[base + SLOT_QTH];
        } else {
          // dioload.c:172-182 — normal NR: vd & delTemp from rhsOld.
          vd = voltages[_posPrimeNode] - voltages[nodeCathode];
          delTemp = selfheat ? voltages[nodeTemp] : 0.0;
          s0[base + SLOT_QTH] = params.CTH0 * delTemp;
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_QTH] = s0[base + SLOT_QTH];
          }
        }

        // dioload.c:219-243 — limit new junction voltage via pnjlim.
        const vdOld = s0[base + SLOT_VD];
        if (isFinite(params.BV) && vd < Math.min(0, -tBV + 10 * vtebrk)) {
          const vdBefore = vd;
          let vdtemp = -(vd + tBV);
          const r = pnjlim(vdtemp, -(vdOld + tBV), vtebrk, tVcrit);
          vdtemp = r.value;
          Check_dio = r.limited ? 1 : 0;
          vd = -(vdtemp + tBV);
          this._recordLimit(ctx, vdBefore, vd, r.limited);
        } else {
          const vdBefore = vd;
          const r = pnjlim(vd, vdOld, vte, tVcrit);
          vd = r.value;
          Check_dio = r.limited ? 1 : 0;
          this._recordLimit(ctx, vdBefore, vd, r.limited);
        }
        // dioload.c:244-248 — limitlog damps the temperature step.
        if (selfheat) {
          const r = limitlog(delTemp, s0[base + SLOT_DELTEMP], 100);
          delTemp = r.value;
          Check_th = r.check;
        } else {
          delTemp = 0.0;
        }
      }

      // dioload.c:253-262 — re-evaluate temperature params at Temp+delTemp.
      let Temp: number;
      if (selfheat) {
        Temp = deviceTemp + delTemp;
        applyDioTempResult(dioTemp(tempInput(), Temp, geom(), _lastCtx.reltol));
        vt = CONSTKoverQ * Temp;
        vte = params.N * vt;
        vtebrk = params.NBV * vt;
      } else {
        Temp = deviceTemp;
      }

      // dioload.c:264-268.
      let csat = tIS;
      let csat_dT = tIS_dT;
      const csatsw = tSatSWCur;
      const csatsw_dT = tSatSWCur_dT;
      gspr = tConductance;

      let cdsw = 0.0;
      let cdsw_dT = 0.0;
      let gdsw = 0.0;

      // dioload.c:270-312 — sidewall current.
      if (_swCurGiven) {
        if (_swEmissionGiven) {
          const vtesw = params.NSW * vt;
          if (vd >= -3 * vtesw) {
            const evd = Math.exp(vd / vtesw);
            cdsw = csatsw * (evd - 1);
            gdsw = csatsw * evd / vtesw;
            cdsw_dT = csatsw_dT * (evd - 1) - csatsw * vd * evd / (vtesw * Temp);
          } else if (!isFinite(params.BV) || vd >= -tBV) {
            let argsw = 3 * vtesw / (vd * Math.E);
            argsw = argsw * argsw * argsw;
            const argsw_dT = 3 * argsw / Temp;
            cdsw = -csatsw * (1 + argsw);
            gdsw = csatsw * 3 * argsw / vd;
            cdsw_dT = -csatsw_dT - (csatsw_dT * argsw + csatsw * argsw_dT);
          } else {
            const evrev = Math.exp(-(tBV + vd) / vtebrk);
            const evrev_dT = (tBV + vd) * evrev / (vtebrk * Temp);
            cdsw = -csatsw * evrev;
            gdsw = csatsw * evrev / vtebrk;
            cdsw_dT = -(csatsw_dT * evrev + csatsw * evrev_dT);
          }
        } else {
          // dioload.c:304-310 — merge into bottom characteristic.
          csat = csat + csatsw;
          csat_dT = csat_dT + csatsw_dT;
          cdsw_dT = 0.0;
        }
      }

      // dioload.c:318-363 — bottom current, three regions.
      let cdb: number, gdb: number, cdb_dT: number;
      if (vd >= -3 * vte) {
        const evd = Math.exp(vd / vte);
        cdb = csat * (evd - 1);
        gdb = csat * evd / vte;
        cdb_dT = csat_dT * (evd - 1) - csat * vd * evd / (vte * Temp);
        // dioload.c:324-340 — recombination current arm.
        if (_recSatCurGiven) {
          const vterec = params.NR * vt;
          const evd_rec = Math.exp(vd / vterec);
          let cdb_rec = tRecSatCur * (evd_rec - 1);
          let gdb_rec = tRecSatCur * evd_rec / vterec;
          const cdb_rec_dT = tRecSatCur_dT * (evd_rec - 1)
                           - tRecSatCur * vd * evd_rec / (vterec * Temp);
          const t1 = Math.pow(1 - vd / tVJ, 2) + 0.005;
          const gen_fac = Math.pow(t1, tGradingCoeff / 2);
          const gen_fac_vd = -tGradingCoeff * (1 - vd / tVJ)
                           * Math.pow(t1, tGradingCoeff / 2 - 1);
          cdb_rec = cdb_rec * gen_fac;
          gdb_rec = gdb_rec * gen_fac + cdb_rec * gen_fac_vd;
          cdb = cdb + cdb_rec;
          gdb = gdb + gdb_rec;
          cdb_dT = cdb_dT + cdb_rec_dT * gen_fac;
        }
      } else if (!isFinite(params.BV) || vd >= -tBV) {
        let arg = 3 * vte / (vd * Math.E);
        arg = arg * arg * arg;
        const darg_dT = 3 * arg / Temp;
        cdb = -csat * (1 + arg);
        gdb = csat * 3 * arg / vd;
        cdb_dT = -csat_dT - (csat_dT * arg + csat * darg_dT);
      } else {
        const evrev = Math.exp(-(tBV + vd) / vtebrk);
        const evrev_dT = (tBV + vd) * evrev / (vtebrk * Temp);
        cdb = -csat * evrev;
        gdb = csat * evrev / vtebrk;
        cdb_dT = -(csat_dT * evrev + csat * evrev_dT);
      }

      // dioload.c:365-375 — tunnel sidewall current.
      if (_tunSatSWCurGiven) {
        const vtetun = params.NTUN * vt;
        const evd = Math.exp(-vd / vtetun);
        cdsw = cdsw - tTunSatSWCur * (evd - 1);
        gdsw = gdsw + tTunSatSWCur * evd / vtetun;
        cdsw_dT = cdsw_dT - tTunSatSWCur_dT * (evd - 1)
                          - tTunSatSWCur * vd * evd / (vtetun * Temp);
      }

      // dioload.c:377-387 — tunnel bottom current.
      if (_tunSatCurGiven) {
        const vtetun = params.NTUN * vt;
        const evd = Math.exp(-vd / vtetun);
        cdb = cdb - tTunSatCur * (evd - 1);
        gdb = gdb + tTunSatCur * evd / vtetun;
        cdb_dT = cdb_dT - tTunSatCur_dT * (evd - 1)
                        - tTunSatCur * vd * evd / (vtetun * Temp);
      }

      // dioload.c:389-391.
      let cd = cdb + cdsw;
      let gd = gdb + gdsw;
      let dIdio_dT = cdb_dT + cdsw_dT;

      // dioload.c:393-417 — high-injection knee + gmin.
      if (vd >= -3 * vte) {
        if (_ikfGiven && cd > 1.0e-18) {
          const ikf_area_m = params.IKF * geomArea;
          const sqrt_ikf = Math.sqrt(cd / ikf_area_m);
          gd = ((1 + sqrt_ikf) * gd - cd * gd / (2 * sqrt_ikf * ikf_area_m)) / (1 + 2 * sqrt_ikf + cd / ikf_area_m) + ctx.cktGmin;
          cd = cd / (1 + sqrt_ikf) + ctx.cktGmin * vd;
        } else {
          gd = gd + ctx.cktGmin;
          cd = cd + ctx.cktGmin * vd;
        }
      } else {
        if (_ikrGiven && cd < -1.0e-18) {
          const ikr_area_m = params.IKR * geomArea;
          const sqrt_ikr = Math.sqrt(cd / (-ikr_area_m));
          gd = ((1 + sqrt_ikr) * gd + cd * gd / (2 * sqrt_ikr * ikr_area_m)) / (1 + 2 * sqrt_ikr - cd / ikr_area_m) + ctx.cktGmin;
          cd = cd / (1 + sqrt_ikr) + ctx.cktGmin * vd;
        } else {
          gd = gd + ctx.cktGmin;
          cd = cd + ctx.cktGmin * vd;
        }
      }

      // dioload.c:419-516 — charge-storage block.
      let ceqqth = 0.0;
      let gcTt = 0.0;
      const capGate =
        (mode & (MODEDCTRANCURVE | MODETRAN | MODEAC | MODEINITSMSIG)) !== 0 ||
        ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);
      if (capGate) {
        const order = ctx.order;
        const method = ctx.method;
        const Cj = computeJunctionCapacitance(vd, tCJO, tVJ, tGradingCoeff, tDepCap, tF2, tF3);
        const CjSW = computeJunctionCapacitance(vd, tJctSWCap, tJctSWPot, params.MJSW, tDepSWCap, tF2SW, tF3SW);
        // dioload.c:449-455 — total charge and capacitance with cmetal/cpoly fold.
        const diffcap = tTransitTime * gd;
        const capd = diffcap + Cj + CjSW + _cmetal + _cpoly;

        const q0 = computeJunctionCharge(vd, tCJO, tVJ, tGradingCoeff, tDepCap, tF1, tF2, tF3, tTransitTime, cd)
                 + this._deplChargeSW(vd, tJctSWCap, tJctSWPot, params.MJSW, tDepSWCap, tF1, tF2SW, tF3SW);
        let q1 = s1[base + SLOT_Q];
        const q2 = s2[base + SLOT_Q];
        const q3 = s3[base + SLOT_Q];
        s0[base + SLOT_Q] = q0;

        if (!((mode & MODETRANOP) && (mode & MODEUIC))) {
          if (mode & MODEINITSMSIG) {
            // dioload.c:464-477 — store the small-signal capacitance, then
            // `continue` to the next instance: the MODEINITSMSIG pass skips the
            // convergence bump, the state0 writes, and the matrix/RHS load.
            s0[base + SLOT_CCAP] = capd;
            return;
          } else {
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_Q] = q0;
              q1 = q0;
            }
            const ag = ctx.ag;
            const ccapPrev = s1[base + SLOT_CCAP];
            const { ccap, geq: capGeq } = niIntegrate(method, order, capd, ag, q0, q1, [q2, q3, 0, 0, 0], ccapPrev);
            s0[base + SLOT_CCAP] = ccap;
            gd = gd + capGeq;
            cd = cd + ccap;
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CCAP] = ccap;
            }
            // dioload.c:506-514 — integrate the thermal capacitor.
            if (selfheat) {
              const qth0 = s0[base + SLOT_QTH];
              const cqthPrev = s1[base + SLOT_CQTH];
              const thRes = niIntegrate(method, order, params.CTH0, ag, qth0, s1[base + SLOT_QTH], [s2[base + SLOT_QTH], s3[base + SLOT_QTH], 0, 0, 0], cqthPrev);
              gcTt = thRes.geq;
              ceqqth = thRes.ceq;
              s0[base + SLOT_CQTH] = thRes.ccap;
              if (mode & MODEINITTRAN) {
                s1[base + SLOT_CQTH] = thRes.ccap;
              }
            }
          }
        }
      }

      // dioload.c:523-528 — bump the non-convergence counter when either the
      // junction pnjlim (Check_dio) or the thermal limitlog (Check_th) damped.
      if (!(mode & MODEINITFIX) || !params.OFF) {
        if (Check_th === 1 || Check_dio === 1) {
          ctx.noncon.value++;
        }
      }
      pnjlimLimited = Check_dio === 1;

      // dioload.c:529-533 — state0 writes.
      s0[base + SLOT_VD]       = vd;
      s0[base + SLOT_ID]       = cd;
      s0[base + SLOT_GEQ]      = gd;
      s0[base + SLOT_DELTEMP]  = delTemp;
      s0[base + SLOT_DIDIO_DT] = dIdio_dT;

      // dioload.c:540-557 — thermal Jacobian.
      let Ith = 0, dIth_dVrs = 0, dIth_dVdio = 0, dIth_dT = 0, dIrs_dT = 0, vrs = 0;
      if (selfheat) {
        vrs = voltages[nodeAnode] - voltages[_posPrimeNode];
        Ith = vd * cd + vrs * vrs * gspr;
        const dIrs_dVrs = gspr;
        const dIrs_dgspr = vrs;
        dIrs_dT = dIrs_dgspr * tConductance_dT;
        dIth_dVrs = vrs * gspr;
        const dIth_dIrs = vrs;
        dIth_dVrs = dIth_dVrs + dIth_dIrs * dIrs_dVrs;
        dIth_dT = dIth_dIrs * dIrs_dT + dIdio_dT * vd;
        dIth_dVdio = cd + vd * gd;
        _dIth_dVrs = dIth_dVrs;
        _dIth_dVdio = dIth_dVdio;
        _dIth_dT = dIth_dT;
        _gcTt = gcTt;
        _dIrs_dT = dIrs_dT;
      }

      // dioload.c:561-563 — load current vector.
      const cdeq = cd - gd * vd;
      stampRHS(ctx.rhs, nodeCathode, cdeq);
      stampRHS(ctx.rhs, _posPrimeNode, -cdeq);
      // dioload.c:564-569 — self-heating RHS.
      if (selfheat) {
        stampRHS(ctx.rhs, nodeAnode, dIrs_dT * delTemp);
        stampRHS(ctx.rhs, _posPrimeNode, dIdio_dT * delTemp - dIrs_dT * delTemp);
        stampRHS(ctx.rhs, nodeCathode, -dIdio_dT * delTemp);
        stampRHS(ctx.rhs, nodeTemp, Ith - dIth_dVdio * vd - dIth_dVrs * vrs - dIth_dT * delTemp - ceqqth);
      }

      // dioload.c:573-579 — load matrix (junction).
      solver.stampElement(_hPosPos, gspr);
      solver.stampElement(_hNegNeg, gd);
      solver.stampElement(_hPPPP, gd + gspr);
      solver.stampElement(_hPosPP, -gspr);
      solver.stampElement(_hNegPP, -gd);
      solver.stampElement(_hPPPos, -gspr);
      solver.stampElement(_hPPNeg, -gd);
      // dioload.c:580-588 — thermal matrix stamps.
      if (selfheat) {
        solver.stampElement(_hTempPos, -dIth_dVrs);
        solver.stampElement(_hTempPosPrime, -dIth_dVdio + dIth_dVrs);
        solver.stampElement(_hTempNeg, dIth_dVdio);
        solver.stampElement(_hTempTemp, -dIth_dT + 1 / params.RTH0 + gcTt);
        solver.stampElement(_hPosTemp, dIrs_dT);
        solver.stampElement(_hPosPrimeTemp, dIdio_dT - dIrs_dT);
        solver.stampElement(_hNegTemp, -dIdio_dT);
      }
    }

    /** Sidewall depletion charge term — dioload.c:436-447 (added to DIOcapCharge). */
    private _deplChargeSW(
      vd: number, czeroSW: number, tSWPot: number, mjsw: number,
      tDepSWCapL: number, tF1L: number, tF2SWL: number, tF3SWL: number,
    ): number {
      if (czeroSW <= 0) return 0;
      if (vd < tDepSWCapL) {
        const argSW = 1 - vd / tSWPot;
        const sargSW = Math.exp(-mjsw * Math.log(argSW));
        return tSWPot * czeroSW * (1 - argSW * sargSW) / (1 - mjsw);
      } else {
        const czof2SW = czeroSW / tF2SWL;
        return czeroSW * tF1L + czof2SW * (tF3SWL * (vd - tDepSWCapL)
             + (mjsw / (tSWPot + tSWPot)) * (vd * vd - tDepSWCapL * tDepSWCapL));
      }
    }

    private _recordLimit(ctx: LoadContext, vBefore: number, vAfter: number, limited: boolean): void {
      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore,
          vAfter,
          wasLimited: limited,
        });
      }
    }

    stampAc(
      solver: SparseSolverStamp,
      omega: number,
      _ctx: LoadContext,
      _rhsRe: Float64Array,
      _rhsIm: Float64Array,
    ): void {
      // dioacld.c:31-44 — junction admittance stamps.
      const s0 = this._pool.states[0];
      const base = this._stateBase;
      const gspr = tConductance;
      const geq = s0[base + SLOT_GEQ];
      const xceq = s0[base + SLOT_CCAP] * omega;
      solver.stampElement(_hPosPos, gspr);
      solver.stampElement(_hNegNeg, geq);
      solver.stampElementImag(_hNegNeg, xceq);
      solver.stampElement(_hPPPP, geq + gspr);
      solver.stampElementImag(_hPPPP, xceq);
      solver.stampElement(_hPosPP, -gspr);
      solver.stampElement(_hNegPP, -geq);
      solver.stampElementImag(_hNegPP, -xceq);
      solver.stampElement(_hPPPos, -gspr);
      solver.stampElement(_hPPNeg, -geq);
      solver.stampElementImag(_hPPNeg, -xceq);
      // dioacld.c:45-63 — self-heating thermal branch.
      if (this._selfheat()) {
        const dIdio_dT = s0[base + SLOT_DIDIO_DT];
        solver.stampElement(_hTempPos, -_dIth_dVrs);
        solver.stampElement(_hTempPosPrime, -_dIth_dVdio + _dIth_dVrs);
        solver.stampElement(_hTempNeg, _dIth_dVdio);
        solver.stampElement(_hTempTemp, -_dIth_dT + 1 / params.RTH0 + _gcTt);
        solver.stampElement(_hPosTemp, _dIrs_dT);
        solver.stampElement(_hPosPrimeTemp, dIdio_dT - _dIrs_dT);
        solver.stampElement(_hNegTemp, -dIdio_dT);
        const xgcTt = s0[base + SLOT_CQTH] * omega;
        solver.stampElementImag(_hTempTemp, xgcTt);
      }
    }

    checkConvergence(ctx: LoadContext): boolean {
      const pool = this._pool;
      const base = this._stateBase;
      const s0 = pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      if (pnjlimLimited) return false;

      const voltages = ctx.rhsOld;
      const vd = voltages[_posPrimeNode] - voltages[nodeCathode];
      const delvd = vd - s0[base + SLOT_VD];

      // dioconv.c:41-50 — convergence prediction with temperature term.
      const selfheat = this._selfheat();
      const delTemp = selfheat ? voltages[nodeTemp] : 0.0;
      const deldelTemp = delTemp - s0[base + SLOT_DELTEMP];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd + s0[base + SLOT_DIDIO_DT] * deldelTemp;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      // pinLayout order: [A, K, Tj]; Tj carries no terminal current.
      const id = this._pool.states[0][this._stateBase + SLOT_ID];
      return [id, -id, 0];
    }

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      if (!hasCapacitance()) return Infinity;
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
     * computeTemperature — DIOtemp (diotemp.c:249-272). Resolves the device
     * base temperature (DIOtempGiven ? DIOtemp : CKTtemp) and runs DIOtempUpdate
     * at that temperature.
     */
    computeTemperature(ctx: TempContext): void {
      _lastCtx = ctx;
      const T = _tempGiven ? params.TEMP : ctx.cktTemp;
      applyDioTempResult(dioTemp(tempInput(), T, geom(), ctx.reltol));
    }

    setParam(key: string, value: number): void {
      // Geometry params (diosetup.c:239-291) refold area/perimeter/cmetal/cpoly.
      const geomKeys = new Set(["MMULT", "AREA", "PJ", "W", "L", "LEVEL", "WM", "LM", "WP", "LP", "XOM", "XOI", "XM", "XP"]);
      if (key === "MMULT") {
        // dio.c:21 — instance multiplier maps to M_MULT internally.
        params.M_MULT = value;
        resolveGeometry();
        this.computeTemperature(_lastCtx);
        return;
      }
      if (key in params) {
        params[key] = value;
        if (key === "IKF") _ikfGiven = isFinite(value);
        if (key === "IKR") _ikrGiven = isFinite(value);
        if (geomKeys.has(key)) resolveGeometry();
        if (key === "TEMP") {
          _tempGiven = true;
          this.computeTemperature({ ..._lastCtx, cktTemp: value, cktNomTemp: params.TNOM });
        } else {
          this.computeTemperature(_lastCtx);
        }
      }
    }
  }

  return new DiodeAnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// getDiodeInternalNodeLabels — mirror of the RS > 0 predicate
// ---------------------------------------------------------------------------

export function getDiodeInternalNodeLabels(props: PropertyBag): readonly string[] {
  return props.getModelParam<number>("RS") > 0 ? ["internal"] : [];
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

  /**
   * Whether this instance is topologically self-heating, mirroring the ngspice
   * selfheat predicate (dioload.c:80 / diosetup.c:325):
   *   selfheat = (DIOtempNode > 0) && DIOthermal && DIOrth0Given
   * The DIOtempNode>0 factor is what the Tj terminal materialises: ngspice only
   * allocates DIOtempNode when self-heating is configured (DIOthermal set and
   * rth0 given), leaving it 0 (ground) otherwise. digiTS mirrors that by
   * declaring the Tj pin only under this predicate — an unconfigured diode is a
   * 2-terminal {A,K} device whose temperature node is ground, exactly as
   * ngspice's DIOtempNode=0.
   */
  private _selfHeatingConfigured(): boolean {
    const props = this.getProperties();
    // getPins runs on the user-facing CircuitElement bag, which- unlike the
    // compile-merged analog bag- can be bare (factory(new PropertyBag()) in the
    // registry smoke test; pre-merge during compile pin resolution). Read THERMAL
    // directly when present, else its paramDef default (DIODE_PARAM_SPEC, the
    // single source of the value).
    const thermal = props.hasModelParam("THERMAL")
      ? props.getModelParam<number>("THERMAL")
      : DIODE_PARAM_DEFAULTS.THERMAL;
    return thermal !== 0 && props.isModelParamGiven("RTH0");
  }

  getPins(): readonly Pin[] {
    const decls = this._selfHeatingConfigured()
      ? buildDiodePinDeclarations()
      // dio.c:137-143 — the Tj terminal exists only when self-heating wires
      // DIOtempNode; drop it for the 2-terminal {A,K} case so the unwired Tj
      // pin does not exclude the device from the analog netlist.
      : buildDiodePinDeclarations().filter((d) => d.label !== "Tj");
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4,
      height: 2,
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

    // Triangle body pointing right (anode left, cathode right)
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);

    // dio.c:140 — the Tj thermal lead is painted only when self-heating is
    // configured, matching the pin set getPins() exposes for that case.
    if (this._selfHeatingConfigured()) {
      const vTj = signals?.getPinVoltage("Tj");
      drawColoredLead(ctx, signals, vTj, 2, 0.5, 2, 1.5);
    }

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.75, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout — dio.c:137-143: DIOnames {D+, D-, Tj}
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
    {
      // dio.c:140 — Tj is the junction-temperature node (diodefs.h:41
      // DIOtempNode); it carries delTemp (the temperature rise over rth0)
      // when self-heating is on. Declared in the static layout (3-terminal
      // device) but exposed by getPins() only when self-heating is configured,
      // so it is marked conditional; wired into the matrix only when selfheat.
      direction: PinDirection.OUTPUT,
      label: "Tj",
      defaultBitWidth: 1,
      position: { x: 2, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      conditional: true,
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
  voltageProbes: [{ name: "V", pos: "A", neg: "K" }],
  propertyDefs: DIODE_PROPERTY_DEFS,
  attributeMap: DIODE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Diode — Shockley equation with NR linearization, self-heating, recombination,\n" +
    "tunneling, sidewall and level=3 parasitic geometry.\n" +
    "Id = IS * (exp(Vd/(N*Vt)) - 1)",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: DIODE_PARAM_DEFS,
      params: DIODE_PARAM_DEFAULTS,
      spice: { device: "DIO", deckNodeTokens: ["A", "K"] },
    },
  },
  defaultModel: "spice",
};
