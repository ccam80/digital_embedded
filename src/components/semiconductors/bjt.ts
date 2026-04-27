/**
 * BJT analog components â€” NPN and PNP bipolar junction transistors.
 *
 * Simple L0 and SPICE L1 (Gummel-Poon) models ported mechanically from
 * `ref/ngspice/src/spicelib/devices/bjt/bjtload.c::BJTload`. Single-pass load()
 * per device per NR iteration. No cached `Float64Array` references to `pool.states[N]` â€” every state
 * access reads through `pool.states[0..3]` at call time (matches ngspice's
 * `CKTstate0`/`CKTstate1` pointer semantics).
 *
 * PNP is implemented as the NPN model with polarity = -1 per ngspice
 * BJTtype (bjtdefs.h); all junction voltages and currents are polarity-signed.
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
  type AnalogFactory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { IntegrationMethod, LoadContext, PoolBackedAnalogElementCore } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG, MODEINITTRAN, MODEINITPRED,
  MODETRAN, MODEAC, MODETRANOP, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, deviceParams } from "../../core/model-params.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (CKTgmin). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-16,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
    NE:  { default: 1.5,    description: "B-E leakage emission coefficient" },
    NC:  { default: 2,      description: "B-C leakage emission coefficient" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
    OFF:   { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    ICVBE: { default: NaN,  unit: "V",  description: "Initial condition: B-E voltage for UIC" },
    ICVCE: { default: NaN,  unit: "V",  description: "Initial condition: C-E voltage for UIC" },
  },
});

export const { defaults: BJT_PNP_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-16,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
    NE:  { default: 1.5,    description: "B-E leakage emission coefficient" },
    NC:  { default: 2,      description: "B-C leakage emission coefficient" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
    OFF:   { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    ICVBE: { default: NaN,  unit: "V",  description: "Initial condition: B-E voltage for UIC" },
    ICVCE: { default: NaN,  unit: "V",  description: "Initial condition: C-E voltage for UIC" },
  },
});

// ---------------------------------------------------------------------------
// SPICE Level 1 model parameter declarations (superset of simple params)
// ---------------------------------------------------------------------------

export const { paramDefs: BJT_SPICE_L1_PARAM_DEFS, defaults: BJT_SPICE_L1_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-16,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
    NE:  { default: 1.5,    description: "B-E leakage emission coefficient" },
    NC:  { default: 2,      description: "B-C leakage emission coefficient" },
    RB:  { default: 0,      unit: "Î©", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Î©", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Î©", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Î©", description: "Emitter resistance" },
    CJE: { default: 0,      unit: "F", description: "B-E zero-bias junction capacitance" },
    VJE: { default: 0.75,   unit: "V", description: "B-E built-in potential" },
    MJE: { default: 0.33,   description: "B-E grading coefficient" },
    CJC: { default: 0,      unit: "F", description: "B-C zero-bias junction capacitance" },
    VJC: { default: 0.75,   unit: "V", description: "B-C built-in potential" },
    MJC: { default: 0.33,   description: "B-C grading coefficient" },
    XCJC: { default: 1,     description: "Fraction of B-C capacitance connected to internal base" },
    FC:  { default: 0.5,    description: "Forward-bias capacitance coefficient" },
    TF:  { default: 0,      unit: "s", description: "Forward transit time" },
    XTF: { default: 0,      description: "Transit time bias dependence coefficient" },
    VTF: { default: Infinity, unit: "V", description: "Transit time dependency on Vbc" },
    ITF: { default: 0,      unit: "A", description: "Transit time dependency on Ic" },
    PTF: { default: 0,      unit: "Â°", description: "Excess phase at freq=1/(2Ï€Â·TF)" },
    TR:  { default: 0,      unit: "s", description: "Reverse transit time" },
    CJS: { default: 0,      unit: "F", description: "Collector-substrate zero-bias capacitance" },
    VJS: { default: 0.75,   unit: "V", description: "Substrate junction built-in potential" },
    MJS: { default: 0,      description: "Substrate junction exponential factor" },
    ISS: { default: 0,      unit: "A", description: "Substrate saturation current" },
    NS:  { default: 1,      description: "Substrate emission coefficient" },
    XTB: { default: 0,      description: "Forward/reverse beta temperature exponent" },
    EG:  { default: 1.11,   unit: "eV", description: "Energy gap for temperature effect on IS" },
    XTI: { default: 3,      description: "Saturation current temperature exponent" },
    KF:  { default: 0,      description: "Flicker noise coefficient" },
    AF:  { default: 1,      description: "Flicker noise exponent" },
    NKF: { default: 0.5,    description: "High-injection roll-off exponent" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    AREAB: { default: 1,    description: "Base-area factor" },
    AREAC: { default: 1,    description: "Collector-area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
    OFF:   { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    ICVBE: { default: NaN,  unit: "V",  description: "Initial condition: B-E voltage for UIC" },
    ICVCE: { default: NaN,  unit: "V",  description: "Initial condition: C-E voltage for UIC" },
  },
});

export const { defaults: BJT_SPICE_L1_PNP_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-16,  unit: "A", description: "Saturation current" },
  },
  secondary: {
    NF:  { default: 1,      description: "Forward emission coefficient" },
    BR:  { default: 1,      description: "Reverse current gain" },
    VAF: { default: Infinity, unit: "V", description: "Forward Early voltage" },
    IKF: { default: Infinity, unit: "A", description: "Forward knee current" },
    IKR: { default: Infinity, unit: "A", description: "Reverse knee current" },
    ISE: { default: 0,      unit: "A", description: "B-E leakage saturation current" },
    ISC: { default: 0,      unit: "A", description: "B-C leakage saturation current" },
    NR:  { default: 1,      description: "Reverse emission coefficient" },
    VAR: { default: Infinity, unit: "V", description: "Reverse Early voltage" },
    NE:  { default: 1.5,    description: "B-E leakage emission coefficient" },
    NC:  { default: 2,      description: "B-C leakage emission coefficient" },
    RB:  { default: 0,      unit: "Î©", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Î©", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Î©", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Î©", description: "Emitter resistance" },
    CJE: { default: 0,      unit: "F", description: "B-E zero-bias junction capacitance" },
    VJE: { default: 0.75,   unit: "V", description: "B-E built-in potential" },
    MJE: { default: 0.33,   description: "B-E grading coefficient" },
    CJC: { default: 0,      unit: "F", description: "B-C zero-bias junction capacitance" },
    VJC: { default: 0.75,   unit: "V", description: "B-C built-in potential" },
    MJC: { default: 0.33,   description: "B-C grading coefficient" },
    XCJC: { default: 1,     description: "Fraction of B-C capacitance connected to internal base" },
    FC:  { default: 0.5,    description: "Forward-bias capacitance coefficient" },
    TF:  { default: 0,      unit: "s", description: "Forward transit time" },
    XTF: { default: 0,      description: "Transit time bias dependence coefficient" },
    VTF: { default: Infinity, unit: "V", description: "Transit time dependency on Vbc" },
    ITF: { default: 0,      unit: "A", description: "Transit time dependency on Ic" },
    PTF: { default: 0,      unit: "Â°", description: "Excess phase at freq=1/(2Ï€Â·TF)" },
    TR:  { default: 0,      unit: "s", description: "Reverse transit time" },
    CJS: { default: 0,      unit: "F", description: "Collector-substrate zero-bias capacitance" },
    VJS: { default: 0.75,   unit: "V", description: "Substrate junction built-in potential" },
    MJS: { default: 0,      description: "Substrate junction exponential factor" },
    ISS: { default: 0,      unit: "A", description: "Substrate saturation current" },
    NS:  { default: 1,      description: "Substrate emission coefficient" },
    XTB: { default: 0,      description: "Forward/reverse beta temperature exponent" },
    EG:  { default: 1.11,   unit: "eV", description: "Energy gap for temperature effect on IS" },
    XTI: { default: 3,      description: "Saturation current temperature exponent" },
    KF:  { default: 0,      description: "Flicker noise coefficient" },
    AF:  { default: 1,      description: "Flicker noise exponent" },
    NKF: { default: 0.5,    description: "High-injection roll-off exponent" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    AREAB: { default: 1,    description: "Base-area factor" },
    AREAC: { default: 1,    description: "Collector-area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" },
    OFF:   { default: 0, emit: "flag",   description: "Initial condition: device off (0=false, 1=true)" },
    ICVBE: { default: NaN,  unit: "V",  description: "Initial condition: B-E voltage for UIC" },
    ICVCE: { default: NaN,  unit: "V",  description: "Initial condition: C-E voltage for UIC" },
  },
});

// ---------------------------------------------------------------------------
// Built-in NPN model presets (Fairchild/Philips/NXP extracted)
// ---------------------------------------------------------------------------

const NPN_2N3904 = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 6.734e-15, BF: 416.4, NF: 1.0, BR: 0.7371, NR: 1.0,
  VAF: 74.03, IKF: 0.06678, IKR: 0, ISE: 6.734e-15, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 2.65e-11, VJE: 0.65, MJE: 0.33, CJC: 3.59e-12, VJC: 0.75, MJC: 0.33,
  TF: 3.97e-10, TR: 5e-8, FC: 0.5,
});

const NPN_BC547B = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 2.39e-14, BF: 294.3, NF: 1.008, BR: 7.946, NR: 1.004,
  VAF: 63.2, IKF: 0.1357, IKR: 0.1144, ISE: 3.545e-15, ISC: 6.272e-14, VAR: 25.9,
  RB: 10, RC: 1, RE: 0, NE: 1.48, NC: 2,
  CJE: 1.12e-11, VJE: 0.72, MJE: 0.33, CJC: 4.43e-12, VJC: 0.72, MJC: 0.33,
  TF: 4.26e-10, TR: 5e-8, FC: 0.5,
});

const NPN_2N2222A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 2.24e-11, VJE: 0.75, MJE: 0.33, CJC: 7.31e-12, VJC: 0.75, MJC: 0.33,
  TF: 4.11e-10, TR: 4.6e-8, FC: 0.5,
});

const NPN_2N2219A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
});

// ---------------------------------------------------------------------------
// Built-in PNP model presets
// ---------------------------------------------------------------------------

const PNP_2N3906 = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 1.41e-15, BF: 180.7, NF: 1.0, BR: 4.977, NR: 1.0,
  VAF: 18.7, IKF: 0.08, IKR: 0, ISE: 0, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 4.49e-12, VJE: 0.66, MJE: 0.33, CJC: 1.95e-11, VJC: 0.75, MJC: 0.33,
  TF: 1e-9, TR: 1e-7, FC: 0.5,
});

const PNP_BC557B = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 3.83e-14, BF: 344.4, NF: 1.008, BR: 14.84, NR: 1.005,
  VAF: 21.11, IKF: 0.08039, IKR: 0.047, ISE: 1.22e-14, ISC: 2.85e-13, VAR: 32.02,
});

const PNP_2N2907A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 650.6e-18, BF: 231.7, NF: 1.0, BR: 3.563, NR: 1.0,
  VAF: 115.7, IKF: 1.079, IKR: 0, ISE: 54.81e-15, ISC: 0, VAR: 100,
});

const PNP_TIP32C = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 1.8111e-12, BF: 526.98, NF: 1.0, BR: 1.1294, NR: 1.0,
  VAF: 100, IKF: 0.95034, IKR: 0.15869, ISE: 68.670e-12, ISC: 409.26e-9, VAR: 100,
});

// ---------------------------------------------------------------------------
// Temperature / area scaling â€” maps to bjttemp.c:158-257
// ---------------------------------------------------------------------------

interface BjtTempParams {
  vt: number;
  tSatCur: number;
  tBetaF: number;
  tBetaR: number;
  tBEleakCur: number;
  tBCleakCur: number;
  tinvRollOffF: number;
  tinvRollOffR: number;
  tinvEarlyVoltF: number;
  tinvEarlyVoltR: number;
  tcollectorConduct: number;
  temitterConduct: number;
  tbaseResist: number;
  tminBaseResist: number;
  tbaseCurrentHalfResist: number;
  tBEcap: number;
  tBEpot: number;
  tBCcap: number;
  tBCpot: number;
  tDepCap: number;
  tf1: number;
  f2: number;
  f3: number;
  tf4: number;
  tf5: number;
  f6: number;
  f7: number;
  tVcrit: number;
  tSubcap: number;
  tSubpot: number;
  tSubSatCur: number;
  tSubVcrit: number;
  ttransitTimeF: number;
  ttransitTimeR: number;
  tjunctionExpBE: number;
  tjunctionExpBC: number;
  tjunctionExpSub: number;
  excessPhaseFactor: number;
}

function computeBjtTempParams(p: {
  IS: number; BF: number; BR: number; ISE: number; ISC: number;
  NE: number; NC: number; EG: number; XTI: number; XTB: number;
  IKF: number; IKR: number; RC: number; RE: number; RB: number; RBM: number;
  IRB: number; CJE: number; VJE: number; MJE: number;
  CJC: number; VJC: number; MJC: number; CJS: number; VJS: number; MJS: number;
  FC: number; AREA: number; TNOM: number;
  VAF: number; VAR: number;
  PTF: number; TF: number; TR: number;
  ISS: number; TEMP: number;
}, T: number): BjtTempParams {
  const REFTEMP = 300.15;
  const k = 1.3806226e-23;
  const q_charge = 1.6021918e-19;
  const KoverQ = k / q_charge;

  const vt = T * KoverQ;
  const fact1 = p.TNOM / REFTEMP;
  const fact2 = T / REFTEMP;
  const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
  const arg = -egfet / (2 * k * T) + 1.1150877 / (k * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + q_charge * arg);

  const ratlog = Math.log(T / p.TNOM);
  const ratio1 = T / p.TNOM - 1;
  const factlog = ratio1 * p.EG / vt + p.XTI * ratlog;
  const factor = Math.exp(factlog);

  const tSatCur = p.IS * factor;
  const bfactor = Math.exp(ratlog * p.XTB);
  const tBetaF = p.BF * bfactor;
  const tBetaR = p.BR * bfactor;
  const tBEleakCur = p.ISE > 0 ? p.ISE * Math.exp(factlog / p.NE) / bfactor : 0;
  const tBCleakCur = p.ISC > 0 ? p.ISC * Math.exp(factlog / p.NC) / bfactor : 0;

  const tinvRollOffF = p.IKF > 0 && isFinite(p.IKF) ? 1 / p.IKF : 0;
  const tinvRollOffR = p.IKR > 0 && isFinite(p.IKR) ? 1 / p.IKR : 0;

  const tinvEarlyVoltF = (p.VAF > 0 && isFinite(p.VAF)) ? 1 / p.VAF : 0;
  const tinvEarlyVoltR = (p.VAR > 0 && isFinite(p.VAR)) ? 1 / p.VAR : 0;

  const tcollectorConduct = p.RC > 0 ? 1 / p.RC : 0;
  const temitterConduct = p.RE > 0 ? 1 / p.RE : 0;
  const tbaseResist = p.RB;
  const tminBaseResist = p.RBM > 0 ? p.RBM : p.RB;
  const tbaseCurrentHalfResist = p.IRB;

  const xfc = Math.log(1 - p.FC);

  const pbo_be = (p.VJE - pbfact) / fact1;
  const gmaold_be = (p.VJE - pbo_be) / pbo_be;
  let tBEcap = p.CJE / (1 + p.MJE * (4e-4 * (p.TNOM - REFTEMP) - gmaold_be));
  const tBEpot = fact2 * pbo_be + pbfact;
  const gmanew_be = (tBEpot - pbo_be) / pbo_be;
  tBEcap *= 1 + p.MJE * (4e-4 * (T - REFTEMP) - gmanew_be);

  const pbo_bc = (p.VJC - pbfact) / fact1;
  const gmaold_bc = (p.VJC - pbo_bc) / pbo_bc;
  let tBCcap = p.CJC / (1 + p.MJC * (4e-4 * (p.TNOM - REFTEMP) - gmaold_bc));
  const tBCpot = fact2 * pbo_bc + pbfact;
  const gmanew_bc = (tBCpot - pbo_bc) / pbo_bc;
  tBCcap *= 1 + p.MJC * (4e-4 * (T - REFTEMP) - gmanew_bc);

  let tSubcap: number;
  let tSubpot: number;
  if (p.CJS > 0 && p.VJS > 0) {
    const pbo_sub = (p.VJS - pbfact) / fact1;
    const gmaold_sub = (p.VJS - pbo_sub) / pbo_sub;
    tSubcap = p.CJS / (1 + p.MJS * (4e-4 * (p.TNOM - REFTEMP) - gmaold_sub));
    tSubpot = fact2 * pbo_sub + pbfact;
    const gmanew_sub = (tSubpot - pbo_sub) / pbo_sub;
    tSubcap *= 1 + p.MJS * (4e-4 * (T - REFTEMP) - gmanew_sub);
  } else {
    tSubcap = p.CJS;
    tSubpot = p.VJS;
  }

  const tSubSatCur = p.ISS * factor;

  const tDepCap = p.FC * tBEpot;
  const tf1 = tBEpot * (1 - Math.exp((1 - p.MJE) * xfc)) / (1 - p.MJE);
  const f2 = Math.exp((1 + p.MJE) * xfc);
  const f3 = 1 - p.FC * (1 + p.MJE);
  const tf4 = p.FC * tBCpot;
  const tf5 = tBCpot * (1 - Math.exp((1 - p.MJC) * xfc)) / (1 - p.MJC);
  const f6 = Math.exp((1 + p.MJC) * xfc);
  const f7 = 1 - p.FC * (1 + p.MJC);

  const tVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCur * p.AREA));
  const tSubVcrit = tSubSatCur > 0 ? vt * Math.log(vt / (Math.SQRT2 * tSubSatCur * p.AREA)) : Infinity;

  const ttransitTimeF = p.TF;
  const ttransitTimeR = p.TR;
  const tjunctionExpBE = p.MJE;
  const tjunctionExpBC = p.MJC;
  const tjunctionExpSub = p.MJS;

  const excessPhaseFactor = (p.PTF > 0 && p.TF > 0) ? (p.PTF / (180 / Math.PI)) * p.TF : 0;

  return {
    vt, tSatCur, tBetaF, tBetaR, tBEleakCur, tBCleakCur,
    tinvRollOffF, tinvRollOffR, tinvEarlyVoltF, tinvEarlyVoltR,
    tcollectorConduct, temitterConduct,
    tbaseResist, tminBaseResist, tbaseCurrentHalfResist,
    tBEcap, tBEpot, tBCcap, tBCpot, tDepCap, tf1, f2, f3, tf4, tf5, f6, f7,
    tVcrit, tSubVcrit, tSubcap, tSubpot, tSubSatCur,
    ttransitTimeF, ttransitTimeR, tjunctionExpBE, tjunctionExpBC, tjunctionExpSub,
    excessPhaseFactor,
  };
}

// Gummel-Poon evaluation lives inline in each load() body, mirroring ngspice
// bjtload.c:420-560 line-for-line. ngspice has no helper for this block; a
// helper would re-introduce the structural seam that caused the doubled-cc
// bug (op.cc returned by helper + `cc = cc + (cex-cbc)/qb - ...` in caller).

// ---------------------------------------------------------------------------
// State schema â€” BJT simple (L0). Matches bjtdefs.h offsets for the subset
// of slots we track. VBE=0, VBC=1 line up with BJTvbe=0, BJTvbc=1.
// ---------------------------------------------------------------------------

export const BJT_SIMPLE_SCHEMA: StateSchema = defineStateSchema("BjtSimpleElement", [
  { name: "VBE", doc: "bjtdefs.h BJTvbe", init: { kind: "fromParams", compute: (_p) => _p["polarity"] === 1 ? 0.6 : -0.6 } },
  { name: "VBC", doc: "bjtdefs.h BJTvbc", init: { kind: "zero" } },
  { name: "CC",  doc: "bjtdefs.h BJTcc (collector current)",  init: { kind: "zero" } },
  { name: "CB",  doc: "bjtdefs.h BJTcb (base current)",       init: { kind: "zero" } },
  { name: "GPI", doc: "bjtdefs.h BJTgpi", init: { kind: "zero" } },
  { name: "GMU", doc: "bjtdefs.h BJTgmu", init: { kind: "zero" } },
  { name: "GM",  doc: "bjtdefs.h BJTgm",  init: { kind: "zero" } },
  { name: "GO",  doc: "bjtdefs.h BJTgo",  init: { kind: "zero" } },
  { name: "GX",  doc: "bjtdefs.h BJTgx=16 (base-resistance cond); L0 always 0 â€” no RB", init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createBjtElement â€” Simple L0 (resistive) factory.
// Single load() mirroring bjtload.c without cap/transit-time handling.
// No cached Float64Array state refs â€” pool.states[N] read at call time.
// ---------------------------------------------------------------------------

export function createBjtElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  _branchIdx: number,
  props: PropertyBag,
) {
  const nodeB = pinNodes.get("B")!;
  const nodeC = pinNodes.get("C")!;
  const nodeE = pinNodes.get("E")!;

  const params: Record<string, number> = {
    IS: props.getModelParam<number>("IS"),
    BF: props.getModelParam<number>("BF"),
    NF: props.getModelParam<number>("NF"),
    BR: props.getModelParam<number>("BR"),
    NR: props.getModelParam<number>("NR"),
    ISE: props.getModelParam<number>("ISE"),
    ISC: props.getModelParam<number>("ISC"),
    VAF: props.getModelParam<number>("VAF"),
    VAR: props.getModelParam<number>("VAR"),
    IKF: props.getModelParam<number>("IKF"),
    IKR: props.getModelParam<number>("IKR"),
    NE: props.getModelParam<number>("NE"),
    NC: props.getModelParam<number>("NC"),
    AREA: props.getModelParam<number>("AREA"),
    M: props.getModelParam<number>("M"),
    TNOM: props.getModelParam<number>("TNOM"),
    TEMP: props.getModelParam<number>("TEMP"),
    OFF: props.getModelParam<number>("OFF"),
    ICVBE: props.getModelParam<number>("ICVBE"),
    ICVCE: props.getModelParam<number>("ICVCE"),
  };

  function makeTp(): BjtTempParams {
    return computeBjtTempParams({
      IS: params.IS, BF: params.BF, BR: params.BR,
      ISE: params.ISE, ISC: params.ISC,
      NE: params.NE, NC: params.NC, EG: 1.11, XTI: 3, XTB: 0,
      IKF: params.IKF, IKR: params.IKR,
      RC: 0, RE: 0, RB: 0, RBM: 0, IRB: 0,
      CJE: 0, VJE: 0.75, MJE: 0.33,
      CJC: 0, VJC: 0.75, MJC: 0.33,
      CJS: 0, VJS: 0.75, MJS: 0,
      FC: 0.5, AREA: params.AREA, TNOM: params.TNOM,
      VAF: params.VAF, VAR: params.VAR,
      PTF: 0, TF: 0, TR: 0,
      ISS: 0, TEMP: params.TEMP,
    }, params.TEMP);
  }
  let tp = makeTp();

  // Slot indices (mirror bjtdefs.h where applicable).
  const SLOT_VBE = 0;
  const SLOT_VBC = 1;
  const SLOT_CC  = 2;
  const SLOT_CB  = 3;
  const SLOT_GPI = 4;
  const SLOT_GMU = 5;
  const SLOT_GM  = 6;
  const SLOT_GO  = 7;
  const SLOT_GX  = 8; // bjtdefs.h BJTgx=16; L0 always writes 0 (bjtload.c:780)

  // Pool binding â€” only the pool reference is retained. Individual state
  // arrays are NOT cached as member variables: every access inside load()
  // reads pool.states[N] at call time. Mirrors ngspice CKTstate0/1/2/3
  // pointer access (bjtload.c never caches state pointers on devices).
  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration icheck flag (bjtload.c:405,749-754 CKTnoncon bump).
  let icheckLimited = false;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.BJT,
    isNonlinear: true,
    isReactive: false as const,
    poolBacked: true as const,
    stateSchema: BJT_SIMPLE_SCHEMA,
    stateSize: BJT_SIMPLE_SCHEMA.size,
    stateBaseOffset: -1,
    s0: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s1: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s2: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s3: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s4: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s5: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s6: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s7: new Float64Array(0) as Float64Array<ArrayBufferLike>,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      this.s0 = poolRef.state0 as Float64Array<ArrayBufferLike>; this.s1 = poolRef.state1 as Float64Array<ArrayBufferLike>; this.s2 = poolRef.state2 as Float64Array<ArrayBufferLike>; this.s3 = poolRef.state3 as Float64Array<ArrayBufferLike>;
      this.s4 = poolRef.state4 as Float64Array<ArrayBufferLike>; this.s5 = poolRef.state5 as Float64Array<ArrayBufferLike>; this.s6 = poolRef.state6 as Float64Array<ArrayBufferLike>; this.s7 = poolRef.state7 as Float64Array<ArrayBufferLike>;
      applyInitialValues(BJT_SIMPLE_SCHEMA, pool, base, { polarity });
    },

    /**
     * Single-pass load mirroring bjtload.c::BJTload for the resistive subset
     * (no caps, no transit time, no excess phase, no substrate, no terminal
     * resistances). L0 is the direct dc-op of the Gummel-Poon equations.
     */
    load(this: PoolBackedAnalogElementCore, ctx: LoadContext): void {
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const mode = ctx.cktMode;
      const voltages = ctx.rhsOld;

      // bjtload.c:236-322: linearization voltage dispatch per cktMode.
      let vbeRaw: number;
      let vbcRaw: number;

      if (mode & MODEINITSMSIG) {
        // bjtload.c:236-244: seed from CKTstate0.
        vbeRaw = s0[base + SLOT_VBE];
        vbcRaw = s0[base + SLOT_VBC];
      } else if (mode & MODEINITTRAN) {
        // bjtload.c:245-257: seed from CKTstate1 for transient init.
        vbeRaw = s1[base + SLOT_VBE];
        vbcRaw = s1[base + SLOT_VBC];
        // cite: bjtload.c:236-257 â€” MODEINITTRAN seeds state1 from the initial voltage read
        // so subsequent NIintegrate history has a valid t=0 prior value.
        s1[base + SLOT_VBE] = vbeRaw;
        s1[base + SLOT_VBC] = vbcRaw;
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // cite: bjtload.c:258-264 â€” MODEINITJCT+MODETRANOP+MODEUIC: seed from IC* params.
        const vbe_ic = polarity * (isNaN(params.ICVBE) ? 0 : params.ICVBE);
        const vce_ic = polarity * (isNaN(params.ICVCE) ? 0 : params.ICVCE);
        vbeRaw = vbe_ic;
        vbcRaw = vbe_ic - vce_ic;
      } else if ((mode & MODEINITJCT) && params.OFF === 0) {
        // cite: bjtload.c:265-269 â€” MODEINITJCT, device ON: seed vbe=tVcrit, vbc=0.
        vbeRaw = tp.tVcrit;
        vbcRaw = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && params.OFF !== 0)) {
        // cite: bjtload.c:270-275 â€” MODEINITJCT+OFF or MODEINITFIX+OFF: zero-seed.
        vbeRaw = 0;
        vbcRaw = 0;
      } else if (mode & MODEINITPRED) {
        // bjtload.c:278-287: #ifndef PREDICTOR state1â†’state0 copy + xfact extrapolation.
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        // cite: bjtload.c:288-303 â€” copy remaining op-state slots from state1 to state0.
        s0[base + SLOT_CC]  = s1[base + SLOT_CC];  // cite: bjtload.c:289
        s0[base + SLOT_CB]  = s1[base + SLOT_CB];  // cite: bjtload.c:290
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI]; // cite: bjtload.c:291
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU]; // cite: bjtload.c:292
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];  // cite: bjtload.c:293
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];  // cite: bjtload.c:294
        s0[base + SLOT_GX]  = s1[base + SLOT_GX];  // cite: bjtload.c:295
        vbeRaw = (1 + ctx.xfact) * s1[base + SLOT_VBE] - ctx.xfact * s2[base + SLOT_VBE];
        vbcRaw = (1 + ctx.xfact) * s1[base + SLOT_VBC] - ctx.xfact * s2[base + SLOT_VBC];
      } else {
        // bjtload.c:311-319: normal NR iteration â€” read from CKTrhsOld.
        const vB = voltages[nodeB];
        const vC = voltages[nodeC];
        const vE = voltages[nodeE];
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }

      // cite: bjtload.c:323-337 â€” delvbe/delvbc + cchat/cbhat current prediction
      // (used by both checkConvergence and the bypass gate below).
      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cchat = s0[base + SLOT_CC] + (s0[base + SLOT_GM] + s0[base + SLOT_GO]) * delvbe
                    - (s0[base + SLOT_GO] + s0[base + SLOT_GMU]) * delvbc;
      const cbhat = s0[base + SLOT_CB] + s0[base + SLOT_GPI] * delvbe
                    + s0[base + SLOT_GMU] * delvbc;

      // cite: bjtload.c:338-381 â€” NOBYPASS gate: skip recompute when tolerances met.
      // Arranged as if/else wrapping the pnjlim+compute block, mirroring ngspice goto load.
      let vbeLimited: number;
      let vbcLimited: number;
      if (ctx.bypass &&
          !(mode & MODEINITPRED) &&
          (Math.abs(delvbe) < ctx.reltol * Math.max(Math.abs(vbeRaw), Math.abs(s0[base + SLOT_VBE])) + ctx.voltTol) &&
          (Math.abs(delvbc) < ctx.reltol * Math.max(Math.abs(vbcRaw), Math.abs(s0[base + SLOT_VBC])) + ctx.voltTol) &&
          (Math.abs(cchat - s0[base + SLOT_CC]) < ctx.reltol * Math.max(Math.abs(cchat), Math.abs(s0[base + SLOT_CC])) + ctx.iabstol) &&
          (Math.abs(cbhat - s0[base + SLOT_CB]) < ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(s0[base + SLOT_CB])) + ctx.iabstol)) {
        // cite: bjtload.c:365-380 â€” bypass: restore op-state from state0, skip pnjlim+compute.
        vbeLimited = s0[base + SLOT_VBE];
        vbcLimited = s0[base + SLOT_VBC];
        icheckLimited = false;
      } else {
        // bjtload.c:383-416: pnjlim on BE/BC. pnjlim runs under MODEINITPRED â€” ngspice has no
        // MODEINITPRED skip (bjtload.c:386 unconditional; !(MODEINITPRED) guard at :347 is for
        // bypass only).
        vbeLimited = vbeRaw;
        vbcLimited = vbcRaw;
        let vbeLimFlag = false;
        let vbcLimFlag = false;
        if ((mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0) {
          const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, tp.tVcrit);
          vbeLimited = vbeResult.value;
          vbeLimFlag = vbeResult.limited;
          const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], tp.vt, tp.tVcrit);
          vbcLimited = vbcResult.value;
          vbcLimFlag = vbcResult.limited;
        }
        icheckLimited = vbeLimFlag || vbcLimFlag;
        // L0 has no substrate junction â€” substrate is L1-only per the model-registry
        // split (architectural-alignment.md Â§E1 APPROVED ACCEPT). See also the
        // "no caps, no transit time, no excess phase, no substrate" L0 scope note at
        // the top of this load() body.

        // cite: bjtload.c:749-754 â€” icheck++ unless MODEINITFIX && OFF
        if (icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "BE",
            limitType: "pnjlim",
            vBefore: vbeRaw,
            vAfter: vbeLimited,
            wasLimited: vbeLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "BC",
            limitType: "pnjlim",
            vBefore: vbcRaw,
            vAfter: vbcLimited,
            wasLimited: vbcLimFlag,
          });
        }

        // bjtload.c:420-560: inline Gummel-Poon evaluation at limited voltages.
        // L0 = simple resistive Gummel-Poon (no excess phase, no caps). NKF=0.5
        // implicit (sqrt branch only). All formulas mirror bjtload.c line-for-line.
        const csat = tp.tSatCur * params.AREA;
        const betaF = tp.tBetaF;
        const betaR = tp.tBetaR;
        const c2 = tp.tBEleakCur * params.AREA;
        const c4 = tp.tBCleakCur * params.AREA;
        const tinvEarlyVoltF = tp.tinvEarlyVoltF;
        const tinvEarlyVoltR = tp.tinvEarlyVoltR;
        const oik = tp.tinvRollOffF / params.AREA;
        const oikr = tp.tinvRollOffR / params.AREA;
        const vt = tp.vt;
        const vtn_f = vt * params.NF;
        const vte = vt * params.NE;
        const vtn_r = vt * params.NR;
        const vtc = vt * params.NC;

        // bjtload.c:422-431: forward B-E junction current + conductance.
        let cbe: number, gbe: number;
        if (vbeLimited >= -3 * vtn_f) {
          const evbe = Math.exp(vbeLimited / vtn_f);
          cbe = csat * (evbe - 1);
          gbe = csat * evbe / vtn_f;
        } else {
          let a = 3 * vtn_f / (vbeLimited * Math.E);
          a = a * a * a;
          cbe = -csat * (1 + a);
          gbe = csat * 3 * a / vbeLimited;
        }

        // bjtload.c:432-446: non-ideal B-E (c2/vte).
        let cben: number, gben: number;
        if (c2 === 0) { cben = 0; gben = 0; }
        else if (vbeLimited >= -3 * vte) {
          const evben = Math.exp(vbeLimited / vte);
          cben = c2 * (evben - 1);
          gben = c2 * evben / vte;
        } else {
          let a = 3 * vte / (vbeLimited * Math.E);
          a = a * a * a;
          cben = -c2 * (1 + a);
          gben = c2 * 3 * a / vbeLimited;
        }
        // bjtload.c:447-448
        gben += GMIN;
        cben += GMIN * vbeLimited;

        // bjtload.c:452-461: reverse B-C junction current + conductance.
        let cbc: number, gbc: number;
        if (vbcLimited >= -3 * vtn_r) {
          const evbc = Math.exp(vbcLimited / vtn_r);
          cbc = csat * (evbc - 1);
          gbc = csat * evbc / vtn_r;
        } else {
          let a = 3 * vtn_r / (vbcLimited * Math.E);
          a = a * a * a;
          cbc = -csat * (1 + a);
          gbc = csat * 3 * a / vbcLimited;
        }

        // bjtload.c:462-476: non-ideal B-C (c4/vtc).
        let cbcn: number, gbcn: number;
        if (c4 === 0) { cbcn = 0; gbcn = 0; }
        else if (vbcLimited >= -3 * vtc) {
          const evbcn = Math.exp(vbcLimited / vtc);
          cbcn = c4 * (evbcn - 1);
          gbcn = c4 * evbcn / vtc;
        } else {
          let a = 3 * vtc / (vbcLimited * Math.E);
          a = a * a * a;
          cbcn = -c4 * (1 + a);
          gbcn = c4 * 3 * a / vbcLimited;
        }
        // bjtload.c:477-478
        gbcn += GMIN;
        cbcn += GMIN * vbcLimited;

        // bjtload.c:495-517: base charge qb (NKF=0.5 â†’ sqrt branch).
        const q1 = 1 / (1 - tinvEarlyVoltF * vbcLimited - tinvEarlyVoltR * vbeLimited);
        let qb: number, dqbdve: number, dqbdvc: number;
        if (oik === 0 && oikr === 0) {
          qb = q1;
          dqbdve = q1 * qb * tinvEarlyVoltR;
          dqbdvc = q1 * qb * tinvEarlyVoltF;
        } else {
          const q2 = oik * cbe + oikr * cbc;
          const arg_qb = Math.max(0, 1 + 4 * q2);
          const sqarg = arg_qb !== 0 ? Math.sqrt(arg_qb) : 1;
          qb = q1 * (1 + sqarg) / 2;
          // bjtload.c:511-512: NKF=0.5 default branch.
          const sqargSafe = Math.max(sqarg, 1e-30);
          dqbdve = q1 * (qb * tinvEarlyVoltR + oik * gbe / sqargSafe);
          dqbdvc = q1 * (qb * tinvEarlyVoltF + oikr * gbc / sqargSafe);
        }

        // bjtload.c:522-524: cc=0; cex=cbe; gex=gbe (L0 has no excess phase).
        let cc = 0;
        const cex = cbe;
        const gex = gbe;

        // bjtload.c:547-560: dc incremental currents and conductances.
        cc = cc + (cex - cbc) / qb - cbc / betaR - cbcn;
        const cb = cbe / betaF + cben + cbc / betaR + cbcn;
        const gpi = gbe / betaF + gben;
        const gmu = gbc / betaR + gbcn;
        const go = (gbc + (cex - cbc) * dqbdvc / qb) / qb;
        const gm = (gex - (cex - cbc) * dqbdve / qb) / qb - go;

        // bjtload.c:772-786: CKTstate0 write-back of accepted linearization.
        s0[base + SLOT_VBE] = vbeLimited;
        s0[base + SLOT_VBC] = vbcLimited;
        s0[base + SLOT_CC]  = cc;
        s0[base + SLOT_CB]  = cb;
        s0[base + SLOT_GPI] = gpi;
        s0[base + SLOT_GMU] = gmu;
        s0[base + SLOT_GM]  = gm;
        s0[base + SLOT_GO]  = go;
        s0[base + SLOT_GX]  = 0; // bjtload.c:780 â€” L0 has no RB so gx=0
      }

      // bjtload.c:795-805: ceqbe/ceqbc RHS terms.
      // On bypass path, vbeLimited/vbcLimited are restored from s0; op values read from s0.
      // On compute path, vbeLimited/vbcLimited are the newly limited values; op values in s0.
      // ceqbe = BJTtype * (cc + cb - vbe*(gm+go+gpi) + vbc*(go - geqcb));
      // ceqbc = BJTtype * (-cc + vbe*(gm+go) - vbc*(gmu+go));
      // Simple L0: geqcb=0 (no transit-time charge feedback).
      const m = params.M;
      const cc  = s0[base + SLOT_CC];
      const cb  = s0[base + SLOT_CB];
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const ceqbe = polarity * (cc + cb
                              - vbeLimited * (gm + go + gpi)
                              + vbcLimited * go);
      const ceqbc = polarity * (-cc
                              + vbeLimited * (gm + go)
                              - vbcLimited * (gmu + go));

      if (mode & MODEINITSMSIG) return;  // cite: bjtload.c:676,703 â€” MODEINITSMSIG stores op state, skips stamps

      const solver = ctx.solver;

      // bjtload.c:807-814: RHS stamps per terminal. Simple L0 collapses
      // base/base-prime and col/col-prime (no RB/RC internal nodes).
      stampRHS(ctx.rhs, nodeB, m * (-ceqbe - ceqbc));  // BJTbasePrimeNode += -ceqbe-ceqbc
      stampRHS(ctx.rhs, nodeC, m * ceqbc);              // BJTcolPrimeNode += ceqbx+ceqbc, ceqbx=0
      stampRHS(ctx.rhs, nodeE, m * ceqbe);              // BJTemitPrimeNode += ceqbe

      // bjtload.c:819-842: Y-matrix stamps. Simple L0 subset:
      //   BJTbasePrimeBasePrimePtr  += gpi + gmu  (no geqcb, no gx/geqbx)
      //   BJTcolPrimeColPrimePtr    += gmu + go    (no gcpr/geqbx)
      //   BJTemitPrimeEmitPrimePtr  += gpi + gm + go  (no gepr)
      //   BJTcolPrimeBasePrimePtr   += -gmu + gm
      //   BJTcolPrimeEmitPrimePtr   += -gm - go
      //   BJTbasePrimeColPrimePtr   += -gmu  (no geqcb)
      //   BJTbasePrimeEmitPrimePtr  += -gpi
      //   BJTemitPrimeColPrimePtr   += -go   (no geqcb)
      //   BJTemitPrimeBasePrimePtr  += -gpi - gm  (no geqcb)
      stampG(solver, nodeB, nodeB, m * (gpi + gmu));
      stampG(solver, nodeC, nodeC, m * (gmu + go));
      stampG(solver, nodeE, nodeE, m * (gpi + gm + go));
      stampG(solver, nodeC, nodeB, m * (-gmu + gm));
      stampG(solver, nodeC, nodeE, m * (-gm - go));
      stampG(solver, nodeB, nodeC, m * -gmu);
      stampG(solver, nodeB, nodeE, m * -gpi);
      stampG(solver, nodeE, nodeC, m * -go);
      stampG(solver, nodeE, nodeB, m * (-gpi - gm));
    },

    checkConvergence(ctx: LoadContext): boolean {
      const s0 = pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      const voltages = ctx.rhsOld;
      const vB = voltages[nodeB];
      const vC = voltages[nodeC];
      const vE = voltages[nodeE];
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      if (icheckLimited) return false;

      // BJTconvTest: bjtload.c:331-337 cchat/cbhat current prediction.
      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cc  = s0[base + SLOT_CC];
      const cb  = s0[base + SLOT_CB];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];

      const cchat = cc + (gm + go) * delvbe - (go + gmu) * delvbc;
      const cbhat = cb + gpi * delvbe + gmu * delvbc;

      const tolC = ctx.reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + ctx.iabstol;
      const tolB = ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + ctx.iabstol;

      return Math.abs(cchat - cc) <= tolC && Math.abs(cbhat - cb) <= tolB;
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      const s0 = pool.states[0];
      const ic = polarity * s0[base + SLOT_CC];
      const ib = polarity * s0[base + SLOT_CB];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        tp = makeTp();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// State schema â€” BJT SPICE L1. Only the slots that have direct ngspice
// correspondences survive the W1.2 excision. bjtdefs.h offsets:
//   BJTvbe=0, BJTvbc=1, BJTcc=2, BJTcb=3, BJTgpi=4, BJTgmu=5, BJTgm=6,
//   BJTgo=7, BJTqbe=8, BJTcqbe=9, BJTqbc=10, BJTcqbc=11, BJTqsub=12,
//   BJTcqsub=13, BJTqbx=14, BJTcqbx=15, BJTgx=16, BJTcexbc=17, BJTgeqcb=18,
//   BJTgccs=19, BJTgeqbx=20, BJTvsub=21, BJTcdsub=22, BJTgdsub=23.
//
// Invented cross-method cap slots (W1.2 A1 excision):
//   - CAP_GEQ_BE / CAP_IEQ_BE
//   - CAP_GEQ_BC_INT / CAP_IEQ_BC_INT
//   - CAP_GEQ_BC_EXT / CAP_IEQ_BC_EXT
//   - CAP_GEQ_CS / CAP_IEQ_CS
// All deleted. The lumping goes inline into gpi/gmu/cc/cb per bjtload.c:725-734.
//
// Ngspice-correspondent slots kept (in bjtdefs.h order):
//   VBE, VBC, CC, CB, GPI, GMU, GM, GO, QBE, CQBE, QBC, CQBC, QSUB, CQSUB,
//   QBX, CQBX, CEXBC, GEQCB, CDSUB, GDSUB, VSUB
// ---------------------------------------------------------------------------

export const BJT_L1_SCHEMA: StateSchema = defineStateSchema("BjtSpiceL1Element", [
  { name: "VBE",   doc: "bjtdefs.h BJTvbe=0",   init: { kind: "fromParams", compute: (_p) => _p["polarity"] === 1 ? 0.6 : -0.6 } },
  { name: "VBC",   doc: "bjtdefs.h BJTvbc=1",   init: { kind: "zero" } },
  { name: "CC",    doc: "bjtdefs.h BJTcc=2",    init: { kind: "zero" } },
  { name: "CB",    doc: "bjtdefs.h BJTcb=3",    init: { kind: "zero" } },
  { name: "GPI",   doc: "bjtdefs.h BJTgpi=4",   init: { kind: "zero" } },
  { name: "GMU",   doc: "bjtdefs.h BJTgmu=5",   init: { kind: "zero" } },
  { name: "GM",    doc: "bjtdefs.h BJTgm=6",    init: { kind: "zero" } },
  { name: "GO",    doc: "bjtdefs.h BJTgo=7",    init: { kind: "zero" } },
  { name: "QBE",   doc: "bjtdefs.h BJTqbe=8 (bjtload.c:615-626)",   init: { kind: "zero" } },
  { name: "CQBE",  doc: "bjtdefs.h BJTcqbe=9 (NIintegrate ccap)",   init: { kind: "zero" } },
  { name: "QBC",   doc: "bjtdefs.h BJTqbc=10 (bjtload.c:634-642)",  init: { kind: "zero" } },
  { name: "CQBC",  doc: "bjtdefs.h BJTcqbc=11",                     init: { kind: "zero" } },
  { name: "QSUB",  doc: "bjtdefs.h BJTqsub=12",                     init: { kind: "zero" } },
  { name: "CQSUB", doc: "bjtdefs.h BJTcqsub=13",                    init: { kind: "zero" } },
  { name: "QBX",   doc: "bjtdefs.h BJTqbx=14 (bjtload.c:646-654)",  init: { kind: "zero" } },
  { name: "CQBX",  doc: "bjtdefs.h BJTcqbx=15",                     init: { kind: "zero" } },
  { name: "GX",    doc: "bjtdefs.h BJTgx=16 (base-resistance cond)",init: { kind: "fromParams", compute: (_p) => _p["RB"] > 0 ? 1 / _p["RB"] : 0 } },
  { name: "CEXBC", doc: "bjtdefs.h BJTcexbc=17 (excess phase)",     init: { kind: "zero" } },
  { name: "GEQCB", doc: "bjtdefs.h BJTgeqcb=18",                    init: { kind: "zero" } },
  { name: "GCSUB", doc: "bjtdefs.h BJTgccs=19 subst cap cond",      init: { kind: "zero" } },
  { name: "GEQBX", doc: "bjtdefs.h BJTgeqbx=20 B-X cap cond",       init: { kind: "zero" } },
  { name: "VSUB",  doc: "bjtdefs.h BJTvsub=21",                     init: { kind: "zero" } },
  { name: "CDSUB", doc: "bjtdefs.h BJTcdsub=22",                    init: { kind: "zero" } },
  { name: "GDSUB", doc: "bjtdefs.h BJTgdsub=23",                    init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createSpiceL1BjtElement â€” SPICE L1 factory ported from bjtload.c.
// Single load() pass with inline cap-companion lumping (bjtload.c:725-734).
// D3: cap/charge integration gated on ctx.dt > 0 (dc-op has dt=0).
// No cached Float64Array state refs â€” pool.states[N] at call time.
// ---------------------------------------------------------------------------

export function createSpiceL1BjtElement(
  polarity: 1 | -1,
  isLateral: boolean,
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
) {
  const nodeB_ext = pinNodes.get("B")!;
  const nodeC_ext = pinNodes.get("C")!;
  const nodeE_ext = pinNodes.get("E")!;

  const params: Record<string, number> = {
    IS: props.getModelParam<number>("IS"),
    BF: props.getModelParam<number>("BF"),
    NF: props.getModelParam<number>("NF"),
    BR: props.getModelParam<number>("BR"),
    NR: props.getModelParam<number>("NR"),
    ISE: props.getModelParam<number>("ISE"),
    ISC: props.getModelParam<number>("ISC"),
    NE: props.getModelParam<number>("NE"),
    NC: props.getModelParam<number>("NC"),
    VAF: props.getModelParam<number>("VAF"),
    VAR: props.getModelParam<number>("VAR"),
    IKF: props.getModelParam<number>("IKF"),
    IKR: props.getModelParam<number>("IKR"),
    RB: props.getModelParam<number>("RB"),
    IRB: props.getModelParam<number>("IRB"),
    RBM: props.getModelParam<number>("RBM"),
    RC: props.getModelParam<number>("RC"),
    RE: props.getModelParam<number>("RE"),
    CJE: props.getModelParam<number>("CJE"),
    VJE: props.getModelParam<number>("VJE"),
    MJE: props.getModelParam<number>("MJE"),
    CJC: props.getModelParam<number>("CJC"),
    VJC: props.getModelParam<number>("VJC"),
    MJC: props.getModelParam<number>("MJC"),
    XCJC: props.getModelParam<number>("XCJC"),
    FC: props.getModelParam<number>("FC"),
    TF: props.getModelParam<number>("TF"),
    XTF: props.getModelParam<number>("XTF"),
    VTF: props.getModelParam<number>("VTF"),
    ITF: props.getModelParam<number>("ITF"),
    PTF: props.getModelParam<number>("PTF"),
    TR: props.getModelParam<number>("TR"),
    CJS: props.getModelParam<number>("CJS"),
    VJS: props.getModelParam<number>("VJS"),
    MJS: props.getModelParam<number>("MJS"),
    ISS: props.getModelParam<number>("ISS"),
    NS:  props.getModelParam<number>("NS"),
    XTB: props.getModelParam<number>("XTB"),
    EG: props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    KF: props.getModelParam<number>("KF"),
    AF: props.getModelParam<number>("AF"),
    NKF: props.getModelParam<number>("NKF"),
    AREA: props.getModelParam<number>("AREA"),
    AREAB: props.getModelParam<number>("AREAB"),
    AREAC: props.getModelParam<number>("AREAC"),
    M: props.getModelParam<number>("M"),
    TNOM: props.getModelParam<number>("TNOM"),
    TEMP: props.getModelParam<number>("TEMP"),
    OFF: props.getModelParam<number>("OFF"),
    ICVBE: props.getModelParam<number>("ICVBE"),
    ICVCE: props.getModelParam<number>("ICVCE"),
  };

  function makeTp(): BjtTempParams {
    return computeBjtTempParams({
      IS: params.IS, BF: params.BF, BR: params.BR,
      ISE: params.ISE, ISC: params.ISC,
      NE: params.NE, NC: params.NC, EG: params.EG, XTI: params.XTI, XTB: params.XTB,
      IKF: params.IKF, IKR: params.IKR,
      RC: params.RC, RE: params.RE, RB: params.RB, RBM: params.RBM, IRB: params.IRB,
      CJE: params.CJE, VJE: params.VJE, MJE: params.MJE,
      CJC: params.CJC, VJC: params.VJC, MJC: params.MJC,
      CJS: params.CJS, VJS: params.VJS, MJS: params.MJS,
      FC: params.FC, AREA: params.AREA, TNOM: params.TNOM,
      VAF: params.VAF, VAR: params.VAR,
      PTF: params.PTF, TF: params.TF, TR: params.TR,
      ISS: params.ISS, TEMP: params.TEMP,
    }, params.TEMP);
  }
  let tp = makeTp();

  // Internal node wiring: when Rx > 0, allocate an internal "prime" node.
  let intIdx = 0;
  const nodeB_int = params.RB > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeB_ext;
  const nodeC_int = params.RC > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeC_ext;
  const nodeE_int = params.RE > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeE_ext;

  // Substrate convention: NPN VERTICAL (+1) stamps on colPrime; PNP LATERAL (-1) on basePrime.
  const subs = polarity > 0 ? 1 : -1;
  const substConNode = subs > 0 ? nodeC_int : nodeB_int;

  const hasCapacitance = params.CJE > 0 || params.CJC > 0 || params.TF > 0 || params.TR > 0 || params.CJS > 0;

  // Slot indices (mirror bjtdefs.h).
  const SLOT_VBE = 0;
  const SLOT_VBC = 1;
  const SLOT_CC  = 2;
  const SLOT_CB  = 3;
  const SLOT_GPI = 4;
  const SLOT_GMU = 5;
  const SLOT_GM  = 6;
  const SLOT_GO  = 7;
  const SLOT_QBE = 8;
  const SLOT_CQBE = 9;
  const SLOT_QBC = 10;
  const SLOT_CQBC = 11;
  const SLOT_QSUB = 12;
  const SLOT_CQSUB = 13;
  const SLOT_QBX = 14;
  const SLOT_CQBX = 15;
  const SLOT_GX  = 16;
  const SLOT_CEXBC = 17;
  const SLOT_GEQCB = 18;
  const SLOT_GCSUB = 19;
  const SLOT_GEQBX = 20;
  const SLOT_VSUB  = 21;
  const SLOT_CDSUB = 22;
  const SLOT_GDSUB = 23;

  let pool: StatePoolRef;
  let base: number;

  let icheckLimited = false;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.BJT,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSchema: BJT_L1_SCHEMA,
    stateSize: BJT_L1_SCHEMA.size,
    stateBaseOffset: -1,
    s0: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s1: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s2: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s3: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s4: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s5: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s6: new Float64Array(0) as Float64Array<ArrayBufferLike>,
    s7: new Float64Array(0) as Float64Array<ArrayBufferLike>,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      this.s0 = poolRef.state0 as Float64Array<ArrayBufferLike>; this.s1 = poolRef.state1 as Float64Array<ArrayBufferLike>; this.s2 = poolRef.state2 as Float64Array<ArrayBufferLike>; this.s3 = poolRef.state3 as Float64Array<ArrayBufferLike>;
      this.s4 = poolRef.state4 as Float64Array<ArrayBufferLike>; this.s5 = poolRef.state5 as Float64Array<ArrayBufferLike>; this.s6 = poolRef.state6 as Float64Array<ArrayBufferLike>; this.s7 = poolRef.state7 as Float64Array<ArrayBufferLike>;
      applyInitialValues(BJT_L1_SCHEMA, pool, base, { polarity, RB: params.RB });
    },

    /**
     * Single-pass load mirroring bjtload.c::BJTload. Invented cross-method
     * cap slots deleted per W1.2 A1; cap-companion geq/ieq lumped inline
     * into gpi/gmu/cc/cb per bjtload.c:725-734.
     *
     * D3: cap/charge update gated on ctx.dt > 0 (DC-OP has dt=0).
     */
    load(this: PoolBackedAnalogElementCore, ctx: LoadContext): void {
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;
      const mode = ctx.cktMode;
      const m = params.M;
      // cite: bjtload.c:184-187 â€” BJTsubs: VERTICAL uses AREAB for c4; LATERAL uses AREAC.
      // `isLateral` is closure-captured from the outer factory (BJT topology
      // is a model variant, not a parameter â€” see modelRegistry "spice" vs
      // "spice-lateral" entries).

      const vt = tp.vt;
      const csat = tp.tSatCur * params.AREA;
      const csubsat = tp.tSubSatCur * params.AREA;
      const c2 = tp.tBEleakCur * params.AREA;
      const c4 = tp.tBCleakCur * (isLateral ? params.AREAC : params.AREAB); // cite: bjtload.c:184-187
      const oik = tp.tinvRollOffF / params.AREA;
      const oikr = tp.tinvRollOffR / params.AREA;

      // bjtload.c:176-179: rbpr = tminBaseResist/AREA, rbpi = tbaseResist/AREA - rbpr.
      const rbpr = tp.tminBaseResist / params.AREA;
      const rbpi = tp.tbaseResist / params.AREA - rbpr;
      const gcpr = tp.tcollectorConduct * params.AREA;
      const gepr = tp.temitterConduct * params.AREA;
      const xjrb = tp.tbaseCurrentHalfResist * params.AREA;
      const td = tp.excessPhaseFactor;

      // bjtload.c:232-322: linearization voltage dispatch per cktMode.
      let vbeRaw: number;
      let vbcRaw: number;
      let vbxRaw: number;
      let vsubRaw: number;

      const vBe_ext = voltages[nodeB_ext];
      const vBi     = voltages[nodeB_int];
      const vCi     = voltages[nodeC_int];
      const vEi     = voltages[nodeE_int];
      const vSubCon = voltages[substConNode];

      if (mode & MODEINITSMSIG) {
        // bjtload.c:236-244.
        vbeRaw = s0[base + SLOT_VBE];
        vbcRaw = s0[base + SLOT_VBC];
        vbxRaw = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
      } else if (mode & MODEINITTRAN) {
        // bjtload.c:245-257 â€” with MODEUIC inside MODETRAN override.
        vbeRaw = s1[base + SLOT_VBE];
        vbcRaw = s1[base + SLOT_VBC];
        vbxRaw = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
        if ((mode & MODETRAN) && (mode & MODEUIC)) {
          const vbe_ic = isNaN(params.ICVBE) ? 0 : params.ICVBE;
          const vce_ic = isNaN(params.ICVCE) ? 0 : params.ICVCE;
          vbxRaw = polarity * (vbe_ic - vce_ic);
          vsubRaw = 0;
        }
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // bjtload.c:258-264.
        const vbe_ic = polarity * (isNaN(params.ICVBE) ? 0 : params.ICVBE);
        const vce_ic = polarity * (isNaN(params.ICVCE) ? 0 : params.ICVCE);
        vbeRaw = vbe_ic;
        vbcRaw = vbe_ic - vce_ic;
        vbxRaw = vbcRaw;
        vsubRaw = 0;
      } else if ((mode & MODEINITJCT) && params.OFF === 0) {
        // bjtload.c:265-269.
        vbeRaw = tp.tVcrit;
        vbcRaw = 0;
        vbxRaw = 0;
        vsubRaw = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && params.OFF !== 0)) {
        // bjtload.c:270-275.
        vbeRaw = 0;
        vbcRaw = 0;
        vbxRaw = 0;
        vsubRaw = 0;
      } else if (mode & MODEINITPRED) {
        // bjtload.c:278-287: #ifndef PREDICTOR state1â†’state0 copy + xfact extrapolation.
        // bjtload.c:383-416: pnjlim runs under MODEINITPRED â€” ngspice has no MODEINITPRED
        // skip (bjtload.c:386 unconditional; !(MODEINITPRED) guard at :347 is for bypass only).
        s0[base + SLOT_VBE]  = s1[base + SLOT_VBE];   // cite: bjtload.c:288
        s0[base + SLOT_VBC]  = s1[base + SLOT_VBC];   // cite: bjtload.c:289
        s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB];  // cite: bjtload.c:290
        s0[base + SLOT_CC]   = s1[base + SLOT_CC];    // cite: bjtload.c:291
        s0[base + SLOT_CB]   = s1[base + SLOT_CB];    // cite: bjtload.c:292
        s0[base + SLOT_GPI]  = s1[base + SLOT_GPI];   // cite: bjtload.c:293
        s0[base + SLOT_GMU]  = s1[base + SLOT_GMU];   // cite: bjtload.c:294
        s0[base + SLOT_GM]   = s1[base + SLOT_GM];    // cite: bjtload.c:295
        s0[base + SLOT_GO]   = s1[base + SLOT_GO];    // cite: bjtload.c:296
        s0[base + SLOT_GX]   = s1[base + SLOT_GX];    // cite: bjtload.c:297
        vbeRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBE]  - ctx.xfact * s2[base + SLOT_VBE];
        vbcRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBC]  - ctx.xfact * s2[base + SLOT_VBC];
        vsubRaw = (1 + ctx.xfact) * s1[base + SLOT_VSUB] - ctx.xfact * s2[base + SLOT_VSUB];
        vbxRaw  = polarity * (vBe_ext - vCi);           // bjtload.c:325-327
        vsubRaw = polarity * subs * (0 - vSubCon);      // bjtload.c:328-330
      } else {
        // bjtload.c:311-319: normal NR iteration â€” read from CKTrhsOld.
        vbeRaw  = polarity * (vBi - vEi);
        vbcRaw  = polarity * (vBi - vCi);
        vbxRaw  = polarity * (vBe_ext - vCi);           // bjtload.c:325-327
        vsubRaw = polarity * subs * (0 - vSubCon);      // bjtload.c:328-330
      }

      // cite: bjtload.c:323-337 â€” delvbe/delvbc + cchat/cbhat current prediction
      // (used by both checkConvergence and the bypass gate below).
      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cchat = s0[base + SLOT_CC] + (s0[base + SLOT_GM] + s0[base + SLOT_GO]) * delvbe
                    - (s0[base + SLOT_GO] + s0[base + SLOT_GMU]) * delvbc;
      const cbhat = s0[base + SLOT_CB] + s0[base + SLOT_GPI] * delvbe
                    + s0[base + SLOT_GMU] * delvbc;

      // cite: bjtload.c:338-381 â€” NOBYPASS gate: skip recompute when tolerances met.
      // Arranged as if/else wrapping the pnjlim+compute+cap block, mirroring ngspice goto load.
      let vbeLimited: number;
      let vbcLimited: number;
      let vsubLimited: number;
      let cc: number;
      let cb: number;
      let gpi: number;
      let gmu: number;
      let gm: number;
      let go: number;
      let gx: number;
      let geqcb: number;
      let gcsub: number;
      let geqbx: number;
      let gdsub: number;
      let cdsub: number;
      if (ctx.bypass &&
          !(mode & MODEINITPRED) &&
          (Math.abs(delvbe) < ctx.reltol * Math.max(Math.abs(vbeRaw), Math.abs(s0[base + SLOT_VBE])) + ctx.voltTol) &&
          (Math.abs(delvbc) < ctx.reltol * Math.max(Math.abs(vbcRaw), Math.abs(s0[base + SLOT_VBC])) + ctx.voltTol) &&
          (Math.abs(cchat - s0[base + SLOT_CC]) < ctx.reltol * Math.max(Math.abs(cchat), Math.abs(s0[base + SLOT_CC])) + ctx.iabstol) &&
          (Math.abs(cbhat - s0[base + SLOT_CB]) < ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(s0[base + SLOT_CB])) + ctx.iabstol)) {
        // cite: bjtload.c:365-379 â€” bypass: restore 15 op-state values from state0.
        vbeLimited = s0[base + SLOT_VBE];
        vbcLimited = s0[base + SLOT_VBC];
        cc   = s0[base + SLOT_CC];
        cb   = s0[base + SLOT_CB];
        gpi  = s0[base + SLOT_GPI];
        gmu  = s0[base + SLOT_GMU];
        gm   = s0[base + SLOT_GM];
        go   = s0[base + SLOT_GO];
        gx   = s0[base + SLOT_GX];
        geqcb  = s0[base + SLOT_GEQCB];
        gcsub  = s0[base + SLOT_GCSUB];
        geqbx  = s0[base + SLOT_GEQBX];
        vsubLimited = s0[base + SLOT_VSUB];
        gdsub  = s0[base + SLOT_GDSUB];
        cdsub  = s0[base + SLOT_CDSUB];
        icheckLimited = false;
      } else {
        // bjtload.c:383-416: pnjlim on BE, BC, and substrate junctions.
        vbeLimited = vbeRaw;
        vbcLimited = vbcRaw;
        vsubLimited = vsubRaw;
        let vbeLimFlag = false;
        let vbcLimFlag = false;
        let vsubLimFlag = false;
        if ((mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0) {
          const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], vt, tp.tVcrit);
          vbeLimited = vbeResult.value;
          vbeLimFlag = vbeResult.limited;
          const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], vt, tp.tVcrit);
          vbcLimited = vbcResult.value;
          vbcLimFlag = vbcResult.limited;
          const vsubResult = pnjlim(vsubRaw, s0[base + SLOT_VSUB], vt, tp.tSubVcrit);
          vsubLimited = vsubResult.value;
          vsubLimFlag = vsubResult.limited;
        }
        icheckLimited = vbeLimFlag || vbcLimFlag || vsubLimFlag;

        // cite: bjtload.c:749-754 â€” icheck++ unless MODEINITFIX && OFF
        if (icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "BE",
            limitType: "pnjlim",
            vBefore: vbeRaw,
            vAfter: vbeLimited,
            wasLimited: vbeLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "BC",
            limitType: "pnjlim",
            vBefore: vbcRaw,
            vAfter: vbcLimited,
            wasLimited: vbcLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "SUB",
            limitType: "pnjlim",
            vBefore: vsubRaw,
            vAfter: vsubLimited,
            wasLimited: vsubLimFlag,
          });
        }

        // bjtload.c:420-478: inline Gummel-Poon junction evaluation at limited voltages.
        const vtn_f = vt * params.NF;
        const vte = vt * params.NE;
        const vtn_r = vt * params.NR;
        const vtc = vt * params.NC;

        // bjtload.c:422-431: forward B-E junction current + conductance.
        let cbe: number, gbe: number;
        if (vbeLimited >= -3 * vtn_f) {
          const evbe = Math.exp(vbeLimited / vtn_f);
          cbe = csat * (evbe - 1);
          gbe = csat * evbe / vtn_f;
        } else {
          let a = 3 * vtn_f / (vbeLimited * Math.E);
          a = a * a * a;
          cbe = -csat * (1 + a);
          gbe = csat * 3 * a / vbeLimited;
        }

        // bjtload.c:432-446: non-ideal B-E (c2/vte).
        let cben: number, gben: number;
        if (c2 === 0) { cben = 0; gben = 0; }
        else if (vbeLimited >= -3 * vte) {
          const evben = Math.exp(vbeLimited / vte);
          cben = c2 * (evben - 1);
          gben = c2 * evben / vte;
        } else {
          let a = 3 * vte / (vbeLimited * Math.E);
          a = a * a * a;
          cben = -c2 * (1 + a);
          gben = c2 * 3 * a / vbeLimited;
        }
        // bjtload.c:447-448
        gben += GMIN;
        cben += GMIN * vbeLimited;

        // bjtload.c:452-461: reverse B-C junction current + conductance.
        let cbc: number, gbc: number;
        if (vbcLimited >= -3 * vtn_r) {
          const evbc = Math.exp(vbcLimited / vtn_r);
          cbc = csat * (evbc - 1);
          gbc = csat * evbc / vtn_r;
        } else {
          let a = 3 * vtn_r / (vbcLimited * Math.E);
          a = a * a * a;
          cbc = -csat * (1 + a);
          gbc = csat * 3 * a / vbcLimited;
        }

        // bjtload.c:462-476: non-ideal B-C (c4/vtc).
        let cbcn: number, gbcn: number;
        if (c4 === 0) { cbcn = 0; gbcn = 0; }
        else if (vbcLimited >= -3 * vtc) {
          const evbcn = Math.exp(vbcLimited / vtc);
          cbcn = c4 * (evbcn - 1);
          gbcn = c4 * evbcn / vtc;
        } else {
          let a = 3 * vtc / (vbcLimited * Math.E);
          a = a * a * a;
          cbcn = -c4 * (1 + a);
          gbcn = c4 * 3 * a / vbcLimited;
        }
        // bjtload.c:477-478
        gbcn += GMIN;
        cbcn += GMIN * vbcLimited;

        // bjtload.c:482-491: substrate junction current/conductance (L1 only).
        const vts = vt * params.NS;
        if (csubsat > 0) {
          if (vsubLimited <= -3 * vts) {
            let a = 3 * vts / (vsubLimited * Math.E);
            a = a * a * a;
            gdsub = csubsat * 3 * a / vsubLimited + GMIN;
            cdsub = -csubsat * (1 + a) + GMIN * vsubLimited;
          } else {
            // bjtload.c:488: exp arg clamped to MAX_EXP_ARG to prevent overflow
            // on paths (MODEINITSMSIG/MODEINITTRAN) that bypass pnjlim.
            const MAX_EXP_ARG = 709;
            const evsub = Math.exp(Math.min(MAX_EXP_ARG, vsubLimited / vts));
            gdsub = csubsat * evsub / vts + GMIN;
            cdsub = csubsat * (evsub - 1) + GMIN * vsubLimited;
          }
        } else {
          gdsub = GMIN;
          cdsub = GMIN * vsubLimited;
        }

        // bjtload.c:495-517: base charge qb. Default NKF (0.5) â†’ sqrt branch;
        // explicit NKF (model->BJTnkfGiven) â†’ pow branch.
        const q1 = 1 / (1 - tp.tinvEarlyVoltF * vbcLimited - tp.tinvEarlyVoltR * vbeLimited);
        let qb: number, dqbdve: number, dqbdvc: number;
        if (oik === 0 && oikr === 0) {
          qb = q1;
          dqbdve = q1 * qb * tp.tinvEarlyVoltR;
          dqbdvc = q1 * qb * tp.tinvEarlyVoltF;
        } else {
          const q2 = oik * cbe + oikr * cbc;
          const arg_qb = Math.max(0, 1 + 4 * q2);
          let sqarg = 1;
          if (params.NKF === 0.5) {
            if (arg_qb !== 0) sqarg = Math.sqrt(arg_qb);
          } else {
            if (arg_qb !== 0) sqarg = Math.pow(arg_qb, params.NKF);
          }
          qb = q1 * (1 + sqarg) / 2;
          if (params.NKF === 0.5) {
            const sqargSafe = Math.max(sqarg, 1e-30);
            dqbdve = q1 * (qb * tp.tinvEarlyVoltR + oik * gbe / sqargSafe);
            dqbdvc = q1 * (qb * tp.tinvEarlyVoltF + oikr * gbc / sqargSafe);
          } else {
            const argSafe = Math.max(arg_qb, 1e-30);
            dqbdve = q1 * (qb * tp.tinvEarlyVoltR + oik * gbe * 2 * sqarg * params.NKF / argSafe);
            dqbdvc = q1 * (qb * tp.tinvEarlyVoltF + oikr * gbc * 2 * sqarg * params.NKF / argSafe);
          }
        }

        // bjtload.c:518-543: Weil's approx for excess phase (backward-Euler).
        // bjtload.c:522-524: cc=0; cex=cbe; gex=gbe (defaults; excess-phase block updates them).
        cc = 0;
        let cex = cbe;
        let gex = gbe;
        let cexbc_now = 0;
        // bjtload.c:525: gate is (MODETRAN|MODEAC) && td!=0 only â€” no ctx.delta guard.
        if ((mode & (MODETRAN | MODEAC)) !== 0 && td !== 0) {
          const arg1a = ctx.dt / td;
          const arg2 = 3 * arg1a;
          const arg1 = arg2 * arg1a;
          const denom = 1 + arg1 + arg2;
          const arg3 = arg1 / denom;
          const deltaOld1 = ctx.deltaOld[1];  // cite: dctran.c:317 â€” pre-seeded to CKTmaxStep, never zero
          // cite: bjtload.c:531-535 â€” INITTRAN seeds state1+state2 cexbc to cbe/qb.
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_CEXBC] = cbe / qb;
            s2[base + SLOT_CEXBC] = s1[base + SLOT_CEXBC];
          }
          // cite: bjtload.c:536-539 â€” IIR denom uses deltaOld[1] directly (dctran.c:317 seeds).
          cc = (s1[base + SLOT_CEXBC] * (1 + ctx.dt / deltaOld1 + arg2)
                - s2[base + SLOT_CEXBC] * ctx.dt / deltaOld1) / denom;
          cex = cbe * arg3;
          gex = gbe * arg3;
          cexbc_now = cc + cex / qb;
        }

        // bjtload.c:547-560: dc incremental currents and conductances (post-excess-phase).
        cc = cc + (cex - cbc) / qb - cbc / tp.tBetaR - cbcn;
        cb = cbe / tp.tBetaF + cben + cbc / tp.tBetaR + cbcn;
        // bjtload.c:549-556: effective base-resistance gx.
        gx = rbpr + rbpi / qb;
        if (xjrb !== 0) {
          const arg1a = Math.max(cb / xjrb, 1e-9);
          const arg2 = (-1 + Math.sqrt(1 + 14.59025 * arg1a)) / 2.4317 / Math.sqrt(arg1a);
          const arg1b = Math.tan(arg2);
          gx = rbpr + 3 * rbpi * (arg1b - arg2) / arg2 / arg1b / arg1b;
        }
        if (gx !== 0) gx = 1 / gx;
        gpi = gbe / tp.tBetaF + gben;
        gmu = gbc / tp.tBetaR + gbcn;
        go = (gbc + (cex - cbc) * dqbdvc / qb) / qb;
        gm = (gex - (cex - cbc) * dqbdve / qb) / qb - go;

        // bjtload.c:561-724: capacitance + charge block.
        // D3: gate on ctx.dt > 0 â€” DC-OP (dt==0) does NOT update cap charges,
        // but MODEINITSMSIG and MODETRANOP&&MODEUIC still store capacitances.
        // bjtload.c:561-563 gate: (MODETRAN|MODEAC) || (MODETRANOP&&MODEUIC) || MODEINITSMSIG.
        let capbe = 0;
        let capbc = 0;
        let capsub = 0;
        let capbx = 0;
        geqcb = 0;
        geqbx = 0;
        gcsub = 0;
        // ceqbx and ceqsub are computed at RHS-stamp time (bjtload.c:799-802)
        // using the stored CQSUB/CQBX state. No init needed here.

        // cite: bjtload.c:561-563 â€” cap block gate.
        const capBlockGate = (mode & (MODETRAN | MODEAC)) !== 0
                          || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0)
                          || (mode & MODEINITSMSIG) !== 0;

        if (hasCapacitance && capBlockGate) {
          const tf = tp.ttransitTimeF;
          const tr = tp.ttransitTimeR;
          const czbe = tp.tBEcap * params.AREA;
          const pe = tp.tBEpot;
          const xme = tp.tjunctionExpBE;
          const cdis = params.XCJC;
          const ctot = tp.tBCcap * (isLateral ? params.AREAC : params.AREAB); // cite: bjtload.c:573-576
          const czbc = ctot * cdis;
          const czbx = ctot - czbc;
          const pc = tp.tBCpot;
          const xmc = tp.tjunctionExpBC;
          const fcpe = tp.tDepCap;
          const czsub = tp.tSubcap * (isLateral ? params.AREAB : params.AREAC); // cite: bjtload.c:582-585
          const ps = tp.tSubpot;
          const xms = tp.tjunctionExpSub;
          const xtf = params.XTF;
          const ovtf = params.VTF === Infinity ? 0 : 1 / (1.44 * params.VTF);
          const xjtf = params.ITF * params.AREA;

          // cite: bjtload.c:591-610 â€” cbeMod/gbeMod compute unconditionally when tf>0 && vbe>0; XTF=0 collapses argtf=arg2=0.
          let cbeMod = cbe;
          let gbeMod = gbe;
          if (tf !== 0 && vbeLimited > 0) {
            let argtf = 0;
            let arg2 = 0;
            let arg3 = 0;
            if (xtf !== 0) {
              argtf = xtf;
              if (ovtf !== 0) {
                argtf = argtf * Math.exp(vbcLimited * ovtf);
              }
              arg2 = argtf;
              if (xjtf !== 0) {
                const temp = cbe / (cbe + xjtf);
                argtf = argtf * temp * temp;
                arg2 = argtf * (3 - temp - temp);
              }
              arg3 = cbe * argtf * ovtf;
            }
            cbeMod = cbe * (1 + argtf) / qb;
            gbeMod = (gbe * (1 + arg2) - cbeMod * dqbdve) / qb;
            geqcb = tf * (arg3 - cbeMod * dqbdvc) / qb;
          }

          // bjtload.c:612-626: QBE + capbe.
          let qbe: number;
          if (vbeLimited < fcpe) {
            const arg = 1 - vbeLimited / pe;
            const sarg = Math.exp(-xme * Math.log(arg));
            qbe = tf * cbeMod + pe * czbe * (1 - arg * sarg) / (1 - xme);
            capbe = tf * gbeMod + czbe * sarg; // cite: bjtload.c:617 â€” gbeMod from op.gbe (not gm)
          } else {
            const f1 = tp.tf1;
            const f2 = tp.f2;
            const f3 = tp.f3;
            const czbef2 = czbe / f2;
            qbe = tf * cbeMod + czbe * f1 + czbef2
                  * (f3 * (vbeLimited - fcpe) + (xme / (pe + pe)) * (vbeLimited * vbeLimited - fcpe * fcpe));
            capbe = tf * gbeMod + czbef2 * (f3 + xme * vbeLimited / pe); // cite: bjtload.c:625
          }

          // bjtload.c:627-642: QBC + capbc.
          const fcpc = tp.tf4;
          const f1c = tp.tf5;
          const f2c = tp.f6;
          const f3c = tp.f7;
          let qbc: number;
          if (vbcLimited < fcpc) {
            const arg = 1 - vbcLimited / pc;
            const sarg = Math.exp(-xmc * Math.log(arg));
            qbc = tr * cbc + pc * czbc * (1 - arg * sarg) / (1 - xmc);
            capbc = tr * gbc + czbc * sarg;
          } else {
            const czbcf2 = czbc / f2c;
            qbc = tr * cbc + czbc * f1c + czbcf2
                  * (f3c * (vbcLimited - fcpc) + (xmc / (pc + pc)) * (vbcLimited * vbcLimited - fcpc * fcpc));
            capbc = tr * gbc + czbcf2 * (f3c + xmc * vbcLimited / pc);
          }

          // bjtload.c:643-654: QBX + capbx.
          let qbx: number;
          if (vbxRaw < fcpc) {
            const arg = 1 - vbxRaw / pc;
            const sarg = Math.exp(-xmc * Math.log(arg));
            qbx = pc * czbx * (1 - arg * sarg) / (1 - xmc);
            capbx = czbx * sarg;
          } else {
            const czbxf2 = czbx / f2c;
            qbx = czbx * f1c + czbxf2
                  * (f3c * (vbxRaw - fcpc) + (xmc / (pc + pc)) * (vbxRaw * vbxRaw - fcpc * fcpc));
            capbx = czbxf2 * (f3c + xmc * vbxRaw / pc);
          }

          // bjtload.c:655-665: QSUB + capsub.
          let qcs: number;
          if (vsubLimited < 0) {
            const arg = 1 - vsubLimited / ps;
            const sarg = Math.exp(-xms * Math.log(arg));
            qcs = ps * czsub * (1 - arg * sarg) / (1 - xms);
            capsub = czsub * sarg;
          } else {
            qcs = vsubLimited * czsub * (1 + xms * vsubLimited / (2 * ps));
            capsub = czsub * (1 + xms * vsubLimited / ps);
          }

          s0[base + SLOT_QBE] = qbe;
          s0[base + SLOT_QBC] = qbc;
          s0[base + SLOT_QBX] = qbx;
          s0[base + SLOT_QSUB] = qcs;

          // cite: bjtload.c:674-703 â€” MODEINITSMSIG stores caps+op, skips NIintegrate and stamps via 'continue'
          if ((mode & MODEINITSMSIG) !== 0 &&
              !((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0)) {
            s0[base + SLOT_CQBE] = capbe;
            s0[base + SLOT_CQBC] = capbc;
            s0[base + SLOT_CQSUB] = capsub;
            s0[base + SLOT_CQBX] = capbx;
            s0[base + SLOT_CEXBC] = geqcb;
            // bjtload.c:703 `continue` â€” skip NIintegrate + stamps for smsig.
            // Write back accepted linearization then return.
            s0[base + SLOT_VBE] = vbeLimited;
            s0[base + SLOT_VBC] = vbcLimited;
            s0[base + SLOT_CC]  = cc;
            s0[base + SLOT_CB]  = cb;
            s0[base + SLOT_GPI] = gpi;
            s0[base + SLOT_GMU] = gmu;
            s0[base + SLOT_GM]  = gm;
            s0[base + SLOT_GO]  = go;
            s0[base + SLOT_GX]  = gx;
            s0[base + SLOT_GEQCB] = geqcb;
            s0[base + SLOT_GCSUB] = 0;
            s0[base + SLOT_GEQBX] = 0;
            s0[base + SLOT_VSUB]  = vsubLimited;
            s0[base + SLOT_GDSUB] = gdsub;
            s0[base + SLOT_CDSUB] = cdsub;
            return;
          }

          // cite: bjtload.c:715-724 â€” MODEINITTRAN copies q-values into state1 for next-step integrate.
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_QBE] = qbe;
            s1[base + SLOT_QBC] = qbc;
            s1[base + SLOT_QBX] = qbx;
            s1[base + SLOT_QSUB] = qcs;
          }

          // bjtload.c:725-734: NIintegrate (B-E, B-C) + geqcb scaled by ag[0].
          // D3: NIintegrate only valid when ctx.dt > 0 (we have a timestep).
          if (ctx.dt > 0) {
            const ag = ctx.ag;
            // B-E cap companion.
            {
              const ccapPrev = s1[base + SLOT_CQBE];
              const q2 = s2[base + SLOT_QBE];
              const q3 = s3[base + SLOT_QBE];
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capbe, ag,
                qbe, s1[base + SLOT_QBE],
                [q2, q3, 0, 0, 0], ccapPrev,
              );
              s0[base + SLOT_CQBE] = ccap;
              // bjtload.c:727: geqcb = geqcb * CKTag[0].
              geqcb = geqcb * ag[0];
              // bjtload.c:728: gpi += geq.
              gpi = gpi + geq;
              // bjtload.c:729: cb += CKTstate0[BJTcqbe] (lumped cap companion current).
              // The value accumulated into cb is ccap â€” the ngspice companion
              // current stored in BJTcqbe via state0 at niinteg.c:77.
              cb = cb + ccap;
            }
            // B-C cap companion.
            {
              const ccapPrev = s1[base + SLOT_CQBC];
              const q2 = s2[base + SLOT_QBC];
              const q3 = s3[base + SLOT_QBC];
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capbc, ag,
                qbc, s1[base + SLOT_QBC],
                [q2, q3, 0, 0, 0], ccapPrev,
              );
              s0[base + SLOT_CQBC] = ccap;
              // bjtload.c:732: gmu += geq.
              gmu = gmu + geq;
              // bjtload.c:733-734: cb += ccap; cc -= ccap.
              cb = cb + ccap;
              cc = cc - ccap;
            }

            // cite: bjtload.c:735-740 â€” MODEINITTRAN copies cqbe/cqbc into state1 for next-step integrate.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQBE] = s0[base + SLOT_CQBE];
              s1[base + SLOT_CQBC] = s0[base + SLOT_CQBC];
            }

            // bjtload.c:757-770: C-S and B-X cap-companion NIintegrate (post-check).
            // These stay as separate stamps (bjtload.c:823,838-842), not lumped
            // into gpi/gmu.
            {
              const ccapPrev = s1[base + SLOT_CQSUB];
              const q2 = s2[base + SLOT_QSUB];
              const q3 = s3[base + SLOT_QSUB];
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capsub, ag,
                qcs, s1[base + SLOT_QSUB],
                [q2, q3, 0, 0, 0], ccapPrev,
              );
              s0[base + SLOT_CQSUB] = ccap;
              gcsub = geq;
            }
            {
              const ccapPrev = s1[base + SLOT_CQBX];
              const q2 = s2[base + SLOT_QBX];
              const q3 = s3[base + SLOT_QBX];
              const { ccap, geq } = niIntegrate(
                ctx.method, ctx.order, capbx, ag,
                qbx, s1[base + SLOT_QBX],
                [q2, q3, 0, 0, 0], ccapPrev,
              );
              s0[base + SLOT_CQBX] = ccap;
              geqbx = geq;
            }
            // cite: bjtload.c:764-769 â€” MODEINITTRAN copies cqbx/cqsub into state1 for next-step integrate.
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQBX] = s0[base + SLOT_CQBX];
              s1[base + SLOT_CQSUB] = s0[base + SLOT_CQSUB];
            }
          }
          // End cap block.
        }

        // bjtload.c:772-786: state0 write-back of accepted linearization.
        s0[base + SLOT_VBE] = vbeLimited;
        s0[base + SLOT_VBC] = vbcLimited;
        s0[base + SLOT_CC]  = cc;
        s0[base + SLOT_CB]  = cb;
        s0[base + SLOT_GPI] = gpi;
        s0[base + SLOT_GMU] = gmu;
        s0[base + SLOT_GM]  = gm;
        s0[base + SLOT_GO]  = go;
        s0[base + SLOT_GX]  = gx;
        s0[base + SLOT_GEQCB] = geqcb;
        s0[base + SLOT_GCSUB] = gcsub;
        s0[base + SLOT_GEQBX] = geqbx;
        s0[base + SLOT_VSUB]  = vsubLimited;
        s0[base + SLOT_GDSUB] = gdsub;
        s0[base + SLOT_CDSUB] = cdsub;
        s0[base + SLOT_CEXBC] = cexbc_now;
      } // end bypass else

      // cite: bjtload.c:798-800 â€” geqsub aggregates gcsub+gdsub; used as single conductance at all substrate stamps.
      const geqsub = gcsub + gdsub;
      const ceqsub = polarity * subs * (s0[base + SLOT_CQSUB] + cdsub - vsubLimited * geqsub);
      const ceqbx = polarity * (s0[base + SLOT_CQBX] - vbxRaw * geqbx);
      const ceqbe = polarity * (cc + cb - vbeLimited * (gm + go + gpi) + vbcLimited * (go - geqcb));
      const ceqbc = polarity * (-cc + vbeLimited * (gm + go) - vbcLimited * (gmu + go));

      // bjtload.c:807-814: RHS stamps.
      stampRHS(ctx.rhs, nodeB_ext,       m * -ceqbx);            // BJTbaseNode
      stampRHS(ctx.rhs, nodeC_int,       m * (ceqbx + ceqbc));   // BJTcolPrimeNode
      stampRHS(ctx.rhs, substConNode,    m * ceqsub);            // BJTsubstConNode
      stampRHS(ctx.rhs, nodeB_int,       m * (-ceqbe - ceqbc));  // BJTbasePrimeNode
      stampRHS(ctx.rhs, nodeE_int,       m * ceqbe);             // BJTemitPrimeNode
      stampRHS(ctx.rhs, 0,               m * -ceqsub);           // BJTsubstNode (ground)

      // bjtload.c:819-842: Y-matrix stamps.
      // Terminal resistances + base resistance + intrinsic block + cap terms.
      if (gcpr !== 0 && nodeC_int !== nodeC_ext) {
        // BJTcolColPtr += gcpr
        stampG(solver, nodeC_ext, nodeC_ext, m * gcpr);
        stampG(solver, nodeC_ext, nodeC_int, m * -gcpr);
        stampG(solver, nodeC_int, nodeC_ext, m * -gcpr);
        stampG(solver, nodeC_int, nodeC_int, m * gcpr);
      }
      if (gepr !== 0 && nodeE_int !== nodeE_ext) {
        stampG(solver, nodeE_ext, nodeE_ext, m * gepr);
        stampG(solver, nodeE_ext, nodeE_int, m * -gepr);
        stampG(solver, nodeE_int, nodeE_ext, m * -gepr);
        stampG(solver, nodeE_int, nodeE_int, m * gepr);
      }
      // bjtload.c:820: BJTbaseBasePtr += gx + geqbx.
      stampG(solver, nodeB_ext, nodeB_ext, m * (gx + geqbx));
      // bjtload.c:822: BJTcolPrimeColPrimePtr += gmu + go + gcpr + geqbx.
      stampG(solver, nodeC_int, nodeC_int, m * (gmu + go + gcpr + geqbx));
      // cite: bjtload.c:823 â€” BJTsubstConSubstConPtr += geqsub (aggregated).
      stampG(solver, substConNode, substConNode, m * geqsub);
      // bjtload.c:824: BJTbasePrimeBasePrimePtr += gx + gpi + gmu + geqcb.
      stampG(solver, nodeB_int, nodeB_int, m * (gx + gpi + gmu + geqcb));
      // bjtload.c:825: BJTemitPrimeEmitPrimePtr += gpi + gepr + gm + go.
      stampG(solver, nodeE_int, nodeE_int, m * (gpi + gepr + gm + go));
      // bjtload.c:827: BJTbaseBasePrimePtr += -gx.
      stampG(solver, nodeB_ext, nodeB_int, m * -gx);
      // bjtload.c:832: BJTbasePrimeBasePtr += -gx.
      stampG(solver, nodeB_int, nodeB_ext, m * -gx);
      // bjtload.c:830: BJTcolPrimeBasePrimePtr += -gmu + gm.
      stampG(solver, nodeC_int, nodeB_int, m * (-gmu + gm));
      // bjtload.c:831: BJTcolPrimeEmitPrimePtr += -gm - go.
      stampG(solver, nodeC_int, nodeE_int, m * (-gm - go));
      // bjtload.c:833: BJTbasePrimeColPrimePtr += -gmu - geqcb.
      stampG(solver, nodeB_int, nodeC_int, m * (-gmu - geqcb));
      // bjtload.c:834: BJTbasePrimeEmitPrimePtr += -gpi.
      stampG(solver, nodeB_int, nodeE_int, m * -gpi);
      // bjtload.c:836: BJTemitPrimeColPrimePtr += -go + geqcb.
      stampG(solver, nodeE_int, nodeC_int, m * (-go + geqcb));
      // bjtload.c:837: BJTemitPrimeBasePrimePtr += -gpi - gm - geqcb.
      stampG(solver, nodeE_int, nodeB_int, m * (-gpi - gm - geqcb));
      // bjtload.c:838: BJTsubstSubstPtr += geqsub.
      stampG(solver, 0, 0, m * geqsub);
      // bjtload.c:839-840: BJTsubstConSubstPtr / BJTsubstSubstConPtr += -geqsub.
      stampG(solver, substConNode, 0, m * -geqsub);
      stampG(solver, 0, substConNode, m * -geqsub);
      // cite: bjtload.c:841-842 â€” BJTbaseColPrimePtr/BJTcolPrimeBasePtr target colPrime (nodeC_int), NOT colExt.
      stampG(solver, nodeB_ext, nodeC_int, m * -geqbx);
      stampG(solver, nodeC_int, nodeB_ext, m * -geqbx);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const s0 = pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      const voltages = ctx.rhsOld;
      const vBi = voltages[nodeB_int];
      const vCi = voltages[nodeC_int];
      const vEi = voltages[nodeE_int];
      const vbeRaw = polarity * (vBi - vEi);
      const vbcRaw = polarity * (vBi - vCi);

      if (icheckLimited) return false;

      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cc  = s0[base + SLOT_CC];
      const cb  = s0[base + SLOT_CB];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];

      const cchat = cc + (gm + go) * delvbe - (go + gmu) * delvbc;
      const cbhat = cb + gpi * delvbe + gmu * delvbc;

      const tolC = ctx.reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + ctx.iabstol;
      const tolB = ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + ctx.iabstol;

      return Math.abs(cchat - cc) <= tolC && Math.abs(cbhat - cb) <= tolB;
    },

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
    ): number {
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];
      let minDt = Infinity;
      {
        const dtBE = cktTerr(dt, deltaOld, order, method,
          s0[base + SLOT_QBE], s1[base + SLOT_QBE], s2[base + SLOT_QBE], s3[base + SLOT_QBE],
          s0[base + SLOT_CQBE], s1[base + SLOT_CQBE], lteParams);
        if (dtBE < minDt) minDt = dtBE;
      }
      {
        const dtBC = cktTerr(dt, deltaOld, order, method,
          s0[base + SLOT_QBC], s1[base + SLOT_QBC], s2[base + SLOT_QBC], s3[base + SLOT_QBC],
          s0[base + SLOT_CQBC], s1[base + SLOT_CQBC], lteParams);
        if (dtBC < minDt) minDt = dtBC;
      }
      if (tp.tSubSatCur > 0) {
        const dtCS = cktTerr(dt, deltaOld, order, method,
          s0[base + SLOT_QSUB], s1[base + SLOT_QSUB], s2[base + SLOT_QSUB], s3[base + SLOT_QSUB],
          s0[base + SLOT_CQSUB], s1[base + SLOT_CQSUB], lteParams);
        if (dtCS < minDt) minDt = dtCS;
      }
      return minDt;
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      const s0 = pool.states[0];
      const ic = polarity * s0[base + SLOT_CC];
      const ib = polarity * s0[base + SLOT_CB];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        tp = makeTp();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createBjtL1Element â€” outer factory capturing polarity and isLateral as
// closure constants. BJT vertical/lateral topology is a model variant (see
// modelRegistry "spice" vs "spice-lateral"), not a runtime parameter â€” so
// `isLateral` is set once at element construction rather than read per-load.
// ---------------------------------------------------------------------------

export function createBjtL1Element(polarity: 1 | -1, isLateral: boolean): AnalogFactory {
  return (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
    createSpiceL1BjtElement(polarity, isLateral, pinNodes, internalNodeIds, branchIdx, props);
}

// ---------------------------------------------------------------------------
// getSpiceL1InternalNodeCount / Labels
// ---------------------------------------------------------------------------

function getSpiceL1InternalNodeCount(props: PropertyBag): number {
  let count = 0;
  if (props.getModelParam<number>("RB") > 0) count++;
  if (props.getModelParam<number>("RC") > 0) count++;
  if (props.getModelParam<number>("RE") > 0) count++;
  return count;
}

function getSpiceL1InternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  if (props.getModelParam<number>("RB") > 0) labels.push("B'");
  if (props.getModelParam<number>("RC") > 0) labels.push("C'");
  if (props.getModelParam<number>("RE") > 0) labels.push("E'");
  return labels;
}

// ---------------------------------------------------------------------------
// NpnBjtElement + PnpBjtElement â€” visual classes (unchanged)
// ---------------------------------------------------------------------------

export class NpnBjtElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NpnBJT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNpnPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4.0,
      height: 2.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vB = signals?.getPinVoltage("B");
    const vC = signals?.getPinVoltage("C");
    const vE = signals?.getPinVoltage("E");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);
    drawColoredLead(ctx, signals, vC, 3.1875, -0.375, 4, -1);
    drawColoredLead(ctx, signals, vE, 3.1875, 0.375, 4, 1);

    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 4, y: 1 },
      { x: 3.75, y: 0.5 },
      { x: 3.4375, y: 0.875 },
    ], true);

    ctx.restore();
  }
}

export class PnpBjtElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PnpBJT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPnpPinDeclarations(), []);
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
    const vB = signals?.getPinVoltage("B");
    const vC = signals?.getPinVoltage("C");
    const vE = signals?.getPinVoltage("E");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);
    drawColoredLead(ctx, signals, vC, 3.1875, 0.375, 4, 1);
    drawColoredLead(ctx, signals, vE, 3.1875, -0.375, 4, -1);

    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 3.3125, y: -0.3125 },
      { x: 3.8125, y: -0.5 },
      { x: 3.5, y: -0.875 },
    ], true);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layouts
// ---------------------------------------------------------------------------

function buildNpnPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

function buildPnpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "E",
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

const BJT_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const BJT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
// ComponentDefinitions
// ---------------------------------------------------------------------------

function npnCircuitFactory(props: PropertyBag): NpnBjtElement {
  return new NpnBjtElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pnpCircuitFactory(props: PropertyBag): PnpBjtElement {
  return new PnpBjtElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NpnBjtDefinition: ComponentDefinition = {
  name: "NpnBJT",
  typeId: -1,
  factory: npnCircuitFactory,
  pinLayout: buildNpnPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN BJT â€” Gummel-Poon Level 2 bipolar junction transistor.\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "simple": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_NPN_DEFAULTS,
    },
    "spice": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_NPN_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "spice-lateral": {
      kind: "inline",
      factory: createBjtL1Element(1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_NPN_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N3904": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N3904,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "BC547B": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_BC547B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2222A": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2222A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2219A": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2219A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
  },
  defaultModel: "spice",
};

export const PnpBjtDefinition: ComponentDefinition = {
  name: "PnpBJT",
  typeId: -1,
  factory: pnpCircuitFactory,
  pinLayout: buildPnpPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP BJT â€” Gummel-Poon Level 2 bipolar junction transistor (PNP polarity).\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "simple": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, branchIdx, props, _getTime) =>
        createBjtElement(-1, pinNodes, branchIdx, props),
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_PNP_DEFAULTS,
    },
    "spice": {
      kind: "inline",
      factory: createBjtL1Element(-1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_PNP_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "spice-lateral": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_PNP_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N3906": {
      kind: "inline",
      factory: createBjtL1Element(-1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N3906,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "BC557B": {
      kind: "inline",
      factory: createBjtL1Element(-1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_BC557B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2907A": {
      kind: "inline",
      factory: createBjtL1Element(-1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N2907A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "TIP32C": {
      kind: "inline",
      factory: createBjtL1Element(-1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_TIP32C,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
  },
  defaultModel: "spice",
};
