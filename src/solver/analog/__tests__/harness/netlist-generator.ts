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
  SubcircuitElement,
  SubcircuitElementParam,
} from "../../../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// SPICE prefix table (typeId -> SPICE prefix, model type for semiconductors)
// ---------------------------------------------------------------------------

interface ElementSpec {
  prefix: string;
  modelType?: string;
}

const ELEMENT_SPECS: Record<string, ElementSpec> = {
  Resistor:        { prefix: "R" },
  Capacitor:       { prefix: "C" },
  Inductor:        { prefix: "L" },
  DcVoltageSource: { prefix: "V" },
  AcVoltageSource: { prefix: "V" },
  DcCurrentSource: { prefix: "I" },
  AcCurrentSource: { prefix: "I" },
  Diode:           { prefix: "D", modelType: "D" },
  ZenerDiode:      { prefix: "D", modelType: "D" },
  VaractorDiode:   { prefix: "D", modelType: "D" },
  NpnBJT:          { prefix: "Q", modelType: "NPN" },
  PnpBJT:          { prefix: "Q", modelType: "PNP" },
  NMOS:            { prefix: "M", modelType: "NMOS" },
  PMOS:            { prefix: "M", modelType: "PMOS" },
  NJFET:           { prefix: "J", modelType: "NMF" },
  PJFET:           { prefix: "J", modelType: "PMF" },
  VCVS:            { prefix: "E" },
  VCCS:            { prefix: "G" },
  CCVS:            { prefix: "H" },
  CCCS:            { prefix: "F" },
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
function canonicalizeSpiceLabel(rawLabel: string, requiredPrefix: string): string {
  const upper = requiredPrefix.toUpperCase();
  return rawLabel.charAt(0).toUpperCase() === upper ? rawLabel : `${upper}${rawLabel}`;
}

// ---------------------------------------------------------------------------
// Subcircuit recursion helpers
// ---------------------------------------------------------------------------

/**
 * Throw if a sub-element parameter uses siblingBranch / siblingState. Sibling
 * refs reach into a peer leaf's pool slot or branch row at every cktLoad-
 * they're a digiTS-specific state-coupling mechanism with no SPICE-syntax
 * equivalent. Their presence on a sub-element means the parent composite is
 * non-SPICE-faithful as currently factored. Author must either fuse the
 * coupled leaves into a single SPICE-primitive device (e.g. relay's
 * Switch+RelayCoupling collapse into one current-controlled-switch leaf
 * mapping to ngspice's W element) or mark the parent component
 * pairedSpiceEquivalent: false on its definition.
 */
function assertNoSiblingRefs(
  sub: SubcircuitElement,
  parentLabel: string,
  parentTypeId: string,
): void {
  const params = sub.params ?? {};
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (typeof v === "object" && v !== null && "kind" in v &&
        (v.kind === "siblingBranch" || v.kind === "siblingState")) {
      throw new Error(
        `netlist-generator: sub-element '${sub.subElementName ?? sub.typeId}' ` +
        `of ${parentTypeId} '${parentLabel}' uses ${v.kind} on param '${key}'. ` +
        `The digiTS factoring is non-SPICE-faithful at this leaf- sibling refs ` +
        `cannot be translated to SPICE syntax. Either (a) fuse the coupled ` +
        `leaves into a single SPICE-primitive device (e.g. a CurrentControlledSwitch ` +
        `leaf with internal hysteresis state mapping to ngspice's W element), or ` +
        `(b) mark this component pairedSpiceEquivalent: false on its definition ` +
        `and use ComparisonSession.createSelfCompare for tests.`
      );
    }
  }
}

/**
 * Resolve a sub-element's params into a synthetic PropertyBag suitable for
 * the primitive-emit path. Resolution rules per SubcircuitElementParam:
 *   - number literal -> setModelParam(key, value)
 *   - string lookup  -> read from parent's model params (preferred) or
 *                       subckt.params defaults; throw if neither
 *                       defines the key
 *   - sibling refs   -> handled separately by assertNoSiblingRefs (caller
 *                       must invoke first)
 *
 * The synthetic bag also carries `model = sub.modelRef` (when set) so that
 * the existing emit-path's `props.has("model") ? props.get("model") :
 * def.defaultModel` selector picks the correct sub-model.
 */
function resolveSubElementProps(
  sub: SubcircuitElement,
  subcktParams: Record<string, number> | undefined,
  parentProps: PropertyBag,
): PropertyBag {
  const bag = new PropertyBag();
  if (sub.modelRef !== undefined) bag.set("model", sub.modelRef);
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
    } else {
      // Sibling refs are handled by assertNoSiblingRefs; reaching here means
      // a new SubcircuitElementParam shape was added without updating this
      // generator. Throw rather than silently swallow.
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
}

function allocateInternalNet(ctx: EmitCtx): number {
  return ctx.nextInternalNet++;
}

// ---------------------------------------------------------------------------
// generateSpiceNetlist
// ---------------------------------------------------------------------------

export function generateSpiceNetlist(
  compiled: ConcreteCompiledAnalogCircuit,
  registry: ComponentRegistry,
  elementLabels: Map<number, string>,
  title?: string,
): string {
  const lines: string[] = [];

  // Title line
  lines.push(title ?? "Auto-generated netlist");

  // Collect model cards: modelName -> ".model <name> <type> (<params>)"
  const modelCards = new Map<string, string>();

  // One element line per compiled element. compiled.elements is sorted by
  // (ngspiceLoadOrder ASC, originalIndex DESC)- i.e. reverse-within-bucket
  // (see compiler.ts). Emit the deck in forward-within-bucket order so that
  // ngspice's `cktcrte.c:63-65` prepend reverses it back into the order our
  // engine actually walks. Concretely: walk each bucket of consecutive
  // same-loadOrder elements from end to start.
  const emitOrder: number[] = [];
  let bucketStart = 0;
  for (let i = 0; i <= compiled.elements.length; i++) {
    const atEnd = i === compiled.elements.length;
    const orderChanged = !atEnd
      && compiled.elements[i]!.ngspiceLoadOrder !== compiled.elements[bucketStart]!.ngspiceLoadOrder;
    if (atEnd || orderChanged) {
      for (let j = i - 1; j >= bucketStart; j--) emitOrder.push(j);
      bucketStart = i;
    }
  }
  // Emit-context: subcircuit recursion allocates fresh internal-net IDs
  // starting just past the highest outer node already in use. ngspice parses
  // node IDs as opaque names, so the exact integers don't matter as long as
  // they're consistent within this deck and don't collide with outer pins.
  const emitCtx: EmitCtx = { nextInternalNet: compiled.nodeCount + 1 };

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

    // Allocate fresh node IDs for internal nets (one per subckt internal net).
    const internalNets: number[] = [];
    for (let k = 0; k < subckt.internalNetCount; k++) {
      internalNets.push(allocateInternalNet(ctx));
    }

    const lines: string[] = [];
    for (let i = 0; i < subckt.elements.length; i++) {
      const sub = subckt.elements[i]!;
      assertNoSiblingRefs(sub, rawLabel, typeId);

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

      const subProps = resolveSubElementProps(sub, subckt.params, props);
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

  return [emitPrimitive(rawLabel, typeId, spec, pinNodes, props, def, modelKey, modelCards)];
}

// ---------------------------------------------------------------------------
// emitPrimitive- single-line emission for a SPICE-primitive leaf
// ---------------------------------------------------------------------------

/**
 * Emit one SPICE element line for a primitive leaf (typeId in ELEMENT_SPECS).
 * Pulls paramDefs / spice emission spec from the active model entry, applies
 * SPICE-prefix canonicalization on the instance name, and dispatches by
 * typeId / spec.prefix to the appropriate per-class branch. Pushes any
 * required `.model` cards into `modelCards`.
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
): string {
  let paramDefs: readonly ParamDef[] = [];
  let emission: ModelEmissionSpec | undefined;
  if (spec.modelType !== undefined) {
    const modelEntry = def.modelRegistry?.[modelKey];
    if (!modelEntry) {
      throw new Error(`netlist-generator: typeId "${typeId}" has no modelRegistry["${modelKey}"]`);
    }
    paramDefs = modelEntry.paramDefs;
    emission = modelEntry.spice;
  }

  const label = canonicalizeSpiceLabel(rawLabel, spec.prefix);

  if (typeId === "Resistor") {
    const R = requireParam(props, def, modelKey, "resistance", rawLabel);
    return `${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${R}`;
  }
  if (typeId === "Capacitor") {
    const C = requireParam(props, def, modelKey, "capacitance", rawLabel);
    return `${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${C}`;
  }
  if (typeId === "Inductor") {
    const L = requireParam(props, def, modelKey, "inductance", rawLabel);
    return `${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} ${L}`;
  }
  if (typeId === "DcVoltageSource") {
    const V = requireParam(props, def, modelKey, "voltage", rawLabel);
    // SPICE convention: Vname pos neg value; our pins are [neg, pos]
    return `${label} ${nodeAt(nodes, 1, rawLabel, "pos")} ${nodeAt(nodes, 0, rawLabel, "neg")} DC ${V}`;
  }
  if (typeId === "AcVoltageSource") {
    const amp   = requireParam(props, def, modelKey, "amplitude", rawLabel);
    const dc    = requireParam(props, def, modelKey, "dcOffset", rawLabel);
    const freq  = requireParam(props, def, modelKey, "frequency", rawLabel);
    const phase = requireParam(props, def, modelKey, "phase", rawLabel);
    const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
    const posNode = nodeAt(nodes, 1, rawLabel, "pos");
    const negNode = nodeAt(nodes, 0, rawLabel, "neg");
    return `${label} ${posNode} ${negNode} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props, def, modelKey, rawLabel)}`;
  }
  if (typeId === "DcCurrentSource") {
    const I = requireParam(props, def, modelKey, "current", rawLabel);
    return `${label} ${nodeAt(nodes, 0, rawLabel, "pos")} ${nodeAt(nodes, 1, rawLabel, "neg")} DC ${I}`;
  }
  if (typeId === "AcCurrentSource") {
    const amp      = requireParam(props, def, modelKey, "amplitude", rawLabel);
    const dc       = requireParam(props, def, modelKey, "dcOffset", rawLabel);
    const freq     = requireParam(props, def, modelKey, "frequency", rawLabel);
    const phase    = requireParam(props, def, modelKey, "phase", rawLabel);
    const waveform = props.has("waveform") ? props.get<string>("waveform") : "sine";
    const posNode = nodeAt(nodes, 1, rawLabel, "pos");
    const negNode = nodeAt(nodes, 0, rawLabel, "neg");
    return `${label} ${posNode} ${negNode} ${buildAcSourceSpec(waveform, amp, dc, freq, phase, props, def, modelKey, rawLabel)}`;
  }
  if (spec.prefix === "D") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 0, rawLabel, "anode")} ${nodeAt(nodes, 1, rawLabel, "cathode")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return line;
  }
  if (spec.prefix === "Q") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 1, rawLabel, "C")} ${nodeAt(nodes, 0, rawLabel, "B")} ${nodeAt(nodes, 2, rawLabel, "E")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return line;
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
    return line;
  }
  if (spec.prefix === "J") {
    const modelName = `${label}_${spec.modelType}`;
    const line = `${label} ${nodeAt(nodes, 2, rawLabel, "D")} ${nodeAt(nodes, 0, rawLabel, "G")} ${nodeAt(nodes, 1, rawLabel, "S")} ${modelName}${instanceParamSuffix(paramDefs, props)}`;
    if (!modelCards.has(modelName)) {
      modelCards.set(modelName, modelCardSuffix(modelName, spec.modelType!, paramDefs, props, emission));
    }
    return line;
  }
  if (typeId === "VCVS") {
    // VCVS pinLayout: [ctrl+, ctrl-, out+, out-] -> SPICE `Ename N+ N- NC+ NC- gain`
    assertLinearControlExpression(props, typeId, rawLabel, "V(ctrl)");
    const gain = requireParam(props, def, modelKey, "gain", rawLabel);
    return `${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${nodeAt(nodes, 0, rawLabel, "ctrl+")} ${nodeAt(nodes, 1, rawLabel, "ctrl-")} ${gain}`;
  }
  if (typeId === "VCCS") {
    // VCCS pinLayout: [ctrl+, ctrl-, out+, out-] -> SPICE `Gname N+ N- NC+ NC- gm`
    assertLinearControlExpression(props, typeId, rawLabel, "V(ctrl)");
    const gm = requireParam(props, def, modelKey, "transconductance", rawLabel);
    return `${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${nodeAt(nodes, 0, rawLabel, "ctrl+")} ${nodeAt(nodes, 1, rawLabel, "ctrl-")} ${gm}`;
  }
  if (typeId === "CCVS") {
    // CCVS pinLayout: [sense+, sense-, out+, out-]; sense pins are nominal
    // (real sensing happens via senseSourceLabel -> ctx.findBranch).
    // SPICE: `Hname N+ N- VSENSE transresistance`
    assertLinearControlExpression(props, typeId, rawLabel, "I(sense)");
    const trans = requireParam(props, def, modelKey, "transresistance", rawLabel);
    const senseRef = canonicalizeSpiceLabel(props.get<string>("senseSourceLabel"), "V");
    return `${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${senseRef} ${trans}`;
  }
  if (typeId === "CCCS") {
    // CCCS pinLayout: [sense+, sense-, out+, out-]; same sense-via-label rule
    // as CCVS. SPICE: `Fname N+ N- VSENSE gain`
    assertLinearControlExpression(props, typeId, rawLabel, "I(sense)");
    const gain = requireParam(props, def, modelKey, "currentGain", rawLabel);
    const senseRef = canonicalizeSpiceLabel(props.get<string>("senseSourceLabel"), "V");
    return `${label} ${nodeAt(nodes, 2, rawLabel, "out+")} ${nodeAt(nodes, 3, rawLabel, "out-")} ${senseRef} ${gain}`;
  }

  throw new Error(
    `netlist-generator: typeId '${typeId}' (label='${rawLabel}') has an entry in ` +
    `ELEMENT_SPECS (prefix='${spec.prefix}') but no matching emit branch in ` +
    `emitPrimitive. Add a branch handling prefix '${spec.prefix}' next to ` +
    `the existing R/C/L/V/I/D/Q/M/J/E/F/G/H branches.`
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
    if (!props.hasModelParam(def.key)) continue;
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
    if (def.emitGroup || def.emit === "flag") {
      throw new Error(
        `netlist-generator: model-card param ${def.key} declares emit/group; ` +
        `only instance partition supports flag/group emission today`,
      );
    }
    if (!props.hasModelParam(def.key)) continue;
    const raw = props.getModelParam<number>(def.key);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const v = def.spiceConverter ? def.spiceConverter(raw) : raw;
    parts.push(`${def.spiceName ?? def.key}=${v}`);
  }

  if (parts.length === 0) return `.model ${modelName} ${spiceModelType}`;
  return `.model ${modelName} ${spiceModelType} (${parts.join(" ")})`;
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
  const period = freq > 0 ? 1 / freq : 1;

  switch (waveform) {
    case "sine": {
      // Our engine: dc + amp * sin(2Ï€ * freq * t + phase)  [phase in radians]
      // SPICE SIN:  SIN(VO VA FREQ TD THETA PHASE_DEG)
      //   PHASE_DEG is phase in degrees (ngspice manual ss4.1.2).
      const phaseDeg = phase * (180 / Math.PI);
      return `SIN(${dc} ${amp} ${freq} 0 0 ${phaseDeg})`;
    }

    case "square": {
      // Our engine (ngspice PULSE semantics, vsrcload.c):
      //   V1 = dc - amp (LOW), V2 = dc + amp (HIGH)
      //   Rising edge: [0, TR] within the period-local clock.
      //   HIGH plateau: [TR, TR+PW] where PW = period/2 - TR.
      //   Falling edge: [TR+PW, TR+PW+TF].
      //   LOW: rest of period.
      //
      // SPICE PULSE(V1 V2 TD TR TF PW PER):
      //   V1  = dc - amp
      //   V2  = dc + amp
      //   TD  = delay to first rising edge start in real time
      //         = ((-phaseShift) % period + period) % period
      //         (positive phase â†’ waveform shifted left â†’ rising edge earlier â†’ larger TD wrap)
      //   TR  = riseTime
      //   TF  = fallTime
      //   PW  = period/2 - TR  (HIGH plateau, same as engine)
      //   PER = period
      const riseTime = requireParam(props, def, modelKey, "riseTime", rawLabel);
      const fallTime = requireParam(props, def, modelKey, "fallTime", rawLabel);
      const halfPeriod = period / 2;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      // Rising edge starts at t = -phaseShift in the engine's unwrapped clock.
      // Wrap to [0, period) for SPICE PULSE TD.
      const td = ((-phaseShift % period) + period) % period;
      const pw = halfPeriod - riseTime;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${riseTime} ${fallTime} ${pw} ${period})`;
    }

    case "triangle": {
      // PULSE-aligned triangle (see ac-voltage-source.ts computeWaveformValue):
      // rises V1 â†’ V2 over halfPeriod, then falls V2 â†’ V1 over halfPeriod.
      // At t=0 (phase=0) the wave sits at V1 rising. Non-zero phase shifts the
      // waveform left in time by phase/(2Ï€*freq); encode that as a positive TD
      // wrapped into [0, period) just like the square case.
      const halfP = period / 2;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      const td = ((-phaseShift % period) + period) % period;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${halfP} ${halfP} 0 ${period})`;
    }

    case "sawtooth": {
      // PULSE-aligned sawtooth (see ac-voltage-source.ts computeWaveformValue):
      // rises V1 â†’ V2 over (period - fallTime), then falls V2 â†’ V1 over fallTime.
      // At t=0 (phase=0) the wave sits at V1 rising. Default fallTime = 1 ps so
      // the sharp fall is below typical transient timesteps while remaining
      // losslessly encodable in PULSE.
      const fallTime = requireParam(props, def, modelKey, "fallTime", rawLabel);
      if (fallTime >= period) {
        throw new Error(
          `sawtooth fallTime (${fallTime}s) must be strictly less than period (${period}s)`,
        );
      }
      const riseSpan = period - fallTime;
      const phaseShift = freq > 0 ? phase / (2 * Math.PI * freq) : 0;
      const td = ((-phaseShift % period) + period) % period;
      const v1 = dc - amp;
      const v2 = dc + amp;
      return `PULSE(${v1} ${v2} ${td} ${riseSpan} ${fallTime} 0 ${period})`;
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

