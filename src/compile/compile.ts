/**
 * Unified compilation entry point — Phase 3.
 *
 * Orchestrates the full pipeline from a visual Circuit to a
 * CompiledCircuitUnified containing compiled digital and/or analog domains,
 * bridge adapters, wire-to-signal and label-to-signal maps, and diagnostics.
 *
 * Pipeline (spec Section 4 flowchart):
 *  1. resolveModelAssignments  — assign each component to a domain
 *  2. flattenCircuit           — inline same-domain subcircuits
 *  3. extractConnectivityGroups — unified netlist extraction
 *  4. partitionByDomain        — split into digital/analog partitions + bridges
 *  5. compileDigitalPartition  — compile digital domain (if non-empty)
 *  6. compileAnalogPartition   — compile analog domain (if non-empty)
 *  7. Build bridge cross-reference map
 *  8. Build wireSignalMap
 *  9. Build labelSignalMap
 * 10. Assemble CompiledCircuitUnified
 */

import type { Circuit } from "../core/circuit.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { TransistorModelRegistry } from "../solver/analog/transistor-model-registry.js";
import { resolveModelAssignments, extractConnectivityGroups, resolveLoadingOverrides, INFRASTRUCTURE_TYPES } from "./extract-connectivity.js";
import { partitionByDomain } from "./partition.js";
import { flattenCircuit, isSubcircuitHost } from "../solver/digital/flatten.js";
import type { FlattenResult } from "../solver/digital/flatten.js";
import { compileDigitalPartition } from "../solver/digital/compiler.js";
import { compileAnalogPartition } from "../solver/analog/compiler.js";
import { BitsException } from "../core/errors.js";
import type {
  CompiledCircuitUnified,
  BridgeAdapter,
  SignalAddress,
  Wire,
  ConnectivityGroup,
  DigitalCompilerFn,
} from "./types.js";
import type { Diagnostic } from "./types.js";

// ---------------------------------------------------------------------------
// compileUnified — public entry point
// ---------------------------------------------------------------------------

/**
 * Compile a circuit through the unified Phase 3 pipeline.
 *
 * @param inputCircuit      The visual circuit model.
 * @param registry          Component registry providing definitions and models.
 * @param transistorModels  Optional transistor model registry for analog BJT/MOSFET.
 * @returns                 CompiledCircuitUnified with both domains, bridges, and maps.
 */
export function compileUnified(
  inputCircuit: Circuit,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): CompiledCircuitUnified {
  const diagnostics: Diagnostic[] = [];

  // -------------------------------------------------------------------------
  // Step 1: Resolve model assignments for each element
  // -------------------------------------------------------------------------

  const [inputModelAssignments, inputModelDiags] = resolveModelAssignments(inputCircuit.elements, registry);
  diagnostics.push(...inputModelDiags);

  // -------------------------------------------------------------------------
  // Step 2: Flatten subcircuits if present (uses pre-resolved model assignments
  // for cross-engine boundary detection)
  // -------------------------------------------------------------------------

  let circuit: Circuit;
  let crossEngineBoundaries: FlattenResult["crossEngineBoundaries"];

  // Only flatten when there are subcircuit elements — flattening creates new
  // Wire objects which would break wireToNetId identity for callers that hold
  // references to the original Wire instances.
  const hasSubcircuits = inputCircuit.elements.some(isSubcircuitHost);
  if (hasSubcircuits) {
    const flattenResult = flattenCircuit(inputCircuit, registry, inputModelAssignments);
    circuit = flattenResult.circuit;
    crossEngineBoundaries = flattenResult.crossEngineBoundaries;
  } else {
    circuit = inputCircuit;
    crossEngineBoundaries = [];
  }

  // Resolve model assignments for the (possibly flattened) circuit.
  // When there are no subcircuits the flat circuit equals the input circuit
  // and we reuse the assignments already computed above.
  let flatModelAssignments: import('./extract-connectivity.js').ModelAssignment[];
  if (hasSubcircuits) {
    const [flatAssignments, flatModelDiags] = resolveModelAssignments(circuit.elements, registry);
    diagnostics.push(...flatModelDiags);
    flatModelAssignments = flatAssignments;
  } else {
    flatModelAssignments = inputModelAssignments;
  }

  // Validate that all non-infrastructure components are registered when the
  // circuit has no analog-only components (pure digital circuits).
  const hasAnalogOnlyComponent = flatModelAssignments.some((a) => {
    const el = circuit.elements[a.elementIndex];
    if (!el) return false;
    const def = registry.get(el.typeId);
    if (!def) return false;
    return a.modelKey !== 'digital' && a.modelKey !== 'neutral';
  });

  if (!hasAnalogOnlyComponent) {
    for (const el of circuit.elements) {
      if (INFRASTRUCTURE_TYPES.has(el.typeId)) continue;
      if (registry.get(el.typeId) === undefined) {
        throw new Error(
          `unknown component type "${el.typeId}" — ` +
          `register this component type before compiling`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Extract connectivity groups (unified netlist)
  // -------------------------------------------------------------------------

  const [groups, connectivityDiagnostics] = extractConnectivityGroups(
    circuit.elements,
    circuit.wires,
    registry,
    flatModelAssignments,
  );
  diagnostics.push(...connectivityDiagnostics);

  // Resolve per-net loading overrides (maps groupId → 'loaded'|'ideal')
  const overrides = circuit.metadata.digitalPinLoadingOverrides ?? [];
  const { resolved: perNetLoadingOverrides, diagnostics: overrideDiags } =
    resolveLoadingOverrides(overrides, groups, circuit.elements);
  diagnostics.push(...overrideDiags);

  // -------------------------------------------------------------------------
  // Step 4: Partition by domain
  // -------------------------------------------------------------------------

  const { digital: digitalPartition, analog: analogPartition, bridges: bridgeDescriptors } =
    partitionByDomain(
      groups,
      circuit.elements,
      registry,
      flatModelAssignments,
      crossEngineBoundaries,
      circuit.metadata.digitalPinLoading ?? "cross-domain",
      perNetLoadingOverrides,
    );

  // -------------------------------------------------------------------------
  // Step 5: Compile digital domain
  //
  // Always compile when the circuit is digital or has digital components so
  // that error-throwing paths (unregistered component, bit-width mismatch) are
  // reached. For a pure-analog circuit with no digital components at all, skip.
  // -------------------------------------------------------------------------

  const isAnalogOnly = hasAnalogOnlyComponent && digitalPartition.components.length === 0;
  const hasDigitalComponents = digitalPartition.components.length > 0;
  let compiledDigital: ReturnType<typeof compileDigitalPartition> | null = null;
  if (!isAnalogOnly && hasDigitalComponents) {
    try {
      compiledDigital = compileDigitalPartition(digitalPartition, registry);
    } catch (e) {
      if (e instanceof BitsException) {
        diagnostics.push({ severity: "error", code: "width-mismatch", message: e.message });
      } else {
        throw e;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Compile analog domain (if partition is non-empty)
  // -------------------------------------------------------------------------

  const hasAnalog = analogPartition.components.length > 0;
  const innerDigitalCompiler: DigitalCompilerFn = (innerCircuit, innerRegistry) =>
    compileUnified(innerCircuit, innerRegistry).digital!;
  const compiledAnalog = hasAnalog
    ? compileAnalogPartition(
        analogPartition,
        registry,
        transistorModels,
        circuit.metadata.logicFamily ?? undefined,
        circuit,
        innerDigitalCompiler,
        circuit.metadata.digitalPinLoading ?? "cross-domain",
        perNetLoadingOverrides,
      )
    : null;

  // -------------------------------------------------------------------------
  // Step 7: Build groupId → netId/nodeId lookup maps for bridge cross-reference
  // -------------------------------------------------------------------------

  // Map groupId → digital netId (index of group in digital partition's groups array)
  const groupIdToDigitalNetId = new Map<number, number>();
  if (compiledDigital !== null) {
    const digitalGroups = digitalPartition.groups;
    for (let i = 0; i < digitalGroups.length; i++) {
      groupIdToDigitalNetId.set(digitalGroups[i]!.groupId, i);
    }
  }

  // Map groupId → analog nodeId via the analog compiler's groupToNodeId.
  // This is authoritative — it handles zero-wire groups (direct pin overlap)
  // that the old wire-based lookup missed.
  const groupIdToAnalogNodeId = new Map<number, number>();
  if (compiledAnalog !== null) {
    const concreteAnalog = compiledAnalog as import("../solver/analog/compiled-analog-circuit.js").ConcreteCompiledAnalogCircuit;
    for (const [groupId, nodeId] of concreteAnalog.groupToNodeId) {
      groupIdToAnalogNodeId.set(groupId, nodeId);
    }
  }

  // -------------------------------------------------------------------------
  // Step 8: Build wireSignalMap
  //
  // For digital-only groups: wire → { domain: "digital", netId, bitWidth }
  // For analog-only groups:  wire → { domain: "analog", nodeId }
  // For boundary groups: use digital address (renderer can resolve analog via bridge)
  // -------------------------------------------------------------------------

  const wireSignalMap = new Map<Wire, SignalAddress>();
  const pinSignalMap = new Map<string, SignalAddress>();

  // Build two coordinate-keyed lookups:
  //   coordToSignalAddr — keyed by "x,y" for any pin world position in a group
  //   wireKeyToSignalAddr — keyed by "x1,y1→x2,y2" for flat wire objects in groups
  //
  // flattenCircuit() creates new Wire objects so group.wires differ from
  // circuit.wires by reference. Some wires (e.g. point wires where start==end)
  // may also not appear in group.wires at all if the union-find root for the
  // wire's virtual slot is not a pin slot root. The pin-position map covers
  // both cases: a wire at position (x,y) belongs to the group whose pins are
  // at (x,y).
  const pinPosToSignalAddr = new Map<string, SignalAddress>();
  const wireKeyToSignalAddr = new Map<string, SignalAddress>();

  for (const group of groups) {
    const isDigital = group.domains.has("digital");
    const isAnalog = group.domains.has("analog");

    let addr: SignalAddress | undefined;
    if (isDigital) {
      const netId = groupIdToDigitalNetId.get(group.groupId) ?? 0;
      const bitWidth = group.bitWidth ?? 1;
      addr = { domain: "digital", netId, bitWidth };
    } else if (isAnalog) {
      const nodeId = groupIdToAnalogNodeId.get(group.groupId) ?? 0;
      addr = { domain: "analog", nodeId };
    }

    if (addr !== undefined) {
      for (const wire of group.wires) {
        wireSignalMap.set(wire, addr);
        const k1 = `${wire.start.x},${wire.start.y}→${wire.end.x},${wire.end.y}`;
        const k2 = `${wire.end.x},${wire.end.y}→${wire.start.x},${wire.start.y}`;
        wireKeyToSignalAddr.set(k1, addr);
        wireKeyToSignalAddr.set(k2, addr);
      }
      for (const pin of group.pins) {
        const pk = `${pin.worldPosition.x},${pin.worldPosition.y}`;
        pinPosToSignalAddr.set(pk, addr);
        // Build pinSignalMap: "instanceId:pinLabel" → signal address
        const el = circuit.elements[pin.elementIndex];
        if (el) {
          pinSignalMap.set(`${el.instanceId}:${pin.pinLabel}`, addr);
        }
      }
    }
  }

  // Map original circuit wires using coordinate lookup.
  // A wire belongs to the group whose pin positions match its endpoints.
  for (const wire of circuit.wires) {
    if (wireSignalMap.has(wire)) continue;
    // Try exact wire key match first (handles non-point wires)
    const wk = `${wire.start.x},${wire.start.y}→${wire.end.x},${wire.end.y}`;
    const addrByKey = wireKeyToSignalAddr.get(wk);
    if (addrByKey !== undefined) {
      wireSignalMap.set(wire, addrByKey);
      continue;
    }
    // Fall back to pin-position lookup (handles point wires and wires whose
    // flat copy had a different union-find root that excluded them from group.wires)
    const sk = `${wire.start.x},${wire.start.y}`;
    const ek = `${wire.end.x},${wire.end.y}`;
    const addrByPin = pinPosToSignalAddr.get(sk) ?? pinPosToSignalAddr.get(ek);
    if (addrByPin !== undefined) {
      wireSignalMap.set(wire, addrByPin);
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: Build labelSignalMap
  //
  // For each In/Out/Probe label, map to the appropriate SignalAddress.
  // Use the compiled results' labelToNetId / labelToNodeId maps directly.
  // -------------------------------------------------------------------------

  const labelSignalMap = new Map<string, SignalAddress>();

  if (compiledDigital !== null) {
    for (const [label, netId] of compiledDigital.labelToNetId) {
      const bitWidth = netId < compiledDigital.netWidths.length
        ? compiledDigital.netWidths[netId] ?? 1
        : 1;
      labelSignalMap.set(label, { domain: "digital", netId, bitWidth });
    }
  }

  if (compiledAnalog !== null) {
    for (const [label, nodeId] of compiledAnalog.labelToNodeId) {
      // Analog takes precedence when a label exists in both maps. This
      // happens for neutral components like Port that are routed to both
      // partitions: the digital compiler creates a spurious net-based
      // mapping (value 0), while the analog compiler maps to the correct
      // MNA node with the solved voltage.
      labelSignalMap.set(label, { domain: "analog", nodeId });
    }
  }

  // -------------------------------------------------------------------------
  // Step 10: Assemble bridge adapters
  // -------------------------------------------------------------------------

  const bridges: BridgeAdapter[] = [];

  for (const bd of bridgeDescriptors) {
    const boundaryGroupId = bd.boundaryGroup.groupId;
    const digitalNetId = groupIdToDigitalNetId.get(boundaryGroupId) ?? 0;
    const analogNodeId = groupIdToAnalogNodeId.get(boundaryGroupId) ?? 0;

    bridges.push({
      boundaryGroupId,
      digitalNetId,
      analogNodeId,
      direction: bd.direction,
      bitWidth: bd.bitWidth,
      electricalSpec: bd.electricalSpec,
    });
  }

  // -------------------------------------------------------------------------
  // Step 10b: Emit diagnostics for digital-only components in mixed-signal
  // circuits that are NOT bridge-connected.
  //
  // A bridge-connected component participates in a boundary group (its element
  // index appears in a boundary group's pin list). Such components are handled
  // by bridge adapters and do not need an analog model. Components that are
  // digital-only and have no bridge connection cannot be simulated in an
  // analog circuit.
  // -------------------------------------------------------------------------

  if (analogPartition.components.length > 0) {
    // Build a set of element indices that participate in any boundary group.
    const bridgeElementIndices = new Set<number>();
    for (const bd of bridgeDescriptors) {
      for (const pin of bd.boundaryGroup.pins) {
        bridgeElementIndices.add(pin.elementIndex);
      }
    }

    for (const pc of digitalPartition.components) {
      const def = registry.get(pc.element.typeId);
      if (!def || (def.models?.mnaModels && Object.keys(def.models.mnaModels).length > 0)) continue; // has mna model — fine
      if (INFRASTRUCTURE_TYPES.has(pc.element.typeId)) continue; // infrastructure — no-op wiring element
      const elementIndex = circuit.elements.indexOf(pc.element);
      if (bridgeElementIndices.has(elementIndex)) continue; // bridge-connected — fine
      // A digital-only component whose pins are all in digital-domain groups
      // is a normal digital component handled by the digital engine — skip it.
      // Only flag components that actually touch an analog-domain group but
      // lack an MNA model to participate in it.
      const touchesAnalogGroup = pc.resolvedPins.some((rp) =>
        groups.some((g) =>
          g.domains.has("analog") &&
          g.pins.some((p) => p.elementIndex === elementIndex && p.pinIndex === rp.pinIndex),
        ),
      );
      if (!touchesAnalogGroup) continue;
      diagnostics.push({
        severity: "error",
        code: "unsupported-component-in-analog",
        message: `Component "${pc.element.typeId}" (${pc.element.instanceId}) is digital-only and cannot be simulated in an analog circuit`,
      });
    }
  }

  // Collect analog diagnostics
  if (compiledAnalog !== null) {
    for (const d of compiledAnalog.diagnostics) {
      diagnostics.push({
        severity: d.severity === "error" ? "error" : "warning",
        code: d.code,
        message: d.summary,
      });
    }
  }

  return {
    digital: compiledDigital,
    analog: compiledAnalog,
    bridges,
    wireSignalMap,
    labelSignalMap,
    pinSignalMap,
    diagnostics,
    allCircuitElements: circuit.elements,
  };
}
