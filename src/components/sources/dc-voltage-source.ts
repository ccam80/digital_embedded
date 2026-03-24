/**
 * DC Voltage Source — ideal independent voltage source for MNA simulation.
 *
 * Introduces one extra MNA branch row to enforce the voltage constraint.
 * Supports setSourceScale for DC operating point source-stepping.
 *
 * MNA stamp convention (1-based node IDs, solver uses 0-based):
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeNeg, k] -= 1    C[k, nodeNeg] -= 1
 *   RHS[k]        += V * scale
 *
 * where k is the absolute branch row index in the MNA matrix.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import { PinDirection, type Pin, type PinDeclaration, type Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import type { AnalogElement, AnalogElementCore } from "../../analog/element.js";

// ---------------------------------------------------------------------------
// DcVoltageSourceElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class DcVoltageSourceElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DcVoltageSource", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const decls = DC_VOLTAGE_SOURCE_PIN_LAYOUT;
    return this.derivePins(decls, []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const voltage = this._properties.getOrDefault<number>("voltage", 5);
    const label = this._properties.getOrDefault<string>("label", "");
    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to negative plate
    if (vNeg !== undefined) {
      ctx.setColor(signals!.voltageColor(vNeg));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 1.75, 0);

    // Lead from pos pin (x=4) to positive plate
    if (vPos !== undefined) {
      ctx.setColor(signals!.voltageColor(vPos));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(2.25, 0, 4, 0);

    // Body (plates) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Shorter plate at x=1.75
    ctx.drawLine(1.75, 0.625, 1.75, -0.625);

    // Longer plate at x=2.25
    ctx.drawLine(2.25, 1, 2.25, -1);

    // Value label below body
    const displayLabel = label.length > 0 ? label : formatSI(voltage, "V");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1.25, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return "Ideal DC voltage source. Introduces a branch current row in the MNA matrix.";
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_PIN_LAYOUT: PinDeclaration[] = [
  {
    label: "neg",
    direction: PinDirection.OUTPUT,
    position: { x: 0, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
  },
  {
    label: "pos",
    direction: PinDirection.INPUT,
    position: { x: 4, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "voltage",
    type: PropertyType.INT,
    label: "Voltage (V)",
    unit: "V",
    defaultValue: 5,
    description: "Source voltage in volts (V)",
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

const DC_VOLTAGE_SOURCE_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Voltage", propertyKey: "voltage", convert: (v) => parseFloat(v) },
  { xmlName: "Label",   propertyKey: "label",   convert: (v) => v },
];

// ---------------------------------------------------------------------------
// analogFactory helper (exported for tests)
// ---------------------------------------------------------------------------

export function makeDcVoltageSource(
  nodePos: number,
  nodeNeg: number,
  branchIdx: number,
  voltage: number,
): AnalogElementCore {
  let scale = 1;

  return {
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,

    setSourceScale(factor: number): void {
      scale = factor;
    },

    stamp(solver: SparseSolver): void {
      const k = branchIdx;

      // B sub-matrix: node rows, branch column k
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, k, -1);

      // C sub-matrix: branch row k, node columns
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeNeg !== 0) solver.stamp(k, nodeNeg - 1, -1);

      // RHS voltage constraint (scaled for source stepping)
      solver.stampRHS(k, voltage * scale);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Branch current I flows into nodePos (positive terminal).
      // Pin layout order: [neg, pos] — neg is index 0, pos is index 1.
      // Current into neg = +I (conventional current enters source at neg).
      // Current into pos = -I (current leaves element at positive terminal).
      const I = voltages[branchIdx];
      return [I, -I];
    },
  };
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const DcVoltageSourceDefinition: ComponentDefinition = {
  name: "DcVoltageSource",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.SOURCES,
  executeFn: noOpAnalogExecuteFn,
  requiresBranchRow: true,

  pinLayout: DC_VOLTAGE_SOURCE_PIN_LAYOUT,
  propertyDefs: DC_VOLTAGE_SOURCE_PROPERTY_DEFS,
  attributeMap: DC_VOLTAGE_SOURCE_ATTRIBUTE_MAP,

  helpText: "Ideal DC voltage source. Introduces a branch current row in the MNA matrix.",

  factory(props: PropertyBag): DcVoltageSourceElement {
    return new DcVoltageSourceElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  analogFactory(
    pinNodes: ReadonlyMap<string, number>,
    _internalNodeIds: readonly number[],
    branchIdx: number,
    props: PropertyBag,
  ): AnalogElementCore {
    const voltage = (props.has("voltage") ? props.get<number>("voltage") : 5) ?? 5;
    return makeDcVoltageSource(pinNodes.get("pos")!, pinNodes.get("neg")!, branchIdx, voltage);
  },
};
