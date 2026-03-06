/**
 * Oscillation detection for feedback SCC evaluation.
 *
 * When a feedback group fails to stabilize within the iteration limit,
 * the OscillationDetector identifies which components are still toggling.
 * This mirrors Digital's oscillation detection in Model.doMicroStep():
 * after N iterations without stability, collect the culprits for 100 more
 * steps to confirm the pattern, then report them.
 *
 */

/** Default number of micro-step iterations before oscillation is declared. */
export const DEFAULT_OSCILLATION_LIMIT = 1000;

/**
 * Number of additional steps to observe after the limit is exceeded,
 * used to confirm which components are genuinely oscillating vs transiently
 * unstable.
 */
const COLLECTION_STEPS = 100;

/**
 * Detects and identifies oscillating components in a feedback SCC.
 *
 * Usage:
 *   1. Call tick() on each iteration of the feedback evaluation loop.
 *   2. When isOverLimit() is true, call collectOscillatingComponents() for
 *      each of the next COLLECTION_STEPS iterations, passing the set of
 *      components that changed in that step.
 *   3. Call getOscillatingComponents() to retrieve the confirmed oscillators.
 *   4. Call reset() to reuse the detector for the next circuit or reset.
 */
export class OscillationDetector {
  private readonly _limit: number;
  private _count: number = 0;

  /**
   * Maps component index → number of times it appeared during the collection
   * period. Components that appear in every collection step are confirmed
   * oscillators.
   */
  private _collectionCounts: Map<number, number> = new Map();
  private _collectionStepsRecorded: number = 0;

  constructor(limit: number = DEFAULT_OSCILLATION_LIMIT) {
    this._limit = limit;
  }

  /** Increment the iteration counter by one. */
  tick(): void {
    this._count++;
  }

  /** Returns true once the iteration count exceeds the configured limit. */
  isOverLimit(): boolean {
    return this._count > this._limit;
  }

  /**
   * Record which components were scheduled (changed) in one collection step.
   *
   * Call this once per iteration during the COLLECTION_STEPS period after
   * isOverLimit() first returns true. Each component that appears in every
   * collection step is a confirmed oscillator.
   */
  collectOscillatingComponents(scheduled: Iterable<number>): void {
    this._collectionStepsRecorded++;
    for (const idx of scheduled) {
      const current = this._collectionCounts.get(idx) ?? 0;
      this._collectionCounts.set(idx, current + 1);
    }
  }

  /**
   * Return the list of component indices that appeared in every collection
   * step, confirming they are genuinely oscillating.
   *
   * If no collection has been done (collectOscillatingComponents was never
   * called), returns all components that appeared at least once.
   */
  getOscillatingComponents(): number[] {
    const threshold = this._collectionStepsRecorded > 0
      ? this._collectionStepsRecorded
      : 1;

    const result: number[] = [];
    for (const [idx, count] of this._collectionCounts) {
      if (count >= threshold) {
        result.push(idx);
      }
    }
    result.sort((a, b) => a - b);
    return result;
  }

  /** Reset all state. The detector can be reused after reset(). */
  reset(): void {
    this._count = 0;
    this._collectionCounts = new Map();
    this._collectionStepsRecorded = 0;
  }
}
