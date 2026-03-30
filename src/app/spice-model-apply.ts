/**
 * Helpers for applying SPICE import results to component instances.
 */

import type { CircuitElement } from '../core/element.js';
import type { Circuit } from '../core/circuit.js';
import type { MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';

/** The result produced by the .MODEL import dialog. */
export interface SpiceImportResult {
  /** Parsed params object. */
  overrides: Record<string, number>;
  /** Display name. */
  modelName: string;
  /** Parsed device type for library-level storage. */
  deviceType: string;
}

/**
 * Apply the .MODEL import result to a component instance and circuit.
 */
export function applySpiceImportResult(
  _element: CircuitElement,
  _result: SpiceImportResult,
  _circuit: Circuit,
): void {
  throw new Error("applySpiceImportResult: pending reimplementation with unified model system");
}

/** The result produced by the .SUBCKT import dialog. */
export interface SpiceSubcktImportResult {
  /** Subcircuit name (from the .SUBCKT header). */
  subcktName: string;
  /** Compiled netlist. */
  netlist: MnaSubcircuitNetlist;
}

/**
 * Apply the .SUBCKT import result to a component instance and circuit.
 */
export function applySpiceSubcktImportResult(
  _element: CircuitElement,
  _result: SpiceSubcktImportResult,
  _circuit: Circuit,
): void {
  throw new Error("applySpiceSubcktImportResult: pending reimplementation with unified model system");
}
