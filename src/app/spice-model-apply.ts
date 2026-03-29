/**
 * Pure helpers for applying SPICE import results to component instances.
 *
 * Separated from spice-import-dialog.ts and spice-subckt-dialog.ts so they
 * can be imported in headless (node) test environments without pulling in
 * DOM dependencies.
 */

import type { CircuitElement } from '../core/element.js';
import type { Circuit } from '../core/circuit.js';
import { SubcircuitModelRegistry } from '../solver/analog/subcircuit-model-registry.js';
import type { MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';
/** The result produced by the .MODEL import dialog. */
export interface SpiceImportResult {
  /** Parsed params object — stored as _spiceModelOverrides. */
  overrides: Record<string, number>;
  /** Display name — stored as _spiceModelName. */
  modelName: string;
  /** Parsed device type for library-level storage. */
  deviceType: string;
}

/**
 * Apply the .MODEL import result:
 *   1. Write to circuit.metadata.namedParameterSets (library-level).
 *   2. Write _spiceModelOverrides and _spiceModelName on the element (per-instance).
 * Both coexist: library provides shared defaults, instance overrides customize this component.
 */
export function applySpiceImportResult(
  element: CircuitElement,
  result: SpiceImportResult,
  circuit: Circuit,
): void {
  if (!circuit.metadata.namedParameterSets) circuit.metadata.namedParameterSets = {};
  circuit.metadata.namedParameterSets[result.modelName] = {
    deviceType: result.deviceType,
    params: { ...result.overrides },
  };
  element.getProperties().set('_spiceModelOverrides', result.overrides);
  element.getProperties().set('_spiceModelName', result.modelName);
}

/** The result produced by the .SUBCKT import dialog. */
export interface SpiceSubcktImportResult {
  /** Subcircuit name (from the .SUBCKT header). */
  subcktName: string;
  /** Compiled netlist — registered in SubcircuitModelRegistry and stored in circuit.metadata.modelDefinitions. */
  netlist: MnaSubcircuitNetlist;
}

/**
 * Apply the .SUBCKT import result:
 *   1. Register the netlist in the provided SubcircuitModelRegistry.
 *   2. Write the MnaSubcircuitNetlist to circuit.metadata.modelDefinitions.
 *   3. Set simulationModel on the instance to the subcircuit name.
 */
export function applySpiceSubcktImportResult(
  element: CircuitElement,
  result: SpiceSubcktImportResult,
  modelRegistry: SubcircuitModelRegistry,
  circuit: Circuit,
): void {
  modelRegistry.register(result.subcktName, result.netlist);
  if (!circuit.metadata.modelDefinitions) circuit.metadata.modelDefinitions = {};
  circuit.metadata.modelDefinitions[result.subcktName] = result.netlist;
  element.getProperties().set('simulationModel', result.subcktName);
}
