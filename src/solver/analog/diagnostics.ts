/**
 * Diagnostic emission and collection infrastructure for the analog solver.
 *
 * The `DiagnosticCollector` class provides the runtime machinery for emitting,
 * collecting, and dispatching `SolverDiagnostic` events produced by the
 * Newton-Raphson loop, DC operating point solver, and timestep controller.
 *
 * Diagnostics are collected synchronously and dispatched to all registered
 * callbacks in emission order. Listeners can inspect any diagnostic and decide
 * how to act on it (log to console, update UI, adjust solver parameters, etc.).
 */

import type { SolverDiagnostic, SolverDiagnosticCode } from "../../core/analog-engine-interface.js";

/**
 * Convergence trace captured during a Newton-Raphson iteration.
 *
 * Records the element causing largest voltage change, any oscillating behavior,
 * the current iteration count, and which fallback mode is active (if any).
 * Emitted as part of convergence diagnostics for pedagogical debugging.
 */
export interface ConvergenceTrace {
  /** Index of the MNA element with the largest voltage change this iteration. */
  largestChangeElement: number;
  /** Index of the MNA node with the largest voltage change this iteration. */
  largestChangeNode: number;
  /** True if the iteration is oscillating (voltage changes exceed convergence threshold repeatedly). */
  oscillating: boolean;
  /** Current Newton-Raphson iteration number (0-indexed). */
  iteration: number;
  /** Current fallback mode: 'none' for direct NR, 'gmin' for Gmin stepping, 'source-step' for source stepping. */
  fallbackLevel: "none" | "gmin" | "source-step";
}

/**
 * Collects and dispatches `SolverDiagnostic` events emitted by the analog solver.
 *
 * - `emit()` stores a diagnostic and synchronously calls all registered listeners
 * - `onDiagnostic()` registers a listener callback
 * - `removeDiagnosticListener()` unregisters a listener
 * - `getDiagnostics()` returns all collected diagnostics since last clear
 * - `clear()` resets the collected diagnostics array (called between analyses)
 *
 * Multiple listeners are supported and called in registration order.
 */
export class DiagnosticCollector {
  private _diagnostics: SolverDiagnostic[] = [];
  private _listeners: Array<(diag: SolverDiagnostic) => void> = [];

  /**
   * Emit a diagnostic event.
   *
   * Stores the diagnostic in the collected array and synchronously dispatches
   * it to all registered listeners in registration order.
   *
   * @param diag - The diagnostic to emit
   */
  emit(diag: SolverDiagnostic): void {
    this._diagnostics.push(diag);
    for (const listener of this._listeners) {
      listener(diag);
    }
  }

  /**
   * Register a callback to receive emitted diagnostics.
   *
   * Multiple callbacks can be registered; each is called in registration order
   * whenever `emit()` is called.
   *
   * @param callback - Listener function that receives the diagnostic
   */
  onDiagnostic(callback: (diag: SolverDiagnostic) => void): void {
    this._listeners.push(callback);
  }

  /**
   * Unregister a previously registered diagnostic listener.
   *
   * The callback is compared by reference; only the first matching callback
   * is removed.
   *
   * @param callback - The listener to remove
   */
  removeDiagnosticListener(callback: (diag: SolverDiagnostic) => void): void {
    const idx = this._listeners.indexOf(callback);
    if (idx >= 0) {
      this._listeners.splice(idx, 1);
    }
  }

  /**
   * Return all collected diagnostics since the last `clear()`.
   *
   * @returns Array of emitted diagnostics in emission order
   */
  getDiagnostics(): SolverDiagnostic[] {
    return this._diagnostics;
  }

  /**
   * Clear the collected diagnostics array.
   *
   * Called between analyses (DC operating point, transient, AC sweep) to start
   * fresh. Does not unregister listeners.
   */
  clear(): void {
    this._diagnostics = [];
  }
}

/**
 * Factory helper to construct a `SolverDiagnostic` with required fields filled in.
 *
 * Provides defaults for optional fields:
 * - `suggestions` defaults to `[]`
 * - `involvedNodes` defaults to `undefined`
 * - `involvedElements` defaults to `undefined`
 * - `simTime` defaults to `undefined`
 * - `detail` defaults to `undefined`
 *
 * All fields present in `opts` override defaults; any fields NOT present in
 * `opts` use the defaults above.
 *
 * @param code - Machine-readable diagnostic code
 * @param severity - Severity level: 'info', 'warning', or 'error'
 * @param summary - One-line summary of the issue
 * @param opts - Optional partial diagnostic fields to override defaults
 * @returns A complete `SolverDiagnostic` object
 */
export function makeDiagnostic(
  code: SolverDiagnosticCode,
  severity: "info" | "warning" | "error",
  summary: string,
  opts?: Partial<SolverDiagnostic>
): SolverDiagnostic {
  return {
    code,
    severity,
    summary,
    explanation: opts?.explanation ?? "",
    suggestions: opts?.suggestions ?? [],
    involvedNodes: opts?.involvedNodes,
    involvedElements: opts?.involvedElements,
    simTime: opts?.simTime,
    detail: opts?.detail,
  };
}
