/**
 * Two-winding transformer component.
 *
 * Wraps a CoupledInductorPair to present a 4-terminal device:
 *   P1 (primary+), P2 (primary−), S1 (secondary+), S2 (secondary−)
 *
 * Derived parameters:
 *   L_secondary = L_primary · N²
 *   M = k · √(L_primary · L_secondary) = k · L_primary · N
 *
 * Each winding includes a series winding resistance for ohmic loss modelling.
 *
 * The MNA stamp follows the "pre-compute then stamp" pattern from inductor.ts:
 * stampCompanion() recomputes the companion coefficients and updates history
 * state; stamp() applies the stored coefficients to the solver.
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
import { CoupledInductorPair } from "../../solver/analog/coupled-inductor.js";
import type { CoupledInductorState } from "../../solver/analog/coupled-inductor.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSFORMER_PARAM_DEFS, defaults: TRANSFORMER_DEFAULTS } = defineModelParams({
  primary: {
    turnsRatio:          { default: 1.0,   description: "Secondary to primary turns ratio N (output/input)", min: 0.001 },
    primaryInductance:   { default: 10e-3, unit: "H", description: "Primary winding self-inductance in henries", min: 1e-12 },
    couplingCoefficient: { default: 0.99,  description: "Magnetic coupling coefficient (0 = no coupling, 1 = ideal)", min: 0, max: 1 },
  },
  secondary: {
    primaryResistance:   { default: 1.0,   unit: "Ω", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 1.0,   unit: "Ω", description: "Secondary winding series resistance in ohms", min: 0 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransformerPinDeclarations(): PinDeclaration[] {
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
      position: { x: 0, y: 2 },
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
      label: "S2",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransformerElement — CircuitElement (visual/editor representation)
// ---------------------------------------------------------------------------

export class TransformerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Transformer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransformerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Pins at y=0 and y=2 (grid units); bounding box spans full extent
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    // Falstad reference (64×32px bounding box, 16px = 1 grid unit):
    //   Two vertical coil columns: primary at x=21px, secondary at x=43px
    //   Each column has 3 arcs stacked vertically at cy=5.333, 16, 26.667px
    //   All arcs: start=3π/2 (top), end=5π/2 (bottom+wrap) — right-facing semicircles
    //   Vertical connecting lines at x=21 and x=43 between arc segments
    //   Core: two vertical lines at x=30 and x=34, y=0 to y=32
    //   Lead lines: (0,0)→(21,0), (0,32)→(21,32), (64,0)→(43,0), (64,32)→(43,32)

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const r = 5.333333 / 16; // arc radius in grid units
    const arcStart = (3 * Math.PI) / 2; // 4.71238898038469
    const arcEnd   = (5 * Math.PI) / 2; // 7.85398163397448

    // Lead lines — horizontal from pins to coil columns
    ctx.drawLine(0, 0, 21 / 16, 0);
    ctx.drawLine(4, 0, 43 / 16, 0);
    ctx.drawLine(0, 2, 21 / 16, 2);
    ctx.drawLine(4, 2, 43 / 16, 2);

    // Coil arc centers (cy) in grid units
    const coilCy = [5.333333 / 16, 16 / 16, 26.666667 / 16];
    // Vertical segment endpoints between arcs (top of col, between arcs, bottom of col)
    const segY = [0, 10.666667 / 16, 21.333333 / 16, 2];

    // Primary coil — vertical column at cx=21/16
    const priCx = 21 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(priCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(priCx, segY[i], priCx, segY[i + 1]);
    }

    // Secondary coil — vertical column at cx=43/16
    const secCx = 43 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(secCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(secCx, segY[i], secCx, segY[i + 1]);
    }

    // Iron core — two vertical parallel lines
    ctx.drawLine(30 / 16, 0, 30 / 16, 2);
    ctx.drawLine(34 / 16, 0, 34 / 16, 2);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogTransformerElement — MNA implementation
// ---------------------------------------------------------------------------

/**
 * MNA element for the two-winding transformer.
 *
 * Uses two consecutive branch rows: branch1 (primary) and branch1+1
 * (secondary). The element pre-computes companion coefficients in
 * stampCompanion() and applies them in stamp() — identical to the pattern
 * used by AnalogInductorElement in inductor.ts.
 *
 * Node layout (pinNodeIds array positions):
 *   [0] = P1 (primary+)   [1] = P2 (primary−)
 *   [2] = S1 (secondary+) [3] = S2 (secondary−)
 */
export class AnalogTransformerElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  setParam(_key: string, _value: number): void {}

  private _pair: CoupledInductorPair;
  private readonly _branch2: number;
  private _rPri: number;
  private _rSec: number;
  private _state: CoupledInductorState;

  // Pre-computed companion coefficients, updated in stampCompanion()
  private _g11: number = 0;
  private _g22: number = 0;
  private _g12: number = 0;
  private _hist1: number = 0;
  private _hist2: number = 0;

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
    this._branch2 = branch1 + 1;
    // turnsRatio = N_primary / N_secondary (e.g. 10 means 10:1 step-down)
    // L_secondary = L_primary / N² so that V_sec = V_pri / N for ideal coupling
    const lSecondary = lPrimary / (turnsRatio * turnsRatio);
    this._pair = new CoupledInductorPair(lPrimary, lSecondary, k);
    this._rPri = rPri;
    this._rSec = rSec;
    this._state = this._pair.createState();
  }

  updateDerivedParams(lPrimary: number, turnsRatio: number, k: number, rPri: number, rSec: number): void {
    const lSecondary = lPrimary / (turnsRatio * turnsRatio);
    this._pair = new CoupledInductorPair(lPrimary, lSecondary, k);
    this._rPri = rPri;
    this._rSec = rSec;
    this._state = this._pair.createState();
  }

  stamp(solver: SparseSolver): void {
    const [p1, p2, s1, s2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._branch2;

    // Primary winding resistance: series resistance modelled as a conductance
    // between P1 and P2 in the node block (Norton parallel equivalent).
    if (this._rPri > 0) {
      const gPri = 1 / this._rPri;
      if (p1 !== 0) solver.stamp(p1 - 1, p1 - 1, gPri);
      if (p2 !== 0) solver.stamp(p2 - 1, p2 - 1, gPri);
      if (p1 !== 0 && p2 !== 0) {
        solver.stamp(p1 - 1, p2 - 1, -gPri);
        solver.stamp(p2 - 1, p1 - 1, -gPri);
      }
    }

    // Secondary winding resistance: series resistance in node block.
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      if (s1 !== 0) solver.stamp(s1 - 1, s1 - 1, gSec);
      if (s2 !== 0) solver.stamp(s2 - 1, s2 - 1, gSec);
      if (s1 !== 0 && s2 !== 0) {
        solver.stamp(s1 - 1, s2 - 1, -gSec);
        solver.stamp(s2 - 1, s1 - 1, -gSec);
      }
    }

    // B sub-matrix: branch current incidence into KCL node equations.
    // Branch current I1 (primary) flows into P1 and out of P2.
    // Branch current I2 (secondary) flows into S1 and out of S2.
    if (p1 !== 0) solver.stamp(p1 - 1, b1, 1);
    if (p2 !== 0) solver.stamp(p2 - 1, b1, -1);
    if (s1 !== 0) solver.stamp(s1 - 1, b2, 1);
    if (s2 !== 0) solver.stamp(s2 - 1, b2, -1);

    // Branch rows (C sub-matrix).
    // Winding resistances appear as series terms in the branch equation
    // (added to the branch diagonal), providing the RL damping needed for
    // DC steady-state convergence with trapezoidal integration.
    //
    // Primary: V(P1) - V(P2) - (g11 + R_pri)·I1 - g12·I2 = hist1
    if (p1 !== 0) solver.stamp(b1, p1 - 1, 1);
    if (p2 !== 0) solver.stamp(b1, p2 - 1, -1);
    solver.stamp(b1, b1, -(this._g11 + this._rPri));
    solver.stamp(b1, b2, -this._g12);
    solver.stampRHS(b1, this._hist1);

    // Secondary: V(S1) - V(S2) - g12·I1 - (g22 + R_sec)·I2 = hist2
    if (s1 !== 0) solver.stamp(b2, s1 - 1, 1);
    if (s2 !== 0) solver.stamp(b2, s2 - 1, -1);
    solver.stamp(b2, b1, -this._g12);
    solver.stamp(b2, b2, -(this._g22 + this._rSec));
    solver.stampRHS(b2, this._hist2);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const [p1, p2, s1, s2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._branch2;

    const L1 = this._pair.l1;
    const L2 = this._pair.l2;
    const M = this._pair.m;

    // Read the accepted solution from the previous timestep.
    // These are the i(n) and v(n) values that enter the companion history terms.
    const i1Now = voltages[b1];
    const i2Now = voltages[b2];
    const vp1 = p1 > 0 ? voltages[p1 - 1] : 0;
    const vp2 = p2 > 0 ? voltages[p2 - 1] : 0;
    const vs1 = s1 > 0 ? voltages[s1 - 1] : 0;
    const vs2 = s2 > 0 ? voltages[s2 - 1] : 0;
    const v1Now = vp1 - vp2;
    const v2Now = vs1 - vs2;

    switch (method) {
      case "bdf1":
        this._g11 = L1 / dt;
        this._g22 = L2 / dt;
        this._g12 = M / dt;
        this._hist1 = -this._g11 * i1Now - this._g12 * i2Now;
        this._hist2 = -this._g22 * i2Now - this._g12 * i1Now;
        break;
      case "trapezoidal":
        this._g11 = (2 * L1) / dt;
        this._g22 = (2 * L2) / dt;
        this._g12 = (2 * M) / dt;
        this._hist1 = -this._g11 * i1Now - this._g12 * i2Now - v1Now;
        this._hist2 = -this._g22 * i2Now - this._g12 * i1Now - v2Now;
        break;
      case "bdf2": {
        this._g11 = (3 * L1) / (2 * dt);
        this._g22 = (3 * L2) / (2 * dt);
        this._g12 = (3 * M) / (2 * dt);
        const i1Hist =
          (4 / 3) * i1Now - (1 / 3) * (this._state.prevI1 ?? 0);
        const i2Hist =
          (4 / 3) * i2Now - (1 / 3) * (this._state.prevI2 ?? 0);
        this._hist1 = -this._g11 * i1Hist - this._g12 * i2Hist;
        this._hist2 = -this._g22 * i2Hist - this._g12 * i1Hist;
        break;
      }
    }

    // Update history state for next timestep (stores i(n) and v(n) for BDF-2).
    this._pair.updateState(dt, method, i1Now, i2Now, v1Now, v2Now, this._state);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const iPri = voltages[this.branchIndex];
    const iSec = voltages[this._branch2];
    // pinLayout order: P1, P2, S1, S2
    // Primary current enters at P1 (+) and exits at P2 (-)
    // Secondary current enters at S1 (+) and exits at S2 (-)
    return [iPri, -iPri, iSec, -iSec];
  }

  /** Second branch index (secondary winding current). */
  get branch2(): number {
    return this._branch2;
  }

  /** Mutual inductance for test access. */
  get mutualInductance(): number {
    return this._pair.m;
  }

  /** Primary inductance. */
  get primaryInductance(): number {
    return this._pair.l1;
  }

  /** Secondary inductance. */
  get secondaryInductance(): number {
    return this._pair.l2;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  branchIdx: number,
  primaryInductance: number,
  turnsRatio: number,
  couplingCoefficient: number,
  primaryResistance: number,
  secondaryResistance: number,
): AnalogElementCore {
  const p = { primaryInductance, turnsRatio, couplingCoefficient, primaryResistance, secondaryResistance };
  const el = new AnalogTransformerElement(
    [pinNodes.get("P1")!, pinNodes.get("P2")!, pinNodes.get("S1")!, pinNodes.get("S2")!],
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

function createTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  return buildTransformerElement(
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

const TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Secondary winding series resistance in ohms",
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

export const TRANSFORMER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
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
// TransformerDefinition
// ---------------------------------------------------------------------------

function transformerCircuitFactory(props: PropertyBag): TransformerElement {
  return new TransformerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TransformerDefinition: ComponentDefinition = {
  name: "Transformer",
  typeId: -1,
  factory: transformerCircuitFactory,
  pinLayout: buildTransformerPinDeclarations(),
  propertyDefs: TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Two-winding transformer using coupled inductor companion model.\n" +
    "Specify turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransformerElement,
      paramDefs: TRANSFORMER_PARAM_DEFS,
      params: TRANSFORMER_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
