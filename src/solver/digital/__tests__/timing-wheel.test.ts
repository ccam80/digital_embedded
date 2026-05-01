/**
 * Tests for TimingWheel and EventPool.
 *
 * Task 3.1.2- Timing Wheel Event Queue
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TimingWheel } from "../timing-wheel";
import { EventPool } from "../event-pool";

// ---------------------------------------------------------------------------
// EventPool tests
// ---------------------------------------------------------------------------

describe("EventPool", () => {
  it("allocates and frees events", () => {
    const pool = new EventPool(4);
    const e1 = pool.alloc();
    const e2 = pool.alloc();
    expect(pool.allocatedCount).toBe(2);
    pool.free(e1);
    expect(pool.allocatedCount).toBe(1);
    pool.free(e2);
    expect(pool.allocatedCount).toBe(0);
  });

  it("reuses freed events", () => {
    const pool = new EventPool(2);
    const e1 = pool.alloc();
    pool.free(e1);
    const e2 = pool.alloc();
    expect(e2).toBe(e1); // same object reference- pool reuse
  });

  it("throws when exhausted", () => {
    const pool = new EventPool(2);
    pool.alloc();
    pool.alloc();
    expect(() => pool.alloc()).toThrow();
  });

  it("reset returns all events to pool", () => {
    const pool = new EventPool(4);
    pool.alloc();
    pool.alloc();
    pool.alloc();
    pool.reset();
    expect(pool.allocatedCount).toBe(0);
    // Should be able to alloc all 4 again.
    for (let i = 0; i < 4; i++) {
      pool.alloc();
    }
    expect(pool.allocatedCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// TimingWheel tests
// ---------------------------------------------------------------------------

describe("TimingWheel", () => {
  let wheel: TimingWheel;

  beforeEach(() => {
    wheel = new TimingWheel(1024, 256);
  });

  it("scheduleSingleEvent- schedule at t=10, advance to t=10, get 1 event with correct netId/value", () => {
    wheel.schedule(7, 0xff, 0, 10n);
    const events = wheel.advance(10n);
    expect(events).toHaveLength(1);
    expect(events[0].netId).toBe(7);
    expect(events[0].value).toBe(0xff);
    expect(events[0].timestamp).toBe(10n);
  });

  it("batchesSimultaneousEvents- schedule 3 events at t=10, advance to t=10, get all 3", () => {
    wheel.schedule(1, 1, 0, 10n);
    wheel.schedule(2, 2, 0, 10n);
    wheel.schedule(3, 3, 0, 10n);
    const events = wheel.advance(10n);
    expect(events).toHaveLength(3);
    const netIds = events.map((e) => e.netId).sort((a, b) => a - b);
    expect(netIds).toEqual([1, 2, 3]);
  });

  it("orderedByTimestamp- schedule at t=20, t=10, t=15; advance to t=20; receive in order 10, 15, 20", () => {
    wheel.schedule(1, 0, 0, 20n);
    wheel.schedule(2, 0, 0, 10n);
    wheel.schedule(3, 0, 0, 15n);
    const events = wheel.advance(20n);
    expect(events).toHaveLength(3);
    expect(events[0].timestamp).toBe(10n);
    expect(events[1].timestamp).toBe(15n);
    expect(events[2].timestamp).toBe(20n);
  });

  it("replacesExistingEventForSameNet- schedule net 5 at t=10, then at t=15; advance to t=15; only one event for net 5 (at t=15)", () => {
    wheel.schedule(5, 1, 0, 10n);
    wheel.schedule(5, 2, 0, 15n);
    const events = wheel.advance(15n);
    const net5 = events.filter((e) => e.netId === 5);
    expect(net5).toHaveLength(1);
    expect(net5[0].timestamp).toBe(15n);
    expect(net5[0].value).toBe(2);
  });

  it("replacesExistingEventForSameNet- first event not returned at t=10 when replaced", () => {
    wheel.schedule(5, 1, 0, 10n);
    wheel.schedule(5, 2, 0, 15n);
    // Advance only to t=10- replacement is at t=15 so nothing at t=10.
    const at10 = wheel.advance(10n);
    const net5at10 = at10.filter((e) => e.netId === 5);
    expect(net5at10).toHaveLength(0);
  });

  it("handlesWrapAround- wheel size 16, schedule at t=20 (wraps), advance to t=20, receive event", () => {
    const smallWheel = new TimingWheel(16, 64);
    // t=20 wraps: 20 % 16 = 4, but base=0 so offset=20 > wheelSize → overflow.
    // After clearing base past t=20, it should be returned.
    smallWheel.schedule(9, 42, 0, 20n);
    const events = smallWheel.advance(20n);
    expect(events).toHaveLength(1);
    expect(events[0].netId).toBe(9);
    expect(events[0].value).toBe(42);
    expect(events[0].timestamp).toBe(20n);
  });

  it("handlesWrapAround- multiple events across a wrap boundary", () => {
    const smallWheel = new TimingWheel(16, 64);
    smallWheel.schedule(1, 1, 0, 5n);
    smallWheel.schedule(2, 2, 0, 20n); // exceeds wheelSize of 16 → overflow
    // Advance to t=5 first.
    const at5 = smallWheel.advance(5n);
    expect(at5).toHaveLength(1);
    expect(at5[0].netId).toBe(1);
    // Now advance to t=20.
    const at20 = smallWheel.advance(20n);
    expect(at20).toHaveLength(1);
    expect(at20[0].netId).toBe(2);
  });

  it("overflowHandled- schedule at t > wheelSize, verify it's returned at correct time", () => {
    // wheelSize=1024, schedule at t=2000 which is > 1024
    wheel.schedule(11, 77, 0, 2000n);
    // Advance to before- should get nothing.
    const before = wheel.advance(1999n);
    expect(before).toHaveLength(0);
    // Advance to exactly t=2000.
    const at2000 = wheel.advance(2000n);
    expect(at2000).toHaveLength(1);
    expect(at2000[0].netId).toBe(11);
    expect(at2000[0].value).toBe(77);
    expect(at2000[0].timestamp).toBe(2000n);
  });

  it("overflowHandled- event not returned early", () => {
    wheel.schedule(3, 5, 0, 1500n);
    const before = wheel.advance(1000n);
    expect(before).toHaveLength(0);
    expect(wheel.size).toBe(1);
  });

  it("zeroAllocation- schedule and advance 1000 events, verify no new objects created (event pool reuse)", () => {
    // Use a wheel with a fixed pool. If pool is exhausted, alloc() throws.
    // Pool size = 64. We schedule one event at a time and advance, reusing pool.
    const poolSize = 64;
    const reuse = new TimingWheel(256, poolSize);

    // Schedule and advance 1000 rounds. Each round: schedule 1 event, advance.
    // If objects were allocated outside the pool, the pool count would deviate.
    for (let i = 0; i < 1000; i++) {
      reuse.schedule(0, i, 0, BigInt(i * 10 + 10));
      const events = reuse.advance(BigInt(i * 10 + 10));
      expect(events).toHaveLength(1);
      expect(events[0].value).toBe(i);
    }
    // Pool should be fully free (all events returned after advance).
    // We can verify by scheduling poolSize events simultaneously without throwing.
    for (let n = 0; n < poolSize; n++) {
      reuse.schedule(n, n, 0, BigInt(100000 + n));
    }
    // If pool wasn't reused above, this would throw. Getting here means it didn't.
    expect(reuse.size).toBe(poolSize);
  });

  it("peek returns undefined when empty", () => {
    expect(wheel.peek()).toBeUndefined();
  });

  it("peek returns earliest timestamp", () => {
    wheel.schedule(1, 0, 0, 50n);
    wheel.schedule(2, 0, 0, 30n);
    wheel.schedule(3, 0, 0, 40n);
    expect(wheel.peek()).toBe(30n);
  });

  it("clear removes all events", () => {
    wheel.schedule(1, 0, 0, 10n);
    wheel.schedule(2, 0, 0, 20n);
    wheel.clear();
    expect(wheel.size).toBe(0);
    expect(wheel.peek()).toBeUndefined();
    const events = wheel.advance(100n);
    expect(events).toHaveLength(0);
  });

  it("highZ field is preserved through schedule/advance", () => {
    wheel.schedule(4, 0b1010, 0b0101, 5n);
    const events = wheel.advance(5n);
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe(0b1010);
    expect(events[0].highZ).toBe(0b0101);
  });

  it("advance before any events returns empty array", () => {
    const events = wheel.advance(1000n);
    expect(events).toHaveLength(0);
  });

  it("same-timestamp replacement updates value in-place", () => {
    // Schedule net 7 at t=10 with value=1, then re-schedule same net at t=10 with value=2.
    wheel.schedule(7, 1, 0, 10n);
    wheel.schedule(7, 2, 0, 10n); // same timestamp → in-place update
    const events = wheel.advance(10n);
    expect(events).toHaveLength(1);
    expect(events[0].netId).toBe(7);
    expect(events[0].value).toBe(2);
  });

  it("does not return events beyond toTimestamp", () => {
    wheel.schedule(1, 1, 0, 5n);
    wheel.schedule(2, 2, 0, 15n);
    const at10 = wheel.advance(10n);
    expect(at10).toHaveLength(1);
    expect(at10[0].netId).toBe(1);
    // Event at t=15 must still be pending.
    expect(wheel.size).toBe(1);
  });

  it("sequential advances work correctly", () => {
    wheel.schedule(1, 1, 0, 5n);
    wheel.schedule(2, 2, 0, 10n);
    wheel.schedule(3, 3, 0, 15n);

    const at5 = wheel.advance(5n);
    expect(at5).toHaveLength(1);
    expect(at5[0].netId).toBe(1);

    const at10 = wheel.advance(10n);
    expect(at10).toHaveLength(1);
    expect(at10[0].netId).toBe(2);

    const at15 = wheel.advance(15n);
    expect(at15).toHaveLength(1);
    expect(at15[0].netId).toBe(3);

    expect(wheel.size).toBe(0);
  });
});
