/**
 * resolveNets- delegates to compilation infrastructure for connectivity.
 *
 * Uses resolveModelAssignments + extractConnectivityGroups as the single
 * source of truth, then builds the Netlist view types from their output.
 */

import type { Circuit } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import type {
  Netlist,
  NetDescriptor,
  NetPin,
  ComponentDescriptor,
  PinDescriptor,
} from './netlist-types.js';
import type { Diagnostic } from '../compile/types.js';
import type { PropertyValue } from '../core/properties.js';
import type { ConnectivityGroup, ResolvedGroupPin } from '../compile/types.js';
import type { ModelAssignment } from '../compile/extract-connectivity.js';
import type { CircuitElement } from '../core/element.js';
import { resolveModelAssignments, extractConnectivityGroups } from '../compile/extract-connectivity.js';
import { getComponentLabel } from './address.js';

// ---------------------------------------------------------------------------
// resolveNets- public entry point
// ---------------------------------------------------------------------------

/**
 * Extract a netlist from a circuit without full compilation.
 *
 * Delegates to the compilation infrastructure (resolveModelAssignments +
 * extractConnectivityGroups) for connectivity, then builds the Netlist
 * view types from their output.
 *
 * @param circuit   The visual circuit model.
 * @param registry  Component registry (used to enumerate registered types).
 * @returns         Netlist with components, nets, and diagnostics.
 */
export function resolveNets(circuit: Circuit, registry: ComponentRegistry): Netlist {
  const [assignments, assignDiags] = resolveModelAssignments(circuit.elements, registry);
  const [groups, groupDiags] = extractConnectivityGroups(
    circuit.elements, circuit.wires, registry, assignments,
  );
  return buildNetlistView(
    circuit.elements, registry, assignments, groups,
    [...assignDiags, ...groupDiags],
  );
}

// ---------------------------------------------------------------------------
// buildNetlistView- transform compilation types into Netlist view types
// ---------------------------------------------------------------------------

function buildNetlistView(
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
  assignments: ModelAssignment[],
  groups: ConnectivityGroup[],
  diagnostics: Diagnostic[],
): Netlist {
  // Build a lookup: (elementIndex, pinIndex) → groupId
  const pinToGroupId = new Map<string, number>();
  for (const group of groups) {
    for (const pin of group.pins) {
      pinToGroupId.set(`${pin.elementIndex}:${pin.pinIndex}`, group.groupId);
    }
  }

  // Build a lookup: groupId → group (for cross-referencing)
  const groupById = new Map<number, ConnectivityGroup>();
  for (const group of groups) {
    groupById.set(group.groupId, group);
  }

  // Helper: map a ResolvedGroupPin to a NetPin
  const toNetPin = (rp: ResolvedGroupPin): NetPin => {
    const el = elements[rp.elementIndex]!;
    const componentLabel = getComponentLabel(el) ?? el.instanceId;
    return {
      componentIndex: rp.elementIndex,
      componentType: el.typeId,
      componentLabel,
      pinLabel: rp.pinLabel,
      domain: rp.domain === 'neutral' ? 'digital' : rp.domain,
    };
  };

  // -------------------------------------------------------------------------
  // Build NetDescriptor[]
  // -------------------------------------------------------------------------

  const nets: NetDescriptor[] = groups.map((group) => {
    // Derive net domain from group.domains
    const hasDigital = group.domains.has('digital');
    const hasAnalog = group.domains.has('analog');
    const domain: 'digital' | 'analog' | 'mixed' =
      hasDigital && hasAnalog ? 'mixed'
        : hasAnalog ? 'analog'
          : 'digital';

    const pins: NetPin[] = group.pins.map(toNetPin);

    const netDesc: NetDescriptor = group.bitWidth !== undefined
      ? { netId: group.groupId, domain, bitWidth: group.bitWidth, pins }
      : { netId: group.groupId, domain, pins };

    return netDesc;
  });

  // -------------------------------------------------------------------------
  // Build ComponentDescriptor[] with PinDescriptor.connectedTo populated
  // -------------------------------------------------------------------------

  const components: ComponentDescriptor[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const assignment = assignments[i]!;
    const elPins = el.getPins();

    // Collect properties from registry property definitions
    const def = registry.getStandalone(el.typeId);
    const properties: Record<string, PropertyValue> = {};
    if (def) {
      for (const propDef of def.propertyDefs) {
        const val = el.getAttribute(propDef.key);
        if (val !== undefined) {
          properties[propDef.key] = val;
        }
      }
    }

    const label = getComponentLabel(el);

    const pinDescriptors: PinDescriptor[] = elPins.map((pin, j) => {
      const groupId = pinToGroupId.get(`${i}:${j}`);
      const group = groupId !== undefined ? groupById.get(groupId) : undefined;

      // Find the ResolvedGroupPin for this element/pin to get its domain
      let pinDomain = 'digital';
      if (group) {
        const resolved = group.pins.find(
          (rp) => rp.elementIndex === i && rp.pinIndex === j,
        );
        if (resolved) {
          pinDomain = resolved.domain === 'neutral' ? 'digital' : resolved.domain;
        }
      }

      // connectedTo = all OTHER pins on the same group/net
      const connectedTo: NetPin[] = [];
      if (group) {
        for (const rp of group.pins) {
          if (rp.elementIndex === i && rp.pinIndex === j) continue;
          connectedTo.push(toNetPin(rp));
        }
      }

      return {
        label: pin.label,
        domain: pinDomain,
        direction: pin.direction,
        bitWidth: pin.bitWidth,
        netId: group ? group.groupId : -1,
        connectedTo,
      };
    });

    const modelKey = assignment.modelKey === 'neutral' ? 'digital' : assignment.modelKey;

    components.push({
      index: i,
      typeId: el.typeId,
      label,
      instanceId: el.instanceId,
      pins: pinDescriptors,
      properties,
      modelKey,
    });
  }

  return { components, nets, diagnostics };
}
