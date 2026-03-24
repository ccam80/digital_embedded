/**
 * RedrawCoordinator — manages the requestAnimationFrame loop for the simulation.
 *
 * When the engine is RUNNING the coordinator schedules a rAF loop that calls
 * engine.step() N times per frame to match the target steps-per-second speed.
 * When the engine transitions to STOPPED or PAUSED the loop is cancelled and a
 * single final repaint callback is issued.
 *
 * This module is browser-aware (uses requestAnimationFrame / cancelAnimationFrame)
 * but has no direct canvas or DOM imports. The repaint callback is injected so
 * tests can replace rAF with a synchronous stub.
 */

import { EngineState } from "@/core/engine-interface";
import type { SimulationEngine } from "@/core/engine-interface";
import type { SpeedControl } from "./speed-control";

/** Called after each batch of steps so the renderer can update the display. */
export type RepaintCallback = () => void;

/**
 * Platform rAF handle. In browsers this is the handle returned by
 * requestAnimationFrame. In tests it is replaced with a stub that returns
 * a numeric handle.
 */
export interface RafProvider {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

const BROWSER_RAF: RafProvider = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
};

export class RedrawCoordinator {
  private _engine: SimulationEngine | null = null;
  private _repaint: RepaintCallback | null = null;
  private _rafHandle: number | null = null;
  private _speedControl: SpeedControl | null = null;
  private readonly _raf: RafProvider;
  private _lastFrameTime: number = 0;

  constructor(raf: RafProvider = BROWSER_RAF) {
    this._raf = raf;
  }

  /**
   * Attach coordinator to an engine and repaint callback.
   * Registers a change listener so state transitions automatically start/stop
   * the rAF loop.
   */
  attach(
    engine: SimulationEngine,
    speedControl: SpeedControl,
    repaint: RepaintCallback,
  ): void {
    this.detach();
    this._engine = engine;
    this._speedControl = speedControl;
    this._repaint = repaint;
    engine.addChangeListener(this._onStateChange);

    if (engine.getState() === EngineState.RUNNING) {
      this._startLoop();
    }
  }

  /** Detach from the current engine. Stops any running loop. */
  detach(): void {
    if (this._engine !== null) {
      this._engine.removeChangeListener(this._onStateChange);
    }
    this._stopLoop();
    this._engine = null;
    this._speedControl = null;
    this._repaint = null;
  }

  get isRunning(): boolean {
    return this._rafHandle !== null;
  }

  private _onStateChange = (state: EngineState): void => {
    if (state === EngineState.RUNNING) {
      this._startLoop();
    } else {
      this._stopLoop();
      this._repaint?.();
    }
  };

  private _startLoop(): void {
    if (this._rafHandle !== null) return;
    this._lastFrameTime = 0;
    this._rafHandle = this._raf.request(this._frame);
  }

  private _stopLoop(): void {
    if (this._rafHandle !== null) {
      this._raf.cancel(this._rafHandle);
      this._rafHandle = null;
    }
  }

  private _frame = (timestamp: number): void => {
    this._rafHandle = null;

    const engine = this._engine;
    const speedControl = this._speedControl;
    if (engine === null || speedControl === null) return;
    if (engine.getState() !== EngineState.RUNNING) return;

    const targetStepsPerSecond = speedControl.speed;
    const FRAME_RATE = 60;

    if (this._lastFrameTime === 0) {
      this._lastFrameTime = timestamp;
    }

    const elapsed = Math.min((timestamp - this._lastFrameTime) / 1000, 0.1);
    this._lastFrameTime = timestamp;

    const stepsThisFrame = Math.max(
      1,
      Math.round(targetStepsPerSecond * elapsed),
    );

    const stepsPerFrame = Math.ceil(targetStepsPerSecond / FRAME_RATE);
    const actualSteps = Math.min(stepsThisFrame, stepsPerFrame * 2);

    for (let i = 0; i < actualSteps; i++) {
      engine.step();
    }

    this._repaint?.();

    this._rafHandle = this._raf.request(this._frame);
  };
}
