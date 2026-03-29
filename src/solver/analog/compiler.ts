/**
 * Analog circuit compiler.
 *
 * Transforms a visual `Circuit` containing analog components into a
 * `ConcreteCompiledAnalogCircuit` that the MNA engine can simulate.
 *
 * Steps:
 *  1. Build node map (wire groups → MNA node IDs, ground = 0)
 *  2. Resolve subcircuit-backed models into MnaModel factories
 *  3. Assign sequential branch indices using branchCount
 *  4. Allocate internal nodes via getInternalNodeCount
 *  5. Resolve pin→node bindings for each element
 *  6. Call factory for each element
 *  7. Topology validation (floating nodes, voltage-source loops, inductor loops)
 *  8. Return ConcreteCompiledAnalogCircuit
 */

import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { ComponentRegistry } from "../../core/registry.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import { pinWorldPosition, PinDirection } from "../../core/pin.js";
import type { PinDeclaration, ResolvedPin } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import { makeDiagnostic } from "./diagnostics.js";
import { SubcircuitModelRegistry } from "./subcircuit-model-registry.js";
import { getAnalogFactory } from "./transistor-expansion.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  ConcreteCompiledAnalogCircuit,
  type DeviceModel,
} from "./compiled-analog-circuit.js";
import { ModelLibrary, registerDefaultNamedModels, validateModel } from "./model-library.js";
import { defaultLogicFamily, getLogicFamilyPreset } from "../../core/logic-family.js";
import { resolvePinElectrical } from "../../core/pin-electrical.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import type { SubcircuitHost } from "../digital/flatten.js";
import type { CrossEngineBoundary } from "../digital/cross-engine-boundary.js";
import type { BridgeInstance } from "./bridge-instance.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter, BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";
import type { CompiledCircuitImpl } from "../digital/compiled-circuit.js";
import type { LogicFamilyConfig } from "../../core/logic-family.js";
import type { SolverPartition, PartitionedComponent, DigitalCompilerFn, ComponentDefinition, MnaModel, DigitalModel } from "../../compile/types.js";

function compileInnerDigitalCircuit(circuit: Circuit, registry: ComponentRegistry, digitalCompiler: DigitalCompilerFn): CompiledCircuitImpl {
  return digitalCompiler(circuit, registry) as CompiledCircuitImpl;
}

// ---------------------------------------------------------------------------
// Component routing — shared decision logic for Pass A and Pass B
// ---------------------------------------------------------------------------

type ComponentRoute =
  | { kind: 'stamp';  model: MnaModel }
  | { kind: 'bridge' }
  | { kind: 'skip' };

function resolveComponentRoute(
  def: ComponentDefinition,
  pc: PartitionedComponent,
  digitalPinLoading: "cross-domain" | "all" | "none",
): ComponentRoute {
  const hasMnaModels = def.models?.mnaModels !== undefined
    && Object.keys(def.models.mnaModels).length > 0;

  if (pc.model === null) return { kind: 'skip' };

  const isDigitalModel = 'executeFn' in pc.model;

  if (isDigitalModel) {
    if (digitalPinLoading === "all" && hasMnaModels) {
      return { kind: 'bridge' };
    }
    return { kind: 'skip' };
  }

  const mnaModel = pc.model as MnaModel;
  return { kind: 'stamp', model: mnaModel };
}

// ---------------------------------------------------------------------------
// Subcircuit model resolution — post-partition step (W4.1)
// ---------------------------------------------------------------------------

/**
 * Resolve subcircuit-backed models into MnaModel factories.
 *
 * For each PartitionedComponent whose active model key appears in
 * `subcircuitRefs` or `subcircuitBindings`, look up the MnaSubcircuitNetlist
 * and compile it into an MnaModel with a composite factory. Replaces
 * `pc.model` in-place so the main compiler loop only sees stamp/bridge/skip.
 */
function resolveSubcircuitModels(
  partition: SolverPartition,
  subcircuitModels: SubcircuitModelRegistry | undefined,
  modelLibrary: ModelLibrary,
  subcircuitBindings: Record<string, string>,
  modelDefinitions: Record<string, MnaSubcircuitNetlist>,
  diagnostics: import("../../core/analog-engine-interface.js").SolverDiagnostic[],
): void {
  for (const pc of partition.components) {
    const def = pc.definition;
    const defName = subcircuitBindings[`${def.name}:${pc.modelKey}`]
      ?? def.subcircuitRefs?.[pc.modelKey];
    if (!defName) continue;

    const netlist = modelDefinitions[defName]
      ?? subcircuitModels?.get(defName);
    if (!netlist) {
      diagnostics.push(
        makeDiagnostic(
          "unresolved-model-ref",
          "error",
          `Subcircuit definition "${defName}" not found for component "${def.name}" model key "${pc.modelKey}"`,
          {
            explanation:
              `Component "${def.name}" references subcircuit definition "${defName}" ` +
              `via subcircuitRefs or subcircuitBindings, but no MnaSubcircuitNetlist ` +
              `with that name was found in modelDefinitions or the SubcircuitModelRegistry.`,
          },
        ),
      );
      pc.model = null;
      continue;
    }

    pc.model = compileSubcircuitToMnaModel(netlist, modelLibrary, pc);
  }
}

/**
 * Compile an MnaSubcircuitNetlist into an MnaModel with a composite factory.
 *
 * The factory returns a single AnalogElementCore that internally aggregates
 * stamps from all sub-elements. The compiler treats it like any other single
 * element.
 */
function compileSubcircuitToMnaModel(
  netlist: MnaSubcircuitNetlist,
  modelLibrary: ModelLibrary,
  _pc: PartitionedComponent,
): MnaModel {
  let totalBranches = 0;
  for (const subEl of netlist.elements) {
    totalBranches += subEl.branchCount ?? 0;
  }

  return {
    factory(
      pinNodes: ReadonlyMap<string, number>,
      internalNodeIds: readonly number[],
      branchIdx: number,
      _props: PropertyBag,
      getTime: () => number,
    ): import("../../core/analog-types.js").AnalogElementCore {
      const portLabelToNode = new Map<string, number>();
      for (const [label, nodeId] of pinNodes) {
        portLabelToNode.set(label, nodeId);
      }

      const netRemap = new Map<number, number>();
      for (let portIdx = 0; portIdx < netlist.ports.length; portIdx++) {
        const portLabel = netlist.ports[portIdx];
        const outerNode = portLabelToNode.get(portLabel);
        if (outerNode !== undefined) {
          netRemap.set(portIdx, outerNode);
        }
      }

      const internalBase = netlist.ports.length;
      for (let i = 0; i < netlist.internalNetCount; i++) {
        if (i < internalNodeIds.length) {
          netRemap.set(internalBase + i, internalNodeIds[i]);
        }
      }

      function remapNet(netIdx: number): number {
        const mapped = netRemap.get(netIdx);
        if (mapped !== undefined) return mapped;
        return -1;
      }

      const subElements: import("../../core/analog-types.js").AnalogElementCore[] = [];
      let subBranchOffset = 0;

      for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
        const subEl = netlist.elements[elIdx];
        const connectivity = netlist.netlist[elIdx];
        const remappedNodes = connectivity.map(remapNet);

        const factory = getAnalogFactory(subEl.typeId);
        if (!factory) continue;

        const subProps = new PropertyBag();
        if (subEl.params) {
          for (const [k, v] of Object.entries(subEl.params)) {
            if (typeof v === "number") subProps.set(k, v);
          }
        }

        if (subEl.modelRef) {
          const namedModel = modelLibrary.get(subEl.modelRef);
          if (namedModel) {
            subProps.set("_modelParams", namedModel.params as unknown as import("../../core/properties.js").PropertyValue);
          }
        }

        const subBranchIdx = branchIdx >= 0 ? branchIdx + subBranchOffset : -1;
        const core = factory(remappedNodes, subBranchIdx, subProps, getTime);
        if (core.branchIndex >= 0) subBranchOffset++;
        subElements.push(core);
      }

      const anyNonlinear = subElements.some(e => e.isNonlinear);
      const anyReactive = subElements.some(e => e.isReactive);

      const core: import("../../core/analog-types.js").AnalogElementCore = {
        branchIndex: branchIdx >= 0 ? branchIdx : -1,
        isNonlinear: anyNonlinear,
        isReactive: anyReactive,

        stamp(solver: import("../../core/analog-types.js").SparseSolverStamp): void {
          for (const sub of subElements) sub.stamp(solver);
        },

        getPinCurrents(voltages: Float64Array): number[] {
          const currents: number[] = [];
          for (const sub of subElements) {
            if (sub.getPinCurrents) {
              currents.push(...sub.getPinCurrents(voltages));
            }
          }
          return currents;
        },
      };

      if (anyNonlinear) {
        core.stampNonlinear = (solver: import("../../core/analog-types.js").SparseSolverStamp): void => {
          for (const sub of subElements) sub.stampNonlinear?.(solver);
        };
        core.updateOperatingPoint = (voltages: Float64Array): void => {
          for (const sub of subElements) sub.updateOperatingPoint?.(voltages);
        };
      }

      if (anyReactive) {
        core.stampCompanion = (dt: number, method: import("../../core/analog-types.js").IntegrationMethod, voltages: Float64Array): void => {
          for (const sub of subElements) sub.stampCompanion?.(dt, method, voltages);
        };
      }

      return core;
    },

    getInternalNodeCount(_props: PropertyBag): number {
      return netlist.internalNetCount;
    },

    branchCount: totalBranches,
  };
}

// ---------------------------------------------------------------------------
// Pin-to-node resolution helpers
// ---------------------------------------------------------------------------

/**
 * Given a CircuitElement, look up the MNA node IDs for each of its pins by
 * matching pin world positions to wire endpoints in the node map.
 *
 * Returns an array of node IDs in pin order. Pins not connected to any wire
 * receive node ID -1 (unconnected).
 */
/**
 * Resolve each pin of `el` to its MNA node ID by matching pin world positions
 * to wire endpoints (within 0.5-unit tolerance). Unconnected pins
 * receive node ID -1.
 *
 * When `vertexOut` is provided, also records the matched wire vertex position
 * for each pin. The resolver uses these to place current injections at exact
 * wire graph vertices without re-doing spatial matching.
 */
function resolveElementNodes(
  el: CircuitElement,
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
  circuit: Circuit,
  vertexOut?: Array<{ x: number; y: number } | null>,
  positionToNodeId?: Map<string, number>,
): number[] {
  const pins = el.getPins();
  const result: number[] = new Array(pins.length).fill(-1);

  for (let i = 0; i < pins.length; i++) {
    // getPins() returns LOCAL coordinates (rotation/mirror not applied).
    // Use pinWorldPosition() to get the actual world-space position that
    // matches wire endpoints in the circuit.
    const pinPos = pinWorldPosition(el, pins[i]);
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
          if (vertexOut) vertexOut[i] = matchStart ? wire.start : wire.end;
          break;
        }
      }
    }
    // Secondary: look up by position (handles pin-overlap without a wire)
    if (result[i] === -1 && positionToNodeId) {
      const key = `${pinPos.x},${pinPos.y}`;
      const nodeId = positionToNodeId.get(key);
      if (nodeId !== undefined) {
        result[i] = nodeId;
        if (vertexOut) vertexOut[i] = { x: pinPos.x, y: pinPos.y };
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Topology validation
// ---------------------------------------------------------------------------

/**
 * Detect poorly-connected nodes by counting element terminals per node.
 *
 * Returns two lists:
 * - `orphan`: nodes with **zero** element terminals — completely disconnected
 *   from any component. These make the MNA matrix singular (error).
 * - `floating`: nodes with exactly **one** element terminal — no current path.
 *   These make the system ill-conditioned (warning).
 */
function detectWeakNodes(
  elements: Array<{ nodeIds: number[] }>,
  nodeCount: number,
): { orphan: number[]; floating: number[] } {
  // Count how many element terminals touch each node (excluding ground = 0).
  const terminalCount = new Array<number>(nodeCount + 1).fill(0);
  for (const el of elements) {
    for (const n of el.nodeIds) {
      if (n >= 0 && n <= nodeCount) {
        terminalCount[n]++;
      }
    }
  }
  const orphan: number[] = [];
  const floating: number[] = [];
  for (let n = 1; n <= nodeCount; n++) {
    if (terminalCount[n] === 0) {
      orphan.push(n);
    } else if (terminalCount[n] === 1) {
      floating.push(n);
    }
  }
  return { orphan, floating };
}

/**
 * Detect voltage-source loops: cycles consisting only of voltage sources.
 *
 * A loop of ideal voltage sources (with no resistors in between) creates a
 * contradictory constraint system that makes the MNA matrix singular. We
 * detect this by building a graph of voltage-source connections and looking
 * for cycles within that graph.
 */
function detectVoltageSourceLoops(
  elements: Array<{ nodeIds: number[]; isBranch: boolean; typeHint: string }>,
): boolean {
  // Build adjacency for voltage-source-only graph
  const vSources = elements.filter((e) => e.isBranch && e.typeHint === "voltage");
  if (vSources.length < 2) return false;

  // Build adjacency list: node → set of reachable nodes through voltage sources
  const adj = new Map<number, Set<number>>();
  for (const vs of vSources) {
    const [a, b] = vs.nodeIds;
    if (a < 0 || b < 0) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  // DFS cycle detection
  const visited = new Set<number>();
  function hasCycle(node: number, parent: number): boolean {
    visited.add(node);
    const neighbors = adj.get(node) ?? new Set<number>();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, node)) return true;
      } else if (neighbor !== parent) {
        return true;
      }
    }
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (hasCycle(node, -1)) return true;
    }
  }
  return false;
}

/**
 * Detect inductor loops: cycles consisting only of inductors.
 *
 * A loop of ideal inductors creates a singular MNA system (degenerate branch
 * equations) at DC and during transient initialization.
 */
function detectInductorLoops(
  elements: Array<{ nodeIds: number[]; isBranch: boolean; typeHint: string }>,
): boolean {
  const inductors = elements.filter((e) => e.isBranch && e.typeHint === "inductor");
  if (inductors.length < 2) return false;

  const adj = new Map<number, Set<number>>();
  for (const ind of inductors) {
    const [a, b] = ind.nodeIds;
    if (a < 0 || b < 0) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  const visited = new Set<number>();
  function hasCycle(node: number, parent: number): boolean {
    visited.add(node);
    const neighbors = adj.get(node) ?? new Set<number>();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, node)) return true;
      } else if (neighbor !== parent) {
        return true;
      }
    }
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (hasCycle(node, -1)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// buildAnalogNodeMap — internal node-map builder
// ---------------------------------------------------------------------------

/**
 * Build the MNA node map for a circuit using union-find over wire endpoints
 * and component pin world positions.
 *
 * Ground elements are always assigned node 0. All other wire groups receive
 * sequential IDs starting at 1.
 */
function buildAnalogNodeMap(
  circuit: Circuit,
): {
  nodeCount: number;
  diagnostics: SolverDiagnostic[];
  wireToNodeId: Map<Wire, number>;
  labelToNodeId: Map<string, number>;
  positionToNodeId: Map<string, number>;
} {
  const diagnostics: SolverDiagnostic[] = [];
  const { elements, wires } = circuit;

  // Step 1: Collect all unique endpoint positions across all wires
  const pointToId = new Map<string, number>();
  let nextId = 0;

  function getOrCreateId(p: { x: number; y: number }): number {
    const k = `${p.x},${p.y}`;
    let id = pointToId.get(k);
    if (id === undefined) {
      id = nextId++;
      pointToId.set(k, id);
    }
    return id;
  }

  const wireStartIds: number[] = [];
  const wireEndIds: number[] = [];
  for (const wire of wires) {
    wireStartIds.push(getOrCreateId(wire.start));
    wireEndIds.push(getOrCreateId(wire.end));
  }

  // Step 2: Union-find — each wire merges its two endpoints
  const ufSize = Math.max(nextId, 1);
  const ufParent = Array.from({ length: ufSize }, (_, i) => i);
  const ufRank = new Array<number>(ufSize).fill(0);

  function ufFind(i: number): number {
    while (ufParent[i] !== i) {
      ufParent[i] = ufParent[ufParent[i]!]!;
      i = ufParent[i]!;
    }
    return i;
  }

  function ufUnion(a: number, b: number): void {
    const ra = ufFind(a);
    const rb = ufFind(b);
    if (ra === rb) return;
    if (ufRank[ra]! < ufRank[rb]!) { ufParent[ra] = rb; }
    else if (ufRank[ra]! > ufRank[rb]!) { ufParent[rb] = ra; }
    else { ufParent[rb] = ra; ufRank[ra]!++; }
  }

  for (let i = 0; i < wires.length; i++) {
    ufUnion(wireStartIds[i]!, wireEndIds[i]!);
  }

  // Add component pin world positions — grow arrays as needed
  for (const el of elements) {
    const pins = el.getPins();
    for (const pin of pins) {
      const wp = pinWorldPosition(el, pin);
      const pinId = getOrCreateId(wp);
      while (ufParent.length <= pinId) {
        ufParent.push(ufParent.length);
        ufRank.push(0);
      }
    }
  }

  // Step 3: Identify ground group
  const groundElements = elements.filter(el => el.typeId === "Ground");
  const groundRoots = new Set<number>();
  for (const gnd of groundElements) {
    for (const pin of gnd.getPins()) {
      const wp = pinWorldPosition(gnd, pin);
      const id = pointToId.get(`${wp.x},${wp.y}`);
      if (id !== undefined) {
        groundRoots.add(ufFind(id));
      }
    }
  }

  // Step 3b: Merge Tunnel components with the same label
  const tunnelsByLabel = new Map<string, number[]>();
  for (const el of elements) {
    if (el.typeId !== "Tunnel") continue;
    const props = el.getProperties();
    const netName = props.has("NetName") ? String(props.get("NetName")) : "";
    if (netName.length === 0) continue;
    const pins = el.getPins();
    if (pins.length === 0) continue;
    const wp = pinWorldPosition(el, pins[0]!);
    const id = pointToId.get(`${wp.x},${wp.y}`);
    if (id === undefined) continue;
    let slots = tunnelsByLabel.get(netName);
    if (slots === undefined) { slots = []; tunnelsByLabel.set(netName, slots); }
    slots.push(id);
  }
  for (const tunnelIds of tunnelsByLabel.values()) {
    for (let m = 1; m < tunnelIds.length; m++) {
      ufUnion(tunnelIds[0]!, tunnelIds[m]!);
    }
  }

  if (groundRoots.size === 0 && ufParent.length > 0) {
    const groupCount = new Map<number, number>();
    for (let i = 0; i < ufParent.length; i++) {
      const root = ufFind(i);
      groupCount.set(root, (groupCount.get(root) ?? 0) + 1);
    }
    let bestRoot = 0;
    let bestCount = 0;
    for (const [root, count] of groupCount) {
      if (count > bestCount) { bestCount = count; bestRoot = root; }
    }
    groundRoots.add(bestRoot);
    diagnostics.push(
      makeDiagnostic("no-ground", "warning", "No Ground element found in circuit", {
        explanation:
          "MNA simulation requires a ground reference node. " +
          "The most-connected wire group has been assigned as ground (node 0). " +
          "Add a Ground element to suppress this warning.",
        suggestions: [{ text: "Add a Ground element connected to the reference node.", automatable: false }],
      }),
    );
  }

  // Step 4: Assign MNA node IDs
  const rootToNodeId = new Map<number, number>();
  let nextNodeId = 1;
  for (const gr of groundRoots) {
    rootToNodeId.set(gr, 0);
  }
  for (let i = 0; i < ufParent.length; i++) {
    const root = ufFind(i);
    if (!rootToNodeId.has(root)) {
      rootToNodeId.set(root, nextNodeId++);
    }
  }
  const nodeCount = nextNodeId - 1;

  // Step 5: Build wireToNodeId
  const wireToNodeId = new Map<Wire, number>();
  for (let i = 0; i < wires.length; i++) {
    const root = ufFind(wireStartIds[i]!);
    wireToNodeId.set(wires[i]!, rootToNodeId.get(root) ?? 0);
  }

  // Step 6: Build labelToNodeId
  const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe", "Port"]);
  const labelToNodeId = new Map<string, number>();
  for (const el of elements) {
    let label: string | undefined;
    const props = el.getProperties();
    if (props.has("label")) { label = String(props.get("label")); }
    if (!label) continue;
    if (!labelTypes.has(el.typeId)) continue;
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const id = pointToId.get(`${wp.x},${wp.y}`);
      if (id !== undefined) {
        const root = ufFind(id);
        labelToNodeId.set(label, rootToNodeId.get(root) ?? 0);
        break;
      }
    }
  }

  // Step 7: Build positionToNodeId
  const positionToNodeId = new Map<string, number>();
  for (const [key, id] of pointToId) {
    const root = ufFind(id);
    positionToNodeId.set(key, rootToNodeId.get(root) ?? 0);
  }

  return { nodeCount, diagnostics, wireToNodeId, labelToNodeId, positionToNodeId };
}

// ---------------------------------------------------------------------------
// Pipeline stage helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the circuit's logic family from its metadata.
 *
 * Checks `metadata.logicFamily` first (direct object), then
 * `metadata.logicFamilyKey` (string preset key), then falls back to the
 * default logic family.
 */
function resolveLogicFamily(
  circuit: Circuit,
): import("../../core/logic-family.js").LogicFamilyConfig {
  return circuit.metadata.logicFamily
    ? circuit.metadata.logicFamily
    : (circuit.metadata as Record<string, unknown>)["logicFamilyKey"] !== undefined
      ? (getLogicFamilyPreset((circuit.metadata as Record<string, unknown>)["logicFamilyKey"] as string) ?? defaultLogicFamily())
      : defaultLogicFamily();
}

function populateModelLibrary(
  modelLibrary: ModelLibrary,
  metadataSource: Record<string, unknown>,
): void {
  const namedParameterSets = metadataSource["namedParameterSets"];
  if (
    namedParameterSets !== null &&
    typeof namedParameterSets === 'object' &&
    !Array.isArray(namedParameterSets)
  ) {
    const sets = namedParameterSets as Record<string, { deviceType: string; params: Record<string, number> }>;
    for (const [name, entry] of Object.entries(sets)) {
      modelLibrary.add({
        name,
        type: entry.deviceType as import("../../core/analog-types.js").DeviceType,
        level: 1,
        params: entry.params,
      });
    }
  }
}

/** Per-element metadata produced by Pass A for `compileAnalogPartition`. */
type PartitionElementMeta = {
  pc: PartitionedComponent;
  branchIdx: number;
  internalNodeOffset: number;
  internalNodeCount: number;
};

/** Result returned by `runPassA_partition`. */
type PassAPartitionResult = {
  elementMeta: PartitionElementMeta[];
  branchCount: number;
  nextInternalNode: number;
};

/**
 * Pass A for `compileAnalogPartition`: iterate over partition components and
 * assign branch indices and internal node IDs.
 *
 * Operates on `PartitionedComponent` entries (which already carry a resolved
 * `ComponentDefinition`) rather than raw `CircuitElement` entries.
 */
function runPassA_partition(
  partition: SolverPartition,
  crossEnginePlaceholderIds: Set<string>,
  externalNodeCount: number,
  diagnostics: SolverDiagnostic[],
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
): PassAPartitionResult {
  let nextInternalNode = externalNodeCount + 1;
  let branchCount = 0;
  const elementMeta: PartitionElementMeta[] = [];

  for (const pc of partition.components) {
    const el = pc.element;

    if (crossEnginePlaceholderIds.has(el.instanceId)) continue;

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
      continue;
    }

    const def = pc.definition;
    const route = resolveComponentRoute(def, pc, digitalPinLoading);

    switch (route.kind) {
      case 'skip': {
        elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
        continue;
      }
      case 'bridge':
        elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
        continue;
      case 'stamp': {
        const modelBranchCount = route.model.branchCount ?? 0;
        const branchIdx = modelBranchCount > 0 ? branchCount : -1;
        branchCount += modelBranchCount;
        const props = el.getProperties();
        const internalCount = route.model.getInternalNodeCount?.(props) ?? 0;
        const internalNodeOffset = internalCount > 0 ? nextInternalNode : -1;
        nextInternalNode += internalCount;
        elementMeta.push({ pc, branchIdx, internalNodeOffset, internalNodeCount: internalCount });
        continue;
      }
    }
  }

  return { elementMeta, branchCount, nextInternalNode };
}

/**
 * Run topology validation on the assembled element list and append any
 * resulting diagnostics.
 *
 * Checks for:
 *  - Orphan nodes (zero element terminals → singular MNA matrix)
 *  - Floating nodes (one element terminal → ill-conditioned system)
 *  - Voltage-source loops (contradictory KVL constraints)
 *  - Inductor loops (degenerate branch equations)
 */
function validateTopologyAndEmitDiagnostics(
  topologyInfo: Array<{ nodeIds: number[]; isBranch: boolean; typeHint: string }>,
  totalNodeCount: number,
  diagnostics: SolverDiagnostic[],
): void {
  if (totalNodeCount > 0) {
    const weakNodes = detectWeakNodes(topologyInfo, totalNodeCount);

    for (const nodeId of weakNodes.orphan) {
      diagnostics.push(
        makeDiagnostic(
          "orphan-node",
          "error",
          `Node ${nodeId} is orphan (no element terminals connected)`,
          {
            explanation:
              `MNA node ${nodeId} has no element terminals connected to it. ` +
              `This typically results from a degenerate wire (zero-length or ` +
              `disconnected from all components). The orphan node creates a ` +
              `zero row in the MNA matrix, making it singular.`,
            involvedNodes: [nodeId],
            suggestions: [
              {
                text: "Remove the disconnected wire or wire fragment at this location.",
                automatable: false,
              },
            ],
          },
        ),
      );
    }

    for (const nodeId of weakNodes.floating) {
      diagnostics.push(
        makeDiagnostic(
          "floating-node",
          "warning",
          `Node ${nodeId} is floating (connected to only one element terminal)`,
          {
            explanation:
              `MNA node ${nodeId} has only one element terminal connected to it. ` +
              `A floating node has no complete current path, which makes the ` +
              `MNA system ill-conditioned or unsolvable.`,
            involvedNodes: [nodeId],
            suggestions: [
              {
                text: "Add a large resistor (e.g. 1 GΩ) from this node to ground to provide a DC path.",
                automatable: false,
              },
            ],
          },
        ),
      );
    }
  }

  if (detectVoltageSourceLoops(topologyInfo)) {
    diagnostics.push(
      makeDiagnostic(
        "voltage-source-loop",
        "error",
        "Voltage source loop detected — two or more voltage sources form a loop with no resistance",
        {
          explanation:
            "A loop of ideal voltage sources with no resistive elements creates " +
            "contradictory KVL constraints. The MNA matrix will be singular and " +
            "cannot be solved. Add a series resistance to break the loop.",
          suggestions: [
            {
              text: "Add a small series resistance (e.g. 1 mΩ) to one of the voltage source branches.",
              automatable: false,
            },
          ],
        },
      ),
    );
  }

  if (detectInductorLoops(topologyInfo)) {
    diagnostics.push(
      makeDiagnostic(
        "inductor-loop",
        "error",
        "Inductor loop detected — inductors form a loop with no resistance",
        {
          explanation:
            "A loop of ideal inductors with no resistive elements creates a " +
            "degenerate branch equation system. The MNA matrix will be singular " +
            "at DC and during transient initialization. Add series resistance.",
          suggestions: [
            {
              text: "Add a small series resistance (e.g. 1 mΩ) to one of the inductor branches.",
              automatable: false,
            },
          ],
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// compileAnalogPartition — new partition-based entry point
// ---------------------------------------------------------------------------

/**
 * Build a NodeMap from pre-computed ConnectivityGroup data.
 *
 * Identifies the Ground group by checking whether any PartitionedComponent in
 * the partition is a Ground element whose pin appears in that group.
 * Ground group → node 0; all other groups → sequential from 1.
 */
function buildAnalogNodeMapFromPartition(
  partition: SolverPartition,
  diagnostics: SolverDiagnostic[],
): {
  nodeCount: number;
  groupToNodeId: Map<number, number>;
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>;
  labelToNodeId: Map<string, number>;
  positionToNodeId: Map<string, number>;
} {
  const groups = partition.groups;

  // Identify which groupId contains Ground element pins.
  // A group is the ground group if any component in the partition is a Ground element
  // and its pin's world position appears in that group's pins.
  const groundGroupIds = new Set<number>();
  for (const pc of partition.components) {
    if (pc.element.typeId !== "Ground") continue;
    for (const rp of pc.resolvedPins) {
      // Find the group containing this pin's world position
      for (const g of groups) {
        for (const gp of g.pins) {
          if (
            Math.abs(gp.worldPosition.x - rp.worldPosition.x) < 0.5 &&
            Math.abs(gp.worldPosition.y - rp.worldPosition.y) < 0.5
          ) {
            groundGroupIds.add(g.groupId);
          }
        }
      }
    }
  }

  // If no ground group found, pick the largest group as best-effort ground
  if (groundGroupIds.size === 0 && groups.length > 0) {
    let bestGroupId = groups[0]!.groupId;
    let bestSize = 0;
    for (const g of groups) {
      const size = g.pins.length + g.wires.length;
      if (size > bestSize) {
        bestSize = size;
        bestGroupId = g.groupId;
      }
    }
    groundGroupIds.add(bestGroupId);
    diagnostics.push(
      makeDiagnostic(
        "no-ground",
        "warning",
        "No Ground element found in partition",
        {
          explanation:
            "MNA simulation requires a ground reference node. " +
            "The most-connected wire group has been assigned as ground (node 0). " +
            "Add a Ground element to suppress this warning.",
          suggestions: [
            {
              text: "Add a Ground element connected to the reference node.",
              automatable: false,
            },
          ],
        },
      ),
    );
  }

  // Assign node IDs: ground groups → 0, others → 1, 2, 3, …
  const groupToNodeId = new Map<number, number>();
  let nextNodeId = 1;
  for (const g of groups) {
    if (groundGroupIds.has(g.groupId)) {
      groupToNodeId.set(g.groupId, 0);
    }
  }
  for (const g of groups) {
    if (!groupToNodeId.has(g.groupId)) {
      groupToNodeId.set(g.groupId, nextNodeId++);
    }
  }
  const nodeCount = nextNodeId - 1;

  // Build wireToNodeId
  const wireToNodeId = new Map<import("../../core/circuit.js").Wire, number>();
  for (const g of groups) {
    const nodeId = groupToNodeId.get(g.groupId) ?? 0;
    for (const w of g.wires) {
      wireToNodeId.set(w, nodeId);
    }
  }

  // Build positionToNodeId from all pin world positions in all groups
  const positionToNodeId = new Map<string, number>();
  for (const g of groups) {
    const nodeId = groupToNodeId.get(g.groupId) ?? 0;
    for (const gp of g.pins) {
      const key = `${gp.worldPosition.x},${gp.worldPosition.y}`;
      positionToNodeId.set(key, nodeId);
    }
    // Also include wire start/end positions
    for (const w of g.wires) {
      positionToNodeId.set(`${w.start.x},${w.start.y}`, nodeId);
      positionToNodeId.set(`${w.end.x},${w.end.y}`, nodeId);
    }
  }

  // Build labelToNodeId from all labeled components in the partition
  const labelTypesPartition = new Set(["In", "Out", "Probe", "in", "out", "probe", "Port"]);
  const labelToNodeId = new Map<string, number>();
  for (const pc of partition.components) {
    const props = pc.element.getProperties();
    const label = props.has("label") ? String(props.get("label")) : "";
    if (!label) continue;
    if (!labelTypesPartition.has(pc.element.typeId)) continue;
    // Use the node ID of the first resolved pin
    if (pc.resolvedPins.length > 0) {
      const rp = pc.resolvedPins[0]!;
      const key = `${rp.worldPosition.x},${rp.worldPosition.y}`;
      const nodeId = positionToNodeId.get(key) ?? 0;
      labelToNodeId.set(label, nodeId);
    }
  }

  return { nodeCount, groupToNodeId, wireToNodeId, labelToNodeId, positionToNodeId };
}

/**
 * Compile an analog partition into a `ConcreteCompiledAnalogCircuit`.
 *
 * Accepts a `SolverPartition` (pre-computed by `partitionByDomain`) instead of
 * a raw `Circuit`. Connectivity is pre-computed in the partition's groups.
 * All analog-specific logic (internal node allocation, branch row
 * allocation, MNA matrix sizing, factory invocation, topology validation)
 * is preserved.
 */
export function compileAnalogPartition(
  partition: SolverPartition,
  registry: ComponentRegistry,
  subcircuitModels?: SubcircuitModelRegistry,
  logicFamily?: LogicFamilyConfig,
  outerCircuit?: Circuit,
  digitalCompiler?: DigitalCompilerFn,
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  perNetLoadingOverrides?: ReadonlyMap<number, "loaded" | "ideal">,
): ConcreteCompiledAnalogCircuit {
  const diagnostics: SolverDiagnostic[] = [];

  // Build node map from partition groups
  const {
    nodeCount: externalNodeCount,
    groupToNodeId,
    wireToNodeId,
    labelToNodeId,
    positionToNodeId,
  } = buildAnalogNodeMapFromPartition(partition, diagnostics);

  // Build a reverse map from MNA node ID → per-net loading override so that
  // bridge synthesis sites can consult per-net overrides instead of relying
  // solely on the circuit-level digitalPinLoading setting.
  const nodeIdToLoadingOverride = new Map<number, "loaded" | "ideal">();
  if (perNetLoadingOverrides) {
    for (const [groupId, override] of perNetLoadingOverrides) {
      const nodeId = groupToNodeId.get(groupId);
      if (nodeId !== undefined) {
        nodeIdToLoadingOverride.set(nodeId, override);
      }
    }
  }

  // Use the caller-supplied logic family or fall back to the default.
  const circuitFamily = logicFamily ?? defaultLogicFamily();

  // Stage 2: Build model library from outer circuit metadata (if provided).
  const modelLibrary = new ModelLibrary();
  registerDefaultNamedModels(modelLibrary);
  if (outerCircuit !== undefined) {
    populateModelLibrary(modelLibrary, outerCircuit.metadata as Record<string, unknown>);
  }

  // Build set of cross-engine placeholder elements (from bridgeStubs)
  const crossEnginePlaceholderIds = new Set<string>(
    partition.crossEngineBoundaries.map((b) => (b.subcircuitElement as CircuitElement).instanceId),
  );

  // Stage 2b: Resolve subcircuit-backed models into MnaModel factories.
  const subcircuitBindings: Record<string, string> =
    outerCircuit?.metadata.subcircuitBindings ?? {};
  const modelDefinitions: Record<string, MnaSubcircuitNetlist> =
    outerCircuit?.metadata.modelDefinitions ?? {};
  resolveSubcircuitModels(partition, subcircuitModels, modelLibrary, subcircuitBindings, modelDefinitions, diagnostics);

  // Stage 3 (Pass A): Assign branch indices and allocate internal nodes.
  const passA = runPassA_partition(partition, crossEnginePlaceholderIds, externalNodeCount, diagnostics, digitalPinLoading);

  const elementMeta = passA.elementMeta;
  let branchCount = passA.branchCount;
  let nextInternalNode = passA.nextInternalNode;

  let totalNodeCount = nextInternalNode - 1;

  // Build a minimal circuit-like wire lookup for resolveElementNodes.
  // We need to pass wireToNodeId and a circuit object. We create a minimal
  // stub that provides circuit.wires for pin position matching.
  // resolveElementNodes needs (el, wireToNodeId, circuit, vertexOut?, positionToNodeId?)
  // where circuit is used for circuit.wires iteration.
  // We collect all wires from the partition's groups.
  const allWires = partition.groups.flatMap((g) => g.wires);
  const partitionCircuitStub = { wires: allWires } as import("../../core/circuit.js").Circuit;

  const inlineBridges: BridgeInstance[] = [];
  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();
  const elementBridgeAdapters = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>();

  type ElementTopologyInfo = {
    nodeIds: number[];
    isBranch: boolean;
    typeHint: string;
  };
  const topologyInfo: ElementTopologyInfo[] = [];

  const timeRef = { value: 0 };
  const getTime = (): number => timeRef.value;

  for (const meta of elementMeta) {
    const { pc } = meta;
    const el = pc.element;

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      continue;
    }

    const def = pc.definition;
    const props = el.getProperties();

    const route = resolveComponentRoute(def, pc, digitalPinLoading);

    if (route.kind === 'skip') {
      continue;
    }

    if (route.kind === 'bridge') {
      const outerPinNodeIds = resolveElementNodes(el, wireToNodeId, partitionCircuitStub, undefined, positionToNodeId);

      let hasUnconnectedPin = false;
      for (let pi = 0; pi < outerPinNodeIds.length; pi++) {
        if (outerPinNodeIds[pi]! < 0) {
          hasUnconnectedPin = true;
          const elLabel = props.has("label") ? props.get<string>("label") : el.typeId;
          const pinLabel = def.pinLayout[pi]?.label ?? `pin ${pi}`;
          diagnostics.push(
            makeDiagnostic(
              "unconnected-analog-pin",
              "error",
              `The "${pinLabel}" pin on "${elLabel}" (${el.typeId}) is not connected to any wire`,
              {
                explanation:
                  `Component "${elLabel}" has a pin ("${pinLabel}") that doesn't touch any wire ` +
                  `endpoint in the circuit. The digital bridge path requires all pins to be connected.`,
              },
            ),
          );
        }
      }
      if (hasUnconnectedPin) continue;

      const innerCircuit = synthesizeDigitalCircuit(el, def, registry);
      let compiledInner: CompiledCircuitImpl;
      try {
        compiledInner = compileInnerDigitalCircuit(innerCircuit, registry, digitalCompiler!);
      } catch (err) {
        diagnostics.push(
          makeDiagnostic(
            "bridge-inner-compile-error",
            "error",
            `Failed to compile inner digital circuit for "${el.typeId}": ${String(err)}`,
            {},
          ),
        );
        continue;
      }

      const outputAdapters: BridgeOutputAdapter[] = [];
      const inputAdapters: BridgeInputAdapter[] = [];
      const outputPinNetIds: number[] = [];
      const inputPinNetIds: number[] = [];

      const elLabel = props.has("label") ? props.get<string>("label") : el.typeId;
      let adapterError = false;

      for (let pi = 0; pi < def.pinLayout.length; pi++) {
        const pinDecl = def.pinLayout[pi]!;
        const outerNodeId = outerPinNodeIds[pi]!;
        const innerNetId = compiledInner.labelToNetId.get(pinDecl.label) ?? -1;

        if (innerNetId < 0) {
          diagnostics.push(
            makeDiagnostic(
              "bridge-missing-inner-pin",
              "warning",
              `Digital bridge: inner circuit has no net for pin label "${pinDecl.label}" on "${elLabel}"`,
              {},
            ),
          );
          adapterError = true;
          continue;
        }

        const defPinOverride = def.pinElectricalOverrides?.[pinDecl.label];
        const componentOverride = def.pinElectrical;
        const userBridgeOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
        if (props.has("_pinElectricalOverrides")) {
          const flatOverrides = props.get<Record<string, number>>("_pinElectricalOverrides");
          for (const [compositeKey, val] of Object.entries(flatOverrides)) {
            const dotIdx = compositeKey.indexOf('.');
            if (dotIdx === -1) continue;
            const pinLabel = compositeKey.slice(0, dotIdx);
            const field = compositeKey.slice(dotIdx + 1);
            if (!userBridgeOverrides[pinLabel]) userBridgeOverrides[pinLabel] = {};
            (userBridgeOverrides[pinLabel] as Record<string, number>)[field] = val;
          }
        }
        const userPinOverride = userBridgeOverrides[pinDecl.label];
        const mergedPinOverride = userPinOverride
          ? { ...defPinOverride, ...userPinOverride }
          : defPinOverride;
        // Per-net override takes precedence over circuit-level digitalPinLoading.
        const netOverride = nodeIdToLoadingOverride.get(outerNodeId);
        const useIdeal = netOverride === "ideal" || (netOverride === undefined && digitalPinLoading === "none");
        const spec = useIdeal
          ? resolvePinElectrical(circuitFamily, { rIn: Infinity, rOut: 0, ...mergedPinOverride }, componentOverride)
          : resolvePinElectrical(circuitFamily, mergedPinOverride, componentOverride);

        if (pinDecl.direction === PinDirection.OUTPUT) {
          const adapter = makeBridgeOutputAdapter(spec, outerNodeId);
          adapter.label = `${elLabel}:${pinDecl.label}`;
          outputAdapters.push(adapter);
          outputPinNetIds.push(innerNetId);
          const adapterIdx = analogElements.length;
          if (!elementToCircuitElement.has(adapterIdx)) elementToCircuitElement.set(adapterIdx, el);
          const adapterList = elementBridgeAdapters.get(adapterIdx) ?? [];
          adapterList.push(adapter);
          elementBridgeAdapters.set(adapterIdx, adapterList);
          analogElements.push(adapter);
          topologyInfo.push({ nodeIds: Array.from(adapter.pinNodeIds), isBranch: false, typeHint: "other" });
        } else {
          const adapter = makeBridgeInputAdapter(spec, outerNodeId);
          adapter.label = `${elLabel}:${pinDecl.label}`;
          inputAdapters.push(adapter);
          inputPinNetIds.push(innerNetId);
          const adapterIdx = analogElements.length;
          if (!elementToCircuitElement.has(adapterIdx)) elementToCircuitElement.set(adapterIdx, el);
          const adapterList = elementBridgeAdapters.get(adapterIdx) ?? [];
          adapterList.push(adapter);
          elementBridgeAdapters.set(adapterIdx, adapterList);
          analogElements.push(adapter);
          topologyInfo.push({ nodeIds: Array.from(adapter.pinNodeIds), isBranch: false, typeHint: "other" });
        }
      }

      if (!adapterError && (outputAdapters.length > 0 || inputAdapters.length > 0)) {
        inlineBridges.push({
          compiledInner,
          outputAdapters,
          inputAdapters,
          outputPinNetIds,
          inputPinNetIds,
          instanceName: typeof elLabel === "string" ? elLabel : el.instanceId,
        });
      }
      continue;
    }

    // route.kind === 'stamp'
    const activeModel = route.model;

    // Resolve pin → node ID bindings
    const livePins = el.getPins();
    const pinVertices: Array<{ x: number; y: number } | null> = new Array(
      livePins.length,
    ).fill(null);
    const pinNodeIds = resolveElementNodes(el, wireToNodeId, partitionCircuitStub, pinVertices, positionToNodeId);

    const pinLabelList = livePins.map((p) => p.label);
    let hasUnconnectedPin = false;
    for (let pi = 0; pi < pinNodeIds.length; pi++) {
      if (pinNodeIds[pi] < 0) {
        hasUnconnectedPin = true;
        const label = el.getProperties().has("label")
          ? el.getProperties().get<string>("label")
          : el.typeId;
        const pinLabel = pinLabelList[pi] ?? `pin ${pi}`;
        diagnostics.push(
          makeDiagnostic(
            "unconnected-analog-pin",
            "warning",
            `The "${pinLabel}" pin on "${label}" (${el.typeId}) is not connected — component excluded from simulation`,
            {
              explanation:
                `Component "${label}" has a pin ("${pinLabel}") that doesn't touch any wire ` +
                `endpoint in the circuit. The component has been excluded from the analog simulation.`,
              suggestions: [
                {
                  text: `Check the wiring around "${label}" — make sure each pin endpoint sits exactly on a wire.`,
                  automatable: false,
                },
              ],
            },
          ),
        );
      }
    }

    if (hasUnconnectedPin) {
      continue;
    }

    const pinNodes = new Map<string, number>();
    for (let pi = 0; pi < pinNodeIds.length; pi++) {
      const lbl = pinLabelList[pi];
      if (lbl !== undefined) {
        pinNodes.set(lbl, pinNodeIds[pi]);
      }
    }

    const internalNodeIds: number[] = [];
    if (meta.internalNodeCount > 0) {
      for (let i = 0; i < meta.internalNodeCount; i++) {
        internalNodeIds.push(meta.internalNodeOffset + i);
      }
    }

    const absoluteBranchIdx =
      meta.branchIdx >= 0 ? totalNodeCount + meta.branchIdx : -1;

    if (def.models?.digital !== undefined && activeModel.factory !== undefined) {
      const flatOverrides: Record<string, number> = props.has("_pinElectricalOverrides")
        ? props.get<Record<string, number>>("_pinElectricalOverrides")
        : {};
      // Build per-pin overrides from flat composite keys (e.g. "A.rOut" → { A: { rOut: ... } })
      const userOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
      for (const [compositeKey, val] of Object.entries(flatOverrides)) {
        const dotIdx = compositeKey.indexOf('.');
        if (dotIdx === -1) continue;
        const pinLabel = compositeKey.slice(0, dotIdx);
        const field = compositeKey.slice(dotIdx + 1);
        if (!userOverrides[pinLabel]) userOverrides[pinLabel] = {};
        (userOverrides[pinLabel] as Record<string, number>)[field] = val;
      }

      const pinLabelsForElec = def.pinLayout.map((pd) => pd.label);
      const pinElectricalMap: Record<string, ResolvedPinElectrical> = {};
      for (const pinLabel of pinLabelsForElec) {
        const defPinOverride = def.pinElectricalOverrides?.[pinLabel];
        const componentOverride = def.pinElectrical;
        const userPinOverride = userOverrides[pinLabel];
        const mergedPinOverride = userPinOverride
          ? { ...defPinOverride, ...userPinOverride }
          : defPinOverride;
        pinElectricalMap[pinLabel] = resolvePinElectrical(
          circuitFamily,
          mergedPinOverride,
          componentOverride,
        );
      }
      props.set("_pinElectrical", pinElectricalMap as unknown as import("../../core/properties.js").PropertyValue);
    }

    if (activeModel.deviceType !== undefined) {
      const modelName = props.has("model") ? props.get<string>("model") : "";
      const namedModel = modelName !== "" ? modelLibrary.get(modelName) : undefined;
      const resolvedModel = namedModel ?? modelLibrary.getDefault(activeModel.deviceType);

      const modelDiags = validateModel(resolvedModel);
      diagnostics.push(...modelDiags);

      // Resolution order for base params:
      // 1. Component-specific defaultParams (e.g. SCHOTTKY_DEFAULTS)
      // 2. Named model params (user-assigned .MODEL card)
      // 3. Library default for the deviceType (base of resolution chain)
      const baseParams = activeModel.defaultParams
        ?? resolvedModel.params;
      let finalParams = baseParams;
      if (namedModel && activeModel.defaultParams) {
        finalParams = { ...baseParams, ...namedModel.params };
      }
      if (props.has("_spiceModelOverrides")) {
        const overrides = props.get<Record<string, number>>("_spiceModelOverrides");
        finalParams = { ...finalParams, ...overrides };
      }
      props.set("_modelParams", finalParams as unknown as import("../../core/properties.js").PropertyValue);
    }

    const analogFactory = activeModel.factory;
    if (!analogFactory) continue;
    const core = analogFactory(pinNodes, internalNodeIds, absoluteBranchIdx, props, getTime);
    const element: import("./element.js").AnalogElement = Object.assign(core, {
      pinNodeIds: pinNodeIds,
      allNodeIds: [...pinNodeIds, ...internalNodeIds],
    });

    const elementIndex = analogElements.length;
    analogElements.push(element);
    elementToCircuitElement.set(elementIndex, el);
    elementPinVertices.set(elementIndex, pinVertices);

    {
      const resolvedPinsOut: ResolvedPin[] = [];
      const elPins = el.getPins();
      for (let pi = 0; pi < elPins.length; pi++) {
        const pin = elPins[pi];
        if (!pin) continue;
        const decl = def.pinLayout[pi];
        resolvedPinsOut.push({
          label: pin.label,
          direction: decl?.direction ?? pin.direction,
          localPosition: pin.position,
          worldPosition: pinWorldPosition(el, pin),
          wireVertex: pinVertices[pi] ?? null,
          nodeId: pinNodeIds[pi],
          bitWidth: pin.bitWidth,
        });
      }
      elementResolvedPins.set(elementIndex, resolvedPinsOut);
    }

    topologyInfo.push({
      nodeIds: [...pinNodeIds, ...internalNodeIds],
      isBranch: meta.branchIdx >= 0,
      typeHint: meta.branchIdx >= 0
        ? element.isReactive
          ? "inductor"
          : "voltage"
        : "other",
    });
  }

  totalNodeCount = nextInternalNode - 1;

  // Topology validation — orphan/floating nodes, source loops.
  validateTopologyAndEmitDiagnostics(topologyInfo, totalNodeCount, diagnostics);

  // Check for ground.
  const hasGround = partition.components.some((pc) => pc.element.typeId === "Ground");
  if (!hasGround) {
    const alreadyHasGroundDiag = diagnostics.some((d) => d.code === "no-ground");
    if (!alreadyHasGroundDiag) {
      diagnostics.push(
        makeDiagnostic(
          "no-ground",
          "warning",
          "No Ground element found in partition",
          {
            explanation:
              "MNA simulation requires a ground reference node (node 0). " +
              "Without a Ground element the simulator cannot establish a voltage reference.",
            suggestions: [
              {
                text: "Add a Ground element connected to the reference node.",
                automatable: false,
              },
            ],
          },
        ),
      );
    }
  }

  // Stage 8: Process cross-engine boundaries into BridgeInstances when an outer
  // circuit is provided (supplies wire-endpoint geometry for node resolution).
  const bridges: BridgeInstance[] = [...inlineBridges];
  if (outerCircuit !== undefined) {
    for (const boundary of partition.crossEngineBoundaries) {
      const bridgeInstance = compileBridgeInstance(
        boundary,
        wireToNodeId,
        outerCircuit,
        totalNodeCount,
        circuitFamily,
        registry,
        diagnostics,
        digitalCompiler!,
        digitalPinLoading,
        nodeIdToLoadingOverride,
      );
      if (bridgeInstance !== null) {
        for (const adapter of bridgeInstance.outputAdapters) {
          analogElements.push(adapter);
        }
        for (const adapter of bridgeInstance.inputAdapters) {
          analogElements.push(adapter);
        }
        bridges.push(bridgeInstance);
      }
    }
  }

  // Build and return ConcreteCompiledAnalogCircuit
  const models = new Map<string, DeviceModel>();

  return new ConcreteCompiledAnalogCircuit({
    nodeCount: totalNodeCount,
    branchCount,
    elements: analogElements,
    labelToNodeId,
    wireToNodeId,
    models,
    elementToCircuitElement,
    elementPinVertices,
    elementResolvedPins,
    groupToNodeId,
    elementBridgeAdapters,
    diagnostics,
    bridges,
    timeRef,
  });
}

// ---------------------------------------------------------------------------
// Bridge instance compilation helpers
// ---------------------------------------------------------------------------

/**
 * Scan the outer circuit for elements connected to `targetNodeId` and return
 * the highest resistance property found among driving elements.
 *
 * Checks each CircuitElement in the outer circuit: if any of its pins are
 * wired to `targetNodeId`, the element's "resistance" property (or "R") is
 * read. Returns the maximum resistance found, or null if no resistive element
 * is found on the node.
 *
 * This is a heuristic check — it only detects simple resistor elements with
 * a "resistance" or "R" property. More complex impedances (e.g., op-amps,
 * current sources) are not detected.
 */
function detectHighSourceImpedance(
  targetNodeId: number,
  outerCircuit: Circuit,
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
  registry: ComponentRegistry,
): number | null {
  let maxResistance: number | null = null;

  for (const el of outerCircuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;

    // Only inspect elements with MNA models
    if (!def.models?.mnaModels || Object.keys(def.models.mnaModels).length === 0) continue;

    // Check if any pin of this element is connected to targetNodeId
    const nodeIds = resolveElementNodes(el, wireToNodeId, outerCircuit);
    if (!nodeIds.includes(targetNodeId)) continue;

    // Try to read a resistance property from the element using safe access
    const props = el.getProperties();
    let rRaw = 0;
    if (props.has("resistance")) rRaw = props.getOrDefault<number>("resistance", 0);
    else if (props.has("R")) rRaw = props.getOrDefault<number>("R", 0);
    else if (props.has("Resistance")) rRaw = props.getOrDefault<number>("Resistance", 0);
    if (typeof rRaw === "number" && rRaw > 0) {
      if (maxResistance === null || rRaw > maxResistance) {
        maxResistance = rRaw;
      }
    }
  }

  return maxResistance;
}

// ---------------------------------------------------------------------------
// Bridge instance compilation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// synthesizeDigitalCircuit
// ---------------------------------------------------------------------------

/**
 * Synthesize a minimal digital circuit from a single "both" component.
 *
 * Creates a Circuit containing:
 *   - One instance of the component (same type and props, minus simulationModel
 *     and _pinElectrical)
 *   - One In element per input pin, labeled to match the component's pin label
 *   - One Out element per output pin, labeled to match the component's pin label
 *   - Wires connecting each In/Out to the component's pins
 *
 * The resulting circuit can be compiled by the digital compiler and used as
 * the inner circuit of a BridgeInstance. The digital compiler's labelToNetId
 * uses the label property of In/Out elements — so by setting each In/Out
 * element's label to the matching pin label we get a direct lookup:
 *   compiledInner.labelToNetId.get(pinLabel) → inner net ID
 *
 * Layout:
 *   Inputs:    x = 0,   y = 0, 10, 20, …  (one per input pin)
 *   Component: x = 200, y = 0
 *   Outputs:   x = 400, y = 0, 10, 20, …  (one per output pin)
 *
 * Pin positions on InElement are (0,0) LOCAL — the world position equals the
 * element position because rotation=0, mirror=false.
 * Pin positions on OutElement are (0,0) LOCAL — same reasoning.
 * Component pins are accessed via getPins() which returns LOCAL coordinates;
 * world = element.position + pin.position (rotation=0).
 */
function synthesizeDigitalCircuit(
  el: CircuitElement,
  def: import("../../core/registry.js").ComponentDefinition,
  registry: ComponentRegistry,
): Circuit {
  const inner = new Circuit({ name: el.typeId });

  // Build stripped props: copy all properties except analog-compiler concerns.
  const srcProps = el.getProperties();
  const innerProps = new PropertyBag();
  for (const [key, val] of srcProps.entries()) {
    if (key === "simulationModel" || key === "_pinElectrical") continue;
    innerProps.set(key, val);
  }

  // Place the component at the centre column (x=200, y=0, rotation=0).
  const compDef = registry.get(el.typeId)!;
  const compEl = compDef.factory(innerProps);
  compEl.position = { x: 200, y: 0 };
  // Assert rotation=0 — this is the one place where raw position + pin.position
  // is valid because we control the element's transform. A non-zero rotation
  // would make compPinWorld = element.position + pin.position incorrect.
  if (compEl.rotation !== 0) {
    throw new Error('synthesizeDigitalCircuit: component must have rotation=0');
  }
  inner.addElement(compEl);

  // Determine pin world positions for the newly-placed component.
  const compPins = compEl.getPins();

  let inputRow = 0;
  let outputRow = 0;

  for (let pi = 0; pi < def.pinLayout.length; pi++) {
    const pinDecl: PinDeclaration = def.pinLayout[pi]!;
    const compPin = compPins[pi];
    if (!compPin) continue;

    // World position of this component pin (element at x=200, y=0, rotation=0).
    const compPinWorld = pinWorldPosition(compEl, compPin);

    if (pinDecl.direction === PinDirection.INPUT || pinDecl.direction === PinDirection.BIDIRECTIONAL) {
      // Create an In element at (0, inputRow*10) with label matching the pin label.
      const inDef = registry.get("In");
      if (!inDef) continue;
      const inProps = new PropertyBag();
      inProps.set("label", pinDecl.label);
      inProps.set("bitWidth", compPin.bitWidth);
      const inEl = inDef.factory(inProps);
      inEl.position = { x: 0, y: inputRow * 10 };
      inner.addElement(inEl);

      // InElement output pin is at (0,0) LOCAL → world = element.position.
      const inPinWorld = { x: 0, y: inputRow * 10 };
      inner.addWire(new Wire(inPinWorld, compPinWorld));
      inputRow++;
    } else {
      // Create an Out element at (400, outputRow*10) with label matching the pin label.
      const outDef = registry.get("Out");
      if (!outDef) continue;
      const outProps = new PropertyBag();
      outProps.set("label", pinDecl.label);
      outProps.set("bitWidth", compPin.bitWidth);
      const outEl = outDef.factory(outProps);
      outEl.position = { x: 400, y: outputRow * 10 };
      inner.addElement(outEl);

      // OutElement input pin is at (0,0) LOCAL → world = element.position.
      const outPinWorld = { x: 400, y: outputRow * 10 };
      inner.addWire(new Wire(compPinWorld, outPinWorld));
      outputRow++;
    }
  }

  return inner;
}

/**
 * Compile one CrossEngineBoundary into a BridgeInstance.
 *
 * Steps:
 *   1. Compile the inner circuit with the digital compiler.
 *   2. For each BoundaryPinMapping, resolve the outer MNA node ID by matching
 *      the subcircuit element's pin position to wires in the outer circuit.
 *   3. Create BridgeOutputAdapter (for 'out' pins) or BridgeInputAdapter
 *      (for 'in' pins) using the resolved electrical spec.
 *   4. Map each adapter to its corresponding net ID in the inner compiled circuit.
 *
 * Returns null and emits diagnostics when compilation fails.
 */
function compileBridgeInstance(
  boundary: CrossEngineBoundary,
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
  outerCircuit: Circuit,
  _totalNodeCount: number,
  circuitFamily: LogicFamilyConfig,
  registry: ComponentRegistry,
  diagnostics: SolverDiagnostic[],
  digitalCompiler: DigitalCompilerFn,
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  nodeIdToLoadingOverride: ReadonlyMap<number, "loaded" | "ideal"> = new Map(),
): BridgeInstance | null {
  // Step 1: Compile the inner digital circuit.
  let compiledInner: CompiledCircuitImpl;
  try {
    compiledInner = compileInnerDigitalCircuit(boundary.internalCircuit, registry, digitalCompiler);
  } catch (err) {
    diagnostics.push(
      makeDiagnostic(
        "bridge-inner-compile-error",
        "error",
        `Failed to compile inner circuit for bridge "${boundary.instanceName}": ${String(err)}`,
        {},
      ),
    );
    return null;
  }

  const outputAdapters: BridgeOutputAdapter[] = [];
  const inputAdapters: BridgeInputAdapter[] = [];
  const outputPinNetIds: number[] = [];
  const inputPinNetIds: number[] = [];

  // Step 2 & 3: For each pin mapping, resolve the outer node ID and create
  //             the appropriate bridge adapter.
  for (const mapping of boundary.pinMappings) {
    // Resolve the outer MNA node ID for this pin by matching the subcircuit
    // element's pin position to wires in the outer circuit.
    const outerNodeId = resolveSubcircuitPinNode(
      boundary.subcircuitElement,
      mapping.pinLabel,
      wireToNodeId,
      outerCircuit,
    );

    if (outerNodeId < 0) {
      // Pin not connected to any wire in the outer circuit — skip with diagnostic.
      diagnostics.push(
        makeDiagnostic(
          "bridge-unconnected-pin",
          "warning",
          `Bridge pin "${mapping.pinLabel}" on "${boundary.instanceName}" is not connected in the outer circuit`,
          {},
        ),
      );
      continue;
    }

    // Resolve the inner net ID for this pin from the compiled inner circuit.
    const innerNetId = compiledInner.labelToNetId.get(mapping.innerLabel) ?? -1;
    if (innerNetId < 0) {
      diagnostics.push(
        makeDiagnostic(
          "bridge-missing-inner-pin",
          "warning",
          `Bridge: inner circuit "${boundary.instanceName}" has no net for pin label "${mapping.innerLabel}"`,
          {},
        ),
      );
      continue;
    }

    // Resolve the pin electrical spec from the circuit logic family.
    // Per-net override takes precedence over circuit-level digitalPinLoading.
    const netOverride = nodeIdToLoadingOverride.get(outerNodeId);
    const useIdeal = netOverride === "ideal" || (netOverride === undefined && digitalPinLoading === "none");
    const spec = useIdeal
      ? resolvePinElectrical(circuitFamily, { rIn: Infinity, rOut: 0 })
      : resolvePinElectrical(circuitFamily);

    if (mapping.direction === "out") {
      // Digital subcircuit output → drives analog net.
      const adapter = makeBridgeOutputAdapter(spec, outerNodeId);
      adapter.label = `${boundary.instanceName}:${mapping.pinLabel}`;
      outputAdapters.push(adapter);
      outputPinNetIds.push(innerNetId);
    } else {
      // Analog net → feeds digital subcircuit input.
      const adapter = makeBridgeInputAdapter(spec, outerNodeId);
      adapter.label = `${boundary.instanceName}:${mapping.pinLabel}`;
      inputAdapters.push(adapter);
      inputPinNetIds.push(innerNetId);

      // Check for impedance mismatch: if any element driving this node has a
      // source resistance much greater than rIn (threshold: R_source > 100 × rIn),
      // emit an info diagnostic.
      const rIn = spec.rIn;
      const rSourceMismatch = detectHighSourceImpedance(
        outerNodeId,
        outerCircuit,
        wireToNodeId,
        registry,
      );
      if (rSourceMismatch !== null && rSourceMismatch > 100 * rIn) {
        diagnostics.push(
          makeDiagnostic(
            "bridge-impedance-mismatch",
            "info",
            `Bridge input pin "${adapter.label}" source impedance ${rSourceMismatch.toExponential(2)}Ω >> R_in ${rIn.toExponential(2)}Ω — may not reliably drive the digital input`,
            {
              explanation:
                `The analog source driving bridge input "${adapter.label}" has an estimated ` +
                `source resistance of ${rSourceMismatch.toExponential(2)}Ω, which is more than ` +
                `100× the bridge input resistance R_in = ${rIn.toExponential(2)}Ω. ` +
                `The voltage at the bridge pin will be attenuated by the resistor divider ` +
                `formed by R_source and R_in, potentially preventing the signal from ` +
                `reaching valid logic levels. Add a buffer or lower the source impedance.`,
              suggestions: [
                {
                  text: "Add a unity-gain buffer (voltage follower) between the high-impedance source and the bridge input.",
                  automatable: false,
                },
              ],
            },
          ),
        );
      }
    }
  }

  return {
    compiledInner,
    outputAdapters,
    inputAdapters,
    outputPinNetIds,
    inputPinNetIds,
    instanceName: boundary.instanceName,
  };
}

/**
 * Resolve the outer MNA node ID for a world-space position.
 *
 * Used by the mixed-mode partitioner to find the node ID at a cut-point
 * position without requiring a SubcircuitHost element. Scans all wires
 * for an endpoint matching the position (within 0.5 tolerance).
 */
function resolvePositionToNodeId(
  pos: { x: number; y: number },
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
  outerCircuit: Circuit,
): number {
  for (const wire of outerCircuit.wires) {
    const matchStart =
      Math.abs(wire.start.x - pos.x) < 0.5 &&
      Math.abs(wire.start.y - pos.y) < 0.5;
    const matchEnd =
      Math.abs(wire.end.x - pos.x) < 0.5 &&
      Math.abs(wire.end.y - pos.y) < 0.5;
    if (matchStart || matchEnd) {
      const nodeId = wireToNodeId.get(wire);
      if (nodeId !== undefined) return nodeId;
    }
  }
  return -1;
}

/**
 * Resolve the outer MNA node ID for a subcircuit element's pin.
 *
 * Finds the pin on the subcircuit element whose label matches `pinLabel`,
 * then finds a wire in the outer circuit whose endpoint touches the pin's
 * position. Returns the wire's node ID, or -1 if no match found.
 */
function resolveSubcircuitPinNode(
  subcircuitEl: SubcircuitHost,
  pinLabel: string,
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
  outerCircuit: Circuit,
): number {
  const pins = subcircuitEl.getPins();
  let pinPos: { x: number; y: number } | undefined;
  for (const pin of pins) {
    if (pin.label === pinLabel) {
      // Use pinWorldPosition to get world-space coordinates
      pinPos = pinWorldPosition(subcircuitEl, pin);
      break;
    }
  }
  if (pinPos === undefined) return -1;

  for (const wire of outerCircuit.wires) {
    const matchStart =
      Math.abs(wire.start.x - pinPos.x) < 0.5 &&
      Math.abs(wire.start.y - pinPos.y) < 0.5;
    const matchEnd =
      Math.abs(wire.end.x - pinPos.x) < 0.5 &&
      Math.abs(wire.end.y - pinPos.y) < 0.5;
    if (matchStart || matchEnd) {
      const nodeId = wireToNodeId.get(wire);
      if (nodeId !== undefined) return nodeId;
    }
  }
  return -1;
}
