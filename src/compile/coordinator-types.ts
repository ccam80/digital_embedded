/**
 * SimulationCoordinator interface — unified simulation contract for all
 * circuit types (digital-only, analog-only, mixed-signal).
 *
 * The coordinator wraps both backend engines and the bridge cross-reference
 * map, providing unified signal routing, label resolution, and observer
 * management across all active solver backends.
 *
 * Spec: unified-component-architecture.md Section 5 (Phase 4).
 */

import type { SimulationEngine, MeasurementObserver } from "../core/engine-interface.js";
import type { AnalogEngine } from "../core/analog-engine-interface.js";
import type { CompiledCircuitUnified, SignalAddress, SignalValue } from "./types.js";

/**
 * Unified coordinator interface for all simulation modes.
 *
 * A single `SimulationCoordinator` instance manages one or both of the
 * digital and analog backends, bridge synchronisation between them, and
 * observer notification after each step.
 */
export interface SimulationCoordinator {
  /** Advance one full step across all active solver backends. */
  step(): void;

  /** Start continuous simulation across all backends. */
  start(): void;

  /** Stop all backends. */
  stop(): void;

  /** Reset all backends to initial state. */
  reset(): void;

  /** Dispose all backends and release resources. */
  dispose(): void;

  /** Read a signal by address (polymorphic across domains). */
  readSignal(addr: SignalAddress): SignalValue;

  /** Write an input signal by address. */
  writeSignal(addr: SignalAddress, value: SignalValue): void;

  /** Read a signal by component label. */
  readByLabel(label: string): SignalValue;

  /** Write an input signal by component label. */
  writeByLabel(label: string, value: SignalValue): void;

  /** Read all labeled signals. Returns Map<label, SignalValue>. */
  readAllSignals(): Map<string, SignalValue>;

  /** Access the digital backend. Null if no digital domain. */
  readonly digitalBackend: SimulationEngine | null;

  /** Access the analog backend. Null if no analog domain. */
  readonly analogBackend: AnalogEngine | null;

  /** The unified compiled output this coordinator was built from. */
  readonly compiled: CompiledCircuitUnified;

  /** Register a measurement observer (notified after each step). */
  addMeasurementObserver(observer: MeasurementObserver): void;

  /** Remove a measurement observer. */
  removeMeasurementObserver(observer: MeasurementObserver): void;
}
