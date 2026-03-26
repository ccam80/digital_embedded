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
import type { AppContext } from './app-context.js';
import { initRenderPipeline } from './render-pipeline.js';
import type { RenderPipeline } from './render-pipeline.js';
import { initSimulationController } from './simulation-controller.js';
import type { SimulationController } from './simulation-controller.js';
import { initKeyboardHandler } from './keyboard-handler.js';
import { AppSettings, SettingKey } from '../editor/settings.js';
import { initFileIOController } from './file-io-controller.js';
import { initAnalysisDialogs } from './analysis-dialogs.js';
import { initCanvasInteraction } from './canvas-interaction.js';

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
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { createModal } from './dialog-manager.js';
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
// TimingDiagramPanel removed — unified into ScopePanel
import type { AcParams } from '../solver/analog/ac-analysis.js';
import { initViewerController } from './viewer-controller.js';
import type { ViewerController } from './viewer-controller.js';
import { BodePlotRenderer } from '../runtime/bode-plot.js';
import { LOGIC_FAMILY_PRESETS, getLogicFamilyPreset, defaultLogicFamily } from '../core/logic-family.js';
import type { BodeViewport } from '../runtime/bode-plot.js';


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

  let clipboard: ClipboardData = { entries: [], wires: [] };
  let lastWorldPt: Point = { x: 0, y: 0 };

  // boxSelect lives in renderPipeline.state.boxSelect (set up below)

  // Speed control, simulation loop, and toolbar sim buttons are now owned by
  // SimulationController (initSimulationController, set up below after ctx).
  // Keyboard shortcuts are registered via initKeyboardHandler (called after ctx is built).

  // -------------------------------------------------------------------------
  // Viewer panels (Timing Diagram + Values Table)
  //
  // Signals are added by right-clicking wires on the canvas.
  // -------------------------------------------------------------------------

  // ViewerController is initialized after renderPipeline is built (below).
  let viewerController!: ViewerController;

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
        viewerController.appendComponentTraceItems(items, elementHit, resolverCtx);
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
          viewerController.appendWireViewerItems(items, wireHit, viewCoordinator);
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

  // (File I/O, folder management, and exports are handled by FileIOController — initialized below)

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
    // httpResolver is set on ctx by initFileIOController after ctx is built
    get httpResolver() { return fileIOController.httpResolver; },

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
    // applyLoadedCircuit is replaced by initFileIOController after ctx is built
    applyLoadedCircuit(loaded: Circuit): void {
      fileIOController.applyLoadedCircuit(loaded);
    },
    setCircuit(c: Circuit): void { circuit = c; },
    getCircuit(): Circuit { return circuit; },
  };

  // Initialize render pipeline — must happen after ctx is built so the
  // pipeline can reference ctx.facade, ctx.viewport, etc.
  renderPipeline = initRenderPipeline(ctx, search);

  // Initialize viewer controller — must happen after renderPipeline is built so
  // it can write to renderPipeline.state.scopePanels.
  viewerController = initViewerController(ctx, renderPipeline);

  // Initialize simulation controller — must happen after renderPipeline is built.
  simController = initSimulationController(ctx, renderPipeline, {
    disposeViewers(): void { viewerController.disposeViewers(); },
    rebuildViewersIfOpen(): void {
      viewerController.resolveWatchedSignalAddresses(facade.getCoordinator().compiled);
    },
  });

  // Initialize file I/O controller — must happen after ctx is built.
  let fileIOController = initFileIOController(ctx, {
    onCircuitLoaded(): void { rebuildInsertMenu(); },
  });

  // Initialize canvas interaction — pointer events, drag state, touch gestures,
  // subcircuit navigation, popup management, and memory editor.
  // Must happen after renderPipeline and simController are built.
  const canvasInteraction = initCanvasInteraction(ctx, renderPipeline, simController, {
    startSimulation(): void { simController.startSimulation(); },
    stopSimulation(): void { simController.stopSimulation(); },
    compileAndBind(): boolean { return simController.compileAndBind(); },
  });

  // Register all keyboard shortcuts (merges the three former keydown listeners).
  initKeyboardHandler(ctx, {
    startSimulation(): void { simController.startSimulation(); },
    stopSimulation(): void { simController.stopSimulation(); },
    invalidateCompiled,
    closePopup(): void { canvasInteraction.closePopup(); },
    openSearchBar,
    togglePresentation,
    exitPresentation,
    isPresentationMode(): boolean { return presentationMode; },
    navigateBack(): boolean { canvasInteraction.navigateBack(); return canvasInteraction.circuitStack.length >= 0; },
    updateZoomDisplay,
    clearDragMode(): void { /* dragMode is now owned by CanvasInteraction */ },
    fileInput: document.getElementById('file-input') as HTMLInputElement | null,
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

  initAnalysisDialogs(ctx);

  // Ctrl+S and Ctrl+O are handled in initKeyboardHandler.

  // -------------------------------------------------------------------------
  // postMessage adapter
  // -------------------------------------------------------------------------

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
    resolver: fileIOController.httpResolver,
    target: window.parent,
    eventSource: window,
    hooks: {
      loadCircuitXml: (xml) => fileIOController.loadCircuitFromXml(xml),
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
      await fileIOController.loadCircuitFromXml(xml);
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
