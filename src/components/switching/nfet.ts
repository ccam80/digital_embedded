/**
 * NFET — N-channel MOSFET voltage-controlled switch.
 *
 * Gate input G controls source-drain connection:
 *   G=1 → conducting (closed): D and S connected
 *   G=0 → non-conducting (open): D and S disconnected
 *
 * Pins:
 *   Input:        G  (gate, 1-bit)
 *   Bidirectional: D (drain), S (source)
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

// ---------------------------------------------------------------------------
// Layout type with stateOffset
// ---------------------------------------------------------------------------

export interface FETLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeN: Gate at (1,1) right-center, Drain at (1,0) top-right, Source at (1,2) bottom-right
// Component spans x:[0,1], y:[0,2]
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const NFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// NFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NFETElement extends AbstractCircuitElement {
  protected readonly _bitWidth: number;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NFET", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(NFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Gate oxide bar at x=0.05; drain/source leads reach x=1.0.
    // Width = 1.0 - 0.05 = 0.95.
    return { x: this.position.x + 0.05, y: this.position.y, width: 0.95, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain lead: (1,0) → (0.4,0) → (0.4,0.25)
    ctx.drawLine(1, 0, 0.4, 0);
    ctx.drawLine(0.4, 0, 0.4, 0.25);

    // Source lead: (1,2) → (0.4,2) → (0.4,1.75)
    ctx.drawLine(1, 2, 0.4, 2);
    ctx.drawLine(0.4, 2, 0.4, 1.75);

    // Channel gap line: (0.4,0.75) to (0.4,1.25)
    ctx.drawLine(0.4, 0.75, 0.4, 1.25);

    // Gate oxide bar: vertical line at x=0.05 from y=0 to y=2
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Gate lead (THIN): (0.75,1) to (1,1) — connects channel to G pin at (1,1)
    ctx.drawLine(0.75, 1, 1, 1);

    // N-channel arrow (filled triangle): (0.6,1) → (0.85,0.9) → (0.85,1.1)
    ctx.drawPolygon([
      { x: 0.6, y: 1 },
      { x: 0.85, y: 0.9 },
      { x: 0.85, y: 1.1 },
    ], true);

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeNFET — flat simulation function
//
// Input layout: [G=0]
// State layout: [closedFlag=0]
// G=1 → closed=1; G=0 → closed=0
// ---------------------------------------------------------------------------

export function executeNFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const closed = gate;
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const drainNet = wt[outBase]!;
    const sourceNet = wt[outBase + 1]!;
    if (closed) {
      state[sourceNet] = state[drainNet]!;
      highZs[sourceNet] = 0;
    } else {
      highZs[sourceNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// NFETSWSubElement — SW sub-element used by NFET and PFET composites.
//
// Implements the single SW sub-element decomposition per PB-NFET / PB-PFET.
// Pin keys: "D" → SWposNode (drain), "S" → SWnegNode (source).
// ngspice anchor: ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62
// ---------------------------------------------------------------------------

export class NFETSWSubElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.SW;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  _hPP: number = -1;
  _hPN: number = -1;
  _hNP: number = -1;
  _hNN: number = -1;

  private _pendingCtrlVoltage: number = 0;
  private _ron: number = 1;
  private _roff: number = 1e9;
  private _vth: number = 2.5;

  setCtrlVoltage(v: number): void {
    this._pendingCtrlVoltage = v;
  }

  setup(ctx: SetupContext): void {
    const drainNode = this._pinNodes.get("D")!;
    const sourceNode = this._pinNodes.get("S")!;

    // Port of swsetup.c:47-48 — state slot allocation (SW_NUM_STATES = 2)
    this._stateBase = ctx.allocStates(2);

    // Port of swsetup.c:59-62 — TSTALLOC sequence (line-for-line)
    this._hPP = ctx.solver.allocElement(drainNode, drainNode);
    this._hPN = ctx.solver.allocElement(drainNode, sourceNode);
    this._hNP = ctx.solver.allocElement(sourceNode, drainNode);
    this._hNN = ctx.solver.allocElement(sourceNode, sourceNode);
  }

  load(ctx: LoadContext): void {
    // swload.c: g_now = on-conductance if vCtrl > vth, else off-conductance
    const gOn = 1 / this._ron;
    const gOff = 1 / this._roff;
    const g_now = this._pendingCtrlVoltage > this._vth ? gOn : gOff;

    // swload.c:149-152 — stamp conductance through cached handles
    ctx.solver.stampElement(this._hPP, +g_now);
    ctx.solver.stampElement(this._hPN, -g_now);
    ctx.solver.stampElement(this._hNP, -g_now);
    ctx.solver.stampElement(this._hNN, +g_now);
  }

  setParam(key: string, value: number): void {
    if (key === "Ron") this._ron = Math.max(value, 1e-12);
    else if (key === "Roff") this._roff = Math.max(value, 1e-12);
    else if (key === "threshold") this._vth = value;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// NFETAnalogElement — AnalogElement implementation (composite, delegates to SW)
// ---------------------------------------------------------------------------

export class NFETAnalogElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.SW;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  readonly _sw: NFETSWSubElement = new NFETSWSubElement();

  setup(ctx: SetupContext): void {
    // NFET composite forwards directly to its single SW sub-element.
    // SW sub-element uses D as posNode, S as negNode.
    this._sw.setup(ctx);
  }

  load(ctx: LoadContext): void {
    // Control voltage: V(G) - V(S), compared against threshold
    const gateNode = this._pinNodes.get("G")!;
    const sourceNode = this._pinNodes.get("S")!;
    const vCtrl = ctx.rhsOld[gateNode] - ctx.rhsOld[sourceNode];
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

function nfetAnalogFactory(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): NFETAnalogElement {
  const el = new NFETAnalogElement();
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

export const NFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Ron", propertyKey: "Ron", convert: (v) => parseFloat(v) },
  { xmlName: "Roff", propertyKey: "Roff", convert: (v) => parseFloat(v) },
  { xmlName: "Vth", propertyKey: "Vth", convert: (v) => parseFloat(v) },
];

const NFET_PROPERTY_DEFS: PropertyDefinition[] = [
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

function nfetFactory(props: PropertyBag): NFETElement {
  return new NFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const NFETDefinition: ComponentDefinition = {
  name: "NFET",
  typeId: -1,
  factory: nfetFactory,
  pinLayout: NFET_PIN_DECLARATIONS,
  propertyDefs: NFET_PROPERTY_DEFS,
  attributeMap: NFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "NFET — N-channel MOSFET. G=1 → conducting.",
  models: {
    digital: {
      executeFn: executeNFET,
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
      factory: nfetAnalogFactory,
      paramDefs: [],
      params: { Ron: 1, Roff: 1e9, Vth: 2.5 },
    },
  },
};
