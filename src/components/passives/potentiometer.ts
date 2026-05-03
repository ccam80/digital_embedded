/**
 * Potentiometer analog component.
 *
 * A three-terminal linear element modelled as two series resistors sharing a
 * common wiper node. The wiper position (0.0-1.0) determines the resistance split:
 *   R_top = R Ã— position
 *   R_bottom = R Ã— (1 - position)
 *
 * Both resistances are clamped to a minimum to prevent division by zero.
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: POTENTIOMETER_PARAM_DEFS, defaults: POTENTIOMETER_DEFAULTS } = defineModelParams({
  primary: {
    resistance: { default: 10000, unit: "Î©", description: "Total resistance in ohms", min: 1e-9 },
    position:   { default: 0.5,              description: "Wiper position (0.0 = full bottom, 1.0 = full top)", min: 0, max: 1 },
  },
});

// ---------------------------------------------------------------------------
// Inline geometry helpers (Falstad coordinate system)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPotentiometerPinDeclarations(): PinDeclaration[] {
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
    {
      direction: PinDirection.OUTPUT,
      label: "W",
      defaultBitWidth: 1,
      position: { x: 2, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// PotentiometerElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class PotentiometerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Potentiometer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildPotentiometerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Span is (0,0)(4,0) gu. Zigzag peak at y=+0.5 gu, wiper pin at y=-1 gu.
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 4,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Falstad PotElm: total span (0,0)(64,0) px = (0,0)(4,0) gu.
    // Lead wires: 0..16px and 48..64px = 0..1 gu and 3..4 gu.
    // Zigzag body: 16 segments spanning x=16..48 px = 1..3 gu, y peaks Â±8px = Â±0.5 gu.
    // Wiper pin W at (32,-16) px = (2,-1) gu.
    const PX = 1 / 16;
    const hs = 8 * PX; // 0.5 gu

    // Lead wires
    ctx.drawLine(0, 0, 1, 0);
    ctx.drawLine(3, 0, 4, 0);

    // Zigzag resistor body  16 segments spanning x=1..3 gu
    const segments = 16;
    let ox = 0;
    for (let i = 0; i < segments; i++) {
      let nx = 0;
      switch (i & 3) {
        case 0: nx = 1; break;
        case 2: nx = -1; break;
        default: nx = 0; break;
      }
      const fromX = 1 + (i / segments) * 2;
      const fromY = -(hs * ox);
      const toX = 1 + ((i + 1) / segments) * 2;
      const toY = -(hs * nx);
      ctx.drawLine(fromX, fromY, toX, toY);
      ox = nx;
    }

    // Wiper arrow (position=0.5, pin W at (2,-1) gu)
    // Falstad: (32,-16)(17,-16) px, (17,-16)(17,-8) px, barbs (25,-16)(17,-8) and (9,-16)(17,-8)
    const arrowX = 17 * PX;   // 17/16 gu
    const arrowY = -8 * PX;   // -0.5 gu (arrowpoint)
    const stemY = -1;          // -1 gu (wiper pin level)

    ctx.drawLine(2, stemY, arrowX, stemY);           // horizontal stem Warrowbase
    ctx.drawLine(arrowX, stemY, arrowX, arrowY);     // vertical to arrowpoint
    ctx.drawLine(25 * PX, stemY, arrowX, arrowY);   // right barb
    ctx.drawLine(9 * PX, stemY, arrowX, arrowY);    // left barb

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogPotentiometerElement  MNA implementation
// ---------------------------------------------------------------------------

class AnalogPotentiometerElement implements AnalogElement {
  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;

  private R: number;
  private pos: number;
  private G_AW: number;
  private G_WB: number;

  private _hAW_PP: number = -1;  private _hAW_NN: number = -1;
  private _hAW_PN: number = -1;  private _hAW_NP: number = -1;
  private _hWB_PP: number = -1;  private _hWB_NN: number = -1;
  private _hWB_PN: number = -1;  private _hWB_NP: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, resistance: number, position: number) {
    this._pinNodes = new Map(pinNodes);
    this.R = resistance;
    this.pos = Math.max(0, Math.min(1, position));

    const R_AW = Math.max(this.R * this.pos, MIN_RESISTANCE);
    const R_WB = Math.max(this.R * (1 - this.pos), MIN_RESISTANCE);
    this.G_AW = 1 / R_AW;
    this.G_WB = 1 / R_WB;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const aNode = this._pinNodes.get("pos")!;  // pos pin- R_AW posNode
    const wNode = this._pinNodes.get("W")!;    // W pin- shared wiper node
    const bNode = this._pinNodes.get("neg")!;  // neg pin- R_WB negNode

    // R_AW- ressetup.c:46-49 (A as posNode, W as negNode)
    this._hAW_PP = solver.allocElement(aNode, aNode);  // (RESposNode, RESposNode)
    this._hAW_NN = solver.allocElement(wNode, wNode);  // (RESnegNode, RESnegNode)
    this._hAW_PN = solver.allocElement(aNode, wNode);  // (RESposNode, RESnegNode)
    this._hAW_NP = solver.allocElement(wNode, aNode);  // (RESnegNode, RESposNode)

    // R_WB- ressetup.c:46-49 (W as posNode, B as negNode)
    this._hWB_PP = solver.allocElement(wNode, wNode);  // (RESposNode, RESposNode)
    this._hWB_NN = solver.allocElement(bNode, bNode);  // (RESnegNode, RESnegNode)
    this._hWB_PN = solver.allocElement(wNode, bNode);  // (RESposNode, RESnegNode)
    this._hWB_NP = solver.allocElement(bNode, wNode);  // (RESnegNode, RESposNode)
  }

  setParam(key: string, value: number): void {
    if (key === "resistance") this.R = value;
    else if (key === "position") this.pos = Math.max(0, Math.min(1, value));
    else return;
    const R_AW = Math.max(this.R * this.pos, MIN_RESISTANCE);
    const R_WB = Math.max(this.R * (1 - this.pos), MIN_RESISTANCE);
    this.G_AW = 1 / R_AW;
    this.G_WB = 1 / R_WB;
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;

    // R_AW stamps (resload.c: G at pos/pos, neg/neg, pos/neg, neg/pos)
    solver.stampElement(this._hAW_PP,  this.G_AW);
    solver.stampElement(this._hAW_NN,  this.G_AW);
    solver.stampElement(this._hAW_PN, -this.G_AW);
    solver.stampElement(this._hAW_NP, -this.G_AW);

    // R_WB stamps (resload.c: G at pos/pos, neg/neg, pos/neg, neg/pos)
    solver.stampElement(this._hWB_PP,  this.G_WB);
    solver.stampElement(this._hWB_NN,  this.G_WB);
    solver.stampElement(this._hWB_PN, -this.G_WB);
    solver.stampElement(this._hWB_NP, -this.G_WB);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const aNode = this._pinNodes.get("pos")!;  // pos pin
    const wNode = this._pinNodes.get("W")!;    // W (wiper) pin
    const bNode = this._pinNodes.get("neg")!;  // neg pin

    const vA = rhs[aNode];
    const vW = rhs[wNode];
    const vB = rhs[bNode];

    const i_A = this.G_AW * (vA - vW);
    const i_B = this.G_WB * (vB - vW);
    const i_W = -(i_A + i_B);

    return [i_A, i_W, i_B];
  }
}

function createPotentiometerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const R = props.getModelParam<number>("resistance");
  const position = props.getModelParam<number>("position");
  return new AnalogPotentiometerElement(pinNodes, R, position);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POTENTIOMETER_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const POTENTIOMETER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
    convert: (v) => parseFloat(v),
    modelParam: true,
  },
  {
    xmlName: "position",
    propertyKey: "position",
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
// PotentiometerDefinition
// ---------------------------------------------------------------------------

function potentiometerCircuitFactory(props: PropertyBag): PotentiometerElement {
  return new PotentiometerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const PotentiometerDefinition: StandaloneComponentDefinition = {
  name: "Potentiometer",
  typeId: -1,
  factory: potentiometerCircuitFactory,
  pinLayout: buildPotentiometerPinDeclarations(),
  propertyDefs: POTENTIOMETER_PROPERTY_DEFS,
  attributeMap: POTENTIOMETER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Potentiometer  voltage divider with 3 terminals (pos, wiper, neg).\n" +
    "Position determines the voltage division between top and bottom resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createPotentiometerElement,
      paramDefs: POTENTIOMETER_PARAM_DEFS,
      params: POTENTIOMETER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
