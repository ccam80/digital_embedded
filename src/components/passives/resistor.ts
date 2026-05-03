/**
 * Resistor analog component.
 *
 * Stamps a conductance matrix: G = 1/R at four positions in the MNA matrix.
 * Two-terminal element with no branch variable (branchIndex = -1).
 * Two-terminal pins are labelled pos (positive terminal) and neg (negative terminal).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp  prevents G  âˆž for degenerate values
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: RESISTOR_PARAM_DEFS, defaults: RESISTOR_DEFAULTS } = defineModelParams({
  primary: {
    resistance: { default: 1000, unit: "Î", description: "Resistance in ohms. Minimum clamped to 1e-9 Î.", min: 1e-9 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildResistorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// ResistorElement  CircuitElement implementation
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
    const resistance = this._properties.getModelParam<number>("resistance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Lead wires  colored by their respective node voltages
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Zigzag body: 4 iterations producing 8 peaks + start/end
    const hs = 6 / 16; // 0.375 grid units
    const segLen = 2; // distance(lead1, lead2)
    const pts: Array<{ x: number; y: number }> = [{ x: 1, y: 0 }];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: 1 + ((1 + 4 * i) * segLen) / 16, y: hs });
      pts.push({ x: 1 + ((3 + 4 * i) * segLen) / 16, y: -hs });
    }
    pts.push({ x: 3, y: 0 });

    // Body gradient: interpolate voltage from vAvB along the zigzag
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
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(resistance, "Î") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText(displayLabel, 2, 0.75, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// ResistorAnalogElement- AnalogElement class implementation
// ---------------------------------------------------------------------------

class ResistorAnalogElement implements AnalogElement {
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  label: string = "";
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  private _resistance: number;
  private _G: number;

  // Cached element-pool handles allocated in setup() and consumed by
  // load() via solver.stampElement. Mirror ngspice RES instance pointers
  // RESposPosptr / RESnegNegptr / RESposNegptr / RESnegPosptr.
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(resistance: number) {
    this._resistance = Math.max(resistance, MIN_RESISTANCE);
    this._G = 1 / this._resistance;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;  // RESposNode
    const negNode = this._pinNodes.get("neg")!;  // RESnegNode

    // ressetup.c:46-49- TSTALLOC sequence, line-for-line.
    this._hPP = solver.allocElement(posNode, posNode);  // (RESposNode, RESposNode)
    this._hNN = solver.allocElement(negNode, negNode);  // (RESnegNode, RESnegNode)
    this._hPN = solver.allocElement(posNode, negNode);  // (RESposNode, RESnegNode)
    this._hNP = solver.allocElement(negNode, posNode);  // (RESnegNode, RESposNode)
  }

  setParam(key: string, value: number): void {
    if (key === "resistance") {
      this._resistance = Math.max(value, MIN_RESISTANCE);
      this._G = 1 / this._resistance;
    }
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    // resload.c:34-37- value-side stamps through cached handles.
    solver.stampElement(this._hPP, this._G);
    solver.stampElement(this._hNN, this._G);
    solver.stampElement(this._hPN, -this._G);
    solver.stampElement(this._hNP, -this._G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const n0 = this._pinNodes.get("pos")!;
    const n1 = this._pinNodes.get("neg")!;
    const vA = rhs[n0];
    const vB = rhs[n1];
    const I = this._G * (vA - vB);
    return [I, -I];
  }
}

function createResistorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const el = new ResistorAnalogElement(props.getModelParam<number>("resistance"));
  el._pinNodes = new Map(pinNodes);
  return el;
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const RESISTOR_PROPERTY_DEFS: PropertyDefinition[] = [
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
    modelParam: true,
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

export const ResistorDefinition: StandaloneComponentDefinition = {
  name: "Resistor",
  typeId: -1,
  factory: resistorCircuitFactory,
  pinLayout: buildResistorPinDeclarations(),
  propertyDefs: RESISTOR_PROPERTY_DEFS,
  attributeMap: RESISTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Resistor  stamps conductance G=1/R into the MNA matrix.\n" +
    "Minimum resistance is clamped to 1e-9 Î.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createResistorElement,
      paramDefs: RESISTOR_PARAM_DEFS,
      params: RESISTOR_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
