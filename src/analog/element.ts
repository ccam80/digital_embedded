/**
 * Analog element interface — stub for Phase 1.
 *
 * Phase 1 (Task 1.2.2) will replace this with the full implementation.
 * This file exists so that the type-only import in registry.ts resolves.
 */

/** An analog circuit element that stamps into the MNA matrix. */
export interface AnalogElement {
  /** Stamp linear contributions into the MNA matrix. Called once per NR solve setup. */
  stamp(): void;

  /** Stamp nonlinear contributions. Called every NR iteration. */
  stampNonlinear?(): void;

  /** Update companion model for reactive elements. Called once per accepted timestep. */
  updateCompanion?(): void;
}
