import { describe, it, expect } from 'vitest';
import { StatePool } from '../state-pool';

describe('StatePool', () => {
  describe('constructor', () => {
    it('allocates four Float64Array vectors of the given size', () => {
      const pool = new StatePool(10);
      expect(pool.state0).toBeInstanceOf(Float64Array);
      expect(pool.state1).toBeInstanceOf(Float64Array);
      expect(pool.state2).toBeInstanceOf(Float64Array);
      expect(pool.state3).toBeInstanceOf(Float64Array);
      expect(pool.state0.length).toBe(10);
      expect(pool.state1.length).toBe(10);
      expect(pool.state2.length).toBe(10);
      expect(pool.state3.length).toBe(10);
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
      expect(Array.from(pool.state3)).toEqual([0, 0, 0, 0, 0]);
    });

    it('works with totalSlots of 0', () => {
      const pool = new StatePool(0);
      expect(pool.totalSlots).toBe(0);
      expect(pool.state0.length).toBe(0);
    });

    it('exposes states ring buffer with 4 entries', () => {
      const pool = new StatePool(3);
      expect(pool.states.length).toBe(4);
      expect(pool.states[0]).toBe(pool.state0);
      expect(pool.states[1]).toBe(pool.state1);
      expect(pool.states[2]).toBe(pool.state2);
      expect(pool.states[3]).toBe(pool.state3);
    });
  });

  describe('rotateStateVectors()', () => {
    it('rotates ring: state3←state2, state2←state1, state1←state0, state0←recycled old state3', () => {
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);
      pool.state3.set([1000.0, 2000.0, 3000.0]);

      pool.rotateStateVectors();

      // After rotation: state3=old_state2, state2=old_state1, state1=old_state0
      expect(Array.from(pool.state3)).toEqual([100.0, 200.0, 300.0]);
      expect(Array.from(pool.state2)).toEqual([10.0, 20.0, 30.0]);
      expect(Array.from(pool.state1)).toEqual([1.0, 2.0, 3.0]);
    });

    it('state0 is the recycled old state3 — pointer swap, no data copy from state1', () => {
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);
      pool.state3.set([1000.0, 2000.0, 3000.0]);

      pool.rotateStateVectors();

      // state0 is the recycled old state3 — contents from before rotation
      expect(Array.from(pool.state0)).toEqual([1000.0, 2000.0, 3000.0]);
    });

    it('state1 and state2 are independent after rotateStateVectors — mutating state1 does not affect state2', () => {
      const pool = new StatePool(2);
      pool.state0.set([5.0, 6.0]);
      pool.state1.set([1.0, 2.0]);
      pool.state2.set([0.0, 0.0]);
      pool.state3.set([0.0, 0.0]);

      pool.rotateStateVectors();

      // state2 should now hold old state1 values
      expect(Array.from(pool.state2)).toEqual([1.0, 2.0]);
      expect(Array.from(pool.state1)).toEqual([5.0, 6.0]);

      // Mutating state1 should not affect state2 — they are distinct arrays
      pool.state1[0] = 99.0;
      expect(pool.state2[0]).toBe(1.0);
    });

    it('consecutive rotateStateVectors calls shift correctly', () => {
      const pool = new StatePool(2);
      pool.state0.set([1.0, 1.0]);
      pool.state1.set([2.0, 2.0]);
      pool.state2.set([3.0, 3.0]);
      pool.state3.set([4.0, 4.0]);

      pool.rotateStateVectors();
      // After: state0=[4,4](recycled), state1=[1,1], state2=[2,2], state3=[3,3]

      pool.state0.set([5.0, 5.0]);
      pool.rotateStateVectors();
      // After: state0=[3,3](recycled), state1=[5,5], state2=[1,1], state3=[2,2]

      expect(Array.from(pool.state3)).toEqual([2.0, 2.0]);
      expect(Array.from(pool.state2)).toEqual([1.0, 1.0]);
      expect(Array.from(pool.state1)).toEqual([5.0, 5.0]);
      expect(Array.from(pool.state0)).toEqual([3.0, 3.0]);
    });

    it('four consecutive rotations return all arrays to original identity', () => {
      const pool = new StatePool(2);
      const origS0 = pool.states[0];
      const origS1 = pool.states[1];
      const origS2 = pool.states[2];
      const origS3 = pool.states[3];

      pool.rotateStateVectors();
      pool.rotateStateVectors();
      pool.rotateStateVectors();
      pool.rotateStateVectors();

      expect(pool.states[0]).toBe(origS0);
      expect(pool.states[1]).toBe(origS1);
      expect(pool.states[2]).toBe(origS2);
      expect(pool.states[3]).toBe(origS3);
    });
  });

  describe('reset()', () => {
    it('zeros all four vectors', () => {
      const pool = new StatePool(4);
      pool.state0.set([1.0, 2.0, 3.0, 4.0]);
      pool.state1.set([5.0, 6.0, 7.0, 8.0]);
      pool.state2.set([9.0, 10.0, 11.0, 12.0]);
      pool.state3.set([13.0, 14.0, 15.0, 16.0]);

      pool.reset();

      expect(Array.from(pool.state0)).toEqual([0, 0, 0, 0]);
      expect(Array.from(pool.state1)).toEqual([0, 0, 0, 0]);
      expect(Array.from(pool.state2)).toEqual([0, 0, 0, 0]);
      expect(Array.from(pool.state3)).toEqual([0, 0, 0, 0]);
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

  describe('ag[] integration coefficients', () => {
    it('initialises ag to an 8-element Float64Array of zeros', () => {
      const pool = new StatePool(4);
      expect(pool.ag).toBeInstanceOf(Float64Array);
      expect(pool.ag.length).toBe(8);
      expect(Array.from(pool.ag)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('ag is writable — setting ag[0] and ag[1] is reflected', () => {
      const pool = new StatePool(4);
      pool.ag[0] = 1e6;
      pool.ag[1] = -1e6;
      expect(pool.ag[0]).toBe(1e6);
      expect(pool.ag[1]).toBe(-1e6);
    });

    it('reset() zeros ag[]', () => {
      const pool = new StatePool(4);
      pool.ag[0] = 1e6;
      pool.ag[1] = -1e6;
      pool.ag[3] = 42;
      pool.reset();
      expect(Array.from(pool.ag)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('ag[] is independent per StatePool instance', () => {
      const pool1 = new StatePool(4);
      const pool2 = new StatePool(4);
      pool1.ag[0] = 999;
      expect(pool2.ag[0]).toBe(0);
    });
  });

  describe('seedHistory()', () => {
    it('seeds state1, state2, state3 from state0', () => {
      const pool = new StatePool(3);
      pool.state0.set([0.6, 5.0, 1.2]);
      pool.seedHistory();
      expect(Array.from(pool.state1)).toEqual([0.6, 5.0, 1.2]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0, 1.2]);
      expect(Array.from(pool.state3)).toEqual([0.6, 5.0, 1.2]);
    });
  });

  describe('integration: rotateStateVectors', () => {
    it('transient history advances correctly across steps', () => {
      const pool = new StatePool(2);

      // t=0: DC operating point — seed all history
      pool.state0.set([0.6, 5.0]);
      pool.seedHistory();

      // t=1: rotate before retry loop, NR writes new state into state0
      pool.rotateStateVectors();
      pool.state0.set([0.61, 4.9]);

      // state1 now holds the t=0 values (old state0 after rotation)
      expect(Array.from(pool.state1)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state3)).toEqual([0.6, 5.0]);

      // t=2: rotate again — state0 is fresh, state1 = t=1 result
      pool.rotateStateVectors();
      pool.state0.set([0.62, 4.8]);

      expect(Array.from(pool.state1)).toEqual([0.61, 4.9]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state3)).toEqual([0.6, 5.0]);
    });
  });
});
