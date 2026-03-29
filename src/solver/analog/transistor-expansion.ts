/**
 * Transistor model expansion — compile-time analog circuit expansion.
 *
 * expandTransistorModel() takes a ComponentDefinition whose subcircuitModel
 * field names a registered subcircuit in the SubcircuitModelRegistry, and
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

import type { ComponentDefinition } from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "./element.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import type { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { SubcircuitModelRegistry } from "./subcircuit-model-registry.js";
import { makeDiagnostic } from "./diagnostics.js";
import { PropertyBag } from "../../core/properties.js";
import { pinWorldPosition } from "../../core/pin.js";

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
 * @param componentDef     - The ComponentDefinition with subcircuitModel set
 * @param outerPinNodeIds  - MNA node IDs for each of the component's pins (by pin order)
 * @param modelRegistry    - Registry of transistor model subcircuits
 * @param vddNodeId        - The shared VDD node ID injected by the compiler
 * @param gndNodeId        - Ground node ID (0)
 * @param nextNodeId       - Closure that returns the next unique MNA node ID on each call
 * @returns TransistorExpansionResult with elements, internal node count, and diagnostics
 */
function buildWireToNodeId(subcircuit: Circuit): Map<Wire, number> {
  const pointToId = new Map<string, number>();
  let nextId = 0;

  function getOrCreate(p: { x: number; y: number }): number {
    const k = `${p.x},${p.y}`;
    let id = pointToId.get(k);
    if (id === undefined) { id = nextId++; pointToId.set(k, id); }
    return id;
  }

  const wireStartIds: number[] = [];
  const wireEndIds: number[] = [];
  for (const wire of subcircuit.wires) {
    wireStartIds.push(getOrCreate(wire.start));
    wireEndIds.push(getOrCreate(wire.end));
  }

  const total = nextId;
  const parent = Array.from({ length: Math.max(total, 1) }, (_, i) => i);
  const rank = new Array<number>(Math.max(total, 1)).fill(0);

  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a); const rb = find(b);
    if (ra === rb) return;
    if (rank[ra]! < rank[rb]!) parent[ra] = rb;
    else if (rank[ra]! > rank[rb]!) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]!++; }
  }

  for (let i = 0; i < subcircuit.wires.length; i++) {
    union(wireStartIds[i]!, wireEndIds[i]!);
  }

  for (const el of subcircuit.elements) {
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const pinId = getOrCreate(wp);
      while (parent.length <= pinId) { parent.push(parent.length); rank.push(0); }
    }
  }

  const groundElements = subcircuit.elements.filter(el => el.typeId === "Ground");
  const groundRoots = new Set<number>();
  for (const gnd of groundElements) {
    for (const pin of gnd.getPins()) {
      const wp = pinWorldPosition(gnd, pin);
      const id = pointToId.get(`${wp.x},${wp.y}`);
      if (id !== undefined) groundRoots.add(find(id));
    }
  }

  if (groundRoots.size === 0 && parent.length > 0) {
    const groupCount = new Map<number, number>();
    for (let i = 0; i < parent.length; i++) {
      const r = find(i); groupCount.set(r, (groupCount.get(r) ?? 0) + 1);
    }
    let bestRoot = 0; let bestCount = 0;
    for (const [r, c] of groupCount) {
      if (c > bestCount) { bestCount = c; bestRoot = r; }
    }
    groundRoots.add(bestRoot);
  }

  const rootToNodeId = new Map<number, number>();
  let nextNodeId = 1;
  for (const gr of groundRoots) rootToNodeId.set(gr, 0);
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    if (!rootToNodeId.has(r)) rootToNodeId.set(r, nextNodeId++);
  }

  const wireToNodeId = new Map<Wire, number>();
  for (let i = 0; i < subcircuit.wires.length; i++) {
    const r = find(wireStartIds[i]!);
    wireToNodeId.set(subcircuit.wires[i]!, rootToNodeId.get(r) ?? 0);
  }
  return wireToNodeId;
}

export function expandTransistorModel(
  componentDef: ComponentDefinition,
  outerPinNodeIds: number[],
  modelRegistry: SubcircuitModelRegistry,
  vddNodeId: number,
  gndNodeId: number,
  nextNodeId: () => number,
): TransistorExpansionResult {
  const diagnostics: SolverDiagnostic[] = [];

  // Validate: must have subcircuitModel set on cmos model
  const transistorModelName = componentDef.models?.mnaModels?.cmos?.subcircuitModel;
  if (!transistorModelName) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Component "${componentDef.name}" has simulationModel 'transistor' but no subcircuitModel defined`,
        {
          explanation:
            `The component "${componentDef.name}" is configured for transistor-level simulation ` +
            `but its ComponentDefinition has no models.mnaModels.cmos.subcircuitModel field. ` +
            `Set models.mnaModels.cmos.subcircuitModel to the name of a registered transistor model subcircuit.`,
          suggestions: [
            {
              text: `Add mnaModels: { cmos: { subcircuitModel: 'CmosXxx' } } to the ComponentDefinition for "${componentDef.name}".`,
              automatable: false,
            },
          ],
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  // Look up the subcircuit in the registry
  const subcircuit = modelRegistry.get(transistorModelName);
  if (!subcircuit) {
    diagnostics.push(
      makeDiagnostic(
        "missing-transistor-model",
        "error",
        `Transistor model subcircuit "${transistorModelName}" is not registered`,
        {
          explanation:
            `Component "${componentDef.name}" references transistor model ` +
            `"${transistorModelName}" which has not been registered ` +
            `in the SubcircuitModelRegistry. Call registerBuiltinSubcircuitModels() before compiling.`,
        },
      ),
    );
    return { elements: [], internalNodeCount: 0, diagnostics };
  }

  // Build wire-to-nodeId mapping for the subcircuit
  const subWireToNodeId = buildWireToNodeId(subcircuit);

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
          `Transistor model "${transistorModelName}" contains non-analog component "${el.typeId}"`,
          {
            explanation:
              `The transistor model subcircuit "${transistorModelName}" contains ` +
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
    const analogEl: AnalogElement = Object.assign(core, { pinNodeIds: remappedNodes, allNodeIds: remappedNodes });
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
