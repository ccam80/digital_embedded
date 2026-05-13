/**
 * TransmissionLineAnalogElement — verbatim port of ngspice's lossless TRA device.
 *
 * Maps function-by-function to ref/ngspice/src/spicelib/devices/tra/*:
 *   setup()       → trasetup.c
 *   load()        → traload.c
 *   acceptStep()  → traacct.c
 *   setParam()    → traparam.c
 *
 * ngspice → digiTS variable mapping:
 *   TRAposNode1   → _posNode1 (= pinNodes["P1b"])
 *   TRAnegNode1   → _negNode1 (= pinNodes["P1a"])
 *   TRAposNode2   → _posNode2 (= pinNodes["P2b"])
 *   TRAnegNode2   → _negNode2 (= pinNodes["P2a"])
 *   TRAintNode1   → _int1     (ctx.makeVolt label "int1")
 *   TRAintNode2   → _int2     (ctx.makeVolt label "int2")
 *   TRAbrEq1      → _ibr1     (ctx.makeCur  label "i1")
 *   TRAbrEq2      → _ibr2     (ctx.makeCur  label "i2")
 *   TRAimped      → _Z0
 *   TRAconduct    → _G  (= 1/_Z0)
 *   TRAtd         → _td
 *   TRAdelays[]   → _delays[]   (one {t,v1,v2} entry per ngspice's 3-double stride)
 *   TRAsizeDelay  → _sizeDelay
 *   TRAinput1/2   → _input1, _input2
 *   TRAreltol     → _reltol  (per-instance; default 1 per trasetup.c:100-102)
 *   TRAabstol     → _abstol  (per-instance; default 1 per trasetup.c:103-105)
 *   CKTminBreak   → ctx.minBreak (read in load(), cached for acceptStep)
 *   CKTdeltaOld[] → ctx.deltaOld (cached ref in load(); read in acceptStep)
 *
 * Loss handling: when lossPerMeter > 0 the constructor throws — ngspice's `T`
 * card models a lossless line; lossy lines require LTRA (the `O` element, not
 * yet ported). Silently demoting to the LC ladder would re-introduce the
 * structural-singularity NaN that motivated this port.
 */

import { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { PropertyBag } from "../../core/properties.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { MODEDC, MODEINITTRAN, MODEINITPRED } from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";

// ---------------------------------------------------------------------------
// History sample
// ---------------------------------------------------------------------------

/**
 * One row of the ngspice TRAdelays table.
 *
 * ngspice stores three flat doubles per sample (t, v1, v2) at offsets
 * 3*i / 3*i+1 / 3*i+2 (traload.c:79-85). We use an object array for clarity;
 * indexing semantics are identical (delays[i] ↔ delays + 3*i).
 *
 * `v1` = port-2 voltage + ibr2 * Z0 (input headed for port 1 after td delay).
 * `v2` = port-1 voltage + ibr1 * Z0 (input headed for port 2 after td delay).
 */
interface DelaySample {
  t: number;
  v1: number;
  v2: number;
}

// ---------------------------------------------------------------------------
// TransmissionLineAnalogElement
// ---------------------------------------------------------------------------

class TransmissionLineAnalogElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.TRA;
  readonly deviceFamily: DeviceFamily = "TRA";

  // Mutable params (setParam targets)
  private _Z0: number;
  private _td: number;
  private _G: number;
  // Per-instance tolerances for the acceptStep second-derivative test
  // (trasetup.c:100-105 — both default to 1 when not explicitly given)
  private _reltol = 1;
  private _abstol = 1;

  // External pin node IDs (resolved in setup)
  private _posNode1 = -1;
  private _negNode1 = -1;
  private _posNode2 = -1;
  private _negNode2 = -1;
  // Internal nodes (allocated in setup)
  private _int1 = -1;
  private _int2 = -1;
  // Branch rows (allocated in setup)
  private _ibr1 = -1;
  private _ibr2 = -1;

  // 22 stamp handles (allocElement in setup, used by stampElement in load)
  private _hIbr1Ibr2 = -1;
  private _hIbr1Int1 = -1;
  private _hIbr1Neg1 = -1;
  private _hIbr1Neg2 = -1;
  private _hIbr1Pos2 = -1;
  private _hIbr2Ibr1 = -1;
  private _hIbr2Int2 = -1;
  private _hIbr2Neg1 = -1;
  private _hIbr2Neg2 = -1;
  private _hIbr2Pos1 = -1;
  private _hInt1Ibr1 = -1;
  private _hInt1Int1 = -1;
  private _hInt1Pos1 = -1;
  private _hInt2Ibr2 = -1;
  private _hInt2Int2 = -1;
  private _hInt2Pos2 = -1;
  private _hNeg1Ibr1 = -1;
  private _hNeg2Ibr2 = -1;
  private _hPos1Int1 = -1;
  private _hPos1Pos1 = -1;
  private _hPos2Int2 = -1;
  private _hPos2Pos2 = -1;

  // History table (ngspice TRAdelays). Grows by 1 per accepted timestep.
  //
  // ngspice pre-allocates this in trasetup.c:62 as `TMALLOC(double, 15)`
  // (5 entries × 3 doubles, zero-initialized). The first CKTaccept (post-
  // DCOP, simTime=0, sizeDelay=0) reads delays[0].t and delays[2].t (=
  // delays+6) — both 0 from TMALLOC — and the shift / append predicates
  // both no-op (0-0 is not > minBreak, -td is not > 0). digiTS needs the
  // same zero-initialized contents at index 0 (and indices 1-2 for the
  // shift block to read safely once sizeDelay grows ≥ 2 pre-MODEINITTRAN).
  // Seed with three zero samples to match ngspice's behavior bit-for-bit.
  private _delays: DelaySample[] = [
    { t: 0, v1: 0, v2: 0 },
    { t: 0, v1: 0, v2: 0 },
    { t: 0, v1: 0, v2: 0 },
  ];
  // Index of last valid entry (ngspice TRAsizeDelay; 2 after MODEINITTRAN seed).
  private _sizeDelay = 0;

  // RHS contributions held across NR iterations within one step
  // (ngspice TRAinput1/TRAinput2). Refreshed in MODEINITPRED; held otherwise.
  private _input1 = 0;
  private _input2 = 0;

  // Refs/values cached during load() for use in acceptStep().
  // acceptStep takes (simTime, addBreakpoint, atBreakpoint) — no ctx — so the
  // ngspice CKT* fields it needs (rhsOld, deltaOld, minBreak) are stashed at
  // load() time. The Float64Array and readonly[] references are stable for
  // the engine lifetime, so a single cache pass is sufficient.
  private _rhsOldRef: Float64Array | null = null;
  private _deltaOldRef: readonly number[] | null = null;
  private _minBreak = 0;

  constructor(pinNodes: ReadonlyMap<string, number>, Z0: number, td: number) {
    super(pinNodes);
    this._Z0 = Z0;
    this._td = td;
    this._G = 1 / Z0;
  }

  setup(ctx: SetupContext): void {
    // cite: trasetup.c — pin order ["P1+","P1-","P2+","P2-"] (tra.c:32-37)
    // mapped to our pin labels: P1b/P1a/P2b/P2a.
    const p1b = this.pinNodes.get("P1b");
    const p1a = this.pinNodes.get("P1a");
    const p2b = this.pinNodes.get("P2b");
    const p2a = this.pinNodes.get("P2a");
    if (p1b === undefined || p1a === undefined || p2b === undefined || p2a === undefined) {
      throw new Error(
        `TransmissionLine '${this.label}': missing pin nodes ` +
        `(P1b=${p1b}, P1a=${p1a}, P2b=${p2b}, P2a=${p2a}).`,
      );
    }
    this._posNode1 = p1b;
    this._negNode1 = p1a;
    this._posNode2 = p2b;
    this._negNode2 = p2a;

    // Allocation order MUST match ngspice: branch equations FIRST (i1, i2),
    // then internal nodes (int1, int2). trasetup.c:37-58 calls CKTmkVolt in
    // exactly that order; the node-ID assignments ripple into every matrix
    // (row, col) — a different allocation order produces a permuted matrix
    // that fails the harness's structural-equality check.
    this._ibr1 = ctx.makeCur(this.label, "i1");
    this._ibr2 = ctx.makeCur(this.label, "i2");
    this._int1 = ctx.makeVolt(this.label, "int1");
    this._int2 = ctx.makeVolt(this.label, "int2");

    // cite: trasetup.c:71-92 — 22 TSTALLOC entries (allocate matrix slots)
    const s = ctx.solver;
    this._hIbr1Ibr2 = s.allocElement(this._ibr1, this._ibr2);
    this._hIbr1Int1 = s.allocElement(this._ibr1, this._int1);
    this._hIbr1Neg1 = s.allocElement(this._ibr1, this._negNode1);
    this._hIbr1Neg2 = s.allocElement(this._ibr1, this._negNode2);
    this._hIbr1Pos2 = s.allocElement(this._ibr1, this._posNode2);
    this._hIbr2Ibr1 = s.allocElement(this._ibr2, this._ibr1);
    this._hIbr2Int2 = s.allocElement(this._ibr2, this._int2);
    this._hIbr2Neg1 = s.allocElement(this._ibr2, this._negNode1);
    this._hIbr2Neg2 = s.allocElement(this._ibr2, this._negNode2);
    this._hIbr2Pos1 = s.allocElement(this._ibr2, this._posNode1);
    this._hInt1Ibr1 = s.allocElement(this._int1, this._ibr1);
    this._hInt1Int1 = s.allocElement(this._int1, this._int1);
    this._hInt1Pos1 = s.allocElement(this._int1, this._posNode1);
    this._hInt2Ibr2 = s.allocElement(this._int2, this._ibr2);
    this._hInt2Int2 = s.allocElement(this._int2, this._int2);
    this._hInt2Pos2 = s.allocElement(this._int2, this._posNode2);
    this._hNeg1Ibr1 = s.allocElement(this._negNode1, this._ibr1);
    this._hNeg2Ibr2 = s.allocElement(this._negNode2, this._ibr2);
    this._hPos1Int1 = s.allocElement(this._posNode1, this._int1);
    this._hPos1Pos1 = s.allocElement(this._posNode1, this._posNode1);
    this._hPos2Int2 = s.allocElement(this._posNode2, this._int2);
    this._hPos2Pos2 = s.allocElement(this._posNode2, this._posNode2);
  }

  getInternalNodeLabels(): readonly string[] {
    return ["int1", "int2", "i1", "i2"];
  }

  load(ctx: LoadContext): void {
    const s = ctx.solver;
    const G = this._G;
    const Z0 = this._Z0;
    const td = this._td;
    const mode = ctx.cktMode;

    // Cache ctx fields needed by acceptStep().
    this._rhsOldRef = ctx.rhsOld;
    this._deltaOldRef = ctx.deltaOld;
    this._minBreak = ctx.minBreak;

    // cite: traload.c:36-51 — unconditional 16-stamp block
    s.stampElement(this._hPos1Pos1, +G);
    s.stampElement(this._hPos1Int1, -G);
    s.stampElement(this._hNeg1Ibr1, -1);
    s.stampElement(this._hPos2Pos2, +G);
    s.stampElement(this._hNeg2Ibr2, -1);
    s.stampElement(this._hInt1Pos1, -G);
    s.stampElement(this._hInt1Int1, +G);
    s.stampElement(this._hInt1Ibr1, +1);
    s.stampElement(this._hInt2Int2, +G);
    s.stampElement(this._hInt2Ibr2, +1);
    s.stampElement(this._hIbr1Neg1, -1);
    s.stampElement(this._hIbr1Int1, +1);
    s.stampElement(this._hIbr2Neg2, -1);
    s.stampElement(this._hIbr2Int2, +1);
    s.stampElement(this._hPos2Int2, -G);
    s.stampElement(this._hInt2Pos2, -G);

    if (mode & MODEDC) {
      // cite: traload.c:53-59 — MODEDC bridge stamps couple ports directly
      // with a -(1 - CKTgmin)*Z entry on the branch-row diagonals.
      // cite: traload.c:56 reads ckt->CKTgmin (static, default 1e-12) — NOT
      // CKTdiagGmin. ctx.cktGmin carries that exact value.
      const dcZ = (1 - ctx.cktGmin) * Z0;
      s.stampElement(this._hIbr1Pos2, -1);
      s.stampElement(this._hIbr1Neg2, +1);
      s.stampElement(this._hIbr1Ibr2, -dcZ);
      s.stampElement(this._hIbr2Pos1, -1);
      s.stampElement(this._hIbr2Neg1, +1);
      s.stampElement(this._hIbr2Ibr1, -dcZ);
      return;
    }

    // ---- Transient branch (cite: traload.c:60-146) ----

    if (mode & MODEINITTRAN) {
      // cite: traload.c:62-86 — first transient step: seed history table.
      // UIC branch (traload.c:62-66) reads TRAinitVolt1/2 and TRAinitCur1/2;
      // those parameters are not exposed on our TransmissionLine model, so
      // we always take the rhsOld-based seeding path (c:67-78). MODEUIC
      // support would require adding IC params to TRANSMISSION_LINE_PARAM_DEFS.
      const rhsOld = ctx.rhsOld;
      this._input1 = (rhsOld[this._posNode2]! - rhsOld[this._negNode2]!) + rhsOld[this._ibr2]! * Z0;
      this._input2 = (rhsOld[this._posNode1]! - rhsOld[this._negNode1]!) + rhsOld[this._ibr1]! * Z0;
      // cite: traload.c:79-86 — three samples at t = -2*td, -td, 0
      // all carrying the same seed values.
      this._delays = [
        { t: -2 * td, v1: this._input1, v2: this._input2 },
        { t: -td,     v1: this._input1, v2: this._input2 },
        { t: 0,       v1: this._input1, v2: this._input2 },
      ];
      this._sizeDelay = 2;
    } else if (mode & MODEINITPRED) {
      // cite: traload.c:88-141 — quadratic interpolation at (CKTtime - td)
      // in the history table.
      const target = ctx.time - td;
      // c:89-91 — walk the table to find the bracket. Stop at first i where
      // delays[i].t > target, or i == sizeDelay.
      let i = 2;
      while (i < this._sizeDelay && this._delays[i]!.t <= target) i++;
      // c:92-94 — three consecutive samples at indices i-2, i-1, i
      const t1 = this._delays[i - 2]!.t;
      const t2 = this._delays[i - 1]!.t;
      const t3 = this._delays[i]!.t;
      // c:95 — bail out if any consecutive gap is zero
      if ((t2 - t1) === 0 || (t3 - t2) === 0) {
        // Hold previous _input1/_input2 (the `continue` in source skips RHS
        // update too — match that by skipping the stamp below).
      } else {
        // c:96-101 — Lagrange-quadratic numerators
        let f1 = (target - t2) * (target - t3);
        let f2 = (target - t1) * (target - t3);
        let f3 = (target - t1) * (target - t2);
        // c:102-125 — Lagrange weights f_i = prod_{j≠i}(u-t_j) / prod_{j≠i}(t_i-t_j).
        // Each (t_a-t_b) denominator factor is applied in whichever sign the
        // surrounding (t_a-t_b)==0 guard chose, so f3's two factors land as
        // (t2-t3) and (t1-t3) instead of the textbook (t3-t2)(t3-t1). Both
        // signs flip ⇒ the product is the correct (t3-t2)(t3-t1). Bit-correct
        // to ngspice, not a typo.
        if ((t2 - t1) === 0) { f1 = 0; f2 = 0; }
        else { f1 /= (t1 - t2); f2 /= (t2 - t1); }
        if ((t3 - t2) === 0) { f2 = 0; f3 = 0; }
        else { f2 /= (t2 - t3); f3 /= (t2 - t3); }
        if ((t3 - t1) === 0) { f1 = 0; f2 = 0; }
        else { f1 /= (t1 - t3); f3 /= (t1 - t3); }
        // c:136-141 — apply weights to the three samples' v1/v2 fields
        const s1 = this._delays[i - 2]!;
        const s2 = this._delays[i - 1]!;
        const s3 = this._delays[i]!;
        this._input1 = f1 * s1.v1 + f2 * s2.v1 + f3 * s3.v1;
        this._input2 = f1 * s1.v2 + f2 * s2.v2 + f3 * s3.v2;
      }
    }
    // else: mid-NR iteration — hold _input1/_input2 from the last
    // MODEINITPRED (or MODEINITTRAN). No update.

    // cite: traload.c:144-145 — RHS stamps run for every non-DC NR iteration.
    stampRHS(ctx.rhs, this._ibr1, this._input1);
    stampRHS(ctx.rhs, this._ibr2, this._input2);
  }

  acceptStep(simTime: number, addBreakpoint: (t: number) => void, _atBreakpoint: boolean): void {
    // cite: traacct.c — runs once per accepted timestep, at the top of the
    // nextTime: iteration body (dctran.c:410). analog-engine.ts:311-324
    // dispatches at the same structural point. On the first call
    // (post-DCOP, simTime=0, _sizeDelay=0, MODEINITTRAN not yet run) both
    // the shift and append predicates evaluate false against the three
    // zero-initialized samples seeded in _delays, matching ngspice's
    // TMALLOC(15)-backed no-op exactly. _rhsOldRef / _deltaOldRef are
    // guaranteed non-null here because load() ran during DCOP first.
    const rhsOld = this._rhsOldRef!;
    const deltaOld = this._deltaOldRef!;
    const td = this._td;
    const Z0 = this._Z0;
    const minBreak = this._minBreak;

    // cite: traacct.c:34-48 — shift the table left to discard stale entries.
    // ngspice: `if (CKTtime - TRAtd > delays[6])` where delays[6] = delays[2].t
    // (third sample's timestamp).
    if (this._sizeDelay >= 2 && (simTime - td) > this._delays[2]!.t) {
      // c:36-38 — find the first index whose t > simTime - td, then step back 2
      // to keep a 3-sample window around the target time.
      let i = 2;
      while (i < this._sizeDelay && (simTime - td) > this._delays[i]!.t) i++;
      i -= 2;
      // c:40-46 — shift window left by i positions
      for (let j = i; j <= this._sizeDelay; j++) {
        this._delays[j - i] = this._delays[j]!;
      }
      this._sizeDelay -= i;
    }

    // cite: traacct.c:49-50 — append a new sample if the gap since the last
    // sample exceeds CKTminBreak. The `<=` predicate in dctran's pop dedup
    // matches this `>` predicate here.
    if (simTime - this._delays[this._sizeDelay]!.t > minBreak) {
      this._sizeDelay++;
      // c:58-68 — new sample is the converged port-2 / port-1 inputs
      // computed from rhsOld.
      const newV1 = (rhsOld[this._posNode2]! - rhsOld[this._negNode2]!) + rhsOld[this._ibr2]! * Z0;
      const newV2 = (rhsOld[this._posNode1]! - rhsOld[this._negNode1]!) + rhsOld[this._ibr1]! * Z0;
      this._delays[this._sizeDelay] = { t: simTime, v1: newV1, v2: newV2 };

      // cite: traacct.c:94-123 — second-derivative breakpoint test (the
      // #ifndef NOTDEF branch is the live one). Schedule a breakpoint at
      // (previous sample's t + td) if either v1 or v2 derivative is changing
      // beyond the per-instance reltol/abstol thresholds.
      if (this._sizeDelay >= 2 && deltaOld[0]! !== 0 && deltaOld[1]! !== 0) {
        const v1 = this._delays[this._sizeDelay]!.v1;
        const v2 = this._delays[this._sizeDelay - 1]!.v1;
        const v3 = this._delays[this._sizeDelay - 2]!.v1;
        const v4 = this._delays[this._sizeDelay]!.v2;
        const v5 = this._delays[this._sizeDelay - 1]!.v2;
        const v6 = this._delays[this._sizeDelay - 2]!.v2;
        const d1 = (v1 - v2) / deltaOld[0]!;
        const d2 = (v2 - v3) / deltaOld[1]!;
        const d3 = (v4 - v5) / deltaOld[0]!;
        const d4 = (v5 - v6) / deltaOld[1]!;
        // c:106-109 — tolerance check
        const tol12 = this._reltol * Math.max(Math.abs(d1), Math.abs(d2)) + this._abstol;
        const tol34 = this._reltol * Math.max(Math.abs(d3), Math.abs(d4)) + this._abstol;
        if (Math.abs(d1 - d2) >= tol12 || Math.abs(d3 - d4) >= tol34) {
          // c:119-122 — break is scheduled at delays[sizeDelay - 1].t + td
          // (the time of the PREVIOUS sample, not the current one).
          addBreakpoint(this._delays[this._sizeDelay - 1]!.t + td);
        }
      }
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    // pinLayout order: [P1b, P2b, P1a, P2a]
    //   P1b → pos1: current entering Z0 = +ibr1
    //   P2b → pos2: symmetric = +ibr2
    //   P1a → neg1: leaving back to the return = -ibr1
    //   P2a → neg2: symmetric = -ibr2
    const i1 = rhs[this._ibr1]!;
    const i2 = rhs[this._ibr2]!;
    return [+i1, +i2, -i1, -i2];
  }

  setParam(key: string, value: number): void {
    // cite: traparam.c:32-39 — TRA_Z0 / TRA_TD param handlers
    if (key === "impedance") {
      this._Z0 = value;
      this._G = 1 / value;
      return;
    }
    if (key === "delay") {
      this._td = value;
      return;
    }
    if (key === "lossPerMeter") {
      if (value > 0) {
        throw new Error(
          `TransmissionLine '${this.label}': lossPerMeter > 0 requires the ` +
          `LTRA model (ngspice 'O' element), not yet ported.`,
        );
      }
      return;
    }
    throw new Error(`TransmissionLine '${this.label}': unknown param '${key}'`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTransmissionLineElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const lossPerMeter = props.getModelParam<number>("lossPerMeter");
  if (lossPerMeter > 0) {
    throw new Error(
      `TransmissionLine: lossPerMeter=${lossPerMeter} > 0 requires the LTRA ` +
      `model (ngspice 'O' element), not yet ported. Use lossPerMeter = 0 for ` +
      `now; the lossy_open_end fixture is failing-by-design until LTRA lands.`,
    );
  }
  const Z0 = props.getModelParam<number>("impedance");
  const td = props.getModelParam<number>("delay");
  return new TransmissionLineAnalogElement(pinNodes, Z0, td);
}
