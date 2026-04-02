/**
 * resolveNets — compiler steps 1-5 without full compilation.
 *
 * Runs pin collection, union-find wire tracing, net ID assignment, and
 * width validation. Returns a Netlist with all diagnostics collected
 * (never throws for structural issues such as width mismatches).
 */

import type { Circuit } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { Pin } from '../core/pin.js';
import { PinDirection } from '../core/pin.js';
import type {
  Netlist,
  NetDescriptor,
  NetPin,
  ComponentDescriptor,
  PinDescriptor,
} from './netlist-types.js';
import type { Diagnostic } from '../compile/types.js';
import type { PropertyValue } from '../core/properties.js';
import { UnionFind } from '../compile/union-find.js';
import { pinWorldPosition } from '../core/pin.js';
import { getComponentLabel } from './address.js';

// ---------------------------------------------------------------------------
// resolveNets — public entry point
// ---------------------------------------------------------------------------

/**
 * Extract a netlist from a circuit without full compilation.
 *
 * Runs the same union-find net resolution as the compiler (steps 1-5).
 * Collects all diagnostics instead of throwing on the first error.
 *
 * @param circuit   The visual circuit model.
 * @param registry  Component registry (used to enumerate registered types).
 * @returns         Netlist with components, nets, and diagnostics.
 * @throws          Error if an element's typeId is not registered.
 */
export function resolveNets(circuit: Circuit, registry: ComponentRegistry): Netlist {
  const diagnostics: Diagnostic[] = [];
  const elements = circuit.elements;
  const componentCount = elements.length;

  // -------------------------------------------------------------------------
  // Step 1: Enumerate components — validate all types are registered
  // -------------------------------------------------------------------------

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId);
    if (def === undefined) {
      throw new Error(
        `resolveNets: unknown component type "${el.typeId}" at index ${i}. ` +
        `Register this component type before calling resolveNets.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Collect all pins (needed for descriptor building in later steps)
  // -------------------------------------------------------------------------

  // allPins[i] = resolved pins for element i (in local coords from getPins())
  const allPins: ReadonlyArray<readonly Pin[]> = elements.map((el) => el.getPins());

  // -------------------------------------------------------------------------
  // Step 3: Trace nets via wire endpoints and pin positions
  // -------------------------------------------------------------------------

  const wires = circuit.wires;

  // Cumulative pin offsets for slot addressing
  const slotBase: number[] = new Array(componentCount).fill(0);
  let totalPinSlots = 0;
  {
    let offset = 0;
    for (let i = 0; i < componentCount; i++) {
      slotBase[i] = offset;
      offset += allPins[i]!.length;
    }
    totalPinSlots = offset;
  }

  const wireVirtualBase = totalPinSlots;
  const totalSlots = totalPinSlots + wires.length * 2;
  const uf = new UnionFind(totalSlots);
  const posToNodes = new Map<string, number[]>();

  const addNode = (key: string, node: number): void => {
    let list = posToNodes.get(key);
    if (list === undefined) {
      list = [];
      posToNodes.set(key, list);
    }
    list.push(node);
  };

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const pin = pins[j]!;
      const wp = pinWorldPosition(el, pin);
      addNode(`${wp.x},${wp.y}`, slotBase[i]! + j);
    }
  }

  for (let k = 0; k < wires.length; k++) {
    const wire = wires[k]!;
    const startNode = wireVirtualBase + k * 2;
    const endNode = wireVirtualBase + k * 2 + 1;
    addNode(`${wire.start.x},${wire.start.y}`, startNode);
    addNode(`${wire.end.x},${wire.end.y}`, endNode);
    uf.union(startNode, endNode);
  }

  for (const nodes of posToNodes.values()) {
    if (nodes.length > 1) {
      for (let m = 1; m < nodes.length; m++) {
        uf.union(nodes[0]!, nodes[m]!);
      }
    }
  }

  // Merge Tunnel components with the same label
  const tunnelsByLabel = new Map<string, number[]>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (el.typeId === 'Tunnel') {
      const label = el.getAttribute('label');
      if (typeof label === 'string' && label.length > 0) {
        let slots = tunnelsByLabel.get(label);
        if (slots === undefined) {
          slots = [];
          tunnelsByLabel.set(label, slots);
        }
        slots.push(slotBase[i]! + 0);
      }
    }
  }
  for (const tunnelSlots of tunnelsByLabel.values()) {
    for (let m = 1; m < tunnelSlots.length; m++) {
      uf.union(tunnelSlots[0]!, tunnelSlots[m]!);
    }
  }

  // Assign net IDs from union-find roots (pin slots only)
  const rootToNetId = new Map<number, number>();
  let nextNetId = 0;
  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotBase[i]! + j;
      const root = uf.find(slot);
      if (!rootToNetId.has(root)) {
        rootToNetId.set(root, nextNetId++);
      }
    }
  }
  const netCount = nextNetId;
  const slotToNetIdArr: number[] = new Array(totalPinSlots).fill(0);
  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotBase[i]! + j;
      const root = uf.find(slot);
      slotToNetIdArr[slot] = rootToNetId.get(root) ?? 0;
    }
  }

  const slotOf = (elemIdx: number, pinIdx: number): number =>
    slotBase[elemIdx]! + pinIdx;

  const slotToNetId = (slot: number): number => slotToNetIdArr[slot] ?? 0;

  // -------------------------------------------------------------------------
  // Step 5: Determine net widths and collect width-mismatch diagnostics
  // -------------------------------------------------------------------------

  // netWidths[netId] = agreed width, or -1 when pins disagree
  const netWidths: number[] = new Array(netCount).fill(0);
  // For each net: track first pin seen (for error messages and NetPin context)
  const netFirstSlot = new Map<number, { elemIdx: number; pinIdx: number; width: number }>();

  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotOf(i, j);
      const netId = slotToNetId(slot);
      const pin = pins[j]!;
      const existing = netFirstSlot.get(netId);
      if (existing === undefined) {
        netFirstSlot.set(netId, { elemIdx: i, pinIdx: j, width: pin.bitWidth });
        netWidths[netId] = pin.bitWidth;
      } else if (existing.width !== pin.bitWidth) {
        // Mark net as conflicted
        netWidths[netId] = -1;
        // Will emit diagnostic after building NetPin structures (below)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build intermediate data: per-net pin membership
  // netPinEntries[netId] = list of { elemIdx, pinIdx }
  // -------------------------------------------------------------------------

  const netPinEntries: Array<Array<{ elemIdx: number; pinIdx: number }>> = [];
  for (let n = 0; n < netCount; n++) {
    netPinEntries.push([]);
  }

  for (let i = 0; i < componentCount; i++) {
    const pins = allPins[i]!;
    for (let j = 0; j < pins.length; j++) {
      const slot = slotOf(i, j);
      const netId = slotToNetId(slot);
      netPinEntries[netId]!.push({ elemIdx: i, pinIdx: j });
    }
  }

  // -------------------------------------------------------------------------
  // Build NetPin factory helper
  // -------------------------------------------------------------------------

  const pinDomain = (elemIdx: number): 'digital' | 'analog' => {
    const def = registry.get(elements[elemIdx]!.typeId);
    return def?.modelRegistry !== undefined ? 'analog' : 'digital';
  };

  const makeNetPin = (elemIdx: number, pinIdx: number): NetPin => {
    const el = elements[elemIdx]!;
    const pin = allPins[elemIdx]![pinIdx]!;
    const componentLabel = getComponentLabel(el) ?? el.instanceId;
    return {
      componentIndex: elemIdx,
      componentType: el.typeId,
      componentLabel,
      pinLabel: pin.label,
      domain: pinDomain(elemIdx),
    };
  };

  // -------------------------------------------------------------------------
  // Collect width-mismatch diagnostics now that we can build NetPin[]
  // -------------------------------------------------------------------------

  // We need to find nets where widths disagree. Re-scan to collect all pins per net.
  // netWidths[netId] === -1 means conflicted.
  for (let netId = 0; netId < netCount; netId++) {
    if (netWidths[netId] !== -1) continue;

    // Collect all pins on this net and group by width
    const entries = netPinEntries[netId]!;
    const pinsByWidth = new Map<number, NetPin[]>();
    for (const { elemIdx, pinIdx } of entries) {
      const w = allPins[elemIdx]![pinIdx]!.bitWidth;
      let group = pinsByWidth.get(w);
      if (group === undefined) {
        group = [];
        pinsByWidth.set(w, group);
      }
      group.push(makeNetPin(elemIdx, pinIdx));
    }

    // Emit one diagnostic per conflicting pair of widths
    const widths = Array.from(pinsByWidth.keys());
    const w0 = widths[0]!;
    const w1 = widths[1] ?? widths[0]!;
    // Build a human-readable description of which pins are involved
    const pinDescs = entries.map(({ elemIdx, pinIdx }) => {
      const np = makeNetPin(elemIdx, pinIdx);
      const w = allPins[elemIdx]![pinIdx]!.bitWidth;
      const name = np.componentLabel || np.componentType;
      return `${name}:${np.pinLabel} [${w}-bit]`;
    });
    diagnostics.push({
      severity: "error",
      code: "width-mismatch",
      message:
        `Bit-width mismatch: ${pinDescs.join(" \u2194 ")} ` +
        `(widths: ${widths.join(", ")})`,
      netId,
      involvedElements: entries.map(({ elemIdx }) => elemIdx),
      suggestions: [{ text: `Ensure all pins on this net have the same bit width (e.g. ${w0} or ${w1}).`, automatable: false }],
    });
  }

  // -------------------------------------------------------------------------
  // Build NetDescriptor[]
  // -------------------------------------------------------------------------

  const nets: NetDescriptor[] = [];
  for (let netId = 0; netId < netCount; netId++) {
    const entries = netPinEntries[netId]!;
    const netPins: NetPin[] = entries.map(({ elemIdx, pinIdx }) =>
      makeNetPin(elemIdx, pinIdx),
    );
    const width = netWidths[netId] === -1 ? undefined : (netWidths[netId] ?? 1);
    // Determine net domain: analog if any pin on the net is analog
    const domain: 'digital' | 'analog' | 'mixed' = entries.some(
      ({ elemIdx }) => pinDomain(elemIdx) === 'analog',
    )
      ? entries.some(({ elemIdx }) => pinDomain(elemIdx) === 'digital')
        ? 'mixed'
        : 'analog'
      : 'digital';
    const netDesc: NetDescriptor = width !== undefined
      ? { netId, domain, bitWidth: width, pins: netPins }
      : { netId, domain, pins: netPins };
    nets.push(netDesc);
  }

  // -------------------------------------------------------------------------
  // Collect unconnected-input and multi-driver-no-tristate diagnostics
  // -------------------------------------------------------------------------

  for (let netId = 0; netId < netCount; netId++) {
    const entries = netPinEntries[netId]!;

    // Unconnected input: net has exactly 1 pin and it's an INPUT
    if (entries.length === 1) {
      const { elemIdx, pinIdx } = entries[0]!;
      const pin = allPins[elemIdx]![pinIdx]!;
      if (pin.direction === PinDirection.INPUT) {
        const np = makeNetPin(elemIdx, pinIdx);
        diagnostics.push({
          severity: "warning",
          code: "unconnected-input",
          message:
            `Unconnected input pin "${np.pinLabel}" on component ` +
            `"${np.componentLabel}" (${np.componentType})`,
          netId,
          involvedElements: [elemIdx],
          suggestions: [{ text: `Connect this input pin to a signal source.`, automatable: false }],
        });
      }
    }

    // Multi-driver: net has more than one OUTPUT pin (warning — could be tri-state)
    const outputPins = entries.filter(
      ({ elemIdx, pinIdx }) =>
        allPins[elemIdx]![pinIdx]!.direction === PinDirection.OUTPUT,
    );
    if (outputPins.length > 1) {
      diagnostics.push({
        severity: "warning",
        code: "multi-driver-no-tristate",
        message:
          `Net ${netId} has ${outputPins.length} output drivers. ` +
          `This is valid only when all drivers support tri-state (high-Z) output or the net is an analog node.`,
        netId,
        involvedElements: outputPins.map(({ elemIdx }) => elemIdx),
        suggestions: [{ text: `For digital: use tri-state outputs or ensure only one driver is active. For analog: this is normal (node sums currents).`, automatable: false }],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Build ComponentDescriptor[] with PinDescriptor.connectedTo populated
  // -------------------------------------------------------------------------

  const components: ComponentDescriptor[] = [];

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = allPins[i]!;

    // Collect properties from registry property definitions
    const def = registry.get(el.typeId)!;
    const properties: Record<string, PropertyValue> = {};
    for (const propDef of def.propertyDefs) {
      const val = el.getAttribute(propDef.key);
      if (val !== undefined) {
        properties[propDef.key] = val;
      }
    }

    const label = getComponentLabel(el);

    const pinDescriptors: PinDescriptor[] = pins.map((pin, j) => {
      const slot = slotOf(i, j);
      const netId = slotToNetId(slot);
      const thisNetEntries = netPinEntries[netId]!;

      // connectedTo = all OTHER pins on the same net
      const connectedTo: NetPin[] = thisNetEntries
        .filter(({ elemIdx, pinIdx }) => !(elemIdx === i && pinIdx === j))
        .map(({ elemIdx, pinIdx }) => makeNetPin(elemIdx, pinIdx));

      return {
        label: pin.label,
        domain: pinDomain(i),
        direction: pin.direction,
        bitWidth: pin.bitWidth,
        netId: thisNetEntries.length > 0 ? netId : -1,
        connectedTo,
      };
    });

    const modelAttr = el.getAttribute('model');
    const modelKey = typeof modelAttr === 'string' ? modelAttr : 'digital';

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
