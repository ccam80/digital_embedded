/**
 * TransGate — CMOS transmission gate.
 *
 * A bidirectional switch controlled by a complementary pair of gate signals.
 * Closed (A and B connected) when: S=1 AND ~S=0 (S != ~S and S is high).
 * Open in all other cases including when S == ~S (invalid state).
 *
 * Pins:
 *   Input:         S   (gate, 1-bit)
 *   Input:         ~S  (complementary gate, 1-bit)
 *   Bidirectional: A   (bitWidth)
 *   Bidirectional: B   (bitWidth)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Analog model: composite of two SW sub-elements sharing the same in↔out
 * signal path. NFET SW uses ctrl pin; PFET SW uses ctrlN pin (inverted).
 * ngspice anchor: ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62
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
import type { FETLayout } from "./nfet.js";
import { NFETSWSubElement } from "./nfet.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java TransGateShape: p1(SIZE,−SIZE)=(1,−1), p2(SIZE,SIZE)=(1,1), out1(0,0), out2(SIZE*2,0)=(2,0)
const COMP_WIDTH = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const TRANS_GATE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "p1",
    defaultBitWidth: 1,
    position: { x: 1, y: -1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.INPUT,
    label: "p2",
    defaultBitWidth: 1,
    position: { x: 1, y: 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out1",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out2",
    defaultBitWidth: 1,
    position: { x: 2, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// TransGateElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TransGateElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TransGate", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(TRANS_GATE_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Gate line extends up to y=-1 (pin p1 at y=-1).
    // Label text at y=-1.4 doesn't produce segments; drawn geometry min y=-1.
    // Starting bbox at y=-1.4 caused overflow = tsBounds.minY - by0 = -1 - (-1.4) = 0.4.
    // Circle at (1, 0.75) r=0.2 means max drawn y=0.95; bbox bottom at y=1 covers it.
    return { x: this.position.x, y: this.position.y - 1, width: COMP_WIDTH, height: 2 };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Upper NFET bowtie polygon (closed): (0,0)→(0,-1)→(2,0)→(2,-1)→(0,0)
    ctx.drawPolygon([
      { x: 0, y: 0 },
      { x: 0, y: -1 },
      { x: 2, y: 0 },
      { x: 2, y: -1 },
      { x: 0, y: 0 },
    ], false);

    // Lower PFET bowtie polygon (closed): (0,0)→(0,1)→(2,0)→(2,1)→(0,0)
    ctx.drawPolygon([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 0 },
    ], false);

    // Gate line (top): p1 pin at (1,-1) connects to upper polygon at (1,-0.5)
    ctx.drawLine(1, -1, 1, -0.5);

    // Inversion bubble circle for p2 (bottom gate) at (1,0.75) r=0.2
    ctx.drawCircle(1, 0.75, 0.2, false);

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -1.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeTransGate — flat simulation function
//
// Input layout: [S=0, ~S=1, A=2, B=3]
// State layout: [closedFlag=0]
// Closed when: S=1 AND ~S=0 (complementary and S is high)
// ---------------------------------------------------------------------------

export function executeTransGate(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const sHighZ = highZs[wt[inBase]!]! !== 0;
  const nsHighZ = highZs[wt[inBase + 1]!]! !== 0;

  let closed = 0;
  if (!sHighZ && !nsHighZ) {
    const s = state[wt[inBase]!]! & 1;
    const ns = state[wt[inBase + 1]!]! & 1;
    if (s !== ns) {
      closed = s;
    }
  }
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const aNet = wt[outBase]!;
    const bNet = wt[outBase + 1]!;
    if (closed) {
      state[bNet] = state[aNet]!;
      highZs[bNet] = 0;
    } else {
      highZs[bNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// TransGateAnalogElement — MNA composite element
//
// Composite: two SW sub-elements sharing the same in↔out signal path.
//   _nfetSW: posNode=inNode, negNode=outNode, control=p1 (ctrl pin)
//            ON when V(p1) > Vth_n
//   _pfetSW: posNode=inNode, negNode=outNode, control=p2 (ctrlN pin, inverted)
//            ON when V(p2) < Vth_p (implemented as inverted control voltage)
//
// setup() calls _nfetSW.setup(ctx) then _pfetSW.setup(ctx) — NFET first per
// A6.4 sub-element ordering rule (both are SW, same NGSPICE_LOAD_ORDER; NFET
// sub-element is first by construction order, matching PB-TRANSGATE TSTALLOC table).
//
// ngspice anchor: ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62 (applied twice)
// ---------------------------------------------------------------------------

export class TransGateAnalogElement implements AnalogElement {
  label: string = "";
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.SW;
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _nfetSW: NFETSWSubElement;
  readonly _pfetSW: NFETSWSubElement;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);

    const inNode = pinNodes.get("out1")!;
    const outNode = pinNodes.get("out2")!;

    this._nfetSW = new NFETSWSubElement();
    this._nfetSW._pinNodes = new Map([
      ["D", inNode],
      ["S", outNode],
    ]);

    this._pfetSW = new NFETSWSubElement();
    this._pfetSW._pinNodes = new Map([
      ["D", inNode],
      ["S", outNode],
    ]);
  }

  setup(ctx: SetupContext): void {
    // Both sub-elements share the same signal path (in=out1, out=out2).
    // NFET's SW setup runs first, PFET's SW setup runs second.
    // Per PB-TRANSGATE TSTALLOC table: entries 1-4 are NFET SW, 5-8 are PFET SW.
    // Per A6.4: sub-elements in NGSPICE_LOAD_ORDER ascending (both SW = same order;
    // NFET first by construction, matching ngspice swsetup.c applied twice).
    this._nfetSW.setup(ctx);
    this._pfetSW.setup(ctx);
  }

  load(ctx: LoadContext): void {
    // NFET SW: ON when V(p1) - V(0) > Vth_n (p1 is ctrl pin, active-high)
    const ctrlNode = this._pinNodes.get("p1")!;
    const vCtrlN = ctx.rhsOld[ctrlNode] ?? 0;
    this._nfetSW.setCtrlVoltage(vCtrlN);
    this._nfetSW.load(ctx);

    // PFET SW: ON when V(0) - V(p2) > |Vth_p| (p2 is ctrlN pin, active-low)
    // Invert: present as positive control voltage when p2 is low.
    const ctrlNNode = this._pinNodes.get("p2")!;
    const vCtrlP = -(ctx.rhsOld[ctrlNNode] ?? 0);
    this._pfetSW.setCtrlVoltage(vCtrlP);
    this._pfetSW.load(ctx);
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0, 0];
  }

  setParam(key: string, value: number): void {
    this._nfetSW.setParam(key, value);
    this._pfetSW.setParam(key, value);
  }
}

function createTransGateAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): TransGateAnalogElement {
  const el = new TransGateAnalogElement(pinNodes);

  const ron = Math.max(props.getOrDefault<number>("Ron", 1), 1e-12);
  const roff = Math.max(props.getOrDefault<number>("Roff", 1e9), 1e-12);
  const vth = props.getOrDefault<number>("Vth", 2.5);

  el._nfetSW.setParam("Ron", ron);
  el._nfetSW.setParam("Roff", roff);
  el._nfetSW.setParam("threshold", vth);
  el._pfetSW.setParam("Ron", ron);
  el._pfetSW.setParam("Roff", roff);
  el._pfetSW.setParam("threshold", vth);

  return el;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const TRANS_GATE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Ron", propertyKey: "Ron", convert: (v) => parseFloat(v) },
  { xmlName: "Roff", propertyKey: "Roff", convert: (v) => parseFloat(v) },
  { xmlName: "Vth", propertyKey: "Vth", convert: (v) => parseFloat(v) },
];

const TRANS_GATE_PROPERTY_DEFS: PropertyDefinition[] = [
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

function transGateFactory(props: PropertyBag): TransGateElement {
  return new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TransGateDefinition: ComponentDefinition = {
  name: "TransGate",
  typeId: -1,
  factory: transGateFactory,
  pinLayout: TRANS_GATE_PIN_DECLARATIONS,
  propertyDefs: TRANS_GATE_PROPERTY_DEFS,
  attributeMap: TRANS_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "TransGate — CMOS transmission gate. S=1, ~S=0 → A and B connected.",
  models: {
    digital: {
      executeFn: executeTransGate,
      inputSchema: ["p1", "p2"],
      outputSchema: ["out1", "out2"],
      stateSlotCount: 1,
      switchPins: [2, 3],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransGateAnalogElement,
      paramDefs: [],
      params: { Ron: 1, Roff: 1e9, Vth: 2.5 },
    },
  },
};
