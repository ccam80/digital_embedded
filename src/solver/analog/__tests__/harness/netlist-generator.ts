/**
 * Auto-generates a SPICE netlist from a compiled analog circuit.
 *
 * Iterates compiled elements, uses element labels for SPICE instance names,
 * reads parameters from property bags, and emits SPICE element lines.
 * Emits model cards for semiconductors.
 */

import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { PropertyBag } from "../../../../core/properties.js";
import {
  ComponentRegistry,
  type ParamDef,
  type ModelEmissionSpec,
  type ComponentDefinition,
} from "../../../../core/registry.js";
import type {
  MnaSubcircuitNetlist,
  SubcircuitElement,
  SubcircuitElementParam,
} from "../../../../core/mna-subcircuit-netlist.js";
import { deckOrder } from "../../ngspice-load-order.js";
import {
  enumWaveformCoeffs,
  FunctionType,
  type Waveform,
} from "../../../../components/sources/ac-voltage-source.js";

// ---------------------------------------------------------------------------
// SPICE prefix table (typeId -> SPICE prefix, model type for semiconductors)
// ---------------------------------------------------------------------------

interface ElementSpec {
  prefix: string;
  modelType?: string;
}

const ELEMENT_SPECS: Record<string, ElementSpec> = {
  Resistor:        { prefix: "R" },
  Capacitor:       { prefix: "C", modelType: "C" },
  Inductor:        { prefix: "L" },
  DcVoltageSource: { prefix: "V" },
  AcVoltageSource: { prefix: "V" },
  DcCurrentSource: { prefix: "I" },
  AcCurrentSource: { prefix: "I" },
  Diode:           { prefix: "D", modelType: "D" },
  ZenerDiode:      { prefix: "D", modelType: "D" },
  VaractorDiode:   { prefix: "D", modelType: "D" },
  SchottkyDiode:   { prefix: "D", modelType: "D" },
  NpnBJT:          { prefix: "Q", modelType: "NPN" },
  PnpBJT:          { prefix: "Q", modelType: "PNP" },
  NMOS:            { prefix: "M", modelType: "NMOS" },
  PMOS:            { prefix: "M", modelType: "PMOS" },
  // VDMOS: ngspice `M<name> nd ng ns <model>` with `.model <name> VDMOS(...)`.
  // The N/P-ness is a model-card flag (nchan/pchan), not a separate model type.
  VDMOSN:          { prefix: "M", modelType: "VDMOS" },
  VDMOSP:          { prefix: "M", modelType: "VDMOS" },
  NJFET:           { prefix: "J", modelType: "NJF" },
  PJFET:           { prefix: "J", modelType: "PJF" },
  VCVS:            { prefix: "E" },
  VCCS:            { prefix: "G" },
  CCVS:            { prefix: "H" },
  CCCS:            { prefix: "F" },
  // InternalCccs is the internal-only flavour of CCCS used inside composites
  // (e.g. Optocoupler). Same ngspice F-card; the sense V-source is identified
  // by a `{ kind: "ref" }` peer reference rather than user-facing sense pins.
  InternalCccs:    { prefix: "F" },
  SwitchSPST:      { prefix: "S", modelType: "SW" },
  SwitchSPDT:      { prefix: "S", modelType: "SW" },
  Switch:          { prefix: "S", modelType: "SW" },
  SwitchDT:        { prefix: "S", modelType: "SW" },
  CurrentControlledSwitch: { prefix: "W", modelType: "CSW" },
  TransmissionLine: { prefix: "T" },
  LDR:             { prefix: "R" },
  VariableRail:    { prefix: "V" },
  Clock:           { prefix: "V" },
};

/**
 * SPICE infers an element's device class from its instance name's first
 * letter. User-authored labels (e.g. "Vc" for a capacitor, "vs" for a v-source,
 * "r1" vs "R1") may not start with the correct SPICE prefix for their type.
 * Emit them verbatim and ngspice silently reinterprets the device. When the
 * label's first letter (case-insensitive) does not match the required SPICE
 * prefix, prepend the prefix so ngspice parses the element as the correct
 * type. Same canonicalization is needed for V-source references on H/F element
 * lines (the sense source is named via the user's senseSourceLabel, but the
 * emitted V-source line carries the canonicalized name).
 */
export function canonicalizeSpiceLabel(rawLabel: string, requiredPrefix: string): string {
  const upper = requiredPrefix.toUpperCase();
  return rawLabel.charAt(0).toUpperCase() === upper ? rawLabel : `${upper}${rawLabel}`;
}

// ---------------------------------------------------------------------------
// Subcircuit recursion helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `{ kind: "ref", name }` cross-element reference to the canonical
 * SPICE label of the referenced sibling sub-element.
 *
 * The runtime resolves refs via `ctx.findBranch` / `ctx.findDevice`. For the
 * harness's paired-vs-ngspice path the same ref must resolve to a SPICE
 * device-name on the emitted deck. That resolution is derived, not enumerated:
 * the sibling's `typeId` (already declared in the parent netlist) determines
 * the SPICE prefix via `ELEMENT_SPECS`. ngspice's CCCS/CCVS (`F`/`H` cards),
 * CSW (`W` card), and K (mutual inductor) all consume the same shape — a
 * canonical device-name string identifying the sibling — so there is nothing
 * per-`(typeId, key)` about the resolution.
 *
 * Throws if the sibling is not present in `parentSubckt.elements`, or if the
 * sibling's typeId has no SPICE prefix entry. The latter is the only case
 * that legitimately means the composite is non-SPICE-faithful as factored.
 */
function resolveRefToSpiceLabel(
  ref: { name: string },
  parentSubckt: MnaSubcircuitNetlist,
  parentRawLabel: string,
): string {
  const target = parentSubckt.elements.find((e) => e.subElementName === ref.name);
  if (!target) {
    throw new Error(
      `netlist-generator: ref { name: '${ref.name}' } in '${parentRawLabel}' ` +
      `points at no sibling sub-element. Available subElementNames: ` +
      `${parentSubckt.elements.map((e) => e.subElementName ?? `<${e.typeId}>`).join(", ")}.`
    );
  }
  const spec = ELEMENT_SPECS[target.typeId];
  if (!spec) {
    throw new Error(
      `netlist-generator: ref to sibling '${ref.name}' of typeId '${target.typeId}' ` +
      `has no SPICE prefix in ELEMENT_SPECS. Either add an entry for that typeId, ` +
      `or mark the parent composite pairedSpiceEquivalent: false.`
    );
  }
  return canonicalizeSpiceLabel(`${parentRawLabel}_${ref.name}`, spec.prefix);
}

/**
 * Resolve a sub-element's params into a synthetic PropertyBag suitable for
 * the primitive-emit path. Resolution rules per SubcircuitElementParam:
 *   - number literal -> setModelParam(key, value)
 *   - string lookup  -> read from parent's model params (preferred) or
 *                       subckt.params defaults; throw if neither
 *                       defines the key
 *   - { kind: "ref" } -> resolve to the canonical SPICE label of the
 *                       referenced sibling via `resolveRefToSpiceLabel`
 *                       and store under the same key (as a non-model
 *                       string prop). The downstream emit branch for the
 *                       consuming card type (F/H/W/etc.) reads that prop.
 *
 * The synthetic bag also carries `model = sub.modelRef` (when set) so that
 * the existing emit-path's `props.has("model") ? props.get("model") :
 * def.defaultModel` selector picks the correct sub-model.
 */
function resolveSubElementProps(
  sub: SubcircuitElement,
  parentSubckt: MnaSubcircuitNetlist,
  parentProps: PropertyBag,
  parentRawLabel: string,
): PropertyBag {
  const bag = new PropertyBag();
  if (sub.modelRef !== undefined) bag.set("model", sub.modelRef);
  const subcktParams = parentSubckt.params;
  const subParams = sub.params ?? {};
  for (const subKey of Object.keys(subParams)) {
    const v: SubcircuitElementParam = subParams[subKey];
    let resolved: number | undefined;
    if (typeof v === "number") {
      resolved = v;
    } else if (typeof v === "string") {
      if (parentProps.hasModelParam(v)) {
        resolved = parentProps.getModelParam<number>(v);
      } else if (subcktParams && Object.prototype.hasOwnProperty.call(subcktParams, v)) {
        resolved = subcktParams[v];
      } else {
        throw new Error(
          `netlist-generator: sub-element '${sub.subElementName ?? sub.typeId}' ` +
          `param '${subKey}' references '${v}' but neither the parent's model ` +
          `params nor the subcircuit's defaults define a value for that key.`
        );
      }
    } else if (typeof v === "object" && v !== null && "kind" in v && v.kind === "ref") {
      bag.set(subKey, resolveRefToSpiceLabel(v, parentSubckt, parentRawLabel));
      continue;
    } else {
      throw new Error(
        `netlist-generator: sub-element '${sub.subElementName ?? sub.typeId}' ` +
        `param '${subKey}' has unrecognized SubcircuitElementParam shape ` +
        `${JSON.stringify(v)}. Update resolveSubElementProps to handle it.`
      );
    }
    bag.setModelParam(subKey, resolved);
  }
  return bag;
}

/**
 * Emit-time context: tracks the next available global node ID for fresh
 * internal-net allocation during subcircuit recursion. Seeded from the
 * compiled circuit's nodeCount + 1 (node 0 is ground; nodeCount counts the
 * non-ground outer nodes already in use).
 */
interface EmitCtx {
  nextInternalNet: number;
  /**
   * Pre-allocated composite-internal nodes, keyed by `${parentLabel}#${suffix}`.
   * The compiler runs `expandCompositeInstance` (compiler.ts) and assigns
   * each composite-internal net a node ID via the `allocateCompositeNode`
   * threaded into the recursion. Those IDs land in compiled.preAllocatedNodes.
   *
   * The deck emitter MUST reuse those IDs rather than allocate fresh ones,
   * because the harness's node-mapping looks up ngspice node names by their
   * digiTS node ID as a decimal string — if the deck emits a composite
   * internal net at deck node "7" while digiTS calls it node 5, the harness
   * cannot correlate the two and treats the value as missing (null) on the
   * ngspice side.
   */
  preAllocatedNodes: ReadonlyMap<string, number>;
}

function allocateInternalNet(ctx: EmitCtx): number {
  return ctx.nextInternalNet++;
}

/**
 * Resolve a composite-internal net to its compiled node ID. Throws if the
 * (parentLabel, suffix) pair was not pre-allocated by the compiler — every
 * MnaSubcircuitNetlist internal net is assigned an ID by
 * `expandCompositeInstance` (compiler.ts), so a miss is a generator bug.
 */
function resolveCompositeInternalNet(
  ctx: EmitCtx,
  parentLabel: string,
  suffix: string,
): number {
  const key = `${parentLabel}#${suffix}`;
  const id = ctx.preAllocatedNodes.get(key);
  if (id === undefined) {
    throw new Error(
      `netlist-generator: composite-internal net '${key}' not present in ` +
      `compiled.preAllocatedNodes. expandCompositeInstance should have ` +
      `allocated it; check that compileAnalog ran with the same ` +
      `MnaSubcircuitNetlist that emitElement is recursing into.`
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// generateSpiceNetlist
// ---------------------------------------------------------------------------

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  registry: ComponentRegistry,
  elementLabels: Map<number, string>,
  title?: string,
  nodesets?: ReadonlyMap<number, number>,
  ics?: ReadonlyMap<number, number>,
): string {
  const lines: string[] = [];

  // Title line
  lines.push(title ?? "Auto-generated netlist");

  // Collect model cards: modelName -> ".model <name> <type> (<params>)"
  const modelCards = new Map<string, string>();

  // One element line per compiled element. The MNA node-map walk and this deck
  // emitter MUST iterate device lines in the identical order (inppas2.c:76
  // top-to-bottom card walk), or parse-time node integers desync from the
  // emitted deck. Both consume the single shared `deckOrder` producer
  // (ngspice-load-order.ts).
  //
  // `compiled.elements` is stored (ngspiceLoadOrder ASC, build-order DESC)-
  // reverse-within-bucket, because cktcrte.c:62-64's LIFO instance prepend
  // reverses the per-iteration load walk back. Node numbering, by contrast,
  // is the forward parse order. To recover each element's forward build order,
  // enumerate the array in reverse (ascending originalIndex tracks the original
  // build order within each bucket), then `deckOrder` re-buckets into
  // forward-within-bucket emission order. Sub-elements (no parent
  // CircuitElement) are emitted via their parent's subcircuit recursion, so
  // they are excluded from the top-level deck order here.
  const emittable: { typeId: string; arrayIndex: number }[] = [];
  for (let i = compiled.elements.length - 1; i >= 0; i--) {
    const circuitEl = compiled.elementToCircuitElement.get(i);
    if (!circuitEl) continue;
    emittable.push({ typeId: circuitEl.typeId, arrayIndex: i });
  }
  const emitOrder = deckOrder(emittable).map(({ item }) => item.arrayIndex);
  // Emit-context: subcircuit recursion reuses compiler-assigned IDs for
  // composite-internal nets when present (so the deck names match digiTS
  // node IDs and the harness's nodeMap correlates them by stringified id).
  // Fresh IDs are allocated past compiled.nodeCount only for emit-time-only
  // nets (e.g. synthesised switch control-V-source mid-rails) that the
  // compiler did not pre-allocate.
  const preAllocatedByName = new Map<string, number>();
  for (const entry of compiled.preAllocatedNodes) {
    preAllocatedByName.set(entry.name, entry.number);
  }
  const emitCtx: EmitCtx = {
    nextInternalNet: compiled.nodeCount + 1,
    preAllocatedNodes: preAllocatedByName,
  };

  for (const i of emitOrder) {
    const el = compiled.elements[i]!;
    const rawLabel = elementLabels.get(i) ?? `element_${i}`;
    const circuitEl = compiled.elementToCircuitElement.get(i);

    // Sub-elements from composite-component decomposition have no parent
    // CircuitElement entry. They're emitted via their parent's subcircuit
    // recursion (driven from the parent's MnaSubcircuitNetlist), so skip
    // them here to avoid double-emission.
    if (!circuitEl) continue;

    const typeId = circuitEl.typeId;
    const props = circuitEl.getProperties();
    const def = registry.get(typeId);
    if (!def) {
      throw new Error(`netlist-generator: typeId "${typeId}" not registered`);
    }
    const modelKey = props.has("model")
      ? props.get<string>("model")
      : (def.defaultModel ?? "");
    const pinNodes = [...el.pinNodes.values()];
    const pinNodesByLabel = new Map(el.pinNodes);

    lines.push(...emitElement(
      rawLabel, typeId, pinNodes, pinNodesByLabel,
      props, modelKey, registry, modelCards, emitCtx,
    ));
  }

  // Emit model cards
  for (const card of modelCards.values()) {
    lines.push(card);
  }

  // Emit the .nodeset card (ngspice-only DC operating-point GUESS). Each listed
  // node is clamped to its value with a 1e10 conductance during the
  // MODEINITJCT / MODEINITFIX passes and RELEASED before the final
  // MODEINITFLOAT solve (cktload.c:107-120: nsGiven nodes get
  // CKTrhs[number] = 1e10 * nodeset * CKTsrcFact and *(node->ptr) = 1e10). On a
  // circuit with more than one stable DC operating point the guess steers the
  // solver into one state. The deck emits stringified digiTS node IDs as node
  // names, so V(<id>) targets the same node digiTS allocated. Node 0 is ground;
  // a nodeset on ground is meaningless and rejected.
  if (nodesets && nodesets.size > 0) {
    const parts: string[] = [];
    for (const [nodeId, value] of nodesets) {
      if (nodeId === 0) {
        throw new Error(
          `netlist-generator: .nodeset on node 0 (ground) is meaningless; ` +
          `ground is fixed at 0 V. Remove the ground entry from the nodesets map.`
        );
      }
      parts.push(`V(${nodeId})=${value}`);
    }
    lines.push(`.nodeset ${parts.join(" ")}`);
  }

  // Emit the .ic card (transient-boot INITIAL CONDITION). Each listed node is
  // constrained to its value during the MODETRANOP transient-boot DCOP when
  // MODEUIC is not set (cktload.c:131-158: icGiven nodes get
  // CKTrhs[number] = 1e10 * ic * CKTsrcFact and *(node->ptr) += 1e10). Unlike a
  // .nodeset GUESS, an .ic is enforced through the transient-boot operating
  // point. The deck emits stringified digiTS node IDs as node names, so V(<id>)
  // targets the same node digiTS allocated. Node 0 is ground; an IC on ground
  // is meaningless and rejected.
  if (ics && ics.size > 0) {
    const parts: string[] = [];
    for (const [nodeId, value] of ics) {
      if (nodeId === 0) {
        throw new Error(
          `netlist-generator: .ic on node 0 (ground) is meaningless; ` +
          `ground is fixed at 0 V. Remove the ground entry from the ics map.`
        );
      }
      parts.push(`V(${nodeId})=${value}`);
    }
    lines.push(`.ic ${parts.join(" ")}`);
  }

  lines.push(".end");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// emitElement- recursive dispatcher
// ---------------------------------------------------------------------------

/**
 * Emit SPICE deck lines for one component instance. Either:
 *   (a) The active model is `kind: "netlist"`-> recurse into the
 *       MnaSubcircuitNetlist, mapping ports to outer pinNodes and allocating
 *       fresh internal nets, then emit each sub-element.
 *   (b) The active model is `kind: "inline"` and typeId is in ELEMENT_SPECS
 *       -> emit one primitive line via emitPrimitive.
 *   (c) Otherwise -> throw with a precise message naming the typeId.
 *
 * `pinNodes` is the pin-index-ordered array (matching pinLayout order) used
 * by the primitive-emit branches. `pinNodesByLabel` is the same data keyed
 * by pin label, used to map subcircuit ports to outer global nodes.
 */
function emitElement(
  rawLabel: string,
  typeId: string,
  pinNodes: number[],
  pinNodesByLabel: ReadonlyMap<string, number>,
  props: PropertyBag,
  modelKey: string,
  registry: ComponentRegistry,
  modelCards: Map<string, string>,
  ctx: EmitCtx,
): string[] {
  const def = registry.get(typeId);
  if (!def) {
    throw new Error(`netlist-generator: typeId '${typeId}' not registered`);
  }
  const modelEntry = def.modelRegistry?.[modelKey];

  if (modelEntry?.kind === "netlist") {
    const subckt = typeof modelEntry.netlist === "function"
      ? modelEntry.netlist(props)
      : modelEntry.netlist;

    // Map subcircuit port (by label) -> outer global node ID.
    const portToOuter: number[] = subckt.ports.map((portLabel) => {
      const n = pinNodesByLabel.get(portLabel);
      if (n === undefined) {
        throw new Error(
          `netlist-generator: subcircuit '${typeId}' (label='${rawLabel}') port ` +
          `'${portLabel}' has no matching outer pin. Subcircuit ports must align ` +
          `with the parent component's pin labels by name.`
        );
      }
      return n;
    });

    // Internal-net IDs reuse what `expandCompositeInstance` (compiler.ts)
    // pre-allocated for this composite instance — keyed by ${rawLabel}#${suffix}
    // in compiled.preAllocatedNodes. Falling back to allocateInternalNet would
    // give the deck a fresh ID that doesn't match digiTS's node ID, breaking
    // the harness's nodeMap correlation. Walks elements in deck order so that
    // ngspice's first-encounter parser semantics still produce the same hash
    // insertion order as our compile-time allocation.
    const internalNets: number[] = new Array(subckt.internalNetCount);
    for (let slot = 0; slot < subckt.internalNetCount; slot++) {
      const suffix = subckt.internalNetLabels?.[slot] ?? `int${slot}`;
      internalNets[slot] = resolveCompositeInternalNet(ctx, rawLabel, suffix);
    }

    const lines: string[] = [];
    for (let i = 0; i < subckt.elements.length; i++) {
      const sub = subckt.elements[i]!;

      // MutualInductor maps directly to ngspice's K element. ngspice K
      // resolves L1Name/L2Name to coil branch indices and stamps mutual-
      // inductance off-diagonals (mutsetup.c:66-67, mutload.c) — identical to
      // our `{ kind: "ref" }` semantics. Emit inline because the K card is
      // structurally different from a leaf param substitution.
      if (sub.typeId === "MutualInductor") {
        lines.push(...emitMutualInductorK(rawLabel, sub, subckt, props));
        continue;
      }

      const subDef = registry.get(sub.typeId);
      if (!subDef) {
        throw new Error(
          `netlist-generator: subcircuit '${typeId}' references unregistered ` +
          `sub-element typeId '${sub.typeId}' (subElementName='${sub.subElementName}').`
        );
      }

      const subPinLabels = subDef.pinLayout?.map((p) => p.label) ?? [];
      const netIndices = subckt.netlist[i] ?? [];
      const subPinNodes: number[] = [];
      const subPinNodesByLabel = new Map<string, number>();
      for (let p = 0; p < netIndices.length; p++) {
        const netIdx = netIndices[p]!;
        const outer = netIdx < subckt.ports.length
          ? portToOuter[netIdx]!
          : internalNets[netIdx - subckt.ports.length]!;
        subPinNodes.push(outer);
        const pinLabel = subPinLabels[p] ?? `p${p}`;
        subPinNodesByLabel.set(pinLabel, outer);
      }

      const subProps = resolveSubElementProps(sub, subckt, props, rawLabel);
      const subRawLabel = `${rawLabel}_${sub.subElementName ?? `e${i}`}`;
      const subModelKey = sub.modelRef ?? subDef.defaultModel ?? "";

      lines.push(...emitElement(
        subRawLabel, sub.typeId, subPinNodes, subPinNodesByLabel,
        subProps, subModelKey, registry, modelCards, ctx,
      ));
    }
    return lines;
  }

  // Primitive leaf: dispatch via ELEMENT_SPECS.
  const spec = ELEMENT_SPECS[typeId];
  if (!spec) {
    throw new Error(
      `netlist-generator: typeId '${typeId}' (label='${rawLabel}') has no entry in ` +
      `ELEMENT_SPECS and therefore no SPICE-deck emission. Either (a) add an entry ` +
      `to ELEMENT_SPECS with the matching SPICE prefix (E/F/G/H for controlled ` +
      `sources, K for mutual coupling, T for transmission line, S/W for switches, ` +
      `etc.) and a corresponding emit branch in emitPrimitive, (b) declare the ` +
      `component as a subcircuit (modelRegistry[..].kind = 'netlist') so the ` +
      `generator recurses into primitives, or (c) flag the component ` +
      `pairedSpiceEquivalent: false so the harness skips ngspice comparison for it.`
    );
  }

  return emitPrimitive(rawLabel, typeId, spec, pinNodes, props, def, modelKey, modelCards, ctx);
}

// ---------------------------------------------------------------------------
// emitPrimitive- single-line emission for a SPICE-primitive leaf
// ---------------------------------------------------------------------------

/**
 * Emit SPICE element line(s) for a primitive leaf (typeId in ELEMENT_SPECS).
 * Pulls paramDefs / spice emission spec from the active model entry, applies
 * SPICE-prefix canonicalization on the instance name, and dispatches by
 * typeId / spec.prefix to the appropriate per-class branch. Pushes any
 * required `.model` cards into `modelCards`. Returns one or more lines
 * (Switch/SwitchDT emit a synthesized V-source line plus one or two S lines).
 */
function emitPrimitive(
  rawLabel: string,
  typeId: string,
  spec: ElementSpec,
  nodes: number[],
  props: PropertyBag,
  def: ComponentDefinition,
  modelKey: string,
  modelCards: Map<string, string>,
  ctx: EmitCtx,
): string[] {
  let paramDefs: readonly ParamDef[] = [];
  let emission: ModelEmissionSpec | undefined;
  const modelEntry = def.modelRegistry?.[modelKey];
  if (modelEntry) {
    paramDefs = modelEntry.paramDefs;
    emission = modelEntry.kind === "netlist" ? modelEntry.spice : undefined;
  } else if (spec.modelType !== undefined) {
    throw new Error(`netlist-generator: typeId "${typeId}" has no modelRegistry["${modelKey}"]`);
  }

  const label = canonicalizeSpiceLabel(rawLabel, spec.prefix);

  if (typeId === "Resistor") {
    const R = requireParam(props, def, modelKey, "resistance", rawLabel);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${R}${instanceParamSuffix(paramDefs, props)}`];
  }
  if (typeId === "Capacitor") {
    // ngspice C-card has two semantic paths gated by captemp.c:55-70:
    //
    //   1. Direct-value path (instance VALUE given):
    //        `Cxxx N+ N- VALUE [inst-params]`
    //      ngspice's captemp.c:69-70 takes the positional VALUE as the cap;
    //      cj/cjsw/defw/defl on a .model card are unused. Emit with NO model
    //      card so ngspice attaches its default cap model.
    //
    //   2. Geometric / model path (instance VALUE NOT given):
    //        `Cxxx N+ N- MODELNAME [W=... L=... inst-params]`
    //      + `.model MODELNAME C (cj=... cjsw=... defw=... defl=... ...)`
    //      ngspice's captemp.c:55-68 computes effective C from the model's
    //      process params and the instance W/L.
    //
    // The positional VALUE wins outright (captemp.c:70 reset), so emitting
    // both VALUE and MODELNAME is contradictory and ngspice rejects the
    // resulting C-card. Gate on isModelParamGiven("capacitance").
    if (props.isModelParamGiven("capacitance")) {
      const C = props.getModelParam<number>("capacitance");
      return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${C}${instanceParamSuffix(paramDefs, props)}`];
    }
    const modelName = `${label}_${spec.modelType}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${modelName}${instanceParamSuffix(paramDefs, props)}`];
  }
  if (typeId === "Inductor") {
    const L = requireParam(props, def, modelKey, "inductance", rawLabel);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${L}${instanceParamSuffix(paramDefs, props)}`];
  }
  if (typeId === "DcVoltageSource") {
    const V = requireParam(props, def, modelKey, "voltage", rawLabel);
    // SPICE convention: Vname pos neg value; our pins are [neg, pos]
    return [`${label} ${nodeAt(nodes, 1, rawLabel, "pos")} ${nodeAt(nodes, 0, rawLabel, "neg")} DC ${V}`];
  }
  if (typeId === "AcVoltageSource") {
    const amp   = requireParam(props, def, modelKey, "amplitude", rawLabel);
    const dc    = requireParam(props, def, modelKey, "dcOffset", rawLabel);
    const freq  = requireParam(props, def, modelKey, "frequency", rawLabel);
    const phase = requireParam(props, def, modelKey, "phase", rawLabel);
    const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
    const posNode = nodeAt(nodes, 1, rawLabel, "pos");
    const negNode = nodeAt(nodes, 0, rawLabel, "neg");
    // ngspice V-source AC token: `AC <mag> [<phase>]` (vsrctemp.c:38-42,
    // 68-70). digiTS's AcVoltageSourceAnalogImpl.stampAc reads these
    // properties on its element (vsrcacld.c:175-180), so the emitted
    // ngspice deck must carry the same `acMagnitude` / `acPhase` values
    // for the .ac sweep stimuli to match bit-exact.
    const acMag   = requireParam(props, def, modelKey, "acMagnitude", rawLabel);
    const acPhase = requireParam(props, def, modelKey, "acPhase",     rawLabel);
    return [`${label} ${posNode} ${negNode} AC ${acMag} ${acPhase} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props, def, modelKey, rawLabel)}`];
  }
  if (typeId === "DcCurrentSource") {
    const I = requireParam(props, def, modelKey, "current", rawLabel);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} DC ${I}`];
  }
  if (typeId === "AcCurrentSource") {
    const amp      = requireParam(props, def, modelKey, "amplitude", rawLabel);
    const dc       = requireParam(props, def, modelKey, "dcOffset", rawLabel);
    const freq     = requireParam(props, def, modelKey, "frequency", rawLabel);
    const phase    = requireParam(props, def, modelKey, "phase", rawLabel);
    const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
    const posNode = nodeAt(nodes, 1, rawLabel, "pos");
    const negNode = nodeAt(nodes, 0, rawLabel, "neg");
    // ngspice I-source AC token: `AC <mag> [<phase>]` (isrcacld.c:36-50).
    // Symmetric with AcVoltageSource above.
    const acMag   = requireParam(props, def, modelKey, "acMagnitude", rawLabel);
    const acPhase = requireParam(props, def, modelKey, "acPhase",     rawLabel);
    return [`${label} ${posNode} ${negNode} AC ${acMag} ${acPhase} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props, def, modelKey, rawLabel)}`];
  }
  if (spec.prefix === "D") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 0, rawLabel, "anode")} ${nodeAt(nodes, 1, rawLabel, "cathode")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return [line];
  }
  if (spec.prefix === "Q") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 1, rawLabel, "C")} ${nodeAt(nodes, 0, rawLabel, "B")} ${nodeAt(nodes, 2, rawLabel, "E")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return [line];
  }
  if (spec.prefix === "M" && (typeId === "VDMOSN" || typeId === "VDMOSP")) {
    // ngspice VDMOS instance line: `M<name> nd ng ns <model>` (3 external
    // nodes; the body diode and prime nodes are internal). The model card is
    // `.model <name> VDMOS (nchan|pchan ...)` (vdmosmpar.c VDMOS_MOD_NMOS/PMOS).
    //
    // The model NAME must NOT contain the substring "vdmos" (any case). The
    // LTspice-VDMOS preprocessor `inp_vdmos_model` (inpcom.c:7947-7992) locates
    // VDMOS `.model` cards with a naive `strstr(line, "vdmos")` and cuts at the
    // FIRST occurrence (inpcom.c:7971-7972): a name like `m1_vdmos` would make
    // it cut inside the model NAME instead of at the `VDMOS` type keyword,
    // corrupting the rewritten card. Using `${label}MOD` keeps the only
    // "vdmos" occurrence at the legitimate `.model <name> VDMOS (...)` type word,
    // so the preprocessor latches onto the type keyword and emits `vdmosn (`.
    const modelName = `${label}MOD`;
    const d = nodeAt(nodes, 2, rawLabel, "D");
    const g = nodeAt(nodes, 0, rawLabel, "G");
    const s = nodeAt(nodes, 1, rawLabel, "S");
    const line = `${label} ${d} ${g} ${s} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, vdmosModelCard(modelName, typeId === "VDMOSN", paramDefs, props));
    }
    return [line];
  }
  if (spec.prefix === "M") {
    const modelName = `${label}_${spec.modelType}`;
    let d: number, g: number, s: number, b: number;
    if (typeId === "NMOS") {
      d = nodeAt(nodes, 2, rawLabel, "D");
      g = nodeAt(nodes, 0, rawLabel, "G");
      s = nodeAt(nodes, 1, rawLabel, "S");
      b = s;
    } else if (typeId === "PMOS") {
      d = nodeAt(nodes, 1, rawLabel, "D");
      g = nodeAt(nodes, 0, rawLabel, "G");
      s = nodeAt(nodes, 2, rawLabel, "S");
      b = s;
    } else {
      throw new Error(`netlist-generator: unknown MOSFET typeId '${typeId}'- add an explicit pin-order branch`);
    }
    const line = `${label} ${d} ${g} ${s} ${b} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return [line];
  }
  if (spec.prefix === "J") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 2, rawLabel, "D")} ${nodeAt(nodes, 0, rawLabel, "G")} ${nodeAt(nodes, 1, rawLabel, "S")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return [line];
  }
  if (typeId === "VCVS") {
    // VCVS pinLayout: [ctrl+, ctrl-, out+, out-] -> SPICE `Ename N+ N- NC+ NC- gain`
    assertLinearControlExpression(props, typeId, rawLabel, "V(ctrl)");
    const gain = requireParam(props, def, modelKey, "gain", rawLabel);
    return [`${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${nodeAt(nodes, 0, rawLabel, "ctrl+")} ${nodeAt(nodes, 1, rawLabel, "ctrl-")} ${gain}`];
  }
  if (typeId === "VCCS") {
    // VCCS pinLayout: [ctrl+, ctrl-, out+, out-] -> SPICE `Gname N+ N- NC+ NC- gm`
    assertLinearControlExpression(props, typeId, rawLabel, "V(ctrl)");
    const gm = requireParam(props, def, modelKey, "transconductance", rawLabel);
    return [`${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${nodeAt(nodes, 0, rawLabel, "ctrl+")} ${nodeAt(nodes, 1, rawLabel, "ctrl-")} ${gm}`];
  }
  if (typeId === "CCVS") {
    // CCVS pinLayout: [sense+, sense-, out+, out-]; sense pins are nominal
    // (real sensing happens via senseSourceLabel -> ctx.findBranch).
    // SPICE: `Hname N+ N- VSENSE transresistance`
    assertLinearControlExpression(props, typeId, rawLabel, "I(sense)");
    const trans = requireParam(props, def, modelKey, "transresistance", rawLabel);
    const senseRef = canonicalizeSpiceLabel(props.get<string>("senseSourceLabel"), "V");
    return [`${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${senseRef} ${trans}`];
  }
  if (typeId === "CCCS") {
    // CCCS pinLayout: [sense+, sense-, out+, out-]; same sense-via-label rule
    // as CCVS. SPICE: `Fname N+ N- VSENSE gain`
    assertLinearControlExpression(props, typeId, rawLabel, "I(sense)");
    const gain = requireParam(props, def, modelKey, "currentGain", rawLabel);
    const senseRef = canonicalizeSpiceLabel(props.get<string>("senseSourceLabel"), "V");
    return [`${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${senseRef} ${gain}`];
  }
  if (typeId === "InternalCccs") {
    // InternalCccs pinLayout: [pos, neg]. Sense V-source is identified by the
    // `sense` prop, written by resolveSubElementProps as the canonical SPICE
    // label of the sibling V-source. SPICE: `Fname N+ N- VSENSE gain`.
    const gain = requireParam(props, def, modelKey, "gain", rawLabel);
    const senseRef = props.get<string>("sense");
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${senseRef} ${gain}`];
  }

  // ---------------------------------------------------------------------------
  // S-element branches — voltage-controlled switch (ngspice SW / VSWITCH)
  // ---------------------------------------------------------------------------

  if (typeId === "SwitchSPST") {
    // Class A: real ctrl pin. pinLayout: [in, out, ctrl] (analog-switch.ts:464-493).
    // SPICE: `S{label} {in} {out} {ctrl} 0  SWMODEL_{label}`
    // `.model SWMODEL_{label} SW (VT={vThreshold} VH={vHysteresis} RON={rOn} ROFF={rOff})`
    const inNode   = nodeAt(nodes, 0, rawLabel, "in");
    const outNode  = nodeAt(nodes, 1, rawLabel, "out");
    const ctrlNode = nodeAt(nodes, 2, rawLabel, "ctrl");
    const modelName = `SWMODEL_${label}`;
    const vt  = requireParam(props, def, modelKey, "vThreshold",  rawLabel);
    const vh  = requireParam(props, def, modelKey, "vHysteresis", rawLabel);
    const ron  = requireParam(props, def, modelKey, "rOn",  rawLabel);
    const roff = requireParam(props, def, modelKey, "rOff", rawLabel);
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, `.model ${modelName} SW (VT=${vt} VH=${vh} RON=${ron} ROFF=${roff})`);
    }
    return [`${label} ${inNode} ${outNode} ${ctrlNode} 0 ${modelName}`];
  }

  if (typeId === "SwitchSPDT") {
    // Class A: real ctrl pin. pinLayout: [com, no, nc, ctrl] (analog-switch.ts:496-534).
    // Two complementary S elements sharing one .model card:
    //   S{label}_AB {com} {no} {ctrl} 0  SWMODEL_{label}   (closes when v_ctrl > VT)
    //   S{label}_AC {com} {nc} 0 {ctrl}  SWMODEL_{label}   (closes when -v_ctrl > VT)
    const comNode  = nodeAt(nodes, 0, rawLabel, "com");
    const noNode   = nodeAt(nodes, 1, rawLabel, "no");
    const ncNode   = nodeAt(nodes, 2, rawLabel, "nc");
    const ctrlNode = nodeAt(nodes, 3, rawLabel, "ctrl");
    const modelName = `SWMODEL_${label}`;
    const vt  = requireParam(props, def, modelKey, "vThreshold",  rawLabel);
    const vh  = requireParam(props, def, modelKey, "vHysteresis", rawLabel);
    const ron  = requireParam(props, def, modelKey, "rOn",  rawLabel);
    const roff = requireParam(props, def, modelKey, "rOff", rawLabel);
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, `.model ${modelName} SW (VT=${vt} VH=${vh} RON=${ron} ROFF=${roff})`);
    }
    return [
      `${label}_AB ${comNode} ${noNode} ${ctrlNode} 0 ${modelName}`,
      `${label}_AC ${comNode} ${ncNode} 0 ${ctrlNode} ${modelName}`,
    ];
  }

  if (typeId === "CurrentControlledSwitch") {
    // ngspice CSW (W element). ctrlBranch resolves to the sibling V-source's
    // canonicalized SPICE label (written by resolveSubElementProps). The W
    // device samples that V-source's branch current per NR iteration and
    // applies pull-in / drop-out hysteresis via the CSW .model card.
    //
    // Model card (cswparam.c / cswload.c):
    //   .model {modelName} CSW (IT={iThreshold} IH={iHysteresis} RON={ron} ROFF={roff})
    // ngspice CSW->digiTS mapping:
    //   CSWiThreshold  = (pullInI + dropOutI) / 2
    //   CSWiHysteresis = (pullInI - dropOutI) / 2
    // NC switches additionally emit the `ON` keyword per cswparam.c:27-30
    // (CSW_IC_ON case sets CSWzero_stateGiven), pinning the CSWITCH's
    // initial state to closed and matching digiTS's `normallyClosed: true`.
    const a1Node = nodeAt(nodes, 0, rawLabel, "A1");
    const b1Node = nodeAt(nodes, 1, rawLabel, "B1");
    const ron  = requireParam(props, def, modelKey, "Ron",  rawLabel);
    const roff = requireParam(props, def, modelKey, "Roff", rawLabel);
    const pullInI  = requireParam(props, def, modelKey, "pullInI",  rawLabel);
    const dropOutI = requireParam(props, def, modelKey, "dropOutI", rawLabel);
    const iThreshold  = (pullInI + dropOutI) / 2;
    const iHysteresis = (pullInI - dropOutI) / 2;
    const senseLabel = props.get<string>("ctrlBranch");
    const wLabel = canonicalizeSpiceLabel(rawLabel, "W");
    const modelName = `CSWMODEL_${wLabel}`;
    const normallyClosed = props.has("normallyClosed") ? !!props.get<boolean>("normallyClosed") : false;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, `.model ${modelName} CSW (IT=${iThreshold} IH=${iHysteresis} RON=${ron} ROFF=${roff})`);
    }
    const onKeyword = normallyClosed ? " ON" : "";
    return [
      `${wLabel} ${a1Node} ${b1Node} ${senseLabel} ${modelName}${onKeyword}`,
    ];
  }

  if (typeId === "Switch") {
    const a1Node = nodeAt(nodes, 0, rawLabel, "A1");
    const b1Node = nodeAt(nodes, 1, rawLabel, "B1");
    const ron  = requireParam(props, def, modelKey, "Ron",  rawLabel);
    const roff = requireParam(props, def, modelKey, "Roff", rawLabel);

    // Class B (manual click-toggle): no ctrlBranch wired. Synthesize an
    // internal ctrl net + 0V/+1V V-source snapshotting `closed` at deck-build
    // time. SPICE:
    //   V{label}_ctrl  {ctrlNet} 0  DC {closed ? 1 : 0}
    //   S{label}       {a1} {b1} {ctrlNet} 0  SWMODEL_{label}
    //   .model SWMODEL_{label} SW (VT=0 VH=0 RON={ron} ROFF={roff})
    // Model card constants VT=0 VH=0 verified per swsetup.c:28-33 and swload.c:108-116.
    const ctrlNet = allocateInternalNet(ctx);
    const closed = props.has("closed") ? !!props.get<boolean>("closed") : false;
    const normallyClosed = props.has("normallyClosed") ? !!props.get<boolean>("normallyClosed") : false;
    const effectivelyClosed = normallyClosed ? !closed : closed;
    const ctrlV = effectivelyClosed ? 1 : 0;
    const modelName = `SWMODEL_${label}`;
    const vCtrlLabel = canonicalizeSpiceLabel(`${rawLabel}_ctrl`, "V");
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, `.model ${modelName} SW (VT=0 VH=0 RON=${ron} ROFF=${roff})`);
    }
    return [
      `${vCtrlLabel} ${ctrlNet} 0 DC ${ctrlV}`,
      `${label} ${a1Node} ${b1Node} ${ctrlNet} 0 ${modelName}`,
    ];
  }

  if (typeId === "SwitchDT") {
    // Class B: manual click-toggle. pinLayout: [A1, B1, C1] (switch-dt.ts:442).
    // One ctrl net, two complementary S elements:
    //   V{label}_ctrl  {ctrlNet} 0  DC {closed ? 1 : 0}
    //   S{label}_AB    {a1} {b1} {ctrlNet} 0  SWMODEL_{label}   (AB closed when closed=true)
    //   S{label}_AC    {a1} {c1} 0 {ctrlNet}  SWMODEL_{label}   (AC closed when closed=false)
    // Model card constants VT=0 VH=0 verified per swsetup.c:28-33 and swload.c:108-116.
    const a1Node = nodeAt(nodes, 0, rawLabel, "A1");
    const b1Node = nodeAt(nodes, 1, rawLabel, "B1");
    const c1Node = nodeAt(nodes, 2, rawLabel, "C1");
    const ctrlNet = allocateInternalNet(ctx);
    const closed = props.has("closed") ? !!props.get<boolean>("closed") : false;
    const normallyClosed = props.has("normallyClosed") ? !!props.get<boolean>("normallyClosed") : false;
    const effectivelyClosed = normallyClosed ? !closed : closed;
    const ctrlV = effectivelyClosed ? 1 : 0;
    const ron  = requireParam(props, def, modelKey, "Ron",  rawLabel);
    const roff = requireParam(props, def, modelKey, "Roff", rawLabel);
    const modelName = `SWMODEL_${label}`;
    const vCtrlLabel = canonicalizeSpiceLabel(`${rawLabel}_ctrl`, "V");
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, `.model ${modelName} SW (VT=0 VH=0 RON=${ron} ROFF=${roff})`);
    }
    return [
      `${vCtrlLabel} ${ctrlNet} 0 DC ${ctrlV}`,
      `${label}_AB ${a1Node} ${b1Node} ${ctrlNet} 0 ${modelName}`,
      `${label}_AC ${a1Node} ${c1Node} 0 ${ctrlNet} ${modelName}`,
    ];
  }

  // ---------------------------------------------------------------------------
  // Group A primitives — components whose physics collapse to a single SPICE
  // primitive at deck-build time. The harness snapshot is exact for static
  // analysis (DC-OP, .tran with no mid-transient parameter changes); tests
  // that drive runtime parameter changes must use createSelfCompare.
  // ---------------------------------------------------------------------------

  if (typeId === "TransmissionLine") {
    // ngspice T card: T<name> A+ A- B+ B- Z0=<z> TD=<td>
    // Our pinLayout is [P1b, P2b, P1a, P2a] = [pos1, pos2, neg1, neg2];
    // emit in ngspice order [pos1, neg1, pos2, neg2] = nodes[0, 2, 1, 3].
    const z0 = requireParam(props, def, modelKey, "impedance", rawLabel);
    const td = requireParam(props, def, modelKey, "delay", rawLabel);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "P1b")} ${nodeAt(nodes, 2, rawLabel, "P1a")} ${nodeAt(nodes, 1, rawLabel, "P2b")} ${nodeAt(nodes, 3, rawLabel, "P2a")} Z0=${z0} TD=${td}`];
  }

  if (typeId === "LDR") {
    // LDR resistance follows a power law:
    //   R = rDark · (lux / luxRef)^(-gamma)
    // (see ldr.ts helpText). Hot-loadable via setParam("lux"). SPICE has no
    // light-dependent primitive; we snapshot the resistance at deck-build time
    // and emit as a plain R. Pin order: [pos, neg].
    const rDark  = requireParam(props, def, modelKey, "rDark",  rawLabel);
    const luxRef = requireParam(props, def, modelKey, "luxRef", rawLabel);
    const gamma  = requireParam(props, def, modelKey, "gamma",  rawLabel);
    const lux    = requireParam(props, def, modelKey, "lux",    rawLabel);
    const R = rDark * Math.pow(lux / luxRef, -gamma);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${R}`];
  }

  if (typeId === "VariableRail") {
    // Single-pin DC source (neg side is implicit ground). Voltage is hot-
    // loadable via setParam at runtime; the SPICE deck snapshots the current
    // value at deck-build time. Pin order: [pos] only.
    const V = requireParam(props, def, modelKey, "voltage", rawLabel);
    return [`${label} ${nodeAt(nodes, 0, rawLabel, "pos")} 0 DC ${V}`];
  }

  if (typeId === "Clock") {
    // Clock is a digital signal first (its analog `behavioral` model exists for
    // mixed-signal cross-domain tests, NOT for ngspice parity). Mapping it to
    // PULSE(0 vdd 0 0 0 ...) cannot achieve bit-exact parity because ngspice's
    // vsrcload.c:81-86 unconditionally substitutes CKTstep for any TR=0 / TF=0,
    // producing a finite ramp window the digiTS clock does not model. There is
    // no per-test override that doesn't either pollute the breakpoint
    // sequence or force digiTS's clock to grow rise/fall semantics it
    // shouldn't have. For analog square-wave parity fixtures, use
    // AcVoltageSource with waveform="square" and explicit non-zero
    // riseTime/fallTime - that path emits the user's TR/TF directly into the
    // SPICE deck, sidestepping the substitution.
    throw new Error(
      `netlist-generator: Clock '${rawLabel}' has no SPICE-paired emit path. ` +
      `Clock is a digital component; its analog model is not bit-exact with ` +
      `ngspice's PULSE source (vsrcload.c:81-86 CKTstep substitution on TR=0). ` +
      `For analog square-wave parity fixtures, use AcVoltageSource with ` +
      `waveform="square" and explicit non-zero riseTime/fallTime (see ` +
      `acvsource-canon-square-1khz-loaded.dts for a worked example).`
    );
  }

  throw new Error(
    `netlist-generator: typeId '${typeId}' (label='${rawLabel}') has an entry in ` +
    `ELEMENT_SPECS (prefix='${spec.prefix}') but no matching emit branch in ` +
    `emitPrimitive. Add a branch handling prefix '${spec.prefix}' next to ` +
    `the existing R/C/L/V/I/D/Q/M/J/E/F/G/H/S branches.`
  );
}

// ---------------------------------------------------------------------------
// Instance-param suffix (element line)
// ---------------------------------------------------------------------------

function instanceParamSuffix(
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
): string {
  const parts: string[] = [];
  const groups = new Map<string, Array<{ index: number; value: number }>>();

  for (const def of paramDefs) {
    if (def.partition !== "instance") continue;
    // ngspice *Given semantics: emit only user-set per-instance overrides.
    if (!props.isModelParamGiven(def.key)) continue;
    const raw = props.getModelParam<number>(def.key);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const v = def.spiceConverter ? def.spiceConverter(raw) : raw;

    if (def.emitGroup) {
      let arr = groups.get(def.emitGroup.name);
      if (!arr) { arr = []; groups.set(def.emitGroup.name, arr); }
      arr.push({ index: def.emitGroup.index, value: v });
      continue;
    }

    if (def.emit === "flag") {
      if (v !== 0) parts.push(def.spiceName ?? def.key);
      continue;
    }

    parts.push(`${def.spiceName ?? def.key}=${v}`);
  }

  for (const [name, members] of groups) {
    members.sort((a, b) => a.index - b.index);
    if (members.some(m => m.value !== 0)) {
      parts.push(`${name}=${members.map(m => m.value).join(",")}`);
    }
  }

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Model-card suffix (.model line)
// ---------------------------------------------------------------------------

function modelCardSuffix(
  modelName: string,
  spiceModelType: string,
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
  emission: ModelEmissionSpec | undefined,
): string {
  const parts: string[] = [];

  if (emission?.modelCardPrefix) parts.push(...emission.modelCardPrefix);

  for (const def of paramDefs) {
    if (def.partition === "instance") continue;
    // Positional params (e.g. cap.capacitance, inductor.inductance) emit as the
    // bare VALUE on the instance line per inp2c.c:18 / inp2l.c — never inside
    // a .model card body.
    if (def.positional) continue;
    if (def.emitGroup || def.emit === "flag") {
      throw new Error(
        `netlist-generator: model-card param ${def.key} declares emit/group; ` +
        `only instance partition supports flag/group emission today`,
      );
    }
    if (!props.isModelParamGiven(def.key)) continue;
    const raw = props.getModelParam<number>(def.key);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const v = def.spiceConverter ? def.spiceConverter(raw) : raw;
    parts.push(`${def.spiceName ?? def.key}=${v}`);
  }

  if (parts.length === 0) return `.model ${modelName} ${spiceModelType}`;
  return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// VDMOS model card — maps the uppercase digiTS param keys to the lowercase
// ngspice VDMOS model-card parameter names (vdmos.c VDMOSmPTable) and emits the
// nchan/pchan device-type flag (vdmosmpar.c VDMOS_MOD_NMOS/VDMOS_MOD_PMOS).
// ---------------------------------------------------------------------------

const VDMOS_PARAM_SPICE_NAMES: Record<string, string> = {
  VTH: "vto", KP: "kp", LAMBDA: "lambda", PHI: "phi", THETA: "theta",
  RD: "rd", RS: "rs", RG: "rg", TNOM: "tnom", KF: "kf", AF: "af",
  RQ: "rq", VQ: "vq", MTRIODE: "mtriode",
  TCVTH: "tcvth", MU: "mu", TEXP0: "texp0", TEXP1: "texp1",
  TRD1: "trd1", TRD2: "trd2", TRG1: "trg1", TRG2: "trg2", TRS1: "trs1", TRS2: "trs2",
  SUBSHIFT: "subshift", KSUBTHRES: "ksubthres",
  TKSUBTHRES1: "tksubthres1", TKSUBTHRES2: "tksubthres2",
  BV: "bv", IBV: "ibv", NBV: "nbv", RDS: "rds", RB: "rb", N: "n", TT: "tt",
  EG: "eg", XTI: "xti", IS: "is", VJ: "vj", TRB1: "trb1", TRB2: "trb2",
  // Body-diode grading coefficient: ngspice names this model-card param `m`
  // (vdmos.c:121 `IOP("m", VDIO_MOD_MJ, ...)`), NOT `mj`. Emitting `mj=…`
  // is an unrecognized param and ngspice rejects it.
  CJO: "cjo", MJ: "m", FC: "fc",
  CGDMIN: "cgdmin", CGDMAX: "cgdmax", A: "a", CGS: "cgs",
  RTHJC: "rthjc", RTHCA: "rthca", CTHJ: "cthj",
  VGS_MAX: "vgs_max", VGD_MAX: "vgd_max", VDS_MAX: "vds_max",
  VGSR_MAX: "vgsr_max", VGDR_MAX: "vgdr_max", PD_MAX: "pd_max",
  ID_MAX: "id_max", IDR_MAX: "idr_max", TE_MAX: "te_max",
  RTH_EXT: "rth_ext", DERATING: "derating",
};

function vdmosModelCard(
  modelName: string,
  isNchan: boolean,
  paramDefs: readonly ParamDef[],
  props: PropertyBag,
): string {
  // vdmosmpar.c VDMOS_MOD_NMOS / VDMOS_MOD_PMOS — the device-type flag.
  const parts: string[] = [isNchan ? "nchan" : "pchan"];
  for (const def of paramDefs) {
    if (def.partition === "instance") continue;
    if (!props.isModelParamGiven(def.key)) continue;
    const spiceName = VDMOS_PARAM_SPICE_NAMES[def.key];
    if (spiceName === undefined) continue;
    const raw = props.getModelParam<number>(def.key);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const v = def.spiceConverter ? def.spiceConverter(raw) : raw;
    parts.push(`${spiceName}=${v}`);
  }
  return `.model ${modelName} VDMOS (${parts.join(" ")})`;
}

// ---------------------------------------------------------------------------
// AC source transient-spec builder (shared by AcVoltageSource and AcCurrentSource)
// ---------------------------------------------------------------------------

/**
 * Build a SPICE transient source specifier for AC sources (voltage or current)
 * so that ngspice drives the same time-varying waveform as our engine during
 * .tran analysis. The SPICE transient spec syntax is identical for V and I sources.
 *
 * Supported waveforms (all exact- no approximations):
 *   sine     â†’ SIN(VO VA FREQ TD THETA PHASE_DEG)
 *   square   â†’ PULSE(V1 V2 TD TR TF PW PER)
 *   triangle â†’ PULSE(V1 V2 TD halfPeriod halfPeriod 0 PER)
 *   sawtooth â†’ PULSE(V1 V2 TD (period-fallTime) fallTime 0 PER)
 *
 * Rejected waveforms (throw): sweep, am, fm, noise, expression- none of these
 * are representable as a SPICE transient primitive. A .tran parity comparison
 * against ngspice is not valid for these; callers must author a custom SPICE
 * deck (e.g. PWL) if they need a ngspice counterpart.
 *
 * Square-wave note:
 *   Our engine uses ngspice PULSE semantics exactly: at t=0 (phase=0) value is V1 (LOW),
 *   the rising edge spans [0, TR], HIGH plateau is [TR, TR+PW], falling edge is
 *   [TR+PW, TR+PW+TF], then LOW until the next period. The PULSE(V1 V2 TD TR TF PW PER)
 *   emission is therefore exact- no approximation or sub-riseTime discrepancy.
 *
 * Triangle-wave note:
 *   After the -Ï€/2 phase alignment in computeWaveformValue, at t=0 (phase=0) our
 *   triangle sits at V1 = dc - amp and rises linearly to V2 over the first half
 *   period, then falls linearly back to V1 over the second half. SPICE PULSE with
 *   TR=TF=halfPeriod and PW=0 reproduces this exactly (the rising edge is the
 *   rise half-period, the falling edge is the fall half-period, zero plateau).
 *   Non-zero phase is encoded via TD just like the square case.
 *
 * Sawtooth note:
 *   Our engine rises linearly from V1 to V2 over (period - fallTime) and falls
 *   linearly from V2 back to V1 over fallTime. SPICE PULSE with TR=(period-fallTime),
 *   TF=fallTime, PW=0 reproduces this exactly. Non-zero phase is encoded via TD.
 */
function buildAcSourceSpec(
  waveform: string,
  amp: number,
  dc: number,
  freq: number,
  phase: number,
  props: PropertyBag,
  def: ComponentDefinition,
  modelKey: string,
  rawLabel: string,
): string {
  // ngspice coefficient model (vsrcpar.c / vsrcload.c): when a SPICE function
  // token + coefficient vector are given, emit the token straight from those
  // coefficients so the ngspice deck carries the exact coefficients digiTS
  // evaluates (the precondition for a bit-exact waveform gate, Part G). The
  // order-guard defaults (TR/TF→CKTstep, PW/PER→CKTfinalTime) are resolved by
  // ngspice itself from the emitted coefficient list, identically to our
  // evaluateNgspiceWaveform — so the coefficients are passed verbatim.
  const funcToken = (props.has("funcType") ? props.get<string>("funcType") : "").trim().toUpperCase();
  if (funcToken !== "") {
    const coeffsRaw = props.has("coeffs") ? props.get<number[] | string>("coeffs") : [];
    const coeffs = Array.isArray(coeffsRaw)
      ? coeffsRaw
      : coeffsRaw.split(/[\s,]+/).filter((s) => s.length > 0).map((s) => parseFloat(s));
    switch (funcToken) {
      case "PULSE": case "SINE": case "EXP": case "SFFM": case "AM": case "PWL":
        return `${funcToken}(${coeffs.join(" ")})`;
      case "TRNOISE": case "TRRANDOM":
        // TRNOISE/TRRANDOM deck emission rides with maths-misc#recon/randnumb:
        // the deterministic generator must match bit-exact on both sides before
        // a noise deck is comparable. Until that recon lands, refuse to emit a
        // noise deck rather than produce an uncomparable one.
        throw new Error(
          `SPICE deck emission for ${funcToken} sources rides with `
          + `maths-misc#recon/randnumb (deterministic RNG parity); not yet available.`,
        );
      default:
        throw new Error(`Unrecognized SPICE function token '${funcToken}' on '${rawLabel}'.`);
    }
  }

  switch (waveform) {
    case "sine":
    case "square":
    case "triangle":
    case "sawtooth": {
      // Criterion #11: the editor-facing waveform enum drives off the SAME
      // ngspice coefficient vector digiTS evaluates — enumWaveformCoeffs builds
      // the PULSE/SINE coefficients from the named params and the element
      // evaluates the identical vector through evaluateNgspiceWaveform. Emitting
      // those coefficients verbatim makes the ngspice deck carry digiTS's exact
      // coefficient set (the precondition for a bit-exact waveform gate). The
      // riseTime/fallTime resolution mirrors the element's named-param defaults
      // (registry default 1e-12), so both sides build identical vectors.
      const riseTime = requireParam(props, def, modelKey, "riseTime", rawLabel);
      const fallTime = requireParam(props, def, modelKey, "fallTime", rawLabel);
      const built = enumWaveformCoeffs(
        waveform as Waveform, amp, freq, phase, dc, riseTime, fallTime,
      );
      if (built === null) {
        throw new Error(
          `netlist-generator: waveform '${waveform}' on '${rawLabel}' has no ` +
          `ngspice coefficient counterpart.`,
        );
      }
      const token = built.functionType === FunctionType.SINE ? "SIN" : "PULSE";
      return `${token}(${built.coeffs.join(" ")})`;
    }

    case "sweep":
    case "am":
    case "fm":
    case "noise":
    case "expression":
      throw new Error(
        `SPICE transient parity is not valid for waveform "${waveform}". ` +
        `Sweep/AM/FM/noise/expression sources have no exact SPICE transient primitive- ` +
        `author a custom SPICE deck (e.g. PWL) if you need a ngspice counterpart.`,
      );

    default:
      throw new Error(`Unrecognized AC source waveform: "${waveform}"`);
  }
}

// ---------------------------------------------------------------------------
// Pin-node and param accessors with explicit "missing" failure modes.
// Both throw on the silent-default condition the older `?? 0` and
// `getPropNumber(..., hardcodedDefault)` patterns used to swallow- a
// missing pin-node or a missing param value is now an explicit error,
// and the only source of truth for default param values is the
// component's modelRegistry entry.
// ---------------------------------------------------------------------------

/**
 * Read a global node ID for a pin index. Throws if the pin index has no
 * entry in `nodes`- an unwired pin would silently emit as ground (`0`) in
 * the SPICE deck and diverge from our engine, which is the same class of
 * silent-skip miscompare the typeId-level throws fixed. Calling sites pass
 * `pinName` (e.g. "pos", "neg", "ctrl+") so the error names what's missing,
 * not just the array index.
 */
function nodeAt(
  nodes: number[],
  k: number,
  rawLabel: string,
  pinName: string,
): number {
  const n: number | undefined = nodes[k];
  if (n === undefined) {
    throw new Error(
      `netlist-generator: '${rawLabel}' has no node at pin index ${k} ` +
      `(${pinName}). Every component pin must resolve to a global node ID; ` +
      `an unwired pin would silently emit as ground in the SPICE deck and ` +
      `diverge from our engine.`
    );
  }
  return n;
}

/**
 * Read a numeric param for a primitive emit. Resolution order: instance's
 * model-param store, instance's regular property bag, then the model-entry's
 * registered defaults (`def.modelRegistry[modelKey].params[key]`). Throws
 * when none of those define the key- the model-registry defaults are the
 * single source of truth and the netlist generator must not invent its own.
 */
function requireParam(
  props: PropertyBag,
  def: ComponentDefinition,
  modelKey: string,
  key: string,
  rawLabel: string,
): number {
  if (props.hasModelParam(key)) return props.getModelParam<number>(key);
  if (props.has(key)) return props.get<number>(key);
  const registered = def.modelRegistry?.[modelKey]?.params?.[key];
  if (typeof registered === "number") return registered;
  throw new Error(
    `netlist-generator: component '${rawLabel}' (typeId='${def.name}') has no ` +
    `value for param '${key}' on model '${modelKey}', and the model registry ` +
    `has no numeric default. Either set the property explicitly on the ` +
    `instance, or add params['${key}'] to def.modelRegistry['${modelKey}'].`
  );
}

/**
 * Emit a SPICE K element for a MutualInductor sub-element. Mirrors
 * ngspice K (mutsetup.c / mutload.c): resolves L1Name/L2Name to coil branch
 * indices and stamps -k·√(L1·L2) off-diagonals at (b1,b2) and (b2,b1).
 *
 * digiTS factoring stores the mutual inductance as M directly (rather than
 * the dimensionless coupling coefficient k) to keep the parent-side runtime
 * stamp self-contained — k is by definition `M / √(L1·L2)`. We compute k at
 * SPICE-emit time by reading the resolved inductance values of the L1/L2
 * sibling sub-elements; ngspice does the same lookup internally to validate
 * |k| ≤ 1 at deck parse time.
 *
 * Reads M, L1, L2 from the parent subcircuit's resolved param chain
 * (sub-element params → parent's modelParams → subckt.params defaults). The
 * sibling Inductor sub-elements MUST declare canonical `inductance: ...`
 * params (not `L: ...` aliases) for the lookup to resolve.
 */
function emitMutualInductorK(
  parentRawLabel: string,
  sub: SubcircuitElement,
  parentSubckt: MnaSubcircuitNetlist,
  parentProps: PropertyBag,
): string[] {
  const subParams = sub.params ?? {};
  const subName = sub.subElementName ?? "MUT";

  const l1Ref = subParams["L1_branch"];
  const l2Ref = subParams["L2_branch"];
  if (!isElementRef(l1Ref) || !isElementRef(l2Ref)) {
    throw new Error(
      `netlist-generator: MutualInductor sub-element '${subName}' of ` +
      `'${parentRawLabel}' must declare L1_branch and L2_branch as ` +
      `{ kind: "ref", name } refs. Got L1_branch=${JSON.stringify(l1Ref)}, ` +
      `L2_branch=${JSON.stringify(l2Ref)}.`
    );
  }

  const l1SubName = l1Ref.name;
  const l2SubName = l2Ref.name;
  const l1Sub = parentSubckt.elements.find((e) => e.subElementName === l1SubName);
  const l2Sub = parentSubckt.elements.find((e) => e.subElementName === l2SubName);
  if (!l1Sub || !l2Sub) {
    throw new Error(
      `netlist-generator: MutualInductor '${subName}' of '${parentRawLabel}' ` +
      `references sibling sub-elements '${l1SubName}' and '${l2SubName}', ` +
      `but ${!l1Sub ? `'${l1SubName}'` : `'${l2SubName}'`} is not present in the ` +
      `parent's netlist.elements.`
    );
  }

  // Resolve coupling coefficient k. Sub-elements carry either:
  //   K: <number>  — dimensionless coupling coefficient (preferred; set by
  //                  transformer.ts / tapped-transformer.ts after task 4.3.2)
  //   M: <number>  — mutual inductance in H (back-compute k = M / √(L1·L2))
  let k: number;
  if (subParams["K"] !== undefined) {
    k = resolveSubElementNumeric(
      subParams["K"],
      parentSubckt.params,
      parentProps,
      `${subName}.K`,
      parentRawLabel,
    );
  } else {
    const l1Inductance = resolveSubElementNumeric(
      l1Sub.params?.["inductance"],
      parentSubckt.params,
      parentProps,
      `${l1SubName}.inductance`,
      parentRawLabel,
    );
    const l2Inductance = resolveSubElementNumeric(
      l2Sub.params?.["inductance"],
      parentSubckt.params,
      parentProps,
      `${l2SubName}.inductance`,
      parentRawLabel,
    );
    const m = resolveSubElementNumeric(
      subParams["M"],
      parentSubckt.params,
      parentProps,
      `${subName}.M`,
      parentRawLabel,
    );
    const denom = Math.sqrt(l1Inductance * l2Inductance);
    if (!Number.isFinite(denom) || denom === 0) {
      throw new Error(
        `netlist-generator: MutualInductor '${parentRawLabel}_${subName}' has ` +
        `degenerate inductances (L1=${l1Inductance}, L2=${l2Inductance}); ` +
        `cannot compute coupling coefficient k = M / √(L1·L2).`
      );
    }
    k = m / denom;
  }

  const subRawLabel = `${parentRawLabel}_${subName}`;
  const kLabel  = canonicalizeSpiceLabel(subRawLabel, "K");
  const l1Label = resolveRefToSpiceLabel(l1Ref, parentSubckt, parentRawLabel);
  const l2Label = resolveRefToSpiceLabel(l2Ref, parentSubckt, parentRawLabel);

  return [`${kLabel} ${l1Label} ${l2Label} ${k}`];
}

function isElementRef(
  v: SubcircuitElementParam | undefined,
): v is { kind: "ref"; name: string } {
  return typeof v === "object" && v !== null && "kind" in v && v.kind === "ref";
}

/**
 * Resolve a SubcircuitElementParam (number literal or string lookup) to a
 * concrete number using the same precedence as `resolveSubElementProps`:
 * parent's modelParams first, then subckt.params defaults, then throw. Used
 * by emit paths (like the K element) that need the resolved value at SPICE-
 * emit time without going through the synthetic-PropertyBag indirection.
 */
function resolveSubElementNumeric(
  value: SubcircuitElementParam | undefined,
  subcktParams: Record<string, number> | undefined,
  parentProps: PropertyBag,
  pathDescription: string,
  parentRawLabel: string,
): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (parentProps.hasModelParam(value)) return parentProps.getModelParam<number>(value);
    if (subcktParams && Object.prototype.hasOwnProperty.call(subcktParams, value)) {
      return subcktParams[value]!;
    }
    throw new Error(
      `netlist-generator: '${parentRawLabel}' ${pathDescription} references ` +
      `'${value}' but neither the parent's model params nor the subcircuit's ` +
      `defaults define a value for that key.`
    );
  }
  throw new Error(
    `netlist-generator: '${parentRawLabel}' ${pathDescription} has shape ` +
    `${JSON.stringify(value)}; expected a number literal or a string lookup.`
  );
}

/**
 * Reject controlled-source instances whose `expression` property has been
 * customised away from the linear default. SPICE E/F/G/H elements take a
 * single linear gain/transresistance/transconductance scalar on the element
 * line and have no general expression evaluator that lines up bit-exact with
 * our parser. ngspice's POLY syntax is sampled differently and B-sources have
 * their own evaluator- neither produces the bit-exact equivalence the harness
 * requires. Authors who need a non-linear expression must mark the component
 * `pairedSpiceEquivalent: false` and use createSelfCompare instead.
 *
 * `defaultExpression` is the component's linear-shortcut sentinel (e.g.
 * "V(ctrl)" for VCVS/VCCS, "I(sense)" for CCVS/CCCS). Empty string or the
 * sentinel are both treated as linear.
 */
function assertLinearControlExpression(
  props: PropertyBag,
  typeId: string,
  rawLabel: string,
  defaultExpression: string,
): void {
  if (!props.has("expression")) return;
  const expr = props.get<string>("expression").trim();
  if (expr === "" || expr === defaultExpression) return;
  throw new Error(
    `netlist-generator: ${typeId} '${rawLabel}' has non-linear expression ` +
    `'${expr}'. SPICE E/F/G/H take a single linear gain on the element line; ` +
    `non-linear expressions cannot be emitted bit-exact. Mark the component ` +
    `pairedSpiceEquivalent: false and use ComparisonSession.createSelfCompare ` +
    `for tests of this instance.`
  );
}

