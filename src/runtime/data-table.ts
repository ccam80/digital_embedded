/**
 * DataTablePanel — live tabular view of all measured signals.
 *
 * Implements MeasurementObserver to receive step/reset notifications from
 * the simulation coordinator. Renders one row per signal with the current
 * value formatted in the configured radix. Supports sorting by name and
 * grouping signals by component type (inputs, outputs, probes).
 *
 * Configurable radix per signal via right-click context menu.
 *
 */

import type { MeasurementObserver } from "@/core/engine-interface";
import type { DisplayFormat } from "@/core/signal";
import { BitVector } from "@/core/signal";
import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { SignalAddress } from "@/compile/types";

// ---------------------------------------------------------------------------
// Signal group — categorises signals by component type
// ---------------------------------------------------------------------------

export type SignalGroup = "input" | "output" | "probe";

// ---------------------------------------------------------------------------
// SignalDescriptor — describes one signal in the table
// ---------------------------------------------------------------------------

export interface SignalDescriptor {
  /** Display name shown in the Name column. */
  readonly name: string;
  /** Signal address used to read the value from the coordinator. */
  readonly addr: SignalAddress;
  /** Bit width of the signal (used for digital signals). */
  readonly width: number;
  /** Component type group. */
  readonly group: SignalGroup;
}

// ---------------------------------------------------------------------------
// SignalRow — live row in the table
// ---------------------------------------------------------------------------

interface SignalRow {
  descriptor: SignalDescriptor;
  /** Display radix for this row's value column. */
  radix: DisplayFormat;
  /** Most recently read value, or null when cleared/not-yet-read. */
  value: BitVector | number | null;
}

// ---------------------------------------------------------------------------
// DataTablePanel
// ---------------------------------------------------------------------------

/**
 * Live tabular view of measured signals.
 *
 * Usage:
 *   const panel = new DataTablePanel(containerEl, coordinator, signals);
 *   coordinator.addMeasurementObserver(panel);
 *   // Later:
 *   coordinator.removeMeasurementObserver(panel);
 *   panel.dispose();
 */
export class DataTablePanel implements MeasurementObserver {
  private readonly _container: HTMLElement;
  private readonly _coordinator: SimulationCoordinator;
  private _rows: SignalRow[];
  private _sortByName = false;
  private _tableBody: HTMLTableSectionElement | null = null;
  private _lastUpdateTime = 0;

  constructor(
    container: HTMLElement,
    coordinator: SimulationCoordinator,
    signals: readonly SignalDescriptor[],
  ) {
    this._container = container;
    this._coordinator = coordinator;
    this._rows = signals.map((d) => ({
      descriptor: d,
      radix: "dec" as DisplayFormat,
      value: null,
    }));
    this._buildDom();
  }

  // -------------------------------------------------------------------------
  // MeasurementObserver
  // -------------------------------------------------------------------------

  onStep(_stepCount: number): void {
    // Read values eagerly, throttle DOM updates to at most every 50ms.
    for (const row of this._rows) {
      const sv = this._coordinator.readSignal(row.descriptor.addr);
      row.value = sv.type === 'digital'
        ? BitVector.fromNumber(sv.value, row.descriptor.width)
        : sv.voltage;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._lastUpdateTime >= 50) {
      this._lastUpdateTime = now;
      this._updateDom();
    }
  }

  onReset(): void {
    for (const row of this._rows) {
      row.value = null;
    }
    this._updateDom();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the display radix for the signal at the given index in the current
   * (possibly sorted) display order.
   */
  setRadix(signalIndex: number, radix: DisplayFormat): void {
    const ordered = this._orderedRows();
    if (signalIndex < 0 || signalIndex >= ordered.length) {
      throw new RangeError(`Signal index ${signalIndex} out of range`);
    }
    ordered[signalIndex].radix = radix;
    this._updateDom();
  }

  /**
   * Set the display radix for the signal with the given name.
   * Throws if no signal with that name is registered.
   */
  setRadixByName(name: string, radix: DisplayFormat): void {
    const row = this._rows.find((r) => r.descriptor.name === name);
    if (row === undefined) {
      throw new Error(`No signal named "${name}" in data table`);
    }
    row.radix = radix;
    this._updateDom();
  }

  /**
   * Enable or disable alphabetical sort by signal name.
   * When false (default), signals appear in insertion order grouped by type.
   */
  setSortByName(enabled: boolean): void {
    this._sortByName = enabled;
    this._updateDom();
  }

  /** Returns the number of signals currently registered. */
  getSignalCount(): number {
    return this._rows.length;
  }

  /**
   * Return the formatted value string for the signal at the given display index.
   * Returns "" when the value is null (not yet read or after reset).
   */
  getDisplayValue(signalIndex: number): string {
    const ordered = this._orderedRows();
    if (signalIndex < 0 || signalIndex >= ordered.length) {
      throw new RangeError(`Signal index ${signalIndex} out of range`);
    }
    const row = ordered[signalIndex];
    if (row.value === null) {
      return "";
    }
    return typeof row.value === "number" ? row.value.toFixed(4) + " V" : row.value.toString(row.radix);
  }

  /**
   * Return the formatted value string for the signal with the given name.
   * Returns "" when the value is null.
   */
  getDisplayValueByName(name: string): string {
    const row = this._rows.find((r) => r.descriptor.name === name);
    if (row === undefined) {
      throw new Error(`No signal named "${name}" in data table`);
    }
    if (row.value === null) {
      return "";
    }
    return typeof row.value === "number" ? row.value.toFixed(4) + " V" : row.value.toString(row.radix);
  }

  /**
   * Return the radix currently configured for the signal with the given name.
   */
  getRadixByName(name: string): DisplayFormat {
    const row = this._rows.find((r) => r.descriptor.name === name);
    if (row === undefined) {
      throw new Error(`No signal named "${name}" in data table`);
    }
    return row.radix;
  }

  /** Return all signal names in current display order. */
  getSignalNames(): string[] {
    return this._orderedRows().map((r) => r.descriptor.name);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  /** Detach DOM and release references. */
  dispose(): void {
    this._container.innerHTML = "";
    this._tableBody = null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _orderedRows(): SignalRow[] {
    if (!this._sortByName) {
      return this._groupedRows();
    }
    return [...this._rows].sort((a, b) =>
      a.descriptor.name.localeCompare(b.descriptor.name),
    );
  }

  private _groupedRows(): SignalRow[] {
    const inputs = this._rows.filter((r) => r.descriptor.group === "input");
    const outputs = this._rows.filter((r) => r.descriptor.group === "output");
    const probes = this._rows.filter((r) => r.descriptor.group === "probe");
    return [...inputs, ...outputs, ...probes];
  }

  private _buildDom(): void {
    this._container.innerHTML = "";

    const table = document.createElement("table");
    table.className = "data-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const thName = document.createElement("th");
    thName.textContent = "Signal";
    thName.className = "data-table-header-name";

    const thValue = document.createElement("th");
    thValue.textContent = "Value";
    thValue.className = "data-table-header-value";

    headerRow.appendChild(thName);
    headerRow.appendChild(thValue);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    tbody.className = "data-table-body";
    this._tableBody = tbody;
    table.appendChild(tbody);

    this._container.appendChild(table);
    this._populateBody();
  }

  private _updateDom(): void {
    this._populateBody();
  }

  private _populateBody(): void {
    if (this._tableBody === null) return;

    const ordered = this._orderedRows();
    this._tableBody.innerHTML = "";

    let currentGroup: SignalGroup | null = null;

    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];

      // Group separator row (only in grouped/unsorted mode)
      if (!this._sortByName && row.descriptor.group !== currentGroup) {
        currentGroup = row.descriptor.group;
        const separatorTr = document.createElement("tr");
        separatorTr.className = "data-table-group-separator";

        const separatorTd = document.createElement("td");
        separatorTd.colSpan = 2;
        separatorTd.className = "data-table-group-label";
        separatorTd.textContent = _groupLabel(currentGroup);
        separatorTr.appendChild(separatorTd);
        this._tableBody.appendChild(separatorTr);
      }

      const tr = document.createElement("tr");
      tr.className = `data-table-row data-table-group-${row.descriptor.group}`;
      tr.dataset["signalIndex"] = String(i);
      tr.dataset["signalName"] = row.descriptor.name;

      const tdName = document.createElement("td");
      tdName.className = "data-table-cell-name";
      tdName.textContent = row.descriptor.name;

      const tdValue = document.createElement("td");
      tdValue.className = "data-table-cell-value";
      tdValue.textContent = row.value === null
        ? ""
        : typeof row.value === "number"
          ? row.value.toFixed(4) + " V"
          : row.value.toString(row.radix);

      // Right-click context menu for radix switching
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this._showRadixMenu(e as PointerEvent, row);
      });

      tr.appendChild(tdName);
      tr.appendChild(tdValue);
      this._tableBody.appendChild(tr);
    }
  }

  private _showRadixMenu(e: PointerEvent, row: SignalRow): void {
    const existing = document.getElementById("data-table-radix-menu");
    if (existing !== null) {
      existing.remove();
    }

    const menu = document.createElement("ul");
    menu.id = "data-table-radix-menu";
    menu.className = "data-table-context-menu";
    menu.style.position = "fixed";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const formats: Array<{ label: string; format: DisplayFormat }> = [
      { label: "Decimal", format: "dec" },
      { label: "Hexadecimal", format: "hex" },
      { label: "Binary", format: "bin" },
      { label: "Octal", format: "oct" },
      { label: "Signed Decimal", format: "decSigned" },
    ];

    for (const { label, format } of formats) {
      const li = document.createElement("li");
      li.textContent = label;
      li.className = "data-table-context-item";
      if (row.radix === format) {
        li.classList.add("data-table-context-item-active");
      }
      li.addEventListener("click", () => {
        row.radix = format;
        this._updateDom();
        menu.remove();
      });
      menu.appendChild(li);
    }

    document.body.appendChild(menu);

    const dismiss = () => {
      menu.remove();
      document.removeEventListener("click", dismiss);
    };
    document.addEventListener("click", dismiss);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _groupLabel(group: SignalGroup): string {
  switch (group) {
    case "input":
      return "Inputs";
    case "output":
      return "Outputs";
    case "probe":
      return "Probes";
  }
}
