/**
 * SliderEngineBridge — connects SliderPanel to the SimulationCoordinator.
 *
 * When a slider value changes, the bridge:
 *   1. Resolves the analog element from the coordinator's current resolver context.
 *   2. Calls coordinator.setComponentProperty(element, key, value), which
 *      internally calls setParam() on the element and triggers engine re-stamp.
 *
 */

import type { SimulationCoordinator } from "@/solver/coordinator-types.js";
import { SliderPanel } from "./slider-panel.js";

/**
 * Bridges a SliderPanel to a SimulationCoordinator so that slider changes
 * propagate to element parameters in real time.
 */
export class SliderEngineBridge {
  private readonly _panel: SliderPanel;
  private readonly _coordinator: SimulationCoordinator;

  /**
   * @param panel       - The SliderPanel whose changes drive the coordinator.
   * @param coordinator - The active SimulationCoordinator.
   */
  constructor(panel: SliderPanel, coordinator: SimulationCoordinator) {
    this._panel = panel;
    this._coordinator = coordinator;

    this._panel.onSliderChange((elementId, propertyKey, value) => {
      this._applyParameterChange(elementId, propertyKey, value);
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the CircuitElement for the given analog element index via the
   * coordinator's current resolver context, then delegate to
   * coordinator.setComponentProperty() which handles setParam + re-stamp.
   */
  private _applyParameterChange(elementId: number, propertyKey: string, value: number): void {
    const ctx = this._coordinator.getCurrentResolverContext();
    if (!ctx) return;

    const element = ctx.elementToCircuitElement.get(elementId);
    if (!element) return;

    // Update the CircuitElement's PropertyBag so the value persists across
    // recompilations and is serialized with the circuit.
    if (typeof element.getProperties === 'function') {
      element.getProperties().set(propertyKey, value);
    }

    this._coordinator.setComponentProperty(element, propertyKey, value);
  }
}
