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
import { hasAnalogModel, hasDigitalModel } from "../core/registry.js";
import type { TransistorModelRegistry } from "../analog/transistor-model-registry.js";
import { resolveModelAssignments, extractConnectivityGroups } from "./extract-connectivity.js";
import { partitionByDomain } from "./partition.js";
import { flattenCircuit, isSubcircuitHost } from "../engine/flatten.js";
import type { FlattenResult } from "../engine/flatten.js";
import { compileDigitalPartition } from "../engine/compiler.js";
import { compileAnalogPartition } from "../analog/compiler.js";
import { BitsException } from "../core/errors.js";
import type {
  CompiledCircuitUnified,
  BridgeAdapter,
  SignalAddress,
  Wire,
  ConnectivityGroup,
} from "./types.js";
import type { Diagnostic } from "../headless/netlist-types.js";

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
  // Step 1: Flatten subcircuits if present
  // -------------------------------------------------------------------------

  let circuit: Circuit;
  let crossEngineBoundaries: FlattenResult["crossEngineBoundaries"];

  // Only flatten when there are subcircuit elements — flattening creates new
  // Wire objects which would break wireToNetId identity for callers that hold
  // references to the original Wire instances.
  const hasSubcircuits = inputCircuit.elements.some(isSubcircuitHost);
  if (hasSubcircuits) {
    const flattenResult = flattenCircuit(inputCircuit, registry);
    circuit = flattenResult.circuit;
    crossEngineBoundaries = flattenResult.crossEngineBoundaries;
  } else {
    circuit = inputCircuit;
    crossEngineBoundaries = [];
  }

  // -------------------------------------------------------------------------
  // Step 2: Detect whether the circuit targets the analog domain.
  //
  // A circuit is analog when any of its components — including infrastructure
  // elements like Ground and VDD — has an analog model but no digital model.
  // This drives two downstream decisions:
  //   - Whether to skip digital-component validation (analog circuits may
  //     contain types not in the digital registry).
  //   - Whether to pass "analog" as the domain hint to resolveModelAssignments
  //     so dual-model components default to the analog backend.
  //
  // Ground and VDD are analog-only infrastructure and serve as the canonical
  // indicator that a circuit is wired for MNA simulation.
  // -------------------------------------------------------------------------

  const INFRASTRUCTURE = new Set([
    "Wire", "Tunnel", "Ground", "VDD", "Const", "Probe",
    "Splitter", "Driver", "NotConnected", "ScopeTrigger",
  ]);

  let hasAnalogOnlyComponent = false;
  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (def === undefined) continue;
    if (hasAnalogModel(def) && !hasDigitalModel(def)) {
      hasAnalogOnlyComponent = true;
      break;
    }
  }

  const derivedEngineType = hasAnalogOnlyComponent ? "analog" : "digital";

  if (!hasAnalogOnlyComponent) {
    for (const el of circuit.elements) {
      if (INFRASTRUCTURE.has(el.typeId)) continue;
      if (registry.get(el.typeId) === undefined) {
        throw new Error(
          `unknown component type "${el.typeId}" — ` +
          `register this component type before compiling`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2b: Resolve model assignments for each element
  // -------------------------------------------------------------------------

  const flatModelAssignments = resolveModelAssignments(circuit.elements, registry, derivedEngineType);

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
  const compiledAnalog = hasAnalog
    ? compileAnalogPartition(
        analogPartition,
        registry,
        transistorModels,
        circuit.metadata.logicFamily ?? undefined,
        circuit,
      )
    : null;

  // -------------------------------------------------------------------------
  // Step 6b: For analog circuits, inject unsupported-component-in-analog
  // diagnostics for any digital-only components that were routed to the
  // digital partition (they have no analog model).
  // -------------------------------------------------------------------------

  if (hasAnalogOnlyComponent && compiledAnalog !== null) {
    for (const el of circuit.elements) {
      if (INFRASTRUCTURE.has(el.typeId)) continue;
      const def = registry.get(el.typeId);
      if (!def) continue;
      if (def.models?.analog === undefined && def.models?.digital !== undefined) {
        compiledAnalog.diagnostics.push({
          code: "unsupported-component-in-analog",
          severity: "error",
          message: `Component "${el.typeId}" is digital-only and cannot be placed in an analog circuit`,
        });
      }
    }
  }

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

  // Map groupId → analog nodeId via compiled analog circuit's wireToNodeId
  // We derive this from the analog partition groups and the compiled analog result.
  const groupIdToAnalogNodeId = new Map<number, number>();
  if (compiledAnalog !== null) {
    for (const group of analogPartition.groups) {
      // Find the node ID by looking up any wire in this group's wireToNodeId
      for (const wire of group.wires) {
        const nodeId = compiledAnalog.wireToNodeId.get(wire);
        if (nodeId !== undefined) {
          groupIdToAnalogNodeId.set(group.groupId, nodeId);
          break;
        }
      }
      if (!groupIdToAnalogNodeId.has(group.groupId)) {
        diagnostics.push({
          severity: "warning",
          code: "unmapped-analog-group",
          message: `Analog connectivity group ${group.groupId} has no wire-based node mapping`,
        });
      }
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
      // Only add if not already set by digital (digital takes precedence for boundary labels)
      if (!labelSignalMap.has(label)) {
        labelSignalMap.set(label, { domain: "analog", nodeId });
      }
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

  // Collect analog diagnostics
  if (compiledAnalog !== null) {
    for (const d of compiledAnalog.diagnostics) {
      diagnostics.push({
        severity: d.severity === "error" ? "error" : "warning",
        code: d.code,
        message: d.message,
      });
    }
  }

  return {
    digital: compiledDigital,
    analog: compiledAnalog,
    bridges,
    wireSignalMap,
    labelSignalMap,
    diagnostics,
  };
}
