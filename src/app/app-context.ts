/**
 * AppContext- shared state interface for app-init sub-modules.
 *
 * This is the typed contract between app-init.ts and the modules it will
 * delegate to. All shared state lives here; modules receive a reference to
 * the concrete object rather than capturing closure locals.
 *
 * This file contains only the interface declaration- no implementation.
 * The concrete object is built in app-init.ts after all locals are created.
 */

import type { Circuit } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { DefaultSimulatorFacade } from '../headless/default-facade.js';
import type { EditorBinding } from '../integration/editor-binding.js';
import type { SelectionModel } from '../editor/selection.js';
import type { Viewport } from '../editor/viewport.js';
import type { UndoRedoStack } from '../editor/undo-redo.js';
import type { PlacementMode } from '../editor/placement.js';
import type { WireDrawingMode } from '../editor/wire-drawing.js';
import type { WireDragMode } from '../editor/wire-drag.js';
import type { CanvasRenderer } from '../editor/canvas-renderer.js';
import type { ElementRenderer } from '../editor/element-renderer.js';
import type { WireRenderer } from '../editor/wire-renderer.js';
import type { GridRenderer } from '../editor/grid.js';
import type { LockedModeGuard } from '../editor/locked-mode.js';
import type { ColorSchemeManager } from '../editor/color-scheme.js';
import type { ContextMenu } from '../editor/context-menu.js';
import type { ComponentPalette } from '../editor/palette.js';
import type { PaletteUI } from '../editor/palette-ui.js';
import type { ClipboardData } from '../editor/edit-operations.js';
import type { Point } from '../core/renderer-interface.js';
import type { SimulatorParams } from './url-params.js';
import type { HttpResolver } from '../io/file-resolver.js';

export interface AppContext {
  // --- Core state ---
  /** Current circuit- mutable; modules may reassign via setCircuit(). */
  circuit: Circuit;
  readonly registry: ComponentRegistry;
  readonly facade: DefaultSimulatorFacade;
  readonly binding: EditorBinding;
  readonly analogTypeIds: ReadonlySet<string>;

  // --- Editor subsystems ---
  readonly canvas: HTMLCanvasElement;
  readonly viewport: Viewport;
  readonly selection: SelectionModel;
  readonly placement: PlacementMode;
  readonly wireDrawing: WireDrawingMode;
  readonly wireDrag: WireDragMode;
  readonly undoStack: UndoRedoStack;
  readonly lockedModeGuard: LockedModeGuard;
  readonly colorSchemeManager: ColorSchemeManager;
  readonly contextMenu: ContextMenu;
  readonly palette: ComponentPalette;
  readonly paletteUI: PaletteUI;

  // --- Renderers ---
  readonly canvasRenderer: CanvasRenderer;
  readonly elementRenderer: ElementRenderer;
  readonly wireRenderer: WireRenderer;
  readonly gridRenderer: GridRenderer;

  // --- Mutable flags ---
  compiledDirty: boolean;
  clipboard: ClipboardData;
  lastWorldPt: Point;

  // --- URL params & environment ---
  readonly params: SimulatorParams;
  readonly isIframe: boolean;
  readonly httpResolver: HttpResolver;

  // --- Helper methods ---

  /** Request a canvas repaint on the next animation frame. */
  scheduleRender(): void;

  /** Mark compiled state dirty and tear down the running engine. */
  invalidateCompiled(): void;

  /** Hot-recompile: preserve simulation state across a recompile if running. */
  hotRecompile(): void;

  /**
   * Compile the current circuit and bind the editor to the new engine.
   * Returns true on success, false if compilation failed (status bar updated).
   */
  compileAndBind(): boolean;

  /**
   * Ensure the circuit is compiled. If dirty, calls compileAndBind().
   * Returns false if compilation failed- callers should abort their action.
   *
   * Replaces the pattern: `if (compiledDirty && !compileAndBind()) return;`
   */
  ensureCompiled(): boolean;

  /** Show a message in the status bar. Pass isError=true for error styling. */
  showStatus(message: string, isError?: boolean): void;

  /** Reset the status bar to "Ready". */
  clearStatus(): void;

  /** True when a simulation is active (any circuit type). */
  isSimActive(): boolean;

  /**
   * Fit the viewport to the current circuit elements using the canvas size.
   * Replaces: `viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight })`
   */
  fitViewport(): void;

  /**
   * Replace circuit contents from a loaded Circuit object, reset selection,
   * fit viewport, and invalidate compiled state.
   */
  applyLoadedCircuit(loaded: Circuit): void;

  /** Reassign the active circuit (used by subcircuit navigation). */
  setCircuit(c: Circuit): void;

  /** Read the active circuit. */
  getCircuit(): Circuit;
}
