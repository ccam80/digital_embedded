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
import type { ComponentRegistry, ExecuteFunction } from "@/core/registry";
import { PropertyBag } from "@/core/properties";
import type { Pin } from "@/core/pin";
import { PinDirection, pinWorldPosition } from "@/core/pin";
import { BitsException } from "@/core/errors";
import { CompiledCircuitImpl, FlatComponentLayout } from "./compiled-circuit.js";
import type { EvaluationGroup } from "./digital-engine.js";
import { findSCCs, hasSelfLoop } from "./tarjan.js";
import { topologicalSort } from "./topological-sort.js";
import { BusResolver } from "./bus-resolution.js";
import type { PullResistor } from "./bus-resolution.js";
import { traceNets } from "./net-trace.js";
import type { SolverPartition } from "@/compile/types.js";

// ---------------------------------------------------------------------------
// CompilationWarning — non-fatal issue found during compilation
// ---------------------------------------------------------------------------

export interface CompilationWarning {
  message: string;
  componentIndex?: number;
  netId?: number;
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
  // Step 2: Collect all pins (for wiring table construction in later steps)
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
  // Step 3: Trace nets via wire endpoints and pin positions (F5, F6)
  // -----------------------------------------------------------------------

  const wires = circuit.wires;

  // Delegate to shared traceNets() which uses pinWorldPosition() (F6 fix).
  const traced = traceNets(elements, wires, registry);
  const { slotToNetId: slotToNetIdArr, netCount } = traced;

  // Cumulative pin offsets for slot addressing (mirrors slotBase inside traceNets)
  const tracedSlotBase: number[] = new Array(componentCount).fill(0);
  {
    let offset = 0;
    for (let i = 0; i < componentCount; i++) {
      tracedSlotBase[i] = offset;
      offset += allPinRefs[i]!.length;
    }
  }

  const slotOf = (elemIdx: number, pinIdx: number): number =>
    tracedSlotBase[elemIdx]! + pinIdx;

  const slotToNetId = (slot: number): number => slotToNetIdArr[slot] ?? 0;

  // Build wireToNetId: assign each wire the net ID of the connected pin cluster.
  // Wires form chains — intermediate wire endpoints may not touch any pin directly.
  // We propagate net IDs through wire endpoints iteratively until stable.

  // Step A: seed posToNetId from pin world positions (using pinWorldPosition, F6)
  const posToNetId = new Map<string, number>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const pins = el.getPins();
    for (let j = 0; j < pins.length; j++) {
      const pin = pins[j]!;
      const wp = pinWorldPosition(el, pin);
      const key = `${wp.x},${wp.y}`;
      if (!posToNetId.has(key)) {
        posToNetId.set(key, slotToNetIdArr[tracedSlotBase[i]! + j] ?? 0);
      }
    }
  }

  // Step B: propagate through wires — repeat until no new positions are resolved
  let changed = true;
  while (changed) {
    changed = false;
    for (const wire of wires) {
      const sk = `${wire.start.x},${wire.start.y}`;
      const ek = `${wire.end.x},${wire.end.y}`;
      const sNet = posToNetId.get(sk);
      const eNet = posToNetId.get(ek);
      if (sNet !== undefined && eNet === undefined) {
        posToNetId.set(ek, sNet);
        changed = true;
      } else if (eNet !== undefined && sNet === undefined) {
        posToNetId.set(sk, eNet);
        changed = true;
      }
    }
  }

  // Step C: assign each wire its net ID from either endpoint
  const wireToNetId = new Map<Wire, number>();
  for (const wire of wires) {
    const sk = `${wire.start.x},${wire.start.y}`;
    const ek = `${wire.end.x},${wire.end.y}`;
    const netId = posToNetId.get(sk) ?? posToNetId.get(ek);
    if (netId !== undefined) {
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
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;

    if (def.models?.digital?.inputSchema) {
      // Schema-driven: build inputs in schema order by matching pin labels
      const inputs: number[] = [];
      for (const label of def.models.digital.inputSchema) {
        const refIdx = refs.findIndex(r => r.pin.label === label);
        if (refIdx >= 0) {
          inputs.push(slotToNetId(slotOf(i, refIdx)));
        }
      }
      componentInputNets.push(inputs);
    } else {
      // Fallback: existing behaviour — getPins() order filtered by direction
      const inputs: number[] = [];
      for (let j = 0; j < refs.length; j++) {
        const ref = refs[j]!;
        if (ref.pin.direction !== PinDirection.OUTPUT && ref.pin.direction !== PinDirection.BIDIRECTIONAL) {
          inputs.push(slotToNetId(slotOf(i, j)));
        }
      }
      componentInputNets.push(inputs);
    }

    if (def.models?.digital?.outputSchema) {
      // Schema-driven: build outputs in schema order by matching pin labels
      const outputs: number[] = [];
      for (const label of def.models.digital.outputSchema) {
        const refIdx = refs.findIndex(r => r.pin.label === label);
        if (refIdx >= 0) {
          outputs.push(slotToNetId(slotOf(i, refIdx)));
        }
      }
      componentOutputNets.push(outputs);
    } else {
      // Fallback: existing behaviour — getPins() order filtered by direction
      const outputs: number[] = [];
      for (let j = 0; j < refs.length; j++) {
        const ref = refs[j]!;
        if (ref.pin.direction === PinDirection.OUTPUT || ref.pin.direction === PinDirection.BIDIRECTIONAL) {
          outputs.push(slotToNetId(slotOf(i, j)));
        }
      }
      componentOutputNets.push(outputs);
    }
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
    const slotSpec = def.models?.digital?.stateSlotCount;
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
  // Step 7c: Classify switch components (unidirectional vs bidirectional)
  // -----------------------------------------------------------------------

  const switchClassification = new Uint8Array(componentCount);
  const bidirectionalSwitchIndices: number[] = [];

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    const sp = def.models?.digital?.switchPins;
    if (sp === undefined) continue;

    const refs = allPinRefs[i]!;
    const pinAIdx = sp[0];
    const pinBIdx = sp[1];
    if (pinAIdx >= refs.length || pinBIdx >= refs.length) continue;

    const netA = slotToNetId(slotOf(i, pinAIdx));
    const netB = slotToNetId(slotOf(i, pinBIdx));

    if (multiDriverNets.has(netA) && multiDriverNets.has(netB)) {
      switchClassification[i] = 2;
      bidirectionalSwitchIndices.push(i);
      if (busResolver !== null) {
        busResolver.registerSwitch(i, netA, netB);
      }
    } else {
      switchClassification[i] = 1;
    }
  }

  const switchComponentIndices = new Uint32Array(bidirectionalSwitchIndices);

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
  const typeNameMap = new Map<number, string>();
  const typeIds = new Uint16Array(componentCount);

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    typeIds[i] = def.typeId;
    if (!executeFnsMap.has(def.typeId)) {
      executeFnsMap.set(def.typeId, def.models!.digital!.executeFn);
      typeNameMap.set(def.typeId, def.name);
      if (def.models!.digital!.sampleFn !== undefined) {
        sampleFnsMap.set(def.typeId, def.models!.digital!.sampleFn);
      }
    }
  }

  // Build flat executeFns and sampleFns arrays indexed by type ID
  const maxTypeId = executeFnsMap.size > 0 ? Math.max(...executeFnsMap.keys()) : -1;
  const executeFns: ExecuteFunction[] = new Array(maxTypeId + 1);
  const sampleFns: (ExecuteFunction | null)[] = new Array(maxTypeId + 1).fill(null);
  const typeNames: string[] = new Array(maxTypeId + 1).fill("");
  for (const [typeId, fn] of executeFnsMap) {
    executeFns[typeId] = fn;
  }
  for (const [typeId, fn] of sampleFnsMap) {
    sampleFns[typeId] = fn;
  }
  for (const [typeId, name] of typeNameMap) {
    typeNames[typeId] = name;
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
      const defDelay = def.models?.digital?.defaultDelay;
      delays[i] = typeof defDelay === "number" ? defDelay : DEFAULT_GATE_DELAY;
    }
  }

  // -----------------------------------------------------------------------
  // Step 12: Classify sequential elements
  // -----------------------------------------------------------------------

  // Sequential elements are those whose typeId name contains "Flipflop",
  // "Register", "Counter", or is explicitly tagged via a registry field.
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
    switchComponentIndices,
    switchClassification,
    shadowNetCount,
    typeNames,
  });
}

// ---------------------------------------------------------------------------
// compileDigitalPartition — entry point for the unified netlist pipeline
// ---------------------------------------------------------------------------

/**
 * Compile a pre-partitioned digital solver partition into a CompiledCircuitImpl.
 *
 * Unlike compileCircuit(), this function receives pre-computed connectivity
 * groups and partitioned components from the unified netlist pipeline.
 * It skips traceNets() and the wire→netId propagation pass because both are
 * already encoded in the partition's groups and their wires arrays.
 *
 * All digital-specific logic (multi-driver detection, SCC decomposition,
 * topological sort, wiring table construction) is preserved unchanged.
 *
 * @param partition  Pre-partitioned digital domain (from partitionByDomain).
 * @param registry   Component registry providing definitions and executeFns.
 * @returns          The compiled executable model, identical in structure to
 *                   what compileCircuit() would produce for the same circuit.
 */
export function compileDigitalPartition(
  partition: SolverPartition,
  registry: ComponentRegistry,
): CompiledCircuitImpl {
  const { components: partitionedComponents, groups } = partition;

  // -----------------------------------------------------------------------
  // Step 1: Build element list from partitioned components
  // -----------------------------------------------------------------------

  const elements: CircuitElement[] = partitionedComponents.map(pc => pc.element);
  const componentCount = elements.length;

  // -----------------------------------------------------------------------
  // Step 2: Map groupId → sequential net ID
  // -----------------------------------------------------------------------

  // Groups are the pre-computed connectivity groups for the digital domain.
  // Assign each group a sequential net ID based on its position in the array.
  const groupIdToNetId = new Map<number, number>();
  for (let g = 0; g < groups.length; g++) {
    groupIdToNetId.set(groups[g]!.groupId, g);
  }
  const netCount = groups.length;

  // -----------------------------------------------------------------------
  // Step 3: Build pin references from partitioned component resolvedPins
  // -----------------------------------------------------------------------

  // For each component, we need PinReference[] in pin-index order.
  // resolvedPins from the partition are ordered by pin index already.
  interface PartitionPinReference {
    element: CircuitElement;
    elementIndex: number;
    pinLabel: string;
    pinIndex: number;
    direction: import("@/core/pin.js").PinDirection;
    bitWidth: number;
  }

  const allPinRefs: PartitionPinReference[][] = [];
  for (let i = 0; i < componentCount; i++) {
    const pc = partitionedComponents[i]!;
    const refs: PartitionPinReference[] = pc.resolvedPins.map((rp, j) => ({
      element: pc.element,
      elementIndex: i,
      pinLabel: rp.pinLabel,
      pinIndex: j,
      direction: rp.direction,
      bitWidth: rp.bitWidth,
    }));
    allPinRefs.push(refs);
  }

  // -----------------------------------------------------------------------
  // Step 4: Build slotToNetId from groups' pin membership
  //
  // Each ResolvedGroupPin carries an elementIndex and pinIndex that identify
  // which slot (element i, pin j) belongs to which group.
  // We build a lookup: (elementIndex, pinIndex) → netId
  // -----------------------------------------------------------------------

  // pinNetLookup[elementIndex][pinIndex] = netId
  const pinNetLookup: number[][] = new Array(componentCount).fill(null).map(() => []);

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const netId = groupIdToNetId.get(group.groupId)!;
    for (const pin of group.pins) {
      if (pin.elementIndex < componentCount) {
        const arr = pinNetLookup[pin.elementIndex]!;
        arr[pin.pinIndex] = netId;
      }
    }
  }

  // For pins not found in any group (isolated pins), assign a fresh net ID
  // starting after the group-based nets.
  let nextIsolatedNetId = netCount;
  const isolatedNetIds: number[] = [];

  for (let i = 0; i < componentCount; i++) {
    const pc = partitionedComponents[i]!;
    for (let j = 0; j < pc.resolvedPins.length; j++) {
      if (pinNetLookup[i]![j] === undefined) {
        pinNetLookup[i]![j] = nextIsolatedNetId++;
        isolatedNetIds.push(pinNetLookup[i]![j]!);
      }
    }
  }

  const totalNetCount = nextIsolatedNetId;

  const slotToNetId = (elemIdx: number, pinIdx: number): number =>
    pinNetLookup[elemIdx]?.[pinIdx] ?? 0;

  // -----------------------------------------------------------------------
  // Step 5: Build wireToNetId from groups' wires arrays
  //
  // Each group's wires array contains the Wire objects that belong to that
  // group. We map each wire to the group's net ID directly.
  // -----------------------------------------------------------------------

  const wireToNetId = new Map<Wire, number>();
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const netId = groupIdToNetId.get(group.groupId)!;
    for (const wire of group.wires) {
      wireToNetId.set(wire, netId);
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: Determine net widths from pin bit widths
  // -----------------------------------------------------------------------

  const netWidths = new Uint8Array(totalNetCount).fill(1);
  const netFirstPin = new Map<number, { label: string; width: number }>();

  for (let i = 0; i < componentCount; i++) {
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      const netId = slotToNetId(i, j);
      const ref = refs[j]!;
      const existing = netFirstPin.get(netId);
      if (existing === undefined) {
        netFirstPin.set(netId, { label: ref.pinLabel, width: ref.bitWidth });
        netWidths[netId] = ref.bitWidth;
      } else if (existing.width !== ref.bitWidth) {
        throw new BitsException(
          `Bit width mismatch on net ${netId}: pin "${existing.label}" has ${existing.width} bits ` +
          `but pin "${ref.pinLabel}" has ${ref.bitWidth} bits`,
          { expectedBits: existing.width, actualBits: ref.bitWidth },
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 7: Build per-component wiring arrays (input/output net IDs)
  // -----------------------------------------------------------------------

  const componentInputNets: number[][] = [];
  const componentOutputNets: number[][] = [];

  for (let i = 0; i < componentCount; i++) {
    const refs = allPinRefs[i]!;
    const el = elements[i]!;
    const def = registry.get(el.typeId);
    if (def === undefined) {
      throw new Error(
        `Compiler: unknown component type "${el.typeId}" at index ${i}. ` +
        `Register this component type before compiling.`,
      );
    }

    if (def.models?.digital?.inputSchema) {
      const inputs: number[] = [];
      for (const label of def.models.digital.inputSchema) {
        const refIdx = refs.findIndex(r => r.pinLabel === label);
        if (refIdx >= 0) {
          inputs.push(slotToNetId(i, refIdx));
        }
      }
      componentInputNets.push(inputs);
    } else {
      const inputs: number[] = [];
      for (let j = 0; j < refs.length; j++) {
        const ref = refs[j]!;
        if (ref.direction !== PinDirection.OUTPUT && ref.direction !== PinDirection.BIDIRECTIONAL) {
          inputs.push(slotToNetId(i, j));
        }
      }
      componentInputNets.push(inputs);
    }

    if (def.models?.digital?.outputSchema) {
      const outputs: number[] = [];
      for (const label of def.models.digital.outputSchema) {
        const refIdx = refs.findIndex(r => r.pinLabel === label);
        if (refIdx >= 0) {
          outputs.push(slotToNetId(i, refIdx));
        }
      }
      componentOutputNets.push(outputs);
    } else {
      const outputs: number[] = [];
      for (let j = 0; j < refs.length; j++) {
        const ref = refs[j]!;
        if (ref.direction === PinDirection.OUTPUT || ref.direction === PinDirection.BIDIRECTIONAL) {
          outputs.push(slotToNetId(i, j));
        }
      }
      componentOutputNets.push(outputs);
    }
  }

  // Build flat wiring arrays
  let wiringTableSize = 0;
  const inputOffsets = new Int32Array(componentCount);
  const outputOffsets = new Int32Array(componentCount);
  const inputCounts = new Uint8Array(componentCount);
  const outputCounts = new Uint8Array(componentCount);

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

  // Build per-component property maps
  const componentPropertiesList: ReadonlyMap<string, import("@/core/properties").PropertyValue>[] = [];
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const propMap = new Map<string, import("@/core/properties").PropertyValue>();
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
  // Step 7b: Allocate state slots per component
  // -----------------------------------------------------------------------

  const stateOffsets = new Int32Array(componentCount);
  let totalStateSlots = 0;

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    const slotSpec = def.models?.digital?.stateSlotCount;
    let resolvedSlots = 0;
    if (typeof slotSpec === "function") {
      const props = new PropertyBag(componentPropertiesList[i]!);
      resolvedSlots = slotSpec(props);
    } else if (typeof slotSpec === "number") {
      resolvedSlots = slotSpec;
    }
    stateOffsets[i] = totalNetCount + totalStateSlots;
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
  // Step 8: Build dependency graph for SCC decomposition
  // -----------------------------------------------------------------------

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
  // Step 8b: Multi-driver detection and BusResolver
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
    let nextShadowNetId = totalNetCount;
    const shadowRemap = new Map<number, Map<number, number>>();

    for (const sharedNetId of multiDriverNets) {
      const drivers = netDrivers.get(sharedNetId)!;

      let pull: PullResistor = "none";
      for (const driverIdx of drivers) {
        const el = elements[driverIdx]!;
        if (el.typeId === "PullUp") { pull = "up"; break; }
        if (el.typeId === "PullDown") { pull = "down"; break; }
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

    for (const [compIdx, remap] of shadowRemap) {
      const outBase = outputOffsets[compIdx]!;
      for (const [pinIdx, shadowId] of remap) {
        wiringTable[outBase + pinIdx] = shadowId;
      }
    }

    shadowNetCount = nextShadowNetId - totalNetCount;
    for (let i = 0; i < componentCount; i++) {
      stateOffsets[i] += shadowNetCount;
    }
  }

  // -----------------------------------------------------------------------
  // Step 8c: Classify switch components
  // -----------------------------------------------------------------------

  const switchClassification = new Uint8Array(componentCount);
  const bidirectionalSwitchIndices: number[] = [];

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    const sp = def.models?.digital?.switchPins;
    if (sp === undefined) continue;

    const refs = allPinRefs[i]!;
    const pinAIdx = sp[0];
    const pinBIdx = sp[1];
    if (pinAIdx >= refs.length || pinBIdx >= refs.length) continue;

    const netA = slotToNetId(i, pinAIdx);
    const netB = slotToNetId(i, pinBIdx);

    if (multiDriverNets.has(netA) && multiDriverNets.has(netB)) {
      switchClassification[i] = 2;
      bidirectionalSwitchIndices.push(i);
      if (busResolver !== null) {
        busResolver.registerSwitch(i, netA, netB);
      }
    } else {
      switchClassification[i] = 1;
    }
  }

  const switchComponentIndices = new Uint32Array(bidirectionalSwitchIndices);

  // -----------------------------------------------------------------------
  // Step 9: SCC decomposition and topological sort
  // -----------------------------------------------------------------------

  const sccs = findSCCs(adjacency);
  const sccIsFeedback: boolean[] = sccs.map((scc) => {
    if (scc.length > 1) return true;
    return hasSelfLoop(adjacency, scc[0]!);
  });

  const componentToScc = new Int32Array(componentCount);
  for (let s = 0; s < sccs.length; s++) {
    for (const node of sccs[s]!) {
      componentToScc[node] = s;
    }
  }

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

  const forwardAdj: number[][] = sccs.map(() => []);
  for (let i = 0; i < sccs.length; i++) {
    for (const dep of condensationAdj[i]!) {
      forwardAdj[dep]!.push(i);
    }
  }
  const sccTopoOrder = topologicalSort(forwardAdj);

  // -----------------------------------------------------------------------
  // Step 10: Build evaluation order
  // -----------------------------------------------------------------------

  const evaluationOrder: EvaluationGroup[] = [];
  for (const sccIdx of sccTopoOrder) {
    const scc = sccs[sccIdx]!;
    evaluationOrder.push({
      componentIndices: new Uint32Array(scc),
      isFeedback: sccIsFeedback[sccIdx]!,
    });
  }

  // -----------------------------------------------------------------------
  // Step 11: Build function table
  // -----------------------------------------------------------------------

  const executeFnsMap = new Map<number, ExecuteFunction>();
  const sampleFnsMap = new Map<number, ExecuteFunction>();
  const typeNameMap = new Map<number, string>();
  const typeIds = new Uint16Array(componentCount);

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    typeIds[i] = def.typeId;
    if (!executeFnsMap.has(def.typeId)) {
      executeFnsMap.set(def.typeId, def.models!.digital!.executeFn);
      typeNameMap.set(def.typeId, def.name);
      if (def.models!.digital!.sampleFn !== undefined) {
        sampleFnsMap.set(def.typeId, def.models!.digital!.sampleFn);
      }
    }
  }

  const maxTypeId = executeFnsMap.size > 0 ? Math.max(...executeFnsMap.keys()) : -1;
  const executeFns: ExecuteFunction[] = new Array(maxTypeId + 1);
  const sampleFns: (ExecuteFunction | null)[] = new Array(maxTypeId + 1).fill(null);
  const typeNames: string[] = new Array(maxTypeId + 1).fill("");
  for (const [typeId, fn] of executeFnsMap) { executeFns[typeId] = fn; }
  for (const [typeId, fn] of sampleFnsMap) { sampleFns[typeId] = fn; }
  for (const [typeId, name] of typeNameMap) { typeNames[typeId] = name; }

  // -----------------------------------------------------------------------
  // Step 12: Build delays array
  // -----------------------------------------------------------------------

  const DEFAULT_GATE_DELAY = 10;
  const delays = new Uint32Array(componentCount);
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const def = registry.get(el.typeId)!;
    const instanceDelay = el.getAttribute("delay");
    if (typeof instanceDelay === "number") {
      delays[i] = instanceDelay;
    } else {
      const defDelay = def.models?.digital?.defaultDelay;
      delays[i] = typeof defDelay === "number" ? defDelay : DEFAULT_GATE_DELAY;
    }
  }

  // -----------------------------------------------------------------------
  // Step 13: Classify sequential elements
  // -----------------------------------------------------------------------

  const sequentialIndices: number[] = [];
  for (let i = 0; i < componentCount; i++) {
    if (isSequentialComponent(elements[i]!.typeId)) {
      sequentialIndices.push(i);
    }
  }
  const sequentialComponents = new Uint32Array(sequentialIndices);

  // -----------------------------------------------------------------------
  // Step 13b: Identify Reset components
  // -----------------------------------------------------------------------

  const resetIndices: number[] = [];
  for (let i = 0; i < componentCount; i++) {
    if (elements[i]!.typeId === "Reset") {
      resetIndices.push(i);
    }
  }
  const resetComponentIndices = new Uint32Array(resetIndices);

  // -----------------------------------------------------------------------
  // Step 14: Build labelToNetId
  // -----------------------------------------------------------------------

  const labelToNetId = new Map<string, number>();
  const LABELED_TYPES = new Set(["In", "Out", "Probe", "Measurement", "Clock"]);

  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    if (LABELED_TYPES.has(el.typeId)) {
      const label = el.getAttribute("label");
      if (typeof label === "string" && label.length > 0) {
        const refs = allPinRefs[i]!;
        if (refs.length > 0) {
          labelToNetId.set(label, slotToNetId(i, 0));
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 14b: Build pinNetMap
  // -----------------------------------------------------------------------

  const pinNetMap = new Map<string, number>();
  for (let i = 0; i < componentCount; i++) {
    const el = elements[i]!;
    const refs = allPinRefs[i]!;
    for (let j = 0; j < refs.length; j++) {
      pinNetMap.set(`${el.instanceId}:${refs[j]!.pinLabel}`, slotToNetId(i, j));
    }
  }

  // -----------------------------------------------------------------------
  // Step 15: Allocate SCC snapshot buffer
  // -----------------------------------------------------------------------

  let maxFeedbackNetCount = 0;
  for (let s = 0; s < sccs.length; s++) {
    if (sccIsFeedback[s]) {
      let count = 0;
      for (const idx of sccs[s]!) {
        count += componentOutputNets[idx]!.length;
      }
      if (count > maxFeedbackNetCount) maxFeedbackNetCount = count;
    }
  }
  const sccSnapshotBuffer = new Uint32Array(Math.max(maxFeedbackNetCount, 1));

  // -----------------------------------------------------------------------
  // Step 16: Build componentToElement map
  // -----------------------------------------------------------------------

  const componentToElement = new Map<number, CircuitElement>();
  for (let i = 0; i < componentCount; i++) {
    componentToElement.set(i, elements[i]!);
  }

  // -----------------------------------------------------------------------
  // Produce CompiledCircuitImpl
  // -----------------------------------------------------------------------

  return new CompiledCircuitImpl({
    netCount: totalNetCount,
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
    switchComponentIndices,
    switchClassification,
    shadowNetCount,
    typeNames,
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
    typeId === "DFF" ||
    typeId === "DFFSR" ||
    // TS component names
    typeId === "D_FF" ||
    typeId === "JK_FF" ||
    typeId === "RS_FF" ||
    typeId === "T_FF" ||
    typeId === "D_FF_AS" ||
    typeId === "JK_FF_AS" ||
    typeId === "RS_FF_AS" ||
    typeId === "Monoflop" ||
    typeId.startsWith("Register") ||
    typeId.startsWith("Counter")
  );
}
