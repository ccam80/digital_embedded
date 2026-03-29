/**
 * CanvasInteraction — coordinator that wires together all canvas event handlers.
 *
 * Creates shared state, then delegates to focused handler modules:
 *   canvas-pointer      — pointerdown/pointermove/pointerup/pointercancel
 *   canvas-wheel        — wheel zoom
 *   canvas-dblclick     — property popup / memory editor / subcircuit nav
 *   canvas-popup        — property popup lifecycle
 *   canvas-subcircuit   — subcircuit navigation stack + breadcrumb
 *   canvas-memory-editor — hex editor overlay
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import type { SimulationController } from './simulation-controller.js';
import { Circuit } from '../core/circuit.js';
import { createCanvasState } from './canvas-shared-state.js';
import { createPopupController } from './canvas-popup.js';
import { createSubcircuitNavigator } from './canvas-subcircuit.js';
import { createMemoryEditorController } from './canvas-memory-editor.js';
import { registerPointerHandlers } from './canvas-pointer.js';
import { registerWheelHandler } from './canvas-wheel.js';
import { registerDblClickHandler } from './canvas-dblclick.js';
import type { CircuitElement } from '../core/element.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CanvasInteractionDeps {
  startSimulation(): void;
  stopSimulation(): void;
  compileAndBind(): boolean;
}

export interface CanvasInteraction {
  closePopup(): void;
  openPopup(elementHit: CircuitElement, screenPt: { x: number; y: number }, container: HTMLElement): void;
  navigateBack(): void;
  openSubcircuit(name: string, subCircuit: Circuit): void;
  openMemoryEditor(element: CircuitElement): Promise<void>;
  readonly circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }>;
}

// ---------------------------------------------------------------------------
// initCanvasInteraction
// ---------------------------------------------------------------------------

export function initCanvasInteraction(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  _simController: SimulationController,
  deps: CanvasInteractionDeps,
): CanvasInteraction {
  ctx.canvas.style.touchAction = 'none';

  // Shared mutable state passed to all handler modules.
  const state = createCanvasState();

  // Subsystem controllers.
  const popup = createPopupController(ctx, renderPipeline, deps);
  const navigator = createSubcircuitNavigator(ctx.canvas, ctx, renderPipeline, popup.closePopup);
  const memoryEditor = createMemoryEditorController(ctx);

  // Register event handlers.
  registerPointerHandlers(ctx, renderPipeline, deps, state, popup.closePopup);
  registerWheelHandler(ctx, renderPipeline);
  registerDblClickHandler(ctx, renderPipeline, popup, navigator, memoryEditor);

  return {
    closePopup: popup.closePopup,
    openPopup: popup.openPopup,
    navigateBack: navigator.navigateBack,
    openSubcircuit: navigator.openSubcircuit,
    openMemoryEditor: memoryEditor.openMemoryEditor,
    get circuitStack() { return navigator.circuitStack; },
  };
}
