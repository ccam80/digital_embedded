/**
 * Pre-allocated object pool for ScheduledEvent instances.
 *
 * Eliminates per-event allocation during steady-state timed simulation.
 * Pool entries are reused via a free-list (stack discipline).
 *
 * Pool size should be set to `2 * netCount` at construction time:
 * each net can have at most one pending event but transient duplicates
 * during transitions can briefly double the count.
 */

export interface ScheduledEvent {
  netId: number;
  value: number;
  highZ: number;
  timestamp: bigint;
  /** Internal: next event in free-list or bucket chain. null = end of list. */
  _next: ScheduledEvent | null;
}

export class EventPool {
  private readonly _pool: ScheduledEvent[];
  private _freeHead: ScheduledEvent | null = null;
  private _allocCount = 0;

  constructor(poolSize: number) {
    this._pool = new Array<ScheduledEvent>(poolSize);
    for (let i = 0; i < poolSize; i++) {
      const evt: ScheduledEvent = {
        netId: 0,
        value: 0,
        highZ: 0,
        timestamp: 0n,
        _next: null,
      };
      this._pool[i] = evt;
      evt._next = this._freeHead;
      this._freeHead = evt;
    }
  }

  /**
   * Allocate an event from the pool.
   * Throws if the pool is exhausted (pool size too small for the circuit).
   */
  alloc(): ScheduledEvent {
    if (this._freeHead === null) {
      throw new Error(
        `EventPool exhausted (pool size ${this._pool.length}). ` +
        `Increase pool size (2 * netCount).`
      );
    }
    const evt = this._freeHead;
    this._freeHead = evt._next;
    evt._next = null;
    this._allocCount++;
    return evt;
  }

  /**
   * Return an event to the pool.
   */
  free(event: ScheduledEvent): void {
    event._next = this._freeHead;
    this._freeHead = event;
    this._allocCount--;
  }

  /**
   * Return all events to the pool.
   * O(n) where n is pool size. Rebuilds the free-list from scratch.
   */
  reset(): void {
    this._freeHead = null;
    for (let i = 0; i < this._pool.length; i++) {
      const evt = this._pool[i];
      evt._next = this._freeHead;
      this._freeHead = evt;
    }
    this._allocCount = 0;
  }

  /** Number of events currently checked out of the pool. */
  get allocatedCount(): number {
    return this._allocCount;
  }

  /** Total pool capacity. */
  get capacity(): number {
    return this._pool.length;
  }
}
