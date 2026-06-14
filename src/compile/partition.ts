/**
 * Domain partitioner- splits a unified connectivity graph into
 * digital and analog SolverPartitions, with BridgeDescriptors at boundaries.
 *
 * Implements spec Section 4.4.
 */

import type { CircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import { PinDirection } from "../core/pin.js";
import type { PinElectricalSpec } from "../core/pin-electrical.js";
import type {
  ConnectivityGroup,
  PartitionedComponent,
  SolverPartition,
  BridgePinDescriptor,
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
  bridges: BridgePinDescriptor[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the per-pin electrical spec for ONE crossing digital pin from its
 * own component definition, using the standard override cascade
 * (pinElectricalOverrides[pinLabel] ?? pinElectrical ?? {}). The circuit-level
 * logic family fills any unspecified field later, in resolvePinElectrical.
 */
function electricalSpecForPin(
  pin: ResolvedGroupPin,
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
): PinElectricalSpec {
  const el = elements[pin.elementIndex];
  if (!el) return {};
  const def = registry.getStandalone(el.typeId);
  if (!def) return {};
  return def.pinElectricalOverrides?.[pin.pinLabel] ?? def.pinElectrical ?? {};
}

// ---------------------------------------------------------------------------
// partitionByDomain
// ---------------------------------------------------------------------------

/**
 * Partition a unified set of connectivity groups and model assignments into
 * separate digital and analog SolverPartitions, producing BridgeDescriptors
 * for every boundary group.
 *
 * Neither partition is ever null- callers check `partition.components.length`
 * to determine whether a domain is active.
 *
 * ID assignment is NOT performed here; backend compilers assign net/node IDs.
 */
export function partitionByDomain(
  groups: ConnectivityGroup[],
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
  modelAssignments: ModelAssignment[],
  _digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  _perNetLoadingOverrides?: ReadonlyMap<number, "loaded" | "ideal">,
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
    // assignment- they are handled by each backend individually.
    if (!ma) continue;

    const def = registry.getStandalone(el.typeId);
    if (!def) continue;

    // Sort resolved pins by pinIndex so compileDigitalPartition and
    // compileAnalogPartition can rely on stable pin-index order.
    const resolvedPins = (resolvedPinsByElement.get(i) ?? [])
      .slice()
      .sort((a, b) => a.pinIndex - b.pinIndex);

    const partComp: PartitionedComponent = {
      element: el,
      definition: def,
      modelKey: ma.modelKey,
      model: ma.model,
      resolvedPins,
    };

    if (ma.modelKey === "digital") {
      digitalComponents.push(partComp);
    } else if (ma.modelKey === "analog") {
      analogComponents.push(partComp);
    } else if (ma.modelKey === "neutral") {
      // Infrastructure components (In, Out, Ground, Tunnel, etc.) carry no
      // simulation model. Route by which connectivity groups they touch:
      // - If any pin connects to an analog-domain net, include in the analog
      //   partition so the analog backend can process wiring.
      // - Always include in digital for wiring connections.
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
      const domain = ma.modelKey === "digital" ? "digital" : "analog";
      if (domain === "digital") {
        digitalComponents.push(partComp);
      } else {
        analogComponents.push(partComp);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Classify groups and build per-pin BridgePinDescriptors
  // -------------------------------------------------------------------------
  const digitalGroups: ConnectivityGroup[] = [];
  const analogGroups: ConnectivityGroup[] = [];
  const bridges: BridgePinDescriptor[] = [];

  // Synthetic group IDs for the per-pin private digital nets must not collide
  // with real group IDs. Real group IDs come from extractConnectivityGroups
  // (0..groups.length-1); start synthetic IDs past the max.
  let nextSyntheticGroupId =
    groups.reduce((m, g) => Math.max(m, g.groupId), -1) + 1;

  for (const g of groups) {
    const hasDigital = g.domains.has("digital");
    const hasAnalog = g.domains.has("analog");
    const isBoundary = g.domains.size > 1;

    // A group with no domain tags (all-neutral pins) belongs to the digital
    // partition in digital circuits. In analog/mixed circuits it must also be
    // included in the analog partition- but ONLY if it contains pins from
    // elements that are in the analog partition (e.g., In/Out/Probe with
    // analog-only models). Adding ALL neutral groups would create spurious
    // MNA nodes that break the analog topology.
    const isNeutralOnly = !hasDigital && !hasAnalog;

    // For a BOUNDARY group, the merged group is NOT pushed onto the digital
    // partition: each crossing digital pin gets its OWN singleton digital
    // group below so the digital backend mints a private net per pin. A
    // non-boundary digital (or neutral-only) group is pushed as-is.
    if (!isBoundary && (hasDigital || isNeutralOnly)) digitalGroups.push(g);
    if (hasAnalog) {
      analogGroups.push(g);
    } else if (isNeutralOnly) {
      // Check if any pin in this group belongs to an analog-partition element
      const analogElementIndices = new Set(analogComponents.map(c => elements.indexOf(c.element)));
      const touchesAnalogElement = g.pins.some(p => analogElementIndices.has(p.elementIndex));
      if (touchesAnalogElement) analogGroups.push(g);
    }

    if (isBoundary) {
      const bitWidth = g.bitWidth ?? 1;
      // One descriptor + one singleton private digital group per crossing
      // digital pin. The analog hub group (g) is kept in analogGroups above
      // and nothing pins it.
      for (const pin of g.pins) {
        if (pin.domain !== "digital") continue;
        const el = elements[pin.elementIndex];
        const instanceId = el?.instanceId ?? `el${pin.elementIndex}`;
        const pinKey = `${instanceId}:${pin.pinLabel}`;
        const role: "output" | "input" =
          pin.direction === PinDirection.OUTPUT ? "output" : "input";

        // Private singleton digital group: same single pin, no wires, digital
        // domain only. Gives the digital compiler an isolated net to address.
        const privateGroupId = nextSyntheticGroupId++;
        const privatePin: ResolvedGroupPin = { ...pin };
        const privateGroup: ConnectivityGroup = {
          groupId: privateGroupId,
          pins: [privatePin],
          wires: [],
          domains: new Set(["digital"]),
          bitWidth,
        };
        digitalGroups.push(privateGroup);

        bridges.push({
          boundaryGroup: g,
          analogGroupId: g.groupId,
          pinKey,
          pinLabel: pin.pinLabel,
          elementIndex: pin.elementIndex,
          pinIndex: pin.pinIndex,
          role,
          isTriState: role === "output",
          bitWidth,
          electricalSpec: electricalSpecForPin(pin, elements, registry),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Build BridgeStubs for each partition
  // -------------------------------------------------------------------------
  const digitalBridgeStubs: BridgeStub[] = [];
  const analogBridgeStubs: BridgeStub[] = [];

  for (const bd of bridges) {
    const stub: BridgeStub = {
      pinKey: bd.pinKey,
      analogGroupId: bd.analogGroupId,
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
  };

  const analog: SolverPartition = {
    components: analogComponents,
    groups: analogGroups,
    bridgeStubs: analogBridgeStubs,
  };

  return { digital, analog, bridges };
}
