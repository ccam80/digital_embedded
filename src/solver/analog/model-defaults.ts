/**
 * SPICE standard default parameter sets for each device type.
 *
 * Values match standard SPICE Level 2 defaults as documented in the
 * SPICE2 manual and Berkeley SPICE3 reference. Infinity is represented
 * as Number.POSITIVE_INFINITY for parameters with no physical upper bound.
 */

// ---------------------------------------------------------------------------
// Diode defaults (SPICE D model, Level 1/2)
// ---------------------------------------------------------------------------

/** SPICE standard diode model default parameters. */
export const DIODE_DEFAULTS: Record<string, number> = {
  /** IS: saturation current (A) */
  IS: 1e-14,
  /** N: emission coefficient (dimensionless) */
  N: 1,
  /** RS: ohmic resistance (Ω) */
  RS: 0,
  /** BV: reverse breakdown voltage (V) — infinite means no breakdown */
  BV: Number.POSITIVE_INFINITY,
  /** IBV: current at reverse breakdown (A) */
  IBV: 1e-3,
  /** CJO: zero-bias junction capacitance (F) */
  CJO: 0,
  /** VJ: junction potential (V) */
  VJ: 0.7,
  /** M: grading coefficient (dimensionless) */
  M: 0.5,
  /** TT: transit time (s) */
  TT: 0,
  /** EG: activation energy (eV) — 1.11 for silicon */
  EG: 1.11,
  /** XTI: saturation current temperature exponent */
  XTI: 3,
  /** KF: flicker noise coefficient */
  KF: 0,
  /** AF: flicker noise exponent */
  AF: 1,
  /** FC: forward-bias depletion capacitance coefficient */
  FC: 0.5,
};

// ---------------------------------------------------------------------------
// Zener diode defaults — same as standard diode but with finite BV
// ---------------------------------------------------------------------------

/**
 * Default parameters for a Zener diode.
 * Inherits all SPICE D-model defaults but overrides BV to a typical 5.1 V
 * Zener breakdown voltage so that reverse breakdown is active by default.
 */
export const ZENER_DEFAULTS: Record<string, number> = {
  ...DIODE_DEFAULTS,
  /** BV: reverse breakdown voltage (V) — typical Zener */
  BV: 5.1,
  /** IBV: current at reverse breakdown (A) — 1 mA reference */
  IBV: 1e-3,
};

// ---------------------------------------------------------------------------
// Schottky diode defaults — higher IS, lower BV than standard silicon diode
// ---------------------------------------------------------------------------

/**
 * Default parameters for a Schottky barrier diode.
 * Key differences from silicon: much higher saturation current (metal-
 * semiconductor junction), lower forward voltage drop, lower breakdown.
 */
export const SCHOTTKY_DEFAULTS: Record<string, number> = {
  ...DIODE_DEFAULTS,
  /** IS: saturation current (A) — ~1000x higher than Si diode */
  IS: 1e-8,
  /** N: ideality factor — slightly above 1 for Schottky */
  N: 1.05,
  /** BV: reverse breakdown voltage (V) — lower than Si diode */
  BV: 40,
  /** RS: series resistance (Ω) */
  RS: 1,
  /** CJO: zero-bias junction capacitance (F) */
  CJO: 1e-12,
  /** EG: Schottky barrier height (eV) — lower than Si bandgap */
  EG: 0.69,
};

// ---------------------------------------------------------------------------
// BJT NPN defaults (SPICE Q model, Level 1)
// ---------------------------------------------------------------------------

/** SPICE standard NPN BJT model default parameters. */
export const BJT_NPN_DEFAULTS: Record<string, number> = {
  /** IS: transport saturation current (A) */
  IS: 1e-16,
  /** BF: ideal maximum forward beta */
  BF: 100,
  /** NF: forward current emission coefficient */
  NF: 1.0,
  /** BR: ideal maximum reverse beta */
  BR: 1,
  /** NR: reverse current emission coefficient */
  NR: 1,
  /** ISE: B-E leakage saturation current (A) */
  ISE: 0,
  /** ISC: B-C leakage saturation current (A) */
  ISC: 0,
  /** VAF: forward Early voltage (V) — infinite means no Early effect */
  VAF: Number.POSITIVE_INFINITY,
  /** VAR: reverse Early voltage (V) */
  VAR: Number.POSITIVE_INFINITY,
  /** IKF: corner for forward beta high-current roll-off (A) */
  IKF: Number.POSITIVE_INFINITY,
  /** IKR: corner for reverse beta high-current roll-off (A) */
  IKR: Number.POSITIVE_INFINITY,
  /** RB: zero-bias base resistance (Ω) */
  RB: 0,
  /** RC: collector resistance (Ω) */
  RC: 0,
  /** RE: emitter resistance (Ω) */
  RE: 0,
  /** CJE: B-E zero-bias depletion capacitance (F) */
  CJE: 0,
  /** VJE: B-E built-in potential (V) */
  VJE: 0.75,
  /** MJE: B-E junction grading coefficient */
  MJE: 0.33,
  /** CJC: B-C zero-bias depletion capacitance (F) */
  CJC: 0,
  /** VJC: B-C built-in potential (V) */
  VJC: 0.75,
  /** MJC: B-C junction grading coefficient */
  MJC: 0.33,
  /** TF: ideal forward transit time (s) */
  TF: 0,
  /** TR: ideal reverse transit time (s) */
  TR: 0,
  /** EG: bandgap energy (eV) */
  EG: 1.11,
  /** XTI: saturation current temperature exponent */
  XTI: 3,
  /** XTB: forward and reverse beta temperature exponent */
  XTB: 0,
  /** KF: flicker noise coefficient */
  KF: 0,
};

// ---------------------------------------------------------------------------
// BJT PNP defaults (SPICE Q model, Level 1)
// ---------------------------------------------------------------------------

/**
 * SPICE standard PNP BJT model default parameters.
 * Polarity inversion is handled by the element implementation, not the defaults.
 */
export const BJT_PNP_DEFAULTS: Record<string, number> = {
  /** IS: transport saturation current (A) */
  IS: 1e-16,
  /** BF: ideal maximum forward beta */
  BF: 100,
  /** NF: forward current emission coefficient */
  NF: 1.0,
  /** BR: ideal maximum reverse beta */
  BR: 1,
  /** NR: reverse current emission coefficient */
  NR: 1,
  /** ISE: B-E leakage saturation current (A) */
  ISE: 0,
  /** ISC: B-C leakage saturation current (A) */
  ISC: 0,
  /** VAF: forward Early voltage (V) */
  VAF: Number.POSITIVE_INFINITY,
  /** VAR: reverse Early voltage (V) */
  VAR: Number.POSITIVE_INFINITY,
  /** IKF: corner for forward beta high-current roll-off (A) */
  IKF: Number.POSITIVE_INFINITY,
  /** IKR: corner for reverse beta high-current roll-off (A) */
  IKR: Number.POSITIVE_INFINITY,
  /** RB: zero-bias base resistance (Ω) */
  RB: 0,
  /** RC: collector resistance (Ω) */
  RC: 0,
  /** RE: emitter resistance (Ω) */
  RE: 0,
  /** CJE: B-E zero-bias depletion capacitance (F) */
  CJE: 0,
  /** VJE: B-E built-in potential (V) */
  VJE: 0.75,
  /** MJE: B-E junction grading coefficient */
  MJE: 0.33,
  /** CJC: B-C zero-bias depletion capacitance (F) */
  CJC: 0,
  /** VJC: B-C built-in potential (V) */
  VJC: 0.75,
  /** MJC: B-C junction grading coefficient */
  MJC: 0.33,
  /** TF: ideal forward transit time (s) */
  TF: 0,
  /** TR: ideal reverse transit time (s) */
  TR: 0,
  /** EG: bandgap energy (eV) */
  EG: 1.11,
  /** XTI: saturation current temperature exponent */
  XTI: 3,
  /** XTB: forward and reverse beta temperature exponent */
  XTB: 0,
  /** KF: flicker noise coefficient */
  KF: 0,
};

// ---------------------------------------------------------------------------
// MOSFET NMOS defaults (SPICE MOSFET Level 2)
// ---------------------------------------------------------------------------

/** SPICE standard NMOS MOSFET model default parameters (Level 2). */
export const MOSFET_NMOS_DEFAULTS: Record<string, number> = {
  /** VTO: zero-bias threshold voltage (V) */
  VTO: 0.7,
  /** KP: transconductance parameter (A/V²) */
  KP: 120e-6,
  /** LAMBDA: channel-length modulation parameter (1/V) */
  LAMBDA: 0.02,
  /** PHI: surface potential (V) */
  PHI: 0.6,
  /** GAMMA: body-effect parameter (V^0.5) */
  GAMMA: 0.37,
  /** CBD: zero-bias bulk-drain junction capacitance (F) */
  CBD: 0,
  /** CBS: zero-bias bulk-source junction capacitance (F) */
  CBS: 0,
  /** CGDO: gate-drain overlap capacitance per channel width (F/m) */
  CGDO: 0,
  /** CGSO: gate-source overlap capacitance per channel width (F/m) */
  CGSO: 0,
  /** W: channel width (m) */
  W: 1e-6,
  /** L: channel length (m) */
  L: 1e-6,
  /** TOX: gate oxide thickness (m) */
  TOX: 1e-7,
  /** RD: drain ohmic resistance (Ω) */
  RD: 0,
  /** RS: source ohmic resistance (Ω) */
  RS: 0,
  /** RG: gate ohmic resistance (Ω) */
  RG: 0,
  /** RB: bulk ohmic resistance (Ω) */
  RB: 0,
  /** IS: bulk junction saturation current (A) */
  IS: 1e-14,
  /** JS: bulk junction saturation current density (A/m²) */
  JS: 0,
  /** PB: bulk junction potential (V) */
  PB: 0.8,
  /** MJ: bulk junction grading coefficient */
  MJ: 0.5,
  /** MJSW: sidewall junction grading coefficient */
  MJSW: 0.33,
  /** CGBO: gate-bulk overlap capacitance per channel length (F/m) */
  CGBO: 0,
  /** CJ: zero-bias bulk junction capacitance per area (F/m²) */
  CJ: 0,
  /** CJSW: zero-bias sidewall junction capacitance per perimeter (F/m) */
  CJSW: 0,
  /** NFS: fast surface state density (1/cm²·V) */
  NFS: 0,
};

// ---------------------------------------------------------------------------
// MOSFET PMOS defaults (SPICE MOSFET Level 2)
// ---------------------------------------------------------------------------

/** SPICE standard PMOS MOSFET model default parameters (Level 2). */
export const MOSFET_PMOS_DEFAULTS: Record<string, number> = {
  /** VTO: zero-bias threshold voltage (V) — negative for PMOS */
  VTO: -0.7,
  /** KP: transconductance parameter (A/V²) — lower mobility for PMOS */
  KP: 60e-6,
  /** LAMBDA: channel-length modulation parameter (1/V) */
  LAMBDA: 0.02,
  /** PHI: surface potential (V) */
  PHI: 0.6,
  /** GAMMA: body-effect parameter (V^0.5) */
  GAMMA: 0.37,
  /** CBD: zero-bias bulk-drain junction capacitance (F) */
  CBD: 0,
  /** CBS: zero-bias bulk-source junction capacitance (F) */
  CBS: 0,
  /** CGDO: gate-drain overlap capacitance per channel width (F/m) */
  CGDO: 0,
  /** CGSO: gate-source overlap capacitance per channel width (F/m) */
  CGSO: 0,
  /** W: channel width (m) */
  W: 1e-6,
  /** L: channel length (m) */
  L: 1e-6,
  /** TOX: gate oxide thickness (m) */
  TOX: 1e-7,
  /** RD: drain ohmic resistance (Ω) */
  RD: 0,
  /** RS: source ohmic resistance (Ω) */
  RS: 0,
  /** RG: gate ohmic resistance (Ω) */
  RG: 0,
  /** RB: bulk ohmic resistance (Ω) */
  RB: 0,
  /** IS: bulk junction saturation current (A) */
  IS: 1e-14,
  /** JS: bulk junction saturation current density (A/m²) */
  JS: 0,
  /** PB: bulk junction potential (V) */
  PB: 0.8,
  /** MJ: bulk junction grading coefficient */
  MJ: 0.5,
  /** MJSW: sidewall junction grading coefficient */
  MJSW: 0.33,
  /** CGBO: gate-bulk overlap capacitance per channel length (F/m) */
  CGBO: 0,
  /** CJ: zero-bias bulk junction capacitance per area (F/m²) */
  CJ: 0,
  /** CJSW: zero-bias sidewall junction capacitance per perimeter (F/m) */
  CJSW: 0,
  /** NFS: fast surface state density (1/cm²·V) */
  NFS: 0,
};

// ---------------------------------------------------------------------------
// JFET N-channel defaults (SPICE JFET Level 1)
// ---------------------------------------------------------------------------

/** SPICE standard N-channel JFET model default parameters. */
export const JFET_N_DEFAULTS: Record<string, number> = {
  /** VTO: pinch-off voltage (V) — negative for N-channel */
  VTO: -2.0,
  /** BETA: transconductance parameter (A/V²) */
  BETA: 1e-4,
  /** LAMBDA: channel-length modulation parameter (1/V) */
  LAMBDA: 0,
  /** RD: drain ohmic resistance (Ω) */
  RD: 0,
  /** RS: source ohmic resistance (Ω) */
  RS: 0,
  /** CGS: zero-bias gate-source junction capacitance (F) */
  CGS: 0,
  /** CGD: zero-bias gate-drain junction capacitance (F) */
  CGD: 0,
  /** PB: gate junction potential (V) */
  PB: 1.0,
  /** IS: gate junction saturation current (A) */
  IS: 1e-14,
  /** KF: flicker noise coefficient */
  KF: 0,
  /** AF: flicker noise exponent */
  AF: 1,
  /** FC: forward-bias depletion capacitance coefficient */
  FC: 0.5,
};

// ---------------------------------------------------------------------------
// JFET P-channel defaults (SPICE JFET Level 1)
// ---------------------------------------------------------------------------

/** SPICE standard P-channel JFET model default parameters. */
export const JFET_P_DEFAULTS: Record<string, number> = {
  /** VTO: pinch-off voltage (V) — positive for P-channel */
  VTO: 2.0,
  /** BETA: transconductance parameter (A/V²) */
  BETA: 1e-4,
  /** LAMBDA: channel-length modulation parameter (1/V) */
  LAMBDA: 0,
  /** RD: drain ohmic resistance (Ω) */
  RD: 0,
  /** RS: source ohmic resistance (Ω) */
  RS: 0,
  /** CGS: zero-bias gate-source junction capacitance (F) */
  CGS: 0,
  /** CGD: zero-bias gate-drain junction capacitance (F) */
  CGD: 0,
  /** PB: gate junction potential (V) */
  PB: 1.0,
  /** IS: gate junction saturation current (A) */
  IS: 1e-14,
  /** KF: flicker noise coefficient */
  KF: 0,
  /** AF: flicker noise exponent */
  AF: 1,
  /** FC: forward-bias depletion capacitance coefficient */
  FC: 0.5,
};

// ---------------------------------------------------------------------------
// Tunnel diode defaults
// ---------------------------------------------------------------------------

/** Default parameters for a tunnel diode (Esaki diode) model. */
export const TUNNEL_DIODE_DEFAULTS: Record<string, number> = {
  /** IP: peak tunnel current (A) */
  IP: 5e-3,
  /** VP: peak voltage (V) */
  VP: 0.08,
  /** IV: valley current (A) */
  IV: 0.5e-3,
  /** VV: valley voltage (V) */
  VV: 0.5,
  /** IS: thermal saturation current (A) */
  IS: 1e-14,
  /** N: emission coefficient */
  N: 1,
};

// ---------------------------------------------------------------------------
// Lookup by device type string
// ---------------------------------------------------------------------------

const DEVICE_DEFAULTS_MAP: Record<string, Record<string, number>> = {
  D:      DIODE_DEFAULTS,
  NPN:    BJT_NPN_DEFAULTS,
  PNP:    BJT_PNP_DEFAULTS,
  NMOS:   MOSFET_NMOS_DEFAULTS,
  PMOS:   MOSFET_PMOS_DEFAULTS,
  NJFET:  JFET_N_DEFAULTS,
  PJFET:  JFET_P_DEFAULTS,
  TUNNEL: TUNNEL_DIODE_DEFAULTS,
};

/**
 * Return the default SPICE parameter set for a given device type string.
 * Returns an empty object for unrecognized device types.
 */
export function getDeviceDefaults(deviceType: string): Record<string, number> {
  return DEVICE_DEFAULTS_MAP[deviceType] ?? {};
}
