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
import { fetlim, limvds } from "../../solver/analog/newton-raphson.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { AbstractFetElement } from "../../solver/analog/fet-base.js";
import type { FetCapacitances } from "../../solver/analog/fet-base.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

/** Boltzmann's constant (J/K). */
const KB = 1.38064852e-23;
/** Elementary charge (C). */
const Q = 1.60217663e-19;
/** Permittivity of free space (F/m). */
const EPS0 = 8.854187817e-12;
/** Relative permittivity of SiO2. */
const EPS_OX = 3.9;
/** Relative permittivity of Si. */
const EPS_SI = 11.7;
/** Intrinsic carrier concentration of Si at 300K (cm⁻³). */
const NI = 1.45e10;
/** Thermal voltage at 300K (V). */
const VT = KB * 300 / Q;

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
  TOX: number;
  NSUB: number;
  NSS: number;
  TPG: number;
  LD: number;
  UO: number;
  KF: number;
  AF: number;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: MOSFET_NMOS_PARAM_DEFS, defaults: MOSFET_NMOS_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: 1.0,  unit: "V",      description: "Threshold voltage" },
    KP:     { default: 2e-5, unit: "A/V²",   description: "Process transconductance parameter" },
    LAMBDA: { default: 0.01, unit: "1/V",    description: "Channel-length modulation" },
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
    MJSW:   { default: 0.33,                 description: "Bulk junction sidewall grading coefficient" },
    JS:     { default: 0,    unit: "A/m²",   description: "Bulk junction saturation current density" },
    RSH:    { default: 0,    unit: "Ω/sq",   description: "Drain/source diffusion sheet resistance" },
    TOX:    { default: 1e-7, unit: "m",      description: "Oxide thickness" },
    NSUB:   { default: 0,    unit: "cm⁻³",   description: "Substrate doping" },
    NSS:    { default: 0,    unit: "cm⁻²",   description: "Surface state density" },
    TPG:    { default: 1,                    description: "Gate type: 1=opposite, -1=same, 0=Al gate" },
    LD:     { default: 0,    unit: "m",      description: "Lateral diffusion" },
    UO:     { default: 600,  unit: "cm²/Vs", description: "Surface mobility" },
    KF:     { default: 0,                    description: "Flicker noise coefficient" },
    AF:     { default: 1,                    description: "Flicker noise exponent" },
    FC:     { default: 0.5,                  description: "Forward-bias depletion capacitance coefficient" },
  },
});

// ---------------------------------------------------------------------------
// Built-in NMOS model presets
// Sources: ON Semi MODPEX 2004, Zetex 1985, IR/Symmetry MODPEX 1996
// All values extracted from published .SUBCKT Level 1 .MODEL MM NMOS lines.
// ---------------------------------------------------------------------------

/** Small signal NMOS (TO-92, 60V/200mA). Source: ON Semi 2N7000.REV0.LIB (Symmetry MODPEX 2004-03-31). */
const NMOS_2N7000: Record<string, number> = {
  VTO: 2.236, KP: 0.0932174, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.0724e-11, CGSO: 1.79115e-7,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

/** Small signal NMOS (TO-92, 60V/500mA). Source: Zetex BS170/ZTX model (rev 12/85). */
const NMOS_BS170: Record<string, number> = {
  VTO: 1.824, KP: 0.1233, LAMBDA: 0, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 35e-12, CBS: 0, CGDO: 3e-12, CGSO: 28e-12,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

/** Medium power NMOS (TO-220, 100V/17A). Source: IR irf530n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRF530N: Record<string, number> = {
  VTO: 3.63019, KP: 17.6091, LAMBDA: 0.00363922, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.4372e-7, CGSO: 5.59846e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

/** High power NMOS (TO-220, 100V/33A). Source: IR irf540n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRF540N: Record<string, number> = {
  VTO: 3.55958, KP: 28.379, LAMBDA: 0.000888191, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1.77276e-8, CGSO: 1.23576e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

/** High power NMOS (TO-220, 55V/49A). Source: IR irfz44n_IR (Symmetry MODPEX 1996-04-24). */
const NMOS_IRFZ44N: Record<string, number> = {
  VTO: 3.56214, KP: 39.3974, LAMBDA: 0, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 2.2826e-7, CGSO: 1.25255e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 600, KF: 0, AF: 1, FC: 0.5,
};

export const { paramDefs: MOSFET_PMOS_PARAM_DEFS, defaults: MOSFET_PMOS_DEFAULTS } = defineModelParams({
  primary: {
    VTO:    { default: -1.0, unit: "V",      description: "Threshold voltage" },
    KP:     { default: 1e-5, unit: "A/V²",   description: "Process transconductance parameter" },
    LAMBDA: { default: 0.01, unit: "1/V",    description: "Channel-length modulation" },
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
    MJSW:   { default: 0.33,                 description: "Bulk junction sidewall grading coefficient" },
    JS:     { default: 0,    unit: "A/m²",   description: "Bulk junction saturation current density" },
    RSH:    { default: 0,    unit: "Ω/sq",   description: "Drain/source diffusion sheet resistance" },
    TOX:    { default: 1e-7, unit: "m",      description: "Oxide thickness" },
    NSUB:   { default: 0,    unit: "cm⁻³",   description: "Substrate doping" },
    NSS:    { default: 0,    unit: "cm⁻²",   description: "Surface state density" },
    TPG:    { default: 1,                    description: "Gate type: 1=opposite, -1=same, 0=Al gate" },
    LD:     { default: 0,    unit: "m",      description: "Lateral diffusion" },
    UO:     { default: 250,  unit: "cm²/Vs", description: "Surface mobility (PMOS default 250)" },
    KF:     { default: 0,                    description: "Flicker noise coefficient" },
    AF:     { default: 1,                    description: "Flicker noise exponent" },
    FC:     { default: 0.5,                  description: "Forward-bias depletion capacitance coefficient" },
  },
});

// ---------------------------------------------------------------------------
// Built-in PMOS model presets
// Sources: Zetex/Diodes Inc., IR/Symmetry MODPEX (KiCad-Spice-Library irf.lib)
// All values extracted from published .SUBCKT Level 1 .MODEL MM PMOS lines.
// ---------------------------------------------------------------------------

/** Small signal PMOS (TO-92, -45V/230mA). Source: Zetex/Diodes Inc. BS250P v1.0 (2003-03-19). */
const PMOS_BS250: Record<string, number> = {
  VTO: -3.193, KP: 0.277, LAMBDA: 0.012, W: 1e-6, L: 1e-6,
  PHI: 0.6, GAMMA: 0, CBD: 105e-12, CBS: 0, CGDO: 0, CGSO: 0,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
};

/** Medium power PMOS (TO-220, -100V/6.8A). Source: IR irf9520_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRF9520: Record<string, number> = {
  VTO: -3.41185, KP: 3.46967, LAMBDA: 0.0289226, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 3.45033e-6,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
};

/** High power PMOS (TO-247, -200V/12A). Source: IR irfp9240_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRFP9240: Record<string, number> = {
  VTO: -3.67839, KP: 6.41634, LAMBDA: 0.0117285, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 1.08446e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
};

/** High power PMOS (TO-220, -100V/40A). Source: IR irf5210_IR (KiCad-Spice-Library irf.lib). */
const PMOS_IRF5210: Record<string, number> = {
  VTO: -3.79917, KP: 12.9564, LAMBDA: 0.00220079, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 2.34655e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
};

/** High power PMOS (TO-220, -55V/74A). Source: IR irf4905_IR (ngspice/KiCad-Spice-Library). */
const PMOS_IRF4905: Record<string, number> = {
  VTO: -3.53713, KP: 23.3701, LAMBDA: 0.00549383, W: 100e-6, L: 100e-6,
  PHI: 0.6, GAMMA: 0, CBD: 0, CBS: 0, CGDO: 1e-11, CGSO: 2.84439e-5,
  CGBO: 0, RD: 0, RS: 0, IS: 1e-14, PB: 0.8,
  CJ: 0, MJ: 0.5, CJSW: 0, MJSW: 0.33, JS: 0, RSH: 0,
  TOX: 1e-7, NSUB: 0, NSS: 0, TPG: 1, LD: 0, UO: 250, KF: 0, AF: 1, FC: 0.5,
};

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
    MJSW: raw.MJSW ?? 0.33,
    JS:   raw.JS   ?? 0,
    RSH:  raw.RSH  ?? 0,
    FC:   raw.FC   ?? 0.5,
    TOX:  raw.TOX  ?? 1e-7,
    NSUB: raw.NSUB ?? 0,
    NSS:  raw.NSS  ?? 0,
    TPG:  raw.TPG  ?? 1,
    LD:   raw.LD   ?? 0,
    UO:   raw.UO   ?? 600,
    KF:   raw.KF   ?? 0,
    AF:   raw.AF   ?? 1,
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

  // Area-based junction capacitance: CJ per unit area, CJSW per unit perimeter
  // Approximate AD ≈ W*L, PD ≈ 2*(W+L) since we don't have layout info
  if (p.CJ > 0) {
    const ad = p.W * p.L;
    const pd = 2 * (p.W + p.L);
    if (p.CBD === 0) {
      p.CBD = p.CJ * ad + p.CJSW * pd;
    }
    if (p.CBS === 0) {
      p.CBS = p.CJ * ad + p.CJSW * pd;
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// computeIds — drain current for three operating regions
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET drain-source current and threshold voltage.
 *
 * @param vgs  - Gate-source voltage (polarity-corrected)
 * @param vds  - Drain-source voltage (polarity-corrected, always >= 0 after swap)
 * @param vsb  - Source-bulk voltage (polarity-corrected, >= 0 for NMOS)
 * @param p    - Resolved model parameters
 * @returns    - { ids, vth } drain current and threshold voltage
 */
export function computeIds(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): { ids: number; vth: number } {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));

  const vgst = vgs - vth;

  if (vgst <= 0) {
    return { ids: 0, vth };
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear (triode) region: Vds < Vgs - Vth
    const ids = p.KP * wl * ((vgst * vds) - (vds * vds) / 2) * (1 + lambda * vds);
    return { ids, vth };
  } else {
    // Saturation region: Vds >= Vgs - Vth
    const ids = (p.KP / 2) * wl * vgst * vgst * (1 + lambda * vds);
    return { ids, vth };
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
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return GMIN;
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear: dId/dVgs = KP*(W/L)*Vds*(1+LAMBDA*Vds)
    return p.KP * wl * vds * (1 + lambda * vds) + GMIN;
  } else {
    // Saturation: dId/dVgs = KP*(W/L)*(Vgs-Vth)*(1+LAMBDA*Vds)
    return p.KP * wl * vgst * (1 + lambda * vds) + GMIN;
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
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0) {
    return GMIN;
  }

  const wl = p.W / p.L;
  const lambda = p.LAMBDA;

  if (vds < vgst) {
    // Linear: dId/dVds = KP*(W/L)*(Vgs-Vth - Vds)*(1+LAMBDA*Vds) + KP*(W/L)*((Vgs-Vth)*Vds - Vds²/2)*LAMBDA
    const term1 = p.KP * wl * (vgst - vds) * (1 + lambda * vds);
    const term2 = p.KP * wl * (vgst * vds - vds * vds / 2) * lambda;
    return term1 + term2 + GMIN;
  } else {
    // Saturation: dId/dVds = KP/2*(W/L)*(Vgs-Vth)²*LAMBDA
    return (p.KP / 2) * wl * vgst * vgst * lambda + GMIN;
  }
}

// ---------------------------------------------------------------------------
// computeGmbs — bulk transconductance dId/dVbs
// ---------------------------------------------------------------------------

/**
 * Compute MOSFET bulk transconductance gmbs = dId/dVbs.
 *
 * Body effect modulates threshold: dVth/dVbs = -GAMMA/(2*sqrt(PHI+Vsb))
 * gmbs = -gm * dVth/dVsb = gm * GAMMA / (2*sqrt(PHI+Vsb))
 */
export function computeGmbs(
  vgs: number,
  vds: number,
  vsb: number,
  p: MosfetParams,
): number {
  const phi = Math.max(p.PHI, 0.1);
  const vsbSafe = Math.max(vsb, 0);
  const vth = p.VTO + p.GAMMA * (Math.sqrt(phi + vsbSafe) - Math.sqrt(phi));
  const vgst = vgs - vth;

  if (vgst <= 0 || p.GAMMA <= 0) {
    return 0;
  }

  const gm = computeGm(vgs, vds, vsb, p);
  const dVthdVsb = p.GAMMA / (2 * Math.sqrt(phi + vsbSafe));
  return gm * dVthdVsb;
}

// ---------------------------------------------------------------------------
// limitVoltages — fetlim on Vgs with source/drain swap detection
// ---------------------------------------------------------------------------

/**
 * Apply fetlim() voltage limiting to Vgs, and handle source/drain swap.
 *
 * A symmetric MOSFET can have its source and drain swapped if Vds < 0.
 * In that case we swap so that the mathematical source (lower potential) is
 * always used for Vgs computation.
 */
export function limitVoltages(
  vgsOld: number,
  vgsNew: number,
  vdsOld: number,
  vdsNew: number,
  vto: number,
): { vgs: number; vds: number; swapped: boolean } {
  let vgs = fetlim(vgsNew, vgsOld, vto);
  let vds = vdsNew;
  let swapped = false;

  // Source/drain swap: if Vds < 0, the drain and source roles are reversed
  if (vds < 0) {
    vds = -vds;
    vgs = vgs - vdsNew; // Vgd becomes the new Vgs
    swapped = true;
  }

  // Apply SPICE3f5 Vds limiting after source/drain swap
  vds = limvds(vds, Math.abs(vdsOld));

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
    cgb: (p.CGBO ?? 0) * p.L,
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
// MosfetAnalogElement — AbstractFetElement subclass
// ---------------------------------------------------------------------------

/**
 * Concrete FET analog element for MOSFET (N-channel or P-channel).
 *
 * Extends AbstractFetElement with the Level 2 SPICE MOSFET I-V model,
 * body effect, junction/overlap capacitances, and source/drain swap detection.
 */
class MosfetAnalogElement extends AbstractFetElement {
  readonly polaritySign: 1 | -1;

  private readonly _p: ResolvedMosfetParams;
  private readonly _nodeB: number;

  // Body-effect state
  private _vsb: number = 0;
  private _gmbs: number = 0;

  // Junction capacitance companion model state (drain-bulk and source-bulk)
  private _capGeqDB: number = 0;
  private _capIeqDB: number = 0;
  private _capGeqSB: number = 0;
  private _capIeqSB: number = 0;
  private _vdbPrev: number = NaN;
  private _vsbCapPrev: number = NaN;
  private _capJunctionFirstCall: boolean = true;

  // Gate-bulk overlap capacitance companion model state
  private _capGeqGB: number = 0;
  private _capIeqGB: number = 0;
  private _vgbPrev: number = NaN;
  private _capGbFirstCall: boolean = true;

  private readonly _nodeDext: number;
  private readonly _nodeSext: number;

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

    const caps = computeCapacitances(p);
    const hasCaps = caps.cbd > 0 || caps.cbs > 0 || caps.cgs > 0 || caps.cgd > 0 || caps.cgb > 0;
    this._initReactive(hasCaps);
  }

  limitVoltages(
    vgsOld: number,
    _vdsOld: number,
    vgsNew: number,
    vdsNew: number,
  ): { vgs: number; vds: number; swapped: boolean } {
    return limitVoltages(vgsOld, vgsNew, _vdsOld, vdsNew, this._p.VTO);
  }

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

  computeCapacitances(_vgs: number, _vds: number): FetCapacitances {
    const caps = computeCapacitances(this._p);
    return { cgs: caps.cgs, cgd: caps.cgd };
  }

  override updateOperatingPoint(voltages: Readonly<Float64Array>): void {
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

    // Voltage limiting on Vgs via fetlim: (vgsOld, vgsNew, vdsOld, vdsNew, vto)
    const limited = limitVoltages(this._vgs, vGraw, this._vds, vDraw, this._p.VTO);
    this._vgs = limited.vgs;
    this._vds = limited.vds;
    this._swapped = limited.swapped;

    // Source-bulk voltage (body effect): Vsb = Vs - Vb (always >= 0 for normal bias)
    this._vsb = Math.max(-vBraw, 0);

    // Recompute operating point at limited voltages
    const result = computeIds(this._vgs, this._vds, this._vsb, this._p);
    this._ids = result.ids;
    this._gm = computeGm(this._vgs, this._vds, this._vsb, this._p);
    this._gds = computeGds(this._vgs, this._vds, this._vsb, this._p);
    this._gmbs = computeGmbs(this._vgs, this._vds, this._vsb, this._p);
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

    // Norton current sources (KCL at drain and source)
    // Signed by polarity: positive Id flows from D to S in NMOS
    const vbsOp = -this._vsb; // Vbs = -Vsb
    const nortonId = this.polaritySign * (this._ids - this._gm * this._vgs - this._gds * this._vds - this._gmbs * vbsOp) * this._sourceScale;

    stampRHS(solver, effectiveD, -nortonId);
    stampRHS(solver, effectiveS, nortonId);
  }

  override stamp(solver: SparseSolver): void {
    // Stamp base gate overlap capacitances (Cgs, Cgd)
    super.stamp(solver);

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

    // Gate-bulk overlap capacitance (CGBO * L)
    if (this._capGeqGB !== 0 || this._capIeqGB !== 0) {
      const nodeG = this.gateNode;
      const nodeB = this._nodeB;
      stampG(solver, nodeG, nodeG, this._capGeqGB);
      stampG(solver, nodeG, nodeB, -this._capGeqGB);
      stampG(solver, nodeB, nodeG, -this._capGeqGB);
      stampG(solver, nodeB, nodeB, this._capGeqGB);
      stampRHS(solver, nodeG, -this._capIeqGB);
      stampRHS(solver, nodeB, this._capIeqGB);
    }

    const nodeD = this.drainNode;
    const nodeS = this.sourceNode;
    const nodeB = this._nodeB;

    // Drain-bulk junction capacitance
    if (this._capGeqDB !== 0 || this._capIeqDB !== 0) {
      stampG(solver, nodeD, nodeD, this._capGeqDB);
      stampG(solver, nodeD, nodeB, -this._capGeqDB);
      stampG(solver, nodeB, nodeD, -this._capGeqDB);
      stampG(solver, nodeB, nodeB, this._capGeqDB);
      stampRHS(solver, nodeD, -this._capIeqDB);
      stampRHS(solver, nodeB, this._capIeqDB);
    }

    // Source-bulk junction capacitance
    if (this._capGeqSB !== 0 || this._capIeqSB !== 0) {
      stampG(solver, nodeS, nodeS, this._capGeqSB);
      stampG(solver, nodeS, nodeB, -this._capGeqSB);
      stampG(solver, nodeB, nodeS, -this._capGeqSB);
      stampG(solver, nodeB, nodeB, this._capGeqSB);
      stampRHS(solver, nodeS, -this._capIeqSB);
      stampRHS(solver, nodeB, this._capIeqSB);
    }
  }

  setParam(key: string, value: number): void {
    if (key in this._p) (this._p as unknown as Record<string, number>)[key] = value;
  }

  override stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    // Gate overlap capacitances (Cgs, Cgd) via base class
    super.stampCompanion(dt, method, voltages);

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

    const prevVdb = this._capJunctionFirstCall ? vdb : this._vdbPrev;
    const prevVsb = this._capJunctionFirstCall ? vsbCap : this._vsbCapPrev;
    const prevVgb = this._capGbFirstCall ? vgb : this._vgbPrev;

    const iDB = this._capGeqDB * vdb + this._capIeqDB;
    const iSB = this._capGeqSB * vsbCap + this._capIeqSB;
    const iGB = this._capGeqGB * vgb + this._capIeqGB;

    this._vdbPrev = vdb;
    this._vsbCapPrev = vsbCap;
    this._vgbPrev = vgb;
    this._capJunctionFirstCall = false;
    this._capGbFirstCall = false;

    const caps = computeCapacitances(this._p);
    const pb = this._p.PB;
    const mj = this._p.MJ;
    const fc = this._p.FC;

    // Drain-bulk junction capacitance with FC linearization
    if (caps.cbd > 0) {
      const cbdEff = junctionCap(caps.cbd, vdb, pb, mj, fc);
      this._capGeqDB = capacitorConductance(cbdEff, dt, method);
      this._capIeqDB = capacitorHistoryCurrent(cbdEff, dt, method, vdb, prevVdb, iDB);
    } else {
      this._capGeqDB = 0;
      this._capIeqDB = 0;
    }

    // Source-bulk junction capacitance with FC linearization
    if (caps.cbs > 0) {
      const cbsEff = junctionCap(caps.cbs, vsbCap, pb, mj, fc);
      this._capGeqSB = capacitorConductance(cbsEff, dt, method);
      this._capIeqSB = capacitorHistoryCurrent(cbsEff, dt, method, vsbCap, prevVsb, iSB);
    } else {
      this._capGeqSB = 0;
      this._capIeqSB = 0;
    }

    // Gate-bulk overlap capacitance (CGBO * L), no voltage dependence
    if (caps.cgb > 0) {
      this._capGeqGB = capacitorConductance(caps.cgb, dt, method);
      this._capIeqGB = capacitorHistoryCurrent(caps.cgb, dt, method, vgb, prevVgb, iGB);
    } else {
      this._capGeqGB = 0;
      this._capIeqGB = 0;
    }
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
    MJSW:   mp("MJSW", 0.33),
    JS:     mp("JS", 0),
    RSH:    mp("RSH", 0),
    TOX:    mp("TOX", 1e-7),
    NSUB:   mp("NSUB", 0),
    NSS:    mp("NSS", 0),
    TPG:    mp("TPG", 1),
    LD:     mp("LD", 0),
    UO:     mp("UO", 600),
    KF:     mp("KF", 0),
    AF:     mp("AF", 1),
    FC:     mp("FC", 0.5),
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
    },
    "2N7000": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_2N7000,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "BS170": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_BS170,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRF530N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRF530N,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRF540N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRF540N,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRFZ44N": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(1, pinNodes, internalNodeIds, branchIdx, props, 2e-5),
      paramDefs: MOSFET_NMOS_PARAM_DEFS,
      params: NMOS_IRFZ44N,
      getInternalNodeCount: getMosfetInternalNodeCount,
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
    },
    "BS250": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_BS250,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRF9520": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF9520,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRFP9240": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRFP9240,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRF5210": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF5210,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
    "IRF4905": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props, _getTime) =>
        createMosfetElement(-1, pinNodes, internalNodeIds, branchIdx, props, 1e-5),
      paramDefs: MOSFET_PMOS_PARAM_DEFS,
      params: PMOS_IRF4905,
      getInternalNodeCount: getMosfetInternalNodeCount,
    },
  },
  defaultModel: "spice-l1",
};
