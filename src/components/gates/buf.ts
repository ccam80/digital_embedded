/**
 * BUF gate component- non-inverting buffer with 1 input and 1 output.
 *
 * Mirrors and.ts shape (AbstractCircuitElement, flat executeFn, attributeMap,
 * StandaloneComponentDefinition) with N=1 fixed: no inputCount property,
 * no CMOS model. The behavioral netlist (buildBufNetlist) wires 1 input pin,
 * 1 BehavioralBufDriver leaf, and 1 output pin.
 *
 * Per J-038 (BUF user-facing) + J-137 (Composite M10, contracts_group_09.md).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, Rotation } from "../../core/pin.js";
import { gateBodyMetrics } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import { LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AttributeMapping } from "../../core/registry.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  compWidth,
  buildStandardPinDeclarations,
  drawGateLabel,
  drawAndBody,
} from "./gate-shared.js";

// ---------------------------------------------------------------------------
// BufElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class BufElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Buf", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    // N=1 fixed; no wideShape or inputCount properties on BUF
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const decls = buildStandardPinDeclarations(1, bitWidth, false);
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    // N=1 fixed, narrow shape
    const { topBorder, bodyHeight } = gateBodyMetrics(1);
    return {
      x: this.position.x + 0.05,
      y: this.position.y - topBorder,
      width: compWidth(false) - 0.05,
      height: bodyHeight,
    };
  }

  draw(ctx: RenderContext): void {
    const w = compWidth(false);

    ctx.save();

    // N=1: no extension lines needed (drawGateExtensionLines is a no-op for
    // inputCount <= 2, and BUF always has 1 input).
    drawAndBody(ctx, w);

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeBuf- flat simulation function
//
// Zero allocations. Reads 1 input from the state array, copies it to the
// output slot (identity / pass-through).
// ---------------------------------------------------------------------------

export function executeBuf(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const outputIdx = layout.outputOffset(index);
  state[wt[outputIdx]] = state[wt[inputStart]];
}

// ---------------------------------------------------------------------------
// BUF behavioral model parameter declarations
//
// Mirrors AND_BEHAVIORAL_PARAM_DEFS but drops inputCount (N=1 is fixed).
// ---------------------------------------------------------------------------

export const { paramDefs: BUF_BEHAVIORAL_PARAM_DEFS, defaults: BUF_BEHAVIORAL_DEFAULTS } = defineModelParams({
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
// buildBufNetlist- function-form netlist for the behavioral model
//
// Ports: in_1, out, gnd
// Sub-elements:
//   drv    : BehavioralBufDriver (1-bit identity driver, N=1 fixed)
//   inPin_1: DigitalInputPin{Loaded|Unloaded}
//   outPin : DigitalOutputPin{Loaded|Unloaded} (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildBufNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const loaded        = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  // Port indices: in_1=0, out=1, gnd=2
  const ports: string[] = ["in_1", "out", "gnd"];
  const outIdx = 1;
  const gndIdx = 2;

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- exposes OUTPUT_LOGIC_LEVEL via siblingState.
  elements.push({
    typeId: "BehavioralBufDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  // drv connectivity: [in_1(0), out(1), gnd(2)]
  netlist.push([0, outIdx, gndIdx]);

  // Input pin- port in_1 (index 0) to gnd (index 2)
  elements.push({
    typeId: inputPinType,
    modelRef: "default",
    subElementName: "inPin_1",
  });
  netlist.push([0, gndIdx]);

  // Output pin- siblingState consumes driver's OUTPUT_LOGIC_LEVEL slot.
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
// BUF attribute mappings- Bits and Label only (no Inputs, no wideShape)
// ---------------------------------------------------------------------------

export const BUF_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// BUF property definitions- bitWidth and label only (no inputCount)
// ---------------------------------------------------------------------------

const BUF_PROPERTY_DEFS: PropertyDefinition[] = [
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
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// BufDefinition- StandaloneComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function bufFactory(props: PropertyBag): BufElement {
  return new BufElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const BufDefinition: StandaloneComponentDefinition = {
  name: "Buf",
  typeId: -1,
  factory: bufFactory,
  pinLayout: buildStandardPinDeclarations(1, 1, false),
  propertyDefs: BUF_PROPERTY_DEFS,
  attributeMap: BUF_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Buffer gate- non-inverting, passes the input signal unchanged to the output.\n" +
    "Useful for signal isolation or driving higher fan-out loads.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildBufNetlist,
      paramDefs: BUF_BEHAVIORAL_PARAM_DEFS,
      params: BUF_BEHAVIORAL_DEFAULTS,
    },
  },
  models: {
    digital: {
      executeFn: executeBuf,
      inputSchema: ["In_1"],
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
