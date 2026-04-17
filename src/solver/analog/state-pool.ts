import type { PoolBackedAnalogElementCore } from "./element.js";

export class StatePool {
  /** Ring buffer of state arrays. [0]=current, [1]=prev, [2]=prev2, [3]=prev3. */
  states: Float64Array[];
  readonly totalSlots: number;
  tranStep: number = 0;

  /**
   * Current DC-OP mode (niiter.c:991-997).
   * Driven by dcopModeLadder inside newtonRaphson().
   * Reset to "transient" when reset() is called.
   * "transient" means no DC-OP mode constraint (normal transient NR).
   */
  initMode: "initJct" | "initFix" | "initFloat" | "initTran" | "initPred" | "initSmsig" | "transient" = "transient";

  /**
   * Analysis mode — distinguishes DC-OP from transient NR iterations.
   * Maps to ngspice CKTmode bit flags:
   *   "dcOp" ↔ MODEDCOP | MODETRANOP (bjtload.c:249, dctran.c:346-348 pre-flip)
   *   "tran" ↔ MODETRAN | MODEINITTRAN (dctran.c:346)
   * Used by semiconductor elements to decide whether to scale capacitor
   * feedback conductances (geqcb) by CKTag[0] (= 1/dt for TRAP order-1).
   * Flipped to "tran" in dc-operating-point.ts after DC-OP converges and
   * the first transient step begins (ngspice dctran.c:346).
   */
  analysisMode: "dcOp" | "tran" = "dcOp";

  /**
   * Current integration timestep (dt) for the transient step being loaded.
   * Written by the analog engine before each stamp/NR pass so that element
   * stampCompanion methods can derive the integration coefficient locally
   * (ag0 = 1/dt for TRAP order-1, matching NIcomCof in nicomcof.c:33-51).
   * During DC-OP this stays 0 (no time elapsed), so ag0 = 0 — matching
   * dctran.c:348 where CKTag[0] is zeroed before the first transient step.
   */
  dt: number = 0;

  /**
   * Circuit operating temperature in Kelvin. Maps to ngspice CKTtemp.
   * Default 300.15 K (REFTEMP). Used by passive elements for TC1/TC2
   * temperature coefficient computation.
   */
  temperature: number = 300.15;

  /**
   * Integration coefficients shared across all elements (ngspice CKTag[]).
   * Size 8 to support GEAR orders 3-6 in future. ag[0] = 1/dt for BDF-1/TRAP,
   * ag[1] = -1/dt. Zeroed at DCOP-to-transient transition (dctran.c:348).
   * Computed each transient step by computeNIcomCof() (task 3.2.1).
   */
  ag: Float64Array = new Float64Array(8);

  constructor(totalSlots: number) {
    this.totalSlots = totalSlots;
    this.states = [
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
    ];
  }

  get state0(): Float64Array { return this.states[0]; }
  get state1(): Float64Array { return this.states[1]; }
  get state2(): Float64Array { return this.states[2]; }
  get state3(): Float64Array { return this.states[3]; }
  get state4(): Float64Array { return this.states[4]; }
  get state5(): Float64Array { return this.states[5]; }
  get state6(): Float64Array { return this.states[6]; }
  get state7(): Float64Array { return this.states[7]; }

  /** Update all pool-backed elements' s0-s7 references after rotation. */
  refreshElementRefs(elements: readonly { poolBacked?: boolean }[]): void {
    const s0 = this.states[0];
    const s1 = this.states[1];
    const s2 = this.states[2];
    const s3 = this.states[3];
    const s4 = this.states[4];
    const s5 = this.states[5];
    const s6 = this.states[6];
    const s7 = this.states[7];
    for (const el of elements) {
      if (!el.poolBacked) continue;
      const pel = el as PoolBackedAnalogElementCore;
      pel.s0 = s0;
      pel.s1 = s1;
      pel.s2 = s2;
      pel.s3 = s3;
      pel.s4 = s4;
      pel.s5 = s5;
      pel.s6 = s6;
      pel.s7 = s7;
      pel.refreshSubElementRefs?.(s0, s1, s2, s3, s4, s5, s6, s7);
    }
  }

  /**
   * Ring rotation of state arrays — pointer swap, not data copy.
   * After rotation: states[0] is fresh recycled storage (was states[n-1]),
   * states[1] = previous states[0], states[2] = previous states[1], etc.
   * Matches ngspice dctran.c:715-723 state rotation before the retry loop.
   */
  rotateStateVectors(): void {
    const recycled = this.states[this.states.length - 1];
    for (let i = this.states.length - 1; i > 0; i--) {
      this.states[i] = this.states[i - 1];
    }
    this.states[0] = recycled;
  }

  /** Zero all state arrays and integration coefficients. */
  reset(): void {
    for (const buf of this.states) buf.fill(0);
    this.tranStep = 0;
    this.initMode = "transient";
    this.analysisMode = "dcOp";
    this.dt = 0;
    this.ag.fill(0);
  }

  /**
   * Seed state2 through state7 from state1 (ngspice dctran.c:782-786).
   * Called after first transient step acceptance.
   */
  seedFromState1(): void {
    const s1 = this.states[1];
    this.states[2].set(s1);
    this.states[3].set(s1);
    this.states[4].set(s1);
    this.states[5].set(s1);
    this.states[6].set(s1);
    this.states[7].set(s1);
  }

  /** Seed history from current operating point (post-DCOP). */
  seedHistory(): void {
    const s0 = this.states[0];
    this.states[1].set(s0);
    this.states[2].set(s0);
    this.states[3].set(s0);
    this.states[4].set(s0);
    this.states[5].set(s0);
    this.states[6].set(s0);
    this.states[7].set(s0);
  }
}
