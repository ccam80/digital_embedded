/**
 * PFET- P-channel MOSFET voltage-controlled switch.
 *
 * Gate input G controls source-drain connection (inverted logic vs NFET):
 *   G=0 -> conducting (closed): S and D connected
 *   G=1 -> non-conducting (open): S and D disconnected
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Analog model (kind: "netlist"):
 *   drv (BehavioralFETDriver, polarity p): reads V(G) - V(S), classifies
 *        on as `vGS < -Vth` (active-low gate semantics for P-channel).
 *   sw  (FetSW, invertCtrl=1): the driver signals on when the channel
 *        should be on; sw passes that through unchanged. invertCtrl=1 is
 *        preserved here for symmetry with the TransGate PFET path where
 *        invertCtrl is the natural way to express active-low control.
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
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import type { FETLayout } from "./nfet.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Java FETShapeP: Gate at (0,0), Drain at (SIZE,0), Source at (SIZE, SIZE*2).
 *  SIZE = 20px = 1 grid unit. So width = 1, height = 2. */
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

/**
 * Java FETShapeP.getPins():
 *   Gate  at (0, 0)       - input[0]
 *   Drain at (SIZE, 0)    - output[0]  (1, 0) in grid
 *   Source at (SIZE, SIZE*2)- output[1]  (1, 2) in grid
 */
const PFET_PIN_DECLARATIONS: PinDeclaration[] = [
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
    label: "D",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: COMP_HEIGHT },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// PFETElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class PFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(PFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05, drain/source leads to x=1.
    // Arrow tip at x=0.95, gate lead to x=0.7. Min drawn x = 0.05.
    return { x: this.position.x + 0.05, y: this.position.y, width: 0.95, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    // Java FETShapeP fixture coordinates (grid units, 1 unit = 20px):
    // Drain path (open):   (1,0) -> (0.4,0) -> (0.4,0.25)
    // Source path (open):  (1,2) -> (0.4,2) -> (0.4,1.75)
    // Channel gap:         (0.4,0.75) to (0.4,1.25)  NORMAL
    // Gate oxide bar:      (0.05,0)   to (0.05,2)     NORMAL
    // Gate lead (THIN):    (0.4,1)    to (0.7,1)
    // Arrow (THIN_FILLED): (0.95,1) -> (0.7,0.9) -> (0.7,1.1)  pointing LEFT
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain path (open L): pin D at (1,0) -> stub to channel- use drawPath so
    // the rasterizer treats it as an open polyline matching the Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 0 },
      { op: "lineTo", x: 0.4, y: 0 },
      { op: "lineTo", x: 0.4, y: 0.25 },
    ] });
    // Source path (open L): pin S at (1,2) -> stub to channel
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 2 },
      { op: "lineTo", x: 0.4, y: 2 },
      { op: "lineTo", x: 0.4, y: 1.75 },
    ] });
    // Channel gap (center section of channel bar, between stubs)
    ctx.drawLine(0.4, 0.75, 0.4, 1.25);
    // Gate oxide bar (vertical, left edge)
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Gate lead: from oxide bar to arrow
    ctx.drawLine(0.4, 1, 0.7, 1);
    // P-channel arrow: filled triangle pointing LEFT (toward gate)
    ctx.drawPolygon([{ x: 0.95, y: 1 }, { x: 0.7, y: 0.9 }, { x: 0.7, y: 1.1 }], true);

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.6 });
      ctx.drawText(label, 0.5, -0.3, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executePFET- flat simulation function
//
// G=0 -> closed=1; G=1 -> closed=0 (inverted compared to NFET)
// ---------------------------------------------------------------------------

export function executePFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const closed = gate ^ 1;
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
// buildPfetNetlist- analog netlist builder
//
// Ports: G=0, D=1, S=2
//
// Elements:
//   drv (BehavioralFETDriver, isNType=0): on-condition is `vGS < -Vth`.
//   sw  (FetSW, invertCtrl=0): stamps the 2x2 (D, S) admittance.
// ---------------------------------------------------------------------------

export const buildPfetNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  // Ron/Roff/Vth are declared in paramDefs and merged into the bag by the
  // unified instantiation — read directly. isNType=0 / invertCtrl=0 below are
  // device-identity constants (this is the P-channel FET), not params.
  const ron = params.getModelParam<number>("Ron");
  const roff = params.getModelParam<number>("Roff");
  const vth = params.getModelParam<number>("Vth");

  return {
    ports: ["G", "D", "S"],
    elements: [
      {
        typeId: "BehavioralFETDriver",
        modelRef: "default",
        subElementName: "drv",
        params: { Vth: vth, isNType: 0 },
      },
      {
        typeId: "FetSW",
        modelRef: "default",
        subElementName: "sw",
        params: {
          Ron: ron,
          Roff: roff,
          invertCtrl: 0,
        },
      },
    ],
    internalNetCount: 1,
    internalNetLabels: ["ctrl_gate"],
    // ports: G=0, D=1, S=2; ctrl_gate internal net=3
    netlist: [
      [0, 2, 3], // drv: G=0, S=2, ctrl_out=3
      [1, 2, 3], // sw:  D=1, S=2, ctrl=3
    ],
  };
};

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const PFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Ron", propertyKey: "Ron", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "Roff", propertyKey: "Roff", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "Vth", propertyKey: "Vth", modelParam: true, convert: (v) => parseFloat(v) },
];

const PFET_PROPERTY_DEFS: PropertyDefinition[] = [
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
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
  {
    key: "Ron",
    type: PropertyType.FLOAT,
    label: "Ron (Ohm)",
    defaultValue: 1,
    min: 1e-12,
    description: "On-state resistance in ohms",
  },
  {
    key: "Roff",
    type: PropertyType.FLOAT,
    label: "Roff (Ohm)",
    defaultValue: 1e9,
    min: 1,
    description: "Off-state resistance in ohms",
  },
  {
    key: "Vth",
    type: PropertyType.FLOAT,
    label: "Vth (V)",
    defaultValue: 2.5,
    description: "Gate threshold voltage in volts",
  },
];

function pfetFactory(props: PropertyBag): PFETElement {
  return new PFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PFETDefinition: StandaloneComponentDefinition = {
  name: "PFET",
  typeId: -1,
  factory: pfetFactory,
  pinLayout: PFET_PIN_DECLARATIONS,
  voltageProbes: [
    { name: "Vsd", pos: "S", neg: "D" },
    { name: "Vsg", pos: "S", neg: "G" },
  ],
  propertyDefs: PFET_PROPERTY_DEFS,
  attributeMap: PFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "PFET- P-channel MOSFET. G=0 -> conducting.",
  models: {
    digital: {
      executeFn: executePFET,
      inputSchema: ["G", "D", "S"],
      outputSchema: ["D", "S"],
      stateSlotCount: 1,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildPfetNetlist,
      paramDefs: [
        { key: "Ron", default: 1 },
        { key: "Roff", default: 1e9 },
        { key: "Vth", default: 2.5 },
      ],
      params: {},
    },
  },
};
