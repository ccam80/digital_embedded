/**
 * Application initialization sequence.
 *
 * Wires together the component registry, file resolver, editor subsystems,
 * canvas rendering pipeline, simulation engine, and all DOM event handlers.
 * Called once on page load from main.ts.
 *
 * Browser-only: imports DOM-dependent modules.
 */

import { parseUrlParams } from './url-params.js';

import { createDefaultRegistry } from '../components/register-all.js';
import { Circuit } from '../core/circuit.js';
import { ComponentPalette } from '../editor/palette.js';
import { PaletteUI } from '../editor/palette-ui.js';
import { PropertyPanel } from '../editor/property-panel.js';
import { Viewport } from '../editor/viewport.js';
import { SelectionModel } from '../editor/selection.js';
import { PlacementMode } from '../editor/placement.js';
import { WireDrawingMode } from '../editor/wire-drawing.js';
import { CanvasRenderer } from '../editor/canvas-renderer.js';
import { ElementRenderer } from '../editor/element-renderer.js';
import { WireRenderer } from '../editor/wire-renderer.js';
import { GridRenderer } from '../editor/grid.js';
import { UndoRedoStack } from '../editor/undo-redo.js';
import { SpeedControl } from '../integration/speed-control.js';
import { darkColorScheme, lightColorScheme } from '../core/renderer-interface.js';
import { screenToWorld, GRID_SPACING } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { deleteSelection } from '../editor/edit-operations.js';
import { loadDig } from '../io/dig-loader.js';
import { serializeCircuit } from '../io/save.js';
import { DigitalEngine } from '../engine/digital-engine.js';
import { compileCircuit } from '../engine/compiler.js';
import { createEditorBinding } from '../integration/editor-binding.js';
import { EngineState } from '../core/engine-interface.js';
import { BitVector } from '../core/signal.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import type { WireSignalAccess } from '../editor/wire-signal-access.js';
import type { CompiledCircuitImpl } from '../engine/compiled-circuit.js';

// ---------------------------------------------------------------------------
// initApp — entry point called from main.ts
// ---------------------------------------------------------------------------

export function initApp(search?: string): void {
  const params = parseUrlParams(search);
  const isIframe = window.self !== window.top;

  applyColorScheme(params.dark);

  if (params.panels === 'none') {
    document.getElementById('app')?.classList.add('panels-none');
  }

  const registry = createDefaultRegistry();
  const circuit = new Circuit();
  const colorScheme = params.dark ? darkColorScheme : lightColorScheme;

  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
  const ctx2d = canvas.getContext('2d')!;
  const canvasRenderer = new CanvasRenderer(ctx2d, colorScheme);

  const viewport = new Viewport();
  const selection = new SelectionModel();
  const placement = new PlacementMode();
  const wireDrawing = new WireDrawingMode();
  const elementRenderer = new ElementRenderer();
  const wireRenderer = new WireRenderer();
  const gridRenderer = new GridRenderer();
  const undoStack = new UndoRedoStack();
  const speedControl = new SpeedControl();

  const palette = new ComponentPalette(registry);
  const paletteContainer = document.getElementById('palette-content')!;
  const paletteUI = new PaletteUI(palette, paletteContainer);

  paletteUI.onPlace((def) => {
    placement.start(def);
  });
  paletteUI.render();

  const propertyContainer = document.getElementById('property-content')!;
  const propertyPanel = new PropertyPanel(propertyContainer);

  selection.onChange(() => {
    const selected = selection.getSelectedElements();
    if (selected.size === 1) {
      const element = selected.values().next().value!;
      const def = registry.get(element.typeId);
      if (def) {
        propertyPanel.showProperties(element, def.propertyDefs);
      }
    } else {
      propertyPanel.clear();
    }
  });

  // -------------------------------------------------------------------------
  // Engine + binding
  // -------------------------------------------------------------------------

  const engine = new DigitalEngine('level');
  const binding = createEditorBinding();
  let compiledDirty = true;
  let compiled: CompiledCircuitImpl | null = null;

  function compileAndBind(): boolean {
    if (binding.isBound) {
      engine.stop();
      binding.unbind();
      engine.dispose();
    }
    try {
      compiled = compileCircuit(circuit, registry);
      engine.init(compiled);
      binding.bind(circuit, engine, compiled.wireToNetId, compiled.pinNetMap);
      compiledDirty = false;
      return true;
    } catch (err) {
      console.error('Compilation failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  function invalidateCompiled(): void {
    compiledDirty = true;
    if (engine.getState() === EngineState.RUNNING) engine.stop();
    if (binding.isBound) binding.unbind();
    scheduleRender();
  }

  const wireSignalAccessAdapter: WireSignalAccess = {
    getWireValue(wire: Wire): { raw: number; width: number } | undefined {
      if (!binding.isBound || compiled === null) return undefined;
      const netId = compiled.wireToNetId.get(wire);
      if (netId === undefined) return undefined;
      try {
        const raw = binding.getWireValue(wire);
        const width = compiled.netWidths[netId] ?? 1;
        return { raw, width };
      } catch {
        return undefined;
      }
    },
  };

  // -------------------------------------------------------------------------
  // Canvas sizing
  // -------------------------------------------------------------------------

  function resizeCanvas(): void {
    const container = canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeCanvas();
  window.addEventListener('resize', () => {
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

  function renderFrame(): void {
    renderScheduled = false;
    const dpr = window.devicePixelRatio || 1;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx2d.clearRect(0, 0, w, h);

    const screenRect = { x: 0, y: 0, width: w, height: h };
    gridRenderer.render(canvasRenderer, screenRect, viewport.zoom, viewport.pan);

    ctx2d.save();
    ctx2d.translate(viewport.pan.x, viewport.pan.y);
    ctx2d.scale(viewport.zoom * GRID_SPACING, viewport.zoom * GRID_SPACING);

    const worldRect = viewport.getVisibleWorldRect({ width: w, height: h });
    elementRenderer.render(canvasRenderer, circuit, selection.getSelectedElements(), worldRect);

    wireRenderer.render(
      canvasRenderer,
      circuit.wires,
      selection.getSelectedWires(),
      binding.isBound ? wireSignalAccessAdapter : undefined,
    );
    wireRenderer.renderJunctionDots(canvasRenderer, circuit.wires);

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
      ghost.element.draw(canvasRenderer);
      ctx2d.restore();
    }

    if (wireDrawing.isActive()) {
      const preview = wireDrawing.getPreviewSegments();
      if (preview) {
        canvasRenderer.setColor('WIRE');
        canvasRenderer.setLineWidth(1);
        for (const seg of preview) {
          canvasRenderer.drawLine(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
        }
      }
    }

    ctx2d.restore();

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

  scheduleRender();

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------

  function canvasToWorld(e: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    const screenPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return screenToWorld(screenPt, viewport.zoom, viewport.pan);
  }

  function canvasToScreen(e: MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // -------------------------------------------------------------------------
  // Interaction state
  // -------------------------------------------------------------------------

  const HIT_THRESHOLD = 0.5;

  type DragMode = 'none' | 'pan' | 'select-drag' | 'box-select';

  let dragMode: DragMode = 'none';
  let dragStart: Point = { x: 0, y: 0 };
  let dragStartScreen: Point = { x: 0, y: 0 };

  const boxSelect = {
    active: false,
    startScreen: { x: 0, y: 0 },
    currentScreen: { x: 0, y: 0 },
  };

  // -------------------------------------------------------------------------
  // Mouse events
  // -------------------------------------------------------------------------

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    const worldPt = canvasToWorld(e);
    const screenPt = canvasToScreen(e);

    if (e.button === 1) {
      dragMode = 'pan';
      dragStartScreen = screenPt;
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    if (placement.isActive()) {
      placement.updateCursor(worldPt);
      placement.place(circuit);
      invalidateCompiled();
      return;
    }

    if (wireDrawing.isActive()) {
      const pinHit = hitTestPins(worldPt, circuit.elements, HIT_THRESHOLD);
      if (pinHit) {
        try {
          wireDrawing.completeToPin(pinHit.element, pinHit.pin, circuit);
          invalidateCompiled();
        } catch {
          wireDrawing.cancel();
        }
      } else {
        wireDrawing.addWaypoint();
      }
      scheduleRender();
      return;
    }

    if (binding.isBound) {
      const elementHit = hitTestElements(worldPt, circuit.elements);
      if (elementHit && elementHit.typeId === 'In') {
        const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
        try {
          const current = binding.getPinValue(elementHit, 'out');
          const newVal = bitWidth === 1
            ? (current === 0 ? 1 : 0)
            : ((current + 1) & ((1 << bitWidth) - 1));
          binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
          if (engine.getState() !== EngineState.RUNNING) engine.step();
          scheduleRender();
        } catch {
          scheduleRender();
        }
        return;
      }
    }

    const pinHit = hitTestPins(worldPt, circuit.elements, HIT_THRESHOLD);
    if (pinHit) {
      wireDrawing.startFromPin(pinHit.element, pinHit.pin);
      scheduleRender();
      return;
    }

    const elementHit = hitTestElements(worldPt, circuit.elements);
    if (elementHit) {
      if (e.shiftKey) {
        selection.toggleSelect(elementHit);
      } else if (!selection.isSelected(elementHit)) {
        selection.select(elementHit);
      }
      dragMode = 'select-drag';
      dragStart = worldPt;
      scheduleRender();
      return;
    }

    const wireHit = hitTestWires(worldPt, circuit.wires, HIT_THRESHOLD);
    if (wireHit) {
      if (e.shiftKey) {
        selection.toggleSelect(wireHit);
      } else {
        selection.select(wireHit);
      }
      scheduleRender();
      return;
    }

    if (!e.shiftKey) {
      selection.clear();
    }
    dragMode = 'box-select';
    boxSelect.active = true;
    boxSelect.startScreen = screenPt;
    boxSelect.currentScreen = screenPt;
    scheduleRender();
  });

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    const worldPt = canvasToWorld(e);
    const screenPt = canvasToScreen(e);

    if (placement.isActive()) {
      placement.updateCursor(worldPt);
      scheduleRender();
      return;
    }

    if (wireDrawing.isActive()) {
      wireDrawing.updateCursor(worldPt);
      scheduleRender();
      return;
    }

    if (dragMode === 'pan') {
      const dx = screenPt.x - dragStartScreen.x;
      const dy = screenPt.y - dragStartScreen.y;
      viewport.panBy({ x: dx, y: dy });
      dragStartScreen = screenPt;
      scheduleRender();
      return;
    }

    if (dragMode === 'select-drag') {
      const dx = worldPt.x - dragStart.x;
      const dy = worldPt.y - dragStart.y;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        for (const el of selection.getSelectedElements()) {
          el.position = { x: el.position.x + dx, y: el.position.y + dy };
        }
        dragStart = worldPt;
        invalidateCompiled();
      }
      return;
    }

    if (dragMode === 'box-select') {
      boxSelect.currentScreen = screenPt;
      scheduleRender();
      return;
    }
  });

  canvas.addEventListener('mouseup', (_e: MouseEvent) => {
    if (dragMode === 'box-select') {
      const topLeft = canvasToWorld({
        clientX: Math.min(boxSelect.startScreen.x, boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.min(boxSelect.startScreen.y, boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      } as MouseEvent);
      const bottomRight = canvasToWorld({
        clientX: Math.max(boxSelect.startScreen.x, boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.max(boxSelect.startScreen.y, boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      } as MouseEvent);

      const boxedElements = circuit.elements.filter((el) => {
        const bb = el.getBoundingBox();
        return bb.x >= topLeft.x && bb.y >= topLeft.y &&
          bb.x + bb.width <= bottomRight.x && bb.y + bb.height <= bottomRight.y;
      });
      const boxedWires = circuit.wires.filter((w) => {
        return w.start.x >= topLeft.x && w.start.y >= topLeft.y &&
          w.end.x <= bottomRight.x && w.end.y <= bottomRight.y;
      });

      if (boxedElements.length > 0 || boxedWires.length > 0) {
        selection.boxSelect(boxedElements, boxedWires);
      }

      boxSelect.active = false;
      scheduleRender();
    }

    dragMode = 'none';
  });

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const screenPt = canvasToScreen(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    viewport.zoomAt(screenPt, factor);
    scheduleRender();
  }, { passive: false });

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (placement.isActive()) {
        placement.cancel();
        scheduleRender();
      } else if (wireDrawing.isActive()) {
        wireDrawing.cancel();
        scheduleRender();
      }
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      if (placement.isActive()) {
        placement.rotate();
        scheduleRender();
      }
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      if (placement.isActive()) {
        placement.mirror();
        scheduleRender();
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!selection.isEmpty()) {
        const elements = [...selection.getSelectedElements()];
        const wires: Wire[] = [...selection.getSelectedWires()];
        const cmd = deleteSelection(circuit, elements, wires);
        undoStack.push(cmd);
        selection.clear();
        invalidateCompiled();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      undoStack.undo();
      invalidateCompiled();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || e.key === 'y')) {
      undoStack.redo();
      invalidateCompiled();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      selection.selectAll(circuit);
      scheduleRender();
      return;
    }
  });

  // -------------------------------------------------------------------------
  // Speed control UI
  // -------------------------------------------------------------------------

  const speedInput = document.getElementById('speed-input') as HTMLInputElement | null;

  function updateSpeedDisplay(): void {
    if (speedInput) speedInput.value = String(speedControl.speed);
  }

  document.getElementById('btn-speed-div10')?.addEventListener('click', () => {
    speedControl.divideBy10();
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-div2')?.addEventListener('click', () => {
    speedControl.divideBy2();
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-mul2')?.addEventListener('click', () => {
    speedControl.multiplyBy2();
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-mul10')?.addEventListener('click', () => {
    speedControl.multiplyBy10();
    updateSpeedDisplay();
  });

  speedInput?.addEventListener('change', () => {
    speedControl.parseText(speedInput.value);
    updateSpeedDisplay();
  });

  // -------------------------------------------------------------------------
  // Toolbar: Step / Run / Stop
  // -------------------------------------------------------------------------

  document.getElementById('btn-step')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) engine.stop();
    engine.step();
    scheduleRender();
  });

  document.getElementById('btn-run')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) return;
    engine.start();
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    if (!binding.isBound) return;
    engine.stop();
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // File I/O
  // -------------------------------------------------------------------------

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
        const loaded = loadDig(xml, registry);
        circuit.elements.length = 0;
        circuit.wires.length = 0;
        for (const el of loaded.elements) circuit.addElement(el);
        for (const w of loaded.wires) circuit.addWire(w);
        circuit.metadata = loaded.metadata;
        selection.clear();
        viewport.fitToContent(circuit.elements, {
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        });
        invalidateCompiled();
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load circuit:', msg);
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        }
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    try {
      const json = serializeCircuit(circuit);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (circuit.metadata.name || 'circuit') + '.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to save:', err);
    }
  });

  // -------------------------------------------------------------------------
  // postMessage listener
  // -------------------------------------------------------------------------

  function loadCircuitFromXml(xml: string): void {
    const loaded = loadDig(xml, registry);
    circuit.elements.length = 0;
    circuit.wires.length = 0;
    for (const el of loaded.elements) circuit.addElement(el);
    for (const w of loaded.wires) circuit.addWire(w);
    circuit.metadata = loaded.metadata;
    selection.clear();
    viewport.fitToContent(circuit.elements, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    invalidateCompiled();
  }

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
            loadCircuitFromXml(xml);
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
          loadCircuitFromXml(xml);
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        } catch {
          window.parent.postMessage({ type: 'digital-error', error: 'Invalid base64 data' }, '*');
        }
        break;
      }

      case 'digital-set-base': {
        const basePath = String(data['basePath'] ?? './');
        params.base = basePath;
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
        break;
      }

      case 'digital-set-locked': {
        const locked = Boolean(data['locked']);
        params.locked = locked;
        break;
      }

      default:
        break;
    }
  }

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

  // -------------------------------------------------------------------------
  // Announce ready and auto-load
  // -------------------------------------------------------------------------

  window.parent.postMessage({ type: 'digital-ready' }, '*');

  if (params.file) {
    const fileUrl = `${params.base}${params.file}`;
    fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch: ${fileUrl}`);
        return res.text();
      })
      .then((xml) => {
        loadCircuitFromXml(xml);
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
      });
  }
}

// ---------------------------------------------------------------------------
// applyColorScheme
// ---------------------------------------------------------------------------

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
