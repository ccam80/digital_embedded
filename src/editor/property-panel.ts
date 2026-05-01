/**
 * PropertyPanel- right-side panel showing properties of the selected element.
 *
 * Populated by showProperties(). Fires onChange callbacks when a value changes.
 * Collapsible for iframe-embedded mode.
 */

import type { CircuitElement } from "@/core/element";
import type { PropertyDefinition, PropertyValue } from "@/core/properties";
import { createInput } from "./property-inputs.js";
import type { PropertyInput } from "./property-inputs.js";
import { formatSI, parseSI } from "./si-format.js";
import type { ComponentDefinition, ModelEntry, ParamDef } from "@/core/registry";
import { paramDefDefaults } from "@/core/model-params";
import type { PinElectricalSpec } from "@/core/pin-electrical";
import { resolvePinElectrical } from "@/core/pin-electrical.js";
import type { LogicFamilyConfig } from "@/core/logic-family";
import { PinDirection } from "@/core/pin";
import { createModelSwitchCommand } from "./model-switch-command.js";
import type { ModelSwitchCommand } from "./model-switch-command.js";

const MODEL_LABELS: Record<string, string> = {
  digital: "Digital",
  behavioral: "Behavioral (MNA)",
  cmos: "CMOS (Subcircuit)",
};

function getModelLabel(key: string): string {
  return MODEL_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}


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
  /** True when showModelSelector() rendered show-value into param rows. */
  private _showValueInModelParams = false;

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
    // Don't clear the container- showModelSelector() may have already
    // populated it above us.  Just reset internal tracking state.
    this._inputs.clear();
    this._element = element;
    this._definitions = definitions;
    // _showValueInModelParams is NOT reset here- it was set by showModelSelector
    // which runs before us, and we need to read it below.

    const bag = element.getProperties();
    /** Rows with conditional visibility, keyed by the property they depend on. */
    const conditionalRows: Map<string, { row: HTMLElement; values: PropertyValue[] }[]> = new Map();

    for (const def of definitions) {
      // showLabel and showValue are rendered inline- skip standalone rows
      if (def.key === "showLabel" || def.key === "showValue") {
        continue;
      }
      // Hidden properties are stored in the bag but not shown as panel rows
      if (def.hidden) {
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
        // Commit value to the PropertyBag immediately.
        // When the key is absent from the bag, always write- even if newValue
        // equals the schema default- so the value is explicitly stored.
        const hadKey = bag.has(capturedKey);
        const oldValue = hadKey ? bag.get(capturedKey) : def.defaultValue;
        if (!hadKey || !_valuesEqual(oldValue, newValue)) {
          bag.set(capturedKey, newValue);
          for (const cb of this._changeCallbacks) {
            cb(capturedKey, oldValue ?? newValue, newValue);
          }
        }

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
    // (skip when model param rows already contain the show-value checkbox)
    const showValueDef = definitions.find(d => d.key === "showValue");
    if (showValueDef && !this._showValueInModelParams) {
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
  // Model selector + model param section
  // ---------------------------------------------------------------------------

  /**
   * Show the model dropdown and model parameter section for a component that
   * has a modelRegistry.
   *
   * Renders:
   *  1. A "Model" dropdown listing all available model keys.
   *  2. Primary params immediately below (always visible).
   *  3. Secondary params in a collapsed "Advanced Parameters" subsection.
   *
   * When the user switches models via the dropdown:
   *  - A ModelSwitchCommand is created and executed (updating the element's
   *    model property and replacing the model param partition).
   *  - The model param section is rebuilt to reflect the new entry's paramDefs.
   *  - The registered change callbacks are fired so undo integration works.
   *
   * @param element         The selected circuit element.
   * @param def             The component definition.
   * @param runtimeModels   Optional runtime model entries from circuit.metadata.models
   *                        for this component type (keyed by model name).
   */
  showModelSelector(
    element: CircuitElement,
    def: ComponentDefinition,
    runtimeModels?: Record<string, ModelEntry>,
  ): void {
    const registry = def.modelRegistry;
    if (!registry) return;

    const bag = element.getProperties();

    // Build the full list of model keys
    const staticKeys = Object.keys(registry);
    const hasDigital = def.models?.digital !== undefined;
    const runtimeKeys = runtimeModels ? Object.keys(runtimeModels) : [];

    const allKeys: string[] = [];
    for (const k of staticKeys) {
      if (!allKeys.includes(k)) allKeys.push(k);
    }
    if (hasDigital && !allKeys.includes("digital")) {
      allKeys.push("digital");
    }
    for (const k of runtimeKeys) {
      if (!allKeys.includes(k)) allKeys.push(k);
    }

    if (allKeys.length === 0) return;

    // Resolve the currently active model key
    const currentModelKey = bag.has("model")
      ? bag.get<string>("model")
      : (def.defaultModel ?? allKeys[0]);

    // Model dropdown row
    const select = document.createElement("select");
    select.style.cssText =
      "width:100%;padding:2px 4px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;font-size:11px;";

    for (const key of allKeys) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = getModelLabel(key);
      if (key === currentModelKey) opt.selected = true;
      select.appendChild(opt);
    }

    // Container for primary params- rendered above the model dropdown
    const primaryContainer = document.createElement("div");
    this._container.appendChild(primaryContainer);

    const modelRow = this._buildRow("Model", select as unknown as HTMLElement);
    this._container.appendChild(modelRow);

    // Container for secondary (advanced) params- below the model dropdown
    const secondaryContainer = document.createElement("div");
    this._container.appendChild(secondaryContainer);

    // Render the initial param sections
    this._renderModelParams(element, def, currentModelKey, registry, runtimeModels, primaryContainer, secondaryContainer);

    // Handle model switch
    select.addEventListener("change", () => {
      const newKey = select.value;
      const newEntry = registry[newKey] ?? runtimeModels?.[newKey];
      const newParams: Record<string, PropertyValue> =
        newKey === "digital" || !newEntry
          ? {}
          : { ...paramDefDefaults(newEntry.paramDefs), ...newEntry.params };

      const cmd: ModelSwitchCommand = createModelSwitchCommand(element, newKey, newParams);
      cmd.execute();

      for (const cb of this._changeCallbacks) {
        cb("model", cmd.oldModelKey, newKey);
      }

      // Rebuild both param sections
      primaryContainer.innerHTML = "";
      secondaryContainer.innerHTML = "";
      this._renderModelParams(element, def, newKey, registry, runtimeModels, primaryContainer, secondaryContainer);
    });
  }

  /**
   * Render primary model params into `primaryContainer` and secondary
   * (advanced) params into `secondaryContainer`.
   */
  private _renderModelParams(
    element: CircuitElement,
    def: ComponentDefinition,
    modelKey: string,
    registry: Record<string, ModelEntry>,
    runtimeModels: Record<string, ModelEntry> | undefined,
    primaryContainer: HTMLElement,
    secondaryContainer: HTMLElement,
  ): void {
    if (modelKey === "digital") return;

    const entry = registry[modelKey] ?? runtimeModels?.[modelKey];
    if (!entry) return;

    const paramDefs = entry.paramDefs;
    if (!paramDefs || paramDefs.length === 0) return;

    const bag = element.getProperties();

    const primary = paramDefs.filter(p => p.rank === "primary");
    const secondary = paramDefs.filter(p => p.rank === "secondary");

    // Render primary params above the model dropdown, with show-value checkbox
    for (const pd of primary) {
      const row = this._buildModelParamRow(element, def, pd, entry, bag, modelKey, registry, runtimeModels, primaryContainer);

      // Append show-value checkbox inline with the primary param
      const showValueVal = bag.has("showValue") ? bag.get<boolean>("showValue") : true;
      const svCb = document.createElement("input");
      svCb.type = "checkbox";
      svCb.checked = Boolean(showValueVal);
      svCb.title = "Show value on canvas";
      svCb.addEventListener("change", () => {
        const old = bag.has("showValue") ? bag.get("showValue") : true;
        bag.set("showValue", svCb.checked);
        for (const cb of this._changeCallbacks) cb("showValue", old, svCb.checked);
      });
      row.appendChild(svCb);
      this._showValueInModelParams = true;

      primaryContainer.appendChild(row);
    }

    // Secondary params in a collapsed subsection below the model dropdown
    if (secondary.length > 0) {
      const advSection = document.createElement("div");
      advSection.style.marginTop = "6px";

      const advToggle = document.createElement("div");
      advToggle.style.cssText =
        "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;cursor:pointer;user-select:none;";
      advToggle.textContent = "▶ Advanced Parameters";

      const advContent = document.createElement("div");
      advContent.style.display = "none";

      advToggle.addEventListener("click", () => {
        const open = advContent.style.display !== "none";
        advContent.style.display = open ? "none" : "block";
        advToggle.textContent = (open ? "▶" : "▼") + " Advanced Parameters";
      });

      advSection.appendChild(advToggle);
      advSection.appendChild(advContent);

      for (const pd of secondary) {
        const row = this._buildModelParamRow(element, def, pd, entry, bag, modelKey, registry, runtimeModels, advContent);
        advContent.appendChild(row);
      }

      secondaryContainer.appendChild(advSection);
    }
  }

  /**
   * Build a single model parameter row with a text input, unit label,
   * modified indicator, and "Reset to default" button.
   */
  private _buildModelParamRow(
    _element: CircuitElement,
    _def: ComponentDefinition,
    pd: ParamDef,
    entry: ModelEntry,
    bag: ReturnType<CircuitElement["getProperties"]>,
    _modelKey: string,
    _registry: Record<string, ModelEntry>,
    _runtimeModels: Record<string, ModelEntry> | undefined,
    _container: HTMLElement,
  ): HTMLElement {
    const defaultValue = (entry.params as Record<string, number>)[pd.key] ?? 0;
    const currentValue = bag.hasModelParam(pd.key)
      ? bag.getModelParam<number>(pd.key)
      : defaultValue;

    const row = document.createElement("div");
    row.className = "prop-row-inline";

    const labelEl = document.createElement("label");
    labelEl.className = "prop-label";
    labelEl.textContent = pd.label;
    if (pd.description) labelEl.title = pd.description;
    row.appendChild(labelEl);

    const inputEl = document.createElement("input");
    inputEl.type = "text";

    const isModified = currentValue !== defaultValue;

    // Display value with SI formatting when a unit is present
    inputEl.value = pd.unit
      ? formatSI(currentValue, "", 3).trim()
      : String(currentValue);

    if (isModified) {
      inputEl.style.borderColor = "var(--accent, #4a90d9)";
    }

    inputEl.addEventListener("focus", () => inputEl.select());

    const unitSpan = document.createElement("span");
    unitSpan.style.cssText = "opacity:0.5;font-size:11px;min-width:16px;";
    unitSpan.textContent = pd.unit ?? "";

    // Reset button- only shown when value differs from default
    const resetBtn = document.createElement("button");
    resetBtn.title = "Reset to default";
    resetBtn.textContent = "↺";
    resetBtn.style.cssText =
      "padding:0 4px;font-size:11px;background:none;border:none;cursor:pointer;opacity:0.5;display:" +
      (isModified ? "inline" : "none") + ";";

    const commitParam = () => {
      const raw = inputEl.value.trim();
      const parsed = pd.unit ? parseSI(raw) : parseSI(raw);
      if (isNaN(parsed)) {
        inputEl.value = pd.unit
          ? formatSI(bag.getModelParam<number>(pd.key), "", 3).trim()
          : String(bag.getModelParam<number>(pd.key));
        return;
      }

      const oldValue = bag.hasModelParam(pd.key) ? bag.getModelParam<number>(pd.key) : defaultValue;
      if (parsed !== oldValue) {
        bag.setModelParam(pd.key, parsed);
        inputEl.value = pd.unit ? formatSI(parsed, "", 3).trim() : String(parsed);
        inputEl.style.borderColor =
          parsed !== defaultValue ? "var(--accent, #4a90d9)" : "var(--panel-border)";
        resetBtn.style.display = parsed !== defaultValue ? "inline" : "none";
        for (const cb of this._changeCallbacks) {
          cb(`model:${pd.key}`, oldValue, parsed);
        }
      }
    };

    inputEl.addEventListener("blur", commitParam);
    inputEl.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        commitParam();
        (inputEl as HTMLInputElement).blur();
      }
    });

    resetBtn.addEventListener("click", () => {
      const oldValue = bag.hasModelParam(pd.key) ? bag.getModelParam<number>(pd.key) : defaultValue;
      bag.setModelParam(pd.key, defaultValue);
      inputEl.value = pd.unit ? formatSI(defaultValue, "", 3).trim() : String(defaultValue);
      inputEl.style.borderColor = "var(--panel-border)";
      resetBtn.style.display = "none";
      for (const cb of this._changeCallbacks) {
        cb(`model:${pd.key}`, oldValue, defaultValue);
      }
    });

    row.appendChild(inputEl);
    row.appendChild(unitSpan);
    row.appendChild(resetBtn);
    return row;
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
    const stored: Record<string, number> = bag.has("_pinElectricalOverrides")
      ? (bag.get("_pinElectricalOverrides") as Record<string, number>)
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
      const pinOverride = def.pinElectricalOverrides?.[pinLabel];
      const resolved = resolvePinElectrical(family, pinOverride, def.pinElectrical);

      const pinDiv = document.createElement("div");
      pinDiv.style.cssText = "margin:6px 0 0 8px;font-size:11px;";

      const pinHeader = document.createElement("div");
      pinHeader.style.cssText = "font-weight:600;margin-bottom:3px;";
      pinHeader.textContent = `${pinLabel} (${pin.direction === PinDirection.OUTPUT ? "out" : "in"})`;
      pinDiv.appendChild(pinHeader);

      for (const field of fields) {
        const overrideVal = stored[`${pinLabel}.${field}`];
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
          const current: Record<string, number> = bag.has("_pinElectricalOverrides")
            ? { ...(bag.get("_pinElectricalOverrides") as Record<string, number>) }
            : {};
          const compositeKey = `${pinLabel}.${field}`;
          const raw = input.value.trim();
          if (raw === "") {
            delete current[compositeKey];
            input.value = "";
          } else {
            const parsed = unit ? parseSI(raw) : parseFloat(raw);
            if (isNaN(parsed)) {
              input.value = overrideVal !== undefined
                ? (unit ? formatSI(overrideVal, "", 3).trim() : String(overrideVal))
                : "";
              return;
            }
            current[compositeKey] = parsed;
            input.value = unit ? formatSI(parsed, "", 3).trim() : String(parsed);
          }
          const oldValue = bag.has("_pinElectricalOverrides") ? bag.get("_pinElectricalOverrides") : undefined;
          const newValue = Object.keys(current).length > 0 ? current : {};
          bag.set("_pinElectricalOverrides", newValue as Record<string, number>);
          for (const cb of this._changeCallbacks) {
            cb("_pinElectricalOverrides", oldValue ?? {}, newValue);
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
    this._showValueInModelParams = false;
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

/** Shallow equality for PropertyValue, handling number[] arrays and Record<string,number>. */
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
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, number>);
    const keysB = Object.keys(b as Record<string, number>);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if ((a as Record<string, number>)[k] !== (b as Record<string, number>)[k]) return false;
    }
    return true;
  }
  // eslint-disable-next-line eqeqeq
  return a == b;
}
