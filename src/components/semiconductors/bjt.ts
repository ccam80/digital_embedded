/**
 * BJT analog components  NPN and PNP bipolar junction transistors.
 *
 * Simple L0 and SPICE L1 (Gummel-Poon) models ported mechanically from
 * `ref/ngspice/src/spicelib/devices/bjt/bjtload.c::BJTload`. Single-pass load()
 * per device per NR iteration. No cached `Float64Array` references to `pool.states[N]`  every state
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import {
  MODEINITJCT, MODEINITFIX, MODEINITSMSIG, MODEINITTRAN, MODEINITPRED,
  MODETRAN, MODEAC, MODETRANOP, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, deviceParams, kelvinToCelsius } from "../../core/model-params.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";
import {
  CONSTboltz as k,
  CHARGE as q_charge,
  CONSTKoverQ as KoverQ,
  REFTEMP,
} from "../../core/constants.js";

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
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
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
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
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
    // bjtsetup.c:50-55 — separate B-E / B-C saturation currents; when both are
    // given they replace IS in the BE/BC junction-current evaluation (bjtload.c:456,486).
    IBE: { default: 0,      unit: "A", spiceName: "ibe", description: "B-E saturation current (quasi-saturation split)" },
    IBC: { default: 0,      unit: "A", spiceName: "ibc", description: "B-C saturation current (quasi-saturation split)" },
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
    RB:  { default: 0,      unit: "Î", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Î", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Î", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Î", description: "Emitter resistance" },
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
    PTF: { default: 0,      unit: "°", description: "Excess phase at freq=1/(2Ï€·TF)" },
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
    // Kull quasi-saturation model (bjtsetup.c:163-175, :364-381). RCO defaults to
    // 0.01 (clamp at bjtsetup.c:163-166); the netlist-given flag, tracked
    // separately via isModelParamGiven("RCO"), gates the QS load/setup blocks.
    RCO:   { default: 0.01,   unit: "Ω", spiceName: "rco", description: "Intrinsic (epitaxial) collector resistance" },
    VO:    { default: 10.0,   unit: "V", spiceName: "vo", description: "Epi-region drift saturation voltage" },
    GAMMA: { default: 1.0e-11, spiceName: "gamma", description: "Epi-region doping factor" },
    QCO:   { default: 0,      spiceName: "qco", description: "Epi-region charge factor" },
    QUASIMOD: { default: 0,   spiceName: "quasimod", description: "Quasi-saturation temperature-equation selector" },
    EGQS:  { default: 1.206,  unit: "eV", spiceName: "vg", description: "Energy gap for quasi-saturation temperature dependence" },
    XRCI:  { default: 2.42,   spiceName: "cn", description: "Temperature exponent of RCO (NPN default)" },
    XD:    { default: 0.87,   spiceName: "d", description: "Temperature exponent of VO (NPN default)" },
    // TLEV / TLEVC temperature-model selectors (bjtsetup.c:176-181, bjttemp.c:166-313).
    TLEV:  { default: 0,      spiceName: "tlev", description: "Temperature-equation selector (saturation/leakage)" },
    TLEVC: { default: 0,      spiceName: "tlevc", description: "Temperature-equation selector (junction capacitances)" },
    // Per-parameter linear/quadratic temperature coefficients (bjtsetup.c:182-363).
    // Default 0 makes the (1 + t1·dt + t2·dt²) multiplier inert (= 1).
    TBF1:  { default: 0, spiceName: "tbf1" }, TBF2:  { default: 0, spiceName: "tbf2" },
    TBR1:  { default: 0, spiceName: "tbr1" }, TBR2:  { default: 0, spiceName: "tbr2" },
    TIKF1: { default: 0, spiceName: "tikf1" }, TIKF2: { default: 0, spiceName: "tikf2" },
    TIKR1: { default: 0, spiceName: "tikr1" }, TIKR2: { default: 0, spiceName: "tikr2" },
    TIRB1: { default: 0, spiceName: "tirb1" }, TIRB2: { default: 0, spiceName: "tirb2" },
    TNC1:  { default: 0, spiceName: "tnc1" }, TNC2:  { default: 0, spiceName: "tnc2" },
    TNE1:  { default: 0, spiceName: "tne1" }, TNE2:  { default: 0, spiceName: "tne2" },
    TNF1:  { default: 0, spiceName: "tnf1" }, TNF2:  { default: 0, spiceName: "tnf2" },
    TNR1:  { default: 0, spiceName: "tnr1" }, TNR2:  { default: 0, spiceName: "tnr2" },
    TRB1:  { default: 0, spiceName: "trb1" }, TRB2:  { default: 0, spiceName: "trb2" },
    TRC1:  { default: 0, spiceName: "trc1" }, TRC2:  { default: 0, spiceName: "trc2" },
    TRE1:  { default: 0, spiceName: "tre1" }, TRE2:  { default: 0, spiceName: "tre2" },
    TRM1:  { default: 0, spiceName: "trm1" }, TRM2:  { default: 0, spiceName: "trm2" },
    TVAF1: { default: 0, spiceName: "tvaf1" }, TVAF2: { default: 0, spiceName: "tvaf2" },
    TVAR1: { default: 0, spiceName: "tvar1" }, TVAR2: { default: 0, spiceName: "tvar2" },
    TITF1: { default: 0, spiceName: "titf1" }, TITF2: { default: 0, spiceName: "titf2" },
    TTF1:  { default: 0, spiceName: "ttf1" }, TTF2:  { default: 0, spiceName: "ttf2" },
    TTR1:  { default: 0, spiceName: "ttr1" }, TTR2:  { default: 0, spiceName: "ttr2" },
    TMJE1: { default: 0, spiceName: "tmje1" }, TMJE2: { default: 0, spiceName: "tmje2" },
    TMJC1: { default: 0, spiceName: "tmjc1" }, TMJC2: { default: 0, spiceName: "tmjc2" },
    TMJS1: { default: 0, spiceName: "tmjs1" }, TMJS2: { default: 0, spiceName: "tmjs2" },
    TNS1:  { default: 0, spiceName: "tns1" }, TNS2:  { default: 0, spiceName: "tns2" },
    TIS1:  { default: 0, spiceName: "tis1" }, TIS2:  { default: 0, spiceName: "tis2" },
    TISE1: { default: 0, spiceName: "tise1" }, TISE2: { default: 0, spiceName: "tise2" },
    TISC1: { default: 0, spiceName: "tisc1" }, TISC2: { default: 0, spiceName: "tisc2" },
    TISS1: { default: 0, spiceName: "tiss1" }, TISS2: { default: 0, spiceName: "tiss2" },
    CTC:   { default: 0, spiceName: "ctc" }, CTE:   { default: 0, spiceName: "cte" }, CTS:   { default: 0, spiceName: "cts" },
    TVJE:  { default: 0, spiceName: "tvje" }, TVJC:  { default: 0, spiceName: "tvjc" }, TVJS:  { default: 0, spiceName: "tvjs" },
    // SOA operating-area limits (bjtsetup.c:382-403). Declare-only: no load/setup
    // numerical effect here; consumed by the diagnostic warning pass.
    IC_MAX: { default: 1e99, unit: "A", spiceName: "ic_max", description: "SOA maximum collector current" },
    IB_MAX: { default: 1e99, unit: "A", spiceName: "ib_max", description: "SOA maximum base current" },
    PD_MAX: { default: 1e99, unit: "W", spiceName: "pd_max", description: "SOA maximum power dissipation" },
    TE_MAX: { default: 1e99, unit: "K", spiceName: "te_max", description: "SOA maximum temperature" },
    RTH0:   { default: 0,    spiceName: "rth0", description: "SOA thermal resistance (pd_max derating; no synthesized default)" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    AREAB: { default: 1,    description: "Base-area factor" },
    AREAC: { default: 1,    description: "Collector-area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
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
    // bjtsetup.c:50-55 — separate B-E / B-C saturation currents; when both are
    // given they replace IS in the BE/BC junction-current evaluation (bjtload.c:456,486).
    IBE: { default: 0,      unit: "A", spiceName: "ibe", description: "B-E saturation current (quasi-saturation split)" },
    IBC: { default: 0,      unit: "A", spiceName: "ibc", description: "B-C saturation current (quasi-saturation split)" },
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
    RB:  { default: 0,      unit: "Î", description: "Zero-bias base resistance" },
    IRB: { default: 0,      unit: "A", description: "Current where base resistance falls halfway to minimum" },
    RBM: { default: 0,      unit: "Î", description: "Minimum base resistance at high currents" },
    RC:  { default: 0,      unit: "Î", description: "Collector resistance" },
    RE:  { default: 0,      unit: "Î", description: "Emitter resistance" },
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
    PTF: { default: 0,      unit: "°", description: "Excess phase at freq=1/(2Ï€·TF)" },
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
    // Kull quasi-saturation model (bjtsetup.c:163-175, :364-381). PNP XRCI/XD
    // defaults differ from NPN (bjtsetup.c:370-381).
    RCO:   { default: 0.01,   unit: "Ω", spiceName: "rco", description: "Intrinsic (epitaxial) collector resistance" },
    VO:    { default: 10.0,   unit: "V", spiceName: "vo", description: "Epi-region drift saturation voltage" },
    GAMMA: { default: 1.0e-11, spiceName: "gamma", description: "Epi-region doping factor" },
    QCO:   { default: 0,      spiceName: "qco", description: "Epi-region charge factor" },
    QUASIMOD: { default: 0,   spiceName: "quasimod", description: "Quasi-saturation temperature-equation selector" },
    EGQS:  { default: 1.206,  unit: "eV", spiceName: "vg", description: "Energy gap for quasi-saturation temperature dependence" },
    XRCI:  { default: 2.2,    spiceName: "cn", description: "Temperature exponent of RCO (PNP default)" },
    XD:    { default: 0.52,   spiceName: "d", description: "Temperature exponent of VO (PNP default)" },
    // TLEV / TLEVC temperature-model selectors (bjtsetup.c:176-181, bjttemp.c:166-313).
    TLEV:  { default: 0,      spiceName: "tlev", description: "Temperature-equation selector (saturation/leakage)" },
    TLEVC: { default: 0,      spiceName: "tlevc", description: "Temperature-equation selector (junction capacitances)" },
    // Per-parameter linear/quadratic temperature coefficients (bjtsetup.c:182-363).
    TBF1:  { default: 0, spiceName: "tbf1" }, TBF2:  { default: 0, spiceName: "tbf2" },
    TBR1:  { default: 0, spiceName: "tbr1" }, TBR2:  { default: 0, spiceName: "tbr2" },
    TIKF1: { default: 0, spiceName: "tikf1" }, TIKF2: { default: 0, spiceName: "tikf2" },
    TIKR1: { default: 0, spiceName: "tikr1" }, TIKR2: { default: 0, spiceName: "tikr2" },
    TIRB1: { default: 0, spiceName: "tirb1" }, TIRB2: { default: 0, spiceName: "tirb2" },
    TNC1:  { default: 0, spiceName: "tnc1" }, TNC2:  { default: 0, spiceName: "tnc2" },
    TNE1:  { default: 0, spiceName: "tne1" }, TNE2:  { default: 0, spiceName: "tne2" },
    TNF1:  { default: 0, spiceName: "tnf1" }, TNF2:  { default: 0, spiceName: "tnf2" },
    TNR1:  { default: 0, spiceName: "tnr1" }, TNR2:  { default: 0, spiceName: "tnr2" },
    TRB1:  { default: 0, spiceName: "trb1" }, TRB2:  { default: 0, spiceName: "trb2" },
    TRC1:  { default: 0, spiceName: "trc1" }, TRC2:  { default: 0, spiceName: "trc2" },
    TRE1:  { default: 0, spiceName: "tre1" }, TRE2:  { default: 0, spiceName: "tre2" },
    TRM1:  { default: 0, spiceName: "trm1" }, TRM2:  { default: 0, spiceName: "trm2" },
    TVAF1: { default: 0, spiceName: "tvaf1" }, TVAF2: { default: 0, spiceName: "tvaf2" },
    TVAR1: { default: 0, spiceName: "tvar1" }, TVAR2: { default: 0, spiceName: "tvar2" },
    TITF1: { default: 0, spiceName: "titf1" }, TITF2: { default: 0, spiceName: "titf2" },
    TTF1:  { default: 0, spiceName: "ttf1" }, TTF2:  { default: 0, spiceName: "ttf2" },
    TTR1:  { default: 0, spiceName: "ttr1" }, TTR2:  { default: 0, spiceName: "ttr2" },
    TMJE1: { default: 0, spiceName: "tmje1" }, TMJE2: { default: 0, spiceName: "tmje2" },
    TMJC1: { default: 0, spiceName: "tmjc1" }, TMJC2: { default: 0, spiceName: "tmjc2" },
    TMJS1: { default: 0, spiceName: "tmjs1" }, TMJS2: { default: 0, spiceName: "tmjs2" },
    TNS1:  { default: 0, spiceName: "tns1" }, TNS2:  { default: 0, spiceName: "tns2" },
    TIS1:  { default: 0, spiceName: "tis1" }, TIS2:  { default: 0, spiceName: "tis2" },
    TISE1: { default: 0, spiceName: "tise1" }, TISE2: { default: 0, spiceName: "tise2" },
    TISC1: { default: 0, spiceName: "tisc1" }, TISC2: { default: 0, spiceName: "tisc2" },
    TISS1: { default: 0, spiceName: "tiss1" }, TISS2: { default: 0, spiceName: "tiss2" },
    CTC:   { default: 0, spiceName: "ctc" }, CTE:   { default: 0, spiceName: "cte" }, CTS:   { default: 0, spiceName: "cts" },
    TVJE:  { default: 0, spiceName: "tvje" }, TVJC:  { default: 0, spiceName: "tvjc" }, TVJS:  { default: 0, spiceName: "tvjs" },
    // SOA operating-area limits (bjtsetup.c:382-403). Declare-only.
    IC_MAX: { default: 1e99, unit: "A", spiceName: "ic_max", description: "SOA maximum collector current" },
    IB_MAX: { default: 1e99, unit: "A", spiceName: "ib_max", description: "SOA maximum base current" },
    PD_MAX: { default: 1e99, unit: "W", spiceName: "pd_max", description: "SOA maximum power dissipation" },
    TE_MAX: { default: 1e99, unit: "K", spiceName: "te_max", description: "SOA maximum temperature" },
    RTH0:   { default: 0,    spiceName: "rth0", description: "SOA thermal resistance (pd_max derating; no synthesized default)" },
    TNOM: { default: 300.15, unit: "K", description: "Nominal temperature", spiceConverter: kelvinToCelsius },
  },
  instance: {
    AREA: { default: 1,     description: "Device area factor" },
    AREAB: { default: 1,    description: "Base-area factor" },
    AREAC: { default: 1,    description: "Collector-area factor" },
    M:   { default: 1,      description: "Parallel device multiplier" },
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
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
// Temperature / area scaling  maps to bjttemp.c:158-257
// ---------------------------------------------------------------------------

interface BjtTempParams {
  vt: number;
  tSatCur: number;
  tBEtSatCur: number;
  tBCtSatCur: number;
  tintCollResist: number;
  tepiSatVoltage: number;
  tepiDoping: number;
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
  temissionCoeffF: number;
  temissionCoeffR: number;
  tleakBEemissionCoeff: number;
  tleakBCemissionCoeff: number;
  ttransitTimeHighCurrentF: number;
  temissionCoeffS: number;
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

/**
 * Optional v41 temperature-model inputs (TLEV/TLEVC selectors, per-parameter
 * tempco pairs, Kull QS params, BE/BC satcur split, area-orientation factors,
 * and the givenness flags that gate each ngspice branch). Absent fields default
 * to ngspice's `!Given ⇒ 0` / unset behaviour (bjtsetup.c:176-403), making the
 * full pass inert and bit-preserving for callers that supply none of them.
 */
interface BjtTempExtra {
  isLateral?: boolean;
  AREAB?: number; AREAC?: number; areabGiven?: boolean; areacGiven?: boolean;
  IBE?: number; IBC?: number;
  RCO?: number; VO?: number; GAMMA?: number;
  QUASIMOD?: number; EGQS?: number; XRCI?: number; XD?: number;
  TLEV?: number; TLEVC?: number;
  TBF1?: number; TBF2?: number; TBR1?: number; TBR2?: number;
  TIKF1?: number; TIKF2?: number; TIKR1?: number; TIKR2?: number;
  TIRB1?: number; TIRB2?: number;
  TNC1?: number; TNC2?: number; TNE1?: number; TNE2?: number;
  TNF1?: number; TNF2?: number; TNR1?: number; TNR2?: number;
  TRB1?: number; TRB2?: number; TRC1?: number; TRC2?: number;
  TRE1?: number; TRE2?: number; TRM1?: number; TRM2?: number;
  TVAF1?: number; TVAF2?: number; TVAR1?: number; TVAR2?: number;
  TITF1?: number; TITF2?: number; TTF1?: number; TTF2?: number;
  TTR1?: number; TTR2?: number;
  TMJE1?: number; TMJE2?: number; TMJC1?: number; TMJC2?: number;
  TMJS1?: number; TMJS2?: number; TNS1?: number; TNS2?: number;
  TIS1?: number; TIS2?: number; TISE1?: number; TISE2?: number;
  TISC1?: number; TISC2?: number; TISS1?: number; TISS2?: number;
  CTC?: number; CTE?: number; CTS?: number;
  TVJE?: number; TVJC?: number; TVJS?: number;
  rcoGiven?: boolean; ibeGiven?: boolean; ibcGiven?: boolean; issGiven?: boolean;
  vafGiven?: boolean; varGiven?: boolean; ikfGiven?: boolean; ikrGiven?: boolean;
  rcGiven?: boolean; reGiven?: boolean;
  tbf1Given?: boolean; tbf2Given?: boolean; tbr1Given?: boolean; tbr2Given?: boolean;
}

/**
 * Full v41 BJT temperature pass — operand-for-operand transcription of
 * ref/ngspice/src/spicelib/devices/bjt/bjttemp.c:44-333 (BJTtemp). Every
 * per-instance quantity gains its `(1 + t<x>1·dt + t<x>2·dt²)` tempco
 * multiplier and its area fold (`·BJTarea` / `/BJTarea` / `·areab` / `·areac`),
 * so load()/stampAc() no longer apply area; the tlev/tlevc branches, the
 * pbfact1 nominal band-gap factor, the BE/BC saturation-current split, the
 * mje/mjc/mjs>0.999 grading clamp, and the Kull QS temp block all land here.
 */
function computeBjtTempParams(p: {
  IS: number; BF: number; BR: number; ISE: number; ISC: number;
  NE: number; NC: number; EG: number; XTI: number; XTB: number;
  NF: number; NR: number; NS: number;
  IKF: number; IKR: number; RC: number; RE: number; RB: number; RBM: number;
  IRB: number; CJE: number; VJE: number; MJE: number;
  CJC: number; VJC: number; MJC: number; CJS: number; VJS: number; MJS: number;
  FC: number; AREA: number; TNOM: number;
  VAF: number; VAR: number;
  PTF: number; TF: number; TR: number; ITF: number;
  ISS: number; TEMP: number;
}, T: number, x: BjtTempExtra = {}): BjtTempParams {
  // Area-orientation factors (bjttemp.c uses BJTsubs == VERTICAL/LATERAL).
  // cite: bjtsetup.c:414-418 — areab/areac default to area when not given.
  const isLateral = x.isLateral ?? false;
  const areab = x.areabGiven ? (x.AREAB ?? p.AREA) : p.AREA;
  const areac = x.areacGiven ? (x.AREAC ?? p.AREA) : p.AREA;
  // tempco pairs (default 0 ⇒ inert multiplier).
  const o = (v: number | undefined): number => v ?? 0;
  const tlev = o(x.TLEV);
  const tlevc = o(x.TLEVC);

  const vt = T * KoverQ;
  const vtnom = KoverQ * p.TNOM;
  const fact1 = p.TNOM / REFTEMP;
  const fact2 = T / REFTEMP;
  const dt = T - p.TNOM;

  // cite: bjttemp.c:83-104 — Early-voltage inverses + roll-off inverses, with
  // tempco multipliers; roll-off is area-folded (/area).
  const tinvEarlyVoltF = (x.vafGiven && p.VAF !== 0 && isFinite(p.VAF))
    ? 1 / (p.VAF * (1 + o(x.TVAF1) * dt + o(x.TVAF2) * dt * dt)) : 0;
  let tinvRollOffF: number;
  if (x.ikfGiven && p.IKF !== 0 && isFinite(p.IKF)) {
    tinvRollOffF = 1 / (p.IKF * (1 + o(x.TIKF1) * dt + o(x.TIKF2) * dt * dt));
    tinvRollOffF /= p.AREA;
  } else tinvRollOffF = 0;
  const tinvEarlyVoltR = (x.varGiven && p.VAR !== 0 && isFinite(p.VAR))
    ? 1 / (p.VAR * (1 + o(x.TVAR1) * dt + o(x.TVAR2) * dt * dt)) : 0;
  let tinvRollOffR: number;
  if (x.ikrGiven && p.IKR !== 0 && isFinite(p.IKR)) {
    tinvRollOffR = 1 / (p.IKR * (1 + o(x.TIKR1) * dt + o(x.TIKR2) * dt * dt));
    tinvRollOffR /= p.AREA;
  } else tinvRollOffR = 0;

  // cite: bjttemp.c:105-116 — collector/emitter conductances, area-folded (·area).
  let tcollectorConduct: number;
  if (x.rcGiven && p.RC !== 0) {
    tcollectorConduct = 1 / (p.RC * (1 + o(x.TRC1) * dt + o(x.TRC2) * dt * dt));
    tcollectorConduct *= p.AREA;
  } else tcollectorConduct = 0;
  let temitterConduct: number;
  if (x.reGiven && p.RE !== 0) {
    temitterConduct = 1 / (p.RE * (1 + o(x.TRE1) * dt + o(x.TRE2) * dt * dt));
    temitterConduct *= p.AREA;
  } else temitterConduct = 0;

  // cite: bjttemp.c:47-48 — minBaseResist defaults to baseResist when ungiven.
  const minBaseResistBase = p.RBM > 0 ? p.RBM : p.RB;
  // cite: bjttemp.c:118-123 — base resistances, area-folded.
  let tbaseResist = p.RB * (1 + o(x.TRB1) * dt + o(x.TRB2) * dt * dt);
  tbaseResist /= p.AREA;
  let tminBaseResist = minBaseResistBase * (1 + o(x.TRM1) * dt + o(x.TRM2) * dt * dt);
  tminBaseResist /= p.AREA;
  let tbaseCurrentHalfResist = p.IRB * (1 + o(x.TIRB1) * dt + o(x.TIRB2) * dt * dt);
  tbaseCurrentHalfResist *= p.AREA;

  // cite: bjttemp.c:124-147 — emission coeffs (used as Nx·vt in load), transit
  // times (ttransitTimeHighCurrentF area-folded), junction grading w/ clamp.
  const temissionCoeffF = p.NF * (1 + o(x.TNF1) * dt + o(x.TNF2) * dt * dt);
  const temissionCoeffR = p.NR * (1 + o(x.TNR1) * dt + o(x.TNR2) * dt * dt);
  const tleakBEemissionCoeff = p.NE * (1 + o(x.TNE1) * dt + o(x.TNE2) * dt * dt);
  const tleakBCemissionCoeff = p.NC * (1 + o(x.TNC1) * dt + o(x.TNC2) * dt * dt);
  let ttransitTimeHighCurrentF = p.ITF * (1 + o(x.TITF1) * dt + o(x.TITF2) * dt * dt);
  ttransitTimeHighCurrentF *= p.AREA;
  const ttransitTimeF = p.TF * (1 + o(x.TTF1) * dt + o(x.TTF2) * dt * dt);
  const ttransitTimeR = p.TR * (1 + o(x.TTR1) * dt + o(x.TTR2) * dt * dt);
  let tjunctionExpBE = p.MJE * (1 + o(x.TMJE1) * dt + o(x.TMJE2) * dt * dt);
  if (tjunctionExpBE > 0.999) tjunctionExpBE = 0.999;
  let tjunctionExpBC = p.MJC * (1 + o(x.TMJC1) * dt + o(x.TMJC2) * dt * dt);
  if (tjunctionExpBC > 0.999) tjunctionExpBC = 0.999;
  let tjunctionExpSub = p.MJS * (1 + o(x.TMJS1) * dt + o(x.TMJS2) * dt * dt);
  if (tjunctionExpSub > 0.999) tjunctionExpSub = 0.999;
  const temissionCoeffS = p.NS * (1 + o(x.TNS1) * dt + o(x.TNS2) * dt * dt);

  // cite: bjttemp.c:149-165 — band-gap factors at T and at TNOM (pbfact1).
  const egfet = 1.16 - (7.02e-4 * T * T) / (T + 1108);
  const arg = -egfet / (2 * k * T) + 1.1150877 / (k * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + q_charge * arg);
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (2 * k * p.TNOM) + 1.1150877 / (k * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + q_charge * arg1);

  const ratlog = Math.log(T / p.TNOM);
  const ratio1 = T / p.TNOM - 1;
  const factlog = ratio1 * p.EG / vt + p.XTI * ratlog;

  const ibeGiven = x.ibeGiven ?? false;
  const ibcGiven = x.ibcGiven ?? false;
  const bothSatGiven = ibeGiven && ibcGiven;
  const issGiven = x.issGiven ?? false;

  // cite: bjttemp.c:166-197 — saturation currents, tlev==0/1 vs tlev==3.
  let tSatCur = 0, tBEtSatCur = 0, tBCtSatCur = 0, tSubSatCur = 0;
  if (tlev === 0 || tlev === 1) {
    let factor = Math.exp(factlog);
    tSatCur = p.AREA * p.IS * factor;
    if (bothSatGiven) { factor = Math.exp(factlog / temissionCoeffF); tBEtSatCur = p.AREA * o(x.IBE) * factor; }
    else tBEtSatCur = tSatCur;
    if (bothSatGiven) { factor = Math.exp(factlog / temissionCoeffR); tBCtSatCur = o(x.IBC) * factor; }
    else tBCtSatCur = tSatCur;
    if (issGiven) tSubSatCur = p.ISS * factor;
  } else if (tlev === 3) {
    tSatCur = p.AREA * Math.pow(p.IS, 1 + o(x.TIS1) * dt + o(x.TIS2) * dt * dt);
    if (bothSatGiven) tBEtSatCur = p.AREA * Math.pow(o(x.IBE), 1 + o(x.TIS1) * dt + o(x.TIS2) * dt * dt);
    else tBEtSatCur = tSatCur;
    if (bothSatGiven) tBCtSatCur = Math.pow(o(x.IBC), 1 + o(x.TIS1) * dt + o(x.TIS2) * dt * dt);
    else tBCtSatCur = tSatCur;
    if (issGiven) tSubSatCur = Math.pow(p.ISS, 1 + o(x.TISS1) * dt + o(x.TISS2) * dt * dt);
  }
  // cite: bjttemp.c:198-213 — BC/sub satcur area fold (subs orientation).
  if (!isLateral) tBCtSatCur *= areab; else tBCtSatCur *= areac;
  if (issGiven) {
    if (bothSatGiven) { if (!isLateral) tSubSatCur *= areac; else tSubSatCur *= areab; }
    else tSubSatCur *= p.AREA;
  }

  // cite: bjttemp.c:215-229 — Kull QS temp block (gated on rcoGiven).
  let tintCollResist = 0, tepiSatVoltage = 0, tepiDoping = 0;
  if (x.rcoGiven) {
    if (o(x.QUASIMOD) === 1) {
      const rT = T / p.TNOM;
      tintCollResist = o(x.RCO) * Math.pow(rT, o(x.XRCI));
      tepiSatVoltage = o(x.VO) * Math.pow(rT, o(x.XD));
      const xvar1 = Math.pow(rT, p.XTI);
      const xvar2 = -o(x.EGQS) * (1.0 - rT) / vt;
      const xvar3 = Math.exp(xvar2);
      tepiDoping = o(x.GAMMA) * xvar1 * xvar3;
    } else {
      tintCollResist = o(x.RCO);
      tepiSatVoltage = o(x.VO);
      tepiDoping = o(x.GAMMA);
    }
  }

  // cite: bjttemp.c:231-243 — beta temp factor; tempco arms override bfactor.
  let bfactor = 1.0;
  if (tlev === 0) bfactor = Math.exp(ratlog * p.XTB);
  else if (tlev === 1) bfactor = 1 + p.XTB * dt;
  const tBetaF = (x.tbf1Given || x.tbf2Given)
    ? p.BF * (1 + o(x.TBF1) * dt + o(x.TBF2) * dt * dt) : p.BF * bfactor;
  const tBetaR = (x.tbr1Given || x.tbr2Given)
    ? p.BR * (1 + o(x.TBR1) * dt + o(x.TBR2) * dt * dt) : p.BR * bfactor;

  // cite: bjttemp.c:245-258 — leakage currents, tlev==0/1 vs ==3, then BC fold.
  let tBEleakCur = 0, tBCleakCur = 0;
  if (tlev === 0 || tlev === 1) {
    tBEleakCur = p.AREA * p.ISE * Math.exp(factlog / tleakBEemissionCoeff) / bfactor;
    tBCleakCur = p.ISC * Math.exp(factlog / tleakBCemissionCoeff) / bfactor;
  } else if (tlev === 3) {
    tBEleakCur = p.AREA * Math.pow(p.ISE, 1 + o(x.TISE1) * dt + o(x.TISE2) * dt * dt);
    tBCleakCur = Math.pow(p.ISC, 1 + o(x.TISC1) * dt + o(x.TISC2) * dt * dt);
  }
  if (!isLateral) tBCleakCur *= areab; else tBCleakCur *= areac;

  // cite: bjttemp.c:260-313 — junction capacitances, tlevc==0 (pbfact1) vs ==1.
  let tBEcap: number, tBEpot: number;
  if (tlevc === 0) {
    const pbo = (p.VJE - pbfact1) / fact1;
    const gmaold = (p.VJE - pbo) / pbo;
    tBEcap = p.CJE / (1 + tjunctionExpBE * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
    tBEpot = fact2 * pbo + pbfact;
    const gmanew = (tBEpot - pbo) / pbo;
    tBEcap *= 1 + tjunctionExpBE * (4e-4 * (T - REFTEMP) - gmanew);
  } else {
    tBEcap = p.CJE * (1 + o(x.CTE) * dt);
    tBEpot = p.VJE - o(x.TVJE) * dt;
  }
  tBEcap *= p.AREA;

  let tBCcap: number, tBCpot: number;
  if (tlevc === 0) {
    const pbo = (p.VJC - pbfact1) / fact1;
    const gmaold = (p.VJC - pbo) / pbo;
    tBCcap = p.CJC / (1 + tjunctionExpBC * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
    tBCpot = fact2 * pbo + pbfact;
    const gmanew = (tBCpot - pbo) / pbo;
    tBCcap *= 1 + tjunctionExpBC * (4e-4 * (T - REFTEMP) - gmanew);
  } else {
    tBCcap = p.CJC * (1 + o(x.CTC) * dt);
    tBCpot = p.VJC - o(x.TVJC) * dt;
  }
  if (!isLateral) tBCcap *= areab; else tBCcap *= areac;

  let tSubcap: number, tSubpot: number;
  if (tlevc === 0) {
    const pbo = (p.VJS - pbfact1) / fact1;
    const gmaold = (p.VJS - pbo) / pbo;
    tSubcap = p.CJS / (1 + tjunctionExpSub * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
    tSubpot = fact2 * pbo + pbfact;
    const gmanew = (tSubpot - pbo) / pbo;
    tSubcap *= 1 + tjunctionExpSub * (4e-4 * (T - REFTEMP) - gmanew);
  } else {
    tSubcap = p.CJS * (1 + o(x.CTS) * dt);
    tSubpot = p.VJS - o(x.TVJS) * dt;
  }
  // cite: bjttemp.c:310-313 — substrate cap area fold is swapped vs BC (·areac VERTICAL).
  if (!isLateral) tSubcap *= areac; else tSubcap *= areab;

  // cite: bjttemp.c:315-333 — depletion-cap fit coefficients + critical voltages.
  const xfc = Math.log(1 - p.FC);
  const tDepCap = p.FC * tBEpot;
  const tf1 = tBEpot * (1 - Math.exp((1 - tjunctionExpBE) * xfc)) / (1 - tjunctionExpBE);
  const tf4 = p.FC * tBCpot;
  const tf5 = tBCpot * (1 - Math.exp((1 - tjunctionExpBC) * xfc)) / (1 - tjunctionExpBC);
  const tVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCur));
  const tSubVcrit = issGiven ? vt * Math.log(vt / (Math.SQRT2 * tSubSatCur)) : Infinity;
  const f2 = Math.exp((1 + tjunctionExpBE) * xfc);
  const f3 = 1 - p.FC * (1 + tjunctionExpBE);
  const f6 = Math.exp((1 + tjunctionExpBC) * xfc);
  const f7 = 1 - p.FC * (1 + tjunctionExpBC);

  const excessPhaseFactor = (p.PTF > 0 && p.TF > 0) ? (p.PTF / (180 / Math.PI)) * p.TF : 0;

  return {
    vt, tSatCur, tBEtSatCur, tBCtSatCur,
    tintCollResist, tepiSatVoltage, tepiDoping,
    tBetaF, tBetaR, tBEleakCur, tBCleakCur,
    tinvRollOffF, tinvRollOffR, tinvEarlyVoltF, tinvEarlyVoltR,
    tcollectorConduct, temitterConduct,
    tbaseResist, tminBaseResist, tbaseCurrentHalfResist,
    temissionCoeffF, temissionCoeffR, tleakBEemissionCoeff, tleakBCemissionCoeff,
    ttransitTimeHighCurrentF, temissionCoeffS,
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
// State schema  BJT simple (L0). Matches bjtdefs.h offsets for the subset
// of slots we track. VBE=0, VBC=1 line up with BJTvbe=0, BJTvbc=1.
// ---------------------------------------------------------------------------

export const BJT_SIMPLE_SCHEMA: StateSchema = defineStateSchema("BjtSimpleElement", [
  { name: "VBE", doc: "bjtdefs.h BJTvbe" },
  { name: "VBC", doc: "bjtdefs.h BJTvbc" },
  { name: "CC",  doc: "bjtdefs.h BJTcc (collector current)" },
  { name: "CB",  doc: "bjtdefs.h BJTcb (base current)" },
  { name: "GPI", doc: "bjtdefs.h BJTgpi" },
  { name: "GMU", doc: "bjtdefs.h BJTgmu" },
  { name: "GM",  doc: "bjtdefs.h BJTgm" },
  { name: "GO",  doc: "bjtdefs.h BJTgo" },
  { name: "GX",  doc: "bjtdefs.h BJTgx=16 (base-resistance cond); L0 always 0  no RB" },
]);

// ---------------------------------------------------------------------------
// createBjtL0Element  Simple L0 (resistive) factory.
// Single load() mirroring bjtload.c without cap/transit-time handling.
// No cached Float64Array state refs  pool.states[N] read at call time.
//
// Internal 4-arg helper carrying the polarity flag. Public 3-arg
// AnalogFactory entry points (createBjtL0Element / createPnpBjtL0Element)
// wrap this and live below the function body.
// ---------------------------------------------------------------------------

function _createBjtElementWithPolarity(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
) {
  // Closure-captured pin node IDs assigned in setup() once `this.pinNodes` is
  // available. (Under the compile-time-expansion architecture, pinNodes is
  // already fully resolved at construction time; closure-let is retained for
  // parity with sibling factories.)
  let nodeB = -1;
  let nodeC = -1;
  let nodeE = -1;

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

  // cite: bjttemp.c:107 — BJTtempGiven mirrors PropertyBag givenness for TEMP.
  let _tempGiven = props.isModelParamGiven("TEMP");

  // Givenness flags threaded into the temperature pass to select the same
  // ngspice branches as the C model (bjttemp.c:83-104, :169-182).
  const l0VafGiven = props.isModelParamGiven("VAF");
  const l0VarGiven = props.isModelParamGiven("VAR");
  const l0IkfGiven = props.isModelParamGiven("IKF");
  const l0IkrGiven = props.isModelParamGiven("IKR");

  function computeL0Tp(T: number): BjtTempParams {
    return computeBjtTempParams({
      IS: params.IS, BF: params.BF, BR: params.BR,
      ISE: params.ISE, ISC: params.ISC,
      NE: params.NE, NC: params.NC, EG: 1.11, XTI: 3, XTB: 0,
      NF: params.NF, NR: params.NR, NS: 1,
      IKF: params.IKF, IKR: params.IKR,
      RC: 0, RE: 0, RB: 0, RBM: 0, IRB: 0,
      CJE: 0, VJE: 0.75, MJE: 0.33,
      CJC: 0, VJC: 0.75, MJC: 0.33,
      CJS: 0, VJS: 0.75, MJS: 0,
      FC: 0.5, AREA: params.AREA, TNOM: params.TNOM,
      VAF: params.VAF, VAR: params.VAR,
      PTF: 0, TF: 0, TR: 0, ITF: 0,
      ISS: 0, TEMP: T,
    }, T, {
      vafGiven: l0VafGiven, varGiven: l0VarGiven,
      ikfGiven: l0IkfGiven, ikrGiven: l0IkrGiven,
    });
  }
  function makeTp(): BjtTempParams {
    return computeL0Tp(params.TEMP);
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

  // Ephemeral per-iteration icheck flag (bjtload.c:405,749-754 CKTnoncon bump).
  // Matrix element handles- allocated in setup(), used in load().
  // L0 has RC=RB=RE=0 always, so prime nodes alias external nodes.
  // 23 TSTALLOC entries per bjtsetup.c:435-464.
  // L0 = Gummel-Poon resistive subset: no terminal resistances (RB/RC/RE = 0),
  // no excess phase, no caps, no transit time. Substrate junction is included
  // (csubsat=0 default → contributes only CKTgmin to substConNode diagonal,
  // matching bjtload.c:480-490 + 798 + 823).
  //
  // ngspice gating per bjtsetup.c:372-428 skips the prime-node TSTALLOC entries
  // when the corresponding model resistance is zero. For L0 the resistances are
  // unconditionally zero, so the entire prime-side bridge (entries 1-4, 7, 10,
  // 13-15) is skipped- prime nodes alias external nodes and the prime-prime
  // diagonals (entries 16, 17, 18) cover the BP/CP/EP self-stamps directly.
  // Substrate (entries 19-21) and excess-phase (entries 22-23) are also absent
  // from the L0 model, so those allocations are skipped too. The 9 surviving
  // entries match the L0 load() stamp list line for line.
  class BjtL0Element extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
    readonly deviceFamily: DeviceFamily = "BJT";
    readonly stateSchema = BJT_SIMPLE_SCHEMA;
    readonly stateSize = BJT_SIMPLE_SCHEMA.size;

    private _icheckLimited = false;
    private _hCPBP = -1; private _hCPEP = -1;
    private _hBPCP = -1; private _hBPEP = -1;
    private _hEPCP = -1; private _hEPBP = -1;
    private _hCPCP = -1; private _hBPBP = -1; private _hEPEP = -1;
    // bjtsetup.c TSTALLOC entry 19: BJTsubstConSubstConPtr — substrate-conn diag.
    // For NPN (VERTICAL substrate, bjtsetup.c:42-43) substConNode = colPrime;
    // for PNP (LATERAL, bjtsetup.c:44-45) substConNode = basePrime. With L0's
    // RC=RB=0, prime nodes alias external nodes, so the cell is (col,col) for
    // NPN and (base,base) for PNP — same diag as _hCPCP / _hBPBP, but stamped
    // separately to mirror bjtload.c:822-823 accumulation order bit-for-bit.
    private _hSCSC = -1;

    constructor(pn: ReadonlyMap<string, number>) { super(pn); }

    setup(ctx: SetupContext): void {
      const solver   = ctx.solver;
      const baseNode = this.pinNodes.get("B")!;
      const colNode  = this.pinNodes.get("C")!;
      const emitNode = this.pinNodes.get("E")!;
      // Re-publish pin node IDs into the closure (compile-time-resolved by
      // `expandCompositeInstance` for composite leaves; identical for primitives).
      nodeB = baseNode;
      nodeC = colNode;
      nodeE = emitNode;

      // State slots- bjtsetup.c:366-367
      this._stateBase = ctx.allocStates(this.stateSize);

      // L0 has no resistors- prime nodes alias external nodes; ngspice gates
      // the prime-side TSTALLOC entries on `model.RC > 0` etc. (bjtsetup.c).
      // With prime = external, only the BP/CP/EP cross-terms and self-diagonals
      // are needed. (Entries 1-4, 7, 10, 13-15, 19-23 are NOT allocated.)
      const cp = colNode;
      const bp = baseNode;
      const ep = emitNode;

      // TSTALLOC subset matching L0 load() stamps (cross-terms + self-diagonals).
      this._hCPBP = solver.allocElement(cp, bp);       // (5)
      this._hCPEP = solver.allocElement(cp, ep);       // (6)
      this._hBPCP = solver.allocElement(bp, cp);       // (8)
      this._hBPEP = solver.allocElement(bp, ep);       // (9)
      this._hEPCP = solver.allocElement(ep, cp);       // (11)
      this._hEPBP = solver.allocElement(ep, bp);       // (12)
      this._hCPCP = solver.allocElement(cp, cp);       // (16)
      this._hBPBP = solver.allocElement(bp, bp);       // (17)
      this._hEPEP = solver.allocElement(ep, ep);       // (18)
      // bjtsetup.c TSTALLOC entry 19: BJTsubstConSubstConPtr.
      // bjtsetup.c:42-46: NPN→VERTICAL→substConNode=colPrime;
      //                    PNP→LATERAL →substConNode=basePrime.
      const substConNode = polarity > 0 ? cp : bp;
      this._hSCSC = solver.allocElement(substConNode, substConNode); // (19)
    }

    /**
     * Single-pass load mirroring bjtload.c::BJTload for the resistive subset
     * (no caps, no transit time, no excess phase, no terminal resistances).
     * L0 is the direct dc-op of the Gummel-Poon equations. Substrate junction
     * is included with csubsat=0 (default), contributing only CKTgmin at the
     * substConNode diagonal per bjtload.c:480-490 + 798 + 823.
     */
    load(ctx: LoadContext): void {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
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
        // cite: bjtload.c:236-257  MODEINITTRAN seeds state1 from the initial voltage read
        // so subsequent NIintegrate history has a valid t=0 prior value.
        s1[base + SLOT_VBE] = vbeRaw;
        s1[base + SLOT_VBC] = vbcRaw;
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // cite: bjtload.c:258-264  MODEINITJCT+MODETRANOP+MODEUIC: seed from IC* params.
        const vbe_ic = polarity * (isNaN(params.ICVBE) ? 0 : params.ICVBE);
        const vce_ic = polarity * (isNaN(params.ICVCE) ? 0 : params.ICVCE);
        vbeRaw = vbe_ic;
        vbcRaw = vbe_ic - vce_ic;
      } else if ((mode & MODEINITJCT) && params.OFF === 0) {
        // cite: bjtload.c:265-269  MODEINITJCT, device ON: seed vbe=tVcrit, vbc=0.
        vbeRaw = tp.tVcrit;
        vbcRaw = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && params.OFF !== 0)) {
        // cite: bjtload.c:270-275  MODEINITJCT+OFF or MODEINITFIX+OFF: zero-seed.
        vbeRaw = 0;
        vbcRaw = 0;
      } else if (mode & MODEINITPRED) {
        // bjtload.c:278-287: #ifndef PREDICTOR state1state0 copy + xfact extrapolation.
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        // cite: bjtload.c:288-303  copy remaining op-state slots from state1 to state0.
        s0[base + SLOT_CC]  = s1[base + SLOT_CC];  // cite: bjtload.c:289
        s0[base + SLOT_CB]  = s1[base + SLOT_CB];  // cite: bjtload.c:290
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI]; // cite: bjtload.c:291
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU]; // cite: bjtload.c:292
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];  // cite: bjtload.c:293
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];  // cite: bjtload.c:294
        s0[base + SLOT_GX]  = s1[base + SLOT_GX];  // cite: bjtload.c:295
        // bjtload.c:279 — xfact = CKTdelta / CKTdeltaOld[1], function-local.
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vbeRaw = (1 + xfact) * s1[base + SLOT_VBE] - xfact * s2[base + SLOT_VBE];
        vbcRaw = (1 + xfact) * s1[base + SLOT_VBC] - xfact * s2[base + SLOT_VBC];
      } else {
        // bjtload.c:311-319: normal NR iteration  read from CKTrhsOld.
        const vB = voltages[nodeB];
        const vC = voltages[nodeC];
        const vE = voltages[nodeE];
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }

      // cite: bjtload.c:323-337  delvbe/delvbc + cchat/cbhat current prediction
      // (used by both checkConvergence and the bypass gate below).
      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cchat = s0[base + SLOT_CC] + (s0[base + SLOT_GM] + s0[base + SLOT_GO]) * delvbe
                    - (s0[base + SLOT_GO] + s0[base + SLOT_GMU]) * delvbc;
      const cbhat = s0[base + SLOT_CB] + s0[base + SLOT_GPI] * delvbe
                    + s0[base + SLOT_GMU] * delvbc;

      // cite: bjtload.c:338-381  NOBYPASS gate: skip recompute when tolerances met.
      // Arranged as if/else wrapping the pnjlim+compute block, mirroring ngspice goto load.
      let vbeLimited: number;
      let vbcLimited: number;
      if (ctx.bypass &&
          !(mode & MODEINITPRED) &&
          (Math.abs(delvbe) < ctx.reltol * Math.max(Math.abs(vbeRaw), Math.abs(s0[base + SLOT_VBE])) + ctx.voltTol) &&
          (Math.abs(delvbc) < ctx.reltol * Math.max(Math.abs(vbcRaw), Math.abs(s0[base + SLOT_VBC])) + ctx.voltTol) &&
          (Math.abs(cchat - s0[base + SLOT_CC]) < ctx.reltol * Math.max(Math.abs(cchat), Math.abs(s0[base + SLOT_CC])) + ctx.iabstol) &&
          (Math.abs(cbhat - s0[base + SLOT_CB]) < ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(s0[base + SLOT_CB])) + ctx.iabstol)) {
        // cite: bjtload.c:365-380  bypass: restore op-state from state0, skip pnjlim+compute.
        vbeLimited = s0[base + SLOT_VBE];
        vbcLimited = s0[base + SLOT_VBC];
        this._icheckLimited = false;
      } else {
        // bjtload.c:383-416: pnjlim on BE/BC. pnjlim runs under MODEINITPRED  ngspice has no
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
        this._icheckLimited = vbeLimFlag || vbcLimFlag;

        // cite: bjtload.c:749-754  icheck++ unless MODEINITFIX && OFF
        if (this._icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label,
            junction: "BE",
            limitType: "pnjlim",
            vBefore: vbeRaw,
            vAfter: vbeLimited,
            wasLimited: vbeLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label,
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
        // Area is folded into the temperature-resolved quantities
        // (computeBjtTempParams), so load() reads them without an AREA factor.
        const csatBE = tp.tBEtSatCur; // cite: bjtload.c:456 — B-E uses BJTBEtSatCur
        const csatBC = tp.tSatCur;    // L0 reverse junction uses the area-folded IS satcur
        const betaF = tp.tBetaF;
        const betaR = tp.tBetaR;
        const c2 = tp.tBEleakCur;
        const c4 = tp.tBCleakCur;
        const tinvEarlyVoltF = tp.tinvEarlyVoltF;
        const tinvEarlyVoltR = tp.tinvEarlyVoltR;
        const oik = tp.tinvRollOffF;
        const oikr = tp.tinvRollOffR;
        const vt = tp.vt;
        const vtn_f = vt * params.NF;
        const vte = vt * params.NE;
        const vtn_r = vt * params.NR;
        const vtc = vt * params.NC;

        // bjtload.c:454-462: forward B-E junction current + conductance.
        let cbe: number, gbe: number;
        if (vbeLimited >= -3 * vtn_f) {
          const evbe = Math.exp(vbeLimited / vtn_f);
          cbe = csatBE * (evbe - 1);
          gbe = csatBE * evbe / vtn_f;
        } else {
          let a = 3 * vtn_f / (vbeLimited * Math.E);
          a = a * a * a;
          cbe = -csatBE * (1 + a);
          gbe = csatBE * 3 * a / vbeLimited;
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
        gben += ctx.cktGmin;
        cben += ctx.cktGmin * vbeLimited;

        // bjtload.c:484-492: reverse B-C junction current + conductance.
        let cbc: number, gbc: number;
        if (vbcLimited >= -3 * vtn_r) {
          const evbc = Math.exp(vbcLimited / vtn_r);
          cbc = csatBC * (evbc - 1);
          gbc = csatBC * evbc / vtn_r;
        } else {
          let a = 3 * vtn_r / (vbcLimited * Math.E);
          a = a * a * a;
          cbc = -csatBC * (1 + a);
          gbc = csatBC * 3 * a / vbcLimited;
        }

        // bjtload.c:494-507: non-ideal B-C (c4/vtc).
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
        // bjtload.c:509-510
        gbcn += ctx.cktGmin;
        cbcn += ctx.cktGmin * vbcLimited;

        // bjtload.c:589-611: base charge qb (NKF=0.5  sqrt branch).
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
        s0[base + SLOT_GX]  = 0; // bjtload.c:780  L0 has no RB so gx=0
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

      if (mode & MODEINITSMSIG) return;  // cite: bjtload.c:676,703  MODEINITSMSIG stores op state, skips stamps

      const solver = ctx.solver;
      // L0 prime nodes alias external nodes (RC=RB=RE=0 per the bjtsetup.c
      // gating already applied in setup()).
      const bp = this.pinNodes.get("B")!;
      const cp = this.pinNodes.get("C")!;
      const ep = this.pinNodes.get("E")!;

      // bjtload.c:807-814: RHS stamps per terminal. L0 prime nodes alias external nodes.
      stampRHS(ctx.rhs, bp, m * (-ceqbe - ceqbc));  // BJTbasePrimeNode += -ceqbe-ceqbc
      stampRHS(ctx.rhs, cp, m * ceqbc);              // BJTcolPrimeNode += ceqbx+ceqbc, ceqbx=0
      stampRHS(ctx.rhs, ep, m * ceqbe);              // BJTemitPrimeNode += ceqbe

      // bjtload.c:819-842: Y-matrix stamps via pre-allocated handles (no allocElement in load).
      //   BJTbasePrimeBasePrimePtr  += gpi + gmu  (no geqcb, no gx/geqbx)
      //   BJTcolPrimeColPrimePtr    += gmu + go    (no gcpr/geqbx)
      //   BJTemitPrimeEmitPrimePtr  += gpi + gm + go  (no gepr)
      //   BJTcolPrimeBasePrimePtr   += -gmu + gm
      //   BJTcolPrimeEmitPrimePtr   += -gm - go
      //   BJTbasePrimeColPrimePtr   += -gmu  (no geqcb)
      //   BJTbasePrimeEmitPrimePtr  += -gpi
      //   BJTemitPrimeColPrimePtr   += -go   (no geqcb)
      //   BJTemitPrimeBasePrimePtr  += -gpi - gm  (no geqcb)
      //
      // Stamp order mirrors bjtload.c:819-842 line-for-line: CPCP (822),
      // SCSC (823), BPBP (824), EPEP (825), then cross-terms (830-837).
      // Order matters at LSB level because for PNP, _hSCSC and _hBPBP
      // address the same matrix cell (substConNode = basePrime when LATERAL),
      // so the SCSC-then-BPBP accumulation sequence is preserved bit-exact.
      //
      // Substrate junction (bjtload.c:480-490 + 798): with csubsat=0 default
      // and gcsub=0 in DC-OP / no-cap path, gdsub = CKTgmin and geqsub = gdsub.
      // ceqsub = polarity * subs * (state0[cqsub] + cdsub - vsub*geqsub) = 0
      // when csubsat=0 (cdsub = CKTgmin*vsub, the term cancels exactly).
      solver.stampElement(this._hCPCP, m * (gmu + go));        // bjtload.c:822
      solver.stampElement(this._hSCSC, m * ctx.cktGmin);       // bjtload.c:823 (geqsub = gdsub = CKTgmin)
      solver.stampElement(this._hBPBP, m * (gpi + gmu));       // bjtload.c:824
      solver.stampElement(this._hEPEP, m * (gpi + gm + go));   // bjtload.c:825
      solver.stampElement(this._hCPBP, m * (-gmu + gm));       // bjtload.c:830
      solver.stampElement(this._hCPEP, m * (-gm - go));        // bjtload.c:831
      solver.stampElement(this._hBPCP, m * -gmu);              // bjtload.c:833
      solver.stampElement(this._hBPEP, m * -gpi);              // bjtload.c:834
      solver.stampElement(this._hEPCP, m * -go);               // bjtload.c:836
      solver.stampElement(this._hEPBP, m * (-gpi - gm));       // bjtload.c:837
    }

    checkConvergence(ctx: LoadContext): boolean {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      const voltages = ctx.rhsOld;
      const vB = voltages[nodeB];
      const vC = voltages[nodeC];
      const vE = voltages[nodeE];
      const vbeRaw = polarity * (vB - vE);
      const vbcRaw = polarity * (vB - vC);

      if (this._icheckLimited) return false;

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
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const ic = polarity * s0[base + SLOT_CC];
      const ib = polarity * s0[base + SLOT_CB];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    }

    /**
     * computeTemperature — engine-driven temperature pass for the BJT L0 model.
     *
     * cite: bjttemp.c:107-108 — if(!here->BJTtempGiven) here->BJTtemp = ckt->CKTtemp + here->BJTdtemp;
     * Resolve effective T: per-instance TEMP given → use params.TEMP; else use ctx.cktTemp.
     * cite: bjttemp.c:158-260 — per-instance temperature math (vt, tSatCur, tBetaF/R, leakage, caps).
     * PNP polarity uses the same temperature math as NPN (bjttemp.c is polarity-agnostic;
     * polarity affects junction voltage sign in bjtload.c, not bjttemp.c).
     */
    computeTemperature(ctx: TempContext): void {
      // cite: bjttemp.c:107-108 — if(!here->BJTtempGiven) here->BJTtemp = ckt->CKTtemp + here->BJTdtemp;
      const effectiveT = _tempGiven ? params.TEMP : ctx.cktTemp;
      tp = computeL0Tp(effectiveT);
    }

    setParam(key: string, value: number): void {
      if (key === "TEMP") {
        params.TEMP = value;
        _tempGiven = true;
        // cite: bjttemp.c:107-110 — per-instance TEMP given overrides circuit temp.
        // Re-run temperature math at the new per-instance temperature.
        tp = computeL0Tp(value);
      } else if (key in params) {
        params[key] = value;
        tp = makeTp();
      }
    }
  }

  return new BjtL0Element(pinNodes);
}

// ---------------------------------------------------------------------------
// Public 3-arg AnalogFactory entry points (spec ssA.3).
//
// createBjtL0Element     - NPN polarity (default for tests / NpnBjt registry)
// createPnpBjtL0Element  - PNP polarity (PnpBjt registry, SCR/TRIAC PNP halves)
// ---------------------------------------------------------------------------

export function createBjtL0Element(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return _createBjtElementWithPolarity(1, pinNodes, props);
}

export function createPnpBjtL0Element(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return _createBjtElementWithPolarity(-1, pinNodes, props);
}

// ---------------------------------------------------------------------------
// State schema  BJT SPICE L1. Only the slots that have direct ngspice
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
  { name: "VBE",   doc: "bjtdefs.h BJTvbe=0" },
  { name: "VBC",   doc: "bjtdefs.h BJTvbc=1" },
  { name: "VBCX",  doc: "bjtdefs.h BJTvbcx=2 — base–collCX voltage (Kull QS)" },
  { name: "VRCI",  doc: "bjtdefs.h BJTvrci=3 — intrinsic-collector resistor voltage (Kull QS)" },
  { name: "CC",    doc: "bjtdefs.h BJTcc=4" },
  { name: "CB",    doc: "bjtdefs.h BJTcb=5" },
  { name: "GPI",   doc: "bjtdefs.h BJTgpi=6" },
  { name: "GMU",   doc: "bjtdefs.h BJTgmu=7" },
  { name: "GM",    doc: "bjtdefs.h BJTgm=8" },
  { name: "GO",    doc: "bjtdefs.h BJTgo=9" },
  { name: "QBE",   doc: "bjtdefs.h BJTqbe=10 (bjtload.c:703-712)" },
  { name: "CQBE",  doc: "bjtdefs.h BJTcqbe=11 (NIintegrate ccap)" },
  { name: "QBC",   doc: "bjtdefs.h BJTqbc=12 (bjtload.c:722-728)" },
  { name: "CQBC",  doc: "bjtdefs.h BJTcqbc=13" },
  { name: "QSUB",  doc: "bjtdefs.h BJTqsub=14" },
  { name: "CQSUB", doc: "bjtdefs.h BJTcqsub=15" },
  { name: "QBX",   doc: "bjtdefs.h BJTqbx=16 (bjtload.c:734-740)" },
  { name: "CQBX",  doc: "bjtdefs.h BJTcqbx=17" },
  { name: "GX",    doc: "bjtdefs.h BJTgx=18 (base-resistance cond)" },
  { name: "CEXBC", doc: "bjtdefs.h BJTcexbc=19 (excess phase)" },
  { name: "GEQCB", doc: "bjtdefs.h BJTgeqcb=20" },
  { name: "GCSUB", doc: "bjtdefs.h BJTgccs=21 subst cap cond" },
  { name: "GEQBX", doc: "bjtdefs.h BJTgeqbx=22 B-X cap cond" },
  { name: "VSUB",  doc: "bjtdefs.h BJTvsub=23" },
  { name: "CDSUB", doc: "bjtdefs.h BJTcdsub=24" },
  { name: "GDSUB", doc: "bjtdefs.h BJTgdsub=25" },
  { name: "IRCI",      doc: "bjtdefs.h BJTirci=26 — Kull epi current (bjtload.c:561,573)" },
  { name: "IRCI_VRCI", doc: "bjtdefs.h BJTirci_Vrci=27 — dIrci/dVrci" },
  { name: "IRCI_VBCI", doc: "bjtdefs.h BJTirci_Vbci=28 — dIrci/dVbci" },
  { name: "IRCI_VBCX", doc: "bjtdefs.h BJTirci_Vbcx=29 — dIrci/dVbcx" },
  { name: "QBCX",  doc: "bjtdefs.h BJTqbcx=30 — base–collCX charge (bjtload.c:570)" },
  { name: "CQBCX", doc: "bjtdefs.h BJTcqbcx=31 — base–collCX cap value (bjtload.c:775,838)" },
  { name: "GBCX",  doc: "bjtdefs.h BJTgbcx=32 — integrated collCX cap conductance (bjtload.c:837)" },
]);

// ---------------------------------------------------------------------------
// createSpiceL1BjtElement  SPICE L1 factory ported from bjtload.c.
// Single load() pass with inline cap-companion lumping (bjtload.c:725-734).
// D3: cap/charge integration gated on ctx.dt > 0 (dc-op has dt=0).
// No cached Float64Array state refs  pool.states[N] at call time.
// ---------------------------------------------------------------------------

export function createSpiceL1BjtElement(
  polarity: 1 | -1,
  isLateral: boolean,
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
) {
  // Closure-captured pin node IDs assigned in setup() once `this.pinNodes` is
  // available. (Under the compile-time-expansion architecture, pinNodes is
  // already fully resolved at construction time; closure-let is retained for
  // parity with sibling factories.)
  let nodeB_ext = -1;
  let nodeC_ext = -1;
  let nodeE_ext = -1;

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
    IBE: props.getModelParam<number>("IBE"),
    IBC: props.getModelParam<number>("IBC"),
    RCO: props.getModelParam<number>("RCO"),
    VO: props.getModelParam<number>("VO"),
    GAMMA: props.getModelParam<number>("GAMMA"),
    QCO: props.getModelParam<number>("QCO"),
    QUASIMOD: props.getModelParam<number>("QUASIMOD"),
    EGQS: props.getModelParam<number>("EGQS"),
    XRCI: props.getModelParam<number>("XRCI"),
    XD: props.getModelParam<number>("XD"),
    TLEV: props.getModelParam<number>("TLEV"),
    TLEVC: props.getModelParam<number>("TLEVC"),
    TBF1: props.getModelParam<number>("TBF1"), TBF2: props.getModelParam<number>("TBF2"),
    TBR1: props.getModelParam<number>("TBR1"), TBR2: props.getModelParam<number>("TBR2"),
    TIKF1: props.getModelParam<number>("TIKF1"), TIKF2: props.getModelParam<number>("TIKF2"),
    TIKR1: props.getModelParam<number>("TIKR1"), TIKR2: props.getModelParam<number>("TIKR2"),
    TIRB1: props.getModelParam<number>("TIRB1"), TIRB2: props.getModelParam<number>("TIRB2"),
    TNC1: props.getModelParam<number>("TNC1"), TNC2: props.getModelParam<number>("TNC2"),
    TNE1: props.getModelParam<number>("TNE1"), TNE2: props.getModelParam<number>("TNE2"),
    TNF1: props.getModelParam<number>("TNF1"), TNF2: props.getModelParam<number>("TNF2"),
    TNR1: props.getModelParam<number>("TNR1"), TNR2: props.getModelParam<number>("TNR2"),
    TRB1: props.getModelParam<number>("TRB1"), TRB2: props.getModelParam<number>("TRB2"),
    TRC1: props.getModelParam<number>("TRC1"), TRC2: props.getModelParam<number>("TRC2"),
    TRE1: props.getModelParam<number>("TRE1"), TRE2: props.getModelParam<number>("TRE2"),
    TRM1: props.getModelParam<number>("TRM1"), TRM2: props.getModelParam<number>("TRM2"),
    TVAF1: props.getModelParam<number>("TVAF1"), TVAF2: props.getModelParam<number>("TVAF2"),
    TVAR1: props.getModelParam<number>("TVAR1"), TVAR2: props.getModelParam<number>("TVAR2"),
    TITF1: props.getModelParam<number>("TITF1"), TITF2: props.getModelParam<number>("TITF2"),
    TTF1: props.getModelParam<number>("TTF1"), TTF2: props.getModelParam<number>("TTF2"),
    TTR1: props.getModelParam<number>("TTR1"), TTR2: props.getModelParam<number>("TTR2"),
    TMJE1: props.getModelParam<number>("TMJE1"), TMJE2: props.getModelParam<number>("TMJE2"),
    TMJC1: props.getModelParam<number>("TMJC1"), TMJC2: props.getModelParam<number>("TMJC2"),
    TMJS1: props.getModelParam<number>("TMJS1"), TMJS2: props.getModelParam<number>("TMJS2"),
    TNS1: props.getModelParam<number>("TNS1"), TNS2: props.getModelParam<number>("TNS2"),
    TIS1: props.getModelParam<number>("TIS1"), TIS2: props.getModelParam<number>("TIS2"),
    TISE1: props.getModelParam<number>("TISE1"), TISE2: props.getModelParam<number>("TISE2"),
    TISC1: props.getModelParam<number>("TISC1"), TISC2: props.getModelParam<number>("TISC2"),
    TISS1: props.getModelParam<number>("TISS1"), TISS2: props.getModelParam<number>("TISS2"),
    CTC: props.getModelParam<number>("CTC"), CTE: props.getModelParam<number>("CTE"), CTS: props.getModelParam<number>("CTS"),
    TVJE: props.getModelParam<number>("TVJE"), TVJC: props.getModelParam<number>("TVJC"), TVJS: props.getModelParam<number>("TVJS"),
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

  // cite: bjttemp.c:107 — BJTtempGiven mirrors PropertyBag givenness for TEMP.
  let _tempGiven = props.isModelParamGiven("TEMP");

  // cite: bjtsetup.c:163-166, :438-439 — BJTintCollResistGiven gates the Kull
  // quasi-saturation collCX node split, its four coupling matrix cells, the
  // load() Kull block, and the qbcx truncation-error term. RCO maps to
  // BJTintCollResist; the value defaults to 0.01 always (the clamp at
  // bjtsetup.c:163-166), but this flag — distinct from the value — gates QS.
  const rcoGiven = props.isModelParamGiven("RCO");
  // cite: bjttemp.c:169-180 — both IBE and IBC given splits the BE/BC saturation
  // currents off IS (BJTBEsatCurGiven && BJTBCsatCurGiven).
  const ibeGiven = props.isModelParamGiven("IBE");
  const ibcGiven = props.isModelParamGiven("IBC");
  const issGiven = props.isModelParamGiven("ISS");
  const vafGiven = props.isModelParamGiven("VAF");
  const varGiven = props.isModelParamGiven("VAR");
  const ikfGiven = props.isModelParamGiven("IKF");
  const ikrGiven = props.isModelParamGiven("IKR");
  const rcGiven = props.isModelParamGiven("RC");
  const reGiven = props.isModelParamGiven("RE");
  // cite: bjtload.c:598-609 — the base-charge roll-off branch keys off
  // BJTnkfGiven (whether NKF was specified), not its value: !given → sqrt(arg)
  // + the gbe/sqarg derivative; given → pow(arg,nkf) + the gbe·2·sqarg·nkf/arg
  // derivative. The two derivative forms are algebraically equal but round
  // differently, so a model that gives NKF=0.5 must take the pow arm.
  const nkfGiven = props.isModelParamGiven("NKF");
  // cite: bjttemp.c:236-243 — tbf*/tbr* given selects the tempco-multiplier beta
  // arm over the bfactor arm.
  const tbf1Given = props.isModelParamGiven("TBF1");
  const tbf2Given = props.isModelParamGiven("TBF2");
  const tbr1Given = props.isModelParamGiven("TBR1");
  const tbr2Given = props.isModelParamGiven("TBR2");
  // cite: bjtsetup.c:414-418 — areab/areac default to area when not given.
  const areabGiven = props.isModelParamGiven("AREAB");
  const areacGiven = props.isModelParamGiven("AREAC");

  function computeL1Tp(T: number): BjtTempParams {
    return computeBjtTempParams({
      IS: params.IS, BF: params.BF, BR: params.BR,
      ISE: params.ISE, ISC: params.ISC,
      NE: params.NE, NC: params.NC, EG: params.EG, XTI: params.XTI, XTB: params.XTB,
      NF: params.NF, NR: params.NR, NS: params.NS,
      IKF: params.IKF, IKR: params.IKR,
      RC: params.RC, RE: params.RE, RB: params.RB, RBM: params.RBM, IRB: params.IRB,
      CJE: params.CJE, VJE: params.VJE, MJE: params.MJE,
      CJC: params.CJC, VJC: params.VJC, MJC: params.MJC,
      CJS: params.CJS, VJS: params.VJS, MJS: params.MJS,
      FC: params.FC, AREA: params.AREA, TNOM: params.TNOM,
      VAF: params.VAF, VAR: params.VAR,
      PTF: params.PTF, TF: params.TF, TR: params.TR, ITF: params.ITF,
      ISS: params.ISS, TEMP: T,
    }, T, {
      isLateral, AREAB: params.AREAB, AREAC: params.AREAC, areabGiven, areacGiven,
      IBE: params.IBE, IBC: params.IBC,
      RCO: params.RCO, VO: params.VO, GAMMA: params.GAMMA,
      QUASIMOD: params.QUASIMOD, EGQS: params.EGQS, XRCI: params.XRCI, XD: params.XD,
      TLEV: params.TLEV, TLEVC: params.TLEVC,
      TBF1: params.TBF1, TBF2: params.TBF2, TBR1: params.TBR1, TBR2: params.TBR2,
      TIKF1: params.TIKF1, TIKF2: params.TIKF2, TIKR1: params.TIKR1, TIKR2: params.TIKR2,
      TIRB1: params.TIRB1, TIRB2: params.TIRB2,
      TNC1: params.TNC1, TNC2: params.TNC2, TNE1: params.TNE1, TNE2: params.TNE2,
      TNF1: params.TNF1, TNF2: params.TNF2, TNR1: params.TNR1, TNR2: params.TNR2,
      TRB1: params.TRB1, TRB2: params.TRB2, TRC1: params.TRC1, TRC2: params.TRC2,
      TRE1: params.TRE1, TRE2: params.TRE2, TRM1: params.TRM1, TRM2: params.TRM2,
      TVAF1: params.TVAF1, TVAF2: params.TVAF2, TVAR1: params.TVAR1, TVAR2: params.TVAR2,
      TITF1: params.TITF1, TITF2: params.TITF2, TTF1: params.TTF1, TTF2: params.TTF2,
      TTR1: params.TTR1, TTR2: params.TTR2,
      TMJE1: params.TMJE1, TMJE2: params.TMJE2, TMJC1: params.TMJC1, TMJC2: params.TMJC2,
      TMJS1: params.TMJS1, TMJS2: params.TMJS2, TNS1: params.TNS1, TNS2: params.TNS2,
      TIS1: params.TIS1, TIS2: params.TIS2, TISE1: params.TISE1, TISE2: params.TISE2,
      TISC1: params.TISC1, TISC2: params.TISC2, TISS1: params.TISS1, TISS2: params.TISS2,
      CTC: params.CTC, CTE: params.CTE, CTS: params.CTS,
      TVJE: params.TVJE, TVJC: params.TVJC, TVJS: params.TVJS,
      rcoGiven, ibeGiven, ibcGiven, issGiven,
      vafGiven, varGiven, ikfGiven, ikrGiven, rcGiven, reGiven,
      tbf1Given, tbf2Given, tbr1Given, tbr2Given,
    });
  }
  function makeTp(): BjtTempParams {
    return computeL1Tp(params.TEMP);
  }
  let tp = makeTp();

  // Internal prime nodes- allocated in setup() via ctx.makeVolt().
  // Initialised to external nodes here; setup() overwrites when Rx > 0.
  let nodeB_int = nodeB_ext;
  let nodeC_int = nodeC_ext;
  let nodeE_int = nodeE_ext;
  // cite: bjtsetup.c:430-436 — collCX is the resistive-collector internal node,
  // distinct from colPrime (nodeC_int) only when rco is given (the Kull epi
  // element separates them). When RC==0 collCX collapses onto the external
  // collector; when rco is unset colPrime collapses onto collCX.
  let nodeCX = nodeC_ext;

  // Substrate orientation: VERTICAL (+1) stamps on colPrime; LATERAL (-1) on
  // basePrime. ngspice (bjtdefs.h:578-579) treats `BJTsubs` as an independent
  // model parameter — it is NOT a function of BJTtype, even though ngspice's
  // default is VERTICAL for NPN and LATERAL for PNP (bjtsetup.c:42-46) when
  // unspecified. The caller threads that default in via `isLateral`, so the
  // substrate orientation must derive from `isLateral` alone. Tying `subs` to
  // `polarity` here couples two independent concepts and produces internally
  // inconsistent stamps whenever the caller selects an orientation that
  // disagrees with the polarity-derived default (e.g. NPN+LATERAL or
  // PNP+VERTICAL): `substConNode` (used for the RHS stamp and the ceqsub
  // current term) ends up pointing at a different prime node than the
  // matrix-side `_hSubstConSubstCon` alias driven from `isLateral` in
  // `setup()` — bjtsetup.c keeps both on the same node. cite: bjtdefs.h:578-579,
  // bjtsetup.c:454-460, bjtload.c:799.
  const subs = isLateral ? -1 : 1;
  let substConNode = subs > 0 ? nodeC_int : nodeB_int;

  const hasCapacitance = params.CJE > 0 || params.CJC > 0 || params.TF > 0 || params.TR > 0 || params.CJS > 0;

  // Slot indices (mirror bjtdefs.h, diff bjt.md:561-620, BJTnumStates 33).
  // VBCX/VRCI insert at 2/3; CC..GDSUB shift +2; the seven Kull QS slots append at 26-32.
  const SLOT_VBE = 0;
  const SLOT_VBC = 1;
  const SLOT_VBCX = 2;
  const SLOT_VRCI = 3;
  const SLOT_CC  = 4;
  const SLOT_CB  = 5;
  const SLOT_GPI = 6;
  const SLOT_GMU = 7;
  const SLOT_GM  = 8;
  const SLOT_GO  = 9;
  const SLOT_QBE = 10;
  const SLOT_CQBE = 11;
  const SLOT_QBC = 12;
  const SLOT_CQBC = 13;
  const SLOT_QSUB = 14;
  const SLOT_CQSUB = 15;
  const SLOT_QBX = 16;
  const SLOT_CQBX = 17;
  const SLOT_GX  = 18;
  const SLOT_CEXBC = 19;
  const SLOT_GEQCB = 20;
  const SLOT_GCSUB = 21;
  const SLOT_GEQBX = 22;
  const SLOT_VSUB  = 23;
  const SLOT_CDSUB = 24;
  const SLOT_GDSUB = 25;
  const SLOT_IRCI      = 26;
  const SLOT_IRCI_VRCI = 27;
  const SLOT_IRCI_VBCI = 28;
  const SLOT_IRCI_VBCX = 29;
  const SLOT_QBCX  = 30;
  const SLOT_CQBCX = 31;
  const SLOT_GBCX  = 32;

  // Matrix element handles- allocated in setup(), used in load().
  // 23 TSTALLOC entries per bjtsetup.c:435-464.
  const internalLabels: string[] = [];

  class BjtL1Element extends PoolBackedAnalogElement {
    readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
    readonly deviceFamily: DeviceFamily = "BJT";
    readonly stateSchema = BJT_L1_SCHEMA;
    readonly stateSize = BJT_L1_SCHEMA.size;

    private _icheckLimited = false;
    private _hCCP  = -1; private _hBBP  = -1; private _hEEP  = -1;
    private _hCPC  = -1; private _hCPBP = -1; private _hCPEP = -1;
    private _hBPB  = -1; private _hBPCP = -1; private _hBPEP = -1;
    private _hEPE  = -1; private _hEPCP = -1; private _hEPBP = -1;
    private _hCC   = -1; private _hBB   = -1; private _hEE   = -1;
    private _hCPCP = -1; private _hBPBP = -1; private _hEPEP = -1;
    private _hSS   = -1; private _hSCS  = -1; private _hSSC  = -1;
    private _hBCP  = -1; private _hCPB  = -1;
    private _hSubstConSubstCon = -1;
    // Kull quasi-saturation cells (bjtsetup.c:533-539). _hCollCXcollCX is
    // unconditional (entry 24); the four coupling cells are allocated only when
    // rco is given (entries 25-28).
    private _hCollCXcollCX = -1;
    private _hCollCXBasePrime = -1; private _hBasePrimeCollCX = -1;
    private _hColPrimeCollCX = -1; private _hCollCXColPrime = -1;

    constructor(pn: ReadonlyMap<string, number>) { super(pn); }

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    }

    setup(ctx: SetupContext): void {
      const solver    = ctx.solver;
      const baseNode  = this.pinNodes.get("B")!;
      const colNode   = this.pinNodes.get("C")!;
      const emitNode  = this.pinNodes.get("E")!;
      const substNode = 0;
      // Re-publish pin node IDs into the closure (compile-time-resolved by
      // `expandCompositeInstance` for composite leaves; identical for primitives).
      nodeB_ext = baseNode;
      nodeC_ext = colNode;
      nodeE_ext = emitNode;

      // State slots — bjtsetup.c:424-425
      this._stateBase = ctx.allocStates(this.stateSize);

      // Internal node allocation — bjtsetup.c:430-494
      internalLabels.length = 0;

      // cite: bjtsetup.c:430-436 — collCX is the resistive-collector internal
      // node; when RC==0 it collapses onto the external collector terminal.
      if (params.RC === 0) {
        nodeCX = colNode;
      } else {
        nodeCX = ctx.makeVolt(this.label, "collCX");
        internalLabels.push("collCX");
      }

      // cite: bjtsetup.c:438-443 — colPrime (nodeC_int) is the intrinsic
      // collector node, distinct from collCX only when the Kull rco parameter
      // is given; otherwise it collapses onto collCX.
      if (!rcoGiven) {
        nodeC_int = nodeCX;
      } else {
        nodeC_int = ctx.makeVolt(this.label, "collector");
        internalLabels.push("collector");
      }

      if (params.RB === 0) {
        nodeB_int = baseNode;
      } else {
        nodeB_int = ctx.makeVolt(this.label, "base");
        internalLabels.push("base");
      }
      if (params.RE === 0) {
        nodeE_int = emitNode;
      } else {
        nodeE_int = ctx.makeVolt(this.label, "emitter");
        internalLabels.push("emitter");
      }

      const cp = nodeC_int;
      const cx = nodeCX;
      const bp = nodeB_int;
      const ep = nodeE_int;

      // Recompute substConNode after prime nodes are resolved (bjtsetup.c:521-527).
      // LATERAL substrate connects to basePrime; VERTICAL to colPrime.
      const resolvedSubstConNode = (subs > 0) ? cp : bp;

      // TSTALLOC sequence — bjtsetup.c:502-531, exact order (element-pool order
      // is structurally visible at the harness CSC dump; do not reorder).
      this._hCCP  = solver.allocElement(colNode,  cx);       // (1)  BJTcollCollCXPtr
      this._hBBP  = solver.allocElement(baseNode, bp);       // (2)  BJTbaseBasePrimePtr
      this._hEEP  = solver.allocElement(emitNode, ep);       // (3)  BJTemitEmitPrimePtr
      this._hCPC  = solver.allocElement(cx,       colNode);  // (4)  BJTcollCXCollPtr
      this._hCPBP = solver.allocElement(cp,       bp);       // (5)  BJTcolPrimeBasePrimePtr
      this._hCPEP = solver.allocElement(cp,       ep);       // (6)  BJTcolPrimeEmitPrimePtr
      this._hBPB  = solver.allocElement(bp,       baseNode); // (7)  BJTbasePrimeBasePtr
      this._hBPCP = solver.allocElement(bp,       cp);       // (8)  BJTbasePrimeColPrimePtr
      this._hBPEP = solver.allocElement(bp,       ep);       // (9)  BJTbasePrimeEmitPrimePtr
      this._hEPE  = solver.allocElement(ep,       emitNode); // (10) BJTemitPrimeEmitPtr
      this._hEPCP = solver.allocElement(ep,       cp);       // (11) BJTemitPrimeColPrimePtr
      this._hEPBP = solver.allocElement(ep,       bp);       // (12) BJTemitPrimeBasePrimePtr
      this._hCC   = solver.allocElement(colNode,  colNode);  // (13) BJTcolColPtr
      this._hBB   = solver.allocElement(baseNode, baseNode); // (14) BJTbaseBasePtr
      this._hEE   = solver.allocElement(emitNode, emitNode); // (15) BJTemitEmitPtr
      this._hCPCP = solver.allocElement(cp,       cp);       // (16) BJTcolPrimeColPrimePtr
      this._hBPBP = solver.allocElement(bp,       bp);       // (17) BJTbasePrimeBasePrimePtr
      this._hEPEP = solver.allocElement(ep,       ep);       // (18) BJTemitPrimeEmitPrimePtr

      // Substrate stamps — bjtsetup.c:520 (entry 19), :521-529 (alias + 20-21)
      this._hSS   = solver.allocElement(substNode, substNode); // (19) BJTsubstSubstPtr
      // cite: bjtsetup.c:521-527 — substConSubstCon is an alias, not a new alloc.
      let sc: number;
      if (isLateral) {
        sc = bp;
        this._hSubstConSubstCon = this._hBPBP;
      } else {
        sc = cp;
        this._hSubstConSubstCon = this._hCPCP;
      }
      substConNode = resolvedSubstConNode;
      this._hSCS  = solver.allocElement(sc,        substNode); // (20) BJTsubstConSubstPtr
      this._hSSC  = solver.allocElement(substNode, sc);        // (21) BJTsubstSubstConPtr

      // Remaining cross-terms — bjtsetup.c:530-531 (entries 22-23)
      this._hBCP  = solver.allocElement(baseNode, cp);       // (22) BJTbaseColPrimePtr
      this._hCPB  = solver.allocElement(cp,       baseNode); // (23) BJTcolPrimeBasePtr

      // cite: bjtsetup.c:533 — BJTcollCXcollCXPtr allocated unconditionally;
      // carries the collector series conductance even in classic-GP mode.
      this._hCollCXcollCX = solver.allocElement(cx, cx);    // (24) BJTcollCXcollCXPtr

      // cite: bjtsetup.c:535-539 — four rco-gated coupling cells allocated only
      // when BJTintCollResistGiven; the Kull epi-element stamps into these.
      if (rcoGiven) {
        this._hCollCXBasePrime  = solver.allocElement(cx, bp); // (25) BJTcollCXBasePrimePtr
        this._hBasePrimeCollCX  = solver.allocElement(bp, cx); // (26) BJTbasePrimeCollCXPtr
        this._hColPrimeCollCX   = solver.allocElement(cp, cx); // (27) BJTcolPrimeCollCXPtr
        this._hCollCXColPrime   = solver.allocElement(cx, cp); // (28) BJTcollCXColPrimePtr
      }
    }

    /**
     * Single-pass load mirroring bjtload.c::BJTload. Area is folded into the
     * temperature-resolved quantities by computeBjtTempParams (bjttemp.c), so
     * load() reads them without an AREA factor. Cap-companion geq/ieq lumped
     * inline into gpi/gmu/cc/cb per bjtload.c:726-834. D3: cap/charge update
     * gated on ctx.dt > 0 (DC-OP has dt=0).
     */
    load(ctx: LoadContext): void {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const s3 = this._pool.states[3];
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;
      const mode = ctx.cktMode;
      const m = params.M;
      const gmin = ctx.cktGmin;

      // cite: bjtload.c:148 — vt = here->BJTtemp * CONSTKoverQ
      const vt = tp.vt;

      // Area is folded into all temperature-resolved quantities (bjttemp.c).
      // cite: bjtload.c:170-172 — rbpi = tbaseResist - tminBaseResist (no /area)
      const rbpi = tp.tbaseResist - tp.tminBaseResist;
      const rbpr = tp.tminBaseResist;
      // cite: bjtload.c:932-933 — gcpr/gepr are the area-folded conductances
      const gcpr = tp.tcollectorConduct;
      const gepr = tp.temitterConduct;
      const xjrb = tp.tbaseCurrentHalfResist;
      const td = tp.excessPhaseFactor;
      // cite: bjtload.c:171 — vte = tleakBEemissionCoeff * vt (already tempco-scaled)
      const vte = tp.tleakBEemissionCoeff * vt;
      const vtc = tp.tleakBCemissionCoeff * vt;
      // cite: bjtload.c:590-595 — oik/oikr are the area-folded roll-off inverses
      const oik  = tp.tinvRollOffF;
      const oikr = tp.tinvRollOffR;

      // Sat-currents: area folded in bjttemp.c (bjtload.c:456,486).
      const csatBE  = tp.tBEtSatCur;
      const csatBC  = tp.tBCtSatCur;
      const csubsat = tp.tSubSatCur;
      const c2 = tp.tBEleakCur;
      const c4 = tp.tBCleakCur;

      // Voltage reads from the closure-captured node IDs.
      const vBe_ext = voltages[nodeB_ext];
      const vBi     = voltages[nodeB_int];
      const vCX     = voltages[nodeCX];
      const vCi     = voltages[nodeC_int];
      const vEi     = voltages[nodeE_int];
      const vSubCon = voltages[substConNode];

      // bjtload.c:232-332: linearization voltage dispatch per cktMode.
      // vbcx = polarity*(Vbp - VcollCX);  vrci = polarity*(VcollCX - Vcp).
      let vbeRaw:  number;
      let vbcRaw:  number;
      let vbcxRaw: number;
      let vrciRaw: number;
      let vbxRaw:  number;
      let vsubRaw: number;

      if (mode & MODEINITSMSIG) {
        // cite: bjtload.c:222-232 — SMSIG: seed from state0.
        vbeRaw  = s0[base + SLOT_VBE];
        vbcRaw  = s0[base + SLOT_VBC];
        vbcxRaw = s0[base + SLOT_VBCX];
        vrciRaw = s0[base + SLOT_VRCI];
        vbxRaw  = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
      } else if (mode & MODEINITTRAN) {
        // cite: bjtload.c:233-247 — INITTRAN: seed from state1.
        vbeRaw  = s1[base + SLOT_VBE];
        vbcRaw  = s1[base + SLOT_VBC];
        vbcxRaw = s1[base + SLOT_VBCX];
        vrciRaw = s1[base + SLOT_VRCI];
        vbxRaw  = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
        if ((mode & MODETRAN) && (mode & MODEUIC)) {
          const vbe_ic = isNaN(params.ICVBE) ? 0 : params.ICVBE;
          const vce_ic = isNaN(params.ICVCE) ? 0 : params.ICVCE;
          vbxRaw  = polarity * (vbe_ic - vce_ic);
          vsubRaw = 0;
        }
      } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
        // cite: bjtload.c:248-255 — UIC: seed from IC params.
        const vbe_ic = polarity * (isNaN(params.ICVBE) ? 0 : params.ICVBE);
        const vce_ic = polarity * (isNaN(params.ICVCE) ? 0 : params.ICVCE);
        vbeRaw  = vbe_ic;
        vbcRaw  = vbcxRaw = vbe_ic - vce_ic;
        vbxRaw  = vbcRaw;
        vsubRaw = 0;
        vrciRaw = 0;
      } else if ((mode & MODEINITJCT) && params.OFF === 0) {
        // cite: bjtload.c:256-261 — INITJCT device-on: seed from tVcrit.
        vbeRaw  = tp.tVcrit;
        vbcRaw  = vbcxRaw = 0;
        vbxRaw  = 0;
        vsubRaw = 0;
        vrciRaw = 0;
      } else if ((mode & MODEINITJCT) ||
                 ((mode & MODEINITFIX) && params.OFF !== 0)) {
        // cite: bjtload.c:262-268 — INITJCT+OFF or INITFIX+OFF: zero-seed.
        vbeRaw  = 0;
        vbcRaw  = vbcxRaw = 0;
        vbxRaw  = 0;
        vsubRaw = 0;
        vrciRaw = 0;
      } else if (mode & MODEINITPRED) {
        // cite: bjtload.c:270-312 — INITPRED: copy state1→state0, extrapolate.
        s0[base + SLOT_VBE]  = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC]  = s1[base + SLOT_VBC];
        s0[base + SLOT_VBCX] = s1[base + SLOT_VBCX];
        s0[base + SLOT_VRCI] = s1[base + SLOT_VRCI];
        s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB];
        s0[base + SLOT_CC]   = s1[base + SLOT_CC];
        s0[base + SLOT_CB]   = s1[base + SLOT_CB];
        s0[base + SLOT_GPI]  = s1[base + SLOT_GPI];
        s0[base + SLOT_GMU]  = s1[base + SLOT_GMU];
        s0[base + SLOT_GM]   = s1[base + SLOT_GM];
        s0[base + SLOT_GO]   = s1[base + SLOT_GO];
        s0[base + SLOT_GX]   = s1[base + SLOT_GX];
        // cite: bjtload.c:305-312 — Irci_* predictor copies (bjtload.c:305-312).
        s0[base + SLOT_IRCI]      = s1[base + SLOT_IRCI];
        s0[base + SLOT_IRCI_VRCI] = s1[base + SLOT_IRCI_VRCI];
        s0[base + SLOT_IRCI_VBCI] = s1[base + SLOT_IRCI_VBCI];
        s0[base + SLOT_IRCI_VBCX] = s1[base + SLOT_IRCI_VBCX];
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vbeRaw  = (1 + xfact) * s1[base + SLOT_VBE]  - xfact * s2[base + SLOT_VBE];
        vbcRaw  = (1 + xfact) * s1[base + SLOT_VBC]  - xfact * s2[base + SLOT_VBC];
        vbcxRaw = (1 + xfact) * s1[base + SLOT_VBCX] - xfact * s2[base + SLOT_VBCX];
        vrciRaw = (1 + xfact) * s1[base + SLOT_VRCI] - xfact * s2[base + SLOT_VRCI];
        vsubRaw = (1 + xfact) * s1[base + SLOT_VSUB] - xfact * s2[base + SLOT_VSUB];
        vbxRaw  = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
      } else {
        // cite: bjtload.c:315-332 — normal NR: read from CKTrhsOld.
        vbeRaw  = polarity * (vBi - vEi);
        vbcRaw  = polarity * (vBi - vCi);
        vbcxRaw = polarity * (vBi - vCX);
        vrciRaw = polarity * (vCX - vCi);
        vbxRaw  = polarity * (vBe_ext - vCi);
        vsubRaw = polarity * subs * (0 - vSubCon);
      }

      // cite: bjtload.c:333-349 — delvbe/delvbc/delvbcx/delvrci + cchat/cbhat.
      const delvbe  = vbeRaw  - s0[base + SLOT_VBE];
      const delvbc  = vbcRaw  - s0[base + SLOT_VBC];
      const delvbcx = vbcxRaw - s0[base + SLOT_VBCX];
      const delvrci = vrciRaw - s0[base + SLOT_VRCI];
      const cchat = s0[base + SLOT_CC] + (s0[base + SLOT_GM] + s0[base + SLOT_GO]) * delvbe
                    - (s0[base + SLOT_GO] + s0[base + SLOT_GMU]) * delvbc;
      const cbhat = s0[base + SLOT_CB] + s0[base + SLOT_GPI] * delvbe
                    + s0[base + SLOT_GMU] * delvbc;

      // Kull Irci/Qbcx operating-point values (restored from state0 on bypass,
      // computed below in the bypass-else block otherwise).
      let Irci = 0, Irci_Vrci = 0, Irci_Vbci = 0, Irci_Vbcx = 0;
      let gbcx = 0, cbcx = 0;

      // cite: bjtload.c:350-407 — NOBYPASS gate.
      let vbeLimited:  number;
      let vbcLimited:  number;
      let vbcxLimited: number;
      let vrciLimited: number;
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
          Math.abs(delvbe)  < ctx.reltol * Math.max(Math.abs(vbeRaw),  Math.abs(s0[base + SLOT_VBE]))  + ctx.voltTol &&
          Math.abs(delvbc)  < ctx.reltol * Math.max(Math.abs(vbcRaw),  Math.abs(s0[base + SLOT_VBC]))  + ctx.voltTol &&
          Math.abs(delvbcx) < ctx.reltol * Math.max(Math.abs(vbcxRaw), Math.abs(s0[base + SLOT_VBCX])) + ctx.voltTol &&
          Math.abs(delvrci) < ctx.reltol * Math.max(Math.abs(vrciRaw), Math.abs(s0[base + SLOT_VRCI])) + ctx.voltTol &&
          Math.abs(cchat - s0[base + SLOT_CC]) < ctx.reltol * Math.max(Math.abs(cchat), Math.abs(s0[base + SLOT_CC])) + ctx.iabstol &&
          Math.abs(cbhat - s0[base + SLOT_CB]) < ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(s0[base + SLOT_CB])) + ctx.iabstol) {
        // cite: bjtload.c:383-406 — bypass: restore op-state from state0.
        vbeLimited  = s0[base + SLOT_VBE];
        vbcLimited  = s0[base + SLOT_VBC];
        vbcxLimited = s0[base + SLOT_VBCX];
        vrciLimited = s0[base + SLOT_VRCI];
        cc   = s0[base + SLOT_CC];
        cb   = s0[base + SLOT_CB];
        gpi  = s0[base + SLOT_GPI];
        gmu  = s0[base + SLOT_GMU];
        gm   = s0[base + SLOT_GM];
        go   = s0[base + SLOT_GO];
        gx   = s0[base + SLOT_GX];
        geqcb = s0[base + SLOT_GEQCB];
        gcsub = s0[base + SLOT_GCSUB];
        geqbx = s0[base + SLOT_GEQBX];
        vsubLimited = s0[base + SLOT_VSUB];
        gdsub = s0[base + SLOT_GDSUB];
        cdsub = s0[base + SLOT_CDSUB];
        // cite: bjtload.c:400-405 — restore Kull state on bypass.
        Irci      = s0[base + SLOT_IRCI];
        Irci_Vrci = s0[base + SLOT_IRCI_VRCI];
        Irci_Vbci = s0[base + SLOT_IRCI_VBCI];
        Irci_Vbcx = s0[base + SLOT_IRCI_VBCX];
        gbcx = s0[base + SLOT_GBCX];
        cbcx = s0[base + SLOT_CQBCX];
        this._icheckLimited = false;
      } else {
        // cite: bjtload.c:409-447 — pnjlim on BE, BC, and substrate.
        vbeLimited  = vbeRaw;
        vbcLimited  = vbcRaw;
        vbcxLimited = vbcxRaw;
        vrciLimited = vrciRaw;
        vsubLimited = vsubRaw;
        let vbeLimFlag  = false;
        let vbcLimFlag  = false;
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
          // cite: bjtload.c:447 — vrci = vbc - vbcx after vbc may have been limited.
          vrciLimited = vbcLimited - vbcxLimited;
        }
        this._icheckLimited = vbeLimFlag || vbcLimFlag || vsubLimFlag;

        // cite: bjtload.c:749-754 — icheck++ unless MODEINITFIX && OFF.
        if (this._icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++;

        if (ctx.limitingCollector) {
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label,
            junction: "BE",
            limitType: "pnjlim",
            vBefore: vbeRaw,
            vAfter: vbeLimited,
            wasLimited: vbeLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label,
            junction: "BC",
            limitType: "pnjlim",
            vBefore: vbcRaw,
            vAfter: vbcLimited,
            wasLimited: vbcLimFlag,
          });
          ctx.limitingCollector.push({
            elementIndex: this.elementIndex ?? -1,
            label: this.label,
            junction: "SUB",
            limitType: "pnjlim",
            vBefore: vsubRaw,
            vAfter: vsubLimited,
            wasLimited: vsubLimFlag,
          });
        }

        // bjtload.c:452-510: inline Gummel-Poon junction evaluation.
        // vtn_f/vtn_r use the tempco-scaled emission coefficients (bjtload.c:452,482).
        const vtn_f = tp.temissionCoeffF * vt;
        const vtn_r = tp.temissionCoeffR * vt;

        // cite: bjtload.c:454-462 — forward B-E junction current + conductance.
        let cbe: number, gbe: number;
        if (vbeLimited >= -3 * vtn_f) {
          const evbe = Math.exp(vbeLimited / vtn_f);
          cbe = csatBE * (evbe - 1);
          gbe = csatBE * evbe / vtn_f;
        } else {
          let a = 3 * vtn_f / (vbeLimited * Math.E);
          a = a * a * a;
          cbe = -csatBE * (1 + a);
          gbe = csatBE * 3 * a / vbeLimited;
        }

        // cite: bjtload.c:464-478 — non-ideal B-E (c2/vte).
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
        // bjtload.c:479-480
        gben += gmin;
        cben += gmin * vbeLimited;

        // cite: bjtload.c:484-492 — reverse B-C junction current + conductance.
        let cbc: number, gbc: number;
        if (vbcLimited >= -3 * vtn_r) {
          const evbc = Math.exp(vbcLimited / vtn_r);
          cbc = csatBC * (evbc - 1);
          gbc = csatBC * evbc / vtn_r;
        } else {
          let a = 3 * vtn_r / (vbcLimited * Math.E);
          a = a * a * a;
          cbc = -csatBC * (1 + a);
          gbc = csatBC * 3 * a / vbcLimited;
        }

        // cite: bjtload.c:494-507 — non-ideal B-C (c4/vtc).
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
        // bjtload.c:509-510
        gbcn += gmin;
        cbcn += gmin * vbcLimited;

        // cite: bjtload.c:512-527 — substrate junction current/conductance.
        const vts = tp.temissionCoeffS * vt;
        if (csubsat > 0) {
          if (vsubLimited <= -3 * vts) {
            let a = 3 * vts / (vsubLimited * Math.E);
            a = a * a * a;
            gdsub = csubsat * 3 * a / vsubLimited + gmin;
            cdsub = -csubsat * (1 + a) + gmin * vsubLimited;
          } else {
            const MAX_EXP_ARG = 709;
            const evsub = Math.exp(Math.min(MAX_EXP_ARG, vsubLimited / vts));
            gdsub = csubsat * evsub / vts + gmin;
            cdsub = csubsat * (evsub - 1) + gmin * vsubLimited;
          }
        } else {
          gdsub = gmin;
          cdsub = gmin * vsubLimited;
        }

        // cite: bjtload.c:529-585 — Kull quasi-saturation model; gated on rcoGiven.
        // capbcx_local = Qbcx_Vbcx (bjtload.c:571 here->BJTcapbcx), carried to
        // the cap block for NIintegrate and to the SMSIG CQBCX store.
        let capbcx_local = 0;
        let Qbci_local = 0;
        let Qbci_Vbci_local = 0;
        if (rcoGiven) {
          if (vrciLimited > 0) {
            // cite: bjtload.c:532-569 — Kull epitaxial-collector current Irci and
            // its three Jacobian partial derivatives; epiDoping/tintCollResist/
            // tepiSatVoltage from bjttemp.c:215-229; QCO un-temp-scaled (bjtload.c:566).
            const Kbci      = Math.sqrt(1 + tp.tepiDoping * Math.exp(vbcLimited  / vt));
            const Kbci_Vbci = tp.tepiDoping * Math.exp(vbcLimited  / vt) / (2 * vt * Kbci);
            const Kbcx      = Math.sqrt(1 + tp.tepiDoping * Math.exp(vbcxLimited / vt));
            const Kbcx_Vbcx = tp.tepiDoping * Math.exp(vbcxLimited / vt) / (2 * vt * Kbcx);
            const rKp1       = (1 + Kbci) / (1 + Kbcx);
            const rKp1_Vbci  = Kbci_Vbci / (1 + Kbci);
            const rKp1_Vbcx  = -(1 + Kbci) * Kbcx_Vbcx / ((Kbcx + 1) * (Kbcx + 1));
            const xvar1      = Math.log(rKp1);
            const xvar1_Vbci = rKp1_Vbci / rKp1;
            const xvar1_Vbcx = rKp1_Vbcx / rKp1;
            const Vcorr      = vt * (Kbci - Kbcx - xvar1);
            const Vcorr_Vbci = vt * (Kbci_Vbci - xvar1_Vbci);
            const Vcorr_Vbcx = vt * (-Kbcx_Vbcx - xvar1_Vbcx);
            const Iohm       = (vrciLimited + Vcorr) / tp.tintCollResist;
            const Iohm_Vrci  = 1 / tp.tintCollResist;
            const Iohm_Vbci  = Vcorr_Vbci / tp.tintCollResist;
            const Iohm_Vbcx  = Vcorr_Vbcx / tp.tintCollResist;
            const quot        = 1 + Math.abs(vrciLimited) / tp.tepiSatVoltage;
            const quot_Vrci   = vrciLimited / (tp.tepiSatVoltage * Math.abs(vrciLimited));
            Irci      = Iohm / quot + gmin * vrciLimited;
            Irci_Vrci = Iohm_Vrci / quot - Iohm * quot_Vrci / (quot * quot) + gmin;
            Irci_Vbci = Iohm_Vbci / quot;
            Irci_Vbcx = Iohm_Vbcx / quot;
            const Qbcx      = params.QCO * Kbcx;
            const Qbcx_Vbcx = params.QCO * Kbcx_Vbcx;
            s0[base + SLOT_QBCX] = Qbcx;
            capbcx_local     = Qbcx_Vbcx;         // bjtload.c:571 BJTcapbcx
            Qbci_local       = params.QCO * Kbci;  // bjtload.c:566
            Qbci_Vbci_local  = params.QCO * Kbci_Vbci; // bjtload.c:567
          } else {
            // cite: bjtload.c:572-584 — vrci <= 0: linear resistor + gmin.
            Irci      = vrciLimited / tp.tintCollResist + gmin * vrciLimited;
            Irci_Vrci = 1 / tp.tintCollResist + gmin;
            Irci_Vbci = 0; Irci_Vbcx = 0;
            s0[base + SLOT_QBCX] = 0;
            // capbcx_local, Qbci_local, Qbci_Vbci_local remain 0 (initialized above).
          }
        }

        // cite: bjtload.c:589-611 — base charge qb.
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
          // cite: bjtload.c:597-602 — sqarg keys off BJTnkfGiven, not NKF's value.
          if (!nkfGiven) {
            if (arg_qb !== 0) sqarg = Math.sqrt(arg_qb);
          } else {
            if (arg_qb !== 0) sqarg = Math.pow(arg_qb, params.NKF);
          }
          qb = q1 * (1 + sqarg) / 2;
          // cite: bjtload.c:604-610 — dqbdve/dqbdvc derivative arm by BJTnkfGiven.
          if (!nkfGiven) {
            const sqargSafe = Math.max(sqarg, 1e-30);
            dqbdve = q1 * (qb * tp.tinvEarlyVoltR + oik * gbe / sqargSafe);
            dqbdvc = q1 * (qb * tp.tinvEarlyVoltF + oikr * gbc / sqargSafe);
          } else {
            const argSafe = Math.max(arg_qb, 1e-30);
            dqbdve = q1 * (qb * tp.tinvEarlyVoltR + oik * gbe * 2 * sqarg * params.NKF / argSafe);
            dqbdvc = q1 * (qb * tp.tinvEarlyVoltF + oikr * gbc * 2 * sqarg * params.NKF / argSafe);
          }
        }

        // cite: bjtload.c:615-637 — excess phase (Weil backward-Euler).
        cc = 0;
        let cex = cbe;
        let gex = gbe;
        let cexbc_now = 0;
        if ((mode & (MODETRAN | MODEAC)) !== 0 && td !== 0) {
          const arg1a = ctx.dt / td;
          const arg2 = 3 * arg1a;
          const arg1 = arg2 * arg1a;
          const denom = 1 + arg1 + arg2;
          const arg3 = arg1 / denom;
          const deltaOld1 = ctx.deltaOld[1];
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_CEXBC] = cbe / qb;
            s2[base + SLOT_CEXBC] = s1[base + SLOT_CEXBC];
          }
          cc = (s1[base + SLOT_CEXBC] * (1 + ctx.dt / deltaOld1 + arg2)
                - s2[base + SLOT_CEXBC] * ctx.dt / deltaOld1) / denom;
          cex = cbe * arg3;
          gex = gbe * arg3;
          cexbc_now = cc + cex / qb;
        }

        // cite: bjtload.c:641-654 — dc incremental conductances.
        cc = cc + (cex - cbc) / qb - cbc / tp.tBetaR - cbcn;
        cb = cbe / tp.tBetaF + cben + cbc / tp.tBetaR + cbcn;
        // cite: bjtload.c:643-650 — effective base-resistance gx (rbpi already /area).
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

        // cite: bjtload.c:655-849 — capacitance + charge block.
        let capbe = 0;
        let capbc = 0;
        let capsub = 0;
        let capbx = 0;
        geqcb = 0;
        geqbx = 0;
        gcsub = 0;

        const capBlockGate = (mode & (MODETRAN | MODEAC)) !== 0
                          || ((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0)
                          || (mode & MODEINITSMSIG) !== 0;

        if (hasCapacitance && capBlockGate) {
          const tf  = tp.ttransitTimeF;
          const tr  = tp.ttransitTimeR;
          // cite: bjttemp.c:275,291-294,310-313 — area already folded into caps.
          const czbe = tp.tBEcap;
          const pe   = tp.tBEpot;
          const xme  = tp.tjunctionExpBE;
          const cdis = params.XCJC;
          const ctot = tp.tBCcap;
          const czbc = ctot * cdis;
          const czbx = ctot - czbc;
          const pc   = tp.tBCpot;
          const xmc  = tp.tjunctionExpBC;
          const fcpe = tp.tDepCap;
          const czsub = tp.tSubcap;
          const ps   = tp.tSubpot;
          const xms  = tp.tjunctionExpSub;
          const xtf  = params.XTF;
          const ovtf = params.VTF === Infinity ? 0 : 1 / (1.44 * params.VTF);
          // cite: bjttemp.c:128-129 — ttransitTimeHighCurrentF is area-folded.
          const xjtf = tp.ttransitTimeHighCurrentF;

          let cbeMod = cbe;
          let gbeMod = gbe;
          if (tf !== 0 && vbeLimited > 0) {
            let argtf = 0;
            let arg2 = 0;
            let arg3 = 0;
            if (xtf !== 0) {
              argtf = xtf;
              if (ovtf !== 0) argtf = argtf * Math.exp(vbcLimited * ovtf);
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
            geqcb  = tf * (arg3 - cbeMod * dqbdvc) / qb;
          }

          // QBE + capbe
          let qbe: number;
          if (vbeLimited < fcpe) {
            const arg = 1 - vbeLimited / pe;
            const sarg = Math.exp(-xme * Math.log(arg));
            qbe    = tf * cbeMod + pe * czbe * (1 - arg * sarg) / (1 - xme);
            capbe  = tf * gbeMod + czbe * sarg;
          } else {
            const f1 = tp.tf1;  const f2 = tp.f2;  const f3 = tp.f3;
            const czbef2 = czbe / f2;
            qbe    = tf * cbeMod + czbe * f1 + czbef2
                     * (f3 * (vbeLimited - fcpe) + (xme / (pe + pe)) * (vbeLimited * vbeLimited - fcpe * fcpe));
            capbe  = tf * gbeMod + czbef2 * (f3 + xme * vbeLimited / pe);
          }

          // QBC + capbc
          const fcpc = tp.tf4;
          const f1c = tp.tf5;  const f2c = tp.f6;  const f3c = tp.f7;
          let qbc: number;
          if (vbcLimited < fcpc) {
            const arg = 1 - vbcLimited / pc;
            const sarg = Math.exp(-xmc * Math.log(arg));
            qbc   = tr * cbc + pc * czbc * (1 - arg * sarg) / (1 - xmc);
            capbc = tr * gbc + czbc * sarg;
          } else {
            const czbcf2 = czbc / f2c;
            qbc   = tr * cbc + czbc * f1c + czbcf2
                    * (f3c * (vbcLimited - fcpc) + (xmc / (pc + pc)) * (vbcLimited * vbcLimited - fcpc * fcpc));
            capbc = tr * gbc + czbcf2 * (f3c + xmc * vbcLimited / pc);
          }

          // cite: bjtload.c:756-759 — BC charge augmented by Qbci when rco given.
          if (rcoGiven) {
            qbc  += Qbci_local;
            capbc += Qbci_Vbci_local;
          }

          // QBX + capbx
          let qbx: number;
          if (vbxRaw < fcpc) {
            const arg = 1 - vbxRaw / pc;
            const sarg = Math.exp(-xmc * Math.log(arg));
            qbx   = pc * czbx * (1 - arg * sarg) / (1 - xmc);
            capbx = czbx * sarg;
          } else {
            const czbxf2 = czbx / f2c;
            qbx   = czbx * f1c + czbxf2
                    * (f3c * (vbxRaw - fcpc) + (xmc / (pc + pc)) * (vbxRaw * vbxRaw - fcpc * fcpc));
            capbx = czbxf2 * (f3c + xmc * vbxRaw / pc);
          }

          // QSUB + capsub
          let qcs: number;
          if (vsubLimited < 0) {
            const arg = 1 - vsubLimited / ps;
            const sarg = Math.exp(-xms * Math.log(arg));
            qcs    = ps * czsub * (1 - arg * sarg) / (1 - xms);
            capsub = czsub * sarg;
          } else {
            qcs    = vsubLimited * czsub * (1 + xms * vsubLimited / (2 * ps));
            capsub = czsub * (1 + xms * vsubLimited / ps);
          }

          s0[base + SLOT_QBE]  = qbe;
          s0[base + SLOT_QBC]  = qbc;
          s0[base + SLOT_QBX]  = qbx;
          s0[base + SLOT_QSUB] = qcs;

          // cite: bjtload.c:769-800 — SMSIG: store caps and return (skip integration).
          if ((mode & MODEINITSMSIG) !== 0 &&
              !((mode & MODETRANOP) !== 0 && (mode & MODEUIC) !== 0)) {
            s0[base + SLOT_CQBE]  = capbe;
            s0[base + SLOT_CQBC]  = capbc;
            s0[base + SLOT_CQSUB] = capsub;
            s0[base + SLOT_CQBX]  = capbx;
            s0[base + SLOT_CEXBC] = geqcb;
            // cite: bjtload.c:775 — BJTcqbcx = Qbcx_Vbcx for AC stamp recovery.
            if (rcoGiven) s0[base + SLOT_CQBCX] = capbcx_local;
            s0[base + SLOT_VBE]  = vbeLimited;
            s0[base + SLOT_VBC]  = vbcLimited;
            s0[base + SLOT_CC]   = cc;
            s0[base + SLOT_CB]   = cb;
            s0[base + SLOT_GPI]  = gpi;
            s0[base + SLOT_GMU]  = gmu;
            s0[base + SLOT_GM]   = gm;
            s0[base + SLOT_GO]   = go;
            s0[base + SLOT_GX]   = gx;
            s0[base + SLOT_GEQCB] = geqcb;
            s0[base + SLOT_GCSUB] = 0;
            s0[base + SLOT_GEQBX] = 0;
            s0[base + SLOT_VSUB]  = vsubLimited;
            s0[base + SLOT_GDSUB] = gdsub;
            s0[base + SLOT_CDSUB] = cdsub;
            s0[base + SLOT_IRCI_VRCI] = Irci_Vrci;
            s0[base + SLOT_IRCI_VBCI] = Irci_Vbci;
            s0[base + SLOT_IRCI_VBCX] = Irci_Vbcx;
            return;
          }

          // cite: bjtload.c:812-823 — INITTRAN: dup q-slots into state1.
          if (mode & MODEINITTRAN) {
            s1[base + SLOT_QBE]  = qbe;
            s1[base + SLOT_QBC]  = qbc;
            s1[base + SLOT_QBX]  = qbx;
            s1[base + SLOT_QSUB] = qcs;
            s1[base + SLOT_QBCX] = s0[base + SLOT_QBCX];
          }

          if (ctx.dt > 0) {
            const ag = ctx.ag;
            // B-E cap companion (bjtload.c:824-828).
            {
              const ccapPrev = s1[base + SLOT_CQBE];
              const q2 = s2[base + SLOT_QBE];
              const q3 = s3[base + SLOT_QBE];
              const { ccap, geq } = niIntegrate(ctx.method, ctx.order, capbe, ag,
                qbe, s1[base + SLOT_QBE], [q2, q3, 0, 0, 0], ccapPrev);
              s0[base + SLOT_CQBE] = ccap;
              geqcb = geqcb * ag[0];
              gpi   = gpi + geq;
              cb    = cb + ccap;
            }
            // B-C cap companion (bjtload.c:829-834).
            {
              const ccapPrev = s1[base + SLOT_CQBC];
              const q2 = s2[base + SLOT_QBC];
              const q3 = s3[base + SLOT_QBC];
              const { ccap, geq } = niIntegrate(ctx.method, ctx.order, capbc, ag,
                qbc, s1[base + SLOT_QBC], [q2, q3, 0, 0, 0], ccapPrev);
              s0[base + SLOT_CQBC] = ccap;
              gmu = gmu + geq;
              cb  = cb + ccap;
              cc  = cc - ccap;
            }
            // cite: bjtload.c:834-839 — QBCx cap integration (rco-gated).
            if (rcoGiven) {
              const ccapPrev = s1[base + SLOT_CQBCX];
              const q2 = s2[base + SLOT_QBCX];
              const q3 = s3[base + SLOT_QBCX];
              const { ccap, geq } = niIntegrate(ctx.method, ctx.order, capbcx_local, ag,
                s0[base + SLOT_QBCX], s1[base + SLOT_QBCX], [q2, q3, 0, 0, 0], ccapPrev);
              s0[base + SLOT_CQBCX] = ccap;
              gbcx = geq;
              cbcx = ccap;
            }
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQBE]  = s0[base + SLOT_CQBE];
              s1[base + SLOT_CQBC]  = s0[base + SLOT_CQBC];
              if (rcoGiven) s1[base + SLOT_CQBCX] = s0[base + SLOT_CQBCX];
            }

            // C-S and B-X cap (bjtload.c:866-877).
            {
              const ccapPrev = s1[base + SLOT_CQSUB];
              const q2 = s2[base + SLOT_QSUB];
              const q3 = s3[base + SLOT_QSUB];
              const { ccap, geq } = niIntegrate(ctx.method, ctx.order, capsub, ag,
                qcs, s1[base + SLOT_QSUB], [q2, q3, 0, 0, 0], ccapPrev);
              s0[base + SLOT_CQSUB] = ccap;
              gcsub = geq;
            }
            {
              const ccapPrev = s1[base + SLOT_CQBX];
              const q2 = s2[base + SLOT_QBX];
              const q3 = s3[base + SLOT_QBX];
              const { ccap, geq } = niIntegrate(ctx.method, ctx.order, capbx, ag,
                qbx, s1[base + SLOT_QBX], [q2, q3, 0, 0, 0], ccapPrev);
              s0[base + SLOT_CQBX] = ccap;
              geqbx = geq;
            }
            if (mode & MODEINITTRAN) {
              s1[base + SLOT_CQBX]  = s0[base + SLOT_CQBX];
              s1[base + SLOT_CQSUB] = s0[base + SLOT_CQSUB];
            }
          }
        } // end cap block

        // cite: bjtload.c:879-900 — next2: state0 write-back of linearization.
        s0[base + SLOT_VBE]   = vbeLimited;
        s0[base + SLOT_VBC]   = vbcLimited;
        s0[base + SLOT_VBCX]  = vbcxLimited;
        s0[base + SLOT_VRCI]  = vrciLimited;
        s0[base + SLOT_CC]    = cc;
        s0[base + SLOT_CB]    = cb;
        s0[base + SLOT_GPI]   = gpi;
        s0[base + SLOT_GMU]   = gmu;
        s0[base + SLOT_GM]    = gm;
        s0[base + SLOT_GO]    = go;
        s0[base + SLOT_GX]    = gx;
        s0[base + SLOT_GEQCB] = geqcb;
        s0[base + SLOT_GCSUB] = gcsub;
        s0[base + SLOT_GEQBX] = geqbx;
        s0[base + SLOT_VSUB]  = vsubLimited;
        s0[base + SLOT_GDSUB] = gdsub;
        s0[base + SLOT_CDSUB] = cdsub;
        s0[base + SLOT_CEXBC] = cexbc_now;
        s0[base + SLOT_IRCI]      = Irci;
        s0[base + SLOT_IRCI_VRCI] = Irci_Vrci;
        s0[base + SLOT_IRCI_VBCI] = Irci_Vbci;
        s0[base + SLOT_IRCI_VBCX] = Irci_Vbcx;
        // BJTgbcx is never written by ngspice load(): the gbcx local feeds the
        // collCX/basePrime coupling stamp only (bjtload.c:979-982), and the
        // bypass path reads the slot's init 0 (bjtload.c:404). Leaving SLOT_GBCX
        // unwritten keeps it at 0 to match, on both the state vector and the
        // bypass-stamp value.
      } // end bypass else

      // cite: bjtload.c:910-918 — RHS excitation vectors.
      const geqsub = gcsub + gdsub;
      const ceqsub = polarity * subs * (s0[base + SLOT_CQSUB] + cdsub - vsubLimited * geqsub);
      const ceqbx  = polarity * (s0[base + SLOT_CQBX] - vbxRaw * geqbx);
      const ceqbe  = polarity * (cc + cb - vbeLimited * (gm + go + gpi) + vbcLimited * (go - geqcb));
      const ceqbc  = polarity * (-cc + vbeLimited * (gm + go) - vbcLimited * (gmu + go));

      // cite: bjtload.c:920-927 — RHS stamps.
      stampRHS(ctx.rhs, nodeB_ext,    m * -ceqbx);
      stampRHS(ctx.rhs, nodeC_int,    m * (ceqbx + ceqbc));
      stampRHS(ctx.rhs, substConNode, m * ceqsub);
      stampRHS(ctx.rhs, nodeB_int,    m * (-ceqbe - ceqbc));
      stampRHS(ctx.rhs, nodeE_int,    m * ceqbe);
      stampRHS(ctx.rhs, 0,            m * -ceqsub);

      // cite: bjtload.c:929-956 — Y-matrix stamps. gcpr (collector ohmic
      // conductance) stamps on the collCX diagonal (bjtload.c:932,935-936);
      // no AREA factor (area is folded into the temperature-resolved params).
      solver.stampElement(this._hCC,              m * gcpr);                 // bjtload.c:932
      solver.stampElement(this._hBB,              m * (gx + geqbx));         // bjtload.c:933
      solver.stampElement(this._hEE,              m * gepr);                 // bjtload.c:934
      solver.stampElement(this._hCPCP,            m * (gmu + go + geqbx));   // bjtload.c:935 (gcpr gone to collCX)
      solver.stampElement(this._hCollCXcollCX,    m * gcpr);                 // bjtload.c:936
      solver.stampElement(this._hSubstConSubstCon, m * geqsub);              // bjtload.c:937
      solver.stampElement(this._hBPBP,            m * (gx + gpi + gmu + geqcb));  // bjtload.c:938
      solver.stampElement(this._hEPEP,            m * (gpi + gepr + gm + go));     // bjtload.c:939
      solver.stampElement(this._hCCP,             m * -gcpr);                // bjtload.c:940 (BJTcollCollCXPtr)
      solver.stampElement(this._hBBP,             m * -gx);                  // bjtload.c:941
      solver.stampElement(this._hEEP,             m * -gepr);                // bjtload.c:942
      solver.stampElement(this._hCPC,             m * -gcpr);                // bjtload.c:943 (BJTcollCXCollPtr)
      solver.stampElement(this._hCPBP,            m * (-gmu + gm));          // bjtload.c:944
      solver.stampElement(this._hCPEP,            m * (-gm - go));           // bjtload.c:945
      solver.stampElement(this._hBPB,             m * -gx);                  // bjtload.c:946
      solver.stampElement(this._hBPCP,            m * (-gmu - geqcb));       // bjtload.c:947
      solver.stampElement(this._hBPEP,            m * -gpi);                 // bjtload.c:948
      solver.stampElement(this._hEPE,             m * -gepr);                // bjtload.c:949
      solver.stampElement(this._hEPCP,            m * (-go + geqcb));        // bjtload.c:950
      solver.stampElement(this._hEPBP,            m * (-gpi - gm - geqcb));  // bjtload.c:951
      solver.stampElement(this._hSS,              m * geqsub);               // bjtload.c:952
      solver.stampElement(this._hSCS,             m * -geqsub);              // bjtload.c:953
      solver.stampElement(this._hSSC,             m * -geqsub);              // bjtload.c:954
      solver.stampElement(this._hBCP,             m * -geqbx);               // bjtload.c:955
      solver.stampElement(this._hCPB,             m * -geqbx);               // bjtload.c:956

      // cite: bjtload.c:960-983 — Kull epi-element Jacobian stamp (rco-gated).
      // Repeated += into shared cells in the exact ngspice accumulation order.
      if (rcoGiven) {
        const rhs_curr = polarity * m *
          (Irci - Irci_Vrci * vrciLimited - Irci_Vbci * vbcLimited - Irci_Vbcx * vbcxLimited);
        stampRHS(ctx.rhs, nodeCX,    -rhs_curr);                             // bjtload.c:962
        solver.stampElement(this._hCollCXcollCX,   m *  Irci_Vrci);          // bjtload.c:963
        solver.stampElement(this._hCollCXColPrime,  m * -Irci_Vrci);         // bjtload.c:964
        solver.stampElement(this._hCollCXBasePrime, m *  Irci_Vbci);         // bjtload.c:965
        solver.stampElement(this._hCollCXColPrime,  m * -Irci_Vbci);         // bjtload.c:966
        solver.stampElement(this._hCollCXBasePrime, m *  Irci_Vbcx);         // bjtload.c:967
        solver.stampElement(this._hCollCXcollCX,    m * -Irci_Vbcx);         // bjtload.c:968
        stampRHS(ctx.rhs, nodeC_int,  rhs_curr);                             // bjtload.c:969
        solver.stampElement(this._hColPrimeCollCX,  m * -Irci_Vrci);         // bjtload.c:970
        solver.stampElement(this._hCPCP,            m *  Irci_Vrci);         // bjtload.c:971
        solver.stampElement(this._hCPBP,            m * -Irci_Vbci);         // bjtload.c:972
        solver.stampElement(this._hCPCP,            m *  Irci_Vbci);         // bjtload.c:973
        solver.stampElement(this._hCPBP,            m * -Irci_Vbcx);         // bjtload.c:974
        solver.stampElement(this._hColPrimeCollCX,  m *  Irci_Vbcx);         // bjtload.c:975
        // base–collCX charge (cbcx / gbcx) — bjtload.c:977-982.
        stampRHS(ctx.rhs, nodeB_int, m * -cbcx);                             // bjtload.c:977
        stampRHS(ctx.rhs, nodeCX,    m *  cbcx);                             // bjtload.c:978
        solver.stampElement(this._hBPBP,            m *  gbcx);              // bjtload.c:979
        solver.stampElement(this._hCollCXcollCX,    m *  gbcx);              // bjtload.c:980
        solver.stampElement(this._hBasePrimeCollCX, m * -gbcx);              // bjtload.c:981
        solver.stampElement(this._hCollCXBasePrime, m * -gbcx);              // bjtload.c:982
      }
    }

    /**
     * Complete v41 AC small-signal stamp — operand-for-operand port of
     * ref/ngspice/src/spicelib/devices/bjt/bjtacld.c:41-128 (BJTacLoad).
     * All handles come from setup(); no allocElement here. gcpr/gepr are the
     * area-folded conductances from bjttemp (bjtacld.c:47-48, no *BJTarea).
     */
    stampAc(solver: SparseSolverStamp, omega: number): void {
      const base = this._stateBase;
      const s0 = this._pool.states[0];

      // cite: bjtacld.c:45-55 — m, gcpr/gepr (area in temp), gpi/gmu/gm/go,
      // Irci_* derivatives saved by load() for the Kull AC cross-terms.
      const m = params.M;
      const gcpr = tp.tcollectorConduct;    // bjtacld.c:47 — no *BJTarea
      const gepr = tp.temitterConduct;      // bjtacld.c:48 — no *BJTarea
      const gpi  = s0[base + SLOT_GPI];    // bjtacld.c:49
      const gmu  = s0[base + SLOT_GMU];    // bjtacld.c:50
      let   gm   = s0[base + SLOT_GM];     // bjtacld.c:51
      const go   = s0[base + SLOT_GO];     // bjtacld.c:52
      const Irci_Vrci = s0[base + SLOT_IRCI_VRCI]; // bjtacld.c:53
      const Irci_Vbci = s0[base + SLOT_IRCI_VBCI]; // bjtacld.c:54
      const Irci_Vbcx = s0[base + SLOT_IRCI_VBCX]; // bjtacld.c:55

      // cite: bjtacld.c:56-63 — excess-phase rotation of gm.
      let xgm = 0;                          // bjtacld.c:56
      const td = tp.excessPhaseFactor;       // bjtacld.c:57
      if (td !== 0) {
        const arg = td * omega;              // bjtacld.c:59
        gm = gm + go;                        // bjtacld.c:60
        xgm = -gm * Math.sin(arg);           // bjtacld.c:61 (reads post-add gm)
        gm = gm * Math.cos(arg) - go;        // bjtacld.c:62
      }

      // cite: bjtacld.c:64-70 — small-signal susceptances.
      const gx    = s0[base + SLOT_GX];               // bjtacld.c:64
      const xcpi  = s0[base + SLOT_CQBE]  * omega;    // bjtacld.c:65
      const xcmu  = s0[base + SLOT_CQBC]  * omega;    // bjtacld.c:66
      const xcbx  = s0[base + SLOT_CQBX]  * omega;    // bjtacld.c:67
      const xcsub = s0[base + SLOT_CQSUB] * omega;    // bjtacld.c:68
      const xcmcb = s0[base + SLOT_CEXBC] * omega;    // bjtacld.c:69
      const xcbcx = s0[base + SLOT_CQBCX] * omega;    // bjtacld.c:70 (Kull base–collCX)

      // cite: bjtacld.c:72-106 — complex matrix stamps; real via stampElement,
      // imaginary `*(ptr+1)` via stampElementImag; collCX-split form.
      solver.stampElement(this._hCC,            m * (gcpr));           // bjtacld.c:72
      solver.stampElement(this._hBB,            m * (gx));             // bjtacld.c:73
      solver.stampElementImag(this._hBB,        m * (xcbx));           // bjtacld.c:74
      solver.stampElement(this._hEE,            m * (gepr));           // bjtacld.c:75
      solver.stampElement(this._hCPCP,          m * (gmu + go));       // bjtacld.c:76 (gcpr on collCX:77)
      solver.stampElement(this._hCollCXcollCX,  m * (gcpr));           // bjtacld.c:77
      solver.stampElementImag(this._hCPCP,      m * (xcmu + xcbx));    // bjtacld.c:78
      solver.stampElementImag(this._hSubstConSubstCon, m * (xcsub));   // bjtacld.c:79
      solver.stampElement(this._hBPBP,          m * (gx + gpi + gmu)); // bjtacld.c:80
      solver.stampElementImag(this._hBPBP,      m * (xcpi + xcmu + xcmcb)); // bjtacld.c:81
      solver.stampElement(this._hEPEP,          m * (gpi + gepr + gm + go)); // bjtacld.c:82
      solver.stampElementImag(this._hEPEP,      m * (xcpi + xgm));     // bjtacld.c:83
      solver.stampElement(this._hCCP,           m * (-gcpr));          // bjtacld.c:84 (BJTcollCollCXPtr)
      solver.stampElement(this._hBBP,           m * (-gx));            // bjtacld.c:85
      solver.stampElement(this._hEEP,           m * (-gepr));          // bjtacld.c:86
      solver.stampElement(this._hCPC,           m * (-gcpr));          // bjtacld.c:87 (BJTcollCXCollPtr)
      solver.stampElement(this._hCPBP,          m * (-gmu + gm));      // bjtacld.c:88
      solver.stampElementImag(this._hCPBP,      m * (-xcmu + xgm));    // bjtacld.c:89
      solver.stampElement(this._hCPEP,          m * (-gm - go));       // bjtacld.c:90
      solver.stampElementImag(this._hCPEP,      m * (-xgm));           // bjtacld.c:91
      solver.stampElement(this._hBPB,           m * (-gx));            // bjtacld.c:92
      solver.stampElement(this._hBPCP,          m * (-gmu));           // bjtacld.c:93
      solver.stampElementImag(this._hBPCP,      m * (-xcmu - xcmcb));  // bjtacld.c:94
      solver.stampElement(this._hBPEP,          m * (-gpi));           // bjtacld.c:95
      solver.stampElementImag(this._hBPEP,      m * (-xcpi));          // bjtacld.c:96
      solver.stampElement(this._hEPE,           m * (-gepr));          // bjtacld.c:97
      solver.stampElement(this._hEPCP,          m * (-go));            // bjtacld.c:98
      solver.stampElementImag(this._hEPCP,      m * (xcmcb));          // bjtacld.c:99
      solver.stampElement(this._hEPBP,          m * (-gpi - gm));      // bjtacld.c:100
      solver.stampElementImag(this._hEPBP,      m * (-xcpi - xgm - xcmcb)); // bjtacld.c:101
      solver.stampElementImag(this._hSS,        m * (xcsub));          // bjtacld.c:102
      solver.stampElementImag(this._hSCS,       m * (-xcsub));         // bjtacld.c:103
      solver.stampElementImag(this._hSSC,       m * (-xcsub));         // bjtacld.c:104
      solver.stampElementImag(this._hBCP,       m * (-xcbx));          // bjtacld.c:105
      solver.stampElementImag(this._hCPB,       m * (-xcbx));          // bjtacld.c:106

      // cite: bjtacld.c:107-124 — Kull internal-collector-resistance AC cross-
      // terms, gated on BJTintCollResistGiven; Irci_* are the DC-OP derivatives
      // saved by load() (bjtacld.c:53-55), xcbcx the base–collCX susceptance.
      if (rcoGiven) {
        solver.stampElement(this._hCollCXcollCX,   m *  Irci_Vrci);   // bjtacld.c:108
        solver.stampElement(this._hCollCXColPrime,  m * -Irci_Vrci);  // bjtacld.c:109
        solver.stampElement(this._hCollCXBasePrime, m *  Irci_Vbci);  // bjtacld.c:110
        solver.stampElement(this._hCollCXColPrime,  m * -Irci_Vbci);  // bjtacld.c:111
        solver.stampElement(this._hCollCXBasePrime, m *  Irci_Vbcx);  // bjtacld.c:112
        solver.stampElement(this._hCollCXcollCX,    m * -Irci_Vbcx);  // bjtacld.c:113
        solver.stampElement(this._hColPrimeCollCX,  m * -Irci_Vrci);  // bjtacld.c:114
        solver.stampElement(this._hCPCP,            m *  Irci_Vrci);  // bjtacld.c:115
        solver.stampElement(this._hCPBP,            m * -Irci_Vbci);  // bjtacld.c:116
        solver.stampElement(this._hCPCP,            m *  Irci_Vbci);  // bjtacld.c:117
        solver.stampElement(this._hCPBP,            m * -Irci_Vbcx);  // bjtacld.c:118
        solver.stampElement(this._hColPrimeCollCX,  m *  Irci_Vbcx);  // bjtacld.c:119
        solver.stampElementImag(this._hBPBP,            m *  xcbcx);  // bjtacld.c:120
        solver.stampElementImag(this._hCollCXcollCX,    m *  xcbcx);  // bjtacld.c:121
        solver.stampElementImag(this._hBasePrimeCollCX, m * -xcbcx);  // bjtacld.c:122
        solver.stampElementImag(this._hCollCXBasePrime, m * -xcbcx);  // bjtacld.c:123
      }
    }

    checkConvergence(ctx: LoadContext): boolean {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      const voltages = ctx.rhsOld;
      const vBi  = voltages[nodeB_int];
      const vCX  = voltages[nodeCX];
      const vCi  = voltages[nodeC_int];
      const vEi  = voltages[nodeE_int];
      const vbeRaw  = polarity * (vBi - vEi);
      const vbcRaw  = polarity * (vBi - vCi);
      // cite: bjtconv.c:45-50 — third junction vbcx = base–collCX; delvbcx
      // computed for voltage-set parity but not used in the cchat/cbhat test.
      const vbcxRaw = polarity * (vBi - vCX);
      void (vbcxRaw - s0[base + SLOT_VBCX]); // delvbcx — parity read, unused in tol

      if (this._icheckLimited) return false;

      const delvbe = vbeRaw - s0[base + SLOT_VBE];
      const delvbc = vbcRaw - s0[base + SLOT_VBC];
      const cc  = s0[base + SLOT_CC];
      const cb  = s0[base + SLOT_CB];
      const gm  = s0[base + SLOT_GM];
      const go  = s0[base + SLOT_GO];
      const gpi = s0[base + SLOT_GPI];
      const gmu = s0[base + SLOT_GMU];

      // cite: bjtconv.c:51-57 — cchat/cbhat tolerance test (delvbcx not used).
      const cchat = cc + (gm + go) * delvbe - (go + gmu) * delvbc;
      const cbhat = cb + gpi * delvbe + gmu * delvbc;

      const tolC = ctx.reltol * Math.max(Math.abs(cchat), Math.abs(cc)) + ctx.iabstol;
      const tolB = ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(cb)) + ctx.iabstol;

      return Math.abs(cchat - cc) <= tolC && Math.abs(cbhat - cb) <= tolB;
    }

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
    ): number {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const s1 = this._pool.states[1];
      const s2 = this._pool.states[2];
      const s3 = this._pool.states[3];
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
      // cite: bjttrunc.c:32 — CKTterr(BJTqsub) unconditional.
      {
        const dtCS = cktTerr(dt, deltaOld, order, method,
          s0[base + SLOT_QSUB], s1[base + SLOT_QSUB], s2[base + SLOT_QSUB], s3[base + SLOT_QSUB],
          s0[base + SLOT_CQSUB], s1[base + SLOT_CQSUB], lteParams);
        if (dtCS < minDt) minDt = dtCS;
      }
      // cite: bjttrunc.c:33-35 — BJTqbcx CKTterr gated on BJTintCollResistGiven.
      if (rcoGiven) {
        const dtBCX = cktTerr(dt, deltaOld, order, method,
          s0[base + SLOT_QBCX], s1[base + SLOT_QBCX], s2[base + SLOT_QBCX], s3[base + SLOT_QBCX],
          s0[base + SLOT_CQBCX], s1[base + SLOT_CQBCX], lteParams);
        if (dtBCX < minDt) minDt = dtBCX;
      }
      return minDt;
    }

    getPinCurrents(_rhs: Float64Array): number[] {
      const base = this._stateBase;
      const s0 = this._pool.states[0];
      const ic = polarity * s0[base + SLOT_CC];
      const ib = polarity * s0[base + SLOT_CB];
      const ie = -(ic + ib);
      return [ib, ic, ie];
    }

    /**
     * computeTemperature — engine-driven temperature pass for the BJT L1 model.
     *
     * cite: bjttemp.c:107-108 — if(!here->BJTtempGiven) here->BJTtemp = ckt->CKTtemp + here->BJTdtemp;
     * Resolve effective T: per-instance TEMP given → use params.TEMP; else use ctx.cktTemp.
     * cite: bjttemp.c:158-260 — per-instance temperature math (vt, tSatCur, tBetaF/R, leakage,
     * junction caps tBEcap/tBCcap, built-in potentials tBEpot/tBCpot, tDepCap, tVcrit, etc.).
     * PNP polarity uses the same temperature math as NPN (bjttemp.c is polarity-agnostic;
     * polarity affects junction voltage sign in bjtload.c, not bjttemp.c).
     */
    computeTemperature(ctx: TempContext): void {
      // cite: bjttemp.c:107-108 — if(!here->BJTtempGiven) here->BJTtemp = ckt->CKTtemp + here->BJTdtemp;
      const effectiveT = _tempGiven ? params.TEMP : ctx.cktTemp;
      tp = computeL1Tp(effectiveT);
    }

    setParam(key: string, value: number): void {
      if (key === "TEMP") {
        params.TEMP = value;
        _tempGiven = true;
        // cite: bjttemp.c:107-110 — per-instance TEMP given overrides circuit temp.
        // Re-run temperature math at the new per-instance temperature.
        tp = computeL1Tp(value);
      } else if (key in params) {
        params[key] = value;
        tp = makeTp();
      }
    }
  }

  return new BjtL1Element(pinNodes);
}

// ---------------------------------------------------------------------------
// createBjtL1Element  outer factory capturing polarity and isLateral as
// closure constants. BJT vertical/lateral topology is a model variant (see
// modelRegistry "spice" vs "spice-lateral"), not a runtime parameter  so
// `isLateral` is set once at element construction rather than read per-load.
// ---------------------------------------------------------------------------

export function createBjtL1Element(polarity: 1 | -1, isLateral: boolean): AnalogFactory {
  return (pinNodes, props, _getTime) =>
    createSpiceL1BjtElement(polarity, isLateral, pinNodes, props);
}

// ---------------------------------------------------------------------------
// NpnBjtElement + PnpBjtElement  visual classes (unchanged)
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

export const NpnBjtDefinition: StandaloneComponentDefinition = {
  name: "NpnBJT",
  typeId: -1,
  factory: npnCircuitFactory,
  pinLayout: buildNpnPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN BJT  Gummel-Poon Level 2 bipolar junction transistor.\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "simple": {
      kind: "inline",
      factory: createBjtL0Element,
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_NPN_DEFAULTS,
    },
    "spice": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_NPN_DEFAULTS,
    },
    "spice-lateral": {
      kind: "inline",
      factory: createBjtL1Element(1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_NPN_DEFAULTS,
    },
    "2N3904": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N3904,
    },
    "BC547B": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_BC547B,
    },
    "2N2222A": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2222A,
    },
    "2N2219A": {
      kind: "inline",
      factory: createBjtL1Element(1, false),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: NPN_2N2219A,
    },
  },
  defaultModel: "spice",
};

export const PnpBjtDefinition: StandaloneComponentDefinition = {
  name: "PnpBJT",
  typeId: -1,
  factory: pnpCircuitFactory,
  pinLayout: buildPnpPinDeclarations(),
  propertyDefs: BJT_PROPERTY_DEFS,
  attributeMap: BJT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP BJT  Gummel-Poon Level 2 bipolar junction transistor (PNP polarity).\n" +
    "Pins: C (collector), B (base), E (emitter).\n" +
    "Model parameters: IS, BF, NF, BR, NR, VAF, VAR, IKF, IKR.",
  models: {},
  modelRegistry: {
    "simple": {
      kind: "inline",
      factory: createPnpBjtL0Element,
      paramDefs: BJT_PARAM_DEFS,
      params: BJT_PNP_DEFAULTS,
    },
    // ngspice (bjtsetup.c:42-46) defaults BJTsubs to LATERAL for PNP when not
    // explicitly given. The L1 PNP model registry mirrors that default — every
    // entry below uses `isLateral=true` so that `"model": "spice"` matches
    // ngspice's behavior bit-exact. NPN uses VERTICAL by the same convention
    // (see NpnBjtDefinition above).
    "spice": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_PNP_DEFAULTS,
    },
    "spice-lateral": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: BJT_SPICE_L1_PNP_DEFAULTS,
    },
    "2N3906": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N3906,
    },
    "BC557B": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_BC557B,
    },
    "2N2907A": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_2N2907A,
    },
    "TIP32C": {
      kind: "inline",
      factory: createBjtL1Element(-1, true),
      paramDefs: BJT_SPICE_L1_PARAM_DEFS,
      params: PNP_TIP32C,
    },
  },
  defaultModel: "spice",
};
