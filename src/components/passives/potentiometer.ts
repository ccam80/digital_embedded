/**
 * Potentiometer analog component.
 *
 * A three-terminal linear element modelled as two series resistors sharing a
 * common wiper node. The wiper position (0.0–1.0) determines the resistance split:
 *   R_top = R × position
 *   R_bottom = R × (1 - position)
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
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
    resistance: { default: 10000, unit: "Ω", description: "Total resistance in ohms", min: 1e-9 },
    position:   { default: 0.5,              description: "Wiper position (0.0 = full bottom, 1.0 = full top)", min: 0, max: 1 },
  },
});

// ---------------------------------------------------------------------------
// Inline geometry helpers (Falstad coordinate system)
// ---------------------------------------------------------------------------

const PX = 1 / 16;

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function calcLeads(
  p1: Point,
  p2: Point,
  bodyLen: number,
): { lead1: Point; lead2: Point } {
  const dn = distance(p1, p2);
  const f = (1 - bodyLen / dn) / 2;
  return {
    lead1: { x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f },
    lead2: { x: p1.x + (p2.x - p1.x) * (1 - f), y: p1.y + (p2.y - p1.y) * (1 - f) },
  };
}

function interpPoint(p1: Point, p2: Point, f: number): Point {
  return { x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f };
}

function interpPointSingle(p1: Point, p2: Point, f: number, g: number): Point {
  const dn = distance(p1, p2);
  const dx = (p2.x - p1.x) / dn;
  const dy = (p2.y - p1.y) / dn;
  return {
    x: p1.x + (p2.x - p1.x) * f + dy * g,
    y: p1.y + (p2.y - p1.y) * f - dx * g,
  };
}

function interpPoint2(
  p1: Point,
  p2: Point,
  f: number,
  g: number,
): [Point, Point] {
  const dn = distance(p1, p2);
  const dx = (p2.x - p1.x) / dn;
  const dy = (p2.y - p1.y) / dn;
  const bx = p1.x + (p2.x - p1.x) * f;
  const by = p1.y + (p2.y - p1.y) * f;
  return [
    { x: bx + dy * g, y: by - dx * g },
    { x: bx - dy * g, y: by + dx * g },
  ];
}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildPotentiometerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
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
// PotentiometerElement — CircuitElement implementation
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
    // Span is (0,0)→(4,0) gu. Zigzag peak at y=+0.5 gu, wiper pin at y=-1 gu.
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

    // Falstad PotElm: total span (0,0)→(64,0) px = (0,0)→(4,0) gu.
    // Lead wires: 0..16px and 48..64px = 0..1 gu and 3..4 gu.
    // Zigzag body: 16 segments spanning x=16..48 px = 1..3 gu, y peaks ±8px = ±0.5 gu.
    // Wiper pin W at (32,-16) px = (2,-1) gu.
    const PX = 1 / 16;
    const hs = 8 * PX; // 0.5 gu

    // Lead wires
    ctx.drawLine(0, 0, 1, 0);
    ctx.drawLine(3, 0, 4, 0);

    // Zigzag resistor body — 16 segments spanning x=1..3 gu
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
    // Falstad: (32,-16)→(17,-16) px, (17,-16)→(17,-8) px, barbs (25,-16)→(17,-8) and (9,-16)→(17,-8)
    const arrowX = 17 * PX;   // 17/16 gu
    const arrowY = -8 * PX;   // -0.5 gu (arrowpoint)
    const stemY = -1;          // -1 gu (wiper pin level)

    ctx.drawLine(2, stemY, arrowX, stemY);           // horizontal stem W→arrowbase
    ctx.drawLine(arrowX, stemY, arrowX, arrowY);     // vertical to arrowpoint
    ctx.drawLine(25 * PX, stemY, arrowX, arrowY);   // right barb
    ctx.drawLine(9 * PX, stemY, arrowX, arrowY);    // left barb

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogPotentiometerElement — MNA implementation
// ---------------------------------------------------------------------------

class AnalogPotentiometerElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  private R: number;
  private pos: number;
  private G_top: number;
  private G_bottom: number;

  constructor(pinNodeIds: number[], resistance: number, position: number) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.R = resistance;
    this.pos = Math.max(0, Math.min(1, position));

    const R_top = Math.max(this.R * this.pos, MIN_RESISTANCE);
    const R_bottom = Math.max(this.R * (1 - this.pos), MIN_RESISTANCE);
    this.G_top = 1 / R_top;
    this.G_bottom = 1 / R_bottom;
  }

  setParam(key: string, value: number): void {
    if (key === "resistance") this.R = value;
    else if (key === "position") this.pos = Math.max(0, Math.min(1, value));
    else return;
    const R_top = Math.max(this.R * this.pos, MIN_RESISTANCE);
    const R_bottom = Math.max(this.R * (1 - this.pos), MIN_RESISTANCE);
    this.G_top = 1 / R_top;
    this.G_bottom = 1 / R_bottom;
  }

  stamp(solver: SparseSolver): void {
    const n_A = this.pinNodeIds[0]; // top
    const n_W = this.pinNodeIds[1]; // wiper
    const n_B = this.pinNodeIds[2]; // bottom

    // Stamp helper: 1-based node IDs, skip ground (node 0), -1 for solver index
    const s = (r: number, c: number, v: number): void => {
      if (r !== 0 && c !== 0) solver.stamp(r - 1, c - 1, v);
    };

    // Top resistor (R_top) stamps: G_top at (A,A), (W,W), (A,W), (W,A)
    s(n_A, n_A, this.G_top);
    s(n_W, n_W, this.G_top);
    s(n_A, n_W, -this.G_top);
    s(n_W, n_A, -this.G_top);

    // Bottom resistor (R_bottom) stamps: G_bottom at (W,W), (B,B), (W,B), (B,W)
    s(n_W, n_W, this.G_bottom);
    s(n_B, n_B, this.G_bottom);
    s(n_W, n_B, -this.G_bottom);
    s(n_B, n_W, -this.G_bottom);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    // Factory passes nodes as [A, B, W] matching pinLayout order [A(0), B(1), W(2)].
    // Stamp variables: n_A=pinNodeIds[0] (A), n_W=pinNodeIds[1] (B pin node),
    // n_B=pinNodeIds[2] (W pin node) — the stamp variable names are inverted from
    // the constructor call, but the physics is consistent: top resistor between
    // pinNodeIds[0] and pinNodeIds[1], bottom between pinNodeIds[1] and pinNodeIds[2].
    //
    // Treat as: segment-top = pinNodeIds[0]↔pinNodeIds[1], segment-bottom = pinNodeIds[1]↔pinNodeIds[2].
    // pinLayout: [A, B, W] → must return [I_A, I_B, I_W].
    const n0 = this.pinNodeIds[0]; // A pin
    const n1 = this.pinNodeIds[1]; // middle node (stamp calls this n_W)
    const n2 = this.pinNodeIds[2]; // far end (stamp calls this n_B)

    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const v2 = n2 > 0 ? voltages[n2 - 1] : 0;

    // Current into pin at n0 through top resistor: G_top * (V_n0 - V_n1)
    const i0 = this.G_top * (v0 - v1);
    // Current into pin at n2 through bottom resistor: G_bottom * (V_n2 - V_n1)
    const i2 = this.G_bottom * (v2 - v1);
    // KCL at middle node n1: i1 = -(i0 + i2)
    const i1 = -(i0 + i2);

    // Return in pinLayout order [A, B, W] = [pinNodeIds[0], pinNodeIds[1], pinNodeIds[2]]
    // pinLayout[0]=A → i0, pinLayout[1]=B → i1 (middle), pinLayout[2]=W → i2
    return [i0, i1, i2];
  }
}

function createPotentiometerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const R = props.getOrDefault<number>("resistance", 10000);
  const position = props.getOrDefault<number>("position", 0.5);
  return new AnalogPotentiometerElement(
    [pinNodes.get("A")!, pinNodes.get("B")!, pinNodes.get("W")!],
    R,
    position,
  );
}

function createPotentiometerElementFromModelParams(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const R = props.getModelParam<number>("resistance");
  const position = props.getModelParam<number>("position");
  return new AnalogPotentiometerElement(
    [pinNodes.get("A")!, pinNodes.get("B")!, pinNodes.get("W")!],
    R,
    position,
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POTENTIOMETER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "resistance",
    type: PropertyType.FLOAT,
    label: "Resistance (Ω)",
    unit: "Ω",
    defaultValue: 10000,
    min: 1e-9,
    description: "Total resistance in ohms",
  },
  {
    key: "position",
    type: PropertyType.FLOAT,
    label: "Position",
    defaultValue: 0.5,
    min: 0,
    max: 1,
    description: "Wiper position (0.0 = full bottom, 1.0 = full top)",
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

export const POTENTIOMETER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "resistance",
    propertyKey: "resistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "position",
    propertyKey: "position",
    convert: (v) => parseFloat(v),
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

export const PotentiometerDefinition: ComponentDefinition = {
  name: "Potentiometer",
  typeId: -1,
  factory: potentiometerCircuitFactory,
  pinLayout: buildPotentiometerPinDeclarations(),
  propertyDefs: POTENTIOMETER_PROPERTY_DEFS,
  attributeMap: POTENTIOMETER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Potentiometer — voltage divider with 3 terminals (A, wiper, B).\n" +
    "Position determines the voltage division between top and bottom resistances.",
  models: {
    mnaModels: {
      behavioral: {
      factory: createPotentiometerElement,
    },
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createPotentiometerElementFromModelParams,
      paramDefs: POTENTIOMETER_PARAM_DEFS,
      params: POTENTIOMETER_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
