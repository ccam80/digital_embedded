import { describe, it, expect, vi } from "vitest";
import { HarnessSessionState } from "../harness-session-state.js";
import type { HarnessEntry } from "../harness-session-state.js";

function makeMockEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    session: { dispose: vi.fn() } as any,
    dtsPath: "fixtures/test.dts",
    cirPath: "fixtures/test.cir",
    createdAt: new Date(),
    lastRunAt: null,
    analysis: null,
    ...overrides,
  };
}

describe("HarnessSessionState", () => {
  it("store() returns sequential handles h0, h1, ...", () => {
    const state = new HarnessSessionState();
    const h0 = state.store(makeMockEntry());
    const h1 = state.store(makeMockEntry());
    const h2 = state.store(makeMockEntry());
    expect(h0).toBe("h0");
    expect(h1).toBe("h1");
    expect(h2).toBe("h2");
  });

  it("get() returns the stored entry", () => {
    const state = new HarnessSessionState();
    const entry = makeMockEntry({ dtsPath: "my.dts" });
    const handle = state.store(entry);
    expect(state.get(handle, "test_tool")).toBe(entry);
  });

  it("get() throws with helpful message for unknown handle including known handles", () => {
    const state = new HarnessSessionState();
    state.store(makeMockEntry());
    state.store(makeMockEntry());
    expect(() => state.get("h99", "test_tool")).toThrow(/unknown handle "h99"/);
    expect(() => state.get("h99", "test_tool")).toThrow(/h0/);
    expect(() => state.get("h99", "test_tool")).toThrow(/h1/);
  });

  it("dispose() calls session.dispose()", () => {
    const state = new HarnessSessionState();
    const session = { dispose: vi.fn() } as any;
    const handle = state.store(makeMockEntry({ session }));
    state.dispose(handle);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("dispose() removes handle from map so subsequent get() throws", () => {
    const state = new HarnessSessionState();
    const handle = state.store(makeMockEntry());
    state.dispose(handle);
    expect(() => state.get(handle, "test_tool")).toThrow(/unknown handle/);
  });

  it("dispose() on unknown handle throws with 'Already disposed?' message", () => {
    const state = new HarnessSessionState();
    expect(() => state.dispose("h99")).toThrow(/Already disposed\?/);
  });

  it("size reflects live session count", () => {
    const state = new HarnessSessionState();
    expect(state.size).toBe(0);
    const h0 = state.store(makeMockEntry());
    expect(state.size).toBe(1);
    state.store(makeMockEntry());
    expect(state.size).toBe(2);
    state.dispose(h0);
    expect(state.size).toBe(1);
  });

  it("handles() returns all active handles", () => {
    const state = new HarnessSessionState();
    expect(state.handles()).toEqual([]);
    const h0 = state.store(makeMockEntry());
    const h1 = state.store(makeMockEntry());
    expect(state.handles()).toEqual([h0, h1]);
    state.dispose(h0);
    expect(state.handles()).toEqual([h1]);
  });
});
