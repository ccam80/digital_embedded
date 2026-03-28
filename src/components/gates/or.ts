/**
 * Or gate component.
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
import { makeOrAnalogFactory } from "../../solver/analog/behavioral-gate.js";
import {
  compWidth,
  buildStandardPinDeclarations,
  STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  buildStandardGatePropertyDefs,
  drawGateExtensionLines,
  drawGateLabel,
  drawOrBody,
} from "./gate-shared.js";

export { STANDARD_GATE_ATTRIBUTE_MAPPINGS as OR_ATTRIBUTE_MAPPINGS } from "./gate-shared.js";

// ---------------------------------------------------------------------------
// OrElement — CircuitElement implementation
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
    const decls = buildStandardPinDeclarations(inputCount, bitWidth, wideShape);
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
// executeOr — flat simulation function
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

export const OrDefinition: ComponentDefinition = {
  name: "Or",
  typeId: -1,
  factory: orFactory,
  pinLayout: buildStandardPinDeclarations(2, 1, false),
  propertyDefs: buildStandardGatePropertyDefs("Use IEEE/US (curved) shape instead of IEC/DIN (rectangular)"),
  attributeMap: STANDARD_GATE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.LOGIC,
  helpText:
    "Or gate — performs bitwise OR of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with ≥1) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  models: {
    digital: {
      executeFn: executeOr,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
    mnaModels: {
      behavioral: {
      factory: makeOrAnalogFactory(0),
    },
      cmos: {
        subcircuitModel: "CmosOr2",
      },
    },
  },
  defaultModel: "digital",
};
