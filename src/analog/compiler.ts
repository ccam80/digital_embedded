/**
 * Analog circuit compiler.
 *
 * Transforms a visual `Circuit` with `engineType: "analog"` into a
 * `ConcreteCompiledAnalogCircuit` that the MNA engine can simulate.
 *
 * Steps:
 *  1. Verify circuit.metadata.engineType === "analog"
 *  2. Build node map (wire groups → MNA node IDs, ground = 0)
 *  3. Assign sequential branch indices to components with requiresBranchRow
 *  4. Allocate internal nodes via getInternalNodeCount
 *  5. Resolve pin→node bindings for each element
 *  6. Call analogFactory for each element
 *  7. Topology validation (floating nodes, voltage-source loops, inductor loops)
 *  8. Return ConcreteCompiledAnalogCircuit
 */

import { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { AnalogElement } from "./element.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { SolverDiagnostic } from "../core/analog-engine-interface.js";
import { pinWorldPosition, PinDirection } from "../core/pin.js";
import type { PinDeclaration, ResolvedPin } from "../core/pin.js";
import { PropertyBag } from "../core/properties.js";
import { hasDigitalModel } from "../core/registry.js";
import { makeDiagnostic } from "./diagnostics.js";
import { TransistorModelRegistry } from "./transistor-model-registry.js";
import { expandTransistorModel } from "./transistor-expansion.js";
import {
  ConcreteCompiledAnalogCircuit,
  type DeviceModel,
} from "./compiled-analog-circuit.js";
import { ModelLibrary, validateModel } from "./model-library.js";
import { defaultLogicFamily, getLogicFamilyPreset } from "../core/logic-family.js";
import { resolvePinElectrical } from "../core/pin-electrical.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
import type { FlattenResult, SubcircuitHost, InternalDigitalPartition, InternalCutPoint } from "../engine/flatten.js";
import type { CrossEngineBoundary } from "../engine/cross-engine-boundary.js";
import type { BridgeInstance } from "./bridge-instance.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter, BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";
import { compileCircuit } from "../engine/compiler.js";
import type { CompiledCircuitImpl } from "../engine/compiled-circuit.js";
import type { LogicFamilyConfig } from "../core/logic-family.js";
import type { SolverPartition, PartitionedComponent } from "../compile/types.js";

// ---------------------------------------------------------------------------
// VDD voltage source factory for transistor expansion
// ---------------------------------------------------------------------------

/**
 * Create a minimal ideal DC voltage source AnalogElement for the shared VDD
 * rail injected when transistor-level components are present in the circuit.
 *
 * Uses the same MNA stamp convention as makeVoltageSource in test-elements.ts:
 * the branch row `branchIdx` is an absolute 0-based solver row index.
 */
function makeVddSource(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): import("./element.js").AnalogElement {
  return {
    pinNodeIds: [nodePos, nodeNeg],
    allNodeIds: [nodePos, nodeNeg],
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: import("./sparse-solver.js").SparseSolver): void {
      const k = branchIdx;
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);
      solver.stampRHS(k, voltage);
    },
    getPinCurrents(voltages: Float64Array): number[] {
      const I = voltages[branchIdx];
      return [I, -I];
    },
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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
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
    // Fallback: look up by position (handles pin-overlap without a wire)
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
// extractDigitalSubcircuit — split mixed-mode circuit into analog + digital parts
// ---------------------------------------------------------------------------

const NEUTRAL_TYPES_FOR_PARTITION = new Set([
  "In", "Out", "Ground", "VDD", "Const", "Probe", "Tunnel",
  "Splitter", "Driver", "NotConnected", "ScopeTrigger",
]);

function posKeyForPartition(p: { x: number; y: number }): string {
  return `${Math.round(p.x * 2) / 2},${Math.round(p.y * 2) / 2}`;
}

class PositionUnionFind {
  private readonly _parent = new Map<string, string>();

  find(k: string): string {
    if (!this._parent.has(k)) this._parent.set(k, k);
    let curr = k;
    while (this._parent.get(curr) !== curr) {
      const p = this._parent.get(curr)!;
      this._parent.set(curr, this._parent.get(p) ?? p);
      curr = this._parent.get(curr)!;
    }
    return curr;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this._parent.set(ra, rb);
  }
}

interface PartitionPinInfo {
  element: import("../core/element.js").CircuitElement;
  pinLabel: string;
  direction: PinDirection;
  worldPos: { x: number; y: number };
  bitWidth: number;
  isDigital: boolean;
}

function extractDigitalSubcircuit(
  circuit: Circuit,
  registry: ComponentRegistry,
): { analogCircuit: Circuit; partition: InternalDigitalPartition } {
  const digitalElements = new Set<import("../core/element.js").CircuitElement>();
  const analogElements = new Set<import("../core/element.js").CircuitElement>();

  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;
    if (NEUTRAL_TYPES_FOR_PARTITION.has(el.typeId)) {
      analogElements.add(el);
      continue;
    }
    if (hasDigitalModel(def) && def.models?.analog === undefined) {
      digitalElements.add(el);
    } else {
      analogElements.add(el);
    }
  }

  const posToPins = new Map<string, PartitionPinInfo[]>();
  for (const el of circuit.elements) {
    const isDigit = digitalElements.has(el);
    for (const pin of el.getPins()) {
      const wp = pinWorldPosition(el, pin);
      const key = posKeyForPartition(wp);
      if (!posToPins.has(key)) posToPins.set(key, []);
      posToPins.get(key)!.push({
        element: el,
        pinLabel: pin.label,
        direction: pin.direction,
        worldPos: wp,
        bitWidth: pin.bitWidth,
        isDigital: isDigit,
      });
    }
  }

  const uf = new PositionUnionFind();
  for (const wire of circuit.wires) {
    uf.union(posKeyForPartition(wire.start), posKeyForPartition(wire.end));
  }

  interface PartitionNetInfo {
    hasDigital: boolean;
    hasAnalog: boolean;
    digitalPins: PartitionPinInfo[];
  }
  const nets = new Map<string, PartitionNetInfo>();

  function getNet(pk: string): PartitionNetInfo {
    const root = uf.find(pk);
    if (!nets.has(root)) nets.set(root, { hasDigital: false, hasAnalog: false, digitalPins: [] });
    return nets.get(root)!;
  }

  for (const [pk, pins] of posToPins) {
    const net = getNet(pk);
    for (const p of pins) {
      if (p.isDigital) { net.hasDigital = true; net.digitalPins.push(p); }
      else { net.hasAnalog = true; }
    }
  }
  for (const wire of circuit.wires) {
    getNet(posKeyForPartition(wire.start));
    getNet(posKeyForPartition(wire.end));
  }

  const cutPoints: InternalCutPoint[] = [];
  let cutIdx = 0;
  const processedRoots = new Set<string>();

  for (const [pk] of posToPins) {
    const root = uf.find(pk);
    if (processedRoots.has(root)) continue;
    processedRoots.add(root);
    const net = nets.get(root);
    if (!net || !net.hasDigital || !net.hasAnalog) continue;

    const hasDigitalOutput = net.digitalPins.some(p => p.direction === PinDirection.OUTPUT);
    const hasDigitalInput = net.digitalPins.some(p => p.direction === PinDirection.INPUT);

    if (hasDigitalOutput) {
      const pin = net.digitalPins.find(p => p.direction === PinDirection.OUTPUT)!;
      const label = `_mxb_o${cutIdx}`;
      cutPoints.push({ label, direction: "out", innerLabel: label, bitWidth: pin.bitWidth, position: { x: pin.worldPos.x, y: pin.worldPos.y } });
      cutIdx++;
    }
    if (hasDigitalInput) {
      const pin = net.digitalPins.find(p => p.direction === PinDirection.INPUT)!;
      const label = `_mxb_i${cutIdx}`;
      cutPoints.push({ label, direction: "in", innerLabel: label, bitWidth: pin.bitWidth, position: { x: pin.worldPos.x, y: pin.worldPos.y } });
      cutIdx++;
    }
  }

  const innerCircuit = new Circuit({ engineType: "digital" });
  for (const el of digitalElements) { innerCircuit.addElement(el); }
  for (const wire of circuit.wires) {
    const root = uf.find(posKeyForPartition(wire.start));
    const net = nets.get(root);
    if (net?.hasDigital) { innerCircuit.addWire(wire); }
  }
  for (const cp of cutPoints) {
    const typeName = cp.direction === "in" ? "In" : "Out";
    const def = registry.get(typeName);
    if (!def) continue;
    const props = new PropertyBag([["label", cp.label], ["bitWidth", cp.bitWidth]]);
    const el = def.factory(props);
    (el as { position: { x: number; y: number } }).position = { x: cp.position.x, y: cp.position.y };
    innerCircuit.addElement(el);
  }

  const analogCircuit = new Circuit({ engineType: "analog" });
  analogCircuit.metadata = { ...circuit.metadata, engineType: "analog" };
  for (const el of analogElements) { analogCircuit.addElement(el); }
  for (const wire of circuit.wires) {
    const root = uf.find(posKeyForPartition(wire.start));
    const net = nets.get(root);
    if (net?.hasAnalog) { analogCircuit.addWire(wire); }
  }

  return {
    analogCircuit,
    partition: { internalCircuit: innerCircuit, cutPoints, instanceName: "MixedDigitalPartition" },
  };
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
  const labelToNodeId = new Map<string, number>();
  const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe"]);
  for (const el of elements) {
    if (!labelTypes.has(el.typeId)) continue;
    let label: string | undefined;
    const props = el.getProperties();
    if (props.has("label")) { label = String(props.get("label")); }
    if (!label) continue;
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
// Main compiler entry point
// ---------------------------------------------------------------------------

/**
 * Compile an analog circuit into a `ConcreteCompiledAnalogCircuit`.
 *
 * Accepts either a raw `Circuit` or a `FlattenResult` (from `flattenCircuit`).
 * When a `FlattenResult` is provided, `crossEngineBoundaries` are processed to
 * create bridge adapter elements and compile inner digital circuits. When a raw
 * `Circuit` is provided, no cross-engine boundary processing is performed
 * (equivalent to passing a FlattenResult with an empty boundaries list).
 *
 * @param circuitOrResult - The visual Circuit model or a FlattenResult
 * @param registry        - The component registry with analog ComponentDefinitions
 * @returns A compiled circuit ready for MNA simulation
 * @throws Error if circuit.metadata.engineType !== "analog" or if a
 *         non-analog component is found in the circuit
 */
export function compileAnalogCircuit(
  circuitOrResult: Circuit | FlattenResult,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): ConcreteCompiledAnalogCircuit {
  // Unwrap: accept either a raw Circuit or a FlattenResult
  let circuit: Circuit;
  let crossEngineBoundaries: CrossEngineBoundary[];
  let mixedModePartitions: InternalDigitalPartition[];
  if ("crossEngineBoundaries" in circuitOrResult) {
    circuit = circuitOrResult.circuit;
    crossEngineBoundaries = circuitOrResult.crossEngineBoundaries;
    mixedModePartitions = circuitOrResult.mixedModePartitions ?? [];
  } else {
    const rawCircuit = circuitOrResult;
    crossEngineBoundaries = [];

    // Detect truly mixed-mode: partition only when BOTH digital-only AND
    // analog-only components are present. If only digital-only components
    // exist (no analog), let the per-element check below emit diagnostics.
    const neutralTypes = new Set([
      'In', 'Out', 'Ground', 'VDD', 'Const', 'Probe', 'Tunnel',
      'Splitter', 'Driver', 'NotConnected', 'ScopeTrigger',
    ]);
    let hasDigitalOnlyEl = false;
    let hasAnalogOnlyEl = false;
    for (const el of rawCircuit.elements) {
      if (neutralTypes.has(el.typeId)) continue;
      const def = registry.get(el.typeId);
      if (!def) continue;
      if (hasDigitalModel(def) && def.models?.analog === undefined) hasDigitalOnlyEl = true;
      if (def.models?.analog !== undefined && !hasDigitalModel(def)) hasAnalogOnlyEl = true;
    }

    if (hasDigitalOnlyEl && hasAnalogOnlyEl) {
      const { analogCircuit, partition } = extractDigitalSubcircuit(rawCircuit, registry);
      circuit = analogCircuit;
      mixedModePartitions = [partition];
    } else {
      circuit = rawCircuit;
      mixedModePartitions = [];
    }
  }

  // Step 1: Verify engine type (accept "analog" and "auto" for mixed-mode)
  if (circuit.metadata.engineType !== "analog" && circuit.metadata.engineType !== "auto") {
    throw new Error(
      `compileAnalogCircuit: circuit engineType must be "analog" or "auto", ` +
        `got "${circuit.metadata.engineType}"`,
    );
  }

  // Step 2: Build node map — assigns wire groups to MNA node IDs, ground = 0
  const nodeMap = buildAnalogNodeMap(circuit);

  // Resolve the circuit's logic family (used for _pinElectrical injection)
  const circuitFamily = circuit.metadata.logicFamily
    ? circuit.metadata.logicFamily
    : (circuit.metadata as Record<string, unknown>)["logicFamilyKey"] !== undefined
      ? (getLogicFamilyPreset((circuit.metadata as Record<string, unknown>)["logicFamilyKey"] as string) ?? defaultLogicFamily())
      : defaultLogicFamily();

  // Collect all diagnostics from compilation
  const diagnostics: SolverDiagnostic[] = [...nodeMap.diagnostics];

  // Model library: starts empty; populated from circuit.metadata.models when present
  const modelLibrary = new ModelLibrary();
  if ((circuit.metadata as Record<string, unknown>)["models"] instanceof Map) {
    const circuitModels = (circuit.metadata as Record<string, unknown>)["models"] as Map<string, DeviceModel>;
    for (const model of circuitModels.values()) {
      // Convert DeviceModel (which uses Map<string,number>) to the model-library format
      const params: Record<string, number> =
        model.params instanceof Map
          ? Object.fromEntries(model.params.entries())
          : (model.params as unknown as Record<string, number>);
      modelLibrary.add({
        name: model.name,
        type: model.type as import("./model-parser.js").DeviceType,
        level: 1,
        params,
      });
    }
  }

  // Build a set of cross-engine placeholder elements so Pass A and Pass B can
  // skip them. These elements are left in the flat circuit as opaque placeholders
  // by the flattener — they must not be passed to the analog factory.
  const crossEnginePlaceholders = new Set<CircuitElement>(
    crossEngineBoundaries.map((b) => b.subcircuitElement as CircuitElement),
  );

  // Step 3: Determine branch indices for voltage sources / inductors, and
  //         allocate internal nodes via getInternalNodeCount.
  //
  // We need two passes:
  //   Pass A: collect branch counts and internal node counts
  //   Pass B: build elements with correct absolute branch row indices

  // The branch row block starts immediately after the external nodes.
  // nodeMap.nodeCount = number of external (wire group) non-ground nodes.
  // Internal nodes (from getInternalNodeCount) are appended after external nodes.

  let nextInternalNode = nodeMap.nodeCount + 1; // 1-based, after external nodes
  let branchCount = 0;

  // VDD node and branch tracking for transistor expansion (Phase 4c).
  // vddNodeId is -1 until the first transistor-mode component is encountered;
  // the compiler allocates a single shared VDD node and voltage source for the circuit.
  let vddNodeId = -1;
  let vddBranchIdx = -1;

  // Per-element metadata collected in Pass A, consumed in Pass B
  const elementMeta: Array<{
    el: CircuitElement;
    branchIdx: number;         // -1 or absolute 0-based branch index
    internalNodeOffset: number; // first internal node ID for this element
    internalNodeCount: number;
  }> = [];

  for (const el of circuit.elements) {
    // Skip cross-engine placeholder elements — they are handled via bridge instances.
    if (crossEnginePlaceholders.has(el)) {
      continue;
    }

    // Ground and Tunnel elements do not need an analog factory — they are structural.
    // Tunnel nets are merged by label during node-map construction; no stamping needed.
    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      elementMeta.push({
        el,
        branchIdx: -1,
        internalNodeOffset: -1,
        internalNodeCount: 0,
      });
      continue;
    }

    const def = registry.get(el.typeId);
    if (!def) {
      throw new Error(
        `compileAnalogCircuit: unknown component type "${el.typeId}" — ` +
          `not registered in the provided registry`,
      );
    }

    // Reject digital-only components — emit diagnostic instead of throwing
    const hasAnalog = def.models?.analog !== undefined;
    const hasBoth = def.models?.digital !== undefined && hasAnalog;
    if (!hasAnalog) {
      diagnostics.push(
        makeDiagnostic(
          "unsupported-component-in-analog",
          "error",
          `Component "${el.typeId}" is digital-only and cannot be placed in an analog circuit`,
          {
            explanation:
              `Component "${el.typeId}" has no analog model. ` +
              `Only components with an analog model ` +
              `can be placed in analog circuits.`,
            suggestions: [
              {
                text: `Set simulationMode to 'behavioral' or add an analogFactory to "${el.typeId}".`,
                automatable: false,
              },
            ],
          },
        ),
      );
      elementMeta.push({
        el,
        branchIdx: -1,
        internalNodeOffset: -1,
        internalNodeCount: 0,
      });
      continue;
    }

    // Transistor-mode and digital-mode components are handled in Pass B —
    // skip branch/node allocation here.
    if (hasBoth) {
      const passAProps = el.getProperties();
      const passAMode = passAProps.has("simulationMode")
        ? (passAProps.get("simulationMode") as string)
        : (def.defaultModel === "digital" ? "logical" : "analog-pins");
      if ((passAMode === "analog-internals" && def.models?.analog?.transistorModel) || passAMode === "logical") {
        elementMeta.push({
          el,
          branchIdx: -1,
          internalNodeOffset: -1,
          internalNodeCount: 0,
        });
        continue;
      }
    }

    // Assign branch index
    let branchIdx = -1;
    if (def.models?.analog?.requiresBranchRow) {
      // The actual matrix row = nodeCount + branchIdx (0-based within branch block)
      // We store the absolute branch index here; the matrix row is computed
      // as nodeCount_total + branchIdx when building the matrix.
      branchIdx = branchCount++;
    }

    // Allocate internal nodes
    const props = el.getProperties();
    const internalCount = def.models?.analog?.getInternalNodeCount?.(props) ?? 0;
    const internalNodeOffset = internalCount > 0 ? nextInternalNode : -1;
    nextInternalNode += internalCount;

    elementMeta.push({
      el,
      branchIdx,
      internalNodeOffset,
      internalNodeCount: internalCount,
    });
  }

  // Total node count including internal nodes from Pass A.
  // Updated again after Pass B completes (transistor expansion allocates more nodes).
  let totalNodeCount = nextInternalNode - 1;

  // The MNA matrix dimension: totalNodeCount + branchCount
  // Branch rows are indexed as: nodeCount + branchIdx (0-based)
  // For consistency with test-elements.ts, the absolute branch row index
  // passed to analogFactory is: totalNodeCount + branchIdx
  // However, the spec says branchIdx is 0-based within the branch block,
  // and the MNA matrix size = nodeCount + branchCount. We keep branchIdx
  // as 0-based — the assembler adds nodeCount to get the absolute row.

  // Inline bridges created for flat "logical" simulationMode components.
  // Collected here and merged into the main bridges array after Step 7.
  const inlineBridges: BridgeInstance[] = [];

  // Step 5 & 6: Resolve pin nodes and call analogFactory for each element
  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();

  // Metadata for topology validation
  type ElementTopologyInfo = {
    nodeIds: number[];
    isBranch: boolean;
    typeHint: string;
  };
  const topologyInfo: ElementTopologyInfo[] = [];

  const timeRef = { value: 0 };
  const getTime = (): number => timeRef.value;

  for (const meta of elementMeta) {
    const { el } = meta;

    // Ground and Tunnel elements: skip factory, just record for topology
    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      continue;
    }

    const def = registry.get(el.typeId)!;
    const props = el.getProperties();

    // Skip digital-only components (diagnostic already emitted in Pass A)
    const hasAnalogModel = def.models?.analog !== undefined;
    const hasBothModels = def.models?.digital !== undefined && hasAnalogModel;
    if (!hasAnalogModel) {
      continue;
    }

    // Handle simulationMode property for "both" components.
    // The "logical" branch applies even when analogFactory is undefined
    // (the component will run as an inner digital engine, no analog stamping needed).
    if (hasBothModels) {
      const simulationMode = props.has("simulationMode")
        ? (props.get("simulationMode") as string)
        : (def.defaultModel === "digital" ? "logical" : "analog-pins");

      if (simulationMode === "analog-internals" && def.models?.analog?.transistorModel) {
        if (!transistorModels) {
          diagnostics.push(
            makeDiagnostic(
              "missing-transistor-model",
              "error",
              `Component "${el.typeId}" is set to simulationMode 'analog-internals' but no TransistorModelRegistry was provided`,
              {
                explanation:
                  `Pass a TransistorModelRegistry as the third argument to compileAnalogCircuit() ` +
                  `when compiling circuits with transistor-level components.`,
              },
            ),
          );
          continue;
        }

        if (def.models?.analog?.factory !== undefined) {
          // Resolve outer pin node IDs for this component (capture wire vertices)
          const outerPinVertices: Array<{ x: number; y: number } | null> = new Array(
            def.pinLayout.length,
          ).fill(null);
          const outerPinNodeIds = resolveElementNodes(el, nodeMap.wireToNodeId, circuit, outerPinVertices, nodeMap.positionToNodeId);

          // Build nodeId → vertex lookup from the outer component's pins
          const nodeIdToVertex = new Map<number, { x: number; y: number }>();
          for (let pi = 0; pi < outerPinNodeIds.length; pi++) {
            const nid = outerPinNodeIds[pi];
            const vtx = outerPinVertices[pi];
            if (nid >= 0 && vtx) nodeIdToVertex.set(nid, vtx);
          }

          // Ensure the shared VDD node and VDD voltage source are created once
          if (vddNodeId < 0) {
            vddNodeId = nextInternalNode++;
            // Allocate a branch row for the VDD voltage source
            vddBranchIdx = branchCount++;
          }

          // Expand the transistor model
          const expResult = expandTransistorModel(
            def,
            outerPinNodeIds,
            transistorModels,
            vddNodeId,
            0, // gndNodeId is always 0
            () => nextInternalNode++,
          );

          diagnostics.push(...expResult.diagnostics);

          for (const expEl of expResult.elements) {
            const expElIdx = analogElements.length;
            analogElements.push(expEl);
            elementToCircuitElement.set(expElIdx, el);

            // Map expansion sub-element pinNodeIds back to outer pin vertices
            const subVerts: Array<{ x: number; y: number } | null> = [];
            for (const nid of expEl.pinNodeIds) {
              subVerts.push(nodeIdToVertex.get(nid) ?? null);
            }
            elementPinVertices.set(expElIdx, subVerts);

            // Build minimal ResolvedPin[] for expansion sub-elements.
            // Expansion elements have no pinLayout — use pinNodeIds positionally.
            // wireVertex comes from the outer component's nodeId→vertex map.
            {
              const expResolvedPins: ResolvedPin[] = [];
              for (let ni = 0; ni < expEl.pinNodeIds.length; ni++) {
                const nid = expEl.pinNodeIds[ni];
                const vtx = nodeIdToVertex.get(nid) ?? null;
                expResolvedPins.push({
                  label: `node${ni}`,
                  direction: PinDirection.BIDIRECTIONAL,
                  localPosition: { x: 0, y: 0 },
                  worldPosition: vtx ?? { x: 0, y: 0 },
                  wireVertex: vtx,
                  nodeId: nid,
                  bitWidth: 1,
                });
              }
              elementResolvedPins.set(expElIdx, expResolvedPins);
            }
            topologyInfo.push({
              nodeIds: Array.from(expEl.pinNodeIds),
              isBranch: expEl.branchIndex >= 0,
              typeHint: expEl.branchIndex >= 0
                ? expEl.isReactive ? "inductor" : "voltage"
                : "other",
            });
          }
          continue;
        }
        // No transistorModel — fall through to analogFactory path below
      } else if (simulationMode === "logical") {
        // Logical bridge path: wrap this component in a minimal inner digital
        // circuit and create bridge adapters at each pin boundary.

        const outerPinNodeIds = resolveElementNodes(el, nodeMap.wireToNodeId, circuit, undefined, nodeMap.positionToNodeId);

        // Check for unconnected pins — skip with diagnostic if any are missing.
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

        // Synthesize and compile the inner digital circuit.
        const innerCircuit = synthesizeDigitalCircuit(el, def, registry);
        let compiledInner: CompiledCircuitImpl;
        try {
          compiledInner = compileCircuit(innerCircuit, registry);
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

        // Create bridge adapters for each pin.
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

          const defPinOverride = def.models?.analog?.pinElectricalOverrides?.[pinDecl.label];
          const componentOverride = def.models?.analog?.pinElectrical;
          // Merge user per-pin overrides (from property panel) with definition overrides
          let userBridgeOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
          if (props.has("_pinElectricalOverrides")) {
            try {
              userBridgeOverrides = JSON.parse(props.get("_pinElectricalOverrides") as string);
            } catch { /* ignore malformed JSON */ }
          }
          const userPinOverride = userBridgeOverrides[pinDecl.label];
          const mergedPinOverride = userPinOverride
            ? { ...defPinOverride, ...userPinOverride }
            : defPinOverride;
          const spec = resolvePinElectrical(circuitFamily, mergedPinOverride, componentOverride);

          if (pinDecl.direction === PinDirection.OUTPUT) {
            // Digital drives analog
            const adapter = makeBridgeOutputAdapter(spec, outerNodeId);
            adapter.label = `${elLabel}:${pinDecl.label}`;
            outputAdapters.push(adapter);
            outputPinNetIds.push(innerNetId);
            analogElements.push(adapter);
            topologyInfo.push({ nodeIds: Array.from(adapter.pinNodeIds), isBranch: false, typeHint: "other" });
          } else {
            // Analog drives digital (INPUT or BIDIRECTIONAL)
            const adapter = makeBridgeInputAdapter(spec, outerNodeId);
            adapter.label = `${elLabel}:${pinDecl.label}`;
            inputAdapters.push(adapter);
            inputPinNetIds.push(innerNetId);
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
    }

    // Resolve pin → node ID bindings (also capture matched wire vertices)
    const pinVertices: Array<{ x: number; y: number } | null> = new Array(
      def.pinLayout.length,
    ).fill(null);
    const pinNodeIds = resolveElementNodes(el, nodeMap.wireToNodeId, circuit, pinVertices, nodeMap.positionToNodeId);

    // Check for unconnected pins — emit a human-readable diagnostic per pin
    const pinLabels = def.pinLayout.map((pd) => pd.label);
    let hasUnconnectedPin = false;
    for (let pi = 0; pi < pinNodeIds.length; pi++) {
      if (pinNodeIds[pi] < 0) {
        hasUnconnectedPin = true;
        const label = el.getProperties().has("label")
          ? el.getProperties().get<string>("label")
          : el.typeId;
        const pinLabel = pinLabels[pi] ?? `pin ${pi}`;
        diagnostics.push(
          makeDiagnostic(
            "unconnected-analog-pin",
            "warning",
            `The "${pinLabel}" pin on "${label}" (${el.typeId}) is not connected — component excluded from simulation`,
            {
              explanation:
                `Component "${label}" has a pin ("${pinLabel}") that doesn't touch any wire ` +
                `endpoint in the circuit. This can happen when the component is rotated or ` +
                `moved but the wires weren't updated to follow. The component has been ` +
                `excluded from the analog simulation; the rest of the circuit will still run.`,
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

    // If any pin is unconnected, skip this element entirely to prevent
    // negative node IDs from poisoning the MNA matrix.
    if (hasUnconnectedPin) {
      continue;
    }

    // Build pinNodes map: label -> MNA node ID (in pinLayout order)
    const pinNodes = new Map<string, number>();
    for (let pi = 0; pi < pinNodeIds.length; pi++) {
      const label = pinLabels[pi];
      if (label !== undefined) {
        pinNodes.set(label, pinNodeIds[pi]);
      }
    }

    // Build internalNodeIds array (factory's private allocation)
    const internalNodeIds: number[] = [];
    if (meta.internalNodeCount > 0) {
      for (let i = 0; i < meta.internalNodeCount; i++) {
        internalNodeIds.push(meta.internalNodeOffset + i);
      }
    }

    // Compute the absolute branch row index for this element.
    // The branch block starts at totalNodeCount in the full matrix, but
    // analogFactory receives a 0-based branchIdx. The concrete value passed
    // here matches the convention in test-elements.ts makeVoltageSource where
    // branchIdx is the absolute 0-based solver row (including nodeCount offset).
    // The MNA assembler sets up beginAssembly(matrixSize) where
    // matrixSize = totalNodeCount + branchCount, so branch rows are
    // absolute indices totalNodeCount, totalNodeCount+1, …
    // We pass branchIdx as totalNodeCount + meta.branchIdx to match
    // how makeVoltageSource uses it (as an absolute row index).
    const absoluteBranchIdx =
      meta.branchIdx >= 0 ? totalNodeCount + meta.branchIdx : -1;

    // Pin electrical injection for "both" components with analogFactory.
    // Resolve per-pin electrical specs from the circuit logic family, component
    // definition overrides, AND user-specified per-pin overrides from the
    // property panel (_pinElectricalOverrides JSON string in the PropertyBag).
    //
    // Priority (highest wins):
    //   1. User per-pin override  (_pinElectricalOverrides from PropertyBag)
    //   2. Definition per-pin     (def.pinElectricalOverrides)
    //   3. Definition component   (def.pinElectrical)
    //   4. Circuit logic family   (circuitFamily)
    if (hasBothModels && def.models?.analog?.factory !== undefined) {
      // Parse user overrides from the property panel (stored as JSON string)
      let userOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
      if (props.has("_pinElectricalOverrides")) {
        try {
          userOverrides = JSON.parse(props.get("_pinElectricalOverrides") as string);
        } catch { /* ignore malformed JSON */ }
      }

      const pinLabels = def.pinLayout.map((pd) => pd.label);
      const pinElectricalMap: Record<string, ResolvedPinElectrical> = {};
      for (const pinLabel of pinLabels) {
        const defPinOverride = def.models?.analog?.pinElectricalOverrides?.[pinLabel];
        const componentOverride = def.models?.analog?.pinElectrical;
        // Merge: user per-pin overrides take highest priority
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
      props.set("_pinElectrical", pinElectricalMap as unknown as import("../core/properties.js").PropertyValue);
    }

    // Model binding: semiconductor components get resolved model parameters
    // injected into the props bag under '_modelParams' before factory call.
    if (def.models?.analog?.deviceType !== undefined) {
      const modelName = props.has("model") ? props.get<string>("model") : "";
      const resolvedModel =
        (modelName !== "" ? modelLibrary.get(modelName) : undefined) ??
        modelLibrary.getDefault(def.models!.analog!.deviceType);

      // Emit diagnostics for any issues with the resolved model
      const modelDiags = validateModel(resolvedModel);
      diagnostics.push(...modelDiags);

      // Inject resolved model params into the PropertyBag directly rather
      // than spreading (spreading PropertyBag loses _map contents).
      props.set("_modelParams", resolvedModel.params as unknown as import("../core/properties.js").PropertyValue);
    }

    // Call the analog factory — returns AnalogElementCore (no pinNodeIds).
    // Compiler is the SOLE place pinNodeIds is constructed — always pinLayout order.
    // factory is optional on AnalogModel (transistor-expanded components omit it),
    // but those are handled by the expansion path above and never reach here.
    const analogFactory = def.models!.analog!.factory;
    if (!analogFactory) continue;
    const core = analogFactory(pinNodes, internalNodeIds, absoluteBranchIdx, props, getTime);
    const element: AnalogElement = Object.assign(core, {
      pinNodeIds: pinNodeIds,
      allNodeIds: [...pinNodeIds, ...internalNodeIds],
    });

    const elementIndex = analogElements.length;
    analogElements.push(element);
    elementToCircuitElement.set(elementIndex, el);
    elementPinVertices.set(elementIndex, pinVertices);

    // Build ResolvedPin[] in pinLayout order and store on compiled circuit.
    {
      const resolvedPins: ResolvedPin[] = [];
      const elPins = el.getPins();
      for (let pi = 0; pi < def.pinLayout.length; pi++) {
        const decl = def.pinLayout[pi];
        const pin = elPins[pi];
        if (!decl || !pin) continue;
        resolvedPins.push({
          label: decl.label,
          direction: decl.direction,
          localPosition: pin.position,
          worldPosition: pinWorldPosition(el, pin),
          wireVertex: pinVertices[pi] ?? null,
          nodeId: pinNodeIds[pi],
          bitWidth: pin.bitWidth,
        });
      }
      elementResolvedPins.set(elementIndex, resolvedPins);
    }

    // Record topology info for validation
    topologyInfo.push({
      nodeIds: [...pinNodeIds, ...internalNodeIds],
      isBranch: meta.branchIdx >= 0,
      // Infer typeHint from branchIdx being present; inductors also use branches
      // We distinguish by checking if the element is reactive with a branch
      typeHint: meta.branchIdx >= 0
        ? element.isReactive
          ? "inductor"
          : "voltage"
        : "other",
    });
  }

  // After Pass B: recompute totalNodeCount to include all transistor-expansion nodes.
  totalNodeCount = nextInternalNode - 1;

  // If any transistor-mode component was expanded, inject the shared VDD voltage source.
  // This single DC source supplies all expanded transistor models in the circuit.
  if (vddNodeId >= 0 && vddBranchIdx >= 0) {
    const vdd = circuitFamily.vdd;
    const absoluteVddBranch = totalNodeCount + vddBranchIdx;
    const vddSource = makeVddSource(vddNodeId, 0, absoluteVddBranch, vdd);
    analogElements.push(vddSource);
    topologyInfo.push({
      nodeIds: [vddNodeId, 0],
      isBranch: true,
      typeHint: "voltage",
    });
  }

  // Step 6: Topology validation

  // Check for orphan and floating nodes (only meaningful if we have external nodes)
  if (totalNodeCount > 0) {
    const weakNodes = detectWeakNodes(topologyInfo, totalNodeCount);

    // Orphan nodes: zero element terminals — completely disconnected wire
    // groups (e.g. degenerate zero-length wires). These make the MNA matrix
    // singular and must block compilation.
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

    // Floating nodes: one element terminal — no complete current path.
    // Warning severity; the circuit may still converge with gmin stepping.
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

  // Check for voltage-source loops
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

  // Check for inductor loops
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

  // Re-check missing ground. If the node-map builder already emitted a
  // no-ground diagnostic, don't duplicate it.
  const hasGroundDiag = nodeMap.diagnostics.some((d) => d.code === "no-ground");
  if (!hasGroundDiag) {
    const hasGround = circuit.elements.some(
      (el) => el.typeId === "Ground",
    );
    if (!hasGround) {
      diagnostics.push(
        makeDiagnostic(
          "no-ground",
          "warning",
          "No Ground element found in circuit",
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

  // Step 7: Process cross-engine boundaries — compile inner digital circuits
  //          and create bridge adapter elements.
  const bridges: BridgeInstance[] = [];

  for (const boundary of crossEngineBoundaries) {
    const bridgeInstance = compileBridgeInstance(
      boundary,
      nodeMap.wireToNodeId,
      circuit,
      totalNodeCount,
      circuitFamily,
      registry,
      diagnostics,
    );
    if (bridgeInstance !== null) {
      // Add bridge adapters to the analog element list so the MNA assembler
      // stamps them into the matrix.
      for (const adapter of bridgeInstance.outputAdapters) {
        analogElements.push(adapter);
      }
      for (const adapter of bridgeInstance.inputAdapters) {
        analogElements.push(adapter);
      }
      bridges.push(bridgeInstance);
    }
  }

  // Step 7b: Process mixed-mode partitions — compile inner digital circuits
  //           and create bridge adapter elements at cut-point positions.
  for (const partition of mixedModePartitions) {
    let compiledInner: CompiledCircuitImpl;
    try {
      compiledInner = compileCircuit(partition.internalCircuit, registry);
    } catch (err) {
      diagnostics.push(
        makeDiagnostic(
          "bridge-inner-compile-error",
          "error",
          `Failed to compile inner digital partition "${partition.instanceName}": ${String(err)}`,
          {},
        ),
      );
      continue;
    }

    const outputAdapters: BridgeOutputAdapter[] = [];
    const inputAdapters: BridgeInputAdapter[] = [];
    const outputPinNetIds: number[] = [];
    const inputPinNetIds: number[] = [];

    for (const cp of partition.cutPoints) {
      // Resolve outer MNA node ID by matching cut-point position to wire endpoints
      const outerNodeId = resolvePositionToNodeId(
        cp.position,
        nodeMap.wireToNodeId,
        circuit,
      );

      if (outerNodeId < 0) {
        diagnostics.push(
          makeDiagnostic(
            "bridge-unconnected-pin",
            "warning",
            `Mixed-mode cut point "${cp.label}" at (${cp.position.x}, ${cp.position.y}) ` +
              `is not connected to any wire in the analog circuit`,
            {},
          ),
        );
        continue;
      }

      // Resolve inner net ID from the compiled digital circuit
      const innerNetId = compiledInner.labelToNetId.get(cp.innerLabel) ?? -1;
      if (innerNetId < 0) {
        diagnostics.push(
          makeDiagnostic(
            "bridge-missing-inner-pin",
            "warning",
            `Mixed-mode: inner digital circuit has no net for cut-point label "${cp.innerLabel}"`,
            {},
          ),
        );
        continue;
      }

      const spec = resolvePinElectrical(circuitFamily);

      if (cp.direction === "out") {
        // Digital drives analog
        const adapter = makeBridgeOutputAdapter(spec, outerNodeId);
        adapter.label = `${partition.instanceName}:${cp.label}`;
        outputAdapters.push(adapter);
        outputPinNetIds.push(innerNetId);
      } else {
        // Analog drives digital
        const adapter = makeBridgeInputAdapter(spec, outerNodeId);
        adapter.label = `${partition.instanceName}:${cp.label}`;
        inputAdapters.push(adapter);
        inputPinNetIds.push(innerNetId);
      }
    }

    if (outputAdapters.length > 0 || inputAdapters.length > 0) {
      for (const adapter of outputAdapters) analogElements.push(adapter);
      for (const adapter of inputAdapters) analogElements.push(adapter);
      bridges.push({
        compiledInner,
        outputAdapters,
        inputAdapters,
        outputPinNetIds,
        inputPinNetIds,
        instanceName: partition.instanceName,
      });
    }
  }

  // Step 7c: Merge inline bridges (from flat "logical" simulationMode components).
  bridges.push(...inlineBridges);

  // Step 8: Build and return ConcreteCompiledAnalogCircuit
  const models = new Map<string, DeviceModel>();

  return new ConcreteCompiledAnalogCircuit({
    nodeCount: totalNodeCount,
    branchCount,
    elements: analogElements,
    labelToNodeId: nodeMap.labelToNodeId,
    wireToNodeId: nodeMap.wireToNodeId,
    models,
    elementToCircuitElement,
    elementPinVertices,
    elementResolvedPins,
    diagnostics,
    bridges,
    timeRef,
  });
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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>;
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
  const wireToNodeId = new Map<import("../core/circuit.js").Wire, number>();
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

  // Build labelToNodeId from In/Out/Probe components in the partition
  const labelToNodeId = new Map<string, number>();
  const labelTypes = new Set(["In", "Out", "Probe", "in", "out", "probe"]);
  for (const pc of partition.components) {
    if (!labelTypes.has(pc.element.typeId)) continue;
    const props = pc.element.getProperties();
    const label = props.has("label") ? String(props.get("label")) : "";
    if (!label) continue;
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
 *
 * The existing `compileAnalogCircuit()` continues to work unchanged.
 */
export function compileAnalogPartition(
  partition: SolverPartition,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
  logicFamily?: LogicFamilyConfig,
  outerCircuit?: Circuit,
): ConcreteCompiledAnalogCircuit {
  const diagnostics: SolverDiagnostic[] = [];

  // Build node map from partition groups
  const {
    nodeCount: externalNodeCount,
    wireToNodeId,
    labelToNodeId,
    positionToNodeId,
  } = buildAnalogNodeMapFromPartition(partition, diagnostics);

  // Use the caller-supplied logic family or fall back to the default.
  const circuitFamily = logicFamily ?? defaultLogicFamily();

  // Model library: populate from outerCircuit.metadata.models when provided,
  // matching the same pattern as compileAnalogCircuit (lines 731-745).
  const modelLibrary = new ModelLibrary();
  if (outerCircuit !== undefined &&
      (outerCircuit.metadata as Record<string, unknown>)["models"] instanceof Map) {
    const circuitModels = (outerCircuit.metadata as Record<string, unknown>)["models"] as Map<string, DeviceModel>;
    for (const model of circuitModels.values()) {
      const params: Record<string, number> =
        model.params instanceof Map
          ? Object.fromEntries(model.params.entries())
          : (model.params as unknown as Record<string, number>);
      modelLibrary.add({
        name: model.name,
        type: model.type as import("./model-parser.js").DeviceType,
        level: 1,
        params,
      });
    }
  }

  // Build set of cross-engine placeholder elements (from bridgeStubs)
  const crossEnginePlaceholderIds = new Set<string>(
    partition.crossEngineBoundaries.map((b) => (b.subcircuitElement as CircuitElement).instanceId),
  );

  // Pass A: collect branch counts and internal node counts
  let nextInternalNode = externalNodeCount + 1;
  let branchCount = 0;
  let vddNodeId = -1;
  let vddBranchIdx = -1;

  const elementMeta: Array<{
    pc: PartitionedComponent;
    branchIdx: number;
    internalNodeOffset: number;
    internalNodeCount: number;
  }> = [];

  for (const pc of partition.components) {
    const el = pc.element;

    // Skip cross-engine placeholder elements
    if (crossEnginePlaceholderIds.has(el.instanceId)) {
      continue;
    }

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
      continue;
    }

    const def = pc.definition;

    const hasAnalog = def.models?.analog !== undefined;
    const hasBoth = def.models?.digital !== undefined && hasAnalog;
    if (!hasAnalog) {
      diagnostics.push(
        makeDiagnostic(
          "unsupported-component-in-analog",
          "error",
          `Component "${el.typeId}" is digital-only and cannot be placed in an analog circuit`,
          {
            explanation:
              `Component "${el.typeId}" has no analog model. ` +
              `Only components with an analog model can be placed in analog circuits.`,
            suggestions: [
              {
                text: `Set simulationMode to 'behavioral' or add an analogFactory to "${el.typeId}".`,
                automatable: false,
              },
            ],
          },
        ),
      );
      elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
      continue;
    }

    if (hasBoth) {
      const passAProps = el.getProperties();
      const passAMode = passAProps.has("simulationMode")
        ? (passAProps.get("simulationMode") as string)
        : (def.defaultModel === "digital" ? "logical" : "analog-pins");
      if ((passAMode === "analog-internals" && def.models?.analog?.transistorModel) || passAMode === "logical") {
        elementMeta.push({ pc, branchIdx: -1, internalNodeOffset: -1, internalNodeCount: 0 });
        continue;
      }
    }

    let branchIdx = -1;
    if (def.models?.analog?.requiresBranchRow) {
      branchIdx = branchCount++;
    }

    const props = el.getProperties();
    const internalCount = def.models?.analog?.getInternalNodeCount?.(props) ?? 0;
    const internalNodeOffset = internalCount > 0 ? nextInternalNode : -1;
    nextInternalNode += internalCount;

    elementMeta.push({ pc, branchIdx, internalNodeOffset, internalNodeCount: internalCount });
  }

  let totalNodeCount = nextInternalNode - 1;

  // Build a minimal circuit-like wire lookup for resolveElementNodes.
  // We need to pass wireToNodeId and a circuit object. We create a minimal
  // stub that provides circuit.wires for pin position matching.
  // resolveElementNodes needs (el, wireToNodeId, circuit, vertexOut?, positionToNodeId?)
  // where circuit is used for circuit.wires iteration.
  // We collect all wires from the partition's groups.
  const allWires = partition.groups.flatMap((g) => g.wires);
  const partitionCircuitStub = { wires: allWires } as import("../core/circuit.js").Circuit;

  const inlineBridges: BridgeInstance[] = [];
  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();

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

    const hasAnalogModel = def.models?.analog !== undefined;
    const hasBothModels = def.models?.digital !== undefined && hasAnalogModel;
    if (!hasAnalogModel) {
      continue;
    }

    if (hasBothModels) {
      const simulationMode = props.has("simulationMode")
        ? (props.get("simulationMode") as string)
        : (def.defaultModel === "digital" ? "logical" : "analog-pins");

      if (simulationMode === "analog-internals" && def.models?.analog?.transistorModel) {
        if (!transistorModels) {
          diagnostics.push(
            makeDiagnostic(
              "missing-transistor-model",
              "error",
              `Component "${el.typeId}" is set to simulationMode 'analog-internals' but no TransistorModelRegistry was provided`,
              {
                explanation:
                  `Pass a TransistorModelRegistry as the third argument to compileAnalogPartition() ` +
                  `when compiling circuits with transistor-level components.`,
              },
            ),
          );
          continue;
        }

        if (def.models?.analog?.factory !== undefined) {
          const outerPinVertices: Array<{ x: number; y: number } | null> = new Array(
            def.pinLayout.length,
          ).fill(null);
          const outerPinNodeIds = resolveElementNodes(el, wireToNodeId, partitionCircuitStub, outerPinVertices, positionToNodeId);

          const nodeIdToVertex = new Map<number, { x: number; y: number }>();
          for (let pi = 0; pi < outerPinNodeIds.length; pi++) {
            const nid = outerPinNodeIds[pi];
            const vtx = outerPinVertices[pi];
            if (nid >= 0 && vtx) nodeIdToVertex.set(nid, vtx);
          }

          if (vddNodeId < 0) {
            vddNodeId = nextInternalNode++;
            vddBranchIdx = branchCount++;
          }

          const expResult = expandTransistorModel(
            def,
            outerPinNodeIds,
            transistorModels,
            vddNodeId,
            0,
            () => nextInternalNode++,
          );

          diagnostics.push(...expResult.diagnostics);

          for (const expEl of expResult.elements) {
            const expElIdx = analogElements.length;
            analogElements.push(expEl);
            elementToCircuitElement.set(expElIdx, el);

            const subVerts: Array<{ x: number; y: number } | null> = [];
            for (const nid of expEl.pinNodeIds) {
              subVerts.push(nodeIdToVertex.get(nid) ?? null);
            }
            elementPinVertices.set(expElIdx, subVerts);

            {
              const expResolvedPins: ResolvedPin[] = [];
              for (let ni = 0; ni < expEl.pinNodeIds.length; ni++) {
                const nid = expEl.pinNodeIds[ni];
                const vtx = nodeIdToVertex.get(nid) ?? null;
                expResolvedPins.push({
                  label: `node${ni}`,
                  direction: PinDirection.BIDIRECTIONAL,
                  localPosition: { x: 0, y: 0 },
                  worldPosition: vtx ?? { x: 0, y: 0 },
                  wireVertex: vtx,
                  nodeId: nid,
                  bitWidth: 1,
                });
              }
              elementResolvedPins.set(expElIdx, expResolvedPins);
            }
            topologyInfo.push({
              nodeIds: Array.from(expEl.pinNodeIds),
              isBranch: expEl.branchIndex >= 0,
              typeHint: expEl.branchIndex >= 0
                ? expEl.isReactive ? "inductor" : "voltage"
                : "other",
            });
          }
          continue;
        }
      } else if (simulationMode === "logical") {
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
          compiledInner = compileCircuit(innerCircuit, registry);
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

          const defPinOverride = def.models?.analog?.pinElectricalOverrides?.[pinDecl.label];
          const componentOverride = def.models?.analog?.pinElectrical;
          let userBridgeOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
          if (props.has("_pinElectricalOverrides")) {
            try {
              userBridgeOverrides = JSON.parse(props.get("_pinElectricalOverrides") as string);
            } catch { /* ignore malformed JSON */ }
          }
          const userPinOverride = userBridgeOverrides[pinDecl.label];
          const mergedPinOverride = userPinOverride
            ? { ...defPinOverride, ...userPinOverride }
            : defPinOverride;
          const spec = resolvePinElectrical(circuitFamily, mergedPinOverride, componentOverride);

          if (pinDecl.direction === PinDirection.OUTPUT) {
            const adapter = makeBridgeOutputAdapter(spec, outerNodeId);
            adapter.label = `${elLabel}:${pinDecl.label}`;
            outputAdapters.push(adapter);
            outputPinNetIds.push(innerNetId);
            analogElements.push(adapter);
            topologyInfo.push({ nodeIds: Array.from(adapter.pinNodeIds), isBranch: false, typeHint: "other" });
          } else {
            const adapter = makeBridgeInputAdapter(spec, outerNodeId);
            adapter.label = `${elLabel}:${pinDecl.label}`;
            inputAdapters.push(adapter);
            inputPinNetIds.push(innerNetId);
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
    }

    // Resolve pin → node ID bindings
    const pinVertices: Array<{ x: number; y: number } | null> = new Array(
      def.pinLayout.length,
    ).fill(null);
    const pinNodeIds = resolveElementNodes(el, wireToNodeId, partitionCircuitStub, pinVertices, positionToNodeId);

    const pinLabelList = def.pinLayout.map((pd) => pd.label);
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

    if (hasBothModels && def.models?.analog?.factory !== undefined) {
      let userOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
      if (props.has("_pinElectricalOverrides")) {
        try {
          userOverrides = JSON.parse(props.get("_pinElectricalOverrides") as string);
        } catch { /* ignore malformed JSON */ }
      }

      const pinLabelsForElec = def.pinLayout.map((pd) => pd.label);
      const pinElectricalMap: Record<string, ResolvedPinElectrical> = {};
      for (const pinLabel of pinLabelsForElec) {
        const defPinOverride = def.models?.analog?.pinElectricalOverrides?.[pinLabel];
        const componentOverride = def.models?.analog?.pinElectrical;
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
      props.set("_pinElectrical", pinElectricalMap as unknown as import("../core/properties.js").PropertyValue);
    }

    if (def.models?.analog?.deviceType !== undefined) {
      const modelName = props.has("model") ? props.get<string>("model") : "";
      const resolvedModel =
        (modelName !== "" ? modelLibrary.get(modelName) : undefined) ??
        modelLibrary.getDefault(def.models!.analog!.deviceType);

      const modelDiags = validateModel(resolvedModel);
      diagnostics.push(...modelDiags);
      props.set("_modelParams", resolvedModel.params as unknown as import("../core/properties.js").PropertyValue);
    }

    const analogFactory = def.models!.analog!.factory;
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
      for (let pi = 0; pi < def.pinLayout.length; pi++) {
        const decl = def.pinLayout[pi];
        const pin = elPins[pi];
        if (!decl || !pin) continue;
        resolvedPinsOut.push({
          label: decl.label,
          direction: decl.direction,
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

  // After Pass B: recompute totalNodeCount to include transistor-expansion nodes
  totalNodeCount = nextInternalNode - 1;

  if (vddNodeId >= 0 && vddBranchIdx >= 0) {
    const vdd = circuitFamily.vdd;
    const absoluteVddBranch = totalNodeCount + vddBranchIdx;
    const vddSource = makeVddSource(vddNodeId, 0, absoluteVddBranch, vdd);
    analogElements.push(vddSource);
    topologyInfo.push({
      nodeIds: [vddNodeId, 0],
      isBranch: true,
      typeHint: "voltage",
    });
  }

  // Topology validation
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
              `This creates a zero row in the MNA matrix, making it singular.`,
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
              `A floating node has no complete current path.`,
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
            "A loop of ideal voltage sources creates contradictory KVL constraints.",
          suggestions: [
            {
              text: "Add a small series resistance to one of the voltage source branches.",
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
            "A loop of ideal inductors creates a degenerate branch equation system.",
          suggestions: [
            {
              text: "Add a small series resistance to one of the inductor branches.",
              automatable: false,
            },
          ],
        },
      ),
    );
  }

  // Check for ground
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

  // Process cross-engine boundaries into BridgeInstances when an outer circuit
  // is provided (supplies the wire-endpoint geometry needed for node resolution).
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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
  registry: ComponentRegistry,
): number | null {
  let maxResistance: number | null = null;

  for (const el of outerCircuit.elements) {
    const def = registry.get(el.typeId);
    if (!def) continue;

    // Only inspect analog or both elements
    if (def.models?.analog === undefined) continue;

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
 *   - One instance of the component (same type and props, minus simulationMode
 *     and _pinElectrical)
 *   - One In element per input pin, labeled to match the component's pin label
 *   - One Out element per output pin, labeled to match the component's pin label
 *   - Wires connecting each In/Out to the component's pins
 *   - metadata.engineType = "digital"
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
  def: import("../core/registry.js").ComponentDefinition,
  registry: ComponentRegistry,
): Circuit {
  const inner = new Circuit({ name: el.typeId, engineType: "digital" });

  // Build stripped props: copy all properties except analog-compiler concerns.
  const srcProps = el.getProperties();
  const innerProps = new PropertyBag();
  for (const [key, val] of srcProps.entries()) {
    if (key === "simulationMode" || key === "_pinElectrical") continue;
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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
  outerCircuit: Circuit,
  _totalNodeCount: number,
  circuitFamily: LogicFamilyConfig,
  registry: ComponentRegistry,
  diagnostics: SolverDiagnostic[],
): BridgeInstance | null {
  // Step 1: Compile the inner digital circuit.
  let compiledInner: CompiledCircuitImpl;
  try {
    compiledInner = compileCircuit(boundary.internalCircuit, registry);
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
    const spec = resolvePinElectrical(circuitFamily);

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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
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
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
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
