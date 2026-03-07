/**
 * Worker detection and engine factory.
 *
 * Detects whether both SharedArrayBuffer and Worker are available. SAB requires
 * Cross-Origin-Isolation headers (COOP + COEP) in browsers; Worker must also
 * be defined. Falls back to a main-thread DigitalEngine when either is missing.
 */

import { DigitalEngine } from "./digital-engine.js";
import { WorkerEngine } from "./worker-engine.js";
import type { SimulationEngine, CompiledCircuit } from "@/core/engine-interface";
import type { EvaluationMode } from "./evaluation-mode.js";

// ---------------------------------------------------------------------------
// canUseWorkerEngine
// ---------------------------------------------------------------------------

/**
 * Returns true when the environment supports running the simulation in a
 * Web Worker with shared memory.
 *
 * Both `SharedArrayBuffer` (for lock-free signal reads from the main thread)
 * and `Worker` (for off-thread execution) must be available.
 *
 * In browsers this requires Cross-Origin-Isolation headers.
 * In Node.js (test environment) SAB is available but Worker is not, so this
 * correctly returns false.
 */
export function canUseWorkerEngine(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && typeof Worker !== "undefined";
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

/**
 * Factory that returns the best available engine implementation.
 *
 * When both SharedArrayBuffer and Worker are available:
 *   Attempts to create a WorkerEngine. If the Worker fails to spawn
 *   (e.g. CSP restrictions, missing worker script), falls back to
 *   DigitalEngine.
 *
 * Otherwise:
 *   Returns a DigitalEngine running on the main thread.
 *
 * @param compiled  The compiled circuit to simulate.
 * @param mode      Evaluation mode for the engine.
 */
export function createEngine(
  compiled: CompiledCircuit,
  mode: EvaluationMode,
): SimulationEngine {
  if (canUseWorkerEngine()) {
    try {
      const engine = new WorkerEngine(compiled.netCount, mode);
      engine.init(compiled);
      return engine;
    } catch {
      // Worker spawn failed — fall through to main-thread engine
    }
  }

  const engine = new DigitalEngine(mode);
  engine.init(compiled);
  return engine;
}
