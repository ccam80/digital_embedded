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

  return { base, file, dark, locked, panels, palette };
}
