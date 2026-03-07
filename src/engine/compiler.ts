/**
 * Circuit compiler — transforms a visual Circuit into an executable
 * CompiledCircuit.
 *
 * Compilation pipeline (per spec task 3.2.1):
 *   1. Enumerate components — assign sequential component indices 0..N-1
 *   2. Trace nets — run net resolver to assign net IDs 0..M-1
 *   3. Build wiring tables — map component pins to net IDs
 *   4. SCC decomposition — Tarjan's algorithm on the dependency graph
 *   5. Topological sort — sort the condensation DAG for evaluation order
 *   6. Build function table — executeFns[] indexed by type ID
 *   7. Allocate snapshot buffer — sized to largest feedback SCC net count
 *   8. Classify sequential elements — flip-flops sampled on clock edge
 *   9. Produce CompiledCircuitImpl
 *
 */

import type { Circuit, Wire } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { ComponentRegistry, ExecuteFunction, ComponentDefinition } from "@/core/registry";
import { PropertyBag } from "@/core/properties";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { BitsException } from "@/core/errors";
import { CompiledCircuitImpl, FlatComponentLayout } from "./compiled-circuit.js";
import type { EvaluationGroup } from "./digital-engine.js";
import { findSCCs, hasSelfLoop } from "./tarjan.js";
import { topologicalSort } from "./topological-sort.js";
import { BusResolver } from "./bus-resolution.js";
import type { PullResistor } from "./bus-resolution.js";

// ---------------------------------------------------------------------------
// CompilationWarning — non-fatal issue found during compilation
// ---------------------------------------------------------------------------

export interface CompilationWarning {
  message: string;
  componentIndex?: number;
  netId?: number;
}

// ---------------------------------------------------------------------------
// Internal net tracking during net resolution
// ---------------------------------------------------------------------------

/**
 * Union-Find data structure for efficient net merging during wire tracing.
 */
class UnionFind {
  private readonly _parent: Int32Array;
  private readonly _rank: Uint8Array;

  constructor(size: number) {
    this._parent = new Int32Array(size);
    this._rank = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      this._parent[i] = i;
    }
  }

  find(x: number): number {
    let root = x;
    while (this._parent[root] !== root) {
      root = this._parent[root]!;
    }
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = this._parent[cur]!;
      this._parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this._rank[rx]! < this._rank[ry]!) {
      this._parent[rx] = ry;
    } else if (this._rank[rx]! > this._rank[ry]!) {
      this._parent[ry] = rx;
    } else {
      this._parent[ry] = rx;
      this._rank[rx]!++;
    }
  }

  connected(x: number, y: number): boolean {
    return this.find(x) === this.find(y);
  }
}

// ---------------------------------------------------------------------------
// PinReference — a resolved pin on a placed component
// ---------------------------------------------------------------------------

interface PinReference {
  element: CircuitElement;
  elementIndex: number;
  pin: Pin;
  pinIndex: number;
}

// ---------------------------------------------------------------------------
// compileCircuit — main entry point
// ---------------------------------------------------------------------------

/**
 * Transform a visual Circuit into an executable CompiledCircuitImpl.
 *
 * @param circuit   The visual circuit model (elements + wires).
 * @param registry  Component registry providing definitions and executeFns.
 * @returns         The compiled executable model.
 * @throws          Error if an element's typeId is not registered.
 * @throws          BitsException if connected pins have mismatched bit widths.
 */
export function compileCircuit(
  circuit: Circuit,
  registry: ComponentRegistry,
): CompiledCircuitImpl {
  const warnings: CompilationWarning[] = [];

  // -----------------------------------------------------------------------
  // Step 1: Enumerate components
  // -----------------------------------------------------------------------

  const elements = circuit.elements;
  const componentCount = elements.length;

  // Validate all elements are registered
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId);
    if (def === undefined) {
      throw new Error(
        `Compiler: unknown component type "${el.typeId}" at index ${i}. ` +
        `Register this component type before compiling.`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Collect all pins with their world positions
  // -----------------------------------------------------------------------

  // Build a flat list of all pins across all components.
  // pinRefs[elementIndex][pinIndex] = { element, elementIndex, pin, pinIndex }
  const allPinRefs: PinReference[][] = [];
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = el.getPins();
    const refs: PinReference[] = [];
    for (let j = 0; j < pins.length; j++) {
      refs.push({ element: el, elementIndex: i, pin: pins[j]!, pinIndex: j });
    }
    allPinRefs.push(refs);
  }

  // -----------------------------------------------------------------------
  // Step 3: Trace nets via wire endpoints and pin positions
  // -----------------------------------------------------------------------

  // Total number of "slots" = sum of all pins across all components.
  // We assign each pin a unique slot index and then union-find merge them.
  const slotCount = allPinRefs.reduce((sum, refs) => sum + refs.length, 0);

  // Build slot index: element i, pin j → slot
  const slotOf = (elemIdx: number, pinIdx: number): number => {
    let base = 0;
    for (let k = 0; k < elemIdx; k++) {
      base += allPinRefs[k]!.length;
    }
    return base + pinIdx;
  };

  // Build a map from position key to list of pin slots at that position
  const positionToSlots = new Map<string, number[]>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const pin = refs[j]!.pin;
      const wx = el.position.x + pin.position.x;
      const wy = el.position.y + pin.position.y;
      const key = `${wx},${wy}`;
      let list = positionToSlots.get(key);
      if (list === undefined) {
        list = [];
        positionToSlots.set(key, list);
      }
      list.push(slotOf(i, j));
    }
  }

  // Process wires: build adjacency between endpoints
  // Wire endpoints that land on pin positions merge those pins into one net.
  // Wire endpoints that land on other wire endpoints merge those wires into one net.

  // First, collect all endpoint positions including both wire ends.
  // We create "wire endpoint slots" beyond the pin slots for wire-to-wire junctions.
  // Simpler approach: treat wire endpoints as position points. For each wire,
  // union together the slots at its start and end positions.

  const wires = circuit.wires;

  // For each wire, find all pin slots at its endpoints and wire them together.
  // Wire endpoints that don't land on a pin are "floating wire nodes" — we
  // create virtual slots for them so wires can chain together through space.

  // Total virtual slots needed = 2 * wireCount (start + end of each wire)
  const wireVirtualBase = slotCount;
  const totalSlots = slotCount + wires.length * 2;
  const uf2 = new UnionFind(totalSlots);

  // Re-build position map including wire virtual nodes
  const posToNodes = new Map<string, number[]>();

  // Add pin slots
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const pin = refs[j]!.pin;
      const wx = el.position.x + pin.position.x;
      const wy = el.position.y + pin.position.y;
      const key = `${wx},${wy}`;
      let list = posToNodes.get(key);
      if (list === undefined) {
        list = [];
        posToNodes.set(key, list);
      }
      list.push(slotOf(i, j));
    }
  }

  // Add wire virtual nodes (2 per wire: start=wireVirtualBase+2k, end=wireVirtualBase+2k+1)
  for (let k = 0; k < wires.length; k++) {
    const wire = wires[k]!;
    const startKey = `${wire.start.x},${wire.start.y}`;
    const endKey = `${wire.end.x},${wire.end.y}`;
    const startNode = wireVirtualBase + k * 2;
    const endNode = wireVirtualBase + k * 2 + 1;

    let startList = posToNodes.get(startKey);
    if (startList === undefined) {
      startList = [];
      posToNodes.set(startKey, startList);
    }
    startList.push(startNode);

    let endList = posToNodes.get(endKey);
    if (endList === undefined) {
      endList = [];
      posToNodes.set(endKey, endList);
    }
    endList.push(endNode);

    // Merge start and end of this wire into one net
    uf2.union(startNode, endNode);
  }

  // Now merge all nodes at the same position
  for (const nodes of posToNodes.values()) {
    if (nodes.length > 1) {
      for (let m = 1; m < nodes.length; m++) {
        uf2.union(nodes[0]!, nodes[m]!);
      }
    }
  }

  // Resolve Tunnel components: all Tunnels with the same label are merged
  const tunnelsByLabel = new Map<string, number[]>(); // label → list of pin slots
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (el.typeId === "Tunnel") {
      const label = el.getAttribute("label");
      if (typeof label === "string" && label.length > 0) {
        let slots = tunnelsByLabel.get(label);
        if (slots === undefined) {
          slots = [];
          tunnelsByLabel.set(label, slots);
        }
        // Tunnel has one pin (index 0)
        slots.push(slotOf(i, 0));
      }
    }
  }
  for (const tunnelSlots of tunnelsByLabel.values()) {
    for (let m = 1; m < tunnelSlots.length; m++) {
      uf2.union(tunnelSlots[0]!, tunnelSlots[m]!);
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Assign net IDs
  // -----------------------------------------------------------------------

  // Collect unique net roots (only for pin slots — not wire virtual nodes)
  const rootToNetId = new Map<number, number>();
  let nextNetId = 0;

  for (let i = 0; i < componentCount; i++) {
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const slot = slotOf(i, j);
      const root = uf2.find(slot);
      if (!rootToNetId.has(root)) {
        rootToNetId.set(root, nextNetId++);
      }
    }
  }

  const netCount = nextNetId;

  // Build slot → netId mapping for pins
  const slotToNetId = (slot: number): number => {
    const root = uf2.find(slot);
    return rootToNetId.get(root) ?? 0;
  };

  // Build wireToNetId: each wire is assigned the net of its start node
  const wireToNetId = new Map<Wire, number>();
  for (let k = 0; k < wires.length; k++) {
    const wire = wires[k]!;
    const startNode = wireVirtualBase + k * 2;
    // Map wire node root to net ID — find which net root it's connected to
    // by checking if any pin slot shares this root
    let netId = -1;
    for (const [pinRoot, nId] of rootToNetId.entries()) {
      if (uf2.find(pinRoot) === uf2.find(startNode)) {
        netId = nId;
        break;
      }
    }
    // If wire is floating (not connected to any pin), skip it
    if (netId >= 0) {
      wireToNetId.set(wire, netId);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Determine net widths and validate bit-width consistency
  // -----------------------------------------------------------------------

  // netWidths[netId] = bit width (default 1, set from first pin found)
  const netWidths = new Uint8Array(netCount).fill(1);
  // Track the first pin label found on each net for error messages
  const netFirstPin = new Map<number, { label: string; width: number }>();

  for (let i = 0; i < componentCount; i++) {
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const slot = slotOf(i, j);
      const netId = slotToNetId(slot);
      const pin = refs[j]!.pin;
      const existing = netFirstPin.get(netId);
      if (existing === undefined) {
        netFirstPin.set(netId, { label: pin.label, width: pin.bitWidth });
        netWidths[netId] = pin.bitWidth;
      } else if (existing.width !== pin.bitWidth) {
        throw new BitsException(
          `Bit width mismatch on net ${netId}: pin "${existing.label}" has ${existing.width} bits ` +
          `but pin "${pin.label}" has ${pin.bitWidth} bits`,
          { expectedBits: existing.width, actualBits: pin.bitWidth },
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Build per-component wiring arrays
  // -----------------------------------------------------------------------

  // For each component, collect input net IDs and output net IDs in pin order.
  // We store the first input net ID offset and first output net ID offset.
  //
  // The compiler produces a "virtual net" layout: inputs and outputs are
  // not re-indexed into separate arrays. Instead, each component's executeFn
  // reads directly from state[netId] by net ID. The layout provides the
  // mapping from component slot to net ID.
  //
  // For the FlatComponentLayout, inputOffset(i) returns the net ID of the
  // first input of component i, and outputOffset(i) returns the net ID of
  // the first output of component i. This matches how the existing tests
  // and digital-engine.ts expect the layout to behave.
  //
  // Important: this layout only works correctly when the executeFn reads
  // state[inputOffset(i)], state[inputOffset(i)+1], etc. For this to work,
  // input nets must be contiguous OR the executeFn must use net IDs directly.
  // The existing tests use direct net ID access (state[netId]) rather than
  // layout arithmetic, so we need to ensure the layout correctly maps to net IDs.
  //
  // We produce a "component net ID" array for inputs and outputs separately,
  // but to satisfy the ComponentLayout interface (which returns a single offset
  // integer), we place each component's input nets and output nets in a
  // dedicated region of a "wiring array" and point inputOffset to the start.

  // Build component input/output net ID lists
  const componentInputNets: number[][] = [];
  const componentOutputNets: number[][] = [];

  for (let i = 0; i < componentCount; i++) {
    const refs = allPinRefs[i]!;
    const inputs: number[] = [];
    const outputs: number[] = [];
    for (let j = 0; j < refs.length; j++) {
      const ref = refs[j]!;
      const netId = slotToNetId(slotOf(i, j));
      if (ref.pin.direction === PinDirection.OUTPUT || ref.pin.direction === PinDirection.BIDIRECTIONAL) {
        outputs.push(netId);
      } else {
        inputs.push(netId);
      }
    }
    componentInputNets.push(inputs);
    componentOutputNets.push(outputs);
  }

  // Build flat wiring arrays.
  // We create a "net indirection" array for each component's inputs and outputs.
  // The FlatComponentLayout will return an offset into this indirection array,
  // and the executeFn uses layout.inputOffset(i) + k to address the k-th input.
  //
  // However, since the signal state array is indexed by net ID (not by wiring
  // array position), the executeFns must use net IDs directly from state[].
  // The layout provides the net ID (not a position in the state array) — this
  // is the correct contract as established by the existing test helpers.
  //
  // We pack input nets and output nets into one large "wiring table" array.
  // inputOffset(i) = index in wiringTable where component i's inputs start.
  // Each entry in wiringTable IS a net ID in the state array.

  let wiringTableSize = 0;
  const inputOffsets = new Int32Array(componentCount);
  const outputOffsets = new Int32Array(componentCount);
  const inputCounts = new Uint8Array(componentCount);
  const outputCounts = new Uint8Array(componentCount);

  // First pass: compute offsets
  let wiringPos = 0;
  for (let i = 0; i < componentCount; i++) {
    inputOffsets[i] = wiringPos;
    inputCounts[i] = componentInputNets[i]!.length;
    wiringPos += componentInputNets[i]!.length;
  }
  for (let i = 0; i < componentCount; i++) {
    outputOffsets[i] = wiringPos;
    outputCounts[i] = componentOutputNets[i]!.length;
    wiringPos += componentOutputNets[i]!.length;
  }
  wiringTableSize = wiringPos;

  // Build wiring table with net IDs
  const wiringTable = new Int32Array(wiringTableSize);
  for (let i = 0; i < componentCount; i++) {
    const inBase = inputOffsets[i]!;
    const nets = componentInputNets[i]!;
    for (let k = 0; k < nets.length; k++) {
      wiringTable[inBase + k] = nets[k]!;
    }
  }
  for (let i = 0; i < componentCount; i++) {
    const outBase = outputOffsets[i]!;
    const nets = componentOutputNets[i]!;
    for (let k = 0; k < nets.length; k++) {
      wiringTable[outBase + k] = nets[k]!;
    }
  }

  // Build per-component property maps so executeFns can read bitWidth etc.
  const componentPropertiesList: ReadonlyMap<string, import("@/core/properties").PropertyValue>[] = [];
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const propMap = new Map<string, import("@/core/properties").PropertyValue>();
    // Collect all known property keys from the element's attribute getter
    const def = registry.get(el.typeId)!;
    for (const propDef of def.propertyDefs) {
      const val = el.getAttribute(propDef.key);
      if (val !== undefined) {
        propMap.set(propDef.key, val as import("@/core/properties").PropertyValue);
      }
    }
    componentPropertiesList.push(propMap);
  }

  // -----------------------------------------------------------------------
  // Step 6b: Allocate state slots per component
  // -----------------------------------------------------------------------

  const stateOffsets = new Int32Array(componentCount);
  let totalStateSlots = 0;

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    const slotSpec = (def as ComponentDefinition & { stateSlotCount?: number | ((props: PropertyBag) => number) }).stateSlotCount;
    let resolvedSlots = 0;
    if (typeof slotSpec === "function") {
      const props = new PropertyBag(componentPropertiesList[i]!);
      resolvedSlots = slotSpec(props);
    } else if (typeof slotSpec === "number") {
      resolvedSlots = slotSpec;
    }
    stateOffsets[i] = netCount + totalStateSlots;
    totalStateSlots += resolvedSlots;
  }

  const layout = new FlatComponentLayout(
    inputOffsets,
    outputOffsets,
    inputCounts,
    outputCounts,
    wiringTable,
    componentPropertiesList,
    stateOffsets,
  );

  // -----------------------------------------------------------------------
  // Step 7: Build the dependency graph for SCC decomposition
  // -----------------------------------------------------------------------

  // adjacency[i] = list of components j such that component i depends on j
  // (i.e. i reads from a net that j writes to).
  // Build a map: netId → list of component indices that output to it
  const netDrivers = new Map<number, number[]>();

  for (let i = 0; i < componentCount; i++) {
    for (const netId of componentOutputNets[i]!) {
      let drivers = netDrivers.get(netId);
      if (drivers === undefined) {
        drivers = [];
        netDrivers.set(netId, drivers);
      }
      drivers.push(i);
    }
  }

  // adjacency[i] = list of j where i's inputs come from j's outputs
  const adjacency: number[][] = [];
  for (let i = 0; i < componentCount; i++) {
    const deps: number[] = [];
    const seen = new Set<number>();
    for (const netId of componentInputNets[i]!) {
      const drivers = netDrivers.get(netId);
      if (drivers !== undefined) {
        for (const driver of drivers) {
          if (driver !== i && !seen.has(driver)) {
            deps.push(driver);
            seen.add(driver);
          }
        }
      }
    }
    adjacency.push(deps);
  }

  // -----------------------------------------------------------------------
  // Step 7b: Detect multi-driver nets and create BusResolver
  // -----------------------------------------------------------------------

  const multiDriverNets = new Set<number>();
  let busResolver: BusResolver | null = null;
  let shadowNetCount = 0;

  for (const [netId, drivers] of netDrivers) {
    if (drivers.length > 1) {
      multiDriverNets.add(netId);
    }
  }

  if (multiDriverNets.size > 0) {
    busResolver = new BusResolver();

    // Allocate shadow driver nets: each driver of a multi-driver net gets
    // its own private net slot so components don't overwrite each other.
    // The BusResolver combines these shadow nets into the shared output net.
    let nextShadowNetId = netCount;

    // Track remapping: for each (componentIndex, outputPinIndex in componentOutputNets),
    // if the output net is multi-driver, remap to a shadow net.
    // shadowRemap[componentIndex] = Map<outputPinIndex, shadowNetId>
    const shadowRemap = new Map<number, Map<number, number>>();

    for (const sharedNetId of multiDriverNets) {
      const drivers = netDrivers.get(sharedNetId)!;

      let pull: PullResistor = "none";
      for (const driverIdx of drivers) {
        const el = elements[driverIdx]!;
        if (el.typeId === "PullUp") {
          pull = "up";
          break;
        }
        if (el.typeId === "PullDown") {
          pull = "down";
          break;
        }
      }

      const shadowNetIds: number[] = [];

      for (const driverIdx of drivers) {
        const outNets = componentOutputNets[driverIdx]!;
        for (let pinIdx = 0; pinIdx < outNets.length; pinIdx++) {
          if (outNets[pinIdx] === sharedNetId) {
            const shadowId = nextShadowNetId++;
            shadowNetIds.push(shadowId);

            let remap = shadowRemap.get(driverIdx);
            if (remap === undefined) {
              remap = new Map();
              shadowRemap.set(driverIdx, remap);
            }
            remap.set(pinIdx, shadowId);
          }
        }
      }

      busResolver.addBusNet(sharedNetId, shadowNetIds, pull);
    }

    // Apply shadow remapping to the wiring table: replace each driver's
    // output net entry with its shadow net ID so executeFns write to the
    // shadow slot instead of the shared net.
    for (const [compIdx, remap] of shadowRemap) {
      const outBase = outputOffsets[compIdx]!;
      for (const [pinIdx, shadowId] of remap) {
        wiringTable[outBase + pinIdx] = shadowId;
      }
    }

    // Track extra shadow nets for signal array sizing.
    // Shift state offsets to make room for shadow nets in the signal array.
    shadowNetCount = nextShadowNetId - netCount;
    for (let i = 0; i < componentCount; i++) {
      stateOffsets[i] += shadowNetCount;
    }
  }

  // -----------------------------------------------------------------------
  // Step 8: SCC decomposition (Tarjan's algorithm)
  // -----------------------------------------------------------------------

  const sccs = findSCCs(adjacency);

  // Classify SCCs: feedback (size > 1 or self-loop) vs. non-feedback
  const sccIsFeedback: boolean[] = sccs.map((scc, _idx) => {
    if (scc.length > 1) return true;
    // Singleton: check for self-loop
    const node = scc[0]!;
    return hasSelfLoop(adjacency, node);
  });

  // Map each component to its SCC index
  const componentToScc = new Int32Array(componentCount);
  for (let s = 0; s < sccs.length; s++) {
    for (const node of sccs[s]!) {
      componentToScc[node] = s;
    }
  }

  // Build condensation graph adjacency (SCC-level DAG)
  // condensationAdj[sccIdx] = list of sccIdx that this SCC depends on
  // (edges point from dependent SCC to dependency SCC)
  const condensationAdj: number[][] = sccs.map(() => []);
  const condensationSeen = new Set<string>();

  for (let i = 0; i < componentCount; i++) {
    const sccI = componentToScc[i]!;
    for (const j of adjacency[i]!) {
      const sccJ = componentToScc[j]!;
      if (sccI !== sccJ) {
        const key = `${sccI}-${sccJ}`;
        if (!condensationSeen.has(key)) {
          condensationSeen.add(key);
          condensationAdj[sccI]!.push(sccJ);
        }
      }
    }
  }

  // Topological sort of condensation graph
  // condensationAdj[i] lists SCCs that i depends on (i must come after them).
  // For Kahn's algorithm we need "i → j means i must come before j", so we
  // need to reverse: if sccI depends on sccJ, then sccJ must come before sccI.
  // We build a "must-come-before" adjacency for the sort.
  const forwardAdj: number[][] = sccs.map(() => []);
  for (let i = 0; i < sccs.length; i++) {
    for (const dep of condensationAdj[i]!) {
      // dep must come before i → dep → i
      forwardAdj[dep]!.push(i);
    }
  }

  const sccTopoOrder = topologicalSort(forwardAdj);

  // -----------------------------------------------------------------------
  // Step 9: Build evaluation order
  // -----------------------------------------------------------------------

  // Emit feedback warnings
  for (let s = 0; s < sccs.length; s++) {
    if (sccIsFeedback[s]) {
      const nodeNames = sccs[s]!.map((idx) => elements[idx]?.typeId ?? `#${idx}`).join(", ");
      warnings.push({
        message: `Combinational feedback loop detected among components: ${nodeNames}`,
      });
    }
  }

  // Build EvaluationGroup[] in topological order
  const evaluationOrder: EvaluationGroup[] = [];
  for (const sccIdx of sccTopoOrder) {
    const scc = sccs[sccIdx]!;
    evaluationOrder.push({
      componentIndices: new Uint32Array(scc),
      isFeedback: sccIsFeedback[sccIdx]!,
    });
  }

  // -----------------------------------------------------------------------
  // Step 10: Build function table
  // -----------------------------------------------------------------------

  // Collect all unique type IDs from definitions
  const executeFnsMap = new Map<number, ExecuteFunction>();
  const sampleFnsMap = new Map<number, ExecuteFunction>();
  const typeIds = new Uint8Array(componentCount);

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    typeIds[i] = def.typeId;
    if (!executeFnsMap.has(def.typeId)) {
      executeFnsMap.set(def.typeId, def.executeFn);
      if (def.sampleFn !== undefined) {
        sampleFnsMap.set(def.typeId, def.sampleFn);
      }
    }
  }

  // Build flat executeFns and sampleFns arrays indexed by type ID
  const maxTypeId = executeFnsMap.size > 0 ? Math.max(...executeFnsMap.keys()) : -1;
  const executeFns: ExecuteFunction[] = new Array(maxTypeId + 1);
  const sampleFns: (ExecuteFunction | null)[] = new Array(maxTypeId + 1).fill(null);
  for (const [typeId, fn] of executeFnsMap) {
    executeFns[typeId] = fn;
  }
  for (const [typeId, fn] of sampleFnsMap) {
    sampleFns[typeId] = fn;
  }

  // -----------------------------------------------------------------------
  // Step 11: Build delays array
  // -----------------------------------------------------------------------

  const DEFAULT_GATE_DELAY = 10;
  const delays = new Uint32Array(componentCount);
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    // Instance property "delay" overrides definition default
    const instanceDelay = el.getAttribute("delay");
    if (typeof instanceDelay === "number") {
      delays[i] = instanceDelay;
    } else {
      const defDelay = (def as { defaultDelay?: number }).defaultDelay;
      delays[i] = typeof defDelay === "number" ? defDelay : DEFAULT_GATE_DELAY;
    }
  }

  // -----------------------------------------------------------------------
  // Step 12: Classify sequential elements
  // -----------------------------------------------------------------------

  // Sequential elements are those whose typeId name contains "Flipflop",
  // "Register", "Counter", or is explicitly tagged via a registry field.
  // For now, identify by naming convention (Phase 5 will refine this).
  const sequentialIndices: number[] = [];
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (isSequentialComponent(el.typeId)) {
      sequentialIndices.push(i);
    }
  }
  const sequentialComponents = new Uint32Array(sequentialIndices);

  // -----------------------------------------------------------------------
  // Step 12b: Identify Reset components
  // -----------------------------------------------------------------------

  const resetIndices: number[] = [];
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (el.typeId === "Reset") {
      resetIndices.push(i);
    }
  }
  const resetComponentIndices = new Uint32Array(resetIndices);

  // -----------------------------------------------------------------------
  // Step 13: Build labelToNetId
  // -----------------------------------------------------------------------

  // Map label property of In/Out/Probe/Measurement components to net IDs
  const labelToNetId = new Map<string, number>();
  const LABELED_TYPES = new Set(["In", "Out", "Probe", "Measurement", "Clock"]);

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (LABELED_TYPES.has(el.typeId)) {
      const label = el.getAttribute("label");
      if (typeof label === "string" && label.length > 0) {
        // The first pin of In/Out/Probe is their signal pin
        const refs = allPinRefs[i]!;
        if (refs.length > 0) {
          const netId = slotToNetId(slotOf(i, 0));
          labelToNetId.set(label, netId);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 13b: Build pinNetMap
  // -----------------------------------------------------------------------

  const pinNetMap = new Map<string, number>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const netId = slotToNetId(slotOf(i, j));
      const pin = refs[j]!.pin;
      pinNetMap.set(`${el.instanceId}:${pin.label}`, netId);
    }
  }

  // -----------------------------------------------------------------------
  // Step 14: Allocate SCC snapshot buffer
  // -----------------------------------------------------------------------

  // Sized to the maximum net count touched by any feedback SCC
  let maxFeedbackNetCount = 0;
  for (let s = 0; s < sccs.length; s++) {
    if (sccIsFeedback[s]) {
      const scc = sccs[s]!;
      let netCount2 = 0;
      for (const idx of scc) {
        netCount2 += componentOutputNets[idx]!.length;
      }
      if (netCount2 > maxFeedbackNetCount) {
        maxFeedbackNetCount = netCount2;
      }
    }
  }
  const sccSnapshotBuffer = new Uint32Array(Math.max(maxFeedbackNetCount, 1));

  // -----------------------------------------------------------------------
  // Step 15: Build componentToElement map
  // -----------------------------------------------------------------------

  const componentToElement = new Map<number, CircuitElement>();
  for (let i = 0; i < componentCount; i++) {
    componentToElement.set(i, elements[i]!);
  }

  // -----------------------------------------------------------------------
  // Produce CompiledCircuitImpl
  // -----------------------------------------------------------------------

  return new CompiledCircuitImpl({
    netCount,
    componentCount,
    totalStateSlots: totalStateSlots + shadowNetCount,
    typeIds,
    executeFns,
    sampleFns,
    wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents,
    netWidths,
    sccSnapshotBuffer,
    delays,
    componentToElement,
    labelToNetId,
    wireToNetId,
    pinNetMap,
    resetComponentIndices,
    busResolver,
    multiDriverNets,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the component type name indicates a sequential element.
 * Sequential elements are evaluated on clock edges before combinational sweep.
 */
function isSequentialComponent(typeId: string): boolean {
  return (
    typeId.startsWith("Flipflop") ||
    typeId.startsWith("Register") ||
    typeId.startsWith("Counter") ||
    typeId === "DFF" ||
    typeId === "DFFSR"
  );
}
