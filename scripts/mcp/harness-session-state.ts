// harness-session-state.ts- lifecycle manager for ComparisonSession instances

import type { ComparisonSession } from "../../src/solver/analog/__tests__/harness/comparison-session.js";

export interface HarnessEntry {
  session: ComparisonSession;
  dtsPath: string;
  createdAt: Date;
  lastRunAt: Date | null;
  analysis: "dcop" | "tran" | null;
}

/**
 * HarnessSessionState- lifecycle manager for ComparisonSession instances.
 *
 * Parallel to SessionState in tool-helpers.ts but specialized for harness sessions.
 * Each session maps to one ComparisonSession instance and its metadata.
 */
export class HarnessSessionState {
  private readonly _sessions = new Map<string, HarnessEntry>();
  private _counter = 0;

  /**
   * Allocate a handle and store the session entry.
   * Returns the new handle string.
   */
  store(entry: HarnessEntry): string {
    const handle = `h${this._counter++}`;
    this._sessions.set(handle, entry);
    return handle;
  }

  /**
   * Retrieve a session entry by handle.
   * Throws a descriptive error if the handle is unknown.
   */
  get(handle: string, toolName: string): HarnessEntry {
    const entry = this._sessions.get(handle);
    if (!entry) {
      const known = [...this._sessions.keys()].join(", ") || "(none)";
      throw new Error(
        `${toolName}: unknown handle "${handle}". ` +
          `Active handles: ${known}. Call harness_start first.`,
      );
    }
    return entry;
  }

  /**
   * Dispose a session and remove it from the map.
   * Throws if the handle is unknown.
   */
  dispose(handle: string): void {
    const entry = this._sessions.get(handle);
    if (!entry) {
      throw new Error(
        `harness_dispose: unknown handle "${handle}". Already disposed?`,
      );
    }
    entry.session.dispose();
    this._sessions.delete(handle);
  }

  /** Number of active sessions. */
  get size(): number {
    return this._sessions.size;
  }

  /** All active handles. */
  handles(): string[] {
    return [...this._sessions.keys()];
  }

  /**
   * Dispose all sessions, clear the map, reset the counter.
   * Returns the number of sessions that were disposed.
   */
  reset(): number {
    let disposed = 0;
    for (const entry of this._sessions.values()) {
      entry.session.dispose();
      disposed++;
    }
    this._sessions.clear();
    this._counter = 0;
    return disposed;
  }
}
