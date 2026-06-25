/**
 * Engine + playback preferences- typed access with localStorage persistence.
 *
 * These are session-global preferences (not per-circuit): snapshot budget,
 * oscillation limit, current-flow visualization scaling, and the transient
 * playback speed. They persist under a single localStorage key as one JSON
 * object. Kept as pure functions taking an explicit Storage so the persistence
 * contract is unit-testable without a DOM.
 *
 * Playback speed lives here- not on the coordinator- because compile() builds a
 * fresh coordinator each time (whose speed reverts to the engine default), so
 * the user's chosen rate must survive recompiles in a layer above the engine.
 */

export const SETTINGS_STORAGE_KEY = 'digital-js:engine-settings';

export interface EngineSettings {
  snapshotBudgetMb: number;
  oscillationLimit: number;
  currentSpeedScale: number;
  currentScaleMode: 'linear' | 'logarithmic';
  /** Transient playback rate in sim-seconds per wall-second (matches coordinator.speed). */
  playbackSpeed: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  snapshotBudgetMb: 64,
  oscillationLimit: 1000,
  currentSpeedScale: 200,
  currentScaleMode: 'linear',
  playbackSpeed: 1e-3,
};

/** A finite, strictly-positive number, or the fallback. */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadEngineSettings(storage: Storage): EngineSettings {
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch (err) {
    throw new Error(`Failed to load engine settings from localStorage: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null) return { ...DEFAULT_ENGINE_SETTINGS };

  let parsed: Partial<EngineSettings>;
  try {
    parsed = JSON.parse(raw) as Partial<EngineSettings>;
  } catch (err) {
    throw new Error(`Failed to load engine settings from localStorage: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    snapshotBudgetMb: positiveOr(parsed.snapshotBudgetMb, DEFAULT_ENGINE_SETTINGS.snapshotBudgetMb),
    oscillationLimit: positiveOr(parsed.oscillationLimit, DEFAULT_ENGINE_SETTINGS.oscillationLimit),
    currentSpeedScale: positiveOr(parsed.currentSpeedScale, DEFAULT_ENGINE_SETTINGS.currentSpeedScale),
    currentScaleMode: parsed.currentScaleMode === 'logarithmic' ? 'logarithmic' : 'linear',
    playbackSpeed: positiveOr(parsed.playbackSpeed, DEFAULT_ENGINE_SETTINGS.playbackSpeed),
  };
}

export function saveEngineSettings(storage: Storage, settings: EngineSettings): void {
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
