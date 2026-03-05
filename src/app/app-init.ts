/**
 * Application initialization sequence.
 *
 * Wires together the component registry, file resolver, editor, and toolbar
 * in the correct order. Called once on page load from main.ts.
 *
 * Browser-only: imports DOM-dependent modules. Do not import from Node.js
 * headless contexts.
 */

import { parseUrlParams, type SimulatorParams } from './url-params.js';
import { createDefaultResolver, type FileResolver } from '../io/file-resolver.js';

// ---------------------------------------------------------------------------
// AppContext — runtime state shared between modules
// ---------------------------------------------------------------------------

export interface AppContext {
  params: SimulatorParams;
  resolver: FileResolver;
  isIframe: boolean;
}

// ---------------------------------------------------------------------------
// initApp
// ---------------------------------------------------------------------------

/**
 * Initialize the simulator application.
 *
 * @param search  Optional URL search string. Defaults to window.location.search.
 * @returns       The initialized AppContext.
 */
export function initApp(search?: string): AppContext {
  const params = parseUrlParams(search);
  const resolver = createDefaultResolver(params.base);
  const isIframe = typeof window !== 'undefined'
    ? window.self !== window.top
    : false;

  applyColorScheme(params.dark);

  return { params, resolver, isIframe };
}

// ---------------------------------------------------------------------------
// applyColorScheme
// ---------------------------------------------------------------------------

/**
 * Apply dark or light color scheme to the document root.
 */
function applyColorScheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  }
}
