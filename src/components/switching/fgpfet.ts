/**
 * FGPFET- P-channel floating-gate MOSFET.
 *
 * Behaves like PFET (G=0 â†’ conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGPFET is permanently non-conducting
 * regardless of gate input.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 2 (closedFlag=0, blownFlag=1)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { FETLayout } from "./nfet.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { MOSFET_PMOS_DEFAULTS } from "../semiconductors/mosfet.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice const.h / defines.h)
// ---------------------------------------------------------------------------

/** Reference temperature (REFTEMP). */
const FGPFET_REFTEMP = 300.15;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: FGPFET_PARAM_DEFS, defaults: FGPFET_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    capCG:  { default: 1e-15, unit: "F",  description: "CG-FG coupling capacitance" },
    blown:  { default: 0,                  description: "OTP fuse state (0=normal, 1=blown/non-conducting)" },
    VTO:    { default: MOSFET_PMOS_DEFAULTS.VTO,    unit: "V",      description: "Threshold voltage" },
    KP:     { default: MOSFET_PMOS_DEFAULTS.KP,     unit: "A/VÂ²",   description: "Process transconductance parameter" },
    LAMBDA: { default: MOSFET_PMOS_DEFAULTS.LAMBDA, unit: "1/V",    description: "Channel-length modulation" },
  },
  secondary: {
    PHI:    { default: MOSFET_PMOS_DEFAULTS.PHI,    unit: "V",      description: "Surface potential" },
    GAMMA:  { default: MOSFET_PMOS_DEFAULTS.GAMMA,  unit: "V^0.5",  description: "Body-effect coefficient" },
    CBD:    { default: MOSFET_PMOS_DEFAULTS.CBD,    unit: "F",      description: "Drain-bulk junction capacitance" },
    CBS:    { default: MOSFET_PMOS_DEFAULTS.CBS,    unit: "F",      description: "Source-bulk junction capacitance" },
    RD:     { default: MOSFET_PMOS_DEFAULTS.RD,     unit: "Î©",      description: "Drain ohmic resistance" },
    RS:     { default: MOSFET_PMOS_DEFAULTS.RS,     unit: "Î©",      description: "Source ohmic resistance" },
    IS:     { default: MOSFET_PMOS_DEFAULTS.IS,     unit: "A",      description: "Bulk junction saturation current" },
    W:      { default: MOSFET_PMOS_DEFAULTS.W,      unit: "m",      description: "Channel width" },
    L:      { default: MOSFET_PMOS_DEFAULTS.L,      unit: "m",      description: "Channel length" },
    TEMP:   { default: FGPFET_REFTEMP,              unit: "K",      description: "Operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeP: Gate at (0,0), Source at (SIZE,0)=(1,0), Drain at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGPFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FGPFETElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGPFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGPFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGPFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min x), arrow tip at x=1.1 (max x).
    // Drain/source leads reach x=1. Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    // Java FGPFETShape fixture coordinates (grid units):
    // Drain path (open):    (1,0) -> (0.55,0) -> (0.55,0.25)
    // Source path (open):   (1,2) -> (0.55,2) -> (0.55,1.75)
    // Channel gap:          (0.55,0.75) to (0.55,1.25)  NORMAL
    // Gate oxide bar:       (0.05,0)    to (0.05,2)      NORMAL
    // Floating gate (THIN): (0.3,1.8)   to (0.3,0.2)
    // Gate lead (THIN):     (0.55,1)    to (0.85,1)
    // Arrow (THIN_FILLED):  (1.1,1) -> (0.85,0.9) -> (0.85,1.1)  pointing LEFT
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain path (open L): use drawPath so rasterizer treats it as open polyline
    // matching Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 0 },
      { op: "lineTo", x: 0.55, y: 0 },
      { op: "lineTo", x: 0.55, y: 0.25 },
    ] });
    // Source path (open L)
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 2 },
      { op: "lineTo", x: 0.55, y: 2 },
      { op: "lineTo", x: 0.55, y: 1.75 },
    ] });
    // Channel gap
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);
    // Gate oxide bar
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);
    // Gate lead: from channel to arrow
    ctx.drawLine(0.55, 1, 0.85, 1);
    // P-channel arrow: filled triangle pointing LEFT
    ctx.drawPolygon([{ x: 1.1, y: 1 }, { x: 0.85, y: 0.9 }, { x: 0.85, y: 1.1 }], true);

    // Blown indicator
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.2, 0.5, 0.7, 1.0);
      ctx.drawLine(0.7, 0.5, 0.2, 1.0);
    }

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get blown(): boolean {
    return this._properties.getOrDefault<boolean>("blown", false);
  }
}

// ---------------------------------------------------------------------------
// executeFGPFET- flat simulation function
//
// G=0 and not blown â†’ closed=1; else closed=0
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGPFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : (gate ^ 1);
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const sourceNet = wt[outBase]!;
    const drainNet = wt[outBase + 1]!;
    if (closed) {
      state[drainNet] = state[sourceNet]!;
      highZs[drainNet] = 0;
    } else {
      highZs[drainNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGPFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGPFET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the switched signal",
    structural: true,
  },
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, floating gate is programmed- FET is permanently non-conducting",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

function fgpfetFactory(props: PropertyBag): FGPFETElement {
  return new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// FGPFET_NETLIST- MnaSubcircuitNetlist for floating-gate PMOS
//
// Analogous to FGNFET_NETLIST with PMOS substitution and FGPFETBlownDriver.
// Ports: CG (control gate), D (drain), S (source).
// Internal net: fg (floating gate node, index 3).
// Elements:
//   [0] Capacitor capCG: pos=fg(3), neg=CG(0)
//   [1] PMOS mos:        D=D(1), G=fg(3), S=S(2)
//   [2] FGPFETBlownDriver blownDrv: pos=fg(3), neg=S(2)
// ---------------------------------------------------------------------------

export const FGPFET_NETLIST: MnaSubcircuitNetlist = {
  ports: ["CG", "D", "S"],
  params: {
    capCG: 1e-15,
    blown: 0,
    VTO: MOSFET_PMOS_DEFAULTS.VTO,
    KP: MOSFET_PMOS_DEFAULTS.KP,
    LAMBDA: MOSFET_PMOS_DEFAULTS.LAMBDA,
    PHI: MOSFET_PMOS_DEFAULTS.PHI,
    GAMMA: MOSFET_PMOS_DEFAULTS.GAMMA,
    CBD: MOSFET_PMOS_DEFAULTS.CBD,
    CBS: MOSFET_PMOS_DEFAULTS.CBS,
    RD: MOSFET_PMOS_DEFAULTS.RD,
    RS: MOSFET_PMOS_DEFAULTS.RS,
    IS: MOSFET_PMOS_DEFAULTS.IS,
    W: MOSFET_PMOS_DEFAULTS.W,
    L: MOSFET_PMOS_DEFAULTS.L,
    TEMP: FGPFET_REFTEMP,
  },
  elements: [
    { typeId: "Capacitor",          modelRef: "default", subElementName: "capCG",    params: { C: "capCG" } },
    { typeId: "PMOS",               modelRef: "spice",   subElementName: "mos",      params: { VTO: "VTO", KP: "KP", LAMBDA: "LAMBDA", PHI: "PHI", GAMMA: "GAMMA", CBD: "CBD", CBS: "CBS", RD: "RD", RS: "RS", IS: "IS", W: "W", L: "L", TEMP: "TEMP" } },
    { typeId: "FGPFETBlownDriver",  modelRef: "default", subElementName: "blownDrv", params: { blown: "blown" } },
  ],
  internalNetCount: 1,
  internalNetLabels: ["fg"],
  netlist: [
    [3, 0],    // capCG: pos=fg, neg=CG
    [1, 3, 2], // mos:   D=D, G=fg, S=S
    [3, 2],    // blownDrv: pos=fg, neg=S
  ],
};

export const FGPFETDefinition: StandaloneComponentDefinition = {
  name: "FGPFET",
  typeId: -1,
  factory: fgpfetFactory,
  pinLayout: FGPFET_PIN_DECLARATIONS,
  propertyDefs: FGPFET_PROPERTY_DEFS,
  attributeMap: FGPFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGPFET- P-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGPFET,
      inputSchema: ["G"],
      outputSchema: ["S", "D"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "default": {
      kind: "netlist",
      netlist: FGPFET_NETLIST,
      paramDefs: FGPFET_PARAM_DEFS,
      params: FGPFET_PARAM_DEFAULTS,
    },
  },
};
