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
import type { LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, deviceParams } from "../../core/model-params.js";
import { integrateCapacitor } from "../../solver/analog/integration.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { computeJunctionCapacitance, computeJunctionCharge } from "./diode.js";
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
    ISS: { default: 0,      unit: "A", description: "Substrate saturation current" },
    NS:  { default: 1,      description: "Substrate emission coefficient" },
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
    ISS: { default: 0,      unit: "A", description: "Substrate saturation current" },
    NS:  { default: 1,      description: "Substrate emission coefficient" },
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
  // BJ11: Temperature-adjusted substrate saturation current and critical voltage
  tSubSatCur: number;
  tSubVcrit: number;
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
  // BJ11: Substrate saturation current
  ISS: number;
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

  // BJ11: Substrate saturation current — ngspice bjttemp.c:173 uses BJTsubSatCur (ISS), not IS.
  // ISS defaults to 0, so the substrate diode is inactive unless explicitly specified.
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
  // BJ11: Substrate critical voltage — ngspice bjttemp.c:258-259, same formula using tSubSatCur.
  // When ISS=0, tSubSatCur=0 → tSubVcrit=+Infinity, pnjlim never triggers (inactive substrate).
  const tSubVcrit = tSubSatCur > 0 ? vt * Math.log(vt / (Math.SQRT2 * tSubSatCur * p.AREA)) : Infinity;

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
    tVcrit, tSubVcrit, tSubcap, tSubpot, tSubSatCur,
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
  // BJ13: Raw junction currents and BC conductance
  gbc: number;
  If: number;
  Ir: number;
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
  NE: number,
  NC: number,
): BjtOperatingPoint {
  const nfVt = NF * vt;
  const nrVt = NR * vt;
  const neVt = NE * vt;
  const ncVt = NC * vt;

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
  const ibcNonIdealForIc = (c4 > 0 ? c4 * (Math.exp(Math.min(vbc / ncVt, 700)) - 1) : 0) + GMIN * vbc;

  // Terminal collector current: transport - reverse base - cbcn (ngspice cc)
  const ic = iTransport - Ir / betaR - ibcNonIdealForIc;

  // Non-ideal base current contributions (c2, c4 with leakage emission coefficients NE/NC)
  const ibIdeal = If / betaF + Ir / betaR;
  const ibNonIdeal =
    (c2 > 0 ? c2 * (Math.exp(Math.min(vbe / neVt, 700)) - 1) : 0) +
    (c4 > 0 ? c4 * (Math.exp(Math.min(vbc / ncVt, 700)) - 1) : 0);
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
  const go = dIrdVbc / qb + iTransport * dqbdVbc / qb;
  const gm = dIfdVbe / qb - iTransport * dqbdVbe / qb - go;

  // Input/feedback conductances with GMIN on non-ideal terms (ngspice gben/gbcn)
  const gpi = dIfdVbe / betaF + (c2 > 0 ? c2 * Math.exp(Math.min(vbe / neVt, 700)) / neVt : 0) + GMIN;
  const gmu = dIrdVbc / betaR + (c4 > 0 ? c4 * Math.exp(Math.min(vbc / ncVt, 700)) / ncVt : 0) + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu, cbe: 0, gbe, dqbdvc: dqbdVbc, dqbdve: dqbdVbe, qb, gbc, If, Ir };
}

// ---------------------------------------------------------------------------
// State schema — BJT simple (10 slots)
// ---------------------------------------------------------------------------

export const BJT_SIMPLE_SCHEMA: StateSchema = defineStateSchema("BjtSimpleElement", [
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
      ISS: 0,
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
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, BJTload sets CKTnoncon++)
  let icheckLimited = false;

  // One-shot cold-start seeds from dcopInitJct. Non-null only between
  // primeJunctions() and the next updateOperatingPoint() call, which
  // consumes and re-nulls them. Matches ngspice MODEINITJCT local override.
  let primedVbe: number | null = null;
  let primedVbc: number | null = null;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false as const,
    poolBacked: true as const,
    stateSchema: BJT_SIMPLE_SCHEMA,
    stateSize: BJT_SIMPLE_SCHEMA.size,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
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
        tp.vt, params.NE, params.NC,
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

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
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

    updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): boolean {
      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // BJ1: pnjlim uses tp.vt (temperature-dependent)
      const vcritBE = tp.tVcrit;
      const vcritBC = tp.tVcrit;

      // Junction voltages (polarity-corrected for PNP). If primeJunctions
      // armed a cold-start seed for iteration 0, consume it here and clear
      // so iteration 1 onward reads from the shared voltages array.
      let vbeRaw: number;
      let vbcRaw: number;
      if (primedVbe !== null) {
        vbeRaw = primedVbe;
        vbcRaw = primedVbc!;
        primedVbe = null;
        primedVbc = null;
      } else {
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }

      // Apply pnjlim to both junctions using vold from pool
      const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, vcritBE);
      const vbeLimited = vbeResult.value;
      const vbeLimFlag = vbeResult.limited;
      const vbcResult = pnjlim(vbcRaw, s0[base + SLOT_VBC], tp.vt, vcritBC);
      const vbcLimited = vbcResult.value;
      icheckLimited = vbeLimFlag || vbcResult.limited;

      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "BE",
          limitType: "pnjlim",
          vBefore: vbeRaw,
          vAfter: vbeLimited,
          wasLimited: vbeLimFlag,
        });
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "BC",
          limitType: "pnjlim",
          vBefore: vbcRaw,
          vAfter: vbcLimited,
          wasLimited: vbcResult.limited,
        });
      }

      s0[base + SLOT_VBE] = vbeLimited;
      s0[base + SLOT_VBC] = vbcLimited;

      const op = computeBjtOp(
        vbeLimited, vbcLimited,
        tp.tSatCur * params.AREA, tp.tBetaF, params.NF, tp.tBetaR, params.NR,
        tp.tBEleakCur * params.AREA, tp.tBCleakCur * params.AREA,
        tp.tinvEarlyVoltF, tp.tinvEarlyVoltR,
        tp.tinvRollOffF / params.AREA, tp.tinvRollOffR / params.AREA,
        tp.vt, params.NE, params.NC,
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

    primeJunctions(): void {
      // Arm cold-start seed: Vbe = tVcrit, Vbc = 0.
      // Matches ngspice MODEINITJCT (bjtload.c:265-274), where BJTload reads
      //   vbe = here->BJTtVcrit; vbc = 0;
      // as a LOCAL linearization-point override, never touching the shared
      // node-voltage vector. Consumed and cleared by the next
      // updateOperatingPoint call.
      //
      // Seeds are the RAW junction-bias magnitudes (unsigned-positive for
      // forward bias), NOT polarity-signed node differences. updateOperatingPoint
      // computes `vbeRaw = polarity * (vB - vE)`, which is already
      // polarity-corrected to be positive when the junction is forward-biased.
      // The primed value slots into that same convention directly — so both
      // NPN and PNP use +tVcrit regardless of `polarity`.
      primedVbe = tp.tVcrit;
      primedVbc = 0;
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
  const go = dIrdVbc / qb + iTransport * dqbdVbc / qb;
  const gm = dIfdVbe / qb - iTransport * dqbdVbe / qb - go;

  // Input/feedback conductances: gben/gbcn include GMIN (ngspice approach)
  const gpi = dIfdVbe / betaF + gben + GMIN;
  const gmu = dIrdVbc / betaR + gbcn + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu, cbe: 0, gbe, dqbdvc: dqbdVbc, dqbdve: dqbdVbe, qb, gbc, If, Ir };
}

// ---------------------------------------------------------------------------
// State schema — BJT SPICE L1 (33 slots)
// ---------------------------------------------------------------------------

export const BJT_L1_SCHEMA: StateSchema = defineStateSchema("BjtSpiceL1Element", [
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
  { name: "GEQCB",          doc: "Base charge feedback conductance geqcb (transient-scaled)",           init: { kind: "zero" } },
  // BJ14: DC-form geqcb before ag0 scaling — bjtload.c:591-611
  { name: "GEQCB_DC",       doc: "DC-form geqcb (before ag0 multiply) — bjtload.c:591-611",            init: { kind: "zero" } },
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
  // Total capacitance per junction (stored by stampCompanion for getLteTimestep)
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
  // BJ13: Raw junction current and conductance slots
  { name: "OP_IF",          doc: "Forward junction current",                         init: { kind: "zero" } },
  { name: "OP_IR",          doc: "Reverse junction current",                         init: { kind: "zero" } },
  { name: "OP_GBC",         doc: "Raw BC junction conductance",                      init: { kind: "zero" } },
  // NIintegrate ccap history slots (for getLteTimestep)
  { name: "CCAP_BE",        doc: "B-E companion current (NIintegrate)",              init: { kind: "zero" } },
  { name: "CCAP_BC",        doc: "B-C companion current (NIintegrate)",              init: { kind: "zero" } },
  { name: "CCAP_CS",        doc: "C-S companion current (NIintegrate)",              init: { kind: "zero" } },
  // DC-only current slots (pre-cap augmentation) for getPinCurrents
  { name: "IC_DC",          doc: "Raw DC collector current (pre-cap augmentation)",  init: { kind: "zero" } },
  { name: "IB_DC",          doc: "Raw DC base current (pre-cap augmentation)",       init: { kind: "zero" } },
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
    ISS: props.getModelParam<number>("ISS"),
    NS:  props.getModelParam<number>("NS"),
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
      ISS: params.ISS,
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
  const L1_SLOT_GEQCB     = 12;  // BJ6: transient-scaled geqcb
  const L1_SLOT_GEQCB_DC  = 13;  // BJ14: DC-form geqcb before ag0 (bjtload.c:591-611)
  // Junction capacitance companion model state (shifted by 1 for BJ14)
  const L1_SLOT_CAP_GEQ_BE     = 14;
  const L1_SLOT_CAP_IEQ_BE     = 15;
  const L1_SLOT_CAP_GEQ_BC_INT = 16;
  const L1_SLOT_CAP_IEQ_BC_INT = 17;
  const L1_SLOT_CAP_GEQ_BC_EXT = 18;
  const L1_SLOT_CAP_IEQ_BC_EXT = 19;
  const L1_SLOT_CAP_GEQ_CS     = 20;
  const L1_SLOT_CAP_IEQ_CS     = 21;
  // Current-step voltage slots (history read from s1/s2/s3 at same offsets)
  const L1_SLOT_V_BE            = 22;
  const L1_SLOT_V_BC            = 23;
  const L1_SLOT_V_CS            = 24;
  // Current-step charge slots (history read from s1/s2/s3 at same offsets)
  const L1_SLOT_Q_BE            = 25;
  const L1_SLOT_Q_BC            = 26;
  const L1_SLOT_Q_CS            = 27;
  // Total capacitance per junction
  const L1_SLOT_CTOT_BE         = 28;
  const L1_SLOT_CTOT_BC         = 29;
  const L1_SLOT_CTOT_CS         = 30;
  // BJ7: Excess phase state slots (kept inline — not pool-rotation history)
  const L1_SLOT_CEXBC_NOW   = 31;
  const L1_SLOT_CEXBC_PREV  = 32;
  const L1_SLOT_CEXBC_PREV2 = 33;
  const L1_SLOT_DT_PREV     = 34;
  // BJ8: Operating point storage slots
  const L1_SLOT_OP_CBE    = 35;
  const L1_SLOT_OP_GBE    = 36;
  const L1_SLOT_OP_DQBDVC = 37;
  const L1_SLOT_OP_DQBDVE = 38;
  const L1_SLOT_OP_QB     = 39;
  // BJ11: Substrate diode DC current slots
  const L1_SLOT_VSUB  = 40;
  const L1_SLOT_GDSUB = 41;
  const L1_SLOT_CDSUB = 42;
  // BJ13: Raw junction current and conductance slots
  const L1_SLOT_OP_IF  = 43;   // Forward junction current before qb division
  const L1_SLOT_OP_IR  = 44;   // Reverse junction current before qb division
  const L1_SLOT_OP_GBC = 45;   // Raw BC junction conductance

  const L1_SLOT_CCAP_BE = 46;  // B-E NIintegrate ccap history
  const L1_SLOT_CCAP_BC = 47;  // B-C NIintegrate ccap history
  const L1_SLOT_CCAP_CS = 48;  // C-S NIintegrate ccap history
  const L1_SLOT_IC_DC   = 49;  // Raw DC collector current (pre-cap augmentation)
  const L1_SLOT_IB_DC   = 50;  // Raw DC base current (pre-cap augmentation)

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, BJTload sets CKTnoncon++)
  let icheckLimited = false;

  // One-shot cold-start seeds from dcopInitJct. Non-null only between
  // primeJunctions() and the next updateOperatingPoint() call, which
  // consumes and re-nulls them. Matches ngspice MODEINITJCT local override.
  let primedVbe: number | null = null;
  let primedVbc: number | null = null;

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

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
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
      // BJ13: Store raw junction currents and conductance
      s0[base + L1_SLOT_OP_IF] = op0.If;
      s0[base + L1_SLOT_OP_IR] = op0.Ir;
      s0[base + L1_SLOT_OP_GBC] = op0.gbc;
    },

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    stamp(solver: SparseSolver): void {
      // BJ5: M multiplier on terminal resistance conductances
      const m = params.M;

      // Stamp topology-constant terminal resistances (RC and RE only).
      // RB_EFF depends on operating point and is stamped in stampNonlinear().
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
    },

    stampNonlinear(solver: SparseSolver): void {
      // BJ5: M multiplier on all stamps
      const m = params.M;

      // RB_EFF depends on operating point (qb, |Ib|) — stamp here each NR iteration.
      if (params.RB > 0 && nodeB_int !== nodeB_ext) {
        const gRB = 1 / s0[base + L1_SLOT_RB_EFF];
        stampG(solver, nodeB_ext, nodeB_ext, m * gRB);
        stampG(solver, nodeB_ext, nodeB_int, m * -gRB);
        stampG(solver, nodeB_int, nodeB_ext, m * -gRB);
        stampG(solver, nodeB_int, nodeB_int, m * gRB);
      }

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
      // substConNode: VERTICAL (NPN, subs=+1) → nodeC_int (BJTcolPrimeNode),
      //               LATERAL (PNP, subs=-1) → nodeB_int (BJTbasePrimeNode)
      // Matches ngspice bjtsetup.c:454-460 and bjtload.c:799-815.
      const subs = polarity > 0 ? 1 : -1; // NPN → VERTICAL (+1), PNP → LATERAL (-1)
      const substConNode = subs > 0 ? nodeC_int : nodeB_int;
      const gdsub = s0[base + L1_SLOT_GDSUB];
      const cdsub = s0[base + L1_SLOT_CDSUB];
      const vsub = s0[base + L1_SLOT_VSUB];
      if (gdsub !== 0 || cdsub !== 0) {
        // ceqsub = BJTtype * BJTsubs * (cdsub - vsub * geqsub)  [bjtload.c:799-800, DC: cqsub=0]
        // stamped +ceqsub onto substConNode row  [bjtload.c:810]
        stampG(solver, substConNode, substConNode, m * gdsub);
        stampRHS(solver, substConNode, m * polarity * subs * (cdsub - gdsub * vsub));
      }

      // BC external cap (1-XCJC portion) — stamps on external B/C nodes.
      // Cannot be absorbed into augmented DC stamps because it uses different node pairs.
      if (hasCapacitance) {
        const geqBCext = s0[base + L1_SLOT_CAP_GEQ_BC_EXT];
        const ieqBCext = s0[base + L1_SLOT_CAP_IEQ_BC_EXT];
        if (geqBCext !== 0 || ieqBCext !== 0) {
          stampG(solver, nodeB_ext, nodeB_ext, m * geqBCext);
          stampG(solver, nodeB_ext, nodeC_ext, m * -geqBCext);
          stampG(solver, nodeC_ext, nodeB_ext, m * -geqBCext);
          stampG(solver, nodeC_ext, nodeC_ext, m * geqBCext);
          stampRHS(solver, nodeB_ext, m * -polarity * ieqBCext);
          stampRHS(solver, nodeC_ext, m * polarity * ieqBCext);
        }

        // CS cap — stamps on substConNode (C_int for NPN, B_int for PNP)
        const geqCS = s0[base + L1_SLOT_CAP_GEQ_CS];
        const ieqCS = s0[base + L1_SLOT_CAP_IEQ_CS];
        if (geqCS !== 0 || ieqCS !== 0) {
          const subs_cs = polarity > 0 ? 1 : -1;
          const substConNode_cs = subs_cs > 0 ? nodeC_int : nodeB_int;
          stampG(solver, substConNode_cs, substConNode_cs, m * geqCS);
          stampRHS(solver, substConNode_cs, m * polarity * subs_cs * ieqCS);
        }
      }
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): boolean {
      // Read internal node voltages
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      // BJ1: pnjlim uses tpL1.vt (temperature-dependent)
      const vcritBE = tpL1.tVcrit;
      const vcritBC = tpL1.tVcrit;

      // Consume one-shot cold-start seed from dcopInitJct, if armed.
      let vbeRaw: number;
      let vbcRaw: number;
      if (primedVbe !== null) {
        vbeRaw = primedVbe;
        vbcRaw = primedVbc!;
        primedVbe = null;
        primedVbc = null;
      } else {
        vbeRaw = polarity * (vBi - vEi);
        vbcRaw = polarity * (vBi - vCi);
      }

      const vbeResult = pnjlim(vbeRaw, s0[base + L1_SLOT_VBE], tpL1.vt, vcritBE);
      const vbeLimited = vbeResult.value;
      const vbeLimFlag = vbeResult.limited;
      const vbcResult = pnjlim(vbcRaw, s0[base + L1_SLOT_VBC], tpL1.vt, vcritBC);
      const vbcLimited = vbcResult.value;
      // CS pnjlim: bjtload.c:407-415 — compute vsub from current voltages then limit it.
      // vsub = polarity * subs * (V_substNode - V_substConNode); substrate pin tied to ground so
      // V_substNode = 0. substConNode: VERTICAL(NPN)→nodeC_int, LATERAL(PNP)→nodeB_int.
      // subs defined here; same value reused in the BJ11 section below.
      const subs_op = polarity > 0 ? 1 : -1; // NPN → VERTICAL (+1), PNP → LATERAL (-1)
      const substConNode_op = subs_op > 0 ? nodeC_int : nodeB_int;
      const vSubConRaw = substConNode_op > 0 ? voltages[substConNode_op - 1] : 0;
      const vsubRaw = polarity * subs_op * (0 - vSubConRaw); // V_substNode=0 (substrate tied to ground)
      const vsubResult = pnjlim(vsubRaw, s0[base + L1_SLOT_VSUB], tpL1.vt, tpL1.tSubVcrit);
      const vsubLimited = vsubResult.value;
      icheckLimited = vbeLimFlag || vbcResult.limited || vsubResult.limited;

      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "BE",
          limitType: "pnjlim",
          vBefore: vbeRaw,
          vAfter: vbeLimited,
          wasLimited: vbeLimFlag,
        });
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "BC",
          limitType: "pnjlim",
          vBefore: vbcRaw,
          vAfter: vbcLimited,
          wasLimited: vbcResult.limited,
        });
      }

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
      // BJ13: Store raw junction currents and conductance
      s0[base + L1_SLOT_OP_IF] = op.If;
      s0[base + L1_SLOT_OP_IR] = op.Ir;
      s0[base + L1_SLOT_OP_GBC] = op.gbc;

      s0[base + L1_SLOT_GPI] = op.gpi;
      s0[base + L1_SLOT_GMU] = op.gmu;
      s0[base + L1_SLOT_GM]  = op.gm;
      s0[base + L1_SLOT_GO]  = op.go;
      s0[base + L1_SLOT_IC]  = op.ic;
      s0[base + L1_SLOT_IB]  = op.ib;
      s0[base + L1_SLOT_IC_DC] = op.ic;
      s0[base + L1_SLOT_IB_DC] = op.ib;

      // BJ14: Compute geqcb_dc — DC-form (bjtload.c:591-611), using LIMITED voltages.
      // Formula: geqcb = tf*(arg3 - cbe_mod*dqbdvc)/qb
      // This is the base-charge feedback conductance BEFORE ag0 scaling.
      let geqcb_dc = 0;
      const tf_dc = tpL1.ttransitTimeF;
      if (tf_dc > 0 && op.qb > 1e-30 && vbeLimited > 0) {
        const ovtf_dc = params.VTF === Infinity ? 0 : 1 / (1.44 * params.VTF);
        let argtf_dc = 0;
        if (params.XTF > 0) {
          argtf_dc = params.XTF;
          if (ovtf_dc !== 0) {
            argtf_dc = argtf_dc * Math.exp(Math.min(vbcLimited * ovtf_dc, 700));
          }
          const xjtf_dc = params.ITF * params.AREA;
          if (xjtf_dc > 0) {
            const temp_dc = op.If / (op.If + xjtf_dc);
            argtf_dc = argtf_dc * temp_dc * temp_dc;
          }
        }
        const arg3_dc = op.If * argtf_dc * ovtf_dc;           // bjtload.c:604
        const cbe_mod_dc = op.If * (1 + argtf_dc) / op.qb;   // bjtload.c:606
        geqcb_dc = tf_dc * (arg3_dc - cbe_mod_dc * op.dqbdvc) / op.qb; // bjtload.c:608
      }
      s0[base + L1_SLOT_GEQCB_DC] = geqcb_dc;

      // BJ14: Write GEQCB based on analysis mode (bjtload.c:727):
      //   - DC-OP (ngspice MODETRANOP|MODEDCOP): ag0 = 0, GEQCB = 0 (cap invisible)
      //   - Transient (ngspice MODETRAN|MODEINITTRAN): GEQCB = ag0 * geqcb_dc
      //     where ag0 = 1/dt from NIcomCof (nicomcof.c:33-51) = CKTag[0].
      // Source ag0 from pool.dt on every call — NO cross-phase cached value,
      // matching ngspice's single-pass bjtload semantics.
      const isDcOpContext = (pool.analysisMode ?? "dcOp") === "dcOp";
      const dtForAg0 = pool.dt ?? 0;
      const ag0 = (!isDcOpContext && dtForAg0 > 0) ? 1 / dtForAg0 : 0;
      const geqcb_now = ag0 * geqcb_dc;
      s0[base + L1_SLOT_GEQCB] = geqcb_now;

      // BJ6/BJ14: Norton RHS uses geqcb_now (bjtload.c:803-805), LIMITED voltages.
      s0[base + L1_SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + (op.gmu + op.go) * vbcLimited;
      s0[base + L1_SLOT_IB_NORTON] = op.ib - op.gpi * vbeLimited - op.gmu * vbcLimited - geqcb_now * vbcLimited;
      s0[base + L1_SLOT_IE_NORTON] = -(op.ic + op.ib) + (op.gm + op.go + op.gpi) * vbeLimited - (op.go - geqcb_now) * vbcLimited;

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
      // tSubSatCur derives from ISS (defaults to 0), so csubsat is 0 unless
      // the user specified ISS. Guard on csubsat > 0 to skip inactive substrate diodes.
      // vsub was computed and pnjlim-limited above (ngspice bjtload.c:317-319, 407-415).
      // Formula: polarity * subs * (V_substNode - V_substConNode), V_substNode=0.
      const vsub = vsubLimited;
      const csubsat = tpL1.tSubSatCur * params.AREA;
      const vts = tpL1.vt * params.NS;
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

      // --- ngspice bjtload.c:725-734 lumping ---
      // Augment DC conductances/currents with cap companion geq/ieq so that
      // stampNonlinear reads cap-augmented values (matching ngspice's single-pass
      // bjtload semantics where GPI, GMU, IC, IB contain cap contributions).
      // This runs at the end of updateOperatingPoint so the augmented values are
      // available whenever stampNonlinear reads the slots, regardless of NR
      // iteration ordering (iteration 0 initial assembly or iteration > 0).
      if (hasCapacitance) {
        const geqBE = s0[base + L1_SLOT_CAP_GEQ_BE];
        const ieqBE = s0[base + L1_SLOT_CAP_IEQ_BE];
        const geqBCint = s0[base + L1_SLOT_CAP_GEQ_BC_INT];
        const ieqBCint = s0[base + L1_SLOT_CAP_IEQ_BC_INT];

        const vbeNow_aug = s0[base + L1_SLOT_VBE];
        const vbcNow_aug = s0[base + L1_SLOT_VBC];
        const cqbe = geqBE * vbeNow_aug + ieqBE;     // BE cap current
        const cqbc = geqBCint * vbcNow_aug + ieqBCint; // BC cap current (internal portion)

        // bjtload.c:728-734
        s0[base + L1_SLOT_GPI] += geqBE;
        s0[base + L1_SLOT_GMU] += geqBCint;
        s0[base + L1_SLOT_IC] -= cqbc;            // cc -= cqbc
        s0[base + L1_SLOT_IB] += cqbe + cqbc;     // cb += cqbe + cqbc

        // Recompute Norton currents from augmented values
        // (matches bjtload.c:803-808 which uses augmented cc/cb/gpi/gmu)
        const gpi_aug = s0[base + L1_SLOT_GPI];
        const gmu_aug = s0[base + L1_SLOT_GMU];
        const gm_val = s0[base + L1_SLOT_GM];
        const go_val = s0[base + L1_SLOT_GO];
        const geqcb_val = s0[base + L1_SLOT_GEQCB];
        const ic_aug = s0[base + L1_SLOT_IC];
        const ib_aug = s0[base + L1_SLOT_IB];

        s0[base + L1_SLOT_IC_NORTON] = ic_aug - (gm_val + go_val) * vbeNow_aug + (go_val + gmu_aug) * vbcNow_aug;
        s0[base + L1_SLOT_IB_NORTON] = ib_aug - gpi_aug * vbeNow_aug - gmu_aug * vbcNow_aug - geqcb_val * vbcNow_aug;
        s0[base + L1_SLOT_IE_NORTON] = -(ic_aug + ib_aug) + (gm_val + go_val + gpi_aug) * vbeNow_aug - (go_val - geqcb_val) * vbcNow_aug;
      }

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

      // ngspice BJTconvTest: predict currents from linearisation, check tolerance.
      // GPI, GMU, IC, IB now contain cap-augmented values (lumped at the end of
      // updateOperatingPoint), matching ngspice's bjtload.c single-pass semantics.
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
      const ic = polarity * s0[base + L1_SLOT_IC_DC];
      const ib = polarity * s0[base + L1_SLOT_IB_DC];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    },

    primeJunctions(): void {
      // Arm cold-start seed: Vbe = tVcrit, Vbc = 0.
      // Matches ngspice MODEINITJCT (bjtload.c:265-274). Local override
      // consumed by the next updateOperatingPoint; the shared node-voltage
      // vector is NOT touched, so grounded-terminal and shared-node
      // topologies work correctly. Substrate node stays at its default 0.
      //
      // Seeds are raw junction-bias magnitudes (unsigned-positive for forward
      // bias). updateOperatingPoint's non-primed branch computes
      // `vbeRaw = polarity * (vBi - vEi)` which is already polarity-corrected
      // to positive for a forward-biased junction — both NPN and PNP use
      // +tVcrit regardless of `polarity`.
      primedVbe = tpL1.tVcrit;
      primedVbc = 0;
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
      _voltages: Float64Array,
      order: number,
      deltaOld: readonly number[],
    ): void {
      // Compute junction voltages freshly from current node voltages (ngspice
      // bjtload.c:276-330). Apply pnjlim against the previously-stored limited
      // value (used as `vold`) and write the limited result back to the slot.
      // This makes stampCompanion self-contained — it never reads a cross-phase
      // cached value, eliminating the staleness hazard at the DC-OP→transient
      // boundary.
      const vCi_sc = nodeC_int > 0 ? _voltages[nodeC_int - 1] : 0;
      const vBi_sc = nodeB_int > 0 ? _voltages[nodeB_int - 1] : 0;
      const vEi_sc = nodeE_int > 0 ? _voltages[nodeE_int - 1] : 0;
      const vbeRaw_sc = polarity * (vBi_sc - vEi_sc);
      const vbcRaw_sc = polarity * (vBi_sc - vCi_sc);
      const subs_sc = polarity > 0 ? 1 : -1;
      const substConNode_sc = subs_sc > 0 ? nodeC_int : nodeB_int;
      const vSubCon_sc = substConNode_sc > 0 ? _voltages[substConNode_sc - 1] : 0;
      const vsubRaw_sc = polarity * subs_sc * (0 - vSubCon_sc);
      const vbeNow = pnjlim(vbeRaw_sc, s0[base + L1_SLOT_VBE], tpL1.vt, tpL1.tVcrit).value;
      const vbcNow = pnjlim(vbcRaw_sc, s0[base + L1_SLOT_VBC], tpL1.vt, tpL1.tVcrit).value;
      const vcsNow = pnjlim(vsubRaw_sc, s0[base + L1_SLOT_VSUB], tpL1.vt, tpL1.tSubVcrit).value;
      s0[base + L1_SLOT_VBE] = vbeNow;
      s0[base + L1_SLOT_VBC] = vbcNow;
      s0[base + L1_SLOT_VSUB] = vcsNow;

      // Read history voltages from s1 (last accepted step via StatePool rotation).
      const isFirstCall = pool.initMode === "initTran";
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
      // BJ13: XTF-modified diffusion cap using gbe (ngspice bjtload.c:584-585,593)
      const CjBE = computeJunctionCapacitance(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, mje_eff, params.FC);
      let CdBE: number;
      // cbe_for_q: transport current If*(1+argtf)/qb for charge computation.
      // Hoisted so both XTF and non-XTF branches set it for Q_BE below.
      let cbe_for_q = 0;
      if (tf_eff_base > 0 && params.XTF > 0 && vbeNow > 0) {
        const If_val = s0[base + L1_SLOT_OP_IF];
        const qb_val = s0[base + L1_SLOT_OP_QB];
        const gbe_raw = s0[base + L1_SLOT_OP_GBE];
        const ITF_safe = Math.max(params.ITF * params.AREA, 1e-30);
        const icRatio = If_val / (If_val + ITF_safe);
        const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
        const expTerm = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
        const argtf = params.XTF * icRatio * icRatio * expTerm;
        const arg2 = argtf * (3 - icRatio - icRatio);
        const cbe_mod = If_val * (1 + argtf) / Math.max(qb_val, 1e-30);
        cbe_for_q = cbe_mod;
        const dqbdVbe = s0[base + L1_SLOT_OP_DQBDVE];
        const gbe_mod = (gbe_raw * (1 + arg2) - cbe_mod * dqbdVbe) / Math.max(qb_val, 1e-30);
        CdBE = tf_eff_base * gbe_mod;
      } else {
        CdBE = tf_eff_base * s0[base + L1_SLOT_GM];
        if (tf_eff_base > 0) {
          cbe_for_q = s0[base + L1_SLOT_OP_IF] / Math.max(s0[base + L1_SLOT_OP_QB], 1e-30);
        }
      }
      const CtotalBE = CjBE + CdBE;

      // Store total BE capacitance for LTE tolerance reference
      s0[base + L1_SLOT_CTOT_BE] = CtotalBE;

      // BJ8: OP_CBE slot is set in updateOperatingPoint; CTOT_BE is the canonical cap value here

      // Compute Q_BE from current voltages (ngspice bjtload.c:591-601,703-706).
      // ngspice recomputes charge inside bjtload on EVERY NR iteration so that
      // NIintegrate sees fresh Q. Without this, Q stays frozen at the DC OP value
      // and the companion model's ccap=(Q0-Q1)/dt is always zero — making
      // capacitors electrically invisible and preventing transient convergence.
      {
        const Q_depl_BE = computeJunctionCharge(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, mje_eff, params.FC, 0, 0);
        s0[base + L1_SLOT_Q_BE] = Q_depl_BE + tf_eff_base * cbe_for_q;
        // ngspice bjtload.c:716-724: MODEINITTRAN — copy q0→q1 before NIintegrate
        if (isFirstCall) s1[base + L1_SLOT_Q_BE] = s0[base + L1_SLOT_Q_BE];
      }

      let beAg0 = 1 / dt;
      if (CtotalBE > 0) {
        const q0_be = s0[base + L1_SLOT_Q_BE];
        const q1_be = s1[base + L1_SLOT_Q_BE];
        const q2_be = s2[base + L1_SLOT_Q_BE];
        const ccapPrevBE = s1[base + L1_SLOT_CCAP_BE];
        const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
        const resBE = integrateCapacitor(CtotalBE, vbeNow, q0_be, q1_be, q2_be, dt, h1, h2, order, method, ccapPrevBE);
        s0[base + L1_SLOT_CAP_GEQ_BE] = resBE.geq;
        s0[base + L1_SLOT_CAP_IEQ_BE] = resBE.ceq;
        s0[base + L1_SLOT_CCAP_BE] = resBE.ccap;
        // ngspice bjtload.c:735-740: MODEINITTRAN — copy ccap0→ccap1 after NIintegrate
        if (isFirstCall) s1[base + L1_SLOT_CCAP_BE] = s0[base + L1_SLOT_CCAP_BE];
        beAg0 = resBE.ag0;
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BE] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BE] = 0;
        s0[base + L1_SLOT_CCAP_BE] = 0;
      }

      // B-C junction: depletion + reverse transit-time diffusion capacitance.
      // BJ12: Use temp-adjusted cap and exponent for BC junction
      // B-C junction: depletion + reverse transit-time diffusion capacitance.
      // BJ13: CdBC uses raw gbc (not gmu) per ngspice bjtload.c
      const CjBC = computeJunctionCapacitance(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, mjc_eff, params.FC);
      const CdBC = tr_eff * s0[base + L1_SLOT_OP_GBC];
      const CtotalBC = CjBC + CdBC;

      const xcjc = Math.min(Math.max(params.XCJC, 0), 1);

      // Store total BC capacitance for LTE tolerance reference
      s0[base + L1_SLOT_CTOT_BC] = CtotalBC;

      // Compute Q_BC from current voltages (ngspice bjtload.c:611-621).
      // Same rationale as Q_BE above — charge must be fresh for NIintegrate.
      {
        const Q_depl_BC = computeJunctionCharge(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, mjc_eff, params.FC, 0, 0);
        const Ir_for_q = s0[base + L1_SLOT_OP_IR];
        s0[base + L1_SLOT_Q_BC] = Q_depl_BC + tr_eff * Ir_for_q;
        // ngspice bjtload.c:716-724: MODEINITTRAN — copy q0→q1 before NIintegrate
        if (isFirstCall) s1[base + L1_SLOT_Q_BC] = s0[base + L1_SLOT_Q_BC];
      }

      if (CtotalBC > 0) {
        const q0_bc = s0[base + L1_SLOT_Q_BC];
        const q1_bc = s1[base + L1_SLOT_Q_BC];
        const q2_bc = s2[base + L1_SLOT_Q_BC];
        const ccapPrevBC = s1[base + L1_SLOT_CCAP_BC];
        const h1_bc = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2_bc = deltaOld.length > 2 ? deltaOld[2] : h1_bc;
        const resBC = integrateCapacitor(CtotalBC, vbcNow, q0_bc, q1_bc, q2_bc, dt, h1_bc, h2_bc, order, method, ccapPrevBC);
        s0[base + L1_SLOT_CCAP_BC] = resBC.ccap;
        // ngspice bjtload.c:735-740: MODEINITTRAN — copy ccap0→ccap1 after NIintegrate
        if (isFirstCall) s1[base + L1_SLOT_CCAP_BC] = s0[base + L1_SLOT_CCAP_BC];
        // Split by XCJC
        s0[base + L1_SLOT_CAP_GEQ_BC_INT] = xcjc * resBC.geq;
        s0[base + L1_SLOT_CAP_IEQ_BC_INT] = xcjc * resBC.ceq;
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = (1 - xcjc) * resBC.geq;
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = (1 - xcjc) * resBC.ceq;
      } else {
        s0[base + L1_SLOT_CCAP_BC] = 0;
        s0[base + L1_SLOT_CAP_GEQ_BC_INT] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BC_INT] = 0;
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = 0;
      }

      // BJ10: Collector-substrate capacitance using temperature-adjusted values.
      if (tpL1.tSubcap > 0 || params.CJS > 0) {
        // BJ12: Use temp-adjusted substrate exponent
        const CjCS = computeJunctionCapacitance(vcsNow, tpL1.tSubcap, tpL1.tSubpot, mjs_eff, params.FC);
        s0[base + L1_SLOT_CTOT_CS] = CjCS;

        // Compute Q_CS from current voltages (ngspice bjtload.c:631-641).
        // Same rationale as Q_BE — charge must be fresh for NIintegrate.
        {
          const czsub = tpL1.tSubcap;
          const ps = tpL1.tSubpot;
          const xms = mjs_eff;
          let Q_CS: number;
          if (vcsNow < 0) {
            const arg = Math.max(1 - vcsNow / ps, 1e-6);
            if (Math.abs(xms - 1) < 1e-10) {
              Q_CS = -ps * czsub * Math.log(arg);
            } else {
              Q_CS = ps * czsub * (1 - Math.pow(arg, 1 - xms)) / (1 - xms);
            }
          } else {
            Q_CS = vcsNow * czsub * (1 + xms * vcsNow / (2 * ps));
          }
          s0[base + L1_SLOT_Q_CS] = Q_CS;
          // ngspice bjtload.c:716-724: MODEINITTRAN — copy q0→q1 before NIintegrate
          if (isFirstCall) s1[base + L1_SLOT_Q_CS] = s0[base + L1_SLOT_Q_CS];
        }

        if (CjCS > 0) {
          const q0_cs = s0[base + L1_SLOT_Q_CS];
          const q1_cs = s1[base + L1_SLOT_Q_CS];
          const q2_cs = s2[base + L1_SLOT_Q_CS];
          const ccapPrevCS = s1[base + L1_SLOT_CCAP_CS];
          const h1_cs = deltaOld.length > 1 ? deltaOld[1] : dt;
          const h2_cs = deltaOld.length > 2 ? deltaOld[2] : h1_cs;
          const resCS = integrateCapacitor(CjCS, vcsNow, q0_cs, q1_cs, q2_cs, dt, h1_cs, h2_cs, order, method, ccapPrevCS);
          s0[base + L1_SLOT_CAP_GEQ_CS] = resCS.geq;
          s0[base + L1_SLOT_CAP_IEQ_CS] = resCS.ceq;
          s0[base + L1_SLOT_CCAP_CS] = resCS.ccap;
          // ngspice bjtload.c:735-740: MODEINITTRAN — copy ccap0→ccap1 after NIintegrate
          if (isFirstCall) s1[base + L1_SLOT_CCAP_CS] = s0[base + L1_SLOT_CCAP_CS];
        } else {
          s0[base + L1_SLOT_CAP_GEQ_CS] = 0;
          s0[base + L1_SLOT_CAP_IEQ_CS] = 0;
          s0[base + L1_SLOT_CCAP_CS] = 0;
        }
      }

      // BJ14: Recompute geqcb_dc (bjtload.c:591-611) from OP slots (fresh from
      // the most recent updateOperatingPoint call), then write GEQCB = ag0 * geqcb_dc
      // (bjtload.c:727). ag0 (beAg0) is sourced from this step's dt via
      // integrateCapacitor or falls back to 1/dt — no cross-call cached value.
      const sc_opIf = s0[base + L1_SLOT_OP_IF];
      const sc_opQb = s0[base + L1_SLOT_OP_QB];
      const sc_dqbdvc = s0[base + L1_SLOT_OP_DQBDVC];
      let geqcb_dc_fresh = 0;
      if (tf_eff_base > 0 && sc_opQb > 1e-30 && vbeNow > 0) {
        const ovtf_dc = params.VTF === Infinity ? 0 : 1 / (1.44 * params.VTF);
        let argtf_dc = 0;
        if (params.XTF > 0) {
          argtf_dc = params.XTF;
          if (ovtf_dc !== 0) {
            argtf_dc = argtf_dc * Math.exp(Math.min(vbcNow * ovtf_dc, 700));
          }
          const xjtf_dc = params.ITF * params.AREA;
          if (xjtf_dc > 0) {
            const temp_dc = sc_opIf / (sc_opIf + xjtf_dc);
            argtf_dc = argtf_dc * temp_dc * temp_dc;
          }
        }
        const arg3_dc = sc_opIf * argtf_dc * ovtf_dc;
        const cbe_mod_dc = sc_opIf * (1 + argtf_dc) / sc_opQb;
        geqcb_dc_fresh = tf_eff_base * (arg3_dc - cbe_mod_dc * sc_dqbdvc) / sc_opQb;
      }
      s0[base + L1_SLOT_GEQCB_DC] = geqcb_dc_fresh;
      s0[base + L1_SLOT_GEQCB] = beAg0 * geqcb_dc_fresh;

      if (tpL1.excessPhaseFactor > 0) {
        const td = tpL1.excessPhaseFactor;
        let cc = s0[base + L1_SLOT_IC_DC];
        // Read previous dt from s1 (after state rotation, s1 holds previous step's s0)
        const prevDt = s1[base + L1_SLOT_DT_PREV];

        if (prevDt > 0) {
          // ngspice bjtload.c:497-519 — corrected filter with quadratic denominator
          const r = dt / td;
          const r3 = 3 * r;
          const r3sq = 3 * r * r;
          const denom = 1 + r3sq + r3;

          const cexbc_prev = s1[base + L1_SLOT_CEXBC_PREV];
          const cexbc_prev2 = s1[base + L1_SLOT_CEXBC_PREV2];
          const dtRatio = dt / prevDt;

          // 3-term digital filter (bjtload.c:512-515)
          cc = (cexbc_prev * (1 + dtRatio + r3) - cexbc_prev2 * dtRatio) / denom;

          const arg3 = r3sq / denom;
          const opIf = s0[base + L1_SLOT_OP_IF];
          const opQb = s0[base + L1_SLOT_OP_QB];
          let argtf_run = 0;
          if (tf_eff_base > 0 && params.XTF > 0 && vbeNow > 0) {
            const ITF_safe_run = Math.max(params.ITF * params.AREA, 1e-30);
            const icRatioRun = opIf / (opIf + ITF_safe_run);
            const VTF_safe_run = params.VTF === Infinity ? 1e30 : params.VTF;
            const expTermRun = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe_run), 700));
            argtf_run = params.XTF * icRatioRun * icRatioRun * expTermRun;
          }
          const cbe_mod_run = opIf * (1 + argtf_run) / Math.max(opQb, 1e-30);
          const cex = cbe_mod_run * arg3;
          // cexbc(n) = cc + cex/qb (bjtload.c:518)
          s0[base + L1_SLOT_CEXBC_NOW] = cc + (opQb > 1e-30 ? cex / opQb : 0);

          // bjtload.c:540-541,559-560: filter gbe conductance and recompute gm/go
          // gex = gbe * arg3 (raw BE conductance scaled by filter factor)
          // cexRaw = If * arg3 (raw transport current scaled, pre-qb, as ngspice uses)
          // go = (gbc + (cexRaw - cbc)*dqbdvc/qb) / qb
          // gm = (gex - (cexRaw - cbc)*dqbdve/qb) / qb - go
          const gbe_raw_run = s0[base + L1_SLOT_OP_GBE];
          const gex = gbe_raw_run * arg3;
          const cexRaw = opIf * arg3;
          const cbcRaw = s0[base + L1_SLOT_OP_IR];
          const gbcRaw = s0[base + L1_SLOT_OP_GBC];
          const dqbdvc_run = s0[base + L1_SLOT_OP_DQBDVC];
          const dqbdve_run = s0[base + L1_SLOT_OP_DQBDVE];
          const qbSafe = Math.max(opQb, 1e-30);
          const go_filt = (gbcRaw + (cexRaw - cbcRaw) * dqbdvc_run / qbSafe) / qbSafe;
          const gm_filt = (gex - (cexRaw - cbcRaw) * dqbdve_run / qbSafe) / qbSafe - go_filt;
          s0[base + L1_SLOT_GM] = gm_filt;
          s0[base + L1_SLOT_GO] = go_filt;
          // Recompute Norton RHS with filtered gm/go (bjtload.c:803-808)
          const ic_sc = s0[base + L1_SLOT_IC];
          const ib_sc = s0[base + L1_SLOT_IB];
          const gpi_sc = s0[base + L1_SLOT_GPI];
          const gmu_sc = s0[base + L1_SLOT_GMU];
          const geqcb_sc = s0[base + L1_SLOT_GEQCB];
          s0[base + L1_SLOT_IC_NORTON] = ic_sc - (gm_filt + go_filt) * vbeNow + (go_filt + gmu_sc) * vbcNow;
          s0[base + L1_SLOT_IB_NORTON] = ib_sc - gpi_sc * vbeNow - gmu_sc * vbcNow - geqcb_sc * vbcNow;
          s0[base + L1_SLOT_IE_NORTON] = -(ic_sc + ib_sc) + (gm_filt + go_filt + gpi_sc) * vbeNow - (go_filt - geqcb_sc) * vbcNow;
        } else {
          // MODEINITTRAN: initialize history (bjtload.c:508-510)
          const opIf = s0[base + L1_SLOT_OP_IF];
          const opQb = s0[base + L1_SLOT_OP_QB];
          let initArgtf = 0;
          if (tf_eff_base > 0 && params.XTF > 0 && vbeNow > 0) {
            const ITF_safe = Math.max(params.ITF * params.AREA, 1e-30);
            const icRatioInit = opIf / (opIf + ITF_safe);
            const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
            const expTermInit = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
            initArgtf = params.XTF * icRatioInit * icRatioInit * expTermInit;
          }
          const cbe_mod_init = opIf * (1 + initArgtf) / Math.max(opQb, 1e-30);
          const cexbc_init = opQb > 1e-30 ? cbe_mod_init / opQb : 0;
          s0[base + L1_SLOT_CEXBC_NOW] = cexbc_init;
          s0[base + L1_SLOT_CEXBC_PREV] = cexbc_init;
          s0[base + L1_SLOT_CEXBC_PREV2] = cexbc_init;
        }

        // Shift history
        s0[base + L1_SLOT_CEXBC_PREV2] = s0[base + L1_SLOT_CEXBC_PREV];
        s0[base + L1_SLOT_CEXBC_PREV] = s0[base + L1_SLOT_CEXBC_NOW];
        s0[base + L1_SLOT_DT_PREV] = dt;
      }
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
        const ccap0 = s0[base + L1_SLOT_CCAP_BE];
        const ccap1 = s1[base + L1_SLOT_CCAP_BE];
        const dtBE = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
        if (dtBE < minDt) minDt = dtBE;
      }

      // B-C junction
      {
        const _q0 = s0[base + L1_SLOT_Q_BC];
        const _q1 = s1[base + L1_SLOT_Q_BC];
        const _q2 = s2[base + L1_SLOT_Q_BC];
        const _q3 = s3[base + L1_SLOT_Q_BC];
        const ccap0 = s0[base + L1_SLOT_CCAP_BC];
        const ccap1 = s1[base + L1_SLOT_CCAP_BC];
        const dtBC = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
        if (dtBC < minDt) minDt = dtBC;
      }

      // C-S junction (only if tSubSatCur > 0)
      if (tpL1.tSubSatCur > 0) {
        const _q0 = s0[base + L1_SLOT_Q_CS];
        const _q1 = s1[base + L1_SLOT_Q_CS];
        const _q2 = s2[base + L1_SLOT_Q_CS];
        const _q3 = s3[base + L1_SLOT_Q_CS];
        const ccap0 = s0[base + L1_SLOT_CCAP_CS];
        const ccap1 = s1[base + L1_SLOT_CCAP_CS];
        const dtCS = cktTerr(dt, deltaOld, order, method, _q0, _q1, _q2, _q3, ccap0, ccap1, lteParams);
        if (dtCS < minDt) minDt = dtCS;
      }

      return minDt;
    };



    element.updateChargeFlux = function(_voltages: Float64Array, dt: number, method: string, order: number, deltaOld: readonly number[]): void {
      // Compute limited junction voltages freshly from current node voltages
      // (ngspice bjtload.c:276-330 + 308-341). Single-pass semantics — do not
      // read a cross-phase cached slot.
      const vCi_uc = nodeC_int > 0 ? _voltages[nodeC_int - 1] : 0;
      const vBi_uc = nodeB_int > 0 ? _voltages[nodeB_int - 1] : 0;
      const vEi_uc = nodeE_int > 0 ? _voltages[nodeE_int - 1] : 0;
      const vbeRaw_uc = polarity * (vBi_uc - vEi_uc);
      const vbcRaw_uc = polarity * (vBi_uc - vCi_uc);
      const subs_uc = polarity > 0 ? 1 : -1;
      const substConNode_uc = subs_uc > 0 ? nodeC_int : nodeB_int;
      const vSubCon_uc = substConNode_uc > 0 ? _voltages[substConNode_uc - 1] : 0;
      const vsubRaw_uc = polarity * subs_uc * (0 - vSubCon_uc);
      const vbeNow = pnjlim(vbeRaw_uc, s0[base + L1_SLOT_VBE], tpL1.vt, tpL1.tVcrit).value;
      const vbcNow = pnjlim(vbcRaw_uc, s0[base + L1_SLOT_VBC], tpL1.vt, tpL1.tVcrit).value;
      const vcsNow = pnjlim(vsubRaw_uc, s0[base + L1_SLOT_VSUB], tpL1.vt, tpL1.tSubVcrit).value;
      s0[base + L1_SLOT_VBE] = vbeNow;
      s0[base + L1_SLOT_VBC] = vbcNow;
      s0[base + L1_SLOT_VSUB] = vcsNow;

      // B-E junction charge: depletion integral + diffusion charge
      // Depletion: analytical integral matching ngspice bjtload.c:591-601
      const Q_depl_BE = computeJunctionCharge(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, tpL1.tjunctionExpBE, params.FC, 0, 0);

      // Diffusion: TF * If * (1+argtf) / qb  (ngspice bjtload.c:584,591)
      const qb = s0[base + L1_SLOT_OP_QB];
      const If_val = s0[base + L1_SLOT_OP_IF];
      const TF = tpL1.ttransitTimeF;
      let argtf = 0;
      if (TF > 0 && params.XTF > 0 && vbeNow > 0) {
        const ITF_safe = Math.max(params.ITF * params.AREA, 1e-30);
        const icRatio = If_val / (If_val + ITF_safe);
        const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
        const expTerm = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
        argtf = params.XTF * icRatio * icRatio * expTerm;
      }
      const cbe_mod = If_val * (1 + argtf) / Math.max(qb, 1e-30);
      const Q_diff_BE = TF * cbe_mod;

      const CtotalBE = computeJunctionCapacitance(vbeNow, tpL1.tBEcap * params.AREA, tpL1.tBEpot, tpL1.tjunctionExpBE, params.FC);
      s0[base + L1_SLOT_Q_BE] = Q_depl_BE + Q_diff_BE;
      s0[base + L1_SLOT_V_BE] = vbeNow;
      s0[base + L1_SLOT_CTOT_BE] = CtotalBE + TF * s0[base + L1_SLOT_GM];

      // Recompute CCAP_BE from converged charge so the next step's trapezoidal
      // recursion and LTE tolerance start from the correct companion current.
      // Without this, s0[CCAP_BE] retains the mid-NR value from stampCompanion
      // and s1[CCAP_BE] carries a stale zero forward after acceptTimestep().
      // ngspice: bjtload.c recomputes ccap via NIintegrate after charge update.
      {
        const CtotalBE_full = s0[base + L1_SLOT_CTOT_BE];
        const q0_be = s0[base + L1_SLOT_Q_BE];
        const q1_be = s1[base + L1_SLOT_Q_BE];
        const q2_be = s2[base + L1_SLOT_Q_BE];
        const ccapPrevBE = s1[base + L1_SLOT_CCAP_BE];
        const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
        const resBE = integrateCapacitor(CtotalBE_full, vbeNow, q0_be, q1_be, q2_be, dt, h1, h2, order, method as IntegrationMethod, ccapPrevBE);
        s0[base + L1_SLOT_CCAP_BE] = resBE.ccap;
      }

      // B-C junction charge: depletion integral + diffusion charge
      const Q_depl_BC = computeJunctionCharge(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, tpL1.tjunctionExpBC, params.FC, 0, 0);
      const Ir_val = s0[base + L1_SLOT_OP_IR];
      const Q_diff_BC = tpL1.ttransitTimeR * Ir_val;
      const CtotalBC = computeJunctionCapacitance(vbcNow, tpL1.tBCcap * params.AREA, tpL1.tBCpot, tpL1.tjunctionExpBC, params.FC);
      s0[base + L1_SLOT_Q_BC] = Q_depl_BC + Q_diff_BC;
      s0[base + L1_SLOT_V_BC] = vbcNow;
      s0[base + L1_SLOT_CTOT_BC] = CtotalBC + tpL1.ttransitTimeR * s0[base + L1_SLOT_GMU];

      // Recompute CCAP_BC from converged charge (same rationale as CCAP_BE above).
      {
        const CtotalBC_full = s0[base + L1_SLOT_CTOT_BC];
        const q0_bc = s0[base + L1_SLOT_Q_BC];
        const q1_bc = s1[base + L1_SLOT_Q_BC];
        const q2_bc = s2[base + L1_SLOT_Q_BC];
        const ccapPrevBC = s1[base + L1_SLOT_CCAP_BC];
        const h1_bc = deltaOld.length > 1 ? deltaOld[1] : dt;
        const h2_bc = deltaOld.length > 2 ? deltaOld[2] : h1_bc;
        const resBC = integrateCapacitor(CtotalBC_full, vbcNow, q0_bc, q1_bc, q2_bc, dt, h1_bc, h2_bc, order, method as IntegrationMethod, ccapPrevBC);
        s0[base + L1_SLOT_CCAP_BC] = resBC.ccap;
      }

      // C-S substrate charge (ngspice bjtload.c:631-641)
      if (tpL1.tSubcap > 0) {
        const czsub = tpL1.tSubcap;
        const ps = tpL1.tSubpot;
        const xms = tpL1.tjunctionExpSub;
        let Q_CS: number;
        if (vcsNow < 0) {
          const arg = Math.max(1 - vcsNow / ps, 1e-6);
          if (Math.abs(xms - 1) < 1e-10) {
            Q_CS = -ps * czsub * Math.log(arg);
          } else {
            Q_CS = ps * czsub * (1 - Math.pow(arg, 1 - xms)) / (1 - xms);
          }
        } else {
          Q_CS = vcsNow * czsub * (1 + xms * vcsNow / (2 * ps));
        }
        s0[base + L1_SLOT_Q_CS] = Q_CS;
        s0[base + L1_SLOT_V_CS] = vcsNow;
        s0[base + L1_SLOT_CTOT_CS] = computeJunctionCapacitance(vcsNow, tpL1.tSubcap, tpL1.tSubpot, tpL1.tjunctionExpSub, params.FC);

        // Recompute CCAP_CS from converged charge (same rationale as CCAP_BE above).
        {
          const CjCS_ucf = s0[base + L1_SLOT_CTOT_CS];
          const q0_cs = s0[base + L1_SLOT_Q_CS];
          const q1_cs = s1[base + L1_SLOT_Q_CS];
          const q2_cs = s2[base + L1_SLOT_Q_CS];
          const ccapPrevCS = s1[base + L1_SLOT_CCAP_CS];
          const h1_cs = deltaOld.length > 1 ? deltaOld[1] : dt;
          const h2_cs = deltaOld.length > 2 ? deltaOld[2] : h1_cs;
          const resCS = integrateCapacitor(CjCS_ucf, vcsNow, q0_cs, q1_cs, q2_cs, dt, h1_cs, h2_cs, order, method as IntegrationMethod, ccapPrevCS);
          s0[base + L1_SLOT_CCAP_CS] = resCS.ccap;
        }
      } else if (params.CJS > 0) {
        const CjCS = computeJunctionCapacitance(vcsNow, tpL1.tSubcap, tpL1.tSubpot, tpL1.tjunctionExpSub, params.FC);
        s0[base + L1_SLOT_Q_CS] = CjCS * vcsNow;
        s0[base + L1_SLOT_V_CS] = vcsNow;
        s0[base + L1_SLOT_CTOT_CS] = CjCS;

        // Recompute CCAP_CS for the CJS-only path.
        {
          const q0_cs = s0[base + L1_SLOT_Q_CS];
          const q1_cs = s1[base + L1_SLOT_Q_CS];
          const q2_cs = s2[base + L1_SLOT_Q_CS];
          const ccapPrevCS = s1[base + L1_SLOT_CCAP_CS];
          const h1_cs = deltaOld.length > 1 ? deltaOld[1] : dt;
          const h2_cs = deltaOld.length > 2 ? deltaOld[2] : h1_cs;
          const resCS = integrateCapacitor(CjCS, vcsNow, q0_cs, q1_cs, q2_cs, dt, h1_cs, h2_cs, order, method as IntegrationMethod, ccapPrevCS);
          s0[base + L1_SLOT_CCAP_CS] = resCS.ccap;
        }
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
// getSpiceL1InternalNodeLabels — mirror of getSpiceL1InternalNodeCount
// ---------------------------------------------------------------------------

/**
 * Returns internal node labels for a SPICE L1 BJT instance. Order MUST
 * match getSpiceL1InternalNodeCount and createSpiceL1BjtElement's
 * internalNodeIds consumption (see bjt.ts:1243-1245): B' (RB>0), then
 * C' (RC>0), then E' (RE>0).
 */
function getSpiceL1InternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  if (props.getModelParam<number>("RB") > 0) labels.push("B'");
  if (props.getModelParam<number>("RC") > 0) labels.push("C'");
  if (props.getModelParam<number>("RE") > 0) labels.push("E'");
  return labels;
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
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N3904": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N3904,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "BC547B": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_BC547B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2222A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2222A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2219A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(1, pinNodes, internalNodeIds, branchIdx, props),
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
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N3906": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N3906,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "BC557B": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_BC557B,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "2N2907A": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N2907A,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
    "TIP32C": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createSpiceL1BjtElement(-1, pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_TIP32C,
      getInternalNodeCount: getSpiceL1InternalNodeCount,
      getInternalNodeLabels: getSpiceL1InternalNodeLabels,
    },
  },
  defaultModel: "spice",
};
