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
import { SpeedControl } from '../integration/speed-control.js';
import { AnalogRateController } from '../integration/analog-rate-controller.js';
import { darkColorScheme, lightColorScheme, THEME_COLORS } from '../core/renderer-interface.js';
import { LockedModeGuard } from '../editor/locked-mode.js';
import { ColorSchemeManager, buildColorMap } from '../editor/color-scheme.js';
import { screenToWorld, snapToGrid, GRID_SPACING } from '../editor/coordinates.js';
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
import type { Diagnostic } from '../headless/netlist-types.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import type { WireSignalAccess } from '../editor/wire-signal-access.js';
import type { ConcreteCompiledCircuit } from '../solver/digital/digital-engine.js';
import { DataTablePanel } from '../runtime/data-table.js';
import type { SignalDescriptor, SignalGroup } from '../runtime/data-table.js';
import { TimingDiagramPanel } from '../runtime/timing-diagram.js';
import { WireCurrentResolver } from '../editor/wire-current-resolver.js';
import { CurrentFlowAnimator } from '../editor/current-animation.js';
import { VoltageRangeTracker } from '../editor/voltage-range.js';
import { voltageToColor } from '../editor/voltage-color.js';
import { SliderPanel } from '../editor/slider-panel.js';
import { SliderEngineBridge } from '../editor/slider-engine-bridge.js';
import { PropertyType } from '../core/properties.js';
import { AnalogScopePanel } from '../runtime/analog-scope-panel.js';
import type { ConcreteCompiledAnalogCircuit } from '../solver/analog/compiled-analog-circuit.js';
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
  const speedControl = new SpeedControl();
  const contextMenu = new ContextMenu(document.body);

  /** Analog simulation rate in sim-seconds per wall-second.  Default 1e-3. */
  let analogTargetRate = 1e-3;

  /**
   * World-space positions of diagnostic errors/warnings to highlight on the
   * canvas. Populated by compileAndBind() when diagnostics carry
   * involvedNodes; cleared on successful compile or circuit edit.
   */
  let diagnosticOverlays: Array<{ x: number; y: number; severity: 'error' | 'warning' }> = [];

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

  /**
   * Populate diagnosticOverlays from solver diagnostics that carry involvedNodes.
   * Reverse-lookups wireToNodeId to find world-space positions for each node.
   */
  function populateDiagnosticOverlays(
    diags: import('../core/analog-engine-interface.js').SolverDiagnostic[],
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
      if (!diag.involvedNodes || diag.involvedNodes.length === 0) continue;
      const severity = diag.severity === 'error' ? 'error' as const : 'warning' as const;
      for (const nodeId of diag.involvedNodes) {
        const pos = nodeIdToPosition.get(nodeId);
        if (pos) {
          diagnosticOverlays.push({ x: pos.x, y: pos.y, severity });
        }
      }
    }
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

  /** Category keys in digital-first order. */
  const INSERT_ORDER_DIGITAL = [
    "IO", "WIRING", "LOGIC", "SWITCHING", "FLIP_FLOPS", "MEMORY",
    "ARITHMETIC", "PLD", "MISC", "GRAPHICS", "TERMINAL", "74XX",
    "PASSIVES", "SEMICONDUCTORS", "SOURCES", "ACTIVE",
  ];
  /** Category keys in analog-first order. */
  const INSERT_ORDER_ANALOG = [
    "PASSIVES", "SEMICONDUCTORS", "SOURCES", "ACTIVE",
    "IO", "WIRING", "LOGIC", "SWITCHING", "FLIP_FLOPS", "MEMORY",
    "ARITHMETIC", "PLD", "MISC", "GRAPHICS", "TERMINAL", "74XX",
  ];

  /** Rebuild the Insert menu, filtering by engine type. */
  function rebuildInsertMenu(): void {
    if (!insertMenuDropdown) return;
    insertMenuDropdown.innerHTML = '';
    const reg = palette.getRegistry();
    const engineFilter = palette.getEngineTypeFilter();
    const isAll = engineFilter === null;
    const order = (engineFilter === 'analog' || isAll) ? INSERT_ORDER_ANALOG : INSERT_ORDER_DIGITAL;
    for (const catKey of order) {
      const allDefs = reg.getByCategory(catKey as any);
      // Filter by engine type (null = show all)
      const defs = isAll ? allDefs : allDefs.filter(d => {
        if (engineFilter === 'digital') return hasDigitalModel(d);
        if (engineFilter === 'analog') return hasAnalogModel(d);
        return false;
      });
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

  const propertyContainer = document.getElementById('property-content')!;
  const propertyPanel = new PropertyPanel(propertyContainer);

  selection.onChange(() => {
    const selected = selection.getSelectedElements();
    if (selected.size === 1) {
      const element = selected.values().next().value!;
      const def = registry.get(element.typeId);
      if (def) {
        propertyPanel.showProperties(element, def.propertyDefs);
        if (availableModels(def).length > 1) {
          propertyPanel.showSimulationModeDropdown(element, def);
        }
        if (hasDigitalModel(def)) {
          const simModel = element.getProperties().has("simulationModel")
            ? element.getProperties().get("simulationModel") as string
            : (def.defaultModel ?? "logical");
          if (simModel === "logical" || simModel === "analog-pins") {
            const family = circuit.metadata.logicFamily ?? defaultLogicFamily();
            propertyPanel.showPinElectricalOverrides(element, def, family);
          }
        }
      }
    } else {
      propertyPanel.clear();
    }

    // --- Populate analog sliders for selected element ---
    if (activeSliderPanel) {
      activeSliderPanel.removeUnpinned();
      if (selected.size === 1) {
        const element = selected.values().next().value!;
        const def = registry.get(element.typeId);
        const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null as ConcreteCompiledAnalogCircuit | null;
        if (def?.propertyDefs && analogCompiled) {
          // Find the element index in the compiled circuit
          let elementIndex = -1;
          for (const [idx, ce] of analogCompiled.elementToCircuitElement) {
            if (ce === element) { elementIndex = idx; break; }
          }
          if (elementIndex >= 0) {
            for (const propDef of def.propertyDefs) {
              if (propDef.type === PropertyType.FLOAT) {
                const currentVal = element.getProperties().getOrDefault<number>(propDef.key, propDef.defaultValue as number);
                const unit = PROPERTY_UNIT_MAP[propDef.key] ?? '';
                activeSliderPanel.addSlider(
                  elementIndex,
                  propDef.key,
                  propDef.label,
                  currentVal,
                  { unit, logScale: true },
                );
              }
            }
          }
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

  /** True when a simulation (digital or analog) is active. */
  function isSimActive(): boolean {
    return binding.isBound || ((facade.getCoordinator()?.analogBackend ?? null) !== null);
  }

  /**
   * Translate raw JS error messages from the analog pipeline into
   * plain-language descriptions that help the user locate the problem.
   */
  function _friendlyAnalogError(raw: string, circ: import("../core/circuit.js").Circuit): string {
    // Pattern: "Cannot read properties of undefined (reading 'X')"
    // This typically means a component's pin didn't connect to any wire,
    // producing an invalid node index that cascaded into the solver.
    if (raw.includes('Cannot read properties of undefined')) {
      const componentNames = circ.elements
        .map(el => {
          const props = el.getProperties();
          const label = props.has('label') ? props.get<string>('label') : '';
          return label || el.typeId;
        })
        .filter(n => n.length > 0);
      const list = componentNames.length > 0
        ? ` Components in circuit: ${componentNames.join(', ')}.`
        : '';
      return `A component has an unconnected pin — check that every pin sits exactly ` +
        `on a wire endpoint. Rotated or moved components often leave pins dangling.${list}`;
    }

    // Pattern: unknown component type
    if (raw.includes('unknown component type')) {
      const match = raw.match(/"([^"]+)"/);
      const typeName = match ? match[1] : 'unknown';
      return `Couldn't find the component type "${typeName}" — check that it's ` +
        `registered and spelled correctly.`;
    }

    // Pattern: digital-only component in analog circuit
    if (raw.includes('digital-only')) {
      const match = raw.match(/"([^"]+)"/);
      const typeName = match ? match[1] : 'unknown';
      return `"${typeName}" is a digital-only component and can't be used in an analog circuit. ` +
        `Replace it with an analog equivalent or switch to digital mode.`;
    }

    // Fallback: return the raw message
    return raw;
  }

  /** Dispose the analog engine and clear analog state. */
  function disposeAnalog(): void {
    stopAnalogRenderLoop();
    facade.invalidate();
  }



  function compileAndBind(): boolean {
    // Clear previous diagnostic overlays — each compile attempt starts fresh.
    diagnosticOverlays = [];

    // Determine effective engine mode for UI branching
    let isAnalog = isAnalogMode();

    // Merge any collinear/duplicate wire segments before compiling.
    // This eliminates redundant wires that create cycles in the wire graph,
    // which would cause the current resolver to zero-out entire components.
    circuit.mergeCollinearWires();

    if (binding.isBound) {
      facade.getEngine()?.stop?.();
      binding.unbind();
    }
    disposeAnalog();

    if (isAnalog) {
      try {
        const engine = facade.compile(circuit);
        const ac = facade.getCoordinator()?.compiled.analog ?? null;

        if (ac) {
          const concreteAc = ac as unknown as ConcreteCompiledAnalogCircuit;
          const compileErrors = concreteAc.diagnostics.filter(d => d.severity === 'error');
          if (compileErrors.length > 0) {
            const friendlyMessages = compileErrors.map(d => d.summary);
            const combined = friendlyMessages.join(' | ');
            console.error('Analog compilation diagnostics:', compileErrors);
            showStatus(`Analog circuit problem: ${combined}`, true);
            populateDiagnosticOverlays(concreteAc.diagnostics, concreteAc.wireToNodeId);
            scheduleRender();
            facade.invalidate();
            return false;
          }

          const compileWarnings = concreteAc.diagnostics.filter(d => d.severity === 'warning');
          if (compileWarnings.length > 0) {
            console.warn('Analog compilation warnings:', compileWarnings.map(d => d.summary));
            // Show warning overlays even on successful compile
            populateDiagnosticOverlays(compileWarnings, concreteAc.wireToNodeId);
            scheduleRender();
          }
        }

        const dcResult = facade.getDcOpResult();
        if (dcResult && !dcResult.converged) {
          showStatus('Warning: DC operating point did not converge', true);
        }

        compiledDirty = false;
        clearStatus();

        if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
          const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null;
          if (analogCompiled) {
            for (const sig of watchedSignals) {
              const nodeId = analogCompiled.labelToNodeId.get(sig.name);
              if (nodeId !== undefined) {
                sig.netId = nodeId;
                sig.width = 1;
              }
            }
          }
          rebuildViewers();
        }

        void engine;
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Analog compilation failed:', msg, err);
        const friendly = _friendlyAnalogError(msg, circuit);
        showStatus(`Analog compilation error: ${friendly}`, true);
        facade.invalidate();
        return false;
      }
    }

    // Pre-compilation diagnostics (digital only)
    const diagnostics = facade.validate(circuit);
    const errors = diagnostics.filter(d => d.severity === 'error');
    if (errors.length > 0) {
      const msg = formatDiagnostics(errors);
      console.error('Pre-compilation diagnostics:', msg);
      showStatus(`Compilation error: ${msg}`, true);
      return false;
    }

    try {
      facade.compile(circuit);
      const compiled = facade.getCompiled();
      if (compiled) {
        const coordinator = facade.getCoordinator()!;
        const unified = coordinator.compiled;
        binding.bind(circuit, coordinator, unified.wireSignalMap, unified.labelSignalMap);
      }
      compiledDirty = false;
      clearStatus();
      if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
        const compiledCircuit = facade.getCompiled();
        if (compiledCircuit) {
          for (const sig of watchedSignals) {
            const newNetId = compiledCircuit.labelToNetId.get(sig.name);
            if (newNetId !== undefined) {
              sig.netId = newNetId;
              sig.width = compiledCircuit.netWidths[newNetId] ?? 1;
            }
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
    const eng = facade.getEngine();
    if ((eng as import("../core/engine-interface.js").SimulationEngine | null)?.getState?.() === EngineState.RUNNING) eng?.stop?.();
    if (binding.isBound) binding.unbind();
    disposeAnalog();
    // Dispose viewer panels — they hold stale net IDs
    disposeViewers();
    scheduleRender();
  }

  const wireSignalAccessAdapter: WireSignalAccess = {
    getWireValue(wire: Wire): { raw: number; width: number } | { voltage: number } | undefined {
      const coordinator = facade.getCoordinator();
      if (!coordinator) return undefined;
      const addr = coordinator.compiled.wireSignalMap.get(wire);
      if (addr === undefined) return undefined;
      try {
        const sv = coordinator.readSignal(addr);
        if (sv.type === "analog") {
          return { voltage: sv.voltage };
        }
        return { raw: sv.value, width: addr.bitWidth };
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
      isSimActive() ? wireSignalAccessAdapter : undefined,
    );
    wireRenderer.renderJunctionDots(canvasRenderer, circuit.wires);
    wireRenderer.renderBusWidthMarkers(canvasRenderer, circuit.wires);

    if (currentFlowAnimator !== null) {
      currentFlowAnimator.render(canvasRenderer, circuit);
    }

    const ghosts = placement.getGhosts();
    for (const ghost of ghosts) {
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
    const pasteWires = placement.getPasteWireGhosts();
    if (pasteWires.length > 0) {
      ctx2d.save();
      ctx2d.globalAlpha = 0.5;
      canvasRenderer.setColor('WIRE');
      canvasRenderer.setLineWidth(2);
      for (const w of pasteWires) {
        canvasRenderer.drawLine(w.start.x, w.start.y, w.end.x, w.end.y);
      }
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

    // Render diagnostic overlays (error/warning location circles)
    if (diagnosticOverlays.length > 0) {
      ctx2d.save();
      for (const overlay of diagnosticOverlays) {
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

    // Render scope panels in sync with the main canvas frame
    for (const sp of scopePanels) {
      sizeCanvasInContainer(sp.canvas);
      sp.panel.render();
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
          scheduleRender();
          if (pinHit) {
            wireDrawing.startFromPin(pinHit.element, pinHit.pin);
          } else {
            selection.clear();
            selection.select(lastPlaced);
          }
          scheduleRender();
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
      if (facade.getCoordinator()?.analogBackend !== null) {
        // During analog simulation, allow element selection (for slider panel)
        const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
        if (elementHit) {
          selection.clear();
          selection.select(elementHit);

          // Switch toggle during analog simulation — recompile to update conductance
          if (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT') {
            const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
            try {
              if (momentary) {
                elementHit.setAttribute('closed', true);
                const onPointerUp = (): void => {
                  elementHit.setAttribute('closed', false);
                  compiledDirty = true;
                  if (compileAndBind()) {
                    startSimulation();
                  }
                  scheduleRender();
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
            } catch {
              // ignore toggle errors
            }
          }
        } else {
          selection.clear();
        }
        scheduleRender();
        return;
      }

      const elementHit = hitTestElements(worldPt, circuit.elements, hitMargin);
      if (elementHit && (elementHit.typeId === 'In' || elementHit.typeId === 'Clock')) {
        const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
        try {
          const current = binding.getPinValue(elementHit, 'out');
          const newVal = bitWidth === 1
            ? (current === 0 ? 1 : 0)
            : ((current + 1) & ((1 << bitWidth) - 1));
          binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
          if (elementHit.typeId === 'Clock') {
            const compiled = facade.getCompiled();
            const clockManager = facade.getClockManager();
            if (clockManager !== null && compiled !== null) {
              const netId = compiled.pinNetMap.get(`${elementHit.instanceId}:out`);
              if (netId !== undefined) {
                clockManager.setClockPhase(netId, newVal !== 0);
              }
            }
          }
          const eng = facade.getEngine();
          if (eng?.getState?.() !== EngineState.RUNNING) {
            facade.step(eng!, { clockAdvance: elementHit.typeId !== 'Clock' });
          }
          scheduleRender();
        } catch {
          scheduleRender();
        }
      }

      // Switch toggle: Switch (SPST) and SwitchDT (SPDT) clicked during simulation
      if (elementHit && (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT')) {
        const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
        try {
          if (momentary) {
            // Momentary: set closed=true on pointerdown, release on pointerup
            elementHit.setAttribute('closed', true);
            const onPointerUp = (): void => {
              elementHit.setAttribute('closed', false);
              const eng = facade.getEngine();
              if (eng?.getState?.() !== EngineState.RUNNING) {
                facade.step(eng!, { clockAdvance: true });
              }
              scheduleRender();
            };
            document.addEventListener('pointerup', onPointerUp, { once: true });
          } else {
            // Latching: toggle closed property
            const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
            elementHit.setAttribute('closed', !current);
          }
          const eng = facade.getEngine();
          if (eng?.getState?.() !== EngineState.RUNNING) {
            facade.step(eng!, { clockAdvance: true });
          }
          scheduleRender();
        } catch {
          scheduleRender();
        }
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
    const tempPanel = new PropertyPanel(propsContainer);
    tempPanel.showProperties(elementHit, def.propertyDefs);
    if (availableModels(def).length > 1) {
      tempPanel.showSimulationModeDropdown(elementHit, def);
    }
    if (hasDigitalModel(def)) {
      const simModel = elementHit.getProperties().has("simulationModel")
        ? elementHit.getProperties().get("simulationModel") as string
        : (def.defaultModel ?? "logical");
      if (simModel === "logical" || simModel === "analog-pins") {
        const family = circuit.metadata.logicFamily ?? defaultLogicFamily();
        tempPanel.showPinElectricalOverrides(elementHit, def, family);
      }
    }
    tempPanel.onPropertyChange(() => {
      if (isAnalogMode() && isSimActive()) {
        // Seamlessly recompile — don't hard-stop the analog simulation
        compiledDirty = true;
        if (compileAndBind()) {
          startSimulation();
        }
      } else {
        invalidateCompiled();
      }
      scheduleRender();
    });

    const screenPt = canvasToScreen(e);
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
      if (isSimActive()) {
        if (facade.getCoordinator()?.analogBackend !== null) {
          disposeAnalog();
        } else {
          stopSimulation();
          binding.unbind();
          facade.getEngine()?.dispose?.();
        }
        compiledDirty = true;
        scheduleRender();
      } else {
        if (compiledDirty && !compileAndBind()) return;
        startSimulation();
      }
      return;
    }

    // Block all edit shortcuts during simulation
    if (isSimActive()) return;

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
        const def = registry.get('Capacitor');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === '1') {
        const def = registry.get('Const');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'v' || e.key === 'V') {
        const def = registry.get('VoltageSource');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === '+') {
        const def = registry.get('VDD');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'l' || e.key === 'L') {
        const def = registry.get('Inductor');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 't' || e.key === 'T') {
        const def = registry.get('Tunnel');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }

      if (e.key === 'g' || e.key === 'G') {
        const def = registry.get('Ground');
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

      if (e.key === 'R') {
        const def = registry.get('Resistor');
        if (def) { placement.start(def); scheduleRender(); }
        return;
      }
    }

    if (e.key === 'r') {
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
        placement.startPaste(clipboard);
        placement.updateCursor(lastWorldPt);
        scheduleRender();
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
  const speedUnitEl = document.querySelector('.speed-unit') as HTMLElement | null;

  function isAnalogMode(): boolean {
    return (facade.getCoordinator()?.analogBackend ?? null) !== null;
  }

  /**
   * Format analog rate for display.  Uses SI-prefix style:
   *   0.000001 → "1e-6",  0.001 → "1e-3",  0.1 → "0.1",  1 → "1",  10 → "10"
   */
  function formatAnalogRate(rate: number): string {
    if (rate >= 0.1) return String(parseFloat(rate.toPrecision(4)));
    return rate.toExponential().replace(/\.?0+e/, 'e').replace('e+', 'e');
  }

  function updateSpeedDisplay(): void {
    if (!speedInput) return;
    if (isAnalogMode()) {
      speedInput.value = formatAnalogRate(analogTargetRate);
      if (speedUnitEl) speedUnitEl.textContent = 'sim/real s';
      speedInput.title = 'Simulation seconds per real second';
    } else {
      speedInput.value = String(speedControl.speed);
      if (speedUnitEl) speedUnitEl.textContent = 'steps/s';
      speedInput.title = 'Steps per second';
    }
  }

  document.getElementById('btn-speed-down')?.addEventListener('click', () => {
    if (isAnalogMode()) {
      analogTargetRate = Math.max(1e-15, analogTargetRate / 10);
    } else {
      speedControl.divideBy10();
    }
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-up')?.addEventListener('click', () => {
    if (isAnalogMode()) {
      analogTargetRate = Math.min(1e6, analogTargetRate * 10);
    } else {
      speedControl.multiplyBy10();
    }
    updateSpeedDisplay();
  });

  speedInput?.addEventListener('change', () => {
    if (isAnalogMode()) {
      const parsed = Number(speedInput.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        analogTargetRate = Math.max(1e-15, Math.min(1e6, parsed));
      }
    } else {
      speedControl.parseText(speedInput.value);
    }
    updateSpeedDisplay();
  });

  // -------------------------------------------------------------------------
  // Unified simulation loop — uses coordinator.step() for all circuit types
  // -------------------------------------------------------------------------

  let runRafHandle = -1;

  // Analog-specific render loop state
  let analogRafHandle = -1;
  let currentFlowAnimator: CurrentFlowAnimator | null = null;
  const analogVoltageTracker = new VoltageRangeTracker();
  let activeSliderPanel: SliderPanel | null = null;

  /** Property key → SI unit for slider display. */
  const PROPERTY_UNIT_MAP: Record<string, string> = {
    resistance: '\u03A9',
    capacitance: 'F',
    inductance: 'H',
    voltage: 'V',
    current: 'A',
    frequency: 'Hz',
  };

  /**
   * Unified entry point: starts the simulation render loop for any circuit
   * type (digital-only, analog-only, or mixed). Internally dispatches to
   * the appropriate timing model (speed-control for digital, rate-controller
   * for analog) while always stepping through the coordinator.
   */
  function startSimulation(): void {
    const coordinator = facade.getCoordinator();
    if (!coordinator) return;

    const analogEngine = coordinator.analogBackend;
    const analogCompiled = coordinator.compiled.analog ?? null;

    if (analogEngine !== null && analogCompiled !== null) {
      // --- Analog / mixed path ---
      if (analogRafHandle !== -1) return;
      coordinator.start();
      _startAnalogLoop(coordinator, analogEngine, analogCompiled);
    } else {
      // --- Digital-only path ---
      if (coordinator.digitalBackend?.getState?.() === EngineState.RUNNING) return;
      selection.clear();
      coordinator.start();
      _startDigitalLoop(coordinator);
    }
  }

  /** Digital-only render loop: steps coordinator at speed-control rate. */
  function _startDigitalLoop(coordinator: import('../compile/coordinator-types.js').SimulationCoordinator): void {
    let lastTime = performance.now();

    const tick = (now: number): void => {
      if (coordinator.digitalBackend?.getState?.() !== EngineState.RUNNING) {
        runRafHandle = -1;
        scheduleRender();
        return;
      }
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const stepsThisFrame = Math.max(1, Math.round(speedControl.speed * dt));
      for (let i = 0; i < stepsThisFrame; i++) {
        try {
          facade.step(coordinator);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showStatus(`Simulation error: ${msg}`, true);
          stopSimulation();
          return;
        }
      }
      scheduleRender();
      runRafHandle = requestAnimationFrame(tick);
    };
    runRafHandle = requestAnimationFrame(tick);
  }

  /** Analog / mixed render loop: steps coordinator at analog rate, animates current-flow. */
  function _startAnalogLoop(
    coordinator: import('../compile/coordinator-types.js').SimulationCoordinator,
    analogEngine: import('../core/analog-engine-interface.js').AnalogEngine,
    analogCompiled: import('../core/analog-engine-interface.js').CompiledAnalogCircuit,
  ): void {
    analogVoltageTracker.reset();
    const resolver = new WireCurrentResolver();
    currentFlowAnimator = new CurrentFlowAnimator(resolver);
    currentFlowAnimator.setEnabled(true);
    applyCurrentVizSettings(loadEngineSettings());
    wireRenderer.setVoltageTracker(analogVoltageTracker);

    // Build pin-voltage factory for element renderer.
    // Build a position→nodeId lookup from the unified wireSignalMap so that
    // ALL elements (including infrastructure like Tunnel) can show voltage.
    const posToAnalogNodeId = new Map<string, number>();
    for (const [wire, addr] of coordinator.compiled.wireSignalMap) {
      if (addr.domain !== "analog") continue;
      posToAnalogNodeId.set(`${wire.start.x},${wire.start.y}`, addr.nodeId);
      posToAnalogNodeId.set(`${wire.end.x},${wire.end.y}`, addr.nodeId);
    }
    elementRenderer.setAnalogContext((element) => {
      const pinLabelToNodeId = new Map<string, number>();
      for (const pin of element.getPins()) {
        const wp = pinWorldPosition(element, pin);
        const nodeId = posToAnalogNodeId.get(`${wp.x},${wp.y}`);
        if (nodeId !== undefined) {
          pinLabelToNodeId.set(pin.label, nodeId);
        }
      }
      if (pinLabelToNodeId.size === 0) return undefined;
      const tracker = analogVoltageTracker;
      const scheme = colorSchemeManager.getActive();
      return {
        getPinVoltage(pinLabel: string): number | undefined {
          const nodeId = pinLabelToNodeId.get(pinLabel);
          if (nodeId === undefined) return undefined;
          try {
            return analogEngine.getNodeVoltage(nodeId);
          } catch {
            return undefined;
          }
        },
        voltageColor(voltage: number): string {
          return voltageToColor(voltage, tracker, scheme);
        },
      };
    });

    // --- Slider panel setup ---
    const sliderContainer = document.getElementById('slider-panel');
    if (sliderContainer) {
      sliderContainer.style.display = '';
      activeSliderPanel = new SliderPanel(sliderContainer);
      new SliderEngineBridge(activeSliderPanel, analogEngine, analogCompiled);
    }

    // Rate controller: paces the analog engine at analogTargetRate sim-s / wall-s.
    const analogRate = new AnalogRateController({ targetRate: analogTargetRate });
    let lastAnalogRate = analogTargetRate;

    // Show analog units on the speed display now that we're in analog mode.
    updateSpeedDisplay();

    let lastTime = performance.now();

    const tick = (now: number): void => {
      const wallDtSeconds = (now - lastTime) / 1000;
      lastTime = now;

      // Sync rate from UI; reset miss tracking on change.
      if (analogTargetRate !== lastAnalogRate) {
        analogRate.targetRate = analogTargetRate;
        analogRate.reset();
        lastAnalogRate = analogTargetRate;
        clearStatus();
      }

      const { targetSimAdvance, budgetMs } = analogRate.computeFrameTarget(wallDtSeconds);
      const simTimeGoal = analogEngine.simTime + targetSimAdvance;
      const stepStart = performance.now();
      let missed = false;

      try {
        // Always do at least one step per frame so the sim never stalls.
        coordinator.step();
        if (analogEngine.getState() === EngineState.ERROR) {
          showStatus('Analog simulation error: solver failed to converge', true);
          disposeAnalog();
          compiledDirty = true;
          scheduleRender();
          return;
        }
        while (analogEngine.simTime < simTimeGoal) {
          if (performance.now() - stepStart > budgetMs) {
            missed = true;
            break;
          }
          coordinator.step();
          if (analogEngine.getState() === EngineState.ERROR) {
            showStatus('Analog simulation error: solver failed to converge', true);
            disposeAnalog();
            compiledDirty = true;
            scheduleRender();
            return;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showStatus(`Analog simulation error: ${msg}`, true);
        disposeAnalog();
        compiledDirty = true;
        scheduleRender();
        return;
      }

      // Track frame misses and show/clear warning.
      const result = analogRate.recordFrame(now, missed);
      if (result.warningChanged) {
        if (result.warningActive) {
          showStatus(
            'Simulation is running slower than the designated speed — ' +
            'this circuit is too complex to compute that fast',
            true,
          );
        } else {
          clearStatus();
        }
      }

      const resolverCtx = coordinator.getCurrentResolverContext();
      if (resolverCtx) resolver.resolve(resolverCtx);
      currentFlowAnimator!.update(wallDtSeconds, circuit);
      analogVoltageTracker.update(analogEngine, analogCompiled.nodeCount);

      scheduleRender();
      analogRafHandle = requestAnimationFrame(tick);
    };
    analogRafHandle = requestAnimationFrame(tick);
  }

  function stopSimulation(): void {
    // Stop whichever loop is active
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    if (analogRafHandle !== -1) {
      cancelAnimationFrame(analogRafHandle);
      analogRafHandle = -1;
    }
    const coordinator = facade.getCoordinator();
    if (coordinator) {
      coordinator.stop();
    } else {
      facade.getEngine()?.stop?.();
    }
    scheduleRender();
  }

  function stopAnalogRenderLoop(): void {
    if (analogRafHandle !== -1) {
      cancelAnimationFrame(analogRafHandle);
      analogRafHandle = -1;
    }
    if (currentFlowAnimator !== null) {
      currentFlowAnimator.setEnabled(false);
      currentFlowAnimator = null;
    }
    wireRenderer.setVoltageTracker(null);
    elementRenderer.setAnalogContext(null);
    // --- Slider panel teardown ---
    if (activeSliderPanel) {
      activeSliderPanel.dispose();
      activeSliderPanel = null;
    }
    const sliderContainer = document.getElementById('slider-panel');
    if (sliderContainer) sliderContainer.style.display = 'none';
    // Restore digital speed display units.
    updateSpeedDisplay();
  }

  // -------------------------------------------------------------------------
  // Toolbar: Step / Run / Stop
  // -------------------------------------------------------------------------

  document.getElementById('btn-step')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    const coordinator = facade.getCoordinator();
    if (!coordinator) return;
    // Stop continuous run if active, then do a single step
    if (coordinator.digitalBackend?.getState?.() === EngineState.RUNNING) coordinator.stop();
    try {
      facade.step(coordinator);
      clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showStatus(`Simulation error: ${msg}`, true);
    }
    scheduleRender();
  });

  document.getElementById('btn-run')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    startSimulation();
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    if (!isSimActive()) return;
    if (facade.getCoordinator()?.analogBackend !== null) {
      disposeAnalog();
    } else {
      stopSimulation();
      binding.unbind();
      facade.getEngine()?.dispose?.();
    }
    compiledDirty = true;
    scheduleRender();
  });

  document.getElementById('btn-micro-step')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    const coordinator = facade.getCoordinator();
    if (!coordinator) return;
    if (coordinator.analogBackend !== null) {
      // Analog/mixed: micro-step is equivalent to a single coordinator step
      try { facade.step(coordinator); clearStatus(); } catch (err) {
        showStatus(`Simulation error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    } else {
      // Digital-only: use microStep on the digital backend
      if (coordinator.digitalBackend?.getState?.() === EngineState.RUNNING) coordinator.stop();
      try {
        coordinator.digitalBackend?.microStep();
        clearStatus();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showStatus(`Simulation error: ${msg}`, true);
      }
    }
    scheduleRender();
  });

  document.getElementById('btn-run-to-break')?.addEventListener('click', () => {
    if (compiledDirty && !compileAndBind()) return;
    const coordinator = facade.getCoordinator();
    if (!coordinator) return;
    if (coordinator.analogBackend !== null) {
      showStatus('Run-to-break is not available for analog circuits');
      return;
    }
    if (coordinator.digitalBackend?.getState?.() === EngineState.RUNNING) return;
    try {
      coordinator.digitalBackend?.runToBreak();
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
  const viewerTimingContainer = document.getElementById('viewer-timing-container');
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
    panelIndex: number;
  }
  const watchedSignals: WatchedSignal[] = [];

  /** Multi-panel scope state. Each panel has its own canvas and AnalogScopePanel. */
  interface ScopePanelEntry {
    canvas: HTMLCanvasElement;
    panel: AnalogScopePanel;
  }
  const scopePanels: ScopePanelEntry[] = [];

  /** Build a human-readable name for a net ID from the pinNetMap. */
  function netIdToName(cc: ConcreteCompiledCircuit, netId: number): string {
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
  function netIdToGroup(cc: ConcreteCompiledCircuit, netId: number): 'input' | 'output' | 'probe' {
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
    const eng = facade.getEngine();
    if (activeTimingPanel) {
      (eng as unknown as { removeMeasurementObserver(o: unknown): void } | null)?.removeMeasurementObserver(activeTimingPanel);
      activeTimingPanel.dispose();
      activeTimingPanel = null;
    }
    for (const entry of scopePanels) {
      entry.panel.dispose();
      entry.canvas.remove();
    }
    scopePanels.length = 0;
    if (activeDataTable) {
      (eng as unknown as { removeMeasurementObserver(o: unknown): void } | null)?.removeMeasurementObserver(activeDataTable);
      activeDataTable.dispose();
      activeDataTable = null;
    }
  }

  /** Size a canvas to fill its share of the container at device pixel ratio. */
  function sizeCanvasInContainer(cvs: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    if (w > 0 && h > 0) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
    }
  }

  /** Rebuild viewer panels from the current watchedSignals list. */
  function rebuildViewers(): void {
    disposeViewers();
    const compiled = facade.getCompiled();
    const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null;
    if ((!compiled && !analogCompiled) || watchedSignals.length === 0) return;

    const eng = facade.getEngine();
    const ae = analogCompiled !== null ? eng : null;
    const isAnalog = isAnalogMode() && ae !== null;

    if (viewerTimingContainer) {
      if (isAnalog && ae) {
        // Group signals by panelIndex
        const panelGroups = new Map<number, WatchedSignal[]>();
        for (const s of watchedSignals) {
          const idx = s.panelIndex ?? 0;
          if (!panelGroups.has(idx)) panelGroups.set(idx, []);
          panelGroups.get(idx)!.push(s);
        }

        // Create a canvas + AnalogScopePanel per panel group
        const sortedIndices = [...panelGroups.keys()].sort((a, b) => a - b);
        for (const idx of sortedIndices) {
          const signals = panelGroups.get(idx)!;
          const cvs = document.createElement('canvas');
          viewerTimingContainer.appendChild(cvs);
          // Size after DOM insertion so clientWidth/Height are available
          requestAnimationFrame(() => sizeCanvasInContainer(cvs));
          const panel = new AnalogScopePanel(cvs, ae as unknown as import('../core/analog-engine-interface.js').AnalogEngine);
          for (const s of signals) {
            panel.addVoltageChannel(s.netId, s.name);
          }
          _attachScopeContextMenu(cvs, panel, signals);
          scopePanels.push({ canvas: cvs, panel });
        }
      } else if (eng) {
        const cvs = document.createElement('canvas');
        viewerTimingContainer.appendChild(cvs);
        requestAnimationFrame(() => sizeCanvasInContainer(cvs));
        const channels = watchedSignals.map(s => ({ name: s.name, netId: s.netId, width: s.width }));
        activeTimingPanel = new TimingDiagramPanel(cvs, eng, channels, {
          snapshotInterval: 0,
          stepsPerSecond: speedControl.speed,
        });
        (eng as unknown as { addMeasurementObserver(o: unknown): void }).addMeasurementObserver(activeTimingPanel);
      }
    }

    const coordinator = facade.getCoordinator();
    if (viewerValuesContainer && coordinator) {
      const signals: SignalDescriptor[] = watchedSignals.map(s => ({
        name: s.name,
        addr: isAnalog
          ? { domain: 'analog' as const, nodeId: s.netId }
          : { domain: 'digital' as const, netId: s.netId, bitWidth: s.width },
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
    const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null;
    if (analogCompiled) {
      const nodeId = analogCompiled.wireToNodeId.get(wire);
      if (nodeId === undefined) return;
      if (watchedSignals.some(s => s.netId === nodeId)) return;
      let name = `node${nodeId}`;
      for (const [label, nid] of analogCompiled.labelToNodeId) {
        if (nid === nodeId) { name = label; break; }
      }
      const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
      watchedSignals.push({ name, netId: nodeId, width: 1, group: 'probe', panelIndex: idx });
      viewerPanel?.classList.add('open');
      showViewerTab('timing');
      rebuildViewers();
      return;
    }
    const compiled = facade.getCompiled();
    if (!compiled) return;
    const netId = compiled.wireToNetId.get(wire);
    if (netId === undefined) return;
    if (watchedSignals.some(s => s.netId === netId)) return;

    const name = netIdToName(compiled, netId);
    const width = compiled.netWidths[netId] ?? 1;
    const group = netIdToGroup(compiled, netId);
    const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
    watchedSignals.push({ name, netId, width, group, panelIndex: idx });

    viewerPanel?.classList.add('open');
    showViewerTab('timing');
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
    viewerTimingContainer?.classList.toggle('active', tabName === 'timing');
    viewerValuesContainer?.classList.toggle('active', tabName === 'values');
  }

  function openViewer(tabName: string): void {
    if (compiledDirty && !compileAndBind()) return;
    viewerPanel?.classList.add('open');
    showViewerTab(tabName);
    if (watchedSignals.length > 0 && !activeTimingPanel && scopePanels.length === 0 && !activeDataTable) {
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
    if (!isAnalogMode()) {
      showStatus('AC Sweep is only available for analog/auto circuits', true);
      return;
    }
    if (acSweepDialog) acSweepDialog.style.display = 'flex';
  });

  document.getElementById('ac-sweep-close')?.addEventListener('click', () => {
    if (acSweepDialog) acSweepDialog.style.display = 'none';
  });

  document.getElementById('ac-sweep-run')?.addEventListener('click', () => {
    if (acSweepDialog) acSweepDialog.style.display = 'none';

    if (!isAnalogMode()) {
      showStatus('AC Sweep requires an analog circuit', true);
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

    const acEng = facade.getEngine();
    if (!acEng || facade.getCoordinator()?.analogBackend === null || facade.getCoordinator()?.analogBackend === undefined) {
      showStatus('AC Sweep: analog engine not initialized — compile the circuit first', true);
      return;
    }

    try {
      const result = (acEng as unknown as { acAnalysis(p: AcParams): ReturnType<import('../core/analog-engine-interface.js').AnalogEngine['acAnalysis']> }).acAnalysis(acParams);

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
        sizeCanvasInContainer(bodeCanvas);
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

    const worldPt = canvasToWorld(e);
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
            // Force property panel open even if already selected
            const def = registry.get(elementHit.typeId);
            if (def) {
              selection.select(elementHit);
              propertyPanel.showProperties(elementHit, def.propertyDefs);
              if (availableModels(def).length > 1) {
                propertyPanel.showSimulationModeDropdown(elementHit, def);
              }
              if (hasDigitalModel(def)) {
                const simModel = elementHit.getProperties().has("simulationModel")
                  ? elementHit.getProperties().get("simulationModel") as string
                  : (def.defaultModel ?? "logical");
                if (simModel === "logical" || simModel === "analog-pins") {
                  const family = circuit.metadata.logicFamily ?? defaultLogicFamily();
                  propertyPanel.showPinElectricalOverrides(elementHit, def, family);
                }
              }
            }
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
        if (activeSliderPanel && isSimActive()) {
          const def = registry.get(elementHit.typeId);
          const ac = facade.getCoordinator()?.compiled.analog ?? null as ConcreteCompiledAnalogCircuit | null;
          if (def?.propertyDefs && ac) {
            const floatProps = def.propertyDefs.filter(p => p.type === PropertyType.FLOAT);
            if (floatProps.length > 0) {
              let elementIndex = -1;
              for (const [idx, ce] of ac.elementToCircuitElement) {
                if (ce === elementHit) { elementIndex = idx; break; }
              }
              if (elementIndex >= 0) {
                items.push(separator());
                for (const propDef of floatProps) {
                  const currentVal = elementHit.getProperties().getOrDefault<number>(propDef.key, propDef.defaultValue as number);
                  const unit = PROPERTY_UNIT_MAP[propDef.key] ?? '';
                  items.push({
                    label: `Add Slider: ${propDef.label}`,
                    action: () => {
                      activeSliderPanel!.addSlider(elementIndex, propDef.key, propDef.label, currentVal, { unit, logScale: true });
                    },
                    enabled: true,
                  });
                }
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
      // Available even when sim is stopped (signals are queued for when it starts)
      if (isAnalogMode()) {
        const ac = facade.getCoordinator()?.compiled.analog ?? null as ConcreteCompiledAnalogCircuit | null;
        _appendComponentTraceItems(items, elementHit, ac);
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
        const compiled = facade.getCompiled();
        const analogCompiled = facade.getCoordinator()?.compiled.analog ?? null;
        if (compiled || analogCompiled) {
          if (items.length > 0) items.push(separator());
          _appendWireViewerItems(items, wireHit, compiled, analogCompiled);
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
          if (isAnalogMode()) { analogTargetRate = Math.min(1e6, analogTargetRate * 10); }
          else { speedControl.multiplyBy10(); }
          updateSpeedDisplay();
        }, enabled: true },
        { label: 'Speed \u00f710', action: () => {
          if (isAnalogMode()) { analogTargetRate = Math.max(1e-15, analogTargetRate / 10); }
          else { speedControl.divideBy10(); }
          updateSpeedDisplay();
        }, enabled: true },
      );
    }

    if (items.length > 0) {
      contextMenu.showItems(e.clientX, e.clientY, items);
    }
  });

  // Helper: append wire-viewer items for a wire
  type ConcreteCompiledCircuitType = NonNullable<ReturnType<typeof facade.getCompiled>>;
  type AnalogCompiledCircuitType = ConcreteCompiledAnalogCircuit;

  function _appendWireViewerItems(
    items: MenuItem[],
    wire: import('../core/circuit.js').Wire,
    compiled: ConcreteCompiledCircuitType | null,
    analogCompiled: AnalogCompiledCircuitType | null,
  ): void {
    let netId: number | undefined;
    let signalName: string;

    if (analogCompiled) {
      netId = analogCompiled.wireToNodeId.get(wire);
      if (netId === undefined) return;
      signalName = `node${netId}`;
      for (const [label, nid] of analogCompiled.labelToNodeId) {
        if (nid === netId) { signalName = label; break; }
      }
    } else {
      netId = compiled!.wireToNetId.get(wire);
      if (netId === undefined) return;
      signalName = netIdToName(compiled!, netId);
    }

    const isWatched = watchedSignals.some(s => s.netId === netId);
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
    ac: ConcreteCompiledAnalogCircuit | null,
  ): void {
    const label = _elementLabel(element);
    const pins = element.getPins();

    // If sim is running with compiled analog data, use precise node mapping
    if (ac) {
      let elementIndex = -1;
      for (const [idx, ce] of ac.elementToCircuitElement) {
        if (ce === element) { elementIndex = idx; break; }
      }
      if (elementIndex < 0) return;

      const analogEl = ac.elements[elementIndex];
      if (!analogEl) return;

      if (items.length > 0) items.push(separator());

      // Per-pin voltage traces — resolve node IDs by pin world position,
      // not by indexing pinNodeIds (which may differ in order from pins,
      // e.g. FET pinNodeIds = [D,G,S] but pins = [G,S,D]).
      for (const pin of pins) {
        const pinLabel = pin.label;
        const wp = pinWorldPosition(element, pin);
        let nodeId: number | undefined;
        for (const [wire, nid] of ac.wireToNodeId) {
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
            if (scopePanels.length > 0) {
              scopePanels[0].panel.addVoltageChannel(nodeId, `${label}.${pinLabel}`);
              scopePanels[0].panel.render();
            } else {
              watchedSignals.push({ name: `${label}.${pinLabel}`, netId: nodeId, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
            }
            viewerPanel?.classList.add('open');
            showViewerTab('timing');
          },
          enabled: true,
        });
      }

      // Element current trace (works for all elements via getElementCurrent)
      items.push({
        label: `Trace Current: ${label}`,
        action: () => {
          if (scopePanels.length > 0) {
            scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
            scopePanels[0].panel.render();
          } else {
            // Need at least one voltage probe to create a scope panel first
            // Add a voltage probe for pin 0, then on next rebuild the current will be available
            const panelIdx = nextPanelIndex();
            const pinNodeIds = (analogEl as unknown as { pinNodeIds: number[] }).pinNodeIds ?? [];
            if (pinNodeIds.length > 0) {
              watchedSignals.push({ name: `${label}.${pins[0]?.label ?? 'pin0'}`, netId: pinNodeIds[0]!, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
              // Now add current to the newly created panel
              if (scopePanels.length > 0) {
                scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
              }
            }
          }
          viewerPanel?.classList.add('open');
          showViewerTab('timing');
        },
        enabled: true,
      });
    } else {
      // Sim not compiled yet — offer to queue voltage probes via watchedSignals
      // These will be wired up when the simulation starts
      if (pins.length === 0) return;
      if (items.length > 0) items.push(separator());

      // For pre-sim, use labelToNodeId which won't be available yet.
      // Queue signal names — rebuildViewers() will resolve them on sim start.
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

    // In analog mode, swap the quick insert list
    if (isAnalogMode()) {
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
    panel: AnalogScopePanel,
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
      const ac = facade.getCoordinator()?.compiled.analog ?? null as ConcreteCompiledAnalogCircuit | null;
      if (ac) {
        const currentItems: MenuItem[] = [];
        const seen = new Set<number>();
        for (const sig of signals) {
          for (let idx = 0; idx < ac.elements.length; idx++) {
            if (seen.has(idx)) continue;
            const analogEl = ac.elements[idx];
            if (!analogEl.pinNodeIds.includes(sig.netId)) continue;
            seen.add(idx);
            const ce = ac.elementToCircuitElement.get(idx);
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
              if (sig) removeSignalFromViewer(sig.netId);
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

    const memEng = facade.getEngine();
    if (memEng?.getState?.() === EngineState.RUNNING) {
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
    palette.setEngineTypeFilter(isAnalogMode() ? 'analog' : null);
    paletteUI.render();
    rebuildInsertMenu();
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
        if (file.name.endsWith('.ctz')) {
          // CircuitJS CTZ format — decompressed text parsed directly
          loaded = parseCtzCircuitFromText(text, registry);
        } else {
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
    const gifEng = facade.getEngine();
    if (!gifEng || gifEng.getState?.() === EngineState.STOPPED) return;
    exportGif(circuit, gifEng).then(blob => {
      downloadBlob(blob, `${circuitBaseName()}.gif`);
    }).catch((err: unknown) => {
      showStatus(`GIF export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  });

  function updateGifMenuState(): void {
    if (gifMenuItem) {
      const gifEng = facade.getEngine();
      const stopped = !gifEng || gifEng.getState?.() === EngineState.STOPPED;
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

  interface EngineSettings {
    snapshotBudgetMb: number;
    oscillationLimit: number;
    currentSpeedScale: number;
    currentScaleMode: 'linear' | 'logarithmic';
  }

  function loadEngineSettings(): EngineSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<EngineSettings>;
        return {
          snapshotBudgetMb: typeof parsed.snapshotBudgetMb === 'number' ? parsed.snapshotBudgetMb : 64,
          oscillationLimit: typeof parsed.oscillationLimit === 'number' ? parsed.oscillationLimit : 1000,
          currentSpeedScale: typeof parsed.currentSpeedScale === 'number' ? parsed.currentSpeedScale : 200,
          currentScaleMode: parsed.currentScaleMode === 'logarithmic' ? 'logarithmic' : 'linear',
        };
      }
    } catch { /* ignore */ }
    return { snapshotBudgetMb: 64, oscillationLimit: 1000, currentSpeedScale: 200, currentScaleMode: 'linear' };
  }

  function saveEngineSettings(settings: EngineSettings): void {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  // Apply saved settings on startup
  const initialEngineSettings = loadEngineSettings();
  (facade.getEngine() as unknown as { setSnapshotBudget?(n: number): void } | null)?.setSnapshotBudget?.(initialEngineSettings.snapshotBudgetMb * 1024 * 1024);

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

  function applyCurrentVizSettings(s: EngineSettings): void {
    if (currentFlowAnimator) {
      currentFlowAnimator.setSpeedScale(s.currentSpeedScale);
      currentFlowAnimator.setScaleMode(s.currentScaleMode);
    }
  }

  function openSettingsDialog(): void {
    const s = loadEngineSettings();
    if (snapshotBudgetInput) snapshotBudgetInput.value = String(s.snapshotBudgetMb);
    if (oscillationLimitInput) oscillationLimitInput.value = String(s.oscillationLimit);
    if (currentSpeedInput) currentSpeedInput.value = String(s.currentSpeedScale);
    if (currentScaleSelect) currentScaleSelect.value = s.currentScaleMode;
    // Logic family: find which preset matches the current circuit config
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
    const newSettings: EngineSettings = { snapshotBudgetMb: budgetMb, oscillationLimit: oscLimit, currentSpeedScale: speedScale, currentScaleMode: scaleMode };
    saveEngineSettings(newSettings);
    (facade.getEngine() as unknown as { setSnapshotBudget?(n: number): void } | null)?.setSnapshotBudget?.(budgetMb * 1024 * 1024);
    applyCurrentVizSettings(newSettings);
    // Apply logic family to circuit metadata (only invalidate if changed)
    if (logicFamilySelect) {
      const preset = getLogicFamilyPreset(logicFamilySelect.value);
      if (preset) {
        const prev = circuit.metadata.logicFamily;
        const changed = !prev || prev.name !== preset.name;
        circuit.metadata.logicFamily = preset;
        if (changed) invalidateCompiled();
      }
    }
    closeSettingsDialog();
    showStatus(`Settings saved.`);
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
      const f = palette.getEngineTypeFilter();
      label.textContent = f === 'analog' ? 'Analog' : f === 'digital' ? 'Digital' : 'Auto';
    }
  }

  document.getElementById('btn-circuit-mode')?.addEventListener('click', () => {
    const current = palette.getEngineTypeFilter();
    // Cycle: null (auto) → digital → analog → null (auto)
    const next: "digital" | "analog" | null =
      current === null ? 'digital' : current === 'digital' ? 'analog' : null;
    palette.setEngineTypeFilter(next === 'analog' ? 'analog' : next === 'digital' ? 'digital' : null);
    paletteUI.render();
    rebuildInsertMenu();
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

        const seqEng = facade.getEngine();
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
  // postMessage adapter
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
        const engine = facade.getEngine();
        if (engine) {
          facade.step(engine);
          scheduleRender();
        }
      },
      setInput: (label: string, value: number) => {
        const engine = facade.getEngine();
        if (engine) {
          facade.setInput(engine, label, value);
          scheduleRender();
        }
      },
      readOutput: (label: string) => {
        const engine = facade.getEngine();
        if (!engine) throw new Error('No simulation running');
        return facade.readOutput(engine, label);
      },
      readAllSignals: () => {
        const engine = facade.getEngine();
        if (!engine) throw new Error('No simulation running');
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
        scheduleRender();
        if (durationMs > 0) {
          setTimeout(() => {
            selection.clear();
            scheduleRender();
          }, durationMs);
        }
      },
      clearHighlight: () => {
        selection.clear();
        scheduleRender();
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
      // Resize all scope canvases to fill new height
      for (const sp of scopePanels) {
        sizeCanvasInContainer(sp.canvas);
      }
      scheduleRender();
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
      circuit, viewport, canvas, palette, registry, facade.getCoordinator() ?? null,
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
