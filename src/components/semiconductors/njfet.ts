/**
 * N-channel JFET analog component.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/jfet/jfetload.c::JFETload`.
 * Single-pass `load()` per device per NR iteration (Wave 6.1 unified interface).
 * Gate-junction caps lump inline into the stamps per `jfetload.c:477-492`.
 *
 * Invented cross-method slots deleted per Phase 2.5 Wave 1.4 A1. Only slots
 * with direct ngspice correspondence in `jfetdefs.h:154-166` survive.
 *
 * D-10 (fet-base collapse): NJFET and PJFET are each self-contained closure
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
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
    B:    { default: 1.0,               description: "Sydney University doping-tail parameter" },
    TCV:  { default: 0.0,   unit: "V/K",description: "Threshold voltage temperature coefficient" },
    BEX:  { default: 0.0,               description: "Mobility temperature exponent" },
    AREA: { default: 1.0,               description: "Area factor" },
    M:    { default: 1.0,               description: "Parallel multiplier" },
    KF:   { default: 0,                 description: "Flicker noise coefficient" },
    AF:   { default: 1,                 description: "Flicker noise exponent" },
    TNOM: { default: REFTEMP, unit: "K", description: "Nominal temperature for parameters" },
    TEMP: { default: 300.15,  unit: "K", description: "Per-instance operating temperature" },
    OFF:  { default: 0,                 description: "Initial condition: device off (0=false, 1=true)" },
  },
});

// ---------------------------------------------------------------------------
// JfetParams — resolved model parameters
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
// State schema — JFET (Phase 2.5 Wave 1.4 A1 post-excision).
//
// Only slots with direct correspondence in `jfetdefs.h:154-166` JFETstate<n>
// offsets survive. The prior fet-base schema's 45 MOSFET-oriented slots
// (VSB, VBD, GMBS, GBD, GBS, VON, CAPGB, etc.) are excised along with the
// invented cap-transfer slots (CAP_GEQ_GS/GD, CAP_IEQ_GS/GD, VGS_JUNCTION,
// GD_JUNCTION, ID_JUNCTION, MEYER_GS/GD/GB, V_GS/V_GD, CCAP_GS/GD). The
// gate-junction caps lump inline per jfetload.c:477-492.
//
// Ngspice jfetdefs.h correspondences:
//   VGS=0 (JFETvgs), VGD=1 (JFETvgd), CG=2 (JFETcg), CD=3 (JFETcd),
//   CGD=4 (JFETcgd), GM=5 (JFETgm), GDS=6 (JFETgds), GGS=7 (JFETggs),
//   GGD=8 (JFETggd), QGS=9 (JFETqgs), CQGS=10 (JFETcqgs),
//   QGD=11 (JFETqgd), CQGD=12 (JFETcqgd).
// ---------------------------------------------------------------------------

export const JFET_SCHEMA: StateSchema = defineStateSchema("JfetElement", [
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
export function computeJfetTempParams(p: JfetParams): JfetTempParams {
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

  // cite: jfettemp.c:83 — instance temp from params.TEMP (maps to ngspice JFETtemp)
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

  // jfettemp.c:106-109.
  const corDepCap = fcClamped * tGatePot;
  const f1 = tGatePot * (1 - Math.exp((1 - 0.5) * xfc)) / (1 - 0.5);
  const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));

  // jfettemp.c:111-112.
  const tThreshold = p.VTO - p.TCV * (temp - p.TNOM);
  const tBeta = p.BETA * Math.pow(temp / p.TNOM, p.BEX);

  return {
    vt, tSatCur, tGatePot, tCGS, tCGD,
    corDepCap, vcrit, f1, f2, f3,
    tThreshold, tBeta, bFac,
  };
}

// ---------------------------------------------------------------------------
// createNJfetElement — N-channel JFET factory (polarity literal = +1).
// Single load() ported from jfetload.c line-by-line.
// No cached Float64Array state refs — pool.states[N] at call time.
// ---------------------------------------------------------------------------

export function createNJfetElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
) {
  // N-channel polarity literal (jfetdefs.h:234 `#define NJF 1`).
  const polarity: 1 = 1;

  const nodeG = pinNodes.get("G")!;
  const nodeD = pinNodes.get("D")!;
  const nodeS = pinNodes.get("S")!;

  const params: JfetParams = {
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

  let tp = computeJfetTempParams(params);
  const hasCapacitance = params.CGS > 0 || params.CGD > 0;

  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration icheck flag (jfetload.c:500-508 CKTnoncon bump).
  let icheckLimited = false;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSchema: JFET_SCHEMA,
    stateSize: JFET_SCHEMA.size,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(JFET_SCHEMA, pool, base, {});
    },

    /**
     * Single-pass load mirroring jfetload.c::JFETload line-by-line for
     * N-channel (polarity literal = +1).
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
      // cite: jfetload.c:165-174 — extrapolated currents for bypass + noncon;
      // set only in the general-iteration branch.
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
        // jfetload.c:109-114: UIC with IC params — digiTS has no ICVDS/ICVGS
        // on JfetParams, so the IC values collapse to zero. With polarity=+1:
        //   vds = polarity * 0 = 0;  vgs = polarity * 0 = 0;  vgd = vgs - vds.
        vgs = 0;
        vgd = 0;
        icheck = 0;
      } else if ((mode & MODEINITJCT) && params.OFF === 0) {
        // jfetload.c:115-118: initJct, device on → vgs=-1, vgd=-1.
        vgs = -1;
        vgd = -1;
        icheck = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && params.OFF !== 0)) {
        // jfetload.c:119-122: initJct w/ OFF or initFix+OFF → zero.
        vgs = 0;
        vgd = 0;
        icheck = 0;
      } else if (mode & MODEINITPRED) {
        // jfetload.c:124-149: predictor step (#ifndef PREDICTOR default).
        // ngspice predictor is #undef by default → inert. Use state1
        // rotation fallback matching the pool-rotation model.
        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = s1[base + SLOT_VGD];
        const deltaOldRatio = ctx.deltaOld[1] > 0 ? ctx.delta / ctx.deltaOld[1] : 0;
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
        // jfetload.c:151-164: general iteration — read from CKTrhsOld with
        // polarity pre-multiply. jfetload.c:154-161:
        //   vgs = type * (rhsOld[gate] - rhsOld[sourcePrime]);
        //   vgd = type * (rhsOld[gate] - rhsOld[drainPrime]);
        // N-channel polarity = +1 → raw difference.
        const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
        const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
        const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
        const vgsRaw = polarity * (vG - vS);
        const vgdRaw = polarity * (vG - vD);
        vgs = vgsRaw;
        vgd = vgdRaw;

        // jfetload.c:211-242: voltage limiting — pnjlim then fetlim
        // (DEVfetlim — the three-zone gate-threshold limiter shared with
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

        // cite: jfetload.c:165-174 — extrapolated currents for bypass + noncon gates
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

        // cite: jfetload.c:178-208 — NOBYPASS bypass test
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

      // jfetload.c:249-270: gate junction currents and conductances.
      // jfetload.c:250-259: gate-source junction.
      if (!bypassed) {
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
      const capGate = (mode & (MODETRAN | MODEAC | MODEINITSMSIG)) !== 0
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
            // (ngspice `continue` skips all stamps — replicated as return).
            s0[base + SLOT_QGS] = capgs;
            s0[base + SLOT_QGD] = capgd;
            return; // J-W3-1: skip all state-write + stamp blocks per jfetload.c:466
          } else {
            // jfetload.c:471-476: MODEINITTRAN copies state0 → state1.
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

            // jfetload.c:487-492: MODEINITTRAN copies cqgs/cqgd state0→state1.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQGS] = s0[base + SLOT_CQGS];
              s1[base + SLOT_CQGD] = s0[base + SLOT_CQGD];
            }
          }
        }
      }
      } // end if (!bypassed)

      // cite: jfetload.c:498-507 — suppress noncon bump only when both
      // MODEINITFIX and MODEUIC are set (UIC-forced IC at init step).
      // Bitwise `|` on operands that are already 0/1 from `!` is equivalent
      // to logical `||` — no "quirk," just C convention ported verbatim.
      if ((!(mode & MODEINITFIX)) | (!(mode & MODEUIC))) {
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

      // jfetload.c:521-532: RHS stamps (polarity = JFETtype).
      const ceqgd = polarity * (cgd - ggd * vgd);
      const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
      const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

      stampRHS(solver, nodeG, m * (-ceqgs - ceqgd));
      stampRHS(solver, nodeD, m * (-cdreq + ceqgd));
      stampRHS(solver, nodeS, m * (cdreq + ceqgs));

      // jfetload.c:534-550: Y-matrix stamps. With no RD/RS internal nodes,
      // the "prime" nodes collapse to the external pins.
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
      // J-W3-3: collapsed prime↔external nodes → 2 additional self-stamps.
      // ngspice: JFETdrainDrainPtr += m*(gdpr); JFETsourceSourcePtr += m*(gspr).
      if (gdpr > 0) stampG(solver, nodeD, nodeD, m * gdpr);
      if (gspr > 0) stampG(solver, nodeS, nodeS, m * gspr);
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      const s0 = pool.states[0];
      // jfet.c:33 JFET_CD: id = polarity * cd (JFETtype applied at ask site).
      const id = polarity * s0[base + SLOT_CD];
      const ig = polarity * s0[base + SLOT_CG];
      // pinLayout order: [G, S, D] per buildNJfetPinDeclarations.
      // KCL: iS = -(ig + id).
      const iS = -(ig + id);
      return [ig, iS, id];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        (params as unknown as Record<string, number>)[key] = value;
        tp = computeJfetTempParams(params);
      }
    },

    get _p(): JfetParams {
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
// NJfetElement — CircuitElement implementation (for rendering)
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

    // Drain lead (top): Falstad (64,-16)→(64,-8)→(54,-8) ÷ 16
    drawColoredLead(ctx, signals, vD, 4, -1, 4, -0.5);
    ctx.drawLine(4, -0.5, 3.375, -0.5);

    // Source lead (bottom): Falstad (64,16)→(64,8)→(54,8) ÷ 16
    drawColoredLead(ctx, signals, vS, 4, 1, 4, 0.5);
    ctx.drawLine(4, 0.5, 3.375, 0.5);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildNJfetPinDeclarations(): PinDeclaration[] {
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
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
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

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const NJFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

function njfetCircuitFactory(props: PropertyBag): NJfetElement {
  return new NJfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NJfetDefinition: ComponentDefinition = {
  name: "NJFET",
  typeId: -1,
  factory: njfetCircuitFactory,
  pinLayout: buildNJfetPinDeclarations(),
  propertyDefs: JFET_PROPERTY_DEFS,
  attributeMap: NJFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel JFET — Shichman-Hodges model with gate junction.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, BETA, LAMBDA, IS, CGS, CGD.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createNJfetElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: NJFET_PARAM_DEFS,
      params: NJFET_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
