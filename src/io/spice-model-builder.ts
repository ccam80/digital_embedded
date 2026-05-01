/**
 * SPICE subcircuit-to-MnaSubcircuitNetlist builder.
 *
 * Converts a `ParsedSubcircuit` (from `parseSubcircuit()`) into an
 * `MnaSubcircuitNetlist` that can be compiled at compile time by the
 * composite factory path (`compileSubcircuitToMnaModel` in compiler.ts).
 *
 * The resulting Circuit follows these conventions:
 *   - Interface elements ("In" typeId) are placed at y=0 with pin label "out",
 *     one per port.  Their x-coordinate is the net index (1-based).
 *   - Internal elements are placed at successive y rows starting at y=2.
 *   - Nets are numbered by a stable map: node-name → integer x-coordinate.
 *   - Wire segments connect each element pin to the net at the same x value.
 *
 * Inline `.MODEL` parameter overrides are applied via replaceModelParams()
 * on each element whose modelName matches a parsed inline model name.
 */

import { Circuit, Wire } from "../core/circuit.js";
import { PropertyBag } from "../core/properties.js";
import { PinDirection } from "../core/pin.js";
import type { Pin } from "../core/pin.js";
import type { CircuitElement } from "../core/element.js";
import type { Rect, RenderContext } from "../core/renderer-interface.js";
import type { SerializedElement } from "../core/element.js";
import type { ParsedSubcircuit, ParsedElement, ParsedModel } from "../solver/analog/model-parser.js";

// ---------------------------------------------------------------------------
// Internal element counter (global, same approach as cmos-gates.ts)
// ---------------------------------------------------------------------------

let _spiceBuilderCounter = 0;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function makePin(x: number, y: number, label: string): Pin {
  return {
    position: { x, y },
    label,
    kind: 'signal' as const,
    direction: PinDirection.BIDIRECTIONAL,
    isNegated: false,
    isClock: false,
    bitWidth: 1,
  };
}

function makeCircuitElement(
  typeId: string,
  pins: Array<{ x: number; y: number; label: string }>,
  propsEntries: Array<[string, string | number | boolean | Record<string, number>]> = [],
  modelParams?: Record<string, number>,
): CircuitElement {
  const instanceId = `${typeId}-spice-${++_spiceBuilderCounter}`;
  const resolvedPins = pins.map((p) => makePin(p.x, p.y, p.label));
  const propsMap = new Map<string, import("../core/properties.js").PropertyValue>(
    propsEntries as Array<[string, import("../core/properties.js").PropertyValue]>,
  );
  const propertyBag = new PropertyBag(propsMap.entries());
  if (modelParams !== undefined) {
    propertyBag.replaceModelParams(modelParams);
  }

  const serialized: SerializedElement = {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as SerializedElement["rotation"],
    mirror: false,
    properties: {},
  };

  return {
    typeId,
    instanceId,
    position: { x: 0, y: 0 },
    rotation: 0 as CircuitElement["rotation"],
    mirror: false,
    getPins() { return resolvedPins; },
    getProperties() { return propertyBag; },
    getBoundingBox(): Rect { return { x: 0, y: 0, width: 10, height: 10 }; },
    draw(_ctx: RenderContext) { /* no-op */ },
    serialize() { return serialized; },
    getAttribute(k: string) { return propsMap.get(k); },
    setAttribute(k: string, v: import('../core/properties.js').PropertyValue) { propsMap.set(k, v); },
  };
}

function addWire(circuit: Circuit, x1: number, y1: number, x2: number, y2: number): void {
  circuit.addWire(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }));
}

// ---------------------------------------------------------------------------
// Net numbering
//
// Node names (strings) are mapped to integer x-coordinates.  Port nodes get
// the lowest indices (1-based) in port declaration order; internal nodes are
// assigned the next available index as they are encountered.
// ---------------------------------------------------------------------------

function buildNetMap(sc: ParsedSubcircuit): Map<string, number> {
  const netMap = new Map<string, number>();
  let nextNet = 1;

  // Ground node "0" always maps to net 0
  netMap.set("0", 0);

  // Ports get net indices 1..N in order
  for (const port of sc.ports) {
    if (!netMap.has(port)) {
      netMap.set(port, nextNet++);
    }
  }

  // Walk all element nodes to assign remaining nets
  for (const el of sc.elements) {
    for (const node of el.nodes) {
      if (!netMap.has(node)) {
        netMap.set(node, nextNet++);
      }
    }
  }

  return netMap;
}

// ---------------------------------------------------------------------------
// buildModelOverrides: compute merged model params for an element whose
// model name matches a parsed inline .MODEL statement.
// ---------------------------------------------------------------------------

function buildModelOverrides(
  modelName: string | undefined,
  inlineModels: ParsedModel[],
  elementParams?: Record<string, number>,
): Record<string, number> | undefined {
  const base: Record<string, number> = {};

  // Merge element-level params (e.g. W/L for MOSFETs)
  if (elementParams) {
    for (const [k, v] of Object.entries(elementParams)) {
      base[k] = v;
    }
  }

  // Find matching inline .MODEL and merge its params
  if (modelName) {
    const model = inlineModels.find((m) => m.name.toUpperCase() === modelName.toUpperCase());
    if (model) {
      for (const [k, v] of Object.entries(model.params)) {
        base[k] = v;
      }
    }
  }

  if (Object.keys(base).length === 0) return undefined;
  return base;
}

// ---------------------------------------------------------------------------
// Element factory- maps ParsedElement → CircuitElement
// ---------------------------------------------------------------------------

/**
 * Build a single CircuitElement from a ParsedElement.
 *
 * @param el        The parsed element from the .SUBCKT body.
 * @param netMap    Node-name → x-coordinate mapping.
 * @param yRow      The y-row for this element (for wire placement).
 * @param models    Inline .MODEL declarations from the same .SUBCKT.
 * @returns The constructed CircuitElement.
 */
function buildElement(
  el: ParsedElement,
  netMap: Map<string, number>,
  yRow: number,
  models: ParsedModel[],
): CircuitElement {
  const props: Array<[string, string | number | boolean | Record<string, number>]> = [];
  const overrides = buildModelOverrides(el.modelName, models, el.params);

  switch (el.type) {
    case "R": {
      const netA = netMap.get(el.nodes[0]) ?? 0;
      const netB = netMap.get(el.nodes[1]) ?? 0;
      if (el.value !== undefined) props.push(["resistance", el.value]);
      return makeCircuitElement("Resistor", [
        { x: netA, y: yRow, label: "A" },
        { x: netB, y: yRow, label: "B" },
      ], props, overrides);
    }

    case "C": {
      const netA = netMap.get(el.nodes[0]) ?? 0;
      const netB = netMap.get(el.nodes[1]) ?? 0;
      if (el.value !== undefined) props.push(["capacitance", el.value]);
      return makeCircuitElement("Capacitor", [
        { x: netA, y: yRow, label: "A" },
        { x: netB, y: yRow, label: "B" },
      ], props, overrides);
    }

    case "L": {
      const netA = netMap.get(el.nodes[0]) ?? 0;
      const netB = netMap.get(el.nodes[1]) ?? 0;
      if (el.value !== undefined) props.push(["inductance", el.value]);
      return makeCircuitElement("Inductor", [
        { x: netA, y: yRow, label: "A" },
        { x: netB, y: yRow, label: "B" },
      ], props, overrides);
    }

    case "D": {
      // Diode: anode(A), cathode(K)
      const netA = netMap.get(el.nodes[0]) ?? 0;
      const netK = netMap.get(el.nodes[1]) ?? 0;
      return makeCircuitElement("Diode", [
        { x: netA, y: yRow, label: "A" },
        { x: netK, y: yRow, label: "K" },
      ], props, overrides);
    }

    case "Q": {
      // BJT: nodes = [C, B, E, ...substrate(optional)]
      // Pin order matches BJT component: B, C, E
      const netC = netMap.get(el.nodes[0]) ?? 0;
      const netB = netMap.get(el.nodes[1]) ?? 0;
      const netE = netMap.get(el.nodes[2]) ?? 0;

      // Determine polarity from inline .MODEL device type
      const model = el.modelName
        ? models.find((m) => m.name.toUpperCase() === el.modelName!.toUpperCase())
        : undefined;
      const isPnp = model?.deviceType === "PNP";
      const typeId = isPnp ? "PnpBJT" : "NpnBJT";

      return makeCircuitElement(typeId, [
        { x: netB, y: yRow, label: "B" },
        { x: netC, y: yRow, label: "C" },
        { x: netE, y: yRow, label: "E" },
      ], props, overrides);
    }

    case "M": {
      // MOSFET: nodes = [D, G, S, B(bulk)]
      // Pin order matches MOSFET component: G, S, D (NMOS) or G, D, S (PMOS)
      // We place pins at their net x-coordinates regardless of order.
      const netD = netMap.get(el.nodes[0]) ?? 0;
      const netG = netMap.get(el.nodes[1]) ?? 0;
      const netS = netMap.get(el.nodes[2]) ?? 0;

      const model = el.modelName
        ? models.find((m) => m.name.toUpperCase() === el.modelName!.toUpperCase())
        : undefined;
      const isPmos = model?.deviceType === "PMOS";
      const typeId = isPmos ? "PMOS" : "NMOS";

      return makeCircuitElement(typeId, [
        { x: netG, y: yRow, label: "G" },
        { x: netD, y: yRow, label: "D" },
        { x: netS, y: yRow, label: "S" },
      ], props, overrides);
    }

    case "J": {
      // JFET: nodes = [D, G, S]
      // Pin order matches NJFET/PJFET: G, S, D
      const netD = netMap.get(el.nodes[0]) ?? 0;
      const netG = netMap.get(el.nodes[1]) ?? 0;
      const netS = netMap.get(el.nodes[2]) ?? 0;

      const model = el.modelName
        ? models.find((m) => m.name.toUpperCase() === el.modelName!.toUpperCase())
        : undefined;
      const isPjfet = model?.deviceType === "PJFET";
      const typeId = isPjfet ? "PJFET" : "NJFET";

      return makeCircuitElement(typeId, [
        { x: netG, y: yRow, label: "G" },
        { x: netS, y: yRow, label: "S" },
        { x: netD, y: yRow, label: "D" },
      ], props, overrides);
    }

    case "V": {
      // DC Voltage source: nodes = [pos, neg]
      const netPos = netMap.get(el.nodes[0]) ?? 0;
      const netNeg = netMap.get(el.nodes[1]) ?? 0;
      if (el.value !== undefined) props.push(["voltage", el.value]);
      return makeCircuitElement("DcVoltageSource", [
        { x: netNeg, y: yRow, label: "neg" },
        { x: netPos, y: yRow, label: "pos" },
      ], props);
    }

    case "I": {
      // Current source: nodes = [pos, neg]  (conventional current flows pos→neg externally)
      const netPos = netMap.get(el.nodes[0]) ?? 0;
      const netNeg = netMap.get(el.nodes[1]) ?? 0;
      if (el.value !== undefined) props.push(["current", el.value]);
      return makeCircuitElement("CurrentSource", [
        { x: netPos, y: yRow, label: "pos" },
        { x: netNeg, y: yRow, label: "neg" },
      ], props);
    }

    case "X": {
      // Subcircuit instance- we model it as a placeholder element.
      // The modelName is stored as a property so the compiler can look it up.
      // We create one pin per node.
      const pins = el.nodes.map((node, idx) => ({
        x: netMap.get(node) ?? 0,
        y: yRow,
        label: `p${idx}`,
      }));
      return makeCircuitElement("SubcircuitInstance", pins, props);
    }
  }
}

// ---------------------------------------------------------------------------
// buildSpiceSubcircuit- main public function
// ---------------------------------------------------------------------------

/**
 * Convert a `ParsedSubcircuit` into a `Circuit` suitable for registration in
 * the runtime model registry.
 *
 * The Circuit follows the same wire-coordinate-as-net-ID convention used by
 * `cmos-gates.ts` and `darlington.ts`:
 *   - Each distinct node name maps to a unique integer x-coordinate.
 *   - Port nodes get x-coordinates 1..N.
 *   - Ground node "0" always maps to x=0.
 *   - Interface ("In") elements sit at y=0.
 *   - Internal elements occupy successive y rows (y=2, 4, 6, …).
 *   - Wires connect each element pin at (x=netId, y=row) to the net spine at
 *     (x=netId, y=0), establishing a single MNA node per net.
 */
export function buildSpiceSubcircuit(sc: ParsedSubcircuit): Circuit {
  const circuit = new Circuit({ name: sc.name });
  const netMap = buildNetMap(sc);

  // --- Interface elements (one "In" per port) ---
  for (const port of sc.ports) {
    const netX = netMap.get(port)!;
    circuit.addElement(makeCircuitElement("In", [
      { x: netX, y: 0, label: "out" },
    ], [["label", port]]));
  }

  // --- Internal elements ---
  let yRow = 2;
  for (const el of sc.elements) {
    const circuitEl = buildElement(el, netMap, yRow, sc.models);
    circuit.addElement(circuitEl);

    // Add wires: for each pin, connect (pin.x, yRow) → (pin.x, 0) so that all
    // elements sharing the same x-coordinate end up in the same MNA net.
    for (const pin of circuitEl.getPins()) {
      const px = pin.position.x;
      if (px !== 0 || yRow !== 0) {
        addWire(circuit, px, 0, px, yRow);
      }
    }

    yRow += 2;
  }

  return circuit;
}
