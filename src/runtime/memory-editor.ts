/**
 * MemoryEditorDialog — floating hex editor for RAM/ROM/EEPROM components.
 *
 * Opens as a panel showing the full address space of a DataField.
 * Supports editing bytes in-place, go-to-address navigation, and
 * virtualized scrolling for large memories.
 *
 * Task 7.2.1: core hex editor
 * Task 7.2.2: live update extension (enableLiveUpdate / disableLiveUpdate)
 */

import type { DataField } from "../components/memory/ram.js";
import type { MeasurementObserver } from "../core/engine-interface.js";
import type { SimulationEngine } from "../core/engine-interface.js";
import { HexGrid } from "./hex-grid.js";
import type { DataWidth } from "./hex-grid.js";

// ---------------------------------------------------------------------------
// MemoryEditorDialog
// ---------------------------------------------------------------------------

/**
 * Hex editor dialog for a DataField.
 *
 * Usage:
 *   const editor = new MemoryEditorDialog(dataField, container);
 *   editor.render();
 *
 * The editor renders rows into the provided container element using a
 * virtualized HexGrid (only visible rows are in the DOM). Edits made
 * via the UI are written directly into the DataField.
 */
export class MemoryEditorDialog implements MeasurementObserver {
  private readonly _dataField: DataField;
  private readonly _container: HTMLElement;
  private readonly _grid: HexGrid;

  /** Currently selected cell address for keyboard editing. */
  private _selectedAddress: number = 0;

  /** DOM elements keyed by word address for visible rows. */
  private _cellElements: Map<number, HTMLElement> = new Map();

  /** Addresses that changed in the last live-update step. */
  private _changedAddresses: Set<number> = new Set();

  /** Previous word values for change detection. */
  private _prevValues: Map<number, number> = new Map();

  /** Whether live updates are currently active. */
  private _liveUpdateActive: boolean = false;

  /** Engine reference for live update (set by enableLiveUpdate). */
  private _liveEngine: SimulationEngine | null = null;

  /** Visible row count for the virtual grid. */
  private static readonly VISIBLE_ROWS = 16;

  constructor(dataField: DataField, container: HTMLElement) {
    this._dataField = dataField;
    this._container = container;
    this._grid = new HexGrid(dataField, 8, MemoryEditorDialog.VISIBLE_ROWS);
  }

  // ---------------------------------------------------------------------------
  // MeasurementObserver — Task 7.2.2 (live update)
  // ---------------------------------------------------------------------------

  /**
   * Called after each simulation step. Refreshes visible rows and marks
   * changed addresses with a highlight class.
   */
  onStep(_stepCount: number): void {
    if (!this._liveUpdateActive) return;
    this._refreshVisible();
  }

  /** Called when the simulation resets. Clears highlight state. */
  onReset(): void {
    this._changedAddresses.clear();
    this._prevValues.clear();
    this._refreshVisible();
  }

  // ---------------------------------------------------------------------------
  // Live update control — Task 7.2.2
  // ---------------------------------------------------------------------------

  /**
   * Enable live update: registers this editor as a MeasurementObserver on
   * the given engine. Refreshes visible rows after every simulation step.
   */
  enableLiveUpdate(engine: SimulationEngine): void {
    if (this._liveUpdateActive) return;
    this._liveEngine = engine;
    this._liveUpdateActive = true;
    engine.addMeasurementObserver(this);
  }

  /**
   * Disable live update: removes this editor from the engine's observer list.
   * Subsequent simulation steps will not refresh the display.
   */
  disableLiveUpdate(): void {
    if (!this._liveUpdateActive) return;
    this._liveUpdateActive = false;
    if (this._liveEngine !== null) {
      this._liveEngine.removeMeasurementObserver(this);
      this._liveEngine = null;
    }
  }

  /** Returns whether live update is currently active. */
  isLiveUpdateActive(): boolean {
    return this._liveUpdateActive;
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * Scroll the view so that the given address is visible.
   * @param address - word address in the DataField
   */
  goToAddress(address: number): void {
    this._grid.scrollToAddress(address);
    this._render();
  }

  /** Return the current scroll row (first visible row index). */
  getScrollRow(): number {
    return this._grid.getScrollRow();
  }

  // ---------------------------------------------------------------------------
  // Data width
  // ---------------------------------------------------------------------------

  /**
   * Switch the display width (8/16/32 bits per column).
   * Re-renders the visible window.
   */
  setDataWidth(width: DataWidth): void {
    this._grid.setDataWidth(width);
    this._cellElements.clear();
    this._render();
  }

  /** Return the current data width mode. */
  getDataWidth(): DataWidth {
    return this._grid.getDataWidth();
  }

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  /**
   * Write a new value to the DataField at the given word address.
   * Updates the displayed cell immediately.
   */
  editCell(address: number, value: number): void {
    this._dataField.write(address, value);
    this._updateCellDisplay(address, value);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Initial render. Clears the container and builds the visible rows.
   */
  render(): void {
    this._render();
  }

  /**
   * Return the number of visible row DOM elements currently in the container.
   */
  getRenderedRowCount(): number {
    return this._container.querySelectorAll(".hex-row").length;
  }

  /**
   * Return the hex cell element for the given word address, or null if not rendered.
   */
  getCellElement(address: number): HTMLElement | null {
    return this._cellElements.get(address) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Private rendering
  // ---------------------------------------------------------------------------

  private _render(): void {
    this._container.innerHTML = "";
    this._cellElements.clear();

    const rows = this._grid.renderVisible();
    for (const row of rows) {
      const rowEl = this._buildRowElement(row.baseAddress, row.addressStr, row.hexCells, row.values, row.ascii);
      this._container.appendChild(rowEl);
    }
  }

  private _refreshVisible(): void {
    const rows = this._grid.renderVisible();
    for (const row of rows) {
      for (let col = 0; col < row.values.length; col++) {
        const addr = row.baseAddress + col;
        const newVal = row.values[col];
        const prevVal = this._prevValues.get(addr);
        if (prevVal !== undefined && prevVal !== newVal) {
          this._changedAddresses.add(addr);
        }
        this._prevValues.set(addr, newVal);
        this._updateCellDisplay(addr, newVal);
      }
    }
  }

  private _buildRowElement(
    baseAddress: number,
    addressStr: string,
    hexCells: string[],
    values: number[],
    ascii: string,
  ): HTMLElement {
    const rowEl = document.createElement("div");
    rowEl.className = "hex-row";
    rowEl.dataset["baseAddress"] = baseAddress.toString(16);

    const addrEl = document.createElement("span");
    addrEl.className = "hex-addr";
    addrEl.textContent = addressStr;
    rowEl.appendChild(addrEl);

    for (let col = 0; col < hexCells.length; col++) {
      const addr = baseAddress + col;
      const cellEl = document.createElement("span");
      cellEl.className = "hex-cell";
      cellEl.textContent = hexCells[col];
      cellEl.dataset["address"] = addr.toString();

      if (this._changedAddresses.has(addr)) {
        cellEl.classList.add("hex-changed");
      }

      this._prevValues.set(addr, values[col]);
      this._cellElements.set(addr, cellEl);

      cellEl.addEventListener("click", () => {
        this._selectedAddress = addr;
        this._openCellEditor(cellEl, addr);
      });

      rowEl.appendChild(cellEl);
    }

    if (ascii.length > 0) {
      const asciiEl = document.createElement("span");
      asciiEl.className = "hex-ascii";
      asciiEl.textContent = ascii;
      rowEl.appendChild(asciiEl);
    }

    return rowEl;
  }

  private _updateCellDisplay(address: number, value: number): void {
    const cellEl = this._cellElements.get(address);
    if (cellEl === undefined) return;

    const hexDigits = this._grid.getDataWidth() === 8 ? 2
      : this._grid.getDataWidth() === 16 ? 4 : 8;
    cellEl.textContent = value.toString(16).toUpperCase().padStart(hexDigits, "0");

    if (this._changedAddresses.has(address)) {
      cellEl.classList.add("hex-changed");
    } else {
      cellEl.classList.remove("hex-changed");
    }
  }

  private _openCellEditor(cellEl: HTMLElement, address: number): void {
    const hexDigits = this._grid.getDataWidth() === 8 ? 2
      : this._grid.getDataWidth() === 16 ? 4 : 8;
    const currentVal = this._dataField.read(address);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "hex-cell-input";
    input.value = currentVal.toString(16).toUpperCase().padStart(hexDigits, "0");
    input.maxLength = hexDigits;

    const finishEdit = (): void => {
      const parsed = parseInt(input.value, 16);
      if (!isNaN(parsed)) {
        this.editCell(address, parsed);
      } else {
        this._updateCellDisplay(address, this._dataField.read(address));
      }
      if (input.parentElement) {
        input.parentElement.replaceWith(cellEl);
      }
    };

    input.addEventListener("blur", finishEdit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        finishEdit();
      } else if (e.key === "Escape") {
        if (input.parentElement) {
          input.parentElement.replaceWith(cellEl);
        }
      }
    });

    cellEl.replaceWith(input);
    input.focus();
    input.select();
  }
}
