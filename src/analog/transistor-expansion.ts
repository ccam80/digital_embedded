/**
 * Transistor model expansion — compile-time analog circuit expansion.
 *
 * expandTransistorModel() takes a ComponentDefinition whose transistorModel
 * field names a registered subcircuit in the TransistorModelRegistry, and
 * expands it into a flat list of AnalogElement instances.
 *
 * The subcircuit's In/Out interface elements are mapped to the outer circuit's
 * MNA nodes. Special In elements labeled 'VDD' and 'GND' are mapped to the
 * shared VDD node and ground (node 0) respectively.
 *
 * All other In/Out elements are matched by label to the component's pin layout
 * to find the corresponding outer circuit node.
 *
 * Internal nodes (nodes within the subcircuit that don't connect to interface
 * pins) are assigned unique IDs via the nextNodeId closure so they don't
 * collide with outer circuit nodes or with each other across expansions.
 */

import type { ComponentDefinition } from "../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "./element.js";
import type { SolverDiagnostic } from "../core/analog-engine-interface.js";
import type { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { TransistorModelRegistry } from "./transistor-model-registry.js";
import { makeDiagnostic } from "./diagnostics.js";
import { PropertyBag } from "../core/properties.js";
import { buildNodeMap } from "./node-map.js";

// ---------------------------------------------------------------------------
// TransistorExpansionResult
// ---------------------------------------------------------------------------

export interface TransistorExpansionResult {
  /** All analog elements from the expansion. */
  elements: AnalogElement[];
  /** Number of new internal nodes allocated. */
  internalNodeCount: number;
  /** Any issues detected during expansion. */
  diagnostics: SolverDiagnostic[];
}

// ---------------------------------------------------------------------------
// expandTransistorModel
// ---------------------------------------------------------------------------

/**
 * Expand a single component's transistor model into flat AnalogElement instances.
 *
 * @param componentDef     - The ComponentDefinition with transistorModel set
 * @param outerPinNodeIds  - MNA node IDs for each of the component's pins (by pin order)
 * @param modelRegistry    - Registry of transistor model subcircuits
 * @param vddNodeId        - The shared VDD node ID injected by the compiler
 * @param gndNodeId        - Ground node ID (0)
 * @param nextNodeId       - Closure that returns the next unique MNA node ID on each call
 * @returns TransistorExpansionResult with elements, internal node count, and diagnostics
 */
export function expandTransistorModel(
  componentDef: ComponentDefinition,
  outerPinNodeIds: number[],
  modelRegistry: TransistorModelRegistry,
  vddNodeId: number,
  gndNodeId: number,
  nextNodeId: () => number,
): TransistorExpansionResult {
  const diagnostics: SolverDiagnostic[] = [];

  // Validate: must have transistorModel set
  if (!componentDef.transistorModel) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Component "${componentDef.name}" has simulationMode 'transistor' but no transistorModel defined`,
        {
          explanation:
            `The component "${componentDef.name}" is configured for transistor-level simulation ` +
            `but its ComponentDefinition has no transistorModel field. ` +
            `Set transistorModel to the name of a registered transistor model subcircuit.`,
          suggestions: [
            {
              text: `Add transistorModel: 'CmosXxx' to the ComponentDefinition for "${componentDef.name}".`,
              automatable: false,
            },
          ],
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  // Look up the subcircuit in the registry
  const subcircuit = modelRegistry.get(componentDef.transistorModel);
  if (!subcircuit) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Transistor model subcircuit "${componentDef.transistorModel}" is not registered`,
        {
          explanation:
            `Component "${componentDef.name}" references transistor model ` +
            `"${componentDef.transistorModel}" which has not been registered ` +
            `in the TransistorModelRegistry. Call registerAllCmosGateModels() before compiling.`,
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  // Build a node map for the subcircuit to get wire-to-nodeId mappings
  const subNodeMap = buildNodeMap(subcircuit);
  const subWireToNodeId = subNodeMap.wireToNodeId;

  // Classify subcircuit elements into:
  //   - In/Out interface elements (label-matched to outer pins or VDD/GND)
  //   - Internal analog elements (MOSFETs, resistors, etc.)
  //
  // The node map assigns sequential IDs to wire groups starting at 1.
  // We remap all subcircuit node IDs to outer MNA node IDs:
  //   - Subcircuit node connected to VDD In → vddNodeId
  //   - Subcircuit node connected to GND In → gndNodeId
  //   - Subcircuit node connected to interface In/Out (by label) → outerPinNodeIds[pinIndex]
  //   - All other subcircuit nodes → fresh IDs from nextNodeId()

  // Step 1: Identify interface elements and record subcircuit node → outer node bindings
  const subNodeRemap = new Map<number, number>(); // subcircuit node ID → outer MNA node ID
  // Node 0 in subcircuit is always ground → maps to gndNodeId
  subNodeRemap.set(0, gndNodeId);

  // Build a pin-label → pin index map from the component definition
  const pinLabelToIndex = new Map<string, number>();
  for (let i = 0; i < componentDef.pinLayout.length; i++) {
    pinLabelToIndex.set(componentDef.pinLayout[i].label, i);
  }

  // Track which elements are interface In/Out elements (skip in analog stamping)
  const interfaceElementIds = new Set<string>();

  for (const el of subcircuit.elements) {
    if (el.typeId !== "In" && el.typeId !== "Out") {
      continue;
    }

    const props = el.getProperties();
    const label = props.has("label") ? (props.get<string>("label")) : "";

    // Map VDD/GND interface elements
    if (label === "VDD") {
      const subNode = resolveElementFirstNode(el, subWireToNodeId, subcircuit);
      if (subNode >= 0) {
        subNodeRemap.set(subNode, vddNodeId);
      }
      interfaceElementIds.add(el.instanceId);
      continue;
    }

    if (label === "GND") {
      const subNode = resolveElementFirstNode(el, subWireToNodeId, subcircuit);
      if (subNode >= 0) {
        subNodeRemap.set(subNode, gndNodeId);
      }
      interfaceElementIds.add(el.instanceId);
      continue;
    }

    // Map pin interface elements by label match to outer pin nodes
    const pinIdx = pinLabelToIndex.get(label);
    if (pinIdx !== undefined && pinIdx < outerPinNodeIds.length) {
      const subNode = resolveElementFirstNode(el, subWireToNodeId, subcircuit);
      if (subNode >= 0) {
        subNodeRemap.set(subNode, outerPinNodeIds[pinIdx]);
      }
      interfaceElementIds.add(el.instanceId);
    } else {
      // Interface element whose label doesn't match any pin — treat as interface but warn
      interfaceElementIds.add(el.instanceId);
    }
  }

  // Step 2: Assign fresh MNA node IDs to all unmapped subcircuit nodes
  let internalNodeCount = 0;
  const allSubNodes = collectAllSubcircuitNodes(subWireToNodeId);
  for (const subNodeId of allSubNodes) {
    if (!subNodeRemap.has(subNodeId)) {
      subNodeRemap.set(subNodeId, nextNodeId());
      internalNodeCount++;
    }
  }

  // Step 3: Validate that non-interface elements have analogFactory (are analog leaf components)
  for (const el of subcircuit.elements) {
    if (interfaceElementIds.has(el.instanceId)) continue;
    if (el.typeId === "Ground") continue;

    if (!getAnalogFactory(el.typeId)) {
      diagnostics.push(
        makeDiagnostic(
          "invalid-transistor-model",
          "error",
          `Transistor model "${componentDef.transistorModel}" contains non-analog component "${el.typeId}"`,
          {
            explanation:
              `The transistor model subcircuit "${componentDef.transistorModel}" contains ` +
              `component type "${el.typeId}" which has no analog factory and cannot be ` +
              `stamped into the MNA matrix. Transistor models must contain only analog ` +
              `leaf components (MOSFETs, resistors, voltage sources, etc.).`,
          },
        ),
      );
      return { elements: [], internalNodeCount: 0, diagnostics };
    }
  }

  // Step 4: Instantiate AnalogElement for each non-interface element
  const elements: AnalogElement[] = [];

  for (const el of subcircuit.elements) {
    if (interfaceElementIds.has(el.instanceId)) continue;
    if (el.typeId === "Ground") continue;

    // Resolve pin nodes in subcircuit space, then remap to outer MNA node IDs
    const subPinNodes = resolveAllElementNodes(el, subWireToNodeId, subcircuit);
    const remappedNodes = subPinNodes.map((n) => subNodeRemap.get(n) ?? n);

    const factory = getAnalogFactory(el.typeId);
    if (!factory) continue;

    const props = el.getProperties();
    const core = factory(remappedNodes, -1, props, () => 0);
    const analogEl: AnalogElement = Object.assign(core, { pinNodeIds: remappedNodes });
    elements.push(analogEl);
  }

  return { elements, internalNodeCount, diagnostics };
}

// ---------------------------------------------------------------------------
// Helper: collect all unique node IDs used in the subcircuit (from wire map)
// ---------------------------------------------------------------------------

function collectAllSubcircuitNodes(
  wireToNodeId: Map<Wire, number>,
): Set<number> {
  const nodes = new Set<number>();
  nodes.add(0); // ground is always present
  for (const nodeId of wireToNodeId.values()) {
    nodes.add(nodeId);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Helper: resolve the single node ID that an In/Out element connects to
// (uses the first pin of the element)
// ---------------------------------------------------------------------------

function resolveElementFirstNode(
  el: CircuitElement,
  wireToNodeId: Map<Wire, number>,
  circuit: Circuit,
): number {
  const nodes = resolveAllElementNodes(el, wireToNodeId, circuit);
  return nodes.length > 0 ? nodes[0] : -1;
}

// ---------------------------------------------------------------------------
// Helper: resolve all MNA node IDs for an element's pins
// ---------------------------------------------------------------------------

function resolveAllElementNodes(
  el: CircuitElement,
  wireToNodeId: Map<Wire, number>,
  circuit: Circuit,
): number[] {
  const pins = el.getPins();
  const result: number[] = new Array(pins.length).fill(-1);

  for (let i = 0; i < pins.length; i++) {
    const pinPos = pins[i].position;
    for (const wire of circuit.wires) {
      const matchStart =
        Math.abs(wire.start.x - pinPos.x) < 0.5 &&
        Math.abs(wire.start.y - pinPos.y) < 0.5;
      const matchEnd =
        Math.abs(wire.end.x - pinPos.x) < 0.5 &&
        Math.abs(wire.end.y - pinPos.y) < 0.5;
      if (matchStart || matchEnd) {
        const nodeId = wireToNodeId.get(wire);
        if (nodeId !== undefined) {
          result[i] = nodeId;
          break;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Analog factory registry — maps typeId strings to inline analog factories.
//
// This minimal registry covers the leaf analog components that transistor
// model subcircuits may contain. It is separate from ComponentRegistry to
// avoid circular dependencies during compilation.
//
// Populated lazily using dynamic imports when needed. For the transistor
// expansion use case, we hard-code the MOSFET factories since those are the
// only components used in CMOS transistor models.
// ---------------------------------------------------------------------------

type AnalogFactory = (
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore;

// Known analog component type IDs and their factories.
// This map is populated by registerAnalogFactory() calls from component modules.
const _analogFactoryRegistry = new Map<string, AnalogFactory>();

/**
 * Register an analog factory for a component typeId.
 * Called by component modules during initialization.
 */
export function registerAnalogFactory(typeId: string, factory: AnalogFactory): void {
  _analogFactoryRegistry.set(typeId, factory);
}

/**
 * Look up an analog factory by typeId. Returns undefined for unknown types.
 */
export function getAnalogFactory(typeId: string): AnalogFactory | undefined {
  return _analogFactoryRegistry.get(typeId);
}
