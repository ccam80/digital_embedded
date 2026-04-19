/**
 * Lossy Transmission Line — lumped RLCG model.
 *
 * Models a transmission line as N cascaded RLCG segments. Each segment has:
 *   - Series resistance R_seg (conductor loss)
 *   - Series inductance L_seg (magnetic storage)
 *   - Shunt conductance G_seg (dielectric loss)
 *   - Shunt capacitance C_seg (electric storage)
 *
 * High-level user parameters (Z₀, τ, loss per metre, length, segment count N)
 * are converted to per-segment RLCG values at instantiation.
 *
 * Internal topology for N segments (segments 0..N-2 have a mid-node):
 *
 *   Port1 ─R─L─ junction[0] ─R─L─ junction[1] ─ ... ─R─L─ Port2
 *                   |                  |
 *                  G,C                G,C
 *                   |                  |
 *                  GND               GND
 *
 * Segments 0..N-2: inputNode → R → rlMid[k] → L → junction[k], shunt G+C at junction[k]
 * Segment N-1 (last): junction[N-2] → CombinedRL → Port2 (no shunt at Port2)
 *
 * Internal node allocation (matches getInternalNodeCount = 2*(N-1)):
 *   nodeIds[0]             = Port1 (external)
 *   nodeIds[1]             = Port2 (external)
 *   nodeIds[2..N]          = N-1 RL mid-nodes (rlMidNodes[0..N-2])
 *   nodeIds[N+1..2N-1]     = N-1 junction nodes (junctionNodes[0..N-2])
 *
 * Branch variables: N consecutive indices starting at firstBranchIdx (one per inductor).
 *
 * MNA stamp conventions:
 *   Inductor with nodes A, B, branch row k:
 *     B sub-matrix: G[A-1, k] += 1,  G[B-1, k] -= 1   (KCL: I_k flows A→B)
 *     C sub-matrix: G[k, A-1] += ..., G[k, B-1] -= ... (KVL + companion)
 *     D sub-matrix: G[k, k] -= geq
 *     RHS[k] += ieq
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
import type { AnalogElement, AnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { stampG } from "../../solver/analog/stamp-helpers.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import type { LteParams } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  CAP_COMPANION_SLOTS,
  L_COMPANION_SLOTS,
} from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CONDUCTANCE = 1e-12;
const SHORT_CIRCUIT_CONDUCTANCE = 1e9;

// ---------------------------------------------------------------------------
// State-pool schemas for reactive sub-elements
// ---------------------------------------------------------------------------

const SEGMENT_INDUCTOR_SCHEMA: StateSchema = defineStateSchema("SegmentInductorElement", [
  ...L_COMPANION_SLOTS,
  { name: "PHI",  doc: "Flux at current step",      init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current",          init: { kind: "zero" } },
]);

const SLOT_GEQ    = 0;
const SLOT_IEQ    = 1;
const SLOT_I_PREV = 2;
const SLOT_L_PHI  = 3;
const SLOT_L_CCAP = 4;

const SEGMENT_CAPACITOR_SCHEMA: StateSchema = defineStateSchema("SegmentCapacitorElement", [
  ...CAP_COMPANION_SLOTS,
  { name: "Q",    doc: "Charge at current step",    init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current",          init: { kind: "zero" } },
]);

// CAP slots reuse same offsets: GEQ=0, IEQ=1, V_PREV=2
const SLOT_V_PREV = 2;
const SLOT_C_Q    = 3;
const SLOT_C_CCAP = 4;

const COMBINED_RL_SCHEMA: StateSchema = defineStateSchema("CombinedRLElement", [
  ...L_COMPANION_SLOTS,
  { name: "PHI",  doc: "Flux at current step",      init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current",          init: { kind: "zero" } },
]);

const SLOT_RL_PHI  = 3;
const SLOT_RL_CCAP = 4;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSMISSION_LINE_PARAM_DEFS, defaults: TRANSMISSION_LINE_DEFAULTS } = defineModelParams({
  primary: {
    impedance:    { default: 50,    description: "Characteristic impedance Z\u2080 in ohms", min: 1 },
    delay:        { default: 1e-9,  unit: "s", description: "Total one-way propagation delay in seconds", min: 1e-15 },
  },
  secondary: {
    lossPerMeter: { default: 0,     description: "Conductor and dielectric loss in dB per metre", min: 0 },
    length:       { default: 1.0,   description: "Physical length of the transmission line in metres", min: 1e-6 },
    segments:     { default: 10,    description: "Number of lumped RLCG segments (more segments = more accurate, slower)", min: 2, max: 100 },
  },
});

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped), 1-based → 0-based solver index
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransmissionLinePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1b",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2b",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P1a",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2a",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransmissionLineCircuitElement — CircuitElement for rendering
// ---------------------------------------------------------------------------

export class TransmissionLineCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("TransmissionLine", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransmissionLinePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Falstad: fillRect(0, 0, 66, 18) px → (0,0) to (4.125, 1.125) grid units
    // Component spans from top rail (y=0) to bottom rail (y=1), x from 0 to 4
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 1,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");

    // Falstad TransLineElm: ladder network symbol
    // 4 zero-length thick dot lines at pin corners (fixture order: P1b, P2b, P1a, P2a)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 0, 1); // P1b
    ctx.drawLine(4, 1, 4, 1); // P2b
    ctx.drawLine(0, 0, 0, 0); // P1a
    ctx.drawLine(4, 0, 4, 0); // P2a

    // 32 iterations: thin vertical rung + thick horizontal top segment
    const step = 2 / 16; // 0.125 grid units (2px ÷ 16)
    for (let i = 0; i <= 31; i++) {
      const x = i * step;
      // Thin vertical rung from bottom rail to top rail
      ctx.setLineWidth(1);
      ctx.drawLine(x, 1, x, 0);
      // Thick horizontal top conductor segment
      ctx.setLineWidth(2);
      ctx.drawLine(x, 0, x + step, 0);
    }

    // Thick bottom conductor (full width)
    ctx.setLineWidth(2);
    ctx.drawLine(0, 1, 4, 1);

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// SegmentResistorElement — series R within one segment
// ---------------------------------------------------------------------------

class SegmentResistorElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear = false;
  readonly isReactive = false;
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  constructor(nA: number, nB: number, resistance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.G = resistance > 0 ? 1 / resistance : SHORT_CIRCUIT_CONDUCTANCE;
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    stampG(solver, this.pinNodeIds[0], this.pinNodeIds[0], this.G);
    stampG(solver, this.pinNodeIds[0], this.pinNodeIds[1], -this.G);
    stampG(solver, this.pinNodeIds[1], this.pinNodeIds[0], -this.G);
    stampG(solver, this.pinNodeIds[1], this.pinNodeIds[1], this.G);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const I = this.G * (vA - vB);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentShuntConductanceElement — shunt G from junction to GND
// ---------------------------------------------------------------------------

class SegmentShuntConductanceElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear = false;
  readonly isReactive = false;
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  constructor(node: number, G: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.G = Math.max(G, MIN_CONDUCTANCE);
  }

  load(ctx: LoadContext): void {
    stampG(ctx.solver, this.pinNodeIds[0], this.pinNodeIds[0], this.G);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = n0 > 0 ? voltages[n0 - 1] : 0;
    const I = this.G * v;
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentInductorElement — series L with proper B+C MNA stamp
//
// Uses explicit B-sub-matrix stamping so the inductor branch current appears
// in KCL equations at both nodes. This avoids singularity at DC (geq=0).
//
// DC model (before first stampCompanion, companionActive=false):
//   B sub-matrix: G[nA-1, b] += 1, G[nB-1, b] -= 1
//   C sub-matrix: G[b, nA-1] = 1, G[b, nB-1] = -1
//   (enforces V_A = V_B — short circuit at DC)
//
// Transient model (after stampCompanion):
//   G-block:  geq contribution (conductance equivalent of companion model)
//   B sub-matrix: I_b flows into nA, out of nB
//   C sub-matrix: V_A - V_B - geq*I_b = ieq
// ---------------------------------------------------------------------------

class SegmentInductorElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = SEGMENT_INDUCTOR_SCHEMA;
  readonly stateSize = SEGMENT_INDUCTOR_SCHEMA.size;
  stateBaseOffset = -1;
  setParam(_key: string, _value: number): void {}

  private readonly L: number;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  private base!: number;

  constructor(nA: number, nB: number, branchIdx: number, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.branchIndex = branchIdx;
    this.L = inductance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    this.base = this.stateBaseOffset;
    applyInitialValues(SEGMENT_INDUCTOR_SCHEMA, pool, this.base, {});
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const b = this.branchIndex;
    const L = this.L;
    const base = this.base;
    const iNow = ctx.voltages[b];

    // Flux update guard mirrors !(MODEDC|MODEINITPRED) from indload.c:43.
    if (!ctx.isDcOp && ctx.initMode !== "initPred") {
      this.s0[base + SLOT_L_PHI] = L * iNow;
      if (ctx.initMode === "initTran") {
        this.s1[base + SLOT_L_PHI] = this.s0[base + SLOT_L_PHI];
      }
    } else if (ctx.initMode === "initPred") {
      this.s0[base + SLOT_L_PHI] = this.s1[base + SLOT_L_PHI];
    }

    // Companion: zero at DC (indload.c:88-90), niIntegrate at TRAN.
    let geq = 0;
    let ceq = 0;
    if (ctx.isTransient) {
      const ag = ctx.ag;
      const phi0 = this.s0[base + SLOT_L_PHI];
      const phi1 = this.s1[base + SLOT_L_PHI];
      const phi2 = this.s2[base + SLOT_L_PHI];
      const phi3 = this.s3[base + SLOT_L_PHI];
      const ccapPrev = this.s1[base + SLOT_L_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      geq = ni.geq;
      ceq = ni.ceq;
      this.s0[base + SLOT_L_CCAP] = ni.ccap;
      if (ctx.initMode === "initTran") {
        this.s1[base + SLOT_L_CCAP] = ni.ccap;
      }
    }

    this.s0[base + SLOT_GEQ]    = geq;
    this.s0[base + SLOT_IEQ]    = ceq;
    this.s0[base + SLOT_I_PREV] = iNow;

    // Unconditional stamps — indload.c:119-123 literal. DC writes req=veq=0
    // to the allocated slots; the handle table preserves structural nonzeros.
    if (nA !== 0) solver.stampElement(solver.allocElement(nA - 1, b), 1);
    if (nB !== 0) solver.stampElement(solver.allocElement(nB - 1, b), -1);
    if (nA !== 0) solver.stampElement(solver.allocElement(b, nA - 1), 1);
    if (nB !== 0) solver.stampElement(solver.allocElement(b, nB - 1), -1);
    solver.stampElement(solver.allocElement(b, b), -geq);
    solver.stampRHS(b, ceq);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentCapacitorElement — shunt C from junction to GND
//
// Companion model: geq in parallel with ieq current source (Norton).
// RHS convention at node A: KCL requires the history current to push
// charge onto the node, so the sign is -ieq (current leaving node A via cap).
// ---------------------------------------------------------------------------

class SegmentCapacitorElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = SEGMENT_CAPACITOR_SCHEMA;
  readonly stateSize = SEGMENT_CAPACITOR_SCHEMA.size;
  stateBaseOffset = -1;
  setParam(_key: string, _value: number): void {}

  private readonly C: number;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  private base!: number;

  constructor(node: number, capacitance: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.C = capacitance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    this.base = this.stateBaseOffset;
    applyInitialValues(SEGMENT_CAPACITOR_SCHEMA, pool, this.base, {});
  }

  load(ctx: LoadContext): void {
    if (!ctx.isTransient && !ctx.isDcOp) return;
    const solver = ctx.solver;
    const n0 = this.pinNodeIds[0];
    const vNow = n0 > 0 ? ctx.voltages[n0 - 1] : 0;
    const C = this.C;

    if (ctx.isTransient) {
      const ag = ctx.ag;
      if (ctx.initMode === "initPred") {
        this.s0[this.base + SLOT_C_Q] = this.s1[this.base + SLOT_C_Q];
      } else {
        this.s0[this.base + SLOT_C_Q] = C * vNow;
        if (ctx.initMode === "initTran") {
          this.s1[this.base + SLOT_C_Q] = this.s0[this.base + SLOT_C_Q];
        }
      }
      const q0 = this.s0[this.base + SLOT_C_Q];
      const q1 = this.s1[this.base + SLOT_C_Q];
      const q2 = this.s2[this.base + SLOT_C_Q];
      const q3 = this.s3[this.base + SLOT_C_Q];
      const ccapPrev = this.s1[this.base + SLOT_C_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      if (ctx.initMode === "initTran") {
        this.s1[this.base + SLOT_C_CCAP] = ccap;
      }
      this.s0[this.base + SLOT_C_CCAP] = ccap;
      this.s0[this.base + SLOT_GEQ]    = geq;
      this.s0[this.base + SLOT_IEQ]    = ceq;
      this.s0[this.base + SLOT_V_PREV] = vNow;
      if (n0 !== 0) {
        solver.stampElement(solver.allocElement(n0 - 1, n0 - 1), geq);
        solver.stampRHS(n0 - 1, -ceq);
      }
    } else {
      this.s0[this.base + SLOT_C_Q]    = C * vNow;
      this.s0[this.base + SLOT_V_PREV] = vNow;
      this.s0[this.base + SLOT_GEQ]    = 0;
      this.s0[this.base + SLOT_IEQ]    = 0;
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = n0 > 0 ? voltages[n0 - 1] : 0;
    const I = this.s0[this.base + SLOT_GEQ] * v + this.s0[this.base + SLOT_IEQ];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// CombinedRLElement — series R + L with proper B+C MNA stamp (no mid-node)
//
// Used for the last segment. The series R is absorbed into the branch equation:
//   V_A - V_B = (R + geqL) * I_b - ieq
//
// DC model: enforces V_A = V_B (short circuit). R is included in the branch
// diagonal only during transient.
// ---------------------------------------------------------------------------

class CombinedRLElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = COMBINED_RL_SCHEMA;
  readonly stateSize = COMBINED_RL_SCHEMA.size;
  stateBaseOffset = -1;
  setParam(_key: string, _value: number): void {}

  private readonly R: number;
  private readonly L: number;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  private base!: number;

  constructor(nA: number, nB: number, branchIdx: number, resistance: number, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.branchIndex = branchIdx;
    this.R = resistance;
    this.L = inductance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    this.base = this.stateBaseOffset;
    applyInitialValues(COMBINED_RL_SCHEMA, pool, this.base, {});
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const b = this.branchIndex;
    const L = this.L;
    const base = this.base;
    const iNow = ctx.voltages[b];

    // Flux update guard mirrors !(MODEDC|MODEINITPRED) from indload.c:43.
    if (!ctx.isDcOp && ctx.initMode !== "initPred") {
      this.s0[base + SLOT_RL_PHI] = L * iNow;
      if (ctx.initMode === "initTran") {
        this.s1[base + SLOT_RL_PHI] = this.s0[base + SLOT_RL_PHI];
      }
    } else if (ctx.initMode === "initPred") {
      this.s0[base + SLOT_RL_PHI] = this.s1[base + SLOT_RL_PHI];
    }

    // Companion: zero at DC (indload.c:88-90), niIntegrate at TRAN.
    let geq = 0;
    let ceq = 0;
    if (ctx.isTransient) {
      const ag = ctx.ag;
      const phi0 = this.s0[base + SLOT_RL_PHI];
      const phi1 = this.s1[base + SLOT_RL_PHI];
      const phi2 = this.s2[base + SLOT_RL_PHI];
      const phi3 = this.s3[base + SLOT_RL_PHI];
      const ccapPrev = this.s1[base + SLOT_RL_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      geq = ni.geq;
      ceq = ni.ceq;
      this.s0[base + SLOT_RL_CCAP] = ni.ccap;
      if (ctx.initMode === "initTran") {
        this.s1[base + SLOT_RL_CCAP] = ni.ccap;
      }
    }

    this.s0[base + SLOT_GEQ]    = geq;
    this.s0[base + SLOT_IEQ]    = ceq;
    this.s0[base + SLOT_I_PREV] = iNow;

    // Unconditional stamps — indload.c:119-123 plus the constant -R on branch
    // diagonal. Branch equation: V(A) - V(B) - (R + geq)·I = ceq.
    // In DC with lossless (R=0) the diagonal stamps -= 0; handle table keeps
    // the structural nonzero so Modified Nodal Analysis stays non-singular
    // provided there's a DC path (callers ensure this via series connections).
    if (nA !== 0) solver.stampElement(solver.allocElement(nA - 1, b), 1);
    if (nB !== 0) solver.stampElement(solver.allocElement(nB - 1, b), -1);
    if (nA !== 0) solver.stampElement(solver.allocElement(b, nA - 1), 1);
    if (nB !== 0) solver.stampElement(solver.allocElement(b, nB - 1), -1);
    solver.stampElement(solver.allocElement(b, b), -(this.R + geq));
    solver.stampRHS(b, ceq);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// TransmissionLineElement — composite AnalogElement
// ---------------------------------------------------------------------------

export class TransmissionLineElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  stateSize: number = 0;
  stateBaseOffset = -1;
  readonly stateSchema: StateSchema;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  setParam(_key: string, _value: number): void {}

  private readonly _subElements: AnalogElement[];
  /** Branch index of the last segment's CombinedRL element. */
  private readonly _lastBranchIdx: number;
  /** Branch index of the first segment's inductor (= firstBranchIdx). */
  private readonly _firstBranchIdx: number;

  constructor(
    nodeIds: number[],
    firstBranchIdx: number,
    z0: number,
    delay: number,
    lossDb: number,
    length: number,
    segments: number,
  ) {
    this.pinNodeIds = nodeIds;
    this.allNodeIds = nodeIds;
    this.branchIndex = firstBranchIdx;

    const N = segments;

    // Per-segment L and C derived from transmission line parameters.
    // L_total = Z₀ × τ,  C_total = τ / Z₀
    // Divide by N for per-segment values (length factor already in τ).
    const lSeg = (z0 * delay) / N;
    const cSeg = delay / (z0 * N);

    // Convert dB/m loss to per-segment R and G.
    // α (Np/m) = lossDb × ln(10) / 20
    // R ≈ 2α Z₀ per unit length,  G ≈ 2α / Z₀ per unit length
    let rSeg = 0;
    let gSeg = 0;
    if (lossDb > 0) {
      const alphaNpPerM = (lossDb * Math.LN10) / 20;
      rSeg = (2 * alphaNpPerM * z0 * length) / N;
      gSeg = (2 * alphaNpPerM * length) / (z0 * N);
    }

    // Internal node layout (2*(N-1) nodes total):
    //   rlMidNodes[k]     = nodeIds[2 + k]            for k = 0..N-2
    //   junctionNodes[k]  = nodeIds[2 + (N-1) + k]    for k = 0..N-2
    const rlMidNodes: number[] = [];
    const junctionNodes: number[] = [];
    for (let k = 0; k < N - 1; k++) {
      rlMidNodes.push(nodeIds[2 + k]);
      junctionNodes.push(nodeIds[2 + (N - 1) + k]);
    }

    this._subElements = [];

    for (let k = 0; k < N; k++) {
      const inputNode = k === 0 ? nodeIds[0] : junctionNodes[k - 1];
      const branchIdxForL = firstBranchIdx + k;

      if (k < N - 1) {
        const rlMid = rlMidNodes[k];
        const junctionNode = junctionNodes[k];

        // Series R: inputNode → rlMid
        this._subElements.push(new SegmentResistorElement(inputNode, rlMid, rSeg));

        // Series L: rlMid → junctionNode
        this._subElements.push(
          new SegmentInductorElement(rlMid, junctionNode, branchIdxForL, lSeg),
        );

        // Shunt G: junctionNode → GND (lossy only)
        if (gSeg > 0) {
          this._subElements.push(new SegmentShuntConductanceElement(junctionNode, gSeg));
        }

        // Shunt C: junctionNode → GND
        this._subElements.push(new SegmentCapacitorElement(junctionNode, cSeg));
      } else {
        // Last segment: combined RL to Port2, no shunt at Port2.
        this._subElements.push(
          new CombinedRLElement(inputNode, nodeIds[1], branchIdxForL, rSeg, lSeg),
        );
      }
    }

    // Branch indices for getPinCurrents.
    this._firstBranchIdx = firstBranchIdx;
    this._lastBranchIdx = firstBranchIdx + N - 1;

    // Compute total state size from all reactive sub-elements.
    let totalState = 0;
    for (const el of this._subElements) {
      if (el.isReactive) {
        totalState += (el as ReactiveAnalogElement).stateSize;
      }
    }
    this.stateSize = totalState;
    // stateSchema is unused for the composite but must be set; use empty schema.
    this.stateSchema = defineStateSchema("TransmissionLineElement", []);
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    let offset = this.stateBaseOffset;
    for (const el of this._subElements) {
      if (el.isReactive) {
        const re = el as ReactiveAnalogElement;
        re.stateBaseOffset = offset;
        re.initState(pool);
        offset += re.stateSize;
      }
    }
  }

  refreshSubElementRefs(s0: Float64Array, s1: Float64Array, s2: Float64Array, s3: Float64Array, s4: Float64Array, s5: Float64Array, s6: Float64Array, s7: Float64Array): void {
    for (const el of this._subElements) {
      if (el.isReactive) {
        const re = el as any;
        re.s0 = s0; re.s1 = s1; re.s2 = s2; re.s3 = s3;
        re.s4 = s4; re.s5 = s5; re.s6 = s6; re.s7 = s7;
      }
    }
  }

  load(ctx: LoadContext): void {
    for (const el of this._subElements) {
      el.load(ctx);
    }
  }

  getLteTimestep(dt: number, deltaOld: readonly number[], order: number, method: IntegrationMethod, lteParams: LteParams): number {
    let minDt = Infinity;
    const SLOT_Q_PHI = 3;
    const SLOT_CCAP_SUB = 4;
    for (const el of this._subElements) {
      if (!el.isReactive) continue;
      const re = el as any;
      const base = re.stateBaseOffset;
      const ccap0 = re.s0[base + SLOT_CCAP_SUB];
      const ccap1 = re.s1[base + SLOT_CCAP_SUB];
      const q0 = re.s0[base + SLOT_Q_PHI];
      const q1 = re.s1[base + SLOT_Q_PHI];
      const q2 = re.s2[base + SLOT_Q_PHI];
      const q3 = re.s3[base + SLOT_Q_PHI];
      const proposed = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (proposed < minDt) minDt = proposed;
    }
    return minDt;
  }

  /**
   * Per-pin currents for the 4 external pins in pinLayout order:
   *   [0] P1b — Port1 high side
   *   [1] P2b — Port2 high side
   *   [2] P1a — Port1 return (ground side)
   *   [3] P2a — Port2 return (ground side)
   *
   * Current into Port1 = branch current of first segment's inductor (rlMid0 → junction0).
   * The series R and L in segment 0 are in series, so I_R = I_L = I_firstBranch.
   * This holds for both lossless (R=0) and lossy cases.
   *
   * Current into Port2 = -I_lastBranch: the last CombinedRL branch current flows
   * from the last junction INTO Port2 (nA→nB), so it exits the element externally
   * at Port2 → negative from the element's perspective.
   *
   * P1a and P2a are the ground-return pins: they carry the equal-and-opposite
   * return current relative to their corresponding high-side pin.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    // First segment inductor branch current = current entering Port1 from external.
    const iPort1 = voltages[this._firstBranchIdx];

    // Last CombinedRL branch flows from last junction → Port2 (exits externally).
    const iPort2 = -voltages[this._lastBranchIdx];

    // Return pins carry equal-and-opposite ground return current.
    return [iPort1, iPort2, -iPort1, -iPort2];
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

function buildTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  impedance: number,
  delay: number,
  lossPerMeter: number,
  length: number,
  segments: number,
): AnalogElementCore {
  const p = { impedance, delay, lossPerMeter, length, segments };
  const nodeIds = [
    pinNodes.get("P1b")!,
    pinNodes.get("P2b")!,
    ...internalNodeIds,
  ];
  const el = new TransmissionLineElement(nodeIds, branchIdx, p.impedance, p.delay, p.lossPerMeter, p.length, p.segments);
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
    }
  };
  return el;
}

function createTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  return buildTransmissionLineElement(
    pinNodes,
    internalNodeIds,
    branchIdx,
    props.getModelParam<number>("impedance"),
    props.getModelParam<number>("delay"),
    props.getModelParam<number>("lossPerMeter"),
    props.getModelParam<number>("length"),
    props.getModelParam<number>("segments"),
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRANSMISSION_LINE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "lossPerMeter",
    type: PropertyType.FLOAT,
    label: "Loss (dB/m)",
    defaultValue: 0,
    min: 0,
    description: "Conductor and dielectric loss in dB per metre",
  },
  {
    key: "length",
    type: PropertyType.FLOAT,
    label: "Length (m)",
    defaultValue: 1.0,
    min: 1e-6,
    description: "Physical length of the transmission line in metres",
  },
  {
    key: "segments",
    type: PropertyType.INT,
    label: "Segments (N)",
    defaultValue: 10,
    min: 2,
    max: 100,
    description: "Number of lumped RLCG segments (more segments = more accurate, slower)",
    structural: true,
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown on the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "impedance",
    propertyKey: "impedance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "delay",
    propertyKey: "delay",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "lossPerMeter",
    propertyKey: "lossPerMeter",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "length",
    propertyKey: "length",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "segments",
    propertyKey: "segments",
    modelParam: true,
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// TransmissionLineDefinition
// ---------------------------------------------------------------------------

function transmissionLineCircuitFactory(props: PropertyBag): TransmissionLineCircuitElement {
  return new TransmissionLineCircuitElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const TransmissionLineDefinition: ComponentDefinition = {
  name: "TransmissionLine",
  typeId: -1,
  factory: transmissionLineCircuitFactory,
  pinLayout: buildTransmissionLinePinDeclarations(),
  propertyDefs: TRANSMISSION_LINE_PROPERTY_DEFS,
  attributeMap: TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Lossy Transmission Line — lumped RLCG model.\n" +
    "N cascaded segments with series RL and shunt GC. " +
    "Parameterised by Z\u2080, propagation delay, loss, and segment count.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransmissionLineElement,
      paramDefs: TRANSMISSION_LINE_PARAM_DEFS,
      params: TRANSMISSION_LINE_DEFAULTS,
      branchCount: (props: PropertyBag) => {
        const seg = props.getModelParam<number>('segments');
        return seg != null ? seg : 10;
      },
      getInternalNodeCount: (props: PropertyBag) => {
        const seg = props.getModelParam<number>('segments');
        const N = seg != null ? seg : 10;
        return 2 * (N - 1);
      },
      getInternalNodeLabels: (props: PropertyBag): readonly string[] => {
        // Internal node allocation: rlMid[0..N-2] then junction[0..N-2]
        const seg = props.getModelParam<number>('segments');
        const N = seg != null ? seg : 10;
        const labels: string[] = [];
        for (let k = 0; k < N - 1; k++) labels.push(`rlMid${k}`);
        for (let k = 0; k < N - 1; k++) labels.push(`junc${k}`);
        return labels;
      },
    },
  },
  defaultModel: "behavioral",
};
