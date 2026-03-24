/**
 * Logic family configuration types and built-in presets.
 *
 * Defines the electrical characteristics of a digital logic family
 * (voltage levels, thresholds, impedances, capacitances). Used by the
 * analog simulation engine to determine pin loading, drive strength,
 * and threshold detection for behavioral digital components.
 */

// ---------------------------------------------------------------------------
// LogicFamilyConfig interface
// ---------------------------------------------------------------------------

/**
 * Electrical characteristics of a logic family.
 *
 * All voltage values are in volts (V), impedances in ohms (Ω),
 * and capacitances in farads (F).
 */
export interface LogicFamilyConfig {
  /** Preset name for display (e.g. 'CMOS 3.3V', 'CMOS 5V', 'TTL', 'Custom'). */
  name: string;
  /** Supply voltage (V). */
  vdd: number;
  /** Output high voltage (V). */
  vOH: number;
  /** Output low voltage (V). */
  vOL: number;
  /** Input high threshold (V) — voltage above which input is read as logic HIGH. */
  vIH: number;
  /** Input low threshold (V) — voltage below which input is read as logic LOW. */
  vIL: number;
  /** Default output impedance (Ω). */
  rOut: number;
  /** Default input impedance (Ω). */
  rIn: number;
  /** Default input capacitance (F). */
  cIn: number;
  /** Default output capacitance (F). */
  cOut: number;
  /** Hi-Z state impedance (Ω) — used when a tristate output is disabled. */
  rHiZ: number;
}

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------

/**
 * Built-in logic family presets keyed by a short identifier.
 *
 * All presets satisfy the invariant: vOL < vIL < vIH < vOH.
 */
export const LOGIC_FAMILY_PRESETS: Record<string, LogicFamilyConfig> = {
  'cmos-3v3': {
    name: 'CMOS 3.3V',
    vdd: 3.3,
    vOH: 3.3,
    vOL: 0.0,
    vIH: 2.0,
    vIL: 0.8,
    rOut: 50,
    rIn: 1e7,
    cIn: 5e-12,
    cOut: 5e-12,
    rHiZ: 1e7,
  },
  'cmos-5v': {
    name: 'CMOS 5V',
    vdd: 5.0,
    vOH: 5.0,
    vOL: 0.0,
    vIH: 3.5,
    vIL: 1.5,
    rOut: 50,
    rIn: 1e7,
    cIn: 5e-12,
    cOut: 5e-12,
    rHiZ: 1e7,
  },
  'ttl': {
    name: 'TTL',
    vdd: 5.0,
    vOH: 3.4,
    vOL: 0.35,
    vIH: 2.0,
    vIL: 0.8,
    rOut: 80,
    rIn: 4e3,
    cIn: 5e-12,
    cOut: 5e-12,
    rHiZ: 1e7,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the default logic family (CMOS 3.3V).
 *
 * Used when a circuit has no explicit logicFamily set in its metadata.
 */
export function defaultLogicFamily(): LogicFamilyConfig {
  return LOGIC_FAMILY_PRESETS['cmos-3v3'];
}

/**
 * Look up a logic family preset by key.
 *
 * Returns undefined when the key is not found.
 */
export function getLogicFamilyPreset(key: string): LogicFamilyConfig | undefined {
  return LOGIC_FAMILY_PRESETS[key];
}
