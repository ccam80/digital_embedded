/**
 * Domain partitioner — splits a unified connectivity graph into
 * digital and analog SolverPartitions, with BridgeDescriptors at boundaries.
 *
 * Implements spec Section 4.4.
 */

import type { CircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import { hasDigitalModel, hasAnalogModel } from "../core/registry.js";
import { PinDirection } from "../core/pin.js";
import type { PinElectricalSpec } from "../core/pin-electrical.js";
import type { CrossEngineBoundary } from "../solver/digital/cross-engine-boundary.js";
import type {
  ConnectivityGroup,
  PartitionedComponent,
  SolverPartition,
  BridgeDescriptor,
  BridgeStub,
  ResolvedGroupPin,
} from "./types.js";
import type { ModelAssignment } from "./extract-connectivity.js";

// ---------------------------------------------------------------------------
// PartitionResult
// ---------------------------------------------------------------------------

export interface PartitionResult {
  digital: SolverPartition;
  analog: SolverPartition;
  bridges: BridgeDescriptor[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the bridge direction at a boundary group.
 *
 * "digital-to-analog": a digital output pin drives the net — the digital
 *   domain is the source, analog is the sink.
 * "analog-to-digital": an analog output (or no digital output) drives the
 *   net — the analog domain is the source, digital is the sink.
 *
 * Tie-break: when both domains have outputs, digital-to-analog wins (digital
 * is the event-driven driver; analog receives the threshold crossing).
 */
function bridgeDirection(
  group: ConnectivityGroup,
): "digital-to-analog" | "analog-to-digital" {
  const hasDigitalOutput = group.pins.some(
    (p) => p.domain === "digital" && p.direction === PinDirection.OUTPUT,
  );
  return hasDigitalOutput ? "digital-to-analog" : "analog-to-digital";
}

/**
 * Pick the electrical spec for a boundary group.
 *
 * Prefer the first analog-domain pin's spec (from the AnalogModel), since
 * the analog side defines electrical characteristics. Falls back to an empty
 * spec when no override is present (circuit-level logic family fills it in).
 */
function electricalSpecForGroup(
  group: ConnectivityGroup,
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
): PinElectricalSpec {
  for (const pin of group.pins) {
    if (pin.domain !== "analog") continue;
    const el = elements[pin.elementIndex];
    if (!el) continue;
    const def = registry.get(el.typeId);
    if (!def) continue;
    const analogModel = def.models?.analog;
    if (!analogModel) continue;

    const perPin = analogModel.pinElectricalOverrides?.[pin.pinLabel];
    if (perPin) return perPin;
    if (analogModel.pinElectrical) return analogModel.pinElectrical;
  }
  return {};
}

// ---------------------------------------------------------------------------
// partitionByDomain
// ---------------------------------------------------------------------------

/**
 * Partition a unified set of connectivity groups and model assignments into
 * separate digital and analog SolverPartitions, producing BridgeDescriptors
 * for every boundary group.
 *
 * Neither partition is ever null — callers check `partition.components.length`
 * to determine whether a domain is active.
 *
 * ID assignment is NOT performed here; backend compilers assign net/node IDs.
 */
export function partitionByDomain(
  groups: ConnectivityGroup[],
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
  modelAssignments: ModelAssignment[],
  crossEngineBoundaries: CrossEngineBoundary[],
): PartitionResult {
  // -------------------------------------------------------------------------
  // Step 1: Build lookup from elementIndex → ModelAssignment
  // -------------------------------------------------------------------------
  const assignmentByIndex = new Map<number, ModelAssignment>();
  for (const ma of modelAssignments) {
    assignmentByIndex.set(ma.elementIndex, ma);
  }

  // -------------------------------------------------------------------------
  // Step 2: Build per-element resolved-pins list across all groups
  // -------------------------------------------------------------------------
  const resolvedPinsByElement = new Map<number, ResolvedGroupPin[]>();
  for (const g of groups) {
    for (const pin of g.pins) {
      const list = resolvedPinsByElement.get(pin.elementIndex);
      if (list) {
        list.push(pin);
      } else {
        resolvedPinsByElement.set(pin.elementIndex, [pin]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Split components into digital / analog PartitionedComponents
  // -------------------------------------------------------------------------
  const digitalComponents: PartitionedComponent[] = [];
  const analogComponents: PartitionedComponent[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const ma = assignmentByIndex.get(i);

    // Infrastructure components (wires, tunnels, ground, etc.) have no model
    // assignment — they are handled by each backend individually.
    if (!ma) continue;

    const def = registry.get(el.typeId);
    if (!def) continue;

    // Sort resolved pins by pinIndex so compileDigitalPartition and
    // compileAnalogPartition can rely on stable pin-index order.
    const resolvedPins = (resolvedPinsByElement.get(i) ?? [])
      .slice()
      .sort((a, b) => a.pinIndex - b.pinIndex);

    const partComp: PartitionedComponent = {
      element: el,
      definition: def,
      model: ma.model,
      resolvedPins,
    };

    if (ma.modelKey === "digital") {
      digitalComponents.push(partComp);
    } else if (ma.modelKey === "analog") {
      analogComponents.push(partComp);
    } else if (ma.modelKey === "neutral") {
      // Infrastructure components (In, Out, Ground, Tunnel, etc.) carry no
      // simulation model. Route them to whichever partition is appropriate:
      // - If the component has an analog model (e.g. Ground in analog circuits),
      //   route to analog so it can be processed by the analog backend.
      // - Otherwise route to digital so the digital backend can handle wiring.
      if (hasAnalogModel(def)) {
        // Neutral components with an analog model (Ground, Probe, VDD, etc.)
        // must go to the analog partition so the analog compiler can use them
        // for ground detection and label-to-node mapping. They also go to
        // digital so the digital backend can handle wiring connections.
        analogComponents.push(partComp);
        if (hasDigitalModel(def)) {
          digitalComponents.push(partComp);
        }
      } else if (!hasDigitalModel(def)) {
        // Truly empty models (e.g. Port with models:{}) — route by the
        // connectivity group's domain. If any of this component's pins
        // belong to an analog-domain group, include in the analog partition.
        // Always include in digital for wiring.
        const touchesAnalog = resolvedPins.some((rp) => {
          for (const g of groups) {
            if (
              g.domains.has("analog") &&
              g.pins.some(
                (p) =>
                  p.elementIndex === i && p.pinIndex === rp.pinIndex,
              )
            ) {
              return true;
            }
          }
          return false;
        });
        if (touchesAnalog) {
          analogComponents.push(partComp);
        }
        digitalComponents.push(partComp);
      } else {
        digitalComponents.push(partComp);
      }
    } else {
      // Unknown model key: route based on which models are present.
      if (hasDigitalModel(def) && !hasAnalogModel(def)) {
        digitalComponents.push(partComp);
      } else {
        analogComponents.push(partComp);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Classify groups and build BridgeDescriptors
  // -------------------------------------------------------------------------
  const digitalGroups: ConnectivityGroup[] = [];
  const analogGroups: ConnectivityGroup[] = [];
  const bridges: BridgeDescriptor[] = [];

  for (const g of groups) {
    const hasDigital = g.domains.has("digital");
    const hasAnalog = g.domains.has("analog");
    const isBoundary = g.domains.size > 1;

    // A group with no domain tags (all-neutral pins) belongs to the digital
    // partition in digital circuits. In analog/mixed circuits it must also be
    // included in the analog partition — but ONLY if it contains pins from
    // elements that are in the analog partition (e.g., In/Out/Probe with
    // analog-only models). Adding ALL neutral groups would create spurious
    // MNA nodes that break the analog topology.
    const isNeutralOnly = !hasDigital && !hasAnalog;

    if (hasDigital || isNeutralOnly) digitalGroups.push(g);
    if (hasAnalog) {
      analogGroups.push(g);
    } else if (isNeutralOnly) {
      // Check if any pin in this group belongs to an analog-partition element
      const analogElementIndices = new Set(analogComponents.map(c => elements.indexOf(c.element)));
      const touchesAnalogElement = g.pins.some(p => analogElementIndices.has(p.elementIndex));
      if (touchesAnalogElement) analogGroups.push(g);
    }

    if (isBoundary) {
      const direction = bridgeDirection(g);
      const electricalSpec = electricalSpecForGroup(g, elements, registry);
      const bitWidth = g.bitWidth ?? 1;
      bridges.push({
        boundaryGroup: g,
        direction,
        bitWidth,
        electricalSpec,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Build BridgeStubs for each partition
  // -------------------------------------------------------------------------
  const digitalBridgeStubs: BridgeStub[] = [];
  const analogBridgeStubs: BridgeStub[] = [];

  for (const bd of bridges) {
    const stub: BridgeStub = {
      boundaryGroupId: bd.boundaryGroup.groupId,
      descriptor: bd,
    };
    digitalBridgeStubs.push(stub);
    analogBridgeStubs.push(stub);
  }

  // -------------------------------------------------------------------------
  // Step 6: Assemble and return partitions
  // -------------------------------------------------------------------------
  const digital: SolverPartition = {
    components: digitalComponents,
    groups: digitalGroups,
    bridgeStubs: digitalBridgeStubs,
    crossEngineBoundaries: [...crossEngineBoundaries],
  };

  const analog: SolverPartition = {
    components: analogComponents,
    groups: analogGroups,
    bridgeStubs: analogBridgeStubs,
    crossEngineBoundaries: [...crossEngineBoundaries],
  };

  return { digital, analog, bridges };
}
