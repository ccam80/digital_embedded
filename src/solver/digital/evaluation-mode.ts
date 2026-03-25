/**
 * Evaluation mode configuration for the DigitalEngine.
 *
 * Three modes share the same Uint32Array signal storage and compiled circuit
 * representation. The mode is a construction-time or runtime configuration
 * option on DigitalEngine.
 */

// ---------------------------------------------------------------------------
// EvaluationMode — the three simulation modes
// ---------------------------------------------------------------------------

/**
 * Selects how the DigitalEngine evaluates components on each step.
 *
 * - 'level': Level-by-level (default). One-pass sweep for non-feedback
 *   components. Iterative stabilisation for feedback SCCs.
 * - 'timed': Event-driven with per-component propagation delays. Uses a
 *   timing wheel to schedule output changes at future timestamps.
 * - 'microstep': Evaluates one component per step. Used for educational
 *   step-through debugging.
 */
export type EvaluationMode = "level" | "timed" | "microstep";

// ---------------------------------------------------------------------------
// Mode-specific configuration records
// ---------------------------------------------------------------------------

/** Configuration for level-by-level mode. No extra parameters needed. */
export interface LevelConfig {
  readonly kind: "level";
}

/** Configuration for timed (event-driven) mode. */
export interface TimedConfig {
  readonly kind: "timed";
  /** Default propagation delay in nanoseconds when a component has no explicit delay. */
  readonly defaultDelay: number;
}

/** Configuration for micro-step mode. No extra parameters needed. */
export interface MicrostepConfig {
  readonly kind: "microstep";
}

/** Union of all mode configuration records. */
export type ModeConfig = LevelConfig | TimedConfig | MicrostepConfig;

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

export const DEFAULT_LEVEL_CONFIG: LevelConfig = { kind: "level" };

export const DEFAULT_TIMED_CONFIG: TimedConfig = {
  kind: "timed",
  defaultDelay: 10,
};

export const DEFAULT_MICROSTEP_CONFIG: MicrostepConfig = { kind: "microstep" };

/**
 * Build the default configuration object for a given mode string.
 */
export function defaultConfigForMode(mode: EvaluationMode): ModeConfig {
  switch (mode) {
    case "level":
      return DEFAULT_LEVEL_CONFIG;
    case "timed":
      return DEFAULT_TIMED_CONFIG;
    case "microstep":
      return DEFAULT_MICROSTEP_CONFIG;
  }
}
