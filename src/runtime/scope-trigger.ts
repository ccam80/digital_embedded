/**
 * ScopeTrigger- connects a Scope component's trigger condition to the
 * timing diagram's recording state.
 *
 * Trigger modes:
 *   - "edge": fires once when the monitored signal transitions from 0 to 1
 *             (rising edge).
 *   - "level": fires on every step while the monitored signal is non-zero.
 *
 * Pre-trigger buffer: a fixed-size circular buffer captures the last N samples
 * before the trigger fires. When the trigger fires, those buffered samples are
 * retrospectively available.
 *
 * Recording window: after the trigger fires the controller records for a
 * configurable number of steps (recordingWindow). When the window is exhausted
 * the state returns to ARMED.
 *
 * When no ScopeTrigger is installed the timing diagram records continuously
 * (this class is simply not used in that case- it does not intercept recording).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerMode = "edge" | "level";

export type TriggerStatus = "armed" | "triggered" | "recording";

/** One sample in the pre-trigger ring buffer. */
export interface PreTriggerSample {
  readonly time: number;
  readonly values: ReadonlyMap<number, number>;
}

/** Listener called when trigger status changes. */
export type TriggerStatusListener = (status: TriggerStatus) => void;

// ---------------------------------------------------------------------------
// ScopeTrigger
// ---------------------------------------------------------------------------

/**
 * Monitors a trigger signal and controls the recording state of the timing
 * diagram.
 *
 * Usage:
 *   const trigger = new ScopeTrigger({
 *     triggerNetId: 0,
 *     mode: "edge",
 *     preTriggerDepth: 10,
 *     recordingWindow: 20,
 *   });
 *   // On each simulation step call:
 *   trigger.onStep(stepCount, signalReader);
 */
export class ScopeTrigger {
  private readonly _triggerNetId: number;
  private readonly _mode: TriggerMode;
  private readonly _preTriggerDepth: number;
  private readonly _recordingWindow: number;

  private _status: TriggerStatus = "armed";
  private _prevTriggerValue = 0;
  private _recordingStepsLeft = 0;

  /** Ring buffer for pre-trigger samples (capacity = preTriggerDepth). */
  private readonly _preBuf: PreTriggerSample[];
  private _preBufHead = 0;
  private _preBufCount = 0;

  private readonly _listeners: Set<TriggerStatusListener> = new Set();

  constructor(opts: {
    triggerNetId: number;
    mode: TriggerMode;
    preTriggerDepth?: number;
    recordingWindow?: number;
  }) {
    this._triggerNetId = opts.triggerNetId;
    this._mode = opts.mode;
    this._preTriggerDepth = opts.preTriggerDepth ?? 0;
    this._recordingWindow = opts.recordingWindow ?? 0;
    this._preBuf = new Array<PreTriggerSample>(Math.max(1, this._preTriggerDepth));
  }

  // -------------------------------------------------------------------------
  // Step processing
  // -------------------------------------------------------------------------

  /**
   * Process one simulation step.
   *
   * @param time         Current simulation step count.
   * @param signalReader Function that returns the raw value for a given net ID.
   * @param monitoredNetIds  Additional net IDs whose values are captured in the
   *                        pre-trigger buffer (besides the trigger signal itself).
   * @returns true if the timing diagram should record this step.
   */
  onStep(
    time: number,
    signalReader: (netId: number) => number,
    monitoredNetIds: readonly number[] = [],
  ): boolean {
    const trigVal = signalReader(this._triggerNetId);
    const fired = this._evaluateTrigger(trigVal);
    this._prevTriggerValue = trigVal;

    // Level mode: simple signal-based recording, no state machine
    if (this._mode === "level") {
      return trigVal !== 0;
    }

    // Edge mode: state machine
    if (this._status === "armed") {
      if (fired) {
        this._setStatus("triggered");
        if (this._recordingWindow > 0) {
          this._recordingStepsLeft = this._recordingWindow;
          this._setStatus("recording");
        }
        return true; // trigger step recorded but does not consume window
      }
      // Not fired: capture pre-trigger sample
      if (this._preTriggerDepth > 0) {
        const values = new Map<number, number>();
        values.set(this._triggerNetId, trigVal);
        for (const id of monitoredNetIds) {
          values.set(id, signalReader(id));
        }
        this._preBuf[this._preBufHead] = { time, values };
        this._preBufHead = (this._preBufHead + 1) % this._preTriggerDepth;
        if (this._preBufCount < this._preTriggerDepth) {
          this._preBufCount++;
        }
      }
      return false;
    }

    if (this._status === "recording") {
      this._recordingStepsLeft--;
      if (this._recordingStepsLeft === 0) {
        this._setStatus("armed");
      }
      return true;
    }

    if (this._status === "triggered") {
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Current trigger status. */
  get status(): TriggerStatus {
    return this._status;
  }

  /**
   * Return the pre-trigger buffer samples in chronological order.
   * Oldest sample first. May contain fewer than preTriggerDepth samples if
   * the trigger fired before the buffer was full.
   */
  getPreTriggerSamples(): readonly PreTriggerSample[] {
    if (this._preBufCount === 0) return [];

    const n = this._preBufCount;
    const result: PreTriggerSample[] = new Array(n);

    if (this._preBufCount < this._preTriggerDepth) {
      // Buffer not yet wrapped- data starts at index 0
      for (let i = 0; i < n; i++) {
        result[i] = this._preBuf[i]!;
      }
    } else {
      // Buffer wrapped- oldest is at _preBufHead
      for (let i = 0; i < n; i++) {
        result[i] = this._preBuf[(this._preBufHead + i) % this._preTriggerDepth]!;
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Status listeners
  // -------------------------------------------------------------------------

  addStatusListener(listener: TriggerStatusListener): void {
    this._listeners.add(listener);
  }

  removeStatusListener(listener: TriggerStatusListener): void {
    this._listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  /** Reset trigger state back to armed, clear pre-trigger buffer. */
  reset(): void {
    this._preBufHead = 0;
    this._preBufCount = 0;
    this._prevTriggerValue = 0;
    this._recordingStepsLeft = 0;
    this._setStatus("armed");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _evaluateTrigger(currentValue: number): boolean {
    switch (this._mode) {
      case "edge":
        // Rising edge: 0 → non-zero
        return this._prevTriggerValue === 0 && currentValue !== 0;
      case "level":
        return currentValue !== 0;
    }
  }

  private _setStatus(status: TriggerStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const listener of this._listeners) {
      listener(status);
    }
  }
}
