/**
 * Keyboard shortcut handler — consolidates all three document keydown
 * listeners that were scattered through app-init.ts into a single handler.
 *
 * Covers:
 *  - Edit shortcuts (r/m/Delete/Backspace, Escape, Space start/stop)
 *  - Undo/redo (Ctrl+Z/Y), copy/cut/paste (Ctrl+C/X/V), select-all (Ctrl+A)
 *  - Fit viewport (Ctrl+Shift+F), placement shortcuts (i/o/c/v/g/l/t/w/R/1/+)
 *  - Search (Ctrl+F), presentation mode (F4, Escape)
 *  - File shortcuts (Ctrl+S, Ctrl+O)
 */

import type { AppContext } from './app-context.js';
import {
  deleteSelection,
  rotateSelection,
  mirrorSelection,
  copyToClipboard,
} from '../editor/edit-operations.js';
import type { Wire } from '../core/circuit.js';
import { snapToGrid } from '../editor/coordinates.js';

export interface KeyboardDeps {
  startSimulation(): void;
  stopSimulation(): void;
  invalidateCompiled(): void;
  hotRecompile(): void;
  closePopup(): void;
  openSearchBar(): void;
  togglePresentation(): void;
  exitPresentation(): void;
  isPresentationMode(): boolean;
  /** Navigate back in the subcircuit stack. Returns true if there was a stack entry. */
  navigateBack(): boolean;
  updateZoomDisplay(): void;
  /** Reset dragMode to 'none' — called after Escape cancels an active wire drag. */
  clearDragMode(): void;
  /** The file input element for Ctrl+O (may be null if not present in DOM). */
  fileInput: HTMLInputElement | null;
}

export function initKeyboardHandler(ctx: AppContext, deps: KeyboardDeps): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;

    // --- Presentation-mode shortcuts (no input-field guard) ---
    if (e.key === 'F4') {
      e.preventDefault();
      deps.togglePresentation();
      return;
    }

    // Escape exits presentation mode in addition to normal Escape handling below
    if (e.key === 'Escape' && deps.isPresentationMode()) {
      deps.exitPresentation();
      return;
    }

    // --- Input-field guard: skip shortcuts when typing, except Escape ---
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') {
        deps.closePopup();
      }
      return;
    }

    // --- File shortcuts (Ctrl+S / Ctrl+O) ---
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('btn-save')?.click();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      deps.fileInput?.click();
      return;
    }

    // --- Escape: cancel active modes or navigate back ---
    if (e.key === 'Escape') {
      if (ctx.placement.isActive()) {
        ctx.placement.cancel();
        ctx.scheduleRender();
      } else if (ctx.wireDrawing.isActive()) {
        ctx.wireDrawing.cancel();
        ctx.scheduleRender();
      } else if (ctx.wireDrag.isActive()) {
        ctx.wireDrag.cancel();
        deps.clearDragMode();
        deps.hotRecompile();
        ctx.scheduleRender();
      } else {
        deps.navigateBack();
      }
      return;
    }

    // --- Space: toggle simulation ---
    if (e.key === ' ') {
      e.preventDefault();
      if (ctx.isSimActive()) {
        deps.stopSimulation();
        ctx.binding.unbind();
        ctx.facade.invalidate();
        ctx.compiledDirty = true;
        ctx.scheduleRender();
      } else {
        if (!ctx.ensureCompiled()) return;
        deps.startSimulation();
      }
      return;
    }

    // Block all edit shortcuts during simulation
    if (ctx.isSimActive()) return;

    // --- Single-letter placement shortcuts (no Ctrl/Meta) ---
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === 'i' || e.key === 'I') {
        const def = ctx.registry.get('In');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'o' || e.key === 'O') {
        const def = ctx.registry.get('Out');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'c' || e.key === 'C') {
        const def = ctx.registry.get('Capacitor');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === '1') {
        const def = ctx.registry.get('Const');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'v' || e.key === 'V') {
        const def = ctx.registry.get('VoltageSource');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === '+') {
        const def = ctx.registry.get('VDD');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        const def = ctx.registry.get('Inductor');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        const def = ctx.registry.get('Tunnel');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        const def = ctx.registry.get('Ground');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        if (ctx.placement.isActive()) ctx.placement.cancel();
        const snapped = snapToGrid(ctx.lastWorldPt, 1);
        ctx.wireDrawing.startFromPoint(snapped);
        ctx.scheduleRender();
        return;
      }
      if (e.key === 'p' || e.key === 'P') {
        const def = ctx.registry.get('Port');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'R') {
        const def = ctx.registry.get('Resistor');
        if (def) { ctx.placement.start(def); ctx.scheduleRender(); }
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        ctx.selection.expandWireSelection(ctx.circuit);
        ctx.scheduleRender();
        return;
      }
    }

    // --- r: rotate placement ghost or selection ---
    if (e.key === 'r') {
      if (ctx.placement.isActive()) {
        ctx.placement.rotate();
        ctx.scheduleRender();
      } else if (!ctx.selection.isEmpty()) {
        const elements = [...ctx.selection.getSelectedElements()];
        if (elements.length > 0) {
          const cmd = rotateSelection(elements);
          ctx.undoStack.push(cmd);
          deps.hotRecompile();
        }
      }
      return;
    }

    // --- m/M: mirror placement ghost or selection ---
    if (e.key === 'm' || e.key === 'M') {
      if (ctx.placement.isActive()) {
        ctx.placement.mirror();
        ctx.scheduleRender();
      } else if (!ctx.selection.isEmpty()) {
        const elements = [...ctx.selection.getSelectedElements()];
        if (elements.length > 0) {
          const cmd = mirrorSelection(elements);
          ctx.undoStack.push(cmd);
          deps.hotRecompile();
        }
      }
      return;
    }

    // --- Delete / Backspace: delete selection ---
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!ctx.selection.isEmpty()) {
        const elements = [...ctx.selection.getSelectedElements()];
        const wires: Wire[] = [...ctx.selection.getSelectedWires()];
        const cmd = deleteSelection(ctx.circuit, elements, wires);
        ctx.undoStack.push(cmd);
        ctx.selection.clear();
        deps.hotRecompile();
      }
      return;
    }

    // --- Ctrl+Z: undo ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      ctx.undoStack.undo();
      deps.hotRecompile();
      return;
    }

    // --- Ctrl+Shift+Z / Ctrl+Y: redo ---
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y')) {
      ctx.undoStack.redo();
      deps.hotRecompile();
      return;
    }

    // --- Ctrl+C: copy ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      if (!ctx.selection.isEmpty()) {
        ctx.clipboard = copyToClipboard(
          [...ctx.selection.getSelectedElements()],
          [...ctx.selection.getSelectedWires()],
          (typeId: string) => ctx.registry.get(typeId),
        );
      }
      return;
    }

    // --- Ctrl+X: cut ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      if (!ctx.selection.isEmpty()) {
        ctx.clipboard = copyToClipboard(
          [...ctx.selection.getSelectedElements()],
          [...ctx.selection.getSelectedWires()],
          (typeId: string) => ctx.registry.get(typeId),
        );
        const elements = [...ctx.selection.getSelectedElements()];
        const wires: Wire[] = [...ctx.selection.getSelectedWires()];
        const cmd = deleteSelection(ctx.circuit, elements, wires);
        ctx.undoStack.push(cmd);
        ctx.selection.clear();
        deps.hotRecompile();
      }
      return;
    }

    // --- Ctrl+V: paste ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      if (ctx.clipboard.entries.length > 0 || ctx.clipboard.wires.length > 0) {
        ctx.placement.startPaste(ctx.clipboard);
        ctx.placement.updateCursor(ctx.lastWorldPt);
        ctx.scheduleRender();
      }
      return;
    }

    // --- Ctrl+A: select all ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      ctx.selection.selectAll(ctx.circuit);
      ctx.scheduleRender();
      return;
    }

    // --- Ctrl+Shift+F: fit viewport ---
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      ctx.fitViewport();
      deps.updateZoomDisplay();
      ctx.scheduleRender();
      return;
    }

    // --- Ctrl+F: open search bar ---
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      deps.openSearchBar();
      return;
    }
  });
}
