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
import { AppSettings, SettingKey } from '../editor/settings.js';
import { exportSvg } from '../export/svg.js';
import { exportPng } from '../export/png.js';
import { exportGif } from '../export/gif.js';
import { exportZip } from '../export/zip.js';

import { createDefaultRegistry } from '../components/register-all.js';
import { Circuit } from '../core/circuit.js';
import { ComponentPalette } from '../editor/palette.js';
import { PaletteUI } from '../editor/palette-ui.js';
import { PropertyPanel } from '../editor/property-panel.js';
import { Viewport } from '../editor/viewport.js';
import { SelectionModel } from '../editor/selection.js';
import { PlacementMode } from '../editor/placement.js';
import { WireDrawingMode } from '../editor/wire-drawing.js';
import { WireDragMode } from '../editor/wire-drag.js';
import { CanvasRenderer } from '../editor/canvas-renderer.js';
import { ElementRenderer } from '../editor/element-renderer.js';
import { WireRenderer } from '../editor/wire-renderer.js';
import { GridRenderer } from '../editor/grid.js';
import { UndoRedoStack } from '../editor/undo-redo.js';
import { SpeedControl } from '../integration/speed-control.js';
import { darkColorScheme, lightColorScheme, THEME_COLORS } from '../core/renderer-interface.js';
import { LockedModeGuard } from '../editor/locked-mode.js';
import { ColorSchemeManager, buildColorMap } from '../editor/color-scheme.js';
import { screenToWorld, snapToGrid, GRID_SPACING } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { TouchGestureTracker } from '../editor/touch-gestures.js';
import { splitWiresAtPoint, isWireEndpoint } from '../editor/wire-drawing.js';
import { deleteSelection, rotateSelection, mirrorSelection, copyToClipboard, pasteFromClipboard } from '../editor/edit-operations.js';
import type { ClipboardData } from '../editor/edit-operations.js';
import { loadDig } from '../io/dig-loader.js';
import { loadWithSubcircuits } from '../io/subcircuit-loader.js';
import { HttpResolver, EmbeddedResolver, ChainResolver } from '../io/file-resolver.js';
import { deserializeCircuit } from '../io/load.js';
import { serializeCircuit } from '../io/save.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { deserializeDts } from '../io/dts-deserializer.js';
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
import { DataTablePanel } from '../runtime/data-table.js';
import type { SignalDescriptor, SignalGroup } from '../runtime/data-table.js';
import { TimingDiagramPanel } from '../runtime/timing-diagram.js';
import { SimulationRunner } from '../headless/runner.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';
import { analyseCircuit } from '../analysis/model-analyser.js';
import { TruthTableTab } from '../analysis/truth-table-ui.js';
import { TruthTable } from '../analysis/truth-table.js';
import { autoConnectPower } from '../editor/auto-power.js';
import { KarnaughMapTab } from '../analysis/karnaugh-map.js';
import { minimize } from '../analysis/quine-mccluskey.js';
import { generateSOP, generatePOS } from '../analysis/expression-gen.js';
import { ExpressionEditorTab } from '../analysis/expression-editor.js';
import { synthesizeCircuit } from '../analysis/synthesis.js';
import { exprToString } from '../analysis/expression.js';
import { findCriticalPath } from '../analysis/path-analysis.js';
import { analyseSequential } from '../analysis/state-transition.js';
import type { SequentialAnalysisFacade, SignalSpec } from '../analysis/state-transition.js';

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

  // Load persisted settings — use AppSettings for persistence (SettingKey.COLOR_SCHEME etc.)
  const appSettings = new AppSettings(localStorage);
  appSettings.load();

  // Apply color scheme: AppSettings first, then URL param overrides
  const savedScheme = appSettings.get(SettingKey.COLOR_SCHEME);
  // If URL param explicitly set dark=0 use light; otherwise respect saved setting
  const useDark = !params.dark ? false : (savedScheme === 'light' ? false : true);
  applyColorScheme(useDark);
  // Sync html.light class
  if (!useDark) {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  } else {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
  }

  if (params.panels === 'none') {
    document.getElementById('app')?.classList.add('panels-none');
  }

  const registry = createDefaultRegistry();
  let circuit = new Circuit();

  /** Current save format: 'dig' (Digital XML) or 'digj' (native JSON). */
  let saveFormat: 'dig' | 'digj' = 'dig';
  const colorScheme = useDark ? darkColorScheme : lightColorScheme;

  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
  const ctx2d = canvas.getContext('2d')!;
  const canvasRenderer = new CanvasRenderer(ctx2d, colorScheme);

  const viewport = new Viewport();
  const selection = new SelectionModel();
  const placement = new PlacementMode();
  const wireDrawing = new WireDrawingMode();
  const wireDrag = new WireDragMode();
  const elementRenderer = new ElementRenderer();
  const wireRenderer = new WireRenderer();
  const gridRenderer = new GridRenderer();
  const undoStack = new UndoRedoStack();
  const lockedModeGuard = new LockedModeGuard();
  const colorSchemeManager = new ColorSchemeManager(useDark ? 'default' : 'light');
  const speedControl = new SpeedControl();

  // Sync: any colorSchemeManager change updates the canvas renderer automatically
  colorSchemeManager.onChange(() => {
    canvasRenderer.setColorScheme(colorSchemeManager.getActive());
  });

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
  if (params.palette) {
    palette.setAllowlist(params.palette);
  }
  const paletteContainer = document.getElementById('palette-content')!;
  const paletteUI = new PaletteUI(palette, paletteContainer, colorScheme);

  paletteUI.onPlace((def) => {
    placement.start(def);
  });
  paletteUI.onTouchDrop((def, worldPt) => {
    // Place component at the dropped world position and record for undo
    const element = def.factory(new PropertyBag());
    element.position = worldPt;
    circuit.addElement(element);
    invalidateCompiled();
    scheduleRender();
  });
  paletteUI.render();
  paletteUI.setCanvas(canvas, viewport);

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
    if (circuit.metadata.engineType === 'analog') {
      showStatus('Analog simulation not yet available', true);
      return false;
    }
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
      // Recreate viewer panels if the viewer panel is open
      if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
        // Re-resolve net IDs from signal names after recompilation
        for (const sig of watchedSignals) {
          const newNetId = compiled.labelToNetId.get(sig.name);
          if (newNetId !== undefined) {
            sig.netId = newNetId;
            sig.width = compiled.netWidths[newNetId] ?? 1;
          }
        }
        rebuildViewers();
      }
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
    // Dispose viewer panels — they hold stale net IDs
    disposeViewers();
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

    if (wireDrag.isActive()) {
      const doglegs = wireDrag.getDoglegs();
      canvasRenderer.setColor('WIRE');
      canvasRenderer.setLineWidth(2);
      for (const dw of doglegs) {
        canvasRenderer.drawLine(dw.start.x, dw.start.y, dw.end.x, dw.end.y);
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

  function canvasToWorld(e: { clientX: number; clientY: number }): Point {
    const rect = canvas.getBoundingClientRect();
    const screenPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return screenToWorld(screenPt, viewport.zoom, viewport.pan);
  }

  function canvasToScreen(e: { clientX: number; clientY: number }): Point {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // -------------------------------------------------------------------------
  // Interaction state
  // -------------------------------------------------------------------------

  const HIT_THRESHOLD = 0.5;

  type DragMode = 'none' | 'pan' | 'select-drag' | 'wire-drag' | 'box-select';

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
  // Pointer events
  // -------------------------------------------------------------------------

  /** Track the active pointer ID to reject secondary pointers (mouse/pen). */
  let activePointerId: number | null = null;
  /** Store pointer type for Phase 2/3 branching. Set on every pointerdown. */
  const pointerTypeRef = { value: 'mouse' };

  /** Long-press context menu state (touch only). */
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  let longPressClientX = 0;
  let longPressClientY = 0;
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_THRESHOLD = 10;

  function cancelLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  /** Touch threshold in grid units — larger hit targets for fingers. */
  const TOUCH_HIT_THRESHOLD = 1.5;
  const TOUCH_HIT_MARGIN = 0.5;

  const touchGestures = new TouchGestureTracker();

  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    pointerTypeRef.value = e.pointerType;

    // Touch pointers are handled by the gesture tracker (supports multi-touch).
    if (e.pointerType === 'touch') {
      const worldPt = canvasToWorld(e);
      const hitThreshold = TOUCH_HIT_THRESHOLD;
      const hitMargin = TOUCH_HIT_MARGIN;
      const pinHit = hitTestPins(worldPt, circuit.elements, hitThreshold);
      const elementHit = !pinHit ? hitTestElements(worldPt, circuit.elements, hitMargin) : undefined;
      const hitEmpty = !pinHit && !elementHit;
      touchGestures.onPointerDown(e, hitEmpty);

      // Long-press: start 500ms timer; if pointer doesn't move >10px, show context menu
      cancelLongPress();
      longPressStartX = e.clientX;
      longPressStartY = e.clientY;
      longPressClientX = e.clientX;
      longPressClientY = e.clientY;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        // Fire context menu at long-press position (reuse contextmenu handler logic)
        const synth = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: longPressClientX, clientY: longPressClientY,
        });
        canvas.dispatchEvent(synth);
      }, LONG_PRESS_MS);

      // If gesture tracker is in WAIT state (could still be a tap), fall through
      // to normal logic only for first touch on a hit target.
      if (touchGestures.isActive) return;
      if (!hitEmpty) {
        // Let normal logic handle taps on elements/pins below
      } else {
        // Empty canvas tap — gesture tracker will pan once threshold exceeded
        return;
      }
    }

    // Mouse/pen: reject secondary pointers
    if (e.pointerType !== 'touch') {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      activePointerId = e.pointerId;
    }

    const worldPt = canvasToWorld(e);
    const screenPt = canvasToScreen(e);
    const isTouch = e.pointerType === 'touch';
    const hitThreshold = isTouch ? TOUCH_HIT_THRESHOLD : HIT_THRESHOLD;
    const hitMargin = isTouch ? TOUCH_HIT_MARGIN : 0;

    if (e.button === 1) {
      dragMode = 'pan';
      dragStartScreen = screenPt;
      e.preventDefault();
      return;
    }

    if (e.button !== 0 && e.pointerType !== 'touch') return;

    // During simulation, only allow toggling interactive components (In, Clock, etc.)
    if (binding.isBound) {
      const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
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
      const pinHit = hitTestPins(worldPt, circuit.elements, hitThreshold);
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

    const pinHit = hitTestPins(worldPt, circuit.elements, hitThreshold);
    if (pinHit) {
      wireDrawing.startFromPin(pinHit.element, pinHit.pin);
      scheduleRender();
      return;
    }

    const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
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

    const wireHit = hitTestWires(worldPt, circuit.wires, hitThreshold);
    if (wireHit) {
      if (e.shiftKey) {
        selection.toggleSelect(wireHit);
        scheduleRender();
        return;
      }
      // If the clicked wire is already part of a multi-wire selection,
      // drag the whole group; otherwise select just this wire.
      if (!selection.isSelected(wireHit)) {
        selection.select(wireHit);
      }
      const selectedWires = selection.getSelectedWires();
      wireDrag.start(
        selectedWires.size > 1 ? selectedWires : wireHit,
        worldPt, circuit, circuit.elements,
      );
      dragMode = 'wire-drag';
      dragStart = worldPt;
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

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    // Touch: delegate to gesture tracker first
    if (e.pointerType === 'touch') {
      // Cancel long-press if pointer moved more than threshold
      if (longPressTimer !== null) {
        const dx = e.clientX - longPressStartX;
        const dy = e.clientY - longPressStartY;
        if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
          cancelLongPress();
        } else {
          longPressClientX = e.clientX;
          longPressClientY = e.clientY;
        }
      }
      if (touchGestures.onPointerMove(e, canvas, viewport, scheduleRender)) return;
    } else {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
    }
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

    if (dragMode === 'wire-drag') {
      if (wireDrag.update(worldPt)) {
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

  function finishPointerDrag(): void {
    if (dragMode === 'wire-drag') {
      wireDrag.finish(circuit);
      invalidateCompiled();
      scheduleRender();
    }

    if (dragMode === 'box-select') {
      const topLeft = canvasToWorld({
        clientX: Math.min(boxSelect.startScreen.x, boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.min(boxSelect.startScreen.y, boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      });
      const bottomRight = canvasToWorld({
        clientX: Math.max(boxSelect.startScreen.x, boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.max(boxSelect.startScreen.y, boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      });

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
  }

  canvas.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      touchGestures.onPointerUp(e);
      // If gesture was active, skip normal drag finish
      if (touchGestures.state === 'IDLE' || !touchGestures.isActive) {
        finishPointerDrag();
      }
      return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    finishPointerDrag();
  });

  canvas.addEventListener('pointercancel', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      touchGestures.onPointerUp(e);
      touchGestures.reset();
      dragMode = 'none';
      boxSelect.active = false;
      scheduleRender();
      return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    // Reset drag state on cancel
    dragMode = 'none';
    wireDrawing.cancel();
    boxSelect.active = false;
    wireDrag.cancel();
    scheduleRender();
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

    // Memory components: open hex editor
    if (MEMORY_TYPES.has(elementHit.typeId)) {
      void openMemoryEditor(elementHit);
      return;
    }

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

    const propsContainer = document.createElement('div');
    popup.appendChild(propsContainer);
    const tempPanel = new PropertyPanel(propsContainer);
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
  canvas.addEventListener('pointerdown', () => {
    closePopup();
  }, true);

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Don't intercept keys when the user is typing in an input field
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Still allow Escape to close popups
      if (e.key === 'Escape') {
        closePopup();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (placement.isActive()) {
        placement.cancel();
        scheduleRender();
      } else if (wireDrawing.isActive()) {
        wireDrawing.cancel();
        scheduleRender();
      } else if (wireDrag.isActive()) {
        wireDrag.cancel();
        dragMode = 'none';
        invalidateCompiled();
        scheduleRender();
      } else if (circuitStack.length > 0) {
        navigateBack();
      }
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      if (binding.isBound && engine.getState() === EngineState.RUNNING) {
        // Stop simulation and return to edit mode
        stopContinuousRun();
        binding.unbind();
        engine.dispose();
        compiledDirty = true;
        scheduleRender();
      } else {
        // Start simulation
        if (compiledDirty && !compileAndBind()) return;
        if (engine.getState() !== EngineState.RUNNING) {
          startContinuousRun();
        }
      }
      return;
    }

    // Block all edit shortcuts during simulation
    if (binding.isBound) return;

    // Single-letter placement/wire shortcuts — skip when Ctrl/Meta is held
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === 'i' || e.key === 'I') {
        const def = registry.get('In');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'o' || e.key === 'O') {
        const def = registry.get('Out');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'c' || e.key === 'C') {
        const def = registry.get('Const');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'w' || e.key === 'W') {
        if (placement.isActive()) placement.cancel();
        const snapped = snapToGrid(lastWorldPt, 1);
        wireDrawing.startFromPoint(snapped);
        scheduleRender();
        return;
      }
    }

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

    if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault();
      if (!selection.isEmpty()) {
        clipboard = copyToClipboard(
          [...selection.getSelectedElements()],
          [...selection.getSelectedWires()],
          (typeId: string) => registry.get(typeId),
        );
        const elements = [...selection.getSelectedElements()];
        const wires: Wire[] = [...selection.getSelectedWires()];
        const cmd = deleteSelection(circuit, elements, wires);
        undoStack.push(cmd);
        selection.clear();
        invalidateCompiled();
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

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
      updateZoomDisplay();
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

  document.getElementById('btn-speed-down')?.addEventListener('click', () => {
    speedControl.divideBy10();
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-up')?.addEventListener('click', () => {
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

  document.getElementById('btn-micro-step')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) engine.stop();
    try {
      engine.microStep();
      clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showStatus(`Simulation error: ${msg}`, true);
    }
    scheduleRender();
  });

  document.getElementById('btn-run-to-break')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    if (engine.getState() === EngineState.RUNNING) return;
    try {
      engine.runToBreak();
      clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showStatus(`Simulation error: ${msg}`, true);
    }
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
  // Viewer panels (Timing Diagram + Values Table)
  //
  // Signals are added by right-clicking wires on the canvas.
  // -------------------------------------------------------------------------

  const viewerPanel = document.getElementById('viewer-panel');
  const viewerTimingCanvas = document.getElementById('viewer-timing') as HTMLCanvasElement | null;
  const viewerValuesContainer = document.getElementById('viewer-values');
  const viewerTabs = viewerPanel?.querySelectorAll('.viewer-tab');

  let activeTimingPanel: TimingDiagramPanel | null = null;
  let activeDataTable: DataTablePanel | null = null;

  /** Watched signals — persisted across recompilations by name. */
  interface WatchedSignal {
    name: string;
    netId: number;
    width: number;
    group: SignalGroup;
  }
  const watchedSignals: WatchedSignal[] = [];

  /** Build a human-readable name for a net ID from the pinNetMap. */
  function netIdToName(cc: CompiledCircuitImpl, netId: number): string {
    // Try labelToNetId first (In/Out/Probe labels)
    for (const [label, nid] of cc.labelToNetId) {
      if (nid === netId) return label;
    }
    // Fall back to pinNetMap — find instanceId:pin, resolve component label
    for (const [pinKey, nid] of cc.pinNetMap) {
      if (nid === netId) {
        const [instId, pinLabel] = pinKey.split(':');
        // Try to find a label for this component
        for (const [, el] of cc.componentToElement) {
          if (el.instanceId === instId) {
            const elLabel = el.getProperties().getOrDefault<string>('label', '');
            const compName = elLabel || el.typeId;
            return `${compName}:${pinLabel}`;
          }
        }
        return pinKey;
      }
    }
    return `net${netId}`;
  }

  /** Determine signal group from its source element type. */
  function netIdToGroup(cc: CompiledCircuitImpl, netId: number): 'input' | 'output' | 'probe' {
    for (const [pinKey, nid] of cc.pinNetMap) {
      if (nid === netId) {
        const instId = pinKey.split(':')[0];
        for (const [, el] of cc.componentToElement) {
          if (el.instanceId === instId) {
            if (el.typeId === 'In' || el.typeId === 'Clock') return 'input';
            if (el.typeId === 'Out') return 'output';
            if (el.typeId === 'Probe') return 'probe';
            return 'probe';
          }
        }
      }
    }
    return 'probe';
  }

  /** Tear down any active viewer panels and unregister observers. */
  function disposeViewers(): void {
    if (activeTimingPanel) {
      engine.removeMeasurementObserver(activeTimingPanel);
      activeTimingPanel.dispose();
      activeTimingPanel = null;
    }
    if (activeDataTable) {
      engine.removeMeasurementObserver(activeDataTable);
      activeDataTable.dispose();
      activeDataTable = null;
    }
  }

  /** Rebuild viewer panels from the current watchedSignals list. */
  function rebuildViewers(): void {
    disposeViewers();
    if (!compiled || watchedSignals.length === 0) return;

    const channels = watchedSignals.map(s => ({ name: s.name, netId: s.netId, width: s.width }));

    // Size timing canvas to its container
    if (viewerTimingCanvas) {
      const container = viewerTimingCanvas.parentElement;
      if (container) {
        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = container.clientHeight;
        viewerTimingCanvas.width = w * dpr;
        viewerTimingCanvas.height = h * dpr;
        viewerTimingCanvas.style.width = `${w}px`;
        viewerTimingCanvas.style.height = `${h}px`;
      }
      activeTimingPanel = new TimingDiagramPanel(viewerTimingCanvas, engine, channels, {
        snapshotInterval: 0,  // no snapshots — just waveform recording
        stepsPerSecond: speedControl.speed,
      });
      engine.addMeasurementObserver(activeTimingPanel);
    }

    if (viewerValuesContainer) {
      const signals: SignalDescriptor[] = watchedSignals.map(s => ({
        name: s.name, netId: s.netId, width: s.width, group: s.group,
      }));
      activeDataTable = new DataTablePanel(viewerValuesContainer, engine, signals);
      engine.addMeasurementObserver(activeDataTable);
    }
  }

  /** Add a wire's net to the watched signals and rebuild viewers. */
  function addWireToViewer(wire: Wire): void {
    if (!compiled) return;
    const netId = compiled.wireToNetId.get(wire);
    if (netId === undefined) return;
    // Don't add duplicates
    if (watchedSignals.some(s => s.netId === netId)) return;

    const name = netIdToName(compiled, netId);
    const width = compiled.netWidths[netId] ?? 1;
    const group = netIdToGroup(compiled, netId);
    watchedSignals.push({ name, netId, width, group });

    // Open the viewer panel if not already open
    viewerPanel?.classList.add('open');
    rebuildViewers();
  }

  /** Remove a signal by net ID and rebuild viewers. */
  function removeSignalFromViewer(netId: number): void {
    const idx = watchedSignals.findIndex(s => s.netId === netId);
    if (idx >= 0) watchedSignals.splice(idx, 1);
    if (watchedSignals.length === 0) {
      closeViewer();
    } else {
      rebuildViewers();
    }
  }

  function showViewerTab(tabName: string): void {
    viewerTabs?.forEach(t => {
      t.classList.toggle('active', (t as HTMLElement).dataset['viewer'] === tabName);
    });
    viewerTimingCanvas?.classList.toggle('active', tabName === 'timing');
    viewerValuesContainer?.classList.toggle('active', tabName === 'values');
  }

  function openViewer(tabName: string): void {
    if (compiledDirty && !compileAndBind()) return;
    viewerPanel?.classList.add('open');
    showViewerTab(tabName);
    if (watchedSignals.length > 0 && !activeTimingPanel && !activeDataTable) {
      rebuildViewers();
    }
  }

  function closeViewer(): void {
    viewerPanel?.classList.remove('open');
    disposeViewers();
  }

  // Tab clicks
  viewerTabs?.forEach(tab => {
    tab.addEventListener('click', () => {
      const name = (tab as HTMLElement).dataset['viewer'];
      if (name) showViewerTab(name);
    });
  });

  // Close button
  document.getElementById('btn-viewer-close')?.addEventListener('click', closeViewer);

  // Toolbar buttons
  document.getElementById('btn-tb-timing')?.addEventListener('click', () => openViewer('timing'));
  document.getElementById('btn-tb-values')?.addEventListener('click', () => openViewer('values'));

  // Menu items
  document.getElementById('btn-menu-timing')?.addEventListener('click', () => openViewer('timing'));
  document.getElementById('btn-menu-values')?.addEventListener('click', () => openViewer('values'));

  // -------------------------------------------------------------------------
  // Right-click context menu on wires — add/remove from viewer
  // -------------------------------------------------------------------------

  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();

    const worldPt = canvasToWorld(e);

    // Check for memory component hit — show "Edit Memory..." context menu
    const elementHit = hitTestElements(worldPt, circuit.elements);
    if (elementHit && MEMORY_TYPES.has(elementHit.typeId)) {
      document.getElementById('wire-context-menu')?.remove();
      const memMenu = document.createElement('div');
      memMenu.id = 'wire-context-menu';
      memMenu.className = 'wire-context-menu';
      memMenu.style.position = 'fixed';
      memMenu.style.left = `${e.clientX}px`;
      memMenu.style.top = `${e.clientY}px`;
      const memHeader = document.createElement('div');
      memHeader.className = 'wire-context-header';
      const lbl = String(elementHit.getProperties().has('label') ? elementHit.getProperties().get('label') : elementHit.typeId);
      memHeader.textContent = lbl || elementHit.typeId;
      memMenu.appendChild(memHeader);
      const editItem = document.createElement('div');
      editItem.className = 'wire-context-item';
      editItem.textContent = 'Edit Memory…';
      editItem.addEventListener('click', () => {
        memMenu.remove();
        void openMemoryEditor(elementHit);
      });
      memMenu.appendChild(editItem);
      document.body.appendChild(memMenu);
      const dismissMem = (ev: PointerEvent) => {
        if (!memMenu.contains(ev.target as Node)) {
          memMenu.remove();
          document.removeEventListener('pointerdown', dismissMem);
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', dismissMem), 0);
      return;
    }

    if (!binding.isBound || !compiled) return;

    const wireHit = hitTestWires(worldPt, circuit.wires, HIT_THRESHOLD);
    if (!wireHit) return;

    const netId = compiled.wireToNetId.get(wireHit);
    if (netId === undefined) return;

    // Remove existing context menu if any
    document.getElementById('wire-context-menu')?.remove();

    const menu = document.createElement('div');
    menu.id = 'wire-context-menu';
    menu.className = 'wire-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const isWatched = watchedSignals.some(s => s.netId === netId);
    const signalName = netIdToName(compiled!, netId);
    const width = compiled!.netWidths[netId] ?? 1;

    // Header showing what net this is
    const header = document.createElement('div');
    header.className = 'wire-context-header';
    header.textContent = `${signalName} [${width}-bit]`;
    menu.appendChild(header);

    if (!isWatched) {
      const addItem = document.createElement('div');
      addItem.className = 'wire-context-item';
      addItem.textContent = 'Add to Viewer';
      addItem.addEventListener('click', () => {
        addWireToViewer(wireHit);
        menu.remove();
      });
      menu.appendChild(addItem);
    } else {
      const removeItem = document.createElement('div');
      removeItem.className = 'wire-context-item';
      removeItem.textContent = 'Remove from Viewer';
      removeItem.addEventListener('click', () => {
        removeSignalFromViewer(netId);
        menu.remove();
      });
      menu.appendChild(removeItem);
    }

    document.body.appendChild(menu);

    const dismiss = (ev: PointerEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener('pointerdown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
  });

  // -------------------------------------------------------------------------
  // Memory editor — double-click on RAM/ROM/EEPROM/RegisterFile
  // -------------------------------------------------------------------------

  /** Memory component type IDs that support the hex editor. */
  const MEMORY_TYPES = new Set(['RAM', 'ROM', 'EEPROM', 'RegisterFile']);

  /** Currently open memory editor overlay (only one at a time). */
  let activeMemoryOverlay: HTMLElement | null = null;

  function closeMemoryEditor(): void {
    activeMemoryOverlay?.remove();
    activeMemoryOverlay = null;
  }

  // Wrap in an async IIFE at call site; declared as async function here.
  async function openMemoryEditor(element: import('../core/element.js').CircuitElement): Promise<void> {
    closeMemoryEditor();

    const elementIdx = circuit.elements.indexOf(element);
    const { getBackingStore } = await import('../components/memory/ram.js');
    const dataField = getBackingStore(elementIdx);
    if (!dataField) {
      showStatus('Memory contents not available — run simulation first', false);
      return;
    }

    const props = element.getProperties();
    const label = String(props.has('label') ? props.get('label') : '');
    const typeId = element.typeId;
    const size = dataField.size;
    const width = Number(props.has('bitWidth') ? props.get('bitWidth') : props.has('dataBits') ? props.get('dataBits') : 8);
    const title = label
      ? `${label}: ${typeId} (${size} words × ${width} bits)`
      : `${typeId} (${size} words × ${width} bits)`;

    const overlay = document.createElement('div');
    overlay.className = 'memory-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'memory-dialog';

    const header = document.createElement('div');
    header.className = 'memory-dialog-header';
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'memory-dialog-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closeMemoryEditor);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'memory-dialog-body';

    const { MemoryEditorDialog } = await import('../runtime/memory-editor.js');
    const editor = new MemoryEditorDialog(dataField, body);
    editor.render();

    if (engine.getState() === EngineState.RUNNING) {
      editor.enableLiveUpdate(engine);
    }

    const footer = document.createElement('div');
    footer.className = 'memory-dialog-footer';

    const addrLabel = document.createElement('span');
    addrLabel.textContent = 'Go to:';
    addrLabel.style.fontSize = '12px';
    addrLabel.style.opacity = '0.7';

    const addrInput = document.createElement('input');
    addrInput.type = 'text';
    addrInput.placeholder = '0x0000';
    addrInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const addr = parseInt(addrInput.value, 16);
        if (!isNaN(addr)) editor.goToAddress(addr);
      }
    });

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Go';
    goBtn.addEventListener('click', () => {
      const addr = parseInt(addrInput.value, 16);
      if (!isNaN(addr)) editor.goToAddress(addr);
    });

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    const closeBtnFooter = document.createElement('button');
    closeBtnFooter.textContent = 'Close';
    closeBtnFooter.addEventListener('click', closeMemoryEditor);

    footer.appendChild(addrLabel);
    footer.appendChild(addrInput);
    footer.appendChild(goBtn);
    footer.appendChild(spacer);
    footer.appendChild(closeBtnFooter);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    overlay.addEventListener('pointerdown', (ev) => {
      if (ev.target === overlay) closeMemoryEditor();
    });

    document.body.appendChild(overlay);
    activeMemoryOverlay = overlay;
  }

  // Wire dblclick on memory components
  // (Inserted before the existing dblclick handler handles property popup)
  // We intercept in the existing dblclick handler by checking MEMORY_TYPES.

  // -------------------------------------------------------------------------
  // Search dialog — Ctrl+F
  // -------------------------------------------------------------------------

  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const searchCount = document.getElementById('search-count');
  const searchPrev = document.getElementById('search-prev');
  const searchNext = document.getElementById('search-next');
  const searchCloseBtn = document.getElementById('search-close');

  type SearchResult = import('../editor/search.js').SearchResult;
  let searchResults: SearchResult[] = [];
  let searchCursor = -1;
  let searchDebounceTimer = -1;
  let circuitSearchInstance: import('../editor/search.js').CircuitSearch | null = null;

  function openSearchBar(): void {
    if (!searchBar || !searchInput) return;
    searchBar.classList.add('open');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearchBar(): void {
    searchBar?.classList.remove('open');
    searchResults = [];
    searchCursor = -1;
    if (searchCount) searchCount.textContent = '';
    scheduleRender();
  }

  function runSearch(): void {
    if (!searchInput) return;
    const query = searchInput.value.trim();
    if (!circuitSearchInstance) {
      import('../editor/search.js').then(({ CircuitSearch }) => {
        circuitSearchInstance = new CircuitSearch();
        _doSearch(query);
      });
    } else {
      _doSearch(query);
    }
  }

  function _doSearch(query: string): void {
    if (!circuitSearchInstance) return;
    searchResults = circuitSearchInstance.search(circuit, query);
    searchCursor = searchResults.length > 0 ? 0 : -1;
    if (searchCount) {
      searchCount.textContent = searchResults.length > 0
        ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`
        : query ? 'No results' : '';
    }
    if (searchCursor >= 0) _navigateToResult(searchCursor);
    scheduleRender();
  }

  function _navigateToResult(idx: number): void {
    if (!circuitSearchInstance || searchResults.length === 0) return;
    searchCursor = ((idx % searchResults.length) + searchResults.length) % searchResults.length;
    const result = searchResults[searchCursor];
    if (result) {
      circuitSearchInstance.navigateTo(result, viewport);
      selection.clear();
      selection.select(result.element);
      scheduleRender();
    }
    if (searchCount) {
      searchCount.textContent = `${searchCursor + 1} / ${searchResults.length}`;
    }
  }

  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(runSearch, 150);
  });

  searchPrev?.addEventListener('click', () => _navigateToResult(searchCursor - 1));
  searchNext?.addEventListener('click', () => _navigateToResult(searchCursor + 1));
  searchCloseBtn?.addEventListener('click', closeSearchBar);

  document.getElementById('btn-find')?.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    openSearchBar();
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
    palette.setEngineTypeFilter(loaded.metadata.engineType === 'analog' ? 'analog' : null);
    paletteUI.render();
    updateCircuitModeLabel();
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
          // JSON — distinguish .dts format from legacy .digj
          const parsed = JSON.parse(text);
          if (parsed.format === 'dts' || parsed.format === 'digb') {
            const result = deserializeDts(text, registry);
            loaded = result.circuit;
          } else {
            loaded = deserializeCircuit(text, registry);
          }
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
        sub.addEventListener('pointerenter', () => sub.classList.add('open'));
        sub.addEventListener('pointerleave', () => sub.classList.remove('open'));

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

  /** Show a modal dialog listing .dig files in the folder for the user to pick one. */
  function showCircuitPickerDialog(files: Map<string, string>, folderName: string): void {
    // Build sorted list grouped by directory
    const sortedKeys = [...files.keys()].sort();

    const overlay = document.createElement('div');
    overlay.className = 'circuit-picker-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'circuit-picker';

    // Header
    const header = document.createElement('div');
    header.className = 'circuit-picker-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = `Open circuit — ${folderName}`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Scrollable list
    const list = document.createElement('div');
    list.className = 'circuit-picker-list';

    let lastDir = '';
    for (const key of sortedKeys) {
      const parts = key.split('/');
      const fileName = parts.pop()!;
      const dir = parts.join('/');

      // Show directory heading when directory changes
      if (dir !== lastDir) {
        if (dir) {
          const dirLabel = document.createElement('div');
          dirLabel.className = 'circuit-picker-dir';
          dirLabel.textContent = dir;
          list.appendChild(dirLabel);
        }
        lastDir = dir;
      }

      const item = document.createElement('div');
      item.className = 'circuit-picker-item';
      item.textContent = fileName + '.dig';
      item.addEventListener('click', () => {
        overlay.remove();
        openFromStoredFolder(key);
      });
      list.appendChild(item);
    }

    dialog.appendChild(list);
    overlay.appendChild(dialog);

    // Close on overlay background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
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

    // If only one file, open it directly; otherwise show picker dialog
    if (digFiles.size === 1) {
      const [name] = [...digFiles.keys()];
      await openFromStoredFolder(name);
    } else {
      showCircuitPickerDialog(digFiles, folderName);
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
      let content: string;
      let mimeType: string;
      let ext: string;
      if (saveFormat === 'dig') {
        content = serializeCircuitToDig(circuit, registry);
        mimeType = 'application/xml';
        ext = '.dig';
      } else {
        content = serializeCircuit(circuit);
        mimeType = 'application/json';
        ext = '.digj';
      }
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (circuit.metadata.name || 'circuit') + ext;
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

  // Save format toggle
  const formatDigBtn = document.getElementById('btn-format-dig');
  const formatDigjBtn = document.getElementById('btn-format-digj');

  function updateFormatChecks(): void {
    const digCheck = formatDigBtn?.querySelector('.format-check');
    const digjCheck = formatDigjBtn?.querySelector('.format-check');
    if (digCheck) digCheck.textContent = saveFormat === 'dig' ? '\u2713' : '';
    if (digjCheck) digjCheck.textContent = saveFormat === 'digj' ? '\u2713' : '';
  }

  formatDigBtn?.addEventListener('click', () => {
    saveFormat = 'dig';
    updateFormatChecks();
  });

  formatDigjBtn?.addEventListener('click', () => {
    saveFormat = 'digj';
    updateFormatChecks();
  });

  // -------------------------------------------------------------------------
  // Export menu (Task 6.2)
  // -------------------------------------------------------------------------

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function circuitBaseName(): string {
    return (circuit.metadata.name || 'circuit').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  document.getElementById('btn-export-svg')?.addEventListener('click', () => {
    const svg = exportSvg(circuit);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    downloadBlob(blob, `${circuitBaseName()}.svg`);
  });

  document.getElementById('btn-export-png')?.addEventListener('click', () => {
    exportPng(circuit).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}.png`);
    }).catch((err: unknown) => {
      showStatus(`PNG export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  document.getElementById('btn-export-png2x')?.addEventListener('click', () => {
    exportPng(circuit, { scale: 2 }).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}@2x.png`);
    }).catch((err: unknown) => {
      showStatus(`PNG export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  const gifMenuItem = document.getElementById('btn-export-gif');
  document.getElementById('btn-export-gif')?.addEventListener('click', () => {
    if (engine.getState() === EngineState.STOPPED) return;
    exportGif(circuit, engine).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}.gif`);
    }).catch((err: unknown) => {
      showStatus(`GIF export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  // Keep GIF menu item greyed out when engine is stopped — update on File menu open
  function updateGifMenuState(): void {
    if (gifMenuItem) {
      const stopped = engine.getState() === EngineState.STOPPED;
      gifMenuItem.style.opacity = stopped ? '0.4' : '';
      gifMenuItem.style.pointerEvents = stopped ? 'none' : '';
    }
  }
  // Update GIF state whenever the File menu opens
  document.querySelector('.menu-item[data-menu="file"]')?.addEventListener('click', updateGifMenuState);
  updateGifMenuState();

  document.getElementById('btn-export-zip')?.addEventListener('click', () => {
    exportZip(circuit, new Map()).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}.zip`);
    }).catch((err: unknown) => {
      showStatus(`ZIP export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  // -------------------------------------------------------------------------
  // Dark mode toggle (Task 6.1)
  // -------------------------------------------------------------------------

  const darkModeBtn = document.getElementById('btn-dark-mode');

  function updateDarkModeIcon(): void {
    if (!darkModeBtn) return;
    const isLight = document.documentElement.classList.contains('light');
    // Sun = light mode active (click to go dark), Moon = dark mode active (click to go light)
    darkModeBtn.textContent = isLight ? '\u2600' : '\u263D';
  }

  updateDarkModeIcon();

  darkModeBtn?.addEventListener('click', () => {
    const currentScheme = appSettings.get(SettingKey.COLOR_SCHEME);
    const goingLight = currentScheme === 'default' || currentScheme === 'dark';
    const newScheme = goingLight ? 'light' : 'default';
    appSettings.set(SettingKey.COLOR_SCHEME, newScheme);
    appSettings.save();
    applyColorScheme(!goingLight);
    colorSchemeManager.setActive(goingLight ? 'light' : 'default');
    if (goingLight) {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.remove('light');
      document.documentElement.classList.add('dark');
    }
    updateDarkModeIcon();
    paletteUI.setColorScheme(goingLight ? lightColorScheme : darkColorScheme);
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Fit to content + zoom display (Task 7.4-7.5)
  // -------------------------------------------------------------------------

  const zoomPctBtn = document.getElementById('btn-zoom-pct');
  const zoomDropdown = document.getElementById('zoom-dropdown');

  function updateZoomDisplay(): void {
    if (zoomPctBtn) {
      zoomPctBtn.textContent = Math.round(viewport.zoom * 100) + '%';
    }
  }

  updateZoomDisplay();

  zoomPctBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomDropdown?.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as Element)?.closest('.zoom-dropdown-container')) {
      zoomDropdown?.classList.remove('open');
    }
  });

  document.querySelectorAll('.zoom-preset').forEach((preset) => {
    preset.addEventListener('click', () => {
      const val = (preset as HTMLElement).dataset['zoom'];
      if (val === 'fit') {
        viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
      } else if (val !== undefined) {
        viewport.setZoom(parseFloat(val));
      }
      updateZoomDisplay();
      scheduleRender();
      zoomDropdown?.classList.remove('open');
    });
  });

  document.getElementById('btn-fit-content')?.addEventListener('click', () => {
    viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
    updateZoomDisplay();
    scheduleRender();
  });

  document.getElementById('btn-tb-fit')?.addEventListener('click', () => {
    viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
    updateZoomDisplay();
    scheduleRender();
  });

  // -------------------------------------------------------------------------
  // Lock toggle (Task 7.6)
  // -------------------------------------------------------------------------

  const lockBanner = document.getElementById('lock-banner');
  const lockCheck = document.getElementById('lock-check');

  function updateLockUI(): void {
    const locked = lockedModeGuard.isLocked();
    if (lockCheck) {
      lockCheck.textContent = locked ? '\u2713' : '';
    }
    if (lockBanner) {
      lockBanner.classList.toggle('visible', locked);
    }
  }

  updateLockUI();

  document.getElementById('btn-menu-lock')?.addEventListener('click', () => {
    lockedModeGuard.setLocked(!lockedModeGuard.isLocked());
    updateLockUI();
  });

  // -------------------------------------------------------------------------
  // Undo/Redo toolbar buttons (Task 7.7)
  // -------------------------------------------------------------------------

  const tbUndoBtn = document.getElementById('btn-tb-undo') as HTMLButtonElement | null;
  const tbRedoBtn = document.getElementById('btn-tb-redo') as HTMLButtonElement | null;

  function updateUndoRedoButtons(): void {
    if (tbUndoBtn) tbUndoBtn.disabled = !undoStack.canUndo();
    if (tbRedoBtn) tbRedoBtn.disabled = !undoStack.canRedo();
  }

  updateUndoRedoButtons();

  // Hook afterMutate to keep button states in sync
  const _prevAfterMutate = undoStack.afterMutate;
  undoStack.afterMutate = () => {
    _prevAfterMutate?.();
    updateUndoRedoButtons();
  };

  tbUndoBtn?.addEventListener('click', () => {
    undoStack.undo();
    invalidateCompiled();
    updateUndoRedoButtons();
  });

  tbRedoBtn?.addEventListener('click', () => {
    undoStack.redo();
    invalidateCompiled();
    updateUndoRedoButtons();
  });

  // -------------------------------------------------------------------------
  // View menu + color scheme dialog (Task 8.3)
  // -------------------------------------------------------------------------

  // Mirror dark mode toggle from View menu
  document.getElementById('btn-menu-dark-mode')?.addEventListener('click', () => {
    darkModeBtn?.click();
    const isLight = document.documentElement.classList.contains('light');
    const check = document.getElementById('dark-mode-check');
    if (check) check.textContent = isLight ? '' : '✓';
  });

  // Gate style toggle
  let gateStyleIec = false;
  document.getElementById('btn-menu-gate-style')?.addEventListener('click', () => {
    gateStyleIec = !gateStyleIec;
    colorSchemeManager.setGateShapeStyle(gateStyleIec ? 'iec' : 'ieee');
    const check = document.getElementById('gate-style-check');
    if (check) check.textContent = gateStyleIec ? '✓' : '';
    scheduleRender();
  });

  // Color scheme dialog
  document.getElementById('btn-color-scheme')?.addEventListener('click', () => {
    openColorSchemeDialog();
  });

  function openColorSchemeDialog(): void {
    const customColors: Partial<Record<string, string>> = {};

    const overlay = document.createElement('div');
    overlay.className = 'scheme-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'scheme-dialog';

    const header = document.createElement('div');
    header.className = 'scheme-dialog-header';
    header.innerHTML = '<span>Color Scheme</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'scheme-dialog-body';

    const selectRow = document.createElement('div');
    selectRow.className = 'scheme-select-row';
    const selectLabel = document.createElement('label');
    selectLabel.textContent = 'Active scheme:';
    const schemeSelect = document.createElement('select');
    colorSchemeManager.getSchemeNames().forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === colorSchemeManager.getActiveName()) opt.selected = true;
      schemeSelect.appendChild(opt);
    });
    schemeSelect.addEventListener('change', () => {
      colorSchemeManager.setActive(schemeSelect.value);
      updateColorGrid();
      scheduleRender();
    });
    selectRow.appendChild(selectLabel);
    selectRow.appendChild(schemeSelect);
    body.appendChild(selectRow);

    const colorGrid = document.createElement('div');
    colorGrid.className = 'color-grid';

    ['Color', 'Preview', 'Custom'].forEach(h => {
      const hdr = document.createElement('div');
      hdr.className = 'color-grid-header';
      hdr.textContent = h;
      colorGrid.appendChild(hdr);
    });

    const pickerMap = new Map<string, { swatch: HTMLDivElement; picker: HTMLInputElement }>();

    function updateColorGrid(): void {
      const activeScheme = colorSchemeManager.getActive();
      for (const color of THEME_COLORS) {
        const entry = pickerMap.get(color);
        if (entry) {
          const resolved = (customColors[color] as string | undefined) ?? activeScheme.resolve(color);
          entry.swatch.style.background = resolved;
          entry.picker.value = /^#[0-9a-fA-F]{6}$/.test(resolved) ? resolved : '#888888';
        }
      }
    }

    for (const color of THEME_COLORS) {
      const nameEl = document.createElement('div');
      nameEl.className = 'color-name';
      nameEl.textContent = color;

      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'color-picker-input';
      picker.title = 'Override ' + color;
      picker.addEventListener('input', () => {
        customColors[color] = picker.value;
        swatch.style.background = picker.value;
      });

      pickerMap.set(color, { swatch, picker });
      colorGrid.appendChild(nameEl);
      colorGrid.appendChild(swatch);
      colorGrid.appendChild(picker);
    }

    body.appendChild(colorGrid);
    dialog.appendChild(body);
    updateColorGrid();

    const footer = document.createElement('div');
    footer.className = 'scheme-dialog-footer';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to Default';
    resetBtn.addEventListener('click', () => {
      for (const k of Object.keys(customColors)) delete customColors[k];
      colorSchemeManager.setActive('default');
      schemeSelect.value = 'default';
      updateColorGrid();
      scheduleRender();
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save Custom...';
    saveBtn.addEventListener('click', () => {
      const name = prompt('Custom scheme name:', 'my-scheme');
      if (!name || !name.trim()) return;
      const baseScheme = colorSchemeManager.getActive();
      const fullMap = buildColorMap(baseScheme, customColors as Partial<Record<import('../core/renderer-interface.js').ThemeColor, string>>);
      colorSchemeManager.createCustomScheme(name.trim(), fullMap);
      colorSchemeManager.setActive(name.trim());
      const opt = document.createElement('option');
      opt.value = name.trim();
      opt.textContent = name.trim();
      opt.selected = true;
      schemeSelect.appendChild(opt);
      scheduleRender();
    });

    footer.appendChild(resetBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }


  // -------------------------------------------------------------------------
  // Presentation mode (Task 8.6)
  // -------------------------------------------------------------------------

  const appEl = document.getElementById('app');
  const exitPresentationBtn = document.getElementById('btn-exit-presentation');

  let presentationMode = false;

  function enterPresentation(): void {
    presentationMode = true;
    appEl?.classList.add('presentation-mode');
    scheduleRender();
  }

  function exitPresentation(): void {
    presentationMode = false;
    appEl?.classList.remove('presentation-mode');
    scheduleRender();
  }

  function togglePresentation(): void {
    if (presentationMode) {
      exitPresentation();
    } else {
      enterPresentation();
    }
  }

  document.getElementById('btn-presentation-mode')?.addEventListener('click', togglePresentation);
  exitPresentationBtn?.addEventListener('click', exitPresentation);

  // F4 toggle (added to the existing keydown listener via a second listener)
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'F4') {
      e.preventDefault();
      togglePresentation();
      return;
    }
    // Esc exits presentation mode (in addition to existing Esc handling)
    if (e.key === 'Escape' && presentationMode) {
      exitPresentation();
    }
  });

  // -------------------------------------------------------------------------
  // Tablet mode toggle (View menu)
  // -------------------------------------------------------------------------

  let tabletMode = false;
  const tabletModeCheck = document.getElementById('tablet-mode-check');

  function updateTabletModeUI(): void {
    if (tabletModeCheck) tabletModeCheck.textContent = tabletMode ? '\u2713' : '';
    appEl?.classList.toggle('tablet-mode', tabletMode);
    resizeCanvas();
  }

  document.getElementById('btn-tablet-mode')?.addEventListener('click', () => {
    tabletMode = !tabletMode;
    updateTabletModeUI();
  });

  // -------------------------------------------------------------------------
  // Settings dialog (Task 8.4-8.5)
  // -------------------------------------------------------------------------

  const SETTINGS_STORAGE_KEY = 'digital-js:engine-settings';

  function loadEngineSettings(): { snapshotBudgetMb: number; oscillationLimit: number } {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<{ snapshotBudgetMb: number; oscillationLimit: number }>;
        return {
          snapshotBudgetMb: typeof parsed.snapshotBudgetMb === 'number' ? parsed.snapshotBudgetMb : 64,
          oscillationLimit: typeof parsed.oscillationLimit === 'number' ? parsed.oscillationLimit : 1000,
        };
      }
    } catch { /* ignore */ }
    return { snapshotBudgetMb: 64, oscillationLimit: 1000 };
  }

  function saveEngineSettings(settings: { snapshotBudgetMb: number; oscillationLimit: number }): void {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  // Apply saved settings on startup
  const initialEngineSettings = loadEngineSettings();
  engine.setSnapshotBudget(initialEngineSettings.snapshotBudgetMb * 1024 * 1024);

  const settingsOverlay = document.getElementById('settings-overlay');
  const snapshotBudgetInput = document.getElementById('setting-snapshot-budget') as HTMLInputElement | null;
  const oscillationLimitInput = document.getElementById('setting-oscillation-limit') as HTMLInputElement | null;

  function openSettingsDialog(): void {
    const s = loadEngineSettings();
    if (snapshotBudgetInput) snapshotBudgetInput.value = String(s.snapshotBudgetMb);
    if (oscillationLimitInput) oscillationLimitInput.value = String(s.oscillationLimit);
    if (settingsOverlay) settingsOverlay.style.display = 'flex';
  }

  function closeSettingsDialog(): void {
    if (settingsOverlay) settingsOverlay.style.display = 'none';
  }

  document.getElementById('btn-settings')?.addEventListener('click', openSettingsDialog);
  document.getElementById('btn-menu-settings')?.addEventListener('click', openSettingsDialog);
  document.getElementById('btn-settings-close')?.addEventListener('click', closeSettingsDialog);
  document.getElementById('btn-settings-cancel')?.addEventListener('click', closeSettingsDialog);

  document.getElementById('btn-settings-save')?.addEventListener('click', () => {
    const budgetMb = Math.max(1, Math.min(256, parseInt(snapshotBudgetInput?.value ?? '64', 10) || 64));
    const oscLimit = Math.max(100, Math.min(100000, parseInt(oscillationLimitInput?.value ?? '1000', 10) || 1000));
    const newSettings = { snapshotBudgetMb: budgetMb, oscillationLimit: oscLimit };
    saveEngineSettings(newSettings);
    engine.setSnapshotBudget(budgetMb * 1024 * 1024);
    closeSettingsDialog();
    showStatus(`Settings saved. Oscillation limit: ${oscLimit}. Snapshot budget: ${budgetMb} MB.`);
  });

  // Close settings on overlay backdrop click
  settingsOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettingsDialog();
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

  // -------------------------------------------------------------------------
  // Edit menu: Auto-Connect Power Supplies
  // -------------------------------------------------------------------------

  function updateCircuitModeLabel(): void {
    const label = document.getElementById('circuit-mode-label');
    if (label) {
      label.textContent = circuit.metadata.engineType === 'analog' ? 'Analog' : 'Digital';
    }
  }

  document.getElementById('btn-circuit-mode')?.addEventListener('click', () => {
    const current = circuit.metadata.engineType;
    const next = current === 'digital' ? 'analog' : 'digital';
    circuit.metadata = { ...circuit.metadata, engineType: next };
    palette.setEngineTypeFilter(next === 'digital' ? null : 'analog');
    paletteUI.render();
    updateCircuitModeLabel();
    invalidateCompiled();
  });

  document.getElementById('btn-auto-power')?.addEventListener('click', () => {
    if (params.locked) return;
    const cmd = autoConnectPower(circuit);
    cmd.execute();
    undoStack.push(cmd);
    invalidateCompiled();
    scheduleRender();
    showStatus(`Auto-power: added supplies`);
  });

  // -------------------------------------------------------------------------
  // Analysis menu: Analyse Circuit
  // -------------------------------------------------------------------------

  function openAnalysisDialog(): void {
    const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
    const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));
    const hasFlipFlop = circuit.elements.some(el => flipFlopNames.has(el.typeId));

    const overlay = document.createElement('div');
    overlay.className = 'analysis-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'analysis-dialog';

    // Header
    const header = document.createElement('div');
    header.className = 'analysis-dialog-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Circuit Analysis';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    if (hasFlipFlop) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.style.margin = '16px';
      errDiv.textContent = 'This circuit contains sequential elements (flip-flops). ' +
        'Truth table analysis requires a purely combinational circuit. ' +
        'Use State Transition Analysis for sequential circuits.';
      dialog.appendChild(errDiv);
    } else {
      // Run analysis once; share result across tabs
      let ttModel: TruthTable | null = null;
      let analysisError: string | null = null;
      try {
        const runner = new SimulationRunner(registry);
        const result = analyseCircuit(runner as unknown as import('../headless/facade.js').SimulatorFacade, circuit);
        const inputSpecs = result.inputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
        const outputSpecs = result.outputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
        const outCount = outputSpecs.length;
        const data: import('../analysis/truth-table.js').TernaryValue[] = [];
        for (const row of result.rows) {
          for (let o = 0; o < outCount; o++) {
            const v = row.outputValues[o] ?? 0n;
            data.push(v === 0n ? 0n : 1n);
          }
        }
        ttModel = new TruthTable(inputSpecs, outputSpecs, data);
      } catch (err) {
        analysisError = err instanceof Error ? err.message : String(err);
      }

      // Build tab bar
      const tabBar = document.createElement('div');
      tabBar.className = 'analysis-tabs';
      const TAB_NAMES = ['Truth Table', 'K-Map', 'Expressions', 'Expression Editor'];
      const tabBtns: HTMLButtonElement[] = [];
      for (const name of TAB_NAMES) {
        const btn = document.createElement('button');
        btn.className = 'analysis-tab';
        btn.textContent = name;
        tabBar.appendChild(btn);
        tabBtns.push(btn);
      }
      dialog.appendChild(tabBar);

      const contentArea = document.createElement('div');
      contentArea.className = 'analysis-tab-content';
      dialog.appendChild(contentArea);

      function showAnalysisTab(idx: number): void {
        tabBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
        contentArea.innerHTML = '';

        if (analysisError && idx !== 3) {
          const errDiv = document.createElement('div');
          errDiv.className = 'analysis-error';
          errDiv.textContent = analysisError;
          contentArea.appendChild(errDiv);
          return;
        }

        if (idx === 0 && ttModel) {
          const ttTab = new TruthTableTab(ttModel);
          ttTab.render(contentArea);
        } else if (idx === 1 && ttModel) {
          renderKMapTab(contentArea, ttModel);
        } else if (idx === 2 && ttModel) {
          renderExpressionsTab(contentArea, ttModel);
        } else if (idx === 3) {
          renderExpressionEditorTab(contentArea);
        }
      }

      tabBtns.forEach((btn, i) => btn.addEventListener('click', () => showAnalysisTab(i)));
      showAnalysisTab(0);
    }

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function renderKMapTab(container: HTMLElement, ttModel: TruthTable): void {
    const numVars = ttModel.totalInputBits;
    if (numVars < 2 || numVars > 6) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.textContent = 'K-Map requires 2\u20136 input variables. This circuit has ' + numVars + '.';
      container.appendChild(errDiv);
      return;
    }

    let selectedOutput = 0;
    if (ttModel.outputs.length > 1) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:8px;font-size:12px;';
      const lbl = document.createElement('label');
      lbl.textContent = 'Output: ';
      const sel = document.createElement('select');
      sel.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--panel-border);border-radius:3px;padding:2px 4px;font-size:12px;';
      for (let i = 0; i < ttModel.outputs.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = ttModel.outputs[i]!.name;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => { selectedOutput = parseInt(sel.value, 10); renderKMapCanvas(); });
      row.appendChild(lbl);
      row.appendChild(sel);
      container.appendChild(row);
    }

    const kmapTab = new KarnaughMapTab(ttModel);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;max-width:100%;';
    container.appendChild(canvas);

    function renderKMapCanvas(): void {
      const CELL = 44;
      const layout = kmapTab.kmap.layout;
      const subMaps = kmapTab.subMapCount;
      const labelOff = CELL;
      const mapW = (layout.cols + 1) * CELL;
      const totalW = labelOff + subMaps * mapW + 16;
      const totalH = labelOff + layout.rows * CELL + 16;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = totalW * dpr;
      canvas.height = totalH * dpr;
      canvas.style.width = totalW + 'px';
      canvas.style.height = totalH + 'px';
      const ctx2 = canvas.getContext('2d')!;
      ctx2.scale(dpr, dpr);

      const cs = getComputedStyle(document.documentElement);
      const fg = cs.getPropertyValue('--fg').trim() || '#d4d4d4';
      const border = cs.getPropertyValue('--panel-border').trim() || '#3c3c3c';
      const LOOP_COLORS = ['#e84a4a88','#4ae84a88','#4a9ee888','#e8e84a88','#e84ae888','#4ae8e888','#ff8c0088','#8888ff88'];

      ctx2.clearRect(0, 0, totalW, totalH);
      ctx2.font = Math.round(CELL * 0.4) + 'px monospace';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';

      try {
        const minResult = minimize(ttModel, selectedOutput);
        kmapTab.setImplicants(minResult.primeImplicants);
      } catch (_e) { /* ignore */ }

      const kctx = {
        drawRect(x: number, y: number, w: number, h: number) {
          ctx2.strokeStyle = border;
          ctx2.lineWidth = 1;
          ctx2.strokeRect(x, y, w, h);
        },
        drawText(text: string, x: number, y: number) {
          ctx2.fillStyle = fg;
          ctx2.fillText(text, x, y);
        },
        drawLoop(x: number, y: number, w: number, h: number, colorIdx: number) {
          const c = LOOP_COLORS[colorIdx % LOOP_COLORS.length]!;
          ctx2.fillStyle = c;
          ctx2.strokeStyle = c.replace('88', 'ff');
          ctx2.lineWidth = 2;
          ctx2.beginPath();
          ctx2.roundRect(x + 2, y + 2, w - 4, h - 4, 6);
          ctx2.fill();
          ctx2.stroke();
          ctx2.lineWidth = 1;
        },
      };

      kmapTab.render(kctx, CELL, selectedOutput);
    }

    renderKMapCanvas();
  }

  function renderExpressionsTab(container: HTMLElement, ttModel: TruthTable): void {
    const tbl = document.createElement('table');
    tbl.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;';
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    for (const h of ['Output', 'Minimized (SOP)', 'Canonical SOP', 'Canonical POS']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left;padding:4px 10px;border-bottom:1px solid var(--panel-border);opacity:0.7;font-size:11px;text-transform:uppercase;';
      hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < ttModel.outputs.length; i++) {
      const tr = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = ttModel.outputs[i]!.name;
      nameCell.style.cssText = 'padding:4px 10px;font-weight:600;border-bottom:1px solid rgba(128,128,128,0.15);';
      tr.appendChild(nameCell);

      let minExpr = '', sopExpr = '', posExpr = '';
      try { const m = minimize(ttModel, i); minExpr = exprToString(m.selectedCover); } catch (e) { minExpr = 'Error'; }
      try { sopExpr = exprToString(generateSOP(ttModel, i)); } catch (_e) { sopExpr = 'Error'; }
      try { posExpr = exprToString(generatePOS(ttModel, i)); } catch (_e) { posExpr = 'Error'; }

      for (const val of [minExpr, sopExpr, posExpr]) {
        const td = document.createElement('td');
        td.textContent = val;
        td.style.cssText = 'padding:4px 10px;border-bottom:1px solid rgba(128,128,128,0.15);word-break:break-all;';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);
  }

  function renderExpressionEditorTab(container: HTMLElement): void {
    const editorCtrl = new ExpressionEditorTab();

    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:6px;';
    lbl.textContent = 'Enter a boolean expression (e.g. A AND B OR NOT C). Press Parse or Enter.';
    container.appendChild(lbl);

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const exprInput = document.createElement('input');
    exprInput.type = 'text';
    exprInput.placeholder = 'A AND B OR NOT C';
    exprInput.style.cssText = 'flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;font-family:monospace;font-size:13px;';
    const parseBtn = document.createElement('button');
    parseBtn.textContent = 'Parse';
    parseBtn.style.cssText = 'padding:4px 12px;background:var(--toolbar-bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;cursor:pointer;font-size:12px;';
    inputRow.appendChild(exprInput);
    inputRow.appendChild(parseBtn);
    container.appendChild(inputRow);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;margin-bottom:8px;min-height:16px;';
    container.appendChild(statusEl);

    const ttWrapper = document.createElement('div');
    ttWrapper.style.cssText = 'margin-bottom:12px;overflow:auto;';
    container.appendChild(ttWrapper);

    const synthBtn = document.createElement('button');
    synthBtn.textContent = 'Generate Circuit from Expression';
    synthBtn.disabled = true;
    synthBtn.style.cssText = 'padding:5px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
    synthBtn.addEventListener('click', () => {
      const pr = editorCtrl.lastResult;
      if (!pr.expr) return;
      const vars = editorCtrl.detectVariables();
      const exprMap = new Map<string, import('../analysis/expression.js').BoolExpr>([['Y', pr.expr]]);
      try {
        const synth = synthesizeCircuit(exprMap, vars, registry);
        applyLoadedCircuit(synth);
        container.closest('.analysis-overlay')?.remove();
        showStatus('Circuit synthesized (' + synth.elements.length + ' components)');
      } catch (e) {
        showStatus('Synthesis error: ' + (e instanceof Error ? e.message : String(e)), true);
      }
    });
    container.appendChild(synthBtn);

    function doParse(): void {
      editorCtrl.setText(exprInput.value);
      const pr = editorCtrl.parse();
      ttWrapper.innerHTML = '';
      if (pr.error) {
        statusEl.style.color = '#ffaaaa';
        statusEl.textContent = 'Parse error: ' + pr.error;
        synthBtn.disabled = true;
      } else {
        statusEl.style.color = '#4ae84a';
        statusEl.textContent = 'Valid: ' + exprToString(pr.expr!);
        synthBtn.disabled = false;
        try {
          const tt = editorCtrl.toTruthTable('Y');
          const ttTab = new TruthTableTab(tt);
          ttTab.render(ttWrapper);
        } catch (e) {
          ttWrapper.textContent = 'Table error: ' + (e instanceof Error ? e.message : String(e));
        }
      }
    }

    parseBtn.addEventListener('click', doParse);
    exprInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') doParse(); });
  }

  document.getElementById('btn-analyse-circuit')?.addEventListener('click', openAnalysisDialog);
  document.getElementById('btn-synthesise-circuit')?.addEventListener('click', openAnalysisDialog);

  // -------------------------------------------------------------------------
  // Tutorials menu
  // -------------------------------------------------------------------------
  document.getElementById('btn-browse-tutorials')?.addEventListener('click', () => {
    window.open('tutorials.html', '_blank');
  });
  document.getElementById('btn-edit-tutorial')?.addEventListener('click', () => {
    window.open('tutorial-editor.html', '_blank');
  });

  // -------------------------------------------------------------------------
  // Analysis menu: Critical Path
  // -------------------------------------------------------------------------

  document.getElementById('btn-critical-path')?.addEventListener('click', () => {
    let result;
    try {
      result = findCriticalPath(circuit, registry);
    } catch (err) {
      alert('Critical path analysis failed: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'cp-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'cp-dialog';

    const header = document.createElement('div');
    header.className = 'cp-dialog-header';
    const title = document.createElement('span');
    title.textContent = 'Critical Path Analysis';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cp-dialog-body';

    const stats = [
      ['Path Length', `${result.pathLength} ns`],
      ['Gate Count', String(result.gateCount)],
      ['Total Components', String(result.components.length)],
    ];
    for (const [label, value] of stats) {
      const row = document.createElement('div');
      row.className = 'cp-stat-row';
      const l = document.createElement('span');
      l.className = 'cp-stat-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'cp-stat-value';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
    }

    if (result.components.length > 0) {
      const listLabel = document.createElement('div');
      listLabel.style.cssText = 'margin-top:12px;margin-bottom:6px;font-weight:600;opacity:0.8;';
      listLabel.textContent = 'Components (topological order):';
      body.appendChild(listLabel);

      const list = document.createElement('ol');
      list.className = 'cp-path-list';
      for (const name of result.components) {
        const item = document.createElement('li');
        item.textContent = name;
        list.appendChild(item);
      }
      body.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'analysis-error';
      empty.style.marginTop = '12px';
      empty.textContent = 'No components found in circuit.';
      body.appendChild(empty);
    }

    dialog.appendChild(body);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  });

  // -------------------------------------------------------------------------
  // Analysis menu: State Transition Table
  // -------------------------------------------------------------------------

  document.getElementById('btn-state-transition')?.addEventListener('click', () => {
    // Identify flip-flop Q outputs as state variables
    const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
    const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));

    const stateVarSpecs: SignalSpec[] = [];
    const inputSpecs: SignalSpec[] = [];
    const outputSpecs: SignalSpec[] = [];

    for (const el of circuit.elements) {
      const props = el.getProperties();
      const label = props.has('label') ? String(props.get('label')) : '';
      const bits = props.has('bitWidth') ? Number(props.get('bitWidth')) : 1;

      if (flipFlopNames.has(el.typeId)) {
        // Use label or typeId+instanceId as state variable name
        const name = label.length > 0 ? label : `${el.typeId}_${el.instanceId}`;
        stateVarSpecs.push({ name, bitWidth: 1 });
      } else if (el.typeId === 'In') {
        const name = label.length > 0 ? label : `In_${el.instanceId}`;
        inputSpecs.push({ name, bitWidth: bits });
      } else if (el.typeId === 'Out') {
        const name = label.length > 0 ? label : `Out_${el.instanceId}`;
        outputSpecs.push({ name, bitWidth: bits });
      }
    }

    const overlay = document.createElement('div');
    overlay.className = 'st-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'st-dialog';

    const header = document.createElement('div');
    header.className = 'st-dialog-header';
    const title = document.createElement('span');
    title.textContent = 'State Transition Table';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'st-dialog-body';

    if (stateVarSpecs.length === 0) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.textContent = 'No flip-flops found in circuit. State transition analysis requires a sequential circuit.';
      body.appendChild(errDiv);
    } else {
      // Build a facade backed by the current engine state
      // For state transition analysis we drive signals via engine components
      let tableResult;
      try {
        // Build a minimal facade that maps signal names to engine I/O
        const engineEl = (name: string, typeId: string) =>
          circuit.elements.find(el => {
            const p = el.getProperties();
            const lbl = p.has('label') ? String(p.get('label')) : '';
            return el.typeId === typeId && lbl === name;
          });

        const facade: SequentialAnalysisFacade = {
          setStateValue(name: string, value: bigint): void {
            // Find flip-flop element by label, set its Q output via engine
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && engine) {
              (engine as any).setFlipFlopState?.(el.instanceId, value);
            }
          },
          setInput(name: string, value: bigint): void {
            const el = engineEl(name, 'In');
            if (el && engine) {
              (engine as any).setInputValue?.(el.instanceId, value);
            }
          },
          clockStep(): void {
            if (engine) {
              (engine as any).clockStep?.();
            }
          },
          getStateValue(name: string): bigint {
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && engine) {
              return (engine as any).getFlipFlopState?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
          getOutput(name: string): bigint {
            const el = engineEl(name, 'Out');
            if (el && engine) {
              return (engine as any).getOutputValue?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
        };

        tableResult = analyseSequential(facade, stateVarSpecs, inputSpecs, outputSpecs);
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'analysis-error';
        errDiv.textContent = 'Analysis failed: ' + (err instanceof Error ? err.message : String(err));
        body.appendChild(errDiv);
        dialog.appendChild(body);
        overlay.appendChild(dialog);
        overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        return;
      }

      // Build table
      const table = document.createElement('table');
      table.className = 'st-table';

      // Group header row
      const groupRow = document.createElement('tr');
      groupRow.className = 'st-group-header';
      const groups = [
        { label: 'Current State', count: tableResult.stateVars.length },
        { label: 'Inputs', count: tableResult.inputs.length },
        { label: 'Next State', count: tableResult.stateVars.length },
        { label: 'Outputs', count: tableResult.outputs.length },
      ].filter(g => g.count > 0);

      for (const g of groups) {
        const th = document.createElement('th');
        th.colSpan = g.count;
        th.textContent = g.label;
        groupRow.appendChild(th);
      }
      table.appendChild(groupRow);

      // Column header row
      const colRow = document.createElement('tr');
      const allCols = [
        ...tableResult.stateVars.map(v => v.name),
        ...tableResult.inputs.map(v => v.name),
        ...tableResult.stateVars.map(v => v.name + "'"),
        ...tableResult.outputs.map(v => v.name),
      ];
      for (const col of allCols) {
        const th = document.createElement('th');
        th.textContent = col;
        colRow.appendChild(th);
      }
      table.appendChild(colRow);

      // Data rows
      for (const row of tableResult.transitions) {
        const tr = document.createElement('tr');
        const vals = [
          ...row.currentState,
          ...row.input,
          ...row.nextState,
          ...row.output,
        ];
        for (const val of vals) {
          const td = document.createElement('td');
          td.textContent = val.toString();
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }

      body.appendChild(table);
    }

    dialog.appendChild(body);
    overlay.appendChild(dialog);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  });

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

      case 'digital-set-palette': {
        const raw = data['components'];
        if (Array.isArray(raw)) {
          const names = raw.map(String).filter((s) => s.length > 0);
          palette.setAllowlist(names.length > 0 ? names : null);
        } else {
          palette.setAllowlist(null);
        }
        paletteUI.render();
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
        break;
      }

      // --- Tutorial postMessage extensions ---

      case 'digital-test': {
        const testDataStr = String(data['testData'] ?? '');
        if (!testDataStr) {
          window.parent.postMessage({ type: 'digital-error', error: 'No testData provided' }, '*');
          return;
        }
        try {
          const testRunner = new SimulationRunner(registry);
          const testEngine = testRunner.compile(circuit);
          // Auto-detect input/output split from circuit In/Out labels
          const circuitInputLabels = new Set<string>();
          const circuitOutputLabels = new Set<string>();
          for (const el of circuit.elements) {
            const def = registry.get(el.typeId);
            if (!def) continue;
            const lbl = el.getProperties().getOrDefault('label', '') as string;
            if (!lbl) continue;
            if (def.name === 'In' || def.name === 'Clock') circuitInputLabels.add(lbl);
            else if (def.name === 'Out') circuitOutputLabels.add(lbl);
          }
          // Check that test vector signal names have matching labeled components
          const hdrLine = testDataStr.split('\n').find((l) => l.trim().length > 0 && !l.trim().startsWith('#')) ?? '';
          const hdrNames = hdrLine.trim().split(/\s+/).filter((n) => n.length > 0);
          const missingLabels = hdrNames.filter((n) => !circuitInputLabels.has(n) && !circuitOutputLabels.has(n));
          if (missingLabels.length > 0) {
            const msg = `Test signals not found in circuit: ${missingLabels.join(', ')}. ` +
              `Make sure your In/Out components have labels that match the test vector signal names ` +
              `(${hdrNames.join(', ')}). Double-click a component to set its label.`;
            window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
            return;
          }
          let detectedInputCount = 0;
          for (const n of hdrNames) {
            if (circuitInputLabels.has(n)) detectedInputCount++;
            else break;
          }
          const parsed = parseTestData(testDataStr, detectedInputCount > 0 ? detectedInputCount : undefined);
          const results = executeTests(testRunner, testEngine, circuit, parsed);
          window.parent.postMessage({
            type: 'digital-test-result',
            passed: results.passed,
            failed: results.failed,
            total: results.total,
            details: results.vectors.map((v) => ({
              passed: v.passed,
              inputs: v.inputs,
              expected: v.expectedOutputs,
              actual: v.actualOutputs,
            })),
          }, '*');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          let userMsg: string;
          if (msg.includes('did not stabilize') || msg.includes('oscillation') || msg.includes('iterations')) {
            userMsg = 'Circuit has a feedback loop that could not settle. '
              + 'Check your wiring — a cross-coupled latch needs exactly two feedback paths. '
              + 'Extra or missing connections can cause the circuit to oscillate forever.';
          } else if (msg.includes('not found') || msg.includes('label')) {
            userMsg = msg;
          } else {
            userMsg = `Test error: ${msg}`;
          }
          window.parent.postMessage({ type: 'digital-error', error: userMsg }, '*');
        }
        break;
      }

      case 'digital-get-circuit': {
        try {
          const xml = serializeCircuitToDig(circuit, registry);
          const encoded = btoa(xml);
          window.parent.postMessage({
            type: 'digital-circuit-data',
            data: encoded,
            format: 'dig-xml-base64',
          }, '*');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          window.parent.postMessage({ type: 'digital-error', error: `Serialize failed: ${msg}` }, '*');
        }
        break;
      }

      case 'digital-highlight': {
        const labels = data['labels'];
        if (!Array.isArray(labels)) {
          window.parent.postMessage({ type: 'digital-error', error: 'highlight requires labels array' }, '*');
          return;
        }
        const labelSet = new Set(labels.map(String));
        const toSelect = circuit.elements.filter(
          (el) => labelSet.has(String(el.getProperties().get('label') ?? '')),
        );
        selection.boxSelect(toSelect, []);
        scheduleRender();
        // Auto-clear after duration (default 3 seconds)
        const duration = typeof data['duration'] === 'number' ? data['duration'] : 3000;
        if (duration > 0) {
          setTimeout(() => {
            selection.clear();
            scheduleRender();
          }, duration);
        }
        break;
      }

      case 'digital-clear-highlight': {
        selection.clear();
        scheduleRender();
        break;
      }

      case 'digital-set-readonly-components': {
        const readonlyLabels = data['labels'];
        if (readonlyLabels === null || readonlyLabels === undefined) {
          // Clear all readonly flags
          for (const el of circuit.elements) {
            (el as unknown as Record<string, unknown>)['_readonly'] = false;
          }
        } else if (Array.isArray(readonlyLabels)) {
          const readonlySet = new Set(readonlyLabels.map(String));
          for (const el of circuit.elements) {
            const label = String(el.getProperties().get('label') ?? '');
            (el as unknown as Record<string, unknown>)['_readonly'] = readonlySet.has(label);
          }
        }
        break;
      }

      case 'digital-set-instructions': {
        const markdown = data['markdown'];
        let instructionsPanel = document.getElementById('tutorial-instructions');
        let toggleBtn = document.getElementById('tutorial-toggle-btn');
        if (markdown === null || markdown === undefined) {
          // Hide/remove instructions panel and toggle
          if (instructionsPanel) instructionsPanel.style.display = 'none';
          if (toggleBtn) toggleBtn.style.display = 'none';
        } else {
          if (!instructionsPanel) {
            instructionsPanel = document.createElement('div');
            instructionsPanel.id = 'tutorial-instructions';
            instructionsPanel.className = 'tutorial-instructions-panel';
            const workspace = document.getElementById('workspace');
            if (workspace) workspace.insertBefore(instructionsPanel, workspace.firstChild);
          }
          if (!toggleBtn) {
            toggleBtn = document.createElement('button');
            toggleBtn.id = 'tutorial-toggle-btn';
            toggleBtn.className = 'tutorial-toggle-btn';
            toggleBtn.textContent = 'Instructions';
            const canvasContainer = document.getElementById('canvas-container');
            if (canvasContainer) canvasContainer.appendChild(toggleBtn);
            toggleBtn.addEventListener('click', () => {
              const panel = document.getElementById('tutorial-instructions');
              if (!panel) return;
              const collapsed = panel.classList.toggle('collapsed');
              toggleBtn!.textContent = collapsed ? 'Instructions' : 'Hide';
            });
          }
          instructionsPanel.style.display = '';
          toggleBtn.style.display = '';
          // Simple markdown rendering (headers, bold, code, lists)
          const escaped = String(markdown)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const html = escaped
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+?)`/g, '<code>$1</code>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
          instructionsPanel.innerHTML = html;
        }
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
  // Palette toggle (narrow screens)
  // -------------------------------------------------------------------------

  const palettePanel = document.getElementById('palette-panel');
  const paletteToggleBtn = document.getElementById('btn-palette-toggle');

  function togglePalette(): void {
    palettePanel?.classList.toggle('palette-visible');
  }

  function closePaletteOverlay(): void {
    palettePanel?.classList.remove('palette-visible');
  }

  paletteToggleBtn?.addEventListener('click', togglePalette);

  // Tap on canvas dismisses palette overlay (mobile only — palette is absolute positioned)
  canvas.addEventListener('pointerdown', () => {
    if (window.matchMedia('(max-width: 600px)').matches) {
      closePaletteOverlay();
    }
  });

  // -------------------------------------------------------------------------
  // Panel resize handles
  // -------------------------------------------------------------------------

  // Palette width resize
  const paletteResizeHandle = document.getElementById('palette-resize-handle');
  if (paletteResizeHandle && palettePanel) {
    let resizingPalette = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    paletteResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      resizingPalette = true;
      resizeStartX = e.clientX;
      resizeStartWidth = palettePanel.offsetWidth;
      paletteResizeHandle.setPointerCapture(e.pointerId);
      paletteResizeHandle.classList.add('dragging');
      e.preventDefault();
    });

    paletteResizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!resizingPalette) return;
      const dx = e.clientX - resizeStartX;
      const newWidth = Math.max(120, Math.min(400, resizeStartWidth + dx));
      palettePanel.style.width = `${newWidth}px`;
    });

    const stopPaletteResize = (): void => {
      resizingPalette = false;
      paletteResizeHandle.classList.remove('dragging');
      scheduleRender();
    };

    paletteResizeHandle.addEventListener('pointerup', stopPaletteResize);
    paletteResizeHandle.addEventListener('pointercancel', stopPaletteResize);
  }

  // Viewer height resize
  const viewerResizeHandle = document.getElementById('viewer-resize-handle');
  if (viewerResizeHandle && viewerPanel) {
    let resizingViewer = false;
    let viewerResizeStartY = 0;
    let viewerResizeStartH = 0;

    // Show/hide the viewer resize handle when the viewer panel opens/closes
    const updateViewerHandleVisibility = (): void => {
      const isOpen = viewerPanel.classList.contains('open');
      viewerResizeHandle.classList.toggle('viewer-open', isOpen);
    };

    // Observe viewer panel class changes to sync handle visibility
    const viewerObserver = new MutationObserver(updateViewerHandleVisibility);
    viewerObserver.observe(viewerPanel, { attributes: true, attributeFilter: ['class'] });
    updateViewerHandleVisibility();

    viewerResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!viewerPanel.classList.contains('open')) return;
      resizingViewer = true;
      viewerResizeStartY = e.clientY;
      viewerResizeStartH = viewerPanel.offsetHeight;
      viewerResizeHandle.setPointerCapture(e.pointerId);
      viewerResizeHandle.classList.add('dragging');
      e.preventDefault();
    });

    viewerResizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!resizingViewer) return;
      // Drag up increases height, drag down decreases
      const dy = viewerResizeStartY - e.clientY;
      const newH = Math.max(80, Math.min(600, viewerResizeStartH + dy));
      viewerPanel.style.height = `${newH}px`;
    });

    const stopViewerResize = (): void => {
      resizingViewer = false;
      viewerResizeHandle.classList.remove('dragging');
      // Resize the timing canvas to fill new height
      if (viewerTimingCanvas) {
        const container = viewerTimingCanvas.parentElement;
        if (container) {
          const dpr = window.devicePixelRatio || 1;
          const w = container.clientWidth;
          const h = container.clientHeight;
          viewerTimingCanvas.width = w * dpr;
          viewerTimingCanvas.height = h * dpr;
          viewerTimingCanvas.style.width = `${w}px`;
          viewerTimingCanvas.style.height = `${h}px`;
          // Re-render timing panel to fill new canvas size
          scheduleRender();
        }
      }
    };

    viewerResizeHandle.addEventListener('pointerup', stopViewerResize);
    viewerResizeHandle.addEventListener('pointercancel', stopViewerResize);
  }

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
