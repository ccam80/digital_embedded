/**
 * P-channel JFET analog component.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/jfet/jfetload.c::JFETload`.
 * Single-pass `load()` per device per NR iteration (Wave 6.1 unified interface).
 * Gate-junction caps lump inline into the stamps per `jfetload.c:477-492`.
 *
 * Invented cross-method slots deleted per Phase 2.5 Wave 1.4 A1. Only slots
 * with direct ngspice correspondence in `jfetdefs.h:154-166` survive.
 *
 * D-10 (fet-base collapse): NJFET and PJFET are each self-contained closure
 * factories. No shared abstract class. Sign-polarity is a literal `-1`
 * constant below (P-channel, jfetdefs.h:235 `#define PJF -1`); the N-channel
 * sibling in `njfet.ts` carries its own `+1` literal.
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
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim, fetlim } from "../../solver/analog/newton-raphson.js";
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
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG, MODEINITTRAN, MODEINITPRED,
  MODETRAN, MODEAC, MODETRANOP, MODEUIC,
} from "../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h values)
// ---------------------------------------------------------------------------

const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;
const CONSTKoverQ = CONSTboltz / CHARGE;
const REFTEMP = 300.15;
const CONSTroot2 = Math.SQRT2;

/** Minimum conductance for numerical stability (CKTgmin). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: PJFET_PARAM_DEFS, defaults: PJFET_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: 2.0,   unit: "V",    description: "Pinch-off (threshold) voltage" },
    BETA:   { default: 1e-4,  unit: "A/VÂ²", description: "Transconductance coefficient" },
    LAMBDA: { default: 0.0,   unit: "1/V",  description: "Channel-length modulation" },
  },
  secondary: {
    IS:   { default: 1e-14, unit: "A",  description: "Gate junction saturation current" },
    N:    { default: 1.0,               description: "Gate junction emission coefficient" },
    CGS:  { default: 0,     unit: "F",  description: "Gate-source zero-bias capacitance" },
    CGD:  { default: 0,     unit: "F",  description: "Gate-drain zero-bias capacitance" },
    PB:   { default: 1.0,   unit: "V",  description: "Gate junction built-in potential" },
    FC:   { default: 0.5,               description: "Forward-bias capacitance coefficient" },
    RD:   { default: 0,     unit: "Î",  description: "Drain ohmic resistance" },
    RS:   { default: 0,     unit: "Î",  description: "Source ohmic resistance" },
    B:    { default: 1.0,               description: "Sydney University doping-tail parameter" },
    TCV:  { default: 0.0,   unit: "V/K",description: "Threshold voltage temperature coefficient" },
    BEX:  { default: 0.0,               description: "Mobility temperature exponent" },
    KF:   { default: 0,                 description: "Flicker noise coefficient" },
    AF:   { default: 1,                 description: "Flicker noise exponent" },
    TNOM: { default: REFTEMP, unit: "K", description: "Nominal temperature for parameters" },
  },
  instance: {
    AREA: { default: 1.0,               description: "Area factor" },
    M:    { default: 1.0,               description: "Parallel multiplier" },
    TEMP: { default: 300.15,  unit: "K", description: "Per-instance operating temperature" },
    OFF:  { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
  },
});

// ---------------------------------------------------------------------------
// PjfetParams  resolved model parameters
// ---------------------------------------------------------------------------

export interface PjfetParams {
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
  BEX: number;
  AREA: number;
  M: number;
  KF: number;
  AF: number;
  TNOM: number;
  TEMP: number;
  OFF: number;
}

// ---------------------------------------------------------------------------
// State schema  JFET (Phase 2.5 Wave 1.4 A1 post-excision).
//
// Only slots with direct correspondence in `jfetdefs.h:154-166` JFETstate<n>
// offsets survive. Same layout as the N-channel sibling  the schema is
// polarity-agnostic (ngspice shares JFETstate between NJF and PJF).
// ---------------------------------------------------------------------------

export const PJFET_SCHEMA: StateSchema = defineStateSchema("PjfetElement", [
  { name: "VGS",  doc: "jfetdefs.h JFETvgs=0",  init: { kind: "zero" } },
  { name: "VGD",  doc: "jfetdefs.h JFETvgd=1",  init: { kind: "zero" } },
  { name: "CG",   doc: "jfetdefs.h JFETcg=2",   init: { kind: "zero" } },
  { name: "CD",   doc: "jfetdefs.h JFETcd=3",   init: { kind: "zero" } },
  { name: "CGD",  doc: "jfetdefs.h JFETcgd=4",  init: { kind: "zero" } },
  { name: "GM",   doc: "jfetdefs.h JFETgm=5",   init: { kind: "zero" } },
  { name: "GDS",  doc: "jfetdefs.h JFETgds=6",  init: { kind: "zero" } },
  { name: "GGS",  doc: "jfetdefs.h JFETggs=7",  init: { kind: "zero" } },
  { name: "GGD",  doc: "jfetdefs.h JFETggd=8",  init: { kind: "zero" } },
  { name: "QGS",  doc: "jfetdefs.h JFETqgs=9",  init: { kind: "zero" } },
  { name: "CQGS", doc: "jfetdefs.h JFETcqgs=10",init: { kind: "zero" } },
  { name: "QGD",  doc: "jfetdefs.h JFETqgd=11", init: { kind: "zero" } },
  { name: "CQGD", doc: "jfetdefs.h JFETcqgd=12",init: { kind: "zero" } },
]);

// Slot indices (match PJFET_SCHEMA order, mirror jfetdefs.h).
const SLOT_VGS  = 0;
const SLOT_VGD  = 1;
const SLOT_CG   = 2;
const SLOT_CD   = 3;
const SLOT_CGD  = 4;
const SLOT_GM   = 5;
const SLOT_GDS  = 6;
const SLOT_GGS  = 7;
const SLOT_GGD  = 8;
const SLOT_QGS  = 9;
const SLOT_CQGS = 10;
const SLOT_QGD  = 11;
const SLOT_CQGD = 12;

// ---------------------------------------------------------------------------
// PJFET temperature-corrected parameters (jfettemp.c port, local copy).
// ---------------------------------------------------------------------------

export interface PjfetTempParams {
  vt: number;
  tSatCur: number;
  tGatePot: number;
  tCGS: number;
  tCGD: number;
  corDepCap: number;
  vcrit: number;
  f1: number;
  f2: number;
  f3: number;
  tThreshold: number;
  tBeta: number;
  bFac: number;
}

/**
 * Port of `jfettemp.c::JFETtemp`. Instance operating temperature is taken
 * from `p.TEMP` (maps to ngspice JFETtemp, configurable per device).
 */
export function computePjfetTempParams(p: PjfetParams): PjfetTempParams {
  // jfettemp.c:43-49.
  const vtnom = CONSTKoverQ * p.TNOM;
  const fact1 = p.TNOM / REFTEMP;
  const kt1 = CONSTboltz * p.TNOM;
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);
  const pbo = (p.PB - pbfact1) / fact1;
  const gmaold = (p.PB - pbo) / pbo;
  const cjfact = 1 / (1 + 0.5 * (4e-4 * (p.TNOM - REFTEMP) - gmaold));

  const fcClamped = p.FC > 0.95 ? 0.95 : p.FC;

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
  let tSatCur = p.IS * Math.exp(ratio1 * 1.11 / vt);
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

  const corDepCap = fcClamped * tGatePot;
  const f1 = tGatePot * (1 - Math.exp((1 - 0.5) * xfc)) / (1 - 0.5);
  const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));

  const tThreshold = p.VTO - p.TCV * (temp - p.TNOM);
  const tBeta = p.BETA * Math.pow(temp / p.TNOM, p.BEX);

  return {
    vt, tSatCur, tGatePot, tCGS, tCGD,
    corDepCap, vcrit, f1, f2, f3,
    tThreshold, tBeta, bFac,
  };
}

// ---------------------------------------------------------------------------
// createPJfetElement  P-channel JFET factory (polarity literal = -1).
// Single load() ported from jfetload.c line-by-line.
// No cached Float64Array state refs  pool.states[N] at call time.
// ---------------------------------------------------------------------------

export function createPJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
) {
  // P-channel polarity literal (jfetdefs.h:235 `#define PJF -1`).
  const polarity: -1 = -1;

  const nodeG = pinNodes.get("G")!;
  const nodeD = pinNodes.get("D")!;
  const nodeS = pinNodes.get("S")!;

  const params: PjfetParams = {
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
    BEX:    props.getModelParam<number>("BEX"),
    AREA:   props.getModelParam<number>("AREA"),
    M:      props.getModelParam<number>("M"),
    KF:     props.getModelParam<number>("KF"),
    AF:     props.getModelParam<number>("AF"),
    TNOM:   props.getModelParam<number>("TNOM"),
    TEMP:   props.getModelParam<number>("TEMP"),
    OFF:    props.getModelParam<number>("OFF"),
  };

  let tp = computePjfetTempParams(params);
  const hasCapacitance = params.CGS > 0 || params.CGD > 0;

  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration icheck flag (jfetload.c:500-508 CKTnoncon bump).
  let icheckLimited = false;

  return {
    branchIndex: -1,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),
    _model: params,
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.JFET,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSchema: PJFET_SCHEMA,
    stateSize: PJFET_SCHEMA.size,
    stateBaseOffset: -1,

    // Internal nodes allocated during setup() — jfetset.c:115-158
    _sourcePrimeNode: -1,
    _drainPrimeNode: -1,

    // TSTALLOC handles — jfetset.c:166-180
    _hDDP:  -1,
    _hGDP:  -1,
    _hGSP:  -1,
    _hSSP:  -1,
    _hDPD:  -1,
    _hDPG:  -1,
    _hDPSP: -1,
    _hSPG:  -1,
    _hSPS:  -1,
    _hSPDP: -1,
    _hDD:   -1,
    _hGG:   -1,
    _hSS:   -1,
    _hDPDP: -1,
    _hSPSP: -1,

    setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
      const solver     = ctx.solver;
      const gateNode   = this._pinNodes.get("G")!;
      const drainNode  = this._pinNodes.get("D")!;
      const sourceNode = this._pinNodes.get("S")!;
      const model      = this._model;

      // State slots — jfetset.c:112-113
      this._stateBase = ctx.allocStates(13);

      // Internal nodes — jfetset.c:115-158 (source prime before drain prime)
      this._sourcePrimeNode = (model.RS === 0) ? sourceNode : ctx.makeVolt(this.label, "source");
      this._drainPrimeNode  = (model.RD === 0) ? drainNode  : ctx.makeVolt(this.label, "drain");

      const sp = this._sourcePrimeNode;
      const dp = this._drainPrimeNode;

      // TSTALLOC sequence — jfetset.c:166-180 (identical to NJFET)
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
    },

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(PJFET_SCHEMA, pool, base, {});
    },

    /**
     * Single-pass load mirroring jfetload.c::JFETload line-by-line for
     * P-channel (polarity literal = -1).
     */
    load(ctx: LoadContext): void {
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const mode = ctx.cktMode;
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;
      const m = params.M;

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
        // jfetload.c:109-114: UIC with IC params. PjfetParams has no ICVDS/
        // ICVGS, so IC values collapse to zero. Polarity = -1; polarity * 0
        // = 0 either way.
        vgs = 0;
        vgd = 0;
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
        // P-channel polarity = -1  negate the raw difference.
        const vG  = voltages[nodeG];
        const vSP = voltages[this._sourcePrimeNode];
        const vDP = voltages[this._drainPrimeNode];
        const vgsRaw = polarity * (vG - vSP);
        const vgdRaw = polarity * (vG - vDP);
        vgs = vgsRaw;
        vgd = vgdRaw;

        // jfetload.c:211-242: voltage limiting  pnjlim then fetlim
        // (DEVfetlim  three-zone gate-threshold limiter from devsup.c).
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
            elementIndex: (this as any).elementIndex ?? -1,
            label: (this as any).label ?? "",
            junction: "GS",
            limitType: "pnjlim",
            vBefore: vgsRaw,
            vAfter: vgs,
            wasLimited: vgsResult.limited,
          });
          ctx.limitingCollector.push({
            elementIndex: (this as any).elementIndex ?? -1,
            label: (this as any).label ?? "",
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

      icheckLimited = icheck === 1;

      // jfetload.c:247: vds = vgs - vgd.
      const vds = vgs - vgd;

      if (!bypassed) {
      // jfetload.c:249-270: gate junction currents and conductances.
      // jfetload.c:250-259: gate-source junction.
      if (vgs < -3 * vt_temp) {
        let arg = 3 * vt_temp / (vgs * Math.E);
        arg = arg * arg * arg;
        cg = -csat * (1 + arg) + GMIN * vgs;
        ggs = csat * 3 * arg / vgs + GMIN;
      } else {
        const evgs = Math.exp(vgs / vt_temp);
        ggs = csat * evgs / vt_temp + GMIN;
        cg = csat * (evgs - 1) + GMIN * vgs;
      }

      // jfetload.c:261-270: gate-drain junction.
      if (vgd < -3 * vt_temp) {
        let arg = 3 * vt_temp / (vgd * Math.E);
        arg = arg * arg * arg;
        cgd = -csat * (1 + arg) + GMIN * vgd;
        ggd = csat * 3 * arg / vgd + GMIN;
      } else {
        const evgd = Math.exp(vgd / vt_temp);
        ggd = csat * evgd / vt_temp + GMIN;
        cgd = csat * (evgd - 1) + GMIN * vgd;
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
          cdrain = 0;
          gm = 0;
          gds = 0;
        } else {
          const betap = beta * (1 + params.LAMBDA * vds);
          let Bfac = Bfac0;
          if (vgst >= vds) {
            const apart = 2 * params.B + 3 * Bfac * (vgst - vds);
            const cpart = vds * (vds * (Bfac * vds - params.B) + vgst * apart);
            cdrain = betap * cpart;
            gm = betap * vds * (apart + 3 * Bfac * vgst);
            gds = betap * (vgst - vds) * apart
                + beta * params.LAMBDA * cpart;
          } else {
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
          cdrain = 0;
          gm = 0;
          gds = 0;
        } else {
          const betap = beta * (1 - params.LAMBDA * vds);
          let Bfac = Bfac0;
          if (vgdt + vds >= 0) {
            const apart = 2 * params.B + 3 * Bfac * (vgdt + vds);
            const cpart = vds * (-vds * (-Bfac * vds - params.B) + vgdt * apart);
            cdrain = betap * cpart;
            gm = betap * vds * (apart + 3 * Bfac * vgdt);
            gds = betap * (vgdt + vds) * apart
                - beta * params.LAMBDA * cpart - gm;
          } else {
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
      const capGate = (mode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0
        || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);

      if (capGate) {
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
            // jfetload.c:463-466: store raw caps and continue
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

            // jfetload.c:477-482: NIintegrate G-S cap, lump geq into ggs.
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

            // jfetload.c:481-486: NIintegrate G-D cap, lump geq into ggd.
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
        if (icheckLimited || cgNoncon || cdNoncon) ctx.noncon.value++;
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

      // jfetload.c:521-532: RHS stamps (polarity = JFETtype = -1 for PJFET).
      const ceqgd = polarity * (cgd - ggd * vgd);
      const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
      const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

      stampRHS(ctx.rhs, nodeG, m * (-ceqgs - ceqgd));
      stampRHS(ctx.rhs, nodeD, m * (-cdreq + ceqgd));
      stampRHS(ctx.rhs, nodeS, m * (cdreq + ceqgs));

      // jfetload.c:534-550: Y-matrix stamps.
      // jfetload.c:536-544: off-diagonal + prime-node stamps (cross terms).
      stampG(solver, nodeG, nodeG, m * (ggd + ggs));
      stampG(solver, nodeG, nodeD, m * (-ggd));
      stampG(solver, nodeG, nodeS, m * (-ggs));
      stampG(solver, nodeD, nodeG, m * (gm - ggd));
      stampG(solver, nodeD, nodeD, m * (gdpr + gds + ggd));
      stampG(solver, nodeD, nodeS, m * (-gds - gm));
      stampG(solver, nodeS, nodeG, m * (-ggs - gm));
      stampG(solver, nodeS, nodeD, m * (-gds));
      stampG(solver, nodeS, nodeS, m * (gspr + gds + gm + ggs));
      // jfetload.c:546,548: external drain/source self-stamps (gdpr/gspr).
      // J-W3-3: collapsed primeâ†"external nodes  2 additional self-stamps.
      // ngspice: JFETdrainDrainPtr += m*(gdpr); JFETsourceSourcePtr += m*(gspr).
      if (gdpr > 0) stampG(solver, nodeD, nodeD, m * gdpr);
      if (gspr > 0) stampG(solver, nodeS, nodeS, m * gspr);
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      const s0 = pool.states[0];
      // jfet.c:33 JFET_CD: id = polarity * cd.
      const id = polarity * s0[base + SLOT_CD];
      const ig = polarity * s0[base + SLOT_CG];
      // pinLayout order: [G, D, S] per buildPJfetPinDeclarations.
      // KCL: iS = -(ig + id).
      const iS = -(ig + id);
      return [ig, id, iS];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        (params as unknown as Record<string, number>)[key] = value;
        tp = computePjfetTempParams(params);
      }
    },

    get _p(): PjfetParams {
      return params;
    },

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];
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
    },
  };
}

// ---------------------------------------------------------------------------
// PJfetElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class PJfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PJFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPJfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.5,
      width: 3,
      height: 3,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vG = signals?.getPinVoltage("G");
    const vD = signals?.getPinVoltage("D");
    const vS = signals?.getPinVoltage("S");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const PX = 1 / 16;

    const chanX = 1.8;
    const chanTop = -1.0;
    const chanBot = 1.0;

    // Body (channel line, gate bar rect, arrow) stays COMPONENT color
    ctx.drawLine(chanX, chanTop, chanX, chanBot);

    const barWidth = 3 * PX;
    ctx.drawRect(
      chanX - barWidth / 2,
      chanTop + 0.15,
      barWidth,
      chanBot - chanTop - 0.3,
      true,
    );

    const arrowLen = 8 * PX;
    const arrowWid = 3 * PX;
    const barbF = 1 - arrowLen / chanX;
    const barbX = chanX * (1 - barbF);
    ctx.drawPolygon([
      { x: 0, y: 0 },
      { x: barbX, y: arrowWid },
      { x: barbX, y: -arrowWid },
    ], true);

    // Gate lead
    drawColoredLead(ctx, signals, vG, 0, 0, chanX, 0);

    // Drain lead (top)
    drawColoredLead(ctx, signals, vD, chanX, chanTop, 3, chanTop);
    ctx.drawLine(3, chanTop, 3, -1.5);

    // Source lead (bottom)
    drawColoredLead(ctx, signals, vS, chanX, chanBot, 3, chanBot);
    ctx.drawLine(3, chanBot, 3, 1.5);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPJfetPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: 1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: -1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const JFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const PJFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

function pjfetCircuitFactory(props: PropertyBag): PJfetElement {
  return new PJfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PJfetDefinition: ComponentDefinition = {
  name: "PJFET",
  typeId: -1,
  factory: pjfetCircuitFactory,
  pinLayout: buildPJfetPinDeclarations(),
  propertyDefs: JFET_PROPERTY_DEFS,
  attributeMap: PJFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel JFET  Shichman-Hodges model (polarity inverted).\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, BETA, LAMBDA, IS, CGS, CGD.",
  ngspiceNodeMap: { G: "gate", D: "drain", S: "source" },
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createPJfetElement,
      paramDefs: PJFET_PARAM_DEFS,
      params: PJFET_PARAM_DEFAULTS,
      ngspiceNodeMap: { G: "gate", D: "drain", S: "source" },
    },
  },
  defaultModel: "spice",
};
