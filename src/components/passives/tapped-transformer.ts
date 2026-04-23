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
import type { AnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { MODEDC, MODEINITPRED, MODEINITTRAN } from "../../solver/analog/ckt-mode.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";

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
// State-pool schema — 18 slots: 9 companion matrix coefficients + 3 current
// history + 3 flux linkage + 3 voltage history (indload.c:114-116 SLOT_VOLT)
// ---------------------------------------------------------------------------

// Slot layout — 18 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const TAPPED_TRANSFORMER_SCHEMA: StateSchema = defineStateSchema("AnalogTappedTransformerElement", [
  { name: "G11",   doc: "Primary self-conductance companion coefficient",          init: { kind: "zero" } },
  { name: "G22",   doc: "Secondary half-1 self-conductance companion coefficient", init: { kind: "zero" } },
  { name: "G33",   doc: "Secondary half-2 self-conductance companion coefficient", init: { kind: "zero" } },
  { name: "G12",   doc: "Primary–secondary half-1 mutual conductance",             init: { kind: "zero" } },
  { name: "G13",   doc: "Primary–secondary half-2 mutual conductance",             init: { kind: "zero" } },
  { name: "G23",   doc: "Secondary half-1 to half-2 mutual conductance",           init: { kind: "zero" } },
  { name: "HIST1", doc: "Primary winding history voltage term",                    init: { kind: "zero" } },
  { name: "HIST2", doc: "Secondary half-1 history voltage term",                   init: { kind: "zero" } },
  { name: "HIST3", doc: "Secondary half-2 history voltage term",                   init: { kind: "zero" } },
  { name: "I1",    doc: "Primary branch current this step",                        init: { kind: "zero" } },
  { name: "I2",    doc: "Secondary half-1 branch current this step",               init: { kind: "zero" } },
  { name: "I3",    doc: "Secondary half-2 branch current this step",               init: { kind: "zero" } },
  { name: "PHI1",  doc: "Total flux linkage winding 1 this step",                  init: { kind: "zero" } },
  { name: "PHI2",  doc: "Total flux linkage winding 2 this step",                  init: { kind: "zero" } },
  { name: "PHI3",  doc: "Total flux linkage winding 3 this step",                  init: { kind: "zero" } },
  // TT-W3-4: voltage-state slots per indload.c:114-116 (INDvolt history copy on MODEINITTRAN)
  { name: "VOLT1", doc: "Primary winding terminal voltage (indload.c:INDvolt winding 1)",     init: { kind: "zero" } },
  { name: "VOLT2", doc: "Secondary half-1 terminal voltage (indload.c:INDvolt winding 2)",   init: { kind: "zero" } },
  { name: "VOLT3", doc: "Secondary half-2 terminal voltage (indload.c:INDvolt winding 3)",   init: { kind: "zero" } },
]);

const SLOT_G11    = 0;
const SLOT_G22    = 1;
const SLOT_G33    = 2;
const SLOT_G12    = 3;
const SLOT_G13    = 4;
const SLOT_G23    = 5;
const SLOT_HIST1  = 6;
const SLOT_HIST2  = 7;
const SLOT_HIST3  = 8;
const SLOT_I1     = 9;
const SLOT_I2     = 10;
const SLOT_I3     = 11;
const SLOT_PHI1   = 12;
const SLOT_PHI2   = 13;
const SLOT_PHI3   = 14;
const SLOT_VOLT1  = 15;
const SLOT_VOLT2  = 16;
const SLOT_VOLT3  = 17;

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
export class AnalogTappedTransformerElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = TAPPED_TRANSFORMER_SCHEMA;
  readonly stateSize = TAPPED_TRANSFORMER_SCHEMA.size;
  stateBaseOffset = -1;
  // TT-W3-6: class-body setParam is intentionally a no-op. The real setParam is
  // wired by the buildTappedTransformerElement closure, which overrides this method
  // on the returned AnalogElementCore. Any consumer that constructs
  // AnalogTappedTransformerElement directly (bypassing buildTappedTransformerElement)
  // will get this no-op and hot-reload calls will silently drop. Always route
  // construction through buildTappedTransformerElement.
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

  private _pool!: StatePoolRef;

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

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(TAPPED_TRANSFORMER_SCHEMA, pool, this.stateBaseOffset, {});
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

  /**
   * Unified load() — three-winding tapped transformer.
   *
   * Mirrors ngspice indload.c INDload structure (two-pass per user ruling TT-W3-5):
   *   Pass 1 — self-loop (three inductors, indload.c:43-109):
   *     flux write, MODEINITPRED copy, NIintegrate per winding
   *   Pass 2 — mutual-loop (three MUT pairs, indload.c:65-75):
   *     mutual flux accumulation and mutual companion stamp
   *
   * indload.c:114-116 SLOT_VOLT copy on MODEINITTRAN done after pass 1+2.
   */
  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const [p1, p2, sec1, ct, sec2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._b2;
    const b3 = this._b3;

    // Winding resistances.
    if (this._rPri > 0) {
      const gPri = 1 / this._rPri;
      if (p1 !== 0) solver.stampElement(solver.allocElement(p1 - 1, p1 - 1), gPri);
      if (p2 !== 0) solver.stampElement(solver.allocElement(p2 - 1, p2 - 1), gPri);
      if (p1 !== 0 && p2 !== 0) {
        solver.stampElement(solver.allocElement(p1 - 1, p2 - 1), -gPri);
        solver.stampElement(solver.allocElement(p2 - 1, p1 - 1), -gPri);
      }
    }
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      // Sec half-1 (S1 ↔ CT)
      if (sec1 !== 0) solver.stampElement(solver.allocElement(sec1 - 1, sec1 - 1), gSec);
      if (ct !== 0) solver.stampElement(solver.allocElement(ct - 1, ct - 1), gSec);
      if (sec1 !== 0 && ct !== 0) {
        solver.stampElement(solver.allocElement(sec1 - 1, ct - 1), -gSec);
        solver.stampElement(solver.allocElement(ct - 1, sec1 - 1), -gSec);
      }
      // Sec half-2 (CT ↔ S2)
      if (ct !== 0) solver.stampElement(solver.allocElement(ct - 1, ct - 1), gSec);
      if (sec2 !== 0) solver.stampElement(solver.allocElement(sec2 - 1, sec2 - 1), gSec);
      if (ct !== 0 && sec2 !== 0) {
        solver.stampElement(solver.allocElement(ct - 1, sec2 - 1), -gSec);
        solver.stampElement(solver.allocElement(sec2 - 1, ct - 1), -gSec);
      }
    }

    // Branch incidence (B and C sub-matrices, topology-constant).
    if (p1 !== 0) solver.stampElement(solver.allocElement(p1 - 1, b1), 1);
    if (p2 !== 0) solver.stampElement(solver.allocElement(p2 - 1, b1), -1);
    if (sec1 !== 0) solver.stampElement(solver.allocElement(sec1 - 1, b2), 1);
    if (ct !== 0) solver.stampElement(solver.allocElement(ct - 1, b2), -1);
    if (ct !== 0) solver.stampElement(solver.allocElement(ct - 1, b3), 1);
    if (sec2 !== 0) solver.stampElement(solver.allocElement(sec2 - 1, b3), -1);

    if (p1 !== 0) solver.stampElement(solver.allocElement(b1, p1 - 1), 1);
    if (p2 !== 0) solver.stampElement(solver.allocElement(b1, p2 - 1), -1);
    if (sec1 !== 0) solver.stampElement(solver.allocElement(b2, sec1 - 1), 1);
    if (ct !== 0) solver.stampElement(solver.allocElement(b2, ct - 1), -1);
    if (ct !== 0) solver.stampElement(solver.allocElement(b3, ct - 1), 1);
    if (sec2 !== 0) solver.stampElement(solver.allocElement(b3, sec2 - 1), -1);

    const voltages = ctx.voltages;
    const i1Now = voltages[b1];
    const i2Now = voltages[b2];
    const i3Now = voltages[b3];
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const base = this.stateBaseOffset;
    const mode = ctx.cktMode;

    // -----------------------------------------------------------------------
    // Pass 1 — self-loop: three inductors, one per winding.
    // Mirrors indload.c:43-109 applied three times (b1/L1, b2/L2, b3/L3).
    //
    // TT-W3-5 (user ruling): two-pass structure matching ngspice indload.c.
    // TT-W3-3: integration gate is !(MODEDC) per indload.c:88, not MODETRAN.
    // TT-W3-2: MODEINITTRAN flux copy happens AFTER NIintegrate writes s0[PHI],
    //          matching indload.c:100-102 + 114-116 ordering.
    // -----------------------------------------------------------------------

    // indload.c:43-51 — flux-from-current write, gated !(MODEDC|MODEINITPRED).
    // TT-W3-5 pass-1 self-flux: each winding sees only its own current here;
    // mutual contributions are added in pass 2 below.
    if (!(mode & (MODEDC | MODEINITPRED))) {
      // cite: indload.c:48-49 — state0[INDflux] = INDinduct * rhsOld[INDbrEq]
      // (self-flux only; mutual accumulated in pass 2 per indload.c:65-67)
      s0[base + SLOT_PHI1] = this._l1 * i1Now;
      s0[base + SLOT_PHI2] = this._l2 * i2Now;
      s0[base + SLOT_PHI3] = this._l3 * i3Now;
    } else if (mode & MODEINITPRED) {
      // cite: indload.c:95-97 — MODEINITPRED: state0[INDflux] = state1[INDflux]
      s0[base + SLOT_PHI1] = s1[base + SLOT_PHI1];
      s0[base + SLOT_PHI2] = s1[base + SLOT_PHI2];
      s0[base + SLOT_PHI3] = s1[base + SLOT_PHI3];
    }

    // -----------------------------------------------------------------------
    // Pass 2 — mutual-loop: three MUT instances (12, 13, 23).
    // Mirrors indload.c:65-75 — accumulate mutual flux into state0[INDflux]
    // for each pair, then stamp off-diagonal companion conductance.
    // TT-W3-5: mutual flux += MUTfactor * rhsOld[partner_brEq]
    // -----------------------------------------------------------------------

    // cite: indload.c:65-67 — state0[ind1.INDflux] += MUTfactor * rhsOld[ind2.INDbrEq]
    //                          state0[ind2.INDflux] += MUTfactor * rhsOld[ind1.INDbrEq]
    if (!(mode & (MODEDC | MODEINITPRED))) {
      // Pair (1,2): M12
      s0[base + SLOT_PHI1] += this._m12 * i2Now;
      s0[base + SLOT_PHI2] += this._m12 * i1Now;
      // Pair (1,3): M13
      s0[base + SLOT_PHI1] += this._m13 * i3Now;
      s0[base + SLOT_PHI3] += this._m13 * i1Now;
      // Pair (2,3): M23
      s0[base + SLOT_PHI2] += this._m23 * i3Now;
      s0[base + SLOT_PHI3] += this._m23 * i2Now;
    }

    // -----------------------------------------------------------------------
    // Integration — self companion (req/veq) per winding.
    // TT-W3-3: gate is !(MODEDC) per indload.c:88, not MODETRAN.
    // TT-W3-2: MODEINITTRAN s1←s0 copy happens here AFTER flux is written,
    //          per indload.c:100-102 (copy before NIintegrate restores s1 first).
    // -----------------------------------------------------------------------

    let g11 = 0, g22 = 0, g33 = 0, g12 = 0, g13 = 0, g23 = 0;
    let hist1 = 0, hist2 = 0, hist3 = 0;

    if (!(mode & MODEDC)) {
      // cite: indload.c:94-102 — MODEINITPRED copies s1→s0 (already done above);
      //        else: MODEINITTRAN copies s0→s1 before NIintegrate
      if (mode & MODEINITTRAN) {
        // cite: indload.c:100-102 — state1[INDflux] = state0[INDflux] (copy after flux write)
        s1[base + SLOT_PHI1] = s0[base + SLOT_PHI1];
        s1[base + SLOT_PHI2] = s0[base + SLOT_PHI2];
        s1[base + SLOT_PHI3] = s0[base + SLOT_PHI3];
      }

      const ag = ctx.ag;
      const method = ctx.method;
      const order = ctx.order;

      // cite: indload.c:108 — NIintegrate(ckt, &req, &veq, INDinduct/m, INDflux)
      // Winding 1 (primary, L1)
      {
        const q0 = s0[base + SLOT_PHI1];
        const q1 = s1[base + SLOT_PHI1];
        const q2 = s2[base + SLOT_PHI1];
        const r1 = niIntegrate(method, order, this._l1, ag, q0, q1, [q2, 0, 0, 0, 0], 0);
        g11 = r1.geq;
        hist1 = r1.ceq;
      }
      // Winding 2 (secondary half-1, L2)
      {
        const q0 = s0[base + SLOT_PHI2];
        const q1 = s1[base + SLOT_PHI2];
        const q2 = s2[base + SLOT_PHI2];
        const r2 = niIntegrate(method, order, this._l2, ag, q0, q1, [q2, 0, 0, 0, 0], 0);
        g22 = r2.geq;
        hist2 = r2.ceq;
      }
      // Winding 3 (secondary half-2, L3)
      {
        const q0 = s0[base + SLOT_PHI3];
        const q1 = s1[base + SLOT_PHI3];
        const q2 = s2[base + SLOT_PHI3];
        const r3 = niIntegrate(method, order, this._l3, ag, q0, q1, [q2, 0, 0, 0, 0], 0);
        g33 = r3.geq;
        hist3 = r3.ceq;
      }

      // cite: indload.c:74-75 — mutual off-diagonal companion conductance:
      //   *(MUTbr1br2) -= MUTfactor * CKTag[0]
      //   *(MUTbr2br1) -= MUTfactor * CKTag[0]
      g12 = ag[0] * this._m12;
      g13 = ag[0] * this._m13;
      g23 = ag[0] * this._m23;
    }

    // cite: indload.c:119-123 — self diagonal: *(INDibrIbrptr) -= req
    // cite: indload.c:74-75   — mutual off-diagonal: *(MUTbr1br2) -= MUTfactor*ag[0]
    solver.stampElement(solver.allocElement(b1, b1), -g11);
    solver.stampElement(solver.allocElement(b1, b2), -g12);
    solver.stampElement(solver.allocElement(b1, b3), -g13);
    solver.stampElement(solver.allocElement(b2, b1), -g12);
    solver.stampElement(solver.allocElement(b2, b2), -g22);
    solver.stampElement(solver.allocElement(b2, b3), -g23);
    solver.stampElement(solver.allocElement(b3, b1), -g13);
    solver.stampElement(solver.allocElement(b3, b2), -g23);
    solver.stampElement(solver.allocElement(b3, b3), -g33);
    // cite: indload.c:112 — *(CKTrhs + INDbrEq) += veq
    solver.stampRHS(b1, hist1);
    solver.stampRHS(b2, hist2);
    solver.stampRHS(b3, hist3);

    // TT-W3-4: SLOT_VOLT — winding terminal voltage, copied s0→s1 on MODEINITTRAN.
    // cite: indload.c:114-116 — state1[INDvolt] = state0[INDvolt] on MODEINITTRAN.
    // Terminal voltages: V_winding = V_pos - V_neg for each winding.
    const vWind1 = (p1 !== 0 ? voltages[p1 - 1] : 0) - (p2 !== 0 ? voltages[p2 - 1] : 0);
    const vWind2 = (sec1 !== 0 ? voltages[sec1 - 1] : 0) - (ct !== 0 ? voltages[ct - 1] : 0);
    const vWind3 = (ct !== 0 ? voltages[ct - 1] : 0) - (sec2 !== 0 ? voltages[sec2 - 1] : 0);
    s0[base + SLOT_VOLT1] = vWind1;
    s0[base + SLOT_VOLT2] = vWind2;
    s0[base + SLOT_VOLT3] = vWind3;
    if (mode & MODEINITTRAN) {
      // cite: indload.c:115-116 — state1[INDvolt] = state0[INDvolt]
      s1[base + SLOT_VOLT1] = vWind1;
      s1[base + SLOT_VOLT2] = vWind2;
      s1[base + SLOT_VOLT3] = vWind3;
    }

    s0[base + SLOT_G11]   = g11;
    s0[base + SLOT_G22]   = g22;
    s0[base + SLOT_G33]   = g33;
    s0[base + SLOT_G12]   = g12;
    s0[base + SLOT_G13]   = g13;
    s0[base + SLOT_G23]   = g23;
    s0[base + SLOT_HIST1] = hist1;
    s0[base + SLOT_HIST2] = hist2;
    s0[base + SLOT_HIST3] = hist3;
    s0[base + SLOT_I1]    = i1Now;
    s0[base + SLOT_I2]    = i2Now;
    s0[base + SLOT_I3]    = i3Now;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const b = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    // All three windings are flux-based: pass 0,0 for ccap (inductor pattern)
    const dt1 = cktTerr(dt, deltaOld, order, method,
      s0[b + SLOT_PHI1], s1[b + SLOT_PHI1], s2[b + SLOT_PHI1], s3[b + SLOT_PHI1],
      0, 0, lteParams);
    const dt2 = cktTerr(dt, deltaOld, order, method,
      s0[b + SLOT_PHI2], s1[b + SLOT_PHI2], s2[b + SLOT_PHI2], s3[b + SLOT_PHI2],
      0, 0, lteParams);
    const dt3 = cktTerr(dt, deltaOld, order, method,
      s0[b + SLOT_PHI3], s1[b + SLOT_PHI3], s2[b + SLOT_PHI3], s3[b + SLOT_PHI3],
      0, 0, lteParams);
    return Math.min(dt1, dt2, dt3);
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
      branchCount: 3,  // TT-W3-1: three branch rows (b1=primary, b2=sec-half-1, b3=sec-half-2)
    },
  },
  defaultModel: "behavioral",
};
