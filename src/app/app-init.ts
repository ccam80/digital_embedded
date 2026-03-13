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
import { screenToWorld, snapToGrid, GRID_SPACING } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { splitWiresAtPoint, isWireEndpoint } from '../editor/wire-drawing.js';
import { deleteSelection, rotateSelection, mirrorSelection, copyToClipboard, pasteFromClipboard } from '../editor/edit-operations.js';
import type { ClipboardData } from '../editor/edit-operations.js';
import { loadDig } from '../io/dig-loader.js';
import { loadWithSubcircuits } from '../io/subcircuit-loader.js';
import { HttpResolver, EmbeddedResolver, ChainResolver } from '../io/file-resolver.js';
import { deserializeCircuit } from '../io/load.js';
import { serializeCircuit } from '../io/save.js';
import { storeFolder, loadFolder, clearFolder } from '../io/folder-store.js';
import { DigitalEngine } from '../engine/digital-engine.js';
import { compileCircuit } from '../engine/compiler.js';
import { ClockManager } from '../engine/clock.js';
import { createEditorBinding } from '../integration/editor-binding.js';
import { EngineState } from '../core/engine-interface.js';
import { BitVector } from '../core/signal.js';
import { PropertyBag } from '../core/properties.js';
import { pinWorldPosition } from '../core/pin.js';
import { resolveNets } from '../headless/netlist.js';
import type { Diagnostic } from '../headless/netlist-types.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import type { WireSignalAccess } from '../editor/wire-signal-access.js';
import type { CompiledCircuitImpl } from '../engine/compiled-circuit.js';

/** Component type names that are togglable during simulation — skip property popup on dblclick. */
const TOGGLABLE_TYPES = new Set(["In", "Clock", "Button", "Switch", "DipSwitch"]);

/**
 * After completing a wire to a pin or junction, check if the newly added
 * segments contain a dead-end stub that overshot the target. A dead-end stub
 * is a zero-length wire or a segment whose endpoint is not connected to any
 * pin or any other wire endpoint in the circuit.
 */
function removeDeadEndStubs(newWires: Wire[], circuit: Circuit): void {
  // Collect all wire endpoint positions (excluding the new wires themselves)
  const endpointCounts = new Map<string, number>();
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

  for (const w of circuit.wires) {
    const sk = key(w.start);
    const ek = key(w.end);
    endpointCounts.set(sk, (endpointCounts.get(sk) ?? 0) + 1);
    endpointCounts.set(ek, (endpointCounts.get(ek) ?? 0) + 1);
  }

  // Remove zero-length wires
  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) {
      circuit.removeWire(w);
    }
  }

  // Check new wires for dead-end stubs: segments with an endpoint that has
  // exactly 1 connection (only this wire) and doesn't touch any component pin.
  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) continue; // already removed

    for (const pt of [w.start, w.end]) {
      const k = key(pt);
      const count = endpointCounts.get(k) ?? 0;
      if (count <= 1) {
        // Check if this endpoint touches a pin
        let touchesPin = false;
        for (const el of circuit.elements) {
          for (const pin of el.getPins()) {
            const wp = pinWorldPosition(el, pin);
            if (wp.x === pt.x && wp.y === pt.y) {
              touchesPin = true;
              break;
            }
          }
          if (touchesPin) break;
        }
        if (!touchesPin && newWires.length > 1) {
          circuit.removeWire(w);
          break;
        }
      }
    }
  }
}

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
  let circuit = new Circuit();
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

  // -------------------------------------------------------------------------
  // Status bar
  // -------------------------------------------------------------------------

  const statusBar = document.getElementById('status-bar')!;
  const statusMessage = document.getElementById('status-message')!;
  const statusDismiss = document.getElementById('status-dismiss')!;
  const statusCoords = document.getElementById('status-coords')!;

  function showStatus(message: string, isError = false): void {
    statusMessage.textContent = message;
    statusBar.classList.toggle('error', isError);
  }

  function clearStatus(): void {
    statusMessage.textContent = 'Ready';
    statusBar.classList.remove('error');
  }

  function formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return '';
    const first = diagnostics[0]!;
    const base = diagnostics.length === 1
      ? first.message
      : `${diagnostics.length} errors: ${first.message}`;
    return first.fix ? `${base} (fix: ${first.fix})` : base;
  }

  statusDismiss.addEventListener('click', clearStatus);

  const palette = new ComponentPalette(registry);
  const paletteContainer = document.getElementById('palette-content')!;
  const paletteUI = new PaletteUI(palette, paletteContainer, colorScheme);

  paletteUI.onPlace((def) => {
    placement.start(def);
  });
  paletteUI.render();

  // -------------------------------------------------------------------------
  // Insert menu — full component set with hierarchical submenus
  // -------------------------------------------------------------------------
  const insertMenuDropdown = document.getElementById('insert-menu-dropdown');
  if (insertMenuDropdown) {
    const categoryLabels: Record<string, string> = {
      LOGIC: "Logic",
      IO: "I/O",
      FLIP_FLOPS: "Flip-Flops",
      MEMORY: "Memory",
      ARITHMETIC: "Arithmetic",
      WIRING: "Wiring",
      SWITCHING: "Switching",
      PLD: "PLD",
      MISC: "Miscellaneous",
      GRAPHICS: "Graphics",
      TERMINAL: "Terminal",
      "74XX": "74xx",
    };
    const reg = palette.getRegistry();
    for (const catKey of Object.keys(categoryLabels)) {
      const defs = reg.getByCategory(catKey as any);
      if (defs.length === 0) continue;
      const sub = document.createElement("div");
      sub.className = "menu-submenu";
      const trigger = document.createElement("div");
      trigger.className = "menu-action";
      trigger.textContent = categoryLabels[catKey] ?? catKey;
      sub.appendChild(trigger);

      const subDropdown = document.createElement("div");
      subDropdown.className = "menu-dropdown";
      for (const def of defs) {
        const item = document.createElement("div");
        item.className = "menu-action";
        item.textContent = def.name;
        item.addEventListener("click", () => {
          placement.start(def);
          document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
        });
        subDropdown.appendChild(item);
      }
      sub.appendChild(subDropdown);
      insertMenuDropdown.appendChild(sub);
    }
  }

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
  let clockManager: ClockManager | null = null;

  function compileAndBind(): boolean {
    if (binding.isBound) {
      engine.stop();
      binding.unbind();
      engine.dispose();
    }
    const { diagnostics } = resolveNets(circuit, registry);
    const errors = diagnostics.filter(d => d.severity === 'error');
    if (errors.length > 0) {
      const msg = formatDiagnostics(errors);
      console.error('Pre-compilation diagnostics:', msg);
      showStatus(`Compilation error: ${msg}`, true);
      return false;
    }
    try {
      compiled = compileCircuit(circuit, registry);
      engine.init(compiled);
      binding.bind(circuit, engine, compiled.wireToNetId, compiled.pinNetMap);
      clockManager = new ClockManager(compiled);
      compiledDirty = false;
      clearStatus();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Compilation failed:', msg);
      showStatus(`Compilation error: ${msg}`, true);
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
    const gridScale = viewport.zoom * GRID_SPACING;
    ctx2d.scale(gridScale, gridScale);
    canvasRenderer.setGridScale(gridScale);

    const worldRect = viewport.getVisibleWorldRect({ width: w, height: h });
    elementRenderer.render(canvasRenderer, circuit, selection.getSelectedElements(), worldRect);

    wireRenderer.render(
      canvasRenderer,
      circuit.wires,
      selection.getSelectedWires(),
      binding.isBound ? wireSignalAccessAdapter : undefined,
    );
    wireRenderer.renderJunctionDots(canvasRenderer, circuit.wires);
    wireRenderer.renderBusWidthMarkers(canvasRenderer, circuit.wires);

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
        canvasRenderer.setLineWidth(2);
        for (const seg of preview) {
          canvasRenderer.drawLine(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
        }
      }
    }

    canvasRenderer.setGridScale(1);
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
  let clipboard: ClipboardData = { entries: [], wires: [] };
  let lastWorldPt: Point = { x: 0, y: 0 };

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

    // During simulation, only allow toggling interactive components (In, Clock, etc.)
    if (binding.isBound) {
      const elementHit = hitTestElements(worldPt, circuit.elements);
      if (elementHit && (elementHit.typeId === 'In' || elementHit.typeId === 'Clock')) {
        const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
        try {
          const current = binding.getPinValue(elementHit, 'out');
          const newVal = bitWidth === 1
            ? (current === 0 ? 1 : 0)
            : ((current + 1) & ((1 << bitWidth) - 1));
          binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
          if (elementHit.typeId === 'Clock' && clockManager !== null && compiled !== null) {
            // Sync ClockManager phase so it doesn't immediately revert
            const netId = compiled.pinNetMap.get(`${elementHit.instanceId}:out`);
            if (netId !== undefined) {
              clockManager.setClockPhase(netId, newVal !== 0);
            }
          }
          if (engine.getState() !== EngineState.RUNNING) {
            // Skip advanceClocks when manually toggling a Clock
            if (elementHit.typeId !== 'Clock' && clockManager !== null) {
              clockManager.advanceClocks(engine.getSignalArray());
            }
            engine.step();
          }
          scheduleRender();
        } catch {
          scheduleRender();
        }
      }
      return;
    }

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
          const wires = wireDrawing.completeToPin(pinHit.element, pinHit.pin, circuit);
          removeDeadEndStubs(wires, circuit);
          invalidateCompiled();
        } catch {
          wireDrawing.cancel();
        }
      } else {
        // Check if cursor lands on an existing wire — split interior or connect at endpoint
        const snappedPt = snapToGrid(worldPt, 1);
        const tappedPoint = splitWiresAtPoint(snappedPt, circuit);
        if (tappedPoint !== undefined) {
          try {
            const wires = wireDrawing.completeToPoint(tappedPoint, circuit);
            removeDeadEndStubs(wires, circuit);
            invalidateCompiled();
          } catch {
            wireDrawing.cancel();
          }
        } else if (isWireEndpoint(snappedPt, circuit)) {
          try {
            const wires = wireDrawing.completeToPoint(snappedPt, circuit);
            removeDeadEndStubs(wires, circuit);
            invalidateCompiled();
          } catch {
            wireDrawing.cancel();
          }
        } else if (wireDrawing.isSameAsLastWaypoint(snappedPt)) {
          // Clicking the same spot twice ends the wire at that point
          try {
            wireDrawing.completeToPoint(snappedPt, circuit);
            invalidateCompiled();
          } catch {
            wireDrawing.cancel();
          }
        } else {
          wireDrawing.addWaypoint();
        }
      }
      scheduleRender();
      return;
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
      // Clicking a wire selects it. Tee/split only happens when already in
      // wire-drawing mode (handled above) or when starting from a pin.
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
    lastWorldPt = worldPt;

    // Update cursor grid coordinates in status bar
    const gx = Math.round(worldPt.x * 100) / 100;
    const gy = Math.round(worldPt.y * 100) / 100;
    statusCoords.textContent = `${gx}, ${gy}`;

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
      const snappedWorld = snapToGrid(worldPt, 1);
      const snappedStart = snapToGrid(dragStart, 1);
      const dx = snappedWorld.x - snappedStart.x;
      const dy = snappedWorld.y - snappedStart.y;
      if (dx !== 0 || dy !== 0) {
        const selectedElements = selection.getSelectedElements();
        const selectedWires = selection.getSelectedWires();

        // Collect world-space pin positions BEFORE moving elements.
        const pinPositions = new Set<string>();
        for (const el of selectedElements) {
          for (const pin of el.getPins()) {
            const wp = pinWorldPosition(el, pin);
            pinPositions.add(`${wp.x},${wp.y}`);
          }
        }

        // Move elements.
        for (const el of selectedElements) {
          el.position = { x: el.position.x + dx, y: el.position.y + dy };
        }

        // Stretch wires: move endpoints that were connected to moved pins.
        // Skip wires that are part of the selection (they move with it).
        for (const wire of circuit.wires) {
          if (selectedWires.has(wire)) continue;
          const startKey = `${wire.start.x},${wire.start.y}`;
          const endKey = `${wire.end.x},${wire.end.y}`;
          if (pinPositions.has(startKey)) {
            wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
          }
          if (pinPositions.has(endKey)) {
            wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
          }
        }

        // Also move selected wires with the selection.
        for (const wire of selectedWires) {
          wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
          wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
        }

        dragStart = snappedWorld;
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
  // Double-click → property popup
  // -------------------------------------------------------------------------

  let activePopup: HTMLElement | null = null;

  function closePopup(): void {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
  }

  // -------------------------------------------------------------------------
  // Circuit navigation (subcircuit drill-down)
  // -------------------------------------------------------------------------

  let currentCircuitName = 'Main';
  const circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }> = [];

  function updateBreadcrumb(): void {
    let breadcrumb = document.getElementById('circuit-breadcrumb');
    if (!breadcrumb) {
      breadcrumb = document.createElement('div');
      breadcrumb.id = 'circuit-breadcrumb';
      breadcrumb.style.cssText = 'position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:100;display:flex;gap:4px;align-items:center;font-family:sans-serif;font-size:13px;color:#ccc;background:rgba(0,0,0,0.55);padding:2px 10px;border-radius:4px;pointer-events:auto;';
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
      circuit,
      zoom: viewport.zoom,
      pan: { x: viewport.pan.x, y: viewport.pan.y },
    });
    circuit = subCircuit;
    currentCircuitName = name;
    viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
    selection.clear();
    closePopup();
    updateBreadcrumb();
    scheduleRender();
  }

  function navigateBack(): void {
    if (circuitStack.length === 0) return;
    const prev = circuitStack.pop()!;
    circuit = prev.circuit;
    currentCircuitName = prev.name;
    viewport.zoom = prev.zoom;
    viewport.pan = prev.pan;
    selection.clear();
    closePopup();
    updateBreadcrumb();
    scheduleRender();
  }

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    const worldPt = canvasToWorld(e);
    const elementHit = hitTestElements(worldPt, circuit.elements);
    if (!elementHit) return;

    // During simulation, don't open properties for togglable components
    if (binding.isBound && TOGGLABLE_TYPES.has(elementHit.typeId)) return;

    // Subcircuit elements: navigate into them on double-click
    if ('definition' in elementHit && (elementHit as any).definition?.circuit) {
      const subDef = (elementHit as any).definition;
      openSubcircuit(subDef.name, subDef.circuit);
      return;
    }

    const def = registry.get(elementHit.typeId);
    if (!def || def.propertyDefs.length === 0) return;

    closePopup();

    const popup = document.createElement('div');
    popup.className = 'prop-popup';

    const header = document.createElement('div');
    header.className = 'prop-popup-header';
    const title = document.createElement('span');
    title.className = 'prop-popup-title';
    title.textContent = elementHit.typeId;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closePopup);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    const tempPanel = new PropertyPanel(popup);
    tempPanel.showProperties(elementHit, def.propertyDefs);
    tempPanel.onPropertyChange(() => {
      invalidateCompiled();
      scheduleRender();
    });

    const screenPt = canvasToScreen(e);
    const container = canvas.parentElement!;
    popup.style.left = `${Math.min(screenPt.x + 10, container.clientWidth - 200)}px`;
    popup.style.top = `${Math.min(screenPt.y + 10, container.clientHeight - 200)}px`;

    container.appendChild(popup);
    activePopup = popup;
  });

  // Close popup when clicking elsewhere on canvas
  canvas.addEventListener('mousedown', () => {
    closePopup();
  }, true);

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
      } else if (circuitStack.length > 0) {
        navigateBack();
      }
      return;
    }

    // Block all edit shortcuts during simulation
    if (binding.isBound) return;

    if (e.key === 'r' || e.key === 'R') {
      if (placement.isActive()) {
        placement.rotate();
        scheduleRender();
      } else if (!selection.isEmpty()) {
        const elements = [...selection.getSelectedElements()];
        if (elements.length > 0) {
          const cmd = rotateSelection(elements);
          undoStack.push(cmd);
          invalidateCompiled();
        }
      }
      return;
    }

    if (e.key === 'm' || e.key === 'M') {
      if (placement.isActive()) {
        placement.mirror();
        scheduleRender();
      } else if (!selection.isEmpty()) {
        const elements = [...selection.getSelectedElements()];
        if (elements.length > 0) {
          const cmd = mirrorSelection(elements);
          undoStack.push(cmd);
          invalidateCompiled();
        }
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

    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault();
      if (!selection.isEmpty()) {
        clipboard = copyToClipboard(
          [...selection.getSelectedElements()],
          [...selection.getSelectedWires()],
          (typeId: string) => registry.get(typeId),
        );
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      if (clipboard.entries.length > 0 || clipboard.wires.length > 0) {
        const cmd = pasteFromClipboard(circuit, clipboard, lastWorldPt);
        undoStack.push(cmd);
        invalidateCompiled();
      }
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
  // Continuous run loop — steps engine at speed-control rate and repaints
  // -------------------------------------------------------------------------

  let runRafHandle = -1;

  function startContinuousRun(): void {
    selection.clear();
    engine.start();
    let lastTime = performance.now();

    const tick = (now: number): void => {
      if (engine.getState() !== EngineState.RUNNING) {
        runRafHandle = -1;
        scheduleRender();
        return;
      }
      const dt = (now - lastTime) / 1000; // seconds elapsed
      lastTime = now;
      const stepsThisFrame = Math.max(1, Math.round(speedControl.speed * dt));
      for (let i = 0; i < stepsThisFrame; i++) {
        if (clockManager !== null) clockManager.advanceClocks(engine.getSignalArray());
        try {
          engine.step();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showStatus(`Simulation error: ${msg}`, true);
          stopContinuousRun();
          return;
        }
      }
      scheduleRender();
      runRafHandle = requestAnimationFrame(tick);
    };
    runRafHandle = requestAnimationFrame(tick);
  }

  function stopContinuousRun(): void {
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    engine.stop();
    scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Toolbar: Step / Run / Stop
  // -------------------------------------------------------------------------

  document.getElementById('btn-step')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) engine.stop();
    if (clockManager !== null) clockManager.advanceClocks(engine.getSignalArray());
    try {
      engine.step();
      clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showStatus(`Simulation error: ${msg}`, true);
    }
    scheduleRender();
  });

  document.getElementById('btn-run')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) return;
    startContinuousRun();
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    if (!binding.isBound) return;
    stopContinuousRun();
    // Return to edit mode: unbind signals so wires go grey
    binding.unbind();
    engine.dispose();
    compiledDirty = true;
    scheduleRender();
  });

  // Toolbar Start/Step/Stop buttons (mirror the menu actions)
  document.getElementById('btn-tb-step')?.addEventListener('click', () => {
    document.getElementById('btn-step')?.click();
  });
  document.getElementById('btn-tb-run')?.addEventListener('click', () => {
    document.getElementById('btn-run')?.click();
  });
  document.getElementById('btn-tb-stop')?.addEventListener('click', () => {
    document.getElementById('btn-stop')?.click();
  });

  // -------------------------------------------------------------------------
  // File I/O
  // -------------------------------------------------------------------------

  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

  document.getElementById('btn-open')?.addEventListener('click', () => {
    fileInput?.click();
  });

  /** HTTP resolver for subcircuit .dig file resolution. */
  const httpResolver = new HttpResolver(params.base || './');

  /** Replace circuit contents from a loaded Circuit object. */
  function applyLoadedCircuit(loaded: Circuit): void {
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
    updateCircuitName();
  }

  fileInput?.addEventListener('change', () => {
    const file = fileInput?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result as string;
        let loaded: Circuit;
        const firstChar = text.replace(/^\s+/, '').charAt(0);
        if (firstChar === '{' || firstChar === '[') {
          loaded = deserializeCircuit(text, registry);
        } else {
          // Use async subcircuit-aware loader to handle embedded subcircuit references
          try {
            loaded = await loadWithSubcircuits(text, httpResolver, registry);
          } catch {
            // Fall back to simple loader if async loading fails
            loaded = loadDig(text, registry);
          }
        }
        applyLoadedCircuit(loaded);
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load circuit:', msg);
        showStatus(`Load error: ${msg}`, true);
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        }
      }
    };
    reader.readAsText(file);
  });

  // -------------------------------------------------------------------------
  // Open Folder — read all .dig files from a directory for subcircuit resolution
  // -------------------------------------------------------------------------

  const folderInput = document.getElementById('folder-input') as HTMLInputElement | null;

  document.getElementById('btn-open-folder')?.addEventListener('click', () => {
    folderInput?.click();
  });

  // Track the currently-loaded folder's file contents (name→XML text).
  // Populated on folder upload or IndexedDB restore.
  let currentFolderFiles: Map<string, string> | null = null;
  let currentFolderName = '';

  const browseFolderMenu = document.getElementById('browse-folder-menu');
  const folderSubmenu = document.getElementById('folder-submenu');
  const closeFolderBtn = document.getElementById('btn-close-folder');

  /** A directory tree node: files at this level + child directories. */
  interface DirNode {
    files: string[];          // base names (no extension) of .dig files here
    children: Map<string, DirNode>;
  }

  /** Build the Browse Folder submenu from the current folder file map. */
  function buildFolderSubmenu(files: Map<string, string>): void {
    if (!folderSubmenu || !browseFolderMenu || !closeFolderBtn) return;
    folderSubmenu.innerHTML = '';

    // Build a nested tree from file keys (which may contain '/' separators)
    const root: DirNode = { files: [], children: new Map() };
    for (const key of files.keys()) {
      if (key.endsWith('.dig')) continue; // skip .dig-suffixed duplicates
      const parts = key.split('/');
      const fileName = parts.pop()!;
      let node = root;
      for (const segment of parts) {
        if (!node.children.has(segment)) {
          node.children.set(segment, { files: [], children: new Map() });
        }
        node = node.children.get(segment)!;
      }
      node.files.push(fileName);
    }

    // Recursively populate a dropdown element from a DirNode
    function populateDropdown(container: HTMLElement, node: DirNode, pathPrefix: string): void {
      // Sort and add subdirectory submenus first
      const sortedDirs = [...node.children.keys()].sort();
      for (const dirName of sortedDirs) {
        const childNode = node.children.get(dirName)!;
        const sub = document.createElement('div');
        sub.className = 'menu-submenu';

        const label = document.createElement('div');
        label.className = 'menu-action';
        label.textContent = dirName;
        sub.appendChild(label);

        const dropdown = document.createElement('div');
        dropdown.className = 'menu-dropdown';
        populateDropdown(dropdown, childNode, pathPrefix ? `${pathPrefix}/${dirName}` : dirName);
        sub.appendChild(dropdown);

        // Open/close submenu on hover
        sub.addEventListener('mouseenter', () => sub.classList.add('open'));
        sub.addEventListener('mouseleave', () => sub.classList.remove('open'));

        container.appendChild(sub);
      }

      // Then add .dig file items sorted
      const sortedFiles = [...node.files].sort();
      if (sortedDirs.length > 0 && sortedFiles.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        container.appendChild(sep);
      }
      for (const name of sortedFiles) {
        const fullKey = pathPrefix ? `${pathPrefix}/${name}` : name;
        const item = document.createElement('div');
        item.className = 'menu-action';
        item.textContent = name + '.dig';
        item.addEventListener('click', () => {
          openFromStoredFolder(fullKey);
        });
        container.appendChild(item);
      }
    }

    populateDropdown(folderSubmenu, root, '');

    browseFolderMenu.style.display = '';
    closeFolderBtn.style.display = '';
  }

  /** Hide the Browse Folder submenu and clear folder state. */
  function hideFolderSubmenu(): void {
    if (browseFolderMenu) browseFolderMenu.style.display = 'none';
    if (closeFolderBtn) closeFolderBtn.style.display = 'none';
    if (folderSubmenu) folderSubmenu.innerHTML = '';
    currentFolderFiles = null;
    currentFolderName = '';
  }

  /** Open a circuit by name from the current in-memory folder. */
  async function openFromStoredFolder(name: string): Promise<void> {
    if (!currentFolderFiles) return;
    const xml = currentFolderFiles.get(name);
    if (!xml) {
      showStatus(`File "${name}.dig" not found in folder`, true);
      return;
    }
    try {
      // Build resolver from all OTHER files in the folder
      const siblingMap = new Map<string, string>();
      for (const [k, v] of currentFolderFiles) {
        if (k !== name) {
          siblingMap.set(k, v);
          if (!k.endsWith('.dig')) siblingMap.set(k + '.dig', v);
        }
      }
      const folderResolver = new ChainResolver([
        new EmbeddedResolver(siblingMap),
        httpResolver,
      ]);
      const loaded = await loadWithSubcircuits(xml, folderResolver, registry);
      applyLoadedCircuit(loaded);
      circuit.metadata.name = name.split('/').pop() || name;
      updateCircuitName();
      const scCount = siblingMap.size / 2; // each file registered twice
      showStatus(`Loaded ${name}.dig (${scCount} subcircuit file${scCount !== 1 ? 's' : ''} available)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to load circuit from folder:', msg);
      showStatus(`Load error: ${msg}`, true);
    }
  }

  folderInput?.addEventListener('change', async () => {
    const files = folderInput?.files;
    if (!files || files.length === 0) return;

    // Read all .dig files to text and collect in a map
    const digFiles = new Map<string, string>();
    let folderName = '';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.name.endsWith('.dig')) {
        const name = f.name.replace(/\.dig$/, '');
        // Use webkitRelativePath for subfolder structure, fall back to name
        const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (relPath && !folderName) {
          folderName = relPath.split('/')[0] || name;
        }
        // Store under just the filename (no extension) for flat folders
        const content = await f.text();
        digFiles.set(name, content);
      }
    }

    if (digFiles.size === 0) {
      showStatus('No .dig files found in selected folder', true);
      return;
    }

    if (!folderName) folderName = 'Folder';

    // Persist to IndexedDB (single-slot replacement)
    try {
      await storeFolder(folderName, digFiles);
    } catch (e) {
      console.warn('Failed to persist folder to IndexedDB:', e);
    }

    // Set in-memory state and build menu
    currentFolderFiles = digFiles;
    currentFolderName = folderName;
    buildFolderSubmenu(digFiles);

    // If only one file, open it directly; otherwise let user pick from menu
    if (digFiles.size === 1) {
      const [name] = [...digFiles.keys()];
      await openFromStoredFolder(name);
    } else {
      showStatus(`Folder "${folderName}" loaded (${digFiles.size} .dig files). Use File → Browse Folder to open a circuit.`);
    }
  });

  // Close Folder handler
  closeFolderBtn?.addEventListener('click', async () => {
    hideFolderSubmenu();
    try {
      await clearFolder();
    } catch (e) {
      console.warn('Failed to clear folder from IndexedDB:', e);
    }
    showStatus('Folder closed');
  });

  // Restore folder from IndexedDB on startup
  loadFolder().then((stored) => {
    if (!stored) return;
    const files = new Map(Object.entries(stored.files));
    currentFolderFiles = files;
    currentFolderName = stored.name;
    buildFolderSubmenu(files);
    showStatus(`Folder "${stored.name}" restored (${files.size} .dig files). Use File → Browse Folder to open a circuit.`);
  }).catch((e) => {
    console.warn('Failed to restore folder from IndexedDB:', e);
  });

  document.getElementById('btn-save')?.addEventListener('click', () => {
    try {
      const json = serializeCircuit(circuit);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (circuit.metadata.name || 'circuit') + '.digj';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to save:', err);
    }
  });

  // -------------------------------------------------------------------------
  // Menu: New, Save As, Edit actions, Circuit name
  // -------------------------------------------------------------------------

  const circuitNameInput = document.getElementById('circuit-name') as HTMLInputElement | null;

  function updateCircuitName(): void {
    if (circuitNameInput) {
      circuitNameInput.value = circuit.metadata.name || 'Untitled';
    }
  }

  circuitNameInput?.addEventListener('change', () => {
    circuit.metadata.name = circuitNameInput.value.trim() || 'Untitled';
  });

  document.getElementById('btn-new')?.addEventListener('click', () => {
    circuit.elements.length = 0;
    circuit.wires.length = 0;
    circuit.metadata = { ...circuit.metadata, name: 'Untitled' };
    selection.clear();
    invalidateCompiled();
    updateCircuitName();
  });

  document.getElementById('btn-save-as')?.addEventListener('click', () => {
    const suggested = circuit.metadata.name || 'circuit';
    const name = prompt('Save as:', suggested);
    if (name !== null && name.trim() !== '') {
      circuit.metadata.name = name.trim();
      updateCircuitName();
      document.getElementById('btn-save')?.click();
    }
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    undoStack.undo();
    invalidateCompiled();
  });

  document.getElementById('btn-redo')?.addEventListener('click', () => {
    undoStack.redo();
    invalidateCompiled();
  });

  document.getElementById('btn-delete')?.addEventListener('click', () => {
    if (!selection.isEmpty()) {
      const elements = [...selection.getSelectedElements()];
      const wires: Wire[] = [...selection.getSelectedWires()];
      const cmd = deleteSelection(circuit, elements, wires);
      undoStack.push(cmd);
      selection.clear();
      invalidateCompiled();
    }
  });

  document.getElementById('btn-select-all')?.addEventListener('click', () => {
    selection.selectAll(circuit);
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // JS test script evaluator
  // -------------------------------------------------------------------------

  /**
   * Detect whether test data is a JavaScript test script (vs plain format).
   * Heuristic: contains `signals(` call.
   */
  function isJsTestScript(text: string): boolean {
    return /\bsignals\s*\(/.test(text);
  }

  /**
   * Evaluate a JavaScript test script and return the equivalent plain-format
   * test data string. The script runs in a sandboxed Function() with helpers:
   *   signals('A', 'B', 'Y')  — declare pin names (must be called once)
   *   row(0, 1, 1)            — add a test vector row
   *   X                       — don't-care value
   *   C                       — clock pulse value
   *   Z                       — high-impedance value
   */
  function evalJsTestScript(script: string): string {
    let pinNames: string[] | null = null;
    const rows: string[][] = [];

    const sandbox = {
      X: 'X',
      C: 'C',
      Z: 'Z',
      signals: (...names: string[]) => {
        if (pinNames !== null) throw new Error('signals() can only be called once');
        if (names.length === 0) throw new Error('signals() requires at least one pin name');
        pinNames = names;
      },
      row: (...values: (number | string)[]) => {
        if (pinNames === null) throw new Error('Call signals() before row()');
        if (values.length !== pinNames.length) {
          throw new Error(
            `row() expects ${pinNames.length} values (${pinNames.join(', ')}), got ${values.length}`,
          );
        }
        rows.push(values.map(v => String(v)));
      },
    };

    // Build and execute the sandboxed function
    const argNames = Object.keys(sandbox);
    const argValues = Object.values(sandbox);
    const fn = new Function(...argNames, script);
    fn(...argValues);

    if (pinNames === null) throw new Error('Test script must call signals()');
    if (rows.length === 0) throw new Error('Test script must add at least one row()');

    // Build plain-format output
    const names: string[] = pinNames;
    const lines = [names.join(' ')];
    for (const r of rows) {
      lines.push(r.join(' '));
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Test editor dialog
  // -------------------------------------------------------------------------

  document.getElementById('btn-tests')?.addEventListener('click', () => {
    // Find existing Testcase component or create the dialog with empty content
    let existingTestData = '';
    for (const el of circuit.elements) {
      if (el.typeId === 'Testcase') {
        const props = el.getProperties();
        if (props.has('testData')) {
          existingTestData = String(props.get('testData'));
        }
        break;
      }
    }

    const overlay = document.createElement('div');
    overlay.className = 'test-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'test-dialog';

    const header = document.createElement('div');
    header.className = 'test-dialog-header';
    header.innerHTML = '<span>Test Vectors</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const help = document.createElement('div');
    help.className = 'test-help';
    help.innerHTML =
      '<b>Plain format:</b> signal names on first line, then one row per test vector. Use 0/1, X (don\'t-care), C (clock).<br>' +
      '<b>JavaScript:</b> use <code>signals(\'A\',\'B\',\'Y\')</code> then <code>row(0,0,1)</code>. ' +
      'Use loops, variables, functions — full JS. Constants: <code>X</code> (don\'t-care), <code>C</code> (clock), <code>Z</code> (high-Z).';
    dialog.appendChild(help);

    const textarea = document.createElement('textarea');
    textarea.value = existingTestData;
    textarea.placeholder =
      '// Plain format:\nA B Y\n0 0 0\n0 1 1\n\n// Or JavaScript:\nsignals(\'A\', \'B\', \'Y\');\nfor (let i = 0; i < 4; i++) {\n  row(i >> 1, i & 1, (i >> 1) ^ (i & 1));\n}';
    dialog.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'test-dialog-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const rawText = textarea.value;

      // If the test data is a JS script, evaluate it to produce plain format
      let testData: string;
      if (isJsTestScript(rawText)) {
        try {
          testData = evalJsTestScript(rawText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showStatus(`Test script error: ${msg}`, true);
          return; // Don't close dialog — let user fix the script
        }
      } else {
        testData = rawText;
      }

      // Store the raw source (JS or plain) so the user sees their script when reopening
      // Also store the evaluated plain-format data for the test executor
      const storeValue = rawText;

      // Find or create Testcase element
      let testEl = circuit.elements.find(el => el.typeId === 'Testcase');
      if (testEl) {
        testEl.getProperties().set('testData', storeValue);
        testEl.getProperties().set('testDataCompiled', testData);
      } else {
        const testDef = registry.get('Testcase');
        if (testDef) {
          const props = new PropertyBag();
          props.set('testData', storeValue);
          props.set('testDataCompiled', testData);
          const el = testDef.factory(props);
          el.position = { x: 0, y: -3 };
          circuit.addElement(el);
        }
      }
      invalidateCompiled();
      overlay.remove();
      if (isJsTestScript(rawText)) {
        showStatus(`Test script evaluated: ${testData.split('\n').length - 1} test vectors generated`);
      }
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    textarea.focus();
  });

  // -------------------------------------------------------------------------
  // Keyboard: Ctrl+S save, Ctrl+O open
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('btn-save')?.click();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      fileInput?.click();
    }
  });

  // -------------------------------------------------------------------------
  // postMessage listener
  // -------------------------------------------------------------------------

  async function loadCircuitFromXml(xml: string): Promise<void> {
    let loaded: Circuit;
    try {
      loaded = await loadWithSubcircuits(xml, httpResolver, registry);
    } catch {
      loaded = loadDig(xml, registry);
    }
    applyLoadedCircuit(loaded);
  }

  async function handleMessage(data: Record<string, unknown>): Promise<void> {
    switch (data['type']) {
      case 'digital-load-url': {
        const url = String(data['url'] ?? '');
        if (!url) {
          window.parent.postMessage({ type: 'digital-error', error: 'No URL provided' }, '*');
          return;
        }
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
          const xml = await res.text();
          await loadCircuitFromXml(xml);
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        }
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
          await loadCircuitFromXml(xml);
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
    handleMessage(data).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      window.parent.postMessage({ type: 'digital-error', error: message }, '*');
    });
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
      .then(async (xml) => {
        await loadCircuitFromXml(xml);
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
