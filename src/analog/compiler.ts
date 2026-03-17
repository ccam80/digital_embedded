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

import type { Circuit } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { SolverDiagnostic } from "../core/analog-engine-interface.js";
import { buildNodeMap } from "./node-map.js";
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
import type { FlattenResult, SubcircuitHost } from "../engine/flatten.js";
import type { CrossEngineBoundary } from "../engine/cross-engine-boundary.js";
import type { BridgeInstance } from "./bridge-instance.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter, BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";
import { compileCircuit } from "../engine/compiler.js";
import type { CompiledCircuitImpl } from "../engine/compiled-circuit.js";
import type { LogicFamilyConfig } from "../core/logic-family.js";

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
    nodeIndices: [nodePos, nodeNeg],
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
function resolveElementNodes(
  el: CircuitElement,
  wireToNodeId: Map<import("../core/circuit.js").Wire, number>,
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
// Topology validation
// ---------------------------------------------------------------------------

/**
 * Detect floating nodes: nodes that appear as terminals of only one element.
 *
 * A floating node has no current path (only one element connected to it).
 * This makes the MNA system unsolvable or ill-conditioned.
 */
function detectFloatingNodes(
  elements: Array<{ nodeIds: number[] }>,
  nodeCount: number,
): number[] {
  // Count how many element terminals touch each node (excluding ground = 0).
  const terminalCount = new Array<number>(nodeCount + 1).fill(0);
  for (const el of elements) {
    for (const n of el.nodeIds) {
      if (n >= 0 && n <= nodeCount) {
        terminalCount[n]++;
      }
    }
  }
  const floating: number[] = [];
  for (let n = 1; n <= nodeCount; n++) {
    if (terminalCount[n] <= 1) {
      floating.push(n);
    }
  }
  return floating;
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
  if ("crossEngineBoundaries" in circuitOrResult) {
    circuit = circuitOrResult.circuit;
    crossEngineBoundaries = circuitOrResult.crossEngineBoundaries;
  } else {
    circuit = circuitOrResult;
    crossEngineBoundaries = [];
  }

  // Step 1: Verify engine type
  if (circuit.metadata.engineType !== "analog") {
    throw new Error(
      `compileAnalogCircuit: circuit engineType must be "analog", ` +
        `got "${circuit.metadata.engineType}"`,
    );
  }

  // Step 2: Build node map — assigns wire groups to MNA node IDs, ground = 0
  const nodeMap = buildNodeMap(circuit);

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

    // Ground elements do not need an analog factory — they are structural.
    if (el.typeId === "Ground" || el.typeId === "ground") {
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
    const et = def.engineType ?? "digital";
    if (et !== "analog" && et !== "both") {
      diagnostics.push(
        makeDiagnostic(
          "unsupported-component-in-analog",
          "error",
          `Component "${el.typeId}" is digital-only and cannot be placed in an analog circuit`,
          {
            explanation:
              `Component "${el.typeId}" has engineType="${et}" with no analogFactory. ` +
              `Only components with engineType "analog" or "both" (with analogFactory) ` +
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

    // Transistor-mode components are expanded in Pass B — skip branch/node allocation here.
    if (et === "both") {
      const passAProps = el.getProperties();
      const passAMode = passAProps.has("simulationMode")
        ? (passAProps.get("simulationMode") as string)
        : "behavioral";
      if (passAMode === "transistor") {
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
    if (def.requiresBranchRow) {
      // The actual matrix row = nodeCount + branchIdx (0-based within branch block)
      // We store the absolute branch index here; the matrix row is computed
      // as nodeCount_total + branchIdx when building the matrix.
      branchIdx = branchCount++;
    }

    // Allocate internal nodes
    const props = el.getProperties();
    const internalCount = def.getInternalNodeCount?.(props) ?? 0;
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

  // Step 5 & 6: Resolve pin nodes and call analogFactory for each element
  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();

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

    // Ground elements: skip factory, just record for topology
    if (el.typeId === "Ground" || el.typeId === "ground") {
      continue;
    }

    const def = registry.get(el.typeId)!;
    const props = el.getProperties();

    // Skip digital-only components (diagnostic already emitted in Pass A)
    const elEngineType = def.engineType ?? "digital";
    if (elEngineType !== "analog" && elEngineType !== "both") {
      continue;
    }

    // Handle simulationMode property for "both" components
    if (elEngineType === "both" && def.analogFactory !== undefined) {
      const simulationMode = props.has("simulationMode")
        ? (props.get("simulationMode") as string)
        : "behavioral";

      if (simulationMode === "digital") {
        diagnostics.push(
          makeDiagnostic(
            "digital-bridge-not-yet-implemented",
            "info",
            `Component "${el.typeId}" is set to simulationMode 'digital' — bridge not yet available`,
            {
              explanation:
                `The digital bridge (Phase 4b) is not yet implemented. ` +
                `Component "${el.typeId}" will be skipped in analog compilation. ` +
                `Set simulationMode to 'behavioral' to simulate this component.`,
            },
          ),
        );
        continue;
      }

      if (simulationMode === "transistor") {
        if (!transistorModels) {
          diagnostics.push(
            makeDiagnostic(
              "missing-transistor-model",
              "error",
              `Component "${el.typeId}" is set to simulationMode 'transistor' but no TransistorModelRegistry was provided`,
              {
                explanation:
                  `Pass a TransistorModelRegistry as the third argument to compileAnalogCircuit() ` +
                  `when compiling circuits with transistor-level components.`,
              },
            ),
          );
          continue;
        }

        // Resolve outer pin node IDs for this component
        const outerPinNodeIds = resolveElementNodes(el, nodeMap.wireToNodeId, circuit);

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
          topologyInfo.push({
            nodeIds: Array.from(expEl.nodeIndices),
            isBranch: expEl.branchIndex >= 0,
            typeHint: expEl.branchIndex >= 0
              ? expEl.isReactive ? "inductor" : "voltage"
              : "other",
          });
        }
        continue;
      }
    }

    // Resolve pin → node ID bindings
    const pinNodeIds = resolveElementNodes(el, nodeMap.wireToNodeId, circuit);

    // Build the full nodeIds array: external pin nodes + internal nodes
    const nodeIds = [...pinNodeIds];
    if (meta.internalNodeCount > 0) {
      for (let i = 0; i < meta.internalNodeCount; i++) {
        nodeIds.push(meta.internalNodeOffset + i);
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
    // override, and per-pin overrides, then inject via _pinElectrical into the
    // props bag before calling analogFactory.
    if (elEngineType === "both" && def.analogFactory !== undefined) {
      const pinLabels = def.pinLayout.map((pd) => pd.label);
      const pinElectricalMap: Record<string, ResolvedPinElectrical> = {};
      for (const pinLabel of pinLabels) {
        const pinOverride = def.pinElectricalOverrides?.[pinLabel];
        const componentOverride = def.pinElectrical;
        pinElectricalMap[pinLabel] = resolvePinElectrical(
          circuitFamily,
          pinOverride,
          componentOverride,
        );
      }
      props.set("_pinElectrical", pinElectricalMap as unknown as import("../core/properties.js").PropertyValue);
    }

    // Model binding: semiconductor components get resolved model parameters
    // injected into the props bag under '_modelParams' before factory call.
    let resolvedProps = props;
    if (def.analogDeviceType !== undefined) {
      const modelName = typeof props["model"] === "string" ? props["model"] as string : "";
      const resolvedModel =
        (modelName !== "" ? modelLibrary.get(modelName) : undefined) ??
        modelLibrary.getDefault(def.analogDeviceType);

      // Emit diagnostics for any issues with the resolved model
      const modelDiags = validateModel(resolvedModel);
      diagnostics.push(...modelDiags);

      resolvedProps = { ...props, _modelParams: resolvedModel.params };
    }

    // Call the analog factory
    const element = def.analogFactory!(nodeIds, absoluteBranchIdx, resolvedProps, getTime);

    const elementIndex = analogElements.length;
    analogElements.push(element);
    elementToCircuitElement.set(elementIndex, el);

    // Record topology info for validation
    topologyInfo.push({
      nodeIds: pinNodeIds,
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

  // Check for floating nodes (only meaningful if we have external nodes)
  if (totalNodeCount > 0) {
    const floatingNodes = detectFloatingNodes(topologyInfo, totalNodeCount);
    for (const nodeId of floatingNodes) {
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

  // Re-check missing ground (buildNodeMap already handles this, but the spec
  // says the compiler re-checks). If nodeMap already emitted a no-ground
  // diagnostic we don't duplicate it.
  const hasGroundDiag = nodeMap.diagnostics.some((d) => d.code === "no-ground");
  if (!hasGroundDiag) {
    const hasGround = circuit.elements.some(
      (el) => el.typeId === "Ground" || el.typeId === "ground",
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
    const et = def.engineType ?? "digital";
    if (et !== "analog" && et !== "both") continue;

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
      pinPos = pin.position;
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
