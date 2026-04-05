export class StatePool {
  /** Current operating point state. */
  readonly state0: Float64Array;
  /** Previous accepted timestep (for trapezoidal/BDF-2). */
  readonly state1: Float64Array;
  /** Two timesteps ago (for BDF-2 only). */
  readonly state2: Float64Array;
  readonly totalSlots: number;

  constructor(totalSlots: number) {
    this.totalSlots = totalSlots;
    this.state0 = new Float64Array(totalSlots);
    this.state1 = new Float64Array(totalSlots);
    this.state2 = new Float64Array(totalSlots);
  }

  /** Copy history after accepted timestep: state2.set(state1); state1.set(state0). */
  acceptTimestep(): void {
    this.state2.set(this.state1);
    this.state1.set(this.state0);
  }

  /** Zero all vectors. */
  reset(): void {
    this.state0.fill(0);
    this.state1.fill(0);
    this.state2.fill(0);
  }
}
