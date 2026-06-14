/**
 * N-channel JFET analog component.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/jfet/jfetload.c::JFETload`.
 * Single-pass `load()` per device per NR iteration.
 * Gate-junction caps lump inline into the stamps per `jfetload.c:477-492`.
 *
 * Only slots with direct ngspice correspondence in `jfetdefs.h:154-166` are
 * declared.
 *
 * NJFET and PJFET are each self-contained closure
 * factories. No shared abstract class. Sign-polarity is a literal `+1`
 * constant below (N-channel); the P-channel sibling in `pjfet.ts` carries
 * its own `-1` literal.
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
  MODETRAN, MODEAC, MODETRANOP, MODEUIC, MODEDCTRANCURVE,
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

const CONSTroot2 = Math.SQRT2;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: NJFET_PARAM_DEFS, defaults: NJFET_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: -2.0,  unit: "V",    description: "Pinch-off (threshold) voltage" },
    BETA:   { default: 1e-4,  unit: "A/V²", description: "Transconductance coefficient" },
    LAMBDA: { default: 0.0,   unit: "1/V",  description: "Channel-length modulation" },
  },
  secondary: {
    IS:   { default: 1e-14, unit: "A",  description: "Gate junction saturation current" },
    N:    { default: 1.0,               description: "Gate junction emission coefficient" },
    CGS:  { default: 0,     unit: "F",  description: "Gate-source zero-bias capacitance" },
    CGD:  { default: 0,     unit: "F",  description: "Gate-drain zero-bias capacitance" },
    PB:   { default: 1.0,   unit: "V",  description: "Gate junction built-in potential" },
    FC:   { default: 0.5,               description: "Forward-bias capacitance coefficient" },
    RD:   { default: 0,     unit: "Ω",  description: "Drain ohmic resistance" },
    RS:   { default: 0,     unit: "Ω",  description: "Source ohmic resistance" },
    B:      { default: 1.0,               description: "Sydney University doping-tail parameter" },
    TCV:    { default: 0.0,   unit: "V/K", description: "Threshold voltage temperature coefficient" },
    VTOTC:  { default: 0.0,   unit: "V/K", spiceName: "vtotc", description: "Threshold voltage temperature coefficient alternative (jfet.c:71 JFET_MOD_VTOTC)" },
    BEX:    { default: 0.0,               description: "Mobility temperature exponent" },
    BETATCE:{ default: 0.0,   unit: "%/K", spiceName: "betatce", description: "Mobility temperature exponent alternative (jfet.c:73 JFET_MOD_BETATCE)" },
    XTI:    { default: 3.0,               spiceName: "xti", description: "Gate junction saturation current temperature exponent (jfet.c:74 JFET_MOD_XTI)" },
    EG:     { default: 1.11,  unit: "eV",  spiceName: "eg", description: "Bandgap voltage (jfet.c:75 JFET_MOD_EG)" },
    KF:   { default: 0,                 description: "Flicker noise coefficient" },
    AF:   { default: 1,                 description: "Flicker noise exponent" },
    TNOM: { default: REFTEMP, unit: "K", description: "Nominal temperature for parameters", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA: { default: 1.0,               description: "Area factor" },
    M:    { default: 1.0,               description: "Parallel multiplier" },
    TEMP: { default: 300.15,  unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
    OFF:  { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    ICVDS:{ default: 0,    unit: "V",   emitGroup: { name: "IC", index: 0 }, spiceName: "icvds", description: "Initial condition for Vds (MODEUIC) (jfetpar.c:41-43 JFET_IC_VDS, vec[0])" },
    ICVGS:{ default: 0,    unit: "V",   emitGroup: { name: "IC", index: 1 }, spiceName: "icvgs", description: "Initial condition for Vgs (MODEUIC) (jfetpar.c:45-47 JFET_IC_VGS, vec[1])" },
  },
});

// ---------------------------------------------------------------------------
// JfetParams  resolved model parameters
// ---------------------------------------------------------------------------

export interface JfetParams {
  VTO: number;
  BETA: number;
  LAMBDA: number;
  IS: number;
  N: number;
  CGS: number;
  CGD: number;
  PB: number;
  FC: number;
  RD: number;
  RS: number;
  B: number;
  TCV: number;
  VTOTC: number;
  BEX: number;
  BETATCE: number;
  XTI: number;
  EG: number;
  AREA: number;
  M: number;
  KF: number;
  AF: number;
  TNOM: number;
  TEMP: number;
  OFF: number;
  ICVDS: number;
  ICVGS: number;
  [key: string]: number;
}

// ---------------------------------------------------------------------------
// State schema  JFET.
//
// Slots correspond 1:1 to `jfetdefs.h:154-166` JFETstate<n> offsets. The
// gate-junction caps lump inline per jfetload.c:477-492.
//
// Ngspice jfetdefs.h correspondences:
//   VGS=0 (JFETvgs), VGD=1 (JFETvgd), CG=2 (JFETcg), CD=3 (JFETcd),
//   CGD=4 (JFETcgd), GM=5 (JFETgm), GDS=6 (JFETgds), GGS=7 (JFETggs),
//   GGD=8 (JFETggd), QGS=9 (JFETqgs), CQGS=10 (JFETcqgs),
//   QGD=11 (JFETqgd), CQGD=12 (JFETcqgd).
// ---------------------------------------------------------------------------

export const JFET_SCHEMA: StateSchema = defineStateSchema("JfetElement", [
  { name: "VGS",  doc: "jfetdefs.h JFETvgs=0" },
  { name: "VGD",  doc: "jfetdefs.h JFETvgd=1" },
  { name: "CG",   doc: "jfetdefs.h JFETcg=2" },
  { name: "CD",   doc: "jfetdefs.h JFETcd=3" },
  { name: "CGD",  doc: "jfetdefs.h JFETcgd=4" },
  { name: "GM",   doc: "jfetdefs.h JFETgm=5" },
  { name: "GDS",  doc: "jfetdefs.h JFETgds=6" },
  { name: "GGS",  doc: "jfetdefs.h JFETggs=7" },
  { name: "GGD",  doc: "jfetdefs.h JFETggd=8" },
  { name: "QGS",  doc: "jfetdefs.h JFETqgs=9" },
  { name: "CQGS", doc: "jfetdefs.h JFETcqgs=10" },
  { name: "QGD",  doc: "jfetdefs.h JFETqgd=11" },
  { name: "CQGD", doc: "jfetdefs.h JFETcqgd=12" },
]);

// Slot indices (match JFET_SCHEMA order, mirror jfetdefs.h).
export const SLOT_VGS  = 0;
export const SLOT_VGD  = 1;
export const SLOT_CG   = 2;
export const SLOT_CD   = 3;
export const SLOT_CGD  = 4;
export const SLOT_GM   = 5;
export const SLOT_GDS  = 6;
export const SLOT_GGS  = 7;
export const SLOT_GGD  = 8;
export const SLOT_QGS  = 9;
export const SLOT_CQGS = 10;
export const SLOT_QGD  = 11;
export const SLOT_CQGD = 12;

// ---------------------------------------------------------------------------
// JFET temperature-corrected parameters (jfettemp.c port).
// ---------------------------------------------------------------------------

export interface JfetTempParams {
  /** Thermal voltage vt = temp * CONSTKoverQ. */
  vt: number;
  /** Temperature-adjusted saturation current (JFETtSatCur). */
  tSatCur: number;
  /** Temperature-adjusted gate potential (JFETtGatePot). */
  tGatePot: number;
  /** Temperature-adjusted G-S capacitance (JFETtCGS). */
  tCGS: number;
  /** Temperature-adjusted G-D capacitance (JFETtCGD). */
  tCGD: number;
  /** Critical depletion-cap voltage (JFETcorDepCap). */
  corDepCap: number;
  /** Critical voltage for pnjlim (JFETvcrit). */
  vcrit: number;
  /** Capacitance polynomial coefficient f1 (JFETf1). */
  f1: number;
  /** Model-level coefficient f2 (JFETf2). */
  f2: number;
  /** Model-level coefficient f3 (JFETf3). */
  f3: number;
  /** Temperature-adjusted threshold voltage (JFETtThreshold). */
  tThreshold: number;
  /** Temperature-adjusted beta (JFETtBeta). */
  tBeta: number;
  /** Sydney University bFac (JFETbFac). */
  bFac: number;
}

/**
 * Port of `jfettemp.c::JFETtemp`. Instance operating temperature is taken
 * from `p.TEMP` (maps to ngspice JFETtemp, configurable per device).
 */
export function computeJfetTempParams(
  p: JfetParams,
  given: { xtiGiven: boolean; vtotcGiven: boolean; betatceGiven: boolean },
): JfetTempParams {
  // jfettemp.c:43-49: model-level constants at TNOM.
  const vtnom = CONSTKoverQ * p.TNOM;
  const fact1 = p.TNOM / REFTEMP;
  const kt1 = CONSTboltz * p.TNOM;
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);
  const pbo = (p.PB - pbfact1) / fact1;
  const gmaold = (p.PB - pbo) / pbo;
  const cjfact = 1 / (1 + 0.5 * (4e-4 * (p.TNOM - REFTEMP) - gmaold));

  // jfettemp.c:64-69: FC clamp to 0.95.
  const fcClamped = p.FC > 0.95 ? 0.95 : p.FC;

  // jfettemp.c:71-73: model-level f2/f3.
  const xfc = Math.log(1 - fcClamped);
  const f2 = Math.exp((1 + 0.5) * xfc);
  const f3 = 1 - fcClamped * (1 + 0.5);

  // jfettemp.c:75-77: Sydney University bFac.
  const bFac = (1 - p.B) / (p.PB - p.VTO);

  // cite: jfettemp.c:83  instance temp from params.TEMP (maps to ngspice JFETtemp)
  const temp = p.TEMP;
  const vt = temp * CONSTKoverQ;
  const fact2 = temp / REFTEMP;
  const ratio1 = temp / p.TNOM - 1;
  // jfettemp.c:92-96: gate saturation current temperature scaling. The xti
  // branch adds the (ratio1+1)^xti factor; both legs read the bandgap eg.
  let tSatCur: number;
  if (given.xtiGiven) {
    tSatCur = p.IS * Math.exp(ratio1 * p.EG / vt) * Math.pow(ratio1 + 1, p.XTI);
  } else {
    tSatCur = p.IS * Math.exp(ratio1 * p.EG / vt);
  }
  let tCGS = p.CGS * cjfact;
  let tCGD = p.CGD * cjfact;
  const kt = CONSTboltz * temp;
  const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
  const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);
  const tGatePot = fact2 * pbo + pbfact;
  const gmanew = (tGatePot - pbo) / pbo;
  const cjfact1 = 1 + 0.5 * (4e-4 * (temp - REFTEMP) - gmanew);
  tCGS *= cjfact1;
  tCGD *= cjfact1;

  // jfettemp.c:106-109.
  const corDepCap = fcClamped * tGatePot;
  const f1 = tGatePot * (1 - Math.exp((1 - 0.5) * xfc)) / (1 - 0.5);
  const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));

  // jfettemp.c:115-124: threshold and beta temperature scaling. The vtotc/
  // betatce legs select the alternative linear/exponential coefficient forms.
  let tThreshold: number;
  if (given.vtotcGiven) {
    tThreshold = p.VTO + p.VTOTC * (temp - p.TNOM);
  } else {
    tThreshold = p.VTO - p.TCV * (temp - p.TNOM);
  }
  let tBeta: number;
  if (given.betatceGiven) {
    tBeta = p.BETA * Math.pow(1.01, p.BETATCE * (temp - p.TNOM));
  } else {
    tBeta = p.BETA * Math.pow(temp / p.TNOM, p.BEX);
  }

  return {
    vt, tSatCur, tGatePot, tCGS, tCGD,
    corDepCap, vcrit, f1, f2, f3,
    tThreshold, tBeta, bFac,
  };
}

// ---------------------------------------------------------------------------
// createNJfetElement  N-channel JFET factory (polarity literal = +1).
// Single load() ported from jfetload.c line-by-line.
// No cached Float64Array state refs  pool.states[N] at call time.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NJFETElement  pool-backed analog element class (N-channel JFET).
// ---------------------------------------------------------------------------

class NJFETElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.JFET;
  readonly deviceFamily: DeviceFamily = "JFET";
  readonly stateSchema = JFET_SCHEMA;
  readonly stateSize = JFET_SCHEMA.size;

  // N-channel polarity literal (jfetdefs.h:234 `#define NJF 1`).
  private readonly _polarity: 1 = 1;

  private _params: JfetParams;
  private _tp: JfetTempParams;

  // Ephemeral per-iteration icheck flag (jfetload.c:500-508 CKTnoncon bump).
  private _icheckLimited = false;

  // cite: jfettemp.c:83-88 — JFETtempGiven mirrors PropertyBag givenness for TEMP.
  private _tempGiven: boolean;

  // jfetdefs.h model-struct *Given bits: read whether the netlist supplied each
  // temperature/bandgap parameter so the temperature pass can branch on
  // givenness (jfettemp.c:92, :115, :120).
  private _vtotcGiven: boolean;
  private _betatceGiven: boolean;
  private _xtiGiven: boolean;

  // Internal nodes allocated during setup()- jfetset.c:115-158
  private _sourcePrimeNode = -1;
  private _drainPrimeNode  = -1;

  // TSTALLOC handles- jfetset.c:166-180
  private _hDDP  = -1; private _hGDP  = -1; private _hGSP  = -1; private _hSSP  = -1;
  private _hDPD  = -1; private _hDPG  = -1; private _hDPSP = -1;
  private _hSPG  = -1; private _hSPS  = -1; private _hSPDP = -1;
  private _hDD   = -1; private _hGG   = -1; private _hSS   = -1;
  private _hDPDP = -1; private _hSPSP = -1;

  // Internal-node labels recorded in allocation order (A.7).
  private readonly _internalLabels: string[] = [];

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
    _getTime: () => number,
  ) {
    super(pinNodes);
    this._tempGiven = props.isModelParamGiven("TEMP");
    this._vtotcGiven = props.isModelParamGiven("VTOTC");
    this._betatceGiven = props.isModelParamGiven("BETATCE");
    this._xtiGiven = props.isModelParamGiven("XTI");
    this._params = {
      VTO:    props.getModelParam<number>("VTO"),
      BETA:   props.getModelParam<number>("BETA"),
      LAMBDA: props.getModelParam<number>("LAMBDA"),
      IS:     props.getModelParam<number>("IS"),
      N:      props.getModelParam<number>("N"),
      CGS:    props.getModelParam<number>("CGS"),
      CGD:    props.getModelParam<number>("CGD"),
      PB:     props.getModelParam<number>("PB"),
      FC:     props.getModelParam<number>("FC"),
      RD:     props.getModelParam<number>("RD"),
      RS:     props.getModelParam<number>("RS"),
      B:      props.getModelParam<number>("B"),
      TCV:    props.getModelParam<number>("TCV"),
      VTOTC:  props.getModelParam<number>("VTOTC"),
      BEX:    props.getModelParam<number>("BEX"),
      BETATCE:props.getModelParam<number>("BETATCE"),
      XTI:    props.getModelParam<number>("XTI"),
      EG:     props.getModelParam<number>("EG"),
      AREA:   props.getModelParam<number>("AREA"),
      M:      props.getModelParam<number>("M"),
      KF:     props.getModelParam<number>("KF"),
      AF:     props.getModelParam<number>("AF"),
      TNOM:   props.getModelParam<number>("TNOM"),
      TEMP:   props.getModelParam<number>("TEMP"),
      OFF:    props.getModelParam<number>("OFF"),
      ICVDS:  props.getModelParam<number>("ICVDS"),
      ICVGS:  props.getModelParam<number>("ICVGS"),
    };
    this._tp = computeJfetTempParams(this._params, {
      xtiGiven: this._xtiGiven,
      vtotcGiven: this._vtotcGiven,
      betatceGiven: this._betatceGiven,
    });
  }

  get _p(): JfetParams {
    return this._params;
  }

  setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
    const solver     = ctx.solver;
    const gateNode   = this.pinNodes.get("G")!;
    const sourceNode = this.pinNodes.get("S")!;
    const drainNode  = this.pinNodes.get("D")!;

    // State slots- jfetset.c:112-113
    this._stateBase = ctx.allocStates(this.stateSize);

    // Internal nodes- jfetset.c:115-158
    // Source prime BEFORE drain prime (ngspice order)
    this._internalLabels.length = 0;
    if (this._params.RS === 0) {
      this._sourcePrimeNode = sourceNode;
    } else {
      this._sourcePrimeNode = ctx.makeVolt(this.label, "source");
      this._internalLabels.push("source");
    }
    if (this._params.RD === 0) {
      this._drainPrimeNode = drainNode;
    } else {
      this._drainPrimeNode = ctx.makeVolt(this.label, "drain");
      this._internalLabels.push("drain");
    }

    const sp = this._sourcePrimeNode;
    const dp = this._drainPrimeNode;

    // TSTALLOC sequence- jfetset.c:166-180
    this._hDDP  = solver.allocElement(drainNode,  dp);          // (1)
    this._hGDP  = solver.allocElement(gateNode,   dp);          // (2)
    this._hGSP  = solver.allocElement(gateNode,   sp);          // (3)
    this._hSSP  = solver.allocElement(sourceNode, sp);          // (4)
    this._hDPD  = solver.allocElement(dp,         drainNode);   // (5)
    this._hDPG  = solver.allocElement(dp,         gateNode);    // (6)
    this._hDPSP = solver.allocElement(dp,         sp);          // (7)
    this._hSPG  = solver.allocElement(sp,         gateNode);    // (8)
    this._hSPS  = solver.allocElement(sp,         sourceNode);  // (9)
    this._hSPDP = solver.allocElement(sp,         dp);          // (10)
    this._hDD   = solver.allocElement(drainNode,  drainNode);   // (11)
    this._hGG   = solver.allocElement(gateNode,   gateNode);    // (12)
    this._hSS   = solver.allocElement(sourceNode, sourceNode);  // (13)
    this._hDPDP = solver.allocElement(dp,         dp);          // (14)
    this._hSPSP = solver.allocElement(sp,         sp);          // (15)
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  /**
   * Single-pass load mirroring jfetload.c::JFETload line-by-line for
   * N-channel (polarity literal = +1).
   */
  load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const base = this._stateBase;
    const mode = ctx.cktMode;
    const voltages = ctx.rhsOld;
    const solver = ctx.solver;
    const params = this._params;
    const tp = this._tp;
    const polarity = this._polarity;
    const m = params.M;

    const nodeG = this.pinNodes.get("G")!;

    // jfetload.c:95-98: dc model parameters (area-scaled).
    const beta = tp.tBeta * params.AREA;
    const gdpr = (params.RD > 0 ? 1 / params.RD : 0) * params.AREA;
    const gspr = (params.RS > 0 ? 1 / params.RS : 0) * params.AREA;
    const csat = tp.tSatCur * params.AREA;
    const vt_temp = tp.vt;
    const vto = tp.tThreshold;

    let icheck = 1;
    let bypassed = false;

    // jfetload.c:103-164: linearization voltage dispatch per cktMode.
    let vgs: number;
    let vgd: number;
    // Promoted to function scope so bypass reload and stamp phase share the
    // same bindings; initial values are set in the compute block.
    let cg = 0;
    let cd = 0;
    let cgd = 0;
    let gm = 0;
    let gds = 0;
    let ggs = 0;
    let ggd = 0;
    let cghat = 0;
    let cdhat = 0;

    if (mode & MODEINITSMSIG) {
      // jfetload.c:103-105: seed from CKTstate0.
      vgs = s0[base + SLOT_VGS];
      vgd = s0[base + SLOT_VGD];
      icheck = 0;
    } else if (mode & MODEINITTRAN) {
      // jfetload.c:106-108: seed from CKTstate1.
      vgs = s1[base + SLOT_VGS];
      vgd = s1[base + SLOT_VGD];
      icheck = 0;
    } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
      // jfetload.c:109-114: UIC operating-point seed from the instance IC params.
      //   vds = JFETtype * JFETicVDS;  vgs = JFETtype * JFETicVGS;  vgd = vgs - vds.
      // With no netlisted ic, ICVDS/ICVGS default to 0 so the seed reduces to
      // vgs = vgd = 0. N-channel polarity = +1.
      const vds = polarity * params.ICVDS;
      vgs = polarity * params.ICVGS;
      vgd = vgs - vds;
      icheck = 0;
    } else if ((mode & MODEINITJCT) && params.OFF === 0) {
      // jfetload.c:115-118: initJct, device on  vgs=-1, vgd=-1.
      vgs = -1;
      vgd = -1;
      icheck = 0;
    } else if ((mode & MODEINITJCT) ||
               ((mode & MODEINITFIX) && params.OFF !== 0)) {
      // jfetload.c:119-122: initJct w/ OFF or initFix+OFF  zero.
      vgs = 0;
      vgd = 0;
      icheck = 0;
    } else if (mode & MODEINITPRED) {
      // cite: jfetload.c:124-149  predictor step active by default
      // (#ifndef PREDICTOR is true when PREDICTOR is undefined, the default).
      // Verbatim port: xfact extrapolation of vgs/vgd plus 9-slot state copy.
      const vgs1 = s1[base + SLOT_VGS];
      const vgd1 = s1[base + SLOT_VGD];
      const deltaOldRatio = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
      const xfact = deltaOldRatio;
      s0[base + SLOT_VGS] = vgs1;
      vgs = (1 + xfact) * vgs1 - xfact * s2[base + SLOT_VGS];
      s0[base + SLOT_VGD] = vgd1;
      vgd = (1 + xfact) * vgd1 - xfact * s2[base + SLOT_VGD];
      // cite: jfetload.c:135-148
      s0[base + SLOT_CG]  = s1[base + SLOT_CG];
      s0[base + SLOT_CD]  = s1[base + SLOT_CD];
      s0[base + SLOT_CGD] = s1[base + SLOT_CGD];
      s0[base + SLOT_GM]  = s1[base + SLOT_GM];
      s0[base + SLOT_GDS] = s1[base + SLOT_GDS];
      s0[base + SLOT_GGS] = s1[base + SLOT_GGS];
      s0[base + SLOT_GGD] = s1[base + SLOT_GGD];
      icheck = 0;
    } else {
      // jfetload.c:151-164: general iteration  read from CKTrhsOld with
      // polarity pre-multiply. jfetload.c:154-161:
      //   vgs = type * (rhsOld[gate] - rhsOld[sourcePrime]);
      //   vgd = type * (rhsOld[gate] - rhsOld[drainPrime]);
      // N-channel polarity = +1  raw difference.
      const vG  = voltages[nodeG];
      const vSP = voltages[this._sourcePrimeNode];
      const vDP = voltages[this._drainPrimeNode];
      const vgsRaw = polarity * (vG - vSP);
      const vgdRaw = polarity * (vG - vDP);
      vgs = vgsRaw;
      vgd = vgdRaw;

      // jfetload.c:211-242: voltage limiting  pnjlim then fetlim
      // (DEVfetlim  the three-zone gate-threshold limiter shared with
      // MOSFETs in devsup.c). jfetload.c:227-228 OR icheck with ichk1.
      const vgsOld = s0[base + SLOT_VGS];
      const vgdOld = s0[base + SLOT_VGD];

      const vgsResult = pnjlim(vgs, vgsOld, vt_temp, tp.vcrit);
      vgs = vgsResult.value;
      icheck = vgsResult.limited ? 1 : 0;

      const vgdResult = pnjlim(vgd, vgdOld, vt_temp, tp.vcrit);
      vgd = vgdResult.value;
      if (vgdResult.limited) icheck = 1;

      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "GS",
          limitType: "pnjlim",
          vBefore: vgsRaw,
          vAfter: vgs,
          wasLimited: vgsResult.limited,
        });
        ctx.limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "GD",
          limitType: "pnjlim",
          vBefore: vgdRaw,
          vAfter: vgd,
          wasLimited: vgdResult.limited,
        });
      }

      vgs = fetlim(vgs, vgsOld, vto); // cite: devsup.c::DEVfetlim via newton-raphson.fetlim
      vgd = fetlim(vgd, vgdOld, vto);

      // cite: jfetload.c:165-174  extrapolated currents for bypass + noncon gates
      const delvgs = vgs - s0[base + SLOT_VGS];
      const delvgd = vgd - s0[base + SLOT_VGD];
      const delvds = delvgs - delvgd;
      cghat = s0[base + SLOT_CG]
        + s0[base + SLOT_GGD] * delvgd
        + s0[base + SLOT_GGS] * delvgs;
      cdhat = s0[base + SLOT_CD]
        + s0[base + SLOT_GM]  * delvgs
        + s0[base + SLOT_GDS] * delvds
        - s0[base + SLOT_GGD] * delvgd;

      // cite: jfetload.c:178-208  NOBYPASS bypass test
      if (ctx.bypass && !(mode & MODEINITPRED)) {
        const vgsOld2 = s0[base + SLOT_VGS];
        const vgdOld2 = s0[base + SLOT_VGD];
        const cgOld  = s0[base + SLOT_CG];
        const cdOld  = s0[base + SLOT_CD];
        if (Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(vgsOld2)) + ctx.voltTol)
        if (Math.abs(delvgd) < ctx.reltol * Math.max(Math.abs(vgd), Math.abs(vgdOld2)) + ctx.voltTol)
        if (Math.abs(cghat - cgOld) < ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cgOld)) + ctx.iabstol)
        if (Math.abs(cdhat - cdOld) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cdOld)) + ctx.iabstol) {
          vgs = vgsOld2;
          vgd = vgdOld2;
          cg  = cgOld;
          cd  = cdOld;
          cgd = s0[base + SLOT_CGD];
          gm  = s0[base + SLOT_GM];
          gds = s0[base + SLOT_GDS];
          ggs = s0[base + SLOT_GGS];
          ggd = s0[base + SLOT_GGD];
          bypassed = true;
        }
      }
    }

    this._icheckLimited = icheck === 1;

    // jfetload.c:247: vds = vgs - vgd.
    const vds = vgs - vgd;

    // jfetload.c:249-270: gate junction currents and conductances.
    // jfetload.c:250-259: gate-source junction.
    if (!bypassed) {
    if (vgs < -3 * vt_temp) {
      let arg = 3 * vt_temp / (vgs * Math.E);
      arg = arg * arg * arg;
      cg = -csat * (1 + arg) + ctx.cktGmin * vgs;
      ggs = csat * 3 * arg / vgs + ctx.cktGmin;
    } else {
      const evgs = Math.exp(vgs / vt_temp);
      ggs = csat * evgs / vt_temp + ctx.cktGmin;
      cg = csat * (evgs - 1) + ctx.cktGmin * vgs;
    }

    // jfetload.c:261-270: gate-drain junction.
    if (vgd < -3 * vt_temp) {
      let arg = 3 * vt_temp / (vgd * Math.E);
      arg = arg * arg * arg;
      cgd = -csat * (1 + arg) + ctx.cktGmin * vgd;
      ggd = csat * 3 * arg / vgd + ctx.cktGmin;
    } else {
      const evgd = Math.exp(vgd / vt_temp);
      ggd = csat * evgd / vt_temp + ctx.cktGmin;
      cgd = csat * (evgd - 1) + ctx.cktGmin * vgd;
    }

    // jfetload.c:272: cg = cg + cgd.
    cg = cg + cgd;

    // jfetload.c:274-348: Sydney University drain current / derivatives.
    let cdrain: number;
    const Bfac0 = tp.bFac;

    if (vds >= 0) {
      // jfetload.c:276-311: normal mode.
      const vgst = vgs - vto;
      if (vgst <= 0) {
        // jfetload.c:281-287: cutoff.
        cdrain = 0;
        gm = 0;
        gds = 0;
      } else {
        const betap = beta * (1 + params.LAMBDA * vds);
        let Bfac = Bfac0;
        if (vgst >= vds) {
          // jfetload.c:291-301: linear region.
          const apart = 2 * params.B + 3 * Bfac * (vgst - vds);
          const cpart = vds * (vds * (Bfac * vds - params.B) + vgst * apart);
          cdrain = betap * cpart;
          gm = betap * vds * (apart + 3 * Bfac * vgst);
          gds = betap * (vgst - vds) * apart
              + beta * params.LAMBDA * cpart;
        } else {
          // jfetload.c:302-310: saturation region.
          Bfac = vgst * Bfac;
          gm = betap * vgst * (2 * params.B + 3 * Bfac);
          const cpart = vgst * vgst * (params.B + Bfac);
          cdrain = betap * cpart;
          gds = params.LAMBDA * beta * cpart;
        }
      }
    } else {
      // jfetload.c:312-348: inverse mode.
      const vgdt = vgd - vto;
      if (vgdt <= 0) {
        // jfetload.c:317-323: cutoff.
        cdrain = 0;
        gm = 0;
        gds = 0;
      } else {
        const betap = beta * (1 - params.LAMBDA * vds);
        let Bfac = Bfac0;
        if (vgdt + vds >= 0) {
          // jfetload.c:327-336: linear region.
          const apart = 2 * params.B + 3 * Bfac * (vgdt + vds);
          const cpart = vds * (-vds * (-Bfac * vds - params.B) + vgdt * apart);
          cdrain = betap * cpart;
          gm = betap * vds * (apart + 3 * Bfac * vgdt);
          gds = betap * (vgdt + vds) * apart
              - beta * params.LAMBDA * cpart - gm;
        } else {
          // jfetload.c:337-346: saturation region.
          Bfac = vgdt * Bfac;
          gm = -betap * vgdt * (2 * params.B + 3 * Bfac);
          const cpart = vgdt * vgdt * (params.B + Bfac);
          cdrain = -betap * cpart;
          gds = params.LAMBDA * beta * cpart - gm;
        }
      }
    }

    // jfetload.c:423-424: cd = cdrain - cgd.
    cd = cdrain - cgd;

    // jfetload.c:425-494: charge storage + NIintegrate for transient.
    const capGate = (mode & (MODEDCTRANCURVE | MODETRAN | MODEAC | MODEINITSMSIG)) !== 0
      || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);

    if (capGate) {
      // jfetload.c:428-457: junction cap / charge at each of G-S, G-D.
      const czgs = tp.tCGS * params.AREA;
      const czgd = tp.tCGD * params.AREA;
      const twop = tp.tGatePot + tp.tGatePot;
      const fcpb2 = tp.corDepCap * tp.corDepCap;
      const czgsf2 = czgs / tp.f2;
      const czgdf2 = czgd / tp.f2;

      // jfetload.c:436-446: G-S junction cap + charge.
      let capgs: number;
      if (vgs < tp.corDepCap) {
        const sarg = Math.sqrt(1 - vgs / tp.tGatePot);
        s0[base + SLOT_QGS] = twop * czgs * (1 - sarg);
        capgs = czgs / sarg;
      } else {
        s0[base + SLOT_QGS] = czgs * tp.f1
          + czgsf2 * (tp.f3 * (vgs - tp.corDepCap)
          + (vgs * vgs - fcpb2) / (twop + twop));
        capgs = czgsf2 * (tp.f3 + vgs / twop);
      }

      // jfetload.c:447-457: G-D junction cap + charge.
      let capgd: number;
      if (vgd < tp.corDepCap) {
        const sarg = Math.sqrt(1 - vgd / tp.tGatePot);
        s0[base + SLOT_QGD] = twop * czgd * (1 - sarg);
        capgd = czgd / sarg;
      } else {
        s0[base + SLOT_QGD] = czgd * tp.f1
          + czgdf2 * (tp.f3 * (vgd - tp.corDepCap)
          + (vgd * vgd - fcpb2) / (twop + twop));
        capgd = czgdf2 * (tp.f3 + vgd / twop);
      }

      // jfetload.c:461-493: store + NIintegrate (skipped for UIC TRANOP).
      if (!((mode & MODETRANOP) && (mode & MODEUIC))) {
        if (mode & MODEINITSMSIG) {
          // jfetload.c:463-466: store raw caps into QGS/QGD and continue
          // (ngspice `continue` skips all stamps  replicated as return).
          s0[base + SLOT_QGS] = capgs;
          s0[base + SLOT_QGD] = capgd;
          return; // J-W3-1: skip all state-write + stamp blocks per jfetload.c:466
        } else {
          // jfetload.c:471-476: MODEINITTRAN copies state0  state1.
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_QGS] = s0[base + SLOT_QGS];
            s1[base + SLOT_QGD] = s0[base + SLOT_QGD];
          }

          // jfetload.c:477-482: NIintegrate G-S cap, lump geq into ggs,
          // companion current into cg.
          const ag = ctx.ag;
          {
            const q0 = s0[base + SLOT_QGS];
            const q1 = s1[base + SLOT_QGS];
            const q2 = s2[base + SLOT_QGS];
            const ccapPrev = s1[base + SLOT_CQGS];
            const { ccap, geq } = niIntegrate(
              ctx.method,
              ctx.order,
              capgs,
              ag,
              q0, q1,
              [q2, 0, 0, 0, 0],
              ccapPrev,
            );
            s0[base + SLOT_CQGS] = ccap;
            ggs = ggs + geq;
            cg = cg + ccap;
          }

          // jfetload.c:481-486: NIintegrate G-D cap, lump geq into ggd,
          // companion current into cg/cd/cgd.
          {
            const q0 = s0[base + SLOT_QGD];
            const q1 = s1[base + SLOT_QGD];
            const q2 = s2[base + SLOT_QGD];
            const ccapPrev = s1[base + SLOT_CQGD];
            const { ccap, geq } = niIntegrate(
              ctx.method,
              ctx.order,
              capgd,
              ag,
              q0, q1,
              [q2, 0, 0, 0, 0],
              ccapPrev,
            );
            s0[base + SLOT_CQGD] = ccap;
            ggd = ggd + geq;
            cg = cg + ccap;
            cd = cd - ccap;
            cgd = cgd + ccap;
          }

          // jfetload.c:487-492: MODEINITTRAN copies cqgs/cqgd state0state1.
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_CQGS] = s0[base + SLOT_CQGS];
            s1[base + SLOT_CQGD] = s0[base + SLOT_CQGD];
          }
        }
      }
    }
    } // end if (!bypassed)

    // cite: jfetload.c:498-507  suppress noncon bump only when both
    // MODEINITFIX and MODEUIC are set (UIC-forced IC at init step).
    if ((!(mode & MODEINITFIX)) || (!(mode & MODEUIC))) {
      const absTol = ctx.iabstol;
      const cgNoncon = Math.abs(cghat - cg)
        >= ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + absTol;
      const cdNoncon = Math.abs(cdhat - cd)
        >  ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + absTol;
      if (this._icheckLimited || cgNoncon || cdNoncon) ctx.noncon.value++;
    }

    // jfetload.c:509-517: write accepted state back to state0.
    s0[base + SLOT_VGS] = vgs;
    s0[base + SLOT_VGD] = vgd;
    s0[base + SLOT_CG]  = cg;
    s0[base + SLOT_CD]  = cd;
    s0[base + SLOT_CGD] = cgd;
    s0[base + SLOT_GM]  = gm;
    s0[base + SLOT_GDS] = gds;
    s0[base + SLOT_GGS] = ggs;
    s0[base + SLOT_GGD] = ggd;

    // jfetload.c:521-532: RHS stamps (polarity = JFETtype).
    // RHS entries go to gate, drainPrime, sourcePrime (not external D/S when
    // internal nodes exist).
    const ceqgd = polarity * (cgd - ggd * vgd);
    const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
    const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

    const sp = this._sourcePrimeNode;
    const dp = this._drainPrimeNode;

    stampRHS(ctx.rhs, nodeG, m * (-ceqgs - ceqgd));
    stampRHS(ctx.rhs, dp,    m * (-cdreq + ceqgd));
    stampRHS(ctx.rhs, sp,    m * (cdreq + ceqgs));

    // jfetload.c:534-550: Y-matrix stamps via cached TSTALLOC handles.
    // jfetload.c:536-544: off-diagonal + prime-node cross terms.
    solver.stampElement(this._hGG,   m * (ggd + ggs));          // JFETgateGatePtr
    solver.stampElement(this._hGDP,  m * (-ggd));               // JFETgateDrainPrimePtr
    solver.stampElement(this._hGSP,  m * (-ggs));               // JFETgateSourcePrimePtr
    solver.stampElement(this._hDPG,  m * (gm - ggd));           // JFETdrainPrimeGatePtr
    solver.stampElement(this._hDPDP, m * (gdpr + gds + ggd));   // JFETdrainPrimeDrainPrimePtr
    solver.stampElement(this._hDPSP, m * (-gds - gm));          // JFETdrainPrimeSourcePrimePtr
    solver.stampElement(this._hSPG,  m * (-ggs - gm));          // JFETsourcePrimeGatePtr
    solver.stampElement(this._hSPDP, m * (-gds));               // JFETsourcePrimeDrainPrimePtr
    solver.stampElement(this._hSPSP, m * (gspr + gds + gm + ggs)); // JFETsourcePrimeSourcePrimePtr
    // jfetload.c:546-550: ohmic resistance stamps (drain/source series Rs).
    // JFETdrainDrainPrimePtr, JFETdrainPrimeDrainPtr, JFETdrainDrainPtr.
    solver.stampElement(this._hDDP,  m * (-gdpr));              // JFETdrainDrainPrimePtr
    solver.stampElement(this._hDPD,  m * (-gdpr));              // JFETdrainPrimeDrainPtr
    solver.stampElement(this._hDD,   m * gdpr);                 // JFETdrainDrainPtr
    // JFETsourceSourcePrimePtr, JFETsourcePrimeSourcePtr, JFETsourceSourcePtr.
    solver.stampElement(this._hSSP,  m * (-gspr));              // JFETsourceSourcePrimePtr
    solver.stampElement(this._hSPS,  m * (-gspr));              // JFETsourcePrimeSourcePtr
    solver.stampElement(this._hSS,   m * gspr);                 // JFETsourceSourcePtr
  }

  /**
   * AC small-signal admittance stamp — jfetacld.c::JFETacLoad line-for-line.
   *
   * Reads the operating-point conductances (JFETgm/gds/ggs/ggd from CKTstate0)
   * and the gate-junction charges (JFETqgs/JFETqgd from CKTstate0) persisted by
   * the most recent load(), scaling the charges by CKTomega to form the
   * junction susceptances xgs/xgd. The imaginary (susceptance) terms go to the
   * `+1` half of each cell via stampElementImag; the real (conductance) terms
   * via stampElement. The additive solver primitives have no subtract variant,
   * so each ngspice `-=` is rendered as a stamp of the negated cell expression
   * (jfetacld.c:55-61,63,66-68), preserving the operand order inside the
   * parentheses.
   */
  stampAc(
    solver: SparseSolverStamp,
    omega: number,
    _ctx: LoadContext,
    _rhsRe: Float64Array,
    _rhsIm: Float64Array,
  ): void {
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const params = this._params;

    // jfetacld.c:36-43: dc conductances (area-scaled) + state0 reads, with the
    // gate-junction charges scaled by CKTomega to form susceptances.
    const gdpr = (params.RD > 0 ? 1 / params.RD : 0) * params.AREA;
    const gspr = (params.RS > 0 ? 1 / params.RS : 0) * params.AREA;
    const gm  = s0[base + SLOT_GM];
    const gds = s0[base + SLOT_GDS];
    const ggs = s0[base + SLOT_GGS];
    const xgs = s0[base + SLOT_QGS] * omega;
    const ggd = s0[base + SLOT_GGD];
    const xgd = s0[base + SLOT_QGD] * omega;

    // jfetacld.c:45: m = here->JFETm.
    const m = params.M;

    // jfetacld.c:47-68: Y-matrix stamps via cached TSTALLOC handles. Real
    // (conductance) terms to the cell; imaginary (susceptance) terms to the
    // `+1` half. ngspice `-=` rendered as a stamp of the negated expression.
    solver.stampElement(this._hDD,    m * (gdpr));                  // *(JFETdrainDrainPtr)
    solver.stampElement(this._hGG,    m * (ggd + ggs));             // *(JFETgateGatePtr)
    solver.stampElementImag(this._hGG, m * (xgd + xgs));            // *(JFETgateGatePtr +1)
    solver.stampElement(this._hSS,    m * (gspr));                  // *(JFETsourceSourcePtr)
    solver.stampElement(this._hDPDP,  m * (gdpr + gds + ggd));      // *(JFETdrainPrimeDrainPrimePtr)
    solver.stampElementImag(this._hDPDP, m * (xgd));               // *(JFETdrainPrimeDrainPrimePtr +1)
    solver.stampElement(this._hSPSP,  m * (gspr + gds + gm + ggs)); // *(JFETsourcePrimeSourcePrimePtr)
    solver.stampElementImag(this._hSPSP, m * (xgs));              // *(JFETsourcePrimeSourcePrimePtr +1)
    solver.stampElement(this._hDDP,   -(m * (gdpr)));              // *(JFETdrainDrainPrimePtr) -=
    solver.stampElement(this._hGDP,   -(m * (ggd)));              // *(JFETgateDrainPrimePtr) -=
    solver.stampElementImag(this._hGDP, -(m * (xgd)));            // *(JFETgateDrainPrimePtr +1) -=
    solver.stampElement(this._hGSP,   -(m * (ggs)));              // *(JFETgateSourcePrimePtr) -=
    solver.stampElementImag(this._hGSP, -(m * (xgs)));            // *(JFETgateSourcePrimePtr +1) -=
    solver.stampElement(this._hSSP,   -(m * (gspr)));             // *(JFETsourceSourcePrimePtr) -=
    solver.stampElement(this._hDPD,   -(m * (gdpr)));             // *(JFETdrainPrimeDrainPtr) -=
    solver.stampElement(this._hDPG,   m * (-ggd + gm));           // *(JFETdrainPrimeGatePtr)
    solver.stampElementImag(this._hDPG, -(m * (xgd)));           // *(JFETdrainPrimeGatePtr +1) -=
    solver.stampElement(this._hDPSP,  m * (-gds - gm));           // *(JFETdrainPrimeSourcePrimePtr)
    solver.stampElement(this._hSPG,   m * (-ggs - gm));           // *(JFETsourcePrimeGatePtr)
    solver.stampElementImag(this._hSPG, -(m * (xgs)));          // *(JFETsourcePrimeGatePtr +1) -=
    solver.stampElement(this._hSPS,   -(m * (gspr)));            // *(JFETsourcePrimeSourcePtr) -=
    solver.stampElement(this._hSPDP,  -(m * (gds)));             // *(JFETsourcePrimeDrainPrimePtr) -=
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    const s0 = this._pool.states[0];
    const polarity = this._polarity;
    // jfet.c:33 JFET_CD: id = polarity * cd (JFETtype applied at ask site).
    const id = polarity * s0[this._stateBase + SLOT_CD];
    const ig = polarity * s0[this._stateBase + SLOT_CG];
    // pinLayout order: [G, S, D] per buildNJfetPinDeclarations.
    // KCL: iS = -(ig + id).
    const iS = -(ig + id);
    return [ig, iS, id];
  }

  /**
   * computeTemperature — engine-driven temperature pass for NJFET.
   *
   * cite: jfettemp.c:83-88 —
   *   if(!here->JFETtempGiven) here->JFETtemp = ckt->CKTtemp + here->JFETdtemp;
   *   vt = here->JFETtemp * CONSTKoverQ;
   * Resolve effective T: per-instance TEMP given → use params.TEMP; else ctx.cktTemp.
   * cite: jfettemp.c:89-112 — per-instance temperature math (tSatCur, caps, tThreshold, tBeta).
   */
  computeTemperature(ctx: TempContext): void {
    // cite: jfettemp.c:83-88 — if(!JFETtempGiven) JFETtemp = CKTtemp + JFETdtemp
    const effectiveT = this._tempGiven ? this._params.TEMP : ctx.cktTemp;
    this._params.TEMP = effectiveT;
    this._tp = computeJfetTempParams(this._params, {
      xtiGiven: this._xtiGiven,
      vtotcGiven: this._vtotcGiven,
      betatceGiven: this._betatceGiven,
    });
  }

  setParam(key: string, value: number): void {
    if (key === "TEMP") {
      this._params.TEMP = value;
      this._tempGiven = true;
      // cite: jfettemp.c:83-88 — per-instance TEMP given overrides circuit temp.
      this._tp = computeJfetTempParams(this._params, {
        xtiGiven: this._xtiGiven,
        vtotcGiven: this._vtotcGiven,
        betatceGiven: this._betatceGiven,
      });
      return;
    }
    // jfet.c:71-75 JFET_MOD_VTOTC/BETATCE/XTI/EG — a hot-loaded temperature/
    // bandgap param sets its *Given bit so the temperature pass sees givenness.
    if (key === "VTOTC") this._vtotcGiven = true;
    else if (key === "BETATCE") this._betatceGiven = true;
    else if (key === "XTI") this._xtiGiven = true;
    if (key in this._params) {
      this._params[key] = value;
      this._tp = computeJfetTempParams(this._params, {
        xtiGiven: this._xtiGiven,
        vtotcGiven: this._vtotcGiven,
        betatceGiven: this._betatceGiven,
      });
    }
  }

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
      const q0 = s0[base + slotQ];
      const q1 = s1[base + slotQ];
      const q2 = s2[base + slotQ];
      const q3 = s3[base + slotQ];
      const ccap0 = s0[base + slotCcap];
      const ccap1 = s1[base + slotCcap];
      const dtSlot = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (dtSlot < minDt) minDt = dtSlot;
    }
    return minDt;
  }
}

export function createNJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new NJFETElement(pinNodes, props, _getTime);
}

// ---------------------------------------------------------------------------
// NJfetElement  CircuitElement implementation (for rendering)
// ---------------------------------------------------------------------------

export class NJfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NJFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNJfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vG = signals?.getPinVoltage("G");
    const vD = signals?.getPinVoltage("D");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Channel bar: fillPolygon from Falstad pixels (51,-16),(51,16),(54,16),(54,-16) ÷ 16
    ctx.drawPolygon(
      [
        { x: 3.1875, y: -1 },
        { x: 3.1875, y: 1 },
        { x: 3.375, y: 1 },
        { x: 3.375, y: -1 },
      ],
      true,
    );

    // Gate arrow: fillPolygon from Falstad pixels (50,0),(42,-3),(42,3) ÷ 16
    ctx.drawPolygon(
      [
        { x: 3.125, y: 0 },
        { x: 2.625, y: -0.1875 },
        { x: 2.625, y: 0.1875 },
      ],
      true,
    );

    // Gate lead
    drawColoredLead(ctx, signals, vG, 0, 0, 3.125, 0);

    // Drain lead (top): Falstad (64,-16)(64,-8)(54,-8) ÷ 16
    drawColoredLead(ctx, signals, vD, 4, -1, 4, -0.5);
    ctx.drawLine(4, -0.5, 3.375, -0.5);

    // Source lead (bottom): Falstad (64,16)(64,8)(54,8) ÷ 16
    drawColoredLead(ctx, signals, vS, 4, 1, 4, 0.5);
    ctx.drawLine(4, 0.5, 3.375, 0.5);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildNJfetPinDeclarations(): PinDeclaration[] {
  // currentLead waypoints route each terminal through an L-bend to the channel at x≈3.375.
  return [
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 3.375, y: 0 }],
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 4, y: 0.5 }, { x: 3.375, y: 0.5 }],
    },
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
      currentLead: [{ x: 4, y: -0.5 }, { x: 3.375, y: -0.5 }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const NJFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// StandaloneComponentDefinition
// ---------------------------------------------------------------------------

function njfetCircuitFactory(props: PropertyBag): NJfetElement {
  return new NJfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NJfetDefinition: StandaloneComponentDefinition = {
  name: "NJFET",
  typeId: -1,
  factory: njfetCircuitFactory,
  pinLayout: buildNJfetPinDeclarations(),
  voltageProbes: [
    { name: "Vds", pos: "D", neg: "S" },
    { name: "Vgs", pos: "G", neg: "S" },
  ],
  propertyDefs: JFET_PROPERTY_DEFS,
  attributeMap: NJFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel JFET  Shichman-Hodges model with gate junction.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, BETA, LAMBDA, IS, CGS, CGD.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createNJfetElement,
      paramDefs: NJFET_PARAM_DEFS,
      params: NJFET_PARAM_DEFAULTS,
      spice: { device: "JFET", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice",
};
