/**
 * QuickRun — run simulation at maximum speed with no rendering callbacks.
 *
 * Suppresses all change listeners and measurement observers on the engine
 * for the duration of the run, then restores them. This eliminates observer
 * overhead for computation-heavy circuits.
 *
 * speedTest() runs quickRun() and measures wall-clock time to report the
 * maximum achievable simulation frequency (kHz).
 *
 * Java reference: de.neemann.digital.gui.components.speedtest.SpeedTest
 */

import type { DigitalEngine } from "./digital-engine.js";
import type { EngineChangeListener, MeasurementObserver } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// SpeedTestResult
// ---------------------------------------------------------------------------

/**
 * Result of a speed test run.
 *
 * steps:           number of steps executed.
 * elapsedMs:       wall-clock time in milliseconds.
 * stepsPerSecond:  steps / (elapsedMs / 1000).
 * khz:             stepsPerSecond / 1000 — matches Digital's SpeedTest metric.
 */
export interface SpeedTestResult {
  readonly steps: number;
  readonly elapsedMs: number;
  readonly stepsPerSecond: number;
  readonly khz: number;
}

// ---------------------------------------------------------------------------
// EngineInternals — private field access type
// ---------------------------------------------------------------------------

/**
 * Type cast used to reach the private listener Sets on DigitalEngine.
 *
 * DigitalEngine stores listeners in private readonly Sets. quickRun must
 * temporarily remove them to suppress callbacks. This cast is the minimal
 * intrusion into the engine's internals needed to implement the feature.
 */
interface EngineInternals {
  _changeListeners: Set<EngineChangeListener>;
  _measurementObservers: Set<MeasurementObserver>;
}

// ---------------------------------------------------------------------------
// quickRun
// ---------------------------------------------------------------------------

/**
 * Run the engine N steps at maximum speed with no listener callbacks.
 *
 * Saves all registered change listeners and measurement observers, clears
 * them from the engine, runs N steps in a tight loop, then restores them.
 *
 * @param engine  The DigitalEngine to step.
 * @param steps   Number of steps to execute.
 */
export function quickRun(engine: DigitalEngine, steps: number): void {
  const internals = engine as unknown as EngineInternals;

  // Save and clear change listeners
  const savedListeners = new Set(internals._changeListeners);
  internals._changeListeners.clear();

  // Save and clear measurement observers
  const savedObservers = new Set(internals._measurementObservers);
  internals._measurementObservers.clear();

  try {
    for (let i = 0; i < steps; i++) {
      engine.step();
    }
  } finally {
    // Restore listeners unconditionally (even if step() throws)
    for (const listener of savedListeners) {
      internals._changeListeners.add(listener);
    }
    for (const observer of savedObservers) {
      internals._measurementObservers.add(observer);
    }
  }
}

// ---------------------------------------------------------------------------
// speedTest
// ---------------------------------------------------------------------------

/**
 * Run N simulation steps at maximum speed and measure wall-clock time.
 *
 * Calls quickRun() internally, so listeners are suppressed during measurement.
 *
 * @param engine  The DigitalEngine to benchmark.
 * @param steps   Number of steps to time.
 * @returns SpeedTestResult with timing metrics.
 */
export function speedTest(engine: DigitalEngine, steps: number): SpeedTestResult {
  const startMs = performance.now();

  quickRun(engine, steps);

  const elapsedMs = performance.now() - startMs;
  const stepsPerSecond = elapsedMs > 0 ? (steps / elapsedMs) * 1000 : steps * 1000;
  const khz = stepsPerSecond / 1000;

  return { steps, elapsedMs, stepsPerSecond, khz };
}
