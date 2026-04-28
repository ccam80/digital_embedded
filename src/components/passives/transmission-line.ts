/**
 * Lossy Transmission Line  lumped RLCG model.
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
 * Segments 0..N-2: inputNode ─ R ─ rlMid[k] ─ L ─ junction[k], shunt G+C at junction[k]
 * Segment N-1 (last): junction[N-2] ─ CombinedRL ─ Port2 (no shunt at Port2)
 *
 * Branch variables: N consecutive indices (one per segment inductor/CombinedRL).
 *
 * MNA stamp conventions:
 *   Inductor with nodes A, B, branch row k:
 *     B sub-matrix: G[A-1, k] += 1,  G[B-1, k] -= 1   (KCL: I_k flows AB)
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
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { AnalogElement, ReactiveAnalogElementCore, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODEDC, MODETRAN, MODETRANOP, MODEINITPRED, MODEINITTRAN } from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
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
    impedance:    { default: 50,    description: "Characteristic impedance Z₀ in ohms", min: 1 },
    delay:        { default: 1e-9,  unit: "s", description: "Total one-way propagation delay in seconds", min: 1e-15 },
  },
  secondary: {
    lossPerMeter: { default: 0,     description: "Conductor and dielectric loss in dB per metre", min: 0 },
    length:       { default: 1.0,   description: "Physical length of the transmission line in metres", min: 1e-6 },
    segments:     { default: 10,    description: "Number of lumped RLCG segments (more segments = more accurate, slower)", min: 2, max: 100 },
  },
});

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
// TransmissionLineCircuitElement  CircuitElement for rendering
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
// SegmentResistorElement  series R within one segment
// ---------------------------------------------------------------------------

class SegmentResistorElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = false;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  // ressetup.c:46-49 — cached TSTALLOC handles, 4 entries.
  private _hAA: number = -1;
  private _hAB: number = -1;
  private _hBA: number = -1;
  private _hBB: number = -1;

  constructor(nA: number, nB: number, resistance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this.G = resistance > 0 ? 1 / resistance : SHORT_CIRCUIT_CONDUCTANCE;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];

    // ressetup.c:46-49 — TSTALLOC sequence, 4 entries.
    this._hAA = solver.allocElement(nA, nA);
    this._hAB = solver.allocElement(nA, nB);
    this._hBA = solver.allocElement(nB, nA);
    this._hBB = solver.allocElement(nB, nB);
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const G = this.G;
    solver.stampElement(this._hAA,  G);
    solver.stampElement(this._hAB, -G);
    solver.stampElement(this._hBA, -G);
    solver.stampElement(this._hBB,  G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const vA = rhs[nA];
    const vB = rhs[nB];
    const I = this.G * (vA - vB);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentShuntConductanceElement  shunt G from junction to GND
// ---------------------------------------------------------------------------

class SegmentShuntConductanceElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = false;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  setParam(_key: string, _value: number): void {}

  private readonly G: number;

  // ressetup.c:46-49 collapsed to single (n,n) — one terminal is ground.
  private _hNN: number = -1;

  constructor(node: number, G: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.G = Math.max(G, MIN_CONDUCTANCE);
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const n = this.pinNodeIds[0];
    // Single TSTALLOC: (n, n). The (0, 0), (n, 0), (0, n) entries that
    // would exist if the cathode were a real node fall on row/col 0
    // (ground discard) and are not allocated.
    this._hNN = solver.allocElement(n, n);
  }

  load(ctx: LoadContext): void {
    ctx.solver.stampElement(this._hNN, this.G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = rhs[n0];
    const I = this.G * v;
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentInductorElement  series L with proper B+C MNA stamp
//
// Uses explicit B-sub-matrix stamping so the inductor branch current appears
// in KCL equations at both nodes. This avoids singularity at DC (geq=0).
//
// DC model (before first stampCompanion, companionActive=false):
//   B sub-matrix: G[nA-1, b] += 1, G[nB-1, b] -= 1
//   C sub-matrix: G[b, nA-1] = 1, G[b, nB-1] = -1
//   (enforces V_A = V_B  short circuit at DC)
//
// Transient model (after stampCompanion):
//   G-block:  geq contribution (conductance equivalent of companion model)
//   B sub-matrix: I_b flows into nA, out of nB
//   C sub-matrix: V_A - V_B - geq*I_b = ieq
// ---------------------------------------------------------------------------

class SegmentInductorElement implements ReactiveAnalogElementCore {
  pinNodeIds: readonly number[];
  allNodeIds: readonly number[];
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = true as const;
  readonly poolBacked = true as const;
  readonly stateSchema = SEGMENT_INDUCTOR_SCHEMA;
  readonly stateSize = SEGMENT_INDUCTOR_SCHEMA.size;
  stateBaseOffset = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  setParam(_key: string, _value: number): void {}

  private readonly L: number;
  private readonly _label: string;
  private _pool!: StatePoolRef;

  // indsetup.c:96-100 — cached TSTALLOC handles, 5 entries.
  private _hPIbr:   number = -1;
  private _hNIbr:   number = -1;
  private _hIbrN:   number = -1;
  private _hIbrP:   number = -1;
  private _hIbrIbr: number = -1;

  constructor(nA: number, nB: number, label: string, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this._label = label;
    this.L = inductance;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodeIds[0];
    const negNode = this.pinNodeIds[1];

    // Branch row allocation per indsetup.c:84-88 — idempotent guard.
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100 — TSTALLOC sequence, 5 entries (line-for-line).
    this._hPIbr   = solver.allocElement(posNode, b);
    this._hNIbr   = solver.allocElement(negNode, b);
    this._hIbrN   = solver.allocElement(b, negNode);
    this._hIbrP   = solver.allocElement(b, posNode);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this._label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    return this.branchIndex;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SEGMENT_INDUCTOR_SCHEMA, pool, this.stateBaseOffset, {});
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const b = this.branchIndex;
    const L = this.L;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const iNow = ctx.rhsOld[b];

    // Flux update guard mirrors !(MODEDC|MODEINITPRED) from indload.c:43.
    const mode = ctx.cktMode;
    if (!(mode & (MODEDC | MODEINITPRED))) {
      s0[base + SLOT_L_PHI] = L * iNow;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_L_PHI] = s0[base + SLOT_L_PHI];
      }
    } else if (mode & MODEINITPRED) {
      s0[base + SLOT_L_PHI] = s1[base + SLOT_L_PHI];
    }

    // Companion: zero at DC (indload.c:88-90), niIntegrate at TRAN.
    let geq = 0;
    let ceq = 0;
    if (!(mode & MODEDC)) {
      const ag = ctx.ag;
      const phi0 = s0[base + SLOT_L_PHI];
      const phi1 = s1[base + SLOT_L_PHI];
      const phi2 = s2[base + SLOT_L_PHI];
      const phi3 = s3[base + SLOT_L_PHI];
      const ccapPrev = s1[base + SLOT_L_CCAP];
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
      s0[base + SLOT_L_CCAP] = ni.ccap;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_L_CCAP] = ni.ccap;
      }
    }

    s0[base + SLOT_GEQ]    = geq;
    s0[base + SLOT_IEQ]    = ceq;
    s0[base + SLOT_I_PREV] = iNow;

    // Unconditional stamps — indload.c:119-123 literal.
    solver.stampElement(this._hPIbr,    1);
    solver.stampElement(this._hNIbr,   -1);
    solver.stampElement(this._hIbrP,    1);
    solver.stampElement(this._hIbrN,   -1);
    solver.stampElement(this._hIbrIbr, -geq);
    stampRHS(ctx.rhs, b, ceq);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// SegmentCapacitorElement  shunt C from junction to GND
//
// Companion model: geq in parallel with ieq current source (Norton).
// RHS convention at node A: KCL requires the history current to push
// charge onto the node, so the sign is -ieq (current leaving node A via cap).
// ---------------------------------------------------------------------------

class SegmentCapacitorElement implements ReactiveAnalogElementCore {
  pinNodeIds: readonly number[];
  allNodeIds: readonly number[];
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = true as const;
  readonly poolBacked = true as const;
  readonly stateSchema = SEGMENT_CAPACITOR_SCHEMA;
  readonly stateSize = SEGMENT_CAPACITOR_SCHEMA.size;
  stateBaseOffset = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  setParam(_key: string, _value: number): void {}

  private readonly C: number;
  private _pool!: StatePoolRef;

  // capsetup.c:102-117 collapsed to single (n,n) — one terminal is ground.
  private _hNN: number = -1;

  constructor(node: number, capacitance: number) {
    this.pinNodeIds = [node, 0];
    this.allNodeIds = [node, 0];
    this.C = capacitance;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const n = this.pinNodeIds[0];
    // Single TSTALLOC: (n, n). The capsetup pattern's (pos, pos), (neg,
    // neg), (pos, neg), (neg, pos) collapses to (n, n) only because
    // negNode = 0 (ground), and all (neg, *) / (*, neg) entries are
    // discarded.
    this._hNN = solver.allocElement(n, n);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SEGMENT_CAPACITOR_SCHEMA, pool, this.stateBaseOffset, {});
  }

  load(ctx: LoadContext): void {
    const mode = ctx.cktMode;
    if (!(mode & (MODETRAN | MODETRANOP))) return;
    const solver = ctx.solver;
    const n0 = this.pinNodeIds[0];
    const vNow = ctx.rhsOld[n0];
    const C = this.C;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    if (mode & MODETRAN) {
      const ag = ctx.ag;
      if (mode & MODEINITPRED) {
        s0[base + SLOT_C_Q] = s1[base + SLOT_C_Q];
      } else {
        s0[base + SLOT_C_Q] = C * vNow;
        if (mode & MODEINITTRAN) {
          s1[base + SLOT_C_Q] = s0[base + SLOT_C_Q];
        }
      }
      const q0 = s0[base + SLOT_C_Q];
      const q1 = s1[base + SLOT_C_Q];
      const q2 = s2[base + SLOT_C_Q];
      const q3 = s3[base + SLOT_C_Q];
      const ccapPrev = s1[base + SLOT_C_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_C_CCAP] = ccap;
      }
      s0[base + SLOT_C_CCAP] = ccap;
      s0[base + SLOT_GEQ]    = geq;
      s0[base + SLOT_IEQ]    = ceq;
      s0[base + SLOT_V_PREV] = vNow;
      if (n0 !== 0) {
        solver.stampElement(this._hNN, geq);
        stampRHS(ctx.rhs, n0, -ceq);
      }
    } else {
      s0[base + SLOT_C_Q]    = C * vNow;
      s0[base + SLOT_V_PREV] = vNow;
      s0[base + SLOT_GEQ]    = 0;
      s0[base + SLOT_IEQ]    = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const v = rhs[n0];
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const I = s0[base + SLOT_GEQ] * v + s0[base + SLOT_IEQ];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// CombinedRLElement  series R + L with proper B+C MNA stamp (no mid-node)
//
// Used for the last segment. The series R is absorbed into the branch equation:
//   V_A - V_B = (R + geqL) * I_b - ieq
//
// DC model: enforces V_A = V_B (short circuit). R is included in the branch
// diagonal only during transient.
// ---------------------------------------------------------------------------

class CombinedRLElement implements ReactiveAnalogElementCore {
  pinNodeIds: readonly number[];
  allNodeIds: readonly number[];
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = true as const;
  readonly poolBacked = true as const;
  readonly stateSchema = COMBINED_RL_SCHEMA;
  readonly stateSize = COMBINED_RL_SCHEMA.size;
  stateBaseOffset = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  setParam(_key: string, _value: number): void {}

  private readonly R: number;
  private readonly L: number;
  private readonly _label: string;
  private _pool!: StatePoolRef;

  // 5 TSTALLOC entries — same shape as SegmentInductorElement.
  private _hPIbr:   number = -1;
  private _hNIbr:   number = -1;
  private _hIbrN:   number = -1;
  private _hIbrP:   number = -1;
  private _hIbrIbr: number = -1;

  constructor(nA: number, nB: number, label: string, resistance: number, inductance: number) {
    this.pinNodeIds = [nA, nB];
    this.allNodeIds = [nA, nB];
    this._label = label;
    this.R = resistance;
    this.L = inductance;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];

    // Branch row allocation — same idempotent pattern as SegmentInductorElement.
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    const b = this.branchIndex;

    // 5 TSTALLOC entries — same shape as SegmentInductorElement, but the
    // (b, b) handle's stamped value during load() includes the -R
    // contribution in addition to -geq, per the combined-RL branch
    // equation:  V(A) - V(B) - (R + geq)·I = ceq.
    this._hPIbr   = solver.allocElement(nA, b);
    this._hNIbr   = solver.allocElement(nB, b);
    this._hIbrN   = solver.allocElement(b, nB);
    this._hIbrP   = solver.allocElement(b, nA);
    this._hIbrIbr = solver.allocElement(b, b);
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    if (name !== this._label) return 0;
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._label, "branch");
    }
    return this.branchIndex;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(COMBINED_RL_SCHEMA, pool, this.stateBaseOffset, {});
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const b = this.branchIndex;
    const L = this.L;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const iNow = ctx.rhsOld[b];

    // Flux update guard mirrors !(MODEDC|MODEINITPRED) from indload.c:43.
    const mode = ctx.cktMode;
    if (!(mode & (MODEDC | MODEINITPRED))) {
      s0[base + SLOT_RL_PHI] = L * iNow;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_RL_PHI] = s0[base + SLOT_RL_PHI];
      }
    } else if (mode & MODEINITPRED) {
      s0[base + SLOT_RL_PHI] = s1[base + SLOT_RL_PHI];
    }

    // Companion: zero at DC (indload.c:88-90), niIntegrate at TRAN.
    let geq = 0;
    let ceq = 0;
    if (!(mode & MODEDC)) {
      const ag = ctx.ag;
      const phi0 = s0[base + SLOT_RL_PHI];
      const phi1 = s1[base + SLOT_RL_PHI];
      const phi2 = s2[base + SLOT_RL_PHI];
      const phi3 = s3[base + SLOT_RL_PHI];
      const ccapPrev = s1[base + SLOT_RL_CCAP];
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
      s0[base + SLOT_RL_CCAP] = ni.ccap;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_RL_CCAP] = ni.ccap;
      }
    }

    s0[base + SLOT_GEQ]    = geq;
    s0[base + SLOT_IEQ]    = ceq;
    s0[base + SLOT_I_PREV] = iNow;

    // Unconditional stamps — indload.c:119-123 plus the constant -R on branch
    // diagonal. Branch equation: V(A) - V(B) - (R + geq)·I = ceq.
    solver.stampElement(this._hPIbr,    1);
    solver.stampElement(this._hNIbr,   -1);
    solver.stampElement(this._hIbrP,    1);
    solver.stampElement(this._hIbrN,   -1);
    solver.stampElement(this._hIbrIbr, -(this.R + geq));
    stampRHS(ctx.rhs, b, ceq);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// TransmissionLineElement  composite AnalogElement
// ---------------------------------------------------------------------------

export class TransmissionLineElement implements AnalogElementCore {
  pinNodeIds: readonly number[];
  allNodeIds: readonly number[];
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  stateSize: number = 0;
  stateBaseOffset = -1;
  readonly stateSchema: StateSchema;
  private _pool!: StatePoolRef;
  setParam(_key: string, _value: number): void {}

  private _subElements: (SegmentResistorElement | SegmentInductorElement | SegmentShuntConductanceElement | SegmentCapacitorElement | CombinedRLElement)[] = [];

  /** Branch index of the last segment's CombinedRL element. */
  private _lastBranchIdx: number = -1;
  /** Branch index of the first segment's inductor (= firstBranchIdx). */
  private _firstBranchIdx: number = -1;

  private readonly _segments: number;
  private readonly _rSeg: number;
  private readonly _lSeg: number;
  private readonly _gSeg: number;
  private readonly _cSeg: number;
  label?: string;

  constructor(
    nodeIds: number[],
    z0: number,
    delay: number,
    lossDb: number,
    length: number,
    segments: number,
    label?: string,
  ) {
    this.pinNodeIds = nodeIds;
    this.allNodeIds = nodeIds;
    if (label !== undefined) this.label = label;

    const N = segments;
    this._segments = N;

    // Per-segment L and C derived from transmission line parameters.
    // L_total = Z₀ × τ,  C_total = τ / Z₀
    // Divide by N for per-segment values (length factor already in τ).
    this._lSeg = (z0 * delay) / N;
    this._cSeg = delay / (z0 * N);

    // Convert dB/m loss to per-segment R and G.
    // α (Np/m) = lossDb × ln(10) / 20
    // R = 2α Z₀ per unit length,  G = 2α / Z₀ per unit length
    this._rSeg = 0;
    this._gSeg = 0;
    if (lossDb > 0) {
      const alphaNpPerM = (lossDb * Math.LN10) / 20;
      this._rSeg = (2 * alphaNpPerM * z0 * length) / N;
      this._gSeg = (2 * alphaNpPerM * length) / (z0 * N);
    }

    // stateSchema is unused for the composite but must be set; use empty schema.
    this.stateSchema = defineStateSchema("TransmissionLineElement", []);
  }

  setup(ctx: SetupContext): void {
    const N = this._segments;
    const nodeIds = this.pinNodeIds;  // [P1b, P2b] from constructor

    // Allocate (N-1) rlMid internal nodes and (N-1) junction internal nodes.
    const rlMidNodes: number[] = [];
    const junctionNodes: number[] = [];
    for (let k = 0; k < N - 1; k++) {
      rlMidNodes.push(ctx.makeVolt(this.label ?? "tline", `rlMid${k}`));
    }
    for (let k = 0; k < N - 1; k++) {
      junctionNodes.push(ctx.makeVolt(this.label ?? "tline", `junc${k}`));
    }

    // Construct the segment-chain sub-elements with allocated internal node ids.
    this._subElements = [];
    for (let k = 0; k < N; k++) {
      const inputNode = k === 0 ? nodeIds[0] : junctionNodes[k - 1];

      if (k < N - 1) {
        const rlMid = rlMidNodes[k];
        const junctionNode = junctionNodes[k];

        // Series R: inputNode → rlMid
        this._subElements.push(new SegmentResistorElement(inputNode, rlMid, this._rSeg));

        // Series L: rlMid → junctionNode (label drives makeCur in L.setup)
        this._subElements.push(new SegmentInductorElement(
          rlMid, junctionNode,
          `${this.label ?? "tline"}_seg${k}_L`,
          this._lSeg,
        ));

        // Shunt G: junctionNode → GND (lossy only)
        if (this._gSeg > 0) {
          this._subElements.push(new SegmentShuntConductanceElement(junctionNode, this._gSeg));
        }

        // Shunt C: junctionNode → GND
        this._subElements.push(new SegmentCapacitorElement(junctionNode, this._cSeg));
      } else {
        // Last segment: combined RL to Port2, no shunt at Port2.
        this._subElements.push(new CombinedRLElement(
          inputNode, nodeIds[1],
          `${this.label ?? "tline"}_seg${k}_RL`,
          this._rSeg, this._lSeg,
        ));
      }
    }

    // Forward setup() to every sub-element. Order within a segment:
    // R → L → (G if lossy) → C, and the final segment is CombinedRL alone.
    // Across segments: 0, 1, 2, ..., N-1.
    for (const el of this._subElements) {
      el.setup(ctx);
    }

    // Compute total state size from all reactive sub-elements (now that they exist).
    let totalState = 0;
    for (const el of this._subElements) {
      if (el.isReactive) {
        totalState += (el as ReactiveAnalogElementCore).stateSize;
      }
    }
    this.stateSize = totalState;

    // Cache branch indices for getPinCurrents.
    this._firstBranchIdx = this._extractFirstBranchIdx();
    this._lastBranchIdx  = this._extractLastBranchIdx();
  }

  private _extractFirstBranchIdx(): number {
    const N = this._segments;
    if (N === 1) {
      // Only element is CombinedRLElement at index 0
      return (this._subElements[0] as CombinedRLElement).branchIndex;
    }
    // For N>=2: _subElements[1] is the SegmentInductorElement of segment 0
    return (this._subElements[1] as SegmentInductorElement).branchIndex;
  }

  private _extractLastBranchIdx(): number {
    // The last element is always the CombinedRLElement
    const last = this._subElements[this._subElements.length - 1];
    return (last as CombinedRLElement).branchIndex;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const el of this._subElements) {
      if (el.isReactive) {
        const re = el as ReactiveAnalogElementCore;
        re.stateBaseOffset = offset;
        re.initState(pool);
        offset += re.stateSize;
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
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    for (const el of this._subElements) {
      if (!el.isReactive) continue;
      const re = el as ReactiveAnalogElementCore;
      const base = re.stateBaseOffset;
      const ccap0 = s0[base + SLOT_CCAP_SUB];
      const ccap1 = s1[base + SLOT_CCAP_SUB];
      const q0 = s0[base + SLOT_Q_PHI];
      const q1 = s1[base + SLOT_Q_PHI];
      const q2 = s2[base + SLOT_Q_PHI];
      const q3 = s3[base + SLOT_Q_PHI];
      const proposed = cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
      if (proposed < minDt) minDt = proposed;
    }
    return minDt;
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    for (const el of this._subElements) {
      const candidate = el as SegmentInductorElement | CombinedRLElement;
      if (typeof candidate.findBranchFor === "function") {
        const idx = candidate.findBranchFor(name, ctx);
        if (idx !== 0) return idx;
      }
    }
    return 0;
  }

  /**
   * Per-pin currents for the 4 external pins in pinLayout order:
   *   [0] P1b  Port1 high side
   *   [1] P2b  Port2 high side
   *   [2] P1a  Port1 return (ground side)
   *   [3] P2a  Port2 return (ground side)
   *
   * Current into Port1 = branch current of first segment's inductor (rlMid0 → junction0).
   * The series R and L in segment 0 are in series, so I_R = I_L = I_firstBranch.
   * This holds for both lossless (R=0) and lossy cases.
   *
   * Current into Port2 = -I_lastBranch: the last CombinedRL branch current flows
   * from the last junction INTO Port2 (nA→nB), so it exits the element externally
   * at Port2 — negative from the element's perspective.
   *
   * P1a and P2a are the ground-return pins: they carry the equal-and-opposite
   * return current relative to their corresponding high-side pin.
   */
  getPinCurrents(rhs: Float64Array): number[] {
    // First segment inductor branch current = current entering Port1 from external.
    const iPort1 = rhs[this._firstBranchIdx];

    // Last CombinedRL branch flows from last junction → Port2 (exits externally).
    const iPort2 = -rhs[this._lastBranchIdx];

    // Return pins carry equal-and-opposite ground return current.
    return [iPort1, iPort2, -iPort1, -iPort2];
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

function buildTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  impedance: number,
  delay: number,
  lossPerMeter: number,
  length: number,
  segments: number,
  label?: string,
): AnalogElementCore {
  const p = { impedance, delay, lossPerMeter, length, segments };
  const nodeIds = [
    pinNodes.get("P1b")!,
    pinNodes.get("P2b")!,
  ];
  const el = new TransmissionLineElement(nodeIds, p.impedance, p.delay, p.lossPerMeter, p.length, p.segments, label);
  el._pinNodes = new Map(pinNodes);
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
    }
  };
  return el;
}

function createTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  const label = props.hasModelParam("label") ? props.getModelParam<string>("label") : undefined;
  return buildTransmissionLineElement(
    pinNodes,
    props.getModelParam<number>("impedance"),
    props.getModelParam<number>("delay"),
    props.getModelParam<number>("lossPerMeter"),
    props.getModelParam<number>("length"),
    props.getModelParam<number>("segments"),
    typeof label === "string" ? label : undefined,
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
    "Lossy Transmission Line  lumped RLCG model.\n" +
    "N cascaded segments with series RL and shunt GC. " +
    "Parameterised by Z₀, propagation delay, loss, and segment count.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransmissionLineElement,
      paramDefs: TRANSMISSION_LINE_PARAM_DEFS,
      params: TRANSMISSION_LINE_DEFAULTS,
      mayCreateInternalNodes: true,
    },
  },
  defaultModel: "behavioral",
};
