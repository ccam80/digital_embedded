/**
 * XOr gate component.
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
  drawGateLabel,
  drawGateExtensionLines,
  drawXorBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as XOR_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// XOrElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class XOrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("XOr", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildStandardPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && XOrDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Back curve starts at x=0.0; body and stubs also start at x=0.0.
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
    drawXorBody(ctx, w);
    this._drawBodyStubs(ctx, inputCount);
    if (offs > 0) ctx.restore();

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }

  /**
   * Draw input wire stubs for pins adjacent to the body (in body-local coords).
   * XOR has longer stubs than OR because of the double-back gap.
   * Outer pins connect to extension lines instead.
   */
  private _drawBodyStubs(ctx: RenderContext, inputCount: number): void {
    const center = (inputCount & 1) !== 0;
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawLine(0, 0, 0.7, 0);
    ctx.drawLine(0, 2, 0.7, 2);
    if (center) ctx.drawLine(0, 1, 0.85, 1);
  }
}

// ---------------------------------------------------------------------------
// executeXOr- flat simulation function
// ---------------------------------------------------------------------------

export function executeXOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result ^ state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}

// ---------------------------------------------------------------------------
// CMOS_XOR2_NETLIST- 2-input CMOS XOR gate structural netlist
//
// Topology: standard CMOS XOR using transmission gates.
// Ports: In_1, In_2, out, VDD, GND
// Internal nets: In_1_bar (5), In_2_bar (6), mid (7)
// ---------------------------------------------------------------------------

const CMOS_XOR2_NETLIST: MnaSubcircuitNetlist = {
  ports: ["In_1", "In_2", "out", "VDD", "GND"],
  params: { WP: 20e-6, WN: 10e-6, L: 1e-6 },
  elements: [
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } }, // inv1_p: invert In_1
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } }, // inv1_n: invert In_1
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } }, // inv2_p: invert In_2
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } }, // inv2_n: invert In_2
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } }, // tg1_p: transmission gate 1 PMOS
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } }, // tg1_n: transmission gate 1 NMOS
    { typeId: "PMOS", branchCount: 0, params: { W: "WP", L: "L" } }, // tg2_p: transmission gate 2 PMOS
    { typeId: "NMOS", branchCount: 0, params: { W: "WN", L: "L" } }, // tg2_n: transmission gate 2 NMOS
  ],
  internalNetCount: 3,
  // Nets 0..4 = ports [In_1, In_2, out, VDD, GND]
  // Nets 5 = In_1_bar, 6 = In_2_bar, 7 = mid
  // PMOS/NMOS pins: [D, G, S]
  netlist: [
    [3, 0, 5], // inv1_p: D=VDD, G=In_1, S=In_1_bar
    [5, 0, 4], // inv1_n: D=In_1_bar, G=In_1, S=GND
    [3, 1, 6], // inv2_p: D=VDD, G=In_2, S=In_2_bar
    [6, 1, 4], // inv2_n: D=In_2_bar, G=In_2, S=GND
    [1, 5, 7], // tg1_p: D=In_2, G=In_1_bar, S=mid (pass In_2 when In_1=0)
    [1, 0, 7], // tg1_n: D=In_2, G=In_1, S=mid
    [6, 0, 7], // tg2_p: D=In_2_bar, G=In_1, S=mid (pass In_2_bar when In_1=1)
    [6, 5, 7], // tg2_n: D=In_2_bar, G=In_1_bar, S=mid
  ],
};

// ---------------------------------------------------------------------------
// Behavioural model parameter declarations
// ---------------------------------------------------------------------------
//
// inputCount: structural; per-instance N inputs. Defaults to 2 to match the
//   user-facing default and the CMOS_XOR2_NETLIST arity.
// loaded: when true, parent emits DigitalInputPinLoaded / DigitalOutputPinLoaded
//   sub-elements (gate inputs draw current; gate output drives via VSRC + R+C).
//   When false, parent emits the Unloaded variants (high-Z inputs, no VSRC
//   stamp on output- pure observability).
// vIH/vIL: per-input CMOS thresholds, consumed by the BehavioralXorDriver leaf.
// rOut/cOut/vOH/vOL: per-output drive params, consumed by the outPin sibling.

export const { paramDefs: XOR_BEHAVIORAL_PARAM_DEFS, defaults: XOR_BEHAVIORAL_DEFAULTS } = defineModelParams({
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
// buildXorGateNetlist- function-form netlist for the behavioural model
//
// Ports (variable count): in_1, in_2, ..., in_N, out, gnd
// Sub-elements:
//   drv     : BehavioralXorDriver  (1-bit pure-truth-function leaf, N inputs)
//   inPin_i : DigitalInputPin{Loaded|Unloaded}  (one per input port)
//   outPin  : DigitalOutputPin{Loaded|Unloaded}  (consumes drv OUTPUT_LOGIC_LEVEL)
// ---------------------------------------------------------------------------

export function buildXorGateNetlist(params: PropertyBag): MnaSubcircuitNetlist {
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
    typeId: "BehavioralXorDriver",
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
// XOrDefinition
// ---------------------------------------------------------------------------

function xorFactory(props: PropertyBag): XOrElement {
  return new XOrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const XOrDefinition: StandaloneComponentDefinition = {
  name: "XOr",
  typeId: -1,
  factory: xorFactory,
  pinLayout: buildStandardPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved with extra line) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "XOr gate- performs bitwise XOR of all inputs.\n" +
    "Configurable input count (2â€“5) and bit width (1â€“32).\n" +
    "Both IEEE/US (curved with extra line) and IEC/DIN (rectangular with =1) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    behavioral: {
      kind: "netlist",
      netlist: buildXorGateNetlist,
      paramDefs: XOR_BEHAVIORAL_PARAM_DEFS,
      params: XOR_BEHAVIORAL_DEFAULTS,
    },
    cmos: {
      kind: "netlist",
      netlist: CMOS_XOR2_NETLIST,
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
      executeFn: executeXOr,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
