/**
 * BJT analog components — NPN and PNP bipolar junction transistors.
 *
 * Implements the Gummel-Poon Level 2 model with:
 *   - Forward and reverse Ebers-Moll currents
 *   - Early effect via VAF/VAR
 *   - High-injection limiting via IKF/IKR
 *   - Non-ideal base current via ISE/ISC
 *   - Voltage limiting via pnjlim() on both B-E and B-C junctions
 *
 * PNP is implemented as the NPN model with polarity = -1, which inverts all
 * junction voltage signs and current directions.
 *
 * MNA stamp convention for a 3-terminal device (C, B, E):
 *   The linearized Gummel-Poon model produces conductances between the
 *   three terminals plus Norton current sources.
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
import type { IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, deviceParams } from "../../core/model-params.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { computeJunctionCapacitance } from "./diode.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import type { ReactiveAnalogElementCore } from "../../solver/analog/element.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// BJ1: VT import removed — all code now uses tp.vt (temperature-dependent thermal voltage)

/** Minimum conductance for numerical stability. */
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
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
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
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
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
    RB:  { default: 0,      unit: "Ω", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Ω", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Ω", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Ω", description: "Emitter resistance" },
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
    PTF: { default: 0,      unit: "°", description: "Excess phase at freq=1/(2π·TF)" },
    TR:  { default: 0,      unit: "s", description: "Reverse transit time" },
    CJS: { default: 0,      unit: "F", description: "Collector-substrate zero-bias capacitance" },
    VJS: { default: 0.75,   unit: "V", description: "Substrate junction built-in potential" },
    MJS: { default: 0,      description: "Substrate junction exponential factor" },
    XTB: { default: 0,      description: "Forward/reverse beta temperature exponent" },
    EG:  { default: 1.11,   unit: "eV", description: "Energy gap for temperature effect on IS" },
    XTI: { default: 3,      description: "Saturation current temperature exponent" },
    KF:  { default: 0,      description: "Flicker noise coefficient" },
    AF:  { default: 1,      description: "Flicker noise exponent" },
    NKF: { default: 0.5,    description: "High-injection roll-off exponent" },
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
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
    RB:  { default: 0,      unit: "Ω", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Ω", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Ω", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Ω", description: "Emitter resistance" },
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
    PTF: { default: 0,      unit: "°", description: "Excess phase at freq=1/(2π·TF)" },
    TR:  { default: 0,      unit: "s", description: "Reverse transit time" },
    CJS: { default: 0,      unit: "F", description: "Collector-substrate zero-bias capacitance" },
    VJS: { default: 0.75,   unit: "V", description: "Substrate junction built-in potential" },
    MJS: { default: 0,      description: "Substrate junction exponential factor" },
    XTB: { default: 0,      description: "Forward/reverse beta temperature exponent" },
    EG:  { default: 1.11,   unit: "eV", description: "Energy gap for temperature effect on IS" },
    XTI: { default: 3,      description: "Saturation current temperature exponent" },
    KF:  { default: 0,      description: "Flicker noise coefficient" },
    AF:  { default: 1,      description: "Flicker noise exponent" },
    NKF: { default: 0.5,    description: "High-injection roll-off exponent" },
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature" },
  },
});

// ---------------------------------------------------------------------------
// Built-in NPN model presets
// Sources: Fairchild/Philips/NXP extracted models from LTspice standard.bjt
// ---------------------------------------------------------------------------

/** Small signal general purpose NPN. Source: Fairchild extracted. */
const NPN_2N3904 = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 6.734e-15, BF: 416.4, NF: 1.0, BR: 0.7371, NR: 1.0,
  VAF: 74.03, IKF: 0.06678, IKR: 0, ISE: 6.734e-15, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 2.65e-11, VJE: 0.65, MJE: 0.33, CJC: 3.59e-12, VJC: 0.75, MJC: 0.33,
  TF: 3.97e-10, TR: 5e-8, FC: 0.5,
});

/** Small signal NPN (European, B-grade). Source: NXP extracted. */
const NPN_BC547B = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 2.39e-14, BF: 294.3, NF: 1.008, BR: 7.946, NR: 1.004,
  VAF: 63.2, IKF: 0.1357, IKR: 0.1144, ISE: 3.545e-15, ISC: 6.272e-14, VAR: 25.9,
  RB: 10, RC: 1, RE: 0, NE: 1.48, NC: 2,
  CJE: 1.12e-11, VJE: 0.72, MJE: 0.33, CJC: 4.43e-12, VJC: 0.72, MJC: 0.33,
  TF: 4.26e-10, TR: 5e-8, FC: 0.5,
});

/** General purpose NPN. Source: Fairchild extracted. */
const NPN_2N2222A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 2.24e-11, VJE: 0.75, MJE: 0.33, CJC: 7.31e-12, VJC: 0.75, MJC: 0.33,
  TF: 4.11e-10, TR: 4.6e-8, FC: 0.5,
});

/** Medium power NPN (TO-39, same die as 2N2222A). Source: Philips/LTspice. */
const NPN_2N2219A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 14.34e-15, BF: 255.9, NF: 1.0, BR: 6.092, NR: 1.0,
  VAF: 74.03, IKF: 0.2847, IKR: 0, ISE: 14.34e-15, ISC: 0, VAR: 100,
});

// ---------------------------------------------------------------------------
// Built-in PNP model presets
// Sources: Fairchild/Philips/NXP extracted models, Central Semiconductor
// ---------------------------------------------------------------------------

/** Small signal PNP (complement of 2N3904). Source: Fairchild extracted. */
const PNP_2N3906 = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 1.41e-15, BF: 180.7, NF: 1.0, BR: 4.977, NR: 1.0,
  VAF: 18.7, IKF: 0.08, IKR: 0, ISE: 0, ISC: 0, VAR: 100,
  RB: 10, RC: 1, RE: 0, NE: 1.5, NC: 2,
  CJE: 4.49e-12, VJE: 0.66, MJE: 0.33, CJC: 1.95e-11, VJC: 0.75, MJC: 0.33,
  TF: 1e-9, TR: 1e-7, FC: 0.5,
});

/** Small signal PNP (European, B-grade, complement of BC547B). Source: NXP extracted. */
const PNP_BC557B = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 3.83e-14, BF: 344.4, NF: 1.008, BR: 14.84, NR: 1.005,
  VAF: 21.11, IKF: 0.08039, IKR: 0.047, ISE: 1.22e-14, ISC: 2.85e-13, VAR: 32.02,
});

/** General purpose PNP (complement of 2N2222). Source: Philips extracted. */
const PNP_2N2907A = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 650.6e-18, BF: 231.7, NF: 1.0, BR: 3.563, NR: 1.0,
  VAF: 115.7, IKF: 1.079, IKR: 0, ISE: 54.81e-15, ISC: 0, VAR: 100,
});

/** Medium power PNP. Source: Central Semiconductor Corp TIP32C.LIB. */
const PNP_TIP32C = deviceParams(BJT_SPICE_L1_PARAM_DEFS, {
  IS: 1.8111e-12, BF: 526.98, NF: 1.0, BR: 1.1294, NR: 1.0,
  VAF: 100, IKF: 0.95034, IKR: 0.15869, ISE: 68.670e-12, ISC: 409.26e-9, VAR: 100,
});

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Temperature / area scaling — maps to bjttemp.c:158-257
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
  // BJ2: Pre-computed inverse Early voltages
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
  // BJ10: Temperature-adjusted substrate cap
  tSubcap: number;
  tSubpot: number;
  // BJ11: Temperature-adjusted substrate saturation current
  tSubSatCur: number;
  // BJ12: Temperature-adjusted transit times and junction exponents
  ttransitTimeF: number;
  ttransitTimeR: number;
  tjunctionExpBE: number;
  tjunctionExpBC: number;
  tjunctionExpSub: number;
  // BJ7: Excess phase factor
  excessPhaseFactor: number;
}

function computeBjtTempParams(p: {
  IS: number; BF: number; BR: number; ISE: number; ISC: number;
  NE: number; NC: number; EG: number; XTI: number; XTB: number;
  IKF: number; IKR: number; RC: number; RE: number; RB: number; RBM: number;
  IRB: number; CJE: number; VJE: number; MJE: number;
  CJC: number; VJC: number; MJC: number; CJS: number; VJS: number; MJS: number;
  FC: number; AREA: number; TNOM: number;
  // BJ2: Early voltage inputs
  VAF: number; VAR: number;
  // BJ7/BJ12: Excess phase and transit time inputs
  PTF: number; TF: number; TR: number;
}, T: number = 300.15): BjtTempParams {
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

  // BJ2: Pre-computed inverse Early voltages
  const tinvEarlyVoltF = (p.VAF > 0 && isFinite(p.VAF)) ? 1 / p.VAF : 0;
  const tinvEarlyVoltR = (p.VAR > 0 && isFinite(p.VAR)) ? 1 / p.VAR : 0;

  const tcollectorConduct = p.RC > 0 ? 1 / p.RC : 0;
  const temitterConduct = p.RE > 0 ? 1 / p.RE : 0;
  const tbaseResist = p.RB;
  const tminBaseResist = p.RBM > 0 ? p.RBM : p.RB;
  const tbaseCurrentHalfResist = p.IRB;

  // Junction cap temp adjustment (bjttemp.c:202-255, tlevc=0)
  const xfc = Math.log(1 - p.FC);

  // B-E junction
  const pbo_be = (p.VJE - pbfact) / fact1;
  const gmaold_be = (p.VJE - pbo_be) / pbo_be;
  let tBEcap = p.CJE / (1 + p.MJE * (4e-4 * (p.TNOM - REFTEMP) - gmaold_be));
  const tBEpot = fact2 * pbo_be + pbfact;
  const gmanew_be = (tBEpot - pbo_be) / pbo_be;
  tBEcap *= 1 + p.MJE * (4e-4 * (T - REFTEMP) - gmanew_be);

  // B-C junction
  const pbo_bc = (p.VJC - pbfact) / fact1;
  const gmaold_bc = (p.VJC - pbo_bc) / pbo_bc;
  let tBCcap = p.CJC / (1 + p.MJC * (4e-4 * (p.TNOM - REFTEMP) - gmaold_bc));
  const tBCpot = fact2 * pbo_bc + pbfact;
  const gmanew_bc = (tBCpot - pbo_bc) / pbo_bc;
  tBCcap *= 1 + p.MJC * (4e-4 * (T - REFTEMP) - gmanew_bc);

  // BJ10: Substrate junction cap temp adjustment (same tlevc=0 scaling)
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

  // BJ11: Substrate saturation current (same temp scaling as main IS)
  const tSubSatCur = p.IS * factor;

  const tDepCap = p.FC * tBEpot;
  const tf1 = tBEpot * (1 - Math.exp((1 - p.MJE) * xfc)) / (1 - p.MJE);
  const f2 = Math.exp((1 + p.MJE) * xfc);
  const f3 = 1 - p.FC * (1 + p.MJE);
  const tf4 = p.FC * tBCpot;
  const tf5 = tBCpot * (1 - Math.exp((1 - p.MJC) * xfc)) / (1 - p.MJC);
  const f6 = Math.exp((1 + p.MJC) * xfc);
  const f7 = 1 - p.FC * (1 + p.MJC);

  const tVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCur * p.AREA));

  // BJ12: Temperature-adjusted transit times and junction exponents
  // With default polynomial coefficients = 0, these equal raw params
  const ttransitTimeF = p.TF;
  const ttransitTimeR = p.TR;
  const tjunctionExpBE = p.MJE;
  const tjunctionExpBC = p.MJC;
  const tjunctionExpSub = p.MJS;

  // BJ7: Excess phase factor = (PTF / (180/PI)) * TF
  const excessPhaseFactor = (p.PTF > 0 && p.TF > 0) ? (p.PTF / (180 / Math.PI)) * p.TF : 0;

  return {
    vt, tSatCur, tBetaF, tBetaR, tBEleakCur, tBCleakCur,
    tinvRollOffF, tinvRollOffR, tinvEarlyVoltF, tinvEarlyVoltR,
    tcollectorConduct, temitterConduct,
    tbaseResist, tminBaseResist, tbaseCurrentHalfResist,
    tBEcap, tBEpot, tBCcap, tBCpot, tDepCap, tf1, f2, f3, tf4, tf5, f6, f7,
    tVcrit, tSubcap, tSubpot, tSubSatCur,
    ttransitTimeF, ttransitTimeR, tjunctionExpBE, tjunctionExpBC, tjunctionExpSub,
    excessPhaseFactor,
  };
}

// ---------------------------------------------------------------------------
// Gummel-Poon model helper types
// ---------------------------------------------------------------------------

interface BjtOperatingPoint {
  /** Base-emitter junction voltage (signed, polarity-applied). */
  vbe: number;
  /** Base-collector junction voltage (signed, polarity-applied). */
  vbc: number;
  /** Collector current. */
  ic: number;
  /** Base current. */
  ib: number;
  /** Transconductance dIc/dVbe. */
  gm: number;
  /** Output conductance dIc/dVce = dIc/dVbc. */
  go: number;
  /** Input conductance dIb/dVbe. */
  gpi: number;
  /** Feedback conductance dIb/dVbc. */
  gmu: number;
  // BJ6/BJ8: Operating point storage for geqcb and base resistance
  cbe: number;
  gbe: number;
  dqbdvc: number;
  dqbdve: number;
  qb: number;
}

// ---------------------------------------------------------------------------
// computeBjtOp — Gummel-Poon operating point
// ---------------------------------------------------------------------------

// csat  = tSatCur * AREA   (area-scaled saturation current)
// betaF = tBetaF            (temp-adjusted forward beta)
// betaR = tBetaR            (temp-adjusted reverse beta)
// c2    = tBEleakCur * AREA (area-scaled B-E leakage current)
// c4    = tBCleakCur * AREA (area-scaled B-C leakage current)
// oik   = tinvRollOffF / AREA  (area-scaled 1/IKF)
// oikr  = tinvRollOffR / AREA  (area-scaled 1/IKR)
// BJ1: vt parameter added (temperature-dependent thermal voltage)
// BJ2: tinvEarlyVoltF/R replace VAF/VAR
function computeBjtOp(
  vbe: number,
  vbc: number,
  csat: number,
  betaF: number,
  NF: number,
  betaR: number,
  NR: number,
  c2: number,
  c4: number,
  tinvEarlyVoltF: number,
  tinvEarlyVoltR: number,
  oik: number,
  oikr: number,
  vt: number,
): BjtOperatingPoint {
  const nfVt = NF * vt;
  const nrVt = NR * vt;

  // Forward and reverse junction currents and conductances (ngspice bjtload.c:398-420)
  // Polynomial approximation for reverse-bias (vbe < -3*nfVt)
  let If: number, gbe: number;
  if (vbe >= -3 * nfVt) {
    const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
    If = csat * (expVbe - 1);
    gbe = csat * expVbe / nfVt;
  } else {
    const arg = 3 * nfVt / (vbe * Math.E);
    const arg3 = arg * arg * arg;
    If = -csat * (1 + arg3);
    gbe = csat * 3 * arg3 / vbe;
  }

  let Ir: number, gbc: number;
  if (vbc >= -3 * nrVt) {
    const expVbc = Math.exp(Math.min(vbc / nrVt, 700));
    Ir = csat * (expVbc - 1);
    gbc = csat * expVbc / nrVt;
  } else {
    const arg = 3 * nrVt / (vbc * Math.E);
    const arg3 = arg * arg * arg;
    Ir = -csat * (1 + arg3);
    gbc = csat * 3 * arg3 / vbc;
  }

  // BJ2: Base charge factor qb (Early effect + high injection) using pre-computed tinvEarlyVolt
  const q1 = 1 / (1 - tinvEarlyVoltF * vbc - tinvEarlyVoltR * vbe);
  const q2 = If * oik + Ir * oikr;
  const sqrtTerm = Math.sqrt(Math.max(1 + 4 * q2, 1e-30));
  const qb = q1 * (1 + sqrtTerm) / 2;

  // Transport current (used for Jacobian dqb terms, NOT terminal ic)
  const iTransport = (If - Ir) / qb;

  // BJ4: Non-ideal BC current computation moved before ic for -cbcn subtraction
  const ibcNonIdealForIc = (c4 > 0 ? c4 * (Math.exp(Math.min(vbc / nrVt, 700)) - 1) : 0) + GMIN * vbc;

  // Terminal collector current: transport - reverse base - cbcn (ngspice cc)
  const ic = iTransport - Ir / betaR - ibcNonIdealForIc;

  // Non-ideal base current contributions (c2, c4 with emission coefficients)
  // For simplicity we use NF and NR for c2/c4 emission (Level 1 approximation)
  const ibIdeal = If / betaF + Ir / betaR;
  const ibNonIdeal =
    (c2 > 0 ? c2 * (Math.exp(Math.min(vbe / nfVt, 700)) - 1) : 0) +
    (c4 > 0 ? c4 * (Math.exp(Math.min(vbc / nrVt, 700)) - 1) : 0);
  // GMIN current contributions to base (ngspice cben/cbcn)
  const ib = ibIdeal + ibNonIdeal + GMIN * vbe + GMIN * vbc;

  // Linearized conductances via chain rule
  const dIfdVbe = gbe;
  const dIrdVbc = gbc;

  // dqb/dVbe and dqb/dVbc (Early effect + high injection Jacobian)
  // BJ2: derivatives use tinvEarlyVolt
  const dq1dVbe = q1 * q1 * tinvEarlyVoltR;
  const dq1dVbc = q1 * q1 * tinvEarlyVoltF;
  const dqbdVbe = dq1dVbe * (1 + sqrtTerm) / 2 + q1 / sqrtTerm * oik * dIfdVbe;
  const dqbdVbc = dq1dVbc * (1 + sqrtTerm) / 2 + q1 / sqrtTerm * oikr * dIrdVbc;

  // Transconductance and output conductance use transport current for dqb terms (Fix 3)
  const gm = dIfdVbe / qb - iTransport * dqbdVbe / qb;
  const go = dIrdVbc / qb + iTransport * dqbdVbc / qb;

  // Input/feedback conductances with GMIN on non-ideal terms (ngspice gben/gbcn)
  const gpi = dIfdVbe / betaF + (c2 > 0 ? c2 * Math.exp(Math.min(vbe / nfVt, 700)) / nfVt : 0) + GMIN;
  const gmu = dIrdVbc / betaR + (c4 > 0 ? c4 * Math.exp(Math.min(vbc / nrVt, 700)) / nrVt : 0) + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu, cbe: 0, gbe, dqbdvc: dqbdVbc, dqbdve: dqbdVbe, qb };
}

// ---------------------------------------------------------------------------
// State schema — BJT simple (10 slots)
// ---------------------------------------------------------------------------

const BJT_SIMPLE_SCHEMA: StateSchema = defineStateSchema("BjtSimpleElement", [
  { name: "VBE",       doc: "pnjlim-limited B-E junction voltage",          init: { kind: "fromParams", compute: (_p) => _p["polarity"] === 1 ? 0.6 : -0.6 } },
  { name: "VBC",       doc: "pnjlim-limited B-C junction voltage",          init: { kind: "zero" } },
  { name: "GPI",       doc: "dIb/dVbe input conductance",                   init: { kind: "zero" } },
  { name: "GMU",       doc: "dIb/dVbc feedback conductance",                init: { kind: "zero" } },
  { name: "GM",        doc: "dIc/dVbe transconductance",                    init: { kind: "zero" } },
  { name: "GO",        doc: "dIc/dVce output conductance",                  init: { kind: "zero" } },
  { name: "IC",        doc: "Collector current at operating point",         init: { kind: "zero" } },
  { name: "IB",        doc: "Base current at operating point",              init: { kind: "zero" } },
  { name: "IC_NORTON", doc: "Norton collector current for MNA stamp",       init: { kind: "zero" } },
  { name: "IB_NORTON", doc: "Norton base current for MNA stamp",            init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createBjtElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createBjtElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  _branchIdx: number,
  props: PropertyBag,
): ReactiveAnalogElementCore {
  const nodeB = pinNodes.get("B")!; // base
  const nodeC = pinNodes.get("C")!; // collector
  const nodeE = pinNodes.get("E")!; // emitter

  // Read model parameters from the PropertyBag model param partition.
  // Guaranteed populated by compiler via replaceModelParams() before factory invocation.
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
    AREA: props.getModelParam<number>("AREA"),
    M: props.getModelParam<number>("M"),
    TNOM: props.getModelParam<number>("TNOM"),
  };

  // Simple model doesn't have L1 params — supply defaults for computeBjtTempParams
  function makeTp(): BjtTempParams {
    return computeBjtTempParams({
      IS: params.IS, BF: params.BF, BR: params.BR,
      ISE: params.ISE, ISC: params.ISC,
      NE: 1.5, NC: 2.0, EG: 1.11, XTI: 3, XTB: 0,
      IKF: params.IKF, IKR: params.IKR,
      RC: 0, RE: 0, RB: 0, RBM: 0, IRB: 0,
      CJE: 0, VJE: 0.75, MJE: 0.33,
      CJC: 0, VJC: 0.75, MJC: 0.33,
      CJS: 0, VJS: 0.75, MJS: 0,
      FC: 0.5, AREA: params.AREA, TNOM: params.TNOM,
      VAF: params.VAF, VAR: params.VAR,
      PTF: 0, TF: 0, TR: 0,
    });
  }
  let tp = makeTp();

  // State pool slot indices (BJT simple, stateSize: 10)
  const SLOT_VBE = 0;
  const SLOT_VBC = 1;
  const SLOT_GPI = 2;
  const SLOT_GMU = 3;
  const SLOT_GM  = 4;
  const SLOT_GO  = 5;
  const SLOT_IC  = 6;
  const SLOT_IB  = 7;
  const SLOT_IC_NORTON = 8;
  const SLOT_IB_NORTON = 9;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, BJTload sets CKTnoncon++)
  let icheckLimited = false;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true as const,
    poolBacked: true as const,
    stateSchema: BJT_SIMPLE_SCHEMA,
    stateSize: BJT_SIMPLE_SCHEMA.size,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(BJT_SIMPLE_SCHEMA, pool, base, { polarity });
      const op0 = computeBjtOp(
        0, 0,
        tp.tSatCur * params.AREA, tp.tBetaF, params.NF, tp.tBetaR, params.NR,
        tp.tBEleakCur * params.AREA, tp.tBCleakCur * params.AREA,
        tp.tinvEarlyVoltF, tp.tinvEarlyVoltR,
        tp.tinvRollOffF / params.AREA, tp.tinvRollOffR / params.AREA,
        tp.vt,
      );
      s0[base + SLOT_GPI] = op0.gpi;
      s0[base + SLOT_GMU] = op0.gmu;
      s0[base + SLOT_GM]  = op0.gm;
      s0[base + SLOT_GO]  = op0.go;
      s0[base + SLOT_IC]  = op0.ic;
      s0[base + SLOT_IB]  = op0.ib;
      s0[base + SLOT_IC_NORTON] = op0.ic - op0.gm * 0 + op0.go * 0;
      s0[base + SLOT_IB_NORTON] = op0.ib - op0.gpi * 0 - op0.gmu * 0;
    },

    stamp(_solver: SparseSolver): void {
      // No linear (topology-constant) contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      // BJ5: M multiplier on all stamps
      const m = params.M;

      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const icNorton = s0[base + SLOT_IC_NORTON];
      const ibNorton = s0[base + SLOT_IB_NORTON];
      const ieNorton = -(icNorton + ibNorton);

      // Stamp conductances (gpi between B-E, gmu between B-C, go between C-E)
      // gpi between B and E
      stampG(solver, nodeB, nodeB, m * gpi);
      stampG(solver, nodeB, nodeE, m * -gpi);
      stampG(solver, nodeE, nodeB, m * -gpi);
      stampG(solver, nodeE, nodeE, m * gpi);

      // gmu between B and C
      stampG(solver, nodeB, nodeB, m * gmu);
      stampG(solver, nodeB, nodeC, m * -gmu);
      stampG(solver, nodeC, nodeB, m * -gmu);
      stampG(solver, nodeC, nodeC, m * gmu);

      // go between C and E
      stampG(solver, nodeC, nodeC, m * go);
      stampG(solver, nodeC, nodeE, m * -go);
      stampG(solver, nodeE, nodeC, m * -go);
      stampG(solver, nodeE, nodeE, m * go);

      // gm*vbe transconductance: gm stamps in C-E cross terms
      stampG(solver, nodeC, nodeB, m * gm);
      stampG(solver, nodeC, nodeE, m * -gm);
      stampG(solver, nodeE, nodeB, m * -gm);
      stampG(solver, nodeE, nodeE, m * gm);

      // Norton RHS at each terminal
      stampRHS(solver, nodeC, m * -polarity * icNorton);
      stampRHS(solver, nodeB, m * -polarity * ibNorton);
      stampRHS(solver, nodeE, m * -polarity * ieNorton);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): boolean {
      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // BJ1: pnjlim uses tp.vt (temperature-dependent)
      const vcritBE = tp.tVcrit;
      const vcritBC = tp.tVcrit;

      // Junction voltages (polarity-corrected for PNP)
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      // Apply pnjlim to both junctions using vold from pool
      const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, vcritBE);
      const vbeLimited = vbeResult.value;
      const vbeLimFlag = vbeResult.limited;
      const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], tp.vt, vcritBC);
      const vbcLimited = vbcResult.value;
      icheckLimited = vbeLimFlag || vbcResult.limited;

      s0[base + SLOT_VBE] = vbeLimited;
      s0[base + SLOT_VBC] = vbcLimited;

      const op = computeBjtOp(
        vbeLimited, vbcLimited,
        tp.tSatCur * params.AREA, tp.tBetaF, params.NF, tp.tBetaR, params.NR,
        tp.tBEleakCur * params.AREA, tp.tBCleakCur * params.AREA,
        tp.tinvEarlyVoltF, tp.tinvEarlyVoltR,
        tp.tinvRollOffF / params.AREA, tp.tinvRollOffR / params.AREA,
        tp.vt,
      );

      s0[base + SLOT_GPI] = op.gpi;
      s0[base + SLOT_GMU] = op.gmu;
      s0[base + SLOT_GM]  = op.gm;
      s0[base + SLOT_GO]  = op.go;
      s0[base + SLOT_IC]  = op.ic;
      s0[base + SLOT_IB]  = op.ib;
      s0[base + SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + (op.gmu + op.go) * vbcLimited;
      s0[base + SLOT_IB_NORTON] = op.ib - op.gpi * vbeLimited - op.gmu * vbcLimited;
      return icheckLimited;
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];

      // ngspice icheck: if any junction was limited by pnjlim, declare non-converged
      if (icheckLimited) return false;

      // ngspice BJTconvTest: predict currents from linearisation, check tolerance
      const cc  = s0[base + SLOT_IC];
      const cb  = s0[base + SLOT_IB];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];

      const cchat = cc + (gm + go) * delvbe - (go + gmu) * delvbc;
      const cbhat = cb + gpi * delvbe + gmu * delvbc;

      const tolC = reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + abstol;
      const tolB = reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + abstol;

      return Math.abs(cchat - cc) <= tolC && Math.abs(cbhat - cb) <= tolB;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinNodeIds order: [nodeB, nodeC, nodeE] (pinLayout order: [B, C, E])
      // Positive = current flowing INTO element at that pin.
      const ic = polarity * s0[base + SLOT_IC];
      const ib = polarity * s0[base + SLOT_IB];
      const ie = -(ic + ib); // KCL: ib + ic + ie = 0
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
// computeSpiceL1BjtOp — Gummel-Poon with separate NE/NC emission coefficients
// ---------------------------------------------------------------------------

// csat  = tSatCur * AREA       (area-scaled saturation current)
// betaF = tBetaF               (temp-adjusted forward beta)
// betaR = tBetaR               (temp-adjusted reverse beta)
// c2    = tBEleakCur * AREA    (area-scaled B-E leakage current)
// c4    = tBCleakCur * AREA    (area-scaled B-C leakage current)
// oik   = tinvRollOffF / AREA  (area-scaled 1/IKF)
// oikr  = tinvRollOffR / AREA  (area-scaled 1/IKR)
// BJ1: vt parameter added (temperature-dependent thermal voltage)
// BJ2: tinvEarlyVoltF/R replace VAF/VAR
// BJ3: NKF parameter added for generalized base charge
function computeSpiceL1BjtOp(
  vbe: number,
  vbc: number,
  csat: number,
  betaF: number,
  NF: number,
  betaR: number,
  NR: number,
  c2: number,
  c4: number,
  NE: number,
  NC: number,
  tinvEarlyVoltF: number,
  tinvEarlyVoltR: number,
  oik: number,
  oikr: number,
  vt: number,
  NKF: number,
): BjtOperatingPoint {
  const nfVt = NF * vt;
  const nrVt = NR * vt;
  const neVt = NE * vt;
  const ncVt = NC * vt;

  // Forward and reverse junction currents and conductances (ngspice bjtload.c:398-420)
  let If: number, gbe: number;
  if (vbe >= -3 * nfVt) {
    const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
    If = csat * (expVbe - 1);
    gbe = csat * expVbe / nfVt;
  } else {
    const arg = 3 * nfVt / (vbe * Math.E);
    const arg3 = arg * arg * arg;
    If = -csat * (1 + arg3);
    gbe = csat * 3 * arg3 / vbe;
  }

  let Ir: number, gbc: number;
  if (vbc >= -3 * nrVt) {
    const expVbc = Math.exp(Math.min(vbc / nrVt, 700));
    Ir = csat * (expVbc - 1);
    gbc = csat * expVbc / nrVt;
  } else {
    const arg = 3 * nrVt / (vbc * Math.E);
    const arg3 = arg * arg * arg;
    Ir = -csat * (1 + arg3);
    gbc = csat * 3 * arg3 / vbc;
  }

  // BJ2: Base charge factor using pre-computed inverse Early voltages
  const q1 = 1 / (1 - tinvEarlyVoltF * vbc - tinvEarlyVoltR * vbe);
  const q2 = If * oik + Ir * oikr;

  // BJ3: NKF-generalized base charge (L1 only)
  const arg_qb = Math.max(0, 1 + 4 * q2);
  const sqarg = (NKF === 0.5) ? Math.sqrt(arg_qb) : Math.pow(arg_qb, NKF);
  const qb = q1 * (1 + sqarg) / 2;

  // Transport current (for Jacobian dqb terms)
  const iTransport = (If - Ir) / qb;

  // BJ4: Non-ideal BC current must be computed BEFORE ic for -cbcn subtraction
  let ibcNonIdeal: number, gbcn: number;
  if (c4 > 0) {
    if (vbc >= -3 * ncVt) {
      const expVbcNC = Math.exp(Math.min(vbc / ncVt, 700));
      ibcNonIdeal = c4 * (expVbcNC - 1);
      gbcn = c4 * expVbcNC / ncVt;
    } else {
      const arg = 3 * ncVt / (vbc * Math.E);
      const arg3 = arg * arg * arg;
      ibcNonIdeal = -c4 * (1 + arg3);
      gbcn = c4 * 3 * arg3 / vbc;
    }
  } else {
    ibcNonIdeal = 0;
    gbcn = 0;
  }

  // BJ4: Terminal collector current with -cbcn (ngspice cc)
  const ic = iTransport - Ir / betaR - (ibcNonIdeal + GMIN * vbc);

  // Non-ideal BE base current: c2 uses NE emission
  let ibeNonIdeal: number, gben: number;
  if (c2 > 0) {
    if (vbe >= -3 * neVt) {
      const expVbeNE = Math.exp(Math.min(vbe / neVt, 700));
      ibeNonIdeal = c2 * (expVbeNE - 1);
      gben = c2 * expVbeNE / neVt;
    } else {
      const arg = 3 * neVt / (vbe * Math.E);
      const arg3 = arg * arg * arg;
      ibeNonIdeal = -c2 * (1 + arg3);
      gben = c2 * 3 * arg3 / vbe;
    }
  } else {
    ibeNonIdeal = 0;
    gben = 0;
  }

  const ibIdeal = If / betaF + Ir / betaR;
  // GMIN current contributions (ngspice cben/cbcn include GMIN*v terms)
  const ib = ibIdeal + ibeNonIdeal + ibcNonIdeal + GMIN * vbe + GMIN * vbc;

  // Linearized conductances
  const dIfdVbe = gbe;
  const dIrdVbc = gbc;

  // BJ3: NKF-generalized derivatives
  // BJ2: derivatives use tinvEarlyVolt
  const dq1dVbe = q1 * q1 * tinvEarlyVoltR;
  const dq1dVbc = q1 * q1 * tinvEarlyVoltF;

  let dqbdVbe: number, dqbdVbc: number;
  if (NKF === 0.5) {
    const sqrtSafe = Math.max(sqarg, 1e-30);
    dqbdVbe = dq1dVbe * (1 + sqarg) / 2 + q1 * oik * dIfdVbe / sqrtSafe;
    dqbdVbc = dq1dVbc * (1 + sqarg) / 2 + q1 * oikr * dIrdVbc / sqrtSafe;
  } else {
    const argSafe = Math.max(arg_qb, 1e-30);
    const dSqdVbe = 2 * sqarg * NKF / argSafe * oik * dIfdVbe;
    const dSqdVbc = 2 * sqarg * NKF / argSafe * oikr * dIrdVbc;
    dqbdVbe = dq1dVbe * (1 + sqarg) / 2 + q1 * dSqdVbe;
    dqbdVbc = dq1dVbc * (1 + sqarg) / 2 + q1 * dSqdVbc;
  }

  // Transconductance and output conductance use transport current for dqb terms
  const gm = dIfdVbe / qb - iTransport * dqbdVbe / qb;
  const go = dIrdVbc / qb + iTransport * dqbdVbc / qb;

  // Input/feedback conductances: gben/gbcn include GMIN (ngspice approach)
  const gpi = dIfdVbe / betaF + gben + GMIN;
  const gmu = dIrdVbc / betaR + gbcn + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu, cbe: 0, gbe, dqbdvc: dqbdVbc, dqbdve: dqbdVbe, qb };
}

// ---------------------------------------------------------------------------
// State schema — BJT SPICE L1 (33 slots)
// ---------------------------------------------------------------------------

const BJT_L1_SCHEMA: StateSchema = defineStateSchema("BjtSpiceL1Element", [
  { name: "VBE",            doc: "pnjlim-limited B-E junction voltage",              init: { kind: "fromParams", compute: (_p) => _p["polarity"] === 1 ? 0.6 : -0.6 } },
  { name: "VBC",            doc: "pnjlim-limited B-C junction voltage",              init: { kind: "zero" } },
  { name: "GPI",            doc: "dIb/dVbe input conductance",                       init: { kind: "zero" } },
  { name: "GMU",            doc: "dIb/dVbc feedback conductance",                    init: { kind: "zero" } },
  { name: "GM",             doc: "dIc/dVbe transconductance",                        init: { kind: "zero" } },
  { name: "GO",             doc: "dIc/dVce output conductance",                      init: { kind: "zero" } },
  { name: "IC",             doc: "Collector current at operating point",             init: { kind: "zero" } },
  { name: "IB",             doc: "Base current at operating point",                  init: { kind: "zero" } },
  { name: "IC_NORTON",      doc: "Norton collector current for MNA stamp",           init: { kind: "zero" } },
  { name: "IB_NORTON",      doc: "Norton base current for MNA stamp",               init: { kind: "zero" } },
  { name: "RB_EFF",         doc: "Effective base resistance at operating point",     init: { kind: "fromParams", compute: (_p) => _p["RB"] } },
  { name: "IE_NORTON",      doc: "Norton emitter current for MNA stamp",             init: { kind: "zero" } },
  // BJ6: geqcb feedback conductance slot
  { name: "GEQCB",          doc: "Base charge feedback conductance geqcb",           init: { kind: "zero" } },
  // Junction capacitance companion model state
  { name: "CAP_GEQ_BE",     doc: "B-E junction-cap companion conductance",           init: { kind: "zero" } },
  { name: "CAP_IEQ_BE",     doc: "B-E junction-cap companion history current",       init: { kind: "zero" } },
  { name: "CAP_GEQ_BC_INT", doc: "B-C internal junction-cap companion conductance",  init: { kind: "zero" } },
  { name: "CAP_IEQ_BC_INT", doc: "B-C internal junction-cap companion history current", init: { kind: "zero" } },
  { name: "CAP_GEQ_BC_EXT", doc: "B-C external junction-cap companion conductance",  init: { kind: "zero" } },
  { name: "CAP_IEQ_BC_EXT", doc: "B-C external junction-cap companion history current", init: { kind: "zero" } },
  { name: "CAP_GEQ_CS",     doc: "C-S junction-cap companion conductance",           init: { kind: "zero" } },
  { name: "CAP_IEQ_CS",     doc: "C-S junction-cap companion history current",       init: { kind: "zero" } },
  // Current-step voltages (history comes from s1/s2/s3 at same offsets via StatePool rotation)
  { name: "V_BE",           doc: "B-E voltage at current step (for companion)",      init: { kind: "zero" } },
  { name: "V_BC",           doc: "B-C voltage at current step (for companion)",      init: { kind: "zero" } },
  { name: "V_CS",           doc: "C-S voltage at current step (for companion)",      init: { kind: "zero" } },
  // Current-step charges (history from s1/s2/s3 at same offsets)
  { name: "Q_BE",           doc: "B-E junction charge at current step",              init: { kind: "zero" } },
  { name: "Q_BC",           doc: "B-C junction charge at current step",              init: { kind: "zero" } },
  { name: "Q_CS",           doc: "C-S junction charge at current step",              init: { kind: "zero" } },
  // Total capacitance per junction (stored by stampCompanion for getLteEstimate)
  { name: "CTOT_BE",        doc: "Total B-E capacitance (depletion + diffusion)",    init: { kind: "zero" } },
  { name: "CTOT_BC",        doc: "Total B-C capacitance (depletion + diffusion)",    init: { kind: "zero" } },
  { name: "CTOT_CS",        doc: "Total C-S capacitance",                            init: { kind: "zero" } },
  // BJ7: Excess phase state slots — these are NOT pool-history; they are multi-step
  //      computation state that must survive across NR iterations, kept inline.
  { name: "CEXBC_NOW",      doc: "Excess phase current at current step",             init: { kind: "zero" } },
  { name: "CEXBC_PREV",     doc: "Excess phase current at step n-1",                 init: { kind: "zero" } },
  { name: "CEXBC_PREV2",    doc: "Excess phase current at step n-2",                 init: { kind: "zero" } },
  { name: "DT_PREV",        doc: "Previous timestep for excess phase",               init: { kind: "zero" } },
  // BJ8: Operating point storage slots
  { name: "OP_CBE",         doc: "B-E capacitance at operating point",               init: { kind: "zero" } },
  { name: "OP_GBE",         doc: "B-E junction conductance at operating point",      init: { kind: "zero" } },
  { name: "OP_DQBDVC",      doc: "dqb/dVbc at operating point",                      init: { kind: "zero" } },
  { name: "OP_DQBDVE",      doc: "dqb/dVbe at operating point",                      init: { kind: "zero" } },
  { name: "OP_QB",          doc: "Base charge factor qb at operating point",         init: { kind: "zero" } },
  // BJ11: Substrate diode DC current slots
  { name: "VSUB",           doc: "Substrate junction voltage",                       init: { kind: "zero" } },
  { name: "GDSUB",          doc: "Substrate diode conductance",                      init: { kind: "zero" } },
  { name: "CDSUB",          doc: "Substrate diode current",                          init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createSpiceL1BjtElement — SPICE Level 1 AnalogElement factory
// ---------------------------------------------------------------------------

export function createSpiceL1BjtElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): ReactiveAnalogElementCore {
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
    XTB: props.getModelParam<number>("XTB"),
    EG: props.getModelParam<number>("EG"),
    XTI: props.getModelParam<number>("XTI"),
    KF: props.getModelParam<number>("KF"),
    AF: props.getModelParam<number>("AF"),
    NKF: props.getModelParam<number>("NKF"),
    AREA: props.getModelParam<number>("AREA"),
    M: props.getModelParam<number>("M"),
    TNOM: props.getModelParam<number>("TNOM"),
  };

  function makeTpL1(): BjtTempParams {
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
    });
  }
  let tpL1 = makeTpL1();

  // Internal nodes: if resistance > 0, use allocated internal node; else short to external
  let intIdx = 0;
  const nodeB_int = params.RB > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeB_ext;
  const nodeC_int = params.RC > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeC_ext;
  const nodeE_int = params.RE > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeE_ext;

  const hasCapacitance = params.CJE > 0 || params.CJC > 0 || params.TF > 0 || params.TR > 0 || params.CJS > 0;
  // hasCapacitance is evaluated at factory creation time; tpL1 only affects runtime values.

  // State pool slot indices (BJT SPICE L1)
  // BJ6: GEQCB inserted after IE_NORTON, shifts all subsequent cap slots by 1
  const L1_SLOT_VBE = 0;
  const L1_SLOT_VBC = 1;
  const L1_SLOT_GPI = 2;
  const L1_SLOT_GMU = 3;
  const L1_SLOT_GM  = 4;
  const L1_SLOT_GO  = 5;
  const L1_SLOT_IC  = 6;
  const L1_SLOT_IB  = 7;
  const L1_SLOT_IC_NORTON = 8;
  const L1_SLOT_IB_NORTON = 9;
  const L1_SLOT_RB_EFF    = 10;
  const L1_SLOT_IE_NORTON = 11;
  const L1_SLOT_GEQCB     = 12;  // BJ6: new slot
  // Junction capacitance companion model state (shifted by 1)
  const L1_SLOT_CAP_GEQ_BE     = 13;
  const L1_SLOT_CAP_IEQ_BE     = 14;
  const L1_SLOT_CAP_GEQ_BC_INT = 15;
  const L1_SLOT_CAP_IEQ_BC_INT = 16;
  const L1_SLOT_CAP_GEQ_BC_EXT = 17;
  const L1_SLOT_CAP_IEQ_BC_EXT = 18;
  const L1_SLOT_CAP_GEQ_CS     = 19;
  const L1_SLOT_CAP_IEQ_CS     = 20;
  // Current-step voltage slots (history read from s1/s2/s3 at same offsets)
  const L1_SLOT_V_BE            = 21;
  const L1_SLOT_V_BC            = 22;
  const L1_SLOT_V_CS            = 23;
  // Current-step charge slots (history read from s1/s2/s3 at same offsets)
  const L1_SLOT_Q_BE            = 24;
  const L1_SLOT_Q_BC            = 25;
  const L1_SLOT_Q_CS            = 26;
  // Total capacitance per junction
  const L1_SLOT_CTOT_BE         = 27;
  const L1_SLOT_CTOT_BC         = 28;
  const L1_SLOT_CTOT_CS         = 29;
  // BJ7: Excess phase state slots (kept inline — not pool-rotation history)
  const L1_SLOT_CEXBC_NOW   = 30;
  const L1_SLOT_CEXBC_PREV  = 31;
  const L1_SLOT_CEXBC_PREV2 = 32;
  const L1_SLOT_DT_PREV     = 33;
  // BJ8: Operating point storage slots
  const L1_SLOT_OP_CBE    = 34;
  const L1_SLOT_OP_GBE    = 35;
  const L1_SLOT_OP_DQBDVC = 36;
  const L1_SLOT_OP_DQBDVE = 37;
  const L1_SLOT_OP_QB     = 38;
  // BJ11: Substrate diode DC current slots
  const L1_SLOT_VSUB  = 39;
  const L1_SLOT_GDSUB = 40;
  const L1_SLOT_CDSUB = 41;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, BJTload sets CKTnoncon++)
  let icheckLimited = false;

  const element: ReactiveAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true as const,
    poolBacked: true as const,
    stateSchema: BJT_L1_SCHEMA,
    stateSize: BJT_L1_SCHEMA.size,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(BJT_L1_SCHEMA, pool, base, { polarity, RB: params.RB });
      const op0 = computeSpiceL1BjtOp(
        0, 0,
        tpL1.tSatCur * params.AREA, tpL1.tBetaF, params.NF, tpL1.tBetaR, params.NR,
        tpL1.tBEleakCur * params.AREA, tpL1.tBCleakCur * params.AREA,
        params.NE, params.NC,
        tpL1.tinvEarlyVoltF, tpL1.tinvEarlyVoltR,
        tpL1.tinvRollOffF / params.AREA, tpL1.tinvRollOffR / params.AREA,
        tpL1.vt,
        params.NKF,
      );
      s0[base + L1_SLOT_GPI] = op0.gpi;
      s0[base + L1_SLOT_GMU] = op0.gmu;
      s0[base + L1_SLOT_GM]  = op0.gm;
      s0[base + L1_SLOT_GO]  = op0.go;
      s0[base + L1_SLOT_IC]  = op0.ic;
      s0[base + L1_SLOT_IB]  = op0.ib;
      s0[base + L1_SLOT_IC_NORTON] = op0.ic - op0.gm * 0 + op0.go * 0;
      s0[base + L1_SLOT_IB_NORTON] = op0.ib - op0.gpi * 0 - op0.gmu * 0;
      s0[base + L1_SLOT_IE_NORTON] = -(op0.ic + op0.ib);
      // BJ8: Store initial OP values
      s0[base + L1_SLOT_OP_CBE] = op0.cbe;
      s0[base + L1_SLOT_OP_GBE] = op0.gbe;
      s0[base + L1_SLOT_OP_DQBDVC] = op0.dqbdvc;
      s0[base + L1_SLOT_OP_DQBDVE] = op0.dqbdve;
      s0[base + L1_SLOT_OP_QB] = op0.qb;
    },

    stamp(solver: SparseSolver): void {
      // BJ5: M multiplier on terminal resistance conductances
      const m = params.M;

      // Stamp terminal resistances.
      if (params.RB > 0 && nodeB_int !== nodeB_ext) {
        const gRB = 1 / s0[base + L1_SLOT_RB_EFF];
        stampG(solver, nodeB_ext, nodeB_ext, m * gRB);
        stampG(solver, nodeB_ext, nodeB_int, m * -gRB);
        stampG(solver, nodeB_int, nodeB_ext, m * -gRB);
        stampG(solver, nodeB_int, nodeB_int, m * gRB);
      }
      if (params.RC > 0 && nodeC_int !== nodeC_ext) {
        const gRC = tpL1.tcollectorConduct * params.AREA;
        stampG(solver, nodeC_ext, nodeC_ext, m * gRC);
        stampG(solver, nodeC_ext, nodeC_int, m * -gRC);
        stampG(solver, nodeC_int, nodeC_ext, m * -gRC);
        stampG(solver, nodeC_int, nodeC_int, m * gRC);
      }
      if (params.RE > 0 && nodeE_int !== nodeE_ext) {
        const gRE = tpL1.temitterConduct * params.AREA;
        stampG(solver, nodeE_ext, nodeE_ext, m * gRE);
        stampG(solver, nodeE_ext, nodeE_int, m * -gRE);
        stampG(solver, nodeE_int, nodeE_ext, m * -gRE);
        stampG(solver, nodeE_int, nodeE_int, m * gRE);
      }

      // Stamp junction capacitance companion models when active.
      const _capGeqBE     = s0[base + L1_SLOT_CAP_GEQ_BE];
      const _capIeqBE     = s0[base + L1_SLOT_CAP_IEQ_BE];
      const _capGeqBC_int = s0[base + L1_SLOT_CAP_GEQ_BC_INT];
      const _capIeqBC_int = s0[base + L1_SLOT_CAP_IEQ_BC_INT];
      const _capGeqBC_ext = s0[base + L1_SLOT_CAP_GEQ_BC_EXT];
      const _capIeqBC_ext = s0[base + L1_SLOT_CAP_IEQ_BC_EXT];
      const _capGeqCS     = s0[base + L1_SLOT_CAP_GEQ_CS];
      const _capIeqCS     = s0[base + L1_SLOT_CAP_IEQ_CS];
      if (_capGeqBE !== 0 || _capIeqBE !== 0) {
        stampG(solver, nodeB_int, nodeB_int, m * _capGeqBE);
        stampG(solver, nodeB_int, nodeE_int, m * -_capGeqBE);
        stampG(solver, nodeE_int, nodeB_int, m * -_capGeqBE);
        stampG(solver, nodeE_int, nodeE_int, m * _capGeqBE);
        stampRHS(solver, nodeB_int, m * -_capIeqBE);
        stampRHS(solver, nodeE_int, m * _capIeqBE);
      }
      // B-C capacitance: XCJC fraction between internal nodes, (1-XCJC) between external nodes.
      if (_capGeqBC_int !== 0 || _capIeqBC_int !== 0) {
        stampG(solver, nodeB_int, nodeB_int, m * _capGeqBC_int);
        stampG(solver, nodeB_int, nodeC_int, m * -_capGeqBC_int);
        stampG(solver, nodeC_int, nodeB_int, m * -_capGeqBC_int);
        stampG(solver, nodeC_int, nodeC_int, m * _capGeqBC_int);
        stampRHS(solver, nodeB_int, m * -_capIeqBC_int);
        stampRHS(solver, nodeC_int, m * _capIeqBC_int);
      }
      if (_capGeqBC_ext !== 0 || _capIeqBC_ext !== 0) {
        stampG(solver, nodeB_ext, nodeB_ext, m * _capGeqBC_ext);
        stampG(solver, nodeB_ext, nodeC_ext, m * -_capGeqBC_ext);
        stampG(solver, nodeC_ext, nodeB_ext, m * -_capGeqBC_ext);
        stampG(solver, nodeC_ext, nodeC_ext, m * _capGeqBC_ext);
        stampRHS(solver, nodeB_ext, m * -_capIeqBC_ext);
        stampRHS(solver, nodeC_ext, m * _capIeqBC_ext);
      }
      // Collector-substrate capacitance: between external collector and ground.
      if (_capGeqCS !== 0 || _capIeqCS !== 0) {
        stampG(solver, nodeC_ext, nodeC_ext, m * _capGeqCS);
        stampRHS(solver, nodeC_ext, m * -_capIeqCS);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // BJ5: M multiplier on all stamps
      const m = params.M;

      const gpi = s0[base + L1_SLOT_GPI];
      const gmu = s0[base + L1_SLOT_GMU];
      const gm  = s0[base + L1_SLOT_GM];
      const go  = s0[base + L1_SLOT_GO];
      const icNorton = s0[base + L1_SLOT_IC_NORTON];
      const ibNorton = s0[base + L1_SLOT_IB_NORTON];
      const ieNorton = s0[base + L1_SLOT_IE_NORTON];
      // BJ6: geqcb feedback conductance
      const geqcb = s0[base + L1_SLOT_GEQCB];

      // gpi between B_int and E_int
      stampG(solver, nodeB_int, nodeB_int, m * gpi);
      stampG(solver, nodeB_int, nodeE_int, m * -gpi);
      stampG(solver, nodeE_int, nodeB_int, m * -gpi);
      stampG(solver, nodeE_int, nodeE_int, m * gpi);

      // gmu between B_int and C_int
      stampG(solver, nodeB_int, nodeB_int, m * gmu);
      stampG(solver, nodeB_int, nodeC_int, m * -gmu);
      stampG(solver, nodeC_int, nodeB_int, m * -gmu);
      stampG(solver, nodeC_int, nodeC_int, m * gmu);

      // go between C_int and E_int
      stampG(solver, nodeC_int, nodeC_int, m * go);
      stampG(solver, nodeC_int, nodeE_int, m * -go);
      stampG(solver, nodeE_int, nodeC_int, m * -go);
      stampG(solver, nodeE_int, nodeE_int, m * go);

      // gm*vbe VCCS
      stampG(solver, nodeC_int, nodeB_int, m * gm);
      stampG(solver, nodeC_int, nodeE_int, m * -gm);
      stampG(solver, nodeE_int, nodeB_int, m * -gm);
      stampG(solver, nodeE_int, nodeE_int, m * gm);

      // BJ6: geqcb Jacobian stamps (4 entries)
      stampG(solver, nodeB_int, nodeB_int, m * geqcb);
      stampG(solver, nodeB_int, nodeC_int, m * -geqcb);
      stampG(solver, nodeE_int, nodeC_int, m * geqcb);
      stampG(solver, nodeE_int, nodeB_int, m * -geqcb);

      // Norton RHS at internal terminals
      stampRHS(solver, nodeC_int, m * -polarity * icNorton);
      stampRHS(solver, nodeB_int, m * -polarity * ibNorton);
      stampRHS(solver, nodeE_int, m * -polarity * ieNorton);

      // BJ11: Substrate diode DC current stamp
      const gdsub = s0[base + L1_SLOT_GDSUB];
      const cdsub = s0[base + L1_SLOT_CDSUB];
      const vsub = s0[base + L1_SLOT_VSUB];
      if (gdsub !== 0 || cdsub !== 0) {
        stampG(solver, nodeC_ext, nodeC_ext, m * gdsub);
        stampRHS(solver, nodeC_ext, m * -polarity * (cdsub - gdsub * vsub));
      }
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): boolean {
      // Read internal node voltages
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      // BJ1: pnjlim uses tpL1.vt (temperature-dependent)
      const vcritBE = tpL1.tVcrit;
      const vcritBC = tpL1.tVcrit;

      const vbeRaw = polarity * (vBi - vEi);
      const vbcRaw = polarity * (vBi - vCi);

      const vbeResult = pnjlim(vbeRaw, s0[base + L1_SLOT_VBE], tpL1.vt, vcritBE);
      const vbeLimited = vbeResult.value;
      const vbeLimFlag = vbeResult.limited;
      const vbcResult = pnjlim(vbcRaw, s0[base + L1_SLOT_VBC], tpL1.vt, vcritBC);
      const vbcLimited = vbcResult.value;
      icheckLimited = vbeLimFlag || vbcResult.limited;
      // Save limited voltages to pool
      s0[base + L1_SLOT_VBE] = vbeLimited;
      s0[base + L1_SLOT_VBC] = vbcLimited;

      const op = computeSpiceL1BjtOp(
        vbeLimited, vbcLimited,
        tpL1.tSatCur * params.AREA, tpL1.tBetaF, params.NF, tpL1.tBetaR, params.NR,
        tpL1.tBEleakCur * params.AREA, tpL1.tBCleakCur * params.AREA,
        params.NE, params.NC,
        tpL1.tinvEarlyVoltF, tpL1.tinvEarlyVoltR,
        tpL1.tinvRollOffF / params.AREA, tpL1.tinvRollOffR / params.AREA,
        tpL1.vt,
        params.NKF,
      );

      // BJ8: Store OP values
      s0[base + L1_SLOT_OP_CBE] = op.cbe;
      s0[base + L1_SLOT_OP_GBE] = op.gbe;
      s0[base + L1_SLOT_OP_DQBDVC] = op.dqbdvc;
      s0[base + L1_SLOT_OP_DQBDVE] = op.dqbdve;
      s0[base + L1_SLOT_OP_QB] = op.qb;

      s0[base + L1_SLOT_GPI] = op.gpi;
      s0[base + L1_SLOT_GMU] = op.gmu;
      s0[base + L1_SLOT_GM]  = op.gm;
      s0[base + L1_SLOT_GO]  = op.go;
      s0[base + L1_SLOT_IC]  = op.ic;
      s0[base + L1_SLOT_IB]  = op.ib;

      // BJ6: geqcb feedback in Norton RHS
      const geqcb_prev = s0[base + L1_SLOT_GEQCB];
      s0[base + L1_SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + (op.gmu + op.go) * vbcLimited;
      s0[base + L1_SLOT_IB_NORTON] = op.ib - op.gpi * vbeLimited - op.gmu * vbcLimited - geqcb_prev * vbcLimited;
      s0[base + L1_SLOT_IE_NORTON] = -(op.ic + op.ib) + (op.gm + op.go + op.gpi) * vbeLimited - (op.go - geqcb_prev) * vbcLimited;

      // BJ9: Update current-dependent base resistance with corrected constants and qb division
      const qb_op = op.qb;
      const rbpr = tpL1.tminBaseResist / params.AREA;
      const rbpi = tpL1.tbaseResist / params.AREA - rbpr;
      const irbEff = tpL1.tbaseCurrentHalfResist * params.AREA;
      if (irbEff > 0 && rbpi > 0) {
        const Ib_abs = Math.abs(op.ib) + 1e-30;
        const x = Ib_abs / irbEff;
        // BJ9: Corrected constants: 14.59025 and 2.4317
        const z = (-1 + Math.sqrt(1 + 14.59025 * x)) / (2.4317 * Math.sqrt(x + 1e-30));
        const tanz = Math.tan(z);
        const factor = (tanz > 1e-10 && z > 1e-10) ? 3 * rbpi * (tanz - z) / (z * tanz * tanz) : rbpi;
        s0[base + L1_SLOT_RB_EFF] = Math.max(rbpr, rbpr + factor);
      } else {
        // BJ9: gx = rbpr + rbpi/qb
        s0[base + L1_SLOT_RB_EFF] = rbpr + rbpi / Math.max(qb_op, 1e-30);
      }

      // BJ11: Substrate diode DC current
      const vCe = nodeC_ext > 0 ? voltages[nodeC_ext - 1] : 0;
      const vsub = polarity * vCe;
      const csubsat = tpL1.tSubSatCur * params.AREA;
      const vts = tpL1.vt;
      let gdsub: number, cdsub: number;
      if (csubsat > 0) {
        if (vsub > -3 * vts) {
          const expSub = Math.exp(Math.min(vsub / vts, 700));
          gdsub = csubsat * expSub / vts + GMIN;
          cdsub = csubsat * (expSub - 1) + GMIN * vsub;
        } else {
          const argSub = 3 * vts / (vsub * Math.E);
          const arg3Sub = argSub * argSub * argSub;
          gdsub = csubsat * 3 * arg3Sub / vsub + GMIN;
          cdsub = -csubsat * (1 + arg3Sub) + GMIN * vsub;
        }
      } else {
        gdsub = GMIN;
        cdsub = GMIN * vsub;
      }
      s0[base + L1_SLOT_VSUB] = vsub;
      s0[base + L1_SLOT_GDSUB] = gdsub;
      s0[base + L1_SLOT_CDSUB] = cdsub;
      return icheckLimited;
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;
      const vbeRaw = polarity * (vBi - vEi);
      const vbcRaw = polarity * (vBi - vCi);

      const delvbe = vbeRaw - s0[base + L1_SLOT_VBE];
      const delvbc = vbcRaw - s0[base + L1_SLOT_VBC];

      // ngspice icheck: if any junction was limited by pnjlim, declare non-converged
      if (icheckLimited) return false;

      // ngspice BJTconvTest: predict currents from linearisation, check tolerance
      const cc  = s0[base + L1_SLOT_IC];
      const cb  = s0[base + L1_SLOT_IB];
      const gm  = s0[base + L1_SLOT_GM];
      const go  = s0[base + L1_SLOT_GO];
      const gpi = s0[base + L1_SLOT_GPI];
      const gmu = s0[base + L1_SLOT_GMU];

      const cchat = cc + (gm + go) * delvbe - (go + gmu) * delvbc;
      const cbhat = cb + gpi * delvbe + gmu * delvbc;

      const tolC = reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + abstol;
      const tolB = reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + abstol;

      return Math.abs(cchat - cc) <= tolC && Math.abs(cbhat - cb) <= tolB;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      const ic = polarity * s0[base + L1_SLOT_IC];
      const ib = polarity * s0[base + L1_SLOT_IB];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        tpL1 = makeTpL1();
      }
    },
  };

  // Attach stampCompanion for junction capacitances
  if (hasCapacitance) {
    element.stampCompanion = function (
      dt: number,
      method: IntegrationMethod,
      voltages: Float64Array,
    ): void {
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;
      const vBe = nodeB_ext > 0 ? voltages[nodeB_ext - 1] : 0;
      const vCe = nodeC_ext > 0 ? voltages[nodeC_ext - 1] : 0;

      const vbeNow = polarity * (vBi - vEi);
      const vbcNow = polarity * (vBi - vCi);
      // Collector-substrate voltage: Vc_ext referenced to substrate (ground = 0).
      const vcsNow = polarity * vCe;

      // Read history voltages from s1 (last accepted step via StatePool rotation).
      // First call detected by s1 voltage still zero (pool zero-initialised).
      const isFirstCall = s1[base + L1_SLOT_V_BE] === 0 && s1[base + L1_SLOT_Q_BE] === 0;
      const prevVbe = isFirstCall ? vbeNow : s1[base + L1_SLOT_V_BE];
      const prevVbc = isFirstCall ? vbcNow : s1[base + L1_SLOT_V_BC];
      const prevVcs = isFirstCall ? vcsNow : s1[base + L1_SLOT_V_CS];
      s0[base + L1_SLOT_V_BE] = vbeNow;
      s0[base + L1_SLOT_V_BC] = vbcNow;
      s0[base + L1_SLOT_V_CS] = vcsNow;

      // BJ12: Use temperature-adjusted transit times and junction exponents
      const tf_eff_base = tpL1.ttransitTimeF;
      const tr_eff = tpL1.ttransitTimeR;
      const mje_eff = tpL1.tjunctionExpBE;
      const mjc_eff = tpL1.tjunctionExpBC;
      const mjs_eff = tpL1.tjunctionExpSub;

      // B-E junction: depletion + transit-time diffusion capacitance.
      // Transit time modulation: TF_eff = TF * (1 + XTF*(Ic/(Ic+ITF))^2 * exp(Vbc/(1.44*VTF)))
      let TF_eff = tf_eff_base;
      if (tf_eff_base > 0 && params.XTF > 0) {
        const Ic = s0[base + L1_SLOT_IC];
        const ITF_safe = (params.ITF * params.AREA) > 0 ? params.ITF * params.AREA : 1e-30;
        const icRatio = Ic / (Ic + ITF_safe);
        const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
        const expTerm = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
        TF_eff = tf_eff_base * (1 + params.XTF * icRatio * icRatio * expTerm);
      }

      // BJ12: Use temp-adjusted cap and exponent for BE junction
      const CjBE = computeJunctionCapacitance(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, mje_eff, params.FC);
      const CdBE = TF_eff * s0[base + L1_SLOT_GM];
      const CtotalBE = CjBE + CdBE;

      // Store total BE capacitance for LTE tolerance reference
      s0[base + L1_SLOT_CTOT_BE] = CtotalBE;

      // BJ8: Store cbe in OP slot
      s0[base + L1_SLOT_OP_CBE] = CtotalBE;

      if (CtotalBE > 0) {
        const iBE = s1[base + L1_SLOT_CAP_GEQ_BE] * s1[base + L1_SLOT_V_BE] + s1[base + L1_SLOT_CAP_IEQ_BE];
        s0[base + L1_SLOT_CAP_GEQ_BE] = capacitorConductance(CtotalBE, dt, method);
        s0[base + L1_SLOT_CAP_IEQ_BE] = capacitorHistoryCurrent(CtotalBE, dt, method, vbeNow, prevVbe, iBE);
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BE] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BE] = 0;
      }

      // B-C junction: depletion + reverse transit-time diffusion capacitance.
      // BJ12: Use temp-adjusted cap and exponent for BC junction
      const CjBC = computeJunctionCapacitance(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, mjc_eff, params.FC);
      const CdBC = tr_eff * s0[base + L1_SLOT_GMU];
      const CtotalBC = CjBC + CdBC;

      const xcjc = Math.min(Math.max(params.XCJC, 0), 1);
      const CtotalBC_int = xcjc * CtotalBC;
      const CtotalBC_ext = (1 - xcjc) * CtotalBC;

      // Store total BC capacitance for LTE tolerance reference
      s0[base + L1_SLOT_CTOT_BC] = CtotalBC;

      // Compute total BC companion current (int + ext) before updating coefficients
      let iBC_total = 0;

      if (CtotalBC_int > 0) {
        const iBC_int = s1[base + L1_SLOT_CAP_GEQ_BC_INT] * s1[base + L1_SLOT_V_BC] + s1[base + L1_SLOT_CAP_IEQ_BC_INT];
        iBC_total += iBC_int;
        s0[base + L1_SLOT_CAP_GEQ_BC_INT] = capacitorConductance(CtotalBC_int, dt, method);
        s0[base + L1_SLOT_CAP_IEQ_BC_INT] = capacitorHistoryCurrent(CtotalBC_int, dt, method, vbcNow, prevVbc, iBC_int);
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BC_INT] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BC_INT] = 0;
      }

      if (CtotalBC_ext > 0) {
        // External B-C uses external node voltages for Vbc; prevVbc tracks the internal vbc
        // which is equivalent to external when XCJC < 1 (both driven by same junction).
        const vbcExt = polarity * (vBe - vCe);
        const iBC_ext = s1[base + L1_SLOT_CAP_GEQ_BC_EXT] * vbcExt + s1[base + L1_SLOT_CAP_IEQ_BC_EXT];
        iBC_total += iBC_ext;
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = capacitorConductance(CtotalBC_ext, dt, method);
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = capacitorHistoryCurrent(CtotalBC_ext, dt, method, vbcExt, prevVbc, iBC_ext);
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = 0;
      }

      // BC charge written by updateChargeFlux after NR convergence

      // BJ10: Collector-substrate capacitance using temperature-adjusted values.
      if (tpL1.tSubcap > 0 || params.CJS > 0) {
        // BJ12: Use temp-adjusted substrate exponent
        const CjCS = computeJunctionCapacitance(vcsNow, tpL1.tSubcap, tpL1.tSubpot, mjs_eff, params.FC);
        s0[base + L1_SLOT_CTOT_CS] = CjCS;
        if (CjCS > 0) {
          const iCS = s1[base + L1_SLOT_CAP_GEQ_CS] * s1[base + L1_SLOT_V_CS] + s1[base + L1_SLOT_CAP_IEQ_CS];
          s0[base + L1_SLOT_CAP_GEQ_CS] = capacitorConductance(CjCS, dt, method);
          s0[base + L1_SLOT_CAP_IEQ_CS] = capacitorHistoryCurrent(CjCS, dt, method, vcsNow, prevVcs, iCS);
        } else {
          s0[base + L1_SLOT_CAP_GEQ_CS] = 0;
          s0[base + L1_SLOT_CAP_IEQ_CS] = 0;
        }
      }

      // BJ6/BJ8: Compute geqcb from stored OP values using TF modulation formula
      const opQb = s0[base + L1_SLOT_OP_QB];
      const opDqbdvc = s0[base + L1_SLOT_OP_DQBDVC];
      const opCbe = s0[base + L1_SLOT_OP_CBE];
      let geqcb = 0;
      if (opQb > 1e-30 && opCbe > 0) {
        let ag0: number;
        switch (method) {
          case "bdf1":    ag0 = 1 / dt; break;
          case "trapezoidal": ag0 = 2 / dt; break;
          case "bdf2":    ag0 = 3 / (2 * dt); break;
          default:        ag0 = 1 / dt; break;
        }
        geqcb = ag0 * opCbe * opDqbdvc / opQb;
      }
      s0[base + L1_SLOT_GEQCB] = geqcb;

      // BJ7: Excess phase implementation (Weil's backward-Euler approximation)
      if (tpL1.excessPhaseFactor > 0) {
        const td = tpL1.excessPhaseFactor;
        let cc = s0[base + L1_SLOT_IC];
        const prevDt = s0[base + L1_SLOT_DT_PREV];

        if (prevDt > 0) {
          const arg1 = dt / td;
          const arg2 = 3 * arg1;
          const denom = 1 + arg2;
          const cexbc_prev = s0[base + L1_SLOT_CEXBC_PREV];
          const cexbc_prev2 = s0[base + L1_SLOT_CEXBC_PREV2];
          const cex = cexbc_prev + (cc + cexbc_prev2) * arg1 / denom;
          cc = (cc - cex) * arg2 / denom + cex / denom;
          s0[base + L1_SLOT_CEXBC_NOW] = cc;
        }

        s0[base + L1_SLOT_CEXBC_PREV2] = s0[base + L1_SLOT_CEXBC_PREV];
        s0[base + L1_SLOT_CEXBC_PREV] = s0[base + L1_SLOT_CEXBC_NOW];
        s0[base + L1_SLOT_DT_PREV] = dt;
      }
    };

    // Attach getLteEstimate for adaptive timestepping (ngspice bjttrunc.c).
    // Uses the same formula as the capacitor: LTE ≈ (dt/12) * |ΔI|,
    // applied to each junction's capacitance current history.
    element.getLteEstimate = function (dt: number): { truncationError: number; toleranceReference: number } {
      if (dt <= 0) return { truncationError: 0, toleranceReference: 0 };

      let maxError = 0;
      let maxRef = 0;

      // Reconstruct cap currents from s1/s2: i = geq * v + ieq
      // B-E junction
      const iBE_prev  = s1[base + L1_SLOT_CAP_GEQ_BE] * s1[base + L1_SLOT_V_BE] + s1[base + L1_SLOT_CAP_IEQ_BE];
      const iBE_prev2 = s2[base + L1_SLOT_CAP_GEQ_BE] * s2[base + L1_SLOT_V_BE] + s2[base + L1_SLOT_CAP_IEQ_BE];
      const deltaI_BE = Math.abs(iBE_prev - iBE_prev2);
      const err_BE = (dt / 12) * deltaI_BE;
      const cBE = s0[base + L1_SLOT_CTOT_BE];
      const ref_BE = cBE * Math.abs(s0[base + L1_SLOT_VBE]);
      if (err_BE > maxError) { maxError = err_BE; maxRef = ref_BE; }

      // B-C junction (use combined int+ext companion — BC_INT dominates when XCJC=1)
      const iBC_prev  = s1[base + L1_SLOT_CAP_GEQ_BC_INT] * s1[base + L1_SLOT_V_BC] + s1[base + L1_SLOT_CAP_IEQ_BC_INT]
                      + s1[base + L1_SLOT_CAP_GEQ_BC_EXT] * s1[base + L1_SLOT_V_BC] + s1[base + L1_SLOT_CAP_IEQ_BC_EXT];
      const iBC_prev2 = s2[base + L1_SLOT_CAP_GEQ_BC_INT] * s2[base + L1_SLOT_V_BC] + s2[base + L1_SLOT_CAP_IEQ_BC_INT]
                      + s2[base + L1_SLOT_CAP_GEQ_BC_EXT] * s2[base + L1_SLOT_V_BC] + s2[base + L1_SLOT_CAP_IEQ_BC_EXT];
      const deltaI_BC = Math.abs(iBC_prev - iBC_prev2);
      const err_BC = (dt / 12) * deltaI_BC;
      const cBC = s0[base + L1_SLOT_CTOT_BC];
      const ref_BC = cBC * Math.abs(s0[base + L1_SLOT_VBC]);
      if (err_BC > maxError) { maxError = err_BC; maxRef = ref_BC; }

      // C-S junction (only if CJS > 0)
      if (params.CJS > 0) {
        const iCS_prev  = s1[base + L1_SLOT_CAP_GEQ_CS] * s1[base + L1_SLOT_V_CS] + s1[base + L1_SLOT_CAP_IEQ_CS];
        const iCS_prev2 = s2[base + L1_SLOT_CAP_GEQ_CS] * s2[base + L1_SLOT_V_CS] + s2[base + L1_SLOT_CAP_IEQ_CS];
        const deltaI_CS = Math.abs(iCS_prev - iCS_prev2);
        const err_CS = (dt / 12) * deltaI_CS;
        const cCS = s0[base + L1_SLOT_CTOT_CS];
        const ref_CS = cCS * Math.abs(s1[base + L1_SLOT_V_CS]);
        if (err_CS > maxError) { maxError = err_CS; maxRef = ref_CS; }
      }

      return { truncationError: maxError, toleranceReference: maxRef };
    };

    element.getLteTimestep = function (
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
    ): number {
      let minDt = Infinity;

      // B-E junction
      {
        const _q0 = s0[base + L1_SLOT_Q_BE];
        const _q1 = s1[base + L1_SLOT_Q_BE];
        const _q2 = s2[base + L1_SLOT_Q_BE];
        const _q3 = s3[base + L1_SLOT_Q_BE];
        const _h0 = dt;
        const _h1 = deltaOld.length > 0 ? deltaOld[0] : dt;
        const _ccap0 = _h0 > 0 ? (_q0 - _q1) / _h0 : 0;
        const _ccap1 = _h1 > 0 ? (_q1 - _q2) / _h1 : 0;
        const dtBE = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, _ccap0, _ccap1, lteParams);
        if (dtBE < minDt) minDt = dtBE;
      }

      // B-C junction
      {
        const _q0 = s0[base + L1_SLOT_Q_BC];
        const _q1 = s1[base + L1_SLOT_Q_BC];
        const _q2 = s2[base + L1_SLOT_Q_BC];
        const _q3 = s3[base + L1_SLOT_Q_BC];
        const _h0 = dt;
        const _h1 = deltaOld.length > 0 ? deltaOld[0] : dt;
        const _ccap0 = _h0 > 0 ? (_q0 - _q1) / _h0 : 0;
        const _ccap1 = _h1 > 0 ? (_q1 - _q2) / _h1 : 0;
        const dtBC = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, _ccap0, _ccap1, lteParams);
        if (dtBC < minDt) minDt = dtBC;
      }

      // C-S junction (only if CJS > 0)
      if (params.CJS > 0) {
        const _q0 = s0[base + L1_SLOT_Q_CS];
        const _q1 = s1[base + L1_SLOT_Q_CS];
        const _q2 = s2[base + L1_SLOT_Q_CS];
        const _q3 = s3[base + L1_SLOT_Q_CS];
        const _h0 = dt;
        const _h1 = deltaOld.length > 0 ? deltaOld[0] : dt;
        const _ccap0 = _h0 > 0 ? (_q0 - _q1) / _h0 : 0;
        const _ccap1 = _h1 > 0 ? (_q1 - _q2) / _h1 : 0;
        const dtCS = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, _ccap0, _ccap1, lteParams);
        if (dtCS < minDt) minDt = dtCS;
      }

      return minDt;
    };

    element.updateChargeFlux = function(voltages: Float64Array): void {
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;
      const vCe = nodeC_ext > 0 ? voltages[nodeC_ext - 1] : 0;

      const vbeNow = polarity * (vBi - vEi);
      const vbcNow = polarity * (vBi - vCi);
      const vcsNow = polarity * vCe;

      // B-E junction charge: (Cj_BE + TF_eff * GM) * Vbe
      let TF_eff = tpL1.ttransitTimeF;
      if (TF_eff > 0 && params.XTF > 0) {
        const Ic = s0[base + L1_SLOT_IC];
        const ITF_safe = (params.ITF * params.AREA) > 0 ? params.ITF * params.AREA : 1e-30;
        const icRatio = Ic / (Ic + ITF_safe);
        const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
        const expTerm = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
        TF_eff = tpL1.ttransitTimeF * (1 + params.XTF * icRatio * icRatio * expTerm);
      }
      const CjBE = computeJunctionCapacitance(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, tpL1.tjunctionExpBE, params.FC);
      const CdBE = TF_eff * s0[base + L1_SLOT_GM];
      const CtotalBE = CjBE + CdBE;
      s0[base + L1_SLOT_Q_BE] = CtotalBE * vbeNow;
      s0[base + L1_SLOT_V_BE] = vbeNow;
      s0[base + L1_SLOT_CTOT_BE] = CtotalBE;

      // B-C junction charge: (Cj_BC + TR * GMU) * Vbc
      const CjBC = computeJunctionCapacitance(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, tpL1.tjunctionExpBC, params.FC);
      const CdBC = tpL1.ttransitTimeR * s0[base + L1_SLOT_GMU];
      const CtotalBC = CjBC + CdBC;
      s0[base + L1_SLOT_Q_BC] = CtotalBC * vbcNow;
      s0[base + L1_SLOT_V_BC] = vbcNow;
      s0[base + L1_SLOT_CTOT_BC] = CtotalBC;

      // C-S junction charge: Cj_CS * Vcs
      if (tpL1.tSubcap > 0 || params.CJS > 0) {
        const CjCS = computeJunctionCapacitance(vcsNow, tpL1.tSubcap, tpL1.tSubpot, tpL1.tjunctionExpSub, params.FC);
        s0[base + L1_SLOT_Q_CS] = CjCS * vcsNow;
        s0[base + L1_SLOT_V_CS] = vcsNow;
        s0[base + L1_SLOT_CTOT_CS] = CjCS;
      }
    };
  }

  return element;
}

// ---------------------------------------------------------------------------
// getSpiceL1InternalNodeCount — compute internal nodes needed for terminal resistances
// ---------------------------------------------------------------------------

function getSpiceL1InternalNodeCount(props: PropertyBag): number {
  let count = 0;
  if (props.getModelParam<number>("RB") > 0) count++;
  if (props.getModelParam<number>("RC") > 0) count++;
  if (props.getModelParam<number>("RE") > 0) count++;
  return count;
}

// ---------------------------------------------------------------------------
// NpnBjtElement + PnpBjtElement — CircuitElement implementations
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

    // Vertical bar (filled polygon)
    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    // Base lead
    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);

    // Collector lead (from bar to collector pin)
    drawColoredLead(ctx, signals, vC, 3.1875, -0.375, 4, -1);

    // Emitter lead (from bar to emitter pin)
    drawColoredLead(ctx, signals, vE, 3.1875, 0.375, 4, 1);

    // Arrow on emitter (pointing outward for NPN)
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

    // Vertical bar (filled polygon)
    ctx.drawPolygon([
      { x: 3, y: -1 },
      { x: 3.1875, y: -1 },
      { x: 3.1875, y: 1 },
      { x: 3, y: 1 },
    ], true);

    // Base lead
    drawColoredLead(ctx, signals, vB, 0, 0, 3, 0);

    // Lower branch to C pin at (4, 1)
    drawColoredLead(ctx, signals, vC, 3.1875, 0.375, 4, 1);

    // Upper branch to E pin at (4, -1)
    drawColoredLead(ctx, signals, vE, 3.1875, -0.375, 4, -1);

    // Arrow on upper (E) branch pointing inward (PNP)
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
    "NPN BJT — Gummel-Poon Level 2 bipolar junction transistor.\n" +
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
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_NPN_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "2N3904": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N3904,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "BC547B": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_BC547B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "2N2222A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2222A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "2N2219A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2219A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
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
    "PNP BJT — Gummel-Poon Level 2 bipolar junction transistor (PNP polarity).\n" +
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
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_PNP_DEFAULTS,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "2N3906": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N3906,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "BC557B": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_BC557B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "2N2907A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N2907A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
    "TIP32C": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_TIP32C,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
    },
  },
  defaultModel: "spice",
};
