/**
 * PFET- P-channel MOSFET voltage-controlled switch.
 *
 * Gate input G controls source-drain connection (inverted logic vs NFET):
 *   G=0 → conducting (closed): S and D connected
 *   G=1 → non-conducting (open): S and D disconnected
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
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
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { FETLayout } from "./nfet.js";
import { NFETSWSubElement } from "./nfet.js";

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
// G=0 → closed=1; G=1 → closed=0 (inverted compared to NFET)
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
// PFETAnalogElement- AnalogElement implementation (composite, delegates to SW)
//
// PFET is structurally identical to NFET- same 4-stamp SW setup.
// Polarity inversion: control voltage is V(S) - V(G) (inverted vs NFET).
// ngspice anchor: ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62
// ---------------------------------------------------------------------------

export class PFETAnalogElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.SW;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  readonly _sw: NFETSWSubElement = new NFETSWSubElement();

  setup(ctx: SetupContext): void {
    // PFET composite forwards directly to its single SW sub-element.
    // SW sub-element uses D as posNode, S as negNode.
    // Inverted polarity is a load-time concern only- setup is identical to NFET.
    this._sw.setup(ctx);
  }

  load(ctx: LoadContext): void {
    // Inverted control: PFET turns ON when source is higher than gate by |Vth|
    // Negate vCtrl so the same SW threshold logic applies
    const gateNode = this._pinNodes.get("G")!;
    const sourceNode = this._pinNodes.get("S")!;
    const vCtrl = ctx.rhsOld[sourceNode] - ctx.rhsOld[gateNode];
    this._sw.setCtrlVoltage(vCtrl);
    this._sw.load(ctx);
  }

  setParam(key: string, value: number): void {
    this._sw.setParam(key, value);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

function pfetAnalogFactory(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PFETAnalogElement {
  const el = new PFETAnalogElement();
  el._pinNodes = new Map(pinNodes);
  el._sw._pinNodes = new Map([
    ["D", pinNodes.get("D")!],
    ["S", pinNodes.get("S")!],
  ]);
  const ron = Math.max(props.getOrDefault<number>("Ron", 1), 1e-12);
  const roff = Math.max(props.getOrDefault<number>("Roff", 1e9), 1e-12);
  const vth = props.getOrDefault<number>("Vth", 2.5);
  el._sw.setParam("Ron", ron);
  el._sw.setParam("Roff", roff);
  el._sw.setParam("threshold", vth);
  return el;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const PFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Ron", propertyKey: "Ron", convert: (v) => parseFloat(v) },
  { xmlName: "Roff", propertyKey: "Roff", convert: (v) => parseFloat(v) },
  { xmlName: "Vth", propertyKey: "Vth", convert: (v) => parseFloat(v) },
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
    label: "Ron (Ω)",
    defaultValue: 1,
    min: 1e-12,
    description: "On-state resistance in ohms",
  },
  {
    key: "Roff",
    type: PropertyType.FLOAT,
    label: "Roff (Ω)",
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

export const PFETDefinition: ComponentDefinition = {
  name: "PFET",
  typeId: -1,
  factory: pfetFactory,
  pinLayout: PFET_PIN_DECLARATIONS,
  propertyDefs: PFET_PROPERTY_DEFS,
  attributeMap: PFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "PFET- P-channel MOSFET. G=0 → conducting.",
  models: {
    digital: {
      executeFn: executePFET,
      inputSchema: ["G"],
      outputSchema: ["D", "S"],
      stateSlotCount: 1,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: pfetAnalogFactory,
      paramDefs: [],
      params: { Ron: 1, Roff: 1e9, Vth: 2.5 },
    },
  },
};
