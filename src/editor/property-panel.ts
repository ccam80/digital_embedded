/**
 * PropertyPanel — right-side panel showing properties of the selected element.
 *
 * Populated by showProperties(). Fires onChange callbacks when a value changes.
 * Collapsible for iframe-embedded mode.
 */

import type { CircuitElement } from "@/core/element";
import type { PropertyDefinition, PropertyValue } from "@/core/properties";
import { createInput } from "./property-inputs.js";
import type { PropertyInput } from "./property-inputs.js";
import type { ComponentDefinition } from "@/core/registry";

// ---------------------------------------------------------------------------
// Change callback type
// ---------------------------------------------------------------------------

export type PropertyChangeCallback = (
  key: string,
  oldValue: PropertyValue,
  newValue: PropertyValue,
) => void;

// ---------------------------------------------------------------------------
// PropertyPanel
// ---------------------------------------------------------------------------

/**
 * Manages the property editor panel DOM.
 *
 * showProperties() clears the panel and creates one input per property
 * definition. Changes fire the registered callback with old and new values
 * for undo integration.
 */
export class PropertyPanel {
  private readonly _container: HTMLElement;
  private _changeCallbacks: PropertyChangeCallback[] = [];
  private _collapsed = false;
  /** Currently shown inputs, keyed by property key. */
  private _inputs: Map<string, PropertyInput> = new Map();

  constructor(container: HTMLElement) {
    this._container = container;
  }

  // ---------------------------------------------------------------------------
  // Population
  // ---------------------------------------------------------------------------

  /**
   * Populate the panel with inputs for each definition, using the element's
   * current property values as initial values.
   */
  showProperties(
    element: CircuitElement,
    definitions: PropertyDefinition[],
  ): void {
    this._clear();

    const bag = element.getProperties();

    for (const def of definitions) {
      const currentValue = bag.has(def.key)
        ? bag.get(def.key)
        : def.defaultValue;

      const input = createInput(def, currentValue);
      this._inputs.set(def.key, input);

      const row = this._buildRow(def.label, input.element);
      this._container.appendChild(row);

      // Capture oldValue at callback registration time.
      const capturedKey = def.key;
      input.onChange((newValue) => {
        const oldValue = bag.has(capturedKey)
          ? bag.get(capturedKey)
          : def.defaultValue;
        bag.set(capturedKey, newValue);
        for (const cb of this._changeCallbacks) {
          cb(capturedKey, oldValue, newValue);
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Change callback
  // ---------------------------------------------------------------------------

  /**
   * Register a callback fired when any property changes. Provides old and new
   * values so the caller can create an undo command.
   */
  onPropertyChange(callback: PropertyChangeCallback): void {
    this._changeCallbacks.push(callback);
  }

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  /**
   * Remove all inputs from the panel (no selection state).
   */
  clear(): void {
    this._clear();
  }

  // ---------------------------------------------------------------------------
  // Collapsed state
  // ---------------------------------------------------------------------------

  /**
   * Show or hide the entire panel for iframe-embedded mode.
   */
  setCollapsed(collapsed: boolean): void {
    this._collapsed = collapsed;
    this._container.style.display = collapsed ? "none" : "";
  }

  /**
   * Returns true when the panel is hidden.
   */
  isCollapsed(): boolean {
    return this._collapsed;
  }

  // ---------------------------------------------------------------------------
  // Simulation mode dropdown (analog mode only)
  // ---------------------------------------------------------------------------

  /**
   * Show the simulation mode dropdown for a component that supports multiple
   * simulation modes in an analog circuit.
   *
   * Called after showProperties() when the circuit engineType is "analog" and
   * the selected component has simulationModes with more than one entry. The
   * dropdown is appended after the regular property rows.
   *
   * Default is "behavioral" (read at call time, never persisted on the element
   * until the user changes it).
   *
   * @param element   The selected circuit element.
   * @param def       The component definition declaring simulationModes.
   */
  showSimulationModeDropdown(
    element: CircuitElement,
    def: ComponentDefinition,
  ): void {
    const modes = def.simulationModes;
    if (!modes || modes.length <= 1) return;

    const bag = element.getProperties();
    const current = bag.has("simulationMode")
      ? (bag.get("simulationMode") as string)
      : "behavioral";

    const select = document.createElement("select") as unknown as HTMLSelectElement & { value: string };
    for (const mode of modes) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = mode;
      if (mode === current) {
        (option as unknown as { selected: boolean }).selected = true;
      }
      (select as unknown as { appendChild(c: unknown): void }).appendChild(option);
    }
    select.value = current;

    (select as unknown as { addEventListener(e: string, cb: () => void): void }).addEventListener("change", () => {
      const newMode = select.value;
      const oldValue = bag.has("simulationMode")
        ? bag.get("simulationMode")
        : "behavioral";
      bag.set("simulationMode", newMode);
      for (const cb of this._changeCallbacks) {
        cb("simulationMode", oldValue, newMode);
      }
    });

    const row = this._buildRow("Simulation Mode", select as unknown as HTMLElement);
    this._container.appendChild(row);
    this._inputs.set("simulationMode", {
      element: select as unknown as HTMLElement,
      onChange: (_cb: (v: PropertyValue) => void) => { /* managed internally via select change event */ },
      setValue: (v: PropertyValue) => { select.value = v as string; },
      getValue: () => select.value,
    });
  }

  // ---------------------------------------------------------------------------
  // Input access (for tests)
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of property input rows currently shown.
   */
  getInputCount(): number {
    return this._inputs.size;
  }

  /**
   * Returns the input widget for the given property key, or undefined.
   */
  getInput(key: string): PropertyInput | undefined {
    return this._inputs.get(key);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _clear(): void {
    this._container.innerHTML = "";
    this._inputs.clear();
  }

  private _buildRow(label: string, inputEl: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "prop-row";

    const labelEl = document.createElement("label");
    labelEl.className = "prop-label";
    labelEl.textContent = label;

    row.appendChild(labelEl);
    row.appendChild(inputEl);
    return row;
  }
}
