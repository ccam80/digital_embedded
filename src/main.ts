/**
 * Digital-in-Browser: browser-based digital logic circuit simulator.
 * Entry point — initializes the application, wires DOM events, starts render loop.
 */

import { initApp } from './app/app-init.js';
import { screenToWorld, GRID_SPACING } from './editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from './editor/hit-test.js';
import { deleteSelection } from './editor/edit-operations.js';
import type { Wire } from './core/circuit.js';
import { loadDig } from './io/dig-loader.js';
import { serializeCircuit } from './io/save.js';
import type { Point } from './core/renderer-interface.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const ctx = initApp();

// ---------------------------------------------------------------------------
// Apply panel visibility
// ---------------------------------------------------------------------------

if (ctx.params.panels === 'none') {
  document.getElementById('app')?.classList.add('panels-none');
}

// ---------------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------------

function resizeCanvas(): void {
  const container = ctx.canvas.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  ctx.canvas.width = w * dpr;
  ctx.canvas.height = h * dpr;
  ctx.canvas.style.width = `${w}px`;
  ctx.canvas.style.height = `${h}px`;
  ctx.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

resizeCanvas();
window.addEventListener('resize', () => {
  resizeCanvas();
  scheduleRender();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let renderScheduled = false;

function scheduleRender(): void {
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(renderFrame);
  }
}

function renderFrame(): void {
  renderScheduled = false;
  const { canvas, ctx2d, canvasRenderer: cr, viewport, circuit, selection,
    gridRenderer, elementRenderer, wireRenderer, placement } = ctx;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Clear
  ctx2d.clearRect(0, 0, w, h);

  // Draw grid (operates in screen space internally)
  const screenRect = { x: 0, y: 0, width: w, height: h };
  gridRenderer.render(cr, screenRect, viewport.zoom, viewport.pan);

  // World transform for elements and wires
  ctx2d.save();
  ctx2d.translate(viewport.pan.x, viewport.pan.y);
  ctx2d.scale(viewport.zoom * GRID_SPACING, viewport.zoom * GRID_SPACING);

  // Draw elements
  const worldRect = viewport.getVisibleWorldRect({ width: w, height: h });
  elementRenderer.render(cr, circuit, selection.getSelectedElements(), worldRect);

  // Draw wires
  wireRenderer.render(cr, circuit.wires, selection.getSelectedWires());
  wireRenderer.renderJunctionDots(cr, circuit.wires);

  // Draw placement ghost
  const ghost = placement.getGhost();
  if (ghost) {
    ctx2d.save();
    ctx2d.globalAlpha = 0.5;
    ctx2d.translate(ghost.position.x, ghost.position.y);
    if (ghost.rotation !== 0) {
      ctx2d.rotate((ghost.rotation * Math.PI) / 2);
    }
    if (ghost.mirror) {
      ctx2d.scale(-1, 1);
    }
    ghost.element.draw(cr);
    ctx2d.restore();
  }

  // Draw wire preview segments
  if (ctx.wireDrawing.isActive()) {
    const preview = ctx.wireDrawing.getPreviewSegments();
    if (preview) {
      cr.setColor("WIRE");
      cr.setLineWidth(1);
      for (const seg of preview) {
        cr.drawLine(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
      }
    }
  }

  ctx2d.restore();

  // Draw selection box overlay (screen space)
  if (boxSelect.active) {
    ctx2d.save();
    ctx2d.strokeStyle = 'rgba(86, 156, 214, 0.8)';
    ctx2d.fillStyle = 'rgba(86, 156, 214, 0.1)';
    ctx2d.lineWidth = 1;
    const bx = Math.min(boxSelect.startScreen.x, boxSelect.currentScreen.x);
    const by = Math.min(boxSelect.startScreen.y, boxSelect.currentScreen.y);
    const bw = Math.abs(boxSelect.currentScreen.x - boxSelect.startScreen.x);
    const bh = Math.abs(boxSelect.currentScreen.y - boxSelect.startScreen.y);
    ctx2d.fillRect(bx, by, bw, bh);
    ctx2d.strokeRect(bx, by, bw, bh);
    ctx2d.restore();
  }
}

// Initial render
scheduleRender();

// ---------------------------------------------------------------------------
// Mouse → world coordinate helper
// ---------------------------------------------------------------------------

function canvasToWorld(e: MouseEvent): Point {
  const rect = ctx.canvas.getBoundingClientRect();
  const screenPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  return screenToWorld(screenPt, ctx.viewport.zoom, ctx.viewport.pan);
}

function canvasToScreen(e: MouseEvent): Point {
  const rect = ctx.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ---------------------------------------------------------------------------
// Interaction state machine
// ---------------------------------------------------------------------------

const HIT_THRESHOLD = 0.5; // world units for wire/pin hit tolerance

type DragMode = 'none' | 'pan' | 'select-drag' | 'box-select';

let dragMode: DragMode = 'none';
let dragStart: Point = { x: 0, y: 0 };
let dragStartScreen: Point = { x: 0, y: 0 };

const boxSelect = {
  active: false,
  startScreen: { x: 0, y: 0 },
  currentScreen: { x: 0, y: 0 },
};

// ---------------------------------------------------------------------------
// Canvas mouse events
// ---------------------------------------------------------------------------

ctx.canvas.addEventListener('mousedown', (e: MouseEvent) => {
  const worldPt = canvasToWorld(e);
  const screenPt = canvasToScreen(e);

  // Middle-click or space+click: pan
  if (e.button === 1) {
    dragMode = 'pan';
    dragStartScreen = screenPt;
    e.preventDefault();
    return;
  }

  if (e.button !== 0) return;

  // Placement mode: place component on click
  if (ctx.placement.isActive()) {
    ctx.placement.updateCursor(worldPt);
    ctx.placement.place(ctx.circuit);
    scheduleRender();
    return;
  }

  // Wire drawing mode: check for pin click to complete, else add waypoint
  if (ctx.wireDrawing.isActive()) {
    const pinHit = hitTestPins(worldPt, ctx.circuit.elements, HIT_THRESHOLD);
    if (pinHit) {
      try {
        ctx.wireDrawing.completeToPin(pinHit.element, pinHit.pin, ctx.circuit);
      } catch {
        // Wire validation failed — just cancel
        ctx.wireDrawing.cancel();
      }
    } else {
      ctx.wireDrawing.addWaypoint();
    }
    scheduleRender();
    return;
  }

  // Hit test: pin → start wire drawing, element → select, wire → select
  const pinHit = hitTestPins(worldPt, ctx.circuit.elements, HIT_THRESHOLD);
  if (pinHit) {
    ctx.wireDrawing.startFromPin(pinHit.element, pinHit.pin);
    scheduleRender();
    return;
  }

  const elementHit = hitTestElements(worldPt, ctx.circuit.elements);
  if (elementHit) {
    if (e.shiftKey) {
      ctx.selection.toggleSelect(elementHit);
    } else if (!ctx.selection.isSelected(elementHit)) {
      ctx.selection.select(elementHit);
    }
    dragMode = 'select-drag';
    dragStart = worldPt;
    scheduleRender();
    return;
  }

  const wireHit = hitTestWires(worldPt, ctx.circuit.wires, HIT_THRESHOLD);
  if (wireHit) {
    if (e.shiftKey) {
      ctx.selection.toggleSelect(wireHit);
    } else {
      ctx.selection.select(wireHit);
    }
    scheduleRender();
    return;
  }

  // Empty space: start box select or deselect
  if (!e.shiftKey) {
    ctx.selection.clear();
  }
  dragMode = 'box-select';
  boxSelect.active = true;
  boxSelect.startScreen = screenPt;
  boxSelect.currentScreen = screenPt;
  scheduleRender();
});

ctx.canvas.addEventListener('mousemove', (e: MouseEvent) => {
  const worldPt = canvasToWorld(e);
  const screenPt = canvasToScreen(e);

  // Placement ghost follows cursor
  if (ctx.placement.isActive()) {
    ctx.placement.updateCursor(worldPt);
    scheduleRender();
    return;
  }

  // Wire drawing preview
  if (ctx.wireDrawing.isActive()) {
    ctx.wireDrawing.updateCursor(worldPt);
    scheduleRender();
    return;
  }

  if (dragMode === 'pan') {
    const dx = screenPt.x - dragStartScreen.x;
    const dy = screenPt.y - dragStartScreen.y;
    ctx.viewport.panBy({ x: dx, y: dy });
    dragStartScreen = screenPt;
    scheduleRender();
    return;
  }

  if (dragMode === 'select-drag') {
    const dx = worldPt.x - dragStart.x;
    const dy = worldPt.y - dragStart.y;
    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
      for (const el of ctx.selection.getSelectedElements()) {
        el.position = { x: el.position.x + dx, y: el.position.y + dy };
      }
      dragStart = worldPt;
      scheduleRender();
    }
    return;
  }

  if (dragMode === 'box-select') {
    boxSelect.currentScreen = screenPt;
    scheduleRender();
    return;
  }
});

ctx.canvas.addEventListener('mouseup', (_e: MouseEvent) => {
  if (dragMode === 'box-select') {
    // Complete box selection
    const topLeft = canvasToWorld({
      clientX: Math.min(boxSelect.startScreen.x, boxSelect.currentScreen.x) + ctx.canvas.getBoundingClientRect().left,
      clientY: Math.min(boxSelect.startScreen.y, boxSelect.currentScreen.y) + ctx.canvas.getBoundingClientRect().top,
    } as MouseEvent);
    const bottomRight = canvasToWorld({
      clientX: Math.max(boxSelect.startScreen.x, boxSelect.currentScreen.x) + ctx.canvas.getBoundingClientRect().left,
      clientY: Math.max(boxSelect.startScreen.y, boxSelect.currentScreen.y) + ctx.canvas.getBoundingClientRect().top,
    } as MouseEvent);

    const boxedElements = ctx.circuit.elements.filter((el) => {
      const bb = el.getBoundingBox();
      return bb.x >= topLeft.x && bb.y >= topLeft.y &&
        bb.x + bb.width <= bottomRight.x && bb.y + bb.height <= bottomRight.y;
    });
    const boxedWires = ctx.circuit.wires.filter((w) => {
      return w.start.x >= topLeft.x && w.start.y >= topLeft.y &&
        w.end.x <= bottomRight.x && w.end.y <= bottomRight.y;
    });

    if (boxedElements.length > 0 || boxedWires.length > 0) {
      ctx.selection.boxSelect(boxedElements, boxedWires);
    }

    boxSelect.active = false;
    scheduleRender();
  }

  dragMode = 'none';
});

// Zoom with scroll wheel
ctx.canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const screenPt = canvasToScreen(e);
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  ctx.viewport.zoomAt(screenPt, factor);
  scheduleRender();
}, { passive: false });

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Escape: cancel placement or wire drawing
  if (e.key === 'Escape') {
    if (ctx.placement.isActive()) {
      ctx.placement.cancel();
      scheduleRender();
    } else if (ctx.wireDrawing.isActive()) {
      ctx.wireDrawing.cancel();
      scheduleRender();
    }
    return;
  }

  // R: rotate placement ghost
  if (e.key === 'r' || e.key === 'R') {
    if (ctx.placement.isActive()) {
      ctx.placement.rotate();
      scheduleRender();
    }
    return;
  }

  // M: mirror placement ghost
  if (e.key === 'm' || e.key === 'M') {
    if (ctx.placement.isActive()) {
      ctx.placement.mirror();
      scheduleRender();
    }
    return;
  }

  // Delete / Backspace: delete selection
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!ctx.selection.isEmpty()) {
      const elements = [...ctx.selection.getSelectedElements()];
      const wires: Wire[] = [...ctx.selection.getSelectedWires()];
      const cmd = deleteSelection(ctx.circuit, elements, wires);
      ctx.undoStack.push(cmd);
      ctx.selection.clear();
      scheduleRender();
    }
    return;
  }

  // Ctrl+Z: undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    ctx.undoStack.undo();
    scheduleRender();
    return;
  }

  // Ctrl+Shift+Z or Ctrl+Y: redo
  if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y')) {
    ctx.undoStack.redo();
    scheduleRender();
    return;
  }

  // Ctrl+A: select all
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault();
    ctx.selection.selectAll(ctx.circuit);
    scheduleRender();
    return;
  }
});

// ---------------------------------------------------------------------------
// Speed control UI
// ---------------------------------------------------------------------------

const speedInput = document.getElementById('speed-input') as HTMLInputElement | null;

function updateSpeedDisplay(): void {
  if (speedInput) speedInput.value = String(ctx.speedControl.speed);
}

document.getElementById('btn-speed-div10')?.addEventListener('click', () => {
  ctx.speedControl.divideBy10();
  updateSpeedDisplay();
});

document.getElementById('btn-speed-div2')?.addEventListener('click', () => {
  ctx.speedControl.divideBy2();
  updateSpeedDisplay();
});

document.getElementById('btn-speed-mul2')?.addEventListener('click', () => {
  ctx.speedControl.multiplyBy2();
  updateSpeedDisplay();
});

document.getElementById('btn-speed-mul10')?.addEventListener('click', () => {
  ctx.speedControl.multiplyBy10();
  updateSpeedDisplay();
});

speedInput?.addEventListener('change', () => {
  ctx.speedControl.parseText(speedInput.value);
  updateSpeedDisplay();
});

// ---------------------------------------------------------------------------
// Toolbar: Step / Run / Stop (stubs until engine compilation is wired)
// ---------------------------------------------------------------------------

document.getElementById('btn-step')?.addEventListener('click', () => {
  // TODO: compile circuit → engine.step()
  console.log('Step: engine compilation not yet wired');
});

document.getElementById('btn-run')?.addEventListener('click', () => {
  // TODO: compile circuit → engine.start()
  console.log('Run: engine compilation not yet wired');
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
  // TODO: engine.stop()
  console.log('Stop: engine compilation not yet wired');
});

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

document.getElementById('btn-open')?.addEventListener('click', () => {
  fileInput?.click();
});

fileInput?.addEventListener('change', () => {
  const file = fileInput?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const xml = reader.result as string;
      const loaded = loadDig(xml, ctx.registry);
      // Replace current circuit contents
      ctx.circuit.elements.length = 0;
      ctx.circuit.wires.length = 0;
      for (const el of loaded.elements) {
        ctx.circuit.addElement(el);
      }
      for (const w of loaded.wires) {
        ctx.circuit.addWire(w);
      }
      ctx.circuit.metadata = loaded.metadata;
      ctx.selection.clear();
      ctx.viewport.fitToContent(ctx.circuit.elements, {
        width: ctx.canvas.clientWidth,
        height: ctx.canvas.clientHeight,
      });
      scheduleRender();
      if (ctx.isIframe) {
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to load circuit:', msg);
      if (ctx.isIframe) {
        window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
      }
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-save')?.addEventListener('click', () => {
  try {
    const json = serializeCircuit(ctx.circuit);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (ctx.circuit.metadata.name || 'circuit') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Failed to save:', err);
  }
});

// ---------------------------------------------------------------------------
// postMessage listener
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) return;

  try {
    handleMessage(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    window.parent.postMessage({ type: 'digital-error', error: message }, '*');
  }
});

function handleMessage(data: Record<string, unknown>): void {
  switch (data['type']) {
    case 'digital-load-url': {
      const url = String(data['url'] ?? '');
      if (!url) {
        window.parent.postMessage({ type: 'digital-error', error: 'No URL provided' }, '*');
        return;
      }
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
          return res.text();
        })
        .then((xml) => {
          const loaded = loadDig(xml, ctx.registry);
          ctx.circuit.elements.length = 0;
          ctx.circuit.wires.length = 0;
          for (const el of loaded.elements) ctx.circuit.addElement(el);
          for (const w of loaded.wires) ctx.circuit.addWire(w);
          ctx.circuit.metadata = loaded.metadata;
          ctx.selection.clear();
          ctx.viewport.fitToContent(ctx.circuit.elements, {
            width: ctx.canvas.clientWidth,
            height: ctx.canvas.clientHeight,
          });
          scheduleRender();
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        });
      break;
    }

    case 'digital-load-data': {
      const encoded = String(data['data'] ?? '');
      if (!encoded) {
        window.parent.postMessage({ type: 'digital-error', error: 'No data provided' }, '*');
        return;
      }
      try {
        const xml = atob(encoded);
        const loaded = loadDig(xml, ctx.registry);
        ctx.circuit.elements.length = 0;
        ctx.circuit.wires.length = 0;
        for (const el of loaded.elements) ctx.circuit.addElement(el);
        for (const w of loaded.wires) ctx.circuit.addWire(w);
        ctx.circuit.metadata = loaded.metadata;
        ctx.selection.clear();
        ctx.viewport.fitToContent(ctx.circuit.elements, {
          width: ctx.canvas.clientWidth,
          height: ctx.canvas.clientHeight,
        });
        scheduleRender();
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
      } catch {
        window.parent.postMessage({ type: 'digital-error', error: 'Invalid base64 data' }, '*');
      }
      break;
    }

    case 'digital-set-base': {
      const basePath = String(data['basePath'] ?? './');
      ctx.params.base = basePath;
      window.parent.postMessage({ type: 'digital-loaded' }, '*');
      break;
    }

    case 'digital-set-locked': {
      const locked = Boolean(data['locked']);
      ctx.params.locked = locked;
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Announce ready
// ---------------------------------------------------------------------------

window.parent.postMessage({ type: 'digital-ready' }, '*');

// ---------------------------------------------------------------------------
// Auto-load circuit from URL parameter
// ---------------------------------------------------------------------------

if (ctx.params.file) {
  const fileUrl = `${ctx.params.base}${ctx.params.file}`;
  fetch(fileUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch: ${fileUrl}`);
      return res.text();
    })
    .then((xml) => {
      const loaded = loadDig(xml, ctx.registry);
      ctx.circuit.elements.length = 0;
      ctx.circuit.wires.length = 0;
      for (const el of loaded.elements) ctx.circuit.addElement(el);
      for (const w of loaded.wires) ctx.circuit.addWire(w);
      ctx.circuit.metadata = loaded.metadata;
      ctx.selection.clear();
      ctx.viewport.fitToContent(ctx.circuit.elements, {
        width: ctx.canvas.clientWidth,
        height: ctx.canvas.clientHeight,
      });
      scheduleRender();
      window.parent.postMessage({ type: 'digital-loaded' }, '*');
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
    });
}
