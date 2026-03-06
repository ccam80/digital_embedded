/**
 * SimulationController — state machine for the engine lifecycle.
 *
 * Manages the STOPPED / RUNNING / PAUSED / ERROR lifecycle of a DigitalEngine.
 * In continuous run mode, calls engine.step() N times per animation frame
 * (browser) or via setTimeout(0) (headless), then invokes registered render
 * callbacks so the UI can update.
 *
 * State transitions:
 *   STOPPED → start()  → RUNNING
 *   RUNNING → stop()   → PAUSED
 *   PAUSED  → start()  → RUNNING
 *   PAUSED  → reset()  → STOPPED
 *   STOPPED → step()   → STOPPED  (stays STOPPED)
 *   PAUSED  → step()   → PAUSED   (stays PAUSED)
 *   any     → error    → ERROR
 *   ERROR   → reset()  → STOPPED
 *
 */

import { EngineState } from "@/core/engine-interface";
import { SimulationError } from "@/core/errors";
import type { DigitalEngine } from "./digital-engine.js";

// ---------------------------------------------------------------------------
// SimulationController
// ---------------------------------------------------------------------------

/**
 * Wraps a DigitalEngine and provides a controlled lifecycle with continuous
 * run support and configurable simulation speed.
 *
 * Usage:
 *   const ctrl = new SimulationController(engine);
 *   ctrl.setSpeed(10);          // 10 steps per animation frame
 *   ctrl.onError((err) => ...); // register error handler
 *   ctrl.start();               // begin continuous simulation
 *   ctrl.stop();                // pause
 *   ctrl.step();                // single step from STOPPED or PAUSED
 *   ctrl.reset();               // re-initialize
 */
export class SimulationController {
  private readonly _engine: DigitalEngine;
  private _state: EngineState = EngineState.STOPPED;
  private _stepsPerFrame: number = 1;
  private _errorCallbacks: Array<(error: SimulationError) => void> = [];
  private _rafHandle: number = -1;

  constructor(engine: DigitalEngine) {
    this._engine = engine;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin continuous simulation.
   * Transitions STOPPED or PAUSED → RUNNING.
   * If already RUNNING, does nothing.
   */
  start(): void {
    if (this._state === EngineState.RUNNING) return;
    if (this._state === EngineState.ERROR) return;
    this._setState(EngineState.RUNNING);
    this._scheduleContinuousRun();
  }

  /**
   * Pause simulation.
   * Transitions RUNNING → PAUSED.
   * If already PAUSED or STOPPED, does nothing.
   */
  stop(): void {
    this._stopContinuousRun();
    if (this._state === EngineState.RUNNING) {
      this._setState(EngineState.PAUSED);
    }
  }

  /**
   * Re-initialize the engine and transition to STOPPED.
   * Stops any continuous run first.
   */
  reset(): void {
    this._stopContinuousRun();
    this._engine.reset();
    this._setState(EngineState.STOPPED);
  }

  /**
   * Perform a single simulation step.
   * Works from STOPPED or PAUSED state — stays in the current state after.
   * Does nothing if RUNNING (continuous run is managing steps).
   * Does nothing if in ERROR state.
   */
  step(): void {
    if (this._state === EngineState.RUNNING) return;
    if (this._state === EngineState.ERROR) return;
    this._runStep();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set how many engine steps are executed per animation frame during
   * continuous run mode. Must be at least 1.
   *
   * @param stepsPerFrame  Number of step() calls per frame. Default: 1.
   */
  setSpeed(stepsPerFrame: number): void {
    this._stepsPerFrame = Math.max(1, stepsPerFrame);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Return the current engine lifecycle state. */
  getState(): EngineState {
    return this._state;
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  /**
   * Register a callback invoked when engine.step() throws a SimulationError.
   * Multiple callbacks may be registered; all are called in registration order.
   */
  onError(callback: (error: SimulationError) => void): void {
    this._errorCallbacks.push(callback);
  }

  // -------------------------------------------------------------------------
  // Private: single step execution with error catching
  // -------------------------------------------------------------------------

  private _runStep(): void {
    try {
      this._engine.step();
    } catch (err) {
      this._stopContinuousRun();
      this._setState(EngineState.ERROR);
      const simError =
        err instanceof SimulationError
          ? err
          : new SimulationError(err instanceof Error ? err.message : String(err));
      for (const cb of this._errorCallbacks) {
        cb(simError);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: continuous run loop
  // -------------------------------------------------------------------------

  private _scheduleContinuousRun(): void {
    if (typeof requestAnimationFrame !== "undefined") {
      const tick = (): void => {
        if (this._state !== EngineState.RUNNING) return;
        for (let i = 0; i < this._stepsPerFrame; i++) {
          this._runStep();
          if (this._state !== EngineState.RUNNING) return;
        }
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    } else {
      const tick = (): void => {
        if (this._state !== EngineState.RUNNING) return;
        for (let i = 0; i < this._stepsPerFrame; i++) {
          this._runStep();
          if (this._state !== EngineState.RUNNING) return;
        }
        this._rafHandle = setTimeout(tick, 0) as unknown as number;
      };
      this._rafHandle = setTimeout(tick, 0) as unknown as number;
    }
  }

  private _stopContinuousRun(): void {
    if (this._rafHandle !== -1) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this._rafHandle);
      } else {
        clearTimeout(this._rafHandle);
      }
      this._rafHandle = -1;
    }
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  private _setState(newState: EngineState): void {
    this._state = newState;
  }
}
