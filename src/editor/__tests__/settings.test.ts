import { describe, it, expect, beforeEach } from "vitest";
import { AppSettings, SettingKey } from "../settings.js";

// ---------------------------------------------------------------------------
// Minimal localStorage mock usable in a Node/jsdom environment
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

describe("Settings", () => {
  let storage: MockStorage;
  let settings: AppSettings;

  beforeEach(() => {
    storage = new MockStorage();
    settings = new AppSettings(storage);
  });

  it("defaultValues", () => {
    expect(settings.get(SettingKey.GRID_SIZE)).toBe(1);
    expect(settings.get(SettingKey.DEFAULT_DELAY)).toBe(1);
    expect(settings.get(SettingKey.COLOR_SCHEME)).toBe("default");
    expect(settings.get(SettingKey.LANGUAGE)).toBe("en");
    expect(settings.get(SettingKey.SIM_SPEED)).toBe(1);
    expect(settings.get(SettingKey.DEFAULT_RADIX)).toBe("hex");
    expect(settings.get(SettingKey.GATE_SHAPE)).toBe("ieee");
    expect(settings.get(SettingKey.SNAP_TO_GRID)).toBe(true);
  });

  it("persistsToLocalStorage", () => {
    settings.set(SettingKey.GRID_SIZE, 5);
    settings.save();

    const settings2 = new AppSettings(storage);
    settings2.load();

    expect(settings2.get(SettingKey.GRID_SIZE)).toBe(5);
  });

  it("resetRestoresDefault", () => {
    settings.set(SettingKey.GRID_SIZE, 8);
    expect(settings.get(SettingKey.GRID_SIZE)).toBe(8);

    settings.reset(SettingKey.GRID_SIZE);
    expect(settings.get(SettingKey.GRID_SIZE)).toBe(1);
  });

  it("onChangeFiresOnSet", () => {
    const fired: number[] = [];
    settings.onChange(SettingKey.GRID_SIZE, (v) => fired.push(v));

    settings.set(SettingKey.GRID_SIZE, 3);
    expect(fired).toEqual([3]);
  });
});
