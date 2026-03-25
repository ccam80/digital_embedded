/**
 * CircuitJS CTZ format — low-level text parsing.
 *
 * CircuitJS encodes circuits as a line-based text format where each line
 * represents one component. After decompression the text looks like:
 *
 *   $ 1 0.000005 10.20027730826997 50 5 43 5e-11
 *   r 192 192 384 192 0 1000
 *   c 384 192 384 320 0 1e-05 0
 *   v 192 320 192 192 0 0 40 5 0 0 0.5
 *   g 192 320 192 352 0 0
 *
 * Line format: <type> <x1> <y1> <x2> <y2> <flags> [property ...]
 *
 * The first line starting with "$" is a simulation settings line and is skipped.
 * Comment lines start with "#".
 */

import { Circuit, Wire } from "../core/circuit.js";
import { AbstractCircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { Diagnostic } from "../headless/netlist-types.js";
import type { RenderContext, Rect } from "../core/renderer-interface.js";
import type { Pin, Rotation } from "../core/pin.js";
import { PropertyBag } from "../core/properties.js";

// ---------------------------------------------------------------------------
// CtzComponent — parsed record for one CTZ line
// ---------------------------------------------------------------------------

/** A single component record parsed from the CTZ text format. */
export interface CtzComponent {
  /** CircuitJS type code (e.g. 'r', 'c', 'l', 'd'). */
  type: string;
  /** X coordinate of the first endpoint. */
  x1: number;
  /** Y coordinate of the first endpoint. */
  y1: number;
  /** X coordinate of the second endpoint. */
  x2: number;
  /** Y coordinate of the second endpoint. */
  y2: number;
  /** Flags field (integer). */
  flags: number;
  /** Remaining tokens after flags, representing component-specific properties. */
  properties: Record<string, string>;
}

// ---------------------------------------------------------------------------
// CTZ_TYPE_MAP — CircuitJS type codes → digiTS registry type names
// ---------------------------------------------------------------------------

/**
 * Maps CircuitJS component type codes to digiTS registry type names.
 *
 * Coverage: all Tier 1 (passives, basic sources) and Tier 2 (semiconductors,
 * controlled sources, active) components that have CircuitJS equivalents.
 */
export const CTZ_TYPE_MAP: Record<string, string> = {
  // Passives
  r: "Resistor",
  c: "Capacitor",
  l: "Inductor",

  // Sources
  v: "DcVoltageSource",
  a: "AcVoltageSource",
  i: "CurrentSource",
  g: "Ground",

  // Semiconductors
  d: "Diode",
  dz: "ZenerDiode",
  dt: "TunnelDiode",
  dled: "Diode",

  // Transistors — BJT
  t: "NpnBJT",
  tf: "PnpBJT",

  // MOSFETs
  mosfet: "NMOS",
  pmosfet: "PMOS",

  // JFETs
  j: "NJFET",
  pj: "PJFET",

  // Controlled sources
  vcvs: "VCVS",
  vccs: "VCCS",
  ccvs: "CCVS",
  cccs: "CCCS",

  // Op-amp
  o: "OpAmp",

  // Switches / relays
  s: "SwitchSPST",
  spdt: "SwitchSPDT",

  // Passive specialty
  xf: "AnalogTransformer",
  m: "AnalogMutualInductor",
  cr: "AnalogCrystal",
  pot: "Potentiometer",
  memr: "AnalogMemristor",

  // Comparator / schmitt
  comp: "VoltageComparator",
  tri: "SchmittNonInverting",
  sc: "SchmittInverting",

  // Timer
  "555": "Timer555",

  // Transmission line
  tl: "TransmissionLine",

  // Logic
  and: "And",
  or: "Or",
  xor: "XOr",
  not: "Not",
  nand: "NAnd",
  nor: "NOr",
  xnor: "XNOr",

  // Flip-flops
  dff: "D_FF",
  jkff: "JK_FF",
  rsff: "RS_FF",

  // I/O
  "174": "In",
  "175": "Out",
};

// ---------------------------------------------------------------------------
// Placeholder element for unsupported types
// ---------------------------------------------------------------------------

/**
 * A placeholder element substituted when a CTZ type has no digiTS equivalent.
 *
 * Rendered as a labeled box so the circuit can still be displayed; it does not
 * participate in simulation.
 */
export class CtzPlaceholderElement extends AbstractCircuitElement {
  readonly ctzType: string;

  constructor(
    instanceId: string,
    ctzType: string,
    position: { x: number; y: number },
    props: PropertyBag,
  ) {
    super("CtzPlaceholder", instanceId, position, 0 as Rotation, false, props);
    this.ctzType = ctzType;
  }

  getPins(): readonly Pin[] {
    return [];
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 2 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, -1, 4, 2, false);
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(this.ctzType, 2, 0, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }

  getHelpText(): string {
    return `Placeholder for unsupported CTZ type '${this.ctzType}'.`;
  }
}

// ---------------------------------------------------------------------------
// parseCtzText — text → CtzComponent[]
// ---------------------------------------------------------------------------

/**
 * Parse the decompressed CTZ text into an array of structured component records.
 *
 * Lines starting with "$" (simulation settings) or "#" (comments) are skipped.
 * Empty lines are skipped.
 *
 * Property tokens after the flags field are stored as positional keys
 * "p0", "p1", ... corresponding to their order in the CTZ line. For common
 * component types the property keys are also aliased to their semantic names
 * (e.g. "resistance", "capacitance", "inductance", "voltage").
 */
export function parseCtzText(text: string): CtzComponent[] {
  const lines = text.split(/\r?\n/);
  const result: CtzComponent[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("$") || line.startsWith("#")) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 6) continue;

    const type = tokens[0];
    const x1 = parseFloat(tokens[1]);
    const y1 = parseFloat(tokens[2]);
    const x2 = parseFloat(tokens[3]);
    const y2 = parseFloat(tokens[4]);
    const flags = parseInt(tokens[5], 10);

    const extra = tokens.slice(6);
    const properties: Record<string, string> = {};
    for (let i = 0; i < extra.length; i++) {
      properties[`p${i}`] = extra[i];
    }

    // Alias well-known positional properties to semantic names
    applySemanticAliases(type, properties);

    result.push({ type, x1, y1, x2, y2, flags, properties });
  }

  return result;
}

/**
 * Add semantic property name aliases for common CircuitJS component types.
 *
 * CircuitJS properties are positional; for the types we map we can assign
 * the correct semantic names so downstream code can read e.g. "resistance"
 * rather than "p0".
 */
function applySemanticAliases(
  type: string,
  properties: Record<string, string>,
): void {
  switch (type) {
    case "r":
      if ("p0" in properties) properties["resistance"] = properties["p0"];
      break;
    case "c":
      if ("p0" in properties) properties["capacitance"] = properties["p0"];
      break;
    case "l":
      if ("p0" in properties) properties["inductance"] = properties["p0"];
      break;
    case "v":
      // CTZ DC voltage: flags waveform max_voltage freq phase offset duty
      // p0=waveform(0=DC), p1=freq, p2=maxVoltage, ...
      if ("p2" in properties) properties["voltage"] = properties["p2"];
      break;
    case "a":
      // AC voltage source: p2 = amplitude
      if ("p2" in properties) properties["amplitude"] = properties["p2"];
      if ("p1" in properties) properties["frequency"] = properties["p1"];
      break;
    case "i":
      if ("p0" in properties) properties["current"] = properties["p0"];
      break;
  }
}

// ---------------------------------------------------------------------------
// CTZ coordinate → digiTS grid coordinate conversion
// ---------------------------------------------------------------------------

/** CircuitJS uses pixel coordinates at ~32px per grid unit. */
const CTZ_GRID_PIXELS = 32;

function ctzToGrid(px: number): number {
  return Math.round(px / CTZ_GRID_PIXELS);
}

// ---------------------------------------------------------------------------
// Wire inference from CTZ coordinates
// ---------------------------------------------------------------------------

/**
 * Infer wire segments from CTZ component endpoint coordinates.
 *
 * In CircuitJS, components are connected at their endpoints (x1,y1) and
 * (x2,y2). Two components share a node when their endpoints coincide.
 * We create one wire segment per component that represents its "lead" (a wire
 * from one end to the other in grid space). Components at the same grid
 * coordinate are considered connected via a common node.
 */
function buildWires(components: CtzComponent[]): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const wires: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  for (const comp of components) {
    const gx1 = ctzToGrid(comp.x1);
    const gy1 = ctzToGrid(comp.y1);
    const gx2 = ctzToGrid(comp.x2);
    const gy2 = ctzToGrid(comp.y2);

    // Only emit a wire if the two endpoints are distinct
    if (gx1 !== gx2 || gy1 !== gy2) {
      wires.push({ x1: gx1, y1: gy1, x2: gx2, y2: gy2 });
    }
  }

  return wires;
}

// ---------------------------------------------------------------------------
// mapCtzToCircuit — CtzComponent[] + registry → Circuit
// ---------------------------------------------------------------------------

/**
 * Convert a list of parsed CTZ components into a digiTS Circuit.
 *
 * Components with known type codes are created via the registry; unknown types
 * produce a `CtzPlaceholderElement` and an `unsupported-ctz-component`
 * diagnostic. Wire connectivity is inferred from component endpoint
 * coordinates.
 *
 * @param components - Parsed CTZ component records
 * @param registry - digiTS component registry for type lookup
 * @param diagnostics - Mutable array that receives any emitted diagnostics
 * @returns The constructed Circuit
 */
export function mapCtzToCircuit(
  components: CtzComponent[],
  registry: ComponentRegistry,
  diagnostics: Diagnostic[],
): Circuit {
  const circuit = new Circuit({ name: "Imported from CircuitJS" });

  let placeholderCounter = 0;

  for (const comp of components) {
    const gx = ctzToGrid(comp.x1);
    const gy = ctzToGrid(comp.y1);
    const position = { x: gx, y: gy };

    const digiTsType = CTZ_TYPE_MAP[comp.type];

    if (digiTsType !== undefined) {
      const def = registry.get(digiTsType);
      if (def !== undefined) {
        // Build a PropertyBag from CTZ properties
        const entries: Array<[string, import("../core/properties.js").PropertyValue]> = [];
        for (const [key, val] of Object.entries(comp.properties)) {
          const num = parseFloat(val);
          if (!isNaN(num)) {
            entries.push([key, num]);
          } else {
            entries.push([key, val]);
          }
        }
        const props = new PropertyBag(entries);
        const element = def.factory(props);
        element.position = position;
        circuit.addElement(element);
      } else {
        // Type is mapped but not registered — treat as unsupported
        emitUnsupportedDiagnostic(comp.type, diagnostics, placeholderCounter);
        const element = new CtzPlaceholderElement(
          crypto.randomUUID(),
          comp.type,
          position,
          new PropertyBag([["label", `ctz:${comp.type}`]]),
        );
        circuit.addElement(element);
        placeholderCounter++;
      }
    } else {
      emitUnsupportedDiagnostic(comp.type, diagnostics, placeholderCounter);
      const element = new CtzPlaceholderElement(
        crypto.randomUUID(),
        comp.type,
        position,
        new PropertyBag([["label", `ctz:${comp.type}`]]),
      );
      circuit.addElement(element);
      placeholderCounter++;
    }
  }

  // Add wire segments inferred from component endpoints
  const wireDefs = buildWires(components);
  for (const wd of wireDefs) {
    circuit.addWire(new Wire({ x: wd.x1, y: wd.y1 }, { x: wd.x2, y: wd.y2 }));
  }

  return circuit;
}

function emitUnsupportedDiagnostic(
  ctzType: string,
  diagnostics: Diagnostic[],
  _counter: number,
): void {
  diagnostics.push({
    severity: "info",
    code: "unsupported-ctz-component",
    message: `CTZ component type '${ctzType}' is not supported; a placeholder was inserted.`,
    fix: `Remove the placeholder or replace it with a supported digiTS component.`,
  });
}
