/**
 * Analog circuit compiler.
 *
 * Transforms a visual `Circuit` containing analog components into a
 * `ConcreteCompiledAnalogCircuit` that the MNA engine can simulate.
 *
 * Steps:
 *  1. Build node map (wire groups → MNA node IDs, ground = 0)
 *  2. Resolve subcircuit-backed models into MnaModel factories
 *  3. Resolve pin→node bindings for each element
 *  4. Call factory for each element
 *  5. Topology validation (floating nodes, voltage-source loops, inductor loops)
 *  6. Return ConcreteCompiledAnalogCircuit
 */

import { Circuit } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { ComponentRegistry } from "../../core/registry.js";
import { resolvePinLayout } from "../../core/registry.js";
import type { Diagnostic } from "../../compile/types.js";
import { pinWorldPosition } from "../../core/pin.js";
import type { ResolvedPin } from "../../core/pin.js";
import type { ResolvedGroupPin } from "../../compile/types.js";
import { PropertyBag } from "../../core/properties.js";
import { makeDiagnostic } from "./diagnostics.js";
import { paramDefDefaults } from "../../core/model-params.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  ConcreteCompiledAnalogCircuit,
  type DeviceModel,
} from "./compiled-analog-circuit.js";
import { defaultLogicFamily } from "../../core/logic-family.js";
import { resolvePinElectrical } from "../../core/pin-electrical.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter } from "./bridge-adapter.js";
import type { BridgeOutputAdapter, BridgeInputAdapter } from "./bridge-adapter.js";
import type { LogicFamilyConfig } from "../../core/logic-family.js";
import type { SolverPartition, PartitionedComponent, DigitalCompilerFn, ComponentDefinition, MnaModel } from "../../compile/types.js";
import type { ModelEntry } from "../../core/registry.js";
import { StatePool } from "./state-pool.js";
import { isPoolBacked, type AnalogElement } from "./element.js";
import { NGSPICE_LOAD_ORDER, getNgspiceLoadOrderByTypeId, TYPE_ID_TO_DECK_PIN_LABEL_ORDER } from "./ngspice-load-order.js";
import {
  buildTopologyInfo,
  runCompileTimeDetectors,
} from "./topology-diagnostics.js";
import { SubcircuitWrapperElement } from "./subcircuit-wrapper-element.js";

// ---------------------------------------------------------------------------
// Component routing- shared decision logic for Pass A and Pass B
// ---------------------------------------------------------------------------

type ComponentRoute =
  | { kind: 'stamp';  model: MnaModel; entry: ModelEntry | null }
  | { kind: 'skip' };

/**
 * Resolve a ModelEntry from the component's modelRegistry.
 * Returns null if no entry found for the given key.
 */
function resolveModelEntry(
  def: ComponentDefinition,
  modelKey: string,
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): ModelEntry | null {
  if (def.modelRegistry?.[modelKey]) return def.modelRegistry[modelKey]!;
  if (runtimeModelMap?.[def.name]?.[modelKey]) return runtimeModelMap[def.name]![modelKey]!;
  return null;
}

/**
 * Convert a ModelEntry to the compiler-internal MnaModel representation.
 */
function modelEntryToMnaModel(entry: ModelEntry): MnaModel | null {
  if (entry.kind === "inline") {
    const model: MnaModel = {
      factory: entry.factory,
    };
    return model;
  }
  // Netlist entries are resolved separately by resolveSubcircuitModels
  return null;
}

/**
 * Resolve the loaded flag for a single pin at a given MNA node.
 *
 * Used by both the bridge-adapter code path and the behavioural-factory code
 * path so that both resolve pin loading through the same logic.
 *
 * @param nodeId          - MNA node ID for the pin (from groupToNodeId).
 * @param mode            - Circuit-level digitalPinLoading setting.
 * @param nodeIdToOverride - Per-net loading overrides (nodeId → "loaded"|"ideal").
 * @param isCrossDomain   - True when the pin is at a cross-domain boundary
 *                          (bridge adapter); false for purely behavioural pins.
 */
function resolvePinLoading(
  nodeId: number,
  mode: "cross-domain" | "all" | "none",
  nodeIdToOverride: ReadonlyMap<number, "loaded" | "ideal">,
  isCrossDomain: boolean,
): boolean {
  const override = nodeIdToOverride.get(nodeId);
  if (override !== undefined) {
    return override === "loaded";
  }
  if (mode === "none") return false;
  if (mode === "all") return true;
  // "cross-domain": only load pins that are at a cross-domain boundary
  return isCrossDomain;
}

function resolveComponentRoute(
  def: ComponentDefinition,
  pc: PartitionedComponent,
  _digitalPinLoading: "cross-domain" | "all" | "none",
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): ComponentRoute {
  if (pc.modelKey === "neutral") {
    return { kind: 'skip' };
  }

  if (pc.modelKey === "digital") {
    return { kind: 'skip' };
  }

  const entry = resolveModelEntry(def, pc.modelKey, runtimeModelMap);
  if (!entry) return { kind: 'skip' };

  if (entry.kind === "netlist") {
    // Netlist entries are resolved by resolveSubcircuitModels into pc.model
    if (pc.model === null) return { kind: 'skip' };
    return { kind: 'stamp', model: pc.model as MnaModel, entry };
  }

  const mnaModel = modelEntryToMnaModel(entry);
  if (!mnaModel) return { kind: 'skip' };
  return { kind: 'stamp', model: mnaModel, entry };
}


// ---------------------------------------------------------------------------
// Subcircuit model resolution- post-partition step (W4.1)
// ---------------------------------------------------------------------------

/**
 * Resolve subcircuit-backed models into MnaModel factories.
 *
 * For each PartitionedComponent whose active model key resolves to a
 * subcircuit netlist, compile it into an MnaModel with a composite factory.
 * Replaces `pc.model` in-place so the main compiler loop only sees
 * stamp/bridge/skip.
 */
function resolveSubcircuitModels(
  partition: SolverPartition,
  registry: ComponentRegistry,
): void {
  for (const pc of partition.components) {
    const def = pc.definition;
    const modelReg = def.modelRegistry;
    if (!modelReg) continue;
    const entry = modelReg[pc.modelKey];
    if (!entry || entry.kind !== 'netlist') continue;

    const netlist = entry.netlist;

    let resolvedNetlist: MnaSubcircuitNetlist;
    if (typeof netlist === "function") {
      // Spec ssI6: function-form netlist receives the merged-instance PropertyBag
      // (paramDef defaults + entry.params + instance overrides), so the netlist
      // builder evaluates against the same param values the leaf factories see.
      const mergedRecord: Record<string, number> = {
        ...paramDefDefaults(entry.paramDefs),
        ...entry.params,
      };
      const instanceProps = pc.element.getProperties();
      for (const k of instanceProps.getModelParamKeys()) {
        mergedRecord[k] = instanceProps.getModelParam<number>(k);
      }
      const mergedProps = new PropertyBag();
      for (const [k, v] of Object.entries(mergedRecord)) {
        mergedProps.setModelParam(k, v);
      }
      // Also copy static (non-model-param) entries from the instance so that
      // structural props like "bits" are accessible via getOrDefault() inside
      // the netlist builder. These are not model params and are not included in
      // mergedRecord above.
      for (const [k, v] of instanceProps.entries()) {
        mergedProps.set(k, v);
      }
      resolvedNetlist = netlist(mergedProps);
    } else {
      resolvedNetlist = netlist;
    }

    pc.model = compileSubcircuitToMnaModel(resolvedNetlist, pc, registry);
  }
}

/**
 * A thin leaf element that allocates a single internal MNA node during setup()
 * and records the allocated node ID into a shared mutable slot. Used by
 * compileSubcircuitToMnaModel so that internal-net allocation belongs to leaf
 * children (per ssA.7) rather than to the composite's setup() body.
 *
 * The allocator element has no stamps- its sole purpose is calling
 * ctx.makeVolt() and writing the result into `slot.nodeId` so that sibling
 * sub-elements sharing the same internal net can read the resolved ID
 * during their own setup() calls (which run after the allocator's setup()).
 *
 * `labelRef` is a shared mutable object whose `.value` is set to the composite
 * element's label before `super.setup(ctx)` is called, so that diagnostic node
 * names are attributed to the correct parent instance.
 */
function makeInternalNetAllocator(
  labelRef: { value: string },
  suffix: string,
  slot: { nodeId: number },
): AnalogElement {
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.INTERNAL_NET_ALLOC,
    _pinNodes: new Map(),
    _stateBase: -1,
    branchIndex: -1,

    setup(ctx: import("./setup-context.js").SetupContext): void {
      slot.nodeId = ctx.makeVolt(labelRef.value, suffix);
      el._pinNodes.set(suffix, slot.nodeId);
    },

    load(_ctx: import("./load-context.js").LoadContext): void {
      // No stamps- allocator only.
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      return [];
    },

    setParam(_key: string, _value: number): void {
      // No params.
    },
  };
  return el;
}

/**
 * Compile an MnaSubcircuitNetlist into an MnaModel with a wrapper factory.
 *
 * The factory returns a plain-object wrapper AnalogElement with
 * participatesInLoad:false. The wrapper's leaves (allocator, patcher,
 * sub-elements) are exposed via `_subcircuitLeaves` so the caller in
 * compileAnalogPartition flattens them into the global `analogElements`
 * accumulator. The engine's global ngspiceLoadOrder sort then sequences
 * allocator (-2) -> patcher (-1) -> URC (0) -> real devices (>= 0) at
 * setup-time, which makes the wrapper's own setup/load redundant.
 */
function compileSubcircuitToMnaModel(
  netlist: MnaSubcircuitNetlist,
  _pc: PartitionedComponent,
  registry: ComponentRegistry,
): MnaModel {
  return {
    factory(
      pinNodes: ReadonlyMap<string, number>,
      props: PropertyBag,
      getTime: () => number,
    ): AnalogElement {
      const portLabelToNode = new Map<string, number>(pinNodes);

      // Resolve subcircuit-level params: netlist defaults, then instance overrides.
      const resolvedSubcktParams = new Map<string, number>();
      if (netlist.params) {
        for (const [k, v] of Object.entries(netlist.params)) {
          resolvedSubcktParams.set(k, v);
        }
      }
      for (const [k] of resolvedSubcktParams) {
        if (props.hasModelParam(k)) {
          resolvedSubcktParams.set(k, props.getModelParam<number>(k));
        }
      }

      // Allocate one mutable slot per internal net. Leaf allocator elements
      // write to these slots during setup(); sub-elements that share the
      // same internal net read the resolved node ID from the same slot
      // during their own setup() calls, which run after the allocators.
      const internalNetSlots: Array<{ nodeId: number }> = [];
      for (let i = 0; i < netlist.internalNetCount; i++) {
        internalNetSlots.push({ nodeId: -1 });
      }

      // Binding map: subcircuit param name → [{element, elementParamKey}]
      // Used by setParam to route subcircuit-level changes to the correct
      // sub-element param (e.g. "WP" → PMOS elements' "W" param).
      const bindings = new Map<string, Array<{ el: AnalogElement; key: string }>>();

      // Per-instance label resolved at expansion time via setLabel.
      const labelRef = { value: "" };

      // All child elements: allocators first (so slots are populated before
      // sub-elements run setup()), then the real leaf elements.
      const allChildren: AnalogElement[] = [];
      const subElements: AnalogElement[] = [];
      // Per-sub-element record: { element, subElementName }- used by setLabel
      // to stamp `${parentLabel}:${subElementName}` onto each leaf.
      const subElementLabelInfo: Array<{ el: AnalogElement; subElementName: string }> = [];

      // Build elementsByName map for siblingBranch / siblingState resolution.
      const elementsByName = new Map<string, import("../../core/mna-subcircuit-netlist.js").SubcircuitElement>();
      for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
        const subEl = netlist.elements[elIdx]!;
        const subName = subEl.subElementName ?? `el${elIdx}`;
        elementsByName.set(subName, subEl);
      }

      // Map sub-element name → constructed AnalogElement, populated as we build
      // each leaf below. Used for siblingState resolution to acquire the
      // resolved sibling element reference (not just the netlist record).
      const constructedByName = new Map<string, AnalogElement>();

      // Helper: resolve a netlist net index to a node ID or a slot reference.
      // Port nets resolve immediately; internal nets resolve via slot.nodeId
      // (populated by the allocator during setup()).
      function resolveNetToNode(netIdx: number): number {
        if (netIdx < netlist.ports.length) {
          const portLabel = netlist.ports[netIdx];
          return portLabel !== undefined ? (portLabelToNode.get(portLabel) ?? -1) : -1;
        }
        // Internal net- slot will be populated by the allocator's setup().
        // Return the slot's current value; after all allocator setup() calls
        // run, slot.nodeId holds the real node ID.
        const slotIdx = netIdx - netlist.ports.length;
        return internalNetSlots[slotIdx]?.nodeId ?? -1;
      }

      // Helpers for creating proxy _pinNodes maps that read slot values lazily.
      // Each sub-element receives a Map whose values for internal nets are
      // resolved at setup() time (after allocators run), not at construction.
      // We accomplish this by giving sub-elements Maps pre-populated with -1
      // for internal nets, then the allocator elements write the resolved IDs
      // back into the shared slot object. Since the sub-element's _pinNodes Map
      // holds the node ID directly (it is not a live reference to the slot),
      // we must patch the Map entries before the sub-element's setup() runs.
      //
      // The patching is done by a dedicated patcher element inserted between
      // the allocators and the real sub-elements. The patcher's setup() reads
      // all slot values (now populated) and writes the final node IDs into
      // each sub-element's _pinNodes.

      // Record which sub-element _pinNodes entries need patching and which slot.
      const patchWork: Array<{
        target: Map<string, number>;
        pinLabel: string;
        slot: { nodeId: number };
      }> = [];

      for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
        const subEl = netlist.elements[elIdx];
        const connectivity = netlist.netlist[elIdx];

        const leafDef = registry.get(subEl.typeId);
        const leafModelKey = subEl.params?.model as string | undefined ?? leafDef?.defaultModel ?? "";
        const leafEntry = leafDef ? resolveModelEntry(leafDef, leafModelKey) : null;
        if (!leafEntry || leafEntry.kind !== "inline") continue;
        const leafFactory = leafEntry.factory;

        const subProps = new PropertyBag();
        // Seed with leaf definition's default model params (e.g. MOSFET VTO, KP, LAMBDA)
        if (leafEntry.params) {
          for (const [k, v] of Object.entries(leafEntry.params)) {
            if (typeof v === "number") subProps.setModelParam(k, v);
          }
        }
        // Override with subcircuit-specific params- discriminated dispatch on value shape.
        if (subEl.params) {
          for (const [paramKey, v] of Object.entries(subEl.params)) {
            if (typeof v === "number") {
              // Literal pass-through to leaf prop bag.
              subProps.setModelParam(paramKey, v);
            } else if (typeof v === "string") {
              // Existing subcircuit-level param ref; resolve from merged-instance PropertyBag.
              const resolved = resolvedSubcktParams.get(v);
              if (resolved !== undefined) subProps.setModelParam(paramKey, resolved);
            } else if (v !== null && typeof v === "object") {
              const tag = (v as { kind?: string }).kind;
              if (tag === "siblingBranch") {
                const ref = v as { kind: "siblingBranch"; subElementName: string };
                const sibling = elementsByName.get(ref.subElementName);
                if (!sibling) {
                  throw new Error(
                    `siblingBranch: unknown element "${ref.subElementName}"`,
                  );
                }
                // Write the GLOBAL label into the dependent leaf's prop bag.
                // The dependent leaf's setup() calls ctx.findBranch(label).
                subProps.set(
                  paramKey,
                  `${labelRef.value}:${ref.subElementName}`,
                );
              } else if (tag === "siblingState") {
                const ref = v as { kind: "siblingState"; subElementName: string; slotName: string };
                const sibling = elementsByName.get(ref.subElementName);
                if (!sibling) {
                  throw new Error(
                    `siblingState: unknown element "${ref.subElementName}"`,
                  );
                }
                const siblingDef = registry.get(sibling.typeId);
                if (!siblingDef) {
                  throw new Error(
                    `siblingState: registry has no definition for typeId "${sibling.typeId}"`,
                  );
                }
                // The constructed sibling carries the per-instance schema- variable-arity
                // drivers like Counter / Register build their schema from props in the
                // constructor, and fixed-shape drivers expose the same canonical schema.
                // Sibling MUST appear before the consumer in `netlist.elements`
                // iteration order- d-flipflop's parent emits [drv, qPin, nqPin],
                // counter parent emits [drv, outBit0, outBit1, ...]; the d-flipflop
                // / counter drv constructor runs first and populates constructedByName.
                const siblingEl = constructedByName.get(ref.subElementName);
                const siblingSchema =
                  siblingEl !== undefined && isPoolBacked(siblingEl)
                    ? siblingEl.stateSchema
                    : undefined;
                const slotIdx = siblingSchema?.indexOf.get(ref.slotName) ?? -1;
                if (slotIdx < 0) {
                  throw new Error(
                    `siblingState: unknown slot "${ref.slotName}" on "${ref.subElementName}"`,
                  );
                }
                if (siblingEl === undefined) {
                  // Per the in-loop invariant (sibling MUST precede consumer in
                  // netlist.elements iteration order), siblingEl is always
                  // populated by the time we reach a consumer's siblingState
                  // ref. If we hit this branch, the parent netlist's element
                  // ordering is wrong.
                  throw new Error(
                    `siblingState: sibling "${ref.subElementName}" not yet ` +
                      `constructed when consumer needs slot "${ref.slotName}". ` +
                      `Reorder netlist.elements so the sibling appears first.`,
                  );
                }
                // The dependent leaf's setup() resolves to a flat pool index via
                //   sibling._stateBase + slotIdx
                // because at setup-time the sibling's _stateBase is already populated
                // (initState ran before setup). Write the deferred ref:
                subProps.set(paramKey, { kind: "poolSlotRef", element: siblingEl, slotIdx });
              } else {
                throw new Error(
                  "Unsupported SubcircuitElementParam discriminator. " +
                    "Cross-leaf coupling MUST go through pool slots (siblingState) " +
                    "to preserve StatePool rollback. See composite-architecture-job.md ss11.2.",
                );
              }
            }
          }
        }

        // Build pin-label-keyed Map for the sub-element.
        // Port nets resolve immediately; internal nets start as -1 and are
        // patched by the patcher element before this sub-element's setup() runs.
        // Variable-shape drivers (Template A-variable: gates with N inputs,
        // counters/registers with N output bits) supply `pinLayoutFactory`;
        // resolvePinLayout invokes it with the sub-element's resolved props.
        const subPinNodes = new Map<string, number>();
        if (leafDef) {
          const subPinLayout = resolvePinLayout(leafDef, subProps);
          for (let pi = 0; pi < subPinLayout.length && pi < connectivity.length; pi++) {
            const netIdx = connectivity[pi];
            if (netIdx === undefined) continue;
            const pinLabel = subPinLayout[pi]!.label;
            if (netIdx < netlist.ports.length) {
              subPinNodes.set(pinLabel, resolveNetToNode(netIdx));
            } else {
              // Internal net- will be patched before this element's setup()
              const slotIdx = netIdx - netlist.ports.length;
              const slot = internalNetSlots[slotIdx];
              if (slot !== undefined) {
                subPinNodes.set(pinLabel, -1);
                patchWork.push({ target: subPinNodes, pinLabel, slot });
              }
            }
          }
        }

        const childEl = leafFactory(subPinNodes, subProps, getTime);
        subElements.push(childEl);
        const subName = subEl.subElementName ?? `el${elIdx}`;
        constructedByName.set(subName, childEl);
        subElementLabelInfo.push({ el: childEl, subElementName: subName });

        // Record string-ref bindings for setParam routing
        if (subEl.params) {
          for (const [k, v] of Object.entries(subEl.params)) {
            if (typeof v === "string") {
              let arr = bindings.get(v);
              if (!arr) { arr = []; bindings.set(v, arr); }
              arr.push({ el: childEl, key: k });
            }
          }
        }
      }

      // Determine which internal net slots actually need an allocator
      // (only those referenced by at least one sub-element).
      const usedSlotIndices = new Set(
        patchWork.map(pw => internalNetSlots.indexOf(pw.slot)),
      );

      const internalNetLabelsResolved: string[] = [];
      for (let i = 0; i < netlist.internalNetCount; i++) {
        if (!usedSlotIndices.has(i)) continue;
        const slot = internalNetSlots[i]!;
        const suffix = `int${i}`;
        internalNetLabelsResolved.push(suffix);
        allChildren.push(makeInternalNetAllocator(labelRef, suffix, slot));
      }

      // Patcher leaf element: runs after allocators, before real sub-elements,
      // to write resolved internal-node IDs into each sub-element's _pinNodes.
      const patcher: AnalogElement = {
        label: "",
        ngspiceLoadOrder: NGSPICE_LOAD_ORDER.INTERNAL_NET_PATCH,
        _pinNodes: new Map(),
        _stateBase: -1,
        branchIndex: -1,

        setup(_ctx: import("./setup-context.js").SetupContext): void {
          for (const { target, pinLabel, slot } of patchWork) {
            target.set(pinLabel, slot.nodeId);
          }
        },

        load(_ctx: import("./load-context.js").LoadContext): void {
          // No stamps- patcher only.
        },

        getPinCurrents(_rhs: Float64Array): number[] {
          return [];
        },

        setParam(_key: string, _value: number): void {
          // No params.
        },
      };

      if (patchWork.length > 0) {
        allChildren.push(patcher);
      }

      allChildren.push(...subElements);

      // Wrapper is a SubcircuitWrapperElement- the engine walks it like any
      // other AnalogElement, but its setup/load are no-ops; the real work
      // lives in the leaves (allocator, patcher, sub-elements) flattened
      // alongside the wrapper into the global accumulator by the caller.
      // ngspiceLoadOrder is set to VCVS for parity with the controlled-source
      // family; the no-op load means the order is functionally arbitrary.
      return new SubcircuitWrapperElement({
        pinNodes,
        ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
        subElements,
        leaves: allChildren,
        bindings: { map: bindings },
        subElementLabelInfo,
        internalNetLabels: internalNetLabelsResolved,
        labelRef,
      });
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
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>,
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
        Math.abs(wire.start.x - pinPos.x) <= 0.5 &&
        Math.abs(wire.start.y - pinPos.y) <= 0.5;
      const matchEnd =
        Math.abs(wire.end.x - pinPos.x) <= 0.5 &&
        Math.abs(wire.end.y - pinPos.y) <= 0.5;
      if (matchStart || matchEnd) {
        const nodeId = wireToNodeId.get(wire);
        if (nodeId !== undefined) {
          result[i] = nodeId;
          if (vertexOut) vertexOut[i] = matchStart ? wire.start : wire.end;
          break;
        }
      }
    }
    // Secondary: look up by position (handles pin-overlap without a wire)
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
// Pipeline stage helpers
// ---------------------------------------------------------------------------

/** Per-element metadata produced by Pass A for `compileAnalogPartition`. */
type PartitionElementMeta = {
  pc: PartitionedComponent;
  route: ComponentRoute;
};

/**
 * Pass A for `compileAnalogPartition`: iterate over partition components and
 * resolve each component's route. Branch indices and internal node IDs are
 * allocated lazily at setup() time (per A6.1- compile-time pre-sizing removed).
 *
 * Operates on `PartitionedComponent` entries (which already carry a resolved
 * `ComponentDefinition`) rather than raw `CircuitElement` entries.
 */
function runPassA_partition(
  partition: SolverPartition,
  _externalNodeCount: number,
  _diagnostics: Diagnostic[],
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  runtimeModelMap?: Record<string, Record<string, ModelEntry>>,
): PartitionElementMeta[] {
  const elementMeta: PartitionElementMeta[] = [];

  for (const pc of partition.components) {
    const el = pc.element;

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      elementMeta.push({ pc, route: { kind: 'skip' } });
      continue;
    }

    const def = pc.definition;
    const route = resolveComponentRoute(def, pc, digitalPinLoading, runtimeModelMap);

    switch (route.kind) {
      case 'skip': {
        elementMeta.push({ pc, route });
        continue;
      }
      case 'stamp': {
        const props = el.getProperties();
        if (route.entry) {
          const merged: Record<string, number> = { ...paramDefDefaults(route.entry.paramDefs), ...route.entry.params };
          for (const k of props.getModelParamKeys()) {
            merged[k] = props.getModelParam<number>(k);
          }
          props.replaceModelParams(merged);
        }
        elementMeta.push({ pc, route });
        continue;
      }
    }
  }

  return elementMeta;
}

// ---------------------------------------------------------------------------
// compileAnalogPartition- new partition-based entry point
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
  diagnostics: Diagnostic[],
): {
  nodeCount: number;
  groupToNodeId: Map<number, number>;
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>;
  labelToNodeId: Map<string, number>;
  labelPinNodes: Map<string, Array<{ pinLabel: string; nodeId: number }>>;
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

  // If no ground group found, handle based on partition type.
  // Bridge-only partitions (all groups are boundary groups, no Ground component):
  // synthesize a virtual ground at node 0 without consuming any group ID.
  // All boundary groups then get sequential node IDs starting at 1.
  // Other partitions: pick the largest group as best-effort ground.
  if (groundGroupIds.size === 0 && groups.length > 0) {
    const isBridgeOnly = partition.bridgeStubs.length > 0 &&
      groups.every(g => g.domains.has("digital") || g.domains.size > 1);
    if (!isBridgeOnly) {
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
    // Bridge-only: node 0 is a virtual ground (no group mapped to it).
    // Boundary groups will be assigned node IDs starting at 1 below.
  }

  // Assign node IDs: ground groups → 0; remaining groups → 1, 2, 3, … in
  // ngspice deck-line first-encounter order.
  //
  // ngspice numbers MNA nodes during deck PARSE (not during CKTsetup). Each
  // element line is parsed top-to-bottom; each new external node name on a
  // line gets the next sequential integer (cktnewn.c, cktlnkeq.c:32 via
  // INPtermInsert from the per-type `INP2*` parsers, e.g. inp2r.c:60-64).
  //
  // Our deck (generated by `__tests__/harness/netlist-generator.ts`) emits
  // elements in (ngspiceLoadOrder ASC, original-index ASC)- forward within
  // bucket. So to match ngspice's parse-time numbering bit-exactly, we walk
  // `partition.components` in the same order here and assign node IDs as we
  // encounter each component's pins.
  //
  // We use the typeId→loadOrder lookup `getNgspiceLoadOrderByTypeId`
  // (`core/analog-types.ts`)- load order is a per-DEVICE-TYPE concept in
  // ngspice (its position in `DEVices[]`), not per-model or per-instance, so
  // the typeId is the right key. This avoids the chicken-and-egg of needing
  // a constructed AnalogElement to know its load order.
  const groupToNodeId = new Map<number, number>();
  for (const g of groups) {
    if (groundGroupIds.has(g.groupId)) {
      groupToNodeId.set(g.groupId, 0);
    }
  }
  // Build a position → groupId index for O(1) lookup as we walk pins.
  const positionToGroupId = new Map<string, number>();
  for (const g of groups) {
    for (const gp of g.pins) {
      positionToGroupId.set(`${gp.worldPosition.x},${gp.worldPosition.y}`, g.groupId);
    }
  }
  // Sort partition.components in deck-emission order and walk pins for
  // first-encounter numbering. Ground components are walked too- their pins
  // resolve to groupId 0, which is already mapped, so they're no-ops.
  const componentsInDeckOrder = partition.components
    .map((pc, originalIndex) => ({ pc, originalIndex }))
    .sort((a, b) => {
      const lhs = getNgspiceLoadOrderByTypeId(a.pc.element.typeId);
      const rhs = getNgspiceLoadOrderByTypeId(b.pc.element.typeId);
      if (lhs !== rhs) return lhs - rhs;
      return a.originalIndex - b.originalIndex;
    });
  let nextNodeId = 1;
  for (const { pc } of componentsInDeckOrder) {
    // Visit pins in SPICE deck-emission order. ngspice numbers nodes during
    // PARSE, in the order each new node name appears on each element line.
    // Our deck pin order is typeId-specific (e.g. Vname has [pos, neg] but
    // pinLayout is [neg, pos]; M card is [D, G, S, B] but pinLayout for NMOS
    // is [G, S, D]). The TYPE_ID_TO_DECK_PIN_LABEL_ORDER table mirrors what
    // netlist-generator emits.
    const deckLabels = TYPE_ID_TO_DECK_PIN_LABEL_ORDER[pc.element.typeId];
    const visitPin = (rp: ResolvedGroupPin): void => {
      const key = `${rp.worldPosition.x},${rp.worldPosition.y}`;
      const gid = positionToGroupId.get(key);
      if (gid === undefined) return;
      if (groupToNodeId.has(gid)) return;
      groupToNodeId.set(gid, nextNodeId++);
    };
    if (deckLabels !== undefined) {
      // Build a label → ResolvedPin index lookup for this component.
      const labelToPinIdx = new Map<string, number>();
      for (let pi = 0; pi < pc.resolvedPins.length; pi++) {
        labelToPinIdx.set(pc.resolvedPins[pi]!.pinLabel, pi);
      }
      for (const lbl of deckLabels) {
        const idx = labelToPinIdx.get(lbl);
        if (idx === undefined) continue;
        visitPin(pc.resolvedPins[idx]!);
      }
      // Walk any pinLayout-only pins (not listed in deckLabels) afterward-
      // typically only digital-domain pins on cross-domain components, which
      // never affect ngspice numbering.
      for (let pi = 0; pi < pc.resolvedPins.length; pi++) {
        const rp = pc.resolvedPins[pi]!;
        if (!deckLabels.includes(rp.pinLabel)) visitPin(rp);
      }
    } else {
      // Unknown typeId (composite or non-ngspice element): fall back to
      // pinLayout order. ngspice-parity is not currently established for
      // these, so the walk order doesn't have to match a SPICE deck.
      for (const rp of pc.resolvedPins) visitPin(rp);
    }
  }
  // Any groups not visited by any component pin (floating wire-only nets)
  // get assigned at the tail of the range so node IDs stay contiguous.
  for (const g of groups) {
    if (!groupToNodeId.has(g.groupId)) {
      groupToNodeId.set(g.groupId, nextNodeId++);
    }
  }
  const nodeCount = nextNodeId - 1;

  // Build wireToNodeId
  const wireToNodeId = new Map<import("../../core/circuit.js").Wire, number>();
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

  // Build labelToNodeId and labelPinNodes from all labeled components in the
  // partition. Mirrors ngspice's two-namespace semantics: node names and
  // device names are distinct namespaces, and a label that unambiguously
  // identifies a single MNA node only does so for a 1-pin element (Port, In,
  // Out, Ground). A multi-pin device label refers to a device, not a node, so
  // its bare label has no node mapping; per pin we register a `label:pinLabel`
  // entry instead. This keeps labelToNodeId consistent with labelSignalMap
  // (compile.ts:390-397).
  const labelToNodeId = new Map<string, number>();
  const labelPinNodes = new Map<string, Array<{ pinLabel: string; nodeId: number }>>();
  for (const pc of partition.components) {
    const props = pc.element.getProperties();
    const label = props.has("label") ? String(props.get("label")) : "";
    if (!label) continue;
    if (pc.resolvedPins.length === 0) continue;

    const pins: Array<{ pinLabel: string; nodeId: number }> = [];
    for (const rp of pc.resolvedPins) {
      const k = `${rp.worldPosition.x},${rp.worldPosition.y}`;
      const nodeId = positionToNodeId.get(k) ?? 0;
      pins.push({ pinLabel: rp.pinLabel, nodeId });
      labelToNodeId.set(`${label}:${rp.pinLabel}`, nodeId);
    }
    labelPinNodes.set(label, pins);

    if (pins.length === 1) {
      labelToNodeId.set(label, pins[0]!.nodeId);
    }
  }

  return { nodeCount, groupToNodeId, wireToNodeId, labelToNodeId, labelPinNodes, positionToNodeId };
}

/**
 * Compile an analog partition into a `ConcreteCompiledAnalogCircuit`.
 *
 * Accepts a `SolverPartition` (pre-computed by `partitionByDomain`) instead of
 * a raw `Circuit`. Connectivity is pre-computed in the partition's groups.
 * All analog-specific logic (internal node allocation, branch row
 * allocation, MNA matrix sizing, factory invocation, topology validation)
 * is preserved.
 */
export function compileAnalogPartition(
  partition: SolverPartition,
  registry: ComponentRegistry,
  logicFamily?: LogicFamilyConfig,
  outerCircuit?: Circuit,
  _digitalCompiler?: DigitalCompilerFn,
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  perNetLoadingOverrides?: ReadonlyMap<number, "loaded" | "ideal">,
): ConcreteCompiledAnalogCircuit {
  const diagnostics: Diagnostic[] = [];

  // Build node map from partition groups
  const {
    nodeCount: externalNodeCount,
    groupToNodeId,
    wireToNodeId,
    labelToNodeId,
    labelPinNodes,
    positionToNodeId,
  } = buildAnalogNodeMapFromPartition(partition, diagnostics);

  // Build a reverse map from MNA node ID → per-net loading override so that
  // bridge synthesis sites can consult per-net overrides instead of relying
  // solely on the circuit-level digitalPinLoading setting.
  const nodeIdToLoadingOverride = new Map<number, "loaded" | "ideal">();
  if (perNetLoadingOverrides) {
    for (const [groupId, override] of perNetLoadingOverrides) {
      const nodeId = groupToNodeId.get(groupId);
      if (nodeId !== undefined) {
        nodeIdToLoadingOverride.set(nodeId, override);
      }
    }
  }

  // Use the caller-supplied logic family or fall back to the default.
  const circuitFamily = logicFamily ?? defaultLogicFamily();

  // Stage 2b: Resolve subcircuit-backed models into MnaModel factories.
  resolveSubcircuitModels(partition, registry);

  // Extract typed inline runtime models for use in route resolution.
  const runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined =
    outerCircuit?.metadata.models;

  // Stage 3 (Pass A): Resolve component routes. Branch indices and internal
  // node IDs are allocated lazily at setup() time (A6.1).
  const elementMeta = runPassA_partition(partition, externalNodeCount, diagnostics, digitalPinLoading, runtimeModelMap);

  let branchCount = 0;
  let totalNodeCount = externalNodeCount;

  // Build a minimal circuit-like wire lookup for resolveElementNodes.
  // We need to pass wireToNodeId and a circuit object. We create a minimal
  // stub that provides circuit.wires for pin position matching.
  // resolveElementNodes needs (el, wireToNodeId, circuit, vertexOut?, positionToNodeId?)
  // where circuit is used for circuit.wires iteration.
  // We collect all wires from the partition's groups.
  const allWires = partition.groups.flatMap((g) => g.wires);
  const partitionCircuitStub = { wires: allWires } as import("../../core/circuit.js").Circuit;

  const analogElements: import("./element.js").AnalogElement[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();
  const elementBridgeAdapters = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>();

  const timeRef = { value: 0 };
  const getTime = (): number => timeRef.value;

  for (const meta of elementMeta) {
    const { pc, route } = meta;
    const el = pc.element;

    if (el.typeId === "Ground" || el.typeId === "Tunnel") {
      continue;
    }

    if (route.kind === 'skip') {
      continue;
    }

    // route.kind === 'stamp'
    const def = pc.definition;
    const props = el.getProperties();
    const activeModel = route.model;

    // Resolve pin → node ID bindings
    const livePins = el.getPins();
    const pinVertices: Array<{ x: number; y: number } | null> = new Array(
      livePins.length,
    ).fill(null);
    const pinNodeIds = resolveElementNodes(el, wireToNodeId, partitionCircuitStub, pinVertices, positionToNodeId);

    const pinLabelList = livePins.map((p) => p.label);
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
            `The "${pinLabel}" pin on "${label}" (${el.typeId}) is not connected- component excluded from simulation`,
            {
              explanation:
                `Component "${label}" has a pin ("${pinLabel}") that doesn't touch any wire ` +
                `endpoint in the circuit. The component has been excluded from the analog simulation.`,
              suggestions: [
                {
                  text: `Check the wiring around "${label}"- make sure each pin endpoint sits exactly on a wire.`,
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

    if (activeModel.factory !== undefined) {
      const flatOverrides: Record<string, number> = props.has("_pinElectricalOverrides")
        ? props.get<Record<string, number>>("_pinElectricalOverrides")
        : {};
      // Build per-pin overrides from flat composite keys (e.g. "A.rOut" → { A: { rOut: ... } })
      const userOverrides: Record<string, Partial<ResolvedPinElectrical>> = {};
      for (const [compositeKey, val] of Object.entries(flatOverrides)) {
        const dotIdx = compositeKey.indexOf('.');
        if (dotIdx === -1) continue;
        const pinLabel = compositeKey.slice(0, dotIdx);
        const field = compositeKey.slice(dotIdx + 1);
        if (!userOverrides[pinLabel]) userOverrides[pinLabel] = {};
        (userOverrides[pinLabel] as Record<string, number>)[field] = val;
      }

      const pinLabelsForElec = def.pinLayout.map((pd) => pd.label);
      const pinElectricalMap: Record<string, ResolvedPinElectrical> = {};
      for (const pinLabel of pinLabelsForElec) {
        const defPinOverride = def.pinElectricalOverrides?.[pinLabel];
        const componentOverride = def.pinElectrical;
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
      props.set("_pinElectrical", pinElectricalMap);

      // Build per-pin loading map and inject into PropertyBag so that
      // behavioural factories can read it during pin-model construction.
      const pinLoadingMap: Record<string, boolean> = {};
      for (const pinLabel of pinLabelsForElec) {
        const nodeId = pinNodes.get(pinLabel);
        if (nodeId !== undefined) {
          pinLoadingMap[pinLabel] = resolvePinLoading(
            nodeId,
            digitalPinLoading,
            nodeIdToLoadingOverride,
            false,
          );
        }
      }
      props.set("_pinLoading", pinLoadingMap);
    }

    // Populate model params.
    // Merge order (lowest wins): model entry defaults → element _mparams.
    const modelEntry = route.entry;
    if (modelEntry) {
      const schemaKeys = new Set(modelEntry.paramDefs.map(d => d.key));
      for (const k of Object.keys(modelEntry.params)) {
        if (!schemaKeys.has(k)) {
          diagnostics.push(makeDiagnostic(
            'model-param-ignored', 'warning',
            `Model param "${k}" on ${pc.definition.name} is not in the schema and will be ignored`,
          ));
        }
      }
      const merged: Record<string, number> = { ...paramDefDefaults(modelEntry.paramDefs), ...modelEntry.params };
      for (const k of props.getModelParamKeys()) {
        merged[k] = props.getModelParam<number>(k);
      }
      props.replaceModelParams(merged);
    }

    const analogFactory = activeModel.factory;
    if (!analogFactory) continue;
    const core = analogFactory(pinNodes, props, getTime);
    const resolvedLabel = el.getProperties().has("label")
      ? String(el.getProperties().get("label") ?? el.instanceId)
      : el.instanceId;
    // Subcircuit-wrapper case: the factory returned a SubcircuitWrapperElement.
    // Stamp the wrapper's label before flattening leaves so each leaf carries
    // `${parentLabel}:${subElementName}` (Composite I5).
    if (core instanceof SubcircuitWrapperElement) {
      core.setLabel(resolvedLabel);
    }
    const elementIndex = analogElements.length;
    const element: import("./element.js").AnalogElement = Object.assign(core, {
      label: resolvedLabel,
      elementIndex,
    });
    analogElements.push(element);
    elementToCircuitElement.set(elementIndex, el);
    elementPinVertices.set(elementIndex, pinVertices);

    {
      const resolvedPinsOut: ResolvedPin[] = [];
      const elPins = el.getPins();
      for (let pi = 0; pi < elPins.length; pi++) {
        const pin = elPins[pi];
        if (!pin) continue;
        const decl = def.pinLayout[pi];
        resolvedPinsOut.push({
          label: pin.label,
          direction: decl?.direction ?? pin.direction,
          localPosition: pin.position,
          worldPosition: pinWorldPosition(el, pin),
          wireVertex: pinVertices[pi] ?? null,
          nodeId: pinNodeIds[pi],
          bitWidth: pin.bitWidth,
        });
      }
      elementResolvedPins.set(elementIndex, resolvedPinsOut);
    }

    // If the factory was a subcircuit wrapper, push its leaves (allocator,
    // patcher, sub-elements) directly into the analog accumulator so the
    // global ngspiceLoadOrder sort sequences them ahead of real devices.
    // The wrapper itself stays in `analogElements` with no-op setup/load.
    if (core instanceof SubcircuitWrapperElement) {
      for (const leaf of core._subcircuitLeaves) {
        analogElements.push(leaf);
      }
    }
  }

  // Bridge stub processing- create MNA elements for each cross-domain boundary.
  const bridgeAdaptersByGroupId = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>();

  for (const stub of partition.bridgeStubs) {
    const { boundaryGroupId, descriptor } = stub;
    const nodeId = groupToNodeId.get(boundaryGroupId);
    if (nodeId === undefined) continue;

    // Determine loaded flag using the shared resolvePinLoading helper.
    const loaded = resolvePinLoading(
      nodeId,
      digitalPinLoading,
      nodeIdToLoadingOverride,
      true,
    );

    const spec = resolvePinElectrical(circuitFamily, descriptor.electricalSpec);
    const adapters: Array<BridgeOutputAdapter | BridgeInputAdapter> = [];

    if (descriptor.direction === "digital-to-analog") {
      // Digital output pin drives the analog node- BridgeOutputAdapter (voltage source).
      // 1-based slot indexing per the absoluteBranchIdx convention above.
      const branchIdx = totalNodeCount + 1 + branchCount;
      branchCount++;
      const adapter = makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded);
      // Label for coordinator pin-param dispatch (e.g. "out.rOut" → endsWith(":out"))
      const driverPin = descriptor.boundaryGroup.pins.find(p => p.domain === "digital");
      if (driverPin) adapter.label = `bridge-${boundaryGroupId}:${driverPin.pinLabel}`;
      analogElements.push(adapter);
      adapters.push(adapter);
    } else {
      // Analog voltage drives digital input- BridgeInputAdapter (loading sense)
      const adapter = makeBridgeInputAdapter(spec, nodeId, loaded);
      const sensePin = descriptor.boundaryGroup.pins.find(p => p.domain === "digital");
      if (sensePin) adapter.label = `bridge-${boundaryGroupId}:${sensePin.pinLabel}`;
      analogElements.push(adapter);
      adapters.push(adapter);
    }

    bridgeAdaptersByGroupId.set(boundaryGroupId, adapters);
  }

  // Architectural alignment A1: sort by ngspiceLoadOrder so that
  // per-iteration cktLoad walks devices in the same per-type bucket order
  // ngspice does (every R, every C, ..., every V, ...). Within each bucket,
  // walk in REVERSE deck order: ngspice's `cktcrte.c:63-65` prepends every
  // parsed instance to the model's GENinstances linked list, so when CKTsetup
  // walks that list head→tail it visits instances in reverse-deck order. To
  // mirror that, we sort by (ngspiceLoadOrder ASC, originalIndex DESC). The
  // netlist generator emits the deck back in forward-within-bucket order
  // (see netlist-generator.ts) so that ngspice's prepend re-reverses to
  // match our walk. The sort must run before state-pool allocation and
  // before the index maps are returned.
  //
  // Re-key the three index maps and rewrite each element's elementIndex field
  // so post-sort indices stay consistent.
  const oldIndexByEl = new Map<import("./element.js").AnalogElement, number>();
  const oldIndexToElement = analogElements.map((el, i) => {
    oldIndexByEl.set(el, i);
    return { el, oldIndex: i };
  });
  analogElements.sort((a, b) => {
    const orderDiff = a.ngspiceLoadOrder - b.ngspiceLoadOrder;
    if (orderDiff !== 0) return orderDiff;
    return oldIndexByEl.get(b)! - oldIndexByEl.get(a)!;
  });
  const oldToNewIndex = new Map<number, number>();
  for (let newIndex = 0; newIndex < analogElements.length; newIndex++) {
    const el = analogElements[newIndex]!;
    const found = oldIndexToElement.find((p) => p.el === el);
    if (found !== undefined) oldToNewIndex.set(found.oldIndex, newIndex);
  }
  // Rewrite elementIndex on each AnalogElement and rebuild the three keyed maps.
  const newElementToCircuitElement = new Map<number, CircuitElement>();
  const newElementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const newElementResolvedPins = new Map<number, ResolvedPin[]>();
  for (const [oldIdx, val] of elementToCircuitElement) {
    const newIdx = oldToNewIndex.get(oldIdx);
    if (newIdx !== undefined) newElementToCircuitElement.set(newIdx, val);
  }
  for (const [oldIdx, val] of elementPinVertices) {
    const newIdx = oldToNewIndex.get(oldIdx);
    if (newIdx !== undefined) newElementPinVertices.set(newIdx, val);
  }
  for (const [oldIdx, val] of elementResolvedPins) {
    const newIdx = oldToNewIndex.get(oldIdx);
    if (newIdx !== undefined) newElementResolvedPins.set(newIdx, val);
  }
  elementToCircuitElement.clear();
  for (const [k, v] of newElementToCircuitElement) elementToCircuitElement.set(k, v);
  elementPinVertices.clear();
  for (const [k, v] of newElementPinVertices) elementPinVertices.set(k, v);
  elementResolvedPins.clear();
  for (const [k, v] of newElementResolvedPins) elementResolvedPins.set(k, v);
  // Update each element's elementIndex to its post-sort position. Bridge
  // adapters and the synthetic composite wrapper don't currently set
  // elementIndex (only via Object.assign during regular element construction),
  // so guard the assignment.
  for (let i = 0; i < analogElements.length; i++) {
    const el = analogElements[i] as import("./element.js").AnalogElement & { elementIndex?: number };
    if ("elementIndex" in el && typeof el.elementIndex === "number") {
      el.elementIndex = i;
    }
  }

  // Compile-time topology detectors (no branchIndex needed). Post-setup
  // detectors run from MNAEngine._setup() and emit through the engine's
  // runtime DiagnosticCollector- see `topology-diagnostics.ts` and
  // `analog-engine.ts::_setup()`.
  {
    const topology = buildTopologyInfo(analogElements);
    runCompileTimeDetectors(topology, totalNodeCount, d => diagnostics.push(d));
  }

  // Check for ground.
  const hasGround = partition.components.some((pc) => pc.element.typeId === "Ground");
  const isBridgeOnlyPartition = !hasGround && partition.bridgeStubs.length > 0;
  if (isBridgeOnlyPartition) {
    // Bridge-only partitions have no Ground component by definition. Node 0 is
    // reserved by the node map builder as a virtual ground reference. Suppress
    // any "no-ground" diagnostic that was emitted during node map construction.
    for (let i = diagnostics.length - 1; i >= 0; i--) {
      if (diagnostics[i]!.code === "no-ground") {
        diagnostics.splice(i, 1);
      }
    }
  } else if (!hasGround) {
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

  // State pool: deferred to setup time (A5.3). Compiled statePool is null;
  // MNAEngine._setup() calls allocateStateBuffers(numStates) after all
  // element setup() calls have run, then each pool-backed element's
  // initState() is called from CKTCircuitContext.allocateStateBuffers().
  const statePool: StatePool | null = null;

  // Build and return ConcreteCompiledAnalogCircuit
  const models = new Map<string, DeviceModel>();

  return new ConcreteCompiledAnalogCircuit({
    nodeCount: totalNodeCount,
    elements: analogElements,
    labelToNodeId,
    labelPinNodes,
    wireToNodeId,
    models,
    elementToCircuitElement,
    elementPinVertices,
    elementResolvedPins,
    groupToNodeId,
    elementBridgeAdapters,
    bridgeAdaptersByGroupId,
    diagnostics,
    timeRef,
    statePool,
  });
}
