/**
 * Or gate component.
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
  buildStandardPinDeclarations,
  appendPowerPins,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateExtensionLines,
  drawGateLabel,
  drawOrBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as OR_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// OrElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class OrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Or", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildStandardPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && OrDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Body polygon starts at x=0.0 (back curve and stubs); bbox matches drawn geometry.
    // The concave back arc extends to x=0.0, stubs draw from x=0. Min x = 0.
    return {
      x: this.position.x,
      y: this.position.y - topBorder,
      width: compWidth(wideShape),
      height: bodyHeight,
    };
  }

  draw(ctx: RenderContext): void {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const w = compWidth(wideShape);
    const offs = Math.floor(inputCount / 2) - 1;

    ctx.save();

    drawGateExtensionLines(ctx, inputCount);

    // Draw body translated to center position
    if (offs > 0) ctx.save();
    if (offs > 0) ctx.translate(0, offs);
    drawOrBody(ctx, w);
    this._drawBodyStubs(ctx, inputCount);
    if (offs > 0) ctx.restore();

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }

  /**
   * Draw short input wire stubs for pins adjacent to the body (in body-local
   * coordinates). Java IEEEOrShape draws stubs at y=0, y=2, and optionally y=1.
   * Outer pins connect to extension lines instead.
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
// executeOr- flat simulation function
// ---------------------------------------------------------------------------

export function executeOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result | state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}

// ---------------------------------------------------------------------------
// CMOS_OR2_NETLIST- 2-input CMOS OR gate structural netlist
//
// Topology: CMOS NOR2 driving a CMOS inverter.
// Ports: In_1, In_2, out, VDD, GND
// Internal net: nor_out (net index 5)
// ---------------------------------------------------------------------------

const CMOS_OR2_NETLIST: MnaSubcircuitNetlist = {
  ports: ["In_1", "In_2", "out", "VDD", "GND"],
  params: { WP: 20e-6, WN: 10e-6, L: 1e-6 },
  elements: [
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } },
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } },
  ],
  internalNetCount: 2,
  // Nets 0..4 = ports [In_1, In_2, out, VDD, GND], nets 5,6 = internal [nor_out, series_node]
  // NOR2: p1(D=VDD,G=In_1,S=series_node), p2(D=series_node,G=In_2,S=nor_out),
  //        n1(D=nor_out,G=In_1,S=GND), n2(D=nor_out,G=In_2,S=GND)
  // INV:   pInv(D=VDD,G=nor_out,S=out), nInv(D=out,G=nor_out,S=GND)
  // PMOS/NMOS pins: [D, G, S]
  netlist: [
    [3, 0, 6], // p1: D=VDD(3), G=In_1(0), S=series_node(6)
    [6, 1, 5], // p2: D=series_node(6), G=In_2(1), S=nor_out(5)
    [5, 0, 4], // n1: D=nor_out(5), G=In_1(0), S=GND(4)
    [5, 1, 4], // n2: D=nor_out(5), G=In_2(1), S=GND(4)
    [3, 5, 2], // pInv: D=VDD(3), G=nor_out(5), S=out(2)
    [2, 5, 4], // nInv: D=out(2), G=nor_out(5), S=GND(4)
  ],
};

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------
//
// inputCount: structural; per-instance N inputs. Defaults to 2 to match the
//   user-facing default and the CMOS_OR2_NETLIST arity.
// loaded: when true, parent emits DigitalInputPinLoaded / DigitalOutputPinLoaded
//   sub-elements (gate inputs draw current; gate output drives via VSRC + R+C).
//   When false, parent emits the Unloaded variants (high-Z inputs, no VSRC
//   stamp on output- pure observability).
// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralOrDriver leaf.
// rOut/cOut/vOH/vOL: per-output drive params, consumed by the outPin sibling.

export const { paramDefs: OR_BEHAVIORAL_PARAM_DEFS, defaults: OR_BEHAVIORAL_DEFAULTS } = defineModelParams({
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
// buildOrGateNetlist- function-form netlist for the behavioural model
//
// Ports (variable count): in_1, in_2, ..., in_N, out, gnd
// Sub-elements:
//   drv     : BehavioralOrDriver  (1-bit pure-truth-function leaf, N inputs)
//   inPin_i : DigitalInputPin{Loaded|Unloaded}  (one per input port)
//   outPin  : DigitalOutputPin{Loaded|Unloaded}  (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildOrGateNetlist(params: PropertyBag): MnaSubcircuitNetlist {
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
    typeId: "BehavioralOrDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      inputCount: N,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(driverPins);

  // Input pins- one per input port; pin labels match the driver's `In_${i+1}`
  // expectations on the same nets.
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: inputPinType,
      modelRef: "default",
      subElementName: `inPin_${i + 1}`,
    });
    netlist.push([i, gndIdx]);
  }

  // Output pin- siblingState consumes the driver's OUTPUT_LOGIC_LEVEL slot.
  // `kind: "siblingState" as const` narrows the literal so it satisfies the
  // SubcircuitElementParam discriminated union; without `as const` the kind
  // widens to `string` and "doesn't sufficiently overlap" any union arm.
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
// OrDefinition
// ---------------------------------------------------------------------------

function orFactory(props: PropertyBag): OrElement {
  return new OrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const OrDefinition: StandaloneComponentDefinition = {
  name: "Or",
  typeId: -1,
  factory: orFactory,
  pinLayout: buildStandardPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Or gate- performs bitwise OR of all inputs.\n" +
    "Configurable input count (2â€“5) and bit width (1â€“32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with â‰¥1) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildOrGateNetlist,
      paramDefs: OR_BEHAVIORAL_PARAM_DEFS,
      params: OR_BEHAVIORAL_DEFAULTS,
    },
    cmos: {
      kind: "netlist",
      netlist: CMOS_OR2_NETLIST,
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
      executeFn: executeOr,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
