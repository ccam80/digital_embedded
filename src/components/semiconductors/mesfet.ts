/**
 * GaAs MESFET analog component (Statz model).
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/mes/mesload.c::MESload`
 * (Statz drain current + gate-junction charge model). Single-pass `load()` per
 * device per NR iteration. Two channel polarities ship as two element classes:
 * `NMESFETElement` (`mesdefs.h:221` `#define NMF 1`) and `PMESFETElement`
 * (`mesdefs.h:222` `#define PMF -1`), each carrying its own polarity literal,
 * mirroring the NJFET/PJFET split.
 *
 * The single ngspice `mes` device class carries an `nmf`/`pmf` model flag
 * (`MEStype`, `mesdefs.h:176`); digiTS represents the two polarities as two
 * components, so the polarity is a per-class literal, not a runtime param.
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
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG, MODEINITTRAN, MODEINITPRED,
  MODETRAN, MODETRANOP, MODEUIC,
} from "../../solver/analog/ckt-mode.js";

import { VT } from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Model parameter declarations (mesdefs.h:178-214 model + :48-87 instance;
// defaults from messetup.c:32-73, mesparam.c).
// ---------------------------------------------------------------------------

export const { paramDefs: MESFET_PARAM_DEFS, defaults: MESFET_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    // mesmpar.c:20-23 MES_MOD_VTO; messetup.c:32-34 default -2.0. SPICE tokens vt0/vto.
    VTO:    { default: -2.0,   unit: "V",    spiceName: "vto", description: "Pinch-off (threshold) voltage" },
    // mesmpar.c:28-31 MES_MOD_BETA; messetup.c:35-37 default 2.5e-3.
    BETA:   { default: 2.5e-3, unit: "A/V²", description: "Transconductance coefficient" },
    // mesmpar.c:24-27 MES_MOD_ALPHA; messetup.c:41-43 default 2.0.
    ALPHA:  { default: 2.0,    unit: "1/V",  description: "Saturation voltage parameter" },
  },
  secondary: {
    // mesmpar.c:32-35 MES_MOD_LAMBDA; messetup.c:44-46 default 0.
    LAMBDA: { default: 0.0,    unit: "1/V",  description: "Channel-length modulation parameter" },
    // mesmpar.c:36-39 MES_MOD_B; messetup.c:38-40 default 0.3.
    B:      { default: 0.3,    unit: "1/V",  description: "Doping tail extending parameter" },
    // mesmpar.c:40-43 MES_MOD_RD; messetup.c:47-49 default 0.
    RD:     { default: 0,      unit: "Î",    description: "Drain ohmic resistance" },
    // mesmpar.c:44-47 MES_MOD_RS; messetup.c:50-52 default 0.
    RS:     { default: 0,      unit: "Î",    description: "Source ohmic resistance" },
    // mesmpar.c:48-51 MES_MOD_CGS; messetup.c:53-55 default 0.
    CGS:    { default: 0,      unit: "F",    description: "G-S junction capacitance" },
    // mesmpar.c:52-55 MES_MOD_CGD; messetup.c:56-58 default 0.
    CGD:    { default: 0,      unit: "F",    description: "G-D junction capacitance" },
    // mesmpar.c:56-59 MES_MOD_PB; messetup.c:59-61 default 1.0.
    PB:     { default: 1.0,    unit: "V",    description: "Gate junction potential" },
    // mesmpar.c:60-63 MES_MOD_IS; messetup.c:62-64 default 1e-14.
    IS:     { default: 1e-14,  unit: "A",    description: "Gate junction saturation current" },
    // mesmpar.c:64-67 MES_MOD_FC; messetup.c:65-67 default 0.5.
    FC:     { default: 0.5,                  description: "Forward-bias junction fit parameter" },
    // mesmpar.c:78-81 MES_MOD_KF; messetup.c:68-70 default 0. Parsed only —
    // consumed by MESnoise (no noise analysis in digiTS), feeds no eval path.
    KF:     { default: 0,                    description: "Flicker noise coefficient" },
    // mesmpar.c:82-85 MES_MOD_AF; messetup.c:71-73 default 1.
    AF:     { default: 1,                    description: "Flicker noise exponent" },
  },
  instance: {
    // mesparam.c:24-27 MES_AREA; messetup.c:79-81 default 1.
    AREA:  { default: 1.0,               description: "Area factor" },
    // mesparam.c:28-31 MES_M; messetup.c:82-84 default 1.
    M:     { default: 1.0,               description: "Parallel multiplier" },
    // mesparam.c:40-42 MES_OFF.
    OFF:   { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    // mesparam.c:32-35 MES_IC_VDS / mesparam.c:51-54 MES_IC vec[0]. ic= vector
    // emits vds first.
    ICVDS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 0 }, spiceName: "icvds", description: "Initial condition for Vds (MODEUIC)" },
    // mesparam.c:36-39 MES_IC_VGS / mesparam.c:47-50 MES_IC vec[1].
    ICVGS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 1 }, spiceName: "icvgs", description: "Initial condition for Vgs (MODEUIC)" },
  },
});

// ---------------------------------------------------------------------------
// MesfetParams- resolved model parameters
// ---------------------------------------------------------------------------

export interface MesfetParams {
  VTO: number;
  BETA: number;
  ALPHA: number;
  LAMBDA: number;
  B: number;
  RD: number;
  RS: number;
  CGS: number;
  CGD: number;
  PB: number;
  IS: number;
  FC: number;
  KF: number;
  AF: number;
  AREA: number;
  M: number;
  OFF: number;
  ICVDS: number;
  ICVGS: number;
  [key: string]: number;
}

// ---------------------------------------------------------------------------
// State schema- MESFET. mesdefs.h:150-162 MESstate offsets, 13 slots
// (MESnumStates, mesdefs.h:15). Layout identical to JFET.
// ---------------------------------------------------------------------------

export const MES_SCHEMA: StateSchema = defineStateSchema("MesfetElement", [
  { name: "VGS",  doc: "mesdefs.h MESvgs=MESstate+0" },
  { name: "VGD",  doc: "mesdefs.h MESvgd=MESstate+1" },
  { name: "CG",   doc: "mesdefs.h MEScg=MESstate+2" },
  { name: "CD",   doc: "mesdefs.h MEScd=MESstate+3" },
  { name: "CGD",  doc: "mesdefs.h MEScgd=MESstate+4" },
  { name: "GM",   doc: "mesdefs.h MESgm=MESstate+5" },
  { name: "GDS",  doc: "mesdefs.h MESgds=MESstate+6" },
  { name: "GGS",  doc: "mesdefs.h MESggs=MESstate+7" },
  { name: "GGD",  doc: "mesdefs.h MESggd=MESstate+8" },
  { name: "QGS",  doc: "mesdefs.h MESqgs=MESstate+9" },
  { name: "CQGS", doc: "mesdefs.h MEScqgs=MESstate+10" },
  { name: "QGD",  doc: "mesdefs.h MESqgd=MESstate+11" },
  { name: "CQGD", doc: "mesdefs.h MEScqgd=MESstate+12" },
]);

// Slot indices (match MES_SCHEMA order, mirror mesdefs.h:150-162).
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
// MesfetModelTemp- model-level derived quantities (MEStemp, mestemp.c:29-49).
// Temperature-INDEPENDENT (MEStemp ignores ckt, mestemp.c:24 NG_IGNORE(ckt)).
// ---------------------------------------------------------------------------

interface MesfetModelTemp {
  drainConduct: number;
  sourceConduct: number;
  depletionCap: number;
  f1: number;
  f2: number;
  f3: number;
  vcrit: number;
}

/** Port of `mestemp.c::MEStemp` (mestemp.c:29-49). Computes the model-level
 *  derived quantities once from the model params. CONSTvt0 → VT,
 *  CONSTroot2 → Math.SQRT2. */
function computeMesfetModelTemp(p: MesfetParams): MesfetModelTemp {
  // mestemp.c:29-38- series-resistance conductances (0 when R == 0).
  const drainConduct  = p.RD !== 0 ? 1 / p.RD : 0;
  const sourceConduct = p.RS !== 0 ? 1 / p.RS : 0;
  // mestemp.c:40-46- depletion-cap transition voltage + polynomial coeffs.
  const depletionCap = p.FC * p.PB;             // mestemp.c:40-41
  const xfc  = 1 - p.FC;                         // mestemp.c:42
  const temp = Math.sqrt(xfc);                   // mestemp.c:43
  const f1 = p.PB * (1 - temp) / (1 - 0.5);     // mestemp.c:44
  const f2 = temp * temp * temp;                 // mestemp.c:45
  const f3 = 1 - p.FC * (1 + 0.5);              // mestemp.c:46
  // mestemp.c:47-48- junction critical voltage.
  const vcrit = VT * Math.log(VT / (Math.SQRT2 * p.IS));
  return { drainConduct, sourceConduct, depletionCap, f1, f2, f3, vcrit };
}

// ---------------------------------------------------------------------------
// qggnew- smoothed gate-charge model (mesload.c:464-496). Returns the charge
// value plus the two companion capacitances cgsnew/cgdnew.
// ---------------------------------------------------------------------------

function qggnew(
  vgs: number, vgd: number, phib: number, vcap: number, vto: number,
  cgs: number, cgd: number,
): { qgg: number; cgsnew: number; cgdnew: number } {
  const veroot = Math.sqrt((vgs - vgd) * (vgs - vgd) + vcap * vcap); // mesload.c:472
  const veff1 = 0.5 * (vgs + vgd + veroot);                          // mesload.c:473
  const veff2 = veff1 - veroot;                                      // mesload.c:474
  const del = 0.2;                                                   // mesload.c:475
  const vnroot = Math.sqrt((veff1 - vto) * (veff1 - vto) + del * del); // mesload.c:476
  let vnew1 = 0.5 * (veff1 + vto + vnroot);                          // mesload.c:477
  const vnew3 = vnew1;                                               // mesload.c:478
  const vmax = 0.5;                                                  // mesload.c:479
  let ext: number;
  if (vnew1 < vmax) {                                                // mesload.c:480-485
    ext = 0;
  } else {
    vnew1 = vmax;
    ext = (vnew3 - vmax) / Math.sqrt(1 - vmax / phib);
  }
  const qroot = Math.sqrt(1 - vnew1 / phib);                         // mesload.c:487
  const qggval = cgs * (2 * phib * (1 - qroot) + ext) + cgd * veff2; // mesload.c:488
  const par1 = 0.5 * (1 + (veff1 - vto) / vnroot);                   // mesload.c:489
  const cfact = (vgs - vgd) / veroot;                                // mesload.c:490
  const cplus = 0.5 * (1 + cfact);                                   // mesload.c:491
  const cminus = cplus - cfact;                                      // mesload.c:492
  const cgsnew = cgs / qroot * par1 * cplus + cgd * cminus;          // mesload.c:493
  const cgdnew = cgs / qroot * par1 * cminus + cgd * cplus;          // mesload.c:494
  return { qgg: qggval, cgsnew, cgdnew };
}

// ---------------------------------------------------------------------------
// MesfetAnalogElement- shared Statz load body. Polarity is the only difference
// between N and P channel (mesload.c:116-117, 158-165, 432-434 multiply by
// MEStype); subclasses set `_polarity`.
// ---------------------------------------------------------------------------

abstract class MesfetAnalogElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MES;
  readonly deviceFamily: DeviceFamily = "MES";
  readonly stateSchema = MES_SCHEMA;
  readonly stateSize = MES_SCHEMA.size;

  /** MEStype channel-polarity literal (mesdefs.h:221-222). */
  protected abstract readonly _polarity: 1 | -1;

  protected _params: MesfetParams;
  protected _mt: MesfetModelTemp;

  // Ephemeral per-iteration icheck flag (mesload.c:406-414 CKTnoncon bump).
  private _icheckLimited = false;

  // mesdefs.h:86-87 MESicVDSGiven / MESicVGSGiven- gate the MESgetic capture
  // (mesgetic.c:28, 33) and the hot-loaded IC seed (mesparam.c:32-39).
  protected _icVDSGiven: boolean;
  protected _icVGSGiven: boolean;

  // Internal nodes allocated during setup()- messetup.c:88-131.
  private _sourcePrimeNode = -1;
  private _drainPrimeNode  = -1;

  // TSTALLOC handles- messetup.c:139-153.
  private _hDDP  = -1; private _hGDP  = -1; private _hGSP  = -1; private _hSSP  = -1;
  private _hDPD  = -1; private _hDPG  = -1; private _hDPSP = -1;
  private _hSPG  = -1; private _hSPS  = -1; private _hSPDP = -1;
  private _hDD   = -1; private _hGG   = -1; private _hSS   = -1;
  private _hDPDP = -1; private _hSPSP = -1;

  // Internal-node labels recorded in allocation order.
  private readonly _internalLabels: string[] = [];

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._icVDSGiven = props.isModelParamGiven("ICVDS");
    this._icVGSGiven = props.isModelParamGiven("ICVGS");
    this._params = {
      VTO:    props.getModelParam<number>("VTO"),
      BETA:   props.getModelParam<number>("BETA"),
      ALPHA:  props.getModelParam<number>("ALPHA"),
      LAMBDA: props.getModelParam<number>("LAMBDA"),
      B:      props.getModelParam<number>("B"),
      RD:     props.getModelParam<number>("RD"),
      RS:     props.getModelParam<number>("RS"),
      CGS:    props.getModelParam<number>("CGS"),
      CGD:    props.getModelParam<number>("CGD"),
      PB:     props.getModelParam<number>("PB"),
      IS:     props.getModelParam<number>("IS"),
      FC:     props.getModelParam<number>("FC"),
      KF:     props.getModelParam<number>("KF"),
      AF:     props.getModelParam<number>("AF"),
      AREA:   props.getModelParam<number>("AREA"),
      M:      props.getModelParam<number>("M"),
      OFF:    props.getModelParam<number>("OFF"),
      ICVDS:  props.getModelParam<number>("ICVDS"),
      ICVGS:  props.getModelParam<number>("ICVGS"),
    };
    this._mt = computeMesfetModelTemp(this._params);
  }

  get _p(): MesfetParams {
    return this._params;
  }

  setup(ctx: SetupContext): void {
    const solver     = ctx.solver;
    const gateNode   = this.pinNodes.get("G")!;
    const sourceNode = this.pinNodes.get("S")!;
    const drainNode  = this.pinNodes.get("D")!;

    // messetup.c:85-86- state-pool base allocation.
    this._stateBase = ctx.allocStates(this.stateSize);

    // messetup.c:88-109- source-prime node created first, only when RS != 0.
    this._internalLabels.length = 0;
    if (this._params.RS === 0) {
      this._sourcePrimeNode = sourceNode;          // messetup.c:107-108
    } else {
      this._sourcePrimeNode = ctx.makeVolt(this.label, "source"); // messetup.c:90-92
      this._internalLabels.push("source");
    }
    // messetup.c:110-131- drain-prime node created second, only when RD != 0.
    if (this._params.RD === 0) {
      this._drainPrimeNode = drainNode;            // messetup.c:129-130
    } else {
      this._drainPrimeNode = ctx.makeVolt(this.label, "drain");   // messetup.c:112-114
      this._internalLabels.push("drain");
    }

    const sp = this._sourcePrimeNode;
    const dp = this._drainPrimeNode;

    // messetup.c:139-153- 15 matrix element pointers, fixed order.
    this._hDDP  = solver.allocElement(drainNode,  dp);          // (1) messetup.c:139
    this._hGDP  = solver.allocElement(gateNode,   dp);          // (2) messetup.c:140
    this._hGSP  = solver.allocElement(gateNode,   sp);          // (3) messetup.c:141
    this._hSSP  = solver.allocElement(sourceNode, sp);          // (4) messetup.c:142
    this._hDPD  = solver.allocElement(dp,         drainNode);   // (5) messetup.c:143
    this._hDPG  = solver.allocElement(dp,         gateNode);    // (6) messetup.c:144
    this._hDPSP = solver.allocElement(dp,         sp);          // (7) messetup.c:145
    this._hSPG  = solver.allocElement(sp,         gateNode);    // (8) messetup.c:146
    this._hSPS  = solver.allocElement(sp,         sourceNode);  // (9) messetup.c:147
    this._hSPDP = solver.allocElement(sp,         dp);          // (10) messetup.c:148
    this._hDD   = solver.allocElement(drainNode,  drainNode);   // (11) messetup.c:149
    this._hGG   = solver.allocElement(gateNode,   gateNode);    // (12) messetup.c:150
    this._hSS   = solver.allocElement(sourceNode, sourceNode);  // (13) messetup.c:151
    this._hDPDP = solver.allocElement(dp,         dp);          // (14) messetup.c:152
    this._hSPSP = solver.allocElement(sp,         sp);          // (15) messetup.c:153
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  /**
   * Single-pass load mirroring mesload.c::MESload line-by-line (full v26 Statz
   * model). Polarity = MEStype literal.
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
    const mt = this._mt;
    const polarity = this._polarity;
    const m = params.M;

    const nodeG = this.pinNodes.get("G")!;

    // mesload.c:97-102- area-scaled dc parameters; csat from gate sat current.
    const beta  = params.BETA * params.AREA;
    const gdpr  = mt.drainConduct  * params.AREA;
    const gspr  = mt.sourceConduct * params.AREA;
    const csat  = params.IS * params.AREA;
    const vcrit = mt.vcrit;
    const vto   = params.VTO;

    // mesload.c:106- icheck init.
    let icheck = 1;
    let bypassed = false;

    let vgs: number;
    let vgd: number;
    // Promoted to function scope so the bypass reload and stamp phase share the
    // same bindings; computed in the body below.
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
      // mesload.c:107-109.
      vgs = s0[base + SLOT_VGS];
      vgd = s0[base + SLOT_VGD];
    } else if (mode & MODEINITTRAN) {
      // mesload.c:110-112.
      vgs = s1[base + SLOT_VGS];
      vgd = s1[base + SLOT_VGD];
    } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
      // mesload.c:113-118- UIC operating-point seed from the instance IC params.
      //   vds = MEStype*MESicVDS; vgs = MEStype*MESicVGS; vgd = vgs - vds.
      const vds0 = polarity * params.ICVDS;
      vgs = polarity * params.ICVGS;
      vgd = vgs - vds0;
    } else if ((mode & MODEINITJCT) && params.OFF === 0) {
      // mesload.c:119-122- initJct, device on.
      vgs = -1;
      vgd = -1;
    } else if ((mode & MODEINITJCT) ||
               ((mode & MODEINITFIX) && params.OFF !== 0)) {
      // mesload.c:123-126- initJct w/ OFF or initFix+OFF.
      vgs = 0;
      vgd = 0;
    } else {
      // mesload.c:128-168.
      if (mode & MODEINITPRED) {
        // mesload.c:129-153- predictor step (#ifndef PREDICTOR is true by
        // default). xfact extrapolation of vgs/vgd plus 9-slot state copy.
        const xfact = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0; // mesload.c:130
        s0[base + SLOT_VGS] = s1[base + SLOT_VGS];                        // mesload.c:131-132
        vgs = (1 + xfact) * s1[base + SLOT_VGS] - xfact * s2[base + SLOT_VGS]; // mesload.c:133-134
        s0[base + SLOT_VGD] = s1[base + SLOT_VGD];                        // mesload.c:135-136
        vgd = (1 + xfact) * s1[base + SLOT_VGD] - xfact * s2[base + SLOT_VGD]; // mesload.c:137-138
        s0[base + SLOT_CG]  = s1[base + SLOT_CG];                         // mesload.c:139-140
        s0[base + SLOT_CD]  = s1[base + SLOT_CD];                         // mesload.c:141-142
        s0[base + SLOT_CGD] = s1[base + SLOT_CGD];                        // mesload.c:143-144
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];                         // mesload.c:145-146
        s0[base + SLOT_GDS] = s1[base + SLOT_GDS];                        // mesload.c:147-148
        s0[base + SLOT_GGS] = s1[base + SLOT_GGS];                        // mesload.c:149-150
        s0[base + SLOT_GGD] = s1[base + SLOT_GGD];                        // mesload.c:151-152
      } else {
        // mesload.c:155-165- compute new nonlinear branch voltages from
        // CKTrhsOld, premultiplied by MEStype.
        const vG  = voltages[nodeG];
        const vSP = voltages[this._sourcePrimeNode];
        const vDP = voltages[this._drainPrimeNode];
        vgs = polarity * (vG - vSP);
        vgd = polarity * (vG - vDP);
      }
      // mesload.c:169-178- delvgs/delvgd/delvds + extrapolated cghat/cdhat.
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

      // mesload.c:179-211- NOBYPASS bypass test.
      if (ctx.bypass && !(mode & MODEINITPRED)) {
        const vgsOld2 = s0[base + SLOT_VGS];
        const vgdOld2 = s0[base + SLOT_VGD];
        const cgOld  = s0[base + SLOT_CG];
        const cdOld  = s0[base + SLOT_CD];
        if (Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(vgsOld2)) + ctx.voltTol)
        if (Math.abs(delvgd) < ctx.reltol * Math.max(Math.abs(vgd), Math.abs(vgdOld2)) + ctx.voltTol)
        if (Math.abs(cghat - cgOld) < ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cgOld)) + ctx.iabstol)
        if (Math.abs(cdhat - cdOld) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cdOld)) + ctx.iabstol) {
          // mesload.c:199-210- we can do a bypass.
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

      if (!bypassed) {
        // mesload.c:213-226- limit nonlinear branch voltages: pnjlim (×2,
        // OR-ing ichk1 into icheck) then fetlim (×2). CONSTvt0 → VT.
        const vgsOld = s0[base + SLOT_VGS];
        const vgdOld = s0[base + SLOT_VGD];

        const vgsResult = pnjlim(vgs, vgsOld, VT, vcrit);
        vgs = vgsResult.value;
        icheck = vgsResult.limited ? 1 : 0;

        const vgdResult = pnjlim(vgd, vgdOld, VT, vcrit);
        vgd = vgdResult.value;
        // mesload.c:220-222- if (ichk1 == 1) icheck = 1.
        if (vgdResult.limited) icheck = 1;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "GS",
            limitType: "pnjlim",
            vBefore: polarity * (voltages[nodeG] - voltages[this._sourcePrimeNode]),
            vAfter: vgs,
            wasLimited: vgsResult.limited,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "GD",
            limitType: "pnjlim",
            vBefore: polarity * (voltages[nodeG] - voltages[this._drainPrimeNode]),
            vAfter: vgd,
            wasLimited: vgdResult.limited,
          });
        }

        vgs = fetlim(vgs, vgsOld, vto); // mesload.c:223-224 DEVfetlim
        vgd = fetlim(vgd, vgdOld, vto); // mesload.c:225-226
      }
    }

    this._icheckLimited = icheck === 1;

    if (!bypassed) {
    // mesload.c:231- vds = vgs - vgd.
    const vds = vgs - vgd;

    // mesload.c:233-242- gate-source junction: cubic expansion below -3*vt0,
    // else exp. CONSTvt0 → VT, CONSTe → Math.E. Note `<=`.
    if (vgs <= -3 * VT) {
      let arg = 3 * VT / (vgs * Math.E);
      arg = arg * arg * arg;
      cg  = -csat * (1 + arg) + ctx.cktGmin * vgs;
      ggs = csat * 3 * arg / vgs + ctx.cktGmin;
    } else {
      const evgs = Math.exp(vgs / VT);
      ggs = csat * evgs / VT + ctx.cktGmin;
      cg  = csat * (evgs - 1) + ctx.cktGmin * vgs;
    }
    // mesload.c:243-252- gate-drain junction, same shape on vgd.
    if (vgd <= -3 * VT) {
      let arg = 3 * VT / (vgd * Math.E);
      arg = arg * arg * arg;
      cgd = -csat * (1 + arg) + ctx.cktGmin * vgd;
      ggd = csat * 3 * arg / vgd + ctx.cktGmin;
    } else {
      const evgd = Math.exp(vgd / VT);
      ggd = csat * evgd / VT + ctx.cktGmin;
      cgd = csat * (evgd - 1) + ctx.cktGmin * vgd;
    }
    // mesload.c:254- cg = cg + cgd.
    cg = cg + cgd;

    // mesload.c:258-333- Statz drain current + derivatives.
    let cdrain: number;
    if (vds >= 0) {
      // mesload.c:258-293- normal mode.
      const vgst = vgs - params.VTO;             // mesload.c:259
      if (vgst <= 0) {                           // mesload.c:263-266- cutoff
        cdrain = 0;
        gm = 0;
        gds = 0;
      } else {
        const prod = 1 + params.LAMBDA * vds;    // mesload.c:268
        const betap = beta * prod;               // mesload.c:269
        const denom = 1 + params.B * vgst;       // mesload.c:270
        const invdenom = 1 / denom;              // mesload.c:271
        if (vds >= (3 / params.ALPHA)) {         // mesload.c:272- saturation
          cdrain = betap * vgst * vgst * invdenom;                         // mesload.c:276
          gm = betap * vgst * (1 + denom) * invdenom * invdenom;           // mesload.c:277
          gds = params.LAMBDA * beta * vgst * vgst * invdenom;             // mesload.c:278-279
        } else {                                  // mesload.c:280-292- linear
          const afact = 1 - params.ALPHA * vds / 3;                        // mesload.c:284
          const lfact = 1 - afact * afact * afact;                         // mesload.c:285
          cdrain = betap * vgst * vgst * invdenom * lfact;                 // mesload.c:286
          gm = betap * vgst * (1 + denom) * invdenom * invdenom * lfact;   // mesload.c:287-288
          gds = beta * vgst * vgst * invdenom * (params.ALPHA *
              afact * afact * prod + lfact *
              params.LAMBDA);                                              // mesload.c:289-291
        }
      }
    } else {
      // mesload.c:294-333- inverse mode (vds < 0), driven by vgd.
      const vgdt = vgd - params.VTO;             // mesload.c:298
      if (vgdt <= 0) {                           // mesload.c:299-305- cutoff
        cdrain = 0;
        gm = 0;
        gds = 0;
      } else {
        const prod = 1 - params.LAMBDA * vds;    // mesload.c:310
        const betap = beta * prod;               // mesload.c:311
        const denom = 1 + params.B * vgdt;       // mesload.c:312
        const invdenom = 1 / denom;              // mesload.c:313
        if (-vds >= (3 / params.ALPHA)) {        // mesload.c:314- inverse saturation
          cdrain = -betap * vgdt * vgdt * invdenom;                        // mesload.c:315
          gm = -betap * vgdt * (1 + denom) * invdenom * invdenom;          // mesload.c:316
          gds = params.LAMBDA * beta * vgdt * vgdt * invdenom - gm;        // mesload.c:317-318
        } else {                                  // mesload.c:319-331- inverse linear
          const afact = 1 + params.ALPHA * vds / 3;                        // mesload.c:323
          const lfact = 1 - afact * afact * afact;                         // mesload.c:324
          cdrain = -betap * vgdt * vgdt * invdenom * lfact;                // mesload.c:325
          gm = -betap * vgdt * (1 + denom) * invdenom * invdenom * lfact;  // mesload.c:326-327
          gds = beta * vgdt * vgdt * invdenom * (params.ALPHA *
              afact * afact * prod + lfact *
              params.LAMBDA) - gm;                                         // mesload.c:328-330
        }
      }
    }
    // mesload.c:337- cd = cdrain - cgd.
    cd = cdrain - cgd;

    // mesload.c:338-339- charge-storage gate.
    const capGate = (mode & (MODETRAN | MODEINITSMSIG)) !== 0
      || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0);
    if (capGate) {
      // mesload.c:343-348- charge-storage model parameters.
      const czgs = params.CGS * params.AREA;     // mesload.c:343
      const czgd = params.CGD * params.AREA;     // mesload.c:344
      const phib = params.PB;                    // mesload.c:345
      const vgs1 = s1[base + SLOT_VGS];          // mesload.c:346
      const vgd1 = s1[base + SLOT_VGD];          // mesload.c:347
      const vcap = 1 / params.ALPHA;             // mesload.c:348

      // mesload.c:350-353- 4-corner qggnew evaluation.
      const A  = qggnew(vgs,  vgd,  phib, vcap, vto, czgs, czgd);
      const Bq = qggnew(vgs1, vgd,  phib, vcap, vto, czgs, czgd);
      const C  = qggnew(vgs,  vgd1, phib, vcap, vto, czgs, czgd);
      const D  = qggnew(vgs1, vgd1, phib, vcap, vto, czgs, czgd);

      if (mode & MODEINITTRAN) {                  // mesload.c:355-358
        s1[base + SLOT_QGS] = A.qgg;
        s1[base + SLOT_QGD] = A.qgg;
      }
      // mesload.c:359-362- accumulate half-difference charge updates.
      s0[base + SLOT_QGS] = s1[base + SLOT_QGS] + 0.5 * (A.qgg - Bq.qgg + C.qgg - D.qgg);
      s0[base + SLOT_QGD] = s1[base + SLOT_QGD] + 0.5 * (A.qgg - C.qgg + Bq.qgg - D.qgg);
      const capgs = A.cgsnew;                     // mesload.c:363
      const capgd = A.cgdnew;                     // mesload.c:364

      // mesload.c:369-401- store small-signal / integrate (skipped for UIC TRANOP).
      if ((!(mode & MODETRANOP)) || (!(mode & MODEUIC))) {
        if (mode & MODEINITSMSIG) {               // mesload.c:371-374
          s0[base + SLOT_QGS] = capgs;
          s0[base + SLOT_QGD] = capgd;
          return; // ngspice `continue` → skip all stamps for this instance
        }
        if (mode & MODEINITTRAN) {                 // mesload.c:379-384
          s1[base + SLOT_QGS] = s0[base + SLOT_QGS];
          s1[base + SLOT_QGD] = s0[base + SLOT_QGD];
        }
        // mesload.c:385-388- NIintegrate G-S charge: geq → ggs, companion → cg.
        {
          const { ccap, geq } = niIntegrate(
            ctx.method, ctx.order, capgs, ctx.ag,
            s0[base + SLOT_QGS], s1[base + SLOT_QGS],
            [s2[base + SLOT_QGS], 0, 0, 0, 0],
            s1[base + SLOT_CQGS],
          );
          s0[base + SLOT_CQGS] = ccap;
          ggs = ggs + geq;
          cg = cg + s0[base + SLOT_CQGS];
        }
        // mesload.c:389-394- NIintegrate G-D charge: geq → ggd, companion → cg/cd/cgd.
        {
          const { ccap, geq } = niIntegrate(
            ctx.method, ctx.order, capgd, ctx.ag,
            s0[base + SLOT_QGD], s1[base + SLOT_QGD],
            [s2[base + SLOT_QGD], 0, 0, 0, 0],
            s1[base + SLOT_CQGD],
          );
          s0[base + SLOT_CQGD] = ccap;
          ggd = ggd + geq;
          cg  = cg + s0[base + SLOT_CQGD];        // mesload.c:392
          cd  = cd - s0[base + SLOT_CQGD];        // mesload.c:393
          cgd = cgd + s0[base + SLOT_CQGD];       // mesload.c:394
        }
        if (mode & MODEINITTRAN) {                 // mesload.c:395-400
          s1[base + SLOT_CQGS] = s0[base + SLOT_CQGS];
          s1[base + SLOT_CQGD] = s0[base + SLOT_CQGD];
        }
      }
    }
    } // end if (!bypassed)

    // mesload.c:406-415- noncon bump (suppressed only when both MODEINITFIX and
    // MODEUIC are set). The cg test is `>=`, the cd test is `>`.
    if ((!(mode & MODEINITFIX)) || (!(mode & MODEUIC))) {
      const cgNoncon = Math.abs(cghat - cg)
        >= ctx.reltol * Math.max(Math.abs(cghat), Math.abs(cg)) + ctx.iabstol;
      const cdNoncon = Math.abs(cdhat - cd)
        >  ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + ctx.iabstol;
      if (this._icheckLimited || cgNoncon || cdNoncon) ctx.noncon.value++;
    }

    // mesload.c:416-424- write accepted state to state0.
    s0[base + SLOT_VGS] = vgs;
    s0[base + SLOT_VGD] = vgd;
    s0[base + SLOT_CG]  = cg;
    s0[base + SLOT_CD]  = cd;
    s0[base + SLOT_CGD] = cgd;
    s0[base + SLOT_GM]  = gm;
    s0[base + SLOT_GDS] = gds;
    s0[base + SLOT_GGS] = ggs;
    s0[base + SLOT_GGD] = ggd;

    // mesload.c:428-457- load current vector + Y matrix (label `load:`).
    const vds = vgs - vgd;

    // mesload.c:432-434- equivalent source currents (polarity = MEStype).
    const ceqgd = polarity * (cgd - ggd * vgd);
    const ceqgs = polarity * ((cg - cgd) - ggs * vgs);
    const cdreq = polarity * ((cd + cgd) - gds * vds - gm * vgs);

    const sp = this._sourcePrimeNode;
    const dp = this._drainPrimeNode;

    // mesload.c:435-439- RHS to gate / drainPrime / sourcePrime.
    stampRHS(ctx.rhs, nodeG, m * (-ceqgs - ceqgd));
    stampRHS(ctx.rhs, dp,    m * (-cdreq + ceqgd));
    stampRHS(ctx.rhs, sp,    m * (cdreq + ceqgs));

    // mesload.c:443-457- Y-matrix stamps via cached handles, m-scaled.
    solver.stampElement(this._hDDP,  m * (-gdpr));            // MESdrainDrainPrimePtr        :443
    solver.stampElement(this._hGDP,  m * (-ggd));             // MESgateDrainPrimePtr         :444
    solver.stampElement(this._hGSP,  m * (-ggs));             // MESgateSourcePrimePtr        :445
    solver.stampElement(this._hSSP,  m * (-gspr));            // MESsourceSourcePrimePtr      :446
    solver.stampElement(this._hDPD,  m * (-gdpr));            // MESdrainPrimeDrainPtr        :447
    solver.stampElement(this._hDPG,  m * (gm - ggd));         // MESdrainPrimeGatePtr         :448
    solver.stampElement(this._hDPSP, m * (-gds - gm));        // MESdrainPrimeSourcePrimePtr  :449
    solver.stampElement(this._hSPG,  m * (-ggs - gm));        // MESsourcePrimeGatePtr        :450
    solver.stampElement(this._hSPS,  m * (-gspr));            // MESsourcePrimeSourcePtr      :451
    solver.stampElement(this._hSPDP, m * (-gds));             // MESsourcePrimeDrainPrimePtr  :452
    solver.stampElement(this._hDD,   m * (gdpr));             // MESdrainDrainPtr             :453
    solver.stampElement(this._hGG,   m * (ggd + ggs));        // MESgateGatePtr               :454
    solver.stampElement(this._hSS,   m * (gspr));             // MESsourceSourcePtr           :455
    solver.stampElement(this._hDPDP, m * (gdpr + gds + ggd)); // MESdrainPrimeDrainPrimePtr   :456
    solver.stampElement(this._hSPSP, m * (gspr + gds + gm + ggs)); // MESsourcePrimeSourcePrimePtr :457
  }

  /**
   * AC small-signal admittance stamp- mesacl.c::MESacLoad line-for-line
   * (mesacl.c:36-67). Reads the operating-point conductances + gate charges
   * from CKTstate0, scales the charges by CKTomega to susceptances, and stamps
   * the complex Y matrix. Each ngspice `-=` is rendered as a stamp of the
   * negated cell expression, operand order preserved.
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

    const m = params.M;                                       // mesacl.c:36
    // mesacl.c:38-45- dc conductances + state0 conductances/charges.
    const gdpr = this._mt.drainConduct  * params.AREA;        // mesacl.c:38
    const gspr = this._mt.sourceConduct * params.AREA;        // mesacl.c:39
    const gm  = s0[base + SLOT_GM];                           // mesacl.c:40
    const gds = s0[base + SLOT_GDS];                          // mesacl.c:41
    const ggs = s0[base + SLOT_GGS];                          // mesacl.c:42
    const xgs = s0[base + SLOT_QGS] * omega;                  // mesacl.c:43
    const ggd = s0[base + SLOT_GGD];                          // mesacl.c:44
    const xgd = s0[base + SLOT_QGD] * omega;                  // mesacl.c:45

    // mesacl.c:46-67- Y stamps. Real → cell; imag (susceptance) → +1 half via
    // stampElementImag. Each ngspice `-=` rendered as a negated stamp.
    solver.stampElement(this._hDD,    m * (gdpr));                   // mesacl.c:46
    solver.stampElement(this._hGG,    m * (ggd + ggs));             // mesacl.c:47
    solver.stampElementImag(this._hGG, m * (xgd + xgs));            // mesacl.c:48
    solver.stampElement(this._hSS,    m * (gspr));                  // mesacl.c:49
    solver.stampElement(this._hDPDP,  m * (gdpr + gds + ggd));      // mesacl.c:50
    solver.stampElementImag(this._hDPDP, m * (xgd));               // mesacl.c:51
    solver.stampElement(this._hSPSP,  m * (gspr + gds + gm + ggs)); // mesacl.c:52
    solver.stampElementImag(this._hSPSP, m * (xgs));              // mesacl.c:53
    solver.stampElement(this._hDDP,   -(m * (gdpr)));              // mesacl.c:54 (-=)
    solver.stampElement(this._hGDP,   -(m * (ggd)));              // mesacl.c:55 (-=)
    solver.stampElementImag(this._hGDP, -(m * (xgd)));            // mesacl.c:56 (-=)
    solver.stampElement(this._hGSP,   -(m * (ggs)));              // mesacl.c:57 (-=)
    solver.stampElementImag(this._hGSP, -(m * (xgs)));            // mesacl.c:58 (-=)
    solver.stampElement(this._hSSP,   -(m * (gspr)));             // mesacl.c:59 (-=)
    solver.stampElement(this._hDPD,   -(m * (gdpr)));             // mesacl.c:60 (-=)
    solver.stampElement(this._hDPG,   m * (-ggd + gm));           // mesacl.c:61 (+=)
    solver.stampElementImag(this._hDPG, -(m * (xgd)));           // mesacl.c:62 (-=)
    solver.stampElement(this._hDPSP,  m * (-gds - gm));           // mesacl.c:63 (+=)
    solver.stampElement(this._hSPG,   m * (-ggs - gm));           // mesacl.c:64 (+=)
    solver.stampElementImag(this._hSPG, -(m * (xgs)));          // mesacl.c:65 (-=)
    solver.stampElement(this._hSPS,   -(m * (gspr)));            // mesacl.c:66 (-=)
    solver.stampElement(this._hSPDP,  -(m * (gds)));             // mesacl.c:67 (-=)
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const polarity = this._polarity;
    // mes.c:37-38 MES_CS/MES_POWER: id = MEStype*cd, ig = MEStype*cg.
    const id = polarity * s0[base + SLOT_CD];
    const ig = polarity * s0[base + SLOT_CG];
    // pinLayout order [G, S, D]. KCL: iS = -(ig + id).
    const iS = -(ig + id);
    return [ig, iS, id];
  }

  setParam(key: string, value: number): void {
    // mesparam.c:32-39 (MES_IC_VDS/MES_IC_VGS)- a hot-loaded IC seed sets its
    // *Given bit so MESgetic does not overwrite it from the operating point.
    if (key === "ICVDS") this._icVDSGiven = true;
    else if (key === "ICVGS") this._icVGSGiven = true;
    if (key in this._params) {
      this._params[key] = value;
      // The model-temp derived quantities (MEStemp) depend on RD/RS/PB/FC/IS,
      // so recompute after any param write (mestemp.c:29-49).
      this._mt = computeMesfetModelTemp(this._params);
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
    // mestrunc.c:24-25- CKTterr on MESqgs and MESqgd; min over both.
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

// ---------------------------------------------------------------------------
// NMESFETElement / PMESFETElement- channel-polarity concrete classes.
// ---------------------------------------------------------------------------

class NMESFETElement extends MesfetAnalogElement {
  // mesdefs.h:221 `#define NMF 1`. N-channel polarity literal.
  protected readonly _polarity: 1 = 1;
}

class PMESFETElement extends MesfetAnalogElement {
  // mesdefs.h:222 `#define PMF -1`. P-channel polarity literal.
  protected readonly _polarity: -1 = -1;
}

export function createNMesfetElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new NMESFETElement(pinNodes, props);
}

export function createPMesfetElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  return new PMESFETElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// Render elements- 3-terminal G/D/S symbol (reuses JFET geometry).
// ---------------------------------------------------------------------------

function buildMesfetPinDeclarations(): PinDeclaration[] {
  // pinLayout order [G, S, D]- mes.c:66-70 MESnames = Drain/Gate/Source. The
  // deck-pin order (D G S) is produced by the netlist-generator Z-card branch.
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

function drawMesfetBody(ctx: RenderContext, signals?: PinVoltageAccess): void {
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

  // Gate arrow.
  ctx.drawPolygon(
    [
      { x: 3.125, y: 0 },
      { x: 2.625, y: -0.1875 },
      { x: 2.625, y: 0.1875 },
    ],
    true,
  );

  // Gate lead.
  drawColoredLead(ctx, signals, vG, 0, 0, 3.125, 0);
  // Drain lead (top).
  drawColoredLead(ctx, signals, vD, 4, -1, 4, -0.5);
  ctx.drawLine(4, -0.5, 3.375, -0.5);
  // Source lead (bottom).
  drawColoredLead(ctx, signals, vS, 4, 1, 4, 0.5);
  ctx.drawLine(4, 0.5, 3.375, 0.5);

  ctx.restore();
}

export class NMesfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NMESFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildMesfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    drawMesfetBody(ctx, signals);
  }
}

export class PMesfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PMESFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildMesfetPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    drawMesfetBody(ctx, signals);
  }
}

// ---------------------------------------------------------------------------
// Property definitions + attribute mappings
// ---------------------------------------------------------------------------

const MESFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const NMESFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

export const PMESFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// StandaloneComponentDefinitions
// ---------------------------------------------------------------------------

function nMesfetCircuitFactory(props: PropertyBag): NMesfetElement {
  return new NMesfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pMesfetCircuitFactory(props: PropertyBag): PMesfetElement {
  return new PMesfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NMesfetDefinition: StandaloneComponentDefinition = {
  name: "NMESFET",
  typeId: -1,
  factory: nMesfetCircuitFactory,
  pinLayout: buildMesfetPinDeclarations(),
  voltageProbes: [
    { name: "Vds", pos: "D", neg: "S" },
    { name: "Vgs", pos: "G", neg: "S" },
  ],
  propertyDefs: MESFET_PROPERTY_DEFS,
  attributeMap: NMESFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel GaAs MESFET- Statz model with gate junction.\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, ALPHA, BETA, LAMBDA, B, RD, RS, CGS, CGD, PB, IS, FC.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createNMesfetElement,
      paramDefs: MESFET_PARAM_DEFS,
      params: MESFET_PARAM_DEFAULTS,
      spice: { device: "MES", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice",
};

export const PMesfetDefinition: StandaloneComponentDefinition = {
  name: "PMESFET",
  typeId: -1,
  factory: pMesfetCircuitFactory,
  pinLayout: buildMesfetPinDeclarations(),
  voltageProbes: [
    { name: "Vsd", pos: "S", neg: "D" },
    { name: "Vsg", pos: "S", neg: "G" },
  ],
  propertyDefs: MESFET_PROPERTY_DEFS,
  attributeMap: PMESFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel GaAs MESFET- Statz model (polarity inverted).\n" +
    "Pins: G (gate), D (drain), S (source).\n" +
    "Model parameters: VTO, ALPHA, BETA, LAMBDA, B, RD, RS, CGS, CGD, PB, IS, FC.",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createPMesfetElement,
      paramDefs: MESFET_PARAM_DEFS,
      params: MESFET_PARAM_DEFAULTS,
      spice: { device: "MES", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice",
};
