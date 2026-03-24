/**
 * SingleValueDialog — popup showing a signal value in all radix formats.
 *
 * Clicking a wire or pin opens this dialog positioned near the click point.
 * The dialog displays binary, decimal (unsigned), decimal (signed), and hex
 * representations, as well as the bit width. For HIGH_Z signals it shows
 * "High-Z" instead of a numeric value. An override input lets the user type
 * a new value which is applied via engine.setSignalValue().
 *
 * The dialog dismisses when the user clicks outside it or presses Escape.
 *
 * Task 7.2.4: Single Value Dialog
 */

import { BitVector } from "../core/signal.js";
import type { SimulationEngine } from "../core/engine-interface.js";

// ---------------------------------------------------------------------------
// SingleValueDialog
// ---------------------------------------------------------------------------

/**
 * Popup dialog that displays a signal value in all radix formats and allows
 * an optional override via the simulation engine.
 *
 * Usage:
 *   const dlg = new SingleValueDialog(container);
 *   dlg.open(value, netId, engine);   // show near click point
 *   dlg.close();                       // dismiss
 */
export class SingleValueDialog {
  private readonly _container: HTMLElement;

  /** The root dialog element, null when closed. */
  private _dialogEl: HTMLElement | null = null;

  /** The override input element, null when closed. */
  private _overrideInput: HTMLElement | null = null;

  /** The net ID for the currently open dialog. */
  private _netId: number = -1;

  /** The engine for signal override, null when no override possible. */
  private _engine: SimulationEngine | null = null;

  /** Document-level click handler for outside-click dismissal. */
  private _outsideClickHandler: ((e: Event) => void) | null = null;

  /** Document-level keydown handler for Escape dismissal. */
  private _keydownHandler: ((e: Event) => void) | null = null;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------

  /**
   * Open the dialog for the given BitVector value.
   *
   * @param value  The signal value to display.
   * @param netId  The net ID (used when calling engine.setSignalValue).
   * @param engine The simulation engine for override. Pass null to disable override.
   */
  open(value: BitVector, netId: number, engine: SimulationEngine | null): void {
    this.close();

    this._netId = netId;
    this._engine = engine;
    this._currentWidth = value.width;

    this._dialogEl = this._buildDialog(value);
    this._container.appendChild(this._dialogEl);

    this._installDismissHandlers();
  }

  /** Close and remove the dialog. No-op if already closed. */
  close(): void {
    if (this._dialogEl !== null) {
      if (this._dialogEl.parentElement !== null) {
        this._dialogEl.parentElement.removeChild(this._dialogEl);
      }
      this._dialogEl = null;
      this._overrideInput = null;
    }
    this._removeDismissHandlers();
    this._engine = null;
    this._netId = -1;
  }

  /** Return whether the dialog is currently open. */
  isOpen(): boolean {
    return this._dialogEl !== null;
  }

  /**
   * Return the override input element, or null if the dialog is closed.
   * Used in tests to inspect or interact with the input field.
   */
  getOverrideInput(): HTMLElement | null {
    return this._overrideInput;
  }

  /**
   * Return the dialog root element, or null if closed.
   * Used in tests to inspect rendered content.
   */
  getDialogElement(): HTMLElement | null {
    return this._dialogEl;
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  private _buildDialog(value: BitVector): HTMLElement {
    const dialog = document.createElement("div");
    dialog.className = "value-dialog";

    // Bit width row
    const widthRow = document.createElement("div");
    widthRow.className = "value-dialog-width";
    widthRow.textContent = `${value.width} bits`;
    dialog.appendChild(widthRow);

    if (value.isHighZ) {
      // HIGH_Z indication
      const highZRow = document.createElement("div");
      highZRow.className = "value-dialog-highz";
      highZRow.textContent = "High-Z";
      dialog.appendChild(highZRow);
    } else {
      // Binary
      const binRow = this._makeFormatRow("bin", value.toString("bin"));
      dialog.appendChild(binRow);

      // Decimal unsigned
      const decRow = this._makeFormatRow("dec", value.toString("dec"));
      dialog.appendChild(decRow);

      // Decimal signed
      const decSignedRow = this._makeFormatRow("dec-signed", value.toString("decSigned"));
      dialog.appendChild(decSignedRow);

      // Hexadecimal (strip leading "0x" prefix added by BitVector.toString)
      const hexStr = value.toString("hex").replace(/^0x/i, "");
      const hexRow = this._makeFormatRow("hex", hexStr);
      dialog.appendChild(hexRow);
    }

    // Override input (always shown, disabled when no engine)
    const overrideRow = document.createElement("div");
    overrideRow.className = "value-dialog-override";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "value-dialog-input";
    input.placeholder = "Override (hex)";

    if (this._engine !== null) {
      input.addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter") {
          this._applyOverride((input as HTMLInputElement).value);
        } else if (ke.key === "Escape") {
          this.close();
        }
      });
    }

    this._overrideInput = input;
    overrideRow.appendChild(input);
    dialog.appendChild(overrideRow);

    return dialog;
  }

  private _makeFormatRow(format: string, displayValue: string): HTMLElement {
    const row = document.createElement("div");
    row.className = `value-dialog-row value-dialog-${format}`;
    row.dataset["format"] = format;
    row.textContent = displayValue;
    return row;
  }

  // ---------------------------------------------------------------------------
  // Override
  // ---------------------------------------------------------------------------

  private _applyOverride(rawInput: string): void {
    if (this._engine === null) return;

    const trimmed = rawInput.trim();
    let numericValue: number;

    if (/^0x/i.test(trimmed)) {
      numericValue = parseInt(trimmed, 16);
    } else if (/^0b/i.test(trimmed)) {
      numericValue = parseInt(trimmed.slice(2), 2);
    } else {
      numericValue = parseInt(trimmed, 16);
    }

    if (isNaN(numericValue)) return;

    const bv = BitVector.fromNumber(numericValue, this._getWidthForNet());
    this._engine.setSignalValue(this._netId, bv);
    this.close();
  }

  private _getWidthForNet(): number {
    return this._currentWidth;
  }

  /** Width of the currently displayed value, stored during open(). */
  private _currentWidth: number = 8;

  // ---------------------------------------------------------------------------
  // Dismiss handlers
  // ---------------------------------------------------------------------------

  private _installDismissHandlers(): void {
    this._keydownHandler = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") {
        this.close();
      }
    };
    document.addEventListener("keydown", this._keydownHandler);

    this._outsideClickHandler = (e: Event) => {
      if (this._dialogEl !== null && !this._dialogEl.contains(e.target as Node)) {
        this.close();
      }
    };
    document.addEventListener("click", this._outsideClickHandler);
  }

  private _removeDismissHandlers(): void {
    if (this._keydownHandler !== null) {
      document.removeEventListener("keydown", this._keydownHandler);
      this._keydownHandler = null;
    }
    if (this._outsideClickHandler !== null) {
      document.removeEventListener("click", this._outsideClickHandler);
      this._outsideClickHandler = null;
    }
  }
}
