/**
 * Multiplexer component- selects one of N inputs based on selector bits.
 * Output = input[selector].
 *
 * Properties:
 *   - selectorBits: number of selector bits (default 1, gives 2 inputs)
 *   - bitWidth: bit width of data signals (default 1)
 *
 * Pin layout (pin index order):
 *   0: sel (input, selectorBits wide)
 *   1..2^selectorBits: in_0 .. in_(N-1) (inputs, bitWidth wide)
 *   last: out (output, bitWidth wide)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
} from "../../core/pin.js";
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

const COMP_WIDTH = 2;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

export function buildMuxPinDeclarations(
  selectorBits: number,
  bitWidth: number,
  flipSelPos = false,
): PinDeclaration[] {
  const inputCount = 1 << selectorBits;

  // Selector pin: bottom center at (1, inputCount)
  const selPin: PinDeclaration = {
    direction: PinDirection.INPUT,
    label: "sel",
    defaultBitWidth: selectorBits,
    position: { x: 1, y: flipSelPos ? 0 : inputCount },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  // Data input pins: left side
  // Special case for 2 inputs: pins at (0,0) and (0,2)- gap at middle
  const inputPins: PinDeclaration[] = [];
  if (inputCount === 2) {
    inputPins.push({
      direction: PinDirection.INPUT,
      label: "in_0",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
    inputPins.push({
      direction: PinDirection.INPUT,
      label: "in_1",
      defaultBitWidth: bitWidth,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  } else {
    for (let i = 0; i < inputCount; i++) {
      inputPins.push({
        direction: PinDirection.INPUT,
        label: `in_${i}`,
        defaultBitWidth: bitWidth,
        position: { x: 0, y: i },
        isNegatable: false,
        isClockCapable: false,
        kind: "signal",
      });
    }
  }

  // Output pin: right side, vertically centered at (2, floor(inputCount/2))
  const outPin: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: "out",
    defaultBitWidth: bitWidth,
    position: { x: 2, y: Math.floor(inputCount / 2) },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };

  return [selPin, ...inputPins, outPin];
}

// ---------------------------------------------------------------------------
// MuxElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class MuxElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Multiplexer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const flipSelPos = this._properties.getOrDefault<boolean>("flipSelPos", false);
    return this.derivePins(buildMuxPinDeclarations(selectorBits, bitWidth, flipSelPos), []);
  }

  getBoundingBox(): Rect {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const inputCount = 1 << selectorBits;
    // Trapezoid: (0.05,-0.2) -> (1.95,0.25) -> (1.95,h-0.25) -> (0.05,h+0.2).
    // MinX=0.05, maxX=1.95, minY=-0.2, maxY=h+0.2.
    // height = (h+0.2) - (-0.2) to avoid float cancellation in y + height.
    const minY = -0.2;
    const maxY = inputCount + 0.2;
    return {
      x: this.position.x + 0.05,
      y: this.position.y + minY,
      width: 1.9,
      height: maxY - minY,
    };
  }

  draw(ctx: RenderContext): void {
    const selectorBits = this._properties.getOrDefault<number>("selectorBits", 1);
    const inputCount = 1 << selectorBits;
    // h is the span used for the trapezoid body (inputCount grid units)
    const h = inputCount;

    ctx.save();

    // Trapezoid with Java's 0.05 horizontal insets:
    // (0.05,-0.2) -> (1.95,0.25) -> (1.95,h-0.25) -> (0.05,h+0.2)
    const poly = [
      { x: 0.05, y: -0.2 },
      { x: COMP_WIDTH - 0.05, y: 0.25 },
      { x: COMP_WIDTH - 0.05, y: h - 0.25 },
      { x: 0.05, y: h + 0.2 },
    ];

    ctx.setColor("COMPONENT_FILL");
    ctx.drawPolygon(poly, true);

    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawPolygon(poly, false);

    // Java draws only "0" at (0.15, 0.1) with left/top anchor
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.9, weight: "bold" });
    ctx.drawText("0", 0.15, 0.1, {
      horizontal: "left",
      vertical: "top",
    });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// executeMux- flat simulation function
//
// Pin layout in state array (matching buildMuxPinDeclarations order):
//   input 0: sel
//   inputs 1..N: in_0..in_(N-1)
//   output 0: out
// ---------------------------------------------------------------------------

export function executeMux(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outIdx = layout.outputOffset(index);

  const sel = state[wt[inBase]] >>> 0;
  // input 0 is sel, data inputs start at inBase+1
  const dataBase = inBase + 1;
  state[wt[outIdx]] = state[wt[dataBase + sel]] >>> 0;
}

// ---------------------------------------------------------------------------
// MUX_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const MUX_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Selector Bits",
    propertyKey: "selectorBits",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "flipSelPos",
    propertyKey: "flipSelPos",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const MUX_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "selectorBits",
    type: PropertyType.INT,
    label: "Selector Bits",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of selector bits (determines number of inputs: 2^selectorBits)",
    structural: true,
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each data signal",
    structural: true,
  },
  LABEL_PROPERTY_DEF,
  {
    key: "flipSelPos",
    type: PropertyType.BOOLEAN,
    label: "Flip Selector Position",
    defaultValue: false,
    description: "When true, selector pin is at top instead of bottom",
  },
];

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------
//
// selectorBits: structural; per-instance K selector bits. N = 2^K data inputs.
// loaded: when true, parent emits DigitalInputPinLoaded / DigitalOutputPinLoaded
//   sub-elements. When false, parent emits the Unloaded variants.
// vIH/vIL: per-input CMOS thresholds, consumed by BehavioralMuxDriver leaf.
// rOut/cOut/vOH/vOL: per-output drive params, consumed by the outPin sibling.

export const { paramDefs: MUX_BEHAVIORAL_PARAM_DEFS, defaults: MUX_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    selectorBits: { default: 1,     unit: "",  description: "Number of selector bits (structural; N = 2^selectorBits data inputs)" },
    loaded:       { default: 1,     unit: "",  description: "1 = loaded pins (DigitalInputPinLoaded / DigitalOutputPinLoaded), 0 = unloaded" },
    vIH:          { default: 2.0,   unit: "V", description: "Input high threshold (CMOS spec)" },
    vIL:          { default: 0.8,   unit: "V", description: "Input low threshold (CMOS spec)" },
    rOut:         { default: 100,   unit: "Ω", description: "Output drive resistance" },
    cOut:         { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:          { default: 5.0,   unit: "V", description: "Output high voltage" },
    vOL:          { default: 0.0,   unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildMuxNetlist- function-form netlist for the behavioural model
//
// Ports: data_0 .. data_{N-1}, sel_0 .. sel_{K-1}, out, gnd
// Sub-elements:
//   drv       : BehavioralMuxDriver  (selector-indexed pick leaf)
//   inPin_data_i : DigitalInputPin{Loaded|Unloaded}  (one per data port)
//   inPin_sel_i  : DigitalInputPin{Loaded|Unloaded}  (one per sel port)
//   outPin    : DigitalOutputPin{Loaded|Unloaded}  (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildMuxNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const K        = params.getModelParam<number>("selectorBits");
  const N        = 1 << K;
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port order: data_0..data_{N-1}, sel_0..sel_{K-1}, out, gnd
  const ports: string[] = [];
  for (let i = 0; i < N; i++) ports.push(`data_${i}`);
  for (let i = 0; i < K; i++) ports.push(`sel_${i}`);
  ports.push("out", "gnd");

  const outPortIdx = N + K;
  const gndPortIdx = N + K + 1;

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- exposes OUTPUT_LOGIC_LEVEL via siblingState.
  // Pin order in driver: data_0..data_{N-1}, sel_0..sel_{K-1}, out, gnd
  const driverPins: number[] = [];
  for (let i = 0; i < N; i++) driverPins.push(i);
  for (let i = 0; i < K; i++) driverPins.push(N + i);
  driverPins.push(outPortIdx, gndPortIdx);
  elements.push({
    typeId: "BehavioralMuxDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      selectorBits: K,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(driverPins);

  // Data input pins- one per data port.
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_data_${i}`,
    });
    netlist.push([i, gndPortIdx]);
  }

  // Selector input pins- one per sel port.
  for (let i = 0; i < K; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_sel_${i}`,
    });
    netlist.push([N + i, gndPortIdx]);
  }

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
  netlist.push([outPortIdx, gndPortIdx]);

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// MuxDefinition
// ---------------------------------------------------------------------------

function muxFactory(props: PropertyBag): MuxElement {
  return new MuxElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const MuxDefinition: StandaloneComponentDefinition = {
  name: "Multiplexer",
  typeId: -1,
  factory: muxFactory,
  pinLayout: buildMuxPinDeclarations(1, 1, false),
  propertyDefs: MUX_PROPERTY_DEFS,
  attributeMap: MUX_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.WIRING,
  helpText:
    "Multiplexer- selects one of N inputs based on selector bits.\n" +
    "Output = input[selector]. N = 2^selectorBits.",
  models: {
    digital: {
      executeFn: executeMux,
      inputSchema: (props) => {
        const selectorBits = props.getOrDefault<number>("selectorBits", 1);
        const inputCount = 1 << selectorBits;
        const labels = ["sel"];
        for (let i = 0; i < inputCount; i++) {
          labels.push(`in_${i}`);
        }
        return labels;
      },
      outputSchema: ["out"],
    },
  },
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildMuxNetlist,
      paramDefs: MUX_BEHAVIORAL_PARAM_DEFS,
      params: MUX_BEHAVIORAL_DEFAULTS,
    },
  },
  defaultModel: "digital",
};
