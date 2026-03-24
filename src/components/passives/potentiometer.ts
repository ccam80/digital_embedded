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
      label: "B",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "W",
      defaultBitWidth: 1,
      position: { x: 2, y: -1 },
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
