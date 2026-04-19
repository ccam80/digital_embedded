/**
 * DC Voltage Source — ideal independent voltage source for MNA simulation.
 *
 * Introduces one extra MNA branch row to enforce the voltage constraint.
 * Reads `ctx.srcFact` (ngspice CKTsrcFact) directly inside load() to apply
 * DC-OP source stepping — matches ngspice vsrcload.c:54 exactly.
 *
 * MNA stamp convention (1-based node IDs, solver uses 0-based):
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeNeg, k] -= 1    C[k, nodeNeg] -= 1
 *   RHS[k]        += V * srcFact
 *
 * where k is the absolute branch row index in the MNA matrix.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import { PinDirection, type Pin, type PinDeclaration, type Rotation } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DC_VOLTAGE_SOURCE_PARAM_DEFS, defaults: DC_VOLTAGE_SOURCE_DEFAULTS } = defineModelParams({
  primary: {
    voltage: { default: 5, unit: "V", description: "Source voltage in volts" },
  },
});

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
    const voltage = this._properties.getModelParam<number>("voltage");
    const label = this._visibleLabel();
    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Lead from neg pin (x=0) to negative plate
    drawColoredLead(ctx, signals, vNeg, 0, 0, 1.75, 0);

    // Lead from pos pin (x=4) to positive plate
    drawColoredLead(ctx, signals, vPos, 2.25, 0, 4, 0);

    // Body (plates) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Shorter plate at x=1.75
    ctx.drawLine(1.75, 0.625, 1.75, -0.625);

    // Longer plate at x=2.25
    ctx.drawLine(2.25, 1, 2.25, -1);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(voltage, "V") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1.25, { horizontal: "center", vertical: "top" });

    ctx.restore();
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
    kind: "signal",
  },
  {
    label: "pos",
    direction: PinDirection.INPUT,
    position: { x: 4, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DC_VOLTAGE_SOURCE_PROPERTY_DEFS: PropertyDefinition[] = [
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
  { xmlName: "Voltage", propertyKey: "voltage", convert: (v) => parseFloat(v), modelParam: true },
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
  const p: Record<string, number> = { voltage };

  return {
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const k = branchIdx;

      // B sub-matrix: node rows, branch column k
      if (nodePos !== 0) solver.stampElement(solver.allocElement(nodePos - 1, k), 1);
      if (nodeNeg !== 0) solver.stampElement(solver.allocElement(nodeNeg - 1, k), -1);

      // C sub-matrix: branch row k, node columns
      if (nodePos !== 0) solver.stampElement(solver.allocElement(k, nodePos - 1), 1);
      if (nodeNeg !== 0) solver.stampElement(solver.allocElement(k, nodeNeg - 1), -1);

      // RHS voltage constraint scaled by ctx.srcFact (CKTsrcFact) for DC source stepping.
      solver.stampRHS(k, p.voltage * ctx.srcFact);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // MNA branch variable: +I means current leaves nodePos through the branch.
      // Pin layout order: [neg, pos] — neg is index 0, pos is index 1.
      // "Into element at pos" = +I (current enters element at pos terminal).
      // "Into element at neg" = -I (current exits element at neg terminal).
      // Since pin 0 = neg and pin 1 = pos, return [-I, I].
      const I = voltages[branchIdx];
      return [-I, I];
    },
  };
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const DcVoltageSourceDefinition: ComponentDefinition = {
  name: "DcVoltageSource",
  typeId: -1,
  category: ComponentCategory.SOURCES,

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

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        const voltage = props.getModelParam<number>("voltage");
        return makeDcVoltageSource(pinNodes.get("pos")!, pinNodes.get("neg")!, branchIdx, voltage);
      },
      paramDefs: DC_VOLTAGE_SOURCE_PARAM_DEFS,
      params: DC_VOLTAGE_SOURCE_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
