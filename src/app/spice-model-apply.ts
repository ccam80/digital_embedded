/**
 * Pure helpers for applying SPICE import results to component instances.
 *
 * Separated from spice-import-dialog.ts and spice-subckt-dialog.ts so they
 * can be imported in headless (node) test environments without pulling in
 * DOM dependencies.
 */

import type { CircuitElement } from '../core/element.js';
import type { Circuit } from '../core/circuit.js';
import { TransistorModelRegistry } from '../solver/analog/transistor-model-registry.js';

/** The result produced by the .MODEL import dialog. */
export interface SpiceImportResult {
  /** Serialized JSON of parsed params — stored as _spiceModelOverrides. */
  overridesJson: string;
  /** Display name — stored as _spiceModelName. */
  modelName: string;
}

/**
 * Apply the .MODEL import result to the element's PropertyBag in-place.
 * Called by the context menu handler after the dialog resolves.
 */
export function applySpiceImportResult(
  element: CircuitElement,
  result: SpiceImportResult,
): void {
  element.getProperties().set('_spiceModelOverrides', result.overridesJson);
  element.getProperties().set('_spiceModelName', result.modelName);
}

/** The result produced by the .SUBCKT import dialog. */
export interface SpiceSubcktImportResult {
  /** Subcircuit name (from the .SUBCKT header). */
  subcktName: string;
  /** The built Circuit to register in TransistorModelRegistry. */
  circuit: Circuit;
}

/**
 * Apply the .SUBCKT import result:
 *   1. Register the circuit in the provided TransistorModelRegistry.
 *   2. Set simulationModel on the instance to the subcircuit name.
 */
export function applySpiceSubcktImportResult(
  element: CircuitElement,
  result: SpiceSubcktImportResult,
  modelRegistry: TransistorModelRegistry,
): void {
  modelRegistry.register(result.subcktName, result.circuit);
  element.getProperties().set('simulationModel', result.subcktName);
}
