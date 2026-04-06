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

/** Thermal voltage at 300 K (kT/q). */
const VT = 0.02585;

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: BJT_PARAM_DEFS, defaults: BJT_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
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
  },
});

export const { defaults: BJT_PNP_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
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
  },
});

// ---------------------------------------------------------------------------
// SPICE Level 1 model parameter declarations (superset of simple params)
// ---------------------------------------------------------------------------

export const { paramDefs: BJT_SPICE_L1_PARAM_DEFS, defaults: BJT_SPICE_L1_NPN_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
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
  },
});

export const { defaults: BJT_SPICE_L1_PNP_DEFAULTS } = defineModelParams({
  primary: {
    BF:  { default: 100,    description: "Forward current gain" },
    IS:  { default: 1e-14,  unit: "A", description: "Saturation current" },
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
}

// ---------------------------------------------------------------------------
// computeBjtOp — Gummel-Poon operating point
// ---------------------------------------------------------------------------

function computeBjtOp(
  vbe: number,
  vbc: number,
  IS: number,
  BF: number,
  NF: number,
  BR: number,
  NR: number,
  ISE: number,
  ISC: number,
  VAF: number,
  VAR: number,
  IKF: number,
  IKR: number,
): BjtOperatingPoint {
  const nfVt = NF * VT;
  const nrVt = NR * VT;

  // Forward and reverse junction exponentials
  const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
  const expVbc = Math.exp(Math.min(vbc / nrVt, 700));

  // Forward and reverse transport currents
  const If = IS * (expVbe - 1);
  const Ir = IS * (expVbc - 1);

  // Base charge factor qb (Early effect + high injection)
  // qb = (1 + Vbc/VAR + Vbe/VAF) * (1 + sqrt(1 + If/IKF + Ir/IKR)) / 2
  // Simplified as per SPICE Level 1 Gummel-Poon: base charge factor handles
  // Early effect and high injection via two terms.

  const q1 = 1 / (1 - vbc / (VAR === Infinity ? 1e30 : VAR) - vbe / (VAF === Infinity ? 1e30 : VAF));
  const q2 = If / (IKF === Infinity ? 1e30 : IKF) + Ir / (IKR === Infinity ? 1e30 : IKR);
  const qb = q1 * (1 + Math.sqrt(1 + 4 * q2)) / 2;

  // Collector and base currents
  const ic = (If - Ir) / qb;

  // Non-ideal base current contributions (ISE, ISC with emission coefficients)
  // For simplicity we use NF and NR for ISE/ISC emission (Level 1 approximation)
  const ibIdeal = If / BF + Ir / BR;
  const ibNonIdeal =
    (ISE > 0 ? ISE * (expVbe - 1) : 0) +
    (ISC > 0 ? ISC * (expVbc - 1) : 0);
  const ib = ibIdeal + ibNonIdeal;

  // Linearized conductances via chain rule
  // dIf/dVbe = IS * exp(Vbe/nfVt) / nfVt
  const dIfdVbe = IS * expVbe / nfVt;
  // dIr/dVbc = IS * exp(Vbc/nrVt) / nrVt
  const dIrdVbc = IS * expVbc / nrVt;

  // dqb/dVbe and dqb/dVbc (Early effect + high injection Jacobian)
  const sqrtTerm = Math.sqrt(Math.max(1 + 4 * q2, 1e-30));
  const dqbdIf = q1 / sqrtTerm / (IKF === Infinity ? 1e30 : IKF);
  const dqbdIr = q1 / sqrtTerm / (IKR === Infinity ? 1e30 : IKR);

  const VAF_safe = VAF === Infinity ? 1e30 : VAF;
  const VAR_safe = VAR === Infinity ? 1e30 : VAR;
  const dq1dVbe = q1 * q1 / VAF_safe;
  const dq1dVbc = q1 * q1 / VAR_safe;
  const dqbdVbe = dq1dVbe * (1 + sqrtTerm) / 2 + dqbdIf * dIfdVbe;
  const dqbdVbc = dq1dVbc * (1 + sqrtTerm) / 2 + dqbdIr * dIrdVbc;

  // d(ic)/dVbe = dIf/dVbe/qb - (If-Ir)*dqb/dVbe/qb^2
  const gm = dIfdVbe / qb - ic * dqbdVbe / qb + GMIN;
  // d(ic)/dVbc = -dIr/dVbc/qb - (If-Ir)*dqb/dVbc/qb^2
  // go = d(Ic)/d(Vce) = d(Ic)/d(Vbc) (since Vce = Vbe - Vbc)
  const go = dIrdVbc / qb + ic * dqbdVbc / qb + GMIN;

  // d(ib)/dVbe = dIf/(BF*nfVt) + ISE*exp(Vbe/nfVt)/nfVt
  const gpi = dIfdVbe / BF + (ISE > 0 ? ISE * expVbe / nfVt : 0) + GMIN;
  // d(ib)/dVbc = dIr/(BR*nrVt) + ISC*exp(Vbc/nrVt)/nrVt
  const gmu = dIrdVbc / BR + (ISC > 0 ? ISC * expVbc / nrVt : 0) + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu };
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
  };

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
  let base: number;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true as const,
    poolBacked: true as const,
    stateSchema: BJT_SIMPLE_SCHEMA,
    stateSize: BJT_SIMPLE_SCHEMA.size,
    stateBaseOffset: -1,

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      base = this.stateBaseOffset;
      applyInitialValues(BJT_SIMPLE_SCHEMA, pool, base, { polarity });
      const op0 = computeBjtOp(
        0, 0,
        params.IS, params.BF, params.NF, params.BR, params.NR,
        params.ISE, params.ISC, params.VAF, params.VAR, params.IKF, params.IKR,
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
      // The BJT equivalent circuit (linearized Gummel-Poon) has:
      //   - Conductance gpi between B and E
      //   - Conductance gmu between B and C
      //   - Conductance go between C and E
      //   - VCCS gm*Vbe: current from E to C
      //
      // Norton equivalents at each node:
      //   Ic_norton = ic - (gm+go)*vbe + go*vbc (stored in pool as SLOT_IC_NORTON with sign convention below)
      //   Ib_norton = ib - gpi*vbe - gmu*vbc

      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const icNorton = s0[base + SLOT_IC_NORTON];
      const ibNorton = s0[base + SLOT_IB_NORTON];
      const ieNorton = -(icNorton + ibNorton);

      // Stamp conductances (gpi between B-E, gmu between B-C, go between C-E)
      // gpi between B and E
      stampG(solver, nodeB, nodeB, gpi);
      stampG(solver, nodeB, nodeE, -gpi);
      stampG(solver, nodeE, nodeB, -gpi);
      stampG(solver, nodeE, nodeE, gpi);

      // gmu between B and C
      stampG(solver, nodeB, nodeB, gmu);
      stampG(solver, nodeB, nodeC, -gmu);
      stampG(solver, nodeC, nodeB, -gmu);
      stampG(solver, nodeC, nodeC, gmu);

      // go between C and E
      stampG(solver, nodeC, nodeC, go);
      stampG(solver, nodeC, nodeE, -go);
      stampG(solver, nodeE, nodeC, -go);
      stampG(solver, nodeE, nodeE, go);

      // gm*vbe transconductance: gm stamps in C-E cross terms
      // The VCCS gm*Vbe adds gm to the [C,B] position and -gm to [C,E] and
      // -gm to [E,B] and gm to [E,E] (since Vbe = Vb - Ve)
      stampG(solver, nodeC, nodeB, gm);
      stampG(solver, nodeC, nodeE, -gm);
      stampG(solver, nodeE, nodeB, -gm);
      stampG(solver, nodeE, nodeE, gm);

      // Norton RHS at each terminal
      stampRHS(solver, nodeC, -polarity * icNorton);
      stampRHS(solver, nodeB, -polarity * ibNorton);
      stampRHS(solver, nodeE, -polarity * ieNorton);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): void {
      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // Recompute derived values from mutable params
      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      const vcritBE = nfVt * Math.log(nfVt / (params.IS * Math.SQRT2));
      const vcritBC = nrVt * Math.log(nrVt / (params.IS * Math.SQRT2));

      // Junction voltages (polarity-corrected for PNP)
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      // Apply pnjlim to both junctions using vold from pool
      const vbeLimited = pnjlim(vbeRaw, s0[base + SLOT_VBE], nfVt, vcritBE);
      const vbcLimited = pnjlim(vbcRaw, s0[base + SLOT_VBC], nrVt, vcritBC);

      s0[base + SLOT_VBE] = vbeLimited;
      s0[base + SLOT_VBC] = vbcLimited;

      const op = computeBjtOp(
        vbeLimited, vbcLimited,
        params.IS, params.BF, params.NF, params.BR, params.NR,
        params.ISE, params.ISC, params.VAF, params.VAR, params.IKF, params.IKR,
      );

      s0[base + SLOT_GPI] = op.gpi;
      s0[base + SLOT_GMU] = op.gmu;
      s0[base + SLOT_GM]  = op.gm;
      s0[base + SLOT_GO]  = op.go;
      s0[base + SLOT_IC]  = op.ic;
      s0[base + SLOT_IB]  = op.ib;
      s0[base + SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + op.go * vbcLimited;
      s0[base + SLOT_IB_NORTON] = op.ib - op.gpi * vbeLimited - op.gmu * vbcLimited;
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];

      // ngspice icheck: junction voltage must match what pnjlim accepted
      // (mirrors the BJTload icheck flag that gates entry to BJTconvTest)
      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      if (Math.abs(delvbe) > nfVt || Math.abs(delvbc) > nrVt) {
        return false;
      }

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
      if (key in params) params[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// computeSpiceL1BjtOp — Gummel-Poon with separate NE/NC emission coefficients
// ---------------------------------------------------------------------------

function computeSpiceL1BjtOp(
  vbe: number,
  vbc: number,
  IS: number,
  BF: number,
  NF: number,
  BR: number,
  NR: number,
  ISE: number,
  ISC: number,
  NE: number,
  NC: number,
  VAF: number,
  VAR: number,
  IKF: number,
  IKR: number,
): BjtOperatingPoint {
  const nfVt = NF * VT;
  const nrVt = NR * VT;
  const neVt = NE * VT;
  const ncVt = NC * VT;

  const expVbe = Math.exp(Math.min(vbe / nfVt, 700));
  const expVbc = Math.exp(Math.min(vbc / nrVt, 700));

  const If = IS * (expVbe - 1);
  const Ir = IS * (expVbc - 1);

  const q1 = 1 / (1 - vbc / (VAR === Infinity ? 1e30 : VAR) - vbe / (VAF === Infinity ? 1e30 : VAF));
  const q2 = If / (IKF === Infinity ? 1e30 : IKF) + Ir / (IKR === Infinity ? 1e30 : IKR);
  const qb = q1 * (1 + Math.sqrt(1 + 4 * q2)) / 2;

  const ic = (If - Ir) / qb;

  // Non-ideal base current: ISE uses NE emission, ISC uses NC emission
  const expVbeNE = ISE > 0 ? Math.exp(Math.min(vbe / neVt, 700)) : 0;
  const expVbcNC = ISC > 0 ? Math.exp(Math.min(vbc / ncVt, 700)) : 0;

  const ibIdeal = If / BF + Ir / BR;
  const ibNonIdeal =
    (ISE > 0 ? ISE * (expVbeNE - 1) : 0) +
    (ISC > 0 ? ISC * (expVbcNC - 1) : 0);
  const ib = ibIdeal + ibNonIdeal;

  // Linearized conductances
  const dIfdVbe = IS * expVbe / nfVt;
  const dIrdVbc = IS * expVbc / nrVt;

  const sqrtTerm = Math.sqrt(Math.max(1 + 4 * q2, 1e-30));
  const dqbdIf = q1 / sqrtTerm / (IKF === Infinity ? 1e30 : IKF);
  const dqbdIr = q1 / sqrtTerm / (IKR === Infinity ? 1e30 : IKR);

  const VAF_safe = VAF === Infinity ? 1e30 : VAF;
  const VAR_safe = VAR === Infinity ? 1e30 : VAR;
  const dq1dVbe = q1 * q1 / VAF_safe;
  const dq1dVbc = q1 * q1 / VAR_safe;
  const dqbdVbe = dq1dVbe * (1 + sqrtTerm) / 2 + dqbdIf * dIfdVbe;
  const dqbdVbc = dq1dVbc * (1 + sqrtTerm) / 2 + dqbdIr * dIrdVbc;

  const gm = dIfdVbe / qb - ic * dqbdVbe / qb + GMIN;
  const go = dIrdVbc / qb + ic * dqbdVbc / qb + GMIN;

  // gpi: dIb/dVbe includes ISE with NE emission coefficient
  const gpi = dIfdVbe / BF + (ISE > 0 ? ISE * expVbeNE / neVt : 0) + GMIN;
  // gmu: dIb/dVbc includes ISC with NC emission coefficient
  const gmu = dIrdVbc / BR + (ISC > 0 ? ISC * expVbcNC / ncVt : 0) + GMIN;

  return { vbe, vbc, ic, ib, gm, go, gpi, gmu };
}

// ---------------------------------------------------------------------------
// State schema — BJT SPICE L1 (24 slots)
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
  { name: "CAP_GEQ_BE",     doc: "B-E junction-cap companion conductance",           init: { kind: "zero" } },
  { name: "CAP_IEQ_BE",     doc: "B-E junction-cap companion history current",       init: { kind: "zero" } },
  { name: "CAP_GEQ_BC_INT", doc: "B-C internal junction-cap companion conductance",  init: { kind: "zero" } },
  { name: "CAP_IEQ_BC_INT", doc: "B-C internal junction-cap companion history current", init: { kind: "zero" } },
  { name: "CAP_GEQ_BC_EXT", doc: "B-C external junction-cap companion conductance",  init: { kind: "zero" } },
  { name: "CAP_IEQ_BC_EXT", doc: "B-C external junction-cap companion history current", init: { kind: "zero" } },
  { name: "CAP_GEQ_CS",     doc: "C-S junction-cap companion conductance",           init: { kind: "zero" } },
  { name: "CAP_IEQ_CS",     doc: "C-S junction-cap companion history current",       init: { kind: "zero" } },
  { name: "VBE_PREV",       doc: "B-E voltage at previous accepted step",            init: { kind: "zero" } },
  { name: "VBC_PREV",       doc: "B-C voltage at previous accepted step",            init: { kind: "zero" } },
  { name: "VCS_PREV",       doc: "C-S voltage at previous accepted step",            init: { kind: "zero" } },
  { name: "CAP_FIRST_CALL", doc: "1 until first stampCompanion call; then 0",        init: { kind: "constant", value: 1.0 } },
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
  };

  // Internal nodes: if resistance > 0, use allocated internal node; else short to external
  let intIdx = 0;
  const nodeB_int = params.RB > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeB_ext;
  const nodeC_int = params.RC > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeC_ext;
  const nodeE_int = params.RE > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeE_ext;

  const hasCapacitance = params.CJE > 0 || params.CJC > 0 || params.TF > 0 || params.TR > 0 || params.CJS > 0;

  // State pool slot indices (BJT SPICE L1, stateSize: 24)
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
  // Junction capacitance companion model state (slots 12–23)
  const L1_SLOT_CAP_GEQ_BE     = 12;
  const L1_SLOT_CAP_IEQ_BE     = 13;
  const L1_SLOT_CAP_GEQ_BC_INT = 14;
  const L1_SLOT_CAP_IEQ_BC_INT = 15;
  const L1_SLOT_CAP_GEQ_BC_EXT = 16;
  const L1_SLOT_CAP_IEQ_BC_EXT = 17;
  const L1_SLOT_CAP_GEQ_CS     = 18;
  const L1_SLOT_CAP_IEQ_CS     = 19;
  const L1_SLOT_VBE_PREV        = 20;
  const L1_SLOT_VBC_PREV        = 21;
  const L1_SLOT_VCS_PREV        = 22;
  const L1_SLOT_CAP_FIRST_CALL  = 23;  // 1.0 = first call (true), 0.0 = subsequent

  // Pool binding — set by initState
  let s0: Float64Array;
  let base: number;

  const element: ReactiveAnalogElementCore = {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true as const,
    poolBacked: true as const,
    stateSchema: BJT_L1_SCHEMA,
    stateSize: BJT_L1_SCHEMA.size,
    stateBaseOffset: -1,

    initState(pool: StatePoolRef): void {
      s0 = pool.state0;
      base = this.stateBaseOffset;
      applyInitialValues(BJT_L1_SCHEMA, pool, base, { polarity, RB: params.RB });
      const op0 = computeSpiceL1BjtOp(
        0, 0,
        params.IS, params.BF, params.NF, params.BR, params.NR,
        params.ISE, params.ISC, params.NE, params.NC,
        params.VAF, params.VAR, params.IKF, params.IKR,
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
    },

    stamp(solver: SparseSolver): void {
      // Stamp terminal resistances.
      // RB is current-dependent (IRB/RBM), computed in updateOperatingPoint; use rbEff from pool.
      if (params.RB > 0 && nodeB_int !== nodeB_ext) {
        const gRB = 1 / s0[base + L1_SLOT_RB_EFF];
        stampG(solver, nodeB_ext, nodeB_ext, gRB);
        stampG(solver, nodeB_ext, nodeB_int, -gRB);
        stampG(solver, nodeB_int, nodeB_ext, -gRB);
        stampG(solver, nodeB_int, nodeB_int, gRB);
      }
      if (params.RC > 0 && nodeC_int !== nodeC_ext) {
        const gRC = 1 / params.RC;
        stampG(solver, nodeC_ext, nodeC_ext, gRC);
        stampG(solver, nodeC_ext, nodeC_int, -gRC);
        stampG(solver, nodeC_int, nodeC_ext, -gRC);
        stampG(solver, nodeC_int, nodeC_int, gRC);
      }
      if (params.RE > 0 && nodeE_int !== nodeE_ext) {
        const gRE = 1 / params.RE;
        stampG(solver, nodeE_ext, nodeE_ext, gRE);
        stampG(solver, nodeE_ext, nodeE_int, -gRE);
        stampG(solver, nodeE_int, nodeE_ext, -gRE);
        stampG(solver, nodeE_int, nodeE_int, gRE);
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
        stampG(solver, nodeB_int, nodeB_int, _capGeqBE);
        stampG(solver, nodeB_int, nodeE_int, -_capGeqBE);
        stampG(solver, nodeE_int, nodeB_int, -_capGeqBE);
        stampG(solver, nodeE_int, nodeE_int, _capGeqBE);
        stampRHS(solver, nodeB_int, -_capIeqBE);
        stampRHS(solver, nodeE_int, _capIeqBE);
      }
      // B-C capacitance: XCJC fraction between internal nodes, (1-XCJC) between external nodes.
      if (_capGeqBC_int !== 0 || _capIeqBC_int !== 0) {
        stampG(solver, nodeB_int, nodeB_int, _capGeqBC_int);
        stampG(solver, nodeB_int, nodeC_int, -_capGeqBC_int);
        stampG(solver, nodeC_int, nodeB_int, -_capGeqBC_int);
        stampG(solver, nodeC_int, nodeC_int, _capGeqBC_int);
        stampRHS(solver, nodeB_int, -_capIeqBC_int);
        stampRHS(solver, nodeC_int, _capIeqBC_int);
      }
      if (_capGeqBC_ext !== 0 || _capIeqBC_ext !== 0) {
        stampG(solver, nodeB_ext, nodeB_ext, _capGeqBC_ext);
        stampG(solver, nodeB_ext, nodeC_ext, -_capGeqBC_ext);
        stampG(solver, nodeC_ext, nodeB_ext, -_capGeqBC_ext);
        stampG(solver, nodeC_ext, nodeC_ext, _capGeqBC_ext);
        stampRHS(solver, nodeB_ext, -_capIeqBC_ext);
        stampRHS(solver, nodeC_ext, _capIeqBC_ext);
      }
      // Collector-substrate capacitance: between external collector and ground.
      if (_capGeqCS !== 0 || _capIeqCS !== 0) {
        stampG(solver, nodeC_ext, nodeC_ext, _capGeqCS);
        // ground node = 0, skipped per MNA convention
        stampRHS(solver, nodeC_ext, -_capIeqCS);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      const gpi = s0[base + L1_SLOT_GPI];
      const gmu = s0[base + L1_SLOT_GMU];
      const gm  = s0[base + L1_SLOT_GM];
      const go  = s0[base + L1_SLOT_GO];
      const icNorton = s0[base + L1_SLOT_IC_NORTON];
      const ibNorton = s0[base + L1_SLOT_IB_NORTON];
      const ieNorton = s0[base + L1_SLOT_IE_NORTON];

      // gpi between B_int and E_int
      stampG(solver, nodeB_int, nodeB_int, gpi);
      stampG(solver, nodeB_int, nodeE_int, -gpi);
      stampG(solver, nodeE_int, nodeB_int, -gpi);
      stampG(solver, nodeE_int, nodeE_int, gpi);

      // gmu between B_int and C_int
      stampG(solver, nodeB_int, nodeB_int, gmu);
      stampG(solver, nodeB_int, nodeC_int, -gmu);
      stampG(solver, nodeC_int, nodeB_int, -gmu);
      stampG(solver, nodeC_int, nodeC_int, gmu);

      // go between C_int and E_int
      stampG(solver, nodeC_int, nodeC_int, go);
      stampG(solver, nodeC_int, nodeE_int, -go);
      stampG(solver, nodeE_int, nodeC_int, -go);
      stampG(solver, nodeE_int, nodeE_int, go);

      // gm*vbe VCCS
      stampG(solver, nodeC_int, nodeB_int, gm);
      stampG(solver, nodeC_int, nodeE_int, -gm);
      stampG(solver, nodeE_int, nodeB_int, -gm);
      stampG(solver, nodeE_int, nodeE_int, gm);

      // Norton RHS at internal terminals
      stampRHS(solver, nodeC_int, -polarity * icNorton);
      stampRHS(solver, nodeB_int, -polarity * ibNorton);
      stampRHS(solver, nodeE_int, -polarity * ieNorton);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>): void {
      // Read internal node voltages
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      const vcritBE = nfVt * Math.log(nfVt / (params.IS * Math.SQRT2));
      const vcritBC = nrVt * Math.log(nrVt / (params.IS * Math.SQRT2));

      const vbeRaw = polarity * (vBi - vEi);
      const vbcRaw = polarity * (vBi - vCi);

      const vbeLimited = pnjlim(vbeRaw, s0[base + L1_SLOT_VBE], nfVt, vcritBE);
      const vbcLimited = pnjlim(vbcRaw, s0[base + L1_SLOT_VBC], nrVt, vcritBC);
      // Save limited voltages to pool
      s0[base + L1_SLOT_VBE] = vbeLimited;
      s0[base + L1_SLOT_VBC] = vbcLimited;

      const op = computeSpiceL1BjtOp(
        vbeLimited, vbcLimited,
        params.IS, params.BF, params.NF, params.BR, params.NR,
        params.ISE, params.ISC, params.NE, params.NC,
        params.VAF, params.VAR, params.IKF, params.IKR,
      );

      s0[base + L1_SLOT_GPI] = op.gpi;
      s0[base + L1_SLOT_GMU] = op.gmu;
      s0[base + L1_SLOT_GM]  = op.gm;
      s0[base + L1_SLOT_GO]  = op.go;
      s0[base + L1_SLOT_IC]  = op.ic;
      s0[base + L1_SLOT_IB]  = op.ib;
      s0[base + L1_SLOT_IC_NORTON] = op.ic - (op.gm + op.go) * vbeLimited + op.go * vbcLimited;
      s0[base + L1_SLOT_IB_NORTON] = op.ib - op.gpi * vbeLimited - op.gmu * vbcLimited;
      s0[base + L1_SLOT_IE_NORTON] = -(op.ic + op.ib) + (op.gm + op.go + op.gpi) * vbeLimited + (op.gmu - op.go) * vbcLimited;

      // Update current-dependent base resistance (IRB/RBM).
      // When IRB > 0 and RBM < RB, Rb varies with base current magnitude.
      // Formula from ngspice/SPICE3: Rb(Ib) = RBM + 3*(RB-RBM)*(tan(z)-z)/(z*tan²(z))
      // where z = (-1 + sqrt(1 + 14.59*|Ib|/IRB)) / (2.4 * sqrt(|Ib|/IRB + 1e-30))
      if (params.IRB > 0 && params.RBM > 0 && params.RBM < params.RB) {
        const Ib_abs = Math.abs(op.ib) + 1e-30;
        const x = Ib_abs / params.IRB;
        const z = (-1 + Math.sqrt(1 + 14.59265 * x)) / (2.4494897 * Math.sqrt(x + 1e-30));
        const tanz = Math.tan(z);
        const factor = (tanz > 1e-10 && z > 1e-10) ? 3 * (tanz - z) / (z * tanz * tanz) : 1;
        s0[base + L1_SLOT_RB_EFF] = Math.max(params.RBM, params.RBM + (params.RB - params.RBM) * factor);
      } else {
        s0[base + L1_SLOT_RB_EFF] = params.RB;
      }
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;
      const vbeRaw = polarity * (vBi - vEi);
      const vbcRaw = polarity * (vBi - vCi);

      const delvbe = vbeRaw - s0[base + L1_SLOT_VBE];
      const delvbc = vbcRaw - s0[base + L1_SLOT_VBC];

      // ngspice icheck: junction voltage must match what pnjlim accepted
      const nfVt = params.NF * VT;
      const nrVt = params.NR * VT;
      if (Math.abs(delvbe) > nfVt || Math.abs(delvbc) > nrVt) {
        return false;
      }

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
      if (key in params) params[key] = value;
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

      // Read history voltages and first-call flag from pool BEFORE writing new values.
      const isFirstCall = s0[base + L1_SLOT_CAP_FIRST_CALL] !== 0;
      const prevVbe = isFirstCall ? vbeNow : s0[base + L1_SLOT_VBE_PREV];
      const prevVbc = isFirstCall ? vbcNow : s0[base + L1_SLOT_VBC_PREV];
      const prevVcs = isFirstCall ? vcsNow : s0[base + L1_SLOT_VCS_PREV];
      s0[base + L1_SLOT_VBE_PREV] = vbeNow;
      s0[base + L1_SLOT_VBC_PREV] = vbcNow;
      s0[base + L1_SLOT_VCS_PREV] = vcsNow;
      s0[base + L1_SLOT_CAP_FIRST_CALL] = 0.0;

      // B-E junction: depletion + transit-time diffusion capacitance.
      // Transit time modulation: TF_eff = TF * (1 + XTF*(Ic/(Ic+ITF))^2 * exp(Vbc/(1.44*VTF)))
      let TF_eff = params.TF;
      if (params.TF > 0 && params.XTF > 0) {
        const Ic = s0[base + L1_SLOT_IC];
        const ITF_safe = params.ITF > 0 ? params.ITF : 1e-30;
        const icRatio = Ic / (Ic + ITF_safe);
        const VTF_safe = params.VTF === Infinity ? 1e30 : params.VTF;
        const expTerm = Math.exp(Math.min(vbcNow / (1.44 * VTF_safe), 700));
        TF_eff = params.TF * (1 + params.XTF * icRatio * icRatio * expTerm);
      }

      const CjBE = computeJunctionCapacitance(vbeNow, params.CJE, params.VJE, params.MJE, params.FC);
      const CdBE = TF_eff * s0[base + L1_SLOT_GM];
      const CtotalBE = CjBE + CdBE;

      if (CtotalBE > 0) {
        const iBE = s0[base + L1_SLOT_CAP_GEQ_BE] * vbeNow + s0[base + L1_SLOT_CAP_IEQ_BE];
        s0[base + L1_SLOT_CAP_GEQ_BE] = capacitorConductance(CtotalBE, dt, method);
        s0[base + L1_SLOT_CAP_IEQ_BE] = capacitorHistoryCurrent(CtotalBE, dt, method, vbeNow, prevVbe, iBE);
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BE] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BE] = 0;
      }

      // B-C junction: depletion + reverse transit-time diffusion capacitance.
      // Split by XCJC: internal fraction goes to internal B-C nodes, rest to external.
      const CjBC = computeJunctionCapacitance(vbcNow, params.CJC, params.VJC, params.MJC, params.FC);
      const CdBC = params.TR * s0[base + L1_SLOT_GMU];
      const CtotalBC = CjBC + CdBC;

      const xcjc = Math.min(Math.max(params.XCJC, 0), 1);
      const CtotalBC_int = xcjc * CtotalBC;
      const CtotalBC_ext = (1 - xcjc) * CtotalBC;

      if (CtotalBC_int > 0) {
        const iBC_int = s0[base + L1_SLOT_CAP_GEQ_BC_INT] * vbcNow + s0[base + L1_SLOT_CAP_IEQ_BC_INT];
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
        const iBC_ext = s0[base + L1_SLOT_CAP_GEQ_BC_EXT] * vbcExt + s0[base + L1_SLOT_CAP_IEQ_BC_EXT];
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = capacitorConductance(CtotalBC_ext, dt, method);
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = capacitorHistoryCurrent(CtotalBC_ext, dt, method, vbcExt, prevVbc, iBC_ext);
      } else {
        s0[base + L1_SLOT_CAP_GEQ_BC_EXT] = 0;
        s0[base + L1_SLOT_CAP_IEQ_BC_EXT] = 0;
      }

      // Collector-substrate capacitance (CJS): between external collector and ground.
      if (params.CJS > 0) {
        const CjCS = computeJunctionCapacitance(vcsNow, params.CJS, params.VJS, params.MJS, params.FC);
        if (CjCS > 0) {
          const iCS = s0[base + L1_SLOT_CAP_GEQ_CS] * vcsNow + s0[base + L1_SLOT_CAP_IEQ_CS];
          s0[base + L1_SLOT_CAP_GEQ_CS] = capacitorConductance(CjCS, dt, method);
          s0[base + L1_SLOT_CAP_IEQ_CS] = capacitorHistoryCurrent(CjCS, dt, method, vcsNow, prevVcs, iCS);
        } else {
          s0[base + L1_SLOT_CAP_GEQ_CS] = 0;
          s0[base + L1_SLOT_CAP_IEQ_CS] = 0;
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
