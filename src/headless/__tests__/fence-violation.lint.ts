/**
 * This file intentionally violates the browser-dep fence.
 * It should be caught by ESLint.
 *
 * The .lint.ts extension marks it as lint-only (excluded from typecheck).
 * ESLint errors here demonstrate that the fence is working correctly.
 */

// VIOLATION 1: Import from editor (headless cannot import editor code)
// @ts-ignore - Intentional fence violation for lint testing
import { CanvasRenderer } from '../../editor/canvas-renderer.js';

// VIOLATION 2: Use DOM globals (headless must be Node.js compatible)
const ctx = document.querySelector('canvas') as HTMLCanvasElement;

// VIOLATION 3: Use browser globals
window.addEventListener('load', () => {
  console.log('This violates the browser-dep fence');
});

// Export to use imports
export const violatingCode = {
  CanvasRenderer,
  ctx,
};
