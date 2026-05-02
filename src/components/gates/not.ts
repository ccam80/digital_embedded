/**
 * Not gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. StandaloneComponentDefinition for registry registration
 *
 * Not always has exactly 1 input- inputCount is not configurable.
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
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/**
 * Gate width matching Java GenericShape auto-width:
 * 1-in/1-out with no pin labels â†’ width=1 (narrow) or 2 (wide).
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
// NotElement- CircuitElement implementation
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
    // Narrow: bubbleCX=1.5, r=0.45 â†’ maxX=1.95. Wide: bubbleCX=2.5, r=0.45 â†’ maxX=2.95.
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
   * Narrow: triangle (0.05,-0.6)â†’(0.95,0)â†’(0.05,0.6), bubble at (1.5,0) r=0.45.
   * Wide: triangle (0.05,-1.1)â†’(1.95,0)â†’(0.05,1.1), bubble at (2.5,0) r=0.45.
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
// executeNot- flat simulation function
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
    structural: true,
  },
  {
    key: "wideShape",
    type: PropertyType.BOOLEAN,
    label: "Wide shape",
    defaultValue: false,
    description: "Use IEEE/US (triangle with bubble) shape instead of IEC/DIN (rectangular)",
    structural: true,
  },
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------
//
// loaded: when true, parent emits DigitalInputPinLoaded / DigitalOutputPinLoaded
//   sub-elements. When false, emits the Unloaded variants.
// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralNotDriver leaf.
// rOut/cOut/vOH/vOL: per-output drive params, consumed by the outPin sibling.

export const { paramDefs: NOT_BEHAVIORAL_PARAM_DEFS, defaults: NOT_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    loaded: { default: 1,     unit: "",  description: "1 = loaded pins (DigitalInputPinLoaded / DigitalOutputPinLoaded), 0 = unloaded" },
    vIH:    { default: 2.0,   unit: "V", description: "Input high threshold (CMOS spec)" },
    vIL:    { default: 0.8,   unit: "V", description: "Input low threshold (CMOS spec)" },
    rOut:   { default: 100,   unit: "Ω", description: "Output drive resistance" },
    cOut:   { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:    { default: 5.0,   unit: "V", description: "Output high voltage" },
    vOL:    { default: 0.0,   unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildNotNetlist- function-form netlist for the behavioural model
//
// Ports: in, out, gnd
// Sub-elements:
//   drv    : BehavioralNotDriver  (1-bit pure-truth-function leaf, N=1 fixed)
//   inPin_1: DigitalInputPin{Loaded|Unloaded}
//   outPin : DigitalOutputPin{Loaded|Unloaded}  (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildNotNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded        = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // port indices: in=0, out=1, gnd=2
  const ports = ["in", "out", "gnd"];
  const outIdx = 1;
  const gndIdx = 2;

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- exposes OUTPUT_LOGIC_LEVEL via siblingState.
  elements.push({
    typeId: "BehavioralNotDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push([0, outIdx, gndIdx]); // in_1=0, out=outIdx, gnd=gndIdx

  // Input pin- one input port.
  elements.push({
    typeId: inputPinType,
    modelRef: "default",
    subElementName: "inPin_1",
  });
  netlist.push([0, gndIdx]); // in=0, gnd=gndIdx

  // Output pin- siblingState consumes the driver's OUTPUT_LOGIC_LEVEL slot.
  elements.push({
    typeId: outputPinType,
    modelRef: "default",
    subElementName: "outPin",
    params: {
      rOut: params.getModelParam<number>("rOut"),
      cOut: params.getModelParam<number>("cOut"),
      vOH:  params.getModelParam<number>("vOH"),
      vOL:  params.getModelParam<number>("vOL"),
      inputLogic: { kind: "siblingState" as const, subElementName: "drv",
                    slotName: "OUTPUT_LOGIC_LEVEL" },
    },
  });
  netlist.push([outIdx, gndIdx]);

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// CMOS_INVERTER_NETLIST- CMOS inverter structural netlist
//
// Topology: 1 PMOS (pull-up) + 1 NMOS (pull-down).
// Ports: in, out, VDD, GND
// ---------------------------------------------------------------------------

const CMOS_INVERTER_NETLIST: MnaSubcircuitNetlist = {
  ports: ["in", "out", "VDD", "GND"],
  params: { WP: 20e-6, WN: 10e-6, L: 1e-6 },
  elements: [
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
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

export const NotDefinition: StandaloneComponentDefinition = {
  name: "Not",
  typeId: -1,
  factory: notFactory,
  pinLayout: buildPinDeclarations(1, false),
  propertyDefs: NOT_PROPERTY_DEFS,
  attributeMap: NOT_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Not gate- performs bitwise NOT (inversion) of the input.\n" +
    "Single input, configurable bit width (1â€“32).\n" +
    "Both IEEE/US (triangle with bubble) and IEC/DIN (rectangular with 1) shapes are supported.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildNotNetlist,
      paramDefs: NOT_BEHAVIORAL_PARAM_DEFS,
      params: NOT_BEHAVIORAL_DEFAULTS,
    },
    cmos: {
      kind: "netlist",
      netlist: CMOS_INVERTER_NETLIST,
      paramDefs: [
        { key: "WP", type: PropertyType.FLOAT, label: "WP", rank: "primary" },
        { key: "WN", type: PropertyType.FLOAT, label: "WN", rank: "primary" },
        { key: "L", type: PropertyType.FLOAT, label: "L", rank: "primary" },
      ],
      params: { WP: 20e-6, WN: 10e-6, L: 1e-6 },
    },
  },
  models: {
    digital: {
      executeFn: executeNot,
      inputSchema: ["in"],
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
