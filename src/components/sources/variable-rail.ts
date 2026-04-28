/**
 * Variable Rail  user-adjustable DC voltage source.
 *
 * Designed for live parameter slider integration: changing the rail voltage
 * only requires updating the RHS of the MNA system (numeric re-factorization),
 * not a topology change. The source voltage is updated via setParam("voltage", v).
 *
 * MNA stamp (port of vsrcset.c:52-55 / vsrcload.c):
 *   B[posNode, branch] += 1    B[negNode, branch] -= 1
 *   C[branch, negNode] -= 1    C[branch, posNode]  += 1
 *   RHS[branch]               = voltage
 *
 * negNode is permanently wired to ground (0) — variable rail has no neg pin.
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
import type { AnalogElement, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: VARIABLE_RAIL_PARAM_DEFS, defaults: VARIABLE_RAIL_DEFAULTS } = defineModelParams({
  primary: {
    voltage: { default: 5, unit: "V", description: "Output voltage in volts" },
  },
});

// ---------------------------------------------------------------------------
// VariableRailElement  CircuitElement implementation
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

    // Thick lead line from pin to body (Falstad: 047px = 02.9375 grid units)
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
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// VariableRailAnalogElement  AnalogElement with mutable voltage
// ---------------------------------------------------------------------------

export interface VariableRailAnalogElement extends AnalogElement {
  /** Update the rail voltage. Takes effect from the next stamp() call. */
  setVoltage(v: number): void;
  /** Current rail voltage. */
  readonly currentVoltage: number;
  /** Live parameter mutation. */
  setParam(key: string, value: number): void;
}

export function makeVariableRailElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): VariableRailAnalogElement {
  let _voltage = props.getModelParam<number>("voltage");

  // Cached handles — populated in setup(), consumed in load()
  let _hPosBr = -1;
  let _hNegBr = -1;
  let _hBrNeg = -1;
  let _hBrPos = -1;

  const element: VariableRailAnalogElement = {
    label: "",
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VSRC,
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(ctx: SetupContext): void {
      const posNode = element._pinNodes.get("pos")!;
      const negNode = 0;  // ground — variable rail has no neg pin

      // Port of vsrcset.c:40-43 — idempotent branch allocation
      if (element.branchIndex === -1) {
        element.branchIndex = ctx.makeCur(element.label, "branch");
      }
      const branchNode = element.branchIndex;

      // Port of vsrcset.c:52-55 — TSTALLOC sequence (line-for-line)
      _hPosBr = ctx.solver.allocElement(posNode,    branchNode); // VSRCposNode, VSRCbranch
      _hNegBr = ctx.solver.allocElement(negNode,    branchNode); // VSRCnegNode(=0), VSRCbranch
      _hBrNeg = ctx.solver.allocElement(branchNode, negNode);    // VSRCbranch,  VSRCnegNode(=0)
      _hBrPos = ctx.solver.allocElement(branchNode, posNode);    // VSRCbranch,  VSRCposNode
    },

    findBranchFor(_name: string, ctx: SetupContext): number {
      if (element.branchIndex === -1) {
        element.branchIndex = ctx.makeCur(element.label, "branch");
      }
      return element.branchIndex;
    },

    get currentVoltage() { return _voltage; },

    setVoltage(v: number): void {
      _voltage = v;
    },

    setParam(key: string, value: number): void {
      if (key === "voltage") _voltage = value;
    },

    getPinCurrents(rhs: Float64Array): number[] {
      // Branch current = current delivered by the ideal voltage source (into pos terminal).
      return [rhs[element.branchIndex]];
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;

      // vsrcload.c:43-46
      solver.stampElement(_hPosBr, +1.0);
      solver.stampElement(_hNegBr, -1.0);
      solver.stampElement(_hBrPos, +1.0);
      solver.stampElement(_hBrNeg, -1.0);
      // vsrcload.c:416 — RHS (DC value path: MODEDCOP | MODEDCTRANCURVE with dcGiven)
      ctx.rhs[element.branchIndex] += _voltage;
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

  helpText: "Variable Rail  adjustable DC voltage source.",

  factory(props: PropertyBag): VariableRailElement {
    return new VariableRailElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: makeVariableRailElement,
      paramDefs: VARIABLE_RAIL_PARAM_DEFS,
      params: VARIABLE_RAIL_DEFAULTS,
      ngspiceNodeMap: { pos: "pos" },
    },
  },
  defaultModel: "behavioral",
};
