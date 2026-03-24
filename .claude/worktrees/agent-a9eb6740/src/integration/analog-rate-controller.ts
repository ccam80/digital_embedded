/**
 * AnalogRateController — paces analog simulation at a target rate.
 *
 * Instead of burning a wall-clock budget and accepting whatever sim-time
 * accumulates, this controller targets a concrete ratio of simulation-seconds
 * per wall-second.  Each animation frame it computes how much sim-time to
 * advance; the caller steps the engine until either the target is reached or
 * the per-frame wall-clock budget is exhausted (a "miss").
 *
 * Sustained misses (>30 % of frames over a sliding window) trigger a
 * user-visible warning.  Hysteresis at 20 % prevents flickering.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalogRateConfig {
  /** Target simulation-seconds per wall-second.  Default: 1e-3 (1 ms / s). */
  targetRate: number;
  /** Max wall-clock ms to spend stepping per frame.  Default: 12. */
  maxBudgetMs: number;
  /** Miss-rate fraction that activates the warning.  Default: 0.3. */
  missThreshold: number;
  /** Miss-rate fraction that clears the warning (hysteresis).  Default: 0.2. */
  clearThreshold: number;
  /** Sliding window duration in ms for miss tracking.  Default: 3000. */
  windowMs: number;
}

export interface FrameTarget {
  /** Simulation-seconds to advance this frame. */
  targetSimAdvance: number;
  /** Wall-clock budget in ms. */
  budgetMs: number;
}

export interface FrameResult {
  /** True when the warning state flipped this frame. */
  warningChanged: boolean;
  /** Current warning state (true = active). */
  warningActive: boolean;
  /** Current miss rate over the sliding window (0–1). */
  missRate: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AnalogRateConfig = {
  targetRate: 1e-3,
  maxBudgetMs: 12,
  missThreshold: 0.3,
  clearThreshold: 0.2,
  windowMs: 3000,
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class AnalogRateController {
  private _config: AnalogRateConfig;
  private _warningActive = false;

  /** Sliding window of per-frame miss/hit records. */
  private _frames: Array<{ ts: number; missed: boolean }> = [];

  constructor(config: Partial<AnalogRateConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  get targetRate(): number {
    return this._config.targetRate;
  }

  set targetRate(rate: number) {
    this._config.targetRate = Math.max(0, rate);
  }

  get isWarningActive(): boolean {
    return this._warningActive;
  }

  // -----------------------------------------------------------------------
  // Per-frame interface
  // -----------------------------------------------------------------------

  /**
   * Compute the sim-time target for one animation frame.
   *
   * @param wallDtSeconds  Wall-clock seconds elapsed since the previous frame.
   */
  computeFrameTarget(wallDtSeconds: number): FrameTarget {
    // Clamp wallDt to 100 ms to avoid huge jumps after tab-away / debugger.
    const clampedDt = Math.min(wallDtSeconds, 0.1);
    return {
      targetSimAdvance: this._config.targetRate * clampedDt,
      budgetMs: this._config.maxBudgetMs,
    };
  }

  /**
   * Record whether this frame met its sim-time target and update the
   * sliding-window miss rate.
   *
   * @param timestamp  rAF timestamp or `performance.now()`.
   * @param missed     True when the budget was exhausted before the target.
   */
  recordFrame(timestamp: number, missed: boolean): FrameResult {
    this._frames.push({ ts: timestamp, missed });

    // Prune entries outside the sliding window.
    const cutoff = timestamp - this._config.windowMs;
    while (this._frames.length > 0 && this._frames[0].ts < cutoff) {
      this._frames.shift();
    }

    // Compute miss rate.
    const total = this._frames.length;
    let misses = 0;
    for (let i = 0; i < total; i++) {
      if (this._frames[i].missed) misses++;
    }
    const missRate = total > 0 ? misses / total : 0;

    // Hysteresis: activate at missThreshold, clear at clearThreshold.
    const prev = this._warningActive;
    if (!this._warningActive && missRate >= this._config.missThreshold) {
      this._warningActive = true;
    } else if (this._warningActive && missRate < this._config.clearThreshold) {
      this._warningActive = false;
    }

    return {
      warningChanged: this._warningActive !== prev,
      warningActive: this._warningActive,
      missRate,
    };
  }

  /** Reset miss tracking (call on speed change or circuit change). */
  reset(): void {
    this._frames = [];
    this._warningActive = false;
  }
}
