/**
 * SliderEngineBridge — connects SliderPanel to the AnalogEngine.
 *
 * When a slider value changes, the bridge:
 *   1. Calls the element's optional `setParam()` method to update its internal value.
 *   2. The engine re-stamps and re-factors on the next step (numeric only — no
 *      topology invalidation).
 *
 * For linear elements (R, C, L): the conductance / companion model value is
 * updated; re-factor is typically < 1ms.
 * For nonlinear elements: the new parameter takes effect at the next NR
 * iteration (the element reads its params during `stampNonlinear()`).
 */

import type { AnalogEngine } from "@/core/analog-engine-interface";
import type { CompiledAnalogCircuit } from "@/core/analog-engine-interface";
import { SliderPanel } from "./slider-panel.js";

/**
 * Optional extension on AnalogElement for parameter mutation at runtime.
 *
 * Elements that support live parameter updates implement `setParam(key, value)`
 * so the bridge can push new values without re-compiling the circuit.
 */
export interface ParameterMutableElement {
  setParam(key: string, value: number): void;
}

function isParameterMutable(el: unknown): el is ParameterMutableElement {
  return typeof (el as ParameterMutableElement).setParam === "function";
}

/**
 * Bridges a SliderPanel to an AnalogEngine so that slider changes propagate
 * to element parameters in real time.
 */
export class SliderEngineBridge {
  private readonly _panel: SliderPanel;
  private readonly _engine: AnalogEngine;
  private readonly _compiled: CompiledAnalogCircuit;

  /**
   * @param panel    - The SliderPanel whose changes drive the engine.
   * @param engine   - The active AnalogEngine instance.
   * @param compiled - The compiled analog circuit providing element access.
   */
  constructor(panel: SliderPanel, engine: AnalogEngine, compiled: CompiledAnalogCircuit) {
    this._panel = panel;
    this._engine = engine;
    this._compiled = compiled;

    // Register the change handler
    this._panel.onSliderChange((elementId, propertyKey, value) => {
      this._applyParameterChange(elementId, propertyKey, value);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply a parameter change to the element and signal the engine to
   * re-stamp on the next step.
   *
   * The engine's `configure()` method is called with an empty partial to
   * trigger a re-stamp without changing any solver parameters. Elements that
   * implement `setParam` receive the new value directly.
   */
  private _applyParameterChange(elementId: number, propertyKey: string, value: number): void {
    const elements = (this._compiled as unknown as { elements: unknown[] }).elements;
    if (!elements) return;

    const el = elements[elementId];
    if (!el) return;

    if (isParameterMutable(el)) {
      el.setParam(propertyKey, value);
    }

    // Signal the engine that numeric stamps need refreshing on next step.
    // configure() with an empty partial merges without changing any params,
    // but it rebuilds the timestep controller so the engine re-reads elements.
    this._engine.configure({});
  }
}
