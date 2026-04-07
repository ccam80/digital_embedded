export class StatePool {
  /** Ring buffer of state arrays. [0]=current, [1]=prev, [2]=prev2, [3]=prev3. */
  states: Float64Array[];
  readonly totalSlots: number;

  constructor(totalSlots: number) {
    this.totalSlots = totalSlots;
    this.states = [
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
      new Float64Array(totalSlots),
    ];
  }

  /** Backward-compatible accessors. */
  get state0(): Float64Array { return this.states[0]; }
  get state1(): Float64Array { return this.states[1]; }
  get state2(): Float64Array { return this.states[2]; }
  get state3(): Float64Array { return this.states[3]; }

  /**
   * Rotate pointer ring after accepted timestep, then seed s0 from s1.
   * The seed copy ensures stampLinear sees valid operating-point data
   * for nonlinear elements on the first NR iteration.
   */
  acceptTimestep(): void {
    const recycled = this.states[3];
    this.states[3] = this.states[2];
    this.states[2] = this.states[1];
    this.states[1] = this.states[0];
    this.states[0] = recycled;
    // Seed s0 from s1 so nonlinear elements have valid initial stamp data
    this.states[0].set(this.states[1]);
  }

  /** Update all pool-backed elements' s0/s1/s2/s3 references after rotation. */
  refreshElementRefs(elements: readonly { poolBacked?: true; s0?: Float64Array; s1?: Float64Array; s2?: Float64Array; s3?: Float64Array }[]): void {
    const s0 = this.states[0];
    const s1 = this.states[1];
    const s2 = this.states[2];
    const s3 = this.states[3];
    for (const el of elements) {
      if (el.poolBacked) {
        (el as { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array }).s0 = s0;
        (el as { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array }).s1 = s1;
        (el as { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array }).s2 = s2;
        (el as { s0: Float64Array; s1: Float64Array; s2: Float64Array; s3: Float64Array }).s3 = s3;
      }
    }
  }

  /** Zero all state arrays. */
  reset(): void {
    for (const buf of this.states) buf.fill(0);
  }

  /** Seed history from current operating point (post-DCOP). */
  seedHistory(): void {
    const s0 = this.states[0];
    this.states[1].set(s0);
    this.states[2].set(s0);
    this.states[3].set(s0);
  }
}
