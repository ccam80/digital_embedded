/// <reference types="vite/client" />
/**
 * Subcircuit navigation- drill down into subcircuit elements and back.
 *
 * Manages the circuit stack, breadcrumb UI, and afterMutate hook for
 * persisting subcircuit edits to IndexedDB.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import { Circuit } from '../core/circuit.js';
import { storeSubcircuit } from '../io/subcircuit-store.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';

// ---------------------------------------------------------------------------
// SubcircuitNavigator
// ---------------------------------------------------------------------------

export interface SubcircuitNavigator {
  openSubcircuit(name: string, subCircuit: Circuit): void;
  navigateBack(): void;
  readonly circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }>;
}

export function createSubcircuitNavigator(
  canvas: HTMLCanvasElement,
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  closePopup: () => void,
): SubcircuitNavigator {
  let currentCircuitName = 'Main';
  const circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }> = [];

  /** afterMutate hook saved before entering a subcircuit level, restored on navigateBack. */
  let _subcircuitAfterMutate: (() => void) | undefined;

  function updateBreadcrumb(): void {
    let breadcrumb = document.getElementById('circuit-breadcrumb');
    if (!breadcrumb) {
      breadcrumb = document.createElement('div');
      breadcrumb.id = 'circuit-breadcrumb';
      breadcrumb.style.cssText =
        'position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:100;display:flex;gap:4px;align-items:center;font-family:sans-serif;font-size:13px;color:#ccc;background:rgba(0,0,0,0.55);padding:2px 10px;border-radius:4px;pointer-events:auto;';
      canvas.parentElement!.appendChild(breadcrumb);
    }
    breadcrumb.innerHTML = '';

    const allEntries = [...circuitStack.map(s => s.name), currentCircuitName];
    for (let i = 0; i < allEntries.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = ' > ';
        sep.style.color = '#666';
        breadcrumb.appendChild(sep);
      }
      const crumb = document.createElement('span');
      crumb.textContent = allEntries[i];
      if (i < allEntries.length - 1) {
        crumb.style.cssText = 'cursor:pointer;color:#88f;text-decoration:underline;';
        const levelsBack = allEntries.length - 1 - i;
        crumb.addEventListener('click', () => {
          for (let j = 0; j < levelsBack; j++) navigateBack();
        });
      } else {
        crumb.style.fontWeight = 'bold';
      }
      breadcrumb.appendChild(crumb);
    }

    breadcrumb.style.display = circuitStack.length === 0 ? 'none' : 'flex';
  }

  function openSubcircuit(name: string, subCircuit: Circuit): void {
    circuitStack.push({
      name: currentCircuitName,
      circuit: ctx.circuit,
      zoom: ctx.viewport.zoom,
      pan: { x: ctx.viewport.pan.x, y: ctx.viewport.pan.y },
    });
    ctx.setCircuit(subCircuit);
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      const tb = (window as unknown as Record<string, unknown>).__test as { setCircuit?: (c: Circuit) => void } | undefined;
      tb?.setCircuit?.(subCircuit);
    }
    currentCircuitName = name;
    ctx.fitViewport();
    ctx.selection.clear();
    closePopup();
    updateBreadcrumb();
    renderPipeline.scheduleRender();

    // Wire on-edit persistence: re-serialize subcircuit to IndexedDB on every
    // undo stack mutation (push, undo, redo) while inside the drill-down.
    const prevAfterMutate = ctx.undoStack.afterMutate;
    _subcircuitAfterMutate = prevAfterMutate;
    ctx.undoStack.afterMutate = () => {
      prevAfterMutate?.();
      const subcircuitName = currentCircuitName;
      const xml = serializeCircuitToDig(ctx.circuit, ctx.registry);
      void storeSubcircuit(subcircuitName, xml).catch((err: unknown) => {
        console.error('Failed to persist subcircuit on edit:', err);
        ctx.showStatus(`ERROR: Failed to save subcircuit "${subcircuitName}"- changes may be lost on reload`);
      });
    };
  }

  function navigateBack(): void {
    if (circuitStack.length === 0) return;
    ctx.undoStack.afterMutate = _subcircuitAfterMutate;
    _subcircuitAfterMutate = undefined;

    const prev = circuitStack.pop()!;
    ctx.setCircuit(prev.circuit);
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      const tb = (window as unknown as Record<string, unknown>).__test as { setCircuit?: (c: Circuit) => void } | undefined;
      tb?.setCircuit?.(prev.circuit);
    }
    currentCircuitName = prev.name;
    ctx.viewport.zoom = prev.zoom;
    ctx.viewport.pan = prev.pan;
    ctx.selection.clear();
    closePopup();
    updateBreadcrumb();
    renderPipeline.scheduleRender();
  }

  return {
    openSubcircuit,
    navigateBack,
    get circuitStack() { return circuitStack; },
  };
}
