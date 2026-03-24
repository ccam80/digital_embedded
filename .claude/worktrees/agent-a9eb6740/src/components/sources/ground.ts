/**
 * Analog Ground component.
 *
 * Topological marker only — the analog compiler maps any node connected to
 * this component to node 0 (the MNA ground reference). The AnalogElement
 * stamp is a no-op; the constraint is enforced by node assignment, not by
 * stamping into the matrix.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildAnalogGroundPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "gnd",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// AnalogGroundElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class AnalogGroundElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Ground", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildAnalogGroundPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x - 0.6,
      y: this.position.y,
      width: 1.2,
      height: 1.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vGnd = signals?.getPinVoltage("gnd");

    ctx.save();
    ctx.setLineWidth(1);

    // Vertical stem from pin (y=0) down to first bar — colored by pin voltage
    if (vGnd !== undefined) {
      ctx.setColor(signals!.voltageColor(vGnd));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 0, 0.5);

    // Three decreasing-width horizontal bars stay COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawLine(-0.6, 0.5, 0.6, 0.5);
    ctx.drawLine(-0.4, 0.75, 0.4, 0.75);
    ctx.drawLine(-0.2, 1.0, 0.2, 1.0);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Analog Ground — marks the connected node as the MNA ground reference (node 0).\n" +
      "The stamp is a no-op; the ground constraint is enforced by the compiler's node mapping."
    );
  }
}

// ---------------------------------------------------------------------------
// createAnalogGroundElement — AnalogElement factory (no-op stamp)
// ---------------------------------------------------------------------------

function createAnalogGroundElement(
  nodeIds: number[],
  _branchIdx: number,
  _props: PropertyBag,
): AnalogElement {
  const n0 = nodeIds[0];

  return {
    nodeIndices: [n0],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // Ground constraint is handled by the compiler's node mapping.
      // No stamp entries are needed.
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ANALOG_GROUND_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const ANALOG_GROUND_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// AnalogGroundDefinition
// ---------------------------------------------------------------------------

function analogGroundCircuitFactory(props: PropertyBag): AnalogGroundElement {
  return new AnalogGroundElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const AnalogGroundDefinition: ComponentDefinition = {
  name: "AnalogGround",
  typeId: -1,
  engineType: "analog",
  factory: analogGroundCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildAnalogGroundPinDeclarations(),
  propertyDefs: ANALOG_GROUND_PROPERTY_DEFS,
  attributeMap: ANALOG_GROUND_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SOURCES,
  helpText:
    "Analog Ground — marks the connected node as the MNA ground reference (node 0).\n" +
    "The stamp is a no-op; the ground constraint is enforced by the compiler's node mapping.",
  analogFactory: createAnalogGroundElement,
};
