/**
 * Not gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. ComponentDefinition for registry registration
 *
 * Not always has exactly 1 input — inputCount is not configurable.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  gateBodyMetrics,
  standardGatePinLayout,
  PinDirection,
} from "../../core/pin.js";
import { drawUprightText } from "../../core/upright-text.js";
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeNotAnalogFactory } from "../../solver/analog/behavioral-gate.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * Gate width matching Java GenericShape auto-width:
 * 1-in/1-out with no pin labels → width=1 (narrow) or 2 (wide).
 * Java: `inputs.size()==1 && outputs.size()==1 && !showPinLabels ? 1 : 3`
 * Then .setWide(ws) adds 1 if wideShape.
 */
function compWidth(wideShape: boolean): number { return wideShape ? 2 : 1; }

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

/** Output pin 1 grid unit past body edge (matching Java GenericShape inverted dx=SIZE). */
const OUTPUT_BUBBLE_OFFSET = 1;

function buildPinDeclarations(bitWidth: number, wideShape: boolean = true): PinDeclaration[] {
  const { bodyHeight } = gateBodyMetrics(1);
  return standardGatePinLayout(["in"], "out", compWidth(wideShape), bodyHeight, bitWidth, OUTPUT_BUBBLE_OFFSET);
}

// ---------------------------------------------------------------------------
// NotElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NotElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Not", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls: PinDeclaration[] = buildPinDeclarations(bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && NotDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      const centerX = w / 2;
      decls = [
        ...decls,
        {
          direction: PinDirection.INPUT,
          label: "VDD",
          defaultBitWidth: 1,
          position: { x: centerX, y: -1 },
          isNegatable: false,
          isClockCapable: false,
          kind: "power",
        },
        {
          direction: PinDirection.INPUT,
          label: "GND",
          defaultBitWidth: 1,
          position: { x: centerX, y: 1 },
          isNegatable: false,
          isClockCapable: false,
          kind: "power",
        },
      ];
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const wide = this._properties.getOrDefault<boolean>("wideShape", false);
    // Triangle starts at x=0.05; bubble extends to bubbleCX + BUBBLE_RADIUS.
    // Narrow: bubbleCX=1.5, r=0.45 → maxX=1.95. Wide: bubbleCX=2.5, r=0.45 → maxX=2.95.
    // triY: narrow=0.6, wide=1.1.
    const triY = wide ? 1.1 : 0.6;
    return {
      x: this.position.x + 0.05,
      y: this.position.y - triY,
      width: wide ? 2.9 : 1.9,
      height: triY * 2,
    };
  }

  draw(ctx: RenderContext): void {
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    ctx.save();
    this._drawIEEE(ctx, wideShape);
    this._drawLabel(ctx, wideShape ? 3 : 2);
    ctx.restore();
  }

  /**
   * IEEE/US shape: triangle pointing right, with inversion bubble at output.
   * Coordinates from Java IEEENotShape.
   * Narrow: triangle (0.05,-0.6)→(0.95,0)→(0.05,0.6), bubble at (1.5,0) r=0.45.
   * Wide: triangle (0.05,-1.1)→(1.95,0)→(0.05,1.1), bubble at (2.5,0) r=0.45.
   */
  private _drawIEEE(ctx: RenderContext, wide: boolean): void {
    const BUBBLE_RADIUS = 0.45;

    const triTipX = wide ? 1.95 : 0.95;
    const triY = wide ? 1.1 : 0.6;
    const bubbleCX = wide ? 2.5 : 1.5;

    const ops = [
      { op: "moveTo" as const, x: 0.05, y: -triY },
      { op: "lineTo" as const, x: triTipX, y: 0 },
      { op: "lineTo" as const, x: 0.05, y: triY },
      { op: "closePath" as const },
    ];

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPath({ operations: ops }, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPath({ operations: ops }, false);

    ctx.drawCircle(bubbleCX, 0, BUBBLE_RADIUS, false);
  }

  private _drawLabel(ctx: RenderContext, w: number): void {
    const label = this._visibleLabel();
    if (label.length === 0) return;

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0 });
    drawUprightText(ctx, label, w / 2, -0.5, { horizontal: "center", vertical: "bottom" }, this.rotation);
  }

}

// ---------------------------------------------------------------------------
// executeNot — flat simulation function
// ---------------------------------------------------------------------------

export function executeNot(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputIdx = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  const bitWidth = (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  state[wt[outputIdx]] = ((~state[wt[inputIdx]]) & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// NOT_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const NOT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "wideShape",
    propertyKey: "wideShape",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const NOT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each signal",
  },
  {
    key: "wideShape",
    type: PropertyType.BOOLEAN,
    label: "Wide shape",
    defaultValue: false,
    description: "Use IEEE/US (triangle with bubble) shape instead of IEC/DIN (rectangular)",
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// CMOS_INVERTER_NETLIST — CMOS inverter structural netlist
//
// Topology: 1 PMOS (pull-up) + 1 NMOS (pull-down).
// Ports: in, out, VDD, GND
// ---------------------------------------------------------------------------

const CMOS_INVERTER_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in", "out", "VDD", "GND"],
  params: {},
  elements: [
    { typeId: "PMOS", branchCount: 0 },
    { typeId: "NMOS", branchCount: 0 },
  ],
  internalNetCount: 0,
  // Nets 0..3 = ports [in, out, VDD, GND]
  // PMOS pins: [D, G, S], NMOS pins: [D, G, S]
  netlist: [
    [2, 0, 1], // p: D=VDD(2), G=in(0), S=out(1)
    [1, 0, 3], // n: D=out(1), G=in(0), S=GND(3)
  ],
};

// ---------------------------------------------------------------------------
// NotDefinition
// ---------------------------------------------------------------------------

function notFactory(props: PropertyBag): NotElement {
  return new NotElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const NotDefinition: ComponentDefinition = {
  name: "Not",
  typeId: -1,
  factory: notFactory,
  pinLayout: buildPinDeclarations(1, false),
  propertyDefs: NOT_PROPERTY_DEFS,
  attributeMap: NOT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Not gate — performs bitwise NOT (inversion) of the input.\n" +
    "Single input, configurable bit width (1–32).\n" +
    "Both IEEE/US (triangle with bubble) and IEC/DIN (rectangular with 1) shapes are supported.",
  modelRegistry: {
    cmos: {
      kind: "netlist",
      netlist: CMOS_INVERTER_NETLIST,
      paramDefs: [],
      params: {},
    },
  },
  models: {
    digital: {
      executeFn: executeNot,
      inputSchema: ["in"],
      outputSchema: ["out"],
    },
    mnaModels: {
      behavioral: {
      factory: makeNotAnalogFactory(),
    },
    },
  },
  defaultModel: "digital",
};
