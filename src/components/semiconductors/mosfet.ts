/**
 * MOSFET analog components — N-channel and P-channel MOSFETs (SPICE Level 1).
 *
 * Port of ngspice `ref/ngspice/src/spicelib/devices/mos1/mos1load.c::MOS1load`.
 * Single-pass `load()` per device per NR iteration (Wave 6.1 unified interface).
 * Cap companions lump inline into the gpi/gmu-analog MOS stamps per `mos1load.c:900-end`.
 *
 * Invented cross-method slots deleted per Phase 2.5 Wave 1.3 A1 (11 cap+Q
 * slots cited in C-AUD-6). Only slots with direct ngspice MOS1state<n>
 * correspondence in `mos1defs.h:269-291` survive.
 *
 * G1 — Sign convention (Phase 2.5 W1.3 ruling 2026-04-21): digiTS now uses
 * ngspice's VBS / VBD convention — `vbs = vb - vs`, `vbd = vb - vd`. Prior
 * code used VSB/VBD with an opposite sign; every site — limiting,
 * cap-voltage updates, current evaluation, stamps — is ported from
 * `mos1load.c:150-250` verbatim with the ngspice convention.
 *
 * PMOS is the NMOS model with polarity=-1, matching ngspice `MOS1type`.
 * All junction voltages are polarity-signed at the vbs/vgs/vds read site
 * (mos1load.c:231-239) and un-polarity-signed at the stamp site.
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
import { fetlim, limvds, pnjlim } from "../../solver/analog/newton-raphson.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams, deviceParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITFLOAT, MODEINITJCT, MODEINITFIX, MODEINITSMSIG,
  MODEINITTRAN, MODEINITPRED, MODETRAN, MODETRANOP, MODEAC, MODEUIC,
  MODEDCOP, MODEDCTRANCURVE,
} from "../../solver/analog/ckt-mode.js";

// Phase 5 precondition: compile error if LoadContext is missing bypass or voltTol.
type _PhaseAssert = Pick<LoadContext, "bypass" | "voltTol">;

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h / defines.h values)
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (CKTgmin). */
const GMIN = 1e-12;

/** Boltzmann constant (CONSTboltz). */
const CONSTboltz = 1.3806226e-23;
/** Elementary charge (CHARGE). */
const Q = 1.6021918e-19;
/** k/q (CONSTKoverQ). */
const KoverQ = CONSTboltz / Q;
/** Reference temperature (REFTEMP). */
const REFTEMP = 300.15;
/** Exponential-argument ceiling (defines.h:35 MAX_EXP_ARG). */
const MAX_EXP_ARG = 709.0;

/** Permittivity of free space (F/m). */
const EPS0 = 8.854214871e-12;
/** Relative permittivity of SiO2. */
const EPS_OX = 3.9;
/** Relative permittivity of Si. */
const EPS_SI = 11.7;
/** Intrinsic carrier concentration of Si at 300K (cm⁻³). */
const NI = 1.45e10;

// ---------------------------------------------------------------------------
// MosfetParams / ResolvedMosfetParams — raw PropertyBag → typed
// ---------------------------------------------------------------------------

interface MosfetParams {
  VTO: number; KP: number; LAMBDA: number; PHI: number; GAMMA: number;
  W: number; L: number;
  CBD?: number; CBS?: number; CGDO?: number; CGSO?: number; CGBO?: number;
  RD?: number; RS?: number;
  IS?: number; PB?: number;
  CJ?: number; MJ?: number; CJSW?: number; MJSW?: number;
  JS?: number; RSH?: number; FC?: number;
  AD?: number; AS?: number; PD?: number; PS?: number;
  TNOM?: number; TOX?: number; NSUB?: number; NSS?: number; TPG?: number;
  LD?: number; UO?: number;
  KF?: number; AF?: number;
  M?: number; OFF?: number;
  ICVDS?: number; ICVGS?: number; ICVBS?: number;
  TEMP?: number;
}

interface ResolvedMosfetParams {
  VTO: number; KP: number; LAMBDA: number; PHI: number; GAMMA: number;
  W: number; L: number;
  CBD: number; CBS: number; CGDO: number; CGSO: number; CGBO: number;
  RD: number; RS: number;
  IS: number; PB: number;
  CJ: number; MJ: number; CJSW: number; MJSW: number;
  JS: number; RSH: number; FC: number;
  AD: number; AS: number; PD: number; PS: number;
  TNOM: number; TOX: number; NSUB: number; NSS: number; TPG: number;
  LD: number; UO: number;
  KF: number; AF: number;
  M: number; OFF: number;
  ICVDS: number; ICVGS: number; ICVBS: number;
  TEMP: number;
  // Temperature-corrected values — populated by MosfetTempParams
  _tKP?: number;
  _tPhi?: number;
  _tVto?: number;
}

// ---------------------------------------------------------------------------
// Model parameter declarations — NMOS
// ---------------------------------------------------------------------------

export const { paramDefs: MOSFET_NMOS_PARAM_DEFS, defaults: MOSFET_NMOS_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: 1.0,  unit: "V",      description: "Threshold voltage" },
    KP:     { default: 2e-5, unit: "A/V²",   description: "Process transconductance parameter" },
    LAMBDA: { default: 0,    unit: "1/V",    description: "Channel-length modulation" },
    W:      { default: 1e-6, unit: "m",      description: "Channel width" },
    L:      { default: 1e-6, unit: "m",      description: "Channel length" },
  },
  secondary: {
    PHI:    { default: 0.6,  unit: "V",      description: "Surface potential" },
    GAMMA:  { default: 0.0,  unit: "V^0.5",  description: "Body-effect coefficient" },
    CBD:    { default: 0,    unit: "F",      description: "Drain-bulk junction capacitance" },
    CBS:    { default: 0,    unit: "F",      description: "Source-bulk junction capacitance" },
    CGDO:   { default: 0,    unit: "F/m",    description: "Gate-drain overlap capacitance per unit width" },
    CGSO:   { default: 0,    unit: "F/m",    description: "Gate-source overlap capacitance per unit width" },
    CGBO:   { default: 0,    unit: "F/m",    description: "Gate-bulk overlap capacitance per unit length" },
    RD:     { default: 0,    unit: "Ω",      description: "Drain ohmic resistance" },
    RS:     { default: 0,    unit: "Ω",      description: "Source ohmic resistance" },
    IS:     { default: 1e-14, unit: "A",     description: "Bulk junction saturation current" },
    PB:     { default: 0.8,  unit: "V",      description: "Bulk junction potential" },
    CJ:     { default: 0,    unit: "F/m²",   description: "Zero-bias bulk junction bottom capacitance per unit area" },
    MJ:     { default: 0.5,                  description: "Bulk junction bottom grading coefficient" },
    CJSW:   { default: 0,    unit: "F/m",    description: "Zero-bias junction sidewall capacitance per unit length" },
    MJSW:   { default: 0.5,                  description: "Bulk junction sidewall grading coefficient" },
    JS:     { default: 0,    unit: "A/m²",   description: "Bulk junction saturation current density" },
    RSH:    { default: 0,    unit: "Ω/sq",   description: "Drain/source diffusion sheet resistance" },
    AD:     { default: 0,    unit: "m²",     description: "Drain area" },
    AS:     { default: 0,    unit: "m²",     description: "Source area" },
    PD:     { default: 0,    unit: "m",      description: "Drain perimeter" },
    PS:     { default: 0,    unit: "m",      description: "Source perimeter" },
    TNOM:   { default: REFTEMP, unit: "K",   description: "Nominal temperature" },
    TOX:    { default: 1e-7, unit: "m",      description: "Oxide thickness" },
    NSUB:   { default: 0,    unit: "cm⁻³",   description: "Substrate doping" },
    NSS:    { default: 0,    unit: "cm⁻²",   description: "Surface state density" },
    TPG:    { default: 1,                    description: "Gate type: 1=opposite, -1=same, 0=Al gate" },
    LD:     { default: 0,    unit: "m",      description: "Lateral diffusion" },
    UO:     { default: 600,  unit: "cm²/Vs", description: "Surface mobility" },
    KF:     { default: 0,                    description: "Flicker noise coefficient" },
    AF:     { default: 1,                    description: "Flicker noise exponent" },
    FC:     { default: 0.5,                  description: "Forward-bias depletion capacitance coefficient" },
    M:      { default: 1,                    description: "Parallel device multiplier" },
    OFF:    { default: 0,                    description: "Initial condition: device off (0=false, 1=true)" },
    ICVDS:  { default: 0,    unit: "V",      description: "Initial condition for Vds (MODEUIC)" },
    ICVGS:  { default: 0,    unit: "V",      description: "Initial condition for Vgs (MODEUIC)" },
    ICVBS:  { default: 0,    unit: "V",      description: "Initial condition for Vbs (MODEUIC)" },
    TEMP:   { default: REFTEMP, unit: "K",   description: "Per-instance operating temperature" },
  },
});

// ---------------------------------------------------------------------------
// Built-in NMOS model presets
// Sources: ON Semi MODPEX 2004, Zetex 1985, IR/Symmetry MODPEX 1996
// ---------------------------------------------------------------------------

/** Small signal NMOS (TO-92, 60V/200mA). Source: ON Semi 2N7000.REV0.LIB. */
const NMOS_2N7000 = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 2.236, KP: 0.0932174, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.0724e-11, CGSO: 1.79115e-7,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** Small signal NMOS (TO-92, 60V/500mA). Source: Zetex BS170/ZTX (12/85). */
const NMOS_BS170 = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 1.824, KP: 0.1233, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 35e-12, CBS: 0, CGDO: 3e-12, CGSO: 28e-12,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** Medium power NMOS (TO-220, 100V/17A). Source: IR irf530n_IR. */
const NMOS_IRF530N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.63019, KP: 17.6091, LAMBDA: 0.00363922, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.4372e-7, CGSO: 5.59846e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** High power NMOS (TO-220, 100V/33A). Source: IR irf540n_IR. */
const NMOS_IRF540N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.55958, KP: 28.379, LAMBDA: 0.000888191, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.77276e-8, CGSO: 1.23576e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** High power NMOS (TO-220, 55V/49A). Source: IR irfz44n_IR. */
const NMOS_IRFZ44N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.56214, KP: 39.3974, LAMBDA: 0, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.2826e-7, CGSO: 1.25255e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

// ---------------------------------------------------------------------------
// Model parameter declarations — PMOS
// ---------------------------------------------------------------------------

export const { paramDefs: MOSFET_PMOS_PARAM_DEFS, defaults: MOSFET_PMOS_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: -1.0, unit: "V",      description: "Threshold voltage" },
    KP:     { default: 1e-5, unit: "A/V²",   description: "Process transconductance parameter" },
    LAMBDA: { default: 0,    unit: "1/V",    description: "Channel-length modulation" },
    W:      { default: 1e-6, unit: "m",      description: "Channel width" },
    L:      { default: 1e-6, unit: "m",      description: "Channel length" },
  },
  secondary: {
    PHI:    { default: 0.6,  unit: "V",      description: "Surface potential" },
    GAMMA:  { default: 0.0,  unit: "V^0.5",  description: "Body-effect coefficient" },
    CBD:    { default: 0,    unit: "F",      description: "Drain-bulk junction capacitance" },
    CBS:    { default: 0,    unit: "F",      description: "Source-bulk junction capacitance" },
    CGDO:   { default: 0,    unit: "F/m",    description: "Gate-drain overlap capacitance per unit width" },
    CGSO:   { default: 0,    unit: "F/m",    description: "Gate-source overlap capacitance per unit width" },
    CGBO:   { default: 0,    unit: "F/m",    description: "Gate-bulk overlap capacitance per unit length" },
    RD:     { default: 0,    unit: "Ω",      description: "Drain ohmic resistance" },
    RS:     { default: 0,    unit: "Ω",      description: "Source ohmic resistance" },
    IS:     { default: 1e-14, unit: "A",     description: "Bulk junction saturation current" },
    PB:     { default: 0.8,  unit: "V",      description: "Bulk junction potential" },
    CJ:     { default: 0,    unit: "F/m²",   description: "Zero-bias bulk junction bottom capacitance per unit area" },
    MJ:     { default: 0.5,                  description: "Bulk junction bottom grading coefficient" },
    CJSW:   { default: 0,    unit: "F/m",    description: "Zero-bias junction sidewall capacitance per unit length" },
    MJSW:   { default: 0.5,                  description: "Bulk junction sidewall grading coefficient" },
    JS:     { default: 0,    unit: "A/m²",   description: "Bulk junction saturation current density" },
    RSH:    { default: 0,    unit: "Ω/sq",   description: "Drain/source diffusion sheet resistance" },
    AD:     { default: 0,    unit: "m²",     description: "Drain area" },
    AS:     { default: 0,    unit: "m²",     description: "Source area" },
    PD:     { default: 0,    unit: "m",      description: "Drain perimeter" },
    PS:     { default: 0,    unit: "m",      description: "Source perimeter" },
    TNOM:   { default: REFTEMP, unit: "K",   description: "Nominal temperature" },
    TOX:    { default: 1e-7, unit: "m",      description: "Oxide thickness" },
    NSUB:   { default: 0,    unit: "cm⁻³",   description: "Substrate doping" },
    NSS:    { default: 0,    unit: "cm⁻²",   description: "Surface state density" },
    TPG:    { default: 1,                    description: "Gate type: 1=opposite, -1=same, 0=Al gate" },
    LD:     { default: 0,    unit: "m",      description: "Lateral diffusion" },
    UO:     { default: 250,  unit: "cm²/Vs", description: "Surface mobility (PMOS default 250)" },
    KF:     { default: 0,                    description: "Flicker noise coefficient" },
    AF:     { default: 1,                    description: "Flicker noise exponent" },
    FC:     { default: 0.5,                  description: "Forward-bias depletion capacitance coefficient" },
    M:      { default: 1,                    description: "Parallel device multiplier" },
    OFF:    { default: 0,                    description: "Initial condition: device off (0=false, 1=true)" },
    ICVDS:  { default: 0,    unit: "V",      description: "Initial condition for Vds (MODEUIC)" },
    ICVGS:  { default: 0,    unit: "V",      description: "Initial condition for Vgs (MODEUIC)" },
    ICVBS:  { default: 0,    unit: "V",      description: "Initial condition for Vbs (MODEUIC)" },
    TEMP:   { default: REFTEMP, unit: "K",   description: "Per-instance operating temperature" },
  },
});

// ---------------------------------------------------------------------------
// Built-in PMOS model presets
// Sources: Zetex/Diodes Inc., IR/Symmetry MODPEX
// ---------------------------------------------------------------------------

/** Small signal PMOS (TO-92, -45V/230mA). Source: Zetex BS250P v1.0. */
const PMOS_BS250 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.193, KP: 0.277, LAMBDA: 0.012, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 105e-12, CBS: 0, CGDO: 0, CGSO: 0,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** Medium power PMOS (TO-220, -100V/6.8A). Source: IR irf9520_IR. */
const PMOS_IRF9520 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.41185, KP: 3.46967, LAMBDA: 0.0289226, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 3.45033e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-247, -200V/12A). Source: IR irfp9240_IR. */
const PMOS_IRFP9240 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.67839, KP: 6.41634, LAMBDA: 0.0117285, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 1.08446e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-220, -100V/40A). Source: IR irf5210_IR. */
const PMOS_IRF5210 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.79917, KP: 12.9564, LAMBDA: 0.00220079, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 2.34655e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-220, -55V/74A). Source: IR irf4905_IR. */
const PMOS_IRF4905 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.53713, KP: 23.3701, LAMBDA: 0.00549383, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 2.84439e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

// ---------------------------------------------------------------------------
// resolveParams — derive process parameters when NSUB/TOX are specified
// ---------------------------------------------------------------------------

/**
 * Derive KP, GAMMA, PHI from NSUB/TOX when present. Same ngspice MOS1 Level 1
 * derivation:
 *   Cox  = εox / TOX
 *   KP   = UO * 1e-4 * Cox
 *   GAMMA = sqrt(2 * q * εsi * NSUB*1e6) / Cox
 *   PHI  = 2 * Vt * ln(NSUB / ni)
 */
function resolveParams(raw: MosfetParams, kpDefault: number): ResolvedMosfetParams {
  const p: ResolvedMosfetParams = {
    VTO:  raw.VTO, KP: raw.KP, LAMBDA: raw.LAMBDA,
    PHI: raw.PHI, GAMMA: raw.GAMMA, W: raw.W, L: raw.L,
    CBD:  raw.CBD  ?? 0, CBS: raw.CBS ?? 0,
    CGDO: raw.CGDO ?? 0, CGSO: raw.CGSO ?? 0, CGBO: raw.CGBO ?? 0,
    RD:   raw.RD   ?? 0, RS: raw.RS ?? 0,
    IS:   raw.IS   ?? 1e-14, PB: raw.PB ?? 0.8,
    CJ:   raw.CJ   ?? 0, MJ: raw.MJ ?? 0.5,
    CJSW: raw.CJSW ?? 0, MJSW: raw.MJSW ?? 0.5,
    JS:   raw.JS   ?? 0, RSH: raw.RSH ?? 0, FC: raw.FC ?? 0.5,
    AD:   raw.AD   ?? 0, AS: raw.AS ?? 0, PD: raw.PD ?? 0, PS: raw.PS ?? 0,
    TNOM: raw.TNOM ?? REFTEMP,
    TOX:  raw.TOX  ?? 1e-7, NSUB: raw.NSUB ?? 0, NSS: raw.NSS ?? 0,
    TPG:  raw.TPG  ?? 1, LD: raw.LD ?? 0, UO: raw.UO ?? 600,
    KF:   raw.KF   ?? 0, AF: raw.AF ?? 1,
    M:    raw.M    ?? 1, OFF: raw.OFF ?? 0,
    ICVDS: raw.ICVDS ?? 0, ICVGS: raw.ICVGS ?? 0, ICVBS: raw.ICVBS ?? 0,
    TEMP: raw.TEMP ?? REFTEMP,
  };

  if (p.NSUB > 0 && p.TOX > 0) {
    const cox = (EPS_OX * EPS0) / p.TOX;
    const epsSi = EPS_SI * EPS0;
    const nsubM3 = p.NSUB * 1e6;
    const vtRoom = REFTEMP * KoverQ;

    if (p.KP === kpDefault) {
      p.KP = (p.UO * 1e-4) * cox;
    }
    if (p.GAMMA === 0) {
      p.GAMMA = Math.sqrt(2 * Q * epsSi * nsubM3) / cox;
    }
    if (p.PHI === 0.6) {
      const phi = 2 * vtRoom * Math.log(p.NSUB / NI);
      if (phi > 0.1) p.PHI = phi;
    }
  }

  if (p.M !== 1) {
    p.CGDO *= p.M;
    p.CGSO *= p.M;
    p.CGBO *= p.M;
  }

  return p;
}

// ---------------------------------------------------------------------------
// computeTempParams — ngspice mos1temp.c:44-289 port
// ---------------------------------------------------------------------------

interface MosfetTempParams {
  vt: number;                  // mos1load.c:107: p.TEMP * KoverQ
  tTransconductance: number;  // mos1temp.c:165-166
  tPhi: number;               // mos1temp.c:168-169
  tVbi: number;               // mos1temp.c:170-174
  tVto: number;               // mos1temp.c:175
  tSatCur: number;            // mos1temp.c:177
  tSatCurDens: number;        // mos1temp.c:178
  tBulkPot: number;           // mos1temp.c:190
  tDepCap: number;            // mos1temp.c:200
  tCbd: number;
  tCbs: number;
  tCj: number;
  tCjsw: number;
  drainSatCur: number;        // mos1load.c:131-141
  sourceSatCur: number;       // mos1load.c:131-141
  drainVcrit: number;         // mos1temp.c:202-216
  sourceVcrit: number;
  // Junction cap f2/f3/f4 linearization coefficients (mos1temp.c:218-289)
  czbd: number; czbdsw: number; czbs: number; czbssw: number;
  f2d: number; f3d: number; f4d: number;
  f2s: number; f3s: number; f4s: number;
}

function computeTempParams(p: ResolvedMosfetParams, polarity: 1 | -1): MosfetTempParams {
  // --- Model-level (mos1temp.c:45-51) ---
  const fact1 = p.TNOM / REFTEMP;
  const vtnom = p.TNOM * KoverQ;
  const kt1 = CONSTboltz * p.TNOM;
  const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
  const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + Q * arg1);

  // --- Instance-level (mos1temp.c:135-200); circuit temp = p.TEMP ---
  const instanceTemp = p.TEMP;
  const vt = instanceTemp * KoverQ;
  const ratio = instanceTemp / p.TNOM;
  const fact2 = instanceTemp / REFTEMP;
  const kt = instanceTemp * CONSTboltz;
  const egfet = 1.16 - (7.02e-4 * instanceTemp * instanceTemp) / (instanceTemp + 1108);
  const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
  const pbfact = -2 * vt * (1.5 * Math.log(fact2) + Q * arg);

  // mos1temp.c:165-166
  const ratio4 = ratio * Math.sqrt(ratio);
  const tTransconductance = p.KP / ratio4;

  // mos1temp.c:168-169
  const phio = (p.PHI - pbfact1) / fact1;
  const tPhi = fact2 * phio + pbfact;

  // mos1temp.c:170-175
  const tVbi = p.VTO - polarity * (p.GAMMA * Math.sqrt(p.PHI))
    + 0.5 * (egfet1 - egfet)
    + polarity * 0.5 * (tPhi - p.PHI);
  const tVto = tVbi + polarity * p.GAMMA * Math.sqrt(tPhi);

  // mos1temp.c:177-178
  const tempFactor = Math.exp(-egfet / vt + egfet1 / vtnom);
  const tSatCur = p.IS * tempFactor;
  const tSatCurDens = p.JS * tempFactor;

  // mos1temp.c:181-200
  const pbo = (p.PB - pbfact1) / fact1;
  const gmaold = (p.PB - pbo) / pbo;
  let capfact = 1 / (1 + p.MJ * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
  let tCbd = p.CBD * capfact;
  let tCbs = p.CBS * capfact;
  let tCj = p.CJ * capfact;
  capfact = 1 / (1 + p.MJSW * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
  let tCjsw = p.CJSW * capfact;
  const tBulkPot = fact2 * pbo + pbfact;
  const gmanew = (tBulkPot - pbo) / pbo;
  capfact = 1 + p.MJ * (4e-4 * (instanceTemp - REFTEMP) - gmanew);
  tCbd *= capfact;
  tCbs *= capfact;
  tCj *= capfact;
  capfact = 1 + p.MJSW * (4e-4 * (instanceTemp - REFTEMP) - gmanew);
  tCjsw *= capfact;
  const tDepCap = p.FC * tBulkPot;

  // mos1load.c:131-141: drain/source saturation currents scaled by M
  const m = p.M;
  let drainSatCur: number;
  let sourceSatCur: number;
  if (tSatCurDens === 0 || p.AD === 0 || p.AS === 0) {
    drainSatCur = tSatCur * m;
    sourceSatCur = tSatCur * m;
  } else {
    drainSatCur = tSatCurDens * p.AD * m;
    sourceSatCur = tSatCurDens * p.AS * m;
  }

  // mos1temp.c:202-216: drain/source vcrit
  let drainVcrit: number, sourceVcrit: number;
  if (tSatCurDens === 0 || p.AD === 0 || p.AS === 0) {
    drainVcrit = sourceVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCur));
  } else {
    drainVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCurDens * p.AD));
    sourceVcrit = vt * Math.log(vt / (Math.SQRT2 * tSatCurDens * p.AS));
  }

  // --- Junction cap f2/f3/f4 coefficients (mos1temp.c:218-289) ---
  const mj = p.MJ;
  const mjsw = p.MJSW;
  const fc = p.FC;

  // Drain side (mos1temp.c:218-253)
  let czbd: number;
  if (p.CBD > 0) czbd = tCbd;
  else if (p.CJ > 0 && p.AD > 0) czbd = tCj * p.AD;
  else czbd = 0;
  const czbdsw = p.CJSW > 0 ? tCjsw * p.PD : 0;

  const argFC = 1 - fc;
  const sarg = Math.exp(-mj * Math.log(argFC));
  const sargsw = Math.exp(-mjsw * Math.log(argFC));

  const f2d = czbd * (1 - fc * (1 + mj)) * sarg / argFC
    + czbdsw * (1 - fc * (1 + mjsw)) * sargsw / argFC;
  const f3d = czbd * mj * sarg / argFC / tBulkPot
    + czbdsw * mjsw * sargsw / argFC / tBulkPot;
  const f4d = czbd * tBulkPot * (1 - argFC * sarg) / (1 - mj)
    + czbdsw * tBulkPot * (1 - argFC * sargsw) / (1 - mjsw)
    - f3d / 2 * (tDepCap * tDepCap)
    - tDepCap * f2d;

  // Source side (mos1temp.c:254-289)
  let czbs: number;
  if (p.CBS > 0) czbs = tCbs;
  else if (p.CJ > 0 && p.AS > 0) czbs = tCj * p.AS;
  else czbs = 0;
  const czbssw = p.CJSW > 0 ? tCjsw * p.PS : 0;

  const f2s = czbs * (1 - fc * (1 + mj)) * sarg / argFC
    + czbssw * (1 - fc * (1 + mjsw)) * sargsw / argFC;
  const f3s = czbs * mj * sarg / argFC / tBulkPot
    + czbssw * mjsw * sargsw / argFC / tBulkPot;
  const f4s = czbs * tBulkPot * (1 - argFC * sarg) / (1 - mj)
    + czbssw * tBulkPot * (1 - argFC * sargsw) / (1 - mjsw)
    - f3s / 2 * (tDepCap * tDepCap)
    - tDepCap * f2s;

  return {
    vt,
    tTransconductance, tPhi, tVbi, tVto,
    tSatCur, tSatCurDens,
    tBulkPot, tDepCap, tCbd, tCbs, tCj, tCjsw,
    drainSatCur, sourceSatCur, drainVcrit, sourceVcrit,
    czbd, czbdsw, czbs, czbssw,
    f2d, f3d, f4d, f2s, f3s, f4s,
  };
}

// ---------------------------------------------------------------------------
// computeIds / computeGm / computeGds / computeGmbs — standalone functions
// exported for unit tests that exercise the I-V model directly.
// DIVERGENCE - NOT "INTENTIONAL": THESE SIGN FLIPS ARE DEFINITELY NOT APPROVED
// BY THE AUTHOR.
// The `vsb` argument uses digiTS's `vs - vb` convention; these helpers invert
// it to ngspice's `vbs` for internal use per mos1load.c:500-509.
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET drain-source current, threshold, and vdsat.
 * Mirrors mos1load.c:483-546 saturation/triode block.
 *
 * Inputs: `vgs`, `vds`, and `vsb` (VSB legacy = vs - vb → vbs = -vsb inside).
 */
export function computeIds(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): { ids: number; vth: number; vdsat: number; von: number } {
  const rp = p as ResolvedMosfetParams;
  const tKP = rp._tKP ?? p.KP;
  const tPhi = rp._tPhi ?? p.PHI;
  const tVto = rp._tVto;
  const phi = Math.max(tPhi, 0.1);

  // mos1load.c:500-506: sarg = sqrt(tPhi - vbs) when vbs <= 0,
  //                     else sarg = sqrt(tPhi) - vbs/(2*sarg), clamped >= 0.
  // Legacy vsb = -vbs; vsb >= 0 means vbs <= 0 → normal reverse bias.
  let sarg: number;
  if (vsb >= 0) {
    sarg = Math.sqrt(phi + vsb);
  } else {
    sarg = Math.sqrt(phi);
    sarg = Math.max(0, sarg + vsb / (2 * sarg));
  }

  // mos1load.c:507: von = tVbi*type + gamma*sarg — threshold w/ body effect.
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const von = vth;

  const vgst = vgs - vth;
  const vdsat = Math.max(vgst, 0);

  if (vgst <= 0) return { ids: 0, vth, vdsat, von };

  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const lambda = p.LAMBDA;
  const betap = Beta * (1 + lambda * vds);

  // mos1load.c:527-545: saturation / linear region dispatch.
  if (vds < vgst) {
    const ids = betap * vds * (vgst - 0.5 * vds);
    return { ids, vth, vdsat, von };
  } else {
    const ids = betap * vgst * vgst * 0.5;
    return { ids, vth, vdsat, von };
  }
}

/** Compute MOSFET transconductance gm = dId/dVgs. */
export function computeGm(vgs: number, vds: number, vsb: number, p: MosfetParams): number {
  const rp = p as ResolvedMosfetParams;
  const tKP = rp._tKP ?? p.KP;
  const tPhi = rp._tPhi ?? p.PHI;
  const tVto = rp._tVto;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) sarg = Math.sqrt(phi + vsb);
  else { sarg = Math.sqrt(phi); sarg = Math.max(0, sarg + vsb / (2 * sarg)); }
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;
  if (vgst <= 0) return 0;
  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const betap = Beta * (1 + p.LAMBDA * vds);
  // mos1load.c:530, 539 (no +GMIN in standalone; load() adds gmin at stamp time)
  return (vds < vgst ? betap * vds : betap * vgst) + GMIN;
}

/** Compute MOSFET output conductance gds = dId/dVds. */
export function computeGds(vgs: number, vds: number, vsb: number, p: MosfetParams): number {
  const rp = p as ResolvedMosfetParams;
  const tKP = rp._tKP ?? p.KP;
  const tPhi = rp._tPhi ?? p.PHI;
  const tVto = rp._tVto;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) sarg = Math.sqrt(phi + vsb);
  else { sarg = Math.sqrt(phi); sarg = Math.max(0, sarg + vsb / (2 * sarg)); }
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;
  if (vgst <= 0) return 0;
  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const lambda = p.LAMBDA;
  if (vds < vgst) {
    // mos1load.c:540-543
    const betap = Beta * (1 + lambda * vds);
    return betap * (vgst - vds) + Beta * lambda * vds * (vgst - 0.5 * vds) + GMIN;
  } else {
    // mos1load.c:531
    return Beta * lambda * vgst * vgst * 0.5 + GMIN;
  }
}

/** Compute MOSFET bulk transconductance gmbs = dId/dVbs. */
export function computeGmbs(vgs: number, vds: number, vsb: number, p: MosfetParams): number {
  const rp = p as ResolvedMosfetParams;
  const tPhi = rp._tPhi ?? p.PHI;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) sarg = Math.sqrt(phi + vsb);
  else { sarg = Math.sqrt(phi); sarg = Math.max(0, sarg + vsb / (2 * sarg)); }
  const tVto = rp._tVto;
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;
  if (vgst <= 0 || p.GAMMA <= 0) return 0;
  const gm = computeGm(vgs, vds, vsb, p);
  // mos1load.c:511-514, 532, 544: arg = gamma/(sarg+sarg); gmbs = gm*arg.
  const arg = sarg > 0 ? p.GAMMA / (2 * sarg) : 0;
  return gm * arg;
}

/**
 * Apply SPICE3f5 fetlim+limvds limiting algorithm (mos1load.c:363-406).
 * Forward (vdsOld >= 0): fetlim vgs, derive vds, limvds, derive vgd.
 * Reverse (vdsOld < 0): fetlim vgd, derive vds, -limvds(-vds,-vdsOld), vgs.
 */
export function limitVoltages(
  vgsOld: number, vgsNew: number,
  vdsOld: number, vdsNew: number,
  von: number,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = vgsNew;
  let vds = vdsNew;
  const vgd = vgs - vds;
  const vgdOld = vgsOld - vdsOld;

  if (vdsOld >= 0) {
    vgs = fetlim(vgs, vgsOld, von);
    vds = vgs - vgd;
    vds = limvds(vds, vdsOld);
  } else {
    const vgdLim = fetlim(vgd, vgdOld, von);
    vds = vgs - vgdLim;
    vds = -limvds(-vds, -vdsOld);
    vgs = vgdLim + vds;
  }
  const swapped = vds < 0;
  return { vgs, vds, swapped };
}

/** Returns overlap + junction capacitance totals for tests (no state read). */
export function computeCapacitances(
  p: MosfetParams | ResolvedMosfetParams,
): { cgs: number; cgd: number; cgb: number; cbd: number; cbs: number } {
  const M = p.M ?? 1;
  return {
    cgs: (p.CGSO ?? 0) * p.W * M,
    cgd: (p.CGDO ?? 0) * p.W * M,
    cgb: (p.CGBO ?? 0) * (p.L - 2 * (p.LD ?? 0)) * M,
    cbd: p.CBD ?? 0,
    cbs: p.CBS ?? 0,
  };
}

// ---------------------------------------------------------------------------
// devQmeyer — Meyer gate capacitance model (devsup.c:625-689 port)
// ---------------------------------------------------------------------------

/**
 * Evaluate Meyer gate capacitances. Returns 1/2 of the non-constant portion.
 * Caller must double (MODETRANOP / MODEINITSMSIG) or add previous-step half
 * (normal MODETRAN integration, mos1load.c:789-806).
 */
function devQmeyer(
  vgs: number, vgd: number, _vgb: number,
  von: number, vdsat: number,
  phi: number, cox: number,
): { capgs: number; capgd: number; capgb: number } {
  const MAGIC_VDS = 0.025;
  const vgst = vgs - von;
  vdsat = Math.max(vdsat, MAGIC_VDS);

  let capgs: number, capgd: number, capgb: number;

  if (vgst <= -phi) {
    capgb = cox / 2; capgs = 0; capgd = 0;
  } else if (vgst <= -phi / 2) {
    capgb = -vgst * cox / (2 * phi); capgs = 0; capgd = 0;
  } else if (vgst <= 0) {
    capgb = -vgst * cox / (2 * phi);
    capgs = vgst * cox / (1.5 * phi) + cox / 3;
    const vds = vgs - vgd;
    if (vds >= vdsat) {
      capgd = 0;
    } else {
      const vddif = 2.0 * vdsat - vds;
      const vddif1 = vdsat - vds;
      const vddif2 = vddif * vddif;
      capgd = capgs * (1.0 - vdsat * vdsat / vddif2);
      capgs = capgs * (1.0 - vddif1 * vddif1 / vddif2);
    }
  } else {
    const vds = vgs - vgd;
    vdsat = Math.max(vdsat, MAGIC_VDS);
    if (vdsat <= vds) {
      capgs = cox / 3; capgd = 0; capgb = 0;
    } else {
      const vddif = 2.0 * vdsat - vds;
      const vddif1 = vdsat - vds;
      const vddif2 = vddif * vddif;
      capgd = cox * (1.0 - vdsat * vdsat / vddif2) / 3;
      capgs = cox * (1.0 - vddif1 * vddif1 / vddif2) / 3;
      capgb = 0;
    }
  }

  return { capgs, capgd, capgb };
}

// ---------------------------------------------------------------------------
// State schema — MOSFET SPICE L1 (Phase 2.5 W1.3 A1 post-excision).
//
// Only slots with direct correspondence in `mos1defs.h:269-291` MOS1state<n>
// offsets, plus a small set of DC-op-only scalar slots required by our
// factory (cd / gm / gds / gmbs / mode / von / vbs_old / vbd_old / gbd / gbs /
// cbd / cbs). The 11 invented cap+Q cross-method slots (per C-AUD-6) are
// deleted — the cap companion geq/ieq values lump inline into gbd/gbs and
// the gate-stamp matrix/RHS entries per `mos1load.c:900-end`.
//
// Deleted invented slots (the 11 cited in C-AUD-6):
//   1. CAP_GEQ_GS   (fet-base.ts SLOT 6)  — lumped inline per mos1load.c:930,942
//   2. CAP_IEQ_GS   (fet-base.ts SLOT 7)  — lumped inline into ceqgs
//   3. CAP_GEQ_GD   (fet-base.ts SLOT 8)  — lumped inline per mos1load.c:941
//   4. CAP_IEQ_GD   (fet-base.ts SLOT 9)  — lumped inline into ceqgd
//   5. CAP_GEQ_GB   (fet-base.ts SLOT 18) — lumped inline per mos1load.c:930,940
//   6. CAP_IEQ_GB   (fet-base.ts SLOT 19) — lumped inline into ceqgb
//   7. CAP_GEQ_DB   (fet-base.ts SLOT 12) — lumped into gbd per mos1load.c:717
//   8. CAP_IEQ_DB   (fet-base.ts SLOT 13) — lumped into cbd per mos1load.c:718-719
//   9. CAP_GEQ_SB   (fet-base.ts SLOT 14) — lumped into gbs per mos1load.c:723
//  10. CAP_IEQ_SB   (fet-base.ts SLOT 15) — lumped into cbs per mos1load.c:724
//  11. MEYER_GB     (fet-base.ts SLOT 37) — ngspice uses CKTstate0/1 capgb
//                   averaging (mos1load.c:800-806), not a separate half-cap stash
//
// Surviving slots have direct mos1defs.h correspondence:
//
//   VBD (0) = mos1defs.h MOS1vbd
//   VBS (1) = mos1defs.h MOS1vbs
//   VGS (2) = mos1defs.h MOS1vgs
//   VDS (3) = mos1defs.h MOS1vds
//   CAPGS (4) = mos1defs.h MOS1capgs
//   QGS (5) = mos1defs.h MOS1qgs
//   CQGS (6) = mos1defs.h MOS1cqgs
//   CAPGD (7) = mos1defs.h MOS1capgd
//   QGD (8) = mos1defs.h MOS1qgd
//   CQGD (9) = mos1defs.h MOS1cqgd
//   CAPGB (10) = mos1defs.h MOS1capgb
//   QGB (11) = mos1defs.h MOS1qgb
//   CQGB (12) = mos1defs.h MOS1cqgb
//   QBD (13) = mos1defs.h MOS1qbd
//   CQBD (14) = mos1defs.h MOS1cqbd
//   QBS (15) = mos1defs.h MOS1qbs
//   CQBS (16) = mos1defs.h MOS1cqbs
//
// DC operating-point scalars (non-cross-method, mirror MOS1instance fields):
//   CD (17)    = MOS1instance MOS1cd      (channel + drain jct current)
//   CBD (18)   = MOS1instance MOS1cbd
//   CBS (19)   = MOS1instance MOS1cbs
//   GBD (20)   = MOS1instance MOS1gbd
//   GBS (21)   = MOS1instance MOS1gbs
//   GM  (22)   = MOS1instance MOS1gm
//   GDS (23)   = MOS1instance MOS1gds
//   GMBS (24)  = MOS1instance MOS1gmbs
//   MODE (25)  = MOS1instance MOS1mode (+1 normal, -1 reverse)
//   VON (26)   = MOS1instance MOS1von
//   VDSAT (27) = MOS1instance MOS1vdsat
// ---------------------------------------------------------------------------

export const MOSFET_SCHEMA: StateSchema = defineStateSchema("MosfetElement", [
  { name: "VBD",   doc: "mos1defs.h MOS1vbd=0",   init: { kind: "zero" } },
  { name: "VBS",   doc: "mos1defs.h MOS1vbs=1",   init: { kind: "zero" } },
  { name: "VGS",   doc: "mos1defs.h MOS1vgs=2",   init: { kind: "zero" } },
  { name: "VDS",   doc: "mos1defs.h MOS1vds=3",   init: { kind: "zero" } },
  { name: "CAPGS", doc: "mos1defs.h MOS1capgs=4", init: { kind: "zero" } },
  { name: "QGS",   doc: "mos1defs.h MOS1qgs=5",   init: { kind: "zero" } },
  { name: "CQGS",  doc: "mos1defs.h MOS1cqgs=6",  init: { kind: "zero" } },
  { name: "CAPGD", doc: "mos1defs.h MOS1capgd=7", init: { kind: "zero" } },
  { name: "QGD",   doc: "mos1defs.h MOS1qgd=8",   init: { kind: "zero" } },
  { name: "CQGD",  doc: "mos1defs.h MOS1cqgd=9",  init: { kind: "zero" } },
  { name: "CAPGB", doc: "mos1defs.h MOS1capgb=10",init: { kind: "zero" } },
  { name: "QGB",   doc: "mos1defs.h MOS1qgb=11",  init: { kind: "zero" } },
  { name: "CQGB",  doc: "mos1defs.h MOS1cqgb=12", init: { kind: "zero" } },
  { name: "QBD",   doc: "mos1defs.h MOS1qbd=13",  init: { kind: "zero" } },
  { name: "CQBD",  doc: "mos1defs.h MOS1cqbd=14", init: { kind: "zero" } },
  { name: "QBS",   doc: "mos1defs.h MOS1qbs=15",  init: { kind: "zero" } },
  { name: "CQBS",  doc: "mos1defs.h MOS1cqbs=16", init: { kind: "zero" } },
  { name: "CD",    doc: "MOS1instance MOS1cd",    init: { kind: "zero" } },
  { name: "CBD",   doc: "MOS1instance MOS1cbd",   init: { kind: "zero" } },
  { name: "CBS",   doc: "MOS1instance MOS1cbs",   init: { kind: "zero" } },
  { name: "GBD",   doc: "MOS1instance MOS1gbd",   init: { kind: "zero" } },
  { name: "GBS",   doc: "MOS1instance MOS1gbs",   init: { kind: "zero" } },
  { name: "GM",    doc: "MOS1instance MOS1gm",    init: { kind: "zero" } },
  { name: "GDS",   doc: "MOS1instance MOS1gds",   init: { kind: "zero" } },
  { name: "GMBS",  doc: "MOS1instance MOS1gmbs",  init: { kind: "zero" } },
  { name: "MODE",  doc: "MOS1instance MOS1mode (+1 / -1)", init: { kind: "constant", value: 1 } },
  { name: "VON",   doc: "MOS1instance MOS1von",   init: { kind: "zero" } },
  { name: "VDSAT", doc: "MOS1instance MOS1vdsat", init: { kind: "zero" } },
]);

// Slot index constants (match MOSFET_SCHEMA order).
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
const SLOT_CD = 17;
const SLOT_CBD = 18;
const SLOT_CBS = 19;
const SLOT_GBD = 20;
const SLOT_GBS = 21;
const SLOT_GM = 22;
const SLOT_GDS = 23;
const SLOT_GMBS = 24;
const SLOT_MODE = 25;
const SLOT_VON = 26;
const SLOT_VDSAT = 27;

// ---------------------------------------------------------------------------
// createMosfetElement — AnalogElement factory (closure-based, BJT pattern)
// Single load() ported from mos1load.c line-by-line.
// No cached Float64Array state refs — pool.states[N] at call time.
// ---------------------------------------------------------------------------

export function createMosfetElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  kpDefault: number = 2e-5,
) {
  const nodeG = pinNodes.get("G")!;
  const nodeS_ext = pinNodes.get("S")!;
  const nodeD_ext = pinNodes.get("D")!;

  // 3-terminal MOSFET: bulk = source (no separate bulk pin).
  const nodeB = nodeS_ext;

  const rawRD = props.getModelParam<number>("RD");
  const rawRS = props.getModelParam<number>("RS");

  let intIdx = 0;
  const nodeD = rawRD > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeD_ext;
  const nodeS = rawRS > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeS_ext;

  const rawParams: MosfetParams = {
    VTO: props.getModelParam<number>("VTO"),
    KP: props.getModelParam<number>("KP"),
    LAMBDA: props.getModelParam<number>("LAMBDA"),
    PHI: props.getModelParam<number>("PHI"),
    GAMMA: props.getModelParam<number>("GAMMA"),
    CBD: props.getModelParam<number>("CBD"),
    CBS: props.getModelParam<number>("CBS"),
    CGDO: props.getModelParam<number>("CGDO"),
    CGSO: props.getModelParam<number>("CGSO"),
    CGBO: props.getModelParam<number>("CGBO"),
    W: props.getModelParam<number>("W"),
    L: props.getModelParam<number>("L"),
    RD: rawRD, RS: rawRS,
    IS: props.getModelParam<number>("IS"),
    PB: props.getModelParam<number>("PB"),
    CJ: props.getModelParam<number>("CJ"),
    MJ: props.getModelParam<number>("MJ"),
    CJSW: props.getModelParam<number>("CJSW"),
    MJSW: props.getModelParam<number>("MJSW"),
    JS: props.getModelParam<number>("JS"),
    RSH: props.getModelParam<number>("RSH"),
    AD: props.getModelParam<number>("AD"),
    AS: props.getModelParam<number>("AS"),
    PD: props.getModelParam<number>("PD"),
    PS: props.getModelParam<number>("PS"),
    TNOM: props.getModelParam<number>("TNOM"),
    TOX: props.getModelParam<number>("TOX"),
    NSUB: props.getModelParam<number>("NSUB"),
    NSS: props.getModelParam<number>("NSS"),
    TPG: props.getModelParam<number>("TPG"),
    LD: props.getModelParam<number>("LD"),
    UO: props.getModelParam<number>("UO"),
    KF: props.getModelParam<number>("KF"),
    AF: props.getModelParam<number>("AF"),
    FC: props.getModelParam<number>("FC"),
    M: props.getModelParam<number>("M"),
    OFF: props.getModelParam<number>("OFF"),
    ICVDS: props.getModelParam<number>("ICVDS"),
    ICVGS: props.getModelParam<number>("ICVGS"),
    ICVBS: props.getModelParam<number>("ICVBS"),
    TEMP: props.getModelParam<number>("TEMP"),
  };

  const params = resolveParams(rawParams, kpDefault);
  // DIVERGENCE - NOT "INTENTIONAL": THESE SIGN FLIPS ARE DEFINITELY NOT APPROVED
  // BY THE AUTHOR.
  // For PMOS, VTO is stored as magnitude and type sign is applied via polarity
  // at use sites. ngspice mos1temp.c stores signed VTO directly.
  if (polarity === -1) {
    params.VTO = Math.abs(params.VTO);
  }

  let tp = computeTempParams(params, polarity);
  // Thread temp-corrected values into params for standalone helper functions.
  params._tKP = tp.tTransconductance;
  params._tPhi = tp.tPhi;
  params._tVto = tp.tVto;

  // Derived reactive detection (mirrors ngspice's cap-companion gate bitmask).
  const ld = params.LD;
  const effectiveLength = params.L - 2 * ld;
  const oxideCapProbe = params.TOX > 0 ? (EPS_OX * EPS0 / params.TOX) * effectiveLength * params.W : 0;
  const hasCapacitance = params.CBD > 0 || params.CBS > 0
    || params.CJ > 0 || params.CJSW > 0
    || params.CGDO > 0 || params.CGSO > 0 || params.CGBO > 0
    || oxideCapProbe > 0;

  let pool: StatePoolRef;
  let base: number;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: hasCapacitance,
    poolBacked: true as const,
    stateSchema: MOSFET_SCHEMA,
    stateSize: MOSFET_SCHEMA.size,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(MOSFET_SCHEMA, pool, base, {});
    },

    /**
     * Single-pass load mirroring `mos1load.c::MOS1load` line-by-line.
     *
     * G1 — Uses ngspice's VBS / VBD convention verbatim. `vbs = vb - vs` and
     * `vbd = vb - vd` (mos1load.c:231-247). Legacy digiTS VSB = -VBS; every
     * sign site here uses ngspice's convention.
     *
     * Cap companion lumping (mos1load.c:900-end): geq contributions fold into
     * gbd/gbs/gm-matrix stamps; ieq contributions fold into ceqbd/ceqbs/
     * ceqgs/ceqgd/ceqgb RHS terms. No cross-method cap+Q slots.
     */
    load(ctx: LoadContext): void {
      // mos1load.c:108: Check=0 — false initially; set true only if pnjlim fires.
      let icheckLimited = false;

      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const mode = ctx.cktMode;
      const voltages = ctx.rhsOld;
      const solver = ctx.solver;

      // mos1load.c:107: vt = CONSTKoverQ * MOS1temp — per-instance thermal voltage.
      const vt = tp.vt;

      // mos1load.c:130-147: precomputed operation-point constants.
      const m = params.M;
      const lde = params.L - 2 * params.LD;
      const drainSatCur = tp.drainSatCur;
      const sourceSatCur = tp.sourceSatCur;
      const GateSourceOverlapCap = params.CGSO * m * params.W;
      const GateDrainOverlapCap = params.CGDO * m * params.W;
      const GateBulkOverlapCap = params.CGBO * m * lde;
      const Beta = tp.tTransconductance * m * params.W / lde;
      const OxideCap = params.TOX > 0 ? (EPS_OX * EPS0 / params.TOX) * lde * m * params.W : 0;

      // mos1load.c:200-204: MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN
      // or (MODEINITFIX && !OFF) → fall through to the "simple" dispatch block.
      //
      // Else (mos1load.c:412-434) → MODEINITJCT / MODEINITFIX+OFF / default-zero.
      let vbs: number, vgs: number, vds: number, vbd: number, vgd: number;

      // mos1load.c:201-203: gate bits for "simple/general iteration" dispatch.
      const simpleGate = (mode & (MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN)) !== 0
        || ((mode & MODEINITFIX) !== 0 && params.OFF === 0);

      // cite: mos1load.c:202-204, 226-240, 565, 789, 862
      // MODEINITFLOAT | MODEINITPRED | MODEINITSMSIG | MODEINITTRAN |
      // (MODEINITFIX && !OFF) all take the simple/general block. SMSIG takes the
      // general-iteration path (rhsOld), not a special seed-from-state0 branch —
      // ngspice mos1load.c:202-204 gates SMSIG into the simple block; line 226
      // else reads vbs/vgs/vds from CKTrhsOld, same as MODEINITFLOAT. No early
      // return and no special seed for SMSIG.
      if (simpleGate) {
        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          // mos1load.c:205-225: predictor step (#ifndef PREDICTOR).
          // cite: mos1load.c:211-225
          const deltaOldRatio = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
          const xfact = deltaOldRatio;
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
          // mos1load.c:226-240: general iteration path (MODEINITFLOAT, MODEINITSMSIG,
          // MODEINITFIX+!OFF). vbs/vgs/vds from CKTrhsOld with polarity sign flip.
          const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
          const vS_volt = nodeS > 0 ? voltages[nodeS - 1] : 0;
          const vG_volt = nodeG > 0 ? voltages[nodeG - 1] : 0;
          const vD_volt = nodeD > 0 ? voltages[nodeD - 1] : 0;
          // mos1load.c:231-239 — G1: ngspice computes vbs = B - S, vgs = G - S,
          // vds = D - S; polarity scales the result (MOS1type factor).
          vbs = polarity * (vB - vS_volt);
          vgs = polarity * (vG_volt - vS_volt);
          vds = polarity * (vD_volt - vS_volt);
        }

        // mos1load.c:246-254: now some common crunching.
        vbd = vbs - vds;
        vgd = vgs - vds;

        // mos1load.c:356-406 — voltage limiting (NODELIMITING is undef).
        // cite: mos1load.c:370, 376, 382, 387, 395, 401
        // Limiting runs unconditionally inside simpleGate — predictor voltages
        // also pass through fetlim/limvds/pnjlim per mos1load.c:356-406.
        {
          // mos1load.c:356: von = MOS1type * here->MOS1von.
          const vonStored = s0[base + SLOT_VON];
          const vonForLim = vonStored !== 0 ? vonStored : tp.tVto;

          const vgsOldStored = s0[base + SLOT_VGS];
          const vdsOldStored = s0[base + SLOT_VDS];

          if (vdsOldStored >= 0) {
            // mos1load.c:368-378: forward — fetlim vgs, derive vds, limvds.
            const vgsBefore = vgs;
            vgs = fetlim(vgs, vgsOldStored, vonForLim);
            vds = vgs - vgd;
            const vdsBefore = vds;
            vds = limvds(vds, vdsOldStored);
            vgd = vgs - vds;

            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "GS", limitType: "fetlim",
                vBefore: vgsBefore, vAfter: vgs,
                wasLimited: vgs !== vgsBefore,
              });
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "DS", limitType: "limvds",
                vBefore: vdsBefore, vAfter: vds,
                wasLimited: vds !== vdsBefore,
              });
            }
          } else {
            // mos1load.c:380-392: reverse — fetlim vgd, derive vds, neg limvds.
            const vgdOldStored = vgsOldStored - vdsOldStored;
            const vgdBefore = vgd;
            vgd = fetlim(vgd, vgdOldStored, vonForLim);
            vds = vgs - vgd;
            const vdsBefore = vds;
            // mos1load.c:385: if(!(ckt->CKTfixLimit)) { vds = -DEVlimvds(-vds,...) }
            if (!ctx.cktFixLimit) {
              vds = -limvds(-vds, -vdsOldStored);
            }
            vgs = vgd + vds;

            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "GS", limitType: "fetlim",
                vBefore: vgdBefore, vAfter: vgd,
                wasLimited: vgd !== vgdBefore,
              });
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "DS", limitType: "limvds",
                vBefore: vdsBefore, vAfter: vds,
                wasLimited: vds !== vdsBefore,
              });
            }
          }

          // mos1load.c:393-406: pnjlim on bulk junctions — vds sign-based dispatch.
          // Only pnjlim mutates icheckLimited (devsup.c:50-58); fetlim/limvds do not.
          if (vds >= 0) {
            // G1: pnjlim on vbs (bulk-source), vbd derives from vbs - vds.
            const vbsBefore = vbs;
            const vbsOldStored = s0[base + SLOT_VBS];
            const vbsResult = pnjlim(vbs, vbsOldStored, vt, tp.sourceVcrit);
            vbs = vbsResult.value;
            vbd = vbs - vds;

            icheckLimited = icheckLimited || vbsResult.limited;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "BS", limitType: "pnjlim",
                vBefore: vbsBefore, vAfter: vbs,
                wasLimited: vbsResult.limited,
              });
            }
          } else {
            // G1: pnjlim on vbd (bulk-drain), vbs derives from vbd + vds.
            const vbdBefore = vbd;
            const vbdOldStored = s0[base + SLOT_VBD];
            const vbdResult = pnjlim(vbd, vbdOldStored, vt, tp.drainVcrit);
            vbd = vbdResult.value;
            vbs = vbd + vds;

            icheckLimited = icheckLimited || vbdResult.limited;
            if (ctx.limitingCollector) {
              ctx.limitingCollector.push({
                elementIndex: (this as any).elementIndex ?? -1,
                label: (this as any).label ?? "",
                junction: "BD", limitType: "pnjlim",
                vBefore: vbdBefore, vAfter: vbd,
                wasLimited: vbdResult.limited,
              });
            }
          }
        }
      } else {
        // mos1load.c:412-434: not one of the simple cases — MODEINITJCT /
        // MODEINITFIX+OFF / default-zero dispatch.
        if ((mode & MODEINITJCT) && params.OFF === 0) {
          // cite: mos1load.c:419-430
          // MODEINITJCT path — read ICVDS/ICVGS/ICVBS; if all zero AND
          // (MODETRAN|MODEDCOP|MODEDCTRANCURVE || !MODEUIC), fall back to
          // (vbs=-1, vgs=polarity*tVto, vds=0).
          vds = polarity * params.ICVDS;
          vgs = polarity * params.ICVGS;
          vbs = polarity * params.ICVBS;
          const allZero = vds === 0 && vgs === 0 && vbs === 0;
          const fallback = allZero && (
            (mode & (MODETRAN | MODEDCOP | MODEDCTRANCURVE)) !== 0
            || (mode & MODEUIC) === 0
          );
          if (fallback) {
            vbs = -1;
            vgs = polarity * tp.tVto;
            vds = 0;
          }
        } else {
          // mos1load.c:431-433 — default-zero path: (MODEINITFIX && OFF) OR the
          // "not one of the simple cases" fallthrough. simpleGate at line 1036
          // excludes (MODEINITFIX && OFF) from the simple/general block, so control
          // lands here. Matches mos1load.c:204 which gates on `!MOS1off` for INITFIX.
          vbs = 0; vgs = 0; vds = 0;
        }
        vbd = vbs - vds;
        vgd = vgs - vds;
        icheckLimited = false;
      }

      // mos1load.c:443-445: recompute common quantities post-limiting.
      vbd = vbs - vds;
      vgd = vgs - vds;
      // vgb unused except in Meyer cap block; compute at that site.

      // Hoisted cap totals (written by bypass branch or Meyer block below).
      let capgs = 0, capgd = 0, capgb = 0;

      // cite: mos1load.c:258-348 — NOBYPASS bypass gate.
      // cdhat/cbhat predict drain and bulk currents from previous-iteration
      // conductances. delvXX computes against s0[SLOT_V*] which still holds
      // the prior-iteration stored values (state0 overwrite is at line ~1395).
      let bypassed = false;
      {
        const prevCd   = s0[base + SLOT_CD];
        const prevCbs  = s0[base + SLOT_CBS];
        const prevCbd  = s0[base + SLOT_CBD];
        const prevGm   = s0[base + SLOT_GM];
        const prevGds  = s0[base + SLOT_GDS];
        const prevGmbs = s0[base + SLOT_GMBS];
        const prevGbd  = s0[base + SLOT_GBD];
        const prevGbs  = s0[base + SLOT_GBS];
        const prevMode = s0[base + SLOT_MODE];
        const prevVbs  = s0[base + SLOT_VBS];
        const prevVbd  = s0[base + SLOT_VBD];
        const prevVgs  = s0[base + SLOT_VGS];
        const prevVds  = s0[base + SLOT_VDS];

        const delvbs = vbs - prevVbs;
        const delvbd = vbd - prevVbd;
        const delvgs = vgs - prevVgs;
        const delvds = vds - prevVds;

        let cdhat: number;
        if (prevMode >= 0) {
          const delvgd = delvgs - delvds;
          cdhat = prevCd + prevGm * delvgs + prevGds * delvds + prevGmbs * delvbs - prevGbd * delvbd;
        } else {
          const delvgd = delvgs - delvds;
          cdhat = prevCd - (prevGbd - prevGmbs) * delvbd - prevGm * delvgd + prevGds * delvds;
        }
        const cbhat = prevCbs + prevCbd + prevGbd * delvbd + prevGbs * delvbs;

        if (
          !(mode & (MODEINITPRED | MODEINITTRAN | MODEINITSMSIG))
          && ctx.bypass
          && (Math.abs(cbhat - (prevCbs + prevCbd)) < ctx.reltol * (Math.max(Math.abs(cbhat), Math.abs(prevCbs + prevCbd)) + ctx.iabstol))
          && Math.abs(delvbs) < ctx.reltol * Math.max(Math.abs(vbs), Math.abs(prevVbs)) + ctx.voltTol
          && Math.abs(delvbd) < ctx.reltol * Math.max(Math.abs(vbd), Math.abs(prevVbd)) + ctx.voltTol
          && Math.abs(delvgs) < ctx.reltol * Math.max(Math.abs(vgs), Math.abs(prevVgs)) + ctx.voltTol
          && Math.abs(delvds) < ctx.reltol * Math.max(Math.abs(vds), Math.abs(prevVds)) + ctx.voltTol
          && Math.abs(cdhat - prevCd) < ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(prevCd)) + ctx.iabstol
        ) {
          // cite: mos1load.c:322-347 — bypass: reload voltages from state0,
          // rebuild cap totals from cached half-caps (MODETRAN/MODETRANOP only).
          vbs = prevVbs; vbd = prevVbd; vgs = prevVgs; vds = prevVds;
          vgd = vgs - vds;

          if (mode & (MODETRAN | MODETRANOP)) {
            capgs = s0[base + SLOT_CAPGS] + s1[base + SLOT_CAPGS] + GateSourceOverlapCap;
            capgd = s0[base + SLOT_CAPGD] + s1[base + SLOT_CAPGD] + GateDrainOverlapCap;
            capgb = s0[base + SLOT_CAPGB] + s1[base + SLOT_CAPGB] + GateBulkOverlapCap;
          }
          bypassed = true;
        }
      }

      // mos1load.c:472-478: device mode (normal/inverse) from vds sign.
      const opMode = vds >= 0 ? 1 : -1;

      // cap gate: gated by mode bits; hoisted here so bypass branch can skip cap blocks.
      let capGate = false;

      // Conductances and currents — filled by OP eval below, or reloaded from
      // state0 on bypass per mos1load.c:322-340.
      let gmNR: number, gdsNR: number, gmbsNR: number;
      let gbs: number, cbs: number;
      let gbd: number, cbd: number;
      let cd: number;

      let cdrain: number;
      let ceqgs = 0, ceqgd = 0, ceqgb = 0;
      let gcgs = 0, gcgd = 0, gcgb = 0;

      if (bypassed) {
        // cite: mos1load.c:322-340 — bypass path: reload conductances from state0.
        gmNR  = s0[base + SLOT_GM];
        gdsNR = s0[base + SLOT_GDS];
        gmbsNR= s0[base + SLOT_GMBS];
        gbd   = s0[base + SLOT_GBD];
        gbs   = s0[base + SLOT_GBS];
        cbd   = s0[base + SLOT_CBD];
        cbs   = s0[base + SLOT_CBS];
        cd    = s0[base + SLOT_CD];
        // Reconstruct cdrain from cd: cd = opMode * cdrain - cbd → cdrain = opMode * (cd + cbd)
        cdrain = opMode * (cd + cbd);
      } else {
        // mos1load.c:453-468: bulk-source and bulk-drain junction currents.
        if (vbs <= -3 * vt) {
          gbs = GMIN;
          cbs = gbs * vbs - sourceSatCur;
        } else {
          const evbs = Math.exp(Math.min(MAX_EXP_ARG, vbs / vt));
          gbs = sourceSatCur * evbs / vt + GMIN;
          cbs = sourceSatCur * (evbs - 1) + GMIN * vbs;
        }
        if (vbd <= -3 * vt) {
          gbd = GMIN;
          cbd = gbd * vbd - drainSatCur;
        } else {
          const evbd = Math.exp(Math.min(MAX_EXP_ARG, vbd / vt));
          gbd = drainSatCur * evbd / vt + GMIN;
          cbd = drainSatCur * (evbd - 1) + GMIN * vbd;
        }

        // mos1load.c:483-546: Shichman-Hodges drain current evaluation.
        const tPhi = tp.tPhi;
        let sarg: number;
        const vbEffective = opMode === 1 ? vbs : vbd;
        if (vbEffective <= 0) {
          sarg = Math.sqrt(tPhi - vbEffective);
        } else {
          sarg = Math.sqrt(tPhi);
          sarg = sarg - vbEffective / (sarg + sarg);
          sarg = Math.max(0, sarg);
        }
        // mos1load.c:507: von = tVbi * MOS1type + gamma * sarg.
        // tVbi is stored polarity-unsigned in mos1temp.c (vtbi = VTO - polarity * gamma*sqrt(PHI) + ...),
        // so multiplying by polarity here applies the type sign at the evaluation site.
        // For NMOS (polarity=+1): von > 0, threshold above source. For PMOS (polarity=-1): von < 0.
        // Downstream `vgst = (mode==1 ? vgs : vgd) - von` then carries the correct sign.
        const von = tp.tVbi * polarity + params.GAMMA * sarg;
        const vgst = (opMode === 1 ? vgs : vgd) - von;
        const vdsat = Math.max(vgst, 0);
        const argBE = sarg <= 0 ? 0 : params.GAMMA / (sarg + sarg);

        if (vgst <= 0) {
          // cutoff region (mos1load.c:515-522)
          cdrain = 0; gmNR = 0; gdsNR = 0; gmbsNR = 0;
        } else {
          const betap = Beta * (1 + params.LAMBDA * (vds * opMode));
          if (vgst <= vds * opMode) {
            // saturation (mos1load.c:527-532)
            cdrain = betap * vgst * vgst * 0.5;
            gmNR = betap * vgst;
            gdsNR = params.LAMBDA * Beta * vgst * vgst * 0.5;
            gmbsNR = gmNR * argBE;
          } else {
            // linear/triode (mos1load.c:533-545)
            const vdsMode = vds * opMode;
            cdrain = betap * vdsMode * (vgst - 0.5 * vdsMode);
            gmNR = betap * vdsMode;
            gdsNR = betap * (vgst - vdsMode)
              + params.LAMBDA * Beta * vdsMode * (vgst - 0.5 * vdsMode);
            gmbsNR = gmNR * argBE;
          }
        }

        // mos1load.c:557-563: von, vdsat, cd write-back with polarity.
        s0[base + SLOT_VON] = polarity * von;
        s0[base + SLOT_VDSAT] = polarity * vdsat;
        cd = opMode * cdrain - cbd;
        s0[base + SLOT_CD] = cd;

        // mos1load.c:565-725: cap + charge block.
        // Gate on (MODETRAN|MODETRANOP|MODEINITSMSIG).
        capGate = (mode & (MODETRAN | MODETRANOP | MODEINITSMSIG)) !== 0;

        let capbd = 0, capbs = 0;
        if (capGate) {
        // mos1load.c:586-638: bulk-source depletion cap + charge.
        if (tp.czbs > 0 || tp.czbssw > 0) {
          if (vbs < tp.tDepCap) {
            const argS = 1 - vbs / tp.tBulkPot;
            const sargS = Math.exp(-params.MJ * Math.log(argS));
            const sargswS = Math.exp(-params.MJSW * Math.log(argS));
            s0[base + SLOT_QBS] = tp.tBulkPot * (
              tp.czbs * (1 - argS * sargS) / (1 - params.MJ)
              + tp.czbssw * (1 - argS * sargswS) / (1 - params.MJSW));
            capbs = tp.czbs * sargS + tp.czbssw * sargswS;
          } else {
            s0[base + SLOT_QBS] = tp.f4s + vbs * (tp.f2s + vbs * (tp.f3s / 2));
            capbs = tp.f2s + tp.f3s * vbs;
          }
        } else {
          s0[base + SLOT_QBS] = 0;
          capbs = 0;
        }

        // mos1load.c:641-694: bulk-drain depletion cap + charge.
        if (tp.czbd > 0 || tp.czbdsw > 0) {
          if (vbd < tp.tDepCap) {
            const argD = 1 - vbd / tp.tBulkPot;
            const sargD = Math.exp(-params.MJ * Math.log(argD));
            const sargswD = Math.exp(-params.MJSW * Math.log(argD));
            s0[base + SLOT_QBD] = tp.tBulkPot * (
              tp.czbd * (1 - argD * sargD) / (1 - params.MJ)
              + tp.czbdsw * (1 - argD * sargswD) / (1 - params.MJSW));
            capbd = tp.czbd * sargD + tp.czbdsw * sargswD;
          } else {
            s0[base + SLOT_QBD] = tp.f4d + vbd * (tp.f2d + vbd * tp.f3d / 2);
            capbd = tp.f2d + vbd * tp.f3d;
          }
        } else {
          s0[base + SLOT_QBD] = 0;
          capbd = 0;
        }

        // mos1load.c:701-725: NIintegrate bulk junctions into gbd/gbs
        // (direct lumping — no invented CAP_GEQ_DB/SB slots).
        const runBulkNIintegrate = (mode & MODETRAN) !== 0
          || ((mode & MODEINITTRAN) !== 0 && (mode & MODEUIC) === 0);
        if (runBulkNIintegrate) {
          const ag = ctx.ag;
          // mos1load.c:714-719: BD junction integrate, lump into gbd & cbd.
          {
            const qbd_now = s0[base + SLOT_QBD];
            const qbd1 = s1[base + SLOT_QBD];
            let qbd2 = 0;
            if (ctx.order >= 2) qbd2 = s2[base + SLOT_QBD];
            let ccap_bd: number;
            if (ctx.method === "trapezoidal") {
              if (ctx.order === 1) {
                ccap_bd = ag[0] * qbd_now + ag[1] * qbd1;
              } else {
                const ccapPrev = s1[base + SLOT_CQBD];
                ccap_bd = -ccapPrev * ag[1] + ag[0] * (qbd_now - qbd1);
              }
            } else {
              ccap_bd = ag[0] * qbd_now + ag[1] * qbd1;
              if (ctx.order >= 2) ccap_bd += ag[2] * qbd2;
            }
            const geq_bd = ag[0] * capbd;
            s0[base + SLOT_CQBD] = ccap_bd;
            // mos1load.c:717-719: gbd += geq; cbd += CKTstate0[cqbd]; cd -= CKTstate0[cqbd].
            gbd += geq_bd;
            cbd += ccap_bd;
            // Store updated cd
            s0[base + SLOT_CD] = cd - ccap_bd;
          }
          // mos1load.c:720-724: BS junction integrate, lump into gbs & cbs.
          {
            const qbs_now = s0[base + SLOT_QBS];
            const qbs1 = s1[base + SLOT_QBS];
            let qbs2 = 0;
            if (ctx.order >= 2) qbs2 = s2[base + SLOT_QBS];
            let ccap_bs: number;
            if (ctx.method === "trapezoidal") {
              if (ctx.order === 1) {
                ccap_bs = ag[0] * qbs_now + ag[1] * qbs1;
              } else {
                const ccapPrev = s1[base + SLOT_CQBS];
                ccap_bs = -ccapPrev * ag[1] + ag[0] * (qbs_now - qbs1);
              }
            } else {
              ccap_bs = ag[0] * qbs_now + ag[1] * qbs1;
              if (ctx.order >= 2) ccap_bs += ag[2] * qbs2;
            }
            const geq_bs = ag[0] * capbs;
            s0[base + SLOT_CQBS] = ccap_bs;
            gbs += geq_bs;
            cbs += ccap_bs;
          }
        }
      }

        // mos1load.c:750-753: save vbs, vbd, vgs, vds back to state0.
        s0[base + SLOT_VBS] = vbs;
        s0[base + SLOT_VBD] = vbd;
        s0[base + SLOT_VGS] = vgs;
        s0[base + SLOT_VDS] = vds;

        // mos1load.c:759-856: Meyer capacitance + overlap + NIintegrate.
        if (capGate) {
        // mos1load.c:773-785: DEVqmeyer — mode-dependent vgs/vgd swap.
        const vgb_read = vgs - vbs;  // vgb = vgs - vbs (computed lazily here).
        let meyerCapgs: number, meyerCapgd: number, meyerCapgb: number;
        if (opMode > 0) {
          const meyer = devQmeyer(vgs, vgd, vgb_read, von, vdsat, tp.tPhi, OxideCap);
          meyerCapgs = meyer.capgs; meyerCapgd = meyer.capgd; meyerCapgb = meyer.capgb;
        } else {
          // Reverse mode: swap vgs<->vgd and capgs<->capgd per mos1load.c:780-784.
          const meyer = devQmeyer(vgd, vgs, vgb_read, von, vdsat, tp.tPhi, OxideCap);
          meyerCapgs = meyer.capgd; meyerCapgd = meyer.capgs; meyerCapgb = meyer.capgb;
        }

        // mos1load.c:787-806: cap averaging.
        // MODETRANOP | MODEINITSMSIG → 2 * state0.
        // else → state0 + state1 (incremental averaging).
        const prevCapgs = s1[base + SLOT_CAPGS];
        const prevCapgd = s1[base + SLOT_CAPGD];
        const prevCapgb = s1[base + SLOT_CAPGB];
        const useDouble = (mode & (MODETRANOP | MODEINITSMSIG)) !== 0;
        // Store half-cap in state0 for next-step averaging.
        s0[base + SLOT_CAPGS] = meyerCapgs;
        s0[base + SLOT_CAPGD] = meyerCapgd;
        s0[base + SLOT_CAPGB] = meyerCapgb;
        capgs = (useDouble ? 2 * meyerCapgs : meyerCapgs + prevCapgs) + GateSourceOverlapCap;
        capgd = (useDouble ? 2 * meyerCapgd : meyerCapgd + prevCapgd) + GateDrainOverlapCap;
        capgb = (useDouble ? 2 * meyerCapgb : meyerCapgb + prevCapgb) + GateBulkOverlapCap;

        // mos1load.c:827-855: update charges (MODETRAN → incremental,
        // TRANOP → q = c*v).
        const vgs1 = s1[base + SLOT_VGS];
        const vgd1 = vgs1 - s1[base + SLOT_VDS];
        const vgb1 = vgs1 - s1[base + SLOT_VBS];
        if (mode & (MODEINITPRED | MODEINITTRAN)) {
          // mos1load.c:828-836: predictor extrapolation using xfact.
          // xfact = delta/deltaOld[1]; fallback to 0 when deltaOld[1]=0.
          // q0 = (1+xfact)*q1 - xfact*q2. Do NOT use ctx.xfact — compute
          // locally to match mos1load.c verbatim.
          const xfactQ = ctx.deltaOld[1] > 0 ? ctx.dt / ctx.deltaOld[1] : 0;
          s0[base + SLOT_QGS] = (1 + xfactQ) * s1[base + SLOT_QGS] - xfactQ * s2[base + SLOT_QGS];
          s0[base + SLOT_QGD] = (1 + xfactQ) * s1[base + SLOT_QGD] - xfactQ * s2[base + SLOT_QGD];
          s0[base + SLOT_QGB] = (1 + xfactQ) * s1[base + SLOT_QGB] - xfactQ * s2[base + SLOT_QGB];
        } else if (mode & MODETRAN) {
          // mos1load.c:840-846: incremental charge.
          s0[base + SLOT_QGS] = (vgs - vgs1) * capgs + s1[base + SLOT_QGS];
          s0[base + SLOT_QGD] = (vgd - vgd1) * capgd + s1[base + SLOT_QGD];
          s0[base + SLOT_QGB] = (vgs - vbs - vgb1) * capgb + s1[base + SLOT_QGB];
        } else {
          // TRANOP / SMSIG (mos1load.c:847-852): q = c * v.
          s0[base + SLOT_QGS] = vgs * capgs;
          s0[base + SLOT_QGD] = vgd * capgd;
          s0[base + SLOT_QGB] = (vgs - vbs) * capgb;
        }
      }

        // mos1load.c:860-894: NIintegrate the three gate caps, fold companion
        // geq/ceq inline into gcgs/gcgd/gcgb (NOT into invented slots).
        const initOrNoTran = (mode & MODEINITTRAN) !== 0 || (mode & MODETRAN) === 0;
        if (initOrNoTran) {
          // mos1load.c:862-873: MODEINITTRAN or not-in-TRAN → zero companions.
          gcgs = 0; ceqgs = 0;
          gcgd = 0; ceqgd = 0;
          gcgb = 0; ceqgb = 0;
        } else {
          // mos1load.c:875-877: zero cqgs/gd/gb when corresponding cap = 0.
          if (capgs === 0) s0[base + SLOT_CQGS] = 0;
          if (capgd === 0) s0[base + SLOT_CQGD] = 0;
          if (capgb === 0) s0[base + SLOT_CQGB] = 0;
          // mos1load.c:878-894: MODETRAN-only path. NIintegrate the three caps.
          const ag = ctx.ag;
          // Gate-source cap companion.
          {
            const q0 = s0[base + SLOT_QGS];
            const q1 = s1[base + SLOT_QGS];
            let q2 = 0;
            if (ctx.order >= 2) q2 = s2[base + SLOT_QGS];
            let ccap_gs: number;
            if (ctx.method === "trapezoidal") {
              if (ctx.order === 1) {
                ccap_gs = ag[0] * q0 + ag[1] * q1;
              } else {
                const ccapPrev = s1[base + SLOT_CQGS];
                ccap_gs = -ccapPrev * ag[1] + ag[0] * (q0 - q1);
              }
            } else {
              ccap_gs = ag[0] * q0 + ag[1] * q1;
              if (ctx.order >= 2) ccap_gs += ag[2] * q2;
            }
            gcgs = ag[0] * capgs;
            ceqgs = ccap_gs - gcgs * vgs + ag[0] * q0;
            s0[base + SLOT_CQGS] = ccap_gs;
          }
          // Gate-drain cap companion.
          {
            const q0 = s0[base + SLOT_QGD];
            const q1 = s1[base + SLOT_QGD];
            let q2 = 0;
            if (ctx.order >= 2) q2 = s2[base + SLOT_QGD];
            let ccap_gd: number;
            if (ctx.method === "trapezoidal") {
              if (ctx.order === 1) {
                ccap_gd = ag[0] * q0 + ag[1] * q1;
              } else {
                const ccapPrev = s1[base + SLOT_CQGD];
                ccap_gd = -ccapPrev * ag[1] + ag[0] * (q0 - q1);
              }
            } else {
              ccap_gd = ag[0] * q0 + ag[1] * q1;
              if (ctx.order >= 2) ccap_gd += ag[2] * q2;
            }
            gcgd = ag[0] * capgd;
            ceqgd = ccap_gd - gcgd * vgd + ag[0] * q0;
            s0[base + SLOT_CQGD] = ccap_gd;
          }
          // Gate-bulk cap companion.
          {
            const q0 = s0[base + SLOT_QGB];
            const q1 = s1[base + SLOT_QGB];
            let q2 = 0;
            if (ctx.order >= 2) q2 = s2[base + SLOT_QGB];
            let ccap_gb: number;
            if (ctx.method === "trapezoidal") {
              if (ctx.order === 1) {
                ccap_gb = ag[0] * q0 + ag[1] * q1;
              } else {
                const ccapPrev = s1[base + SLOT_CQGB];
                ccap_gb = -ccapPrev * ag[1] + ag[0] * (q0 - q1);
              }
            } else {
              ccap_gb = ag[0] * q0 + ag[1] * q1;
              if (ctx.order >= 2) ccap_gb += ag[2] * q2;
            }
            gcgb = ag[0] * capgb;
            const vgb_now = vgs - vbs;
            ceqgb = ccap_gb - gcgb * vgb_now + ag[0] * q0;
            s0[base + SLOT_CQGB] = ccap_gb;
          }
        }
      } // end if (!bypassed)

      // mos1load.c:902-916: ceqbs, ceqbd, cdreq RHS terms.
      const ceqbs = polarity * (cbs - gbs * vbs);
      const ceqbd = polarity * (cbd - gbd * vbd);
      let xnrm: number, xrev: number, cdreq: number;
      if (opMode >= 0) {
        xnrm = 1; xrev = 0;
        cdreq = polarity * (cdrain - gdsNR * vds - gmNR * vgs - gmbsNR * vbs);
      } else {
        xnrm = 0; xrev = 1;
        cdreq = -polarity * (cdrain - gdsNR * (-vds) - gmNR * vgd - gmbsNR * vbd);
      }

      // Store DC-op scalars for convergence test (mos1conv.c / MOS1convTest).
      s0[base + SLOT_CBD] = cbd;
      s0[base + SLOT_CBS] = cbs;
      s0[base + SLOT_GBD] = gbd;
      s0[base + SLOT_GBS] = gbs;
      s0[base + SLOT_GM] = gmNR;
      s0[base + SLOT_GDS] = gdsNR;
      s0[base + SLOT_GMBS] = gmbsNR;
      s0[base + SLOT_MODE] = opMode;

      // mos1load.c:917-924: RHS stamps.
      // NOTE: ngspice accounts for Meyer caps at gate node separately from
      // bulk via (ceqgs + ceqgb + ceqgd) lump; ditto bulk-side via -(ceqbs +
      // ceqbd - type*ceqgb). Same reading here.
      stampRHS(solver, nodeG, -(polarity * (ceqgs + ceqgb + ceqgd)));
      stampRHS(solver, nodeB, -(ceqbs + ceqbd - polarity * ceqgb));
      stampRHS(solver, nodeD, (ceqbd - cdreq + polarity * ceqgd));
      stampRHS(solver, nodeS, (cdreq + ceqbs + polarity * ceqgs));

      // RS/RD external terminal stamps (mos1load.c linear model pieces).
      if (params.RD > 0 && nodeD !== nodeD_ext) {
        const gRD = 1 / params.RD;
        stampG(solver, nodeD_ext, nodeD_ext, gRD);
        stampG(solver, nodeD_ext, nodeD, -gRD);
        stampG(solver, nodeD, nodeD_ext, -gRD);
        stampG(solver, nodeD, nodeD, gRD);
      }
      if (params.RS > 0 && nodeS !== nodeS_ext) {
        const gRS = 1 / params.RS;
        stampG(solver, nodeS_ext, nodeS_ext, gRS);
        stampG(solver, nodeS_ext, nodeS, -gRS);
        stampG(solver, nodeS, nodeS_ext, -gRS);
        stampG(solver, nodeS, nodeS, gRS);
      }

      // mos1load.c:929-956: Y-matrix stamps.
      // NOTE: ngspice uses MOS1DdPtr (drain-drain), MOS1DPdpPtr (drainPrime-
      // drainPrime), etc. With RD=0 / RS=0 the "prime" nodes collapse to the
      // external pins, so only the DPdp/SPsp stamps apply (our nodeD/nodeS).
      //   MOS1GgPtr += gcgd + gcgs + gcgb       → (nodeG, nodeG)
      //   MOS1BbPtr += gbd + gbs + gcgb          → (nodeB, nodeB)
      //   MOS1DPdpPtr += gds + gbd + xrev*(gm+gmbs) + gcgd (+drainConductance)
      //   MOS1SPspPtr += gds + gbs + xnrm*(gm+gmbs) + gcgs (+sourceConductance)
      //   MOS1GbPtr -= gcgb
      //   MOS1GdpPtr -= gcgd
      //   MOS1GspPtr -= gcgs
      //   MOS1BgPtr -= gcgb
      //   MOS1BdpPtr -= gbd
      //   MOS1BspPtr -= gbs
      //   MOS1DPgPtr += (xnrm-xrev)*gm - gcgd
      //   MOS1DPbPtr += -gbd + (xnrm-xrev)*gmbs
      //   MOS1DPspPtr += -gds - xnrm*(gm+gmbs)
      //   MOS1SPgPtr += -(xnrm-xrev)*gm - gcgs
      //   MOS1SPbPtr += -gbs - (xnrm-xrev)*gmbs
      //   MOS1SPdpPtr += -gds - xrev*(gm+gmbs)
      stampG(solver, nodeG, nodeG, gcgd + gcgs + gcgb);
      stampG(solver, nodeB, nodeB, gbd + gbs + gcgb);
      stampG(solver, nodeD, nodeD, gdsNR + gbd + xrev * (gmNR + gmbsNR) + gcgd);
      stampG(solver, nodeS, nodeS, gdsNR + gbs + xnrm * (gmNR + gmbsNR) + gcgs);
      stampG(solver, nodeG, nodeB, -gcgb);
      stampG(solver, nodeG, nodeD, -gcgd);
      stampG(solver, nodeG, nodeS, -gcgs);
      stampG(solver, nodeB, nodeG, -gcgb);
      stampG(solver, nodeB, nodeD, -gbd);
      stampG(solver, nodeB, nodeS, -gbs);
      stampG(solver, nodeD, nodeG, (xnrm - xrev) * gmNR - gcgd);
      stampG(solver, nodeD, nodeB, -gbd + (xnrm - xrev) * gmbsNR);
      stampG(solver, nodeD, nodeS, -gdsNR - xnrm * (gmNR + gmbsNR));
      stampG(solver, nodeS, nodeG, -(xnrm - xrev) * gmNR - gcgs);
      stampG(solver, nodeS, nodeB, -gbs - (xnrm - xrev) * gmbsNR);
      stampG(solver, nodeS, nodeD, -gdsNR - xrev * (gmNR + gmbsNR));

      // mos1load.c:737-743: noncon gated on OFF==0 || !(MODEINITFIX|MODEINITSMSIG).
      if (icheckLimited && (params.OFF === 0 || !(mode & (MODEINITFIX | MODEINITSMSIG)))) {
        ctx.noncon.value++;
      }
    },

    checkConvergence(ctx: LoadContext): boolean {
      const s0 = pool.states[0];
      // mos1conv.c: MOS1convTest early-return on INITFIX/INITSMSIG w/ OFF.
      if (params.OFF && (ctx.cktMode & (MODEINITFIX | MODEINITSMSIG))) return true;

      const voltages = ctx.rhsOld;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vS_v = nodeS > 0 ? voltages[nodeS - 1] : 0;
      const vG_v = nodeG > 0 ? voltages[nodeG - 1] : 0;
      const vD_v = nodeD > 0 ? voltages[nodeD - 1] : 0;
      // G1: vbs = polarity*(vB - vS), vds = polarity*(vD - vS).
      const vbsRaw = polarity * (vB - vS_v);
      const vgsRaw = polarity * (vG_v - vS_v);
      const vdsRaw = polarity * (vD_v - vS_v);
      const vbdRaw = vbsRaw - vdsRaw;

      // mos1conv.c: predicted drain current deltas, mode-dependent.
      const storedVbs = s0[base + SLOT_VBS];
      const storedVbd = s0[base + SLOT_VBD];
      const storedVgs = s0[base + SLOT_VGS];
      const storedVds = s0[base + SLOT_VDS];
      const delvbs = vbsRaw - storedVbs;
      const delvbd = vbdRaw - storedVbd;
      const delvgs = vgsRaw - storedVgs;
      const delvds = vdsRaw - storedVds;

      const cd = s0[base + SLOT_CD];
      const gm = s0[base + SLOT_GM];
      const gds = s0[base + SLOT_GDS];
      const gmbs = s0[base + SLOT_GMBS];
      const gbd = s0[base + SLOT_GBD];
      const gbs = s0[base + SLOT_GBS];
      const cbs = s0[base + SLOT_CBS];
      const cbd = s0[base + SLOT_CBD];
      const opMode = s0[base + SLOT_MODE];

      let cdhat: number;
      if (opMode >= 0) {
        cdhat = cd + gm * delvgs + gds * delvds + gmbs * delvbs - gbd * delvbd;
      } else {
        const delvgd = delvgs - delvds;
        cdhat = cd - (gbd - gmbs) * delvbd - gm * delvgd + gds * delvds;
      }
      const cbhat = cbs + cbd + gbd * delvbd + gbs * delvbs;

      const tolD = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(cd)) + ctx.iabstol;
      const tolB = ctx.reltol * Math.max(Math.abs(cbhat), Math.abs(cbs + cbd)) + ctx.iabstol;
      return Math.abs(cdhat - cd) <= tolD && Math.abs(cbhat - (cbs + cbd)) <= tolB;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      const s0 = pool.states[0];
      // Drain current: polarity * cd per mos1load.c:563.
      const id = polarity * s0[base + SLOT_CD];
      const iG = 0;
      const iD = id;
      const iS = -id;
      const iB = 0;
      // pinLayout order: [G, D, S, B] per registry.
      return [iG, iD, iS, iB];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        (params as unknown as Record<string, number>)[key] = value;
        tp = computeTempParams(params, polarity);
        params._tKP = tp.tTransconductance;
        params._tPhi = tp.tPhi;
        params._tVto = tp.tVto;
      }
    },

    // Stored temperature-corrected parameters exposed for tests.
    get _p(): ResolvedMosfetParams {
      return params;
    },

    getLteTimestep(
      dt: number,
      deltaOld: readonly number[],
      order: number,
      method: IntegrationMethod,
      lteParams: LteParams,
    ): number {
      // CKTterr on qgs, qgd, qgb, qbd, qbs per mos1load.c state layout.
      const s0 = pool.states[0];
      const s1 = pool.states[1];
      const s2 = pool.states[2];
      const s3 = pool.states[3];
      let minDt = Infinity;
      const pairs: [number, number][] = [
        [SLOT_QGS, SLOT_CQGS],
        [SLOT_QGD, SLOT_CQGD],
        [SLOT_QGB, SLOT_CQGB],
        [SLOT_QBD, SLOT_CQBD],
        [SLOT_QBS, SLOT_CQBS],
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
// getMosfetInternalNodeCount / Labels
// ---------------------------------------------------------------------------

/**
 * Returns the number of internal nodes allocated for a MOSFET instance.
 * 1 per non-zero RD, 1 per non-zero RS; bulk is tied to source (no extra node).
 */
export function getMosfetInternalNodeCount(props: PropertyBag): number {
  let count = 0;
  if (props.getModelParam<number>("RD") > 0) count++;
  if (props.getModelParam<number>("RS") > 0) count++;
  return count;
}

/**
 * Internal node labels in allocation order: D' (RD>0), S' (RS>0).
 */
export function getMosfetInternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  if (props.getModelParam<number>("RD") > 0) labels.push("D'");
  if (props.getModelParam<number>("RS") > 0) labels.push("S'");
  return labels;
}

// ---------------------------------------------------------------------------
// NmosfetElement + PmosfetElement — CircuitElement (visual) implementations
// ---------------------------------------------------------------------------

export class NmosfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NMOS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildNmosPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.3125,
      width: 4,
      height: 2.625,
    };
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

export class PmosfetElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PMOS", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPmosPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1.3125,
      width: 4.0,
      height: 2.625,
    };
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
// Pin layouts
// ---------------------------------------------------------------------------

function buildNmosPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "S", defaultBitWidth: 1, position: { x: 4, y: 1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "D", defaultBitWidth: 1, position: { x: 4, y: -1 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

function buildPmosPinDeclarations(): PinDeclaration[] {
  return [
    { direction: PinDirection.INPUT, label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.OUTPUT, label: "D", defaultBitWidth: 1, position: { x: 4.0, y: 1.0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
    { direction: PinDirection.INPUT, label: "S", defaultBitWidth: 1, position: { x: 4.0, y: -1.0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions + attribute mappings
// ---------------------------------------------------------------------------

const MOSFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

export const MOSFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model", propertyKey: "model", convert: (v) => v },
  { xmlName: "W", propertyKey: "W", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "L", propertyKey: "L", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

function nmosCircuitFactory(props: PropertyBag): NmosfetElement {
  return new NmosfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function pmosCircuitFactory(props: PropertyBag): PmosfetElement {
  return new PmosfetElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NmosfetDefinition: ComponentDefinition = {
  name: "NMOS",
  typeId: -1,
  factory: nmosCircuitFactory,
  pinLayout: buildNmosPinDeclarations(),
  propertyDefs: MOSFET_PROPERTY_DEFS,
  attributeMap: MOSFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "N-channel MOSFET — Level 1 SPICE model (Shichman-Hodges) with body effect and channel-length modulation.\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Primary: VTO, KP, LAMBDA, W, L.\n" +
    "Secondary: PHI, GAMMA, CBD, CBS, CGDO, CGSO, CGBO, RD, RS, CJ, MJ, CJSW, MJSW, TOX, NSUB, UO, FC, and more.",
  models: {},
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: MOSFET_NMOS_DEFAULTS,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "2N7000": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_2N7000,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "BS170": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_BS170,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRF530N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRF530N,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRF540N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRF540N,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRFZ44N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRFZ44N,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
  },
  defaultModel: "spice-l1",
};

export const PmosfetDefinition: ComponentDefinition = {
  name: "PMOS",
  typeId: -1,
  factory: pmosCircuitFactory,
  pinLayout: buildPmosPinDeclarations(),
  propertyDefs: MOSFET_PROPERTY_DEFS,
  attributeMap: MOSFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "P-channel MOSFET — Level 1 SPICE model (Shichman-Hodges) with body effect and channel-length modulation.\n" +
    "Pins: D (drain), G (gate), S (source).\n" +
    "Primary: VTO, KP, LAMBDA, W, L.\n" +
    "Secondary: PHI, GAMMA, CBD, CBS, CGDO, CGSO, CGBO, RD, RS, CJ, MJ, CJSW, MJSW, TOX, NSUB, UO, FC, and more.",
  models: {},
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: MOSFET_PMOS_DEFAULTS,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "BS250": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_BS250,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRF9520": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF9520,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRFP9240": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRFP9240,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRF5210": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF5210,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
    "IRF4905": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF4905,
      getInternalNodeCount: getMosfetInternalNodeCount,
      getInternalNodeLabels: getMosfetInternalNodeLabels,
    },
  },
  defaultModel: "spice-l1",
};
