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

import { Circuit } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { ComponentRegistry } from "../../core/registry.js";
import type { SolverDiagnostic } from "../../core/analog-engine-interface.js";
import { pinWorldPosition } from "../../core/pin.js";
import type { ResolvedPin } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import { makeDiagnostic } from "./diagnostics.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  ConcreteCompiledAnalogCircuit,
  type DeviceModel,
} from "./compiled-analog-circuit.js";
import { defaultLogicFamily } from "../../core/logic-family.js";
import { resolvePinElectrical } from "../../core/pin-electrical.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter } from "./bridge-adapter.js";
import type { BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";
import type { LogicFamilyConfig } from "../../core/logic-family.js";
import type { SolverPartition, PartitionedComponent, DigitalCompilerFn, ComponentDefinition, MnaModel } from "../../compile/types.js";
import type { ModelEntry } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Component routing — shared decision logic for Pass A and Pass B
// ---------------------------------------------------------------------------

type ComponentRoute =
  | { kind: 'stamp';  model: MnaModel; entry: ModelEntry | null }
  | { kind: 'skip' };

/**
 * Resolve a ModelEntry from the component's modelRegistry.
 * Returns null if no entry found for the given key.
 */
function resolveModelEntry(
  def: ComponentDefinition,
  modelKey: string,
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): ModelEntry | null {
  if (def.modelRegistry?.[modelKey]) return def.modelRegistry[modelKey]!;
  if (runtimeModelMap?.[def.name]?.[modelKey]) return runtimeModelMap[def.name]![modelKey]!;
  return null;
}

/**
 * Convert a ModelEntry to the compiler-internal MnaModel representation.
 */
function modelEntryToMnaModel(entry: ModelEntry): MnaModel | null {
  if (entry.kind === "inline") {
    return {
      factory: entry.factory,
      branchCount: entry.branchCount ?? 0,
    };
  }
  // Netlist entries are resolved separately by resolveSubcircuitModels
  return null;
}

function resolveComponentRoute(
  def: ComponentDefinition,
  pc: PartitionedComponent,
  _digitalPinLoading: "cross-domain" | "all" | "none",
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): ComponentRoute {
  if (pc.modelKey === "neutral") {
    return { kind: 'skip' };
  }

  if (pc.modelKey === "digital") {
    return { kind: 'skip' };
  }

  const entry = resolveModelEntry(def, pc.modelKey, runtimeModelMap);
  if (!entry) return { kind: 'skip' };

  if (entry.kind === "netlist") {
    // Netlist entries are resolved by resolveSubcircuitModels into pc.model
    if (pc.model === null) return { kind: 'skip' };
    return { kind: 'stamp', model: pc.model as MnaModel, entry };
  }

  const mnaModel = modelEntryToMnaModel(entry);
  if (!mnaModel) return { kind: 'skip' };
  return { kind: 'stamp', model: mnaModel, entry };
}


// ---------------------------------------------------------------------------
// Subcircuit model resolution — post-partition step (W4.1)
// ---------------------------------------------------------------------------

/**
 * Resolve subcircuit-backed models into MnaModel factories.
 *
 * For each PartitionedComponent whose active model key resolves to a
 * subcircuit netlist, compile it into an MnaModel with a composite factory.
 * Replaces `pc.model` in-place so the main compiler loop only sees
 * stamp/bridge/skip.
 */
function resolveSubcircuitModels(
  partition: SolverPartition,
  runtimeModels: Record<string, MnaSubcircuitNetlist>,
  registry: ComponentRegistry,
  diagnostics: import("../../core/analog-engine-interface.js").SolverDiagnostic[],
): void {
  for (const pc of partition.components) {
    const def = pc.definition;
    const modelReg = def.modelRegistry;
    if (!modelReg) continue;
    const entry = modelReg[pc.modelKey];
    if (!entry || entry.kind !== 'netlist') continue;
    const defName = pc.modelKey;

    const netlist = entry.netlist ?? runtimeModels[defName];
    if (!netlist) {
      diagnostics.push(
        makeDiagnostic(
          "unresolved-model-ref",
          "error",
          `Subcircuit definition "${defName}" not found for component "${def.name}" model key "${pc.modelKey}"`,
          {
            explanation:
              `Component "${def.name}" references subcircuit definition "${defName}" ` +
              `but no MnaSubcircuitNetlist with that name was found in runtime models.`,
          },
        ),
      );
      pc.model = null;
      continue;
    }

    pc.model = compileSubcircuitToMnaModel(netlist, pc, registry);
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
  _pc: PartitionedComponent,
  registry: ComponentRegistry,
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

      // Resolve subcircuit-level params: netlist defaults, then instance overrides.
      const resolvedSubcktParams = new Map<string, number>();
      if (netlist.params) {
        for (const [k, v] of Object.entries(netlist.params)) {
          resolvedSubcktParams.set(k, v);
        }
      }
      // Instance-level overrides from the outer component's PropertyBag
      for (const [k] of resolvedSubcktParams) {
        if (_props.hasModelParam(k)) {
          resolvedSubcktParams.set(k, _props.getModelParam<number>(k));
        }
      }

      // Binding map: subcircuit param name → [{element, elementParamKey}]
      // Used by setParam to route subcircuit-level changes to the correct
      // sub-element param (e.g. "WP" → PMOS elements' "W" param).
      const bindings = new Map<string, Array<{ el: import("../../core/analog-types.js").AnalogElementCore; key: string }>>();

      const subElements: import("../../core/analog-types.js").AnalogElementCore[] = [];
      let subBranchOffset = 0;

      for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
        const subEl = netlist.elements[elIdx];
        const connectivity = netlist.netlist[elIdx];
        const remappedNodes = connectivity.map(remapNet);

        const leafDef = registry.get(subEl.typeId);
        const leafEntry = leafDef ? resolveModelEntry(leafDef, "behavioral") : null;
        if (!leafEntry || leafEntry.kind !== "inline") continue;
        const leafFactory = leafEntry.factory;

        const subProps = new PropertyBag();
        // Seed with leaf definition's default model params (e.g. MOSFET VTO, KP, LAMBDA)
        if (leafEntry.params) {
          for (const [k, v] of Object.entries(leafEntry.params)) {
            if (typeof v === "number") subProps.setModelParam(k, v);
          }
        }
        // Override with subcircuit-specific params — resolve string references
        if (subEl.params) {
          for (const [k, v] of Object.entries(subEl.params)) {
            if (typeof v === "number") {
              subProps.setModelParam(k, v);
            } else if (typeof v === "string") {
              const resolved = resolvedSubcktParams.get(v);
              if (resolved !== undefined) subProps.setModelParam(k, resolved);
            }
          }
        }

        // Build pin-label-keyed Map from positional connectivity array
        const subPinNodes = new Map<string, number>();
        if (leafDef) {
          for (let pi = 0; pi < leafDef.pinLayout.length && pi < remappedNodes.length; pi++) {
            subPinNodes.set(leafDef.pinLayout[pi]!.label, remappedNodes[pi]);
          }
        }

        const subBranchIdx = branchIdx >= 0 ? branchIdx + subBranchOffset : -1;
        const core = leafFactory(subPinNodes, [], subBranchIdx, subProps, getTime);
        if (core.branchIndex >= 0) subBranchOffset++;
        subElements.push(core);

        // Record string-ref bindings for setParam routing
        if (subEl.params) {
          for (const [k, v] of Object.entries(subEl.params)) {
            if (typeof v === "string") {
              let arr = bindings.get(v);
              if (!arr) { arr = []; bindings.set(v, arr); }
              arr.push({ el: core, key: k });
            }
          }
        }
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

        setParam(key: string, value: number): void {
          const bound = bindings.get(key);
          if (bound) {
            // Subcircuit-level param: route to bound sub-elements
            for (const { el, key: elKey } of bound) el.setParam(elKey, value);
          } else {
            // Direct element param (no binding): broadcast to all
            for (const sub of subElements) sub.setParam(key, value);
          }
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

/**
 * Detect nets driven by two or more voltage-source branch equations.
 *
 * Returns pairs of component labels that compete on the same node.
 * Each pair represents one conflict: two components that both impose
 * a voltage constraint on the same MNA node.
 */
function detectCompetingVoltageConstraints(
  elements: Array<{ nodeIds: number[]; isBranch: boolean; typeHint: string; label: string }>,
): Array<[string, string]> {
  const vSources = elements.filter((e) => e.isBranch && e.typeHint === "voltage");
  if (vSources.length < 2) return [];

  // Map from node ID → list of component labels that drive that node via a branch equation
  const nodeDrivers = new Map<number, string[]>();
  for (const vs of vSources) {
    for (const nodeId of vs.nodeIds) {
      if (nodeId <= 0) continue;
      let drivers = nodeDrivers.get(nodeId);
      if (!drivers) { drivers = []; nodeDrivers.set(nodeId, drivers); }
      if (!drivers.includes(vs.label)) drivers.push(vs.label);
    }
  }

  const conflicts: Array<[string, string]> = [];
  const reportedPairs = new Set<string>();
  for (const drivers of nodeDrivers.values()) {
    if (drivers.length < 2) continue;
    for (let i = 0; i < drivers.length - 1; i++) {
      for (let j = i + 1; j < drivers.length; j++) {
        const key = `${drivers[i]!}|${drivers[j]!}`;
        if (!reportedPairs.has(key)) {
          reportedPairs.add(key);
          conflicts.push([drivers[i]!, drivers[j]!]);
        }
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Pipeline stage helpers
// ---------------------------------------------------------------------------

/**
 * Extract runtime subcircuit netlists from circuit metadata.
 */
function extractRuntimeModels(
  metadataSource: Record<string, unknown>,
): Record<string, MnaSubcircuitNetlist> {
  const models = metadataSource["models"];
  if (
    models !== null &&
    typeof models === 'object' &&
    !Array.isArray(models)
  ) {
    return models as Record<string, MnaSubcircuitNetlist>;
  }
  return {};
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
  externalNodeCount: number,
  _diagnostics: SolverDiagnostic[],
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): PassAPartitionResult {
  let nextInternalNode = externalNodeCount + 1;
  let branchCount = 0;
  const elementMeta: PartitionElementMeta[] = [];

  for (const pc of partition.components) {
    const el = pc.element;

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
      continue;
    }

    const def = pc.definition;
    const route = resolveComponentRoute(def, pc, digitalPinLoading, runtimeModelMap);

    switch (route.kind) {
      case 'skip': {
        elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
        continue;
      }
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
  topologyInfo: Array<{ nodeIds: number[]; isBranch: boolean; typeHint: string; label: string }>,
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

  for (const [comp1, comp2] of detectCompetingVoltageConstraints(topologyInfo)) {
    diagnostics.push(
      makeDiagnostic(
        "competing-voltage-constraints",
        "error",
        `Two competing voltage sources are driving the net that connects to ${comp1}, ${comp2} — the circuit design needs to be fixed`,
        {
          explanation:
            `Both "${comp1}" and "${comp2}" impose a voltage constraint (branch equation) ` +
            `on the same MNA node. Two ideal voltage sources cannot drive the same net — ` +
            `this makes the MNA matrix singular and prevents the solver from converging.`,
          suggestions: [
            {
              text: `Remove one of the voltage sources (${comp1} or ${comp2}) driving the shared net, or insert a series resistor between them.`,
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

  // If no ground group found, handle based on partition type.
  // Bridge-only partitions (all groups are boundary groups, no Ground component):
  // synthesize a virtual ground at node 0 without consuming any group ID.
  // All boundary groups then get sequential node IDs starting at 1.
  // Other partitions: pick the largest group as best-effort ground.
  if (groundGroupIds.size === 0 && groups.length > 0) {
    const isBridgeOnly = partition.bridgeStubs.length > 0 &&
      groups.every(g => g.domains.has("digital") || g.domains.size > 1);
    if (!isBridgeOnly) {
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
    // Bridge-only: node 0 is a virtual ground (no group mapped to it).
    // Boundary groups will be assigned node IDs starting at 1 below.
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
  logicFamily?: LogicFamilyConfig,
  outerCircuit?: Circuit,
  _digitalCompiler?: DigitalCompilerFn,
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

  // Stage 2b: Resolve subcircuit-backed models into MnaModel factories.
  const runtimeModels: Record<string, MnaSubcircuitNetlist> = outerCircuit !== undefined
    ? extractRuntimeModels(outerCircuit.metadata as unknown as Record<string, unknown>)
    : {};
  resolveSubcircuitModels(partition, runtimeModels, registry, diagnostics);

  // Extract typed inline runtime models for use in route resolution.
  const runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined =
    outerCircuit?.metadata.models;

  // Stage 3 (Pass A): Assign branch indices and allocate internal nodes.
  const passA = runPassA_partition(partition, externalNodeCount, diagnostics, digitalPinLoading, runtimeModelMap);

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

  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();
  const elementBridgeAdapters = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>();

  type ElementTopologyInfo = {
    nodeIds: number[];
    isBranch: boolean;
    typeHint: string;
    label: string;
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

    const route = resolveComponentRoute(def, pc, digitalPinLoading, runtimeModelMap);

    if (route.kind === 'skip') {
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

    // Populate model params.
    // Merge order (lowest wins): behavioral defaults → registry entry params → element _mparams.
    const modelEntry = route.entry;
    if (modelEntry) {
      const behavioralDefaults = def.modelRegistry?.["behavioral"]?.params ?? {};
      const merged: Record<string, number> = { ...behavioralDefaults, ...modelEntry.params };
      for (const k of props.getModelParamKeys()) {
        merged[k] = props.getModelParam<number>(k);
      }
      props.replaceModelParams(merged);
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
      label: el.getProperties().has("label")
        ? String(el.getProperties().get("label") ?? el.instanceId)
        : el.instanceId,
    });
  }

  totalNodeCount = nextInternalNode - 1;

  // Bridge stub processing — create MNA elements for each cross-domain boundary.
  const bridgeAdaptersByGroupId = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>();

  for (const stub of partition.bridgeStubs) {
    const { boundaryGroupId, descriptor } = stub;
    const nodeId = groupToNodeId.get(boundaryGroupId);
    if (nodeId === undefined) continue;

    // Determine loaded flag: use per-net override if present, else circuit-level mode.
    // "none" mode → unloaded (ideal); "cross-domain" or "all" → loaded.
    const override = descriptor.boundaryGroup.loadingMode;
    const loaded = override !== undefined
      ? override === "loaded"
      : digitalPinLoading !== "none";

    const spec = resolvePinElectrical(circuitFamily, descriptor.electricalSpec);
    const adapters: Array<BridgeOutputAdapter | BridgeInputAdapter> = [];

    if (descriptor.direction === "digital-to-analog") {
      // Digital output pin drives the analog node — BridgeOutputAdapter (voltage source)
      const branchIdx = totalNodeCount + branchCount;
      branchCount++;
      const adapter = makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded);
      // Label for coordinator pin-param dispatch (e.g. "out.rOut" → endsWith(":out"))
      const driverPin = descriptor.boundaryGroup.pins.find(p => p.domain === "digital");
      if (driverPin) adapter.label = `bridge-${boundaryGroupId}:${driverPin.pinLabel}`;
      analogElements.push(adapter);
      adapters.push(adapter);
    } else {
      // Analog voltage drives digital input — BridgeInputAdapter (loading sense)
      const adapter = makeBridgeInputAdapter(spec, nodeId, loaded);
      const sensePin = descriptor.boundaryGroup.pins.find(p => p.domain === "digital");
      if (sensePin) adapter.label = `bridge-${boundaryGroupId}:${sensePin.pinLabel}`;
      analogElements.push(adapter);
      adapters.push(adapter);
    }

    bridgeAdaptersByGroupId.set(boundaryGroupId, adapters);
  }

  // Topology validation — orphan/floating nodes, source loops.
  validateTopologyAndEmitDiagnostics(topologyInfo, totalNodeCount, diagnostics);

  // Check for ground.
  const hasGround = partition.components.some((pc) => pc.element.typeId === "Ground");
  const isBridgeOnlyPartition = !hasGround && partition.bridgeStubs.length > 0;
  if (isBridgeOnlyPartition) {
    // Bridge-only partitions have no Ground component by definition. Node 0 is
    // reserved by the node map builder as a virtual ground reference. Suppress
    // any "no-ground" diagnostic that was emitted during node map construction.
    for (let i = diagnostics.length - 1; i >= 0; i--) {
      if (diagnostics[i]!.code === "no-ground") {
        diagnostics.splice(i, 1);
      }
    }
  } else if (!hasGround) {
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
    bridgeAdaptersByGroupId,
    diagnostics,
    timeRef,
  });
}
