/**
 * Tutorial shared bundle — browser-safe barrel export for the tutorial editor.
 *
 * This module re-exports presets, type guards, and validation helpers
 * so that tutorial-editor.html can import them via a single <script type="module">.
 *
 * During dev: loaded directly as /src/tutorial/tutorial-bundle.ts (Vite transpiles).
 * In production: built as part of the main bundle or a separate entry.
 */

// Presets
export { PALETTE_PRESETS, resolvePaletteSpec, listPresets } from './presets.js';

// Type guards and URL safety check
export {
  isTutorialManifest,
  isTutorialStep,
  isTutorialHint,
  isTutorialCircuitSpec,
  isTutorialComponentSpec,
  isValidationMode,
  isUrlSafeId,
} from './types.js';

// Re-export types for documentation (erased at runtime)
export type {
  TutorialManifest,
  TutorialStep,
  TutorialHint,
  TutorialCircuitSpec,
  TutorialComponentSpec,
  ValidationMode,
  PaletteSpec,
  StepProgress,
  TutorialProgress,
} from './types.js';
