/**
 * Variable Rail — user-adjustable DC voltage source.
 *
 * Designed for live parameter slider integration: changing the rail voltage
 * only requires updating the RHS of the MNA system (numeric re-factorization),
 * not a topology change. The source voltage is updated via setVoltage().
 *
 * Models internal resistance as a series resistor: the output node is the
 * junction between the ideal voltage source and the internal resistance,
 * which connects to the external load. This requires one internal MNA node.
 *
 * MNA stamp (voltage source portion — same as DC voltage source):
 *   B[nodePos, k] += 1    C[k, nodePos] += 1
 *   B[nodeInt, k] -= 1    C[k, nodeInt] -= 1
 *   RHS[k]        = V
 *
 * Resistor portion (internal node → output terminal):
 *   G[nodeInt, nodeInt] += 1/R_int
 *   G[nodeOut, nodeOut] += 1/R_int
 *   G[nodeInt, nodeOut] -= 1/R_int
 *   G[nodeOut, nodeInt] -= 1/R_int
 *
 * where nodeInt is an allocated internal node.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import { formatSI } from "../../editor/si-format.js";
import type { RenderContext, Rect, TextAnchor } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: VARIABLE_RAIL_PARAM_DEFS, defaults: VARIABLE_RAIL_DEFAULTS } = defineModelParams({
  primary: {
    voltage:    { default: 5,    unit: "V", description: "Output voltage in volts" },
    resistance: { default: 0.01, unit: "Ω", description: "Internal series resistance" },
  },
});

// ---------------------------------------------------------------------------
// VariableRailElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class VariableRailElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VariableRail", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(VARIABLE_RAIL_PIN_LAYOUT, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 3, height: 0 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vPos = signals?.getPinVoltage("pos");

    ctx.save();

    // Thick lead line from pin to body (Falstad: 0→47px = 0→2.9375 grid units)
    ctx.setLineWidth(2);
    drawColoredLead(ctx, signals, vPos, 0, 0, 2.9375, 0);

    // Voltage label at right side
    ctx.setColor("TEXT");
    ctx.setLineWidth(1);
    const voltage = this._properties.getModelParam<number>("voltage");
    const label = this._shouldShowValue() ? formatSI(voltage ?? 5, "V") : "";
    ctx.drawText(label, 4, 0, { horizontal: "left", vertical: "middle" } as TextAnchor);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const VARIABLE_RAIL_PIN_LAYOUT: PinDeclaration[] = [
  {
    label: "pos",
    direction: PinDirection.INPUT,
    position: { x: 0, y: 0 },
    defaultBitWidth: 1,
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VARIABLE_RAIL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "minVoltage",
    type: PropertyType.FLOAT,
    label: "Min Voltage (V)",
    unit: "V",
    defaultValue: 0,
    description: "Minimum slider voltage",
  },
  {
    key: "maxVoltage",
    type: PropertyType.FLOAT,
    label: "Max Voltage (V)",
    unit: "V",
    defaultValue: 30,
    description: "Maximum slider voltage",
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

const VARIABLE_RAIL_ATTRIBUTE_MAP: AttributeMapping[] = [
  { xmlName: "Voltage",    propertyKey: "voltage",    convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "MinVoltage", propertyKey: "minVoltage", convert: (v) => parseFloat(v) },
  { xmlName: "MaxVoltage", propertyKey: "maxVoltage", convert: (v) => parseFloat(v) },
  { xmlName: "Resistance", propertyKey: "resistance", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VariableRailAnalogElement — AnalogElement with mutable voltage
// ---------------------------------------------------------------------------

export interface VariableRailAnalogElement extends AnalogElementCore {
  /** Update the rail voltage. Takes effect from the next stamp() call. */
  setVoltage(v: number): void;
  /** Current rail voltage. */
  readonly currentVoltage: number;
  /** Live parameter mutation. */
  setParam(key: string, value: number): void;
}

export function makeVariableRailElement(
  nodePos: number,
  nodeNeg: number,
  nodeInt: number,
  branchIdx: number,
  initialVoltage: number,
  resistance: number,
): VariableRailAnalogElement {
  const p: Record<string, number> = { voltage: initialVoltage, resistance };

  const element: VariableRailAnalogElement = {
    branchIndex: branchIdx,
    isNonlinear: false,
    isReactive: false,

    get currentVoltage() { return p.voltage; },

    setVoltage(v: number): void {
      p.voltage = v;
    },

    setParam(key: string, value: number): void {
      if (key in p) (p as Record<string, number>)[key] = value;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Branch current = current delivered by the ideal voltage source (into pos terminal).
      return [voltages[branchIdx]];
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const k = branchIdx;
      const G = p.resistance > 0 ? 1 / p.resistance : 1e9;

      // Ideal voltage source: nodePos → nodeInt (internal node before R_int).
      // Variable rail is a user-facing interactive slider, not an ngspice
      // independent source: ctx.srcFact is deliberately ignored so slider
      // changes take effect immediately and are unaffected by DC-OP source
      // stepping. See VARIABLE_RAIL_PROPERTY_DEFS for the slider definition.
      if (nodePos !== 0) solver.stamp(nodePos - 1, k, 1);
      if (nodeInt !== 0) solver.stamp(nodeInt - 1, k, -1);
      if (nodePos !== 0) solver.stamp(k, nodePos - 1, 1);
      if (nodeInt !== 0) solver.stamp(k, nodeInt - 1, -1);
      solver.stampRHS(k, p.voltage);

      // Internal resistance: nodeInt → nodeNeg.
      if (nodeInt !== 0) solver.stamp(nodeInt - 1, nodeInt - 1, G);
      if (nodeNeg !== 0) solver.stamp(nodeNeg - 1, nodeNeg - 1, G);
      if (nodeInt !== 0 && nodeNeg !== 0) {
        solver.stamp(nodeInt - 1, nodeNeg - 1, -G);
        solver.stamp(nodeNeg - 1, nodeInt - 1, -G);
      }
    },
  };

  return element;
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const VariableRailDefinition: ComponentDefinition = {
  name: "VariableRail",
  typeId: -1,
  category: ComponentCategory.SOURCES,

  pinLayout: VARIABLE_RAIL_PIN_LAYOUT,
  propertyDefs: VARIABLE_RAIL_PROPERTY_DEFS,
  attributeMap: VARIABLE_RAIL_ATTRIBUTE_MAP,

  helpText: "Variable Rail — adjustable DC voltage source with internal resistance.",

  factory(props: PropertyBag): VariableRailElement {
    return new VariableRailElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory(
        pinNodes: ReadonlyMap<string, number>,
        internalNodeIds: readonly number[],
        branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        const voltage = props.getModelParam<number>("voltage");
        const resistance = props.getModelParam<number>("resistance");
        const nodePos = pinNodes.get("pos")!;
        const nodeNeg = 0;
        const nodeInt = internalNodeIds[0] ?? nodePos;
        return makeVariableRailElement(nodePos, nodeNeg, nodeInt, branchIdx, voltage, resistance);
      },
      paramDefs: VARIABLE_RAIL_PARAM_DEFS,
      params: VARIABLE_RAIL_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
