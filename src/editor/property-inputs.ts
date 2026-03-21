/**
 * property-inputs.ts — Input widget factory for the property panel.
 *
 * Creates type-appropriate DOM input widgets for each PropertyType.
 * Each widget implements the PropertyInput interface.
 *
 * Separated from property-panel.ts so widgets are individually testable.
 */

import { PropertyType } from "@/core/properties";
import type { PropertyDefinition, PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// PropertyInput interface
// ---------------------------------------------------------------------------

export interface PropertyInput {
  /** The root DOM element to insert into the panel. */
  element: HTMLElement;
  /** Read the current value from the widget. */
  getValue(): PropertyValue;
  /** Push a value into the widget (no change event fired). */
  setValue(v: PropertyValue): void;
  /** Register a callback fired when the user changes the value. */
  onChange(cb: (value: PropertyValue) => void): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate PropertyInput widget for the given definition and
 * initial value.
 */
export function createInput(
  definition: PropertyDefinition,
  currentValue: PropertyValue,
): PropertyInput {
  switch (definition.type) {
    case PropertyType.INT:
    case PropertyType.FLOAT:
    case PropertyType.BIT_WIDTH:
    case PropertyType.LONG:
      return new NumberInput(definition, currentValue);

    case PropertyType.STRING:
      return new TextInput(currentValue);

    case PropertyType.FILE:
      return new FileInput(definition, currentValue);

    case PropertyType.ENUM:
    case PropertyType.INTFORMAT:
      return new EnumSelect(definition, currentValue);

    case PropertyType.BOOLEAN:
      return new BooleanCheckbox(currentValue);

    case PropertyType.HEX_DATA:
      return new HexDataEditor(currentValue);

    case PropertyType.COLOR:
      return new ColorPicker(currentValue);

    case PropertyType.ROTATION:
      return new NumberInput(definition, currentValue);
  }
}

// ---------------------------------------------------------------------------
// NumberInput — for INT, FLOAT, BIT_WIDTH, LONG, ROTATION
// ---------------------------------------------------------------------------

export class NumberInput implements PropertyInput {
  element: HTMLElement;
  private readonly _input: HTMLInputElement;
  private readonly _isFloat: boolean;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(definition: PropertyDefinition, initial: PropertyValue) {
    this._isFloat = definition.type === PropertyType.FLOAT;

    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-number";

    const input = document.createElement("input");
    input.type = "number";
    if (this._isFloat) {
      input.step = "any";
    }
    if (definition.min !== undefined) {
      input.min = String(definition.min);
    }
    if (definition.max !== undefined) {
      input.max = String(definition.max);
    }
    input.value = String(typeof initial === "bigint" ? Number(initial) : initial);

    input.addEventListener("change", () => {
      let raw = Number(input.value);
      if (definition.min !== undefined && raw < definition.min) {
        raw = definition.min;
        input.value = String(raw);
      }
      if (definition.max !== undefined && raw > definition.max) {
        raw = definition.max;
        input.value = String(raw);
      }
      for (const cb of this._callbacks) {
        cb(raw);
      }
    });

    this._input = input;
    wrapper.appendChild(input);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return Number(this._input.value);
  }

  setValue(v: PropertyValue): void {
    this._input.value = String(typeof v === "bigint" ? Number(v) : v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// TextInput — for STRING, FILE
// ---------------------------------------------------------------------------

export class TextInput implements PropertyInput {
  element: HTMLElement;
  private readonly _input: HTMLInputElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-text";

    const input = document.createElement("input");
    input.type = "text";
    input.value = String(initial);

    input.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(input.value);
      }
    });

    this._input = input;
    wrapper.appendChild(input);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._input.value;
  }

  setValue(v: PropertyValue): void {
    this._input.value = String(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// EnumSelect — for ENUM, INTFORMAT
// ---------------------------------------------------------------------------

export class EnumSelect implements PropertyInput {
  element: HTMLElement;
  private readonly _select: HTMLSelectElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(definition: PropertyDefinition, initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-enum";

    const select = document.createElement("select");
    const options = definition.enumValues ?? [];
    for (const opt of options) {
      const optEl = document.createElement("option");
      optEl.value = opt;
      optEl.textContent = opt;
      select.appendChild(optEl);
    }
    select.value = String(initial);

    select.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(select.value);
      }
    });

    this._select = select;
    wrapper.appendChild(select);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._select.value;
  }

  setValue(v: PropertyValue): void {
    this._select.value = String(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// BooleanCheckbox — for BOOLEAN
// ---------------------------------------------------------------------------

export class BooleanCheckbox implements PropertyInput {
  element: HTMLElement;
  private readonly _input: HTMLInputElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-boolean";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(initial);

    input.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(input.checked);
      }
    });

    this._input = input;
    wrapper.appendChild(input);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._input.checked;
  }

  setValue(v: PropertyValue): void {
    this._input.checked = Boolean(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// HexDataEditor — for HEX_DATA (number[] stored as hex)
// ---------------------------------------------------------------------------

export class HexDataEditor implements PropertyInput {
  element: HTMLElement;
  private readonly _textarea: HTMLTextAreaElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-hexdata";

    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.value = this._encode(initial);

    textarea.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(this._decode(textarea.value));
      }
    });

    this._textarea = textarea;
    wrapper.appendChild(textarea);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._decode(this._textarea.value);
  }

  setValue(v: PropertyValue): void {
    this._textarea.value = this._encode(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }

  private _encode(v: PropertyValue): string {
    if (!Array.isArray(v)) return "";
    return (v as number[]).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  private _decode(text: string): PropertyValue {
    const trimmed = text.trim();
    if (trimmed === "") return [];
    return trimmed.split(/\s+/).map((hex) => parseInt(hex, 16));
  }
}

// ---------------------------------------------------------------------------
// FileInput — for FILE (text input + Browse... button)
// ---------------------------------------------------------------------------

export class FileInput implements PropertyInput {
  element: HTMLElement;
  private readonly _input: HTMLInputElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(_definition: PropertyDefinition, initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-file";
    wrapper.style.display = "flex";
    wrapper.style.gap = "4px";
    wrapper.style.alignItems = "center";

    const input = document.createElement("input");
    input.type = "text";
    input.value = String(initial);
    input.style.flex = "1";
    input.style.minWidth = "0";

    input.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(input.value);
      }
    });

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.textContent = "...";
    browseBtn.title = "Browse file";
    browseBtn.style.padding = "2px 6px";
    browseBtn.style.flexShrink = "0";
    browseBtn.style.background = "var(--toolbar-bg)";
    browseBtn.style.border = "1px solid var(--panel-border)";
    browseBtn.style.color = "var(--fg)";
    browseBtn.style.borderRadius = "3px";
    browseBtn.style.cursor = "pointer";
    browseBtn.style.fontSize = "11px";

    const hiddenFileInput = document.createElement("input");
    hiddenFileInput.type = "file";
    hiddenFileInput.accept = ".hex,.bin,.dat";
    hiddenFileInput.style.display = "none";

    browseBtn.addEventListener("click", () => {
      hiddenFileInput.click();
    });

    hiddenFileInput.addEventListener("change", () => {
      const file = hiddenFileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        input.value = content;
        for (const cb of this._callbacks) {
          cb(content);
        }
      };
      reader.readAsText(file);
    });

    this._input = input;
    wrapper.appendChild(input);
    wrapper.appendChild(browseBtn);
    wrapper.appendChild(hiddenFileInput);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._input.value;
  }

  setValue(v: PropertyValue): void {
    this._input.value = String(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// ColorPicker — for COLOR
// ---------------------------------------------------------------------------

export class ColorPicker implements PropertyInput {
  element: HTMLElement;
  private readonly _input: HTMLInputElement;
  private _callbacks: Array<(v: PropertyValue) => void> = [];

  constructor(initial: PropertyValue) {
    const wrapper = document.createElement("div");
    wrapper.className = "prop-input prop-color";

    const input = document.createElement("input");
    input.type = "color";
    input.value = typeof initial === "string" ? initial : "#000000";

    input.addEventListener("change", () => {
      for (const cb of this._callbacks) {
        cb(input.value);
      }
    });

    this._input = input;
    wrapper.appendChild(input);
    this.element = wrapper;
  }

  getValue(): PropertyValue {
    return this._input.value;
  }

  setValue(v: PropertyValue): void {
    this._input.value = String(v);
  }

  onChange(cb: (value: PropertyValue) => void): void {
    this._callbacks.push(cb);
  }
}
