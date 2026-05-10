/**
 * Analog circuit compiler.
 *
 * Transforms a visual `Circuit` containing analog components into a
 * `ConcreteCompiledAnalogCircuit` that the MNA engine can simulate.
 *
 * Steps:
 *  1. Build node map (wire groups â†’ MNA node IDs, ground = 0)
 *  2. Resolve pinâ†’node bindings for each element
 *  3. Call factory for primitives, recursively expand composites
 *     (`expandCompositeInstance`) into a flat list of leaves with
 *     pre-allocated internal-net IDs
 *  4. Topology validation (floating nodes, voltage-source loops, inductor loops)
 *  5. Return ConcreteCompiledAnalogCircuit
 */

import { Circuit } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { ComponentRegistry } from "../../core/registry.js";
import { resolvePinLayout, isStandalone } from "../../core/registry.js";
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
import type { BridgeOutputDriverElement } from "./behavioral-drivers/bridge-output-driver.js";
import type { BridgeInputDriverElement } from "./behavioral-drivers/bridge-input-driver.js";
import type { LogicFamilyConfig } from "../../core/logic-family.js";
import type { SolverPartition, PartitionedComponent, DigitalCompilerFn, ComponentDefinition, MnaModel } from "../../compile/types.js";
import type { ModelEntry } from "../../core/registry.js";
import { StatePool } from "./state-pool.js";
import { isPoolBacked, AnalogElement } from "./element.js";
import { NGSPICE_LOAD_ORDER, getNgspiceLoadOrderByTypeId, TYPE_ID_TO_DECK_PIN_LABEL_ORDER } from "./ngspice-load-order.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import {
  buildTopologyInfo,
  runCompileTimeDetectors,
} from "./topology-diagnostics.js";
import { SubcircuitWrapperElement } from "./subcircuit-wrapper-element.js";
import { AnalogInductorElement } from "../../components/passives/inductor.js";
import { MutualInductorElement } from "../../components/passives/mutual-inductor.js";

// ---------------------------------------------------------------------------
// Component routing- shared decision logic for Pass A and Pass B
// ---------------------------------------------------------------------------

type ComponentRoute =
  | { kind: 'stamp';   model: MnaModel; entry: ModelEntry | null }
  | { kind: 'compose'; entry: ModelEntry & { kind: "netlist" } }
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
 * @param nodeIdToOverride - Per-net loading overrides (nodeId â†’ "loaded"|"ideal").
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
    return { kind: 'compose', entry };
  }

  const mnaModel = modelEntryToMnaModel(entry);
  if (!mnaModel) return { kind: 'skip' };
  return { kind: 'stamp', model: mnaModel, entry };
}


// ---------------------------------------------------------------------------
// Composite expansion- compile-time recursive flattening.
//
// Every composite is fully expanded to primitives at compile time. Internal
// MNA node IDs are pre-allocated by the partition-level allocator (which
// bumps `totalNodeCount` and records the new node in `preAllocatedNodes`),
// so each leaf factory receives a `pinNodes` Map whose values are all real,
// resolved node IDs- no `-1` placeholder ever enters a Map.
//
// The allocator is threaded through `expandCompositeInstance` so nested
// composites share the same partition-level node-ID counter, which keeps the
// node range contiguous from `1..externalNodeCount` (deck walk) through
// `externalNodeCount+1..totalNodeCount` (composite internals, depth-first in
// netlist.elements order).
//
// Replaces: `compileSubcircuitToMnaModel` + `InternalNetAllocator` +
// `PatcherLeaf` + the `internalNetSlots`/`patchWork`/`labelPatchWork`
// indirections from before. The bug class around closure-captured `-1`
// pin-node IDs is unrepresentable: factories never see a `-1`.
// ---------------------------------------------------------------------------

type NodeAllocator = (label: string, suffix: string) => number;

/**
 * Pre-allocated MNA node entry. The engine seeds `_nodeTable` with these
 * before `_setup()` so element-private nodes (`makeVolt` calls inside
 * `setup()`) continue from `compiled.nodeCount + 1` without colliding with
 * compile-time-allocated composite internals.
 */
export interface PreAllocatedNodeEntry {
  name: string;
  number: number;
  type: "voltage";
}

/**
 * Resolve a function-form `MnaSubcircuitNetlist` against a merged instance
 * PropertyBag. Plain (non-function) netlists are returned as-is. Mirrors the
 * spec ssI6 contract: the netlist builder receives paramDef defaults +
 * entry.params + instance overrides + static (non-model-param) instance
 * entries, in that precedence order.
 */
function resolveNetlistInstance(
  entry: ModelEntry & { kind: "netlist" },
  instanceProps: PropertyBag,
): MnaSubcircuitNetlist {
  if (typeof entry.netlist !== "function") return entry.netlist;
  const mergedRecord: Record<string, number> = {
    ...paramDefDefaults(entry.paramDefs),
    ...entry.params,
  };
  for (const k of instanceProps.getModelParamKeys()) {
    mergedRecord[k] = instanceProps.getModelParam<number>(k);
  }
  const mergedProps = new PropertyBag();
  for (const [k, v] of Object.entries(mergedRecord)) {
    mergedProps.setModelParam(k, v);
  }
  for (const [k, v] of instanceProps.entries()) {
    mergedProps.set(k, v);
  }
  return entry.netlist(mergedProps);
}

/**
 * Compute the merged subcircuit-level params for an instance: netlist
 * defaults overridden by the instance's modelParams.
 */
function computeSubcktParams(
  netlist: MnaSubcircuitNetlist,
  instanceProps: PropertyBag,
): Map<string, number> {
  const out = new Map<string, number>();
  if (netlist.params) {
    for (const [k, v] of Object.entries(netlist.params)) out.set(k, v);
  }
  for (const k of out.keys()) {
    if (instanceProps.hasModelParam(k)) {
      out.set(k, instanceProps.getModelParam<number>(k));
    }
  }
  return out;
}

/**
 * Expand a composite instance into a flat list of leaf AnalogElements with
 * fully-resolved pin-node IDs. Recursive- nested composites are expanded in
 * the same pass. The returned `wrapper` is a presentation-only
 * SubcircuitWrapperElement (no-op setup/load) used for setParam routing,
 * getPinCurrents aggregation, and internal-node label exposure. The returned
 * `allLeaves` is the depth-first flattening that the engine's element walk
 * sees as primary participants.
 */
function expandCompositeInstance(
  netlist: MnaSubcircuitNetlist,
  subcktParams: Map<string, number>,
  outerPinNodes: ReadonlyMap<string, number>,
  parentLabel: string,
  registry: ComponentRegistry,
  getTime: () => number,
  allocateNode: NodeAllocator,
  hook?: import("../../core/registry.js").AnalogWrapperHook,
): { wrapper: SubcircuitWrapperElement; allLeaves: AnalogElement[] } {
  // Pre-allocate one MNA node per declared internal net.
  const internalNetIds: number[] = [];
  const internalNetLabels: string[] = [];
  for (let i = 0; i < netlist.internalNetCount; i++) {
    const suffix = netlist.internalNetLabels?.[i] ?? `int${i}`;
    internalNetIds.push(allocateNode(parentLabel, suffix));
    internalNetLabels.push(suffix);
  }

  // Build elementsByName index for siblingBranch / siblingState resolution.
  const elementsByName = new Map<string, import("../../core/mna-subcircuit-netlist.js").SubcircuitElement>();
  for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
    const subEl = netlist.elements[elIdx]!;
    const subName = subEl.subElementName ?? `el${elIdx}`;
    elementsByName.set(subName, subEl);
  }

  // Resolve a netlist net index to a concrete MNA node ID.
  // Reserved port labels `gnd` / `GND` auto-bind to MNA node 0 (global ground)
  // when the parent component's pinLayout doesn't expose a matching pin. This
  // mirrors SPICE's node-0 convention and lets digital composites (gates,
  // flipflops, mux/demux/decoder, drivers) reference ground internally
  // without forcing every component to expose a user-visible GND pin. An
  // explicit pinLayout entry with a matching label still wins, so user
  // wiring is honoured when the component does expose GND.
  const resolveNetToNode = (netIdx: number): number => {
    if (netIdx < netlist.ports.length) {
      const portLabel = netlist.ports[netIdx];
      if (portLabel === undefined) {
        throw new Error(`composite "${parentLabel}": invalid port index ${netIdx}`);
      }
      const id = outerPinNodes.get(portLabel);
      if (id !== undefined) return id;
      if (portLabel === "gnd" || portLabel === "GND") return 0;
      throw new Error(
        `composite "${parentLabel}": port "${portLabel}" not present in outerPinNodes`,
      );
    }
    return internalNetIds[netIdx - netlist.ports.length]!;
  };

  const constructedByName = new Map<string, AnalogElement>();
  const subElements: AnalogElement[] = [];
  const allLeaves: AnalogElement[] = [];
  const subElementLabelInfo: Array<{ el: AnalogElement; subElementName: string }> = [];
  const bindings = new Map<string, Array<{ el: AnalogElement; key: string }>>();

  for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
    const subEl = netlist.elements[elIdx]!;
    const connectivity = netlist.netlist[elIdx]!;
    const subName = subEl.subElementName ?? `el${elIdx}`;
    const childLabel = `${parentLabel}:${subName}`;

    const leafDef = registry.get(subEl.typeId);
    // CLAUDE.md "Component Model Architecture": defaultModel is for
    // placement-time UI only and MUST NOT be a compile-time lookup key.
    const leafModelKey =
      subEl.modelRef ?? (subEl.params?.model as string | undefined);
    if (leafModelKey === undefined) {
      throw new Error(
        `Composite sub-element "${subName}" (typeId="${subEl.typeId}") has no ` +
          `modelRef and no params.model. defaultModel is for placement-time UI ` +
          `only and is not a valid compile-time lookup key.`,
      );
    }
    const leafEntry = leafDef ? resolveModelEntry(leafDef, leafModelKey) : null;
    if (!leafEntry) {
      const available = leafDef?.modelRegistry
        ? Object.keys(leafDef.modelRegistry).join(", ") || "(none)"
        : "(typeId not in registry)";
      throw new Error(
        `Composite sub-element "${subName}" requested model "${leafModelKey}" ` +
          `on typeId "${subEl.typeId}", but the component has no such model ` +
          `entry. Available: ${available}.`,
      );
    }

    // Build the sub-element's PropertyBag: leaf-entry defaults + sub-element
    // param overrides (literal numbers, subcircuit-param refs, sibling refs).
    const subProps = new PropertyBag();
    if (leafEntry.params) {
      for (const [k, v] of Object.entries(leafEntry.params)) {
        if (typeof v === "number") subProps.setModelParam(k, v);
      }
    }
    if (subEl.params) {
      for (const [paramKey, v] of Object.entries(subEl.params)) {
        if (typeof v === "number") {
          subProps.setModelParam(paramKey, v);
        } else if (typeof v === "string") {
          const resolved = subcktParams.get(v);
          if (resolved !== undefined) subProps.setModelParam(paramKey, resolved);
        } else if (v !== null && typeof v === "object") {
          const tag = (v as { kind?: string }).kind;
          if (tag === "siblingBranch") {
            const ref = v as { kind: "siblingBranch"; subElementName: string };
            const sibling = elementsByName.get(ref.subElementName);
            if (!sibling) {
              throw new Error(`siblingBranch: unknown element "${ref.subElementName}"`);
            }
            // Parent label is known at compile time; resolve immediately
            // instead of deferring to a patcher leaf at engine setup time.
            subProps.set(paramKey, `${parentLabel}:${ref.subElementName}`);
          } else if (tag === "siblingState") {
            const ref = v as {
              kind: "siblingState";
              subElementName: string;
              slotName: string;
            };
            const sibling = elementsByName.get(ref.subElementName);
            if (!sibling) {
              throw new Error(`siblingState: unknown element "${ref.subElementName}"`);
            }
            const siblingDef = registry.get(sibling.typeId);
            if (!siblingDef) {
              throw new Error(
                `siblingState: registry has no definition for typeId "${sibling.typeId}"`,
              );
            }
            const siblingEl = constructedByName.get(ref.subElementName);
            if (siblingEl === undefined) {
              throw new Error(
                `siblingState: sibling "${ref.subElementName}" not yet constructed ` +
                  `when consumer needs slot "${ref.slotName}". Reorder ` +
                  `netlist.elements so the sibling appears first.`,
              );
            }
            const siblingSchema = isPoolBacked(siblingEl)
              ? siblingEl.stateSchema
              : undefined;
            const slotIdx = siblingSchema?.indexOf.get(ref.slotName) ?? -1;
            if (slotIdx < 0) {
              throw new Error(
                `siblingState: unknown slot "${ref.slotName}" on "${ref.subElementName}"`,
              );
            }
            subProps.set(paramKey, {
              kind: "poolSlotRef",
              element: siblingEl,
              slotIdx,
            });
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

    // Build pin-label-keyed Map for the sub-element. All node IDs are
    // already resolved (port pins via outer pinNodes; internal-net pins via
    // pre-allocated IDs) - no `-1` placeholder ever appears here.
    const subPinNodes = new Map<string, number>();
    if (leafDef) {
      const subPinLayout = resolvePinLayout(leafDef, subProps);
      for (let pi = 0; pi < subPinLayout.length && pi < connectivity.length; pi++) {
        const netIdx = connectivity[pi];
        if (netIdx === undefined) continue;
        const pinLabel = subPinLayout[pi]!.label;
        subPinNodes.set(pinLabel, resolveNetToNode(netIdx));
      }
    }

    // Build the child element. Inline factories produce a primitive directly;
    // netlist-form leaves recurse to expand nested composites into a flat
    // list of primitives whose internal nets share the partition-level
    // allocator's node-ID range.
    let childEl: AnalogElement;
    if (leafEntry.kind === "inline") {
      childEl = leafEntry.factory(subPinNodes, subProps, getTime);
      childEl.label = childLabel;
      subElements.push(childEl);
      allLeaves.push(childEl);
    } else if (leafEntry.kind === "netlist") {
      const innerNetlist = resolveNetlistInstance(leafEntry, subProps);
      const innerSubcktParams = computeSubcktParams(innerNetlist, subProps);
      const inner = expandCompositeInstance(
        innerNetlist,
        innerSubcktParams,
        subPinNodes,
        childLabel,
        registry,
        getTime,
        allocateNode,
      );
      childEl = inner.wrapper;
      // Inner expansion already set inner.wrapper.label = childLabel via
      // the SubcircuitWrapperElement constructor option; reassert here so
      // future direct construction paths can't drift.
      childEl.label = childLabel;
      subElements.push(childEl);
      allLeaves.push(childEl, ...inner.allLeaves);
    } else if (leafEntry.kind === "mutual-inductor") {
      // K-element construction path. The MutualInductorElement requires live
      // AnalogInductorElement partner references; the generic AnalogFactory
      // signature cannot provide them. We resolve L1_branch/L2_branch sibling
      // names from the netlist params and look them up in constructedByName.
      //
      // ngspice anchor: mutsetup.c:44-57 — partner inductors must be allocated
      // before MUT runs setup(), so Inductor leaves must precede MutualInductor
      // in netlist.elements (enforced by the factory's instanceof guard).
      const rawParams = subEl.params ?? {};
      const l1Ref = rawParams["L1_branch"];
      const l2Ref = rawParams["L2_branch"];
      if (
        typeof l1Ref !== "object" || l1Ref === null || (l1Ref as { kind?: string }).kind !== "siblingBranch" ||
        typeof l2Ref !== "object" || l2Ref === null || (l2Ref as { kind?: string }).kind !== "siblingBranch"
      ) {
        throw new Error(
          `Composite sub-element "${subName}" (kind: "mutual-inductor") must declare ` +
          `L1_branch and L2_branch as siblingBranch refs. ` +
          `Got L1_branch=${JSON.stringify(l1Ref)}, L2_branch=${JSON.stringify(l2Ref)}.`,
        );
      }
      const l1SubName = (l1Ref as { subElementName: string }).subElementName;
      const l2SubName = (l2Ref as { subElementName: string }).subElementName;
      // coupling = K param from the MutualInductor's resolved params (default 1).
      const coupling = subProps.getModelParam<number>("K") ?? 1;
      childEl = leafEntry.factory(l1SubName, l2SubName, coupling, constructedByName);
      childEl.label = childLabel;
      subElements.push(childEl);
      allLeaves.push(childEl);
    } else {
      // Future ModelEntry kinds: surface loudly so we never silently drop a
      // sub-element the way the old code did with `if (kind !== "inline") continue`.
      throw new Error(
        `Composite sub-element "${subName}" has unsupported ModelEntry kind ` +
          `"${(leafEntry as { kind: string }).kind}".`,
      );
    }

    constructedByName.set(subName, childEl);
    subElementLabelInfo.push({ el: childEl, subElementName: subName });

    // Record string-ref bindings for setParam routing.
    if (subEl.params) {
      for (const [k, v] of Object.entries(subEl.params)) {
        if (typeof v === "string") {
          let arr = bindings.get(v);
          if (!arr) {
            arr = [];
            bindings.set(v, arr);
          }
          arr.push({ el: childEl, key: k });
        }
      }
    }
  }

  const wrapper = new SubcircuitWrapperElement({
    pinNodes: outerPinNodes,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    subElements,
    leaves: allLeaves,
    bindings: { map: bindings },
    subElementLabelInfo,
    internalNetLabels,
    label: parentLabel,
    ...(hook !== undefined ? { hook } : {}),
  });

  return { wrapper, allLeaves };
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
      case 'compose': {
        // Composites manage their own internal subcircuit-level params via
        // `computeSubcktParams` at expand time, but the instance's modelParams
        // bag still has to carry merged defaults for the wrapper's setParam
        // dispatch and any non-composite read paths.
        const props = el.getProperties();
        const merged: Record<string, number> = {
          ...paramDefDefaults(route.entry.paramDefs),
          ...route.entry.params,
        };
        for (const k of props.getModelParamKeys()) {
          merged[k] = props.getModelParam<number>(k);
        }
        props.replaceModelParams(merged);
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
 * Ground group â†’ node 0; all other groups â†’ sequential from 1.
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

  // Assign node IDs: ground groups â†’ 0; remaining groups â†’ 1, 2, 3, â€¦ in
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
  // We use the typeIdâ†’loadOrder lookup `getNgspiceLoadOrderByTypeId`
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
  // Build a position â†’ groupId index for O(1) lookup as we walk pins.
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
      // Build a label â†’ ResolvedPin index lookup for this component.
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

  // Build a reverse map from MNA node ID â†’ per-net loading override so that
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

  // Extract typed inline runtime models for use in route resolution.
  const runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined =
    outerCircuit?.metadata.models;

  // Stage 3 (Pass A): Resolve component routes. Branch indices and internal
  // node IDs are allocated lazily at setup() time (A6.1).
  const elementMeta = runPassA_partition(partition, externalNodeCount, diagnostics, digitalPinLoading, runtimeModelMap);

  let branchCount = 0;
  let totalNodeCount = externalNodeCount;

  // Compile-time node allocator for composite-internal nets. Threaded into
  // `expandCompositeInstance` so every nested level shares one contiguous
  // node-ID range. The engine seeds `_nodeTable` with `preAllocatedNodes`
  // before `_setup()` so element-private `makeVolt` calls continue from
  // `compiled.nodeCount + 1` without colliding.
  const preAllocatedNodes: PreAllocatedNodeEntry[] = [];
  const allocateCompositeNode: NodeAllocator = (label, suffix) => {
    totalNodeCount += 1;
    preAllocatedNodes.push({
      name: `${label}#${suffix}`,
      number: totalNodeCount,
      type: "voltage",
    });
    return totalNodeCount;
  };

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
  const elementBridgeAdapters = new Map<number, Array<BridgeOutputDriverElement | BridgeInputDriverElement>>();

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

    const def = pc.definition;
    const props = el.getProperties();

    // Resolve pin â†’ node ID bindings.
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

    // Pin electrical / pin loading metadata (consumed by both inline
    // factories and composite leaf factories: composites flatten outer
    // pinElectrical onto each sub-element pin via the netlist's port mapping).
    {
      const flatOverrides: Record<string, number> = props.has("_pinElectricalOverrides")
        ? props.get<Record<string, number>>("_pinElectricalOverrides")
        : {};
      // Build per-pin overrides from flat composite keys (e.g. "A.rOut" â†’ { A: { rOut: ... } })
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

    // Schema-keys validation: warn for params declared on the model entry
    // that aren't in its paramDefs schema. The merge of defaults +
    // entry.params + instance overrides already happened in
    // `runPassA_partition` for both 'stamp' and 'compose' routes.
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
    }

    const resolvedLabel = el.getProperties().has("label")
      ? String(el.getProperties().get("label") ?? el.instanceId)
      : el.instanceId;

    // Build the element. Primitive (`stamp`): call the factory directly.
    // Composite (`compose`): fully expand to a flat list of primitive leaves
    // at compile time, with internal-net IDs pre-allocated from the
    // partition-level allocator. Sub-element factories see fully-resolved
    // pinNodes Maps - no `-1` placeholder ever appears.
    let core: import("./element.js").AnalogElement;
    let composedLeaves: import("./element.js").AnalogElement[] = [];
    if (route.kind === 'stamp') {
      const analogFactory = route.model.factory;
      if (!analogFactory) continue;
      core = analogFactory(pinNodes, props, getTime);
      core.label = resolvedLabel;
    } else {
      const netlist = resolveNetlistInstance(route.entry, props);
      const subcktParams = computeSubcktParams(netlist, props);
      // Parent-side runtime hook: instantiate once per parent-component
      // instance and thread to the wrapper. The wrapper forwards
      // load/setDiagnosticEmitter/setParam/acceptStep calls to the hook;
      // the existing RuntimeDiagnosticAware wiring in MNAEngine.init()
      // hooks the diagnostic emitter via the wrapper's setDiagnosticEmitter.
      const hook = isStandalone(def) && def.analogWrapperHook
        ? def.analogWrapperHook(pinNodes, props, getTime)
        : undefined;
      const expanded = expandCompositeInstance(
        netlist,
        subcktParams,
        pinNodes,
        resolvedLabel,
        registry,
        getTime,
        allocateCompositeNode,
        hook,
      );
      core = expanded.wrapper;
      core.label = resolvedLabel;
      composedLeaves = expanded.allLeaves;
    }

    const elementIndex = analogElements.length;
    const element: import("./element.js").AnalogElement = Object.assign(core, {
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

    // Composite leaves were depth-first flattened by `expandCompositeInstance`.
    // Push them into the global accumulator so the engine's per-element walk
    // sees each one in `ngspiceLoadOrder` bucket order. The wrapper itself
    // stays in `analogElements`; its load/setDiagnosticEmitter/setParam/
    // acceptStep methods forward to the optional `analogWrapperHook` for
    // parent-side runtime concerns (UI diagnostics).
    for (const leaf of composedLeaves) {
      analogElements.push(leaf);
    }
  }

  // Bridge stub processing- create MNA elements for each cross-domain boundary.
  const bridgeAdaptersByGroupId = new Map<number, Array<BridgeOutputDriverElement | BridgeInputDriverElement>>();

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
    const adapters: Array<BridgeOutputDriverElement | BridgeInputDriverElement> = [];

    if (descriptor.direction === "digital-to-analog") {
      // Digital output pin drives the analog node- BridgeOutputDriverElement (voltage source).
      // 1-based slot indexing per the absoluteBranchIdx convention above.
      const branchIdx = totalNodeCount + 1 + branchCount;
      branchCount++;
      const adapter = makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded);
      // Label for coordinator pin-param dispatch (e.g. "out.rOut" â†’ endsWith(":out"))
      const driverPin = descriptor.boundaryGroup.pins.find(p => p.domain === "digital");
      if (driverPin) adapter.label = `bridge-${boundaryGroupId}:${driverPin.pinLabel}`;
      analogElements.push(adapter);
      adapters.push(adapter);
    } else {
      // Analog voltage drives digital input- BridgeInputDriverElement (loading sense)
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
  // walks that list headâ†’tail it visits instances in reverse-deck order. To
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

  // Build per-family buckets. Preserves the relative order of the sorted
  // flat array so each bucket is in the same (ngspiceLoadOrder ASC,
  // originalIndex DESC) order as `analogElements`.
  const elementsByFamilyMut = new Map<DeviceFamily, AnalogElement[]>();
  for (const el of analogElements) {
    let bucket = elementsByFamilyMut.get(el.deviceFamily);
    if (!bucket) { bucket = []; elementsByFamilyMut.set(el.deviceFamily, bucket); }
    bucket.push(el);
  }
  const elementsByFamily: ReadonlyMap<DeviceFamily, readonly AnalogElement[]> = elementsByFamilyMut;

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
    elementsByFamily,
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
    preAllocatedNodes,
  });
}
