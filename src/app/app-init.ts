/**
 * Application initialization sequence.
 *
 * Wires together the component registry, file resolver, editor subsystems,
 * canvas rendering pipeline, simulation engine, and all DOM event handlers.
 * Called once on page load from main.ts.
 *
 * Browser-only: imports DOM-dependent modules.
 */

import { parseUrlParams, loadModuleConfig, applyModuleConfig } from './url-params.js';
import type { ModuleConfig } from './url-params.js';
import type { AppContext } from './app-context.js';
import { initRenderPipeline } from './render-pipeline.js';
import type { RenderPipeline } from './render-pipeline.js';
import { initSimulationController } from './simulation-controller.js';
import type { SimulationController } from './simulation-controller.js';
import { initKeyboardHandler } from './keyboard-handler.js';
import { AppSettings, SettingKey } from '../editor/settings.js';
import { exportSvg } from '../export/svg.js';
import { exportPng } from '../export/png.js';
import { exportGif } from '../export/gif.js';
import { exportZip } from '../export/zip.js';

import { createDefaultRegistry } from '../components/register-all.js';
import { hasDigitalModel, hasAnalogModel, availableModels } from '../core/registry.js';
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
import { darkColorScheme, lightColorScheme, THEME_COLORS } from '../core/renderer-interface.js';
import { LockedModeGuard } from '../editor/locked-mode.js';
import { ColorSchemeManager, buildColorMap } from '../editor/color-scheme.js';
import { snapToGrid } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { TouchGestureTracker } from '../editor/touch-gestures.js';
import { splitWiresAtPoint, isWireEndpoint } from '../editor/wire-drawing.js';
import { ContextMenu, separator } from '../editor/context-menu.js';
import type { MenuItem } from '../editor/context-menu.js';
import { deleteSelection, rotateSelection, mirrorSelection, copyToClipboard, pasteFromClipboard, placeComponent } from '../editor/edit-operations.js';
import type { ClipboardData } from '../editor/edit-operations.js';
import { loadDig } from '../io/dig-loader.js';
import { loadWithSubcircuits } from '../io/subcircuit-loader.js';
import { HttpResolver, EmbeddedResolver, ChainResolver } from '../io/file-resolver.js';
import { deserializeCircuit } from '../io/load.js';
import { parseCtzCircuitFromText } from '../io/ctz-parser.js';
import { createModal } from './dialog-manager.js';
import { serializeCircuit } from '../io/save.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { deserializeDts } from '../io/dts-deserializer.js';
import { storeFolder, loadFolder, clearFolder } from '../io/folder-store.js';
import { PostMessageAdapter } from '../io/postmessage-adapter.js';
import { createTestBridge } from './test-bridge.js';
import { DefaultSimulatorFacade } from '../headless/default-facade.js';
import { createEditorBinding } from '../integration/editor-binding.js';
import { EngineState } from '../core/engine-interface.js';
import { BitVector } from '../core/signal.js';
import { PropertyBag } from '../core/properties.js';
import { pinWorldPosition } from '../core/pin.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import { DataTablePanel } from '../runtime/data-table.js';
import type { SignalDescriptor, SignalGroup } from '../runtime/data-table.js';
// TimingDiagramPanel removed — unified into ScopePanel
import { ScopePanel } from '../runtime/analog-scope-panel.js';
import type { AcParams } from '../solver/analog/ac-analysis.js';
import { BodePlotRenderer } from '../runtime/bode-plot.js';
import { LOGIC_FAMILY_PRESETS, getLogicFamilyPreset, defaultLogicFamily } from '../core/logic-family.js';
import type { BodeViewport } from '../runtime/bode-plot.js';
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
import type { SignalAddress } from '../compile/types.js';

/** Component type names that are togglable during simulation — skip property popup on dblclick. */
const TOGGLABLE_TYPES = new Set(["In", "Clock", "Button", "Switch", "SwitchDT", "DipSwitch"]);

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
  // Analog component types — their output pins are circuit nodes, not signal drivers,
  // so the shorted-outputs consistency check must skip them.
  const analogTypeIds: ReadonlySet<string> = new Set(
    registry.getWithModel("analog").map((d) => d.name),
  );
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
  const contextMenu = new ContextMenu(document.body);

  // Sync: any colorSchemeManager change updates renderers automatically
  colorSchemeManager.onChange(() => {
    const active = colorSchemeManager.getActive();
    canvasRenderer.setColorScheme(active);
    wireRenderer.setColorScheme(active);
    // The element renderer's factory captures the scheme at creation time.
    // No update needed here — the factory reads the current scheme on each call.
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
    renderPipeline.scheduleRender();
  });
  paletteUI.render();
  paletteUI.setCanvas(canvas, viewport);

  // -------------------------------------------------------------------------
  // Insert menu — full component set with hierarchical submenus
  // -------------------------------------------------------------------------
  const insertMenuDropdown = document.getElementById('insert-menu-dropdown');

  const INSERT_CATEGORY_LABELS: Record<string, string> = {
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
    PASSIVES: "Passives",
    SEMICONDUCTORS: "Semiconductors",
    SOURCES: "Sources",
    ACTIVE: "Active",
  };

  /** Category keys for the Insert menu. */
  const INSERT_ORDER_ANALOG = [
    "PASSIVES", "SEMICONDUCTORS", "SOURCES", "ACTIVE",
    "IO", "WIRING", "LOGIC", "SWITCHING", "FLIP_FLOPS", "MEMORY",
    "ARITHMETIC", "PLD", "MISC", "GRAPHICS", "TERMINAL", "74XX",
  ];

  /** Rebuild the Insert menu. */
  function rebuildInsertMenu(): void {
    if (!insertMenuDropdown) return;
    insertMenuDropdown.innerHTML = '';
    const reg = palette.getRegistry();
    for (const catKey of INSERT_ORDER_ANALOG) {
      const defs = reg.getByCategory(catKey as any);
      if (defs.length === 0) continue;
      const sub = document.createElement("div");
      sub.className = "menu-submenu";
      const trigger = document.createElement("div");
      trigger.className = "menu-action";
      trigger.textContent = INSERT_CATEGORY_LABELS[catKey] ?? catKey;
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
  rebuildInsertMenu();

  selection.onChange(() => {
    const selected = selection.getSelectedElements();

    // --- Populate analog sliders for selected element ---
    const sliderPanel = simController?.activeSliderPanel;
    if (sliderPanel) {
      sliderPanel.removeUnpinned();
      if (selected.size === 1) {
        const element = selected.values().next().value!;
        const sliderCoordinator = facade.getCoordinator();
        const sliderProps = sliderCoordinator.getSliderProperties(element);
        for (const sp of sliderProps) {
          sliderPanel.addSlider(
            sp.elementIndex,
            sp.key,
            sp.label,
            sp.currentValue,
            { unit: sp.unit, logScale: sp.logScale },
          );
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Engine + binding
  // -------------------------------------------------------------------------

  const facade = new DefaultSimulatorFacade(registry);
  const binding = createEditorBinding();
  let compiledDirty = true;

  // isSimActive, compileAndBind, invalidateCompiled — delegated to simController (set up below)

  // -------------------------------------------------------------------------
  // Render pipeline — canvas sizing, render loop, coordinate helpers
  // -------------------------------------------------------------------------

  // renderPipeline is initialized after the AppContext object is built below.
  // We use a mutable reference so compileAndBind (defined above) can call
  // scheduleRender via the ctx.scheduleRender shim set up after ctx is built.
  let renderPipeline!: RenderPipeline;

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

  // boxSelect lives in renderPipeline.state.boxSelect (set up below)

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
      const worldPt = renderPipeline.canvasToWorld(e);
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

    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
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

    // Placement takes priority even during simulation — stop sim and place.
    if (placement.isActive() && placement.isPasteMode()) {
      invalidateCompiled();
      placement.updateCursor(worldPt);
      const transformed = placement.getTransformedClipboard();
      const cmd = pasteFromClipboard(circuit, transformed, worldPt);
      undoStack.push(cmd);
      placement.cancel();
      return;
    }

    if (placement.isActive()) {
      // If the click lands on the just-placed component (its body or a pin),
      // exit placement mode and select/start-wire instead of placing another copy.
      const lastPlaced = placement.getLastPlaced();
      if (lastPlaced) {
        const pinHit = hitTestPins(worldPt, [lastPlaced], hitThreshold);
        const elemHit = !pinHit && hitTestElements(worldPt, [lastPlaced]);
        if (pinHit || elemHit) {
          placement.cancel();
          invalidateCompiled();
          renderPipeline.scheduleRender();
          if (pinHit) {
            wireDrawing.startFromPin(pinHit.element, pinHit.pin);
          } else {
            selection.clear();
            selection.select(lastPlaced);
          }
          renderPipeline.scheduleRender();
          return;
        }
      }
      invalidateCompiled();
      placement.updateCursor(worldPt);
      const placed = placement.place(circuit);
      undoStack.push(placeComponent(circuit, placed));
      return;
    }

    // During simulation, only allow toggling interactive components (In, Clock, etc.)
    if (isSimActive()) {
      if (facade.getCoordinator().timingModel !== 'discrete') {
        // During analog/mixed simulation, allow element selection (for slider panel)
        const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
        if (elementHit) {
          selection.clear();
          selection.select(elementHit);

          // Interactive toggle during analog simulation — recompile to update state
          if (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT') {
            const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
            if (momentary) {
              elementHit.setAttribute('closed', true);
              const onPointerUp = (): void => {
                elementHit.setAttribute('closed', false);
                compiledDirty = true;
                if (compileAndBind()) {
                  startSimulation();
                }
                renderPipeline.scheduleRender();
              };
              document.addEventListener('pointerup', onPointerUp, { once: true });
            } else {
              const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
              elementHit.setAttribute('closed', !current);
            }
            compiledDirty = true;
            if (compileAndBind()) {
              startSimulation();
            }
          } else if (elementHit.typeId === 'In' || elementHit.typeId === 'Clock') {
            // In/Clock toggle during analog/mixed sim — change defaultValue and recompile
            const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
            const current = (elementHit.getAttribute('defaultValue') as number | undefined) ?? 0;
            const newVal = bitWidth === 1
              ? (current === 0 ? 1 : 0)
              : ((current + 1) & ((1 << bitWidth) - 1));
            elementHit.setAttribute('defaultValue', newVal);
            compiledDirty = true;
            if (compileAndBind()) {
              startSimulation();
            }
          }
        } else {
          selection.clear();
        }
        renderPipeline.scheduleRender();
        return;
      }

      const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
      if (elementHit && (elementHit.typeId === 'In' || elementHit.typeId === 'Clock')) {
        const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
        const current = binding.getPinValue(elementHit, 'out');
        const newVal = bitWidth === 1
          ? (current === 0 ? 1 : 0)
          : ((current + 1) & ((1 << bitWidth) - 1));
        binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
        const eng = facade.getCoordinator();
        if (eng.getState() !== EngineState.RUNNING) {
          facade.step(eng, { clockAdvance: elementHit.typeId !== 'Clock' });
        }
        renderPipeline.scheduleRender();
      }

      // Switch toggle: Switch (SPST) and SwitchDT (SPDT) clicked during simulation
      if (elementHit && (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT')) {
        const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
        if (momentary) {
          // Momentary: set closed=true on pointerdown, release on pointerup
          elementHit.setAttribute('closed', true);
          const onPointerUp = (): void => {
            elementHit.setAttribute('closed', false);
            const eng = facade.getCoordinator();
            if (eng.getState() !== EngineState.RUNNING) {
              facade.step(eng, { clockAdvance: true });
            }
            renderPipeline.scheduleRender();
          };
          document.addEventListener('pointerup', onPointerUp, { once: true });
        } else {
          // Latching: toggle closed property
          const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
          elementHit.setAttribute('closed', !current);
        }
        const eng = facade.getCoordinator();
        if (eng.getState() !== EngineState.RUNNING) {
          facade.step(eng, { clockAdvance: true });
        }
        renderPipeline.scheduleRender();
      }
      return;
    }

    if (wireDrawing.isActive()) {
      const pinHit = hitTestPins(worldPt, circuit.elements, hitThreshold);
      if (pinHit) {
        try {
          const wires = wireDrawing.completeToPin(pinHit.element, pinHit.pin, circuit, analogTypeIds);
          removeDeadEndStubs(wires, circuit);
          invalidateCompiled();
        } catch (err) {
          showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
          wireDrawing.cancel();
        }
      } else {
        // Check if cursor lands on an existing wire — split interior or connect at endpoint
        const snappedPt = snapToGrid(worldPt, 1);
        const tappedPoint = splitWiresAtPoint(snappedPt, circuit);
        if (tappedPoint !== undefined) {
          try {
            const wires = wireDrawing.completeToPoint(tappedPoint, circuit, analogTypeIds);
            removeDeadEndStubs(wires, circuit);
            invalidateCompiled();
          } catch (err) {
            showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
            wireDrawing.cancel();
          }
        } else if (isWireEndpoint(snappedPt, circuit)) {
          try {
            const wires = wireDrawing.completeToPoint(snappedPt, circuit, analogTypeIds);
            removeDeadEndStubs(wires, circuit);
            invalidateCompiled();
          } catch (err) {
            showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
            wireDrawing.cancel();
          }
        } else if (wireDrawing.isSameAsLastWaypoint(snappedPt)) {
          // Clicking the same spot twice ends the wire at that point
          try {
            wireDrawing.completeToPoint(snappedPt, circuit, analogTypeIds);
            invalidateCompiled();
          } catch (err) {
            showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
            wireDrawing.cancel();
          }
        } else {
          wireDrawing.addWaypoint();
        }
      }
      renderPipeline.scheduleRender();
      return;
    }

    const pinHit = hitTestPins(worldPt, circuit.elements, hitThreshold);
    if (pinHit) {
      wireDrawing.startFromPin(pinHit.element, pinHit.pin);
      renderPipeline.scheduleRender();
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
      renderPipeline.scheduleRender();
      return;
    }

    const wireHit = hitTestWires(worldPt, circuit.wires, hitThreshold);
    if (wireHit) {
      if (e.shiftKey) {
        selection.toggleSelect(wireHit);
        renderPipeline.scheduleRender();
        return;
      }
      // If the clicked point is a wire endpoint (junction), start wire-drawing
      // from that point instead of dragging the wire segment.
      const snappedPt = snapToGrid(worldPt, 1);
      if (isWireEndpoint(snappedPt, circuit)) {
        wireDrawing.startFromPoint(snappedPt);
        renderPipeline.scheduleRender();
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
      renderPipeline.scheduleRender();
      return;
    }

    if (!e.shiftKey) {
      selection.clear();
    }
    dragMode = 'box-select';
    renderPipeline.state.boxSelect.active = true;
    renderPipeline.state.boxSelect.startScreen = screenPt;
    renderPipeline.state.boxSelect.currentScreen = screenPt;
    renderPipeline.scheduleRender();
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
      if (touchGestures.onPointerMove(e, canvas, viewport, () => renderPipeline.scheduleRender())) return;
    } else {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
    }
    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
    lastWorldPt = worldPt;

    // Update cursor grid coordinates in status bar
    const gx = Math.round(worldPt.x * 100) / 100;
    const gy = Math.round(worldPt.y * 100) / 100;
    statusCoords.textContent = `${gx}, ${gy}`;

    if (placement.isActive()) {
      placement.updateCursor(worldPt);
      renderPipeline.scheduleRender();
      return;
    }

    if (wireDrawing.isActive()) {
      wireDrawing.updateCursor(worldPt);
      renderPipeline.scheduleRender();
      return;
    }

    if (dragMode === 'pan') {
      const dx = screenPt.x - dragStartScreen.x;
      const dy = screenPt.y - dragStartScreen.y;
      viewport.panBy({ x: dx, y: dy });
      dragStartScreen = screenPt;
      renderPipeline.scheduleRender();
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
      renderPipeline.state.boxSelect.currentScreen = screenPt;
      renderPipeline.scheduleRender();
      return;
    }
  });

  function finishPointerDrag(): void {
    if (dragMode === 'wire-drag') {
      wireDrag.finish(circuit);
      invalidateCompiled();
      renderPipeline.scheduleRender();
    }

    if (dragMode === 'box-select') {
      const topLeft = renderPipeline.canvasToWorld({
        clientX: Math.min(renderPipeline.state.boxSelect.startScreen.x, renderPipeline.state.boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.min(renderPipeline.state.boxSelect.startScreen.y, renderPipeline.state.boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      });
      const bottomRight = renderPipeline.canvasToWorld({
        clientX: Math.max(renderPipeline.state.boxSelect.startScreen.x, renderPipeline.state.boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.max(renderPipeline.state.boxSelect.startScreen.y, renderPipeline.state.boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
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

      renderPipeline.state.boxSelect.active = false;
      renderPipeline.scheduleRender();
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
      renderPipeline.state.boxSelect.active = false;
      renderPipeline.scheduleRender();
      return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    // Reset drag state on cancel
    dragMode = 'none';
    wireDrawing.cancel();
    renderPipeline.state.boxSelect.active = false;
    wireDrag.cancel();
    renderPipeline.scheduleRender();
  });

  // passive: true lets the browser compositor run without waiting for JS.
  // Scroll prevention is handled by CSS (html/body overflow:hidden,
  // canvas touch-action:none, overscroll-behavior:contain).
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    const screenPt = renderPipeline.canvasToScreen(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    viewport.zoomAt(screenPt, factor);
    renderPipeline.scheduleRender();
  }, { passive: true });

  // -------------------------------------------------------------------------
  // Double-click → property popup
  // -------------------------------------------------------------------------

  let activePopup: HTMLElement | null = null;
  let activePopupPanel: PropertyPanel | null = null;

  function closePopup(): void {
    if (activePopup) {
      if (activePopupPanel?.commitAll()) {
        if (facade.getCoordinator().timingModel !== 'discrete' && isSimActive()) {
          compiledDirty = true;
          if (compileAndBind()) {
            startSimulation();
          }
        } else {
          invalidateCompiled();
        }
        renderPipeline.scheduleRender();
      }
      activePopupPanel = null;
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
    ctx.fitViewport();
    selection.clear();
    closePopup();
    updateBreadcrumb();
    renderPipeline.scheduleRender();
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
    renderPipeline.scheduleRender();
  }

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    const worldPt = renderPipeline.canvasToWorld(e);
    const elementHit = hitTestElements(worldPt, circuit.elements);
    if (!elementHit) return;

    // During simulation, don't open properties for togglable components
    if (isSimActive() && TOGGLABLE_TYPES.has(elementHit.typeId)) return;

    // Memory components: open hex editor (only during simulation)
    if (isSimActive() && MEMORY_TYPES.has(elementHit.typeId)) {
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
    const propertyPopup = new PropertyPanel(propsContainer);
    propertyPopup.showProperties(elementHit, def.propertyDefs);
    if (availableModels(def).length > 1) {
      propertyPopup.showSimulationModeDropdown(elementHit, def);
    }
    if (hasDigitalModel(def)) {
      const simModel = elementHit.getProperties().has("simulationModel")
        ? elementHit.getProperties().get("simulationModel") as string
        : (def.defaultModel ?? "logical");
      if (simModel === "logical" || simModel === "analog-pins") {
        const family = circuit.metadata.logicFamily ?? defaultLogicFamily();
        propertyPopup.showPinElectricalOverrides(elementHit, def, family);
      }
    }
    activePopupPanel = propertyPopup;

    const screenPt = renderPipeline.canvasToScreen(e);
    const container = canvas.parentElement!;
    popup.style.left = `${Math.min(screenPt.x + 10, container.clientWidth - 200)}px`;
    popup.style.top = `${Math.min(screenPt.y + 10, container.clientHeight - 200)}px`;

    // --- Drag support via header ---
    {
      let dragOffsetX = 0;
      let dragOffsetY = 0;
      let containerRect: DOMRect | null = null;
      let popupW = 0;
      let popupH = 0;

      const onDragMove = (ev: PointerEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        const cr = containerRect!;
        let newLeft = ev.clientX - cr.left - dragOffsetX;
        let newTop = ev.clientY - cr.top - dragOffsetY;
        // Clamp within container
        newLeft = Math.max(0, Math.min(newLeft, cr.width - popupW));
        newTop = Math.max(0, Math.min(newTop, cr.height - popupH));
        popup.style.left = `${newLeft}px`;
        popup.style.top = `${newTop}px`;
      };

      const onDragEnd = (ev: PointerEvent) => {
        ev.stopPropagation();
        document.removeEventListener('pointermove', onDragMove, true);
        document.removeEventListener('pointerup', onDragEnd, true);
        containerRect = null;
      };

      header.addEventListener('pointerdown', (ev: PointerEvent) => {
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        // Snapshot geometry once at drag start
        containerRect = container.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        popupW = popupRect.width;
        popupH = popupRect.height;
        dragOffsetX = ev.clientX - popupRect.left;
        dragOffsetY = ev.clientY - popupRect.top;
        // Use capture phase to intercept before canvas handler fires
        document.addEventListener('pointermove', onDragMove, true);
        document.addEventListener('pointerup', onDragEnd, true);
        ev.stopPropagation();
        ev.preventDefault();
      });
    }

    container.appendChild(popup);
    activePopup = popup;
  });

  // Close popup when clicking elsewhere on canvas
  canvas.addEventListener('pointerdown', () => {
    closePopup();
  }, true);

  // Speed control, simulation loop, and toolbar sim buttons are now owned by
  // SimulationController (initSimulationController, set up below after ctx).
  // Keyboard shortcuts are registered via initKeyboardHandler (called after ctx is built).

  // -------------------------------------------------------------------------
  // Viewer panels (Timing Diagram + Values Table)
  //
  // Signals are added by right-clicking wires on the canvas.
  // -------------------------------------------------------------------------

  const viewerPanel = document.getElementById('viewer-panel');
  const viewerTimingContainer = document.getElementById('viewer-timing-container');
  const viewerValuesContainer = document.getElementById('viewer-values');
  const viewerTabs = viewerPanel?.querySelectorAll('.viewer-tab');

  let activeDataTable: DataTablePanel | null = null;

  /** Watched signals — persisted across recompilations by name. */
  interface WatchedSignal {
    name: string;
    addr: SignalAddress;
    width: number;
    group: SignalGroup;
    panelIndex: number;
  }
  const watchedSignals: WatchedSignal[] = [];

  // renderPipeline.state.scopePanels lives in renderPipeline.state.renderPipeline.state.scopePanels (set up below)

  /** Tear down any active viewer panels and unregister observers. */
  function disposeViewers(): void {
    const coordinator = facade.getCoordinator();
    for (const entry of renderPipeline.state.scopePanels) {
      entry.panel.dispose();
      entry.canvas.remove();
    }
    renderPipeline.state.scopePanels.length = 0;
    if (activeDataTable) {
      coordinator.removeMeasurementObserver(activeDataTable);
      activeDataTable.dispose();
      activeDataTable = null;
    }
  }

  /** Rebuild viewer panels from the current watchedSignals list. */
  function rebuildViewers(): void {
    disposeViewers();
    const coordinator = facade.getCoordinator();
    if (watchedSignals.length === 0) return;

    if (viewerTimingContainer) {
      // Group signals by panelIndex for multi-panel scope view
      const panelGroups = new Map<number, WatchedSignal[]>();
      for (const s of watchedSignals) {
        const idx = s.panelIndex ?? 0;
        if (!panelGroups.has(idx)) panelGroups.set(idx, []);
        panelGroups.get(idx)!.push(s);
      }

      // Create a canvas + ScopePanel per panel group
      const sortedIndices = [...panelGroups.keys()].sort((a, b) => a - b);
      for (const idx of sortedIndices) {
        const signals = panelGroups.get(idx)!;
        const cvs = document.createElement('canvas');
        viewerTimingContainer.appendChild(cvs);
        // Size after DOM insertion so clientWidth/Height are available
        requestAnimationFrame(() => renderPipeline.sizeCanvasInContainer(cvs));
        const panel = new ScopePanel(cvs, coordinator);
        for (const s of signals) {
          if (s.addr.domain === 'analog') {
            panel.addVoltageChannel(s.addr, s.name);
          } else {
            panel.addDigitalChannel(s.addr, s.name);
          }
        }
        _attachScopeContextMenu(cvs, panel, signals);
        renderPipeline.state.scopePanels.push({ canvas: cvs, panel });
      }
    }

    if (viewerValuesContainer) {
      const signals: SignalDescriptor[] = watchedSignals.map(s => ({
        name: s.name,
        addr: s.addr,
        width: s.width,
        group: s.group,
      }));
      activeDataTable = new DataTablePanel(viewerValuesContainer, coordinator, signals);
      coordinator.addMeasurementObserver(activeDataTable);
    }
  }

  /** Get the next available panel index for creating a new panel. */
  function nextPanelIndex(): number {
    let max = -1;
    for (const s of watchedSignals) if (s.panelIndex > max) max = s.panelIndex;
    return max + 1;
  }

  /** Get the list of distinct panel indices with their signal names (for the context menu). */
  function getPanelList(): Array<{ index: number; label: string }> {
    const panels = new Map<number, string[]>();
    for (const s of watchedSignals) {
      if (!panels.has(s.panelIndex)) panels.set(s.panelIndex, []);
      panels.get(s.panelIndex)!.push(s.name);
    }
    const result: Array<{ index: number; label: string }> = [];
    for (const [idx, names] of [...panels.entries()].sort((a, b) => a[0] - b[0])) {
      result.push({ index: idx, label: `Panel ${idx + 1}: ${names.join(', ')}` });
    }
    return result;
  }

  /** Add a wire's net to the watched signals and rebuild viewers. */
  function addWireToViewer(wire: Wire, panelIndex?: number): void {
    const coordinator = facade.getCoordinator();
    const addr = coordinator.compiled.wireSignalMap.get(wire);
    if (addr === undefined) return;

    if (addr.domain === 'analog') {
      const nodeId = addr.nodeId;
      if (watchedSignals.some(s => s.addr.domain === 'analog' && s.addr.nodeId === nodeId)) return;
      let name = `node${nodeId}`;
      for (const [label, a] of coordinator.compiled.labelSignalMap) {
        if (a.domain === 'analog' && a.nodeId === nodeId) { name = label; break; }
      }
      const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
      watchedSignals.push({ name, addr: { domain: 'analog', nodeId }, width: 1, group: 'probe', panelIndex: idx });
    } else {
      const netId = addr.netId;
      if (watchedSignals.some(s => s.addr.domain === 'digital' && s.addr.netId === netId)) return;
      let name = `net${netId}`;
      let width = addr.bitWidth;
      let group: SignalGroup = 'probe';
      for (const [label, a] of coordinator.compiled.labelSignalMap) {
        if (a.domain === 'digital' && a.netId === netId) { name = label; break; }
      }
      const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
      watchedSignals.push({ name, addr: { domain: 'digital', netId, bitWidth: width }, width, group, panelIndex: idx });
    }

    viewerPanel?.classList.add('open');
    showViewerTab('timing');
    rebuildViewers();
  }

  /** Remove a signal by net ID and rebuild viewers. */
  function removeSignalFromViewer(netId: number): void {
    const idx = watchedSignals.findIndex(s => s.addr.domain === 'digital' && s.addr.netId === netId);
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
    viewerTimingContainer?.classList.toggle('active', tabName === 'timing');
    viewerValuesContainer?.classList.toggle('active', tabName === 'values');
  }

  function openViewer(tabName: string): void {
    if (!ctx.ensureCompiled()) return;
    viewerPanel?.classList.add('open');
    showViewerTab(tabName);
    if (watchedSignals.length > 0 && renderPipeline.state.scopePanels.length === 0 && !activeDataTable) {
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
  // AC Sweep dialog + Bode plot
  // -------------------------------------------------------------------------

  const acSweepDialog = document.getElementById('ac-sweep-dialog');
  const bodePanel = document.getElementById('bode-panel');
  const bodeCanvas = document.getElementById('bode-canvas') as HTMLCanvasElement | null;
  const bodeRenderer = new BodePlotRenderer();

  document.getElementById('btn-ac-sweep')?.addEventListener('click', () => {
    if (!facade.getCoordinator().supportsAcSweep()) {
      showStatus('AC Sweep requires a circuit with analog components', true);
      return;
    }
    if (acSweepDialog) acSweepDialog.style.display = 'flex';
  });

  document.getElementById('ac-sweep-close')?.addEventListener('click', () => {
    if (acSweepDialog) acSweepDialog.style.display = 'none';
  });

  document.getElementById('ac-sweep-run')?.addEventListener('click', () => {
    if (acSweepDialog) acSweepDialog.style.display = 'none';

    const coordinator = facade.getCoordinator();
    if (!coordinator.supportsAcSweep()) {
      showStatus('AC Sweep requires a circuit with analog components', true);
      return;
    }

    // Gather parameters from the dialog
    const sweepType = (document.getElementById('ac-sweep-type') as HTMLSelectElement).value as 'lin' | 'dec' | 'oct';
    const numPoints = parseInt((document.getElementById('ac-sweep-points') as HTMLInputElement).value, 10) || 50;
    const fStart = parseFloat((document.getElementById('ac-sweep-fstart') as HTMLInputElement).value) || 1;
    const fStop = parseFloat((document.getElementById('ac-sweep-fstop') as HTMLInputElement).value) || 1e6;
    const sourceLabel = (document.getElementById('ac-sweep-source') as HTMLInputElement).value.trim();
    const outputNodes = (document.getElementById('ac-sweep-outputs') as HTMLInputElement).value
      .split(',').map(s => s.trim()).filter(s => s.length > 0);

    if (!sourceLabel) {
      showStatus('AC Sweep: please specify an AC source label', true);
      return;
    }
    if (outputNodes.length === 0) {
      showStatus('AC Sweep: please specify at least one output node', true);
      return;
    }

    const acParams: AcParams = { type: sweepType, numPoints, fStart, fStop, sourceLabel, outputNodes };

    try {
      const result = coordinator.acAnalysis(acParams)!;

      if (result.diagnostics.length > 0) {
        const errs = result.diagnostics.filter(d => d.severity === 'error');
        if (errs.length > 0) {
          showStatus(`AC Sweep error: ${errs[0].summary}`, true);
          return;
        }
      }

      // Show Bode plot
      if (bodePanel && bodeCanvas) {
        bodePanel.style.display = 'block';
        renderPipeline.sizeCanvasInContainer(bodeCanvas);
        const ctx = bodeCanvas.getContext('2d');
        if (ctx) {
          // Compute viewport from data ranges
          let magMin = 0, magMax = -200, phaseMin = 0, phaseMax = -360;
          for (const [, arr] of result.magnitude) {
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] < magMin) magMin = arr[i];
              if (arr[i] > magMax) magMax = arr[i];
            }
          }
          for (const [, arr] of result.phase) {
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] < phaseMin) phaseMin = arr[i];
              if (arr[i] > phaseMax) phaseMax = arr[i];
            }
          }
          // Add margins
          const magRange = magMax - magMin || 20;
          magMin -= magRange * 0.1;
          magMax += magRange * 0.1;
          const phaseRange = phaseMax - phaseMin || 90;
          phaseMin -= phaseRange * 0.1;
          phaseMax += phaseRange * 0.1;

          const viewport: BodeViewport = {
            x: 0, y: 0,
            width: bodeCanvas.width, height: bodeCanvas.height,
            fMin: fStart, fMax: fStop,
            magMin, magMax,
            phaseMin, phaseMax,
          };
          ctx.clearRect(0, 0, bodeCanvas.width, bodeCanvas.height);
          bodeRenderer.render(ctx, result, viewport);
        }
      }
      showStatus(`AC Sweep complete: ${result.frequencies.length} points`);
    } catch (err) {
      showStatus(`AC Sweep failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  document.getElementById('bode-close')?.addEventListener('click', () => {
    if (bodePanel) bodePanel.style.display = 'none';
  });

  // -------------------------------------------------------------------------
  // Right-click context menu (unified)
  // -------------------------------------------------------------------------

  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    contextMenu.hide();
    // Remove wire-context-menu from the DOM
    document.getElementById('wire-context-menu')?.remove();

    const worldPt = renderPipeline.canvasToWorld(e);
    const locked = lockedModeGuard.isLocked();
    const items: MenuItem[] = [];

    // --- Hit-test priority: element > wire > canvas ---
    const elementHit = hitTestElements(worldPt, circuit.elements);
    const wireHit = !elementHit ? hitTestWires(worldPt, circuit.wires, HIT_THRESHOLD) : null;

    if (elementHit) {
      // Select this element if not already selected
      if (!selection.isSelected(elementHit)) {
        selection.select(elementHit);
      }

      if (!locked) {
        items.push(
          { label: 'Properties\u2026', action: () => {
            selection.select(elementHit);
          }, enabled: true },
          { label: 'Rotate', shortcut: 'R', action: () => {
            const cmd = rotateSelection([...selection.getSelectedElements()]);
            undoStack.push(cmd);
            invalidateCompiled();
          }, enabled: true },
          { label: 'Mirror', shortcut: 'M', action: () => {
            const cmd = mirrorSelection([...selection.getSelectedElements()]);
            undoStack.push(cmd);
            invalidateCompiled();
          }, enabled: true },
          separator(),
          { label: 'Copy', shortcut: 'Ctrl+C', action: () => {
            clipboard = copyToClipboard(
              [...selection.getSelectedElements()],
              [...selection.getSelectedWires()],
              (typeId: string) => registry.get(typeId),
            );
          }, enabled: true },
          { label: 'Delete', shortcut: 'Del', action: () => {
            const elements = [...selection.getSelectedElements()];
            const wires: Wire[] = [...selection.getSelectedWires()];
            const cmd = deleteSelection(circuit, elements, wires);
            undoStack.push(cmd);
            selection.clear();
          }, enabled: true },
        );

        // "Add Slider" — for components with FLOAT properties during analog sim
        if (simController.activeSliderPanel && simController.isSimActive()) {
          const sliderCoord = facade.getCoordinator();
          if (sliderCoord) {
            const sliderProps = sliderCoord.getSliderProperties(elementHit);
            if (sliderProps.length > 0) {
              items.push(separator());
              for (const sp of sliderProps) {
                items.push({
                  label: `Add Slider: ${sp.label}`,
                  action: () => {
                    simController.activeSliderPanel!.addSlider(sp.elementIndex, sp.key, sp.label, sp.currentValue, { unit: sp.unit, logScale: sp.logScale });
                  },
                  enabled: true,
                });
              }
            }
          }
        }
      }

      // Memory components: "Edit Memory…"
      if (MEMORY_TYPES.has(elementHit.typeId)) {
        if (items.length > 0) items.push(separator());
        items.push({
          label: 'Edit Memory\u2026',
          action: () => void openMemoryEditor(elementHit),
          enabled: true,
        });
      }

      // "Add to Traces" — per-pin voltage and element current
      // Available when the circuit has analog components (compiled or not yet compiled)
      if (facade.getCoordinator()?.supportsAcSweep() ?? circuit.elements.some(el => {
        const def = registry.get(el.typeId);
        return def !== undefined && hasAnalogModel(def) && !hasDigitalModel(def);
      })) {
        const resolverCtx = facade.getCoordinator()?.getCurrentResolverContext() ?? null;
        _appendComponentTraceItems(items, elementHit, resolverCtx);
      }

    } else if (wireHit) {
      if (!locked) {
        items.push(
          { label: 'Delete Wire', shortcut: 'Del', action: () => {
            selection.select(wireHit);
            const cmd = deleteSelection(circuit, [...selection.getSelectedElements()], [...selection.getSelectedWires()]);
            undoStack.push(cmd);
            selection.clear();
          }, enabled: true },
        );
      }

      // Wire viewer items (add/remove from scope)
      if (isSimActive()) {
        const viewCoordinator = facade.getCoordinator();
        if (viewCoordinator) {
          if (items.length > 0) items.push(separator());
          _appendWireViewerItems(items, wireHit, viewCoordinator);
        }
      }

    } else {
      // Canvas (empty area)
      if (!locked) {
        // Insert component submenu — top-level categories
        _appendInsertItems(items);
        items.push(separator());
        items.push(
          { label: 'Paste', shortcut: 'Ctrl+V', action: () => {
            if (clipboard.entries.length > 0 || clipboard.wires.length > 0) {
              placement.startPaste(clipboard);
            }
          }, enabled: clipboard.entries.length > 0 || clipboard.wires.length > 0 },
          { label: 'Select All', shortcut: 'Ctrl+A', action: () => {
            selection.selectAll(circuit);
          }, enabled: true },
        );
      }

      // Simulation controls
      items.push(separator());
      if (!isSimActive()) {
        items.push({
          label: 'Start Simulation',
          action: () => document.getElementById('btn-run')?.click(),
          enabled: true,
        });
      } else {
        items.push({
          label: 'Stop Simulation',
          action: () => document.getElementById('btn-stop')?.click(),
          enabled: true,
        });
      }

      // Speed control
      items.push(
        { label: 'Speed \u00d710', action: () => {
          facade.getCoordinator()?.adjustSpeed(10);
          updateSpeedDisplay();
        }, enabled: true },
        { label: 'Speed \u00f710', action: () => {
          facade.getCoordinator()?.adjustSpeed(0.1);
          updateSpeedDisplay();
        }, enabled: true },
      );
    }

    if (items.length > 0) {
      contextMenu.showItems(e.clientX, e.clientY, items);
    }
  });

  // Helper: append wire-viewer items for a wire
  function _appendWireViewerItems(
    items: MenuItem[],
    wire: import('../core/circuit.js').Wire,
    coordinator: import('../solver/coordinator-types.js').SimulationCoordinator,
  ): void {
    const addr = coordinator.compiled.wireSignalMap.get(wire);
    if (addr === undefined) return;

    const netId = addr.domain === 'analog' ? addr.nodeId : addr.netId;
    let signalName: string;
    if (addr.domain === 'analog') {
      signalName = `node${netId}`;
      for (const [label, a] of coordinator.compiled.labelSignalMap) {
        if (a.domain === 'analog' && a.nodeId === netId) { signalName = label; break; }
      }
    } else {
      signalName = `net${netId}`;
      for (const [label, a] of coordinator.compiled.labelSignalMap) {
        if (a.domain === 'digital' && a.netId === netId) { signalName = label; break; }
      }
    }

    const isWatched = watchedSignals.some(s => s.addr.domain === 'digital' && s.addr.netId === netId);
    const capturedNetId = netId;

    if (!isWatched) {
      const existingPanels = getPanelList();
      for (const p of existingPanels) {
        items.push({
          label: `Add "${signalName}" to ${p.label}`,
          action: () => addWireToViewer(wire, p.index),
          enabled: true,
        });
      }
      items.push({
        label: existingPanels.length > 0 ? `Add "${signalName}" to New Panel` : `Add "${signalName}" to Viewer`,
        action: () => addWireToViewer(wire, nextPanelIndex()),
        enabled: true,
      });
    } else {
      items.push({
        label: `Remove "${signalName}" from Viewer`,
        action: () => removeSignalFromViewer(capturedNetId),
        enabled: true,
      });
    }
  }


  // Helper: get a human-readable label for an element
  function _elementLabel(element: import('../core/element.js').CircuitElement): string {
    const props = element.getProperties();
    const lbl = props.has('label') ? String(props.get('label')) : '';
    return lbl || element.typeId;
  }

  // Helper: append "Add to Traces" items for a component (per-pin voltage + element current)
  function _appendComponentTraceItems(
    items: MenuItem[],
    element: import('../core/element.js').CircuitElement,
    resolverCtx: import('../solver/coordinator-types.js').CurrentResolverContext | null,
  ): void {
    const label = _elementLabel(element);
    const pins = element.getPins();

    if (resolverCtx) {
      let elementIndex = -1;
      for (const [idx, ce] of resolverCtx.elementToCircuitElement) {
        if (ce === element) { elementIndex = idx; break; }
      }
      if (elementIndex < 0) return;

      const analogEl = resolverCtx.elements[elementIndex];
      if (!analogEl) return;

      if (items.length > 0) items.push(separator());

      // Per-pin voltage traces — resolve node IDs by pin world position,
      // not by indexing pinNodeIds (which may differ in order from pins,
      // e.g. FET pinNodeIds = [D,G,S] but pins = [G,S,D]).
      for (const pin of pins) {
        const pinLabel = pin.label;
        const wp = pinWorldPosition(element, pin);
        let nodeId: number | undefined;
        for (const [wire, nid] of resolverCtx.wireToNodeId) {
          if (
            (Math.abs(wire.start.x - wp.x) < 0.5 && Math.abs(wire.start.y - wp.y) < 0.5) ||
            (Math.abs(wire.end.x - wp.x) < 0.5 && Math.abs(wire.end.y - wp.y) < 0.5)
          ) {
            nodeId = nid;
            break;
          }
        }
        if (nodeId === undefined) continue;
        items.push({
          label: `Trace Voltage: ${label}.${pinLabel}`,
          action: () => {
            const panelIdx = nextPanelIndex();
            if (renderPipeline.state.scopePanels.length > 0) {
              renderPipeline.state.scopePanels[0].panel.addVoltageChannel(
                { domain: 'analog' as const, nodeId: nodeId! },
                `${label}.${pinLabel}`,
              );
              renderPipeline.state.scopePanels[0].panel.render();
            } else {
              watchedSignals.push({ name: `${label}.${pinLabel}`, addr: { domain: 'analog', nodeId: nodeId! }, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
            }
            viewerPanel?.classList.add('open');
            showViewerTab('timing');
          },
          enabled: true,
        });
      }

      // Element current trace
      items.push({
        label: `Trace Current: ${label}`,
        action: () => {
          if (renderPipeline.state.scopePanels.length > 0) {
            renderPipeline.state.scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
            renderPipeline.state.scopePanels[0].panel.render();
          } else {
            const panelIdx = nextPanelIndex();
            const pinNodeIds = (analogEl as unknown as { pinNodeIds: number[] }).pinNodeIds ?? [];
            if (pinNodeIds.length > 0) {
              watchedSignals.push({ name: `${label}.${pins[0]?.label ?? 'pin0'}`, addr: { domain: 'analog', nodeId: pinNodeIds[0]! }, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
              if (renderPipeline.state.scopePanels.length > 0) {
                renderPipeline.state.scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
              }
            }
          }
          viewerPanel?.classList.add('open');
          showViewerTab('timing');
        },
        enabled: true,
      });
    } else {
      if (pins.length === 0) return;
      if (items.length > 0) items.push(separator());

      items.push({
        label: `Trace Voltages: ${label} (starts on Run)`,
        action: () => {
          showStatus(`Probe queued — start simulation to view traces`, false);
        },
        enabled: true,
      });
    }
  }

  // Helper: append quick-insert items for canvas context menu
  function _appendInsertItems(items: MenuItem[]): void {
    // Show the most common component types as direct items
    const QUICK_INSERT: Array<{ label: string; type: string }> = [
      { label: 'Insert Input', type: 'In' },
      { label: 'Insert Output', type: 'Out' },
      { label: 'Insert AND Gate', type: 'And' },
      { label: 'Insert OR Gate', type: 'Or' },
      { label: 'Insert NOT Gate', type: 'Not' },
      { label: 'Insert NAND Gate', type: 'NAnd' },
      { label: 'Insert Clock', type: 'Clock' },
    ];

    // When circuit has analog-only components, swap the quick insert list
    const hasAnalogOnlyComponents = circuit.elements.some(el => {
      const def = registry.get(el.typeId);
      return def !== undefined && hasAnalogModel(def) && !hasDigitalModel(def);
    });
    if (hasAnalogOnlyComponents) {
      QUICK_INSERT.length = 0;
      QUICK_INSERT.push(
        { label: 'Insert Resistor', type: 'Resistor' },
        { label: 'Insert Capacitor', type: 'Capacitor' },
        { label: 'Insert Inductor', type: 'Inductor' },
        { label: 'Insert DC Voltage Source', type: 'VoltageSource' },
        { label: 'Insert Ground', type: 'Ground' },
        { label: 'Insert Diode', type: 'Diode' },
      );
    }

    for (const qi of QUICK_INSERT) {
      const def = registry.get(qi.type);
      if (!def) continue;
      items.push({
        label: qi.label,
        action: () => placement.start(def),
        enabled: true,
      });
    }
  }

  // Helper: attach right-click context menu to a scope panel canvas
  function _attachScopeContextMenu(
    cvs: HTMLCanvasElement,
    panel: ScopePanel,
    signals: WatchedSignal[],
  ): void {
    cvs.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      contextMenu.hide();

      const items: MenuItem[] = [];
      const channels = panel.getChannelDescriptors();
      const fftOn = panel.isFftEnabled();

      // Toggle FFT / time-domain view
      items.push({
        label: fftOn ? 'Switch to Time Domain' : 'Switch to Spectrum (FFT)',
        action: () => {
          panel.setFftEnabled(!fftOn);
          if (!fftOn && channels.length > 0) {
            panel.setFftChannel(channels[0].label);
          }
          panel.render();
        },
        enabled: true,
      });

      // Stat overlays — toggle for all channels at once
      items.push(separator());
      const overlayOpts: Array<{ kind: import('../runtime/analog-scope-panel.js').OverlayKind; label: string }> = [
        { kind: 'mean', label: 'Mean' },
        { kind: 'max', label: 'Max' },
        { kind: 'min', label: 'Min' },
        { kind: 'rms', label: 'RMS' },
      ];
      for (const ov of overlayOpts) {
        // Check if any channel has this overlay active
        const anyActive = channels.some(ch => ch.overlays.has(ov.kind));
        items.push({
          label: `${anyActive ? '\u2713 ' : ''}Overlay ${ov.label}`,
          action: () => {
            for (const ch of channels) { panel.toggleOverlay(ch.label, ov.kind); }
            panel.render();
          },
          enabled: channels.length > 0,
        });
      }

      // Per-channel Y range
      if (channels.length > 0) {
        items.push(separator());
        for (const ch of channels) {
          items.push({
            label: ch.autoRange ? `${ch.label}: Fix Y Range` : `${ch.label}: Auto Y Range`,
            action: () => {
              if (ch.autoRange) panel.setYRange(ch.label, ch.yMin, ch.yMax);
              else panel.setAutoYRange(ch.label);
              panel.render();
            },
            enabled: true,
          });
        }
      }

      // Add current for elements connected to viewed signals
      const resolverCtx = facade.getCoordinator()?.getCurrentResolverContext() ?? null;
      if (resolverCtx) {
        const currentItems: MenuItem[] = [];
        const seen = new Set<number>();
        for (const sig of signals) {
          for (let idx = 0; idx < resolverCtx.elements.length; idx++) {
            if (seen.has(idx)) continue;
            const analogEl = resolverCtx.elements[idx];
            if (sig.addr.domain !== 'analog' || !analogEl.pinNodeIds.includes(sig.addr.nodeId)) continue;
            seen.add(idx);
            const ce = resolverCtx.elementToCircuitElement.get(idx);
            const elLabel = ce ? _elementLabel(ce) : `element${idx}`;
            const alreadyHas = channels.some(c => (c.kind === 'current' || c.kind === 'elementCurrent') && c.label === `${elLabel} I`);
            if (!alreadyHas) {
              currentItems.push({
                label: `Add Current: ${elLabel}`,
                action: () => { panel.addElementCurrentChannel(idx, `${elLabel} I`); panel.render(); },
                enabled: true,
              });
            }
          }
        }
        if (currentItems.length > 0) {
          items.push(separator());
          items.push(...currentItems);
        }
      }

      // Remove channels
      if (channels.length > 0) {
        items.push(separator());
        for (const ch of channels) {
          items.push({
            label: `Remove "${ch.label}"`,
            action: () => {
              panel.removeChannel(ch.label);
              // Also remove from watchedSignals if it's a voltage channel
              const sig = signals.find(s => s.name === ch.label);
              if (sig) {
                const sigIdx = watchedSignals.indexOf(sig);
                if (sigIdx >= 0) watchedSignals.splice(sigIdx, 1);
                if (watchedSignals.length === 0) closeViewer(); else rebuildViewers();
              }
            },
            enabled: true,
          });
        }
      }

      if (items.length > 0) {
        contextMenu.showItems(e.clientX, e.clientY, items);
      }
    });
  }

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

    const { overlay, dialog, body } = createModal({
      title,
      className: 'memory-dialog',
      overlayClassName: 'memory-dialog-overlay',
      onClose: () => { activeMemoryOverlay = null; },
    });

    const { MemoryEditorDialog } = await import('../runtime/memory-editor.js');
    const editor = new MemoryEditorDialog(dataField, body);
    editor.render();

    const memEng = facade.getCoordinator();
    if (memEng?.getState() === EngineState.RUNNING) {
      editor.enableLiveUpdate(memEng);
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

    dialog.appendChild(footer);

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
    renderPipeline.scheduleRender();
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
    renderPipeline.scheduleRender();
  }

  function _navigateToResult(idx: number): void {
    if (!circuitSearchInstance || searchResults.length === 0) return;
    searchCursor = ((idx % searchResults.length) + searchResults.length) % searchResults.length;
    const result = searchResults[searchCursor];
    if (result) {
      circuitSearchInstance.navigateTo(result, viewport);
      selection.clear();
      selection.select(result.element);
      renderPipeline.scheduleRender();
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

  document.getElementById('btn-import-ctz')?.addEventListener('click', () => {
    if (fileInput) {
      fileInput.accept = '.ctz';
      fileInput.click();
      fileInput.addEventListener('change', () => {
        fileInput.accept = '.dig,.dts,.json,.digj,.ctz';
      }, { once: true });
    }
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
    paletteUI.render();
    rebuildInsertMenu();
    selection.clear();
    viewport.fitToContent(circuit.elements, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    invalidateCompiled();
    updateCircuitName();
  }

  // ---------------------------------------------------------------------------
  // SimulationController forward declaration — initialized after renderPipeline.
  // ctx methods delegate to it via these closures.
  // Local shim functions allow the rest of the file to call invalidateCompiled()
  // etc. directly — they forward to simController at call time.
  // ---------------------------------------------------------------------------

  let simController: SimulationController = null!;

  function invalidateCompiled(): void { simController.invalidateCompiled(); }
  function compileAndBind(): boolean { return simController.compileAndBind(); }
  function isSimActive(): boolean { return simController.isSimActive(); }
  function startSimulation(): void { simController.startSimulation(); }
  function stopSimulation(): void { simController.stopSimulation(); }
  function updateSpeedDisplay(): void { simController.updateSpeedDisplay(); }

  // ---------------------------------------------------------------------------
  // AppContext — shared state object passed to extracted sub-modules
  // ---------------------------------------------------------------------------

  const ctx: AppContext = {
    // Core state
    get circuit() { return circuit; },
    set circuit(c) { circuit = c; },
    registry,
    facade,
    binding,
    analogTypeIds,

    // Editor subsystems
    canvas,
    viewport,
    selection,
    placement,
    wireDrawing,
    wireDrag,
    undoStack,
    lockedModeGuard,
    colorSchemeManager,
    contextMenu,
    palette,
    paletteUI,

    // Renderers
    canvasRenderer,
    elementRenderer,
    wireRenderer,
    gridRenderer,

    // Mutable flags
    get compiledDirty() { return compiledDirty; },
    set compiledDirty(v) { compiledDirty = v; },
    clipboard: { elements: [], wires: [] } as import('../editor/edit-operations.js').ClipboardData,
    lastWorldPt: { x: 0, y: 0 },

    // URL params & environment
    params,
    isIframe,
    httpResolver,

    // Helper methods
    scheduleRender(): void { renderPipeline.scheduleRender(); },
    // invalidateCompiled, compileAndBind, isSimActive delegate via local shims
    invalidateCompiled,
    compileAndBind,
    ensureCompiled(): boolean {
      if (compiledDirty && !compileAndBind()) return false;
      return true;
    },
    showStatus,
    clearStatus,
    isSimActive,
    fitViewport(): void {
      viewport.fitToContent(circuit.elements, { width: canvas.clientWidth, height: canvas.clientHeight });
    },
    applyLoadedCircuit,
    setCircuit(c: Circuit): void { circuit = c; },
    getCircuit(): Circuit { return circuit; },
  };

  // Initialize render pipeline — must happen after ctx is built so the
  // pipeline can reference ctx.facade, ctx.viewport, etc.
  renderPipeline = initRenderPipeline(ctx, search);

  // Initialize simulation controller — must happen after renderPipeline is built.
  simController = initSimulationController(ctx, renderPipeline, {
    disposeViewers(): void { disposeViewers(); },
    rebuildViewersIfOpen(): void {
      if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
        for (const sig of watchedSignals) {
          const unified = facade.getCoordinator().compiled;
          const addr = unified.labelSignalMap.get(sig.name);
          if (addr !== undefined) {
            sig.addr = addr;
            sig.width = addr.domain === 'digital' ? addr.bitWidth : 1;
          }
        }
        rebuildViewers();
      }
    },
  });

  // Register all keyboard shortcuts (merges the three former keydown listeners).
  initKeyboardHandler(ctx, {
    startSimulation(): void { simController.startSimulation(); },
    stopSimulation(): void { simController.stopSimulation(); },
    invalidateCompiled,
    closePopup,
    openSearchBar,
    togglePresentation,
    exitPresentation,
    isPresentationMode(): boolean { return presentationMode; },
    navigateBack(): boolean { navigateBack(); return circuitStack.length >= 0; },
    updateZoomDisplay,
    clearDragMode(): void { dragMode = 'none'; },
    fileInput,
  });

  // Wire up settings dialog (uses simController.loadEngineSettings etc.)
  {
    const settingsOverlay = document.getElementById('settings-overlay');
    const snapshotBudgetInput = document.getElementById('setting-snapshot-budget') as HTMLInputElement | null;
    const oscillationLimitInput = document.getElementById('setting-oscillation-limit') as HTMLInputElement | null;
    const currentSpeedInput = document.getElementById('setting-current-speed') as HTMLInputElement | null;
    const currentScaleSelect = document.getElementById('setting-current-scale') as HTMLSelectElement | null;
    const logicFamilySelect = document.getElementById('setting-logic-family') as HTMLSelectElement | null;
    const logicFamilyDetails = document.getElementById('logic-family-details') as HTMLElement | null;

    function updateLogicFamilyDetails(key: string): void {
      if (!logicFamilyDetails) return;
      const preset = getLogicFamilyPreset(key);
      if (!preset) { logicFamilyDetails.textContent = ''; return; }
      logicFamilyDetails.innerHTML =
        `<span>V<sub>OH</sub>: ${preset.vOH}V</span><span>V<sub>OL</sub>: ${preset.vOL}V</span>` +
        `<span>V<sub>IH</sub>: ${preset.vIH}V</span><span>V<sub>IL</sub>: ${preset.vIL}V</span>` +
        `<span>R<sub>out</sub>: ${preset.rOut}Ω</span><span>R<sub>in</sub>: ${(preset.rIn / 1e6).toFixed(0)}MΩ</span>`;
    }

    logicFamilySelect?.addEventListener('change', () => {
      updateLogicFamilyDetails(logicFamilySelect.value);
    });

    function openSettingsDialog(): void {
      const s = simController.loadEngineSettings();
      if (snapshotBudgetInput) snapshotBudgetInput.value = String(s.snapshotBudgetMb);
      if (oscillationLimitInput) oscillationLimitInput.value = String(s.oscillationLimit);
      if (currentSpeedInput) currentSpeedInput.value = String(s.currentSpeedScale);
      if (currentScaleSelect) currentScaleSelect.value = s.currentScaleMode;
      if (logicFamilySelect) {
        const family = circuit.metadata.logicFamily ?? defaultLogicFamily();
        const matchKey = Object.entries(LOGIC_FAMILY_PRESETS).find(
          ([, v]) => v.name === family.name,
        )?.[0] ?? 'cmos-3v3';
        logicFamilySelect.value = matchKey;
        updateLogicFamilyDetails(matchKey);
      }
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
      const speedScale = Math.max(0.1, Math.min(100000, parseFloat(currentSpeedInput?.value ?? '200') || 200));
      const scaleMode = (currentScaleSelect?.value === 'logarithmic' ? 'logarithmic' : 'linear') as 'linear' | 'logarithmic';
      const newSettings = { snapshotBudgetMb: budgetMb, oscillationLimit: oscLimit, currentSpeedScale: speedScale, currentScaleMode: scaleMode };
      simController.saveEngineSettings(newSettings);
      (facade.getCoordinator() as unknown as { setSnapshotBudget?(n: number): void } | null)?.setSnapshotBudget?.(budgetMb * 1024 * 1024);
      simController.applyCurrentVizSettings(newSettings);
      if (logicFamilySelect) {
        const preset = getLogicFamilyPreset(logicFamilySelect.value);
        if (preset) {
          const prev = circuit.metadata.logicFamily;
          const changed = !prev || prev.name !== preset.name;
          circuit.metadata.logicFamily = preset;
          if (changed) simController.invalidateCompiled();
        }
      }
      closeSettingsDialog();
      showStatus(`Settings saved.`);
    });

    settingsOverlay?.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettingsDialog();
    });
  }

  fileInput?.addEventListener('change', () => {
    const file = fileInput?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result as string;
        let loaded: Circuit;
        if (file.name.endsWith('.ctz')) {
          // CircuitJS CTZ format — decompressed text parsed directly
          loaded = parseCtzCircuitFromText(text, registry);
        } else {
          const firstChar = text.replace(/^\s+/, '').charAt(0);
          if (firstChar === '{' || firstChar === '[') {
            const parsed = JSON.parse(text);
            if (parsed.format === 'dts' || parsed.format === 'digb') {
              const result = deserializeDts(text, registry);
              loaded = result.circuit;
            } else {
              loaded = deserializeCircuit(text, registry);
            }
          } else {
            // Use async subcircuit-aware loader to handle embedded subcircuit references
            loaded = await loadWithSubcircuits(text, httpResolver, registry);
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

    const { overlay, dialog, body: list } = createModal({
      title: `Open circuit — ${folderName}`,
      className: 'circuit-picker',
      overlayClassName: 'circuit-picker-overlay',
    });
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
    const gifEng = facade.getCoordinator();
    if (!gifEng || gifEng.getState() === EngineState.STOPPED) return;
    exportGif(circuit, gifEng).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}.gif`);
    }).catch((err: unknown) => {
      showStatus(`GIF export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  function updateGifMenuState(): void {
    if (gifMenuItem) {
      const gifEng = facade.getCoordinator();
      const stopped = !gifEng || gifEng.getState() === EngineState.STOPPED;
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
    renderPipeline.scheduleRender();
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
        ctx.fitViewport();
      } else if (val !== undefined) {
        viewport.setZoom(parseFloat(val));
      }
      updateZoomDisplay();
      renderPipeline.scheduleRender();
      zoomDropdown?.classList.remove('open');
    });
  });

  document.getElementById('btn-fit-content')?.addEventListener('click', () => {
    ctx.fitViewport();
    updateZoomDisplay();
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-tb-fit')?.addEventListener('click', () => {
    ctx.fitViewport();
    updateZoomDisplay();
    renderPipeline.scheduleRender();
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
    renderPipeline.scheduleRender();
  });

  // Color scheme dialog
  document.getElementById('btn-color-scheme')?.addEventListener('click', () => {
    openColorSchemeDialog();
  });

  function openColorSchemeDialog(): void {
    const customColors: Partial<Record<string, string>> = {};

    const { overlay, dialog, body } = createModal({
      title: 'Color Scheme',
      className: 'scheme-dialog',
      overlayClassName: 'scheme-dialog-overlay',
    });

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
      renderPipeline.scheduleRender();
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
      renderPipeline.scheduleRender();
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
      renderPipeline.scheduleRender();
    });

    footer.appendChild(resetBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);

    document.body.appendChild(overlay);
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
    renderPipeline.scheduleRender();
  }

  function exitPresentation(): void {
    presentationMode = false;
    appEl?.classList.remove('presentation-mode');
    renderPipeline.scheduleRender();
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

  // F4 and presentation-mode Escape are handled in initKeyboardHandler.

  // -------------------------------------------------------------------------
  // Tablet mode toggle (View menu)
  // -------------------------------------------------------------------------

  let tabletMode = false;
  const tabletModeCheck = document.getElementById('tablet-mode-check');

  function updateTabletModeUI(): void {
    if (tabletModeCheck) tabletModeCheck.textContent = tabletMode ? '\u2713' : '';
    appEl?.classList.toggle('tablet-mode', tabletMode);
    renderPipeline.resizeCanvas();
  }

  document.getElementById('btn-tablet-mode')?.addEventListener('click', () => {
    tabletMode = !tabletMode;
    updateTabletModeUI();
  });

  // -------------------------------------------------------------------------
  // Settings dialog (Task 8.4-8.5)
  // loadEngineSettings/saveEngineSettings/applyCurrentVizSettings are now
  // owned by SimulationController. The dialog UI wires up below after simController
  // is available (see the initSimulationController call near the bottom).
  // -------------------------------------------------------------------------

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
    renderPipeline.scheduleRender();
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

  document.getElementById('btn-auto-power')?.addEventListener('click', () => {
    if (params.locked) return;
    const cmd = autoConnectPower(circuit);
    cmd.execute();
    undoStack.push(cmd);
    invalidateCompiled();
    renderPipeline.scheduleRender();
    showStatus(`Auto-power: added supplies`);
  });

  // -------------------------------------------------------------------------
  // Analysis menu: Analyse Circuit
  // -------------------------------------------------------------------------

  function openAnalysisDialog(): void {
    const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
    const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));
    const hasFlipFlop = circuit.elements.some(el => flipFlopNames.has(el.typeId));

    const { overlay, dialog } = createModal({
      title: 'Circuit Analysis',
      className: 'analysis-dialog',
      overlayClassName: 'analysis-overlay',
    });

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
        const result = analyseCircuit(facade, circuit);
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

    const { overlay, dialog, body } = createModal({
      title: 'Critical Path Analysis',
      className: 'cp-dialog',
      overlayClassName: 'cp-dialog-overlay',
    });

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

    const { overlay, dialog, body } = createModal({
      title: 'State Transition Table',
      className: 'st-dialog',
      overlayClassName: 'st-dialog-overlay',
    });

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

        const seqEng = facade.getCoordinator();
        const seqFacade: SequentialAnalysisFacade = {
          setStateValue(name: string, value: bigint): void {
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && seqEng) {
              (seqEng as any).setFlipFlopState?.(el.instanceId, value);
            }
          },
          setInput(name: string, value: bigint): void {
            const el = engineEl(name, 'In');
            if (el && seqEng) {
              (seqEng as any).setInputValue?.(el.instanceId, value);
            }
          },
          clockStep(): void {
            if (seqEng) {
              (seqEng as any).clockStep?.();
            }
          },
          getStateValue(name: string): bigint {
            const el = circuit.elements.find(e => {
              if (!flipFlopNames.has(e.typeId)) return false;
              const p = e.getProperties();
              const lbl = p.has('label') ? String(p.get('label')) : `${e.typeId}_${e.instanceId}`;
              return lbl === name;
            });
            if (el && seqEng) {
              return (seqEng as any).getFlipFlopState?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
          getOutput(name: string): bigint {
            const el = engineEl(name, 'Out');
            if (el && seqEng) {
              return (seqEng as any).getOutputValue?.(el.instanceId) ?? 0n;
            }
            return 0n;
          },
        };

        tableResult = analyseSequential(seqFacade, stateVarSpecs, inputSpecs, outputSpecs);
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'analysis-error';
        errDiv.textContent = 'Analysis failed: ' + (err instanceof Error ? err.message : String(err));
        body.appendChild(errDiv);
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

    const { overlay, dialog } = createModal({
      title: 'Test Vectors',
      className: 'test-dialog',
      overlayClassName: 'test-dialog-overlay',
    });

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

    document.body.appendChild(overlay);
    textarea.focus();
  });

  // Ctrl+S and Ctrl+O are handled in initKeyboardHandler.

  // -------------------------------------------------------------------------
  // postMessage adapter
  // -------------------------------------------------------------------------

  async function loadCircuitFromXml(xml: string): Promise<void> {
    let loaded: Circuit;
    loaded = await loadWithSubcircuits(xml, httpResolver, registry);
    applyLoadedCircuit(loaded);
    facade.compile(circuit);
  }

  function renderMarkdownToHtml(markdown: string): string {
    const escaped = markdown
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  }

  const postMessageAdapter = new PostMessageAdapter({
    registry,
    resolver: httpResolver,
    target: window.parent,
    eventSource: window,
    hooks: {
      loadCircuitXml: loadCircuitFromXml,
      getCircuit: () => circuit,
      serializeCircuit: () => serializeCircuitToDig(circuit, registry),
      getFacade: () => facade,
      step: () => {
        const engine = facade.getActiveCoordinator();
        if (!engine) throw new Error('No circuit loaded');
        facade.step(engine);
        renderPipeline.scheduleRender();
      },
      setInput: (label: string, value: number) => {
        const engine = facade.getActiveCoordinator();
        if (!engine) throw new Error('No circuit loaded');
        facade.setInput(engine, label, value);
        renderPipeline.scheduleRender();
      },
      readOutput: (label: string) => {
        const engine = facade.getActiveCoordinator();
        if (!engine) throw new Error('No circuit loaded');
        return facade.readOutput(engine, label);
      },
      readAllSignals: () => {
        const engine = facade.getActiveCoordinator();
        if (!engine) throw new Error('No circuit loaded');
        return facade.readAllSignals(engine);
      },
      setBasePath: (basePath: string) => { params.base = basePath; },
      setLocked: (locked: boolean) => { params.locked = locked; },
      setPalette: (components: string[] | null) => {
        palette.setAllowlist(components);
        paletteUI.render();
      },
      highlight: (labels: string[], durationMs: number) => {
        const labelSet = new Set(labels);
        const toSelect = circuit.elements.filter(
          (el) => labelSet.has(String(el.getProperties().get('label') ?? '')),
        );
        selection.boxSelect(toSelect, []);
        renderPipeline.scheduleRender();
        if (durationMs > 0) {
          setTimeout(() => {
            selection.clear();
            renderPipeline.scheduleRender();
          }, durationMs);
        }
      },
      clearHighlight: () => {
        selection.clear();
        renderPipeline.scheduleRender();
      },
      setReadonlyComponents: (labels: string[] | null) => {
        if (labels === null) {
          for (const el of circuit.elements) {
            (el as unknown as Record<string, unknown>)['_readonly'] = false;
          }
        } else {
          const readonlySet = new Set(labels);
          for (const el of circuit.elements) {
            const label = String(el.getProperties().get('label') ?? '');
            (el as unknown as Record<string, unknown>)['_readonly'] = readonlySet.has(label);
          }
        }
      },
      setInstructions: (markdown: string | null) => {
        let instructionsPanel = document.getElementById('tutorial-instructions');
        let toggleBtn = document.getElementById('tutorial-toggle-btn');
        if (markdown === null) {
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
          instructionsPanel.innerHTML = renderMarkdownToHtml(markdown);
        }
      },
    },
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
      renderPipeline.scheduleRender();
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
      // Resize all scope canvases to fill new height
      for (const sp of renderPipeline.state.scopePanels) {
        renderPipeline.sizeCanvasInContainer(sp.canvas);
      }
      renderPipeline.scheduleRender();
    };

    viewerResizeHandle.addEventListener('pointerup', stopViewerResize);
    viewerResizeHandle.addEventListener('pointercancel', stopViewerResize);
  }

  // -------------------------------------------------------------------------
  // Announce ready and auto-load
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Test bridge — exposes coordinate queries for E2E tests
  // -------------------------------------------------------------------------

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    (window as unknown as Record<string, unknown>).__test = createTestBridge(
      circuit, viewport, canvas, palette, registry, () => facade.getCoordinator(),
    );
  }

  postMessageAdapter.init();

  // -------------------------------------------------------------------------
  // Module config + auto-load
  // -------------------------------------------------------------------------

  async function autoLoadFile(): Promise<void> {
    if (!params.file) return;
    const fileUrl = `${params.base}${params.file}`;
    try {
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`Failed to fetch: ${fileUrl}`);
      const xml = await res.text();
      await loadCircuitFromXml(xml);
      window.parent.postMessage({ type: 'digital-loaded' }, '*');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
    }
  }

  async function applyModuleAndLoad(): Promise<void> {
    // Load module config if ?module= is set
    if (params.module) {
      const result = await loadModuleConfig(params.module, params.base);
      if (result) {
        const { config, moduleBase } = result;
        applyModuleConfig(params, config, moduleBase);

        // Re-apply palette if module config set one
        if (params.palette) {
          palette.setAllowlist(params.palette);
          paletteUI.render();
        }

        // Store module config on window for tutorial pages to read
        (window as unknown as Record<string, unknown>).__moduleConfig = config;
        (window as unknown as Record<string, unknown>).__moduleBase = moduleBase;
      } else {
        console.warn(`Module config not found: modules/${params.module}/config.json`);
      }
    }

    await autoLoadFile();
  }

  applyModuleAndLoad();
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
