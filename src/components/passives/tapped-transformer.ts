/**
 * Three-winding (center-tapped) transformer component.
 *
 * Models a transformer with one primary winding and two secondary halves
 * that share a center-tap terminal. The center-tap is the junction between
 * the two secondary half-windings, providing a midpoint voltage reference.
 *
 * Pin layout (5 physical terminals):
 *   P1  — primary positive
 *   P2  — primary negative
 *   S1  — secondary half-1 positive (top end)
 *   CT  — center tap (shared: sec-half-1 negative = sec-half-2 positive)
 *   S2  — secondary half-2 negative (bottom end)
 *
 * Three branch variables:
 *   branch1 (branchIndex)     — primary winding current
 *   branch2 (branchIndex + 1) — secondary half-1 current (S1 → CT)
 *   branch3 (branchIndex + 2) — secondary half-2 current (CT → S2)
 *
 * Inductance relationships for turns ratio N (total secondary / primary):
 *   L2 = L3 = L1 × (N/2)²
 *   M12 = k × √(L1 × L2)
 *   M13 = k × √(L1 × L3)  (= M12 for symmetric halves)
 *   M23 = k × √(L2 × L3)  (= k × L2 for symmetric halves)
 *
 * The 3×3 MNA branch equations (trapezoidal):
 *   V1 = g11·I1 + g12·I2 + g13·I3 + hist1
 *   V2 = g12·I1 + g22·I2 + g23·I3 + hist2
 *   V3 = g13·I1 + g23·I2 + g33·I3 + hist3
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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TAPPED_TRANSFORMER_PARAM_DEFS, defaults: TAPPED_TRANSFORMER_DEFAULTS } = defineModelParams({
  primary: {
    turnsRatio:          { default: 2.0,   description: "Total secondary to primary turns ratio N (both halves combined)", min: 0.001 },
    primaryInductance:   { default: 10e-3, unit: "H", description: "Primary winding self-inductance in henries", min: 1e-12 },
    couplingCoefficient: { default: 0.99,  description: "Magnetic coupling coefficient (0 = no coupling, 1 = ideal)", min: 0, max: 1 },
  },
  secondary: {
    primaryResistance:   { default: 0.0,   unit: "Ω", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 0.0,   unit: "Ω", description: "Each secondary half winding series resistance in ohms", min: 0 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTappedTransformerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2",
      defaultBitWidth: 1,
      position: { x: 0, y: 4 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "CT",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S2",
      defaultBitWidth: 1,
      position: { x: 4, y: 4 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TappedTransformerElement — visual/editor representation
// ---------------------------------------------------------------------------

export class TappedTransformerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TappedTransformer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTappedTransformerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines: pin → coil edge
    ctx.drawLine(0, 0, 1.25, 0);      // P1 lead
    ctx.drawLine(0, 4, 1.25, 4);      // P2 lead
    ctx.drawLine(4, 0, 2.75, 0);      // S1 lead
    ctx.drawLine(4, 2, 2.75, 2);      // CT lead
    ctx.drawLine(4, 4, 2.75, 4);      // S2 lead

    // Primary coil: 6 right-facing arcs at x=1.25 (3π/2 to 5π/2) with vertical connectors
    const arcR = 5.333 / 16;
    for (let i = 0; i < 6; i++) {
      const cy = (i * 2 + 1) * arcR;
      ctx.drawArc(1.25, cy, arcR, 3 * Math.PI / 2, 5 * Math.PI / 2);
      ctx.drawLine(1.25, i * 2 * arcR, 1.25, (i + 1) * 2 * arcR);
    }

    // Secondary coil: 6 right-facing arcs at x=2.75 (3π/2 to 5π/2) with vertical connectors
    for (let i = 0; i < 6; i++) {
      const cy = (i * 2 + 1) * arcR;
      ctx.drawArc(2.75, cy, arcR, 3 * Math.PI / 2, 5 * Math.PI / 2);
      ctx.drawLine(2.75, i * 2 * arcR, 2.75, (i + 1) * 2 * arcR);
    }

    // Core lines (iron core between coils)
    ctx.drawLine(1.875, 0, 1.875, 4);
    ctx.drawLine(2.125, 0, 2.125, 4);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogTappedTransformerElement — MNA implementation
// ---------------------------------------------------------------------------

/**
 * MNA element for the three-winding center-tapped transformer.
 *
 * Uses three consecutive branch rows: branchIndex (primary), branchIndex+1
 * (secondary half-1), branchIndex+2 (secondary half-2).
 *
 * Node layout (pinNodeIds array positions):
 *   [0] = P1 (primary+)    [1] = P2 (primary-)
 *   [2] = S1 (sec-half-1+) [3] = CT (center tap)
 *   [4] = S2 (sec-half-2-)
 *
 * The 3×3 companion matrix coefficients are computed in stampCompanion() and
 * applied in stamp(), following the same "pre-compute then stamp" pattern as
 * AnalogTransformerElement.
 */
export class AnalogTappedTransformerElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private readonly _b2: number;
  private readonly _b3: number;
  private _rPri: number;
  private _rSec: number;

  // Inductances and mutual inductances
  private _l1: number;
  private _l2: number;
  private _l3: number;
  private _m12: number;
  private _m13: number;
  private _m23: number;

  // Pre-computed companion coefficients, updated in stampCompanion()
  private _g11: number = 0;
  private _g22: number = 0;
  private _g33: number = 0;
  private _g12: number = 0;
  private _g13: number = 0;
  private _g23: number = 0;
  private _hist1: number = 0;
  private _hist2: number = 0;
  private _hist3: number = 0;

  // Previous accepted currents and voltages for history terms
  private _prevI1: number = 0;
  private _prevI2: number = 0;
  private _prevI3: number = 0;

  constructor(
    pinNodeIds: number[],
    branch1: number,
    lPrimary: number,
    turnsRatio: number,
    k: number,
    rPri: number,
    rSec: number,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.branchIndex = branch1;
    this._b2 = branch1 + 1;
    this._b3 = branch1 + 2;
    this._rPri = rPri;
    this._rSec = rSec;

    // L2 = L3 = L1 × (N/2)² — each secondary half has half the total turns
    this._l1 = lPrimary;
    const halfRatio = turnsRatio / 2;
    this._l2 = lPrimary * halfRatio * halfRatio;
    this._l3 = lPrimary * halfRatio * halfRatio;

    this._m12 = k * Math.sqrt(this._l1 * this._l2);
    this._m13 = k * Math.sqrt(this._l1 * this._l3);
    this._m23 = k * Math.sqrt(this._l2 * this._l3);
  }

  updateDerivedParams(lPrimary: number, turnsRatio: number, k: number, rPri: number, rSec: number): void {
    this._rPri = rPri;
    this._rSec = rSec;
    this._l1 = lPrimary;
    const halfRatio = turnsRatio / 2;
    this._l2 = lPrimary * halfRatio * halfRatio;
    this._l3 = lPrimary * halfRatio * halfRatio;
    this._m12 = k * Math.sqrt(this._l1 * this._l2);
    this._m13 = k * Math.sqrt(this._l1 * this._l3);
    this._m23 = k * Math.sqrt(this._l2 * this._l3);
  }

  stamp(solver: SparseSolver): void {
    const [p1, p2, s1, ct, s2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._b2;
    const b3 = this._b3;

    // Primary winding resistance (Norton parallel between P1 and P2)
    if (this._rPri > 0) {
      const gPri = 1 / this._rPri;
      if (p1 !== 0) solver.stamp(p1 - 1, p1 - 1, gPri);
      if (p2 !== 0) solver.stamp(p2 - 1, p2 - 1, gPri);
      if (p1 !== 0 && p2 !== 0) {
        solver.stamp(p1 - 1, p2 - 1, -gPri);
        solver.stamp(p2 - 1, p1 - 1, -gPri);
      }
    }

    // Secondary half-1 winding resistance (between S1 and CT)
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      if (s1 !== 0) solver.stamp(s1 - 1, s1 - 1, gSec);
      if (ct !== 0) solver.stamp(ct - 1, ct - 1, gSec);
      if (s1 !== 0 && ct !== 0) {
        solver.stamp(s1 - 1, ct - 1, -gSec);
        solver.stamp(ct - 1, s1 - 1, -gSec);
      }
    }

    // Secondary half-2 winding resistance (between CT and S2)
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      if (ct !== 0) solver.stamp(ct - 1, ct - 1, gSec);
      if (s2 !== 0) solver.stamp(s2 - 1, s2 - 1, gSec);
      if (ct !== 0 && s2 !== 0) {
        solver.stamp(ct - 1, s2 - 1, -gSec);
        solver.stamp(s2 - 1, ct - 1, -gSec);
      }
    }

    // B sub-matrix: branch current incidence into KCL node equations.
    // I1 (primary) flows into P1, out of P2.
    // I2 (sec-half-1) flows into S1, out of CT.
    // I3 (sec-half-2) flows into CT, out of S2.
    if (p1 !== 0) solver.stamp(p1 - 1, b1, 1);
    if (p2 !== 0) solver.stamp(p2 - 1, b1, -1);
    if (s1 !== 0) solver.stamp(s1 - 1, b2, 1);
    if (ct !== 0) solver.stamp(ct - 1, b2, -1);
    if (ct !== 0) solver.stamp(ct - 1, b3, 1);
    if (s2 !== 0) solver.stamp(s2 - 1, b3, -1);

    // Branch rows (C sub-matrix + RHS).
    // Primary:     V(P1) - V(P2) - (g11 + R_pri)·I1 - g12·I2 - g13·I3 = hist1
    if (p1 !== 0) solver.stamp(b1, p1 - 1, 1);
    if (p2 !== 0) solver.stamp(b1, p2 - 1, -1);
    solver.stamp(b1, b1, -(this._g11 + this._rPri));
    solver.stamp(b1, b2, -this._g12);
    solver.stamp(b1, b3, -this._g13);
    solver.stampRHS(b1, this._hist1);

    // Sec half-1: V(S1) - V(CT) - g12·I1 - (g22 + R_sec)·I2 - g23·I3 = hist2
    if (s1 !== 0) solver.stamp(b2, s1 - 1, 1);
    if (ct !== 0) solver.stamp(b2, ct - 1, -1);
    solver.stamp(b2, b1, -this._g12);
    solver.stamp(b2, b2, -(this._g22 + this._rSec));
    solver.stamp(b2, b3, -this._g23);
    solver.stampRHS(b2, this._hist2);

    // Sec half-2: V(CT) - V(S2) - g13·I1 - g23·I2 - (g33 + R_sec)·I3 = hist3
    if (ct !== 0) solver.stamp(b3, ct - 1, 1);
    if (s2 !== 0) solver.stamp(b3, s2 - 1, -1);
    solver.stamp(b3, b1, -this._g13);
    solver.stamp(b3, b2, -this._g23);
    solver.stamp(b3, b3, -(this._g33 + this._rSec));
    solver.stampRHS(b3, this._hist3);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const [p1, p2, s1, ct, s2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._b2;
    const b3 = this._b3;

    const i1Now = voltages[b1];
    const i2Now = voltages[b2];
    const i3Now = voltages[b3];
    const vp1 = p1 > 0 ? voltages[p1 - 1] : 0;
    const vp2 = p2 > 0 ? voltages[p2 - 1] : 0;
    const vs1 = s1 > 0 ? voltages[s1 - 1] : 0;
    const vct = ct > 0 ? voltages[ct - 1] : 0;
    const vs2 = s2 > 0 ? voltages[s2 - 1] : 0;
    const v1Now = vp1 - vp2;
    const v2Now = vs1 - vct;
    const v3Now = vct - vs2;

    switch (method) {
      case "bdf1":
        this._g11 = this._l1 / dt;
        this._g22 = this._l2 / dt;
        this._g33 = this._l3 / dt;
        this._g12 = this._m12 / dt;
        this._g13 = this._m13 / dt;
        this._g23 = this._m23 / dt;
        this._hist1 = -this._g11 * i1Now - this._g12 * i2Now - this._g13 * i3Now;
        this._hist2 = -this._g12 * i1Now - this._g22 * i2Now - this._g23 * i3Now;
        this._hist3 = -this._g13 * i1Now - this._g23 * i2Now - this._g33 * i3Now;
        break;
      case "trapezoidal":
        this._g11 = (2 * this._l1) / dt;
        this._g22 = (2 * this._l2) / dt;
        this._g33 = (2 * this._l3) / dt;
        this._g12 = (2 * this._m12) / dt;
        this._g13 = (2 * this._m13) / dt;
        this._g23 = (2 * this._m23) / dt;
        this._hist1 =
          -this._g11 * i1Now - this._g12 * i2Now - this._g13 * i3Now - v1Now;
        this._hist2 =
          -this._g12 * i1Now - this._g22 * i2Now - this._g23 * i3Now - v2Now;
        this._hist3 =
          -this._g13 * i1Now - this._g23 * i2Now - this._g33 * i3Now - v3Now;
        break;
      case "bdf2": {
        this._g11 = (3 * this._l1) / (2 * dt);
        this._g22 = (3 * this._l2) / (2 * dt);
        this._g33 = (3 * this._l3) / (2 * dt);
        this._g12 = (3 * this._m12) / (2 * dt);
        this._g13 = (3 * this._m13) / (2 * dt);
        this._g23 = (3 * this._m23) / (2 * dt);
        const i1H = (4 / 3) * i1Now - (1 / 3) * this._prevI1;
        const i2H = (4 / 3) * i2Now - (1 / 3) * this._prevI2;
        const i3H = (4 / 3) * i3Now - (1 / 3) * this._prevI3;
        this._hist1 = -this._g11 * i1H - this._g12 * i2H - this._g13 * i3H;
        this._hist2 = -this._g12 * i1H - this._g22 * i2H - this._g23 * i3H;
        this._hist3 = -this._g13 * i1H - this._g23 * i2H - this._g33 * i3H;
        break;
      }
    }

    // Rotate history state
    this._prevI1 = i1Now;
    this._prevI2 = i2Now;
    this._prevI3 = i3Now;
    void v1Now; void v2Now; void v3Now; // _prevV fields removed (unused)
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const i1 = voltages[this.branchIndex]; // primary: P1→P2
    const i2 = voltages[this._b2];         // sec half-1: S1→CT
    const i3 = voltages[this._b3];         // sec half-2: CT→S2
    // pinLayout order: P1, P2, S1, CT, S2
    // CT: i2 exits (−i2) and i3 enters (+i3) → net = i3 − i2
    // Sum: i1 + (−i1) + i2 + (i3−i2) + (−i3) = 0 ✓
    return [i1, -i1, i2, i3 - i2, -i3];
  }

  /** Second branch index (secondary half-1 winding current). */
  get branch2(): number {
    return this._b2;
  }

  /** Third branch index (secondary half-2 winding current). */
  get branch3(): number {
    return this._b3;
  }

  /** Primary inductance. */
  get primaryInductance(): number {
    return this._l1;
  }

  /** Secondary half inductance (each half). */
  get secondaryHalfInductance(): number {
    return this._l2;
  }

  /** Mutual inductance between primary and each secondary half. */
  get mutualInductancePriSec(): number {
    return this._m12;
  }

  /** Mutual inductance between the two secondary halves. */
  get mutualInductanceSecSec(): number {
    return this._m23;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildTappedTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  branchIdx: number,
  primaryInductance: number,
  turnsRatio: number,
  couplingCoefficient: number,
  primaryResistance: number,
  secondaryResistance: number,
): AnalogElementCore {
  const p = { primaryInductance, turnsRatio, couplingCoefficient, primaryResistance, secondaryResistance };
  const el = new AnalogTappedTransformerElement(
    [pinNodes.get("P1")!, pinNodes.get("P2")!, pinNodes.get("S1")!, pinNodes.get("CT")!, pinNodes.get("S2")!],
    branchIdx,
    p.primaryInductance,
    p.turnsRatio,
    p.couplingCoefficient,
    p.primaryResistance,
    p.secondaryResistance,
  );
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      el.updateDerivedParams(
        p.primaryInductance,
        p.turnsRatio,
        p.couplingCoefficient,
        p.primaryResistance,
        p.secondaryResistance,
      );
    }
  };
  return el;
}

function createTappedTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  return buildTappedTransformerElement(
    pinNodes,
    branchIdx,
    props.getModelParam<number>("primaryInductance"),
    props.getModelParam<number>("turnsRatio"),
    props.getModelParam<number>("couplingCoefficient"),
    props.getModelParam<number>("primaryResistance"),
    props.getModelParam<number>("secondaryResistance"),
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TAPPED_TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 0.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance per Half (Ω)",
    unit: "Ω",
    defaultValue: 0.0,
    min: 0,
    description: "Each secondary half winding series resistance in ohms",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "turnsRatio", propertyKey: "turnsRatio", modelParam: true, convert: (v) => parseFloat(v) },
  {
    xmlName: "primaryInductance",
    propertyKey: "primaryInductance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "couplingCoefficient",
    propertyKey: "couplingCoefficient",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "primaryResistance",
    propertyKey: "primaryResistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "secondaryResistance",
    propertyKey: "secondaryResistance",
    convert: (v) => parseFloat(v),
  },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TappedTransformerDefinition
// ---------------------------------------------------------------------------

function tappedTransformerCircuitFactory(props: PropertyBag): TappedTransformerElement {
  return new TappedTransformerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TappedTransformerDefinition: ComponentDefinition = {
  name: "TappedTransformer",
  typeId: -1,
  factory: tappedTransformerCircuitFactory,
  pinLayout: buildTappedTransformerPinDeclarations(),
  propertyDefs: TAPPED_TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Center-tapped three-winding transformer using 3×3 coupled inductor companion model.\n" +
    "Specify total turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTappedTransformerElement,
      paramDefs: TAPPED_TRANSFORMER_PARAM_DEFS,
      params: TAPPED_TRANSFORMER_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
