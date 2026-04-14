/**
 * MOSFET analog components — N-channel and P-channel MOSFETs.
 *
 * Implements the Level 1 SPICE MOSFET model (Shichman-Hodges) with:
 *   - Three operating regions: cutoff, linear (triode), saturation
 *   - Body effect via GAMMA and PHI parameters
 *   - Channel-length modulation via LAMBDA
 *   - Gate-source voltage limiting via fetlim()
 *   - Source/drain swap detection for symmetric device
 *   - Junction capacitances (CBD, CBS) and overlap capacitances (CGDO, CGSO, CGBO)
 *   - Drain/source ohmic resistances (RD, RS) via internal nodes
 *   - Process parameter derivation: KP from UO/TOX, GAMMA from NSUB/TOX, PHI from NSUB
 *   - Area-based junction caps: CJ, CJSW with grading and FC linearization
 *
 * PMOS is implemented as the NMOS model with polarity = -1, which inverts
 * all junction voltage signs and current directions.
 *
 * I-V equations (NMOS, polarity = +1):
 *   Vth = VTO + GAMMA * (sqrt(PHI + Vsb) - sqrt(PHI))
 *   Cutoff (Vgs < Vth):        Id = 0
 *   Linear (Vds < Vgs - Vth): Id = KP*(W/L)*((Vgs-Vth)*Vds - Vds²/2)*(1+LAMBDA*Vds)
 *   Saturation (Vds >= Vgs-Vth): Id = KP/2*(W/L)*(Vgs-Vth)²*(1+LAMBDA*Vds)
 *
 * MNA stamp convention (3-terminal: D, G, S):
 *   The linearized MOSFET produces conductances between terminals plus
 *   Norton current sources at D and S.
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
import { fetlim, limvds, pnjlim } from "../../solver/analog/newton-raphson.js";
import type { LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { VT } from "../../core/constants.js";
import { integrateCapacitor } from "../../solver/analog/integration.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import {
  AbstractFetElement,
  SLOT_VGS,
  SLOT_VDS,
  SLOT_GM,
  SLOT_GDS,
  SLOT_IDS,
  SLOT_SWAPPED,
  SLOT_VSB,
  SLOT_GMBS,
  SLOT_GBD,
  SLOT_GBS,
  SLOT_CBD_I,
  SLOT_CBS_I,
  SLOT_VBD,
  SLOT_CAP_GEQ_GB,
  SLOT_CAP_IEQ_GB,
  SLOT_CAP_GEQ_DB,
  SLOT_CAP_IEQ_DB,
  SLOT_CAP_GEQ_SB,
  SLOT_CAP_IEQ_SB,
  SLOT_V_DB,
  SLOT_V_SB,
  SLOT_V_GB,
  SLOT_VON,
  SLOT_VBS_OLD,
  SLOT_VBD_OLD,
  SLOT_MODE,
  SLOT_Q_GB,
  SLOT_MEYER_GS,
  SLOT_MEYER_GD,
  SLOT_MEYER_GB,
  SLOT_CCAP_GB,
  SLOT_Q_DB,
  SLOT_Q_SB,
  SLOT_CCAP_DB,
  SLOT_CCAP_SB,
} from "../../solver/analog/fet-base.js";
import type { FetCapacitances } from "../../solver/analog/fet-base.js";
import { defineModelParams, deviceParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Elementary charge (C) — ngspice CHARGE from const.h. */
const Q = 1.6021918e-19;
/** Permittivity of free space (F/m). */
const EPS0 = 8.854214871e-12;
/** Relative permittivity of SiO2. */
const EPS_OX = 3.9;
/** Relative permittivity of Si. */
const EPS_SI = 11.7;
/** Intrinsic carrier concentration of Si at 300K (cm⁻³). */
const NI = 1.45e10;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// MosfetParams — resolved model parameters
// ---------------------------------------------------------------------------

interface MosfetParams {
  // Primary I-V params (always required)
  VTO: number;
  KP: number;
  LAMBDA: number;
  PHI: number;
  GAMMA: number;
  W: number;
  L: number;
  // Capacitance params (optional, default 0)
  CBD?: number;
  CBS?: number;
  CGDO?: number;
  CGSO?: number;
  CGBO?: number;
  // Terminal resistance params (optional, default 0)
  RD?: number;
  RS?: number;
  // Junction params (optional, with SPICE defaults)
  IS?: number;
  PB?: number;
  CJ?: number;
  MJ?: number;
  CJSW?: number;
  MJSW?: number;
  JS?: number;
  RSH?: number;
  FC?: number;
  // Area/perimeter params (optional, default 0)
  AD?: number;
  AS?: number;
  PD?: number;
  PS?: number;
  // Temperature param (optional, default 300.15 K)
  TNOM?: number;
  // Process params (optional, default 0/off)
  TOX?: number;
  NSUB?: number;
  NSS?: number;
  TPG?: number;
  LD?: number;
  UO?: number;
  // Noise params (optional, default 0/1)
  KF?: number;
  AF?: number;
  // Parallel device multiplier (optional, default 1)
  M?: number;
  // Initial condition: device off (optional, default 0=false)
  OFF?: number;
}

/** MosfetParams with all fields guaranteed present (after resolveParams). */
interface ResolvedMosfetParams {
  VTO: number;
  KP: number;
  LAMBDA: number;
  PHI: number;
  GAMMA: number;
  W: number;
  L: number;
  CBD: number;
  CBS: number;
  CGDO: number;
  CGSO: number;
  CGBO: number;
  RD: number;
  RS: number;
  IS: number;
  PB: number;
  CJ: number;
  MJ: number;
  CJSW: number;
  MJSW: number;
  JS: number;
  RSH: number;
  FC: number;
  AD: number;
  AS: number;
  PD: number;
  PS: number;
  TNOM: number;
  TOX: number;
  NSUB: number;
  NSS: number;
  TPG: number;
  LD: number;
  UO: number;
  KF: number;
  AF: number;
  M: number;
  OFF: number;
  // Temperature-corrected values threaded from _recomputeTempParams
  _tKP?: number;
  _tPhi?: number;
  _tVto?: number;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
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
    TNOM:   { default: 300.15, unit: "K",    description: "Nominal temperature" },
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
  },
});

// ---------------------------------------------------------------------------
// Built-in NMOS model presets
// Sources: ON Semi MODPEX 2004, Zetex 1985, IR/Symmetry MODPEX 1996
// All values extracted from published .SUBCKT Level 1 .MODEL MM NMOS lines.
// ---------------------------------------------------------------------------

/** Small signal NMOS (TO-92, 60V/200mA). Source: ON Semi 2N7000.REV0.LIB (Symmetry MODPEX 2004-03-31). */
const NMOS_2N7000 = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 2.236, KP: 0.0932174, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.0724e-11, CGSO: 1.79115e-7,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** Small signal NMOS (TO-92, 60V/500mA). Source: Zetex BS170/ZTX model (rev 12/85). */
const NMOS_BS170 = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 1.824, KP: 0.1233, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 35e-12, CBS: 0, CGDO: 3e-12, CGSO: 28e-12,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** Medium power NMOS (TO-220, 100V/17A). Source: IR irf530n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRF530N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.63019, KP: 17.6091, LAMBDA: 0.00363922, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.4372e-7, CGSO: 5.59846e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** High power NMOS (TO-220, 100V/33A). Source: IR irf540n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRF540N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.55958, KP: 28.379, LAMBDA: 0.000888191, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.77276e-8, CGSO: 1.23576e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

/** High power NMOS (TO-220, 55V/49A). Source: IR irfz44n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRFZ44N = deviceParams(MOSFET_NMOS_PARAM_DEFS, {
  VTO: 3.56214, KP: 39.3974, LAMBDA: 0, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.2826e-7, CGSO: 1.25255e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
});

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
    TNOM:   { default: 300.15, unit: "K",    description: "Nominal temperature" },
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
  },
});

// ---------------------------------------------------------------------------
// Built-in PMOS model presets
// Sources: Zetex/Diodes Inc., IR/Symmetry MODPEX (KiCad-Spice-Library irf.lib)
// All values extracted from published .SUBCKT Level 1 .MODEL MM PMOS lines.
// ---------------------------------------------------------------------------

/** Small signal PMOS (TO-92, -45V/230mA). Source: Zetex/Diodes Inc. BS250P v1.0 (2003-03-19). */
const PMOS_BS250 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.193, KP: 0.277, LAMBDA: 0.012, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 105e-12, CBS: 0, CGDO: 0, CGSO: 0,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** Medium power PMOS (TO-220, -100V/6.8A). Source: IR irf9520_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRF9520 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.41185, KP: 3.46967, LAMBDA: 0.0289226, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 3.45033e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-247, -200V/12A). Source: IR irfp9240_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRFP9240 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.67839, KP: 6.41634, LAMBDA: 0.0117285, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 1.08446e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-220, -100V/40A). Source: IR irf5210_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRF5210 = deviceParams(MOSFET_PMOS_PARAM_DEFS, {
  VTO: -3.79917, KP: 12.9564, LAMBDA: 0.00220079, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 2.34655e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.5, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
});

/** High power PMOS (TO-220, -55V/74A). Source: IR irf4905_IR (ngspice/KiCad-Spice-Library). */
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
 * Derive KP, GAMMA, and PHI from process parameters when NSUB > 0 and TOX > 0.
 *
 * This mirrors the standard ngspice/SPICE Level 1 derivation:
 *   Cox  = εox / TOX
 *   KP   = UO * 1e-4 * Cox            (UO in cm²/Vs → m²/Vs via *1e-4)
 *   GAMMA = sqrt(2 * q * εsi * NSUB*1e6) / Cox  (NSUB in cm⁻³ → m⁻³ via *1e6)
 *   PHI  = 2 * Vt * ln(NSUB / ni)
 *
 * Only derived when the user hasn't explicitly set the params (i.e., they're at
 * their default values: KP_default for the polarity, GAMMA=0, PHI=0.6).
 *
 * Area-based junction caps (CJ, CJSW) are resolved here too:
 *   CBD = CJ * W*L + CJSW * 2*(W+L)   (when CJ > 0 and CBD = 0)
 *   CBS = same formula
 *
 * @param raw - Raw params from PropertyBag
 * @param kpDefault - Default KP for this polarity (2e-5 NMOS, 1e-5 PMOS)
 * @returns Resolved MosfetParams with any derived values applied
 */
function resolveParams(raw: MosfetParams, kpDefault: number): ResolvedMosfetParams {
  // Expand optional fields to full resolved params with SPICE defaults
  const p: ResolvedMosfetParams = {
    VTO:  raw.VTO,
    KP:   raw.KP,
    LAMBDA: raw.LAMBDA,
    PHI:  raw.PHI,
    GAMMA: raw.GAMMA,
    W:    raw.W,
    L:    raw.L,
    CBD:  raw.CBD  ?? 0,
    CBS:  raw.CBS  ?? 0,
    CGDO: raw.CGDO ?? 0,
    CGSO: raw.CGSO ?? 0,
    CGBO: raw.CGBO ?? 0,
    RD:   raw.RD   ?? 0,
    RS:   raw.RS   ?? 0,
    IS:   raw.IS   ?? 1e-14,
    PB:   raw.PB   ?? 0.8,
    CJ:   raw.CJ   ?? 0,
    MJ:   raw.MJ   ?? 0.5,
    CJSW: raw.CJSW ?? 0,
    MJSW: raw.MJSW ?? 0.5,
    JS:   raw.JS   ?? 0,
    RSH:  raw.RSH  ?? 0,
    FC:   raw.FC   ?? 0.5,
    AD:   raw.AD   ?? 0,
    AS:   raw.AS   ?? 0,
    PD:   raw.PD   ?? 0,
    PS:   raw.PS   ?? 0,
    TNOM: raw.TNOM ?? 300.15,
    TOX:  raw.TOX  ?? 1e-7,
    NSUB: raw.NSUB ?? 0,
    NSS:  raw.NSS  ?? 0,
    TPG:  raw.TPG  ?? 1,
    LD:   raw.LD   ?? 0,
    UO:   raw.UO   ?? 600,
    KF:   raw.KF   ?? 0,
    AF:   raw.AF   ?? 1,
    M:    raw.M    ?? 1,
    OFF:  raw.OFF  ?? 0,
  };

  if (p.NSUB > 0 && p.TOX > 0) {
    const cox = (EPS_OX * EPS0) / p.TOX;
    const epsSi = EPS_SI * EPS0;
    // cm⁻³ → m⁻³ multiply by 1e6
    const nsubM3 = p.NSUB * 1e6;

    // Derive KP if still at default
    if (p.KP === kpDefault) {
      p.KP = (p.UO * 1e-4) * cox;
    }

    // Derive GAMMA if still at default (0)
    if (p.GAMMA === 0) {
      p.GAMMA = Math.sqrt(2 * Q * epsSi * nsubM3) / cox;
    }

    // Derive PHI if still at default (0.6)
    if (p.PHI === 0.6) {
      const phi = 2 * VT * Math.log(p.NSUB / NI);
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
// computeIds — drain current for three operating regions
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET drain-source current and threshold voltage.
 *
 * Uses temperature-corrected KP, PHI, VTO when available in params (_tKP, _tPhi, _tVto).
 * Returns vdsat and von for Meyer gate cap model.
 *
 * @param vgs  - Gate-source voltage (polarity-corrected)
 * @param vds  - Drain-source voltage (polarity-corrected, always >= 0 after swap)
 * @param vsb  - Source-bulk voltage (polarity-corrected, >= 0 for NMOS)
 * @param p    - Resolved model parameters
 * @returns    - { ids, vth, vdsat, von } drain current, threshold, saturation voltage, von
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

  // Body effect — allow forward body bias (ngspice mos1load.c)
  let sarg: number;
  if (vsb >= 0) {
    sarg = Math.sqrt(phi + vsb);
  } else {
    sarg = Math.sqrt(phi);
    sarg = Math.max(0, sarg + vsb / (2 * sarg));
  }
  // Use tVbi-based von when tVto is available, otherwise VTO-based
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  // von = vth including body effect (same as vth here)
  const von = vth;

  const vgst = vgs - vth;
  const vdsat = Math.max(vgst, 0);

  if (vgst <= 0) {
    return { ids: 0, vth, vdsat, von };
  }

  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const lambda = p.LAMBDA;
  const betap = Beta * (1 + lambda * vds);

  if (vds < vgst) {
    // Linear (triode) region
    const ids = betap * vds * (vgst - 0.5 * vds);
    return { ids, vth, vdsat, von };
  } else {
    // Saturation region
    const ids = betap * vgst * vgst * 0.5;
    return { ids, vth, vdsat, von };
  }
}

// ---------------------------------------------------------------------------
// computeGm — transconductance dId/dVgs
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET transconductance gm = dId/dVgs.
 */
export function computeGm(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const rp = p as ResolvedMosfetParams;
  const tKP = rp._tKP ?? p.KP;
  const tPhi = rp._tPhi ?? p.PHI;
  const tVto = rp._tVto;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) {
    sarg = Math.sqrt(phi + vsb);
  } else {
    sarg = Math.sqrt(phi);
    sarg = Math.max(0, sarg + vsb / (2 * sarg));
  }
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return 0;
  }

  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const lambda = p.LAMBDA;
  const betap = Beta * (1 + lambda * vds);

  if (vds < vgst) {
    return betap * vds + GMIN;
  } else {
    return betap * vgst + GMIN;
  }
}

// ---------------------------------------------------------------------------
// computeGds — output conductance dId/dVds
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET output conductance gds = dId/dVds.
 */
export function computeGds(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const rp = p as ResolvedMosfetParams;
  const tKP = rp._tKP ?? p.KP;
  const tPhi = rp._tPhi ?? p.PHI;
  const tVto = rp._tVto;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) {
    sarg = Math.sqrt(phi + vsb);
  } else {
    sarg = Math.sqrt(phi);
    sarg = Math.max(0, sarg + vsb / (2 * sarg));
  }
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return 0;
  }

  const ld = p.LD ?? 0;
  const effectiveLength = p.L - 2 * ld;
  const Beta = tKP * p.W / effectiveLength * (p.M ?? 1);
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    const betap = Beta * (1 + lambda * vds);
    const term1 = betap * (vgst - vds);
    const term2 = Beta * lambda * vds * (vgst - 0.5 * vds);
    return term1 + term2 + GMIN;
  } else {
    return Beta * lambda * vgst * vgst * 0.5 + GMIN;
  }
}

// ---------------------------------------------------------------------------
// computeGmbs — bulk transconductance dId/dVbs
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET bulk transconductance gmbs = dId/dVbs.
 *
 * ngspice mos1load.c: gmbs = gm * arg, where arg = GAMMA / (2 * sarg).
 */
export function computeGmbs(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const rp = p as ResolvedMosfetParams;
  const tPhi = rp._tPhi ?? p.PHI;
  const phi = Math.max(tPhi, 0.1);
  let sarg: number;
  if (vsb >= 0) {
    sarg = Math.sqrt(phi + vsb);
  } else {
    sarg = Math.sqrt(phi);
    sarg = Math.max(0, sarg + vsb / (2 * sarg));
  }
  const tVto = rp._tVto;
  const vth = tVto !== undefined
    ? tVto + p.GAMMA * (sarg - Math.sqrt(phi))
    : p.VTO + p.GAMMA * (sarg - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0 || p.GAMMA <= 0) {
    return 0;
  }

  const gm = computeGm(vgs, vds, vsb, p);
  const dVthdVsb = sarg > 0 ? p.GAMMA / (2 * sarg) : 0;
  return gm * dVthdVsb;
}

// ---------------------------------------------------------------------------
// limitVoltages — fetlim on Vgs with source/drain swap detection
// ---------------------------------------------------------------------------

/**
 * Apply fetlim/limvds voltage limiting — exact mos1load.c:363-386 algorithm.
 *
 * Forward (vdsOld >= 0): fetlim vgs, derive vds, limvds, derive vgd.
 * Reverse (vdsOld < 0): fetlim vgd, derive vds, -limvds(-vds,-vdsOld), derive vgs.
 * Mode from FINAL vds sign.
 *
 * @param von - threshold voltage including body effect from previous iteration
 */
export function limitVoltages(
  vgsOld: number,
  vgsNew: number,
  vdsOld: number,
  vdsNew: number,
  von: number,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = vgsNew;
  let vds = vdsNew;
  const vgd = vgs - vds;
  const vgdOld = vgsOld - vdsOld;

  if (vdsOld >= 0) {
    // Forward: fetlim vgs, derive vds, limvds, derive vgd
    vgs = fetlim(vgs, vgsOld, von);
    vds = vgs - vgd;
    vds = limvds(vds, vdsOld);
  } else {
    // Reverse: fetlim vgd, derive vds, -limvds(-vds,-vdsOld), derive vgs
    const vgdLim = fetlim(vgd, vgdOld, von);
    vds = vgs - vgdLim;
    vds = -limvds(-vds, -vdsOld);
    vgs = vgdLim + vds;
  }

  // Mode from FINAL vds sign
  const swapped = vds < 0;
  return { vgs, vds, swapped };
}

// ---------------------------------------------------------------------------
// computeCapacitances — junction and overlap capacitances
// ---------------------------------------------------------------------------

/**
 * Compute gate and junction capacitances from model parameters.
 *
 * Returns zero for all capacitances when the relevant parameters are zero.
 * Overlap capacitances scale with channel width W (CGDO, CGSO) or length L (CGBO).
 *
 * Junction capacitances (CBD, CBS) are returned directly — any CJ/CJSW area
 * derivation was already done in resolveParams before the element is constructed.
 *
 * The FC parameter linearizes junction caps in forward bias (standard SPICE):
 *   For V < FC*PB: C = C0 * (1 - V/PB)^(-MJ)
 *   For V >= FC*PB: C = C0 * (1 - FC*(1+MJ) + MJ*V/PB) / (1 - FC)^(1+MJ)
 * This function returns the zero-bias value; linearization is applied in
 * stampCompanion when vdb/vsb voltages are available.
 */
export function computeCapacitances(
  p: MosfetParams | ResolvedMosfetParams,
): { cgs: number; cgd: number; cgb: number; cbd: number; cbs: number } {
  return {
    cgs: (p.CGSO ?? 0) * p.W,
    cgd: (p.CGDO ?? 0) * p.W,
    cgb: (p.CGBO ?? 0) * (p.L - 2 * (p.LD ?? 0)),
    cbd: p.CBD ?? 0,
    cbs: p.CBS ?? 0,
  };
}

/**
 * Evaluate junction capacitance at voltage V across the junction.
 *
 * Uses the standard SPICE FC linearization:
 *   For V < FC*PB: C = C0 * (1 - V/PB)^(-MJ)
 *   For V >= FC*PB: linear extension from FC*PB tangent
 *
 * @param c0   Zero-bias capacitance (F)
 * @param v    Voltage across junction (positive = forward bias)
 * @param pb   Junction built-in potential (PB)
 * @param mj   Grading coefficient (MJ or MJSW)
 * @param fc   Forward-bias coefficient (FC)
 */
export function junctionCap(c0: number, v: number, pb: number, mj: number, fc: number): number {
  if (c0 === 0) return 0;
  const pbSafe = Math.max(pb, 0.1);
  const vBound = fc * pbSafe;
  if (v < vBound) {
    return c0 * Math.pow(1 - v / pbSafe, -mj);
  } else {
    // Linearized above FC*PB to avoid divergence
    const f2 = Math.pow(1 - fc, 1 + mj);
    return c0 * (1 - fc * (1 + mj) + mj * v / pbSafe) / f2;
  }
}

// ---------------------------------------------------------------------------
// devQmeyer — Meyer gate capacitance model (devsup.c:625-689)
// ---------------------------------------------------------------------------

/**
 * Evaluate Meyer gate capacitances. Returns 1/2 of the non-constant portion.
 * Caller must double and add overlap caps.
 *
 * Four regions:
 * 1. Accumulation (vgst <= -phi): capgb = cox/2, capgs = capgd = 0
 * 2. Depletion (vgst <= -phi/2): capgb = -vgst*cox/(2*phi), capgs = capgd = 0
 * 3. Weak inversion (vgst <= 0): voltage-dependent split
 * 4. Strong inversion: saturation or linear split
 */
export function devQmeyer(
  vgs: number, vgd: number, _vgb: number,
  von: number, vdsat: number,
  phi: number, cox: number,
): { capgs: number; capgd: number; capgb: number } {
  const MAGIC_VDS = 0.025;
  const vgst = vgs - von;
  vdsat = Math.max(vdsat, MAGIC_VDS);

  let capgs: number;
  let capgd: number;
  let capgb: number;

  if (vgst <= -phi) {
    capgb = cox / 2;
    capgs = 0;
    capgd = 0;
  } else if (vgst <= -phi / 2) {
    capgb = -vgst * cox / (2 * phi);
    capgs = 0;
    capgd = 0;
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
      capgs = cox / 3;
      capgd = 0;
      capgb = 0;
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
// MosfetAnalogElement — AbstractFetElement subclass
// ---------------------------------------------------------------------------

/**
 * Concrete FET analog element for MOSFET (N-channel or P-channel).
 *
 * Extends AbstractFetElement with the Level 2 SPICE MOSFET I-V model,
 * body effect, junction/overlap capacitances, and source/drain swap detection.
 */
// ---------------------------------------------------------------------------
// Physical constants for temperature model
// ---------------------------------------------------------------------------

/** Boltzmann constant / electron charge (CONSTKoverQ in ngspice const.h). */
const KoverQ = 1.3806226e-23 / 1.6021918e-19;

/** Reference temperature (REFTEMP in ngspice const.h). */
const REFTEMP = 300.15;

class MosfetAnalogElement extends AbstractFetElement {
  readonly polaritySign: 1 | -1;

  private readonly _p: ResolvedMosfetParams;
  private readonly _nodeB: number;

  private readonly _nodeDext: number;
  private readonly _nodeSext: number;

  // Precomputed temperature-adjusted saturation currents (mos1temp.c:176-179)
  private _tSatCur: number = 0;
  private _tSatCurDens: number = 0;
  private _drainSatCur: number = 0;
  private _sourceSatCur: number = 0;
  private _drainVcrit: number = 0;
  private _sourceVcrit: number = 0;

  // Full temperature model (mos1temp.c:44-200)
  private _tTransconductance: number = 0;
  private _tPhi: number = 0;
  private _tVbi: number = 0;
  private _tVto: number = 0;
  private _tBulkPot: number = 0;
  private _tDepCap: number = 0;
  private _tCbd: number = 0;
  private _tCbs: number = 0;
  private _tCj: number = 0;
  private _tCjsw: number = 0;

  // Junction cap f2/f3/f4 coefficients (mos1temp.c:238-289)
  private _f2d: number = 0;
  private _f3d: number = 0;
  private _f4d: number = 0;
  private _f2s: number = 0;
  private _f3s: number = 0;
  private _f4s: number = 0;
  private _czbd: number = 0;
  private _czbdsw: number = 0;
  private _czbs: number = 0;
  private _czbssw: number = 0;

  // Last computed vdsat for Meyer caps
  private _lastVdsat: number = 0;

  /** Junction charge at forward-bias boundary (drain/source). Used by charge-based integration. */
  get _junctionChargeAtDepCap(): { qd: number; qs: number } {
    return { qd: this._f4d, qs: this._f4s };
  }

  constructor(
    polarity: 1 | -1,
    nodeD: number,
    nodeG: number,
    nodeS: number,
    nodeB: number,
    p: ResolvedMosfetParams,
    nodeDint: number,
    nodeSint: number,
  ) {
    // The base class drainNode/sourceNode refer to the internal nodes (after RD/RS).
    // When RD=0/RS=0, nodeDint==nodeD and nodeSint==nodeS (no internal nodes allocated).
    // Pass nodeB as extra node so pinNodeIds = [G, Dint, Sint, B] (bulk always included).
    super(nodeG, nodeDint, nodeSint, [nodeB]);
    this.polaritySign = polarity;
    this._p = p;
    this._nodeB = nodeB;
    this._nodeDext = nodeD;
    this._nodeSext = nodeS;

    // For PMOS, VTO is stored as magnitude; polarity inversion applies sign during I-V evaluation
    if (polarity === -1) {
      this._p.VTO = Math.abs(this._p.VTO);
    }

    this._recomputeTempParams();

    const caps = computeCapacitances(p);
    const ld = p.LD ?? 0;
    const effectiveLength = p.L - 2 * ld;
    const oxideCap = p.TOX > 0 ? (EPS_OX * EPS0 / p.TOX) * effectiveLength * p.W : 0;
    const hasCaps = caps.cbd > 0 || caps.cbs > 0 || caps.cgs > 0 || caps.cgd > 0 || caps.cgb > 0 || oxideCap > 0;
    this._initReactive(hasCaps);
  }

  /**
   * Recompute temperature-adjusted parameters.
   * Full mos1temp.c:44-289 chain: transconductance, phi, vbi, vto,
   * saturation currents, junction caps, and f2/f3/f4 coefficients.
   *
   * Circuit temperature = REFTEMP (300.15 K), nominal = p.TNOM.
   */
  private _recomputeTempParams(): void {
    const p = this._p;
    const CONSTboltz = 1.3806226e-23;

    // --- Model-level computations (mos1temp.c:45-51) ---
    const fact1 = p.TNOM / REFTEMP;
    const vtnom = p.TNOM * KoverQ;
    const kt1 = CONSTboltz * p.TNOM;
    const egfet1 = 1.16 - (7.02e-4 * p.TNOM * p.TNOM) / (p.TNOM + 1108);
    const arg1 = -egfet1 / (kt1 + kt1) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
    const pbfact1 = -2 * vtnom * (1.5 * Math.log(fact1) + Q * arg1);

    // --- Instance-level computations (mos1temp.c:135-201) ---
    // here->MOS1temp = REFTEMP (circuit temperature)
    const vt = REFTEMP * KoverQ;
    const ratio = REFTEMP / p.TNOM;
    const fact2 = REFTEMP / REFTEMP; // = 1 (circuit temp / REFTEMP)
    const kt = REFTEMP * CONSTboltz;
    const egfet = 1.16 - (7.02e-4 * REFTEMP * REFTEMP) / (REFTEMP + 1108);
    const arg = -egfet / (kt + kt) + 1.1150877 / (CONSTboltz * (REFTEMP + REFTEMP));
    const pbfact = -2 * vt * (1.5 * Math.log(fact2) + Q * arg);

    // mos1temp.c:165-166: temperature-adjusted transconductance
    const ratio4 = ratio * Math.sqrt(ratio);
    this._tTransconductance = p.KP / ratio4;

    // mos1temp.c:168-169: temperature-adjusted phi
    const phio = (p.PHI - pbfact1) / fact1;
    this._tPhi = fact2 * phio + pbfact;

    // mos1temp.c:170-176: temperature-adjusted vbi and vto
    const type = this.polaritySign;
    this._tVbi = p.VTO - type * (p.GAMMA * Math.sqrt(p.PHI))
      + 0.5 * (egfet1 - egfet)
      + type * 0.5 * (this._tPhi - p.PHI);
    this._tVto = this._tVbi + type * p.GAMMA * Math.sqrt(this._tPhi);

    // mos1temp.c:177-180: saturation currents
    const tempFactor = Math.exp(-egfet / vt + egfet1 / vtnom);
    this._tSatCur = p.IS * tempFactor;
    this._tSatCurDens = p.JS * tempFactor;

    // mos1temp.c:181-200: junction cap temperature adjustment
    const pbo = (p.PB - pbfact1) / fact1;
    const gmaold = (p.PB - pbo) / pbo;
    let capfact = 1 / (1 + p.MJ * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
    this._tCbd = p.CBD * capfact;
    this._tCbs = p.CBS * capfact;
    this._tCj = p.CJ * capfact;
    capfact = 1 / (1 + p.MJSW * (4e-4 * (p.TNOM - REFTEMP) - gmaold));
    this._tCjsw = p.CJSW * capfact;
    this._tBulkPot = fact2 * pbo + pbfact;
    const gmanew = (this._tBulkPot - pbo) / pbo;
    capfact = 1 + p.MJ * (4e-4 * (REFTEMP - REFTEMP) - gmanew);
    this._tCbd *= capfact;
    this._tCbs *= capfact;
    this._tCj *= capfact;
    capfact = 1 + p.MJSW * (4e-4 * (REFTEMP - REFTEMP) - gmanew);
    this._tCjsw *= capfact;
    this._tDepCap = p.FC * this._tBulkPot;

    // mos1load.c:128-138: drain/source saturation currents scaled by multiplicity M
    const m = p.M ?? 1;
    if (this._tSatCurDens === 0 || p.AD === 0 || p.AS === 0) {
      this._drainSatCur = this._tSatCur * m;
      this._sourceSatCur = this._tSatCur * m;
    } else {
      this._drainSatCur = this._tSatCurDens * p.AD * m;
      this._sourceSatCur = this._tSatCurDens * p.AS * m;
    }

    // mos1temp.c:202-216: separate drain/source vcrit
    if (this._tSatCurDens === 0 || p.AD === 0 || p.AS === 0) {
      this._drainVcrit = this._sourceVcrit = vt * Math.log(vt / (Math.SQRT2 * this._tSatCur));
    } else {
      this._drainVcrit = vt * Math.log(vt / (Math.SQRT2 * this._tSatCurDens * p.AD));
      this._sourceVcrit = vt * Math.log(vt / (Math.SQRT2 * this._tSatCurDens * p.AS));
    }

    // Thread temperature values into params for standalone functions
    (this._p as ResolvedMosfetParams)._tKP = this._tTransconductance;
    (this._p as ResolvedMosfetParams)._tPhi = this._tPhi;
    (this._p as ResolvedMosfetParams)._tVto = this._tVto;

    // Compute junction f2/f3/f4 coefficients
    this._computeJunctionF234();
  }

  /**
   * Precompute zero-bias junction caps and f2/f3/f4 linearization coefficients.
   * Matches mos1temp.c:218-289.
   */
  private _computeJunctionF234(): void {
    const p = this._p;
    const mj = p.MJ;
    const mjsw = p.MJSW;
    const fc = p.FC;
    const tBulkPot = this._tBulkPot;

    // --- Drain side (mos1temp.c:218-253) ---
    // Priority: CBD given > CJ*AD > 0
    let czbd: number;
    if (p.CBD > 0) {
      czbd = this._tCbd;
    } else if (p.CJ > 0 && p.AD > 0) {
      czbd = this._tCj * p.AD;
    } else {
      czbd = 0;
    }
    const czbdsw = p.CJSW > 0 ? this._tCjsw * p.PD : 0;

    const argFC = 1 - fc;
    const sarg = Math.exp(-mj * Math.log(argFC));
    const sargsw = Math.exp(-mjsw * Math.log(argFC));

    this._czbd = czbd;
    this._czbdsw = czbdsw;
    this._f2d = czbd * (1 - fc * (1 + mj)) * sarg / argFC
      + czbdsw * (1 - fc * (1 + mjsw)) * sargsw / argFC;
    this._f3d = czbd * mj * sarg / argFC / tBulkPot
      + czbdsw * mjsw * sargsw / argFC / tBulkPot;
    this._f4d = czbd * tBulkPot * (1 - argFC * sarg) / (1 - mj)
      + czbdsw * tBulkPot * (1 - argFC * sargsw) / (1 - mjsw)
      - this._f3d / 2 * (this._tDepCap * this._tDepCap)
      - this._tDepCap * this._f2d;

    // --- Source side (mos1temp.c:254-289) ---
    let czbs: number;
    if (p.CBS > 0) {
      czbs = this._tCbs;
    } else if (p.CJ > 0 && p.AS > 0) {
      czbs = this._tCj * p.AS;
    } else {
      czbs = 0;
    }
    const czbssw = p.CJSW > 0 ? this._tCjsw * p.PS : 0;

    // sarg/sargsw same as drain side (same FC, MJ, MJSW)
    this._czbs = czbs;
    this._czbssw = czbssw;
    this._f2s = czbs * (1 - fc * (1 + mj)) * sarg / argFC
      + czbssw * (1 - fc * (1 + mjsw)) * sargsw / argFC;
    this._f3s = czbs * mj * sarg / argFC / tBulkPot
      + czbssw * mjsw * sargsw / argFC / tBulkPot;
    this._f4s = czbs * tBulkPot * (1 - argFC * sarg) / (1 - mj)
      + czbssw * tBulkPot * (1 - argFC * sargsw) / (1 - mjsw)
      - this._f3s / 2 * (this._tDepCap * this._tDepCap)
      - this._tDepCap * this._f2s;
  }

  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped: boolean } {
    // Use tVto (temperature-adjusted) instead of bare VTO
    const base = this.stateBaseOffset;
    const storedVon = this._s0[base + SLOT_VON];
    // First iteration (NaN): use tVto as initial von
    const von = isNaN(storedVon) ? this._tVto : storedVon;
    return limitVoltages(vgsOld, vgsNew, _vdsOld, vdsNew, von);
  }

  private get _vsb(): number { return this._s0[this.stateBaseOffset + SLOT_VSB]; }
  private set _vsb(v: number) { this._s0[this.stateBaseOffset + SLOT_VSB] = v; }

  private get _gmbs(): number { return this._s0[this.stateBaseOffset + SLOT_GMBS]; }
  private set _gmbs(v: number) { this._s0[this.stateBaseOffset + SLOT_GMBS] = v; }

  computeIds(vgs: number, vds: number): number {
    const { ids } = computeIds(vgs, vds, this._vsb, this._p);
    return ids;
  }

  computeGm(vgs: number, vds: number): number {
    return computeGm(vgs, vds, this._vsb, this._p);
  }

  computeGds(vgs: number, vds: number): number {
    return computeGds(vgs, vds, this._vsb, this._p);
  }

  computeCapacitances(vgs: number, vds: number): FetCapacitances {
    const p = this._p;
    const ld = p.LD ?? 0;
    const effectiveLength = p.L - 2 * ld;
    const oxideCap = p.TOX > 0 ? (EPS_OX * EPS0 / p.TOX) * effectiveLength * p.W : 0;
    const gsOverlap = (p.CGSO ?? 0) * p.W;
    const gdOverlap = (p.CGDO ?? 0) * p.W;

    if (oxideCap > 0) {
      // Meyer gate cap model with mode-dependent arg swap (mos1load.c:753-775)
      const base = this.stateBaseOffset;
      const von = this._s0[base + SLOT_VON] || this._tVto;
      const vdsat = this._lastVdsat;
      const vgd = vgs - vds;
      const mode = this._swapped ? -1 : 1;
      let meyerGs: number, meyerGd: number;
      if (mode > 0) {
        const meyer = devQmeyer(vgs, vgd, 0, von, vdsat, this._tPhi, oxideCap);
        meyerGs = meyer.capgs;
        meyerGd = meyer.capgd;
      } else {
        // Reverse mode: swap vgs<->vgd and capgs<->capgd
        const meyer = devQmeyer(vgd, vgs, 0, von, vdsat, this._tPhi, oxideCap);
        meyerGs = meyer.capgd;
        meyerGd = meyer.capgs;
      }
      // Store half-caps for averaging
      this._s0[base + SLOT_MEYER_GS] = meyerGs;
      this._s0[base + SLOT_MEYER_GD] = meyerGd;

      // Average with previous step's half-cap (mos1load.c:769-786)
      const prevMeyerGs = this.s1[base + SLOT_MEYER_GS];
      const prevMeyerGd = this.s1[base + SLOT_MEYER_GD];
      const firstTran = this._pool.initMode === "initTran";
      const cgs = (firstTran ? 2 * meyerGs : meyerGs + prevMeyerGs) + gsOverlap;
      const cgd = (firstTran ? 2 * meyerGd : meyerGd + prevMeyerGd) + gdOverlap;
      return { cgs, cgd };
    }

    // No oxide cap: overlap only
    return { cgs: gsOverlap, cgd: gdOverlap };
  }

  override updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): boolean {
    if (this._pool.initMode === "initPred") {
      // ngspice mos1load.c:206-225 (MODEINITPRED, no PREDICTOR):
      // Only copies vgs, vds, vbs, vbd from state1 to state0.
      // These serve as the "vold" references for fetlim/pnjlim limiting.
      // All conductances/currents/von/mode are recomputed from fresh voltages.
      const base = this.stateBaseOffset;
      const s0 = this._s0;
      const s1 = this.s1;
      s0[base + SLOT_VGS]     = s1[base + SLOT_VGS];      // fetlim vold for vgs
      s0[base + SLOT_VDS]     = s1[base + SLOT_VDS];      // limvds vold for vds
      s0[base + SLOT_VBS_OLD] = s1[base + SLOT_VBS_OLD];  // pnjlim vold for vbs
      s0[base + SLOT_VBD_OLD] = s1[base + SLOT_VBD_OLD];  // pnjlim vold for vbd
    }

    const nodeD = this.drainNode;
    const nodeG = this.gateNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vBulk = nodeB > 0 ? voltages[nodeB - 1] : 0;

    // Apply polarity for PMOS (negate all voltages relative to device)
    const vGraw = this.polaritySign * (vG - vS);
    const vDraw = this.polaritySign * (vD - vS);
    const vBraw = this.polaritySign * (vBulk - vS);

    // Voltage limiting on Vgs via fetlim with von (Fix 2)
    const limited = this.limitVoltages(this._vgs, this._vds, vGraw, vDraw);
    if (limitingCollector) {
      limitingCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label ?? "",
        junction: "GS",
        limitType: "fetlim",
        vBefore: vGraw,
        vAfter: limited.vgs,
        wasLimited: limited.vgs !== vGraw,
      });
      limitingCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label ?? "",
        junction: "DS",
        limitType: "limvds",
        vBefore: vDraw,
        vAfter: limited.vds,
        wasLimited: limited.vds !== vDraw,
      });
    }
    this._vgs = limited.vgs;
    this._vds = limited.vds;
    this._swapped = limited.swapped;

    const base = this.stateBaseOffset;
    const s0 = this._s0;

    // Store mode for convergence check and Norton current (Fix 9, 10)
    const mode = limited.swapped ? -1 : 1;
    s0[base + SLOT_MODE] = mode;

    // Source-bulk voltage — allow forward body bias (no clamp to >= 0)
    // In reverse mode, body effect uses vbd (mos1load.c:480)
    if (limited.swapped) {
      // Reverse mode: effective source is the physical drain node
      this._vsb = -this.polaritySign * (vBulk - vD);
    } else {
      this._vsb = -vBraw;
    }

    // Recompute operating point at limited voltages
    const result = computeIds(this._vgs, this._vds, this._vsb, this._p);
    this._ids = result.ids;
    this._lastVdsat = result.vdsat;
    this._gm = computeGm(this._vgs, this._vds, this._vsb, this._p);
    this._gds = computeGds(this._vgs, this._vds, this._vsb, this._p);
    this._gmbs = computeGmbs(this._vgs, this._vds, this._vsb, this._p);

    // Store von (Vth including body effect) for next iteration's fetlim
    s0[base + SLOT_VON] = result.vth;

    // Bulk junction DC diode: compute gbd, gbs, Ibd, Ibs and store VBD
    // VBS = -VSB (bulk-source), VBD = VBS - VDS
    let vbs = -this._vsb;
    let vbd = vbs - this._vds;

    // mos1load.c:378-386: apply pnjlim once based on vds sign
    const vbsOld = s0[base + SLOT_VBS_OLD];
    const vbdOld = s0[base + SLOT_VBD_OLD];
    let pnjLimited = false;
    if (this._vds >= 0) {
      const vbsBefore = vbs;
      const vbsResult = pnjlim(vbs, vbsOld, VT, this._sourceVcrit);
      vbs = vbsResult.value;
      vbd = vbs - this._vds;
      pnjLimited = vbsResult.limited;
      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "BS",
          limitType: "pnjlim",
          vBefore: vbsBefore,
          vAfter: vbs,
          wasLimited: pnjLimited,
        });
      }
    } else {
      const vbdBefore = vbd;
      const vbdResult = pnjlim(vbd, vbdOld, VT, this._drainVcrit);
      vbd = vbdResult.value;
      vbs = vbd + this._vds;
      pnjLimited = vbdResult.limited;
      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: this.elementIndex ?? -1,
          label: this.label ?? "",
          junction: "BD",
          limitType: "pnjlim",
          vBefore: vbdBefore,
          vAfter: vbd,
          wasLimited: pnjLimited,
        });
      }
    }
    s0[base + SLOT_VBS_OLD] = vbs;
    s0[base + SLOT_VBD_OLD] = vbd;
    this._pnjlimLimited = pnjLimited;

    // mos1load.c:433-448: junction I-V with area-scaled saturation currents
    const drainSatCur = this._drainSatCur;
    const sourceSatCur = this._sourceSatCur;

    const MAX_EXP_ARG = 709.78;

    // Source-bulk junction
    let gbs: number, cbsI: number;
    if (vbs <= -3 * VT) {
      gbs = GMIN;
      cbsI = GMIN * vbs - sourceSatCur;
    } else {
      const evbs = Math.exp(Math.min(vbs / VT, MAX_EXP_ARG));
      gbs = sourceSatCur * evbs / VT + GMIN;
      cbsI = sourceSatCur * (evbs - 1) + GMIN * vbs;
    }

    // Drain-bulk junction
    let gbd: number, cbdI: number;
    if (vbd <= -3 * VT) {
      gbd = GMIN;
      cbdI = GMIN * vbd - drainSatCur;
    } else {
      const evbd = Math.exp(Math.min(vbd / VT, MAX_EXP_ARG));
      gbd = drainSatCur * evbd / VT + GMIN;
      cbdI = drainSatCur * (evbd - 1) + GMIN * vbd;
    }

    // Store in pool for convergence check (MOS1convTest) and stamping
    s0[base + SLOT_GBD] = gbd;
    s0[base + SLOT_GBS] = gbs;
    s0[base + SLOT_CBD_I] = cbdI;
    s0[base + SLOT_CBS_I] = cbsI;
    s0[base + SLOT_VBD] = vbd;
    return this._pnjlimLimited;
  }

  override stampNonlinear(solver: SparseSolver): void {
    const nodeG = this.gateNode;
    const effectiveD = this._swapped ? this.sourceNode : this.drainNode;
    const effectiveS = this._swapped ? this.drainNode : this.sourceNode;
    const nodeB = this._nodeB;

    const gmS = this._gm * this._sourceScale;
    const gdsS = this._gds * this._sourceScale;
    const gmbsS = this._gmbs * this._sourceScale;

    // Transconductance gm (Vgs): current from S to D
    stampG(solver, effectiveD, nodeG, gmS);
    stampG(solver, effectiveD, effectiveS, -gmS);
    stampG(solver, effectiveS, nodeG, -gmS);
    stampG(solver, effectiveS, effectiveS, gmS);

    // Output conductance gds (Vds): current from S to D
    stampG(solver, effectiveD, effectiveD, gdsS);
    stampG(solver, effectiveD, effectiveS, -gdsS);
    stampG(solver, effectiveS, effectiveD, -gdsS);
    stampG(solver, effectiveS, effectiveS, gdsS);

    // Body transconductance gmbs (Vbs = Vb - Vs): only when bulk ≠ source
    if (nodeB !== effectiveS && gmbsS > 0) {
      stampG(solver, effectiveD, nodeB, gmbsS);
      stampG(solver, effectiveD, effectiveS, -gmbsS);
      stampG(solver, effectiveS, nodeB, -gmbsS);
      stampG(solver, effectiveS, effectiveS, gmbsS);
    }

    // Fix 9: Norton current — mode-dependent formula (ngspice mos1load.c)
    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const mode = s0[base + SLOT_MODE];
    const polarity = this.polaritySign;
    let nortonId: number;
    const vbsOp = -this._vsb; // Vbs = -Vsb
    if (mode >= 0) {
      // Normal mode
      nortonId = polarity * (this._ids - this._gm * this._vgs - this._gds * this._vds - this._gmbs * vbsOp);
    } else {
      // Reverse mode: vgd = vgs - vds, vbd = vbs - vds
      const vgd = this._vgs - this._vds;
      const vbd = vbsOp - this._vds;
      nortonId = -polarity * (this._ids - this._gds * (-this._vds) - this._gm * vgd - this._gmbs * vbd);
    }
    nortonId *= this._sourceScale;

    stampRHS(solver, effectiveD, -nortonId);
    stampRHS(solver, effectiveS, nortonId);

    // Fix 3: Stamp bulk junction diode conductances and Norton currents
    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const gbd = s0[base + SLOT_GBD];
    const gbs = s0[base + SLOT_GBS];
    const cbdI = s0[base + SLOT_CBD_I];
    const cbsI = s0[base + SLOT_CBS_I];
    const vbd_stored = s0[base + SLOT_VBD];

    // Drain-bulk junction conductance stamps
    stampG(solver, nodeD, nodeD, gbd);
    stampG(solver, nodeD, nodeB, -gbd);
    stampG(solver, nodeB, nodeD, -gbd);
    stampG(solver, nodeB, nodeB, gbd);

    // Source-bulk junction conductance stamps
    stampG(solver, nodeS, nodeS, gbs);
    stampG(solver, nodeS, nodeB, -gbs);
    stampG(solver, nodeB, nodeS, -gbs);
    stampG(solver, nodeB, nodeB, gbs);

    // Norton currents for junction diodes.
    // Use pnjlim-limited vbd/vbs from SLOT_VBD_OLD/SLOT_VBS_OLD (written by
    // updateOperatingPoint) — not raw vbsOp which is the un-limited current-iter
    // value. ngspice mos1load.c:698-703 uses the stored state0 vbs/vbd.
    const vbs_limited = s0[base + SLOT_VBS_OLD]; // pnjlim-limited Vbs (mos1load.c:698)
    const ceqbd = cbdI - gbd * vbd_stored;
    const ceqbs = cbsI - gbs * vbs_limited;
    stampRHS(solver, nodeD, -polarity * ceqbd);
    stampRHS(solver, nodeB, polarity * (ceqbd + ceqbs));
    stampRHS(solver, nodeS, -polarity * ceqbs);
  }

  override stamp(solver: SparseSolver): void {
    // Drain ohmic resistance RD between external drain pin and internal drain node
    if (this._p.RD > 0 && this.drainNode !== this._nodeDext) {
      const gRD = 1 / this._p.RD;
      stampG(solver, this._nodeDext, this._nodeDext, gRD);
      stampG(solver, this._nodeDext, this.drainNode, -gRD);
      stampG(solver, this.drainNode, this._nodeDext, -gRD);
      stampG(solver, this.drainNode, this.drainNode, gRD);
    }

    // Source ohmic resistance RS between external source pin and internal source node
    if (this._p.RS > 0 && this.sourceNode !== this._nodeSext) {
      const gRS = 1 / this._p.RS;
      stampG(solver, this._nodeSext, this._nodeSext, gRS);
      stampG(solver, this._nodeSext, this.sourceNode, -gRS);
      stampG(solver, this.sourceNode, this._nodeSext, -gRS);
      stampG(solver, this.sourceNode, this.sourceNode, gRS);
    }
  }

  override stampReactiveCompanion(solver: SparseSolver): void {
    // GS and GD gate overlap capacitances via base class
    super.stampReactiveCompanion(solver);

    const base = this.stateBaseOffset;
    const s0 = this._s0;

    // Gate-bulk overlap capacitance (CGBO * L)
    const capGeqGB = s0[base + SLOT_CAP_GEQ_GB];
    const capIeqGB = s0[base + SLOT_CAP_IEQ_GB];
    if (capGeqGB !== 0 || capIeqGB !== 0) {
      const nodeG = this.gateNode;
      const nodeB = this._nodeB;
      stampG(solver, nodeG, nodeG, capGeqGB);
      stampG(solver, nodeG, nodeB, -capGeqGB);
      stampG(solver, nodeB, nodeG, -capGeqGB);
      stampG(solver, nodeB, nodeB, capGeqGB);
      stampRHS(solver, nodeG, -capIeqGB);
      stampRHS(solver, nodeB, capIeqGB);
    }

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    // Drain-bulk junction capacitance. Convention: ngspice uses vbd (bulk-drain)
    // as the controlling voltage, so the Norton companion's positive terminal
    // is the BULK node. RHS stamp is therefore rhs[bulk] -= ceq, rhs[drain] += ceq.
    // Matches mos1load.c stamping of qbd companion.
    const capGeqDB = s0[base + SLOT_CAP_GEQ_DB];
    const capIeqDB = s0[base + SLOT_CAP_IEQ_DB];
    if (capGeqDB !== 0 || capIeqDB !== 0) {
      stampG(solver, nodeD, nodeD, capGeqDB);
      stampG(solver, nodeD, nodeB, -capGeqDB);
      stampG(solver, nodeB, nodeD, -capGeqDB);
      stampG(solver, nodeB, nodeB, capGeqDB);
      stampRHS(solver, nodeD, capIeqDB);
      stampRHS(solver, nodeB, -capIeqDB);
    }

    // Source-bulk junction capacitance. Same ngspice (+ = bulk) convention.
    const capGeqSB = s0[base + SLOT_CAP_GEQ_SB];
    const capIeqSB = s0[base + SLOT_CAP_IEQ_SB];
    if (capGeqSB !== 0 || capIeqSB !== 0) {
      stampG(solver, nodeS, nodeS, capGeqSB);
      stampG(solver, nodeS, nodeB, -capGeqSB);
      stampG(solver, nodeB, nodeS, -capGeqSB);
      stampG(solver, nodeB, nodeB, capGeqSB);
      stampRHS(solver, nodeS, capIeqSB);
      stampRHS(solver, nodeB, -capIeqSB);
    }
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      (this._p as unknown as Record<string, number>)[key] = value;
      this._recomputeTempParams();
    }
  }

  override checkConvergence(voltages: Float64Array, prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
    if (this._p.OFF && this._pool.initMode === "initFix") return true;
    return super.checkConvergence(voltages, prevVoltages, reltol, abstol);
  }

  primeJunctions(): void {
    if (this._p.OFF) {
      this._vgs = 0;
      this._vds = 0;
      const base = this.stateBaseOffset;
      this._s0[base + SLOT_VBS_OLD] = 0;
      this._s0[base + SLOT_VBD_OLD] = 0;
      this._vsb = 0;
    } else {
      this._vgs = this._tVto;
      this._vds = 0;
      const base = this.stateBaseOffset;
      this._s0[base + SLOT_VBS_OLD] = -1;
      this._s0[base + SLOT_VBD_OLD] = -1;
      this._vsb = 1;
    }
  }

  override stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array, order: number, deltaOld: readonly number[]): void {
    // Gate overlap capacitances (Cgs, Cgd) via base class
    super.stampCompanion(dt, method, voltages, order, deltaOld);

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeG = this.gateNode;
    const nodeB = this._nodeB;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vBulkV = nodeB > 0 ? voltages[nodeB - 1] : 0;

    const vdb = vD - vBulkV;
    const vsbCap = vS - vBulkV;
    const vgb = vG - vBulkV;

    const base = this.stateBaseOffset;
    const s0 = this._s0;

    const s1 = this.s1;

    s0[base + SLOT_V_DB] = vdb;
    s0[base + SLOT_V_SB] = vsbCap;
    s0[base + SLOT_V_GB] = vgb;

    const pb = this._tBulkPot;
    const mj = this._p.MJ;
    const mjsw = this._p.MJSW;

    const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
    const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;

    // Junction-cap formulas follow ngspice mos1load.c exactly, which uses
    // vbd = V_bulk - V_drain and vbs = V_bulk - V_source as the controlling
    // voltages. Prior code here used vdb/vsbCap (opposite sign) with ngspice's
    // formula shape, which is wrong: tDepCap guard fired on the wrong
    // polarity, the linear-extension branch was used for normal reverse-biased
    // operation, and the depletion formula (when taken) evaluated with a
    // flipped argument. SLOT_Q_DB / SLOT_Q_SB now hold ngspice's qbd / qbs
    // directly (bulk-drain / bulk-source charge), matching the harness
    // mapping one-to-one.
    const vbd = -vdb;           // = vBulkV - vD, ngspice convention
    const vbs = -vsbCap;        // = vBulkV - vS, ngspice convention

    // --- Drain-bulk junction capacitance (mos1load.c:629-669) ---
    const czbd = this._czbd;
    const czbdsw = this._czbdsw;
    if (czbd > 0 || czbdsw > 0) {
      let capbd: number;
      let qbd: number;
      if (vbd < this._tDepCap) {
        const argD = 1 - vbd / pb;
        const sargD = Math.exp(-mj * Math.log(argD));
        const sargswD = Math.exp(-mjsw * Math.log(argD));
        capbd = czbd * sargD + czbdsw * sargswD;
        qbd = pb * (czbd * (1 - argD * sargD) / (1 - mj)
          + czbdsw * (1 - argD * sargswD) / (1 - mjsw));
      } else {
        capbd = this._f2d + vbd * this._f3d;
        qbd = this._f4d + vbd * (this._f2d + vbd * this._f3d / 2);
      }
      s0[base + SLOT_Q_DB] = qbd;
      const q1_db = s1[base + SLOT_Q_DB];
      const q2_db = this.s2[base + SLOT_Q_DB];
      const ccapPrev_db = s1[base + SLOT_CCAP_DB];
      const resDB = integrateCapacitor(capbd, vbd, qbd, q1_db, q2_db, dt, h1, h2, order, method, ccapPrev_db);
      s0[base + SLOT_CAP_GEQ_DB] = resDB.geq;
      s0[base + SLOT_CAP_IEQ_DB] = resDB.ceq;
      s0[base + SLOT_CCAP_DB] = resDB.ccap;
    } else {
      s0[base + SLOT_CAP_GEQ_DB] = 0;
      s0[base + SLOT_CAP_IEQ_DB] = 0;
      s0[base + SLOT_CCAP_DB] = 0;
      s0[base + SLOT_Q_DB] = 0;
    }

    // --- Source-bulk junction capacitance (mos1load.c:569-614) ---
    const czbs = this._czbs;
    const czbssw = this._czbssw;
    if (czbs > 0 || czbssw > 0) {
      let capbs: number;
      let qbs: number;
      if (vbs < this._tDepCap) {
        const argS = 1 - vbs / pb;
        const sargS = Math.exp(-mj * Math.log(argS));
        const sargswS = Math.exp(-mjsw * Math.log(argS));
        capbs = czbs * sargS + czbssw * sargswS;
        qbs = pb * (czbs * (1 - argS * sargS) / (1 - mj)
          + czbssw * (1 - argS * sargswS) / (1 - mjsw));
      } else {
        capbs = this._f2s + vbs * this._f3s;
        qbs = this._f4s + vbs * (this._f2s + vbs * this._f3s / 2);
      }
      s0[base + SLOT_Q_SB] = qbs;
      const q1_sb = s1[base + SLOT_Q_SB];
      const q2_sb = this.s2[base + SLOT_Q_SB];
      const ccapPrev_sb = s1[base + SLOT_CCAP_SB];
      const resSB = integrateCapacitor(capbs, vbs, qbs, q1_sb, q2_sb, dt, h1, h2, order, method, ccapPrev_sb);
      s0[base + SLOT_CAP_GEQ_SB] = resSB.geq;
      s0[base + SLOT_CAP_IEQ_SB] = resSB.ceq;
      s0[base + SLOT_CCAP_SB] = resSB.ccap;
    } else {
      s0[base + SLOT_CAP_GEQ_SB] = 0;
      s0[base + SLOT_CAP_IEQ_SB] = 0;
      s0[base + SLOT_CCAP_SB] = 0;
      s0[base + SLOT_Q_SB] = 0;
    }

    // --- Gate-bulk capacitance: Meyer capgb + CGBO overlap (mos1load.c:753-775) ---
    const p = this._p;
    const ld = p.LD ?? 0;
    const effectiveLength = p.L - 2 * ld;
    const oxideCap = p.TOX > 0 ? (EPS_OX * EPS0 / p.TOX) * effectiveLength * p.W : 0;
    const gbOverlap = (p.CGBO ?? 0) * effectiveLength;

    if (oxideCap > 0 || gbOverlap > 0) {
      // Compute Meyer capgb for gate-bulk.
      // mos1load.c:773-784: DEVqmeyer receives the pnjlim/fetlim-limited vgs and
      // vgd (stored in CKTstate0), not raw node voltages. Use this._vgs (limited)
      // and this._vgs - this._vds (= limited vgd) to match ngspice exactly.
      const vgsM = this._vgs; // pnjlim/fetlim-limited Vgs (mos1load.c:774)
      const vgdM = this._vgs - this._vds; // limited Vgd = Vgs - Vds (mos1load.c:774)
      const mode = this._swapped ? -1 : 1;
      let meyerCapgb: number;
      if (mode > 0) {
        const meyer = devQmeyer(vgsM, vgdM, vgb, this._s0[this.stateBaseOffset + SLOT_VON] || this._tVto, this._lastVdsat, this._tPhi, oxideCap);
        meyerCapgb = meyer.capgb;
      } else {
        const meyer = devQmeyer(vgdM, vgsM, vgb, this._s0[this.stateBaseOffset + SLOT_VON] || this._tVto, this._lastVdsat, this._tPhi, oxideCap);
        meyerCapgb = meyer.capgb;
      }
      s0[base + SLOT_MEYER_GB] = meyerCapgb;
      const prevMeyerGb = this.s1[base + SLOT_MEYER_GB];
      const totalGb = (this._pool.initMode === "initTran" ? 2 * meyerCapgb : meyerCapgb + prevMeyerGb) + gbOverlap;
      const qgb = totalGb * vgb;
      const q1_gb = s1[base + SLOT_Q_GB];
      const q2_gb = this.s2[base + SLOT_Q_GB];
      const ccapPrev_gb = s1[base + SLOT_CCAP_GB];
      const resGB = integrateCapacitor(totalGb, vgb, qgb, q1_gb, q2_gb, dt, h1, h2, order, method, ccapPrev_gb);
      s0[base + SLOT_CAP_GEQ_GB] = resGB.geq;
      s0[base + SLOT_CAP_IEQ_GB] = resGB.ceq;
      s0[base + SLOT_CCAP_GB] = resGB.ccap;
      s0[base + SLOT_Q_GB] = qgb;
    } else {
      s0[base + SLOT_CAP_GEQ_GB] = 0;
      s0[base + SLOT_CAP_IEQ_GB] = 0;
      s0[base + SLOT_CCAP_GB] = 0;
    }

    // ngspice mos1load.c:842-853 — zero gate-bulk cap companions during MODEINITTRAN
    if (this._pool.initMode === "initTran") {
      s0[base + SLOT_CAP_GEQ_GB] = 0;
      s0[base + SLOT_CAP_IEQ_GB] = 0;
      s0[base + SLOT_CCAP_GB] = 0;
      s0[base + SLOT_CCAP_DB] = 0;
      s0[base + SLOT_CCAP_SB] = 0;
    }
  }

  override updateChargeFlux(voltages: Float64Array, dt: number, method: IntegrationMethod, order: number, deltaOld: readonly number[]): void {
    // GS and GD charges via base class
    super.updateChargeFlux(voltages, dt, method, order, deltaOld);

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeG = this.gateNode;
    const nodeB = this._nodeB;

    const vD = nodeD > 0 ? voltages[nodeD - 1] : 0;
    const vS = nodeS > 0 ? voltages[nodeS - 1] : 0;
    const vG = nodeG > 0 ? voltages[nodeG - 1] : 0;
    const vBulkV = nodeB > 0 ? voltages[nodeB - 1] : 0;

    const vdb = vD - vBulkV;
    const vsbCap = vS - vBulkV;
    const vgb = vG - vBulkV;

    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const s1 = this.s1;

    const p = this._p;
    const ld = p.LD ?? 0;
    const effectiveLength = p.L - 2 * ld;
    const oxideCap = p.TOX > 0 ? (EPS_OX * EPS0 / p.TOX) * effectiveLength * p.W : 0;
    const gbOverlap = (p.CGBO ?? 0) * effectiveLength;

    if (oxideCap > 0 || gbOverlap > 0) {
      // mos1load.c:773-784: use pnjlim/fetlim-limited vgs/vgd (same as stampCompanion)
      const vgsM = this._vgs; // pnjlim/fetlim-limited Vgs (mos1load.c:774)
      const vgdM = this._vgs - this._vds; // limited Vgd (mos1load.c:774)
      const mode = this._swapped ? -1 : 1;
      let meyerCapgb: number;
      if (mode > 0) {
        const meyer = devQmeyer(vgsM, vgdM, vgb, this._s0[this.stateBaseOffset + SLOT_VON] || this._tVto, this._lastVdsat, this._tPhi, oxideCap);
        meyerCapgb = meyer.capgb;
      } else {
        const meyer = devQmeyer(vgdM, vgsM, vgb, this._s0[this.stateBaseOffset + SLOT_VON] || this._tVto, this._lastVdsat, this._tPhi, oxideCap);
        meyerCapgb = meyer.capgb;
      }
      const prevMeyerGbU = s1[base + SLOT_MEYER_GB];
      const isFirstCallU = this._pool.initMode === "initTran";
      const totalGb = (isFirstCallU ? 2 * meyerCapgb : meyerCapgb + prevMeyerGbU) + gbOverlap;
      const prevVgb = s1[base + SLOT_V_GB];
      const prevQgb = s1[base + SLOT_Q_GB];
      if (isFirstCallU) {
        s0[base + SLOT_Q_GB] = totalGb * vgb;
      } else {
        s0[base + SLOT_Q_GB] = totalGb * (vgb - prevVgb) + prevQgb;
      }
      s0[base + SLOT_V_GB] = vgb;
    } else {
      s0[base + SLOT_Q_GB] = 0;
      s0[base + SLOT_V_GB] = vgb;
    }

    // Recompute Q_DB and Q_SB from converged voltages, then recompute ccap for
    // GB/DB/SB so the next step's trapezoidal recursion starts from the correct
    // companion current (fixes stale CCAP slots). Uses ngspice vbd/vbs
    // convention to match stampCompanion above.
    if (dt > 0) {
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      const vbd = -vdb;
      const vbs = -vsbCap;

      // Drain-bulk charge recomputation
      const czbd = this._czbd;
      const czbdsw = this._czbdsw;
      if (czbd > 0 || czbdsw > 0) {
        const pb = this._tBulkPot;
        const mj = this._p.MJ;
        const mjsw = this._p.MJSW;
        let capbd: number;
        let qbd: number;
        if (vbd < this._tDepCap) {
          const argD = 1 - vbd / pb;
          const sargD = Math.exp(-mj * Math.log(argD));
          const sargswD = Math.exp(-mjsw * Math.log(argD));
          capbd = czbd * sargD + czbdsw * sargswD;
          qbd = pb * (czbd * (1 - argD * sargD) / (1 - mj)
            + czbdsw * (1 - argD * sargswD) / (1 - mjsw));
        } else {
          capbd = this._f2d + vbd * this._f3d;
          qbd = this._f4d + vbd * (this._f2d + vbd * this._f3d / 2);
        }
        s0[base + SLOT_Q_DB] = qbd;
        const q1_db = s1[base + SLOT_Q_DB];
        const q2_db = this.s2[base + SLOT_Q_DB];
        const ccapPrev_db = s1[base + SLOT_CCAP_DB];
        const resDB = integrateCapacitor(capbd, vbd, qbd, q1_db, q2_db, dt, h1, h2, order, method, ccapPrev_db);
        s0[base + SLOT_CCAP_DB] = resDB.ccap;
      }

      // Source-bulk charge recomputation
      const czbs = this._czbs;
      const czbssw = this._czbssw;
      if (czbs > 0 || czbssw > 0) {
        const pb = this._tBulkPot;
        const mj = this._p.MJ;
        const mjsw = this._p.MJSW;
        let capbs: number;
        let qbs: number;
        if (vbs < this._tDepCap) {
          const argS = 1 - vbs / pb;
          const sargS = Math.exp(-mj * Math.log(argS));
          const sargswS = Math.exp(-mjsw * Math.log(argS));
          capbs = czbs * sargS + czbssw * sargswS;
          qbs = pb * (czbs * (1 - argS * sargS) / (1 - mj)
            + czbssw * (1 - argS * sargswS) / (1 - mjsw));
        } else {
          capbs = this._f2s + vbs * this._f3s;
          qbs = this._f4s + vbs * (this._f2s + vbs * this._f3s / 2);
        }
        s0[base + SLOT_Q_SB] = qbs;
        const q1_sb = s1[base + SLOT_Q_SB];
        const q2_sb = this.s2[base + SLOT_Q_SB];
        const ccapPrev_sb = s1[base + SLOT_CCAP_SB];
        const resSB = integrateCapacitor(capbs, vbs, qbs, q1_sb, q2_sb, dt, h1, h2, order, method, ccapPrev_sb);
        s0[base + SLOT_CCAP_SB] = resSB.ccap;
      }

      // Gate-bulk ccap recomputation
      const q0_gb = s0[base + SLOT_Q_GB];
      if (q0_gb !== 0 || s1[base + SLOT_Q_GB] !== 0) {
        const q1_gb = s1[base + SLOT_Q_GB];
        const q2_gb = this.s2[base + SLOT_Q_GB];
        const ccapPrev_gb = s1[base + SLOT_CCAP_GB];
        const meyerGbNow = s0[base + SLOT_MEYER_GB];
        const meyerGbPrev = s1[base + SLOT_MEYER_GB];
        const isFirstCallU2 = this._pool.initMode === "initTran";
        const totalGbRecalc = (isFirstCallU2 ? 2 * meyerGbNow : meyerGbNow + meyerGbPrev) + gbOverlap;
        if (totalGbRecalc > 0) {
          const resGB = integrateCapacitor(totalGbRecalc, vgb, q0_gb, q1_gb, q2_gb, dt, h1, h2, order, method, ccapPrev_gb);
          s0[base + SLOT_CCAP_GB] = resGB.ccap;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LTE estimation — ngspice CKTterr on gate charge quantities Qgs, Qgd, Qgb
  // ---------------------------------------------------------------------------

  override getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    // GS + GD from base class
    let minDt = super.getLteTimestep(dt, deltaOld, order, method, lteParams);

    const base = this.stateBaseOffset;
    const s0 = this._s0;
    const s1 = this.s1;
    const s2 = this.s2;
    const s3 = this.s3;

    // Gate-bulk
    {
      const ccap0 = s0[base + SLOT_CCAP_GB];
      const ccap1 = s1[base + SLOT_CCAP_GB];
      const q0 = s0[base + SLOT_Q_GB];
      const q1 = s1[base + SLOT_Q_GB];
      const q2 = s2[base + SLOT_Q_GB];
      const q3 = s3[base + SLOT_Q_GB];
      const dtGB = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (dtGB < minDt) minDt = dtGB;
    }

    return minDt;
  }

}

// ---------------------------------------------------------------------------
// createMosfetElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createMosfetElement(
  polarity: 1 | -1,
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  kpDefault: number = 2e-5,
): MosfetAnalogElement {
  const nodeG = pinNodes.get("G")!; // gate
  const nodeS = pinNodes.get("S")!; // source
  const nodeD = pinNodes.get("D")!; // drain

  const rawRD = props.hasModelParam("RD") ? props.getModelParam<number>("RD") : 0;
  const rawRS = props.hasModelParam("RS") ? props.getModelParam<number>("RS") : 0;

  // 3-terminal MOSFET: bulk is always tied to source (no separate bulk pin).
  // Internal nodes are only allocated for RD/RS series resistances.
  const nodeB = nodeS;
  let intIdx = 0;
  const nodeDint = rawRD > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeD;
  const nodeSint = rawRS > 0 && internalNodeIds.length > intIdx ? internalNodeIds[intIdx++] : nodeS;

  /** Read a model param, returning `fallback` if the key is absent (backward compat). */
  function mp(key: string, fallback: number): number {
    return props.hasModelParam(key) ? props.getModelParam<number>(key) : fallback;
  }

  const rawParams: MosfetParams = {
    VTO:    props.getModelParam<number>("VTO"),
    KP:     props.getModelParam<number>("KP"),
    LAMBDA: props.getModelParam<number>("LAMBDA"),
    PHI:    props.getModelParam<number>("PHI"),
    GAMMA:  props.getModelParam<number>("GAMMA"),
    CBD:    mp("CBD", 0),
    CBS:    mp("CBS", 0),
    CGDO:   mp("CGDO", 0),
    CGSO:   mp("CGSO", 0),
    CGBO:   mp("CGBO", 0),
    W:      props.getModelParam<number>("W"),
    L:      props.getModelParam<number>("L"),
    RD:     rawRD,
    RS:     rawRS,
    IS:     mp("IS", 1e-14),
    PB:     mp("PB", 0.8),
    CJ:     mp("CJ", 0),
    MJ:     mp("MJ", 0.5),
    CJSW:   mp("CJSW", 0),
    MJSW:   mp("MJSW", 0.5),
    JS:     mp("JS", 0),
    RSH:    mp("RSH", 0),
    AD:     mp("AD", 0),
    AS:     mp("AS", 0),
    PD:     mp("PD", 0),
    PS:     mp("PS", 0),
    TNOM:   mp("TNOM", 300.15),
    TOX:    mp("TOX", 1e-7),
    NSUB:   mp("NSUB", 0),
    NSS:    mp("NSS", 0),
    TPG:    mp("TPG", 1),
    LD:     mp("LD", 0),
    UO:     mp("UO", 600),
    KF:     mp("KF", 0),
    AF:     mp("AF", 1),
    FC:     mp("FC", 0.5),
    M:      mp("M", 1),
    OFF:    mp("OFF", 0),
  };

  const p = resolveParams(rawParams, kpDefault);

  return new MosfetAnalogElement(polarity, nodeD, nodeG, nodeS, nodeB, p, nodeDint, nodeSint);
}

// ---------------------------------------------------------------------------
// getMosfetInternalNodeCount — bulk node + optional RD/RS internal nodes
// ---------------------------------------------------------------------------

/**
 * Returns the number of internal nodes needed for this MOSFET instance.
 *
 * Always 1 for the bulk node, plus 1 for RD > 0, plus 1 for RS > 0.
 */
export function getMosfetInternalNodeCount(props: PropertyBag): number {
  let count = 0; // 3-terminal: bulk = source, no internal node needed
  if (props.hasModelParam("RD") && props.getModelParam<number>("RD") > 0) count++;
  if (props.hasModelParam("RS") && props.getModelParam<number>("RS") > 0) count++;
  return count;
}

// ---------------------------------------------------------------------------
// getMosfetInternalNodeLabels — mirror of getMosfetInternalNodeCount
// ---------------------------------------------------------------------------

/**
 * Returns internal node labels for a MOSFET instance. Order MUST match
 * getMosfetInternalNodeCount / createMosfetElement's internalNodeIds
 * consumption: D' first (for RD > 0), then S' (for RS > 0).
 */
export function getMosfetInternalNodeLabels(props: PropertyBag): readonly string[] {
  const labels: string[] = [];
  if (props.hasModelParam("RD") && props.getModelParam<number>("RD") > 0) labels.push("D'");
  if (props.hasModelParam("RS") && props.getModelParam<number>("RS") > 0) labels.push("S'");
  return labels;
}

// ---------------------------------------------------------------------------
// NmosfetElement + PmosfetElement — CircuitElement implementations
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

    // Body (channel segments, gate bar, body connection line, arrow) stays COMPONENT color
    // Channel segments (with gap in middle for depletion-mode styling)
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);

    // Stub extensions at drain/source sides
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);

    // Gate bar
    ctx.drawLine(gateBarX, -0.5, gateBarX, 0.5);

    // Body connection line (channel to body node)
    ctx.drawLine(chanX, 0, 2.625, 0);

    // Arrow (pointing inward for N-channel)
    ctx.drawPolygon([
      { x: 2.625, y: 0 },
      { x: 3.375, y: 0.3125 },
      { x: 3.375, y: -0.3125 },
    ], true);

    // Gate lead (horizontal from pin to gate bar)
    drawColoredLead(ctx, signals, vG, 0, 0, gateBarX, 0);

    // Drain lead (horizontal stub from channel to drain pin)
    drawColoredLead(ctx, signals, vD, 4, -1, chanX, -1);

    // Source lead (horizontal stub + vertical to body + body horizontal)
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

    // Line 1: D lead (signal D color)
    drawColoredLead(ctx, signals, vD, 4, 1, chanX, 1);

    // Line 2: S stub horizontal (signal S color)
    drawColoredLead(ctx, signals, vS, 4, -1, chanX, -1);

    // Lines 3-6: channel segments (COMPONENT color)
    ctx.setColor("COMPONENT");
    ctx.drawLine(chanX, 1, chanX, 0.6875);
    ctx.drawLine(chanX, 0.3125, chanX, 0);
    ctx.drawLine(chanX, 0, chanX, -0.3125);
    ctx.drawLine(chanX, -0.6875, chanX, -1);

    // Lines 7-8: extended stubs beyond D/S (COMPONENT color)
    ctx.drawLine(chanX, 1, chanX, 1.3125);
    ctx.drawLine(chanX, -1, chanX, -1.3125);

    // Lines 9-10: S body vertical + horizontal (signal S color)
    drawColoredLead(ctx, signals, vS, 4, -1, 4, 0);
    ctx.drawLine(4, 0, chanX, 0);

    // Line 11: arrow (COMPONENT color)
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 4, y: 0 },
      { x: 3.25, y: -0.3125 },
      { x: 3.25, y: 0.3125 },
    ], true);

    // Line 12: gate lead (signal G color)
    drawColoredLead(ctx, signals, vG, 0, 0, gateBarX, 0);

    // Line 13: gate bar (COMPONENT color)
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

function buildPmosPinDeclarations(): PinDeclaration[] {
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
      label: "D",
      defaultBitWidth: 1,
      position: { x: 4.0, y: 1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "S",
      defaultBitWidth: 1,
      position: { x: 4.0, y: -1.0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MOSFET_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const MOSFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  { xmlName: "W", propertyKey: "W", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "L", propertyKey: "L", convert: (v) => parseFloat(v), modelParam: true },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
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
