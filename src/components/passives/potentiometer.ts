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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Minimum resistance clamp
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-9;

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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "W",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
    // post3 is at y = -offset = -1 (below axis), zigzag peak at y = +hs = +0.5
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 2,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Falstad PotElm: calcLeads(32px) on span (0,0)→(2,0), bodyLen=2gu=distance
    // → lead1=(0,0), lead2=(2,0). hs=8*PX=0.5
    const PX = 1 / 16;
    const hs = 8 * PX; // 0.5

    // Lead wires (zero-length since lead endpoints = pin endpoints)
    // Zigzag resistor body — 16 segments (non-euro PotElm)
    // nx cycles: 0→1→0→-1→0→1→... per i&3 switch
    const segments = 16;
    let ox = 0;
    for (let i = 0; i < segments; i++) {
      let nx = 0;
      switch (i & 3) {
        case 0: nx = 1; break;
        case 2: nx = -1; break;
        default: nx = 0; break;
      }
      // interpPointSingle(lead1, lead2, f, g) along horizontal (0,0)→(2,0):
      // result = (2*f, -g) since perpendicular to +x is -y
      const fromX = (i / segments) * 2;
      const fromY = -(hs * ox);
      const toX = ((i + 1) / segments) * 2;
      const toY = -(hs * nx);
      ctx.drawLine(fromX, fromY, toX, toY);
      ox = nx;
    }

    // Wiper: position=0.5 → midpoint of body axis
    // For horizontal (0,0)→(2,0), interpPointSingle perpendicular: y = -g
    // corner2 = interpPoint(pA, pB, 0.5) = (1, 0)
    // post3 = interpPointSingle(pA, pB, 0.5, offset=1) = (1, -1)
    // arrowPoint = interpPointSingle(pA, pB, 0.5, 8*PX) = (1, -0.5)
    const corner2X = 1;
    const corner2Y = 0;
    const post3X = 1;
    const post3Y = -1;
    const arrowPointX = 1;
    const arrowPointY = -(8 * PX); // -0.5

    // Wiper lines: post3 → corner2 → arrowPoint
    ctx.drawLine(post3X, post3Y, corner2X, corner2Y);
    ctx.drawLine(corner2X, corner2Y, arrowPointX, arrowPointY);

    // Arrow barbs: interpPoint2(corner2, arrowPoint, f=(clen-8*PX)/clen, g=8*PX)
    // clen = |offset| - 8*PX = 1 - 0.5 = 0.5
    // f = (0.5 - 0.5)/0.5 = 0 → at corner2
    // corner2→arrowPoint: dx=0, dy=-0.5, len=0.5
    // gx = (dy/len)*g = (-1)*0.5 = -0.5, gy = (-dx/len)*g = 0
    // arrow1 = (1-0.5, 0) = (0.5, 0), arrow2 = (1+0.5, 0) = (1.5, 0)
    ctx.drawLine(0.5, 0, arrowPointX, arrowPointY);
    ctx.drawLine(1.5, 0, arrowPointX, arrowPointY);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Potentiometer — voltage divider with 3 terminals (A, wiper, B).\n" +
      "Position determines the voltage division between top and bottom resistances."
    );
  }
}

// ---------------------------------------------------------------------------
// AnalogPotentiometerElement — MNA implementation
// ---------------------------------------------------------------------------

class AnalogPotentiometerElement implements AnalogElement {
  readonly nodeIndices: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = false;

  private readonly R: number;
  private readonly position: number;
  private G_top: number;
  private G_bottom: number;

  constructor(nodeIndices: number[], resistance: number, position: number) {
    this.nodeIndices = nodeIndices;
    this.R = resistance;
    this.position = Math.max(0, Math.min(1, position));

    const R_top = Math.max(this.R * this.position, MIN_RESISTANCE);
    const R_bottom = Math.max(this.R * (1 - this.position), MIN_RESISTANCE);
    this.G_top = 1 / R_top;
    this.G_bottom = 1 / R_bottom;
  }

  stamp(solver: SparseSolver): void {
    const n_A = this.nodeIndices[0]; // top
    const n_W = this.nodeIndices[1]; // wiper
    const n_B = this.nodeIndices[2]; // bottom

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
}

function createPotentiometerElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const R = props.getOrDefault<number>("resistance", 10000);
  const position = props.getOrDefault<number>("position", 0.5);
  return new AnalogPotentiometerElement(nodeIds, R, position);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const POTENTIOMETER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "resistance",
    type: PropertyType.INT,
    label: "Resistance (Ω)",
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
  engineType: "analog",
  factory: potentiometerCircuitFactory,
  executeFn: () => {},
  pinLayout: buildPotentiometerPinDeclarations(),
  propertyDefs: POTENTIOMETER_PROPERTY_DEFS,
  attributeMap: POTENTIOMETER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Potentiometer — voltage divider with 3 terminals (A, wiper, B).\n" +
    "Position determines the voltage division between top and bottom resistances.",
  analogFactory: createPotentiometerElement,
};
