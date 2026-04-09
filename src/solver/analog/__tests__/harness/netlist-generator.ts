/**
 * Auto-generates a SPICE netlist from a compiled analog circuit.
 *
 * Iterates compiled elements, uses element labels for SPICE instance names,
 * reads parameters from property bags, and emits SPICE element lines.
 * Emits model cards for semiconductors.
 */

import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { PropertyBag } from "../../../../core/properties.js";

// ---------------------------------------------------------------------------
// SPICE prefix table (typeId -> SPICE prefix, model type for semiconductors)
// ---------------------------------------------------------------------------

interface ElementSpec {
  prefix: string;
  modelType?: string;
}

const ELEMENT_SPECS: Record<string, ElementSpec> = {
  Resistor:        { prefix: "R" },
  Capacitor:       { prefix: "C" },
  Inductor:        { prefix: "L" },
  DcVoltageSource: { prefix: "V" },
  AcVoltageSource: { prefix: "V" },
  DcCurrentSource: { prefix: "I" },
  AcCurrentSource: { prefix: "I" },
  Diode:           { prefix: "D", modelType: "D" },
  Zener:           { prefix: "D", modelType: "D" },
  Varactor:        { prefix: "D", modelType: "D" },
  TunnelDiode:     { prefix: "D", modelType: "D" },
  NpnBJT:          { prefix: "Q", modelType: "NPN" },
  PnpBJT:          { prefix: "Q", modelType: "PNP" },
  NMOS:            { prefix: "M", modelType: "NMOS" },
  PMOS:            { prefix: "M", modelType: "PMOS" },
  NJFET:           { prefix: "J", modelType: "NMF" },
  PJFET:           { prefix: "J", modelType: "PMF" },
};

// ---------------------------------------------------------------------------
// generateSpiceNetlist
// ---------------------------------------------------------------------------

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  elementLabels: Map<number, string>,
  title?: string,
): string {
  const lines: string[] = [];

  // Title line
  lines.push(title ?? "Auto-generated netlist");

  // Collect model cards: modelName -> ".model <name> <type> (<params>)"
  const modelCards = new Map<string, string>();

  // One element line per compiled element
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i];
    const label = elementLabels.get(i) ?? `element_${i}`;
    const circuitEl = compiled.elementToCircuitElement.get(i);

    if (!circuitEl) continue;

    const typeId = circuitEl.typeId;
    const spec = ELEMENT_SPECS[typeId];
    if (!spec) continue;

    const props = circuitEl.getProperties();
    const nodes = el.pinNodeIds;

    let line: string;

    if (typeId === "Resistor") {
      const R = getPropNumber(props, "resistance", 1000);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${R}`;

    } else if (typeId === "Capacitor") {
      const C = getPropNumber(props, "capacitance", 1e-6);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${C}`;

    } else if (typeId === "Inductor") {
      const L = getPropNumber(props, "inductance", 1e-3);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${L}`;

    } else if (typeId === "DcVoltageSource") {
      const V = getPropNumber(props, "voltage", 0);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} DC ${V}`;

    } else if (typeId === "AcVoltageSource") {
      const amp = getPropNumber(props, "amplitude", 1);
      const dc = getPropNumber(props, "dcOffset", 0);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} DC ${dc} AC ${amp}`;

    } else if (typeId === "DcCurrentSource") {
      const I = getPropNumber(props, "current", 0);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} DC ${I}`;

    } else if (typeId === "AcCurrentSource") {
      const amp = getPropNumber(props, "amplitude", 1);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} AC ${amp}`;

    } else if (spec.prefix === "D") {
      // Diode variants: D name A K modelName
      const modelName = `${label}_${spec.modelType}`;
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "Q") {
      // BJT: Q name C B E modelName
      const modelName = `${label}_${spec.modelType}`;
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${nodes[2] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "M") {
      // MOSFET: M name D G S B modelName W=... L=...
      const modelName = `${label}_${spec.modelType}`;
      const W = getPropNumber(props, "W", 1e-6);
      const L = getPropNumber(props, "L", 1e-6);
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${nodes[2] ?? 0} ${nodes[3] ?? 0} ${modelName} W=${W} L=${L}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else if (spec.prefix === "J") {
      // JFET: J name D G S modelName
      const modelName = `${label}_${spec.modelType}`;
      line = `${spec.prefix}${label} ${nodes[0] ?? 0} ${nodes[1] ?? 0} ${nodes[2] ?? 0} ${modelName}`;
      if (!modelCards.has(modelName)) {
        modelCards.set(modelName, buildModelCard(modelName, spec.modelType!, props));
      }

    } else {
      continue;
    }

    lines.push(line);
  }

  // Emit model cards
  for (const card of modelCards.values()) {
    lines.push(card);
  }

  lines.push(".end");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Model card builder
// ---------------------------------------------------------------------------

function buildModelCard(
  modelName: string,
  spiceModelType: string,
  props: PropertyBag,
): string {
  const paramKeys = props.getModelParamKeys();
  const paramParts: string[] = [];

  for (const key of paramKeys) {
    if (!isSpiceModelParam(key)) continue;
    const value = props.getModelParam<number>(key);
    if (typeof value === "number") {
      paramParts.push(`${key}=${value}`);
    }
  }

  if (paramParts.length === 0) {
    return `.model ${modelName} ${spiceModelType}`;
  }
  return `.model ${modelName} ${spiceModelType} (${paramParts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// Helper: read a numeric property from model params or regular bag
// ---------------------------------------------------------------------------

function getPropNumber(props: PropertyBag, key: string, defaultValue: number): number {
  if (props.hasModelParam(key)) {
    return props.getModelParam<number>(key);
  }
  if (props.has(key)) {
    return props.get<number>(key);
  }
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Filter out non-SPICE model param keys
// ---------------------------------------------------------------------------

const NON_SPICE_KEYS = new Set([
  "label", "model", "waveform", "expression",
  "bits", "bitWidth",
]);

function isSpiceModelParam(key: string): boolean {
  return !NON_SPICE_KEYS.has(key);
}
