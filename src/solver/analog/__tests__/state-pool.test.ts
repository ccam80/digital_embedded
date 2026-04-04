import { describe, it, expect } from 'vitest';
import { StatePool } from '../state-pool';

describe('StatePool', () => {
  describe('constructor', () => {
    it('allocates three Float64Array vectors of the given size', () => {
      const pool = new StatePool(10);
      expect(pool.state0).toBeInstanceOf(Float64Array);
      expect(pool.state1).toBeInstanceOf(Float64Array);
      expect(pool.state2).toBeInstanceOf(Float64Array);
      expect(pool.state0.length).toBe(10);
      expect(pool.state1.length).toBe(10);
      expect(pool.state2.length).toBe(10);
    });

    it('sets totalSlots', () => {
      const pool = new StatePool(7);
      expect(pool.totalSlots).toBe(7);
    });

    it('initialises all vectors to zero', () => {
      const pool = new StatePool(5);
      expect(Array.from(pool.state0)).toEqual([0, 0, 0, 0, 0]);
      expect(Array.from(pool.state1)).toEqual([0, 0, 0, 0, 0]);
      expect(Array.from(pool.state2)).toEqual([0, 0, 0, 0, 0]);
    });

    it('works with totalSlots of 0', () => {
      const pool = new StatePool(0);
      expect(pool.totalSlots).toBe(0);
      expect(pool.state0.length).toBe(0);
    });
  });

  describe('checkpoint()', () => {
    it('returns a deep copy of state0', () => {
      const pool = new StatePool(4);
      pool.state0.set([1.0, 2.0, 3.0, 4.0]);

      const cp = pool.checkpoint(0.001);

      expect(Array.from(cp.state0)).toEqual([1.0, 2.0, 3.0, 4.0]);
    });

    it('stores simTime in the checkpoint', () => {
      const pool = new StatePool(3);
      const cp = pool.checkpoint(0.005);
      expect(cp.simTime).toBe(0.005);
    });

    it('checkpoint is independent — mutating state0 after checkpoint does not affect checkpoint', () => {
      const pool = new StatePool(4);
      pool.state0.set([1.0, 2.0, 3.0, 4.0]);

      const cp = pool.checkpoint(0.001);

      // Modify state0 after taking checkpoint
      pool.state0[0] = 99.0;
      pool.state0[3] = 88.0;

      // Checkpoint values must be unchanged
      expect(cp.state0[0]).toBe(1.0);
      expect(cp.state0[3]).toBe(4.0);
    });

    it('returns a different Float64Array instance from state0', () => {
      const pool = new StatePool(4);
      const cp = pool.checkpoint(0.0);
      expect(cp.state0).not.toBe(pool.state0);
    });
  });

  describe('rollback()', () => {
    it('restores state0 from checkpoint', () => {
      const pool = new StatePool(4);
      pool.state0.set([1.0, 2.0, 3.0, 4.0]);

      const cp = pool.checkpoint(0.001);

      // Corrupt state0 to simulate a failed NR iteration
      pool.state0.set([9.0, 8.0, 7.0, 6.0]);

      pool.rollback(cp);

      expect(Array.from(pool.state0)).toEqual([1.0, 2.0, 3.0, 4.0]);
    });

    it('does not modify state1 or state2 on rollback', () => {
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);

      const cp = pool.checkpoint(0.0);

      pool.state0.set([5.0, 5.0, 5.0]);
      pool.rollback(cp);

      expect(Array.from(pool.state1)).toEqual([10.0, 20.0, 30.0]);
      expect(Array.from(pool.state2)).toEqual([100.0, 200.0, 300.0]);
    });

    it('rollback does not share memory with the checkpoint — further mutations are independent', () => {
      const pool = new StatePool(2);
      pool.state0.set([1.0, 2.0]);
      const cp = pool.checkpoint(0.0);

      pool.state0.set([9.0, 9.0]);
      pool.rollback(cp);

      // Now mutate state0 again — checkpoint must remain unchanged
      pool.state0[0] = 42.0;
      expect(cp.state0[0]).toBe(1.0);
    });
  });

  describe('acceptTimestep()', () => {
    it('shifts history: state2 ← state1, state1 ← state0', () => {
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);

      pool.acceptTimestep();

      expect(Array.from(pool.state2)).toEqual([10.0, 20.0, 30.0]);
      expect(Array.from(pool.state1)).toEqual([1.0, 2.0, 3.0]);
    });

    it('does not modify state0 during acceptTimestep', () => {
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);

      pool.acceptTimestep();

      expect(Array.from(pool.state0)).toEqual([1.0, 2.0, 3.0]);
    });

    it('state1 and state2 are independent after acceptTimestep — mutating state1 does not affect state2', () => {
      const pool = new StatePool(2);
      pool.state0.set([5.0, 6.0]);
      pool.state1.set([1.0, 2.0]);
      pool.state2.set([0.0, 0.0]);

      pool.acceptTimestep();

      // state2 should now hold old state1 values
      expect(Array.from(pool.state2)).toEqual([1.0, 2.0]);
      expect(Array.from(pool.state1)).toEqual([5.0, 6.0]);

      // Mutating state1 should not affect state2
      pool.state1[0] = 99.0;
      expect(pool.state2[0]).toBe(1.0);
    });

    it('consecutive acceptTimestep calls shift correctly', () => {
      const pool = new StatePool(2);
      pool.state0.set([1.0, 1.0]);
      pool.state1.set([2.0, 2.0]);
      pool.state2.set([3.0, 3.0]);

      pool.acceptTimestep();
      // state0=[1,1], state1=[1,1], state2=[2,2]

      pool.state0.set([4.0, 4.0]);
      pool.acceptTimestep();
      // state0=[4,4], state1=[4,4], state2=[1,1]

      expect(Array.from(pool.state2)).toEqual([1.0, 1.0]);
      expect(Array.from(pool.state1)).toEqual([4.0, 4.0]);
      expect(Array.from(pool.state0)).toEqual([4.0, 4.0]);
    });
  });

  describe('reset()', () => {
    it('zeros all three vectors', () => {
      const pool = new StatePool(4);
      pool.state0.set([1.0, 2.0, 3.0, 4.0]);
      pool.state1.set([5.0, 6.0, 7.0, 8.0]);
      pool.state2.set([9.0, 10.0, 11.0, 12.0]);

      pool.reset();

      expect(Array.from(pool.state0)).toEqual([0, 0, 0, 0]);
      expect(Array.from(pool.state1)).toEqual([0, 0, 0, 0]);
      expect(Array.from(pool.state2)).toEqual([0, 0, 0, 0]);
    });

    it('reset on a zero-slot pool does not throw', () => {
      const pool = new StatePool(0);
      expect(() => pool.reset()).not.toThrow();
    });
  });

  describe('allocation loop — offset assignment (mirrors compiler logic)', () => {
    it('elements with stateSize 0 get stateBaseOffset -1', () => {
      const elements: Array<{ stateSize: number; stateBaseOffset: number; initState?: (pool: StatePool) => void }> = [
        { stateSize: 0, stateBaseOffset: -1 },
        { stateSize: 0, stateBaseOffset: -1 },
      ];

      let stateOffset = 0;
      for (const el of elements) {
        const size = el.stateSize ?? 0;
        if (size > 0) {
          el.stateBaseOffset = stateOffset;
          stateOffset += size;
        } else {
          el.stateBaseOffset = -1;
        }
      }
      const pool = new StatePool(stateOffset);

      expect(elements[0]!.stateBaseOffset).toBe(-1);
      expect(elements[1]!.stateBaseOffset).toBe(-1);
      expect(pool.totalSlots).toBe(0);
    });

    it('elements with stateSize > 0 get contiguous non-overlapping offsets', () => {
      const elements: Array<{ stateSize: number; stateBaseOffset: number }> = [
        { stateSize: 4, stateBaseOffset: -1 },
        { stateSize: 10, stateBaseOffset: -1 },
        { stateSize: 3, stateBaseOffset: -1 },
      ];

      let stateOffset = 0;
      for (const el of elements) {
        const size = el.stateSize ?? 0;
        if (size > 0) {
          el.stateBaseOffset = stateOffset;
          stateOffset += size;
        } else {
          el.stateBaseOffset = -1;
        }
      }
      const pool = new StatePool(stateOffset);

      expect(elements[0]!.stateBaseOffset).toBe(0);
      expect(elements[1]!.stateBaseOffset).toBe(4);
      expect(elements[2]!.stateBaseOffset).toBe(14);
      expect(pool.totalSlots).toBe(17);
    });

    it('mixed elements: zero-state elements are skipped in offset sequence', () => {
      const elements: Array<{ stateSize: number; stateBaseOffset: number }> = [
        { stateSize: 0, stateBaseOffset: -1 },  // linear resistor
        { stateSize: 4, stateBaseOffset: -1 },  // diode
        { stateSize: 0, stateBaseOffset: -1 },  // another linear
        { stateSize: 10, stateBaseOffset: -1 }, // BJT
      ];

      let stateOffset = 0;
      for (const el of elements) {
        const size = el.stateSize ?? 0;
        if (size > 0) {
          el.stateBaseOffset = stateOffset;
          stateOffset += size;
        } else {
          el.stateBaseOffset = -1;
        }
      }
      const pool = new StatePool(stateOffset);

      expect(elements[0]!.stateBaseOffset).toBe(-1);
      expect(elements[1]!.stateBaseOffset).toBe(0);
      expect(elements[2]!.stateBaseOffset).toBe(-1);
      expect(elements[3]!.stateBaseOffset).toBe(4);
      expect(pool.totalSlots).toBe(14);
    });

    it('initState is called for elements that declare it, and they can write to pool slots', () => {
      let initCalled = false;
      let capturedBase = -1;
      const SLOT_GEQ = 1;
      const GMIN = 1e-12;

      const elements: Array<{ stateSize: number; stateBaseOffset: number; initState?(pool: StatePool): void }> = [
        {
          stateSize: 4,
          stateBaseOffset: -1,
          initState(pool: StatePool): void {
            initCalled = true;
            capturedBase = this.stateBaseOffset;
            pool.state0[this.stateBaseOffset + SLOT_GEQ] = GMIN;
          },
        },
      ];

      let stateOffset = 0;
      for (const el of elements) {
        const size = el.stateSize ?? 0;
        if (size > 0) {
          el.stateBaseOffset = stateOffset;
          stateOffset += size;
        } else {
          el.stateBaseOffset = -1;
        }
      }
      const pool = new StatePool(stateOffset);
      for (const el of elements) {
        if (el.initState) el.initState(pool);
      }

      expect(initCalled).toBe(true);
      expect(capturedBase).toBe(0);
      expect(pool.state0[0 + SLOT_GEQ]).toBe(GMIN);
    });

    it('elements missing stateSize (existing elements without the field) default to 0 and get offset -1', () => {
      // Simulate existing elements that do not yet declare stateSize
      const elements: Array<{ stateBaseOffset: number; stateSize?: number }> = [
        { stateBaseOffset: -1 },
        { stateBaseOffset: -1 },
      ];

      let stateOffset = 0;
      for (const el of elements) {
        const size = el.stateSize ?? 0;
        if (size > 0) {
          (el as { stateBaseOffset: number }).stateBaseOffset = stateOffset;
          stateOffset += size;
        } else {
          (el as { stateBaseOffset: number }).stateBaseOffset = -1;
        }
      }
      const pool = new StatePool(stateOffset);

      expect(elements[0]!.stateBaseOffset).toBe(-1);
      expect(elements[1]!.stateBaseOffset).toBe(-1);
      expect(pool.totalSlots).toBe(0);
    });
  });

  describe('integration: checkpoint + rollback + acceptTimestep', () => {
    it('NR retry scenario: rollback restores state0 while state1/state2 remain from accepted history', () => {
      const pool = new StatePool(3);

      // Simulate DC convergence accepted as first timestep
      pool.state0.set([0.6, 0.001, 5.0]);
      pool.state1.set([0.6, 0.001, 5.0]);
      pool.state2.set([0.6, 0.001, 5.0]);

      // Take checkpoint before NR attempt
      const cp = pool.checkpoint(1e-6);

      // NR iteration modifies state0
      pool.state0.set([0.65, 0.002, 4.8]);

      // NR fails — rollback
      pool.rollback(cp);

      expect(Array.from(pool.state0)).toEqual([0.6, 0.001, 5.0]);
      // History unchanged
      expect(Array.from(pool.state1)).toEqual([0.6, 0.001, 5.0]);
      expect(Array.from(pool.state2)).toEqual([0.6, 0.001, 5.0]);
    });

    it('accepted timestep scenario: history advances correctly', () => {
      const pool = new StatePool(2);

      // t=0: DC operating point
      pool.state0.set([0.6, 5.0]);
      pool.state1.set([0.6, 5.0]);
      pool.state2.set([0.6, 5.0]);

      // t=1: NR converges with new state
      pool.state0.set([0.61, 4.9]);
      pool.acceptTimestep();

      expect(Array.from(pool.state1)).toEqual([0.61, 4.9]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0]);

      // t=2: NR converges again
      pool.state0.set([0.62, 4.8]);
      pool.acceptTimestep();

      expect(Array.from(pool.state1)).toEqual([0.62, 4.8]);
      expect(Array.from(pool.state2)).toEqual([0.61, 4.9]);
    });
  });
});
