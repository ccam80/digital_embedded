/**
 * BusSplitter component- bidirectional bus splitter with Output Enable control.
 *
 * Common bus D (n-bit, bidirectional) and individual bit lines D0..D(n-1)
 * (1-bit, bidirectional) are gated by OE (1-bit input):
 *
 *   OE = 1: D drives D0..D(n-1). Bit i of D appears on D[i]. The D side stops
 *           driving D, so external bus drivers on D dominate.
 *   OE = 0: D0..D(n-1) drive D. The packed bits appear on D. The D[i] sides
 *           stop driving the bit lines, so external drivers on D[i] dominate.
 *
 * Per-bit high-Z is propagated faithfully: a high-Z bit on the source side
 * yields a high-Z bit on the destination side.
 *
 * Java reference: hneemann/Digital BusSplitter.java
 *   `commonOut`/`out[i]` are setBidirectional()+setToHighZ(); the readInputs/
 *   writeOutputs split chooses which side drives based on OE.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import { drawTextUpright } from "../generic-shape.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// BusSplitterElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class BusSplitterElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("BusSplitter", instanceId, position, rotation, mirror, props);
  }

  get bits(): number {
    return this._properties.getOrDefault<number>("bitWidth", 1);
  }

  get spreading(): number {
    return this._properties.getOrDefault<number>("spreading", 1);
  }

  getPins(): readonly Pin[] {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    const decls: PinDeclaration[] = [
      {
        direction: PinDirection.BIDIRECTIONAL,
        label: "D",
        defaultBitWidth: bits,
        position: { x: 0, y: 0 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
      {
        direction: PinDirection.INPUT,
        label: "OE",
        defaultBitWidth: 1,
        position: { x: 0, y: 1 },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      },
    ];
    for (let i = 0; i < bits; i++) {
      decls.push({
        direction: PinDirection.BIDIRECTIONAL,
        label: `D${i}`,
        defaultBitWidth: 1,
        position: { x: 1, y: i * spreading },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      });
    }
    return resolvePins(
      decls,
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
    );
  }

  getBoundingBox(): Rect {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    // Original height formula covers OE pin at y=1 and all bit pins
    const h = Math.max(2, (bits - 1) * spreading + 1);
    // Filled bar top extends to y=-0.1 above origin, so shift bbox top up by 0.1.
    // Keep height = h so the bottom edge is unchanged.
    return {
      x: this.position.x,
      y: this.position.y - 0.1,
      width: 1,
      height: h,
    };
  }

  draw(ctx: RenderContext): void {
    const bits = this._properties.getOrDefault<number>("bitWidth", 1);
    const spreading = this._properties.getOrDefault<number>("spreading", 1);
    const lastBitY = (bits - 1) * spreading;
    const flip = this.rotation === 2;

    ctx.save();

    const labelFont = { family: "sans-serif", size: 0.35 };

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Left side: D pin lead (0,0)â†’(0.5,0) and OE pin lead (0,1)â†’(0.5,1)
    ctx.drawLine(0, 0, 0.5, 0);
    ctx.drawLine(0, 1, 0.5, 1);

    // Text labels for D and OE on the left (RIGHTBOTTOM anchor â†’ right,bottom)
    ctx.setFont(labelFont);
    ctx.setColor("TEXT");
    drawTextUpright(ctx, "D",  -0.1, -0.15, { horizontal: "right", vertical: "bottom" }, flip);
    drawTextUpright(ctx, "OE", -0.1,  0.85, { horizontal: "right", vertical: "bottom" }, flip);

    // Right side: lead lines from (1,y)â†’(0.5,y) and labels for each bit
    ctx.setColor("COMPONENT");
    for (let i = 0; i < bits; i++) {
      const y = i * spreading;
      ctx.drawLine(1, y, 0.5, y);
      ctx.setFont(labelFont);
      ctx.setColor("TEXT");
      // LEFTBOTTOM anchor â†’ left,bottom; label offset mirrors Java: x=1.1, y=bitY-0.15
      drawTextUpright(ctx, `D${i}`, 1.1, y - 0.15, { horizontal: "left", vertical: "bottom" }, flip);
      ctx.setColor("COMPONENT");
    }

    // Filled vertical bar: (0.4,-0.1)â†’(0.6,-0.1)â†’(0.6,barBottom)â†’(0.4,barBottom), FILLED
    // Use drawPolygon with explicit coords to avoid drawRect float error
    // (0.4+0.2 != 0.6 and -0.1+barHeight != barBottom in IEEE 754).
    const barBottom = Math.max(1, lastBitY) + 0.1;
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([
      { x: 0.4, y: -0.1 },
      { x: 0.6, y: -0.1 },
      { x: 0.6, y: barBottom },
      { x: 0.4, y: barBottom },
    ], true);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeBusSplitter
//
// Bidirectional propagation. Slot layout (driven by inputSchema/outputSchema
// below):
//
//   inputOffset (read from resolved real nets):
//     +0  OE
//     +1  D       (n-bit, real net, includes other drivers)
//     +2  D0
//     +3  D1
//     ...
//
//   outputOffset (write to this component's per-pin shadow; the bus resolver
//   merges shadows from all drivers of each net):
//     +0  D
//     +1  D0
//     +2  D1
//     ...
//
// Per-bit high-Z encoding (bus-resolution.ts:resolveBusDrivers):
//   highZs[netId] is a per-bit mask. A driver contributes 0 on high-Z bits and
//   `value & ~highZs` on driven bits. 0xFFFFFFFF means "nothing driven".
// ---------------------------------------------------------------------------

export function executeBusSplitter(
  index: number,
  state: Uint32Array,
  highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const inCount = layout.inputCount(index);
  // inputs: OE, D, D0..D(bits-1)  → bits = inCount - 2
  const bits = inCount - 2;

  const oe = state[wt[inBase + 0]];
  const dShadow = wt[outBase + 0];

  if (oe) {
    // OE=1: D drives D0..D(bits-1); this side stops driving D.
    const dRealNet = wt[inBase + 1];
    const dValue = state[dRealNet] ?? 0;
    const dHighZ = highZs[dRealNet] ?? 0xffffffff;

    state[dShadow] = 0;
    highZs[dShadow] = 0xffffffff;

    for (let i = 0; i < bits; i++) {
      const biShadow = wt[outBase + 1 + i];
      const bitMask = 1 << i;
      const bit = (dValue & bitMask) !== 0 ? 1 : 0;
      const bitHighZ = (dHighZ & bitMask) !== 0;
      state[biShadow] = bit;
      highZs[biShadow] = bitHighZ ? 0xffffffff : 0;
    }
  } else {
    // OE=0: D0..D(bits-1) drive D; this side stops driving the bit lines.
    let dValue = 0;
    let dHighZ = 0;
    for (let i = 0; i < bits; i++) {
      const biRealNet = wt[inBase + 2 + i];
      const biValue = (state[biRealNet] ?? 0) & 1;
      const biIsHighZ = ((highZs[biRealNet] ?? 0xffffffff) & 1) !== 0;
      const bitMask = 1 << i;
      if (biValue) dValue |= bitMask;
      if (biIsHighZ) dHighZ |= bitMask;
    }
    state[dShadow] = dValue;
    highZs[dShadow] = dHighZ;

    for (let i = 0; i < bits; i++) {
      const biShadow = wt[outBase + 1 + i];
      state[biShadow] = 0;
      highZs[biShadow] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// BUS_SPLITTER_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const BUS_SPLITTER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "spreading",
    propertyKey: "spreading",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const BUS_SPLITTER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    description: "Number of bits in the common bus",
    structural: true,
  },
  {
    key: "spreading",
    type: PropertyType.INT,
    label: "Spreading",
    defaultValue: 1,
    description: "Vertical spacing between individual bit pins",
  },
];

// ---------------------------------------------------------------------------
// BusSplitterDefinition
// ---------------------------------------------------------------------------

function busSplitterFactory(props: PropertyBag): BusSplitterElement {
  return new BusSplitterElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

function buildDefaultPinLayout(bits: number, spreading: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [
    {
      direction: PinDirection.BIDIRECTIONAL,
      label: "D",
      defaultBitWidth: bits,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "OE",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
  for (let i = 0; i < bits; i++) {
    decls.push({
      direction: PinDirection.BIDIRECTIONAL,
      label: `D${i}`,
      defaultBitWidth: 1,
      position: { x: 1, y: i * spreading },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }
  return decls;
}

export const BusSplitterDefinition: StandaloneComponentDefinition = {
  name: "BusSplitter",
  typeId: -1,
  factory: busSplitterFactory,
  pinLayout: buildDefaultPinLayout(1, 1),
  propertyDefs: BUS_SPLITTER_PROPERTY_DEFS,
  attributeMap: BUS_SPLITTER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "BusSplitter- bidirectional bus splitter with Output Enable control.\n" +
    "OE=1: D drives D0..D(bits-1) (split). OE=0: D0..D(bits-1) drive D (merge).\n" +
    "Whichever side is not driving goes high-Z, so external drivers on that\n" +
    "side dominate. Per-bit high-Z propagates faithfully across the gate.",
  models: {
    digital: {
      executeFn: executeBusSplitter,
      inputSchema: (props) => {
        const bits = props.getOrDefault<number>("bitWidth", 1);
        // OE first, then D (for the merge direction), then D0..D(bits-1)
        // (for the split direction); order is consumed positionally by
        // executeBusSplitter.
        const labels = ["OE", "D"];
        for (let i = 0; i < bits; i++) {
          labels.push(`D${i}`);
        }
        return labels;
      },
      outputSchema: (props) => {
        const bits = props.getOrDefault<number>("bitWidth", 1);
        const labels = ["D"];
        for (let i = 0; i < bits; i++) {
          labels.push(`D${i}`);
        }
        return labels;
      },
    },
  },
  // Behavioural analog model is a future scoped job (NEW driver leaf with
  // OE-gated splitter semantics required, distinct from BehavioralSplitterDriver
  // which is always-active and cannot represent this component's tri-state OE).
  defaultModel: "digital",
};
