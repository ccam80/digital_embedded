/**
 * And gate component — the exemplar component.
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
import { PropertyBag } from "../../core/properties.js";
import {
  ComponentCategory,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
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
// AndElement — CircuitElement implementation
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
// executeAnd — flat simulation function (Decision 1)
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
// AndDefinition — ComponentDefinition for registry registration (Decision 4)
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
    "And gate — performs bitwise AND of all inputs.\n" +
    "Configurable input count (2–5) and bit width (1–32).\n" +
    "Both IEEE/US (curved) and IEC/DIN (rectangular with &) shapes are supported.\n" +
    "Individual inputs can be inverted via the inverterConfig property.",
  subcircuitRefs: { cmos: "CmosAnd2" },
  models: {
    digital: {
      executeFn: executeAnd,
      inputSchema: (props) => {
        const n = props.getOrDefault<number>("inputCount", 2);
        return Array.from({ length: n }, (_, i) => `In_${i + 1}`);
      },
      outputSchema: ["out"],
    },
    mnaModels: {
      behavioral: {
      factory: makeAndAnalogFactory(0),
    },
      cmos: {
        subcircuitModel: "CmosAnd2",
      },
    },
  },
  defaultModel: "digital",
};
