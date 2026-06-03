/**
 * Shared simulation constants used across multiple modules.
 */

/** Maximum propagation steps before aborting a run-to-break loop. */
export const MAX_STEPS = 100_000;

/** Maximum total input bit count for truth-table analysis (2^20 ≈ 1M rows). */
export const MAX_INPUT_BITS = 20;

/** Maximum subcircuit nesting depth (matching Digital's limit). */
export const MAX_DEPTH = 30;

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h)
// ---------------------------------------------------------------------------
// Single source of truth for the SPICE physical constants. Every analog device
// model imports these so vt / vcrit / Vbi / temperature-scaled quantities are
// bit-identical to ngspice. Do not redefine these literals anywhere else.

/** Elementary charge in coulombs (ref/ngspice/src/include/ngspice/const.h:32). */
export const CHARGE = 1.6021766208e-19;

/** Boltzmann constant in J/K (ref/ngspice/src/include/ngspice/const.h:37). */
export const CONSTboltz = 1.38064852e-23;

/**
 * Boltzmann constant divided by elementary charge (k/q), in V/K.
 * Formed as CONSTboltz / CHARGE, matching ref/ngspice/src/main.c:498
 * (`double CONSTKoverQ = CONSTboltz / CHARGE;`). ckttemp.c:26 then computes
 * the circuit thermal voltage as `CKTvt = CONSTKoverQ * CKTtemp`.
 */
export const CONSTKoverQ = CONSTboltz / CHARGE;

/** Celsius-to-Kelvin offset (ref/ngspice/src/include/ngspice/const.h:25). */
export const CONSTCtoK = 273.15;

/** Reference temperature in K: 27 °C (ref/ngspice/src/include/ngspice/const.h:54, `27.0 + CONSTCtoK`). */
export const REFTEMP = 27.0 + CONSTCtoK;

/** Thermal voltage at REFTEMP (300.15 K): REFTEMP * CONSTKoverQ, in volts. */
export const VT = REFTEMP * CONSTKoverQ;

/** Speed of light in m/s (ref/ngspice/src/include/ngspice/const.h:19). */
export const CONSTc = 299792458;

/**
 * Vacuum permeability in H/m (ref/ngspice/src/include/ngspice/const.h:43):
 * `4.0 * CONSTpi * 1E-7`. CONSTpi's IEEE-754 double equals Math.PI.
 */
export const CONSTmuZero = 4.0 * Math.PI * 1e-7;

/**
 * Vacuum permittivity in F/m (ref/ngspice/src/include/ngspice/const.h:46):
 * `1.0 / (CONSTmuZero * CONSTc * CONSTc)`, from e0*u0*c^2 = 1.
 */
export const CONSTepsZero = 1.0 / (CONSTmuZero * CONSTc * CONSTc);

/** Relative permittivity of SiO2 (ref/ngspice/src/include/ngspice/const.h:51). */
export const CONSTepsrSiO2 = 3.9;

/**
 * SiO2 permittivity in F/m (ref/ngspice/src/include/ngspice/const.h:53):
 * `CONSTepsrSiO2 * CONSTepsZero`. Used by the level=3 diode parasitic metal /
 * poly overlap caps (diosetup.c:285-290).
 */
export const CONSTepsSiO2 = CONSTepsrSiO2 * CONSTepsZero;
