/**
 * Forward reference to StatePool used by element interfaces.
 *
 * The `StatePool` class below structurally satisfies this interface; the
 * interface exists so type-only consumers (element.ts, etc.) can refer to a
 * pool's read shape without having to import the class itself.
 */
export interface StatePoolRef {
  readonly states: readonly Float64Array[];
  readonly state0: Float64Array;
  readonly state1: Float64Array;
  readonly state2: Float64Array;
  readonly state3: Float64Array;
  readonly state4: Float64Array;
  readonly state5: Float64Array;
  readonly state6: Float64Array;
  readonly state7: Float64Array;
  readonly totalSlots: number;
  /** Number of accepted transient steps. 0 = MODEINITTRAN equivalent. */
  readonly tranStep: number;
  /**
   * Current transient integration timestep written by the engine before each
   * stamp pass. 0 during DC-OP. Used by elements to derive ag0 locally
   * (NIcomCof equivalent, nicomcof.c:33-51).
   */
  readonly dt?: number;
  /**
   * Circuit operating temperature in Kelvin. Absent → 300.15 K (REFTEMP).
   * Maps to ngspice CKTtemp. Used by passive elements (capacitor, inductor)
   * for TC1/TC2 temperature coefficient computation.
   */
  readonly temperature?: number;
}

export class StatePool {
  /** Ring buffer of state arrays. [0]=current, [1]=prev, [2]=prev2, [3]=prev3. */
  states: Float64Array[];
  readonly totalSlots: number;
  tranStep: number = 0;

  /**
   * Current integration timestep (dt) for the transient step being loaded.
   * Written by the analog engine before each stamp/NR pass so that element
   * stampCompanion methods can derive the integration coefficient locally
   * (ag0 = 1/dt for TRAP order-1, matching NIcomCof in nicomcof.c:33-51).
   * During DC-OP this stays 0 (no time elapsed), so ag0 = 0- matching
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
   * Maximum integration order- mirrors ngspice CKTmaxOrder
   * (cktdojob.c:53 sets `CKTmaxOrder = TSKmaxOrder` once per job; default 2
   * for trapezoidal). Bounds the rotation ring in `rotateStateVectors()` to
   * exactly slots `0..maxOrder+1`, matching `dctran.c:719-723`. Slots above
   * `maxOrder+1` are inert (never rotated, never read by integration), the
   * digiTS analog of ngspice not allocating them at all
   * (`cktsetup.c:82-83` allocates only slots `0..MAX(2,maxOrder)+1`).
   *
   * Set once at engine init from `SimulationParams.maxOrder`; do not mutate
   * mid-simulation. Default 2 = TRAP, also the ngspice default
   * (`cktinit.c:65`).
   */
  maxOrder: number = 2;

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

  /**
   * Ring rotation of state arrays- pointer swap, not data copy. Mirrors
   * ngspice `dctran.c:719-723`:
   *
   *   temp = ckt->CKTstates[ckt->CKTmaxOrder+1];
   *   for(i=ckt->CKTmaxOrder; i>=0; i--)
   *     ckt->CKTstates[i+1] = ckt->CKTstates[i];
   *   ckt->CKTstates[0] = temp;
   *
   * The ring spans slots `0..maxOrder+1` exactly- slots above `maxOrder+1`
   * are NOT rotated. They stay at construction-zero, matching ngspice's
   * allocator (`cktsetup.c:82-83`) which never allocates above
   * `MAX(2,maxOrder)+1`. Without this bound, slots beyond the integration
   * window would carry stale rotated data into any future Gear-order
   * configuration that reaches them.
   */
  rotateStateVectors(): void {
    const top = this.maxOrder + 1;
    const recycled = this.states[top];
    for (let i = top; i > 0; i--) {
      this.states[i] = this.states[i - 1];
    }
    this.states[0] = recycled;
  }

  /** Zero all state arrays. Integration coefficients live on CKTCircuitContext.ag. */
  reset(): void {
    for (const buf of this.states) buf.fill(0);
    this.tranStep = 0;
    this.dt = 0;
  }

  /**
   * Copy state1 into state2 and state3 only- matches ngspice dctran.c:795-799
   * exactly (both placement-inside-for(;;)-loop and width).
   *
   *   if(firsttime) {
   *       for(i=0;i<ckt->CKTnumStates;i++) {
   *           ckt->CKTstate2[i] = ckt->CKTstate1[i];
   *           ckt->CKTstate3[i] = ckt->CKTstate1[i];
   *       }
   *   }
   *
   * Called by analog-engine.ts inside the transient retry loop, on every
   * outer iteration while _stepCount === 0 (firsttime).
   */
  copyState1ToState23(): void {
    const s1 = this.states[1];
    this.states[2].set(s1);
    this.states[3].set(s1);
  }

}
