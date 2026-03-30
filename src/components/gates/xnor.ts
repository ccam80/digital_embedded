/**
 * XNOr gate component.
 *
 * Follows the And gate exemplar pattern exactly:
 *   1. CircuitElement class (rendering, properties, pin declarations)
 *   2. Standalone flat executeFn (simulation, zero allocations)
 *   3. AttributeMapping[] for .dig XML parsing
 *   4. ComponentDefinition for registry registration
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, Rotation } from "../../core/pin.js";
import { gateBodyMetrics } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import {
  ComponentCategory,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { makeXnorAnalogFactory } from "../../solver/analog/behavioral-gate.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import {
  compWidth,
  buildInvertedPinDeclarations,
  appendPowerPins,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateLabel,
  drawGateExtensionLines,
  drawXorBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as XNOR_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// XNOrElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class XNOrElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("XNOr", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildInvertedPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && XNOrDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Back curve starts at x=0.0; bubble at w+0.5, r=0.45 → maxX = w+0.95+0.05=w+1.
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
    drawXorBody(ctx, w);
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
   * Draw input wire stubs for pins adjacent to the body (in body-local coords).
   * XOR has longer stubs than OR because of the double-back gap.
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
// executeXNOr — flat simulation function
// ---------------------------------------------------------------------------

export function executeXNOr(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0;
  for (let i = 0; i < inputCount; i++) {
    result = (result ^ state[wt[inputStart + i]]) >>> 0;
  }
  const bitWidth = (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  state[wt[outputIdx]] = ((~result) & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// CMOS_XNOR2_NETLIST — 2-input CMOS XNOR gate structural netlist
//
// Topology: CMOS XOR2 driving a CMOS inverter.
// Ports: In_1, In_2, out, VDD, GND
// Internal nets: In_1_bar (5), In_2_bar (6), xor_out (7)
// ---------------------------------------------------------------------------

const CMOS_XNOR2_NETLIST: MnaSubcircuitNetlist = {
  ports: ["In_1", "In_2", "out", "VDD", "GND"],
  params: {},
  elements: [
    { typeId: "PMOS", branchCount: 0 }, // inv1_p: invert In_1
    { typeId: "NMOS", branchCount: 0 }, // inv1_n: invert In_1
    { typeId: "PMOS", branchCount: 0 }, // inv2_p: invert In_2
    { typeId: "NMOS", branchCount: 0 }, // inv2_n: invert In_2
    { typeId: "PMOS", branchCount: 0 }, // tg1_p: transmission gate 1 PMOS
    { typeId: "NMOS", branchCount: 0 }, // tg1_n: transmission gate 1 NMOS
    { typeId: "PMOS", branchCount: 0 }, // tg2_p: transmission gate 2 PMOS
    { typeId: "NMOS", branchCount: 0 }, // tg2_n: transmission gate 2 NMOS
    { typeId: "PMOS", branchCount: 0 }, // inv_out_p: output inverter PMOS
    { typeId: "NMOS", branchCount: 0 }, // inv_out_n: output inverter NMOS
  ],
  internalNetCount: 3,
  // Nets 0..4 = ports [In_1, In_2, out, VDD, GND]
  // Nets 5 = In_1_bar, 6 = In_2_bar, 7 = xor_out
  // PMOS/NMOS pins: [D, G, S]
  netlist: [
    [3, 0, 5], // inv1_p: D=VDD, G=In_1, S=In_1_bar
    [5, 0, 4], // inv1_n: D=In_1_bar, G=In_1, S=GND
    [3, 1, 6], // inv2_p: D=VDD, G=In_2, S=In_2_bar
    [6, 1, 4], // inv2_n: D=In_2_bar, G=In_2, S=GND
    [1, 5, 7], // tg1_p: D=In_2, G=In_1_bar, S=xor_out
    [1, 0, 7], // tg1_n: D=In_2, G=In_1, S=xor_out
    [6, 0, 7], // tg2_p: D=In_2_bar, G=In_1, S=xor_out
    [6, 5, 7], // tg2_n: D=In_2_bar, G=In_1_bar, S=xor_out
    [3, 7, 2], // inv_out_p: D=VDD, G=xor_out, S=out
    [2, 7, 4], // inv_out_n: D=out, G=xor_out, S=GND
  ],
};

// ---------------------------------------------------------------------------
// XNOrDefinition
// ---------------------------------------------------------------------------

function xnorFactory(props: PropertyBag): XNOrElement {
  return new XNOrElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const XNOrDefinition: ComponentDefinition = {
  name: "XNOr",
  typeId: -1,
  factory: xnorFactory,
  pinLayout: buildInvertedPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved with bubble) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "XNOr gate — performs bitwise NOT(XOR) of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with =1 and bubble) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    cmos: {
      kind: "netlist",
      netlist: CMOS_XNOR2_NETLIST,
      paramDefs: [],
      params: {},
    },
  },
  models: {
    digital: {
      executeFn: executeXNOr,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
    mnaModels: {
      behavioral: {
      factory: makeXnorAnalogFactory(0),
    },
    },
  },
  defaultModel: "digital",
};
