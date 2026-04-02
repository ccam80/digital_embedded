/**
 * RenderPipeline — canvas rendering loop, coordinate helpers, canvas management.
 *
 * Extracted from app-init.ts (Step 3 of modularization plan).
 * Owns: resizeCanvas, scheduleRender, renderFrame, frame profiling,
 * diagnostic overlays, canvas rect cache, coordinate helpers, sizeCanvasInContainer.
 */

import type { AppContext } from './app-context.js';
import { screenToWorld, GRID_SPACING } from '../editor/coordinates.js';
import type { Point } from '../core/renderer-interface.js';
import type { Wire } from '../core/circuit.js';
import type { WireSignalAccess } from '../editor/wire-signal-access.js';
import type { CurrentFlowAnimator } from '../editor/current-animation.js';
import type { ScopePanel } from '../runtime/analog-scope-panel.js';
import type { Diagnostic } from '../compile/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BoxSelectState {
  active: boolean;
  startScreen: Point;
  currentScreen: Point;
}

export interface ScopePanelEntry {
  canvas: HTMLCanvasElement;
  panel: ScopePanel;
}

export interface RenderState {
  diagnosticOverlays: Array<{ x: number; y: number; severity: 'error' | 'warning' }>;
  boxSelect: BoxSelectState;
  currentFlowAnimator: CurrentFlowAnimator | null;
  scopePanels: ScopePanelEntry[];
}

export interface RenderPipeline {
  scheduleRender(): void;
  resizeCanvas(): void;
  canvasToWorld(e: { clientX: number; clientY: number }): Point;
  canvasToScreen(e: { clientX: number; clientY: number }): Point;
  invalidateCanvasRect(): void;
  sizeCanvasInContainer(cvs: HTMLCanvasElement): boolean;
  populateDiagnosticOverlays(diags: Diagnostic[], wireToNodeId: Map<Wire, number>): void;
  clearDiagnosticOverlays(): void;
  readonly state: RenderState;
}

// ---------------------------------------------------------------------------
// initRenderPipeline
// ---------------------------------------------------------------------------

export function initRenderPipeline(ctx: AppContext, search?: string): RenderPipeline {
  const canvas = ctx.canvas;
  const ctx2d = canvas.getContext('2d')!;

  // Shared render state exposed to other modules
  const state: RenderState = {
    diagnosticOverlays: [],
    boxSelect: {
      active: false,
      startScreen: { x: 0, y: 0 },
      currentScreen: { x: 0, y: 0 },
    },
    currentFlowAnimator: null,
    scopePanels: [],
  };

  // -------------------------------------------------------------------------
  // Canvas sizing
  // -------------------------------------------------------------------------

  // Cached canvas dimensions — avoids forced synchronous layout reflow
  // from reading clientWidth/clientHeight on every render frame.
  let _canvasW = 0;
  let _canvasH = 0;

  function resizeCanvas(): void {
    const container = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    _canvasW = container.clientWidth;
    _canvasH = container.clientHeight;
    canvas.width = _canvasW * dpr;
    canvas.height = _canvasH * dpr;
    canvas.style.width = `${_canvasW}px`;
    canvas.style.height = `${_canvasH}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeCanvas();
  window.addEventListener('resize', () => {
    invalidateCanvasRect();
    resizeCanvas();
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  let renderScheduled = false;

  function scheduleRender(): void {
    if (!renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(renderFrame);
    }
  }

  // Frame profiling — enabled via ?profile query param or console: _enableFrameProfile()
  let _frameProfileEnabled = search?.includes('profile') ?? false;
  let _frameProfileSamples: number[] = [];
  (window as any)._enableFrameProfile = () => { _frameProfileEnabled = true; _frameProfileSamples = []; };
  (window as any)._disableFrameProfile = () => {
    _frameProfileEnabled = false;
    if (_frameProfileSamples.length > 0) {
      const sorted = _frameProfileSamples.slice().sort((a, b) => a - b);
      const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      console.log(`Frame profile (${sorted.length} frames): avg=${avg.toFixed(1)}ms p50=${p50!.toFixed(1)}ms p95=${p95!.toFixed(1)}ms p99=${p99!.toFixed(1)}ms max=${sorted[sorted.length-1]!.toFixed(1)}ms`);
    }
    _frameProfileSamples = [];
  };

  // Wire signal access adapter — reads live signal values for wire coloring.
  const wireSignalAccessAdapter: WireSignalAccess = {
    getWireValue(wire: Wire): { raw: number; width: number } | { voltage: number } | undefined {
      const coordinator = ctx.facade.getCoordinator();
      const addr = coordinator.compiled.wireSignalMap.get(wire);
      if (addr === undefined) return undefined;
      const sv = coordinator.readSignal(addr);
      if (sv.type === 'analog') {
        return { voltage: sv.voltage };
      }
      return { raw: sv.value, width: addr.domain === 'digital' ? addr.bitWidth : 1 };
    },
  };

  function renderFrame(): void {
    renderScheduled = false;
    const _t0 = _frameProfileEnabled ? performance.now() : 0;
    const dpr = window.devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Use cached dimensions — avoids forced synchronous layout reflow.
    const w = _canvasW;
    const h = _canvasH;

    ctx2d.clearRect(0, 0, w, h);

    const screenRect = { x: 0, y: 0, width: w, height: h };
    ctx.gridRenderer.render(ctx.canvasRenderer, screenRect, ctx.viewport.zoom, ctx.viewport.pan);

    ctx2d.save();
    ctx2d.translate(ctx.viewport.pan.x, ctx.viewport.pan.y);
    const gridScale = ctx.viewport.zoom * GRID_SPACING;
    ctx2d.scale(gridScale, gridScale);
    ctx.canvasRenderer.setGridScale(gridScale);

    const worldRect = ctx.viewport.getVisibleWorldRect({ width: w, height: h });
    ctx.elementRenderer.render(ctx.canvasRenderer, ctx.circuit, ctx.selection.getSelectedElements(), worldRect);

    ctx.wireRenderer.render(
      ctx.canvasRenderer,
      ctx.circuit.wires,
      ctx.selection.getSelectedWires(),
      !ctx.compiledDirty ? wireSignalAccessAdapter : undefined,
    );
    ctx.wireRenderer.renderJunctionDots(ctx.canvasRenderer, ctx.circuit.wires);
    ctx.wireRenderer.renderBusWidthMarkers(ctx.canvasRenderer, ctx.circuit.wires);
    ctx.wireRenderer.renderOverrideIndicators(ctx.canvasRenderer, ctx.circuit.wires);

    if (state.currentFlowAnimator !== null) {
      state.currentFlowAnimator.render(ctx.canvasRenderer, ctx.circuit);
    }

    const ghosts = ctx.placement.getGhosts();
    for (const ghost of ghosts) {
      ctx2d.save();
      ctx2d.globalAlpha = 0.5;
      ctx2d.translate(ghost.position.x, ghost.position.y);
      if (ghost.rotation !== 0) {
        // Negate the angle to match ElementRenderer's convention:
        // rotatePoint uses (x,y)→(y,-x) for rot=1, which corresponds
        // to rotate(-PI/2) in Canvas2D coordinates.
        ctx2d.rotate(-(ghost.rotation * Math.PI) / 2);
      }
      if (ghost.mirror) {
        // Mirror negates Y in local space, matching ElementRenderer.
        ctx2d.scale(1, -1);
      }
      ghost.element.draw(ctx.canvasRenderer);
      ctx2d.restore();
    }
    const pasteWires = ctx.placement.getPasteWireGhosts();
    if (pasteWires.length > 0) {
      ctx2d.save();
      ctx2d.globalAlpha = 0.5;
      ctx.canvasRenderer.setColor('WIRE');
      ctx.canvasRenderer.setLineWidth(2);
      for (const pw of pasteWires) {
        ctx.canvasRenderer.drawLine(pw.start.x, pw.start.y, pw.end.x, pw.end.y);
      }
      ctx2d.restore();
    }

    if (ctx.wireDrawing.isActive()) {
      const preview = ctx.wireDrawing.getPreviewSegments();
      if (preview) {
        ctx.canvasRenderer.setColor('WIRE');
        ctx.canvasRenderer.setLineWidth(2);
        for (const seg of preview) {
          ctx.canvasRenderer.drawLine(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
        }
      }
    }

    if (ctx.wireDrag.isActive()) {
      const doglegs = ctx.wireDrag.getDoglegs();
      ctx.canvasRenderer.setColor('WIRE');
      ctx.canvasRenderer.setLineWidth(2);
      for (const dw of doglegs) {
        ctx.canvasRenderer.drawLine(dw.start.x, dw.start.y, dw.end.x, dw.end.y);
      }
    }

    // Render diagnostic overlays (error/warning location circles)
    if (state.diagnosticOverlays.length > 0) {
      ctx2d.save();
      for (const overlay of state.diagnosticOverlays) {
        const isError = overlay.severity === 'error';
        ctx2d.fillStyle = isError
          ? 'rgba(220, 38, 38, 0.25)'   // red for errors
          : 'rgba(234, 179, 8, 0.25)';   // yellow for warnings
        ctx2d.strokeStyle = isError
          ? 'rgba(220, 38, 38, 0.8)'
          : 'rgba(234, 179, 8, 0.8)';
        ctx2d.lineWidth = 2 / gridScale;
        const radius = 1.5; // grid units
        ctx2d.beginPath();
        ctx2d.arc(overlay.x, overlay.y, radius, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    ctx.canvasRenderer.setGridScale(1);
    ctx2d.restore();

    if (state.boxSelect.active) {
      ctx2d.save();
      ctx2d.strokeStyle = 'rgba(86, 156, 214, 0.8)';
      ctx2d.fillStyle = 'rgba(86, 156, 214, 0.1)';
      ctx2d.lineWidth = 1;
      const bx = Math.min(state.boxSelect.startScreen.x, state.boxSelect.currentScreen.x);
      const by = Math.min(state.boxSelect.startScreen.y, state.boxSelect.currentScreen.y);
      const bw = Math.abs(state.boxSelect.currentScreen.x - state.boxSelect.startScreen.x);
      const bh = Math.abs(state.boxSelect.currentScreen.y - state.boxSelect.startScreen.y);
      ctx2d.fillRect(bx, by, bw, bh);
      ctx2d.strokeRect(bx, by, bw, bh);
      ctx2d.restore();
    }

    // Render scope panels when simulation is running (new data from onStep)
    // or when resized. Skip during idle zoom/pan to avoid expensive redraws.
    const simRunning = ctx.isSimActive();
    for (const sp of state.scopePanels) {
      const resized = sizeCanvasInContainer(sp.canvas);
      if (resized || simRunning) {
        sp.panel.render();
      }
    }

    if (_frameProfileEnabled) {
      const dt = performance.now() - _t0;
      _frameProfileSamples.push(dt);
      if (_frameProfileSamples.length % 60 === 0) {
        console.log(`Frame: ${dt.toFixed(1)}ms (${_frameProfileSamples.length} samples)`);
      }
    }
  }

  scheduleRender();

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------

  // Cache canvas bounding rect to avoid forcing synchronous layout reflow on
  // every mouse/wheel event. Invalidated on resize and scroll.
  let _canvasRect: DOMRect | null = null;
  function getCanvasRect(): DOMRect {
    if (_canvasRect === null) _canvasRect = canvas.getBoundingClientRect();
    return _canvasRect;
  }
  function invalidateCanvasRect(): void { _canvasRect = null; }
  window.addEventListener('resize', invalidateCanvasRect);
  window.addEventListener('scroll', invalidateCanvasRect, true);

  function canvasToWorld(e: { clientX: number; clientY: number }): Point {
    const rect = getCanvasRect();
    const screenPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return screenToWorld(screenPt, ctx.viewport.zoom, ctx.viewport.pan);
  }

  function canvasToScreen(e: { clientX: number; clientY: number }): Point {
    const rect = getCanvasRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // -------------------------------------------------------------------------
  // Scope canvas sizing helper
  // -------------------------------------------------------------------------

  /** Size a canvas to fill its share of the container at device pixel ratio. */
  function sizeCanvasInContainer(cvs: HTMLCanvasElement): boolean {
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    // Only resize when dimensions actually changed — setting canvas.width/height
    // resets the entire canvas context and forces GPU reallocation.
    if (targetW > 0 && targetH > 0 && (cvs.width !== targetW || cvs.height !== targetH)) {
      cvs.width = targetW;
      cvs.height = targetH;
      return true; // resized
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Diagnostic overlays
  // -------------------------------------------------------------------------

  /**
   * Populate diagnosticOverlays from diagnostics that carry involvedNodes or
   * involvedPositions. Solver diagnostics use involvedNodes (reverse-looked up
   * via wireToNodeId); connectivity diagnostics use involvedPositions directly.
   * Handles both errors and warnings in a single pass.
   */
  function populateDiagnosticOverlays(
    diags: Diagnostic[],
    wireToNodeId: Map<Wire, number>,
  ): void {
    // Build reverse map: nodeId → first wire endpoint position (world coords)
    const nodeIdToPosition = new Map<number, { x: number; y: number }>();
    for (const [wire, nodeId] of wireToNodeId) {
      if (!nodeIdToPosition.has(nodeId)) {
        nodeIdToPosition.set(nodeId, { x: wire.start.x, y: wire.start.y });
      }
    }

    for (const diag of diags) {
      const severity = diag.severity === 'error' ? 'error' as const : 'warning' as const;

      if (diag.involvedNodes && diag.involvedNodes.length > 0) {
        for (const nodeId of diag.involvedNodes) {
          const pos = nodeIdToPosition.get(nodeId);
          if (pos) {
            state.diagnosticOverlays.push({ x: pos.x, y: pos.y, severity });
          }
        }
      }

      if (diag.involvedPositions && diag.involvedPositions.length > 0) {
        for (const pos of diag.involvedPositions) {
          state.diagnosticOverlays.push({ x: pos.x, y: pos.y, severity });
        }
      }
    }
  }

  function clearDiagnosticOverlays(): void {
    state.diagnosticOverlays = [];
  }

  // -------------------------------------------------------------------------
  // Return pipeline interface
  // -------------------------------------------------------------------------

  return {
    scheduleRender,
    resizeCanvas,
    canvasToWorld,
    canvasToScreen,
    invalidateCanvasRect,
    sizeCanvasInContainer,
    populateDiagnosticOverlays,
    clearDiagnosticOverlays,
    state,
  };
}
