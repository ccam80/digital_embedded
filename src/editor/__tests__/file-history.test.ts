import { describe, it, expect, beforeEach } from "vitest";
import { FileHistory } from "../file-history.js";

// ---------------------------------------------------------------------------
// Minimal localStorage mock
// ---------------------------------------------------------------------------

class MockStorage implements Storage {
  private _store: Map<string, string> = new Map();

  get length(): number {
    return this._store.size;
  }

  key(index: number): string | null {
    return [...this._store.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this._store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this._store.set(key, value);
  }

  removeItem(key: string): void {
    this._store.delete(key);
  }

  clear(): void {
    this._store.clear();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileHistory", () => {
  let storage: MockStorage;
  let history: FileHistory;

  beforeEach(() => {
    storage = new MockStorage();
    history = new FileHistory(storage);
  });

  it("addsToFront", () => {
    history.add("a.dig");
    history.add("b.dig");
    expect(history.getRecent()).toEqual(["b.dig", "a.dig"]);
  });

  it("deduplicates", () => {
    history.add("a.dig");
    history.add("a.dig");
    const recent = history.getRecent();
    expect(recent).toEqual(["a.dig"]);
    expect(recent.length).toBe(1);
  });

  it("trimsToTen", () => {
    for (let i = 0; i < 12; i++) {
      history.add(`file${i}.dig`);
    }
    expect(history.getRecent().length).toBe(10);
  });

  it("persistsToLocalStorage", () => {
    history.add("a.dig");
    history.add("b.dig");
    history.save();

    const history2 = new FileHistory(storage);
    history2.load();
    expect(history2.getRecent()).toEqual(["b.dig", "a.dig"]);
  });
});
