/**
 * SliderPanel- live parameter sliders for analog component properties.
 *
 * Hosts HTML range inputs below the canvas. Each slider is tied to a specific
 * (elementId, propertyKey) pair. Dragging the slider fires the registered
 * callback with the new value in real-time.
 *
 * Log-scale sliders map the linear slider position [0, 1] to
 * `min * (max/min)^position`, giving even visual spacing across decades.
 *
 * Slider state is runtime-only- not persisted with the circuit file.
 */

import { formatSI } from "./si-format.js";

// ---------------------------------------------------------------------------
// SliderOpts
// ---------------------------------------------------------------------------

export interface SliderOpts {
  /** Lower bound of the slider range. */
  min?: number;
  /** Upper bound of the slider range. */
  max?: number;
  /** When true, the slider maps position logarithmically. Default: false. */
  logScale?: boolean;
  /** SI unit string shown in the value display (e.g. "Ω", "F", "V"). */
  unit?: string;
}

// ---------------------------------------------------------------------------
// Internal slider descriptor
// ---------------------------------------------------------------------------

interface SliderEntry {
  elementId: number;
  propertyKey: string;
  label: string;
  min: number;
  max: number;
  logScale: boolean;
  unit: string;
  currentValue: number;
  /** Root container div for this slider row. */
  container: HTMLElement;
  /** The range input element. */
  input: HTMLInputElement;
  /** Value display span. */
  valueDisplay: HTMLSpanElement;
  /** When true, slider stays visible after element is deselected. */
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// SliderPanel
// ---------------------------------------------------------------------------

/**
 * Panel that hosts live parameter sliders for analog components.
 */
export class SliderPanel {
  private readonly _container: HTMLElement;
  private _sliders: SliderEntry[] = [];
  private _callbacks: ((elementId: number, propertyKey: string, value: number) => void)[] = [];

  /**
   * @param container - The DOM element into which slider rows are appended.
   */
  constructor(container: HTMLElement) {
    this._container = container;
  }

  /**
   * Add a slider for a component property.
   *
   * Default ranges:
   * - If `currentValue !== 0`: log scale `[currentValue * 0.1, currentValue * 10]`
   * - If `currentValue === 0`: fallback `[1e-12, 1e-3]` (pF–mF / pΩ–mΩ range)
   *
   * @param elementId    - Index of the analog element in the compiled circuit.
   * @param propertyKey  - Property name (e.g. "resistance", "capacitance").
   * @param label        - Human-readable label for display.
   * @param currentValue - Current property value (used to derive default range).
   * @param opts         - Optional range and scale overrides.
   */
  addSlider(
    elementId: number,
    propertyKey: string,
    label: string,
    currentValue: number,
    opts: SliderOpts = {},
  ): void {
    // Determine range and scale from opts or defaults
    let min: number;
    let max: number;
    let logScale: boolean;

    if (opts.min !== undefined && opts.max !== undefined) {
      min = opts.min;
      max = opts.max;
      logScale = opts.logScale ?? false;
    } else if (currentValue !== 0) {
      min = opts.min ?? currentValue * 0.1;
      max = opts.max ?? currentValue * 10;
      logScale = opts.logScale ?? true;
    } else {
      min = opts.min ?? 1e-12;
      max = opts.max ?? 1e-3;
      logScale = opts.logScale ?? true;
    }

    const unit = opts.unit ?? "";

    // Build DOM
    const rowDiv = document.createElement("div");
    rowDiv.className = "slider-row";
    rowDiv.style.display = "flex";
    rowDiv.style.alignItems = "center";
    rowDiv.style.gap = "8px";
    rowDiv.style.padding = "4px 8px";

    const labelSpan = document.createElement("span");
    labelSpan.className = "slider-label";
    labelSpan.textContent = label;
    labelSpan.style.minWidth = "80px";

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "10000";
    input.step = "1";
    input.style.flex = "1";

    // Set initial slider position from currentValue
    const initialPosition = this._valueToPosition(currentValue, min, max, logScale);
    input.value = String(Math.round(initialPosition * 10000));

    const valueDisplay = document.createElement("span");
    valueDisplay.className = "slider-value";
    valueDisplay.style.minWidth = "80px";
    valueDisplay.style.textAlign = "right";
    valueDisplay.textContent = unit ? formatSI(currentValue, unit) : String(currentValue);

    // Pin button- keeps slider visible after deselection
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.title = "Pin slider (keep visible)";
    pinBtn.textContent = "\u{1F4CC}"; // 📌 pushpin
    pinBtn.style.cssText = "background:none;border:none;cursor:pointer;font-size:14px;padding:0 2px;opacity:0.4;flex-shrink:0;";
    pinBtn.addEventListener("click", () => {
      entry.pinned = !entry.pinned;
      pinBtn.style.opacity = entry.pinned ? "1" : "0.4";
    });

    rowDiv.appendChild(labelSpan);
    rowDiv.appendChild(input);
    rowDiv.appendChild(valueDisplay);
    rowDiv.appendChild(pinBtn);
    this._container.appendChild(rowDiv);

    const entry: SliderEntry = {
      elementId,
      propertyKey,
      label,
      min,
      max,
      logScale,
      unit,
      currentValue,
      container: rowDiv,
      input,
      valueDisplay,
      pinned: false,
    };

    this._sliders.push(entry);

    // Wire up the change handler
    input.addEventListener("input", () => {
      const position = Number(input.value) / 10000;
      const newValue = this._positionToValue(position, entry.min, entry.max, entry.logScale);
      entry.currentValue = newValue;

      // Update value display
      if (entry.unit) {
        valueDisplay.textContent = formatSI(newValue, entry.unit);
      } else {
        valueDisplay.textContent = String(newValue);
      }

      // Fire callbacks
      for (const cb of this._callbacks) {
        cb(entry.elementId, entry.propertyKey, newValue);
      }
    });
  }

  /**
   * Remove the slider for a specific (elementId, propertyKey) pair.
   *
   * @param elementId   - Element index.
   * @param propertyKey - Property name.
   */
  removeSlider(elementId: number, propertyKey: string): void {
    const idx = this._sliders.findIndex(
      (s) => s.elementId === elementId && s.propertyKey === propertyKey,
    );
    if (idx < 0) return;

    const entry = this._sliders[idx];
    entry.container.parentNode?.removeChild(entry.container);
    this._sliders.splice(idx, 1);
  }

  /**
   * Remove all sliders and clear the panel.
   */
  removeAll(): void {
    for (const entry of this._sliders) {
      entry.container.parentNode?.removeChild(entry.container);
    }
    this._sliders = [];
  }

  /**
   * Remove only unpinned sliders. Pinned sliders stay visible across
   * selection changes so the user can keep adjusting them.
   */
  removeUnpinned(): void {
    const kept: SliderEntry[] = [];
    for (const entry of this._sliders) {
      if (entry.pinned) {
        kept.push(entry);
      } else {
        entry.container.parentNode?.removeChild(entry.container);
      }
    }
    this._sliders = kept;
  }

  /**
   * Register a callback fired during slider drag.
   *
   * @param callback - Called with (elementId, propertyKey, newValue) on each input event.
   */
  onSliderChange(
    callback: (elementId: number, propertyKey: string, value: number) => void,
  ): void {
    this._callbacks.push(callback);
  }

  /**
   * Remove all DOM elements and registered callbacks. Panel must not be used after this.
   */
  dispose(): void {
    this.removeAll();
    this._callbacks = [];
  }

  // ---------------------------------------------------------------------------
  // Coordinate helpers: value ↔ slider position [0, 1]
  // ---------------------------------------------------------------------------

  /**
   * Map a property value to a normalized slider position [0, 1].
   *
   * For log scale: position = log(value/min) / log(max/min)
   * For linear scale: position = (value - min) / (max - min)
   */
  private _valueToPosition(value: number, min: number, max: number, logScale: boolean): number {
    if (logScale) {
      if (min <= 0 || max <= 0 || value <= 0) return 0;
      return Math.log(value / min) / Math.log(max / min);
    }
    if (max === min) return 0;
    return (value - min) / (max - min);
  }

  /**
   * Map a normalized slider position [0, 1] to a property value.
   *
   * For log scale: value = min * (max/min)^position
   * For linear scale: value = min + position * (max - min)
   */
  private _positionToValue(position: number, min: number, max: number, logScale: boolean): number {
    if (logScale) {
      if (min <= 0 || max <= 0) return min;
      return min * Math.pow(max / min, position);
    }
    return min + position * (max - min);
  }

  // ---------------------------------------------------------------------------
  // Public value/position accessors (used by tests)
  // ---------------------------------------------------------------------------

  /**
   * Compute the value corresponding to a given normalized position [0, 1] on
   * the slider identified by (elementId, propertyKey).
   *
   * @returns The computed value, or undefined if the slider does not exist.
   */
  getValueAtPosition(
    elementId: number,
    propertyKey: string,
    position: number,
  ): number | undefined {
    const entry = this._sliders.find(
      (s) => s.elementId === elementId && s.propertyKey === propertyKey,
    );
    if (!entry) return undefined;
    return this._positionToValue(position, entry.min, entry.max, entry.logScale);
  }

  /**
   * Programmatically set the slider position [0, 1] and fire the change callback.
   *
   * Used by tests and the engine bridge to synchronise the display with an
   * externally set value.
   */
  setPosition(elementId: number, propertyKey: string, position: number): void {
    const entry = this._sliders.find(
      (s) => s.elementId === elementId && s.propertyKey === propertyKey,
    );
    if (!entry) return;

    const clamped = Math.max(0, Math.min(1, position));
    entry.input.value = String(Math.round(clamped * 10000));

    const newValue = this._positionToValue(clamped, entry.min, entry.max, entry.logScale);
    entry.currentValue = newValue;

    if (entry.unit) {
      entry.valueDisplay.textContent = formatSI(newValue, entry.unit);
    } else {
      entry.valueDisplay.textContent = String(newValue);
    }

    for (const cb of this._callbacks) {
      cb(entry.elementId, entry.propertyKey, newValue);
    }
  }
}
