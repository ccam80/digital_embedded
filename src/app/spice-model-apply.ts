/**
 * Helpers for applying SPICE import results to component instances.
 */

import type { CircuitElement } from '../core/element.js';
import type { Circuit } from '../core/circuit.js';
import type { MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';
import type { ModelEntry, ParamDef, ComponentRegistry } from '../core/registry.js';
import { PropertyType } from '../core/properties.js';

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
 *
 * Creates a new inline ModelEntry by copying factory + paramDefs from the
 * component's behavioral model entry, using result.overrides as params.
 * Stores the entry in circuit.metadata.models and updates element properties.
 */
export function applySpiceImportResult(
  element: CircuitElement,
  result: SpiceImportResult,
  circuit: Circuit,
  registry?: ComponentRegistry,
): void {
  const def = registry?.get(element.typeId);
  const behavioralEntry = def?.modelRegistry?.["behavioral"];

  if (!behavioralEntry || behavioralEntry.kind !== "inline") {
    throw new Error(
      `applySpiceImportResult: component "${element.typeId}" has no "behavioral" inline model entry in its modelRegistry`,
    );
  }

  const entry: ModelEntry = {
    kind: "inline",
    factory: behavioralEntry.factory,
    paramDefs: behavioralEntry.paramDefs,
    params: { ...result.overrides },
  };

  if (circuit.metadata.models === undefined) {
    circuit.metadata.models = {};
  }
  if (circuit.metadata.models[element.typeId] === undefined) {
    circuit.metadata.models[element.typeId] = {};
  }
  circuit.metadata.models[element.typeId]![result.modelName] = entry;

  element.getProperties().set("model", result.modelName);
  element.getProperties().replaceModelParams(result.overrides);
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
 *
 * Creates a new netlist ModelEntry derived from the subcircuit's exposed params
 * and stores it in circuit.metadata.models. Sets the element's model property
 * to the subcircuit name.
 */
export function applySpiceSubcktImportResult(
  element: CircuitElement,
  result: SpiceSubcktImportResult,
  circuit: Circuit,
): void {
  const subcktParams = result.netlist.params ?? {};
  const paramDefs: ParamDef[] = Object.entries(subcktParams).map(([key]) => ({
    key,
    type: PropertyType.FLOAT,
    label: key,
    rank: "primary" as const,
  }));

  const entry: ModelEntry = {
    kind: "netlist",
    netlist: result.netlist,
    paramDefs,
    params: { ...subcktParams },
  };

  if (circuit.metadata.models === undefined) {
    circuit.metadata.models = {};
  }
  if (circuit.metadata.models[element.typeId] === undefined) {
    circuit.metadata.models[element.typeId] = {};
  }
  circuit.metadata.models[element.typeId]![result.subcktName] = entry;

  element.getProperties().set("model", result.subcktName);
}
