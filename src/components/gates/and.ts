/**
 * And gate component- the exemplar component.
 *
 * Establishes the exact pattern all subsequent components follow:
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
import { PropertyBag, PropertyType } from "../../core/properties.js";
import {
  ComponentCategory,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { MnaSubcircuitNetlist } from "../../core/mna-subcircuit-netlist.js";
import { makeAndAnalogFactory } from "../../solver/analog/behavioral-gate.js";
import {
  compWidth,
  buildStandardPinDeclarations,
  appendPowerPins,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateLabel,
  drawGateExtensionLines,
  drawAndBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as AND_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// AndElement- CircuitElement implementation
// ---------------------------------------------------------------------------

export class AndElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("And", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildStandardPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("model", "");
    if (activeModel && AndDefinition.modelRegistry?.[activeModel]) {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Body polygon starts at x=0.05 (left flat edge); bbox must match drawn geometry exactly.
    return {
      x: this.position.x + 0.05,
      y: this.position.y - topBorder,
      width: compWidth(wideShape) - 0.05,
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
    drawAndBody(ctx, w);
    if (offs > 0) ctx.restore();

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeAnd- flat simulation function (Decision 1)
//
// Called by the engine's inner loop via a function table indexed by typeId.
// Zero allocations. Reads N inputs from the state array, ANDs them together,
// writes the result to the output slot.
// ---------------------------------------------------------------------------

export function executeAnd(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);

  let result = 0xFFFFFFFF;
  for (let i = 0; i < inputCount; i++) {
    result = (result & state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = result;
}


// ---------------------------------------------------------------------------
// CMOS_AND2_NETLIST- 2-input CMOS AND gate structural netlist
//
// Topology: CMOS NAND2 driving a CMOS inverter.
// Ports: In_1, In_2, out, VDD, GND
// Internal nets: nand_out (net index 5)
// ---------------------------------------------------------------------------

const CMOS_AND2_NETLIST: MnaSubcircuitNetlist = {
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
  // Nets 0..4 = ports [In_1, In_2, out, VDD, GND], nets 5,6 = internal [nand_out, series_node]
  // NAND2: p1(D=VDD,G=In_1,S=nand_out), p2(D=VDD,G=In_2,S=nand_out),
  //        n1(D=nand_out,G=In_1,S=series_node), n2(D=series_node,G=In_2,S=GND)
  // INV:   pInv(D=VDD,G=nand_out,S=out), nInv(D=out,G=nand_out,S=GND)
  // PMOS pins: [D, G, S], NMOS pins: [D, G, S]
  netlist: [
    [3, 0, 5], // p1: D=VDD(3), G=In_1(0), S=nand_out(5)
    [3, 1, 5], // p2: D=VDD(3), G=In_2(1), S=nand_out(5)
    [5, 0, 6], // n1: D=nand_out(5), G=In_1(0), S=series_node(6)
    [6, 1, 4], // n2: D=series_node(6), G=In_2(1), S=GND(4)
    [3, 5, 2], // pInv: D=VDD(3), G=nand_out(5), S=out(2)
    [2, 5, 4], // nInv: D=out(2), G=nand_out(5), S=GND(4)
  ],
};

// ---------------------------------------------------------------------------
// AndDefinition- ComponentDefinition for registry registration (Decision 4)
//
// typeId: -1 signals to the registry that it should auto-assign a numeric ID.
// ---------------------------------------------------------------------------

function andFactory(props: PropertyBag): AndElement {
  return new AndElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const AndDefinition: ComponentDefinition = {
  name: "And",
  typeId: -1,
  factory: andFactory,
  pinLayout: buildStandardPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "And gate- performs bitwise AND of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with &) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: makeAndAnalogFactory(0),
      paramDefs: [],
      params: {},
    },
    cmos: {
      kind: "netlist",
      netlist: CMOS_AND2_NETLIST,
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
      executeFn: executeAnd,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
  },
  defaultModel: "digital",
};
