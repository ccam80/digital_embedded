/**
 * NOr gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. StandaloneComponentDefinition for registry registration
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, Rotation } from "../../core/pin.js";
import { gateBodyMetrics } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import {
  ComponentCategory,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  compWidth,
  buildInvertedPinDeclarations,
  appendPowerPins,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateLabel,
  drawGateExtensionLines,
  drawOrBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as NOR_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// NOrElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class NOrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NOr", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildInvertedPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && NOrDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Body back arc starts at x=0.0; bubble adds 1 to right extent.
    return {
      x: this.position.x,
      y: this.position.y - topBorder,
      width: compWidth(wideShape) + 1,
      height: bodyHeight,
    };
  }

  draw(ctx: RenderContext): void {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const w = compWidth(wideShape);
    const offs = Math.floor(inputCount / 2) - 1;
    const outputY = Math.floor(inputCount / 2);
    const BUBBLE_RADIUS = 0.45;

    ctx.save();

    drawGateExtensionLines(ctx, inputCount);

    // Draw body translated to center position
    if (offs > 0) ctx.save();
    if (offs > 0) ctx.translate(0, offs);
    drawOrBody(ctx, w);
    this._drawBodyStubs(ctx, inputCount);
    if (offs > 0) ctx.restore();

    // Inversion bubble at output pin position (untranslated)
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(w + 0.5, outputY, BUBBLE_RADIUS, false);

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }

  /**
   * Draw short input wire stubs for pins adjacent to the body (in body-local
   * coordinates). Outer pins connect to extension lines instead.
   */
  private _drawBodyStubs(ctx: RenderContext, inputCount: number): void {
    const center = (inputCount & 1) !== 0;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawLine(0, 0, 0.2, 0);
    ctx.drawLine(0, 2, 0.2, 2);
    if (center) ctx.drawLine(0, 1, 0.35, 1);
  }
}

// ---------------------------------------------------------------------------
// executeNOr- flat simulation function
// ---------------------------------------------------------------------------

export function executeNOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);
  const bitWidth = (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result | state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = ((~result) & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// CMOS_NOR2_NETLIST- 2-input CMOS NOR gate structural netlist
//
// Topology: 2 PMOS in series (pull-up), 2 NMOS in parallel (pull-down).
// Ports: In_1, In_2, out, VDD, GND
// Internal net: series_node (net index 5)
// ---------------------------------------------------------------------------

const CMOS_NOR2_NETLIST: MnaSubcircuitNetlist = {
  ports: ["In_1", "In_2", "out", "VDD", "GND"],
  params: { WP: 20e-6, WN: 10e-6, L: 1e-6 },
  elements: [
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
  ],
  internalNetCount: 1,
  // Nets 0..4 = ports [In_1, In_2, out, VDD, GND], net 5 = series_node
  // p1(D=VDD,G=In_1,S=series_node), p2(D=series_node,G=In_2,S=out),
  // n1(D=out,G=In_1,S=GND), n2(D=out,G=In_2,S=GND)
  // PMOS/NMOS pins: [D, G, S]
  netlist: [
    [3, 0, 5], // p1: D=VDD(3), G=In_1(0), S=series_node(5)
    [5, 1, 2], // p2: D=series_node(5), G=In_2(1), S=out(2)
    [2, 0, 4], // n1: D=out(2), G=In_1(0), S=GND(4)
    [2, 1, 4], // n2: D=out(2), G=In_2(1), S=GND(4)
  ],
};

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: NOR_BEHAVIORAL_PARAM_DEFS, defaults: NOR_BEHAVIORAL_DEFAULTS } = defineModelParams({
  primary: {
    inputCount: { default: 2,     unit: "",  description: "Number of inputs (structural)" },
    loaded:     { default: 1,     unit: "",  description: "1 = loaded pins (DigitalInputPinLoaded / DigitalOutputPinLoaded), 0 = unloaded" },
    vIH:        { default: 2.0,   unit: "V", description: "Input high threshold (CMOS spec)" },
    vIL:        { default: 0.8,   unit: "V", description: "Input low threshold (CMOS spec)" },
    rOut:       { default: 100,   unit: "Ω", description: "Output drive resistance" },
    cOut:       { default: 1e-12, unit: "F", description: "Output companion capacitance" },
    vOH:        { default: 5.0,   unit: "V", description: "Output high voltage" },
    vOL:        { default: 0.0,   unit: "V", description: "Output low voltage" },
  },
});

// ---------------------------------------------------------------------------
// buildNorGateNetlist- function-form netlist for the behavioural model
//
// Ports (variable count): in_1, in_2, ..., in_N, out, gnd
// Sub-elements:
//   drv     : BehavioralNorDriver  (1-bit pure-truth-function leaf, N inputs)
//   inPin_i : DigitalInputPin{Loaded|Unloaded}  (one per input port)
//   outPin  : DigitalOutputPin{Loaded|Unloaded}  (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildNorGateNetlist(params: PropertyBag): MnaSubcircuitNetlist {
  const N        = params.getModelParam<number>("inputCount");
  const loaded   = params.getModelParam<number>("loaded") >= 0.5;
  const inputPinType  = loaded ? "DigitalInputPinLoaded"  : "DigitalInputPinUnloaded";
  const outputPinType = loaded ? "DigitalOutputPinLoaded" : "DigitalOutputPinUnloaded";

  const ports: string[] = [];
  for (let i = 0; i < N; i++) ports.push(`in_${i + 1}`);
  ports.push("out", "gnd");
  const outIdx = N;
  const gndIdx = N + 1;

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // Driver leaf- exposes OUTPUT_LOGIC_LEVEL via siblingState.
  const driverPins: number[] = [];
  for (let i = 0; i < N; i++) driverPins.push(i);
  driverPins.push(outIdx, gndIdx);
  elements.push({
    typeId: "BehavioralNorDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      inputCount: N,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(driverPins);

  // Input pins- one per input port.
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_${i + 1}`,
    });
    netlist.push([i, gndIdx]);
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
  netlist.push([outIdx, gndIdx]);

  return {
    ports,
    elements,
    internalNetCount: 0,
    netlist,
  };
}

// ---------------------------------------------------------------------------
// NOrDefinition
// ---------------------------------------------------------------------------

function norFactory(props: PropertyBag): NOrElement {
  return new NOrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const NOrDefinition: StandaloneComponentDefinition = {
  name: "NOr",
  typeId: -1,
  factory: norFactory,
  pinLayout: buildInvertedPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved with bubble) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "NOr gate- performs bitwise NOT(OR) of all inputs.\n" +
    "Configurable input count (2â€“5) and bit width (1â€“32).\n" +
    "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with â‰¥1 and bubble) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildNorGateNetlist,
      paramDefs: NOR_BEHAVIORAL_PARAM_DEFS,
      params: NOR_BEHAVIORAL_DEFAULTS,
    },
    cmos: {
      kind: "netlist",
      netlist: CMOS_NOR2_NETLIST,
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
      executeFn: executeNOr,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
