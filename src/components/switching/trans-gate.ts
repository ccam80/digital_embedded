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
 * Ported from:
 *   ref/Digital/src/main/java/de/neemann/digital/core/switching/TransGate.java
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

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java TransGateShape: p1(SIZE,−SIZE)=(1,−1), p2(SIZE,SIZE)=(1,1), out1(0,0), out2(SIZE*2,0)=(2,0)
const COMP_WIDTH = 2;
const COMP_HEIGHT = 2;

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
  },
  {
    direction: PinDirection.INPUT,
    label: "p2",
    defaultBitWidth: 1,
    position: { x: 1, y: 1 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out1",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "out2",
    defaultBitWidth: 1,
    position: { x: 2, y: 0 },
    isNegatable: false,
    isClockCapable: false,
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
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
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
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const TRANS_GATE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
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
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
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
};
