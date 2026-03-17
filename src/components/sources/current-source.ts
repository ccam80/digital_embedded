/**
 * Current Source — ideal independent current source for MNA simulation.
 *
 * Stamps only into the RHS vector — no G-matrix entries required.
 * Supports setSourceScale for DC operating point source-stepping.
 *
 * MNA stamp convention (current I flows from nodeNeg to nodePos through source):
 *   RHS[nodePos] += I * scale   (current enters nodePos)
 *   RHS[nodeNeg] -= I * scale   (current leaves nodeNeg)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import type { AnalogElement } from "../../analog/element.js";

// ---------------------------------------------------------------------------
// CurrentSourceElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CurrentSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CurrentSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const decls = CURRENT_SOURCE_PIN_LAYOUT;
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 1,
      y: this.position.y - 2,
      width: 2,
      height: 4,
    };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    // Circle body: radius 1, centered at (0, 0)
    ctx.drawCircle(0, 0, 1, false);
    // Arrow indicating current direction (upward from neg to pos)
    ctx.drawLine(0, 0.7, 0, -0.7);
    ctx.drawLine(0, -0.7, -0.3, -0.3);
    ctx.drawLine(0, -0.7, 0.3, -0.3);
    // Label
    const label = this._properties.getOrDefault<string>("label", "");
    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.9 });
      ctx.drawText(label, 0, -1.4, { horizontal: "center", vertical: "bottom" });
    }
    ctx.restore();
  }

  getHelpText(): string {
    return "Ideal DC current source. Stamps only into the RHS vector — no matrix entries.";
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  { name: "pos", direction: "input",  position: { x: 0, y: -2 }, description: "Positive terminal (+)" },
  { name: "neg", direction: "output", position: { x: 0, y:  2 }, description: "Negative terminal (-)" },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "current",
    type: PropertyType.INT,
    label: "Current",
    defaultValue: 0.01,
    description: "Source current in amperes (A)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label",
  },
];

// ---------------------------------------------------------------------------
// Attribute map
// ---------------------------------------------------------------------------

const CURRENT_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Current", propertyKey: "current", convert: (v) => parseFloat(v) },
  { xmlName: "Label",   propertyKey: "label",   convert: (v) => v },
];

// ---------------------------------------------------------------------------
// analogFactory helper (exported for tests)
// ---------------------------------------------------------------------------

export function makeCurrentSource(
  nodePos: number,
  nodeNeg: number,
  current: number,
): AnalogElement {
  let scale = 1;

  return {
    nodeIndices: [nodePos, nodeNeg],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,

    setSourceScale(factor: number): void {
      scale = factor;
    },

    stamp(solver: SparseSolver): void {
      const I = current * scale;
      if (nodePos !== 0) solver.stampRHS(nodePos - 1, I);
      if (nodeNeg !== 0) solver.stampRHS(nodeNeg - 1, -I);
    },
  };
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const CurrentSourceDefinition: ComponentDefinition = {
  name: "CurrentSource",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.SOURCES,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: CURRENT_SOURCE_PIN_LAYOUT,
  propertyDefs: CURRENT_SOURCE_PROPERTY_DEFS,
  attributeMap: CURRENT_SOURCE_ATTRIBUTE_MAP,

  helpText: "Ideal DC current source. Stamps only into the RHS vector — no matrix entries.",

  factory(props: PropertyBag): CurrentSourceElement {
    return new CurrentSourceElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    const current = (props.has("current") ? props.get<number>("current") : 0.01) ?? 0.01;
    return makeCurrentSource(nodeIds[0], nodeIds[1], current);
  },
};
