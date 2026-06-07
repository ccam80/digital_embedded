/**
 * TransGate- CMOS transmission gate.
 *
 * A bidirectional switch controlled by a complementary pair of gate signals.
 * Closed (A and B connected) when: S=1 AND ~S=0 (S != ~S and S is high).
 * Open in all other cases including when S == ~S (invalid state).
 *
 * Pins:
 *   Input:         p1  (gate, 1-bit)
 *   Input:         p2  (complementary gate, 1-bit)
 *   Bidirectional: out1 (bitWidth)
 *   Bidirectional: out2 (bitWidth)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
 *
 * Analog model (kind: "netlist"):
 *   Two SW paths share the same drain/source nodes (D=out1, S=out2).
 *
 *   nfetDrv + nfetSW: NFET path. Driver classifies V(p1) - V(out2) on the
 *        N-channel rule (on when vGS > Vth). Switch reads slot, stamps
 *        admittance with invertCtrl=0.
 *
 *   pfetDrv + pfetSW: PFET path. Driver classifies V(p2) - V(out2) on the
 *        P-channel rule (on when vGS < -Vth). Switch reads slot with
 *        invertCtrl=0 (driver already encodes "on" as 1).
 *
 * Per PB-TRANSGATE TSTALLOC ordering (Wave 11a spec line 386): NFET path
 * is emitted FIRST (drv + sw) before the PFET path. Both SW elements share
 * the same NGSPICE_LOAD_ORDER (SW), so emission order determines stamp order.
 *
 * ngspice anchor: ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62
 * (applied twice, NFET-first).
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

// Java TransGateShape: p1(SIZE,-SIZE)=(1,-1), p2(SIZE,SIZE)=(1,1), out1(0,0), out2(SIZE*2,0)=(2,0)
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
// TransGateElement- CircuitElement implementation
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

    // Upper NFET bowtie polygon (closed): (0,0)->(0,-1)->(2,0)->(2,-1)->(0,0)
    ctx.drawPolygon([
      { x: 0, y: 0 },
      { x: 0, y: -1 },
      { x: 2, y: 0 },
      { x: 2, y: -1 },
      { x: 0, y: 0 },
    ], false);

    // Lower PFET bowtie polygon (closed): (0,0)->(0,1)->(2,0)->(2,1)->(0,0)
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
// executeTransGate- flat simulation function
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
// buildTransGateNetlist- analog netlist builder
//
// Ports: p1=0, p2=1, out1=2, out2=3
//
// Elements (NFET path FIRST per PB-TRANSGATE TSTALLOC ordering):
//   nfetDrv (BehavioralFETDriver, isNType=1): pins (G=p1, D=out1, S=out2),
//        on-condition vGS = V(p1) - V(out2) > Vth.
//   nfetSW  (FetSW, invertCtrl=0): pins (D=out1, S=out2).
//
//   pfetDrv (BehavioralFETDriver, isNType=0): pins (G=p2, D=out1, S=out2),
//        on-condition vGS = V(p2) - V(out2) < -Vth.
//   pfetSW  (FetSW, invertCtrl=0): pins (D=out1, S=out2).
// ---------------------------------------------------------------------------

export const buildTransGateNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  // Ron/Roff/Vth are declared in paramDefs and merged into the bag by the
  // unified instantiation — read directly. The isNType / invertCtrl values on
  // the sub-elements below are device-identity constants (N-path vs P-path),
  // not params.
  const ron = params.getModelParam<number>("Ron");
  const roff = params.getModelParam<number>("Roff");
  const vth = params.getModelParam<number>("Vth");

  return {
    ports: ["p1", "p2", "out1", "out2"],
    elements: [
      // NFET path- emitted first per PB-TRANSGATE TSTALLOC ordering.
      {
        typeId: "BehavioralFETDriver",
        modelRef: "default",
        subElementName: "nfetDrv",
        params: { Vth: vth, isNType: 1 },
      },
      {
        typeId: "FetSW",
        modelRef: "default",
        subElementName: "nfetSW",
        params: {
          Ron: ron,
          Roff: roff,
          invertCtrl: 0,
        },
      },
      // PFET path- emitted second.
      {
        typeId: "BehavioralFETDriver",
        modelRef: "default",
        subElementName: "pfetDrv",
        params: { Vth: vth, isNType: 0 },
      },
      {
        typeId: "FetSW",
        modelRef: "default",
        subElementName: "pfetSW",
        params: {
          Ron: ron,
          Roff: roff,
          invertCtrl: 0,
        },
      },
    ],
    internalNetCount: 2,
    internalNetLabels: ["nfet_ctrl", "pfet_ctrl"],
    // ports: p1=0, p2=1, out1=2, out2=3; nfet_ctrl=4, pfet_ctrl=5
    netlist: [
      [0, 3, 4], // nfetDrv: G=p1, S=out2, ctrl_out=nfet_ctrl(4)
      [2, 3, 4], // nfetSW:  D=out1, S=out2, ctrl=nfet_ctrl(4)
      [1, 3, 5], // pfetDrv: G=p2, S=out2, ctrl_out=pfet_ctrl(5)
      [2, 3, 5], // pfetSW:  D=out1, S=out2, ctrl=pfet_ctrl(5)
    ],
  };
};

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const TRANS_GATE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Ron", propertyKey: "Ron", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "Roff", propertyKey: "Roff", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "Vth", propertyKey: "Vth", modelParam: true, convert: (v) => parseFloat(v) },
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

function transGateFactory(props: PropertyBag): TransGateElement {
  return new TransGateElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TransGateDefinition: StandaloneComponentDefinition = {
  name: "TransGate",
  typeId: -1,
  factory: transGateFactory,
  pinLayout: TRANS_GATE_PIN_DECLARATIONS,
  propertyDefs: TRANS_GATE_PROPERTY_DEFS,
  attributeMap: TRANS_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "TransGate- CMOS transmission gate. S=1, ~S=0 -> A and B connected.",
  models: {
    digital: {
      executeFn: executeTransGate,
      inputSchema: ["p1", "p2", "out1", "out2"],
      outputSchema: ["out1", "out2"],
      stateSlotCount: 1,
      switchPins: [2, 3],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "netlist",
      netlist: buildTransGateNetlist,
      paramDefs: [
        { key: "Ron", default: 1 },
        { key: "Roff", default: 1e9 },
        { key: "Vth", default: 2.5 },
      ],
      params: {},
    },
  },
};
