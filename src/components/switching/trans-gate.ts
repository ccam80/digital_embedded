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
import { PinDirection, resolvePins, createInverterConfig } from "../../core/pin.js";
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

const COMP_WIDTH = 3;
const COMP_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const TRANS_GATE_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "S",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH / 2, y: 0 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.INPUT,
    label: "~S",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH / 2, y: COMP_HEIGHT },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "A",
    defaultBitWidth: 1,
    position: { x: 0, y: COMP_HEIGHT / 2 },
    isNegatable: false,
    isClockCapable: false,
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "B",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: COMP_HEIGHT / 2 },
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// TransGateElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TransGateElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TransGate", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 1);
    this._pins = resolvePins(
      TRANS_GATE_PIN_DECLARATIONS,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      this._bitWidth,
    );
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Channel body — horizontal line through center
    ctx.drawLine(0, COMP_HEIGHT / 2, COMP_WIDTH, COMP_HEIGHT / 2);

    // Gate bar (vertical, NFET side — top)
    ctx.drawLine(COMP_WIDTH / 2 - 0.5, COMP_HEIGHT / 2 - 0.5, COMP_WIDTH / 2 + 0.5, COMP_HEIGHT / 2 - 0.5);
    // Gate bar (vertical, PFET side — bottom)
    ctx.drawLine(COMP_WIDTH / 2 - 0.5, COMP_HEIGHT / 2 + 0.5, COMP_WIDTH / 2 + 0.5, COMP_HEIGHT / 2 + 0.5);

    // S gate line (top)
    ctx.drawLine(COMP_WIDTH / 2, 0, COMP_WIDTH / 2, COMP_HEIGHT / 2 - 0.5);

    // ~S gate line (bottom) with inversion bubble
    ctx.drawLine(COMP_WIDTH / 2, COMP_HEIGHT / 2 + 0.5, COMP_WIDTH / 2, COMP_HEIGHT - 0.15);
    ctx.drawCircle(COMP_WIDTH / 2, COMP_HEIGHT - 0.15, 0.15, false);

    // NFET arrow (top, pointing inward toward channel)
    ctx.drawLine(COMP_WIDTH / 2, COMP_HEIGHT / 2 - 0.5, COMP_WIDTH / 2 - 0.2, COMP_HEIGHT / 2 - 0.8);
    ctx.drawLine(COMP_WIDTH / 2, COMP_HEIGHT / 2 - 0.5, COMP_WIDTH / 2 + 0.2, COMP_HEIGHT / 2 - 0.8);

    // PFET arrow (bottom, pointing outward away from channel)
    ctx.drawLine(COMP_WIDTH / 2 - 0.2, COMP_HEIGHT / 2 + 0.8, COMP_WIDTH / 2, COMP_HEIGHT / 2 + 0.5);
    ctx.drawLine(COMP_WIDTH / 2 + 0.2, COMP_HEIGHT / 2 + 0.8, COMP_WIDTH / 2, COMP_HEIGHT / 2 + 0.5);

    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "TransGate — CMOS transmission gate.\n" +
      "S=1, ~S=0: A and B are connected (conducting).\n" +
      "S=0, ~S=1: A and B are disconnected.\n" +
      "S == ~S: invalid state, treated as open."
    );
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
  executeFn: executeTransGate,
  pinLayout: TRANS_GATE_PIN_DECLARATIONS,
  propertyDefs: TRANS_GATE_PROPERTY_DEFS,
  attributeMap: TRANS_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "TransGate — CMOS transmission gate. S=1, ~S=0 → A and B connected.",
  stateSlotCount: 1,
  defaultDelay: 0,
  switchPins: [2, 3],
};
