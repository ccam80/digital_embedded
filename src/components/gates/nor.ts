/**
 * NOr gate component.
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
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
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
// NOrElement — CircuitElement implementation
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
// executeNOr — flat simulation function
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
// CMOS_NOR2_NETLIST — 2-input CMOS NOR gate structural netlist
//
// Topology: 2 PMOS in series (pull-up), 2 NMOS in parallel (pull-down).
// Ports: In_1, In_2, out, VDD, GND
// Internal net: series_node (net index 5)
// ---------------------------------------------------------------------------

const CMOS_NOR2_NETLIST: MnaSubcircuitNetlist = {
  ports: ["In_1", "In_2", "out", "VDD", "GND"],
  params: {},
  elements: [
    { typeId: "PMOS", branchCount: 0 },
    { typeId: "PMOS", branchCount: 0 },
    { typeId: "NMOS", branchCount: 0 },
    { typeId: "NMOS", branchCount: 0 },
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

export const NOrDefinition: ComponentDefinition = {
  name: "NOr",
  typeId: -1,
  factory: norFactory,
  pinLayout: buildInvertedPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved with bubble) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "NOr gate — performs bitwise NOT(OR) of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with ≥1 and bubble) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    cmos: {
      kind: "netlist",
      netlist: CMOS_NOR2_NETLIST,
      paramDefs: [],
      params: {},
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
