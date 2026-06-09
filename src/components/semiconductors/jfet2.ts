/**
 * Parker-Skellern (PS) short-channel JFET2 field-effect transistor
 * (N-channel / P-channel). Parker-Skellern MESFET model, A.E. Parker,
 * Macquarie University.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/jfet2/`:
 *   - jfet2defs.h  — instance/model structs, the 19 state slots (:164-184).
 *   - jfet2parm.h  — the 30-row PS model card (:15-54).
 *   - jfet2set.c   — JFET2setup (prime-node alloc, 15-element TSTALLOC).
 *   - jfet2temp.c  — JFET2temp (model + per-instance temperature corrections).
 *   - psmodel.c    — PSids / qgg / PScharge / PSacload / PSinstanceinit.
 *   - jfet2load.c  — JFET2load (voltage dispatch, limiting, NIintegrate, stamps).
 *   - jfet2acld.c  — JFET2acLoad (AC small-signal complex stamps).
 *   - jfet2trun.c  — JFET2trunc (LTE via CKTterr on qgs/qgd).
 *   - jfet2par.c / jfet2mpar.c — instance / model parameter setters.
 *
 * Single-pass `load()` per device per NR iteration (unified-interface model,
 * sibling of njfet.ts). JFET2type carries the device polarity (+1 NJF / -1
 * PJF); Jfet2NDefinition/Jfet2PDefinition seed it via the closure factory.
 * State lives in StatePool slots; load() reads s1/s2 and writes s0. All params
 * are hot-loadable via setParam.
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
import type { AnalogElement } from "../../solver/analog/element.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { pnjlim, fetlim } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG, MODEINITTRAN, MODEINITPRED,
  MODETRAN, MODEAC, MODETRANOP, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import {
  CONSTboltz,
  CHARGE,
  CONSTKoverQ,
  REFTEMP,
} from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** sqrt(2) (CONSTroot2). */
const CONSTroot2 = Math.SQRT2;

// ---------------------------------------------------------------------------
// Part A — Model / instance parameter declarations
//
// The PS model card is the PARAM table jfet2parm.h:15-54 plus the tnom row
// (jfet2mpar.c:24-27). digiTS tokens equal the ngspice tokens. vbi/pb both
// write PHI; vt0/vto both write VTO; hfgam defaults to lfgam (resolved in the
// temperature pass, jfet2parm.h:54 / jfet2set.c:36-38).
// ---------------------------------------------------------------------------

export const { paramDefs: JFET2_PARAM_DEFS, defaults: JFET2_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    BETA: { default: 1e-4, unit: "A/V²", description: "Transconductance parameter (jfet2parm.h:17 beta)" },
    VTO:  { default: -2.0, unit: "V", spiceName: "vt0", description: "Threshold voltage (jfet2parm.h:49 vt0 writable PARAM; vto PARAMR alias :50)" },
    LAMBDA: { default: 0.0, unit: "1/V", spiceName: "lambda", description: "Channel length modulation (jfet2parm.h:33)" },
  },
  secondary: {
    ACGAM: { default: 0, spiceName: "acgam", description: "Capacitance vds modulation (jfet2parm.h:15)" },
    AF:    { default: 1, spiceName: "af", description: "Flicker noise exponent (jfet2parm.h:16)" },
    CAPDS: { default: 0, unit: "F", spiceName: "cds", description: "D-S junction capacitance (jfet2parm.h:18)" },
    CAPGD: { default: 0, unit: "F", spiceName: "cgd", description: "G-D junction capacitance (jfet2parm.h:19)" },
    CAPGS: { default: 0, unit: "F", spiceName: "cgs", description: "G-S junction capacitance (jfet2parm.h:20)" },
    DELTA: { default: 0, spiceName: "delta", description: "Coef of thermal current reduction (jfet2parm.h:21)" },
    HFETA: { default: 0, spiceName: "hfeta", description: "Drain feedback modulation (jfet2parm.h:22)" },
    HFE1:  { default: 0, spiceName: "hfe1", description: "AC source feedback vgd modulation (jfet2parm.h:23)" },
    HFE2:  { default: 0, spiceName: "hfe2", description: "AC source feedback vgs modulation (jfet2parm.h:24)" },
    HFG1:  { default: 0, spiceName: "hfg1", description: "AC drain feedback vgs modulation (jfet2parm.h:25)" },
    HFG2:  { default: 0, spiceName: "hfg2", description: "AC drain feedback vgd modulation (jfet2parm.h:26)" },
    MVST:  { default: 0, spiceName: "mvst", description: "Subthreshold vds modulation index (jfet2parm.h:27)" },
    MXI:   { default: 0, spiceName: "mxi", description: "Saturation potential modulation (jfet2parm.h:28)" },
    FC:    { default: 0.5, spiceName: "fc", description: "Forward bias junction fit param (jfet2parm.h:29)" },
    IBD:   { default: 0, unit: "A", spiceName: "ibd", description: "Breakdown current of diode jnc (jfet2parm.h:30)" },
    IS:    { default: 1e-14, unit: "A", spiceName: "is", description: "Gate junction saturation current (jfet2parm.h:31)" },
    FNCOEF: { default: 0, spiceName: "kf", description: "Flicker noise coefficient (jfet2parm.h:32)" },
    LFGAM: { default: 0, spiceName: "lfgam", description: "DC drain feedback (jfet2parm.h:34)" },
    LFG1:  { default: 0, spiceName: "lfg1", description: "DC drain feedback vgs modulation (jfet2parm.h:35)" },
    LFG2:  { default: 0, spiceName: "lfg2", description: "DC drain feedback vgd modulation (jfet2parm.h:36)" },
    N:     { default: 1, spiceName: "n", description: "Gate junction ideality factor (jfet2parm.h:37)" },
    P:     { default: 2, spiceName: "p", description: "Power law (triode region) (jfet2parm.h:38)" },
    PHI:   { default: 1, unit: "V", spiceName: "vbi", description: "Gate junction potential (jfet2parm.h:39 vbi writable PARAM; pb PARAMR alias :40)" },
    Q:     { default: 2, spiceName: "q", description: "Power law (saturated region) (jfet2parm.h:41)" },
    RD:    { default: 0, unit: "Ω", spiceName: "rd", description: "Drain ohmic resistance (jfet2parm.h:42)" },
    RS:    { default: 0, unit: "Ω", spiceName: "rs", description: "Source ohmic resistance (jfet2parm.h:43)" },
    TAUD:  { default: 0, unit: "s", spiceName: "taud", description: "Thermal relaxation time (jfet2parm.h:44)" },
    TAUG:  { default: 0, unit: "s", spiceName: "taug", description: "Drain feedback relaxation time (jfet2parm.h:45)" },
    VBD:   { default: 1, unit: "V", spiceName: "vbd", description: "Breakdown potential of diode jnc (jfet2parm.h:46)" },
    VER:   { default: 0, spiceName: "ver", description: "Version number of PS model (jfet2parm.h:47)" },
    VST:   { default: 0, spiceName: "vst", description: "Crit poten subthreshold conductn (jfet2parm.h:48)" },
    XC:    { default: 0, spiceName: "xc", description: "Amount of cap reduction at pinch-off (jfet2parm.h:51)" },
    XI:    { default: 1000, spiceName: "xi", description: "Velocity saturation index (jfet2parm.h:52)" },
    Z:     { default: 1, spiceName: "z", description: "Rate of velocity saturation (jfet2parm.h:53)" },
    HFGAM: { default: 0, spiceName: "hfgam", description: "High freq drain feedback; defaults to lfgam (jfet2parm.h:54)" },
    TNOM:  { default: REFTEMP, unit: "K", spiceName: "tnom", description: "Nominal parameter temperature (jfet2mpar.c:24-27)", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA:  { default: 1.0, description: "Area factor (jfet2par.c:37-39)" },
    M:     { default: 1.0, description: "Parallel multiplier (jfet2par.c:41-44)" },
    TEMP:  { default: 300.15, unit: "K", description: "Per-instance operating temperature (jfet2par.c:29-32)", spiceConverter: kelvinToCelsius },
    DTEMP: { default: 0.0, unit: "K", description: "Instance temperature difference (jfet2par.c:33-36)" },
    OFF:   { default: 0, emit: "flag", description: "Initial condition: device off (jfet2par.c:53-55)" },
    ICVDS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 0 }, spiceName: "icvds", description: "IC for Vds (MODEUIC) (jfet2par.c:45-48, JFET2_IC vec[0])" },
    ICVGS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 1 }, spiceName: "icvgs", description: "IC for Vgs (MODEUIC) (jfet2par.c:49-52, JFET2_IC vec[1])" },
  },
});

// ---------------------------------------------------------------------------
// Jfet2Params  resolved model + instance parameters
// ---------------------------------------------------------------------------

export interface Jfet2Params {
  BETA: number;
  VTO: number;
  LAMBDA: number;
  ACGAM: number;
  AF: number;
  CAPDS: number;
  CAPGD: number;
  CAPGS: number;
  DELTA: number;
  HFETA: number;
  HFE1: number;
  HFE2: number;
  HFG1: number;
  HFG2: number;
  MVST: number;
  MXI: number;
  FC: number;
  IBD: number;
  IS: number;
  FNCOEF: number;
  LFGAM: number;
  LFG1: number;
  LFG2: number;
  N: number;
  P: number;
  PHI: number;
  Q: number;
  RD: number;
  RS: number;
  TAUD: number;
  TAUG: number;
  VBD: number;
  VER: number;
  VST: number;
  XC: number;
  XI: number;
  Z: number;
  HFGAM: number;
  TNOM: number;
  AREA: number;
  M: number;
  TEMP: number;
  DTEMP: number;
  OFF: number;
  ICVDS: number;
  ICVGS: number;
  [key: string]: number;
}

// ---------------------------------------------------------------------------
// Part B — State schema  (jfet2defs.h:164-184, the 19-slot pool).
//
// cite: jfet2defs.h:164-184 — JFET2numStates 19. Slots in ngspice offset
// order. JFET2vtrap (16) is the gate-DRAIN trap (PS VGDTRAP); JFET2vgstrap
// (17) the gate-SOURCE trap (PS VGSTRAP) — the crossed naming is ngspice's
// (psmodel.h:47-50), preserved here. The state-count 19 satisfies the
// portable state-count sub-item jfet2defs.h#h003a.
// ---------------------------------------------------------------------------

export const JFET2_SCHEMA: StateSchema = defineStateSchema("Jfet2Element", [
  { name: "VGS",     doc: "jfet2defs.h JFET2vgs=0" },
  { name: "VGD",     doc: "jfet2defs.h JFET2vgd=1" },
  { name: "CG",      doc: "jfet2defs.h JFET2cg=2" },
  { name: "CD",      doc: "jfet2defs.h JFET2cd=3" },
  { name: "CGD",     doc: "jfet2defs.h JFET2cgd=4" },
  { name: "GM",      doc: "jfet2defs.h JFET2gm=5" },
  { name: "GDS",     doc: "jfet2defs.h JFET2gds=6" },
  { name: "GGS",     doc: "jfet2defs.h JFET2ggs=7" },
  { name: "GGD",     doc: "jfet2defs.h JFET2ggd=8" },
  { name: "QGS",     doc: "jfet2defs.h JFET2qgs=9" },
  { name: "CQGS",    doc: "jfet2defs.h JFET2cqgs=10" },
  { name: "QGD",     doc: "jfet2defs.h JFET2qgd=11" },
  { name: "CQGD",    doc: "jfet2defs.h JFET2cqgd=12" },
  { name: "QDS",     doc: "jfet2defs.h JFET2qds=13" },
  { name: "CQDS",    doc: "jfet2defs.h JFET2cqds=14" },
  { name: "PAVE",    doc: "jfet2defs.h JFET2pave=15" },
  { name: "VTRAP",   doc: "jfet2defs.h JFET2vtrap=16 (PS VGDTRAP)" },
  { name: "VGSTRAP", doc: "jfet2defs.h JFET2vgstrap=17 (PS VGSTRAP)" },
  { name: "UNKNOWN", doc: "jfet2defs.h JFET2unknown=18 (spare; numStates=19)" },
]);

const SLOT_VGS     = JFET2_SCHEMA.indexOf.get("VGS")!;
const SLOT_VGD     = JFET2_SCHEMA.indexOf.get("VGD")!;
const SLOT_CG      = JFET2_SCHEMA.indexOf.get("CG")!;
const SLOT_CD      = JFET2_SCHEMA.indexOf.get("CD")!;
const SLOT_CGD     = JFET2_SCHEMA.indexOf.get("CGD")!;
const SLOT_GM      = JFET2_SCHEMA.indexOf.get("GM")!;
const SLOT_GDS     = JFET2_SCHEMA.indexOf.get("GDS")!;
const SLOT_GGS     = JFET2_SCHEMA.indexOf.get("GGS")!;
const SLOT_GGD     = JFET2_SCHEMA.indexOf.get("GGD")!;
const SLOT_QGS     = JFET2_SCHEMA.indexOf.get("QGS")!;
const SLOT_CQGS    = JFET2_SCHEMA.indexOf.get("CQGS")!;
const SLOT_QGD     = JFET2_SCHEMA.indexOf.get("QGD")!;
const SLOT_CQGD    = JFET2_SCHEMA.indexOf.get("CQGD")!;
const SLOT_QDS     = JFET2_SCHEMA.indexOf.get("QDS")!;
const SLOT_CQDS    = JFET2_SCHEMA.indexOf.get("CQDS")!;
const SLOT_PAVE    = JFET2_SCHEMA.indexOf.get("PAVE")!;
const SLOT_VTRAP   = JFET2_SCHEMA.indexOf.get("VTRAP")!;
const SLOT_VGSTRAP = JFET2_SCHEMA.indexOf.get("VGSTRAP")!;

// ---------------------------------------------------------------------------
// Part D — Temperature-corrected parameters (jfet2temp.c + PSinstanceinit).
// ---------------------------------------------------------------------------

export interface Jfet2TempParams {
  /** Thermal voltage vt = temp * CONSTKoverQ (jfet2temp.c:93). */
  vt: number;
  /** Temperature-adjusted saturation current (JFET2tSatCur, jfet2temp.c:96). */
  tSatCur: number;
  /** Temperature-adjusted gate potential = PS VBI (JFET2tGatePot, jfet2temp.c:104). */
  tGatePot: number;
  /** Temperature-corrected G-S capacitance (JFET2tCGS, jfet2temp.c:97,107). */
  tCGS: number;
  /** Temperature-corrected G-D capacitance (JFET2tCGD, jfet2temp.c:98,108). */
  tCGD: number;
  /** Forward-bias depletion-cap join potential = PS VMAX (JFET2corDepCap, jfet2temp.c:110). */
  corDepCap: number;
  /** Critical voltage for pnjlim (JFET2vcrit, jfet2temp.c:112). */
  vcrit: number;
  /** Capacitance polynomial coefficient f1 (JFET2f1, jfet2temp.c:111). */
  f1: number;
  /** Model-level coefficient f2 (JFET2f2, jfet2temp.c:78). */
  f2: number;
  /** Model-level coefficient f3 (JFET2f3, jfet2temp.c:79). */
  f3: number;
  /** Drain ohmic conductance 1/rd or 0 (JFET2drainConduct, jfet2temp.c:60-64). */
  drainConduct: number;
  /** Source ohmic conductance 1/rs or 0 (JFET2sourceConduct, jfet2temp.c:65-69). */
  sourceConduct: number;
  /** Saturation knee parameter = PS ZA (JFET2za, psmodel.c:374). */
  za: number;
  /** Velocity saturation potential = PS XI_WOO (JFET2xiwoo, psmodel.c:373). */
  xiwoo: number;
  /** Capacitance transition param = PS ALPHA (JFET2alpha, psmodel.c:375). */
  alpha: number;
  /** Dual power-law parameter = PS D3 (JFET2d3, psmodel.c:376). */
  d3: number;
  /** High-freq drain feedback resolved against lfgam (jfet2parm.h:54). */
  hfgam: number;
  /** FC clamped to 0.95 (jfet2temp.c:70-75). */
  fc: number;
  /** Model nominal temperature (jfet2temp.c:46-48). */
  tnom: number;
}

export interface Jfet2GivenFlags {
  hfgamGiven: boolean;
  tnomGiven: boolean;
  tempGiven: boolean;
  dtempGiven: boolean;
}

/**
 * Port of `jfet2temp.c::JFET2temp` (model + per-instance corrections) followed
 * by `psmodel.c::PSinstanceinit`. Mirrors njfet.ts::computeJfetTempParams but
 * uses the literal 1.11 bandgap factor (jfet2temp.c:96 — JFET2 has no eg/xti
 * param) and adds the PS derived fields.
 */
export function computeJfet2TempParams(
  p: Jfet2Params,
  given: Jfet2GivenFlags,
  ctx: { cktTemp: number; cktNomTemp: number },
): Jfet2TempParams {
  // jfet2temp.c:46-48 — tnom defaults to circuit nominal temperature.
  const tnom = given.tnomGiven ? p.TNOM : ctx.cktNomTemp;
  // jfet2temp.c:49-58 — built-in-potential temperature reference math.
  const vtnom = CONSTKoverQ * tnom;
  const fact1 = tnom / REFTEMP;
  const kt1 = CONSTboltz * tnom;
  const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
  const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);
  const pbo = (p.PHI - pbfact1) / fact1;
  const gmaold = (p.PHI - pbo) / pbo;
  const cjfact = 1 / (1 + 0.5 * (4e-4 * (tnom - REFTEMP) - gmaold));

  // jfet2temp.c:60-69 — drain/source conductance from rd/rs.
  const drainConduct  = p.RD !== 0 ? 1 / p.RD : 0;
  const sourceConduct = p.RS !== 0 ? 1 / p.RS : 0;

  // jfet2temp.c:70-79 — FC clamp to 0.95, then f2/f3.
  const fc = p.FC > 0.95 ? 0.95 : p.FC;
  const xfc = Math.log(1 - fc);
  const f2 = Math.exp((1 + 0.5) * xfc);
  const f3 = 1 - fc * (1 + 0.5);

  // jfet2temp.c:85-91 — dtemp / temp defaults.
  const dtemp = given.dtempGiven ? p.DTEMP : 0.0;
  const temp = given.tempGiven ? p.TEMP : ctx.cktTemp + dtemp;

  // jfet2temp.c:93-96 — thermal voltage + saturation current scaling (1.11 fixed).
  const vt = temp * CONSTKoverQ;
  const fact2 = temp / REFTEMP;
  const ratio1 = temp / tnom - 1;
  const tSatCur = p.IS * Math.exp(ratio1 * 1.11 / vt);

  // jfet2temp.c:97-108 — depletion-cap temperature corrections (two cjfact stages).
  let tCGS = p.CAPGS * cjfact;
  let tCGD = p.CAPGD * cjfact;
  const kt = CONSTboltz * temp;
  const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
  const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);
  const tGatePot = fact2 * pbo + pbfact;
  const gmanew = (tGatePot - pbo) / pbo;
  const cjfact1 = 1 + 0.5 * (4e-4 * (temp - REFTEMP) - gmanew);
  tCGS *= cjfact1;
  tCGD *= cjfact1;

  // jfet2temp.c:110-112 — depletion-cap join point, f1, critical voltage.
  const corDepCap = fc * tGatePot;
  const f1 = tGatePot * (1 - Math.exp((1 - 0.5) * xfc)) / (1 - 0.5);
  const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));

  // psmodel.c:372-376 — PSinstanceinit derived parameters. woo = VBI - VTO,
  // VBI = tGatePot.
  const woo = tGatePot - p.VTO;
  const xiwoo = p.XI * woo;
  const za = Math.sqrt(1 + p.Z) / 2;
  const alpha = (xiwoo * xiwoo) / (p.XI + 1) / (p.XI + 1) / 4;
  const d3 = p.P / p.Q / Math.pow(woo, p.P - p.Q);

  // jfet2parm.h:54 — hfgam defaults to lfgam when not given (jfet2set.c:36-38).
  const hfgam = given.hfgamGiven ? p.HFGAM : p.LFGAM;

  return {
    vt, tSatCur, tGatePot, tCGS, tCGD, corDepCap, vcrit, f1, f2, f3,
    drainConduct, sourceConduct, za, xiwoo, alpha, d3, hfgam, fc, tnom,
  };
}

// ---------------------------------------------------------------------------
// Part E/F — PS-model out structs.
// ---------------------------------------------------------------------------

interface PsIdsOut { igs: number; igd: number; ggs: number; ggd: number; gm: number; gds: number; }
interface PsCapsOut { cgs: number; cgd: number; }
interface PsAcOut { gm: number; xgm: number; gds: number; xgds: number; }

/**
 * Port of psmodel.c:209-249 — Statz et al. gate-charge function (IEEE Trans ED
 * Feb 87). Returns total gate charge; writes cgs/cgd into `out`.
 */
function qgg(
  vgs: number, vgd: number, gamma: number, pb: number, alpha: number,
  vto: number, vmax: number, xc: number, cgso: number, cgdo: number,
  out: PsCapsOut,
): number {
  const vds = vgs - vgd;
  const d1_xc = 1 - xc;
  const vert = Math.sqrt(vds * vds + alpha);
  const veff = 0.5 * (vgs + vgd + vert) + gamma * vds;
  const vnr = d1_xc * (veff - vto);
  const vnrt = Math.sqrt(vnr * vnr + 0.04);
  const vnew = veff + 0.5 * (vnrt - vnr);
  let qrt: number, ext: number, Cgso: number;
  if (vnew < vmax) {
    ext = 0;
    qrt = Math.sqrt(1 - vnew / pb);
    Cgso = 0.5 * cgso / qrt * (1 + xc + d1_xc * vnr / vnrt);
  } else {
    const vx = 0.5 * (vnew - vmax);
    const par = 1 + vx / (pb - vmax);
    qrt = Math.sqrt(1 - vmax / pb);
    ext = vx * (1 + par) / qrt;
    Cgso = 0.5 * cgso / qrt * (1 + xc + d1_xc * vnr / vnrt) * par;
  }
  const cpm = vds / vert;
  const cplus = 0.5 * (1 + cpm);
  const cminus = cplus - cpm;
  out.cgs = Cgso * (cplus + gamma) + cgdo * (cminus + gamma);
  out.cgd = Cgso * (cminus - gamma) + cgdo * (cplus - gamma);
  return cgso * ((pb + pb) * (1 - qrt) + ext) + cgdo * (veff - vert);
}

// ---------------------------------------------------------------------------
// createJfet2Element  closure factory (polarity literal +1 NJF / -1 PJF).
// ---------------------------------------------------------------------------

function _createJfet2ElementWithType(
  type: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElement {
  // jfet2par.c:29-55 — *Given flags read parse-time givenness. The DTEMP token
  // routes through JFET2_DTEMP (jfet2par.c:33-36), which sets JFET2temp /
  // JFET2tempGiven and never JFET2dtemp / JFET2dtempGiven — so a netlisted dtemp=
  // marks tempGiven, leaving dtempGiven false (JFET2dtempGiven is set nowhere in
  // ngspice, so the jfet2temp.c:85-87 dtemp=0 default always fires).
  const given: Jfet2GivenFlags = {
    hfgamGiven: props.isModelParamGiven("HFGAM"),
    tnomGiven: props.isModelParamGiven("TNOM"),
    tempGiven: props.isModelParamGiven("TEMP") || props.isModelParamGiven("DTEMP"),
    dtempGiven: false,
  };
  let icVDSGiven = props.isModelParamGiven("ICVDS");
  let icVGSGiven = props.isModelParamGiven("ICVGS");
  let areaGiven = props.isModelParamGiven("AREA");
  let mGiven = props.isModelParamGiven("M");

  const p: Jfet2Params = {
    BETA: props.getModelParam<number>("BETA"),
    VTO: props.getModelParam<number>("VTO"),
    LAMBDA: props.getModelParam<number>("LAMBDA"),
    ACGAM: props.getModelParam<number>("ACGAM"),
    AF: props.getModelParam<number>("AF"),
    CAPDS: props.getModelParam<number>("CAPDS"),
    CAPGD: props.getModelParam<number>("CAPGD"),
    CAPGS: props.getModelParam<number>("CAPGS"),
    DELTA: props.getModelParam<number>("DELTA"),
    HFETA: props.getModelParam<number>("HFETA"),
    HFE1: props.getModelParam<number>("HFE1"),
    HFE2: props.getModelParam<number>("HFE2"),
    HFG1: props.getModelParam<number>("HFG1"),
    HFG2: props.getModelParam<number>("HFG2"),
    MVST: props.getModelParam<number>("MVST"),
    MXI: props.getModelParam<number>("MXI"),
    FC: props.getModelParam<number>("FC"),
    IBD: props.getModelParam<number>("IBD"),
    IS: props.getModelParam<number>("IS"),
    FNCOEF: props.getModelParam<number>("FNCOEF"),
    LFGAM: props.getModelParam<number>("LFGAM"),
    LFG1: props.getModelParam<number>("LFG1"),
    LFG2: props.getModelParam<number>("LFG2"),
    N: props.getModelParam<number>("N"),
    P: props.getModelParam<number>("P"),
    PHI: props.getModelParam<number>("PHI"),
    Q: props.getModelParam<number>("Q"),
    RD: props.getModelParam<number>("RD"),
    RS: props.getModelParam<number>("RS"),
    TAUD: props.getModelParam<number>("TAUD"),
    TAUG: props.getModelParam<number>("TAUG"),
    VBD: props.getModelParam<number>("VBD"),
    VER: props.getModelParam<number>("VER"),
    VST: props.getModelParam<number>("VST"),
    XC: props.getModelParam<number>("XC"),
    XI: props.getModelParam<number>("XI"),
    Z: props.getModelParam<number>("Z"),
    HFGAM: props.getModelParam<number>("HFGAM"),
    TNOM: props.getModelParam<number>("TNOM"),
    AREA: props.getModelParam<number>("AREA"),
    M: props.getModelParam<number>("M"),
    TEMP: props.getModelParam<number>("TEMP"),
    DTEMP: props.getModelParam<number>("DTEMP"),
    OFF: props.getModelParam<number>("OFF"),
    ICVDS: props.getModelParam<number>("ICVDS"),
    ICVGS: props.getModelParam<number>("ICVGS"),
  };

  // jfet2par.c:33-36 — a netlisted dtemp= routes through JFET2_DTEMP, which
  // stores value into JFET2temp (not JFET2dtemp): the operating temperature is
  // the dtemp value itself. Seed TEMP from DTEMP so the temp pass reads it.
  if (props.isModelParamGiven("DTEMP")) {
    p.TEMP = p.DTEMP;
  }

  let tp: Jfet2TempParams = computeJfet2TempParams(p, given, {
    cktTemp: REFTEMP,
    cktNomTemp: REFTEMP,
  });

  // Reusable PS out-structs (single-threaded; consumed before the next call).
  const idsOut: PsIdsOut = { igs: 0, igd: 0, ggs: 0, ggd: 0, gm: 0, gds: 0 };

  class Jfet2AnalogElement extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.JFET2;
    readonly deviceFamily: DeviceFamily = "JFET2";
    readonly stateSchema: StateSchema = JFET2_SCHEMA;
    readonly stateSize: number = JFET2_SCHEMA.size;

    private readonly _polarity: 1 | -1 = type;
    private _icheckLimited = false;

    // Internal nodes (jfet2set.c:55-98).
    private _sourcePrimeNode = -1;
    private _drainPrimeNode = -1;

    // TSTALLOC handles (jfet2set.c:106-120).
    private _hDDP = -1; private _hGDP = -1; private _hGSP = -1; private _hSSP = -1;
    private _hDPD = -1; private _hDPG = -1; private _hDPSP = -1;
    private _hSPG = -1; private _hSPS = -1; private _hSPDP = -1;
    private _hDD = -1; private _hGG = -1; private _hSS = -1;
    private _hDPDP = -1; private _hSPSP = -1;

    private readonly _internalLabels: string[] = [];

    getInternalNodeLabels(): readonly string[] {
      return this._internalLabels;
    }

    // -----------------------------------------------------------------------
    // Part C — setup (rebuild of JFET2setup, jfet2set.c:19-124).
    // -----------------------------------------------------------------------
    setup(ctx: SetupContext): void {
      const solver = ctx.solver;
      const gateNode = this.pinNodes.get("G")!;
      const sourceNode = this.pinNodes.get("S")!;
      const drainNode = this.pinNodes.get("D")!;

      // jfet2set.c:52-53 — allocate the state block.
      this._stateBase = ctx.allocStates(this.stateSize);

      this._internalLabels.length = 0;
      // jfet2set.c:55-76 — source-prime node iff rs != 0, else collapse to source.
      if (p.RS === 0) {
        this._sourcePrimeNode = sourceNode;
      } else {
        this._sourcePrimeNode = ctx.makeVolt(this.label, "source");
        this._internalLabels.push("source");
      }
      // jfet2set.c:77-98 — drain-prime node iff rd != 0, else collapse to drain.
      if (p.RD === 0) {
        this._drainPrimeNode = drainNode;
      } else {
        this._drainPrimeNode = ctx.makeVolt(this.label, "drain");
        this._internalLabels.push("drain");
      }

      const sp = this._sourcePrimeNode;
      const dp = this._drainPrimeNode;

      // jfet2set.c:106-120 — 15 matrix elements in ngspice TSTALLOC order.
      this._hDDP  = solver.allocElement(drainNode,  dp);          // :106 drainDrainPrime
      this._hGDP  = solver.allocElement(gateNode,   dp);          // :107 gateDrainPrime
      this._hGSP  = solver.allocElement(gateNode,   sp);          // :108 gateSourcePrime
      this._hSSP  = solver.allocElement(sourceNode, sp);          // :109 sourceSourcePrime
      this._hDPD  = solver.allocElement(dp,         drainNode);   // :110 drainPrimeDrain
      this._hDPG  = solver.allocElement(dp,         gateNode);    // :111 drainPrimeGate
      this._hDPSP = solver.allocElement(dp,         sp);          // :112 drainPrimeSourcePrime
      this._hSPG  = solver.allocElement(sp,         gateNode);    // :113 sourcePrimeGate
      this._hSPS  = solver.allocElement(sp,         sourceNode);  // :114 sourcePrimeSource
      this._hSPDP = solver.allocElement(sp,         dp);          // :115 sourcePrimeDrainPrime
      this._hDD   = solver.allocElement(drainNode,  drainNode);   // :116 drainDrain
      this._hGG   = solver.allocElement(gateNode,   gateNode);    // :117 gateGate
      this._hSS   = solver.allocElement(sourceNode, sourceNode);  // :118 sourceSource
      this._hDPDP = solver.allocElement(dp,         dp);          // :119 drainPrimeDrainPrime
      this._hSPSP = solver.allocElement(sp,         sp);          // :120 sourcePrimeSourcePrime
    }

    // -----------------------------------------------------------------------
    // Part E — PSids (psmodel.c:41-205). DC drain current + conductances.
    //
    // The s0/s1 trap+power state reads/writes (VTRAP/VGSTRAP/PAVE) happen here,
    // matching the VGDTRAP_NOW/VGSTRAP_NOW/POWR_NOW macros (psmodel.h:47-52).
    // -----------------------------------------------------------------------
    private _psIds(ctx: LoadContext, vgs: number, vgd: number, out: PsIdsOut): number {
      const FX = -10.0;                          // psmodel.c:55
      const MX = 40.0;                           // psmodel.c:56
      const EMX = 2.353852668370199842e17;       // psmodel.c:57 exp(MX)

      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const base = this._stateBase;
      const mode = ctx.cktMode;
      const area = p.AREA;

      let idrain: number, arg: number;

      // psmodel.c:62-105 — gate junction diodes.
      let zz: number;
      {
        // psmodel.c:64-86 — gate-junction forward conduction.
        const Gmin = ctx.cktGmin;
        const Vt = tp.vt * p.N;                  // psmodel.h:66 NVT = JFET2temp*CONSTKoverQ*n
        const isat = tp.tSatCur * area;          // psmodel.h:75 IS = tSatCur
        if ((arg = vgs / Vt) > FX) {
          if (arg < MX) { out.ggs = (zz = isat * Math.exp(arg)) / Vt + Gmin; out.igs = zz - isat + Gmin * vgs; }
          else          { out.ggs = (zz = isat * EMX) / Vt + Gmin;           out.igs = zz * (arg - MX + 1) - isat + Gmin * vgs; }
        } else          { out.ggs = Gmin;                                    out.igs = -isat + Gmin * vgs; }
        if ((arg = vgd / Vt) > FX) {
          if (arg < MX) { out.ggd = (zz = isat * Math.exp(arg)) / Vt + Gmin; out.igd = zz - isat + Gmin * vgd; }
          else          { out.ggd = (zz = isat * EMX) / Vt + Gmin;           out.igd = zz * (arg - MX + 1) - isat + Gmin * vgd; }
        } else          { out.ggd = Gmin;                                    out.igd = -isat + Gmin * vgd; }
      }
      {
        // psmodel.c:87-104 — gate-junction reverse 'breakdown' conduction.
        const Vbd = p.VBD;
        const ibd = p.IBD * area;
        if ((arg = -vgs / Vbd) > FX) {
          if (arg < MX) { out.ggs += (zz = ibd * Math.exp(arg)) / Vbd; out.igs -= zz - ibd; }
          else          { out.ggs += (zz = ibd * EMX) / Vbd;           out.igs -= zz * ((arg - MX) + 1) - ibd; }
        } else            out.igs += ibd;
        if ((arg = -vgd / Vbd) > FX) {
          if (arg < MX) { out.ggd += (zz = ibd * Math.exp(arg)) / Vbd; out.igd -= zz - ibd; }
          else          { out.ggd += (zz = ibd * EMX) / Vbd;           out.igd -= zz * ((arg - MX) + 1) - ibd; }
        } else            out.igd += ibd;
      }

      // psmodel.c:107-202 — compute drain current and derivatives.
      let gm: number, gds: number;
      const vdst = vgs - vgd;
      const stepofour = ctx.dt * 0.25;           // psmodel.c:110 STEP*FOURTH
      {
        // psmodel.c:111-180 — rate-dependent threshold modulation.
        let vgst: number, dvgd: number, dvgs: number, h: number;
        let vgdtrap: number, vgstrap: number, eta: number, gam: number;
        const vto = p.VTO;
        const LFg = p.LFGAM, LFg1 = p.LFG1, LFg2 = p.LFG2;
        const HFg = tp.hfgam, HFg1 = p.HFG1, HFg2 = p.HFG2;
        const HFe = p.HFETA, HFe1 = p.HFE1, HFe2 = p.HFE2;
        if (mode & MODETRAN) {                   // psmodel.h:42 TRAN_ANAL
          const taug = p.TAUG;
          h = taug / (taug + stepofour); h *= h; h *= h; // 4th power
          // VGDTRAP -> slot VTRAP (16); VGSTRAP -> slot VGSTRAP (17).
          s0[base + SLOT_VTRAP]   = vgdtrap = h * s1[base + SLOT_VTRAP]   + (1 - h) * vgd;
          s0[base + SLOT_VGSTRAP] = vgstrap = h * s1[base + SLOT_VGSTRAP] + (1 - h) * vgs;
        } else {
          h = 0;
          s0[base + SLOT_VTRAP]   = vgdtrap = vgd;
          s0[base + SLOT_VGSTRAP] = vgstrap = vgs;
        }
        vgst = vgs - vto;
        vgst -= (LFg - LFg1 * vgstrap + LFg2 * vgdtrap) * vgdtrap;
        vgst += (eta = HFe - HFe1 * vgdtrap + HFe2 * vgstrap) * (dvgs = vgstrap - vgs);
        vgst += (gam = HFg - HFg1 * vgstrap + HFg2 * vgdtrap) * (dvgd = vgdtrap - vgd);
        {
          // psmodel.c:131-176 — exponential subthreshold effect ids(vgst,vdst).
          let vgt: number, subfac: number;
          const mvst = p.MVST;
          const vst = p.VST * (1 + mvst * vdst);
          if (vgst > FX * vst) {
            if (vgst > (arg = MX * vst)) {       // numerically large
              vgt = (EMX / (subfac = EMX + 1)) * (vgst - arg) + arg;
            } else {                              // limit gate bias exponentially
              vgt = vst * Math.log(subfac = (1 + Math.exp(vgst / vst)));
            }
            {
              // psmodel.c:140-169 — dual power-law ids(vgt,vdst).
              const mQ = p.Q;
              const PmQ = p.P - mQ;
              const dvpd_dvdst = tp.d3 * Math.pow(vgt, PmQ);
              const vdp = vdst * dvpd_dvdst;     // D3 = P/Q/((VBI-vto)^PmQ)
              {
                // psmodel.c:145-166 — early saturation effect ids(vgt,vdp).
                const za = tp.za;                // sqrt(1 + Z)/2
                const mxi = p.MXI;
                const vsatFac = vgt / (mxi * vgt + tp.xiwoo);
                const vsat = vgt / (1 + vsatFac);
                const aa = za * vdp + vsat / 2.0;
                const a_aa = aa - vsat;
                const rpt = Math.sqrt(aa * aa + (arg = vsat * vsat * p.Z / 4.0));
                const a_rpt = Math.sqrt(a_aa * a_aa + arg);
                const vdt = (rpt - a_rpt);
                const dvdt_dvdp = za * (aa / rpt - a_aa / a_rpt);
                const dvdt_dvgt = (vdt - vdp * dvdt_dvdp)
                      * (1 + mxi * vsatFac * vsatFac) / (1 + vsatFac) / vgt;
                {
                  // psmodel.c:158-163 — intrinsic Q-law FET equation ids(vgt,vdt).
                  gds = Math.pow(vgt - vdt, mQ - 1);
                  idrain = vdt * gds + vgt * (gm = Math.pow(vgt, mQ - 1) - gds);
                  gds *= mQ;
                  gm *= mQ;
                }
                gm += gds * dvdt_dvgt;
                gds *= dvdt_dvdp;
              }
              gm += gds * PmQ * vdp / vgt;
              gds *= dvpd_dvdst;
            }
            arg = 1 - 1 / subfac;
            if (vst !== 0) gds += gm * p.VST * mvst * (vgt - vgst * arg) / vst;
            gm *= arg;
          } else {                                // in extreme cut-off (numerically)
            idrain = gm = gds = 0.0;
          }
        }
        // psmodel.c:177-179 — feedback recombination of gm/gds.
        gds += gm * (arg = h * gam +
                   (1 - h) * (HFe1 * dvgs - HFg2 * dvgd + 2 * LFg2 * vgdtrap - LFg1 * vgstrap + LFg));
        gm *= 1 - h * eta + (1 - h) * (HFe2 * dvgs - HFg1 * dvgd + LFg1 * vgdtrap) - arg;
      }
      {
        // psmodel.c:181-187 — apply channel length modulation and beta scaling.
        const lambda = p.LAMBDA;
        const beta = p.BETA * area;
        gm *= (arg = beta * (1 + lambda * vdst));
        gds = beta * lambda * idrain + gds * arg;
        idrain *= arg;
      }
      {
        // psmodel.c:189-202 — apply thermal reduction of drain current.
        let h: number, pfac: number, pAverage: number;
        const delta = p.DELTA / area;
        if (mode & MODETRAN) {
          const taud = p.TAUD;
          h = taud / (taud + stepofour); h *= h; h *= h;
          s0[base + SLOT_PAVE] = pAverage = h * s1[base + SLOT_PAVE] + (1 - h) * vdst * idrain;
        } else {
          s0[base + SLOT_PAVE] = s1[base + SLOT_PAVE] = pAverage = vdst * idrain; h = 0;
        }
        idrain /= (pfac = 1 + pAverage * delta);
        out.gm = gm * (arg = (h * delta * s1[base + SLOT_PAVE] + 1) / pfac / pfac);
        out.gds = gds * arg - (1 - h) * delta * idrain * idrain;
      }
      return idrain;
    }

    // -----------------------------------------------------------------------
    // Part F — PScharge (psmodel.c:253-293). Gate charge + capgs/capgd.
    // Returns [capgs, capgd]; writes QGS/QGD state.
    // -----------------------------------------------------------------------
    private _psCharge(ctx: LoadContext, vgs: number, vgd: number): { capgs: number; capgd: number } {
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const base = this._stateBase;
      const mode = ctx.cktMode;
      const area = p.AREA;

      // psmodel.c:267-274 — QGG macro bindings.
      const czgs = tp.tCGS * area;
      const czgd = tp.tCGD * area;
      const vto = p.VTO;
      const alpha = tp.alpha;
      const xc = p.XC;
      const vmax = tp.corDepCap;
      const phib = tp.tGatePot;
      const gac = p.ACGAM;

      const a: PsCapsOut = { cgs: 0, cgd: 0 };

      if (!(mode & MODETRAN)) {
        // psmodel.c:276-278 — single qgg call; fill all four charge cells.
        const q = qgg(vgs, vgd, gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
        s0[base + SLOT_QGS] = s0[base + SLOT_QGD] = s1[base + SLOT_QGS] = s1[base + SLOT_QGD] = q;
        return { capgs: a.cgs, capgd: a.cgd };
      } else {
        // psmodel.c:279-292 — four-point midpoint differencing for transient charge.
        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = s1[base + SLOT_VGD];
        const qgga = qgg(vgs,  vgd,  gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
        const cgsna = a.cgs, cgdna = a.cgd;
        const qggb = qgg(vgs1, vgd,  gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
        const cgdnb = a.cgd;
        const qggc = qgg(vgs,  vgd1, gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
        const cgsnc = a.cgs;
        const qggd = qgg(vgs1, vgd1, gac, phib, alpha, vto, vmax, xc, czgs, czgd, a);
        s0[base + SLOT_QGS] = s1[base + SLOT_QGS] + 0.5 * (qgga - qggb + qggc - qggd);
        s0[base + SLOT_QGD] = s1[base + SLOT_QGD] + 0.5 * (qgga - qggc + qggb - qggd);
        return { capgs: 0.5 * (cgsna + cgsnc), capgd: 0.5 * (cgdna + cgdnb) };
      }
    }

    // -----------------------------------------------------------------------
    // Part H — PSacload (psmodel.c:298-359). Complex gm/gds with taug/taud
    // dispersion. Writes gm/xgm/gds/xgds into `out`.
    // -----------------------------------------------------------------------
    private _psAcLoad(
      vgs: number, vgd: number, ids: number, omega: number,
      gmIn: number, gdsIn: number, out: PsAcOut,
    ): void {
      let arg: number;
      const vds = vgs - vgd;
      const LFgam = p.LFGAM;
      const LFg1 = p.LFG1;
      const LFg2 = p.LFG2 * vgd;
      const HFg1 = p.HFG1;
      const HFg2 = p.HFG2 * vgd;
      const HFeta = p.HFETA;
      const HFe1 = p.HFE1;
      const HFe2 = p.HFE2 * vgs;
      const hfgam = tp.hfgam - HFg1 * vgs + HFg2;
      const eta = HFeta - HFe1 * vgd + HFe2;
      const lfga = LFgam - LFg1 * vgs + LFg2 + LFg2;
      const gmo = gmIn / (1 - lfga + LFg1 * vgd);

      const wtg = p.TAUG * omega;
      const wtgdet = 1 + wtg * wtg;
      const gwtgdet = gmo / wtgdet;

      const gdsi = (arg = hfgam - lfga) * gwtgdet;
      const gdsr = arg * gmo - gdsi;
      const gmi = (eta + LFg1 * vgd) * gwtgdet + gdsi;

      const xgds = wtg * gdsi;
      const gds = gdsIn + gdsr;
      const xgm = -wtg * gmi;
      const gm = gmi + gmo * (1 - eta - hfgam);

      const delta = p.DELTA / p.AREA;
      const wtd = p.TAUD * omega;
      const wtddet = 1 + wtd * wtd;
      const fac = delta * ids;
      const del = 1 / (1 - fac * vds);
      const dd = (del - 1) / wtddet;
      const dr = del - dd;
      const di = wtd * dd;

      const cdsqr = fac * ids * del * wtd / wtddet;

      out.gm = dr * gm - di * xgm;
      out.xgm = di * gm + dr * xgm;
      out.gds = dr * gds - di * xgds + cdsqr * wtd;
      out.xgds = di * gds + dr * xgds + cdsqr;
    }

    // -----------------------------------------------------------------------
    // Part G — load (rebuild of JFET2load, jfet2load.c:21-328).
    // -----------------------------------------------------------------------
    load(ctx: LoadContext): void {
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const base = this._stateBase;
      const mode = ctx.cktMode;
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;
      const polarity = this._polarity;
      const m = p.M;

      const nodeG = this.pinNodes.get("G")!;
      const sp = this._sourcePrimeNode;
      const dp = this._drainPrimeNode;

      // jfet2load.c:71-72 — dc model parameters (area-scaled).
      const gdpr = tp.drainConduct * p.AREA;
      const gspr = tp.sourceConduct * p.AREA;
      const vt_temp = tp.vt;

      let icheck = 1;
      let bypassed = false;

      let vgs: number;
      let vgd: number;
      let cg = 0, cd = 0, cgd = 0, gm = 0, gds = 0, ggs = 0, ggd = 0;
      let cghat = 0, cdhat = 0;

      // jfet2load.c:77-197 — linearization voltage dispatch per cktMode.
      if (mode & MODEINITSMSIG) {
        // jfet2load.c:78-79 — seed from CKTstate0.
        vgs = s0[base + SLOT_VGS];
        vgd = s0[base + SLOT_VGD];
        icheck = 0;
      } else if (mode & MODEINITTRAN) {
        // jfet2load.c:81-82 — seed from CKTstate1.
        vgs = s1[base + SLOT_VGS];
        vgd = s1[base + SLOT_VGD];
        icheck = 0;
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // jfet2load.c:83-88 — UIC operating-point seed from the IC params.
        const vds = polarity * p.ICVDS;
        vgs = polarity * p.ICVGS;
        vgd = vgs - vds;
        icheck = 0;
      } else if ((mode & MODEINITJCT) && p.OFF === 0) {
        // jfet2load.c:89-92 — initJct, device on  vgs=-1, vgd=-1.
        vgs = -1;
        vgd = -1;
        icheck = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && p.OFF !== 0)) {
        // jfet2load.c:93-96 — initJct w/ OFF or initFix+OFF  zero.
        vgs = 0;
        vgd = 0;
        icheck = 0;
      } else if (mode & MODEINITPRED) {
        // jfet2load.c:99-122 — predictor xfact extrapolation + 9-slot state copy.
        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = s1[base + SLOT_VGD];
        const xfact = ctx.dt / ctx.deltaOld[1];
        s0[base + SLOT_VGS] = vgs1;
        vgs = (1 + xfact) * vgs1 - xfact * s2[base + SLOT_VGS];
        s0[base + SLOT_VGD] = vgd1;
        vgd = (1 + xfact) * vgd1 - xfact * s2[base + SLOT_VGD];
        s0[base + SLOT_CG]  = s1[base + SLOT_CG];
        s0[base + SLOT_CD]  = s1[base + SLOT_CD];
        s0[base + SLOT_CGD] = s1[base + SLOT_CGD];
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];
        s0[base + SLOT_GDS] = s1[base + SLOT_GDS];
        s0[base + SLOT_GGS] = s1[base + SLOT_GGS];
        s0[base + SLOT_GGD] = s1[base + SLOT_GGD];
        icheck = 0;
      } else {
        // jfet2load.c:128-135 — general iteration  read from CKTrhsOld with
        // polarity pre-multiply.
        const vG = voltages[nodeG];
        const vSP = voltages[sp];
        const vDP = voltages[dp];
        const vgsRaw = polarity * (vG - vSP);
        const vgdRaw = polarity * (vG - vDP);
        vgs = vgsRaw;
        vgd = vgdRaw;

        const vgsOld = s0[base + SLOT_VGS];
        const vgdOld = s0[base + SLOT_VGD];

        // jfet2load.c:139-148 — extrapolated currents for bypass + noncon gates.
        const delvgs0 = vgs - vgsOld;
        const delvgd0 = vgd - vgdOld;
        const delvds0 = delvgs0 - delvgd0;
        cghat = s0[base + SLOT_CG]
          + s0[base + SLOT_GGD] * delvgd0
          + s0[base + SLOT_GGS] * delvgs0;
        cdhat = s0[base + SLOT_CD]
          + s0[base + SLOT_GM]  * delvgs0
          + s0[base + SLOT_GDS] * delvds0
          - s0[base + SLOT_GGD] * delvgd0;

        // jfet2load.c:152-181 — bypass if solution has not changed.
        let didBypass = false;
        if (ctx.bypass && !(mode & MODEINITPRED) &&
            Math.abs(delvgs0) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(vgsOld)) + ctx.voltTol)
        if (Math.abs(delvgd0) < ctx.reltol * Math.max(Math.abs(vgd), Math.abs(vgdOld)) + ctx.voltTol)
        if (Math.abs(cghat - s0[base + SLOT_CG]) < ctx.reltol * Math.max(Math.abs(cghat), Math.abs(s0[base + SLOT_CG])) + ctx.iabstol)
        if (Math.abs(cdhat - s0[base + SLOT_CD]) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(s0[base + SLOT_CD])) + ctx.iabstol) {
          vgs = vgsOld;
          vgd = vgdOld;
          cg = s0[base + SLOT_CG];
          cd = s0[base + SLOT_CD];
          cgd = s0[base + SLOT_CGD];
          gm = s0[base + SLOT_GM];
          gds = s0[base + SLOT_GDS];
          ggs = s0[base + SLOT_GGS];
          ggd = s0[base + SLOT_GGD];
          didBypass = true;
          bypassed = true;
        }

        if (!didBypass) {
          // jfet2load.c:185-196 — limit nonlinear branch voltages: pnjlim×2 then fetlim×2.
          const vgsResult = pnjlim(vgs, vgsOld, vt_temp, tp.vcrit);
          vgs = vgsResult.value;
          icheck = vgsResult.limited ? 1 : 0;

          const vgdResult = pnjlim(vgd, vgdOld, vt_temp, tp.vcrit);
          vgd = vgdResult.value;
          if (vgdResult.limited) icheck = 1;

          if (ctx.limitingCollector) {
            ctx.limitingCollector.push({
              elementIndex: this.elementIndex ?? -1,
              label: this.label,
              junction: "GS",
              limitType: "pnjlim",
              vBefore: vgsRaw,
              vAfter: vgs,
              wasLimited: vgsResult.limited,
            });
            ctx.limitingCollector.push({
              elementIndex: this.elementIndex ?? -1,
              label: this.label,
              junction: "GD",
              limitType: "pnjlim",
              vBefore: vgdRaw,
              vAfter: vgd,
              wasLimited: vgdResult.limited,
            });
          }

          vgs = fetlim(vgs, vgsOld, p.VTO);   // jfet2load.c:193-194 DEVfetlim(model->JFET2vto)
          vgd = fetlim(vgd, vgdOld, p.VTO);
        }
      }

      this._icheckLimited = icheck === 1;

      if (!bypassed) {
        // jfet2load.c:201-212 — determine dc current and derivatives. The
        // vds-sign branch swaps the PSids argument order and corrects gds/gm.
        const vds = vgs - vgd;
        if (vds < 0.0) {
          // jfet2load.c:203-206 — inverse-mode call: swapped vgd<->vgs.
          cd = -this._psIds(ctx, vgd, vgs, idsOut);
          cgd = idsOut.igs; cg = idsOut.igd; ggd = idsOut.ggs; ggs = idsOut.ggd; gm = idsOut.gm; gds = idsOut.gds;
          gds += gm;
          gm = -gm;
        } else {
          // jfet2load.c:208-209 — normal-mode call.
          cd = this._psIds(ctx, vgs, vgd, idsOut);
          cg = idsOut.igs; cgd = idsOut.igd; ggs = idsOut.ggs; ggd = idsOut.ggd; gm = idsOut.gm; gds = idsOut.gds;
        }
        cg = cg + cgd;   // jfet2load.c:211
        cd = cd - cgd;   // jfet2load.c:212

        // jfet2load.c:214-269 — charge storage + NIintegrate for transient.
        if ((mode & (MODETRAN | MODEAC | MODEINITSMSIG)) ||
            ((mode & MODETRANOP) && (mode & MODEUIC))) {
          // jfet2load.c:219 — D-S linear cap.
          const capds = p.CAPDS * p.AREA;

          // jfet2load.c:221 — gate caps via PScharge.
          const { capgs, capgd } = this._psCharge(ctx, vgs, vgd);

          // jfet2load.c:223 — qds = capds * vds.
          s0[base + SLOT_QDS] = capds * vds;

          // jfet2load.c:228-268 — store small-signal / transient.
          if (!((mode & MODETRANOP) && (mode & MODEUIC))) {
            if (mode & MODEINITSMSIG) {
              // jfet2load.c:230-235 — store raw caps; `continue` skips stamps.
              s0[base + SLOT_QGS] = capgs;
              s0[base + SLOT_QGD] = capgd;
              s0[base + SLOT_QDS] = capds;
              return;
            }
            // jfet2load.c:239-246 — MODEINITTRAN copies state0->state1.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_QGS] = s0[base + SLOT_QGS];
              s1[base + SLOT_QGD] = s0[base + SLOT_QGD];
              s1[base + SLOT_QDS] = s0[base + SLOT_QDS];
            }

            const ag = ctx.ag;
            // jfet2load.c:247-250 — NIintegrate G-S cap; lump geq into ggs, cqgs into cg.
            {
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capgs, ag,
                s0[base + SLOT_QGS], s1[base + SLOT_QGS],
                [s2[base + SLOT_QGS], 0, 0, 0, 0], s1[base + SLOT_CQGS],
              );
              s0[base + SLOT_CQGS] = ccap;
              ggs = ggs + geq;
              cg = cg + s0[base + SLOT_CQGS];
            }
            // jfet2load.c:251-256 — NIintegrate G-D cap; lump geq into ggd, cqgd into cg/cd/cgd.
            {
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capgd, ag,
                s0[base + SLOT_QGD], s1[base + SLOT_QGD],
                [s2[base + SLOT_QGD], 0, 0, 0, 0], s1[base + SLOT_CQGD],
              );
              s0[base + SLOT_CQGD] = ccap;
              ggd = ggd + geq;
              cg = cg + s0[base + SLOT_CQGD];
              cd = cd - s0[base + SLOT_CQGD];
              cgd = cgd + s0[base + SLOT_CQGD];
            }
            // jfet2load.c:257-259 — NIintegrate D-S cap; only cd += cqds (no
            // conductance lump — the D-S susceptance enters the AC path only).
            {
              const { ccap } = niIntegrate(
                ctx.method, ctx.order, capds, ag,
                s0[base + SLOT_QDS], s1[base + SLOT_QDS],
                [s2[base + SLOT_QDS], 0, 0, 0, 0], s1[base + SLOT_CQDS],
              );
              s0[base + SLOT_CQDS] = ccap;
              cd = cd + s0[base + SLOT_CQDS];
            }
            // jfet2load.c:260-267 — MODEINITTRAN copies cqgs/cqgd/cqds state0->state1.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQGS] = s0[base + SLOT_CQGS];
              s1[base + SLOT_CQGD] = s0[base + SLOT_CQGD];
              s1[base + SLOT_CQDS] = s0[base + SLOT_CQDS];
            }
          }
        }

        // jfet2load.c:273-282 — convergence check; suppressed only when both
        // MODEINITFIX and MODEUIC are set.
        if ((!(mode & MODEINITFIX)) || (!(mode & MODEUIC))) {
          const absTol = ctx.iabstol;
          const cgNoncon = Math.abs(cghat - cg)
            >= ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + absTol;
          const cdNoncon = Math.abs(cdhat - cd)
            >  ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + absTol;
          if (this._icheckLimited || cgNoncon || cdNoncon) ctx.noncon.value++;
        }

        // jfet2load.c:283-291 — write accepted state back to state0.
        s0[base + SLOT_VGS] = vgs;
        s0[base + SLOT_VGD] = vgd;
        s0[base + SLOT_CG]  = cg;
        s0[base + SLOT_CD]  = cd;
        s0[base + SLOT_CGD] = cgd;
        s0[base + SLOT_GM]  = gm;
        s0[base + SLOT_GDS] = gds;
        s0[base + SLOT_GGS] = ggs;
        s0[base + SLOT_GGD] = ggd;
      }

      // jfet2load.c:295-324 — load current vector + y matrix (the bypass goto
      // load: lands here with the state0-reloaded conductances).
      const vds = vgs - vgd;
      const ceqgd = polarity * (cgd - ggd * vgd);
      const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
      const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

      // jfet2load.c:302-306 — RHS stamps.
      stampRHS(ctx.rhs, nodeG, m * (-ceqgs - ceqgd));
      stampRHS(ctx.rhs, dp,    m * (-cdreq + ceqgd));
      stampRHS(ctx.rhs, sp,    m * (cdreq + ceqgs));

      // jfet2load.c:310-324 — Y-matrix stamps.
      solver.stampElement(this._hDDP,  m * (-gdpr));
      solver.stampElement(this._hGDP,  m * (-ggd));
      solver.stampElement(this._hGSP,  m * (-ggs));
      solver.stampElement(this._hSSP,  m * (-gspr));
      solver.stampElement(this._hDPD,  m * (-gdpr));
      solver.stampElement(this._hDPG,  m * (gm - ggd));
      solver.stampElement(this._hDPSP, m * (-gds - gm));
      solver.stampElement(this._hSPG,  m * (-ggs - gm));
      solver.stampElement(this._hSPS,  m * (-gspr));
      solver.stampElement(this._hSPDP, m * (-gds));
      solver.stampElement(this._hDD,   m * (gdpr));
      solver.stampElement(this._hGG,   m * (ggd + ggs));
      solver.stampElement(this._hSS,   m * (gspr));
      solver.stampElement(this._hDPDP, m * (gdpr + gds + ggd));
      solver.stampElement(this._hSPSP, m * (gspr + gds + gm + ggs));
    }

    // -----------------------------------------------------------------------
    // Part H — stampAc (rebuild of JFET2acLoad, jfet2acld.c:18-91).
    // -----------------------------------------------------------------------
    stampAc(
      solver: SparseSolverStamp,
      omega: number,
      _ctx: LoadContext,
      _rhsRe: Float64Array,
      _rhsIm: Float64Array,
    ): void {
      const s0 = this._pool.states[0];
      const base = this._stateBase;
      const m = p.M;

      // jfet2acld.c:40-54 — read op-point conductances/charges, scale by omega.
      const gdpr = tp.drainConduct * p.AREA;
      const gspr = tp.sourceConduct * p.AREA;
      const gm0 = s0[base + SLOT_GM];
      const gds0 = s0[base + SLOT_GDS];
      const ggs = s0[base + SLOT_GGS];
      const xgs = s0[base + SLOT_QGS] * omega;
      const ggd = s0[base + SLOT_GGD];
      const xgd = s0[base + SLOT_QGD] * omega;
      const vgs = s0[base + SLOT_VGS];
      const vgd = s0[base + SLOT_VGD];
      const cd = s0[base + SLOT_CD];

      const o: PsAcOut = { gm: gm0, xgm: 0, gds: gds0, xgds: 0 };
      this._psAcLoad(vgs, vgd, cd, omega, gm0, gds0, o);
      const gm = o.gm;
      const gds = o.gds;
      const xgm = o.xgm;
      const xgds = o.xgds + s0[base + SLOT_QDS] * omega;   // jfet2acld.c:54

      // jfet2acld.c:58-86 — complex stamps. ngspice `-=` rendered as a stamp of
      // the negated expression; imaginary terms via stampElementImag.
      solver.stampElementImag(this._hDPDP, m * (xgds));               // :58
      solver.stampElementImag(this._hSPSP, m * (xgds + xgm));         // :59
      solver.stampElementImag(this._hDPG,  m * (xgm));                // :60
      solver.stampElementImag(this._hDPSP, -(m * (xgds + xgm)));      // :61
      solver.stampElementImag(this._hSPG,  -(m * (xgm)));             // :62
      solver.stampElementImag(this._hSPDP, -(m * (xgds)));            // :63

      solver.stampElement(this._hDD,    m * (gdpr));                  // :65
      solver.stampElement(this._hGG,    m * (ggd + ggs));            // :66
      solver.stampElementImag(this._hGG, m * (xgd + xgs));           // :67
      solver.stampElement(this._hSS,    m * (gspr));                 // :68
      solver.stampElement(this._hDPDP,  m * (gdpr + gds + ggd));     // :69
      solver.stampElementImag(this._hDPDP, m * (xgd));              // :70
      solver.stampElement(this._hSPSP,  m * (gspr + gds + gm + ggs)); // :71
      solver.stampElementImag(this._hSPSP, m * (xgs));             // :72
      solver.stampElement(this._hDDP,   -(m * (gdpr)));            // :73 -=
      solver.stampElement(this._hGDP,   -(m * (ggd)));            // :74 -=
      solver.stampElementImag(this._hGDP, -(m * (xgd)));         // :75 -=
      solver.stampElement(this._hGSP,   -(m * (ggs)));            // :76 -=
      solver.stampElementImag(this._hGSP, -(m * (xgs)));         // :77 -=
      solver.stampElement(this._hSSP,   -(m * (gspr)));           // :78 -=
      solver.stampElement(this._hDPD,   -(m * (gdpr)));           // :79 -=
      solver.stampElement(this._hDPG,   m * (-ggd + gm));         // :80
      solver.stampElementImag(this._hDPG, -(m * (xgd)));         // :81 -=
      solver.stampElement(this._hDPSP,  m * (-gds - gm));         // :82
      solver.stampElement(this._hSPG,   m * (-ggs - gm));         // :83
      solver.stampElementImag(this._hSPG, -(m * (xgs)));        // :84 -=
      solver.stampElement(this._hSPS,   -(m * (gspr)));          // :85 -=
      solver.stampElement(this._hSPDP,  -(m * (gds)));           // :86 -=
    }

    // -----------------------------------------------------------------------
    // Part K — LTE / truncation (rebuild of JFET2trunc, jfet2trun.c:19-33).
    // CKTterr on JFET2qgs and JFET2qgd only — NOT qds.
    // -----------------------------------------------------------------------
    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const s3 = this._pool.states[3];
      const base = this._stateBase;
      let minDt = Infinity;
      const pairs: [number, number][] = [
        [SLOT_QGS, SLOT_CQGS],
        [SLOT_QGD, SLOT_CQGD],
      ];
      for (const [slotQ, slotCcap] of pairs) {
        const dtSlot = cktTerr(
          dt, deltaOld, order, method,
          s0[base + slotQ], s1[base + slotQ], s2[base + slotQ], s3[base + slotQ],
          s0[base + slotCcap], s1[base + slotCcap], lteParams,
        );
        if (dtSlot < minDt) minDt = dtSlot;
      }
      return minDt;
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      const s0 = this._pool.states[0];
      const polarity = this._polarity;
      // jfet2 ask JFET2_CD/JFET2_CG: id = type * cd, ig = type * cg.
      const id = polarity * s0[this._stateBase + SLOT_CD];
      const ig = polarity * s0[this._stateBase + SLOT_CG];
      // pinLayout order [G, S, D]; KCL iS = -(ig + id).
      const iS = -(ig + id);
      return [ig, iS, id];
    }

    // -----------------------------------------------------------------------
    // computeTemperature — engine-driven temperature pass (jfet2temp.c).
    // -----------------------------------------------------------------------
    computeTemperature(ctx: TempContext): void {
      tp = computeJfet2TempParams(p, given, {
        cktTemp: ctx.cktTemp,
        cktNomTemp: ctx.cktNomTemp,
      });
      this._lastCtx = ctx;
    }

    private _lastCtx: { cktTemp: number; cktNomTemp: number } = {
      cktTemp: REFTEMP,
      cktNomTemp: REFTEMP,
    };

    // -----------------------------------------------------------------------
    // Part I — parameter setters (JFET2param + JFET2mParam).
    // -----------------------------------------------------------------------
    setParam(key: string, value: number): void {
      // jfet2par.c:29-55 — instance setters set their *Given bit. The DTEMP case
      // (jfet2par.c:33-36) writes JFET2temp/JFET2tempGiven — NOT dtemp — so the
      // raw value becomes the operating temperature and the CKTtemp+dtemp default
      // is bypassed (this matches jfet2par.c, which differs from jfetpar.c:29-32).
      if (key === "TEMP") { p.TEMP = value; given.tempGiven = true; }
      else if (key === "DTEMP") { p.TEMP = value; given.tempGiven = true; }
      else if (key === "AREA") { p.AREA = value; areaGiven = true; }
      else if (key === "M") { p.M = value; mGiven = true; }
      else if (key === "ICVDS") { p.ICVDS = value; icVDSGiven = true; }
      else if (key === "ICVGS") { p.ICVGS = value; icVGSGiven = true; }
      // jfet2mpar.c:24-30 — tnom + the generic model-card param loop.
      else if (key === "TNOM") { p.TNOM = value; given.tnomGiven = true; }
      else if (key === "HFGAM") { p.HFGAM = value; given.hfgamGiven = true; }

      void areaGiven; void mGiven; void icVDSGiven; void icVGSGiven;

      // jfet2par.c:33-36 — DTEMP routes to JFET2temp above; never write JFET2dtemp.
      if (key !== "DTEMP" && key in p) {
        p[key] = value;
        // Model-param writes recompute the temperature-dependent set
        // (hot-loadable params, system requirement).
        tp = computeJfet2TempParams(p, given, this._lastCtx);
      } else if (key === "DTEMP") {
        // TEMP changed via the DTEMP alias — recompute the temperature set.
        tp = computeJfet2TempParams(p, given, this._lastCtx);
      }
    }
  }

  return new Jfet2AnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// Public factory entry points
// ---------------------------------------------------------------------------

export function createJfet2NElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createJfet2ElementWithType(1, pinNodes, props);
}

export function createJfet2PElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createJfet2ElementWithType(-1, pinNodes, props);
}

// ---------------------------------------------------------------------------
// Internal-node label helper (tests / registry consumers).
// ---------------------------------------------------------------------------

export function getJfet2InternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  // jfet2set.c:55,77 — source-prime allocated before drain-prime.
  if (props.getModelParam<number>("RS") !== 0) labels.push("source");
  if (props.getModelParam<number>("RD") !== 0) labels.push("drain");
  return labels;
}

// ---------------------------------------------------------------------------
// Part M — Jfet2NElement + Jfet2PElement  CircuitElement (visual).
// ---------------------------------------------------------------------------

function buildJfet2NPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function buildJfet2PPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function drawJfet2Body(ctx: RenderContext, signals: PinVoltageAccess | undefined, gateArrowInward: boolean): void {
  const vG = signals?.getPinVoltage("G");
  const vD = signals?.getPinVoltage("D");
  const vS = signals?.getPinVoltage("S");

  ctx.save();
  ctx.setColor("COMPONENT");
  ctx.setLineWidth(1);

  // Channel bar.
  ctx.drawPolygon(
    [
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3.375, y: 1 },
      { x: 3.375, y: -1 },
    ],
    true,
  );

  // Gate arrow (PJF points outward from the channel; NJF points inward).
  if (gateArrowInward) {
    ctx.drawPolygon(
      [
        { x: 3.125, y: 0 },
        { x: 2.625, y: -0.1875 },
        { x: 2.625, y: 0.1875 },
      ],
      true,
    );
  } else {
    ctx.drawPolygon(
      [
        { x: 2.625, y: 0 },
        { x: 3.125, y: -0.1875 },
        { x: 3.125, y: 0.1875 },
      ],
      true,
    );
  }

  drawColoredLead(ctx, signals, vG, 0, 0, gateArrowInward ? 3.125 : 2.625, 0);
  drawColoredLead(ctx, signals, vD, 4, -1, 4, -0.5);
  ctx.drawLine(4, -0.5, 3.375, -0.5);
  drawColoredLead(ctx, signals, vS, 4, 1, 4, 0.5);
  ctx.drawLine(4, 0.5, 3.375, 0.5);

  ctx.restore();
}

export class Jfet2NElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JFET2N", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildJfet2NPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    drawJfet2Body(ctx, signals, true);
  }
}

export class Jfet2PElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("JFET2P", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildJfet2PPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    drawJfet2Body(ctx, signals, false);
  }
}

// ---------------------------------------------------------------------------
// Property definitions + attribute mappings
// ---------------------------------------------------------------------------

const JFET2_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const JFET2_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Component definitions (registered in register-all.ts).
// ---------------------------------------------------------------------------

function jfet2NCircuitFactory(props: PropertyBag): Jfet2NElement {
  return new Jfet2NElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function jfet2PCircuitFactory(props: PropertyBag): Jfet2PElement {
  return new Jfet2PElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const Jfet2NDefinition: StandaloneComponentDefinition = {
  name: "JFET2N",
  typeId: -1,
  factory: jfet2NCircuitFactory,
  pinLayout: buildJfet2NPinDeclarations(),
  voltageProbes: [
    { name: "Vds", pos: "D", neg: "S" },
    { name: "Vgs", pos: "G", neg: "S" },
  ],
  propertyDefs: JFET2_PROPERTY_DEFS,
  attributeMap: JFET2_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel JFET2  Parker-Skellern short-channel JFET/MESFET model.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Drain current with rate-dependent threshold trapping, dual power-law,\n" +
    "early-saturation, channel-length modulation, and thermal self-reduction;\n" +
    "Statz gate-charge model; optional rd/rs series resistances.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createJfet2NElement,
      paramDefs: JFET2_PARAM_DEFS,
      params: JFET2_PARAM_DEFAULTS,
      spice: { device: "JFET2", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice",
};

export const Jfet2PDefinition: StandaloneComponentDefinition = {
  name: "JFET2P",
  typeId: -1,
  factory: jfet2PCircuitFactory,
  pinLayout: buildJfet2PPinDeclarations(),
  voltageProbes: [
    { name: "Vsd", pos: "S", neg: "D" },
    { name: "Vsg", pos: "S", neg: "G" },
  ],
  propertyDefs: JFET2_PROPERTY_DEFS,
  attributeMap: JFET2_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel JFET2  Parker-Skellern short-channel JFET/MESFET model.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Drain current with rate-dependent threshold trapping, dual power-law,\n" +
    "early-saturation, channel-length modulation, and thermal self-reduction;\n" +
    "Statz gate-charge model; optional rd/rs series resistances.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createJfet2PElement,
      paramDefs: JFET2_PARAM_DEFS,
      params: JFET2_PARAM_DEFAULTS,
      spice: { device: "JFET2", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice",
};
