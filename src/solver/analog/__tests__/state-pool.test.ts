import { describe, it, expect } from 'vitest';
import { StatePool } from '../state-pool';

describe('StatePool', () => {
  describe('constructor', () => {
    it('allocates eight Float64Array vectors of the given size', () => {
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

    it('allocates state4..state7 Float64Arrays of the given size', () => {
      const pool = new StatePool(6);
      expect(pool.state4).toBeInstanceOf(Float64Array);
      expect(pool.state5).toBeInstanceOf(Float64Array);
      expect(pool.state6).toBeInstanceOf(Float64Array);
      expect(pool.state7).toBeInstanceOf(Float64Array);
      expect(pool.state4.length).toBe(6);
      expect(pool.state5.length).toBe(6);
      expect(pool.state6.length).toBe(6);
      expect(pool.state7.length).toBe(6);
    });

    it('initialises state4..state7 to zero', () => {
      const pool = new StatePool(3);
      expect(Array.from(pool.state4)).toEqual([0, 0, 0]);
      expect(Array.from(pool.state5)).toEqual([0, 0, 0]);
      expect(Array.from(pool.state6)).toEqual([0, 0, 0]);
      expect(Array.from(pool.state7)).toEqual([0, 0, 0]);
    });

    it('exposes states ring buffer with 8 entries', () => {
      const pool = new StatePool(3);
      expect(pool.states.length).toBe(8);
      expect(pool.states[0]).toBe(pool.state0);
      expect(pool.states[1]).toBe(pool.state1);
      expect(pool.states[2]).toBe(pool.state2);
      expect(pool.states[3]).toBe(pool.state3);
      expect(pool.states[4]).toBe(pool.state4);
      expect(pool.states[5]).toBe(pool.state5);
      expect(pool.states[6]).toBe(pool.state6);
      expect(pool.states[7]).toBe(pool.state7);
    });
  });

  describe('rotateStateVectors()', () => {
    it('rotates ring 0..maxOrder+1 (default maxOrder=2): state3<-state2, state2<-state1, state1<-state0', () => {
      const pool = new StatePool(3); // default maxOrder = 2 (TRAP)
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

    it('state0 is the recycled old state[maxOrder+1] — pointer swap, not data copy', () => {
      // Default maxOrder=2 → recycled buffer is state[3].
      const pool = new StatePool(3);
      pool.state0.set([1.0, 2.0, 3.0]);
      pool.state1.set([10.0, 20.0, 30.0]);
      pool.state2.set([100.0, 200.0, 300.0]);
      pool.state3.set([3000.0, 3000.0, 3000.0]);
      // Slot above the ring should NOT be touched by rotation.
      pool.state7.set([7000.0, 8000.0, 9000.0]);

      pool.rotateStateVectors();

      // state0 = recycled old state3.
      expect(Array.from(pool.state0)).toEqual([3000.0, 3000.0, 3000.0]);
      // state7 is above the ring — unchanged.
      expect(Array.from(pool.state7)).toEqual([7000.0, 8000.0, 9000.0]);
    });

    it('slots above maxOrder+1 are NOT rotated — stay at construction-zero', () => {
      // ngspice cktsetup.c:82-83 only allocates slots 0..MAX(2,maxOrder)+1
      // (slots 4..7 in our pool with default maxOrder=2 simply do not exist
      // in ngspice). Rotation must mirror that: never touch them.
      const pool = new StatePool(2);
      pool.state0.set([1.0, 2.0]);
      pool.state1.set([3.0, 4.0]);
      pool.state2.set([5.0, 6.0]);
      pool.state3.set([7.0, 8.0]);
      // state4..state7 stay at construction zero.

      // Capture identities of slots above the ring before rotation.
      const s4 = pool.states[4];
      const s5 = pool.states[5];
      const s6 = pool.states[6];
      const s7 = pool.states[7];

      pool.rotateStateVectors();
      pool.rotateStateVectors();
      pool.rotateStateVectors();

      // Slot identities above the ring must be unchanged (no pointer swap).
      expect(pool.states[4]).toBe(s4);
      expect(pool.states[5]).toBe(s5);
      expect(pool.states[6]).toBe(s6);
      expect(pool.states[7]).toBe(s7);
      // Contents stay zero.
      expect(Array.from(pool.state4)).toEqual([0, 0]);
      expect(Array.from(pool.state5)).toEqual([0, 0]);
      expect(Array.from(pool.state6)).toEqual([0, 0]);
      expect(Array.from(pool.state7)).toEqual([0, 0]);
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
      const pool = new StatePool(2); // default maxOrder = 2, ring = slots 0..3
      pool.state0.set([1.0, 1.0]);
      pool.state1.set([2.0, 2.0]);
      pool.state2.set([3.0, 3.0]);
      pool.state3.set([4.0, 4.0]);

      pool.rotateStateVectors();
      // After: state0=recycled old state3 = [4,4], state1=[1,1], state2=[2,2], state3=[3,3]

      pool.state0.set([5.0, 5.0]);
      pool.rotateStateVectors();
      // After: state0=recycled old state3 = [3,3], state1=[5,5], state2=[1,1], state3=[2,2]

      expect(Array.from(pool.state3)).toEqual([2.0, 2.0]);
      expect(Array.from(pool.state2)).toEqual([1.0, 1.0]);
      expect(Array.from(pool.state1)).toEqual([5.0, 5.0]);
    });

    it('(maxOrder+1+1) consecutive rotations return ring slots to original identity', () => {
      // For default maxOrder=2 the ring is 4 slots wide; 4 rotations cycle
      // back to the starting permutation. Slots above the ring never move.
      const pool = new StatePool(2);
      const origS0 = pool.states[0];
      const origS1 = pool.states[1];
      const origS2 = pool.states[2];
      const origS3 = pool.states[3];
      const origS4 = pool.states[4];
      const origS5 = pool.states[5];
      const origS6 = pool.states[6];
      const origS7 = pool.states[7];

      const ringWidth = pool.maxOrder + 2; // slots 0..maxOrder+1 inclusive
      for (let i = 0; i < ringWidth; i++) pool.rotateStateVectors();

      expect(pool.states[0]).toBe(origS0);
      expect(pool.states[1]).toBe(origS1);
      expect(pool.states[2]).toBe(origS2);
      expect(pool.states[3]).toBe(origS3);
      // Slots 4..7 never participated, identities unchanged from t=0.
      expect(pool.states[4]).toBe(origS4);
      expect(pool.states[5]).toBe(origS5);
      expect(pool.states[6]).toBe(origS6);
      expect(pool.states[7]).toBe(origS7);
    });

    it('honours a wider maxOrder — Gear-style ring extends through state[maxOrder+1]', () => {
      const pool = new StatePool(2);
      pool.maxOrder = 5; // Gear order 5 → ring spans slots 0..6
      pool.state0.set([1.0, 1.0]);
      pool.state5.set([5.0, 5.0]);
      pool.state6.set([6.0, 6.0]);
      // state7 above the ring, must stay put.
      pool.state7.set([7.0, 7.0]);
      const s7 = pool.states[7];

      pool.rotateStateVectors();

      // state0 = recycled old state6.
      expect(Array.from(pool.state0)).toEqual([6.0, 6.0]);
      // state6 = old state5 (ring carried it up).
      expect(Array.from(pool.state6)).toEqual([5.0, 5.0]);
      // state7 untouched in identity and contents.
      expect(pool.states[7]).toBe(s7);
      expect(Array.from(pool.state7)).toEqual([7.0, 7.0]);
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

    it('zeros all eight vectors including state4..state7', () => {
      const pool = new StatePool(2);
      pool.state4.set([11.0, 12.0]);
      pool.state5.set([13.0, 14.0]);
      pool.state6.set([15.0, 16.0]);
      pool.state7.set([17.0, 18.0]);
      pool.reset();
      expect(Array.from(pool.state4)).toEqual([0, 0]);
      expect(Array.from(pool.state5)).toEqual([0, 0]);
      expect(Array.from(pool.state6)).toEqual([0, 0]);
      expect(Array.from(pool.state7)).toEqual([0, 0]);
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

  describe('integration: rotateStateVectors', () => {
    it('transient history advances correctly across steps', () => {
      const pool = new StatePool(2); // default maxOrder = 2 (TRAP)

      // t=0: DC operating point converged. Mirror what production does
      // (analog-engine.ts _seedFromDcop and the for(;;) firsttime block):
      //   ngspice dctran.c:349-350 — state1 = state0
      //   ngspice dctran.c:795-799 — state2 = state3 = state1 (inside for(;;))
      // state4..state7 stay at the constructor's zero — matching ngspice's
      // CKTalloc/calloc-zero (cktsetup.c:82-83 → tmalloc → calloc) where
      // those slots aren't allocated at all under maxOrder=2.
      pool.state0.set([0.6, 5.0]);
      pool.state1.set(pool.state0);
      pool.copyState1ToState23();

      // t=1: rotate before retry loop, NR writes new state into state0
      pool.rotateStateVectors();
      pool.state0.set([0.61, 4.9]);

      expect(Array.from(pool.state1)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state3)).toEqual([0.6, 5.0]);
      // Slots above the ring stay zero — matches ngspice exactly.
      expect(Array.from(pool.state4)).toEqual([0, 0]);
      expect(Array.from(pool.state5)).toEqual([0, 0]);
      expect(Array.from(pool.state6)).toEqual([0, 0]);
      expect(Array.from(pool.state7)).toEqual([0, 0]);

      // t=2: rotate again — state0 is fresh, state1 = t=1 result
      pool.rotateStateVectors();
      pool.state0.set([0.62, 4.8]);

      expect(Array.from(pool.state1)).toEqual([0.61, 4.9]);
      expect(Array.from(pool.state2)).toEqual([0.6, 5.0]);
      expect(Array.from(pool.state3)).toEqual([0.6, 5.0]);
      // Slots above the ring still zero — never touched by rotation.
      expect(Array.from(pool.state4)).toEqual([0, 0]);
      expect(Array.from(pool.state5)).toEqual([0, 0]);
      expect(Array.from(pool.state6)).toEqual([0, 0]);
      expect(Array.from(pool.state7)).toEqual([0, 0]);
    });
  });
});
