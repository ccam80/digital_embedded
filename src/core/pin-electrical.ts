/**
 * Per-pin electrical specification types and resolution utilities.
 *
 * Provides optional per-component and per-pin overrides for the circuit-level
 * logic family defaults. Most digital components omit this entirely and
 * inherit defaults from the circuit's LogicFamilyConfig.
 */

import type { LogicFamilyConfig } from './logic-family.js';

// ---------------------------------------------------------------------------
// PinElectricalSpec- optional override fields
// ---------------------------------------------------------------------------

/**
 * Partial override for one pin's electrical characteristics.
 *
 * All fields are optional. Fields not specified inherit from the component-level
 * override or the circuit-level logic family default.
 */
export interface PinElectricalSpec {
  /** Output impedance override (Ω). */
  rOut?: number;
  /** Output capacitance override (F). */
  cOut?: number;
  /** Input impedance override (Ω). */
  rIn?: number;
  /** Input capacitance override (F). */
  cIn?: number;
  /** Output high voltage override (V). */
  vOH?: number;
  /** Output low voltage override (V). */
  vOL?: number;
  /** Input high threshold override (V). */
  vIH?: number;
  /** Input low threshold override (V). */
  vIL?: number;
  /** Hi-Z state impedance override (Ω). */
  rHiZ?: number;
}

// ---------------------------------------------------------------------------
// ResolvedPinElectrical- fully resolved, no optional fields
// ---------------------------------------------------------------------------

/**
 * Fully resolved electrical characteristics for one pin.
 *
 * All fields are required- downstream analog code never needs null checks.
 * Produced by resolvePinElectrical() after applying the override cascade.
 */
export interface ResolvedPinElectrical {
  /** Output impedance (Ω). */
  rOut: number;
  /** Output capacitance (F). */
  cOut: number;
  /** Input impedance (Ω). */
  rIn: number;
  /** Input capacitance (F). */
  cIn: number;
  /** Output high voltage (V). */
  vOH: number;
  /** Output low voltage (V). */
  vOL: number;
  /** Input high threshold (V). */
  vIH: number;
  /** Input low threshold (V). */
  vIL: number;
  /** Hi-Z state impedance (Ω). */
  rHiZ: number;
}

// ---------------------------------------------------------------------------
// resolvePinElectrical
// ---------------------------------------------------------------------------

/**
 * Resolve the electrical characteristics for one pin by applying the override
 * cascade onto the circuit-level logic family defaults.
 *
 * Priority (highest to lowest):
 *   1. pinOverride  - per-pin override from ComponentDefinition.pinElectricalOverrides
 *   2. componentOverride- component-level override from ComponentDefinition.pinElectrical
 *   3. family       - circuit-level LogicFamilyConfig (from CircuitMetadata.logicFamily)
 */
export function resolvePinElectrical(
  family: LogicFamilyConfig,
  pinOverride?: PinElectricalSpec,
  componentOverride?: PinElectricalSpec,
): ResolvedPinElectrical {
  return {
    rOut:  pinOverride?.rOut  ?? componentOverride?.rOut  ?? family.rOut,
    cOut:  pinOverride?.cOut  ?? componentOverride?.cOut  ?? family.cOut,
    rIn:   pinOverride?.rIn   ?? componentOverride?.rIn   ?? family.rIn,
    cIn:   pinOverride?.cIn   ?? componentOverride?.cIn   ?? family.cIn,
    vOH:   pinOverride?.vOH   ?? componentOverride?.vOH   ?? family.vOH,
    vOL:   pinOverride?.vOL   ?? componentOverride?.vOL   ?? family.vOL,
    vIH:   pinOverride?.vIH   ?? componentOverride?.vIH   ?? family.vIH,
    vIL:   pinOverride?.vIL   ?? componentOverride?.vIL   ?? family.vIL,
    rHiZ:  pinOverride?.rHiZ  ?? componentOverride?.rHiZ  ?? family.rHiZ,
  };
}
