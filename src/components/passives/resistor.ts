/**
 * Resistor analog component.
 *
 * Stamps a conductance matrix: G = 1/R at four positions in the MNA matrix.
 * Two-terminal element with no branch variable (branchIndex = -1).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp — prevents G → ∞ for degenerate values
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildResistorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// ResistorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ResistorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Resistor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildResistorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.375,
      width: 4,
      height: 0.75,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const resistance = this._properties.getOrDefault<number>("resistance", 1000);
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Lead wires — colored by their respective node voltages
    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vA));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1, 0);

    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vB));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(3, 0, 4, 0);

    // Zigzag body: 4 iterations producing 8 peaks + start/end
    const hs = 6 / 16; // 0.375 grid units
    const segLen = 2; // distance(lead1, lead2)
    const pts: Array<{ x: number; y: number }> = [{ x: 1, y: 0 }];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: 1 + ((1 + 4 * i) * segLen) / 16, y: hs });
      pts.push({ x: 1 + ((3 + 4 * i) * segLen) / 16, y: -hs });
    }
    pts.push({ x: 3, y: 0 });

    // Body gradient: interpolate voltage from vA→vB along the zigzag
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(1, 0, 3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let i = 0; i < pts.length - 1; i++) {
      ctx.drawLine(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(resistance, "Ω") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(displayLabel, 2, 0.75, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Resistor — stamps conductance G=1/R into the MNA matrix.\n" +
      "Minimum resistance is clamped to 1e-9 Ω."
    );
  }
}

// ---------------------------------------------------------------------------
// createResistorElement — AnalogElement factory
// ---------------------------------------------------------------------------


function createResistorElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const rawR = props.getOrDefault<number>("resistance", 1000);
  const R = Math.max(rawR, MIN_RESISTANCE);
  const G = 1 / R;
  const n0 = pinNodes.get("A")!;
  const n1 = pinNodes.get("B")!;

  return {
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,

    stamp(solver: SparseSolver): void {
      stampG(solver, n0, n0, G);
      stampG(solver, n0, n1, -G);
      stampG(solver, n1, n0, -G);
      stampG(solver, n1, n1, G);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const vA = n0 > 0 ? voltages[n0 - 1] : 0;
      const vB = n1 > 0 ? voltages[n1 - 1] : 0;
      const I = G * (vA - vB);
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "resistance",
    type: PropertyType.FLOAT,
    label: "Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1000,
    min: 1e-9,
    description: "Resistance in ohms. Minimum clamped to 1e-9 Ω.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const RESISTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ResistorDefinition
// ---------------------------------------------------------------------------

function resistorCircuitFactory(props: PropertyBag): ResistorElement {
  return new ResistorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ResistorDefinition: ComponentDefinition = {
  name: "Resistor",
  typeId: -1,
  factory: resistorCircuitFactory,
  pinLayout: buildResistorPinDeclarations(),
  propertyDefs: RESISTOR_PROPERTY_DEFS,
  attributeMap: RESISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Resistor — stamps conductance G=1/R into the MNA matrix.\n" +
    "Minimum resistance is clamped to 1e-9 Ω.",
  models: {
    analog: {
      factory: createResistorElement,
    },
  },
};
