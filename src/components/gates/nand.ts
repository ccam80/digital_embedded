/**
 * NAnd gate component.
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
import { makeNandAnalogFactory } from "../../solver/analog/behavioral-gate.js";
import {
  compWidth,
  buildInvertedPinDeclarations,
  appendPowerPins,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateLabel,
  drawGateExtensionLines,
  drawAndBody,
} from "./gate-shared.js";

// ---------------------------------------------------------------------------
// NAndElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class NAndElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("NAnd", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    let decls = buildInvertedPinDeclarations(inputCount, bitWidth, wideShape);
    const activeModel = this._properties.getOrDefault<string>("simulationModel", "");
    if (activeModel === "cmos") {
      const w = compWidth(wideShape);
      decls = appendPowerPins(decls, w / 2, -1, inputCount);
    }
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    const inputCount = this._properties.getOrDefault<number>("inputCount", 2);
    const wideShape = this._properties.getOrDefault<boolean>("wideShape", false);
    const { topBorder, bodyHeight } = gateBodyMetrics(inputCount);
    // Body polygon starts at x=0.05; bubble adds 1 to right extent.
    return {
      x: this.position.x + 0.05,
      y: this.position.y - topBorder,
      width: compWidth(wideShape) + 1 - 0.05,
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
    drawAndBody(ctx, w);
    if (offs > 0) ctx.restore();

    // Inversion bubble at output pin position (untranslated)
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawCircle(w + 0.5, outputY, BUBBLE_RADIUS, false);

    drawGateLabel(ctx, this._visibleLabel(), w);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// executeNAnd — flat simulation function
// ---------------------------------------------------------------------------

export function executeNAnd(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  const inputCount = layout.inputCount(index);
  const outputIdx = layout.outputOffset(index);
  const bitWidth = (layout.getProperty(index, "bitWidth") as number | undefined) ?? 1;
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;

  let result = 0xFFFFFFFF;
  for (let i = 0; i < inputCount; i++) {
    result = (result & state[wt[inputStart + i]]) >>> 0;
  }
  state[wt[outputIdx]] = ((~result) & mask) >>> 0;
}

// ---------------------------------------------------------------------------
// NAndDefinition
// ---------------------------------------------------------------------------

function nandFactory(props: PropertyBag): NAndElement {
  return new NAndElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const NAndDefinition: ComponentDefinition = {
  name: "NAnd",
  typeId: -1,
  factory: nandFactory,
  pinLayout: buildInvertedPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved with bubble) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "NAnd gate — performs bitwise NOT(AND) of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved with bubble) and IEC/DIN (rectangular with & and bubble) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  subcircuitRefs: { cmos: "CmosNand2" },
  models: {
    digital: {
      executeFn: executeNAnd,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
    mnaModels: {
      behavioral: {
      factory: makeNandAnalogFactory(0),
    },
      cmos: {
        subcircuitModel: "CmosNand2",
      },
    },
  },
  defaultModel: "digital",
};
