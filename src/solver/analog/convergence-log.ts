/**
 * Convergence logging ring buffer for the MNA analog engine.
 *
 * Records per-step convergence telemetry (NR iterations, dt reductions,
 * LTE rejections, method switches) into a fixed-capacity ring buffer.
 *
 * Design: zero-cost when disabled. The `enabled` field is a plain boolean
 * that the caller reads once per step() into a local `const`. When false,
 * all `if (logging)` branches are predicted-not-taken with no function
 * calls, no property lookups, and no allocations.
 */

import type { IntegrationMethod } from "./integration.js";

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/** Per-NR-attempt record within a step. */
export interface NRAttemptRecord {
  /** dt used for this NR attempt. */
  dt: number;
  /** Integration method used. */
  method: IntegrationMethod;
  /** Number of NR iterations performed. */
  iterations: number;
  /** Whether NR converged. */
  converged: boolean;
  /** Index of element with largest voltage change at final iteration (-1 if none). */
  blameElement: number;
  /** Index of node with largest voltage change at final iteration (-1 if none). */
  blameNode: number;
  /** Trigger: "initial" | "nr-retry" | "lte-retry" */
  trigger: "initial" | "nr-retry" | "lte-retry";
  /**
   * Per-iteration detail records for this attempt.
   *
   * CONTRACT: When `engine.convergenceLog.enabled === true`, this field MUST be
   * populated with one entry per NR iteration. Per Q5 resolution (ss11.1), the
   * harness `postIterationHook` is NOT a precondition- convergence logging is
   * an independent capability. The drain at `analog-engine.ts:400-408` and
   * `:676-687` fires on the log-enabled gate alone.
   */
  iterationDetails?: Array<{
    iteration: number;
    maxDelta: number;
    maxDeltaNode: number;
    noncon: number;
    converged: boolean;
  }>;
}

/** Per-step record. Fixed-layout for ring buffer. */
export interface StepRecord {
  /** Monotonic step counter. */
  stepNumber: number;
  /** Simulation time at step entry. */
  simTime: number;
  /** Original dt at step entry (before any reductions). */
  entryDt: number;
  /** Final accepted dt. */
  acceptedDt: number;
  /** Integration method at step entry. */
  entryMethod: IntegrationMethod;
  /** Final integration method (may differ after NR-failure order-1 fallback). */
  exitMethod: IntegrationMethod;
  /** All NR attempts for this step (typically 1; more on retry). */
  attempts: NRAttemptRecord[];
  /** LTE worst ratio from computeNewDt. */
  lteWorstRatio: number;
  /** LTE-proposed newDt. */
  lteProposedDt: number;
  /** Whether the step was LTE-rejected. */
  lteRejected: boolean;
  /** Final outcome. */
  outcome: "accepted" | "error";
}

// ---------------------------------------------------------------------------
// ConvergenceLog- fixed-capacity ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer for StepRecords.
 *
 * Pre-allocates `capacity` slots. Writing overwrites the oldest entry.
 * Reading returns entries in chronological order.
 */
export class ConvergenceLog {
  private readonly _buffer: (StepRecord | null)[];
  private _head: number = 0;
  private _count: number = 0;
  readonly capacity: number;

  /**
   * The gating flag. When false, the engine skips all logging code paths.
   * Designed as a public field for JIT-friendly boolean checks- no getter
   * overhead, no prototype chain traversal.
   */
  enabled: boolean = false;

  constructor(capacity: number = 128) {
    this.capacity = capacity;
    this._buffer = new Array<StepRecord | null>(capacity).fill(null);
  }

  /** Record a completed step. Caller must only call when enabled. */
  record(step: StepRecord): void {
    this._buffer[this._head] = step;
    this._head = (this._head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  /** Return all recorded steps in chronological order. */
  getAll(): StepRecord[] {
    if (this._count === 0) return [];
    const result: StepRecord[] = [];
    const start = this._count < this.capacity ? 0 : this._head;
    for (let i = 0; i < this._count; i++) {
      const idx = (start + i) % this.capacity;
      result.push(this._buffer[idx]!);
    }
    return result;
  }

  /** Return the last N steps in reverse chronological order (most recent first). */
  getLast(n: number): StepRecord[] {
    const all = this.getAll();
    return all.slice(-n).reverse();
  }

  /** Clear all entries without changing capacity or enabled state. */
  clear(): void {
    this._buffer.fill(null);
    this._head = 0;
    this._count = 0;
  }
}
