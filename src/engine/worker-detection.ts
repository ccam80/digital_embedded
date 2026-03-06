/**
 * Worker detection and engine factory.
 *
 * Detects whether SharedArrayBuffer is available (requires Cross-Origin-Isolation
 * headers: COOP + COEP). If available, creates a WorkerEngine that runs the
 * simulation in a Web Worker with SAB-backed signal state. Falls back to a
 * main-thread DigitalEngine when SAB is unavailable.
 *
 * Cross-Origin-Isolation is required because SharedArrayBuffer was re-restricted
 * after Spectre. Pages must serve:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 */

import { DigitalEngine } from "./digital-engine.js";
import { WorkerEngine } from "./worker-engine.js";
import type { SimulationEngine, CompiledCircuit } from "@/core/engine-interface";
import type { EvaluationMode } from "./evaluation-mode.js";

// ---------------------------------------------------------------------------
// canUseSharedArrayBuffer
// ---------------------------------------------------------------------------

/**
 * Returns true when SharedArrayBuffer is available in the current environment.
 *
 * In browsers, this requires Cross-Origin-Isolation headers.
 * In Node.js (test environment), SharedArrayBuffer is always available.
 */
export function canUseSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

/**
 * Factory that returns the best available engine implementation.
 *
 * When SharedArrayBuffer is available:
 *   Returns a WorkerEngine that runs the simulation in a Web Worker.
 *   Signal state is in a SAB-backed Uint32Array readable from the main thread
 *   via Atomics.load() without blocking.
 *
 * When SharedArrayBuffer is unavailable:
 *   Returns a DigitalEngine running on the main thread.
 *
 * @param compiled  The compiled circuit to simulate.
 * @param mode      Evaluation mode for the engine.
 */
export function createEngine(
  compiled: CompiledCircuit,
  mode: EvaluationMode,
): SimulationEngine {
  if (canUseSharedArrayBuffer()) {
    const engine = new WorkerEngine(compiled.netCount, mode);
    engine.init(compiled);
    return engine;
  }

  const engine = new DigitalEngine(mode);
  engine.init(compiled);
  return engine;
}
