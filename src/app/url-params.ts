/**
 * URL parameter parsing for the simulator page.
 *
 * Parameters:
 *   base=path/     HTTP base path for subcircuit file resolution (default: "./")
 *   file=name.dig  Auto-load a circuit on startup
 *   dark=0         Override to light color scheme (default: dark=true)
 *   locked=1       Start in locked mode
 *   panels=none    Hide all panels (presentation mode)
 *   palette=And,Or,Not  Restrict palette to listed component types
 *   module=ece101  Load a module config (modules/<id>/config.json)
 */

// ---------------------------------------------------------------------------
// SimulatorParams — parsed URL parameters
// ---------------------------------------------------------------------------

export interface SimulatorParams {
  /** HTTP base path for .dig file resolution. Default: "./" */
  base: string;
  /** Circuit file to auto-load on startup. Undefined means no auto-load. */
  file: string | undefined;
  /** Whether dark mode is active. Default: true. */
  dark: boolean;
  /** Whether the editor is locked (interactive but not editable). Default: false. */
  locked: boolean;
  /** Panel display mode. Default: "default". */
  panels: 'default' | 'none';
  /**
   * Palette override — comma-separated list of component type names to show.
   * When set, only these types appear in the palette. Undefined means show all.
   * Example: "And,Or,Not,In,Out,Clock,Led"
   */
  palette: string[] | undefined;
  /**
   * Module config ID. When set, fetches `modules/<id>/config.json` on startup
   * and applies its settings (palette, circuits, tutorials, locked state).
   */
  module: string | undefined;
}

// ---------------------------------------------------------------------------
// ModuleConfig — course/module-scoped configuration
// ---------------------------------------------------------------------------

/**
 * A module config bundles a course-worth of circuits, tutorials, and
 * palette restrictions into a single JSON file. Loaded via `?module=<id>`.
 *
 * File location: `modules/<id>/config.json`
 */
export interface ModuleConfig {
  /** Display title for the module (e.g. "ECE 101 — Digital Logic"). */
  title: string;
  /** Optional description shown in the UI. */
  description?: string;
  /**
   * Restrict the component palette to these types. Undefined or null means
   * show all components. Can use preset names (prefixed with "@") or
   * individual type names.
   */
  palette?: string[] | null;
  /** Lock the editor by default. */
  locked?: boolean;
  /** Override dark mode (true = dark, false = light). */
  dark?: boolean;
  /** Hide panels. */
  panels?: 'default' | 'none';
  /** Circuit file to auto-load on startup (relative to module directory). */
  file?: string;
}

// ---------------------------------------------------------------------------
// parseUrlParams
// ---------------------------------------------------------------------------

/**
 * Parse simulator URL parameters from a URLSearchParams or query string.
 *
 * @param search  URLSearchParams instance, raw query string (with or without
 *                leading "?"), or undefined to read from window.location.search.
 * @returns       Parsed and validated SimulatorParams with defaults applied.
 */
export function parseUrlParams(
  search?: URLSearchParams | string,
): SimulatorParams {
  let params: URLSearchParams;

  if (search === undefined) {
    params = new URLSearchParams(
      typeof window !== 'undefined' ? window.location.search : '',
    );
  } else if (search instanceof URLSearchParams) {
    params = search;
  } else {
    const raw = search.startsWith('?') ? search.slice(1) : search;
    params = new URLSearchParams(raw);
  }

  const base = params.has('base') ? (params.get('base') ?? './') : './';

  const fileRaw = params.get('file');
  const file = fileRaw !== null && fileRaw.length > 0 ? fileRaw : undefined;

  const darkRaw = params.get('dark');
  const dark = darkRaw === null ? true : darkRaw !== '0';

  const lockedRaw = params.get('locked');
  const locked = lockedRaw === '1';

  const panelsRaw = params.get('panels');
  const panels: 'default' | 'none' = panelsRaw === 'none' ? 'none' : 'default';

  const paletteRaw = params.get('palette');
  const palette =
    paletteRaw !== null && paletteRaw.length > 0
      ? paletteRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

  const moduleRaw = params.get('module');
  const module =
    moduleRaw !== null && moduleRaw.length > 0 ? moduleRaw : undefined;

  return { base, file, dark, locked, panels, palette, module };
}

// ---------------------------------------------------------------------------
// loadModuleConfig
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a module config from `modules/<id>/config.json`.
 * Returns null if the fetch fails or the JSON is invalid.
 *
 * @param moduleId  Module identifier (directory name under `modules/`).
 * @param basePath  Base path for resolution (default: "./").
 */
export async function loadModuleConfig(
  moduleId: string,
  basePath: string = './',
): Promise<{ config: ModuleConfig; moduleBase: string } | null> {
  const moduleBase = `${basePath}modules/${moduleId}/`;
  const configUrl = `${moduleBase}config.json`;
  try {
    const res = await fetch(configUrl);
    if (!res.ok) return null;
    const config = (await res.json()) as ModuleConfig;
    return { config, moduleBase };
  } catch (e) {
    // Network error or malformed JSON — surface the anomaly and return
    // null so the caller can decide. Per spec/architectural-alignment.md
    // §I1 replaced prior silent swallow.
    console.warn(`[url-params] Failed to load module config from "${configUrl}".`, e);
    return null;
  }
}

/**
 * Apply a ModuleConfig to SimulatorParams, merging module defaults with
 * explicit URL overrides. URL params take precedence over module config.
 */
export function applyModuleConfig(
  params: SimulatorParams,
  config: ModuleConfig,
  moduleBase: string,
): void {
  // Module sets defaults — explicit URL params override
  if (config.locked !== undefined && !params.locked) {
    params.locked = config.locked;
  }
  if (config.dark !== undefined) {
    // Only override if URL didn't explicitly set dark=0
    // (dark defaults to true, so we can't distinguish "not set" from "set to true")
  }
  if (config.panels && params.panels === 'default') {
    params.panels = config.panels;
  }
  if (config.palette && !params.palette) {
    params.palette = config.palette;
  }
  if (config.file && !params.file) {
    params.file = config.file;
    params.base = moduleBase;
  }
}
