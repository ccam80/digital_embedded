/**
 * SPICE model parameter default values for semiconductor components.
 *
 * These are the canonical defaults used when no external model is specified.
 * Each component's factory calls defineModelParams() to produce both these
 * defaults and the ParamDef[] schema, then exposes them via modelRegistry.
 */

// ---------------------------------------------------------------------------
// Diode (standard silicon junction)
// ---------------------------------------------------------------------------

export const DIODE_DEFAULTS: Record<string, number> = {
  IS:  1e-14,
  N:   1,
  CJO: 0,
  VJ:  1,
  M:   0.5,
  TT:  0,
  FC:  0.5,
  BV:  Infinity,
  IBV: 1e-3,
};

// ---------------------------------------------------------------------------
// Zener diode (5.1V reference)
// ---------------------------------------------------------------------------

export const ZENER_DEFAULTS: Record<string, number> = {
  IS:  1e-14,
  N:   1,
  BV:  5.1,
  IBV: 1e-3,
};

// ---------------------------------------------------------------------------
// Schottky barrier diode
// ---------------------------------------------------------------------------

export const SCHOTTKY_DEFAULTS: Record<string, number> = {
  IS:  1e-8,
  N:   1.05,
  CJO: 1e-12,
  VJ:  0.6,
  M:   0.5,
  TT:  0,
  FC:  0.5,
  BV:  40,
  IBV: 1e-3,
};

// ---------------------------------------------------------------------------
// Tunnel diode
// ---------------------------------------------------------------------------

export const TUNNEL_DIODE_DEFAULTS: Record<string, number> = {
  IP:  1e-3,
  VP:  0.065,
  IV:  1e-4,
  VV:  0.35,
  IS:  1e-14,
  N:   1,
};

// ---------------------------------------------------------------------------
// MOSFET — N-channel and P-channel
// ---------------------------------------------------------------------------

export const MOSFET_NMOS_DEFAULTS: Record<string, number> = {
  VTO:    1.0,
  KP:     2e-5,
  LAMBDA: 0.01,
  PHI:    0.6,
  GAMMA:  0.0,
  CBD:    0,
  CBS:    0,
  CGDO:   0,
  CGSO:   0,
  W:      1e-6,
  L:      1e-6,
};

export const MOSFET_PMOS_DEFAULTS: Record<string, number> = {
  VTO:    -1.0,
  KP:     1e-5,
  LAMBDA: 0.01,
  PHI:    0.6,
  GAMMA:  0.0,
  CBD:    0,
  CBS:    0,
  CGDO:   0,
  CGSO:   0,
  W:      1e-6,
  L:      1e-6,
};

// ---------------------------------------------------------------------------
// JFET — N-channel and P-channel (Shichman-Hodges)
// ---------------------------------------------------------------------------

export const JFET_N_DEFAULTS: Record<string, number> = {
  VTO:    -2.0,
  BETA:   1e-4,
  LAMBDA: 0.0,
  IS:     1e-14,
  CGS:    0,
  CGD:    0,
  PB:     1.0,
  FC:     0.5,
  RD:     0,
  RS:     0,
  KF:     0,
  AF:     1,
};

export const JFET_P_DEFAULTS: Record<string, number> = {
  VTO:    2.0,
  BETA:   1e-4,
  LAMBDA: 0.0,
  IS:     1e-14,
  CGS:    0,
  CGD:    0,
  PB:     1.0,
  FC:     0.5,
  RD:     0,
  RS:     0,
  KF:     0,
  AF:     1,
};

// ---------------------------------------------------------------------------
// BJT NPN defaults (re-exported from bjt.ts for cross-module consumers)
// ---------------------------------------------------------------------------

export { BJT_NPN_DEFAULTS } from "../../components/semiconductors/bjt.js";
