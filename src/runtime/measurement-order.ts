/**
 * MeasurementOrderPanel — UI to select which signals appear in data table
 * and timing diagram, and in what order.
 *
 * Maintains an ordered list of SignalEntry objects. Each entry has a name,
 * group, and a visible flag. Consumers (DataTablePanel, TimingDiagramPanel)
 * subscribe via change listeners and call getVisibleSignals() to obtain the
 * current ordered, visible list.
 *
 * Ordering persists in circuit metadata via toJSON() / fromJSON().
 */

import type { SignalDescriptor, SignalGroup } from "./data-table.js";

// ---------------------------------------------------------------------------
// SignalEntry — one row in the ordering panel
// ---------------------------------------------------------------------------

export interface SignalEntry {
  readonly name: string;
  readonly netId: number;
  readonly width: number;
  readonly group: SignalGroup;
  /** Whether this signal is shown in the data table and timing diagram. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Serialised form for circuit metadata persistence
// ---------------------------------------------------------------------------

export interface MeasurementOrderState {
  entries: Array<{
    name: string;
    netId: number;
    width: number;
    group: SignalGroup;
    visible: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Change listener type
// ---------------------------------------------------------------------------

export type MeasurementOrderListener = (entries: readonly SignalEntry[]) => void;

// ---------------------------------------------------------------------------
// MeasurementOrderPanel
// ---------------------------------------------------------------------------

/**
 * Manages the ordered list of visible signals shown in the data table and
 * timing diagram.
 *
 * Usage:
 *   const panel = new MeasurementOrderPanel(signals);
 *   panel.addChangeListener((entries) => {
 *     dataTable.setVisibleSignals(entries.filter(e => e.visible));
 *   });
 */
export class MeasurementOrderPanel {
  private _entries: SignalEntry[];
  private readonly _listeners: Set<MeasurementOrderListener> = new Set();
  private _container: HTMLElement | null = null;

  constructor(signals: readonly SignalDescriptor[]) {
    // Default order: inputs first, then outputs, then probes (matching DataTablePanel)
    const inputs = signals.filter((s) => s.group === "input");
    const outputs = signals.filter((s) => s.group === "output");
    const probes = signals.filter((s) => s.group === "probe");

    this._entries = [...inputs, ...outputs, ...probes].map((s) => ({
      name: s.name,
      netId: s.netId,
      width: s.width,
      group: s.group,
      visible: true,
    }));
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Return all entries in current display order. */
  getEntries(): readonly SignalEntry[] {
    return this._entries;
  }

  /** Return only visible entries in current display order. */
  getVisibleSignals(): readonly SignalEntry[] {
    return this._entries.filter((e) => e.visible);
  }

  /** Return the number of entries (visible + hidden). */
  getCount(): number {
    return this._entries.length;
  }

  // -------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------

  /**
   * Move the entry at `fromIndex` to `toIndex`.
   * Both indices are in the current order. Throws if either is out of range.
   */
  moveEntry(fromIndex: number, toIndex: number): void {
    const n = this._entries.length;
    if (fromIndex < 0 || fromIndex >= n) {
      throw new RangeError(`fromIndex ${fromIndex} out of range`);
    }
    if (toIndex < 0 || toIndex >= n) {
      throw new RangeError(`toIndex ${toIndex} out of range`);
    }
    if (fromIndex === toIndex) return;

    const entry = this._entries[fromIndex]!;
    const newEntries = this._entries.filter((_, i) => i !== fromIndex);
    newEntries.splice(toIndex, 0, entry);
    this._entries = newEntries;
    this._notify();
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /**
   * Set the visibility of the signal at the given index.
   * Throws if index is out of range.
   */
  setVisible(index: number, visible: boolean): void {
    if (index < 0 || index >= this._entries.length) {
      throw new RangeError(`index ${index} out of range`);
    }
    this._entries[index]!.visible = visible;
    this._notify();
  }

  /**
   * Set the visibility of the signal with the given name.
   * Throws if no signal with that name is found.
   */
  setVisibleByName(name: string, visible: boolean): void {
    const entry = this._entries.find((e) => e.name === name);
    if (entry === undefined) {
      throw new Error(`No signal named "${name}"`);
    }
    entry.visible = visible;
    this._notify();
  }

  /** Make all signals visible. */
  showAll(): void {
    for (const e of this._entries) {
      e.visible = true;
    }
    this._notify();
  }

  /** Hide all signals. */
  hideAll(): void {
    for (const e of this._entries) {
      e.visible = false;
    }
    this._notify();
  }

  // -------------------------------------------------------------------------
  // Change listeners
  // -------------------------------------------------------------------------

  /** Register a listener that is called whenever the order or visibility changes. */
  addChangeListener(listener: MeasurementOrderListener): void {
    this._listeners.add(listener);
  }

  /** Remove a previously registered listener. */
  removeChangeListener(listener: MeasurementOrderListener): void {
    this._listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Persistence — circuit metadata round-trip
  // -------------------------------------------------------------------------

  /** Serialise the current ordering and visibility to a plain object. */
  toJSON(): MeasurementOrderState {
    return {
      entries: this._entries.map((e) => ({
        name: e.name,
        netId: e.netId,
        width: e.width,
        group: e.group,
        visible: e.visible,
      })),
    };
  }

  /**
   * Restore ordering and visibility from a serialised state.
   *
   * Signals present in the state but not in the current panel are ignored.
   * Signals present in the current panel but not in the state retain their
   * default ordering at the end.
   */
  fromJSON(state: MeasurementOrderState): void {
    const currentByName = new Map(this._entries.map((e) => [e.name, e]));
    const reordered: SignalEntry[] = [];
    const seen = new Set<string>();

    for (const saved of state.entries) {
      const entry = currentByName.get(saved.name);
      if (entry !== undefined) {
        entry.visible = saved.visible;
        reordered.push(entry);
        seen.add(saved.name);
      }
    }

    // Append any entries not mentioned in the saved state
    for (const e of this._entries) {
      if (!seen.has(e.name)) {
        reordered.push(e);
      }
    }

    this._entries = reordered;
    this._notify();
  }

  // -------------------------------------------------------------------------
  // DOM rendering (optional — panel may be used without a DOM)
  // -------------------------------------------------------------------------

  /**
   * Mount the panel into the given container element.
   * Renders a list of signal rows with checkboxes and drag handles.
   */
  mount(container: HTMLElement): void {
    this._container = container;
    this._renderDom();
  }

  /** Detach the DOM and release references. */
  dispose(): void {
    if (this._container !== null) {
      this._container.innerHTML = "";
      this._container = null;
    }
    this._listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _notify(): void {
    for (const listener of this._listeners) {
      listener(this._entries);
    }
    if (this._container !== null) {
      this._renderDom();
    }
  }

  private _renderDom(): void {
    if (this._container === null) return;
    this._container.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "measurement-order-toolbar";

    const showAllBtn = document.createElement("button");
    showAllBtn.textContent = "Show All";
    showAllBtn.className = "measurement-order-show-all";
    showAllBtn.addEventListener("click", () => this.showAll());

    const hideAllBtn = document.createElement("button");
    hideAllBtn.textContent = "Hide All";
    hideAllBtn.className = "measurement-order-hide-all";
    hideAllBtn.addEventListener("click", () => this.hideAll());

    toolbar.appendChild(showAllBtn);
    toolbar.appendChild(hideAllBtn);
    this._container.appendChild(toolbar);

    const list = document.createElement("ul");
    list.className = "measurement-order-list";

    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i]!;
      const li = document.createElement("li");
      li.className = "measurement-order-item";
      li.draggable = true;
      li.dataset["index"] = String(i);

      // Drag handle
      const handle = document.createElement("span");
      handle.className = "measurement-order-handle";
      handle.textContent = "⠿";

      // Checkbox
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "measurement-order-checkbox";
      checkbox.checked = entry.visible;
      checkbox.addEventListener("change", () => {
        entry.visible = checkbox.checked;
        this._notify();
      });

      // Label
      const label = document.createElement("span");
      label.className = "measurement-order-label";
      label.textContent = entry.name;

      li.appendChild(handle);
      li.appendChild(checkbox);
      li.appendChild(label);
      list.appendChild(li);

      // Drag-and-drop reordering
      li.addEventListener("dragstart", (e) => {
        if (e.dataTransfer !== null) {
          e.dataTransfer.setData("text/plain", String(i));
        }
      });

      li.addEventListener("dragover", (e) => {
        e.preventDefault();
      });

      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const fromStr = e.dataTransfer?.getData("text/plain");
        if (fromStr !== undefined) {
          const from = parseInt(fromStr, 10);
          if (!isNaN(from) && from !== i) {
            this.moveEntry(from, i);
          }
        }
      });
    }

    this._container.appendChild(list);
  }
}
