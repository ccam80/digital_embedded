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
import { formatSI, parseSI } from "./si-format.js";
import type { ComponentDefinition } from "@/core/registry";
import { availableModels, WELL_KNOWN_PROPERTY_KEYS } from "@/core/registry";
import type { PinElectricalSpec } from "@/core/pin-electrical";
import { resolvePinElectrical } from "@/core/pin-electrical.js";
import type { LogicFamilyConfig } from "@/core/logic-family";
import { PinDirection } from "@/core/pin";

/** Human-friendly labels for simulation mode dropdown. */
const SIMULATION_MODE_LABELS: Record<string, string> = {
  "logical": "Digital",
  "analog-pins": "Analog (at pins)",
  "analog-internals": "Analog (full)",
};

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
  /** The element whose properties are being edited (needed for commit). */
  private _element: CircuitElement | null = null;
  /** Property definitions for the current element (needed for commit). */
  private _definitions: PropertyDefinition[] = [];

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
    this._element = element;
    this._definitions = definitions;

    const bag = element.getProperties();
    /** Rows with conditional visibility, keyed by the property they depend on. */
    const conditionalRows: Map<string, { row: HTMLElement; values: PropertyValue[] }[]> = new Map();

    for (const def of definitions) {
      // showLabel and showValue are rendered inline — skip standalone rows
      if (def.key === "showLabel" || def.key === "showValue") {
        continue;
      }

      const currentValue = bag.has(def.key)
        ? bag.get(def.key)
        : def.defaultValue;

      const input = createInput(def, currentValue);
      this._inputs.set(def.key, input);

      let row: HTMLElement;

      if (def.key === "label") {
        // Build label row with inline showLabel checkbox
        const showLabelVal = bag.has("showLabel") ? bag.get<boolean>("showLabel") : true;
        row = this._buildRowWithCheckbox(def.label, input.element, showLabelVal, (checked) => {
          const old = bag.has("showLabel") ? bag.get("showLabel") : true;
          bag.set("showLabel", checked);
          for (const cb of this._changeCallbacks) cb("showLabel", old, checked);
        });
        // Register a synthetic input so commitAll can read showLabel
        this._inputs.set("showLabel", {
          element: row,
          getValue: () => bag.has("showLabel") ? bag.get("showLabel") : true,
          setValue: (_v) => { /* managed by checkbox */ },
          onChange: (_cb) => { /* managed by checkbox */ },
        });
      } else {
        row = this._buildRow(def.label, input.element);
      }

      this._container.appendChild(row);

      // Track rows with visibleWhen conditions
      if (def.visibleWhen) {
        const depKey = def.visibleWhen.key;
        if (!conditionalRows.has(depKey)) conditionalRows.set(depKey, []);
        conditionalRows.get(depKey)!.push({ row, values: def.visibleWhen.values });
        // Apply initial visibility
        const depValue = bag.has(depKey) ? bag.get(depKey) : definitions.find(d => d.key === depKey)?.defaultValue;
        row.style.display = def.visibleWhen.values.includes(depValue as PropertyValue) ? "" : "none";
      }

      // Capture key at callback registration time.
      const capturedKey = def.key;
      input.onChange((newValue) => {
        // Update conditional visibility of dependent rows
        const deps = conditionalRows.get(capturedKey);
        if (deps) {
          for (const dep of deps) {
            dep.row.style.display = dep.values.includes(newValue) ? "" : "none";
          }
        }
      });
    }

    // Add standalone "Show value" checkbox row if the definition set includes it
    const showValueDef = definitions.find(d => d.key === "showValue");
    if (showValueDef) {
      const showValueVal = bag.has("showValue") ? bag.get<boolean>("showValue") : true;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(showValueVal);
      cb.addEventListener("change", () => {
        const old = bag.has("showValue") ? bag.get("showValue") : true;
        bag.set("showValue", cb.checked);
        for (const ccb of this._changeCallbacks) ccb("showValue", old, cb.checked);
      });
      const wrapper = document.createElement("div");
      wrapper.className = "prop-input prop-boolean";
      wrapper.appendChild(cb);
      const row = this._buildRow("Show value", wrapper);
      this._container.appendChild(row);
      this._inputs.set("showValue", {
        element: row,
        getValue: () => cb.checked,
        setValue: (v) => { cb.checked = Boolean(v); },
        onChange: (_ccb) => { /* managed by checkbox */ },
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

  /**
   * Read every input widget's current DOM value and commit any that differ
   * from the element's PropertyBag. Returns true if at least one value changed.
   * Fires _changeCallbacks once per changed key so undo integration works.
   */
  commitAll(): boolean {
    if (!this._element) return false;
    const bag = this._element.getProperties();
    let anyChanged = false;

    for (const [key, input] of this._inputs) {
      const newValue = input.getValue();
      const def = this._definitions.find(d => d.key === key);
      const oldValue = bag.has(key) ? bag.get(key) : def?.defaultValue;

      if (!_valuesEqual(oldValue, newValue)) {
        bag.set(key, newValue);
        anyChanged = true;
        for (const cb of this._changeCallbacks) {
          cb(key, oldValue ?? newValue, newValue);
        }
      }
    }

    return anyChanged;
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
   * Called after showProperties() when the circuit has analog components and
   * the selected component has simulationModels with more than one entry. The
   * dropdown is appended after the regular property rows.
   *
   * Default is "analog-pins" (read at call time, never persisted on the element
   * until the user changes it).
   *
   * @param element   The selected circuit element.
   * @param def       The component definition declaring simulationModels.
   */
  showSimulationModeDropdown(
    element: CircuitElement,
    def: ComponentDefinition,
  ): void {
    const modes = availableModels(def);
    if (modes.length <= 1) return;

    const bag = element.getProperties();
    const defaultMode = def.defaultModel ?? modes[0] ?? "analog-pins";
    const current = bag.has("simulationModel")
      ? (bag.get("simulationModel") as string)
      : defaultMode;

    const select = document.createElement("select") as unknown as HTMLSelectElement & { value: string };
    for (const mode of modes) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = SIMULATION_MODE_LABELS[mode] ?? mode;
      if (mode === current) {
        (option as unknown as { selected: boolean }).selected = true;
      }
      (select as unknown as { appendChild(c: unknown): void }).appendChild(option);
    }
    select.value = current;

    (select as unknown as { addEventListener(e: string, cb: () => void): void }).addEventListener("change", () => {
      const newMode = select.value;
      const oldValue = bag.has("simulationModel")
        ? bag.get("simulationModel")
        : defaultMode;
      bag.set("simulationModel", newMode);
      for (const cb of this._changeCallbacks) {
        cb("simulationModel", oldValue, newMode);
      }
    });

    const row = this._buildRow("Mode", select as unknown as HTMLElement);
    this._container.appendChild(row);
    this._inputs.set("simulationModel", {
      element: select as unknown as HTMLElement,
      onChange: (_cb: (v: PropertyValue) => void) => { /* managed internally via select change event */ },
      setValue: (v: PropertyValue) => { select.value = v as string; },
      getValue: () => select.value,
    });
  }

  // ---------------------------------------------------------------------------
  // Pin electrical overrides
  // ---------------------------------------------------------------------------

  /**
   * Show a collapsible "Pin Electrical" section for components in analog/mixed
   * circuits. Displays per-pin override fields (rOut, rIn, vOH, vOL, vIH, vIL)
   * with resolved defaults shown as placeholders. Overrides are stored in the
   * element's PropertyBag as a JSON string under `_pinElectricalOverrides`.
   */
  showPinElectricalOverrides(
    element: CircuitElement,
    def: ComponentDefinition,
    family: LogicFamilyConfig,
  ): void {
    const pins = def.pinLayout;
    if (!pins || pins.length === 0) return;

    const bag = element.getProperties();
    const stored: Record<string, PinElectricalSpec> = bag.has("_pinElectricalOverrides")
      ? JSON.parse(bag.get("_pinElectricalOverrides") as string)
      : {};

    // Section header (collapsible)
    const section = document.createElement("div");
    section.style.marginTop = "10px";

    const toggle = document.createElement("div");
    toggle.style.cssText = "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;cursor:pointer;user-select:none;";
    toggle.textContent = "▶ Pin Electrical";
    const content = document.createElement("div");
    content.style.display = "none";

    toggle.addEventListener("click", () => {
      const open = content.style.display !== "none";
      content.style.display = open ? "none" : "block";
      toggle.textContent = (open ? "▶" : "▼") + " Pin Electrical";
    });

    section.appendChild(toggle);
    section.appendChild(content);

    // Fields to show per pin, based on pin direction
    const outputFields: (keyof PinElectricalSpec)[] = ["rOut", "vOH", "vOL"];
    const inputFields: (keyof PinElectricalSpec)[] = ["rIn", "vIH", "vIL"];
    const fieldLabels: Record<string, string> = {
      rOut: "Rout", rIn: "Rin", vOH: "V_OH", vOL: "V_OL",
      vIH: "V_IH", vIL: "V_IL",
    };
    const fieldUnits: Record<string, string> = {
      rOut: "Ω", rIn: "Ω", vOH: "V", vOL: "V", vIH: "V", vIL: "V",
    };

    for (const pin of pins) {
      const pinLabel = pin.label;
      const fields = pin.direction === PinDirection.OUTPUT ? outputFields : inputFields;
      const pinOverride = def.models?.analog?.pinElectricalOverrides?.[pinLabel];
      const resolved = resolvePinElectrical(family, pinOverride, def.models?.analog?.pinElectrical);

      const pinDiv = document.createElement("div");
      pinDiv.style.cssText = "margin:6px 0 0 8px;font-size:11px;";

      const pinHeader = document.createElement("div");
      pinHeader.style.cssText = "font-weight:600;margin-bottom:3px;";
      pinHeader.textContent = `${pinLabel} (${pin.direction === PinDirection.OUTPUT ? "out" : "in"})`;
      pinDiv.appendChild(pinHeader);

      for (const field of fields) {
        const overrideVal = stored[pinLabel]?.[field];
        const resolvedVal = resolved[field as keyof typeof resolved] as number;
        const unit = fieldUnits[field] ?? "";

        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:4px;margin:2px 0;";

        const label = document.createElement("span");
        label.style.cssText = "min-width:50px;opacity:0.7;";
        label.textContent = fieldLabels[field] ?? field;

        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = unit ? formatSI(resolvedVal, "", 3).trim() : String(resolvedVal);
        input.value = overrideVal !== undefined
          ? (unit ? formatSI(overrideVal, "", 3).trim() : String(overrideVal))
          : "";
        input.style.cssText = "width:70px;padding:2px 4px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;font-size:11px;";

        const unitSpan = document.createElement("span");
        unitSpan.style.cssText = "opacity:0.5;font-size:11px;min-width:16px;";
        unitSpan.textContent = unit;

        input.addEventListener("focus", () => input.select());

        const commitOverride = () => {
          const current: Record<string, PinElectricalSpec> = bag.has("_pinElectricalOverrides")
            ? JSON.parse(bag.get("_pinElectricalOverrides") as string)
            : {};
          if (!current[pinLabel]) current[pinLabel] = {};
          const raw = input.value.trim();
          if (raw === "") {
            delete current[pinLabel]![field];
            if (Object.keys(current[pinLabel]!).length === 0) delete current[pinLabel];
            input.value = "";
          } else {
            const parsed = unit ? parseSI(raw) : parseFloat(raw);
            if (isNaN(parsed)) {
              // Revert on bad input
              input.value = overrideVal !== undefined
                ? (unit ? formatSI(overrideVal, "", 3).trim() : String(overrideVal))
                : "";
              return;
            }
            current[pinLabel]![field] = parsed;
            input.value = unit ? formatSI(parsed, "", 3).trim() : String(parsed);
          }
          const oldValue = bag.has("_pinElectricalOverrides") ? bag.get("_pinElectricalOverrides") : undefined;
          const newValue = Object.keys(current).length > 0 ? JSON.stringify(current) : undefined;
          if (newValue !== undefined) {
            bag.set("_pinElectricalOverrides", newValue);
          } else if (bag.has("_pinElectricalOverrides")) {
            bag.set("_pinElectricalOverrides", "{}");
          }
          for (const cb of this._changeCallbacks) {
            cb("_pinElectricalOverrides", oldValue ?? "{}", newValue ?? "{}");
          }
        };

        input.addEventListener("blur", commitOverride);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); commitOverride(); input.blur(); }
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(unitSpan);
        pinDiv.appendChild(row);
      }

      content.appendChild(pinDiv);
    }

    this._container.appendChild(section);
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
    this._element = null;
    this._definitions = [];
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

  /**
   * Build a property row with an inline checkbox to the right of the input.
   * Used for the label field where the checkbox controls showLabel visibility.
   */
  private _buildRowWithCheckbox(
    label: string,
    inputEl: HTMLElement,
    checked: boolean,
    onToggle: (checked: boolean) => void,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "prop-row";

    const labelEl = document.createElement("label");
    labelEl.className = "prop-label";
    labelEl.textContent = label;

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";
    wrapper.style.flex = "1";

    // The main input takes most of the space
    inputEl.style.flex = "1";
    inputEl.style.minWidth = "0";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.title = "Show on canvas";
    cb.style.flexShrink = "0";
    cb.addEventListener("change", () => onToggle(cb.checked));

    wrapper.appendChild(inputEl);
    wrapper.appendChild(cb);

    row.appendChild(labelEl);
    row.appendChild(wrapper);
    return row;
  }
}

/** Shallow equality for PropertyValue, handling number[] arrays. */
function _valuesEqual(a: PropertyValue | undefined, b: PropertyValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  // eslint-disable-next-line eqeqeq
  return a == b;
}
