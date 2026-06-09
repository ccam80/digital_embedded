/**
 * MOSFET LEVEL 3 analog components — N-channel / P-channel semi-empirical
 * short-channel MOSFETs.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/mos3/`:
 *   - mos3defs.h  — instance/model structs, the 17 state slots (:277-302).
 *   - mos3set.c   — MOS3setup (model defaults, prime-node alloc, TSTALLOC).
 *   - mos3temp.c  — MOS3temp (model preprocessing + per-instance correction).
 *   - mos3load.c  — MOS3load (the moseq3 drain-current core, bulk diodes,
 *                   Meyer caps, charge integration, RHS + Y-matrix stamps).
 *   - mos3acld.c  — MOS3acLoad (AC small-signal).
 *   - mos3trun.c  — MOS3trunc (LTE via CKTterr on the three Meyer-gate charges).
 *   - mos3conv.c  — MOS3convTest (folded inline into load() noncon flag).
 *   - mos3par.c / mos3mpar.c — instance / model parameter setters.
 *   - mos3.c      — IFparm tables; MOS3names[] = {Drain,Gate,Source,Bulk}.
 *
 * Single-pass `load()` per device per NR iteration (unified-interface model,
 * sibling of mosfet.ts). MOS3type carries the device polarity (+1 NMOS / -1
 * PMOS); Mosfet3NDefinition/Mosfet3PDefinition seed it via the default model.
 * State lives in StatePool slots; load() reads s1/s2/s3 and writes s0. All
 * params are hot-loadable via setParam.
 *
 * MOS3 is a genuine 4-terminal device with a separate Bulk node
 * (mos3.c:162-167; MOS3bNode, mos3defs.h:44). The Meyer helper devQmeyer is
 * imported from mosfet.ts; the limiters / niIntegrate / cktTerr are existing
 * shared exports.
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
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { fetlim, limvds, pnjlim } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { devQmeyer } from "./mosfet.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX, MODEINITSMSIG,
  MODEINITTRAN, MODEINITPRED, MODETRAN, MODETRANOP, MODEUIC,
  MODEDCOP, MODEDCTRANCURVE,
} from "../../solver/analog/ckt-mode.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import {
  CONSTboltz,
  CHARGE,
  CONSTKoverQ,
  REFTEMP,
} from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Exponential-argument ceiling (defines.h MAX_EXP_ARG). */
const MAX_EXP_ARG = 709.0;
/** Euler's number (const.h CONSTe). Used by the vbs/vbd <= -3*vt diode tail. */
const CONSTe = Math.E;
/** sqrt(2) (const.h CONSTroot2). Used by the vcrit setup. */
const CONSTroot2 = Math.SQRT2;
/** Permittivity of silicon: EPSSIL = 11.7 * 8.854214871e-12 (mos3set.c:16, mos3temp.c:15). */
const EPSSIL = 11.7 * 8.854214871e-12;
/** Permittivity of SiO2: 3.9 * 8.854214871e-12 (mos3temp.c:62). */
const EPS_OX = 3.9 * 8.854214871e-12;

// ---------------------------------------------------------------------------
// Part A — MOSFET3_SCHEMA (17 state slots)
//
// cite: mos3defs.h:277-302 — MOS3NUMSTATES 17. One slot per #define, same
// order: the state-vector layout the integrator/predictor index by. Identical
// to the MOS1 layout; the level-3 distinction is in the drain-current math.
// ---------------------------------------------------------------------------

export const MOSFET3_SCHEMA: StateSchema = defineStateSchema("Mosfet3Element", [
  { name: "VBD",   doc: "mos3defs.h MOS3vbd=0" },
  { name: "VBS",   doc: "mos3defs.h MOS3vbs=1" },
  { name: "VGS",   doc: "mos3defs.h MOS3vgs=2" },
  { name: "VDS",   doc: "mos3defs.h MOS3vds=3" },
  { name: "CAPGS", doc: "mos3defs.h MOS3capgs=4" },
  { name: "QGS",   doc: "mos3defs.h MOS3qgs=5" },
  { name: "CQGS",  doc: "mos3defs.h MOS3cqgs=6" },
  { name: "CAPGD", doc: "mos3defs.h MOS3capgd=7" },
  { name: "QGD",   doc: "mos3defs.h MOS3qgd=8" },
  { name: "CQGD",  doc: "mos3defs.h MOS3cqgd=9" },
  { name: "CAPGB", doc: "mos3defs.h MOS3capgb=10" },
  { name: "QGB",   doc: "mos3defs.h MOS3qgb=11" },
  { name: "CQGB",  doc: "mos3defs.h MOS3cqgb=12" },
  { name: "QBD",   doc: "mos3defs.h MOS3qbd=13" },
  { name: "CQBD",  doc: "mos3defs.h MOS3cqbd=14" },
  { name: "QBS",   doc: "mos3defs.h MOS3qbs=15" },
  { name: "CQBS",  doc: "mos3defs.h MOS3cqbs=16" },
]);

// Slot index constants (match MOSFET3_SCHEMA order, mos3defs.h:277-302).
const SLOT_VBD = 0;
const SLOT_VBS = 1;
const SLOT_VGS = 2;
const SLOT_VDS = 3;
const SLOT_CAPGS = 4;
const SLOT_QGS = 5;
const SLOT_CQGS = 6;
const SLOT_CAPGD = 7;
const SLOT_QGD = 8;
const SLOT_CQGD = 9;
const SLOT_CAPGB = 10;
const SLOT_QGB = 11;
const SLOT_CQGB = 12;
const SLOT_QBD = 13;
const SLOT_CQBD = 14;
const SLOT_QBS = 15;
const SLOT_CQBS = 16;

// ---------------------------------------------------------------------------
// Part B — Resolved parameter set + param defs
//
// Field set mirrors the MOS3model + sMOS3instance structs (mos3defs.h:32-421).
// Names follow the ngspice short names (rename-maps/mos3.md).
// ---------------------------------------------------------------------------

export interface ResolvedMosfet3Params {
  // model params (mos3.c MOS3mPTable / mos3mpar.c)
  VTO: number; KP: number; GAMMA: number; PHI: number;
  RD: number; RS: number; CBD: number; CBS: number; IS: number; PB: number;
  CGSO: number; CGDO: number; CGBO: number; RSH: number;
  CJ: number; MJ: number; CJSW: number; MJSW: number; JS: number;
  TOX: number; LD: number; XL: number; WD: number; XW: number; DELVTO: number;
  U0: number; FC: number; NSUB: number; TPG: number; NSS: number;
  ETA: number; DELTA: number; NFS: number; THETA: number; VMAX: number;
  KAPPA: number; XJ: number; TNOM: number; KF: number; AF: number;
  // instance params (mos3.c MOS3pTable / mos3par.c)
  M: number; W: number; L: number; AS: number; AD: number; PS: number; PD: number;
  NRS: number; NRD: number; OFF: number;
  ICVBS: number; ICVDS: number; ICVGS: number; TEMP: number; DTEMP: number;
  [key: string]: number;
}

// NMOS / PMOS defaults differ only in VTO/KP sign-of-use; ngspice keeps the
// same defaulting and applies the type sign in temp/load. We seed identical
// defaults (mos3set.c) for both and let MOS3type carry the polarity.
const MOS3_PARAM_SPEC = {
  primary: {
    VTO:  { default: 0.0,  unit: "V",     description: "Threshold voltage (mos3set.c:79-81)" },
    KP:   { default: 2e-5, unit: "A/V²",  description: "Transconductance parameter (mos3set.c:67-69)" },
    GAMMA:{ default: 0.0,  unit: "V^0.5", description: "Bulk threshold parameter (mos3set.c:109-111)" },
  },
  secondary: {
    PHI:    { default: 0.6,  unit: "V",    description: "Surface potential (mos3set.c:106-108)" },
    RD:     { default: 0,    unit: "Ω",    description: "Drain ohmic resistance (mos3set.c:58-60)" },
    RS:     { default: 0,    unit: "Ω",    description: "Source ohmic resistance (mos3set.c:61-63)" },
    CBD:    { default: 0,    unit: "F",    description: "B-D junction capacitance (mos3set.c:82-84)" },
    CBS:    { default: 0,    unit: "F",    description: "B-S junction capacitance (mos3set.c:85-87)" },
    IS:     { default: 1e-14, unit: "A",   description: "Bulk junction sat. current (mos3set.c:55-57)" },
    PB:     { default: 0.8,  unit: "V",    description: "Bulk junction potential (mos3set.c:94-96)" },
    CGSO:   { default: 0,    unit: "F/m",  description: "Gate-source overlap cap (mos3set.c:70-72)" },
    CGDO:   { default: 0,    unit: "F/m",  description: "Gate-drain overlap cap (mos3set.c:73-75)" },
    CGBO:   { default: 0,    unit: "F/m",  description: "Gate-bulk overlap cap (mos3set.c:76-78)" },
    RSH:    { default: 0,    unit: "Ω/sq", description: "Sheet resistance (mos3set.c:64-66)" },
    CJ:     { default: 0,    unit: "F/m²", description: "Bottom junction cap per area (mos3set.c:88-90)" },
    MJ:     { default: 0.5,                description: "Bottom grading coefficient (mos3set.c:97-99)" },
    CJSW:   { default: 0,    unit: "F/m",  description: "Side junction cap per length (mos3set.c:91-93)" },
    MJSW:   { default: 0.33,               description: "Side grading coefficient (mos3set.c:100-102)" },
    JS:     { default: 0,    unit: "A/m²", description: "Bulk jct. sat. current density (mos3set.c:52-54)" },
    TOX:    { default: 1e-7, unit: "m",    description: "Oxide thickness (mos3set.c:133-135)" },
    LD:     { default: 0,    unit: "m",    description: "Lateral diffusion (mos3set.c:37-39)" },
    XL:     { default: 0,    unit: "m",    description: "Length mask adjustment (mos3set.c:40-42)" },
    WD:     { default: 0,    unit: "m",    description: "Width narrowing (mos3set.c:43-45)" },
    XW:     { default: 0,    unit: "m",    description: "Width mask adjustment (mos3set.c:46-48)" },
    DELVTO: { default: 0,    unit: "V",    description: "Threshold voltage adjust (mos3set.c:49-51)" },
    U0:     { default: 600,  unit: "cm²/Vs", description: "Surface mobility (mos3temp.c:64)" },
    FC:     { default: 0.5,                description: "Forward bias jct. fit parm (mos3set.c:103-105)" },
    NSUB:   { default: 0,    unit: "cm⁻³", description: "Substrate doping (ungiven → skip)" },
    TPG:    { default: 1,                  description: "Gate type (mos3temp.c:79)" },
    NSS:    { default: 0,    unit: "cm⁻²", description: "Surface state density (mos3temp.c:91-92)" },
    ETA:    { default: 0,                  description: "Vds dependence of threshold (mos3set.c:124-126)" },
    DELTA:  { default: 0,                  description: "Width effect on threshold (mos3set.c:112-114)" },
    NFS:    { default: 0,    unit: "cm⁻²", description: "Fast surface state density (mos3set.c:121-123)" },
    THETA:  { default: 0,    unit: "1/V",  description: "Vgs dependence on mobility (mos3set.c:127-129)" },
    VMAX:   { default: 0,    unit: "m/s",  description: "Maximum carrier drift velocity (mos3set.c:115-117)" },
    KAPPA:  { default: 0.2,                description: "Channel-length modulation (mos3set.c:130-132)" },
    XJ:     { default: 0,    unit: "m",    description: "Junction depth (mos3set.c:118-120)" },
    TNOM:   { default: REFTEMP, unit: "K", description: "Parameter measurement temperature (mos3temp.c:41-43)", spiceConverter: kelvinToCelsius },
    KF:     { default: 0,                  description: "Flicker noise coefficient (mos3set.c:136-138)" },
    AF:     { default: 1,                  description: "Flicker noise exponent (mos3set.c:139-141)" },
  },
  instance: {
    M:      { default: 1,                  description: "Parallel device multiplier (mos3par.c:32-35)" },
    W:      { default: 1e-6, unit: "m",    description: "Channel width (mos3par.c:36-39)" },
    L:      { default: 1e-6, unit: "m",    description: "Channel length (mos3par.c:40-43)" },
    AS:     { default: 0,    unit: "m²",   description: "Source area (mos3par.c:44-47)" },
    AD:     { default: 0,    unit: "m²",   description: "Drain area (mos3par.c:48-51)" },
    PS:     { default: 0,    unit: "m",    description: "Source perimeter (mos3par.c:52-55)" },
    PD:     { default: 0,    unit: "m",    description: "Drain perimeter (mos3par.c:56-59)" },
    NRS:    { default: 1, spiceName: "nrs", description: "Source diffusion squares (mos3par.c:60-63)" },
    NRD:    { default: 1, spiceName: "nrd", description: "Drain diffusion squares (mos3par.c:64-67)" },
    OFF:    { default: 0, emit: "flag",    description: "Device initially off (mos3par.c:68-70)" },
    ICVDS:  { default: 0,    unit: "V",    emitGroup: { name: "IC", index: 0 }, description: "Initial D-S voltage (mos3par.c:75-78)" },
    ICVGS:  { default: 0,    unit: "V",    emitGroup: { name: "IC", index: 1 }, description: "Initial G-S voltage (mos3par.c:79-82)" },
    ICVBS:  { default: 0,    unit: "V",    emitGroup: { name: "IC", index: 2 }, description: "Initial B-S voltage (mos3par.c:71-74)" },
    TEMP:   { default: REFTEMP, unit: "K", description: "Instance operating temperature (mos3par.c:83-86)", spiceConverter: kelvinToCelsius },
    DTEMP:  { default: 0,    unit: "K",    description: "Instance temperature difference (mos3par.c:87-90)" },
  },
} as const;

export const { paramDefs: MOSFET3_N_PARAM_DEFS, defaults: MOSFET3_N_DEFAULTS } =
  defineModelParams(MOS3_PARAM_SPEC);
export const { paramDefs: MOSFET3_P_PARAM_DEFS, defaults: MOSFET3_P_DEFAULTS } =
  defineModelParams(MOS3_PARAM_SPEC);

// ---------------------------------------------------------------------------
// Part D — temperature-corrected scalars (computed by computeTemperature)
//
// cite: mos3temp.c:17-343. The model preprocessing pass (:39-114) derives
// oxideCapFactor, transconductance (if ungiven), gamma/phi/vt0 from nsub, the
// alpha / coeffDepLayWidth / narrowFactor model quantities the level-3 load
// consumes; the per-instance pass (:118-340) derives the corrected scalars.
// ---------------------------------------------------------------------------

interface Mosfet3TempScalars {
  vt: number;                    // mos3load.c:111
  oxideCapFactor: number;        // mos3temp.c:62-63
  transconductance: number;      // mos3temp.c:65-68 (effective KP)
  surfaceMobility: number;       // mos3temp.c:64
  gamma: number;                 // mos3temp.c:85-89 (possibly nsub-derived)
  phi: number;                   // mos3temp.c:71-76 (possibly nsub-derived)
  vt0: number;                   // mos3temp.c:90-101 (possibly nsub-derived)
  alpha: number;                 // mos3temp.c:102-103
  coeffDepLayWidth: number;      // mos3temp.c:104
  narrowFactor: number;          // mos3temp.c:113-114
  gateType: number;              // mos3temp.c:79
  surfaceStateDensity: number;   // mos3temp.c:91-92
  // per-instance corrected scalars
  tTransconductance: number;     // mos3temp.c:215
  tSurfMob: number;              // mos3temp.c:216
  tPhi: number;                  // mos3temp.c:217-218
  tVbi: number;                  // mos3temp.c:219-224
  tVto: number;                  // mos3temp.c:225-226
  tSatCur: number;               // mos3temp.c:227-228
  tSatCurDens: number;           // mos3temp.c:229-230
  tBulkPot: number;              // mos3temp.c:241
  tDepCap: number;               // mos3temp.c:251
  drainVcrit: number;            // mos3temp.c:253-267
  sourceVcrit: number;
  Cbd: number; Cbdsw: number; Cbs: number; Cbssw: number; // mos3temp.c:286-323
  f2d: number; f3d: number; f4d: number;                  // mos3temp.c:288-303
  f2s: number; f3s: number; f4s: number;                  // mos3temp.c:324-339
}

// ---------------------------------------------------------------------------
// _createMosfet3ElementWithPolarity — internal factory carrying MOS3type.
// ---------------------------------------------------------------------------

function _createMosfet3ElementWithPolarity(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElement {
  // Closure-captured pin node IDs (resolved in setup()).
  let nodeG = -1;
  let nodeS_ext = -1;
  let nodeD_ext = -1;
  let nodeB = -1;
  // Internal drain/source prime nodes (allocated in setup()).
  let nodeD = -1;
  let nodeS = -1;

  // Raw param read from the property bag (mos3.c / mos3mpar.c / mos3par.c set).
  const params: ResolvedMosfet3Params = {
    VTO: props.getModelParam<number>("VTO"),
    KP: props.getModelParam<number>("KP"),
    GAMMA: props.getModelParam<number>("GAMMA"),
    PHI: props.getModelParam<number>("PHI"),
    RD: props.getModelParam<number>("RD"),
    RS: props.getModelParam<number>("RS"),
    CBD: props.getModelParam<number>("CBD"),
    CBS: props.getModelParam<number>("CBS"),
    IS: props.getModelParam<number>("IS"),
    PB: props.getModelParam<number>("PB"),
    CGSO: props.getModelParam<number>("CGSO"),
    CGDO: props.getModelParam<number>("CGDO"),
    CGBO: props.getModelParam<number>("CGBO"),
    RSH: props.getModelParam<number>("RSH"),
    CJ: props.getModelParam<number>("CJ"),
    MJ: props.getModelParam<number>("MJ"),
    CJSW: props.getModelParam<number>("CJSW"),
    MJSW: props.getModelParam<number>("MJSW"),
    JS: props.getModelParam<number>("JS"),
    TOX: props.getModelParam<number>("TOX"),
    LD: props.getModelParam<number>("LD"),
    XL: props.getModelParam<number>("XL"),
    WD: props.getModelParam<number>("WD"),
    XW: props.getModelParam<number>("XW"),
    DELVTO: props.getModelParam<number>("DELVTO"),
    U0: props.getModelParam<number>("U0"),
    FC: props.getModelParam<number>("FC"),
    NSUB: props.getModelParam<number>("NSUB"),
    TPG: props.getModelParam<number>("TPG"),
    NSS: props.getModelParam<number>("NSS"),
    ETA: props.getModelParam<number>("ETA"),
    DELTA: props.getModelParam<number>("DELTA"),
    NFS: props.getModelParam<number>("NFS"),
    THETA: props.getModelParam<number>("THETA"),
    VMAX: props.getModelParam<number>("VMAX"),
    KAPPA: props.getModelParam<number>("KAPPA"),
    XJ: props.getModelParam<number>("XJ"),
    TNOM: props.getModelParam<number>("TNOM"),
    KF: props.getModelParam<number>("KF"),
    AF: props.getModelParam<number>("AF"),
    M: props.getModelParam<number>("M"),
    W: props.getModelParam<number>("W"),
    L: props.getModelParam<number>("L"),
    AS: props.getModelParam<number>("AS"),
    AD: props.getModelParam<number>("AD"),
    PS: props.getModelParam<number>("PS"),
    PD: props.getModelParam<number>("PD"),
    NRS: props.getModelParam<number>("NRS"),
    NRD: props.getModelParam<number>("NRD"),
    OFF: props.getModelParam<number>("OFF"),
    ICVBS: props.getModelParam<number>("ICVBS"),
    ICVDS: props.getModelParam<number>("ICVDS"),
    ICVGS: props.getModelParam<number>("ICVGS"),
    TEMP: props.getModelParam<number>("TEMP"),
    DTEMP: props.getModelParam<number>("DTEMP"),
  };

  // Givenness flags (mos3mpar.c / mos3par.c MOS3xxxGiven). Drive defaulting
  // branches in temp/setup that key on whether the user supplied the param.
  const given = {
    NSUB: props.isModelParamGiven("NSUB"),
    PHI: props.isModelParamGiven("PHI"),
    VTO: props.isModelParamGiven("VTO"),
    GAMMA: props.isModelParamGiven("GAMMA"),
    NSS: props.isModelParamGiven("NSS"),
    TPG: props.isModelParamGiven("TPG"),
    KP: props.isModelParamGiven("KP"),
    U0: props.isModelParamGiven("U0"),
    CBD: props.isModelParamGiven("CBD"),
    CBS: props.isModelParamGiven("CBS"),
    CJ: props.isModelParamGiven("CJ"),
    CJSW: props.isModelParamGiven("CJSW"),
    JS: props.isModelParamGiven("JS"),
    RD: props.isModelParamGiven("RD"),
    RS: props.isModelParamGiven("RS"),
    RSH: props.isModelParamGiven("RSH"),
    TEMP: props.isModelParamGiven("TEMP"),
    DTEMP: props.isModelParamGiven("DTEMP"),
  };

  let tp: Mosfet3TempScalars = {} as Mosfet3TempScalars;

  class Mosfet3AnalogElement extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MOS;
    readonly deviceFamily: DeviceFamily = "MOS";
    readonly stateSchema: StateSchema = MOSFET3_SCHEMA;
    readonly stateSize: number = MOSFET3_SCHEMA.size;

    private readonly _internalLabels: string[] = [];

    // TSTALLOC handles (mos3set.c:234-255), cached in setup(), reused in
    // load()/stampAc(). No allocElement outside setup().
    private _hDD = -1;   private _hGG = -1;   private _hSS = -1;   private _hBB = -1;
    private _hDPDP = -1; private _hSPSP = -1;
    private _hDDP = -1;  private _hGB = -1;   private _hGDP = -1;  private _hGSP = -1;
    private _hSSP = -1;  private _hBDP = -1;  private _hBSP = -1;  private _hDPSP = -1;
    private _hDPD = -1;  private _hBG = -1;   private _hDPG = -1;  private _hSPG = -1;
    private _hSPS = -1;  private _hDPB = -1;  private _hSPB = -1;  private _hSPDP = -1;

    // sMOS3instance scalar fields not in the state vector (mos3defs.h:84-104).
    private _cd   = 0;
    private _cbd  = 0;
    private _cbs  = 0;
    private _gbd  = 0;
    private _gbs  = 0;
    private _gm   = 0;
    private _gds  = 0;
    private _gmbs = 0;
    private _mode = 1;   // mos3set.c:184-186 default mode 1
    private _von  = 0;
    private _vdsat = 0;
    private _capbd = 0;
    private _capbs = 0;
    private _drainConductance  = 0;
    private _sourceConductance = 0;

    // per-instance temperature: temp = CKTtemp + dtemp unless given (mos3temp.c:131-137).
    private _tempGiven = given.TEMP;
    private _dtempGiven = given.DTEMP;
    private _temp = params.TEMP;
    private _dtemp = params.DTEMP;
    private _lastCtx: TempContext = { cktTemp: REFTEMP, cktNomTemp: params.TNOM, reltol: 1e-3, epsmin: 1e-28, _indVerbosity: 2 };

    constructor(pinNodes: ReadonlyMap<string, number>) {
      super(pinNodes);
    }

    // -----------------------------------------------------------------------
    // Part D — computeTemperature() + _computeModelTemp() + _computeTempInstance()
    // -----------------------------------------------------------------------
    computeTemperature(ctx: TempContext): void {
      this._lastCtx = ctx;
      // cite: mos3temp.c:39-114 — model preprocessing, once.
      this._computeModelTemp(ctx);
      // cite: mos3temp.c:131-137 — dtemp default, temp = CKTtemp + dtemp.
      if (!this._dtempGiven) this._dtemp = 0.0;
      if (!this._tempGiven) this._temp = ctx.cktTemp + this._dtemp;
      // cite: mos3temp.c:118-340 — per-instance temperature correction.
      this._computeTempInstance(this._temp, ctx);
    }

    /** cite: mos3temp.c:39-114 — model preprocessing pass (once per model). */
    private _computeModelTemp(ctx: TempContext): void {
      const tnom = params.TNOM;
      // mos3temp.c:44-54 — nominal constants.
      const fact1 = tnom / REFTEMP;
      const vtnom = tnom * CONSTKoverQ;
      const kt1 = CONSTboltz * tnom;
      const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
      const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
      this._pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);
      this._fact1 = fact1;
      let nifact = (tnom / 300) * Math.sqrt(tnom / 300);
      nifact *= Math.exp(0.5 * egfet1 * ((1 / 300) - (1 / tnom)) / CONSTKoverQ);
      const niTemp = 1.45e16 * nifact;

      // mos3temp.c:56-60 — phi <= 0 fatal.
      if (params.PHI <= 0.0) {
        ctx.diagnostics?.emit({ severity: "error", code: "model-param-ignored", message: "MOS3: Phi is not positive." });
      }

      // mos3temp.c:62-68 — oxideCapFactor, surfaceMobility, transconductance.
      let oxideCapFactor = 3.9 * 8.854214871e-12 / params.TOX;
      void EPS_OX;
      let surfaceMobility = given.U0 ? params.U0 : 600;
      let transconductance = given.KP
        ? params.KP
        : surfaceMobility * oxideCapFactor * 1e-4;

      let gamma = params.GAMMA;
      let phi = params.PHI;
      let vt0 = params.VTO;
      let alpha = 0;
      let coeffDepLayWidth = 0;
      let gateType = given.TPG ? params.TPG : 1;
      let surfaceStateDensity = params.NSS;

      // mos3temp.c:69-111 — nsub-derived gamma/phi/vt0/alpha.
      if (given.NSUB) {
        if (params.NSUB * 1e6 > niTemp) {
          if (!given.PHI) {
            phi = 2 * vtnom * Math.log(params.NSUB * 1e6 / niTemp);
            phi = Math.max(0.1, phi);
          }
          const fermis = polarity * 0.5 * phi;
          let wkfng = 3.2;
          if (!given.TPG) gateType = 1;
          if (gateType !== 0) {
            const fermig = polarity * gateType * 0.5 * egfet1;
            wkfng = 3.25 + 0.5 * egfet1 - fermig;
          }
          const wkfngs = wkfng - (3.25 + 0.5 * egfet1 + fermis);
          if (!given.GAMMA) {
            gamma = Math.sqrt(2 * EPSSIL * CHARGE * params.NSUB * 1e6) / oxideCapFactor;
          }
          if (!given.VTO) {
            if (!given.NSS) surfaceStateDensity = 0;
            const vfb = wkfngs - surfaceStateDensity * 1e4 * CHARGE / oxideCapFactor;
            vt0 = vfb + polarity * (gamma * Math.sqrt(phi) + phi);
          }
          alpha = (EPSSIL + EPSSIL) / (CHARGE * params.NSUB * 1e6);
          coeffDepLayWidth = Math.sqrt(alpha);
        } else {
          // mos3temp.c:105-110 — nsub < ni fatal.
          ctx.diagnostics?.emit({ severity: "error", code: "model-param-ignored", message: "MOS3: Nsub < Ni" });
        }
      }
      // mos3temp.c:113-114 — narrowFactor.
      const narrowFactor = params.DELTA * 0.5 * Math.PI * EPSSIL / oxideCapFactor;

      this._egfet1 = egfet1;
      this._vtnom = vtnom;
      tp.oxideCapFactor = oxideCapFactor;
      tp.surfaceMobility = surfaceMobility;
      tp.transconductance = transconductance;
      tp.gamma = gamma;
      tp.phi = phi;
      tp.vt0 = vt0;
      tp.alpha = alpha;
      tp.coeffDepLayWidth = coeffDepLayWidth;
      tp.narrowFactor = narrowFactor;
      tp.gateType = gateType;
      tp.surfaceStateDensity = surfaceStateDensity;
      void oxideCapFactor; void surfaceMobility; void transconductance;
    }

    private _pbfact1 = 0;
    private _fact1 = 1;
    private _egfet1 = 0;
    private _vtnom = 0;

    /** cite: mos3temp.c:118-340 — per-instance correction pass. */
    private _computeTempInstance(temp: number, _ctx: TempContext): void {
      const tnom = params.TNOM;
      const pbfact1 = this._pbfact1;
      const fact1 = this._fact1;
      const egfet1 = this._egfet1;
      const vtnom = this._vtnom;

      // mos3temp.c:138-145.
      const vt = temp * CONSTKoverQ;
      const ratio = temp / tnom;
      const fact2 = temp / REFTEMP;
      const kt = temp * CONSTboltz;
      const egfet = 1.16 - (7.02e-4 * temp * temp) / (temp + 1108);
      const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
      const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

      // mos3temp.c:159-196 — drain/source conductances.
      const m = params.M;
      if (given.RD) {
        this._drainConductance = params.RD !== 0 ? m / params.RD : 0;
      } else if (given.RSH) {
        this._drainConductance = (params.RSH !== 0 && params.NRD !== 0)
          ? m / (params.RSH * params.NRD) : 0;
      } else {
        this._drainConductance = 0;
      }
      if (given.RS) {
        this._sourceConductance = params.RS !== 0 ? m / params.RS : 0;
      } else if (given.RSH) {
        this._sourceConductance = (params.RSH !== 0 && params.NRS !== 0)
          ? m / (params.RSH * params.NRS) : 0;
      } else {
        this._sourceConductance = 0;
      }

      // mos3temp.c:198-212 — effective L/W > 0 fatals.
      if (params.L - 2 * params.LD + params.XL <= 0) {
        _ctx.diagnostics?.emit({ severity: "error", code: "model-param-ignored", message: "MOS3: effective channel length less than zero" });
      }
      if (params.W - 2 * params.WD + params.XW <= 0) {
        _ctx.diagnostics?.emit({ severity: "error", code: "model-param-ignored", message: "MOS3: effective channel width less than zero" });
      }

      // mos3temp.c:214-226.
      const ratio4 = ratio * Math.sqrt(ratio);
      const tTransconductance = tp.transconductance / ratio4;
      const tSurfMob = tp.surfaceMobility / ratio4;
      const phio = (tp.phi - pbfact1) / fact1;
      const tPhi = fact2 * phio + pbfact;
      const tVbi =
        params.DELVTO
        + tp.vt0 - polarity * (tp.gamma * Math.sqrt(tp.phi))
        + 0.5 * (egfet1 - egfet)
        + polarity * 0.5 * (tPhi - tp.phi);
      const tVto = tVbi + polarity * tp.gamma * Math.sqrt(tPhi);

      // mos3temp.c:227-230 — Arrhenius sat currents.
      const tempFactor = Math.exp(-egfet / vt + egfet1 / vtnom);
      const tSatCur = params.IS * tempFactor;
      const tSatCurDens = params.JS * tempFactor;

      // mos3temp.c:231-251 — junction-cap temp scaling.
      const pbo = (params.PB - pbfact1) / fact1;
      const gmaold = (params.PB - pbo) / pbo;
      let capfact = 1 / (1 + params.MJ * (4e-4 * (tnom - REFTEMP) - gmaold));
      let tCbd = params.CBD * capfact;
      let tCbs = params.CBS * capfact;
      let tCj = params.CJ * capfact;
      capfact = 1 / (1 + params.MJSW * (4e-4 * (tnom - REFTEMP) - gmaold));
      let tCjsw = params.CJSW * capfact;
      const tBulkPot = fact2 * pbo + pbfact;
      const gmanew = (tBulkPot - pbo) / pbo;
      capfact = (1 + params.MJ * (4e-4 * (temp - REFTEMP) - gmanew));
      tCbd *= capfact;
      tCbs *= capfact;
      tCj *= capfact;
      capfact = (1 + params.MJSW * (4e-4 * (temp - REFTEMP) - gmanew));
      tCjsw *= capfact;
      const tDepCap = params.FC * tBulkPot;

      // mos3temp.c:253-267 — vcrit.
      let drainVcrit: number, sourceVcrit: number;
      if (params.JS === 0 || params.AD === 0 || params.AS === 0) {
        drainVcrit = sourceVcrit = vt * Math.log(vt / (CONSTroot2 * m * tSatCur));
      } else {
        drainVcrit = vt * Math.log(vt / (CONSTroot2 * m * tSatCurDens * params.AD));
        sourceVcrit = vt * Math.log(vt / (CONSTroot2 * m * tSatCurDens * params.AS));
      }

      // mos3temp.c:268-303 — drain-side junction charge coefficients.
      let czbd: number;
      if (given.CBD) {
        czbd = tCbd * m;
      } else if (given.CJ) {
        czbd = tCj * params.AD * m;
      } else {
        czbd = 0;
      }
      const czbdsw = given.CJSW ? tCjsw * params.PD * m : 0;
      let argFC = 1 - params.FC;
      let sarg = Math.exp(-params.MJ * Math.log(argFC));
      let sargsw = Math.exp(-params.MJSW * Math.log(argFC));
      const Cbd = czbd;
      const Cbdsw = czbdsw;
      const f2d = czbd * (1 - params.FC * (1 + params.MJ)) * sarg / argFC
        + czbdsw * (1 - params.FC * (1 + params.MJSW)) * sargsw / argFC;
      const f3d = czbd * params.MJ * sarg / argFC / tBulkPot
        + czbdsw * params.MJSW * sargsw / argFC / tBulkPot;
      const f4d = czbd * tBulkPot * (1 - argFC * sarg) / (1 - params.MJ)
        + czbdsw * tBulkPot * (1 - argFC * sargsw) / (1 - params.MJSW)
        - f3d / 2 * (tDepCap * tDepCap)
        - tDepCap * f2d;

      // mos3temp.c:304-339 — source-side junction charge coefficients.
      let czbs: number;
      if (given.CBS) {
        czbs = tCbs * m;
      } else if (given.CJ) {
        czbs = tCj * params.AS * m;
      } else {
        czbs = 0;
      }
      const czbssw = given.CJSW ? tCjsw * params.PS * m : 0;
      argFC = 1 - params.FC;
      sarg = Math.exp(-params.MJ * Math.log(argFC));
      sargsw = Math.exp(-params.MJSW * Math.log(argFC));
      const Cbs = czbs;
      const Cbssw = czbssw;
      const f2s = czbs * (1 - params.FC * (1 + params.MJ)) * sarg / argFC
        + czbssw * (1 - params.FC * (1 + params.MJSW)) * sargsw / argFC;
      const f3s = czbs * params.MJ * sarg / argFC / tBulkPot
        + czbssw * params.MJSW * sargsw / argFC / tBulkPot;
      const f4s = czbs * tBulkPot * (1 - argFC * sarg) / (1 - params.MJ)
        + czbssw * tBulkPot * (1 - argFC * sargsw) / (1 - params.MJSW)
        - f3s / 2 * (tDepCap * tDepCap)
        - tDepCap * f2s;

      tp.vt = vt;
      tp.tTransconductance = tTransconductance;
      tp.tSurfMob = tSurfMob;
      tp.tPhi = tPhi;
      tp.tVbi = tVbi;
      tp.tVto = tVto;
      tp.tSatCur = tSatCur;
      tp.tSatCurDens = tSatCurDens;
      tp.tBulkPot = tBulkPot;
      tp.tDepCap = tDepCap;
      tp.drainVcrit = drainVcrit;
      tp.sourceVcrit = sourceVcrit;
      tp.Cbd = Cbd; tp.Cbdsw = Cbdsw; tp.Cbs = Cbs; tp.Cbssw = Cbssw;
      tp.f2d = f2d; tp.f3d = f3d; tp.f4d = f4d;
      tp.f2s = f2s; tp.f3s = f3s; tp.f4s = f4s;
    }

    get _p(): ResolvedMosfet3Params {
      return params;
    }

    getInternalNodeLabels(): readonly string[] {
      return this._internalLabels;
    }

    // -----------------------------------------------------------------------
    // Part C — setup() (mos3set.c:18-260)
    // -----------------------------------------------------------------------
    setup(ctx: SetupContext): void {
      const solver = ctx.solver;
      nodeG     = this.pinNodes.get("G")!;
      nodeS_ext = this.pinNodes.get("S")!;
      nodeD_ext = this.pinNodes.get("D")!;
      nodeB     = this.pinNodes.get("B")!;
      const gNode = nodeG;
      const sNode = nodeS_ext;
      const dNode = nodeD_ext;
      const bNode = nodeB;

      // mos3set.c:151-152 — *states += MOS3NUMSTATES.
      this._stateBase = ctx.allocStates(MOSFET3_SCHEMA.size);

      this._internalLabels.length = 0;

      // mos3set.c:188-206 — dNodePrime via CKTmkVolt only if
      // (rd != 0 || (rsh != 0 && drainSquares != 0)); else = dNode.
      if (params.RD !== 0 || (params.RSH !== 0 && params.NRD !== 0)) {
        nodeD = ctx.makeVolt(this.label || "M", "internal#drain");
        this._internalLabels.push("drain");
      } else {
        nodeD = dNode;
      }
      // mos3set.c:208-226 — sNodePrime via CKTmkVolt only if
      // (rs != 0 || (rsh != 0 && sourceSquares != 0)); else = sNode.
      if (params.RS !== 0 || (params.RSH !== 0 && params.NRS !== 0)) {
        nodeS = ctx.makeVolt(this.label || "M", "internal#source");
        this._internalLabels.push("source");
      } else {
        nodeS = sNode;
      }

      const dp = nodeD;
      const sp = nodeS;

      // mos3set.c:234-255 — TSTALLOC sequence (22 cells, line-for-line).
      this._hDD   = solver.allocElement(dNode, dNode); // :234
      this._hGG   = solver.allocElement(gNode, gNode); // :235
      this._hSS   = solver.allocElement(sNode, sNode); // :236
      this._hBB   = solver.allocElement(bNode, bNode); // :237
      this._hDPDP = solver.allocElement(dp,    dp);    // :238
      this._hSPSP = solver.allocElement(sp,    sp);    // :239
      this._hDDP  = solver.allocElement(dNode, dp);    // :240
      this._hGB   = solver.allocElement(gNode, bNode); // :241
      this._hGDP  = solver.allocElement(gNode, dp);    // :242
      this._hGSP  = solver.allocElement(gNode, sp);    // :243
      this._hSSP  = solver.allocElement(sNode, sp);    // :244
      this._hBDP  = solver.allocElement(bNode, dp);    // :245
      this._hBSP  = solver.allocElement(bNode, sp);    // :246
      this._hDPSP = solver.allocElement(dp,    sp);    // :247
      this._hDPD  = solver.allocElement(dp,    dNode); // :248
      this._hBG   = solver.allocElement(bNode, gNode); // :249
      this._hDPG  = solver.allocElement(dp,    gNode); // :250
      this._hSPG  = solver.allocElement(sp,    gNode); // :251
      this._hSPS  = solver.allocElement(sp,    sNode); // :252
      this._hDPB  = solver.allocElement(dp,    bNode); // :253
      this._hSPB  = solver.allocElement(sp,    bNode); // :254
      this._hSPDP = solver.allocElement(sp,    dp);    // :255
    }

    // -----------------------------------------------------------------------
    // Part E — load() (mos3load.c:18-1267)
    // -----------------------------------------------------------------------
    load(ctx: LoadContext): void {
      // mos3load.c:112 — Check=1 (set 0 by pnjlim on a limited junction).
      let Check = 1;

      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const s3 = this._pool.states[3];
      const base = this._stateBase;
      const mode = ctx.cktMode;
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;
      const m = params.M;

      // mos3load.c:111 — vt = CONSTKoverQ * MOS3temp.
      const vt = tp.vt;

      // mos3load.c:130-155 — useful values.
      const EffectiveWidth = params.W - 2 * params.WD + params.XW;
      const EffectiveLength = params.L - 2 * params.LD + params.XL;
      let DrainSatCur: number, SourceSatCur: number;
      if (tp.tSatCurDens === 0 || params.AD === 0 || params.AS === 0) {
        DrainSatCur = m * tp.tSatCur;
        SourceSatCur = m * tp.tSatCur;
      } else {
        DrainSatCur = m * tp.tSatCurDens * params.AD;
        SourceSatCur = m * tp.tSatCurDens * params.AS;
      }
      const GateSourceOverlapCap = params.CGSO * m * EffectiveWidth;
      const GateDrainOverlapCap = params.CGDO * m * EffectiveWidth;
      const GateBulkOverlapCap = params.CGBO * m * EffectiveLength;
      let Beta = tp.tTransconductance * m * EffectiveWidth / EffectiveLength;
      const OxideCap = tp.oxideCapFactor * EffectiveLength * m * EffectiveWidth;

      let vbs: number, vgs: number, vds: number, vbd: number, vgd: number, vgb: number;

      let bypassed = false;
      let bypassCapgs = 0, bypassCapgd = 0, bypassCapgb = 0;

      // mos3load.c:206-208 — simple/general dispatch gate.
      const simpleGate = (mode & (MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN)) !== 0
        || ((mode & MODEINITFIX) !== 0 && params.OFF === 0);

      if (simpleGate) {
        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          // mos3load.c:210-229 — predictor step.
          const xfact = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
          const vbs1 = s1[base + SLOT_VBS];
          const vgs1 = s1[base + SLOT_VGS];
          const vds1 = s1[base + SLOT_VDS];
          s0[base + SLOT_VBS] = vbs1;
          vbs = (1 + xfact) * vbs1 - xfact * s2[base + SLOT_VBS];
          s0[base + SLOT_VGS] = vgs1;
          vgs = (1 + xfact) * vgs1 - xfact * s2[base + SLOT_VGS];
          s0[base + SLOT_VDS] = vds1;
          vds = (1 + xfact) * vds1 - xfact * s2[base + SLOT_VDS];
          s0[base + SLOT_VBD] = s0[base + SLOT_VBS] - s0[base + SLOT_VDS];
        } else {
          // mos3load.c:235-243 — general iteration: vbs/vgs/vds from rhsOld.
          vbs = polarity * (voltages[nodeB] - voltages[nodeS]);
          vgs = polarity * (voltages[nodeG] - voltages[nodeS]);
          vds = polarity * (voltages[nodeD] - voltages[nodeS]);
        }

        // mos3load.c:250-258 — common crunching.
        vbd = vbs - vds;
        vgd = vgs - vds;
        const vgdo = s0[base + SLOT_VGS] - s0[base + SLOT_VDS];
        const delvbs = vbs - s0[base + SLOT_VBS];
        const delvbd = vbd - s0[base + SLOT_VBD];
        const delvgs = vgs - s0[base + SLOT_VGS];
        const delvds = vds - s0[base + SLOT_VDS];
        const delvgd = vgd - vgdo;

        // mos3load.c:262-281 — cdhat / cbhat for convergence testing.
        let cdhat: number;
        if (this._mode >= 0) {
          cdhat = this._cd
            - this._gbd * delvbd
            + this._gmbs * delvbs
            + this._gm * delvgs
            + this._gds * delvds;
        } else {
          cdhat = this._cd
            - (this._gbd - this._gmbs) * delvbd
            - this._gm * delvgd
            + this._gds * delvds;
        }
        const cbhat = this._cbs + this._cbd + this._gbd * delvbd + this._gbs * delvbs;

        // mos3load.c:282-336 — NOBYPASS bypass gate.
        const tempv = Math.max(Math.abs(cbhat), Math.abs(this._cbs + this._cbd)) + ctx.iabstol;
        if (
          !(mode & (MODEINITPRED | MODEINITTRAN | MODEINITSMSIG))
          && ctx.bypass
          && Math.abs(cbhat - (this._cbs + this._cbd)) < ctx.reltol * tempv
          && Math.abs(delvbs) < ctx.reltol * Math.max(Math.abs(vbs), Math.abs(s0[base + SLOT_VBS])) + ctx.voltTol
          && Math.abs(delvbd) < ctx.reltol * Math.max(Math.abs(vbd), Math.abs(s0[base + SLOT_VBD])) + ctx.voltTol
          && Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(s0[base + SLOT_VGS])) + ctx.voltTol
          && Math.abs(delvds) < ctx.reltol * Math.max(Math.abs(vds), Math.abs(s0[base + SLOT_VDS])) + ctx.voltTol
          && Math.abs(cdhat - this._cd) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(this._cd)) + ctx.iabstol
        ) {
          // mos3load.c:316-335 — bypass: reload voltages, rebuild cap totals.
          vbs = s0[base + SLOT_VBS];
          vbd = s0[base + SLOT_VBD];
          vgs = s0[base + SLOT_VGS];
          vds = s0[base + SLOT_VDS];
          vgd = vgs - vds;
          vgb = vgs - vbs;
          if (mode & (MODETRAN | MODETRANOP)) {
            bypassCapgs = s0[base + SLOT_CAPGS] + s1[base + SLOT_CAPGS] + GateSourceOverlapCap;
            bypassCapgd = s0[base + SLOT_CAPGD] + s1[base + SLOT_CAPGD] + GateDrainOverlapCap;
            bypassCapgb = s0[base + SLOT_CAPGB] + s1[base + SLOT_CAPGB] + GateBulkOverlapCap;
          }
          bypassed = true;
        }

        if (!bypassed) {
          // mos3load.c:339 — von = MOS3type * MOS3von.
          const von = polarity * this._von;

          // mos3load.c:349-372 — limiting (NODELIMITING undef).
          const vgsOldStored = s0[base + SLOT_VGS];
          const vdsOldStored = s0[base + SLOT_VDS];
          if (vdsOldStored >= 0) {
            const vgsBefore = vgs;
            vgs = fetlim(vgs, vgsOldStored, von);
            vds = vgs - vgd;
            const vdsBefore = vds;
            vds = limvds(vds, vdsOldStored);
            vgd = vgs - vds;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "GS", limitType: "fetlim", vBefore: vgsBefore, vAfter: vgs, wasLimited: vgs !== vgsBefore });
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "DS", limitType: "limvds", vBefore: vdsBefore, vAfter: vds, wasLimited: vds !== vdsBefore });
            }
          } else {
            const vgdo2 = vgsOldStored - vdsOldStored;
            const vgdBefore = vgd;
            vgd = fetlim(vgd, vgdo2, von);
            vds = vgs - vgd;
            const vdsBefore = vds;
            if (!ctx.cktFixLimit) {
              vds = -limvds(-vds, -vdsOldStored);
            }
            vgs = vgd + vds;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "GD", limitType: "fetlim", vBefore: vgdBefore, vAfter: vgd, wasLimited: vgd !== vgdBefore });
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "DS", limitType: "limvds", vBefore: vdsBefore, vAfter: vds, wasLimited: vds !== vdsBefore });
            }
          }
          // mos3load.c:364-372 — pnjlim on bulk junctions, vds-sign dispatch.
          if (vds >= 0) {
            const vbsBefore = vbs;
            const r = pnjlim(vbs, s0[base + SLOT_VBS], vt, tp.sourceVcrit);
            vbs = r.value;
            vbd = vbs - vds;
            // mos3load.c:365-366 — DEVpnjlim writes Check (1 if limited, 0 if not).
            Check = r.limited ? 1 : 0;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "BS", limitType: "pnjlim", vBefore: vbsBefore, vAfter: vbs, wasLimited: r.limited });
            }
          } else {
            const vbdBefore = vbd;
            const r = pnjlim(vbd, s0[base + SLOT_VBD], vt, tp.drainVcrit);
            vbd = r.value;
            vbs = vbd + vds;
            // mos3load.c:369-370 — DEVpnjlim writes Check (1 if limited, 0 if not).
            Check = r.limited ? 1 : 0;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({ elementIndex: this.elementIndex ?? -1, label: this.label, junction: "BD", limitType: "pnjlim", vBefore: vbdBefore, vAfter: vbd, wasLimited: r.limited });
            }
          }
        }
      } else {
        // mos3load.c:375-397 — MODEINITJCT / MODEINITFIX+OFF / default-zero.
        if ((mode & MODEINITJCT) && params.OFF === 0) {
          vds = polarity * params.ICVDS;
          vgs = polarity * params.ICVGS;
          vbs = polarity * params.ICVBS;
          if (vds === 0 && vgs === 0 && vbs === 0
            && ((mode & (MODETRAN | MODEDCOP | MODEDCTRANCURVE)) !== 0
              || (mode & MODEUIC) === 0)) {
            vbs = -1;
            vgs = polarity * tp.tVto;
            vds = 0;
          }
        } else {
          vbs = 0; vgs = 0; vds = 0;
        }
      }

      // mos3load.c:403-405 — recompute common quantities.
      vbd = vbs! - vds!;
      vgd = vgs! - vds!;
      vgb = vgs! - vbs!;

      // Cap totals hoisted (filled by Meyer block / bypass branch).
      let capgs = bypassCapgs, capgd = bypassCapgd, capgb = bypassCapgb;

      // Conductances / currents (filled by OP-eval or reloaded on bypass).
      let cdrain: number;
      let gbs: number, cbs: number, gbd: number, cbd: number;
      let cd: number;
      let von = polarity * this._von;
      let vdsat = this._vdsat;

      // mos3load.c:438-444 — mode determination. On bypass vds is reloaded from
      // state0, so opMode here equals the MOS3mode stored on the prior iteration
      // (which the bypass cdrain reconstruction at mos3load.c:322 uses).
      const opMode = vds! >= 0 ? 1 : -1;

      if (bypassed) {
        // mos3load.c:316-334 — bypass: the goto jumps over the next1: bulk-diode
        // block and the entire moseq3 drain-current core to the bypass: label,
        // so none of cbs/gbs/cbd/gbd/gm/gds/gmbs/cd is recomputed. Reload the
        // converged scalars stored on the prior iteration and reconstruct
        // cdrain = MOS3mode * (MOS3cd + MOS3cbd) (mos3load.c:322).
        gbd = this._gbd;
        gbs = this._gbs;
        cbd = this._cbd;
        cbs = this._cbs;
        cd = this._cd;
        cdrain = opMode * (cd + cbd);
        // von / vdsat retain their reloaded polarity values (von = polarity *
        // MOS3von, vdsat = MOS3vdsat); _gm/_gds/_gmbs already hold the stored
        // partials the Y-stamps below read. _mode is left unchanged (== opMode).
      } else {
      this._mode = opMode;

      // mos3load.c:414-433 — bulk-source and bulk-drain diodes (next1 label).
      if (vbs! <= -3 * vt) {
        let arg = 3 * vt / (vbs! * CONSTe);
        arg = arg * arg * arg;
        cbs = -SourceSatCur * (1 + arg) + ctx.cktGmin * vbs!;
        gbs = SourceSatCur * 3 * arg / vbs! + ctx.cktGmin;
      } else {
        const evbs = Math.exp(Math.min(MAX_EXP_ARG, vbs! / vt));
        gbs = SourceSatCur * evbs / vt + ctx.cktGmin;
        cbs = SourceSatCur * (evbs - 1) + ctx.cktGmin * vbs!;
      }
      if (vbd <= -3 * vt) {
        let arg = 3 * vt / (vbd * CONSTe);
        arg = arg * arg * arg;
        cbd = -DrainSatCur * (1 + arg) + ctx.cktGmin * vbd;
        gbd = DrainSatCur * 3 * arg / vbd + ctx.cktGmin;
      } else {
        const evbd = Math.exp(Math.min(MAX_EXP_ARG, vbd / vt));
        gbd = DrainSatCur * evbd / vt + ctx.cktGmin;
        cbd = DrainSatCur * (evbd - 1) + ctx.cktGmin * vbd;
      }

      // ----------------------------------------------------------------------
      // mos3load.c:446-871 — moseq3 level-3 semi-empirical drain-current model.
      // ----------------------------------------------------------------------
      {
        const coeff0 = 0.0631353;
        const coeff1 = 0.8013292;
        const coeff2 = -0.01110777;
        let gmLocal = 0, gdsLocal = 0, gmbsLocal = 0;
        cdrain = 0;

        // mos3load.c:559-562.
        vdsat = 0.0;
        const oneoverxl = 1.0 / EffectiveLength;
        const eta = params.ETA * 8.15e-22 / (tp.oxideCapFactor * EffectiveLength * EffectiveLength * EffectiveLength);

        // mos3load.c:566-577 — square-root term.
        const vbsx = opMode === 1 ? vbs! : vbd;
        let phibs: number, sqphbs: number, dsqdvb: number;
        if (vbsx <= 0.0) {
          phibs = tp.tPhi - vbsx;
          sqphbs = Math.sqrt(phibs);
          dsqdvb = -0.5 / sqphbs;
        } else {
          const sqphis = Math.sqrt(tp.tPhi);
          const sqphs3 = tp.tPhi * sqphis;
          sqphbs = sqphis / (1.0 + vbsx / (tp.tPhi + tp.tPhi));
          phibs = sqphbs * sqphbs;
          dsqdvb = -phibs / (sqphs3 + sqphs3);
        }

        // mos3load.c:581-600 — short-channel effect factor (XJ).
        let fshort: number, dfsdvb: number;
        if (params.XJ !== 0.0 && tp.coeffDepLayWidth !== 0.0) {
          const wps = tp.coeffDepLayWidth * sqphbs;
          const oneoverxj = 1.0 / params.XJ;
          const xjonxl = params.XJ * oneoverxl;
          const djonxj = params.LD * oneoverxj;
          const wponxj = wps * oneoverxj;
          const wconxj = coeff0 + coeff1 * wponxj + coeff2 * wponxj * wponxj;
          const arga = wconxj + djonxj;
          const argc = wponxj / (1.0 + wponxj);
          const argb = Math.sqrt(1.0 - argc * argc);
          fshort = 1.0 - xjonxl * (arga * argb - djonxj);
          const dwpdvb = tp.coeffDepLayWidth * dsqdvb;
          const dadvb = (coeff1 + coeff2 * (wponxj + wponxj)) * dwpdvb * oneoverxj;
          const dbdvb = -argc * argc * (1.0 - argc) * dwpdvb / (argb * wps);
          dfsdvb = -xjonxl * (dadvb * argb + arga * dbdvb);
        } else {
          fshort = 1.0;
          dfsdvb = 0.0;
        }

        // mos3load.c:604-611 — body effect.
        const gammas = tp.gamma * fshort;
        const fbodys = 0.5 * gammas / (sqphbs + sqphbs);
        const fbody = fbodys + tp.narrowFactor / EffectiveWidth;
        const onfbdy = 1.0 / (1.0 + fbody);
        const dfbdvb = -fbodys * dsqdvb / sqphbs + fbodys * dfsdvb / fshort;
        const qbonco = gammas * sqphbs + tp.narrowFactor * phibs / EffectiveWidth;
        const dqbdvb = gammas * dsqdvb + tp.gamma * dfsdvb * sqphbs - tp.narrowFactor / EffectiveWidth;

        // mos3load.c:615 — static feedback (ETA).
        const vbix = tp.tVbi * polarity - eta * (opMode * vds!);

        // mos3load.c:619-621 — threshold voltage.
        const vth = vbix + qbonco;
        const dvtdvd = -eta;
        const dvtdvb = dqbdvb;

        // mos3load.c:625-647 — joint weak/strong inversion (NFS).
        von = vth;
        let xn = 0.0, dxndvb = 0.0, dvodvb = 0.0, dvodvd = 0.0;
        let cutoff = false;
        if (params.NFS !== 0.0) {
          const csonco = CHARGE * params.NFS * 1e4 * EffectiveLength * EffectiveWidth * m / OxideCap;
          const cdonco = qbonco / (phibs + phibs);
          xn = 1.0 + csonco + cdonco;
          von = vth + vt * xn;
          dxndvb = dqbdvb / (phibs + phibs) - qbonco * dsqdvb / (phibs * sqphbs);
          dvodvd = dvtdvd;
          dvodvb = dvtdvb + vt * dxndvb;
        } else {
          // mos3load.c:637-646 — cutoff region early-out.
          if ((opMode === 1 ? vgs! : vgd) <= von) {
            cdrain = 0.0;
            gmLocal = 0.0;
            gdsLocal = 0.0;
            gmbsLocal = 0.0;
            cutoff = true;
          }
        }

        let dvsdvg = 0, dvsdvb = 0, dvsdvd = 0;
        let onfg = 1, fgate = 1;
        let dfgdvg = 0, dfgdvd = 0, dfgdvb = 0;
        let onvdsc = 0;
        let cdo = 0, dcodvb = 0, vdsx = 0;
        let fdrain = 0;
        let dfddvg = 0, dfddvd = 0, dfddvb = 0;
        let gds0 = 0;
        let isLine900 = false;

        if (!cutoff) {
          // mos3load.c:651 — device is on.
          const vgsx = Math.max((opMode === 1 ? vgs! : vgd), von);
          // mos3load.c:655-660 — mobility modulation by gate voltage (THETA).
          onfg = 1.0 + params.THETA * (vgsx - vth);
          fgate = 1.0 / onfg;
          // const us = tp.tSurfMob * 1e-4 * fgate;  // used only for vmax branch (vdsc)
          dfgdvg = -params.THETA * fgate * fgate;
          dfgdvd = -dfgdvg * dvtdvd;
          dfgdvb = -dfgdvg * dvtdvb;

          // mos3load.c:664-679 — saturation voltage (VMAX).
          vdsat = (vgsx - vth) * onfbdy;
          if (params.VMAX <= 0.0) {
            dvsdvg = onfbdy;
            dvsdvd = -dvsdvg * dvtdvd;
            dvsdvb = -dvsdvg * dvtdvb - vdsat * dfbdvb * onfbdy;
          } else {
            const us = tp.tSurfMob * 1e-4 * fgate;
            const vdsc = EffectiveLength * params.VMAX / us;
            onvdsc = 1.0 / vdsc;
            const arga = (vgsx - vth) * onfbdy;
            const argb = Math.sqrt(arga * arga + vdsc * vdsc);
            vdsat = arga + vdsc - argb;
            const dvsdga = (1.0 - arga / argb) * onfbdy;
            dvsdvg = dvsdga - (1.0 - vdsc / argb) * vdsc * dfgdvg * onfg;
            dvsdvd = -dvsdvg * dvtdvd;
            dvsdvb = -dvsdvg * dvtdvb - arga * dvsdga * dfbdvb;
          }

          // mos3load.c:683-703 — current factors in linear region.
          vdsx = Math.min(opMode * vds!, vdsat);
          if (vdsx === 0.0) {
            // mos3load.c:684 — goto line900.
            isLine900 = true;
          } else {
            cdo = vgsx - vth - 0.5 * (1.0 + fbody) * vdsx;
            dcodvb = -dvtdvb - 0.5 * dfbdvb * vdsx;
            const cdnorm = cdo * vdsx;
            gmLocal = vdsx;
            if (opMode * vds! > vdsat) gdsLocal = -dvtdvd * vdsx;
            else gdsLocal = vgsx - vth - (1.0 + fbody + dvtdvd) * vdsx;
            gmbsLocal = dcodvb * vdsx;
            // mos3load.c:698-703 — drain current without velocity saturation.
            const cd1 = Beta * cdnorm;
            Beta = Beta * fgate;
            cdrain = Beta * cdnorm;
            gmLocal = Beta * gmLocal + dfgdvg * cd1;
            gdsLocal = Beta * gdsLocal + dfgdvd * cd1;
            gmbsLocal = Beta * gmbsLocal + dfgdvb * cd1;

            // mos3load.c:707-723 — velocity saturation factor (VMAX).
            if (params.VMAX > 0.0) {
              fdrain = 1.0 / (1.0 + vdsx * onvdsc);
              const fd2 = fdrain * fdrain;
              const arga = fd2 * vdsx * onvdsc * onfg;
              dfddvg = -dfgdvg * arga;
              if (opMode * vds! > vdsat) dfddvd = -dfgdvd * arga;
              else dfddvd = -dfgdvd * arga - fd2 * onvdsc;
              dfddvb = -dfgdvb * arga;
              gmLocal = fdrain * gmLocal + dfddvg * cdrain;
              gdsLocal = fdrain * gdsLocal + dfddvd * cdrain;
              gmbsLocal = fdrain * gmbsLocal + dfddvb * cdrain;
              cdrain = fdrain * cdrain;
              Beta = Beta * fdrain;
            }

            // mos3load.c:726-826 — channel-length modulation (KAPPA).
            let delxl = 0, dldvd = 0, ddldvg = 0, ddldvd = 0, ddldvb = 0;
            // ngspice CKTbadMos3 is a model-init flag; digiTS has no
            // legacy-mos3 mode, so badMos3 is always false here.
            const badMos3 = false;
            let gotoLine700 = false;
            let handled = false;

            if (opMode * vds! <= vdsat) {
              if (params.VMAX > 0.0 || tp.alpha === 0.0 || badMos3) {
                gotoLine700 = true;
              } else {
                const arga0 = (opMode * vds!) / vdsat;
                delxl = Math.sqrt(params.KAPPA * tp.alpha * vdsat / 8);
                dldvd = 4 * delxl * arga0 * arga0 * arga0 / vdsat;
                let arga = arga0 * arga0;
                arga *= arga;
                delxl *= arga;
                ddldvg = 0.0;
                ddldvd = -dldvd;
                ddldvb = 0.0;
                handled = true; // goto line520
              }
            }

            if (!gotoLine700 && !handled) {
              if (params.VMAX <= 0.0) {
                // goto line510
                if (badMos3) {
                  delxl = Math.sqrt(params.KAPPA * (opMode * vds! - vdsat) * tp.alpha);
                  dldvd = 0.5 * delxl / (opMode * vds! - vdsat);
                } else {
                  delxl = Math.sqrt(params.KAPPA * tp.alpha * (opMode * vds! - vdsat + (vdsat / 8)));
                  dldvd = 0.5 * delxl / (opMode * vds! - vdsat + (vdsat / 8));
                }
                ddldvg = 0.0;
                ddldvd = -dldvd;
                ddldvb = 0.0;
                handled = true;
              } else if (tp.alpha === 0.0) {
                gotoLine700 = true;
              } else {
                // mos3load.c:748-782.
                const cdsat = cdrain;
                let gdsat = cdsat * (1.0 - fdrain) * onvdsc;
                gdsat = Math.max(1.0e-12, gdsat);
                const gdoncd = gdsat / cdsat;
                const gdonfd = gdsat / (1.0 - fdrain);
                const gdonfg = gdsat * onfg;
                const dgdvg = gdoncd * gmLocal - gdonfd * dfddvg + gdonfg * dfgdvg;
                const dgdvd = gdoncd * gdsLocal - gdonfd * dfddvd + gdonfg * dfgdvd;
                const dgdvb = gdoncd * gmbsLocal - gdonfd * dfddvb + gdonfg * dfgdvb;

                let emax: number;
                if (badMos3) emax = cdsat * oneoverxl / gdsat;
                else emax = params.KAPPA * cdsat * oneoverxl / gdsat;
                const emoncd = emax / cdsat;
                const emongd = emax / gdsat;
                const demdvg = emoncd * gmLocal - emongd * dgdvg;
                const demdvd = emoncd * gdsLocal - emongd * dgdvd;
                const demdvb = emoncd * gmbsLocal - emongd * dgdvb;

                const arga = 0.5 * emax * tp.alpha;
                const argc = params.KAPPA * tp.alpha;
                const argb = Math.sqrt(arga * arga + argc * ((opMode * vds!) - vdsat));
                delxl = argb - arga;
                let dldem: number;
                if (argb !== 0.0) {
                  dldvd = argc / (argb + argb);
                  dldem = 0.5 * (arga / argb - 1.0) * tp.alpha;
                } else {
                  dldvd = 0.0;
                  dldem = 0.0;
                }
                ddldvg = dldem * demdvg;
                ddldvd = dldem * demdvd - dldvd;
                ddldvb = dldem * demdvb;
                handled = true; // goto line520
              }
            }

            if (!gotoLine700) {
              // mos3load.c:799-809 — line520: punch-through approximation.
              if (delxl > 0.5 * EffectiveLength) {
                delxl = EffectiveLength - (EffectiveLength * EffectiveLength / (4.0 * delxl));
                const arga = 4.0 * (EffectiveLength - delxl) * (EffectiveLength - delxl) / (EffectiveLength * EffectiveLength);
                ddldvg = ddldvg * arga;
                ddldvd = ddldvd * arga;
                ddldvb = ddldvb * arga;
                dldvd = dldvd * arga;
              }
              // mos3load.c:813-826 — saturation region.
              const dlonxl = delxl * oneoverxl;
              const xlfact = 1.0 / (1.0 - dlonxl);
              cdrain = cdrain * xlfact;
              const diddl = cdrain / (EffectiveLength - delxl);
              gmLocal = gmLocal * xlfact + diddl * ddldvg;
              gmbsLocal = gmbsLocal * xlfact + diddl * ddldvb;
              gds0 = diddl * ddldvd;
              gmLocal = gmLocal + gds0 * dvsdvg;
              gmbsLocal = gmbsLocal + gds0 * dvsdvb;
              gdsLocal = gdsLocal * xlfact + diddl * dldvd + gds0 * dvsdvd;
            }

            // mos3load.c:831-849 — line700: finish strong inversion / weak inversion.
            if ((opMode === 1 ? vgs! : vgd) < von) {
              const onxn = 1.0 / xn;
              const ondvt = onxn / vt;
              const wfact = Math.exp(((opMode === 1 ? vgs! : vgd) - von) * ondvt);
              cdrain = cdrain * wfact;
              const gms = gmLocal * wfact;
              const gmw = cdrain * ondvt;
              gmLocal = gmw;
              if (opMode * vds! > vdsat) {
                gmLocal = gmLocal + gds0 * dvsdvg * wfact;
              }
              gdsLocal = gdsLocal * wfact + (gms - gmw) * dvodvd;
              gmbsLocal = gmbsLocal * wfact + (gms - gmw) * dvodvb - gmw
                * ((opMode === 1 ? vgs! : vgd) - von) * onxn * dxndvb;
            }
          }

          // mos3load.c:857-866 — line900: special case vds = 0.
          if (isLine900) {
            Beta = Beta * fgate;
            cdrain = 0.0;
            gmLocal = 0.0;
            const vgsxL = Math.max((opMode === 1 ? vgs! : vgd), von);
            gdsLocal = Beta * (vgsxL - vth);
            gmbsLocal = 0.0;
            if (params.NFS !== 0.0 && (opMode === 1 ? vgs! : vgd) < von) {
              gdsLocal *= Math.exp(((opMode === 1 ? vgs! : vgd) - von) / (vt * xn));
            }
          }
        }

        this._gm = gmLocal;
        this._gds = gdsLocal;
        this._gmbs = gmbsLocal;
      }

      // mos3load.c:874-882 — polarity + cd.
      this._von = polarity * von;
      this._vdsat = polarity * vdsat;
      cd = opMode * cdrain - cbd;
      this._cd = cd;
      } // end !bypassed

      // mos3load.c:884-1012 — bulk-junction caps + charge.
      const capGate = (mode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0;
      let capbd = 0, capbs = 0;
      if (!bypassed && capGate) {
        // mos3load.c:906-958 — bulk-source depletion cap + charge.
        if (tp.Cbs !== 0 || tp.Cbssw !== 0) {
          if (vbs! < tp.tDepCap) {
            const arg = 1 - vbs! / tp.tBulkPot;
            let sarg: number, sargsw: number;
            if (params.MJ === params.MJSW) {
              if (params.MJ === 0.5) {
                sarg = sargsw = 1 / Math.sqrt(arg);
              } else {
                sarg = sargsw = Math.exp(-params.MJ * Math.log(arg));
              }
            } else {
              if (params.MJ === 0.5) sarg = 1 / Math.sqrt(arg);
              else sarg = Math.exp(-params.MJ * Math.log(arg));
              if (params.MJSW === 0.5) sargsw = 1 / Math.sqrt(arg);
              else sargsw = Math.exp(-params.MJSW * Math.log(arg));
            }
            s0[base + SLOT_QBS] = tp.tBulkPot * (
              tp.Cbs * (1 - arg * sarg) / (1 - params.MJ)
              + tp.Cbssw * (1 - arg * sargsw) / (1 - params.MJSW));
            capbs = tp.Cbs * sarg + tp.Cbssw * sargsw;
          } else {
            s0[base + SLOT_QBS] = tp.f4s + vbs! * (tp.f2s + vbs! * (tp.f3s / 2));
            capbs = tp.f2s + tp.f3s * vbs!;
          }
        } else {
          s0[base + SLOT_QBS] = 0;
          capbs = 0;
        }
        // mos3load.c:966-1012 — bulk-drain depletion cap + charge.
        if (tp.Cbd !== 0 || tp.Cbdsw !== 0) {
          if (vbd < tp.tDepCap) {
            const arg = 1 - vbd / tp.tBulkPot;
            let sarg: number, sargsw: number;
            if (params.MJ === 0.5 && params.MJSW === 0.5) {
              sarg = sargsw = 1 / Math.sqrt(arg);
            } else {
              if (params.MJ === 0.5) sarg = 1 / Math.sqrt(arg);
              else sarg = Math.exp(-params.MJ * Math.log(arg));
              if (params.MJSW === 0.5) sargsw = 1 / Math.sqrt(arg);
              else sargsw = Math.exp(-params.MJSW * Math.log(arg));
            }
            s0[base + SLOT_QBD] = tp.tBulkPot * (
              tp.Cbd * (1 - arg * sarg) / (1 - params.MJ)
              + tp.Cbdsw * (1 - arg * sargsw) / (1 - params.MJSW));
            capbd = tp.Cbd * sarg + tp.Cbdsw * sargsw;
          } else {
            s0[base + SLOT_QBD] = tp.f4d + vbd * (tp.f2d + vbd * tp.f3d / 2);
            capbd = tp.f2d + vbd * tp.f3d;
          }
        } else {
          s0[base + SLOT_QBD] = 0;
          capbd = 0;
        }
        this._capbs = capbs;
        this._capbd = capbd;

        // mos3load.c:1015-1038 — integrate bulk caps (MODETRAN only).
        if (mode & MODETRAN) {
          const ag = ctx.ag;
          {
            const ccapPrev = s1[base + SLOT_CQBD];
            const { ccap, geq } = niIntegrate(
              ctx.method, ctx.order, capbd, ag,
              s0[base + SLOT_QBD], s1[base + SLOT_QBD],
              [s2[base + SLOT_QBD], s3[base + SLOT_QBD], 0, 0, 0], ccapPrev,
            );
            s0[base + SLOT_CQBD] = ccap;
            gbd += geq;
            cbd += ccap;
            cd -= ccap;
            this._cd = cd;
          }
          {
            const ccapPrev = s1[base + SLOT_CQBS];
            const { ccap, geq } = niIntegrate(
              ctx.method, ctx.order, capbs, ag,
              s0[base + SLOT_QBS], s1[base + SLOT_QBS],
              [s2[base + SLOT_QBS], s3[base + SLOT_QBS], 0, 0, 0], ccapPrev,
            );
            s0[base + SLOT_CQBS] = ccap;
            gbs += geq;
            cbs += ccap;
          }
        }
      }

      // mos3load.c:1045-1051 — convergence (MOS3convTest fold).
      if (params.OFF === 0 || !(mode & (MODEINITFIX | MODEINITSMSIG))) {
        if (Check === 1) {
          ctx.noncon.value++;
        }
      }

      // mos3load.c:1056-1059 — save vbs/vbd/vgs/vds.
      s0[base + SLOT_VBS] = vbs!;
      s0[base + SLOT_VBD] = vbd;
      s0[base + SLOT_VGS] = vgs!;
      s0[base + SLOT_VDS] = vds!;

      // mos3load.c:1065-1156 — Meyer caps via DEVqmeyer.
      if (!bypassed && capGate) {
        let meyerCapgs: number, meyerCapgd: number, meyerCapgb: number;
        if (opMode > 0) {
          const meyer = devQmeyer(vgs!, vgd, vgb, von, vdsat, tp.tPhi, OxideCap);
          meyerCapgs = meyer.capgs; meyerCapgd = meyer.capgd; meyerCapgb = meyer.capgb;
        } else {
          const meyer = devQmeyer(vgd, vgs!, vgb, von, vdsat, tp.tPhi, OxideCap);
          meyerCapgd = meyer.capgs; meyerCapgs = meyer.capgd; meyerCapgb = meyer.capgb;
        }
        s0[base + SLOT_CAPGS] = meyerCapgs;
        s0[base + SLOT_CAPGD] = meyerCapgd;
        s0[base + SLOT_CAPGB] = meyerCapgb;

        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = vgs1 - s1[base + SLOT_VDS];
        const vgb1 = vgs1 - s1[base + SLOT_VBS];
        // mos3load.c:1092-1109 — cap totals.
        if (mode & MODETRANOP) {
          capgs = 2 * s0[base + SLOT_CAPGS] + GateSourceOverlapCap;
          capgd = 2 * s0[base + SLOT_CAPGD] + GateDrainOverlapCap;
          capgb = 2 * s0[base + SLOT_CAPGB] + GateBulkOverlapCap;
        } else {
          capgs = s0[base + SLOT_CAPGS] + s1[base + SLOT_CAPGS] + GateSourceOverlapCap;
          capgd = s0[base + SLOT_CAPGD] + s1[base + SLOT_CAPGD] + GateDrainOverlapCap;
          capgb = s0[base + SLOT_CAPGB] + s1[base + SLOT_CAPGB] + GateBulkOverlapCap;
        }

        // mos3load.c:1127-1155 — charge update.
        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          const xfactQ = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
          s0[base + SLOT_QGS] = (1 + xfactQ) * s1[base + SLOT_QGS] - xfactQ * s2[base + SLOT_QGS];
          s0[base + SLOT_QGD] = (1 + xfactQ) * s1[base + SLOT_QGD] - xfactQ * s2[base + SLOT_QGD];
          s0[base + SLOT_QGB] = (1 + xfactQ) * s1[base + SLOT_QGB] - xfactQ * s2[base + SLOT_QGB];
        } else if (mode & MODETRAN) {
          s0[base + SLOT_QGS] = (vgs! - vgs1) * capgs + s1[base + SLOT_QGS];
          s0[base + SLOT_QGD] = (vgd - vgd1) * capgd + s1[base + SLOT_QGD];
          s0[base + SLOT_QGB] = (vgb - vgb1) * capgb + s1[base + SLOT_QGB];
        } else {
          s0[base + SLOT_QGS] = vgs! * capgs;
          s0[base + SLOT_QGD] = vgd * capgd;
          s0[base + SLOT_QGB] = vgb * capgb;
        }
      }

      // mos3load.c:1162-1194 — Meyer charge integration.
      let gcgs = 0, ceqgs = 0, gcgd = 0, ceqgd = 0, gcgb = 0, ceqgb = 0;
      if (!bypassed) {
        const initOrNoTran = (mode & MODEINITTRAN) !== 0 || (mode & MODETRAN) === 0;
        if (initOrNoTran) {
          gcgs = 0; ceqgs = 0;
          gcgd = 0; ceqgd = 0;
          gcgb = 0; ceqgb = 0;
        } else {
          if (capgs === 0) s0[base + SLOT_CQGS] = 0;
          if (capgd === 0) s0[base + SLOT_CQGD] = 0;
          if (capgb === 0) s0[base + SLOT_CQGB] = 0;
          const ag = ctx.ag;
          {
            const q0 = s0[base + SLOT_QGS];
            const { ccap, ceq, geq } = niIntegrate(
              ctx.method, ctx.order, capgs, ag,
              q0, s1[base + SLOT_QGS],
              [s2[base + SLOT_QGS], s3[base + SLOT_QGS], 0, 0, 0], s1[base + SLOT_CQGS],
            );
            gcgs = geq;
            ceqgs = ceq - gcgs * vgs! + ag[0] * q0;
            s0[base + SLOT_CQGS] = ccap;
          }
          {
            const q0 = s0[base + SLOT_QGD];
            const { ccap, ceq, geq } = niIntegrate(
              ctx.method, ctx.order, capgd, ag,
              q0, s1[base + SLOT_QGD],
              [s2[base + SLOT_QGD], s3[base + SLOT_QGD], 0, 0, 0], s1[base + SLOT_CQGD],
            );
            gcgd = geq;
            ceqgd = ceq - gcgd * vgd + ag[0] * q0;
            s0[base + SLOT_CQGD] = ccap;
          }
          {
            const q0 = s0[base + SLOT_QGB];
            const { ccap, ceq, geq } = niIntegrate(
              ctx.method, ctx.order, capgb, ag,
              q0, s1[base + SLOT_QGB],
              [s2[base + SLOT_QGB], s3[base + SLOT_QGB], 0, 0, 0], s1[base + SLOT_CQGB],
            );
            gcgb = geq;
            ceqgb = ceq - gcgb * vgb + ag[0] * q0;
            s0[base + SLOT_CQGB] = ccap;
          }
        }
      }

      // Store DC-op scalars for convergence test / getPinCurrents.
      this._cbd = cbd;
      this._cbs = cbs;
      this._gbd = gbd;
      this._gbs = gbs;

      // mos3load.c:1202-1224 — RHS load.
      const ceqbs = polarity * (cbs - gbs * vbs!);
      const ceqbd = polarity * (cbd - gbd * vbd);
      let xnrm: number, xrev: number, cdreq: number;
      if (opMode >= 0) {
        xnrm = 1; xrev = 0;
        cdreq = polarity * (cdrain - this._gds * vds! - this._gm * vgs! - this._gmbs * vbs!);
      } else {
        xnrm = 0; xrev = 1;
        cdreq = -polarity * (cdrain - this._gds * (-vds!) - this._gm * vgd - this._gmbs * vbd);
      }
      stampRHS(ctx.rhs, nodeG, -(polarity * (ceqgs + ceqgb + ceqgd)));
      stampRHS(ctx.rhs, nodeB, -(ceqbs + ceqbd - polarity * ceqgb));
      stampRHS(ctx.rhs, nodeD, (ceqbd - cdreq + polarity * ceqgd));
      stampRHS(ctx.rhs, nodeS, (cdreq + ceqbs + polarity * ceqgs));

      // RS/RD external terminal conductances — the prime-node link stamps.
      // ngspice folds drainConductance/sourceConductance into the Y-matrix
      // cells below; the dNode/sNode-vs-prime coupling cells (DdpPtr, DPdPtr,
      // SspPtr, SPsPtr) carry -conductance, the diagonal cells +conductance.
      const gd = this._drainConductance;
      const gs = this._sourceConductance;
      const gmNR = this._gm, gdsNR = this._gds, gmbsNR = this._gmbs;

      // mos3load.c:1236-1263 — Y-matrix stamps via cached handles.
      solver.stampElement(this._hDD,   gd);                                          // :1236
      solver.stampElement(this._hGG,   gcgd + gcgs + gcgb);                          // :1237
      solver.stampElement(this._hSS,   gs);                                          // :1238
      solver.stampElement(this._hBB,   gbd + gbs + gcgb);                            // :1239
      solver.stampElement(this._hDPDP, gd + gdsNR + gbd + xrev * (gmNR + gmbsNR) + gcgd); // :1240-1242
      solver.stampElement(this._hSPSP, gs + gdsNR + gbs + xnrm * (gmNR + gmbsNR) + gcgs); // :1243-1245
      solver.stampElement(this._hDDP,  -gd);                                         // :1246
      solver.stampElement(this._hGB,   -gcgb);                                       // :1247
      solver.stampElement(this._hGDP,  -gcgd);                                       // :1248
      solver.stampElement(this._hGSP,  -gcgs);                                       // :1249
      solver.stampElement(this._hSSP,  -gs);                                         // :1250
      solver.stampElement(this._hBG,   -gcgb);                                       // :1251
      solver.stampElement(this._hBDP,  -gbd);                                        // :1252
      solver.stampElement(this._hBSP,  -gbs);                                        // :1253
      solver.stampElement(this._hDPD,  -gd);                                         // :1254
      solver.stampElement(this._hDPG,  (xnrm - xrev) * gmNR - gcgd);                 // :1255
      solver.stampElement(this._hDPB,  -gbd + (xnrm - xrev) * gmbsNR);               // :1256
      solver.stampElement(this._hDPSP, -gdsNR - xnrm * (gmNR + gmbsNR));             // :1257-1258
      solver.stampElement(this._hSPG,  -(xnrm - xrev) * gmNR - gcgs);                // :1259
      solver.stampElement(this._hSPS,  -gs);                                         // :1260
      solver.stampElement(this._hSPB,  -gbs - (xnrm - xrev) * gmbsNR);               // :1261
      solver.stampElement(this._hSPDP, -gdsNR - xrev * (gmNR + gmbsNR));             // :1262-1263
    }

    // -----------------------------------------------------------------------
    // Part F — stampAc() (mos3acld.c:16-124)
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
      const m = params.M;

      // mos3acld.c:41-47 — xnrm/xrev from MOS3mode sign.
      let xnrm: number, xrev: number;
      if (this._mode < 0) { xnrm = 0; xrev = 1; } else { xnrm = 1; xrev = 0; }

      // mos3acld.c:51-61 — overlap caps.
      const EffectiveWidth = params.W - 2 * params.WD + params.XW;
      const EffectiveLength = params.L - 2 * params.LD + params.XL;
      const GateSourceOverlapCap = params.CGSO * m * EffectiveWidth;
      const GateDrainOverlapCap = params.CGDO * m * EffectiveWidth;
      const GateBulkOverlapCap = params.CGBO * m * EffectiveLength;

      // mos3acld.c:65-78 — Meyer cap totals (state0 doubled) + susceptances.
      const capgs = s0[base + SLOT_CAPGS] + s0[base + SLOT_CAPGS] + GateSourceOverlapCap;
      const capgd = s0[base + SLOT_CAPGD] + s0[base + SLOT_CAPGD] + GateDrainOverlapCap;
      const capgb = s0[base + SLOT_CAPGB] + s0[base + SLOT_CAPGB] + GateBulkOverlapCap;
      const xgs = capgs * omega;
      const xgd = capgd * omega;
      const xgb = capgb * omega;
      const xbd = this._capbd * omega;
      const xbs = this._capbs * omega;

      // mos3acld.c:84-97 — imaginary half-cell stamps.
      solver.stampElementImag(this._hGG,   xgd + xgs + xgb);
      solver.stampElementImag(this._hBB,   xgb + xbd + xbs);
      solver.stampElementImag(this._hDPDP, xgd + xbd);
      solver.stampElementImag(this._hSPSP, xgs + xbs);
      solver.stampElementImag(this._hGB,   -xgb);
      solver.stampElementImag(this._hGDP,  -xgd);
      solver.stampElementImag(this._hGSP,  -xgs);
      solver.stampElementImag(this._hBG,   -xgb);
      solver.stampElementImag(this._hBDP,  -xbd);
      solver.stampElementImag(this._hBSP,  -xbs);
      solver.stampElementImag(this._hDPG,  -xgd);
      solver.stampElementImag(this._hDPB,  -xbd);
      solver.stampElementImag(this._hSPG,  -xgs);
      solver.stampElementImag(this._hSPB,  -xbs);

      // mos3acld.c:98-120 — real conductance stamps.
      const gbd = this._gbd, gbs = this._gbs;
      const gm = this._gm, gds = this._gds, gmbs = this._gmbs;
      const gd = this._drainConductance, gs = this._sourceConductance;
      solver.stampElement(this._hDD,   gd);
      solver.stampElement(this._hSS,   gs);
      solver.stampElement(this._hBB,   gbd + gbs);
      solver.stampElement(this._hDPDP, gd + gds + gbd + xrev * (gm + gmbs));
      solver.stampElement(this._hSPSP, gs + gds + gbs + xnrm * (gm + gmbs));
      solver.stampElement(this._hDDP,  -gd);
      solver.stampElement(this._hSSP,  -gs);
      solver.stampElement(this._hBDP,  -gbd);
      solver.stampElement(this._hBSP,  -gbs);
      solver.stampElement(this._hDPD,  -gd);
      solver.stampElement(this._hDPG,  (xnrm - xrev) * gm);
      solver.stampElement(this._hDPB,  -gbd + (xnrm - xrev) * gmbs);
      solver.stampElement(this._hDPSP, -gds - xnrm * (gm + gmbs));
      solver.stampElement(this._hSPG,  -(xnrm - xrev) * gm);
      solver.stampElement(this._hSPS,  -gs);
      solver.stampElement(this._hSPB,  -gbs - (xnrm - xrev) * gmbs);
      solver.stampElement(this._hSPDP, -gds - xrev * (gm + gmbs));
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      // pinLayout order: [G, D, S, B]. Drain current = polarity * cd
      // (mos3load.c:882). Gate/bulk DC currents are 0 (caps only).
      const id = polarity * this._cd;
      return [0, id, -id, 0];
    }

    setParam(key: string, value: number): void {
      if (key in params) {
        if (key === "TEMP") {
          // cite: mos3par.c:84 — +CONSTCtoK.
          params.TEMP = value + 273.15;
          this._tempGiven = true;
          this._temp = params.TEMP;
        } else if (key === "TNOM") {
          // cite: mos3mpar.c:183 — +CONSTCtoK.
          params.TNOM = value + 273.15;
        } else {
          params[key] = value;
          if (key === "DTEMP") { this._dtempGiven = true; this._dtemp = value; }
        }
        this.computeTemperature(this._lastCtx);
      }
    }

    // -----------------------------------------------------------------------
    // Part G — getLteTimestep() (mos3trun.c:12-27)
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
      // mos3trun.c:21-23 — CKTterr on QGS, QGD, QGB only.
      const pairs: [number, number][] = [
        [SLOT_QGS, SLOT_CQGS],
        [SLOT_QGD, SLOT_CQGD],
        [SLOT_QGB, SLOT_CQGB],
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
  }

  return new Mosfet3AnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// Public factory entry points
// ---------------------------------------------------------------------------

export function createMosfet3Element(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createMosfet3ElementWithPolarity(1, pinNodes, props);
}

export function createPmosfet3Element(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createMosfet3ElementWithPolarity(-1, pinNodes, props);
}

/** Internal node labels in allocation order: drain (RD/RSH), source (RS/RSH). */
export function getMosfet3InternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  const rd = props.getModelParam<number>("RD");
  const rsh = props.getModelParam<number>("RSH");
  const nrd = props.getModelParam<number>("NRD");
  const rs = props.getModelParam<number>("RS");
  const nrs = props.getModelParam<number>("NRS");
  if (rd !== 0 || (rsh !== 0 && nrd !== 0)) labels.push("drain");
  if (rs !== 0 || (rsh !== 0 && nrs !== 0)) labels.push("source");
  return labels;
}

// ---------------------------------------------------------------------------
// Pin layouts (4-terminal: D, G, S, B — mos3.c:162-167)
// ---------------------------------------------------------------------------

function buildMosfet3NPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "B", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function buildMosfet3PPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "B", defaultBitWidth: 1, position: { x: 0, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

// ---------------------------------------------------------------------------
// Visual element implementations
// ---------------------------------------------------------------------------

export class Mosfet3NElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NMOS3", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildMosfet3NPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1.3125, width: 4, height: 2.625 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");
    const vB = signals?.getPinVoltage("B");
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    const chanX = 2.625;
    const gateBarX = 2.25;
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);
    ctx.drawLine(gateBarX, -0.5, gateBarX, 0.5);
    ctx.drawLine(chanX, 0, 2.625, 0);
    ctx.drawPolygon([
      { x: 2.625, y: 0 },
      { x: 3.375, y: 0.3125 },
      { x: 3.375, y: -0.3125 },
    ], true);
    drawColoredLead(ctx, signals, vG, 0, 0, gateBarX, 0);
    drawColoredLead(ctx, signals, vD, 4, -1, chanX, -1);
    drawColoredLead(ctx, signals, vS, 4, 1, chanX, 1);
    drawColoredLead(ctx, signals, vB, 0, 1, chanX, 0);
    ctx.drawLine(4, 1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);
    ctx.restore();
  }
}

export class Mosfet3PElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PMOS3", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildMosfet3PPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1.3125, width: 4.0, height: 2.625 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");
    const vB = signals?.getPinVoltage("B");
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    const chanX = 2.625;
    const gateBarX = 2.25;
    drawColoredLead(ctx, signals, vD, 4, 1, chanX, 1);
    drawColoredLead(ctx, signals, vS, 4, -1, chanX, -1);
    drawColoredLead(ctx, signals, vB, 0, 1, chanX, 0);
    ctx.setColor("COMPONENT");
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);
    drawColoredLead(ctx, signals, vS, 4, -1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 4, y: 0 },
      { x: 3.25, y: -0.3125 },
      { x: 3.25, y: 0.3125 },
    ], true);
    drawColoredLead(ctx, signals, vG, 0, 0, gateBarX, 0);
    ctx.setColor("COMPONENT");
    ctx.drawLine(gateBarX, -0.5, gateBarX, 0.5);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions + attribute mappings
// ---------------------------------------------------------------------------

const MOSFET3_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const MOSFET3_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "W", propertyKey: "W", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "L", propertyKey: "L", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Part H — Component definitions
// ---------------------------------------------------------------------------

function nmos3CircuitFactory(props: PropertyBag): Mosfet3NElement {
  return new Mosfet3NElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pmos3CircuitFactory(props: PropertyBag): Mosfet3PElement {
  return new Mosfet3PElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const Mosfet3NDefinition: StandaloneComponentDefinition = {
  name: "NMOS3",
  typeId: -1,
  factory: nmos3CircuitFactory,
  pinLayout: buildMosfet3NPinDeclarations(),
  voltageProbes: [
    { name: "Vds", pos: "D", neg: "S" },
    { name: "Vgs", pos: "G", neg: "S" },
    { name: "Vbs", pos: "B", neg: "S" },
  ],
  propertyDefs: MOSFET3_PROPERTY_DEFS,
  attributeMap: MOSFET3_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel MOSFET — Level 3 SPICE model (semi-empirical short-channel).\n" +
    "Pins: D (drain), G (gate), S (source), B (bulk) — 4-terminal.\n" +
    "Primary: VTO, KP, GAMMA.\n" +
    "Level-3 short-channel params: THETA, VMAX, KAPPA, ETA, XJ, DELTA, NFS, NSUB.",
  models: {},
  modelRegistry: {
    "spice-l3": {
      kind: "inline",
      factory: createMosfet3Element,
      paramDefs: MOSFET3_N_PARAM_DEFS,
      params: MOSFET3_N_DEFAULTS,
      spice: { device: "MOS", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice-l3",
};

export const Mosfet3PDefinition: StandaloneComponentDefinition = {
  name: "PMOS3",
  typeId: -1,
  factory: pmos3CircuitFactory,
  pinLayout: buildMosfet3PPinDeclarations(),
  voltageProbes: [
    { name: "Vsd", pos: "S", neg: "D" },
    { name: "Vsg", pos: "S", neg: "G" },
    { name: "Vsb", pos: "S", neg: "B" },
  ],
  propertyDefs: MOSFET3_PROPERTY_DEFS,
  attributeMap: MOSFET3_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel MOSFET — Level 3 SPICE model (semi-empirical short-channel).\n" +
    "Pins: D (drain), G (gate), S (source), B (bulk) — 4-terminal.\n" +
    "Primary: VTO, KP, GAMMA.\n" +
    "Level-3 short-channel params: THETA, VMAX, KAPPA, ETA, XJ, DELTA, NFS, NSUB.",
  models: {},
  modelRegistry: {
    "spice-l3": {
      kind: "inline",
      factory: createPmosfet3Element,
      paramDefs: MOSFET3_P_PARAM_DEFS,
      params: MOSFET3_P_DEFAULTS,
      spice: { device: "MOS", deckNodeTokens: ["D", "G", "S"] },
    },
  },
  defaultModel: "spice-l3",
};
