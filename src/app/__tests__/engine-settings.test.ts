/**
 * Engine/playback settings persistence (Surface 1- headless).
 *
 * Covers the contract that fixes "speed setting not respected on restart": the
 * playback rate must round-trip through storage, a stored blob that omits
 * playbackSpeed must default it (not undefined), and a non-positive or
 * malformed rate must fall back to the default rather than corrupt the engine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadEngineSettings,
  saveEngineSettings,
  DEFAULT_ENGINE_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from '../engine-settings.js';

class MockStorage implements Storage {
  private _store = new Map<string, string>();
  get length(): number { return this._store.size; }
  key(i: number): string | null { return [...this._store.keys()][i] ?? null; }
  getItem(k: string): string | null { return this._store.get(k) ?? null; }
  setItem(k: string, v: string): void { this._store.set(k, v); }
  removeItem(k: string): void { this._store.delete(k); }
  clear(): void { this._store.clear(); }
}

describe('engine settings persistence', () => {
  let storage: MockStorage;
  beforeEach(() => { storage = new MockStorage(); });

  it('returns defaults (playbackSpeed 1e-3) when nothing is stored', () => {
    expect(loadEngineSettings(storage)).toEqual(DEFAULT_ENGINE_SETTINGS);
    expect(loadEngineSettings(storage).playbackSpeed).toBe(1e-3);
  });

  it('round-trips a chosen playback speed', () => {
    const settings = { ...DEFAULT_ENGINE_SETTINGS, playbackSpeed: 5 };
    saveEngineSettings(storage, settings);
    expect(loadEngineSettings(storage).playbackSpeed).toBe(5);
  });

  it('persists playback speed independently of the other engine fields', () => {
    saveEngineSettings(storage, {
      snapshotBudgetMb: 128,
      oscillationLimit: 2000,
      currentSpeedScale: 50,
      currentScaleMode: 'logarithmic',
      playbackSpeed: 2e-6,
    });
    const loaded = loadEngineSettings(storage);
    expect(loaded.playbackSpeed).toBe(2e-6);
    expect(loaded.snapshotBudgetMb).toBe(128);
    expect(loaded.currentScaleMode).toBe('logarithmic');
  });

  it('defaults playbackSpeed when the stored blob omits it', () => {
    // A stored blob that has no playbackSpeed key.
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      snapshotBudgetMb: 64,
      oscillationLimit: 1000,
      currentSpeedScale: 200,
      currentScaleMode: 'linear',
    }));
    expect(loadEngineSettings(storage).playbackSpeed).toBe(1e-3);
  });

  it('falls back to the default for a non-positive or non-finite rate', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ playbackSpeed: bad }));
      expect(loadEngineSettings(storage).playbackSpeed).toBe(1e-3);
    }
  });
});
