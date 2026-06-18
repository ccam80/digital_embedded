/**
 * Analog circuit compiler.
 *
 * Transforms a visual `Circuit` containing analog components into a
 * `ConcreteCompiledAnalogCircuit` that the MNA engine can simulate.
 *
 * Steps:
 *  1. Build node map (wire groups → MNA node IDs, ground = 0)
 *  2. Resolve pin→node bindings for each element
 *  3. Call factory for primitives, recursively expand composites
 *     (`expandCompositeInstance`) into a flat list of leaves with
 *     pre-allocated internal-net IDs
 *  4. Topology validation (floating nodes, voltage-source loops, inductor loops)
 *  5. Return ConcreteCompiledAnalogCircuit
 */

import { Circuit } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { ComponentRegistry, StandaloneComponentDefinition } from "../../core/registry.js";
import { resolvePinLayout } from "../../core/registry.js";
import type { Diagnostic } from "../../compile/types.js";
import { pinWorldPosition, PinDirection } from "../../core/pin.js";
import type { ResolvedPin, Pin, PinDeclaration } from "../../core/pin.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
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
import type { LogicFamilyConfig } from "../../core/logic-family.js";
import type { SolverPartition, PartitionedComponent, DigitalCompilerFn, ComponentDefinition, MnaModel } from "../../compile/types.js";
import type { ModelEntry } from "../../core/registry.js";
import { StatePool } from "./state-pool.js";
import { AnalogElement } from "./element.js";
import { getNgspiceLoadOrderByTypeId, getDeviceFamilyByTypeId, getDeckNodeTokensByTypeId, DECK_EMITTING_FAMILIES, deckOrder } from "./ngspice-load-order.js";
import type { DeviceFamily } from "./ngspice-load-order.js";
import {
  buildTopologyInfo,
  runCompileTimeDetectors,
} from "./topology-diagnostics.js";
import { SubcircuitWrapperElement } from "./subcircuit-wrapper-element.js";

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
    return { kind: 'compose', entry };
  }

  const mnaModel = modelEntryToMnaModel(entry);
  if (!mnaModel) return { kind: 'skip' };
  return { kind: 'stamp', model: mnaModel, entry };
}

/**
 * Model-entry parameter values: registry paramDef defaults overlaid by the model
 * entry's own params. These are VALUES, not user-given params — both the
 * standalone instantiation path (runPassA_partition) and the composite-leaf path
 * (expandCompositeInstance) write them with not-given semantics so a leaf device
 * is instantiated under the same contract as a standalone one, matching what the
 * netlist generator emits to ngspice (only explicit, given params on the deck).
 */
function modelEntryDefaults(entry: ModelEntry): Record<string, number> {
  return { ...paramDefDefaults(entry.paramDefs ?? []), ...(entry.params ?? {}) };
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
 * One sub-element of a composite at a single nesting level, carrying everything
 * BOTH node numbering and element construction need so the structure is derived
 * exactly once: the resolved model entry, the fully-built sub-element
 * PropertyBag (givenness-correct), the resolved pin layout, the raw
 * connectivity, the nested-netlist resolution, and the deck node-token order.
 *
 * `nodeTokenNetIndices` are the connectivity net-indices that introduce a node
 * for a primitive (inline) leaf, in the pin order matching ngspice's INP2*
 * first-encounter sequence over the flattened deck (inppas2.c:76) — the single
 * source for that order is `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`. A composite
 * sub-element (`kind:"netlist"`) introduces no node of its own; its ports are
 * listed in connectivity order and its internals are numbered by recursing into
 * `innerNetlist`.
 */
interface CompositeSubRecord {
  subEl: import("../../core/mna-subcircuit-netlist.js").SubcircuitElement;
  subName: string;
  childLabel: string;
  typeId: string;
  leafDef: import("../../core/registry.js").ComponentDefinition | undefined;
  leafModelKey: string | undefined;
  leafEntry: ModelEntry | null;
  subProps: PropertyBag;
  connectivity: readonly number[];
  subPinLayout: ReturnType<typeof resolvePinLayout>;
  isNetlist: boolean;
  innerNetlist: MnaSubcircuitNetlist | undefined;
  innerSubcktParams: Map<string, number> | undefined;
  nodeTokenNetIndices: number[];
}

/**
 * Enumerate one composite level's sub-elements in definition (deck) order,
 * resolving each sub-element's model + props + pin layout + nested netlist +
 * deck node-token order ONCE. Both the node-numbering walk
 * (`buildAnalogNodeMapFromPartition`) and the element-construction walk
 * (`expandCompositeInstance`) consume these records, so there is a single
 * structural derivation of which leaves a composite has and how their node
 * tokens are ordered — the deck emitter, the node numbering, and the element
 * build can no longer drift apart (the divergence that left a B-source leaf
 * mis-numbered when its typeId was absent from the deck-token table).
 *
 * Node-token order is authoritative: a device-modelled leaf (DeviceFamily in
 * DECK_EMITTING_FAMILIES) with no `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` entry is a
 * hard error — never a silent fallback that could mis-order its nodes against
 * ngspice. Behavioural-only leaves (no ngspice counterpart) and composites use
 * connectivity order.
 */
function enumerateCompositeLevel(
  netlist: MnaSubcircuitNetlist,
  parentLabel: string,
  registry: ComponentRegistry,
  runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined,
  subcktParams: Map<string, number>,
): CompositeSubRecord[] {
  const elementsByName = new Map<string, import("../../core/mna-subcircuit-netlist.js").SubcircuitElement>();
  for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
    const subEl = netlist.elements[elIdx]!;
    elementsByName.set(subEl.subElementName ?? `el${elIdx}`, subEl);
  }

  const records: CompositeSubRecord[] = [];
  for (let elIdx = 0; elIdx < netlist.elements.length; elIdx++) {
    const subEl = netlist.elements[elIdx]!;
    const connectivity = netlist.netlist[elIdx]!;
    const subName = subEl.subElementName ?? `el${elIdx}`;
    const childLabel = `${parentLabel}:${subName}`;

    const leafDef = registry.get(subEl.typeId);
    const leafModelKey = subEl.modelRef ?? (subEl.params?.model as string | undefined);
    const leafEntry =
      leafDef && leafModelKey !== undefined
        ? resolveModelEntry(leafDef, leafModelKey, runtimeModelMap)
        : null;

    // Sub-element PropertyBag: model-entry defaults written as VALUES (not given)
    // so givenness-gated leaf branches stay inactive, then per-sub-element param
    // overrides — literal numbers, subckt-param refs, sibling {ref} (resolved to
    // the flattened sibling label for ctx.findBranch/findDevice), and verbatim
    // {literal} (e.g. a B-source `expression`). Identical contract to the
    // standalone instantiation path (modelEntryDefaults).
    const subProps = new PropertyBag();
    if (leafEntry) {
      subProps.replaceModelParams(modelEntryDefaults(leafEntry), { preserveGivenness: true });
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
          if (tag === "ref") {
            const ref = v as { kind: "ref"; name: string };
            if (!elementsByName.has(ref.name)) {
              throw new Error(`SubcircuitElementParam ref: unknown element "${ref.name}"`);
            }
            subProps.set(paramKey, `${parentLabel}:${ref.name}`);
          } else if (tag === "literal") {
            subProps.set(paramKey, (v as { kind: "literal"; value: string }).value);
          } else {
            throw new Error(
              "Unsupported SubcircuitElementParam discriminator. " +
                "Allowed shapes: number, string, { kind: 'ref', name }, { kind: 'literal', value }.",
            );
          }
        }
      }
    }

    const subPinLayout = leafDef ? resolvePinLayout(leafDef, subProps) : [];

    const isNetlist = leafEntry?.kind === "netlist";
    let innerNetlist: MnaSubcircuitNetlist | undefined;
    let innerSubcktParams: Map<string, number> | undefined;
    if (isNetlist && leafEntry) {
      innerNetlist = resolveNetlistInstance(leafEntry, subProps);
      innerSubcktParams = computeSubcktParams(innerNetlist, subProps);
    }

    // Node-token order. A device-modelled leaf (DeviceFamily in
    // DECK_EMITTING_FAMILIES) numbers its nodes in the pin order given by
    // TYPE_ID_TO_DECK_PIN_LABEL_ORDER (matching ngspice's INP2* first-encounter
    // sequence); such a leaf with no entry is a hard error. A behavioural-only
    // leaf (no ngspice counterpart, never harness-compared) and a composite
    // sub-element use connectivity order — the composite recurses into
    // innerNetlist for its own internals.
    let nodeTokenNetIndices: number[];
    const deck = getDeckNodeTokensByTypeId(subEl.typeId);
    if (deck !== undefined) {
      nodeTokenNetIndices = deck
        .map((lbl) => subPinLayout.findIndex((p) => p.label === lbl))
        .filter((pi) => pi >= 0)
        .map((pi) => connectivity[pi])
        .filter((n): n is number => n !== undefined);
      // B-source: ngspice's INP2B parser registers the expression's V() controller
      // nodes immediately after n+ / n- while parsing the B-card (inpptree.c), so
      // those nets mint at the B-card, not where they later appear as a token on
      // another card. The controller pins are every pin not in the card's
      // node-token list, in pinLayout order — which pinLayoutFactory builds in
      // expression first-encounter order, matching ngspice's registration order.
      if (leafEntry?.spice?.device === "ASRC") {
        const tokenLabels = new Set(deck);
        for (let pi = 0; pi < subPinLayout.length && pi < connectivity.length; pi++) {
          if (tokenLabels.has(subPinLayout[pi]!.label)) continue;
          const netIdx = connectivity[pi];
          if (netIdx !== undefined) nodeTokenNetIndices.push(netIdx);
        }
      }
    } else {
      if (
        leafEntry?.kind === "inline" &&
        DECK_EMITTING_FAMILIES.has(getDeviceFamilyByTypeId(subEl.typeId))
      ) {
        throw new Error(
          `compiler: device-modelled leaf "${subName}" (typeId "${subEl.typeId}", ` +
            `family "${getDeviceFamilyByTypeId(subEl.typeId)}") has no ` +
            `TYPE_ID_TO_DECK_PIN_LABEL_ORDER entry. A leaf whose DeviceFamily is ` +
            `matched against ngspice must declare its node-token order so node ` +
            `numbering matches ngspice's INPpas2 first-encounter walk.`,
        );
      }
      nodeTokenNetIndices = connectivity.filter((n): n is number => n !== undefined);
    }

    records.push({
      subEl, subName, childLabel, typeId: subEl.typeId,
      leafDef, leafModelKey, leafEntry, subProps, connectivity, subPinLayout,
      isNetlist, innerNetlist, innerSubcktParams, nodeTokenNetIndices,
    });
  }
  return records;
}

/**
 * Expand a composite instance into a flat list of leaf AnalogElements with
 * fully-resolved pin-node IDs. Recursive- nested composites are expanded in
 * the same pass. The returned `wrapper` is a presentation-only
 * SubcircuitWrapperElement (no-op setup/load) used for setParam routing,
 * getPinCurrents aggregation, and internal-node label exposure. The returned
 * `allLeaves` is the depth-first flattening that the engine's element walk
 * sees as primary participants.
 *
 * Composite-internal node IDs are read from `compositeInternalIds`, which the
 * node-map builder populates in flattened-deck INPpas2 order via
 * `walkCompositeForNodeAllocation`. The straggler pass below covers declared
 * internal nets that no sub-element pin references (rare, but legal).
 */
function expandCompositeInstance(
  netlist: MnaSubcircuitNetlist,
  subcktParams: Map<string, number>,
  outerPinNodes: ReadonlyMap<string, number>,
  parentLabel: string,
  parentTypeId: string,
  registry: ComponentRegistry,
  runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined,
  allocateNode: NodeAllocator,
  compositeInternalIds: ReadonlyMap<string, number>,
  hookFactory?: import("../../core/registry.js").AnalogWrapperHookFactory,
  outerProps?: PropertyBag,
  nodeIdToLoadingOverride?: ReadonlyMap<number, "loaded" | "ideal">,
): { wrapper: SubcircuitWrapperElement; allLeaves: AnalogElement[] } {
  // Pre-allocated path: `walkCompositeForNodeAllocation` (called from the
  // node-map builder during Pass A's deck walk) populates `compositeInternalIds`
  // with `${parentLabel}#${suffix}` → nodeId entries in ngspice INPpas2
  // first-encounter order over the flattened deck. Read those IDs here so the
  // expanded leaves see exactly the same node IDs the deck emitter encodes
  // and ngspice's flattened-deck node-numbering walk assigns.
  const internalNetIds: number[] = new Array(netlist.internalNetCount);
  const internalNetLabels: string[] = new Array(netlist.internalNetCount);
  for (let slot = 0; slot < netlist.internalNetCount; slot++) {
    const suffix = netlist.internalNetLabels?.[slot] ?? `int${slot}`;
    const id = compositeInternalIds.get(`${parentLabel}#${suffix}`);
    if (id !== undefined) {
      internalNetIds[slot] = id;
      internalNetLabels[slot] = suffix;
    }
  }
  // Straggler pass: any internal net never referenced by a sub-element pin
  // is not seen by the flattened-deck walk; the current contract requires
  // every declared internal net to have an ID, so fill stragglers via the
  // partition-level allocator (these IDs land past the deck-walk range).
  //
  // A declared internal net referenced by no sub-element pin never appears on
  // ngspice's flattened deck (no INPtermInsert ever names it, inpsymt.c:43-72),
  // so ngspice mints no number for it. Appending past the deck-walk range here
  // is the faithful counterpart; such a net is a degenerate declaration.
  for (let slot = 0; slot < netlist.internalNetCount; slot++) {
    if (internalNetIds[slot] === undefined) {
      const suffix = netlist.internalNetLabels?.[slot] ?? `int${slot}`;
      internalNetIds[slot] = allocateNode(parentLabel, suffix);
      internalNetLabels[slot] = suffix;
    }
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

  const subElements: AnalogElement[] = [];
  const allLeaves: AnalogElement[] = [];
  const subElementLabelInfo: Array<{ el: AnalogElement; subElementName: string }> = [];
  const bindings = new Map<string, Array<{ el: AnalogElement; key: string }>>();

  for (const rec of enumerateCompositeLevel(netlist, parentLabel, registry, runtimeModelMap, subcktParams)) {
    const { subEl, subName, childLabel, leafDef, leafModelKey, leafEntry, subProps, connectivity, subPinLayout } = rec;

    // defaultModel is placement-time UI only and is not a compile-time lookup
    // key (CLAUDE.md "Component Model Architecture").
    if (leafModelKey === undefined) {
      throw new Error(
        `Composite sub-element "${subName}" (typeId="${subEl.typeId}") has no ` +
          `modelRef and no params.model. defaultModel is for placement-time UI ` +
          `only and is not a valid compile-time lookup key.`,
      );
    }
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

    // Bind every pin to its resolved node ID (port pins via outer pinNodes;
    // internal-net pins via the pre-allocated IDs) — no `-1` placeholder ever
    // appears. Pins bind in pinLayout order; node-token order governs only
    // allocation, which the numbering walk already did.
    const subPinNodes = new Map<string, number>();
    for (let pi = 0; pi < subPinLayout.length && pi < connectivity.length; pi++) {
      const netIdx = connectivity[pi];
      if (netIdx === undefined) continue;
      subPinNodes.set(subPinLayout[pi]!.label, resolveNetToNode(netIdx));
    }

    // Build the child element. Inline factories produce a primitive directly;
    // netlist-form leaves recurse to expand nested composites into a flat
    // list of primitives whose internal nets share the partition-level
    // allocator's node-ID range.
    let childEl: AnalogElement;
    if (leafEntry.kind === "inline") {
      childEl = leafEntry.factory(subPinNodes, subProps);
      childEl.label = childLabel;
      subElements.push(childEl);
      allLeaves.push(childEl);
    } else if (leafEntry.kind === "netlist") {
      // Per-net loading override: a digital input pin whose bound input node
      // carries an explicit loaded/ideal override selects its variant from the
      // override, taking precedence over the composite's baked `loaded` default.
      // The Loaded and Unloaded variants share ports, internal-net labels, and
      // node numbering — they differ only by the rIn/cIn input-load elements,
      // which reference the port nets — so this swap never perturbs the
      // pre-allocated composite-internal IDs.
      let innerNetlist = rec.innerNetlist!;
      let innerSubcktParams = rec.innerSubcktParams!;
      if (
        nodeIdToLoadingOverride !== undefined &&
        (subEl.typeId === "DigitalInputPinLoaded" || subEl.typeId === "DigitalInputPinUnloaded")
      ) {
        const inputNode = subPinNodes.get("node");
        const override = inputNode !== undefined ? nodeIdToLoadingOverride.get(inputNode) : undefined;
        const targetTypeId =
          override === "ideal" ? "DigitalInputPinUnloaded"
          : override === "loaded" ? "DigitalInputPinLoaded"
          : undefined;
        if (targetTypeId !== undefined && targetTypeId !== subEl.typeId) {
          const targetDef = registry.get(targetTypeId);
          const targetEntry = targetDef ? resolveModelEntry(targetDef, "default", runtimeModelMap) : null;
          if (targetEntry?.kind === "netlist") {
            innerNetlist = resolveNetlistInstance(targetEntry, subProps);
            innerSubcktParams = computeSubcktParams(innerNetlist, subProps);
          }
        }
      }
      const inner = expandCompositeInstance(
        innerNetlist,
        innerSubcktParams,
        subPinNodes,
        childLabel,
        subEl.typeId,
        registry,
        runtimeModelMap,
        allocateNode,
        compositeInternalIds,
        leafDef?.analogWrapperHook,
        subProps,
        nodeIdToLoadingOverride,
      );
      childEl = inner.wrapper;
      // Inner expansion already set inner.wrapper.label = childLabel via
      // the SubcircuitWrapperElement constructor option; reassert here so
      // future direct construction paths can't drift.
      childEl.label = childLabel;
      subElements.push(childEl);
      allLeaves.push(childEl, ...inner.allLeaves);
    } else {
      // Future ModelEntry kinds: surface loudly so we never silently drop a
      // sub-element the way the old code did with `if (kind !== "inline") continue`.
      throw new Error(
        `Composite sub-element "${subName}" has unsupported ModelEntry kind ` +
          `"${(leafEntry as { kind: string }).kind}".`,
      );
    }

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

  // Build the by-name index for the hook factory: parent-side hooks need to
  // address specific sub-elements (e.g. write a derived `gain` to the inner
  // VCVS when an outer `vOH` changes). Built from subElementLabelInfo so the
  // names line up with `subElementName` in the netlist declaration.
  const subElementsByName = new Map<string, AnalogElement>();
  for (const { el, subElementName } of subElementLabelInfo) {
    subElementsByName.set(subElementName, el);
  }

  const hook = hookFactory !== undefined && outerProps !== undefined
    ? hookFactory(outerPinNodes, outerProps, subElementsByName)
    : undefined;

  const wrapper = new SubcircuitWrapperElement({
    pinNodes: outerPinNodes,
    ngspiceLoadOrder: getNgspiceLoadOrderByTypeId(parentTypeId),
    deviceFamily: getDeviceFamilyByTypeId(parentTypeId),
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
// Pipeline stage helpers
// ---------------------------------------------------------------------------

/** Per-element metadata produced by Pass A for `compileAnalogPartition`. */
type PartitionElementMeta = {
  pc: PartitionedComponent;
  route: ComponentRoute;
  /** Composite components only: pre-resolved netlist + subcktParams +
   *  parentLabel. Computed in Pass A so the node-map builder and the element
   *  construction loop reuse the same `MnaSubcircuitNetlist` instance — the
   *  one whose internal-net slot indices we allocate node IDs against. */
  composite?: {
    netlist: MnaSubcircuitNetlist;
    subcktParams: Map<string, number>;
    parentLabel: string;
  };
};

/**
 * Resolve a CircuitElement's compile-time label. Mirrors the precedence used
 * in expandCompositeInstance's `${parentLabel}#${suffix}` key construction:
 * the user-set `label` property wins, falling back to `instanceId`.
 */
function resolveElementLabel(el: CircuitElement): string {
  const props = el.getProperties();
  if (props.has("label")) {
    return String(props.get("label") ?? el.instanceId);
  }
  return el.instanceId;
}

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
          const merged: Record<string, number> = { ...modelEntryDefaults(route.entry) };
          for (const k of props.getModelParamKeys()) {
            merged[k] = props.getModelParam<number>(k);
          }
          // preserveGivenness so recompile doesn't wipe a runtime setParam.
          props.replaceModelParams(merged, { preserveGivenness: true });
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
        const merged: Record<string, number> = { ...modelEntryDefaults(route.entry) };
        for (const k of props.getModelParamKeys()) {
          merged[k] = props.getModelParam<number>(k);
        }
        props.replaceModelParams(merged, { preserveGivenness: true });
        // Resolve the function-form netlist + subcktParams here so the same
        // MnaSubcircuitNetlist instance is shared by the node-map deck walk
        // (which allocates composite-internal node IDs in INPpas2 first-
        // encounter order) and the element construction loop (which builds
        // the wrapper + leaves against those same internal-net slot indices).
        const netlist = resolveNetlistInstance(route.entry, props);
        const subcktParams = computeSubcktParams(netlist, props);
        const parentLabel = resolveElementLabel(el);
        elementMeta.push({ pc, route, composite: { netlist, subcktParams, parentLabel } });
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
  elementMeta: ReadonlyMap<PartitionedComponent, PartitionElementMeta>,
  registry: ComponentRegistry,
  runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined,
): {
  nodeCount: number;
  groupToNodeId: Map<number, number>;
  wireToNodeId: Map<import("../../core/circuit.js").Wire, number>;
  labelToNodeId: Map<string, number>;
  labelPinNodes: Map<string, Array<{ pinLabel: string; nodeId: number }>>;
  positionToNodeId: Map<string, number>;
  compositeInternalIds: Map<string, number>;
  preAllocatedNodes: PreAllocatedNodeEntry[];
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
  // Walk partition.components in deck-line order and number pins on
  // first-encounter. Ground components are walked too- their pins resolve to
  // groupId 0, which is already mapped, so they're no-ops. `deckOrder`
  // (ngspice-load-order.ts) is the single producer of device-line order shared
  // with the harness deck emitter (inppas2.c:76 top-to-bottom card walk); both
  // consumers iterate this identical sequence so parse-time node integers stay
  // bound to the emitted deck. `deckOrder` keys on `typeId`, so project each
  // PartitionedComponent's `element.typeId` onto the sortable item.
  const componentsInDeckOrder = deckOrder(
    partition.components.map((pc) => ({ typeId: pc.element.typeId, pc })),
  ).map(({ item }) => ({ pc: item.pc }));
  // Composite-internal node IDs land in the deck-walk range, interleaved with
  // external IDs at the position the parent composite occupies in the
  // emission. The compositeInternalIds map and preAllocatedNodes entries are
  // populated as we go via `allocateCompositeInternal`.
  const compositeInternalIds = new Map<string, number>();
  const preAllocatedNodes: PreAllocatedNodeEntry[] = [];
  let nextNodeId = 1;
  const allocateCompositeInternal = (label: string, suffix: string): number => {
    const key = `${label}#${suffix}`;
    const existing = compositeInternalIds.get(key);
    if (existing !== undefined) return existing;
    const id = nextNodeId++;
    compositeInternalIds.set(key, id);
    preAllocatedNodes.push({ name: key, number: id, type: "voltage" });
    return id;
  };
  // Mint composite-internal node IDs for one composite. The harness deck emitter
  // inlines a composite's body at its position in DEFINITION (depth-first) order
  // — exactly as ngspice splices a `.subckt` body (subckt.c `doit`) — and ngspice
  // numbers nodes by first-encounter walking that flattened deck top-to-bottom
  // (inppas2.c:76). So mint internal nets by flattening the composite to its
  // primitive leaves in definition order and minting each leaf's node-token nets
  // where they first appear. A net must be minted at the deep leaf whose card
  // first names it (e.g. a thresholder's `out-`), NOT at the parent-composite
  // port that re-exposes it — minting at the port would order it ahead of the
  // sub-composite's own earlier leaves. External pins resolve to already-numbered
  // outer node ids and are skipped here.
  const mintCompositeInternals = (
    netlist: MnaSubcircuitNetlist,
    parentLabel: string,
    subcktParams: Map<string, number>,
    outerPortNodes: ReadonlyMap<string, number>,
  ): void => {
    const walk = (
      nl: MnaSubcircuitNetlist,
      label: string,
      params: Map<string, number>,
      portMap: ReadonlyMap<string, number | string>,
    ): void => {
      const portCount = nl.ports.length;
      // Resolve a net index to its canonical identity: an already-numbered outer
      // node id (number) or an internal-net key `${level-label}#${suffix}`
      // (string, not yet minted).
      const resolve = (netIdx: number): number | string => {
        if (netIdx < portCount) {
          const outer = portMap.get(nl.ports[netIdx]!);
          return outer ?? 0; // gnd / unconnected port → global ground
        }
        const suffix = nl.internalNetLabels?.[netIdx - portCount] ?? `int${netIdx - portCount}`;
        return `${label}#${suffix}`;
      };
      for (const rec of enumerateCompositeLevel(nl, label, registry, runtimeModelMap, params)) {
        if (rec.isNetlist && rec.innerNetlist && rec.innerSubcktParams) {
          // Composite sub-element: recurse at its deck position (depth-first), so
          // its internal leaves mint before whatever follows it at this level.
          const innerPortMap = new Map<string, number | string>();
          for (let pi = 0; pi < rec.subPinLayout.length && pi < rec.connectivity.length; pi++) {
            const netIdx = rec.connectivity[pi];
            if (netIdx === undefined) continue;
            innerPortMap.set(rec.subPinLayout[pi]!.label, resolve(netIdx));
          }
          walk(rec.innerNetlist, rec.childLabel, rec.innerSubcktParams, innerPortMap);
        } else {
          // Primitive leaf: mint each internal-net key its node tokens name, in
          // deck-token order, on first encounter.
          for (const netIdx of rec.nodeTokenNetIndices) {
            const net = resolve(netIdx);
            if (typeof net !== "string" || compositeInternalIds.has(net)) continue;
            const hash = net.lastIndexOf("#");
            allocateCompositeInternal(net.slice(0, hash), net.slice(hash + 1));
          }
        }
      }
    };
    walk(netlist, parentLabel, subcktParams, outerPortNodes);
  };
  for (const { pc } of componentsInDeckOrder) {
    // Visit pins in SPICE deck-emission order. ngspice numbers nodes during
    // PARSE, in the order each new node name appears on each element line.
    // Our deck pin order is typeId-specific (e.g. Vname has [pos, neg] but
    // pinLayout is [neg, pos]; M card is [D, G, S, B] but pinLayout for NMOS
    // is [G, S, D]). The TYPE_ID_TO_DECK_PIN_LABEL_ORDER table mirrors what
    // netlist-generator emits.
    const deckLabels = getDeckNodeTokensByTypeId(pc.element.typeId);
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
    } else {
      // Unknown typeId (composite or non-ngspice element): fall back to
      // pinLayout order. ngspice-parity for the outer pins of composites is
      // established by walking pc.resolvedPins in pinLayout order — which
      // matches what netlist-generator emits at the composite's outer
      // call site (the composite typeId has no SPICE card; its sub-element
      // cards drive ngspice's first-encounter walk).
      for (const rp of pc.resolvedPins) visitPin(rp);
    }

    // Composite-internal walk: immediately after this component's outer pins
    // are allocated, walk into its netlist (if any) and allocate IDs for any
    // composite-internal nets in flattened-deck INPpas2 first-encounter order.
    // This lands `nCap` / `senseMid` / etc. at the deck position they
    // actually appear in ngspice's flattened parse — interleaved with, not
    // appended after, the outer-pin allocations.
    const meta = elementMeta.get(pc);
    if (meta?.composite) {
      const { netlist, subcktParams, parentLabel } = meta.composite;
      const outerPortNodes = new Map<string, number>();
      for (const rp of pc.resolvedPins) {
        const k = `${rp.worldPosition.x},${rp.worldPosition.y}`;
        const gid = positionToGroupId.get(k);
        if (gid === undefined) continue;
        const id = groupToNodeId.get(gid);
        if (id !== undefined) outerPortNodes.set(rp.pinLabel, id);
      }
      mintCompositeInternals(netlist, parentLabel, subcktParams, outerPortNodes);
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

  return {
    nodeCount,
    groupToNodeId,
    wireToNodeId,
    labelToNodeId,
    labelPinNodes,
    positionToNodeId,
    compositeInternalIds,
    preAllocatedNodes,
  };
}

// ---------------------------------------------------------------------------
// Per-pin boundary adapters: one internalOnly composite per crossing digital
// pin. The analog hub net is a shared node nothing pins; each crossing pin's
// adapter `node` port attaches to it and presents a finite-impedance pin
// (tri-state Thevenin for outputs, rIn/cIn + threshold for inputs).
// ---------------------------------------------------------------------------

/**
 * Runtime handle the coordinator uses to drive (output) or read (input) one
 * crossing pin's boundary adapter. Output adapters route `ctrl`/`en` through
 * the wrapper's setParam; input adapters expose the `nResult` MNA node id whose
 * voltage the coordinator thresholds back to a digital bit.
 */
export interface BridgePinAdapterHandle {
  pinKey: string;
  role: "output" | "input";
  /** The expanded composite wrapper; setParam routes ctrl/en (output) and the
   *  coordinator reads resultNodeId voltage (input). */
  wrapper: SubcircuitWrapperElement;
  /** MNA node id of the input adapter's `nResult` net; -1 for output. */
  resultNodeId: number;
}

interface BoundaryAdapterInfo {
  pinKey: string;
  role: "output" | "input";
  /** Resolved instance label of the synthetic adapter (== its instanceId and
   *  its `label` property). Keys compositeInternalIds for `${label}#nResult`
   *  and matches the wrapper's resolved label in analogElements. */
  label: string;
}

/**
 * A synthetic one-pin (`node`) analog component instance standing in for one
 * crossing digital pin's boundary adapter. Carries a single `node` pin at the
 * shared analog hub world-position so the node-map builder binds it to the hub
 * node; the compose route then expands it into the boundary-adapter composite.
 */
class BoundaryAdapterElement extends AbstractCircuitElement {
  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    props: PropertyBag,
  ) {
    super(typeId, instanceId, position, 0, false, props);
  }

  getPins(): readonly Pin[] {
    const decls: PinDeclaration[] = [
      {
        kind: "signal",
        direction: PinDirection.OUTPUT,
        label: "node",
        defaultBitWidth: 1,
        position: { x: 0, y: 0 },
        isNegatable: false,
        isClockCapable: false,
      },
    ];
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 0, height: 0 };
  }

  draw(_ctx: RenderContext): void {
    // Synthetic compile-time element- never rendered.
  }
}

/**
 * Build the synthetic adapter element for one crossing pin. Its PropertyBag
 * carries `model: "default"` plus the resolved per-pin electricals as model
 * params (ctrl=0/en=1 for outputs), so the composite netlist reads user-set
 * values exactly like a flip-flop composite passes electricals to its pins.
 */
function makeBoundaryAdapterElement(
  typeId: string,
  instanceId: string,
  position: { x: number; y: number },
  role: "output" | "input",
  loaded: boolean,
  spec: ResolvedPinElectrical,
): BoundaryAdapterElement {
  const props = new PropertyBag([
    ["model", "default"],
    ["label", instanceId],
  ]);
  if (role === "output") {
    props.setModelParam("rOut", spec.rOut);
    // cOut exists only on the Loaded output variant's paramDefs.
    if (loaded) props.setModelParam("cOut", spec.cOut);
    props.setModelParam("vOH", spec.vOH);
    props.setModelParam("vOL", spec.vOL);
    props.setModelParam("rHiZ", spec.rHiZ);
    // midEn is the composite's own normalized-enable threshold (default 0.5),
    // not a pin-electrical field; let the adapter paramDefs supply it.
    props.setModelParam("ctrl", 0);
    props.setModelParam("en", 1);
  } else {
    // rIn/cIn exist only on the Loaded input variant's paramDefs.
    if (loaded) {
      props.setModelParam("rIn", spec.rIn);
      props.setModelParam("cIn", spec.cIn);
    }
    props.setModelParam("vIH", spec.vIH);
    props.setModelParam("vIL", spec.vIL);
  }
  return new BoundaryAdapterElement(typeId, instanceId, position, props);
}

/**
 * Synthesize one boundary-adapter PartitionedComponent per crossing pin from
 * `partition.bridgeStubs`. Output crossings expand the tri-state output adapter
 * (Loaded/Unloaded); input crossings expand the input adapter (Loaded/Unloaded).
 * The Loaded vs Unloaded variant follows the per-net loading override (an
 * `ideal` net selects the Unloaded variant) and the circuit-level loading mode.
 */
function synthesizeBoundaryAdapters(
  partition: SolverPartition,
  registry: ComponentRegistry,
  family: LogicFamilyConfig,
  digitalPinLoading: "cross-domain" | "all" | "none",
  perNetLoadingOverrides: ReadonlyMap<number, "loaded" | "ideal"> | undefined,
): {
  adapterComponents: PartitionedComponent[];
  adapterInfoByPinKey: Map<string, BoundaryAdapterInfo>;
} {
  const adapterComponents: PartitionedComponent[] = [];
  const adapterInfoByPinKey = new Map<string, BoundaryAdapterInfo>();

  for (const stub of partition.bridgeStubs) {
    const bd = stub.descriptor;
    const hubPin = bd.boundaryGroup.pins.find((p) => p.domain === "analog");
    const hubRef = hubPin ?? bd.boundaryGroup.pins[0];
    if (hubRef === undefined) continue;
    const hubPos = hubRef.worldPosition;

    // Loaded vs Unloaded: an explicit per-net `ideal` override (or loading
    // mode "none") selects the Unloaded variant; otherwise the boundary pin is
    // a cross-domain pin and loads (Loaded variant).
    const override = perNetLoadingOverrides?.get(bd.analogGroupId);
    const loaded =
      override === "ideal" ? false
      : override === "loaded" ? true
      : digitalPinLoading === "none" ? false
      : true;

    const adapterName =
      bd.role === "output"
        ? (loaded ? "DigitalOutputBoundaryAdapterLoaded" : "DigitalOutputBoundaryAdapterUnloaded")
        : (loaded ? "DigitalInputBoundaryAdapterLoaded" : "DigitalInputBoundaryAdapterUnloaded");
    const def = registry.get(adapterName);
    if (def === undefined) {
      throw new Error(
        `compileAnalogPartition: boundary adapter "${adapterName}" is not ` +
          `registered. Register it in register-all.ts before compiling.`,
      );
    }

    const spec = resolvePinElectrical(family, bd.electricalSpec);
    const syntheticInstanceId = `bridge-adapter:${bd.pinKey}`;

    const element = makeBoundaryAdapterElement(
      adapterName,
      syntheticInstanceId,
      hubPos,
      bd.role,
      loaded,
      spec,
    );

    const resolvedPin: ResolvedGroupPin = {
      elementIndex: -1,
      pinIndex: 0,
      pinLabel: "node",
      direction: bd.role === "output" ? PinDirection.OUTPUT : PinDirection.INPUT,
      bitWidth: 1,
      worldPosition: hubPos,
      wireVertex: null,
      domain: "analog",
      kind: "signal",
    };

    const partComp: PartitionedComponent = {
      element,
      definition: def as StandaloneComponentDefinition,
      modelKey: "default",
      model: null,
      resolvedPins: [resolvedPin],
    };
    adapterComponents.push(partComp);
    adapterInfoByPinKey.set(bd.pinKey, {
      pinKey: bd.pinKey,
      role: bd.role,
      label: syntheticInstanceId,
    });
  }

  return { adapterComponents, adapterInfoByPinKey };
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
  partitionIn: SolverPartition,
  registry: ComponentRegistry,
  logicFamily?: LogicFamilyConfig,
  outerCircuit?: Circuit,
  _digitalCompiler?: DigitalCompilerFn,
  digitalPinLoading: "cross-domain" | "all" | "none" = "cross-domain",
  perNetLoadingOverrides?: ReadonlyMap<number, "loaded" | "ideal">,
): ConcreteCompiledAnalogCircuit {
  let partition: SolverPartition = partitionIn;
  const diagnostics: Diagnostic[] = [];

  // Extract typed inline runtime models for use in route resolution.
  const runtimeModelMap: Record<string, Record<string, ModelEntry>> | undefined =
    outerCircuit?.metadata.models;

  // Synthesize one boundary-adapter PartitionedComponent per crossing pin from
  // partition.bridgeStubs and inject them into the analog component set BEFORE
  // Pass A, so the route resolver, the node-map deck walk (which mints each
  // adapter's composite-internal nets), and the main element loop expand them
  // uniformly as composites. Each adapter's single `node` pin sits on the
  // shared analog hub world-position so it binds to the hub MNA node; nothing
  // pins the hub. This replaces the hand-rolled BridgeOutput/InputDriverElement
  // ideal-voltage-source stamp.
  const { adapterComponents, adapterInfoByPinKey } = synthesizeBoundaryAdapters(
    partition,
    registry,
    logicFamily ?? defaultLogicFamily(),
    digitalPinLoading,
    perNetLoadingOverrides,
  );
  if (adapterComponents.length > 0) {
    partition = {
      components: [...partition.components, ...adapterComponents],
      groups: partition.groups,
      bridgeStubs: partition.bridgeStubs,
    };
  }

  // Pass A: resolve component routes + merged params + (for composites) the
  // resolved MnaSubcircuitNetlist + subcktParams + parentLabel. Must run
  // before the node-map builder so the latter can walk into each composite
  // at its deck position and allocate composite-internal node IDs in
  // INPpas2 first-encounter order.
  const elementMeta = runPassA_partition(partition, diagnostics, digitalPinLoading, runtimeModelMap);
  const metaByComponent = new Map<PartitionedComponent, PartitionElementMeta>();
  for (const m of elementMeta) metaByComponent.set(m.pc, m);

  // Build node map from partition groups. Composite-internal IDs are
  // interleaved with external IDs at the position the parent composite
  // occupies in the deck walk, matching ngspice's flattened-deck INPpas2
  // node-numbering. `preAllocatedNodes` is seeded with the composite-internal
  // entries here; the engine reads it before `_setup()` runs.
  const {
    nodeCount: deckWalkNodeCount,
    groupToNodeId,
    wireToNodeId,
    labelToNodeId,
    labelPinNodes,
    positionToNodeId,
    compositeInternalIds,
    preAllocatedNodes,
  } = buildAnalogNodeMapFromPartition(
    partition,
    diagnostics,
    metaByComponent,
    registry,
    runtimeModelMap,
  );

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

  // Compile-time node allocator for composite-internal nets that the
  // flattened-deck walk did NOT visit (declared but unreferenced by any
  // sub-element pin — straggler case in `expandCompositeInstance`). These
  // IDs land past the deck-walk range, since ngspice doesn't see them on
  // its flattened deck either. The engine seeds `_nodeTable` with
  // `preAllocatedNodes` before `_setup()` so element-private `makeVolt`
  // calls during setup continue from `compiled.nodeCount + 1`.
  let totalNodeCount = deckWalkNodeCount;
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
  const analogElements: import("./element.js").AnalogElement[] = [];
  // Canonical deck sequence accumulator. Per top-level component, the device-line
  // elements it contributes in deck order (primitive => [itself]; composite =>
  // [wrapper, ...leaves]). Ordered by `deckOrder` before the sort to assign each
  // element a single `deckIndex` — the one ordering basis shared by node
  // numbering, the deck emitter, and the setup/load walk.
  const deckGroups: { typeId: string; elements: import("./element.js").AnalogElement[] }[] = [];
  const elementToCircuitElement = new Map<number, CircuitElement>();
  const elementPinVertices = new Map<number, Array<{ x: number; y: number } | null>>();
  const elementResolvedPins = new Map<number, ResolvedPin[]>();

  const timeRef = { value: 0 };

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

    // Resolve pin → node ID bindings.
    //
    // Use the partition's authoritative per-pin resolution (`pc.resolvedPins`)
    // rather than spatial wire-walking on `circuit.wires`. The spec-mode
    // partition assigned each pin to its correct connectivity group based on
    // the SpecConnection list; a spatial wire-walk breaks at auto-layout
    // corner collisions where two routed wires from distinct nets share an
    // endpoint coordinate. `positionToNodeId` is keyed by pin world-position
    // and carries the spec-derived group nodeId for each pin position, which
    // is the same lookup `labelToNodeId` uses (see line ~905 above).
    const livePins = el.getPins();
    const pinVertices: Array<{ x: number; y: number } | null> = new Array(
      livePins.length,
    ).fill(null);
    const pinNodeIds: number[] = new Array(livePins.length).fill(-1);
    for (const rp of pc.resolvedPins) {
      if (rp.pinIndex < 0 || rp.pinIndex >= livePins.length) continue;
      const key = `${rp.worldPosition.x},${rp.worldPosition.y}`;
      const nodeId = positionToNodeId.get(key);
      if (nodeId !== undefined) {
        pinNodeIds[rp.pinIndex] = nodeId;
        pinVertices[rp.pinIndex] = rp.wireVertex ?? { x: rp.worldPosition.x, y: rp.worldPosition.y };
      }
    }

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
      core = analogFactory(pinNodes, props);
      core.label = resolvedLabel;
    } else {
      // The composite's netlist + subcktParams + parentLabel were resolved
      // up-front in Pass A and stored on the meta so the node-map builder
      // could allocate composite-internal IDs against the same netlist
      // instance. Reuse those here.
      if (!meta.composite) {
        throw new Error(
          `Compose route on "${resolvedLabel}" (${pc.element.typeId}) has no ` +
            `pre-resolved netlist on its PartitionElementMeta. runPassA_partition ` +
            `should populate meta.composite for every compose route.`,
        );
      }
      const { netlist, subcktParams } = meta.composite;
      // Parent-side runtime hook: instantiate once per parent-component
      // instance and thread to the wrapper. The wrapper forwards
      // load/setDiagnosticEmitter/setParam/acceptStep calls to the hook;
      // the existing RuntimeDiagnosticAware wiring in MNAEngine.init()
      // hooks the diagnostic emitter via the wrapper's setDiagnosticEmitter.
      // The factory is invoked inside expandCompositeInstance after the
      // sub-elements are built so the hook can address them by name (e.g.
      // re-derive a VCVS gain when an outer vOH changes).
      const hookFactory = def.analogWrapperHook;
      const expanded = expandCompositeInstance(
        netlist,
        subcktParams,
        pinNodes,
        resolvedLabel,
        pc.element.typeId,
        registry,
        runtimeModelMap,
        allocateCompositeNode,
        compositeInternalIds,
        hookFactory,
        props,
        nodeIdToLoadingOverride,
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
          ...(decl?.currentLead ? { currentLead: decl.currentLead } : {}),
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
    // One deck group per top-level component, in construction (deck) order
    // within the group: [primitive] or [wrapper, ...leaves].
    deckGroups.push({ typeId: pc.element.typeId, elements: [element, ...composedLeaves] });
  }

  // Per-pin boundary adapters were synthesized into partition.components and
  // expanded as composites by the main element loop above (their wrapper +
  // leaves are already in analogElements). Index the expanded wrapper handles
  // by pinKey and resolve each input adapter's `nResult` MNA node id from
  // compositeInternalIds so the coordinator can read the threshold result.
  const bridgeAdaptersByPinKey = new Map<string, BridgePinAdapterHandle>();

  for (const [pinKey, info] of adapterInfoByPinKey) {
    // The wrapper element's label is the synthetic instance id (info.label).
    const wrapper = analogElements.find(
      (el) => el.label === info.label,
    ) as SubcircuitWrapperElement | undefined;
    if (wrapper === undefined) continue; // unconnected hub pin → excluded

    if (info.role === "input") {
      // nResult is a composite-internal net keyed `${label}#nResult`.
      const resultNodeId = compositeInternalIds.get(`${info.label}#nResult`);
      bridgeAdaptersByPinKey.set(pinKey, {
        pinKey,
        role: "input",
        wrapper,
        resultNodeId: resultNodeId ?? -1,
      });
    } else {
      bridgeAdaptersByPinKey.set(pinKey, {
        pinKey,
        role: "output",
        wrapper,
        resultNodeId: -1,
      });
    }
  }

  // Architectural alignment A1: sort by ngspiceLoadOrder so that per-iteration
  // cktLoad walks devices in the same per-type bucket order ngspice does (every
  // R, every C, ..., every V, ...). Within each bucket, walk in REVERSE deck
  // order: ngspice's `cktcrte.c:62-64` prepends every parsed instance to the
  // model's GENinstances list, so CKTsetup (cktsetup.c:104-110) and CKTload
  // (cktload.c:62-64) walk that list head->tail = reverse of deck-parse order.
  // The tie-break is `deckIndex` DESC — each element's slot in the single
  // canonical deck sequence (assigned just below from `deckOrder`, the same
  // basis node numbering and the deck emitter use). NOTE: build/insertion order
  // is NOT deck order once a composite flattens its leaves into device-type
  // buckets (e.g. a CAP composite's R-leaves sort ahead of a discrete R) — that
  // mismatch was the bit-exact parity bug. The sort must run before state-pool
  // allocation and before the index maps are returned.
  //
  // Re-key the three index maps and rewrite each element's elementIndex field
  // so post-sort indices stay consistent.
  //
  // Assign each element its canonical deckIndex. `deckOrder` ranks the groups by
  // (ngspiceLoadOrder ASC, build-order ASC) — identical to the top-level basis
  // `componentsInDeckOrder` (node numbering) and the harness deck emitter use;
  // within a group the contributed device lines keep construction (deck) order.
  const deckIndexByEl = new Map<import("./element.js").AnalogElement, number>();
  {
    let deckCounter = 0;
    for (const { item } of deckOrder(deckGroups)) {
      for (const el of item.elements) deckIndexByEl.set(el, deckCounter++);
    }
  }
  const oldIndexToElement = analogElements.map((el, i) => ({ el, oldIndex: i }));
  analogElements.sort((a, b) => {
    const orderDiff = a.ngspiceLoadOrder - b.ngspiceLoadOrder;
    if (orderDiff !== 0) return orderDiff;
    // Reverse canonical deck order within a device-type bucket (ngspice LIFO).
    return deckIndexByEl.get(b)! - deckIndexByEl.get(a)!;
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

  // Per-element-index canonical deck position, exposed on the compiled circuit.
  // The harness deck emitter consumes this to emit device lines in deck order
  // instead of re-deriving the sequence — closing the last parallel ordering path.
  const deckOrderByElementIndex = analogElements.map((el) => deckIndexByEl.get(el) ?? -1);

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
    deckOrderByElementIndex,
    labelToNodeId,
    labelPinNodes,
    wireToNodeId,
    models,
    elementToCircuitElement,
    elementPinVertices,
    elementResolvedPins,
    groupToNodeId,
    bridgeAdaptersByPinKey,
    diagnostics,
    timeRef,
    statePool,
    preAllocatedNodes,
  });
}
