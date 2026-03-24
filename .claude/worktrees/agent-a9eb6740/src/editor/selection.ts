/**
 * SelectionModel — tracks which elements and wires are currently selected.
 *
 * The model is mutated by editor interaction handlers. The renderer reads
 * selectedElements and selectedWires to draw highlights. Change listeners
 * allow the render loop to schedule a repaint on any mutation.
 */

import type { CircuitElement } from "@/core/element";
import { Wire } from "@/core/circuit";
import type { Circuit } from "@/core/circuit";

export type ChangeListener = () => void;

export class SelectionModel {
  private readonly _elements: Set<CircuitElement> = new Set();
  private readonly _wires: Set<Wire> = new Set();
  private readonly _listeners: ChangeListener[] = [];

  // ---------------------------------------------------------------------------
  // Mutation API
  // ---------------------------------------------------------------------------

  /**
   * Clear all selections and select exactly one item.
   */
  select(item: CircuitElement | Wire): void {
    this._elements.clear();
    this._wires.clear();
    this._addItem(item);
    this._notify();
  }

  /**
   * Add the item if not present; remove it if already selected.
   * Does not affect other selected items.
   */
  toggleSelect(item: CircuitElement | Wire): void {
    if (this._hasItem(item)) {
      this._removeItem(item);
    } else {
      this._addItem(item);
    }
    this._notify();
  }

  /**
   * Replace the entire selection with the given items.
   */
  boxSelect(elements: CircuitElement[], wires: Wire[]): void {
    this._elements.clear();
    this._wires.clear();
    for (const el of elements) {
      this._elements.add(el);
    }
    for (const wire of wires) {
      this._wires.add(wire);
    }
    this._notify();
  }

  /**
   * Select every element and wire in the circuit.
   */
  selectAll(circuit: Circuit): void {
    this._elements.clear();
    this._wires.clear();
    for (const el of circuit.elements) {
      this._elements.add(el);
    }
    for (const wire of circuit.wires) {
      this._wires.add(wire);
    }
    this._notify();
  }

  /**
   * Deselect everything.
   */
  clear(): void {
    this._elements.clear();
    this._wires.clear();
    this._notify();
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  isSelected(item: CircuitElement | Wire): boolean {
    return this._hasItem(item);
  }

  isEmpty(): boolean {
    return this._elements.size === 0 && this._wires.size === 0;
  }

  getSelectedElements(): ReadonlySet<CircuitElement> {
    return this._elements;
  }

  getSelectedWires(): ReadonlySet<Wire> {
    return this._wires;
  }

  // ---------------------------------------------------------------------------
  // Change listeners
  // ---------------------------------------------------------------------------

  onChange(callback: ChangeListener): void {
    this._listeners.push(callback);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _addItem(item: CircuitElement | Wire): void {
    if (item instanceof Wire) {
      this._wires.add(item);
    } else {
      this._elements.add(item as CircuitElement);
    }
  }

  private _removeItem(item: CircuitElement | Wire): void {
    if (item instanceof Wire) {
      this._wires.delete(item);
    } else {
      this._elements.delete(item as CircuitElement);
    }
  }

  private _hasItem(item: CircuitElement | Wire): boolean {
    if (item instanceof Wire) {
      return this._wires.has(item);
    }
    return this._elements.has(item as CircuitElement);
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}
