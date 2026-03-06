/**
 * O(1) amortized event queue for timed simulation mode.
 *
 * Uses a circular buffer indexed by `timestamp % wheelSize`. Events at the
 * same slot form a singly-linked list using the pool's `_next` pointers.
 * For delays exceeding the wheel size, events go into a sorted overflow list
 * and are moved into the wheel when it wraps past their insertion point.
 *
 * Design invariants:
 * - Each netId has at most one pending event. Scheduling a net that already
 *   has a pending event replaces the old one (latest schedule wins).
 * - `advance(toTimestamp)` returns events in ascending timestamp order.
 * - Zero allocation during steady-state: all events come from EventPool.
 *
 * Java reference: de.neemann.digital.core.Model (event scheduling)
 */

import { EventPool, type ScheduledEvent } from "./event-pool";

export type { ScheduledEvent };

export class TimingWheel {
  private readonly _wheelSize: number;
  private readonly _mask: number;
  private readonly _slots: Array<ScheduledEvent | null>;
  private readonly _pool: EventPool;

  /**
   * Map from netId → the currently-pending ScheduledEvent for that net.
   * Used to cancel a superseded event in O(1) via slot-list removal.
   */
  private readonly _pendingByNet: Map<number, ScheduledEvent> = new Map();

  /**
   * Overflow list: events with timestamp - _currentBase >= wheelSize.
   * Stored sorted ascending by timestamp for efficient insertion into the
   * wheel when the cursor wraps.
   * Uses _next pointer as linked-list linkage.
   */
  private _overflowHead: ScheduledEvent | null = null;

  /** The simulation timestamp corresponding to slot 0 of the current wheel rotation. */
  private _currentBase: bigint = 0n;

  /** Slot index the wheel cursor currently sits at. */
  private _cursor: number = 0;

  /** Total count of events (wheel + overflow). */
  private _size: number = 0;

  constructor(wheelSize: number, poolSize: number) {
    // Wheel size must be a power of two for the bitmask trick.
    // Round up to next power of two if necessary.
    let sz = 1;
    while (sz < wheelSize) sz <<= 1;
    this._wheelSize = sz;
    this._mask = sz - 1;
    this._slots = new Array<ScheduledEvent | null>(sz).fill(null);
    this._pool = new EventPool(poolSize);
  }

  /**
   * Schedule a value change for `netId` at `timestamp`.
   *
   * If `netId` already has a pending event at a different timestamp, the old
   * event is cancelled and replaced. If it has a pending event at the same
   * timestamp the new values are applied in-place (no requeue needed).
   */
  schedule(netId: number, value: number, highZ: number, timestamp: bigint): void {
    const existing = this._pendingByNet.get(netId);

    if (existing !== undefined) {
      if (existing.timestamp === timestamp) {
        // Same slot — just update the payload in-place.
        existing.value = value;
        existing.highZ = highZ;
        return;
      }
      // Remove the superseded event.
      this._removeEvent(existing);
      this._size--;
    }

    const evt = this._pool.alloc();
    evt.netId = netId;
    evt.value = value;
    evt.highZ = highZ;
    evt.timestamp = timestamp;
    evt._next = null;

    this._insertEvent(evt);
    this._pendingByNet.set(netId, evt);
    this._size++;
  }

  /**
   * Return all events with timestamp ≤ toTimestamp, ordered ascending by
   * timestamp. The returned array is stable for this call only — events are
   * freed back to the pool after being returned (caller must consume them
   * before the next `advance` call).
   */
  advance(toTimestamp: bigint): ScheduledEvent[] {
    const result: ScheduledEvent[] = [];

    // Collect all due events from the wheel and overflow, sorted ascending.
    // Strategy: gather candidates bucket by bucket up to toTimestamp,
    // plus any overflow entries that have become due.

    // Advance cursor through all slots whose base timestamp ≤ toTimestamp.
    const wheelEnd = toTimestamp - this._currentBase;

    if (wheelEnd >= 0n) {
      const maxSlots = wheelEnd >= BigInt(this._wheelSize)
        ? this._wheelSize
        : Number(wheelEnd) + 1;

      for (let i = 0; i < maxSlots; i++) {
        const slotTs = this._currentBase + BigInt(i);
        const slotIdx = Number(slotTs & BigInt(this._mask));
        let evt = this._slots[slotIdx];
        while (evt !== null) {
          if (evt.timestamp <= toTimestamp) {
            const next = evt._next;
            result.push(evt);
            evt = next;
          } else {
            // Should not happen in a correct wheel — defensive skip.
            evt = evt._next;
          }
        }
        this._slots[slotIdx] = null;
      }

      // Advance base if we consumed an entire revolution or moved forward.
      if (wheelEnd >= BigInt(this._wheelSize)) {
        this._currentBase = toTimestamp + 1n;
        this._cursor = 0;
      } else {
        this._currentBase += BigInt(maxSlots);
        this._cursor = Number(this._currentBase & BigInt(this._mask));
      }
    }

    // Drain overflow events that are now due.
    this._drainOverflowInto(toTimestamp, result);

    // Sort ascending by timestamp.
    result.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    // Remove from pending map and free back to pool.
    for (const evt of result) {
      this._pendingByNet.delete(evt.netId);
      this._size--;
    }

    // NOTE: events are returned as-is. Callers must not hold references past
    // the next advance() call. We free them after the caller consumes them
    // by requiring the caller to be synchronous (single-threaded JS).
    // Free here so pool is immediately reusable.
    for (const evt of result) {
      this._pool.free(evt);
    }

    return result;
  }

  /**
   * Return the timestamp of the next scheduled event, or undefined if empty.
   */
  peek(): bigint | undefined {
    if (this._size === 0) return undefined;

    let earliest: bigint | undefined;

    // Scan wheel slots.
    for (let i = 0; i < this._wheelSize; i++) {
      const slotTs = this._currentBase + BigInt(i);
      const slotIdx = Number(slotTs & BigInt(this._mask));
      let evt = this._slots[slotIdx];
      while (evt !== null) {
        if (earliest === undefined || evt.timestamp < earliest) {
          earliest = evt.timestamp;
        }
        evt = evt._next;
      }
    }

    // Scan overflow.
    let ov = this._overflowHead;
    while (ov !== null) {
      if (earliest === undefined || ov.timestamp < earliest) {
        earliest = ov.timestamp;
      }
      ov = ov._next;
    }

    return earliest;
  }

  /**
   * Reset all state. All pending events are freed back to the pool.
   */
  clear(): void {
    for (let i = 0; i < this._wheelSize; i++) {
      let evt = this._slots[i];
      while (evt !== null) {
        const next = evt._next;
        this._pool.free(evt);
        evt = next;
      }
      this._slots[i] = null;
    }

    let ov = this._overflowHead;
    while (ov !== null) {
      const next = ov._next;
      this._pool.free(ov);
      ov = next;
    }
    this._overflowHead = null;

    this._pendingByNet.clear();
    this._currentBase = 0n;
    this._cursor = 0;
    this._size = 0;
  }

  /** Total number of pending events. */
  get size(): number {
    return this._size;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _insertEvent(evt: ScheduledEvent): void {
    const offset = evt.timestamp - this._currentBase;
    if (offset < 0n || offset >= BigInt(this._wheelSize)) {
      // Goes into overflow list (sorted ascending by timestamp).
      this._insertOverflow(evt);
      return;
    }
    const slotIdx = Number(evt.timestamp & BigInt(this._mask));
    evt._next = this._slots[slotIdx];
    this._slots[slotIdx] = evt;
  }

  private _insertOverflow(evt: ScheduledEvent): void {
    // Insertion into sorted singly-linked list.
    if (this._overflowHead === null || evt.timestamp < this._overflowHead.timestamp) {
      evt._next = this._overflowHead;
      this._overflowHead = evt;
      return;
    }
    let cur = this._overflowHead;
    while (cur._next !== null && cur._next.timestamp <= evt.timestamp) {
      cur = cur._next;
    }
    evt._next = cur._next;
    cur._next = evt;
  }

  /**
   * Remove `target` from wherever it currently lives (wheel slot or overflow).
   * Called when a superseded event needs to be cancelled.
   */
  private _removeEvent(target: ScheduledEvent): void {
    const offset = target.timestamp - this._currentBase;
    if (offset < 0n || offset >= BigInt(this._wheelSize)) {
      // It's in overflow.
      if (this._overflowHead === target) {
        this._overflowHead = target._next;
        target._next = null;
        this._pool.free(target);
        return;
      }
      let cur = this._overflowHead;
      while (cur !== null && cur._next !== target) {
        cur = cur._next;
      }
      if (cur !== null) {
        cur._next = target._next;
      }
    } else {
      // It's in a wheel slot.
      const slotIdx = Number(target.timestamp & BigInt(this._mask));
      if (this._slots[slotIdx] === target) {
        this._slots[slotIdx] = target._next;
        target._next = null;
        this._pool.free(target);
        return;
      }
      let cur = this._slots[slotIdx];
      while (cur !== null && cur._next !== target) {
        cur = cur._next;
      }
      if (cur !== null) {
        cur._next = target._next;
      }
    }
    target._next = null;
    this._pool.free(target);
  }

  /**
   * Move overflow events that are now within [0, toTimestamp] into `result`.
   */
  private _drainOverflowInto(toTimestamp: bigint, result: ScheduledEvent[]): void {
    while (this._overflowHead !== null && this._overflowHead.timestamp <= toTimestamp) {
      const evt = this._overflowHead;
      this._overflowHead = evt._next;
      evt._next = null;
      result.push(evt);
    }
  }
}
