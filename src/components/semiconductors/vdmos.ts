/**
 * VDMOS analog component — LTspice-compatible vertical DMOS power MOSFET
 * (N-channel / P-channel), SPICE VDMOS model new in ngspice v41.
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/vdmos/`:
 *   - vdmosdefs.h  — instance/model structs, the 18 state slots (:251-276).
 *   - vdmosset.c   — VDMOSsetup (model defaults, prime-node alloc, TSTALLOC).
 *   - vdmostemp.c  — VDMOStemp / VDMOStempUpdate (temperature corrections).
 *   - vdmosload.c  — VDMOSload (drain current, gate caps, body diode, self-heat).
 *   - vdmosacld.c  — VDMOSacLoad (AC small-signal).
 *   - vdmostrun.c  — VDMOStrunc (LTE via CKTterr).
 *   - vdmosconv.c  — VDMOSconvTest (folded inline into load() noncon flags).
 *   - vdmospar.c / vdmosmpar.c — instance / model parameter setters.
 *   - devsup.c DevCapVDMOS (:653-665) — ported to newton-raphson.ts::devCapVdmos.
 *
 * Single-pass `load()` per device per NR iteration (unified-interface model,
 * sibling of mosfet.ts). VDMOStype carries the device polarity (+1 NMOS / -1
 * PMOS); VdmosNDefinition/VdmosPDefinition seed it via the default model. State
 * lives in StatePool slots; load() reads s1/s2 and writes s0. All params are
 * hot-loadable via setParam.
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
import type { AnalogElement } from "../../solver/analog/element.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { fetlim, limvds, limitlog, pnjlim, devCapVdmos } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG,
  MODEINITTRAN, MODEINITPRED, MODETRAN, MODETRANOP, MODEUIC,
  MODEAC, MODEDCOP, MODEDCTRANCURVE,
} from "../../solver/analog/ckt-mode.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import {
  CONSTboltz,
  CHARGE,
  CONSTKoverQ,
  CONSTCtoK,
  REFTEMP,
} from "../../core/constants.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** sqrt(2) (CONSTroot2). */
const CONSTroot2 = Math.SQRT2;
/** Euler's number (CONSTe, const.h). */
const CONSTe = Math.E;
/** ckt->CKTreltol default (cktinit.c). Used by the breakdown match tolerance. */
const CKT_RELTOL = 1e-3;

// ---------------------------------------------------------------------------
// Part A — VDMOS_SCHEMA (18 state slots)
//
// cite: vdmosdefs.h:251-276 — VDMOSnumStates 18. One slot per v41 #define,
// same order: the state-vector layout the integrator/predictor index by.
// ---------------------------------------------------------------------------

export const VDMOS_SCHEMA: StateSchema = defineStateSchema("VdmosElement", [
  { name: "VGS",       doc: "vdmosdefs.h VDMOSvgs=0" },
  { name: "VDS",       doc: "vdmosdefs.h VDMOSvds=1" },
  { name: "DELTEMP",   doc: "vdmosdefs.h VDMOSdelTemp=2" },
  { name: "CAPGS",     doc: "vdmosdefs.h VDMOScapgs=3" },
  { name: "QGS",       doc: "vdmosdefs.h VDMOSqgs=4" },
  { name: "CQGS",      doc: "vdmosdefs.h VDMOScqgs=5" },
  { name: "CAPGD",     doc: "vdmosdefs.h VDMOScapgd=6" },
  { name: "QGD",       doc: "vdmosdefs.h VDMOSqgd=7" },
  { name: "CQGD",      doc: "vdmosdefs.h VDMOScqgd=8" },
  { name: "VDIO_V",    doc: "vdmosdefs.h VDIOvoltage=9" },
  { name: "VDIO_I",    doc: "vdmosdefs.h VDIOcurrent=10" },
  { name: "VDIO_G",    doc: "vdmosdefs.h VDIOconduct=11" },
  { name: "VDIO_QCAP", doc: "vdmosdefs.h VDIOcapCharge=12" },
  { name: "VDIO_CCAP", doc: "vdmosdefs.h VDIOcapCurrent=13" },
  { name: "CAPTH",     doc: "vdmosdefs.h VDMOScapth=14" },
  { name: "QTH",       doc: "vdmosdefs.h VDMOSqth=15" },
  { name: "CQTH",      doc: "vdmosdefs.h VDMOScqth=16" },
  { name: "VDIO_DIDT", doc: "vdmosdefs.h VDIOdIdio_dT=17" },
]);

// Slot index constants (match VDMOS_SCHEMA order, vdmosdefs.h:251-276).
const SLOT_VGS       = 0;
const SLOT_VDS       = 1;
const SLOT_DELTEMP   = 2;
const SLOT_CAPGS     = 3;
const SLOT_QGS       = 4;
const SLOT_CQGS      = 5;
const SLOT_CAPGD     = 6;
const SLOT_QGD       = 7;
const SLOT_CQGD      = 8;
const SLOT_VDIO_V    = 9;
const SLOT_VDIO_I    = 10;
const SLOT_VDIO_G    = 11;
const SLOT_VDIO_QCAP = 12;
const SLOT_VDIO_CCAP = 13;
const SLOT_CAPTH     = 14;
const SLOT_QTH       = 15;
const SLOT_CQTH      = 16;
const SLOT_VDIO_DIDT = 17;

// ---------------------------------------------------------------------------
// Part B — Model / instance parameter declarations
//
// Param set from vdmos.c / vdmosmpar.c / vdmospar.c; defaults from vdmosset.c.
// The N/P split carries VDMOStype = +1 / -1, applied to the transconductance
// and threshold IRF defaults at construction (kp = 25 + 10*type, vth0 = 3*type).
// ---------------------------------------------------------------------------

/**
 * Build the VDMOS param defs for a given device polarity. ngspice computes the
 * KP / VTH defaults from VDMOStype (vdmosset.c:34-38): for NMOS (type +1)
 * kp = 35, vth0 = 3; for PMOS (type -1) kp = 15, vth0 = -3. Defaults are the
 * IRF540 / IRF9540 fit values (vdmosset.c comments).
 */
function buildVdmosParams(type: 1 | -1): {
  paramDefs: ParamDef[];
  defaults: Record<string, number>;
} {
  return defineModelParams({
    primary: {
      VTH: { default: 3 * type, unit: "V", description: "Threshold voltage (vto/vth0, vdmosset.c:37-38)" },
      KP:  { default: 25 + 10 * type, unit: "A/V²", description: "Transconductance (vdmosset.c:34-35)" },
      LAMBDA: { default: 0, unit: "1/V", description: "Channel-length modulation (vdmosset.c:58-59)" },
    },
    secondary: {
      PHI:   { default: 0.6, unit: "V", description: "Surface potential (vdmosset.c:55-56)" },
      THETA: { default: 0, unit: "1/V", description: "Mobility reduction (vdmosset.c:61-62)" },
      RD:    { default: 0, unit: "Ω", description: "Drain ohmic resistance (vdmosset.c:100-101)" },
      RS:    { default: 0, unit: "Ω", description: "Source ohmic resistance (vdmosset.c:103-104)" },
      RG:    { default: 0, unit: "Ω", description: "Gate ohmic resistance (vdmosset.c:106-107)" },
      TNOM:  { default: REFTEMP, unit: "K", description: "Nominal temperature (vdmosset.c:222-224)", spiceConverter: kelvinToCelsius },
      KF:    { default: 0, description: "Flicker noise coefficient (vdmosset.c:64-65)" },
      AF:    { default: 1, description: "Flicker noise exponent (vdmosset.c:67-68)" },
      RQ:    { default: 0, unit: "Ω", description: "Quasi-saturation resistance (vdmosset.c:211-212)" },
      VQ:    { default: 0, unit: "V", description: "Quasi-saturation voltage (vdmosset.c:214-215)" },
      MTRIODE: { default: 1, description: "Triode-region scaling mtr (vdmosset.c:88-90)" },
      TCVTH: { default: 0, unit: "V/K", description: "Vth temperature coefficient (vdmosset.c:139-140)" },
      MU:    { default: -1.5, description: "Mobility temperature exponent (vdmosset.c:136-137)" },
      TEXP0: { default: 1.5, description: "Rd temperature exponent (vdmosset.c:142-143)" },
      TEXP1: { default: 0.3, description: "Rq temperature exponent (vdmosset.c:145-146)" },
      TRD1:  { default: 0, description: "Rd linear temp coeff (vdmosset.c:148-149)" },
      TRD2:  { default: 0, description: "Rd quadratic temp coeff (vdmosset.c:151-152)" },
      TRG1:  { default: 0, description: "Rg linear temp coeff (vdmosset.c:154-155)" },
      TRG2:  { default: 0, description: "Rg quadratic temp coeff (vdmosset.c:157-158)" },
      TRS1:  { default: 0, description: "Rs linear temp coeff (vdmosset.c:160-161)" },
      TRS2:  { default: 0, description: "Rs quadratic temp coeff (vdmosset.c:163-164)" },
      SUBSHIFT:    { default: 0, unit: "V", description: "Subthreshold shift (vdmosset.c:82-83)" },
      KSUBTHRES:   { default: 0.1, unit: "V", description: "Weak-inversion slope (vdmosset.c:85-86)" },
      TKSUBTHRES1: { default: 0, description: "Ksubthres linear temp coeff (vdmosset.c:172-173)" },
      TKSUBTHRES2: { default: 0, description: "Ksubthres quadratic temp coeff (vdmosset.c:175-176)" },
      BV:  { default: 1e99, unit: "V", description: "Body-diode breakdown voltage (vdmosset.c:91-92)" },
      IBV: { default: 1.0e-10, unit: "A", description: "Body-diode breakdown current (vdmosset.c:94-95)" },
      NBV: { default: 1, description: "Body-diode breakdown emission coeff (vdmosset.c:97-98)" },
      RDS: { default: 1.0e+15, unit: "Ω", description: "Drain-source shunt resistance (vdmosset.c:109-110)" },
      RB:  { default: 0, unit: "Ω", description: "Body-diode series resistance (vdmosset.c:112-113)" },
      N:   { default: 1, description: "Body-diode emission coefficient (vdmosset.c:115-116)" },
      TT:  { default: 0, unit: "s", description: "Body-diode transit time (vdmosset.c:118-119)" },
      EG:  { default: 1.11, unit: "eV", description: "Body-diode activation energy (vdmosset.c:121-122)" },
      XTI: { default: 3.0, description: "Body-diode IS temp exponent (vdmosset.c:124-125)" },
      IS:  { default: 1e-14, unit: "A", description: "Body-diode saturation current (vdmosset.c:40-41)" },
      VJ:  { default: 0.8, unit: "V", description: "Body-diode junction potential (vdmosset.c:43-44)" },
      TRB1: { default: 0, description: "Body-diode Rb linear temp coeff (vdmosset.c:166-167)" },
      TRB2: { default: 0, description: "Body-diode Rb quadratic temp coeff (vdmosset.c:169-170)" },
      CJO: { default: 5e-10, unit: "F", description: "Body-diode zero-bias junction cap (vdmosset.c:46-47)" },
      MJ:  { default: 0.5, description: "Body-diode grading coefficient (vdmosset.c:49-50)" },
      FC:  { default: 0.5, description: "Body-diode forward-bias cap coeff (vdmosset.c:52-53)" },
      CGDMIN: { default: 2e-11, unit: "F", description: "Min gate-drain cap (vdmosset.c:70-71)" },
      CGDMAX: { default: 2e-9, unit: "F", description: "Max gate-drain cap (vdmosset.c:73-74)" },
      A:      { default: 1.0, description: "Gate-cap nonlinearity coeff (vdmosset.c:79-80)" },
      CGS:    { default: 1.4e-9, unit: "F", description: "Gate-source cap (vdmosset.c:76-77)" },
      RTHJC: { default: 1.0, unit: "K/W", description: "Junction-to-case thermal resistance (vdmosset.c:127-128)" },
      RTHCA: { default: 1000, unit: "K/W", description: "Case-to-ambient thermal resistance (vdmosset.c:130-131)" },
      CTHJ:  { default: 10e-6, unit: "J/K", description: "Junction thermal capacitance (vdmosset.c:133-134)" },
      VGS_MAX:  { default: 1e99, unit: "V", description: "SOA max Vgs (stored, unused; vdmosset.c:178-179)" },
      VGD_MAX:  { default: 1e99, unit: "V", description: "SOA max Vgd (stored, unused; vdmosset.c:181-182)" },
      VDS_MAX:  { default: 1e99, unit: "V", description: "SOA max Vds (stored, unused; vdmosset.c:184-185)" },
      VGSR_MAX: { default: 1e99, unit: "V", description: "SOA max reverse Vgs (stored, unused; vdmosset.c:187-188)" },
      VGDR_MAX: { default: 1e99, unit: "V", description: "SOA max reverse Vgd (stored, unused; vdmosset.c:190-191)" },
      PD_MAX:   { default: 1e99, unit: "W", description: "SOA max power dissipation (stored, unused; vdmosset.c:193-194)" },
      ID_MAX:   { default: 1e99, unit: "A", description: "SOA max drain current (stored, unused; vdmosset.c:196-197)" },
      IDR_MAX:  { default: 1e99, unit: "A", description: "SOA max reverse drain current (stored, unused; vdmosset.c:199-200)" },
      TE_MAX:   { default: 1e99, unit: "K", description: "SOA max temperature (stored, unused; vdmosset.c:202-203)" },
      RTH_EXT:  { default: 1000, unit: "K/W", description: "SOA external thermal resistance (defaults to RTHCA; vdmosset.c:208-209)" },
      DERATING: { default: 0, description: "SOA derating (stored, unused; vdmosset.c:205-206)" },
    },
    instance: {
      M:     { default: 1, description: "Parallel device multiplier (vdmospar.c:41-44)" },
      OFF:   { default: 0, emit: "flag", description: "Initial condition: device off (vdmospar.c:45-47)" },
      ICVDS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 0 }, description: "IC for Vds (vdmospar.c:48-51)" },
      ICVGS: { default: 0, unit: "V", emitGroup: { name: "IC", index: 1 }, description: "IC for Vgs (vdmospar.c:52-55)" },
      TEMP:  { default: REFTEMP, unit: "K", description: "Per-instance operating temperature (vdmospar.c:33-36)", spiceConverter: kelvinToCelsius },
      DTEMP: { default: 0, unit: "K", description: "Instance temp delta from ambient (vdmospar.c:37-40)" },
      THERMAL: { default: 0, emit: "flag", description: "Self-heating enable flag (vdmospar.c:56-58)" },
    },
  });
}

const _N = buildVdmosParams(1);
const _P = buildVdmosParams(-1);

export const VDMOS_N_PARAM_DEFS = _N.paramDefs;
export const VDMOS_N_DEFAULTS = _N.defaults;
export const VDMOS_P_PARAM_DEFS = _P.paramDefs;
export const VDMOS_P_DEFAULTS = _P.defaults;

// ---------------------------------------------------------------------------
// VdmosAnalogElement factory
// ---------------------------------------------------------------------------

function _createVdmosElementWithType(
  type: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): AnalogElement {
  // Pin node IDs, resolved in setup().
  let dNode = -1;
  let gNode = -1;
  let sNode = -1;

  // Internal prime nodes (default to external when the gating resistance is 0).
  let dPrime = -1;
  let gPrime = -1;
  let sPrime = -1;
  let dioPrime = -1;
  // Self-heating internal nodes / branch (0 sentinel when off, matching
  // ngspice's tempNode=0 non-selfheat path, vdmosset.c:422-425).
  let tempNode = 0;
  let tcaseNode = 0;
  let tNodePrime = 0;
  let vcktTbranch = 0;

  // ---- model + instance parameters (mutable; setParam writes here) ----
  // cite: vdmospar.c:34 / vdmosmpar.c:20 — temp/tnom carry +CONSTCtoK when set.
  // The bag already applied the kelvinToCelsius spiceConverter on emit; on read
  // we get Kelvin values directly.
  const p: Record<string, number> = {
    VTH: props.getModelParam<number>("VTH"),
    KP: props.getModelParam<number>("KP"),
    LAMBDA: props.getModelParam<number>("LAMBDA"),
    PHI: props.getModelParam<number>("PHI"),
    THETA: props.getModelParam<number>("THETA"),
    RD: props.getModelParam<number>("RD"),
    RS: props.getModelParam<number>("RS"),
    RG: props.getModelParam<number>("RG"),
    TNOM: props.getModelParam<number>("TNOM"),
    KF: props.getModelParam<number>("KF"),
    AF: props.getModelParam<number>("AF"),
    RQ: props.getModelParam<number>("RQ"),
    VQ: props.getModelParam<number>("VQ"),
    MTRIODE: props.getModelParam<number>("MTRIODE"),
    TCVTH: props.getModelParam<number>("TCVTH"),
    MU: props.getModelParam<number>("MU"),
    TEXP0: props.getModelParam<number>("TEXP0"),
    TEXP1: props.getModelParam<number>("TEXP1"),
    TRD1: props.getModelParam<number>("TRD1"),
    TRD2: props.getModelParam<number>("TRD2"),
    TRG1: props.getModelParam<number>("TRG1"),
    TRG2: props.getModelParam<number>("TRG2"),
    TRS1: props.getModelParam<number>("TRS1"),
    TRS2: props.getModelParam<number>("TRS2"),
    SUBSHIFT: props.getModelParam<number>("SUBSHIFT"),
    KSUBTHRES: props.getModelParam<number>("KSUBTHRES"),
    TKSUBTHRES1: props.getModelParam<number>("TKSUBTHRES1"),
    TKSUBTHRES2: props.getModelParam<number>("TKSUBTHRES2"),
    BV: props.getModelParam<number>("BV"),
    IBV: props.getModelParam<number>("IBV"),
    NBV: props.getModelParam<number>("NBV"),
    RDS: props.getModelParam<number>("RDS"),
    RB: props.getModelParam<number>("RB"),
    N: props.getModelParam<number>("N"),
    TT: props.getModelParam<number>("TT"),
    EG: props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    IS: props.getModelParam<number>("IS"),
    VJ: props.getModelParam<number>("VJ"),
    TRB1: props.getModelParam<number>("TRB1"),
    TRB2: props.getModelParam<number>("TRB2"),
    CJO: props.getModelParam<number>("CJO"),
    MJ: props.getModelParam<number>("MJ"),
    FC: props.getModelParam<number>("FC"),
    CGDMIN: props.getModelParam<number>("CGDMIN"),
    CGDMAX: props.getModelParam<number>("CGDMAX"),
    A: props.getModelParam<number>("A"),
    CGS: props.getModelParam<number>("CGS"),
    RTHJC: props.getModelParam<number>("RTHJC"),
    RTHCA: props.getModelParam<number>("RTHCA"),
    CTHJ: props.getModelParam<number>("CTHJ"),
    VGS_MAX: props.getModelParam<number>("VGS_MAX"),
    VGD_MAX: props.getModelParam<number>("VGD_MAX"),
    VDS_MAX: props.getModelParam<number>("VDS_MAX"),
    VGSR_MAX: props.getModelParam<number>("VGSR_MAX"),
    VGDR_MAX: props.getModelParam<number>("VGDR_MAX"),
    PD_MAX: props.getModelParam<number>("PD_MAX"),
    ID_MAX: props.getModelParam<number>("ID_MAX"),
    IDR_MAX: props.getModelParam<number>("IDR_MAX"),
    TE_MAX: props.getModelParam<number>("TE_MAX"),
    RTH_EXT: props.getModelParam<number>("RTH_EXT"),
    DERATING: props.getModelParam<number>("DERATING"),
    M: props.getModelParam<number>("M"),
    OFF: props.getModelParam<number>("OFF"),
    ICVDS: props.getModelParam<number>("ICVDS"),
    ICVGS: props.getModelParam<number>("ICVGS"),
    TEMP: props.getModelParam<number>("TEMP"),
    DTEMP: props.getModelParam<number>("DTEMP"),
    THERMAL: props.getModelParam<number>("THERMAL"),
  };

  // *Given guards mirror ngspice's per-instance/model `<x>Given` flags.
  const given = {
    RQ: props.isModelParamGiven("RQ"),
    VQ: props.isModelParamGiven("VQ"),
    RDS: props.isModelParamGiven("RDS"),
    RB: props.isModelParamGiven("RB"),
    TEXP0: props.isModelParamGiven("TEXP0"),
    BV: props.isModelParamGiven("BV"),
    RTHJC: props.isModelParamGiven("RTHJC"),
    TEMP: props.isModelParamGiven("TEMP"),
    DTEMP: props.isModelParamGiven("DTEMP"),
  };

  // vdmosset.c:217-220 — qsGiven = rqGiven && vqGiven.
  let qsGiven = given.RQ && given.VQ;

  // vdmosmpar.c:82-83 / :166-167 — setting mj zeroes gradCoeffTemp1/2; setting
  // tt zeroes tranTimeTemp1/2. Not parse-time netlist params (no card row); they
  // default to 0 and are zeroed when mj/tt are set.
  let gradCoeffTemp1 = 0;
  let gradCoeffTemp2 = 0;
  let tranTimeTemp1 = 0;
  let tranTimeTemp2 = 0;

  class VdmosAnalogElement extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MOS;
    readonly deviceFamily: DeviceFamily = "MOS";
    readonly stateSchema: StateSchema = VDMOS_SCHEMA;
    readonly stateSize: number = VDMOS_SCHEMA.size;

    private readonly _internalLabels: string[] = [];

    // ---- conductances (vdmosset.c:277-305) ----
    private _m = 1;
    private _sourceConductance = 0;
    private _drainConductance = 0;
    private _gateConductance = 0;
    private _dsConductance = 1e-15;
    private _dioConductance = 0;
    // ---- temperature working set (vdmostemp.c) ----
    private _temp = REFTEMP;
    private _dtemp = 0;
    private _drainResistance = 0;
    private _qsResistance = 0;
    private _tTransconductance = 0;
    private _tVth = 0;
    private _tPhi = 0;
    private _tksubthres = 0;
    private _tGradingCoeff = 0;
    private _tJctCap = 0;
    private _tJctPot = 0;
    private _tSatCur = 0;
    private _tSatCur_dT = 0;
    private _tConductance = 0;
    private _tConductance_dT = 0;
    private _tBrkdwnV = 0;
    private _tDepCap = 0;
    private _tVcrit = 0;
    private _tTransitTime = 0;
    private _tF1 = 0;
    private _tF2 = 0;
    private _tF3 = 0;
    private _cap = 0;
    // ---- operating-point scalars (vdmosdefs.h:74-108) ----
    private _von = 0;
    private _vdsat = 0;
    private _cd = 0;
    private _gm = 0;
    private _gds = 0;
    private _gmT = 0;
    private _mode = 1;
    private _gtempg = 0;
    private _gtempd = 0;
    private _gtempT = 0;
    private _cth = 0;

    // ---- matrix handles (TSTALLOC order, vdmosset.c:433-486) ----
    private _hDd = -1; private _hGg = -1; private _hSs = -1;
    private _hDPdp = -1; private _hSPsp = -1; private _hGPgp = -1;
    private _hDdp = -1; private _hGPdp = -1; private _hGPsp = -1;
    private _hSsp = -1; private _hDPsp = -1; private _hDPd = -1;
    private _hDPgp = -1; private _hSPgp = -1; private _hSPs = -1;
    private _hSPdp = -1; private _hGgp = -1; private _hGPg = -1;
    private _hDs = -1; private _hSd = -1;
    private _hRPd = -1; private _hDrp = -1; private _hSrp = -1;
    private _hRPs = -1; private _hRPrp = -1;
    // thermal cells (selfheat only)
    private _hTemptemp = -1; private _hTempdp = -1; private _hTempsp = -1;
    private _hTempgp = -1; private _hGPtemp = -1; private _hDPtemp = -1;
    private _hSPtemp = -1; private _hTempposPrime = -1; private _hTempd = -1;
    private _hPosPrimetemp = -1; private _hDtemp = -1; private _htempS = -1;
    private _hStemp = -1; private _hTcasetcase = -1; private _hTcasetemp = -1;
    private _hTemptcase = -1; private _hTptp = -1; private _hTptcase = -1;
    private _hTcasetp = -1; private _hCktTcktT = -1; private _hCktTtp = -1;
    private _hTpcktT = -1;

    private _lastCtx: TempContext = { cktTemp: REFTEMP, cktNomTemp: p.TNOM, _indVerbosity: 2 };

    constructor(pinNodes: ReadonlyMap<string, number>) {
      super(pinNodes);
      this._m = p.M;
    }

    getInternalNodeLabels(): readonly string[] {
      return this._internalLabels;
    }

    /**
     * Operating-point readback — the load-bearing VDMOSask quantities
     * (vdmosask.c VDMOS_VON / VDMOS_VDSAT / VDMOS_CD / VDMOS_GM / VDMOS_GDS /
     * VDMOS_CDIO and the temperature-corrected tPhi). digiTS has no IFparm ask
     * dispatch; these scalars are exposed here for tests and consumers.
     */
    getOperatingPoint(): {
      von: number; vdsat: number; cd: number; gm: number; gds: number;
      cdio: number; tPhi: number; mode: number;
    } {
      return {
        von: this._von, vdsat: this._vdsat, cd: this._cd,
        gm: this._gm, gds: this._gds, cdio: this._cap,
        tPhi: this._tPhi, mode: this._mode,
      };
    }

    /** selfheat = thermal && rthjcGiven (vdmosset.c:401 / vdmosload.c:81). */
    private _selfheat(): boolean {
      return p.THERMAL !== 0 && given.RTHJC;
    }

    // -----------------------------------------------------------------------
    // Part C — setup()
    // -----------------------------------------------------------------------
    setup(ctx: SetupContext): void {
      // cite: vdmosset.c:251-252 — set lower limit of the body-diode saturation
      // current (VDIOjctSatCur). ngspice floors it in VDMOSsetup, before
      // VDMOStemp (vdmostemp.c:99-107) derives tSatCur from it; flooring p.IS
      // here precedes the post-setup computeTemperature() pass that consumes it.
      if (p.IS < ctx.epsmin) {
        p.IS = ctx.epsmin;
      }

      const solver = ctx.solver;
      dNode = this.pinNodes.get("D")!;
      gNode = this.pinNodes.get("G")!;
      sNode = this.pinNodes.get("S")!;

      // vdmosset.c:259-260 — *states += VDMOSnumStates.
      this._stateBase = ctx.allocStates(VDMOS_SCHEMA.size);

      // vdmosset.c:274-276 — m default 1.
      this._m = p.M;

      // vdmosset.c:277-305 — conductances.
      this._drainConductance = p.RD > 0 ? this._m / p.RD : 0.0;
      this._sourceConductance = p.RS > 0 ? this._m / p.RS : 0.0;
      this._gateConductance = p.RG > 0 ? this._m / p.RG : 0.0;
      // vdmosset.c:292-300 — dsConductance gated on rdsGiven: only when rds is
      // user-given does rds>0 yield m/rds; ungiven (or rds<=0) defaults to 1e-15.
      if (given.RDS) {
        this._dsConductance = p.RDS > 0 ? this._m / p.RDS : 1e-15;
      } else {
        this._dsConductance = 1e-15;
      }
      this._dioConductance = p.RB > 0 ? this._m / p.RB : 0.0;

      this._internalLabels.length = 0;

      // vdmosset.c:307-329 — dPrime via CKTmkVolt only if rd>0.
      if (p.RD > 0) {
        dPrime = ctx.makeVolt(this.label || "VM", "drain");
        this._internalLabels.push("drain");
      } else {
        dPrime = dNode;
      }
      // vdmosset.c:331-352 — gPrime only if rg>0.
      if (p.RG > 0) {
        gPrime = ctx.makeVolt(this.label || "VM", "gate");
        this._internalLabels.push("gate");
      } else {
        gPrime = gNode;
      }
      // vdmosset.c:354-376 — sPrime only if rs>0.
      if (p.RS > 0) {
        sPrime = ctx.makeVolt(this.label || "VM", "source");
        this._internalLabels.push("source");
      } else {
        sPrime = sNode;
      }
      // vdmosset.c:378-399 — dioPrime via CKTmkVolt only if rb>0, else sNode.
      if (p.RB > 0) {
        dioPrime = ctx.makeVolt(this.label || "VM", "body diode");
        this._internalLabels.push("body diode");
      } else {
        dioPrime = sNode;
      }

      // vdmosset.c:401-425 — self-heating node + branch alloc, gated on
      // (thermal && rthjcGiven); else tempNode = tcaseNode = 0.
      const selfheat = this._selfheat();
      if (selfheat) {
        tempNode = ctx.makeVolt(this.label || "VM", "Tj");
        tcaseNode = ctx.makeVolt(this.label || "VM", "Tc");
        vcktTbranch = ctx.makeCur(this.label || "VM", "VcktTemp");
        tNodePrime = ctx.makeVolt(this.label || "VM", "cktTemp");
        this._internalLabels.push("Tj", "Tc", "cktTemp");
      } else {
        tempNode = 0;
        tcaseNode = 0;
        tNodePrime = 0;
        vcktTbranch = 0;
      }

      // ---- Part C-matrix: TSTALLOC base cells (vdmosset.c:433-460) ----
      this._hDd   = solver.allocElement(dNode, dNode);          // :433
      this._hGg   = solver.allocElement(gNode, gNode);          // :434
      this._hSs   = solver.allocElement(sNode, sNode);          // :435
      this._hDPdp = solver.allocElement(dPrime, dPrime);        // :436
      this._hSPsp = solver.allocElement(sPrime, sPrime);        // :437
      this._hGPgp = solver.allocElement(gPrime, gPrime);        // :438
      this._hDdp  = solver.allocElement(dNode, dPrime);         // :439
      this._hGPdp = solver.allocElement(gPrime, dPrime);        // :440
      this._hGPsp = solver.allocElement(gPrime, sPrime);        // :441
      this._hSsp  = solver.allocElement(sNode, sPrime);         // :442
      this._hDPsp = solver.allocElement(dPrime, sPrime);        // :443
      this._hDPd  = solver.allocElement(dPrime, dNode);         // :444
      this._hDPgp = solver.allocElement(dPrime, gPrime);        // :445
      this._hSPgp = solver.allocElement(sPrime, gPrime);        // :446
      this._hSPs  = solver.allocElement(sPrime, sNode);         // :447
      this._hSPdp = solver.allocElement(sPrime, dPrime);        // :448
      this._hGgp  = solver.allocElement(gNode, gPrime);         // :450
      this._hGPg  = solver.allocElement(gPrime, gNode);         // :451
      this._hDs   = solver.allocElement(dNode, sNode);          // :453
      this._hSd   = solver.allocElement(sNode, dNode);          // :454
      this._hRPd  = solver.allocElement(dioPrime, dNode);       // :456
      this._hDrp  = solver.allocElement(dNode, dioPrime);       // :457
      this._hSrp  = solver.allocElement(sNode, dioPrime);       // :458
      this._hRPs  = solver.allocElement(dioPrime, sNode);       // :459
      this._hRPrp = solver.allocElement(dioPrime, dioPrime);    // :460

      // ---- thermal cells (vdmosset.c:462-486), selfheat only ----
      if (selfheat) {
        this._hTemptemp     = solver.allocElement(tempNode, tempNode);       // :463
        this._hTempdp       = solver.allocElement(tempNode, dPrime);         // :464
        this._hTempsp       = solver.allocElement(tempNode, sPrime);         // :465
        this._hTempgp       = solver.allocElement(tempNode, gPrime);         // :466
        this._hGPtemp       = solver.allocElement(gPrime, tempNode);         // :467
        this._hDPtemp       = solver.allocElement(dPrime, tempNode);         // :468
        this._hSPtemp       = solver.allocElement(sPrime, tempNode);         // :469
        this._hTempposPrime = solver.allocElement(tempNode, dioPrime);       // :471
        this._hTempd        = solver.allocElement(tempNode, dNode);          // :472
        this._hPosPrimetemp = solver.allocElement(dioPrime, tempNode);       // :473
        this._hDtemp        = solver.allocElement(dNode, tempNode);          // :474
        this._htempS        = solver.allocElement(tempNode, sNode);          // :475
        this._hStemp        = solver.allocElement(sNode, tempNode);          // :476
        this._hTcasetcase   = solver.allocElement(tcaseNode, tcaseNode);     // :478
        this._hTcasetemp    = solver.allocElement(tcaseNode, tempNode);      // :479
        this._hTemptcase    = solver.allocElement(tempNode, tcaseNode);      // :480
        this._hTptp         = solver.allocElement(tNodePrime, tNodePrime);   // :481
        this._hTptcase      = solver.allocElement(tNodePrime, tempNode);     // :482
        this._hTcasetp      = solver.allocElement(tempNode, tNodePrime);     // :483
        this._hCktTcktT     = solver.allocElement(vcktTbranch, vcktTbranch); // :484
        this._hCktTtp       = solver.allocElement(vcktTbranch, tNodePrime);  // :485
        this._hTpcktT       = solver.allocElement(tNodePrime, vcktTbranch);  // :486
        // VDMOSCktTcktTPtr (:484) is allocated for TSTALLOC-order parity but
        // never stamped — the cktTemp source loads only its RHS (vdmosload.c:605),
        // not the (vcktTbranch, vcktTbranch) self-cell.
        void this._hCktTcktT;
      }
    }

    findBranchFor(name: string, ctx: SetupContext): number {
      // Lazy alloc parity with VSRC/IND for the cktTemp branch.
      if (name !== this.label) return 0;
      if (vcktTbranch === 0 && this._selfheat()) {
        vcktTbranch = ctx.makeCur(this.label || "VM", "VcktTemp");
      }
      return vcktTbranch;
    }

    // -----------------------------------------------------------------------
    // Part D — computeTemperature() + _tempUpdate()
    // -----------------------------------------------------------------------
    computeTemperature(ctx: TempContext): void {
      this._lastCtx = ctx;
      // cite: vdmostemp.c:194 — if(!dtempGiven) dtemp = 0.0.
      this._dtemp = given.DTEMP ? p.DTEMP : 0.0;
      // cite: vdmostemp.c:196-197 — if(!tempGiven) temp = CKTtemp + dtemp.
      this._temp = given.TEMP ? p.TEMP : ctx.cktTemp + this._dtemp;
      // cite: vdmostemp.c:199 — VDMOStempUpdate(model, here, here->VDMOStemp, ckt).
      this._tempUpdate(this._temp);
    }

    /**
     * _tempUpdate — port of VDMOStempUpdate (vdmostemp.c:17-180). Recomputes
     * every temperature-corrected quantity at `Temp`. Called once with ambient
     * by computeTemperature(), and per-NR-iteration by load() with
     * VDMOStemp + delTemp under self-heating (vdmosload.c:279-284).
     */
    private _tempUpdate(Temp: number): void {
      const tnom = p.TNOM;
      // vdmostemp.c:31-37 — nominal-temp constants.
      const fact1 = tnom / REFTEMP;
      const vtnom = tnom * CONSTKoverQ;
      const kt1 = CONSTboltz * tnom;
      const egfet1 = 1.16 - (7.02e-4 * tnom * tnom) / (tnom + 1108);
      let arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
      const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + CHARGE * arg1);

      // vdmostemp.c:39 — xfc = log(1 - fc).
      const xfc = Math.log(1 - p.FC);

      // vdmostemp.c:43 — dt = Temp - tnom.
      const dt = Temp - tnom;

      // vdmostemp.c:46-48 — tTransconductance = transconductance * m * pow(ratio, mu).
      const ratio = Temp / tnom;
      this._tTransconductance = p.KP * this._m * Math.pow(ratio, p.MU);

      // vdmostemp.c:50 — tVth = vth0 - type*tcvth*dt.
      this._tVth = p.VTH - type * p.TCVTH * dt;

      // vdmostemp.c:52 — tksubthres = ksubthres*(1 + tksubthres1*dt + tksubthres2*dt*dt).
      this._tksubthres = p.KSUBTHRES * (1.0 + (p.TKSUBTHRES1 * dt) + (p.TKSUBTHRES2 * dt * dt));

      // vdmostemp.c:54-57 — drain resistance temperature adjust.
      if (given.TEXP0) {
        this._drainResistance = p.RD / this._m * Math.pow(ratio, p.TEXP0);
      } else {
        this._drainResistance = p.RD / this._m * (1.0 + (p.TRD1 * dt) + (p.TRD2 * dt * dt));
      }

      // vdmostemp.c:59-61 — gate/source conductance temperature adjust. ngspice
      // divides the setup() conductance in place; rebuild from the base each call.
      const baseGateCond = p.RG > 0 ? this._m / p.RG : 0.0;
      const baseSourceCond = p.RS > 0 ? this._m / p.RS : 0.0;
      this._gateConductance = baseGateCond / (1.0 + (p.TRG1 * dt) + (p.TRG2 * dt * dt));
      this._sourceConductance = baseSourceCond / (1.0 + (p.TRS1 * dt) + (p.TRS2 * dt * dt));

      // vdmostemp.c:63-64 — qs resistance temperature adjust if qsGiven.
      if (qsGiven) {
        this._qsResistance = p.RQ / this._m * Math.pow(ratio, p.TEXP1);
      }

      // vdmostemp.c:66-72 — Temp-side constants.
      const vt = Temp * CONSTKoverQ;
      const fact2 = Temp / REFTEMP;
      const kt = Temp * CONSTboltz;
      const egfet = 1.16 - (7.02e-4 * Temp * Temp) / (Temp + 1108);
      const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
      const pbfact = -2 * vt * (1.5 * Math.log(fact2) + CHARGE * arg);

      // vdmostemp.c:74-75 — tPhi.
      const phio = (p.PHI - pbfact1) / fact1;
      this._tPhi = fact2 * phio + pbfact;

      // ---- body diode temperature model (vdmostemp.c:77-179) ----
      // vdmostemp.c:85-87 — junction grading temperature adjust.
      let factor = 1.0 + (gradCoeffTemp1 * dt) + (gradCoeffTemp2 * dt * dt);
      this._tGradingCoeff = p.MJ * factor;

      // vdmostemp.c:89-97 — junction cap + potential.
      const pbo = (p.VJ - pbfact1) / fact1;
      const gmaold = (p.VJ - pbo) / pbo;
      this._tJctCap = this._m * p.CJO /
        (1 + this._tGradingCoeff * (400e-6 * (tnom - REFTEMP) - gmaold));
      this._tJctPot = pbfact + fact2 * pbo;
      const gmanew = (this._tJctPot - pbo) / pbo;
      this._tJctCap *= 1 + this._tGradingCoeff * (400e-6 * (Temp - REFTEMP) - gmanew);

      // vdmostemp.c:99-107 — vte, Arrhenius tSatCur / tSatCur_dT.
      const vte = p.N * vt;
      arg1 = ((Temp / tnom) - 1) * p.EG / vte;
      const arg1_dT = p.EG / (vte * tnom) - p.EG * (Temp / tnom - 1) / (vte * Temp);
      const arg2 = p.XTI / p.N * Math.log(Temp / tnom);
      const arg2_dT = p.XTI / p.N / Temp;
      this._tSatCur = this._m * p.IS * Math.exp(arg1 + arg2);
      this._tSatCur_dT = this._m * p.IS * Math.exp(arg1 + arg2) * (arg1_dT + arg2_dT);

      // vdmostemp.c:111-119 — tF1, tDepCap, tVcrit.
      this._tF1 = this._tJctPot *
        (1 - Math.exp((1 - this._tGradingCoeff) * xfc)) /
        (1 - this._tGradingCoeff);
      this._tDepCap = p.FC * this._tJctPot;
      this._tVcrit = vte * Math.log(vte / (CONSTroot2 * this._tSatCur));

      // vdmostemp.c:122-128 — limit junction potential to max of 1/FC, warn.
      if (this._tDepCap > 2.5) {
        this._tJctPot = 2.5 / p.N;
        this._tDepCap = p.N * this._tJctPot;
        console.warn(
          `${this.label || "VDMOS"}: junction potential VJ too large, limited to ${this._tJctPot}`,
        );
      }

      // vdmostemp.c:130-164 — breakdown voltage 25-iteration match (when bvGiven).
      if (given.BV) {
        // vdmostemp.c:134 — tBreakdownVoltage = fabs(bv).
        const tBreakdownVoltage = Math.abs(p.BV);
        const cbv = p.IBV;
        let xbv: number;
        if (cbv < this._tSatCur * tBreakdownVoltage / vt) {
          // vdmostemp.c:138-146 (TRACE warning is debug-only, dropped).
          xbv = tBreakdownVoltage;
          this._tBrkdwnV = xbv;
        } else {
          const tol = CKT_RELTOL * cbv;
          xbv = tBreakdownVoltage - p.NBV * vt * Math.log(1 + cbv / this._tSatCur);
          for (let iter = 0; iter < 25; iter++) {
            xbv = tBreakdownVoltage - p.NBV * vt * Math.log(cbv / this._tSatCur + 1 - xbv / vt);
            const xcbv = this._tSatCur *
              (Math.exp((tBreakdownVoltage - xbv) / (p.NBV * vt)) - 1 + xbv / vt);
            if (Math.abs(xcbv - cbv) <= tol) break; // vdmostemp.c:156 goto matched.
          }
          // vdmostemp.c:162-163 — matched: tBrkdwnV = xbv (TRACE warn dropped).
          this._tBrkdwnV = xbv;
        }
      }

      // vdmostemp.c:166-169 — transit time temperature adjust.
      factor = 1.0 + (tranTimeTemp1 * dt) + (tranTimeTemp2 * dt * dt);
      this._tTransitTime = p.TT * factor;

      // vdmostemp.c:171-175 — series resistance temperature adjust.
      factor = 1.0 + (p.TRB1) * dt + (p.TRB2 * dt * dt);
      this._tConductance = this._dioConductance / factor;
      this._tConductance_dT = -this._dioConductance * (p.TRB1 + p.TRB2 * dt) / (factor * factor);

      // vdmostemp.c:177-179 — tF2, tF3.
      this._tF2 = Math.exp((1 + this._tGradingCoeff) * xfc);
      this._tF3 = 1 - p.FC * (1 + this._tGradingCoeff);
    }

    // -----------------------------------------------------------------------
    // Part E — load()
    // -----------------------------------------------------------------------
    load(ctx: LoadContext): void {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const mode = ctx.cktMode;
      const solver = ctx.solver;
      const rhsOld = ctx.rhsOld;

      // vdmosload.c:71-74 — model-level cap constants.
      const cgdmin = p.CGDMIN;
      const cgdmax = p.CGDMAX;
      const a = p.A;
      const cgs = p.CGS;

      // vdmosload.c:80-85 — selfheat + Check_th.
      let Temp = this._temp;
      const selfheat = this._selfheat();
      let Check_th = selfheat ? 1 : 0;
      let Check_dio = 1;

      // vdmosload.c:50 — xfact predictor scale, function-local.
      let xfact = 0.0;

      let vgs: number, vds: number, delTemp: number;
      let vgd = 0, vgdo = 0;
      let delvgs = 0, delvds = 0, delvgd = 0, deldelTemp = 0;
      let cdhat = 0;
      let cdrain = 0;
      let bypassed = false;
      let capgs = 0.0, capgd = 0.0, capth = 0.0;
      let delTemp1 = 0.0;

      // ---- voltage recovery (vdmosload.c:92-277) ----
      if (mode & MODEINITSMSIG) {
        // vdmosload.c:92-95.
        vgs = s0[base + SLOT_VGS];
        vds = s0[base + SLOT_VDS];
        delTemp = s0[base + SLOT_DELTEMP];
      } else if (mode & MODEINITTRAN) {
        // vdmosload.c:96-99.
        vgs = s1[base + SLOT_VGS];
        vds = s1[base + SLOT_VDS];
        delTemp = s1[base + SLOT_DELTEMP];
      } else if ((mode & MODEINITJCT) && p.OFF === 0) {
        // vdmosload.c:100-114.
        vds = type * p.ICVDS;
        vgs = type * p.ICVGS;
        delTemp = 0.0;
        if (vds === 0.0 && vgs === 0.0 &&
            ((mode & (MODETRAN | MODEAC | MODEDCOP | MODEDCTRANCURVE)) !== 0 ||
             (mode & MODEUIC) === 0)) {
          vgs = type * p.VTH + 0.1;
          vds = 0.0;
        }
      } else if ((mode & (MODEINITJCT | MODEINITFIX)) && p.OFF !== 0) {
        // vdmosload.c:115-116.
        vgs = vds = delTemp = 0.0;
      } else {
        // vdmosload.c:128-167 — predictor / general iteration.
        if (mode & MODEINITPRED) {
          // vdmosload.c:131-148 — predictor step.
          xfact = ctx.dt / ctx.deltaOld[1];
          s0[base + SLOT_VGS] = s1[base + SLOT_VGS];
          vgs = (1 + xfact) * s1[base + SLOT_VGS] - xfact * s2[base + SLOT_VGS];
          s0[base + SLOT_VDS] = s1[base + SLOT_VDS];
          vds = (1 + xfact) * s1[base + SLOT_VDS] - xfact * s2[base + SLOT_VDS];
          s0[base + SLOT_DELTEMP] = s1[base + SLOT_DELTEMP];
          delTemp = (1 + xfact) * s1[base + SLOT_DELTEMP] - xfact * s2[base + SLOT_DELTEMP];
        } else {
          // vdmosload.c:155-164 — general iteration.
          vgs = type * (rhsOld[gPrime] - rhsOld[sPrime]);
          vds = type * (rhsOld[dPrime] - rhsOld[sPrime]);
          if (selfheat) delTemp = rhsOld[tempNode];
          else delTemp = 0.0;
        }

        // vdmosload.c:171-178 — common crunching.
        vgd = vgs - vds;
        vgdo = s0[base + SLOT_VGS] - s0[base + SLOT_VDS];
        delvgs = vgs - s0[base + SLOT_VGS];
        delvds = vds - s0[base + SLOT_VDS];
        delvgd = vgd - vgdo;
        deldelTemp = delTemp - s0[base + SLOT_DELTEMP];

        // vdmosload.c:182-194 — cdhat for convergence/bypass.
        if (this._mode >= 0) {
          cdhat = this._cd + this._gm * delvgs + this._gds * delvds + this._gmT * deldelTemp;
        } else {
          cdhat = this._cd - this._gm * delvgd + this._gds * delvds + this._gmT * deldelTemp;
        }

        // vdmosload.c:196-242 — bypass.
        if (
          !(mode & MODEINITPRED) &&
          ctx.bypass &&
          (Math.abs(delvgs) < (ctx.reltol * Math.max(Math.abs(vgs), Math.abs(s0[base + SLOT_VGS])) + ctx.voltTol)) &&
          (Math.abs(delvds) < (ctx.reltol * Math.max(Math.abs(vds), Math.abs(s0[base + SLOT_VDS])) + ctx.voltTol)) &&
          (Math.abs(cdhat - this._cd) < (ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(this._cd)) + ctx.iabstol)) &&
          ((tempNode === 0) ||
            (Math.abs(deldelTemp) < (ctx.reltol * Math.max(Math.abs(delTemp), Math.abs(s0[base + SLOT_DELTEMP])) + ctx.voltTol * 1e4)))
        ) {
          // vdmosload.c:225-240 — bypass code.
          vgs = s0[base + SLOT_VGS];
          vds = s0[base + SLOT_VDS];
          vgd = vgs - vds;
          delTemp = s0[base + SLOT_DELTEMP];
          cdrain = this._mode * this._cd;
          if (mode & (MODETRAN | MODETRANOP)) {
            capgs = s0[base + SLOT_CAPGS] + s1[base + SLOT_CAPGS];
            capgd = s0[base + SLOT_CAPGD] + s1[base + SLOT_CAPGD];
            capth = s0[base + SLOT_CAPTH] + s1[base + SLOT_CAPTH];
          }
          bypassed = true;
        }

        if (!bypassed) {
          // vdmosload.c:246 — von = type * VDMOSvon.
          let von = type * this._von;
          // vdmosload.c:256-275 — limiting.
          if (s0[base + SLOT_VDS] >= 0) {
            vgs = fetlim(vgs, s0[base + SLOT_VGS], von);
            vds = vgs - vgd;
            vds = limvds(vds, s0[base + SLOT_VDS]);
          } else {
            vgd = fetlim(vgd, vgdo, von);
            vds = vgs - vgd;
            if (!ctx.cktFixLimit) {
              vds = -limvds(-vds, -s0[base + SLOT_VDS]);
            }
            vgs = vgd + vds;
          }
          if (selfheat) {
            const ll = limitlog(delTemp, s0[base + SLOT_DELTEMP], 30);
            delTemp = ll.value;
            Check_th = ll.check;
          } else {
            delTemp = 0.0;
          }
          void von;
        }
      }

      // vdmosload.c:279-284 — self-heating temperature re-eval.
      if (selfheat) {
        Temp = this._temp + delTemp;
        this._tempUpdate(Temp);
      } else {
        Temp = this._temp;
      }

      // vdmosload.c:287-309 — self-heated Beta/rd scaling.
      let Beta: number, dBeta_dT: number, rd0T: number, rd1T: number;
      let drd0T_dT = 0, drd1T_dT = 0;
      if (selfheat) {
        const TempRatio = Temp / this._temp;
        Beta = this._tTransconductance * Math.pow(TempRatio, p.MU);
        dBeta_dT = Beta * p.MU / Temp;
        rd0T = this._drainResistance * Math.pow(TempRatio, p.TEXP0);
        drd0T_dT = rd0T * p.TEXP0 / Temp;
        rd1T = 0.0;
        drd1T_dT = 0.0;
        if (qsGiven) {
          rd1T = this._qsResistance * Math.pow(TempRatio, p.TEXP1);
          drd1T_dT = rd1T * p.TEXP1 / Temp;
        }
      } else {
        Beta = this._tTransconductance;
        dBeta_dT = 0.0;
        rd0T = this._drainResistance;
        drd0T_dT = 0.0;
        rd1T = 0.0;
        drd1T_dT = 0.0;
        if (qsGiven) rd1T = this._qsResistance;
      }

      // vdmosload.c:315 — vgd = vgs - vds.
      vgd = vgs - vds;

      // vdmosload.c:320-330 — mode + Vds/Vgs (saturation-positive convention).
      let Vds: number, Vgs: number;
      if (vds >= 0) {
        this._mode = 1;
        Vds = vds;
        Vgs = vgs;
      } else {
        this._mode = -1;
        Vds = -vds;
        Vgs = vgd;
      }

      // ---- drain-current model (vdmosload.c:332-381) §6e Directive 1 ----
      let dIds_dT = 0;
      {
        // vdmosload.c:341 — von = tVth * type.
        const von = this._tVth * type;
        let vgst = (this._mode === 1 ? vgs : vgd) - von;
        const vdsat = Math.max(vgst, 0);
        const slope = this._tksubthres;
        const lambda = p.LAMBDA;
        const theta = p.THETA;
        const shift = p.SUBSHIFT;
        const mtr = p.MTRIODE;

        // vdmosload.c:355-365.
        const vdss = vds * mtr * this._mode;
        const t0 = 1 + lambda * vds;
        const t1 = 1 + theta * vgs;
        const betap = Beta * t0 / t1;
        const dbetapdvgs = -Beta * theta * t0 / (t1 * t1);
        const dbetapdvds = Beta * lambda / t1;
        const dbetapdT = dBeta_dT * t0 / t1;

        const t2 = Math.exp((vgst - shift) / slope);
        vgst = slope * Math.log(1 + t2);
        const dvgstdvgs = t2 / (t2 + 1);

        if (vgst <= vdss) {
          // vdmosload.c:367-373 — saturation region.
          cdrain = betap * vgst * vgst * .5;
          this._gm = betap * vgst * dvgstdvgs + 0.5 * dbetapdvgs * vgst * vgst;
          this._gds = .5 * dbetapdvds * vgst * vgst;
          dIds_dT = dbetapdT * vgst * vgst * .5;
        } else {
          // vdmosload.c:374-380 — linear region.
          cdrain = betap * vdss * (vgst - .5 * vdss);
          this._gm = betap * vdss * dvgstdvgs + vdss * dbetapdvgs * (vgst - .5 * vdss);
          this._gds = vdss * dbetapdvds * (vgst - .5 * vdss) + betap * mtr * (vgst - .5 * vdss) - .5 * vdss * betap * mtr;
          dIds_dT = dbetapdT * vdss * (vgst - .5 * vdss);
        }

        // vdmosload.c:386-387 — polarity write-back.
        this._von = type * von;
        this._vdsat = type * vdsat;
      }

      // vdmosload.c:392 — cd.
      this._cd = this._mode * cdrain;

      // vdmosload.c:396-398 — save vgs/vds/delTemp.
      s0[base + SLOT_VGS] = vgs;
      s0[base + SLOT_VDS] = vds;
      s0[base + SLOT_DELTEMP] = delTemp;

      // vdmosload.c:406-424 — quasi-saturation.
      let dgdrain_dT = 0.0;
      if (qsGiven && this._mode === 1) {
        const vdsn = type * (rhsOld[dNode] - rhsOld[sNode]);
        const rd = rd0T + rd1T * (vdsn / (vdsn + Math.abs(p.VQ)));
        const drd_dT = drd0T_dT + drd1T_dT * (vdsn / (vdsn + Math.abs(p.VQ)));
        if (rd > 0) {
          this._drainConductance = 1 / rd + ctx.cktGmin;
          dgdrain_dT = -drd_dT / (rd * rd);
        } else {
          this._drainConductance = 1 / rd0T;
          dgdrain_dT = -drd0T_dT / (rd0T * rd0T);
        }
      } else {
        if (rd0T > 0) {
          this._drainConductance = 1 / rd0T;
          dgdrain_dT = -drd0T_dT / (rd0T * rd0T);
        }
      }

      // vdmosload.c:426-432 — GmT.
      let GmT: number;
      if (selfheat) {
        GmT = dIds_dT;
        this._gmT = GmT;
      } else {
        GmT = 0.0;
        this._gmT = 0.0;
      }

      // vdmosload.c:434-448 — self-heating power terms.
      let Vrd = 0.0, dIth_dVrd = 0.0, dIrd_dT = 0.0;
      if (selfheat) {
        this._gtempg = type * this._gm * Vds;
        this._gtempT = GmT * Vds;
        this._gtempd = type * (this._gds * Vds + cdrain);
        this._cth = cdrain * Vds
          - type * (this._gtempg * Vgs + this._gtempd * Vds)
          - this._gtempT * delTemp;
        Vrd = rhsOld[dNode] - rhsOld[dPrime];
        dIth_dVrd = this._drainConductance * Vrd;
        const dIrd_dgdrain = Vrd;
        dIrd_dT = dIrd_dgdrain * dgdrain_dT;
        this._cth += this._drainConductance * Vrd * Vrd - dIth_dVrd * Vrd - dIrd_dT * Vrd * delTemp;
      }

      // ---- gate caps via DevCapVDMOS (vdmosload.c:453-515) §6e Directive 3 ----
      if (mode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) {
        // vdmosload.c:465-468 — DevCapVDMOS returns half caps into state0.
        const halves = devCapVdmos(vgd, cgdmin, cgdmax, a, cgs);
        s0[base + SLOT_CAPGS] = halves.capgs;
        s0[base + SLOT_CAPGD] = halves.capgd;
        s0[base + SLOT_CAPTH] = p.CTHJ; // always constant.

        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = vgs1 - s1[base + SLOT_VDS];
        delTemp1 = s1[base + SLOT_DELTEMP];
        if (mode & (MODETRANOP | MODEINITSMSIG)) {
          // vdmosload.c:473-476 — double.
          capgs = 2 * s0[base + SLOT_CAPGS];
          capgd = 2 * s0[base + SLOT_CAPGD];
          capth = 2 * s0[base + SLOT_CAPTH];
        } else {
          // vdmosload.c:478-484 — add previous-step half.
          capgs = s0[base + SLOT_CAPGS] + s1[base + SLOT_CAPGS];
          capgd = s0[base + SLOT_CAPGD] + s1[base + SLOT_CAPGD];
          capth = s0[base + SLOT_CAPTH] + s1[base + SLOT_CAPTH];
        }

        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          // vdmosload.c:487-496 — predictor charge extrapolation.
          s0[base + SLOT_QGS] = (1 + xfact) * s1[base + SLOT_QGS] - xfact * s2[base + SLOT_QGS];
          s0[base + SLOT_QGD] = (1 + xfact) * s1[base + SLOT_QGD] - xfact * s2[base + SLOT_QGD];
          s0[base + SLOT_QTH] = (1 + xfact) * s1[base + SLOT_QTH] - xfact * s2[base + SLOT_QTH];
        } else {
          if (mode & MODETRAN) {
            // vdmosload.c:499-505 — incremental charge.
            s0[base + SLOT_QGS] = (vgs - vgs1) * capgs + s1[base + SLOT_QGS];
            s0[base + SLOT_QGD] = (vgd - vgd1) * capgd + s1[base + SLOT_QGD];
            s0[base + SLOT_QTH] = (delTemp - delTemp1) * capth + s1[base + SLOT_QTH];
          } else {
            // vdmosload.c:506-511 — TRANOP only: q = c*v.
            s0[base + SLOT_QGS] = vgs * capgs;
            s0[base + SLOT_QGD] = vgd * capgd;
            s0[base + SLOT_QTH] = delTemp * capth;
          }
        }
      }

      // vdmosload.c:516-554 — charge integration / companions. NOTE this block
      // runs regardless of bypass (it follows the `bypass:` label, vdmosload.c:517).
      let gcgs = 0, ceqgs = 0, gcgd = 0, ceqgd = 0, gcTt = 0.0, ceqqth = 0.0;
      if ((mode & MODEINITTRAN) || !(mode & MODETRAN)) {
        // vdmosload.c:519-530 — zero companions.
        gcgs = 0; ceqgs = 0; gcgd = 0; ceqgd = 0; gcTt = 0.0; ceqqth = 0.0;
      } else {
        // vdmosload.c:531-554.
        if (capgs === 0) s0[base + SLOT_CQGS] = 0;
        if (capgd === 0) s0[base + SLOT_CQGD] = 0;
        if (capth === 0) s0[base + SLOT_CQTH] = 0;
        const ag = ctx.ag;
        // gate-source cap companion.
        {
          const q0 = s0[base + SLOT_QGS];
          const ni = niIntegrate(ctx.method, ctx.order, capgs, ag, q0, s1[base + SLOT_QGS],
            [s2[base + SLOT_QGS], 0, 0, 0, 0], s1[base + SLOT_CQGS]);
          gcgs = ni.geq;
          ceqgs = ni.ceq;
          s0[base + SLOT_CQGS] = ni.ccap;
          // vdmosload.c:543-544 — ceqgs = ceqgs - gcgs*vgs + ag[0]*state0[qgs].
          ceqgs = ceqgs - gcgs * vgs + ag[0] * q0;
        }
        // gate-drain cap companion.
        {
          const q0 = s0[base + SLOT_QGD];
          const ni = niIntegrate(ctx.method, ctx.order, capgd, ag, q0, s1[base + SLOT_QGD],
            [s2[base + SLOT_QGD], 0, 0, 0, 0], s1[base + SLOT_CQGD]);
          gcgd = ni.geq;
          ceqgd = ni.ceq;
          s0[base + SLOT_CQGD] = ni.ccap;
          ceqgd = ceqgd - gcgd * vgd + ag[0] * q0;
        }
        if (selfheat) {
          const q0 = s0[base + SLOT_QTH];
          const ni = niIntegrate(ctx.method, ctx.order, capth, ag, q0, s1[base + SLOT_QTH],
            [s2[base + SLOT_QTH], 0, 0, 0, 0], s1[base + SLOT_CQTH]);
          gcTt = ni.geq;
          ceqqth = ni.ceq;
          s0[base + SLOT_CQTH] = ni.ccap;
          ceqqth = ceqqth - gcTt * delTemp + ag[0] * q0;
        }
      }

      // ---- MOS RHS + Y-matrix stamps (vdmosload.c:556-660) ----
      let GmT_load: number, gTtg: number, gTtdp: number, gTtt: number, gTtsp: number;
      if (selfheat) {
        if (this._mode >= 0) {
          GmT_load = type * this._gmT;
          gTtg = this._gtempg;
          gTtdp = this._gtempd;
          gTtt = this._gtempT;
          gTtsp = -(gTtg + gTtdp);
        } else {
          GmT_load = -type * this._gmT;
          gTtg = this._gtempg;
          gTtsp = this._gtempd;
          gTtt = this._gtempT;
          gTtdp = -(gTtg + gTtsp);
        }
      } else {
        GmT_load = 0.0; gTtg = 0.0; gTtdp = 0.0; gTtt = 0.0; gTtsp = 0.0;
      }

      let xnrm: number, xrev: number, cdreq: number;
      if (this._mode >= 0) {
        xnrm = 1; xrev = 0;
        cdreq = type * (cdrain - this._gds * vds - this._gm * vgs);
      } else {
        xnrm = 0; xrev = 1;
        cdreq = -type * (cdrain - this._gds * (-vds) - this._gm * vgd);
      }

      // vdmosload.c:594-606 — RHS loads.
      stampRHS(ctx.rhs, gPrime, -(type * (ceqgs + ceqgd)));
      stampRHS(ctx.rhs, dPrime, (-cdreq + type * ceqgd));
      stampRHS(ctx.rhs, sPrime, (cdreq + type * ceqgs));
      if (selfheat) {
        stampRHS(ctx.rhs, dNode, dIrd_dT * delTemp);
        stampRHS(ctx.rhs, dPrime, GmT_load * delTemp - dIrd_dT * delTemp);
        stampRHS(ctx.rhs, sPrime, -GmT_load * delTemp);
        stampRHS(ctx.rhs, tempNode, this._cth - ceqqth);
        let vCktTemp = ctx.temp - CONSTCtoK;
        if (mode & MODETRANOP) vCktTemp *= ctx.srcFact;
        stampRHS(ctx.rhs, vcktTbranch, vCktTemp);
      }

      // vdmosload.c:611-638 — Y matrix stamps.
      solver.stampElement(this._hDd, this._drainConductance + this._dsConductance);
      solver.stampElement(this._hGg, this._gateConductance);
      solver.stampElement(this._hSs, this._sourceConductance + this._dsConductance);
      solver.stampElement(this._hDPdp, this._drainConductance + this._gds + xrev * this._gm + gcgd);
      solver.stampElement(this._hSPsp, this._sourceConductance + this._gds + xnrm * this._gm + gcgs);
      solver.stampElement(this._hGPgp, this._gateConductance + (gcgd + gcgs));
      solver.stampElement(this._hGgp, -this._gateConductance);
      solver.stampElement(this._hDdp, -this._drainConductance);
      solver.stampElement(this._hGPg, -this._gateConductance);
      solver.stampElement(this._hGPdp, -gcgd);
      solver.stampElement(this._hGPsp, -gcgs);
      solver.stampElement(this._hSsp, -this._sourceConductance);
      solver.stampElement(this._hDPd, -this._drainConductance);
      solver.stampElement(this._hDPgp, (xnrm - xrev) * this._gm - gcgd);
      solver.stampElement(this._hDPsp, -this._gds - xnrm * this._gm);
      solver.stampElement(this._hSPgp, -(xnrm - xrev) * this._gm - gcgs);
      solver.stampElement(this._hSPs, -this._sourceConductance);
      solver.stampElement(this._hSPdp, -this._gds - xrev * this._gm);
      solver.stampElement(this._hDs, -this._dsConductance);
      solver.stampElement(this._hSd, -this._dsConductance);

      // vdmosload.c:640-660 — thermal Y stamps.
      if (selfheat) {
        solver.stampElement(this._hDtemp, dIrd_dT);
        solver.stampElement(this._hDPtemp, GmT_load - dIrd_dT);
        solver.stampElement(this._hSPtemp, -GmT_load);
        solver.stampElement(this._hGPtemp, 0.0);
        solver.stampElement(this._hTemptemp, -gTtt - dIrd_dT * Vrd + 1 / p.RTHJC + gcTt);
        solver.stampElement(this._hTempgp, -gTtg);
        solver.stampElement(this._hTempd, -dIth_dVrd);
        solver.stampElement(this._hTempdp, -gTtdp + dIth_dVrd);
        solver.stampElement(this._hTempsp, -gTtsp);
        solver.stampElement(this._hTemptcase, -1 / p.RTHJC);
        solver.stampElement(this._hTcasetemp, -1 / p.RTHJC);
        solver.stampElement(this._hTcasetcase, 1 / p.RTHJC + 1 / p.RTHCA);
        solver.stampElement(this._hTptp, 1 / p.RTHCA);
        solver.stampElement(this._hTptcase, -1 / p.RTHCA);
        solver.stampElement(this._hTcasetp, -1 / p.RTHCA);
        solver.stampElement(this._hCktTtp, 1.0);
        solver.stampElement(this._hTpcktT, 1.0);
      }

      // ---- body-diode sub-model (vdmosload.c:662-925) §6e Directive 2 ----
      const dio = this._loadBodyDiode(ctx, base, s0, s1, mode, Temp, delTemp,
        deldelTemp, selfheat);
      Check_dio = dio.checkDio;
      // vdmosload.c:837 — MODEINITSMSIG `continue` skips the convergence check.
      if (dio.smsigContinue) return;

      // vdmosload.c:863-866 — convergence flags (convTest fold, §6e D6).
      if (Check_th === 1 || Check_dio === 1) {
        ctx.noncon.value++;
      }
    }

    /**
     * Body-diode sub-model — port of vdmosload.c:662-925. Inlined diode with
     * its own state slots, temperature-corrected params, DEVpnjlim/DEVpred
     * handling, and self-heating coupling. §6e Directive 2: separate VDIO*
     * block, no fusion with the MOS stamps and no delegation to DiodeElement.
     */
    private _loadBodyDiode(
      ctx: LoadContext,
      base: number,
      s0: Float64Array,
      s1: Float64Array,
      mode: number,
      Temp: number,
      delTemp: number,
      deldelTemp: number,
      selfheat: boolean,
    ): { checkDio: number; smsigContinue: boolean } {
      const solver = ctx.solver;
      const rhsOld = ctx.rhsOld;

      // vdmosload.c:666-687.
      let vd: number, cd: number;
      let gd = 0, gdb = 0, gspr: number;
      let cdb = 0;
      let dIdio_dT = 0.0;
      let delvd = 0.0;
      let cdhat = 0.0;
      let Ith = 0.0, dIth_dT = 0.0, dIth_dVdio = 0.0;
      let vrs = 0.0, dIrs_dT = 0.0, dIth_dVrs = 0.0;
      let arg = 0.0, sarg = 0.0;
      let capd = 0.0, geq = 0.0, ceq = 0.0;

      gspr = this._tConductance;

      const vt = CONSTKoverQ * Temp;
      const vte = p.N * vt;
      const vtebrk = p.NBV * vt;
      const vbrknp = this._tBrkdwnV;

      // vdmosload.c:689 — Check_dio = 1.
      let checkDio = 1;

      let didLoadGoto = false;

      // vdmosload.c:690-765 — diode voltage recovery + limiting.
      if (mode & MODEINITSMSIG) {
        vd = s0[base + SLOT_VDIO_V];
      } else if (mode & MODEINITTRAN) {
        vd = s1[base + SLOT_VDIO_V];
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // VDIOinitCond — not exposed; ngspice's VDIOinitCond defaults 0.
        vd = 0;
      } else if (mode & MODEINITJCT) {
        vd = this._tVcrit;
      } else {
        if (mode & MODEINITPRED) {
          // vdmosload.c:701-711 — predictor copies + DEVpred.
          s0[base + SLOT_VDIO_V] = s1[base + SLOT_VDIO_V];
          const xfact = ctx.dt / ctx.deltaOld[1];
          // DEVpred(ckt, VDIOvoltage) = (1+xfact)*state1[vd] - xfact*state2[vd].
          const s2 = this._pool.states[2];
          vd = (1 + xfact) * s1[base + SLOT_VDIO_V] - xfact * s2[base + SLOT_VDIO_V];
          s0[base + SLOT_VDIO_I] = s1[base + SLOT_VDIO_I];
          s0[base + SLOT_VDIO_G] = s1[base + SLOT_VDIO_G];
          s0[base + SLOT_VDIO_DIDT] = s1[base + SLOT_VDIO_DIDT];
        } else {
          // vdmosload.c:713-714 — general iteration.
          vd = type * (rhsOld[dioPrime] - rhsOld[dNode]);
        }
        delvd = vd - s0[base + SLOT_VDIO_V];
        cdhat = s0[base + SLOT_VDIO_I] + s0[base + SLOT_VDIO_G] * delvd
          + s0[base + SLOT_VDIO_DIDT] * deldelTemp;

        // vdmosload.c:725-748 — bypass.
        let didBypass = false;
        if (!(mode & MODEINITPRED) && ctx.bypass) {
          let tol = ctx.voltTol + ctx.reltol * Math.max(Math.abs(vd), Math.abs(s0[base + SLOT_VDIO_V]));
          if (Math.abs(delvd) < tol) {
            tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(s0[base + SLOT_VDIO_I])) + ctx.iabstol;
            if (Math.abs(cdhat - s0[base + SLOT_VDIO_I]) < tol) {
              if ((tempNode === 0) ||
                  (Math.abs(deldelTemp) < (ctx.reltol * Math.max(Math.abs(delTemp), Math.abs(s0[base + SLOT_DELTEMP])) + ctx.voltTol * 1e4))) {
                vd = s0[base + SLOT_VDIO_V];
                cd = s0[base + SLOT_VDIO_I];
                gd = s0[base + SLOT_VDIO_G];
                dIdio_dT = s0[base + SLOT_VDIO_DIDT];
                didBypass = true;
                didLoadGoto = true;
              }
            }
          }
        }

        if (!didBypass) {
          // vdmosload.c:752-764 — limit new junction voltage.
          if (given.BV && (vd < Math.min(0, -vbrknp + 10 * vtebrk))) {
            let vdtemp = -(vd + vbrknp);
            const res = pnjlim(vdtemp, -(s0[base + SLOT_VDIO_V] + vbrknp), vtebrk, this._tVcrit);
            vdtemp = res.value;
            checkDio = res.limited ? 1 : 0;
            vd = -(vdtemp + vbrknp);
          } else {
            const res = pnjlim(vd, s0[base + SLOT_VDIO_V], vte, this._tVcrit);
            vd = res.value;
            checkDio = res.limited ? 1 : 0;
          }
        }
      }

      if (!didLoadGoto) {
        // vdmosload.c:770-796 — compute dc current and derivatives.
        if (vd >= -3 * vte) {
          // forward.
          const evd = Math.exp(vd / vte);
          cdb = this._tSatCur * (evd - 1);
          dIdio_dT = this._tSatCur_dT * (evd - 1) - this._tSatCur * vd * evd / (vte * Temp);
          gdb = this._tSatCur * evd / vte;
        } else if (!given.BV || vd >= -vbrknp) {
          // reverse.
          arg = 3 * vte / (vd * CONSTe);
          const arg3 = arg * arg * arg;
          const darg3_dT = 3 * arg3 / Temp;
          cdb = -this._tSatCur * (1 + arg3);
          dIdio_dT = -this._tSatCur_dT * (arg3 + 1) - this._tSatCur * darg3_dT;
          gdb = this._tSatCur * 3 * arg / vd;
        } else {
          // breakdown.
          const evrev = Math.exp(-(vbrknp + vd) / vtebrk);
          cdb = -this._tSatCur * evrev;
          dIdio_dT = this._tSatCur * (-vbrknp - vd) * evrev / vtebrk / Temp - this._tSatCur_dT * evrev;
          gdb = this._tSatCur * evrev / vtebrk;
        }

        // vdmosload.c:798-799.
        cd = cdb + ctx.cktGmin * vd;
        gd = gdb + ctx.cktGmin;

        // vdmosload.c:801-857 — charge storage.
        if ((mode & (MODEDCTRANCURVE | MODETRAN | MODEAC | MODEINITSMSIG)) ||
            ((mode & MODETRANOP) && (mode & MODEUIC))) {
          const czero = this._tJctCap;
          let deplcharge: number, deplcap: number;
          if (vd < this._tDepCap) {
            arg = 1 - vd / this._tJctPot;
            sarg = Math.exp(-this._tGradingCoeff * Math.log(arg));
            deplcharge = this._tJctPot * czero * (1 - arg * sarg) / (1 - this._tGradingCoeff);
            deplcap = czero * sarg;
          } else {
            const czof2 = czero / this._tF2;
            deplcharge = czero * this._tF1 + czof2 * (this._tF3 * (vd - this._tDepCap) +
              (this._tGradingCoeff / (this._tJctPot + this._tJctPot)) * (vd * vd - this._tDepCap * this._tDepCap));
            deplcap = czof2 * (this._tF3 + this._tGradingCoeff * vd / this._tJctPot);
          }
          const diffcharge = this._tTransitTime * cdb;
          s0[base + SLOT_VDIO_QCAP] = diffcharge + deplcharge;
          const diffcap = this._tTransitTime * gdb;
          capd = diffcap + deplcap;
          this._cap = capd;

          // vdmosload.c:832-856 — store small-signal / transient.
          if (!(mode & MODETRANOP) || !(mode & MODEUIC)) {
            if (mode & MODEINITSMSIG) {
              // vdmosload.c:835-837 — store capd then `continue` (skip the diode
              // state save, matrix load, and the device convergence check). The
              // continue propagates to load() via smsigContinue.
              s0[base + SLOT_VDIO_CCAP] = capd;
              return { checkDio, smsigContinue: true };
            }
            // transient analysis.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_VDIO_QCAP] = s0[base + SLOT_VDIO_QCAP];
            }
            const ag = ctx.ag;
            const s2 = this._pool.states[2];
            const ni = niIntegrate(ctx.method, ctx.order, capd, ag,
              s0[base + SLOT_VDIO_QCAP], s1[base + SLOT_VDIO_QCAP],
              [s2[base + SLOT_VDIO_QCAP], 0, 0, 0, 0], s1[base + SLOT_VDIO_CCAP]);
            geq = ni.geq;
            ceq = ni.ceq;
            void ceq;
            s0[base + SLOT_VDIO_CCAP] = ni.ccap;
            gd = gd + geq;
            cd = cd + s0[base + SLOT_VDIO_CCAP];
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_VDIO_CCAP] = s0[base + SLOT_VDIO_CCAP];
            }
          }
        }

        // vdmosload.c:863-866 — convergence flag handled by caller; Check_dio
        // is already set by the limiting block above.

        // vdmosload.c:868-871 — diode state save.
        s0[base + SLOT_VDIO_V] = vd;
        s0[base + SLOT_VDIO_I] = cd;
        s0[base + SLOT_VDIO_G] = gd;
        s0[base + SLOT_VDIO_DIDT] = dIdio_dT;
      } else {
        // Bypass path reloaded vd/cd/gd/dIdio_dT above; jump straight to load.
        vd = s0[base + SLOT_VDIO_V];
        cd = s0[base + SLOT_VDIO_I];
        gd = s0[base + SLOT_VDIO_G];
        dIdio_dT = s0[base + SLOT_VDIO_DIDT];
      }

      // vdmosload.c:876-889 — self-heating diode power terms.
      if (selfheat) {
        vrs = rhsOld[sNode] - rhsOld[dioPrime];
        Ith = vd * cd + vrs * vrs * gspr;
        dIth_dVdio = cd + vd * gd;
        dIth_dVrs = vrs * gspr;
        const dIrs_dgspr = vrs;
        dIrs_dT = dIrs_dgspr * this._tConductance_dT;
        const dIth_dIrs = vrs;
        dIth_dT = dIth_dIrs * dIrs_dT + dIdio_dT * vd;
      }

      // vdmosload.c:893-906 — diode RHS load.
      const cdeq = cd - gd * vd;
      if (type === 1) {
        stampRHS(ctx.rhs, dNode, cdeq);
        stampRHS(ctx.rhs, dioPrime, -cdeq);
      } else {
        stampRHS(ctx.rhs, dNode, -cdeq);
        stampRHS(ctx.rhs, dioPrime, cdeq);
      }
      if (selfheat) {
        stampRHS(ctx.rhs, dioPrime, dIdio_dT * delTemp - dIrs_dT * delTemp);
        stampRHS(ctx.rhs, dNode, -dIdio_dT * delTemp);
        stampRHS(ctx.rhs, sNode, dIrs_dT * delTemp);
        stampRHS(ctx.rhs, tempNode, Ith - type * dIth_dVdio * vd - dIth_dVrs * vrs - dIth_dT * delTemp);
      }

      // vdmosload.c:910-916 — diode + gspr matrix stamps.
      solver.stampElement(this._hSs, gspr);
      solver.stampElement(this._hDd, gd);
      solver.stampElement(this._hRPrp, gd + gspr);
      solver.stampElement(this._hSrp, -gspr);
      solver.stampElement(this._hDrp, -gd);
      solver.stampElement(this._hRPs, -gspr);
      solver.stampElement(this._hRPd, -gd);

      // vdmosload.c:917-925 — diode thermal Y stamps.
      if (selfheat) {
        solver.stampElement(this._htempS, -dIth_dVrs);
        solver.stampElement(this._hTempposPrime, -dIth_dVdio + dIth_dVrs);
        solver.stampElement(this._hTempd, dIth_dVdio);
        solver.stampElement(this._hTemptemp, -dIth_dT);
        solver.stampElement(this._hPosPrimetemp, dIdio_dT - dIrs_dT);
        solver.stampElement(this._hStemp, dIrs_dT);
        solver.stampElement(this._hDtemp, -dIdio_dT);
      }

      return { checkDio, smsigContinue: false };
    }

    // -----------------------------------------------------------------------
    // Part F — stampAc()
    // -----------------------------------------------------------------------
    stampAc(solver: SparseSolverStamp, omega: number, _ctx: LoadContext): void {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const selfheat = this._selfheat();

      // vdmosacld.c:39-65 — mode-dependent thermal coupling factors.
      let xnrm: number, xrev: number;
      if (this._mode < 0) { xnrm = 0; xrev = 1; } else { xnrm = 1; xrev = 0; }

      let GmT: number, cgT: number, cdT: number, cTt: number;
      let gTtt: number, gTtg: number, gTtdp: number, gTtsp: number;
      if (this._mode >= 0) {
        GmT = type * this._gmT;
        cgT = type * 0; // VDMOScgT — written nowhere in load(); ngspice value 0 here.
        cdT = type * 0; // VDMOScdT — likewise.
        cTt = p.CTHJ;
        gTtg = this._gtempg;
        gTtdp = this._gtempd;
        gTtt = this._gtempT;
        gTtsp = -(gTtg + gTtdp);
      } else {
        GmT = -type * this._gmT;
        cgT = -type * 0;
        cdT = -type * 0;
        cTt = -p.CTHJ;
        gTtg = -this._gtempg;
        gTtdp = -this._gtempd;
        gTtt = -this._gtempT;
        gTtsp = gTtg + gTtdp;
      }

      // vdmosacld.c:70-80 — cap admittances (2× doubling).
      const capgs = s0[base + SLOT_CAPGS] + s0[base + SLOT_CAPGS];
      const capgd = s0[base + SLOT_CAPGD] + s0[base + SLOT_CAPGD];
      const xgs = capgs * omega;
      const xgd = capgd * omega;
      const xcgT = cgT * omega;
      const xcdT = cdT * omega;
      const xcsT = -(cgT + cdT) * omega;
      const xcTt = cTt * omega;

      // vdmosacld.c:82-86 — body diode.
      const gspr = this._tConductance;
      const geq = s0[base + SLOT_VDIO_G];
      const xceq = s0[base + SLOT_VDIO_CCAP] * omega;

      // vdmosacld.c:91-97 — imaginary gate stamps.
      solver.stampElementImag(this._hGPgp, xgd + xgs);
      solver.stampElementImag(this._hDPdp, xgd);
      solver.stampElementImag(this._hSPsp, xgs);
      solver.stampElementImag(this._hGPdp, -xgd);
      solver.stampElementImag(this._hGPsp, -xgs);
      solver.stampElementImag(this._hDPgp, -xgd);
      solver.stampElementImag(this._hSPgp, -xgs);

      // vdmosacld.c:99-112 — real MOS conductance stamps.
      solver.stampElement(this._hDd, this._drainConductance);
      solver.stampElement(this._hSs, this._sourceConductance);
      solver.stampElement(this._hDPdp, this._drainConductance + this._gds + xrev * this._gm);
      solver.stampElement(this._hSPsp, this._sourceConductance + this._gds + xnrm * this._gm);
      solver.stampElement(this._hDdp, -this._drainConductance);
      solver.stampElement(this._hSsp, -this._sourceConductance);
      solver.stampElement(this._hDPd, -this._drainConductance);
      solver.stampElement(this._hDPgp, (xnrm - xrev) * this._gm);
      solver.stampElement(this._hDPsp, -this._gds - xnrm * this._gm);
      solver.stampElement(this._hSPgp, -(xnrm - xrev) * this._gm);
      solver.stampElement(this._hSPs, -this._sourceConductance);
      solver.stampElement(this._hSPdp, -this._gds - xrev * this._gm);

      // vdmosacld.c:114-117 — gate resistor.
      solver.stampElement(this._hGg, this._gateConductance);
      solver.stampElement(this._hGPgp, this._gateConductance);
      solver.stampElement(this._hGgp, -this._gateConductance);
      solver.stampElement(this._hGPg, -this._gateConductance);

      // vdmosacld.c:118-129 — body diode real + imag.
      solver.stampElement(this._hSs, gspr);
      solver.stampElement(this._hDd, geq);
      solver.stampElementImag(this._hDd, xceq);
      solver.stampElement(this._hRPrp, geq + gspr);
      solver.stampElementImag(this._hRPrp, xceq);
      solver.stampElement(this._hSrp, -gspr);
      solver.stampElement(this._hDrp, -geq);
      solver.stampElementImag(this._hDrp, -xceq);
      solver.stampElement(this._hRPs, -gspr);
      solver.stampElement(this._hRPd, -geq);
      solver.stampElementImag(this._hRPd, -xceq);

      // vdmosacld.c:130-152 — thermal stamps under selfheat.
      if (selfheat) {
        solver.stampElement(this._hDPtemp, GmT);
        solver.stampElement(this._hSPtemp, -GmT);
        solver.stampElement(this._hTemptemp, gTtt + 1 / p.RTHJC);
        solver.stampElement(this._hTempgp, gTtg);
        solver.stampElement(this._hTempdp, gTtdp);
        solver.stampElement(this._hTempsp, gTtsp);
        solver.stampElement(this._hTemptcase, -1 / p.RTHJC);
        solver.stampElement(this._hTcasetemp, -1 / p.RTHJC);
        solver.stampElement(this._hTcasetcase, 1 / p.RTHJC + 1 / p.RTHCA);
        solver.stampElement(this._hTptp, 1 / p.RTHCA);
        solver.stampElement(this._hTptcase, -1 / p.RTHCA);
        solver.stampElement(this._hTcasetp, -1 / p.RTHCA);
        solver.stampElement(this._hCktTtp, 1.0);
        solver.stampElement(this._hTpcktT, 1.0);
        solver.stampElementImag(this._hTemptemp, xcTt);
        solver.stampElementImag(this._hDPtemp, xcdT);
        solver.stampElementImag(this._hSPtemp, xcsT);
        solver.stampElementImag(this._hGPtemp, xcgT);
      }
    }

    // -----------------------------------------------------------------------
    // Part G — getLteTimestep()
    // -----------------------------------------------------------------------
    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      // vdmostrun.c:24-26 — CKTterr on VDMOSqgs, VDMOSqgd, VDIOcapCharge only.
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const s3 = this._pool.states[3];
      let minDt = Infinity;
      const pairs: [number, number][] = [
        [SLOT_QGS, SLOT_CQGS],
        [SLOT_QGD, SLOT_CQGD],
        [SLOT_VDIO_QCAP, SLOT_VDIO_CCAP],
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
      // pinLayout order: [G, S, D] (buildVdmos{N,P}PinDeclarations). Drain
      // current = type * cd (vdmosload.c:392); positive = into the element.
      const id = type * this._cd;
      return [0, -id, id];
    }

    setParam(key: string, value: number): void {
      if (key in p) {
        if (key === "TEMP") {
          // cite: vdmospar.c:34 — +CONSTCtoK.
          p.TEMP = value + CONSTCtoK;
          given.TEMP = true;
        } else if (key === "TNOM") {
          // cite: vdmosmpar.c:20 — +CONSTCtoK.
          p.TNOM = value + CONSTCtoK;
        } else {
          p[key] = value;
        }
        if (key === "RQ") given.RQ = true;
        else if (key === "VQ") given.VQ = true;
        else if (key === "RDS") given.RDS = true;
        else if (key === "RB") given.RB = true;
        else if (key === "TEXP0") given.TEXP0 = true;
        else if (key === "BV") given.BV = true;
        else if (key === "RTHJC") given.RTHJC = true;
        else if (key === "DTEMP") given.DTEMP = true;
        else if (key === "MJ") {
          // vdmosmpar.c:82-83 — setting mj zeroes gradCoeffTemp1/2.
          gradCoeffTemp1 = 0; gradCoeffTemp2 = 0;
        } else if (key === "TT") {
          // vdmosmpar.c:166-167 — setting tt zeroes tranTimeTemp1/2.
          tranTimeTemp1 = 0; tranTimeTemp2 = 0;
        }
        if (key === "M") this._m = value;
        qsGiven = given.RQ && given.VQ;
        this.computeTemperature(this._lastCtx);
      }
    }
  }

  return new VdmosAnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// Public factory entry points
// ---------------------------------------------------------------------------

export function createVdmosNElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createVdmosElementWithType(1, pinNodes, props);
}

export function createVdmosPElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number = () => 0,
): AnalogElement {
  void _getTime;
  return _createVdmosElementWithType(-1, pinNodes, props);
}

// ---------------------------------------------------------------------------
// getVdmosInternalNodeLabels (public helper for tests / registry consumers)
// ---------------------------------------------------------------------------

export function getVdmosInternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  if (props.getModelParam<number>("RD") > 0) labels.push("drain");
  if (props.getModelParam<number>("RG") > 0) labels.push("gate");
  if (props.getModelParam<number>("RS") > 0) labels.push("source");
  if (props.getModelParam<number>("RB") > 0) labels.push("body diode");
  if (props.getModelParam<number>("THERMAL") !== 0 && props.isModelParamGiven("RTHJC")) {
    labels.push("Tj", "Tc", "cktTemp");
  }
  return labels;
}

// ---------------------------------------------------------------------------
// VdmosNElement + VdmosPElement  CircuitElement (visual) implementations
// ---------------------------------------------------------------------------

function buildVdmosNPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function buildVdmosPPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

export class VdmosNElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VDMOSN", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVdmosNPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1.3125, width: 4, height: 2.625 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");
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
    ctx.drawLine(4, 1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);
    ctx.restore();
  }
}

export class VdmosPElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VDMOSP", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildVdmosPPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1.3125, width: 4.0, height: 2.625 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vD = signals?.getPinVoltage("D");
    const vG = signals?.getPinVoltage("G");
    const vS = signals?.getPinVoltage("S");
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    const chanX = 2.625;
    const gateBarX = 2.25;
    drawColoredLead(ctx, signals, vD, 4, 1, chanX, 1);
    drawColoredLead(ctx, signals, vS, 4, -1, chanX, -1);
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

const VDMOS_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const VDMOS_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Part I — Component definitions (registered in register-all.ts)
// ---------------------------------------------------------------------------

function vdmosNCircuitFactory(props: PropertyBag): VdmosNElement {
  return new VdmosNElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function vdmosPCircuitFactory(props: PropertyBag): VdmosPElement {
  return new VdmosPElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VdmosNDefinition: StandaloneComponentDefinition = {
  name: "VDMOSN",
  typeId: -1,
  factory: vdmosNCircuitFactory,
  pinLayout: buildVdmosNPinDeclarations(),
  propertyDefs: VDMOS_PROPERTY_DEFS,
  attributeMap: VDMOS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel VDMOS  LTspice-compatible vertical power MOSFET (ngspice v41).\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Drain-current core with subthreshold/mtr/quasi-saturation, DevCapVDMOS gate\n" +
    "caps, an inlined body diode with breakdown, and an optional self-heating\n" +
    "thermal network (thermal=1 with rthjc/rthca/cthj).",
  models: {},
  modelRegistry: {
    "spice-vdmos": {
      kind: "inline",
      factory: createVdmosNElement,
      paramDefs: VDMOS_N_PARAM_DEFS,
      params: VDMOS_N_DEFAULTS,
    },
  },
  defaultModel: "spice-vdmos",
};

export const VdmosPDefinition: StandaloneComponentDefinition = {
  name: "VDMOSP",
  typeId: -1,
  factory: vdmosPCircuitFactory,
  pinLayout: buildVdmosPPinDeclarations(),
  propertyDefs: VDMOS_PROPERTY_DEFS,
  attributeMap: VDMOS_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel VDMOS  LTspice-compatible vertical power MOSFET (ngspice v41).\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Drain-current core with subthreshold/mtr/quasi-saturation, DevCapVDMOS gate\n" +
    "caps, an inlined body diode with breakdown, and an optional self-heating\n" +
    "thermal network (thermal=1 with rthjc/rthca/cthj).",
  models: {},
  modelRegistry: {
    "spice-vdmos": {
      kind: "inline",
      factory: createVdmosPElement,
      paramDefs: VDMOS_P_PARAM_DEFS,
      params: VDMOS_P_DEFAULTS,
    },
  },
  defaultModel: "spice-vdmos",
};
