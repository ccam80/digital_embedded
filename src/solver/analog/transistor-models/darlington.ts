/**
 * NPN/PNP Darlington transistor pair subcircuit definitions as MnaSubcircuitNetlist.
 *
 * Each Darlington is two BJTs wired so that the collector of Q1 connects to
 * the shared collector terminal, the emitter of Q1 connects to the base of
 * Q2, and Q2's collector also connects to the shared collector terminal.
 * A base-emitter resistor R_BE (10 kΩ) across Q2's B-E junction speeds up
 * turn-off by providing a discharge path.
 *
 * Ports: B=0, C=1, E=2
 * Internal: Q1E_Q2B=3
 *
 * BJT pin order in netlist: B, C, E (matching bjt.ts pinLayout)
 * Resistor pin order: A, B
 */

import type { MnaSubcircuitNetlist } from "../../../core/mna-subcircuit-netlist.js";
import { PinDirection } from "../../../core/pin.js";
import type { PinDeclaration } from "../../../core/pin.js";
import {
  ComponentCategory,
  type ComponentDefinition,
} from "../../../core/registry.js";
import type { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";

// ---------------------------------------------------------------------------
// createNpnDarlington
//
// Ports: B=0, C=1, E=2
// Internal: Q1E_Q2B=3
//
// Q1: NPN, B=B(0), C=C(1), E=Q1E_Q2B(3)
// Q2: NPN, B=Q1E_Q2B(3), C=C(1), E=E(2)
// R_BE: A=Q1E_Q2B(3), B=E(2)
// ---------------------------------------------------------------------------

export function createNpnDarlington(): MnaSubcircuitNetlist {
  const B = 0, C = 1, E = 2, Q1E_Q2B = 3;
  return {
    ports: ["B", "C", "E"],
    elements: [
      { typeId: "NpnBJT", modelRef: "NPN_DEFAULT" },
      { typeId: "NpnBJT", modelRef: "NPN_DEFAULT" },
      { typeId: "Resistor", params: { resistance: 10000 } },
    ],
    internalNetCount: 1,
    netlist: [
      [B, C, Q1E_Q2B],      // Q1: B=B, C=C, E=Q1E_Q2B
      [Q1E_Q2B, C, E],      // Q2: B=Q1E_Q2B, C=C, E=E
      [Q1E_Q2B, E],          // R_BE: A=Q1E_Q2B, B=E
    ],
  };
}

// ---------------------------------------------------------------------------
// createPnpDarlington
//
// Same topology as NPN but with PnpBJT elements.
// ---------------------------------------------------------------------------

export function createPnpDarlington(): MnaSubcircuitNetlist {
  const B = 0, C = 1, E = 2, Q1E_Q2B = 3;
  return {
    ports: ["B", "C", "E"],
    elements: [
      { typeId: "PnpBJT", modelRef: "PNP_DEFAULT" },
      { typeId: "PnpBJT", modelRef: "PNP_DEFAULT" },
      { typeId: "Resistor", params: { resistance: 10000 } },
    ],
    internalNetCount: 1,
    netlist: [
      [B, C, Q1E_Q2B],      // Q1: B=B, C=C, E=Q1E_Q2B
      [Q1E_Q2B, C, E],      // Q2: B=Q1E_Q2B, C=C, E=E
      [Q1E_Q2B, E],          // R_BE: A=Q1E_Q2B, B=E
    ],
  };
}

// ---------------------------------------------------------------------------
// Pin layout — same as single BJT (B, C, E terminals)
// ---------------------------------------------------------------------------

function buildDarlingtonPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 2, y: -1.5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "E",
      defaultBitWidth: 1,
      position: { x: 2, y: 1.5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// registerDarlingtonModels
// ---------------------------------------------------------------------------

/**
 * Register NPN and PNP Darlington subcircuits in the SubcircuitModelRegistry
 * and return the two ComponentDefinitions.
 *
 * The ComponentDefinitions are returned (not registered in ComponentRegistry)
 * so callers can choose when to add them to the component registry.
 */
export function registerDarlingtonModels(registry: SubcircuitModelRegistry): void {
  registry.register("DarlingtonNPN", createNpnDarlington());
  registry.register("DarlingtonPNP", createPnpDarlington());
}

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const DarlingtonNpnDefinition: ComponentDefinition = {
  name: "DarlingtonNPN",
  typeId: -1,
  factory: (_props) => {
    throw new Error("DarlingtonNPN uses transistor-level expansion; no circuit element factory needed");
  },
  pinLayout: buildDarlingtonPinDeclarations(),
  propertyDefs: [],
  attributeMap: [],
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "NPN Darlington transistor pair.\n" +
    "Two NPN BJTs in Darlington configuration with R_BE = 10 kΩ.\n" +
    "Pins: B (base), C (collector), E (emitter).",
  subcircuitRefs: { cmos: "DarlingtonNPN" },
  models: {},
};

export const DarlingtonPnpDefinition: ComponentDefinition = {
  name: "DarlingtonPNP",
  typeId: -1,
  factory: (_props) => {
    throw new Error("DarlingtonPNP uses transistor-level expansion; no circuit element factory needed");
  },
  pinLayout: buildDarlingtonPinDeclarations(),
  propertyDefs: [],
  attributeMap: [],
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "PNP Darlington transistor pair.\n" +
    "Two PNP BJTs in Darlington configuration with R_BE = 10 kΩ.\n" +
    "Pins: B (base), C (collector), E (emitter).",
  subcircuitRefs: { cmos: "DarlingtonPNP" },
  models: {},
};
