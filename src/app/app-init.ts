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
import { initMenuAndToolbar, applyColorScheme } from './menu-toolbar.js';

import { createDefaultRegistry } from '../components/register-all.js';
import { Circuit } from '../core/circuit.js';
import { ComponentPalette } from '../editor/palette.js';
import { PaletteUI } from '../editor/palette-ui.js';
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
import { darkColorScheme, lightColorScheme } from '../core/renderer-interface.js';
import { LockedModeGuard } from '../editor/locked-mode.js';
import { ColorSchemeManager } from '../editor/color-scheme.js';
import { ContextMenu } from '../editor/context-menu.js';
import type { ClipboardData } from '../editor/edit-operations.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { loadAllSubcircuits } from '../io/subcircuit-store.js';
import { loadWithSubcircuits } from '../io/subcircuit-loader.js';
import { PostMessageAdapter } from '../io/postmessage-adapter.js';
import { TutorialRunner } from './tutorial/tutorial-runner.js';
import { TutorialBar } from './tutorial/tutorial-bar.js';
import { TutorialShelf } from './tutorial/tutorial-shelf.js';
import { isTutorialManifest } from './tutorial/types.js';
import type { TutorialManifest } from './tutorial/types.js';
import { createTestBridge } from './test-bridge.js';
import { DefaultSimulatorFacade } from '../headless/default-facade.js';
import { createEditorBinding } from '../integration/editor-binding.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import type { AcParams } from '../solver/analog/ac-analysis.js';
import { initViewerController } from './viewer-controller.js';
import type { ViewerController } from './viewer-controller.js';
import { BodePlotRenderer } from '../runtime/bode-plot.js';
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

  // -------------------------------------------------------------------------
  // Engine + binding
  // -------------------------------------------------------------------------

  const facade = new DefaultSimulatorFacade(registry);
  const binding = createEditorBinding();
  let compiledDirty = true;

  // Tutorial runner state (created on sim-load-tutorial)
  let activeTutorialRunner: TutorialRunner | null = null;
  let activeTutorialBar: TutorialBar | null = null;
  let activeTutorialShelf: TutorialShelf | null = null;

  // isSimActive, compileAndBind, invalidateCompiled — delegated to simController (set up below)

  // -------------------------------------------------------------------------
  // Render pipeline — canvas sizing, render loop, coordinate helpers
  // -------------------------------------------------------------------------

  // renderPipeline is initialized after the AppContext object is built below.
  let renderPipeline!: RenderPipeline;

  // -------------------------------------------------------------------------
  // Interaction state
  // -------------------------------------------------------------------------

  let clipboard: ClipboardData = { entries: [], wires: [] };
  let lastWorldPt: Point = { x: 0, y: 0 };

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

      if (bodePanel && bodeCanvas) {
        bodePanel.style.display = 'block';
        renderPipeline.sizeCanvasInContainer(bodeCanvas);
        const ctx = bodeCanvas.getContext('2d');
        if (ctx) {
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
          const magRange = magMax - magMin || 20;
          magMin -= magRange * 0.1;
          magMax += magRange * 0.1;
          const phaseRange = phaseMax - phaseMin || 90;
          phaseMin -= phaseRange * 0.1;
          phaseMax += phaseRange * 0.1;

          const bodeViewport: BodeViewport = {
            x: 0, y: 0,
            width: bodeCanvas.width, height: bodeCanvas.height,
            fMin: fStart, fMax: fStop,
            magMin, magMax,
            phaseMin, phaseMax,
          };
          ctx.clearRect(0, 0, bodeCanvas.width, bodeCanvas.height);
          bodeRenderer.render(ctx, result, bodeViewport);
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

  // ---------------------------------------------------------------------------
  // SimulationController forward declaration — initialized after renderPipeline.
  // ---------------------------------------------------------------------------

  let simController: SimulationController = null!;
  let viewerController: ViewerController = null!;

  function invalidateCompiled(): void { simController.invalidateCompiled(); }
  function compileAndBind(): boolean { return simController.compileAndBind(); }
  function isSimActive(): boolean { return simController.isSimActive(); }

  // ---------------------------------------------------------------------------
  // AppContext — shared state object passed to extracted sub-modules
  // ---------------------------------------------------------------------------

  let fileIOController = null! as ReturnType<typeof initFileIOController>;

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
    clipboard: { entries: [], wires: [] } as ClipboardData,
    lastWorldPt: { x: 0, y: 0 },

    // URL params & environment
    params,
    isIframe,
    get httpResolver() { return fileIOController.httpResolver; },

    // Helper methods
    scheduleRender(): void { renderPipeline.scheduleRender(); },
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
    applyLoadedCircuit(loaded: Circuit): void {
      fileIOController.applyLoadedCircuit(loaded);
    },
    setCircuit(c: Circuit): void { circuit = c; },
    getCircuit(): Circuit { return circuit; },
  };

  // Initialize render pipeline
  renderPipeline = initRenderPipeline(ctx, search);

  // Initialize viewer controller
  viewerController = initViewerController(ctx, renderPipeline);

  // Initialize simulation controller
  simController = initSimulationController(ctx, renderPipeline, {
    disposeViewers(): void { viewerController.disposeViewers(); },
    rebuildViewersIfOpen(): void {
      viewerController.resolveWatchedSignalAddresses(facade.getCoordinator().compiled);
    },
  });

  // Initialize file I/O controller
  fileIOController = initFileIOController(ctx, {
    onCircuitLoaded(): void { menuToolbar.rebuildInsertMenu(); },
  });

  // Initialize canvas interaction
  const canvasInteraction = initCanvasInteraction(ctx, renderPipeline, simController, {
    startSimulation(): void { simController.startSimulation(); },
    stopSimulation(): void { simController.stopSimulation(); },
    compileAndBind(): boolean { return simController.compileAndBind(); },
  });

  // Initialize menu and toolbar
  const menuToolbar = initMenuAndToolbar(
    ctx,
    simController,
    viewerController,
    canvasInteraction,
    renderPipeline,
    appSettings,
  );

  // Register all keyboard shortcuts
  initKeyboardHandler(ctx, {
    startSimulation(): void { simController.startSimulation(); },
    stopSimulation(): void { simController.stopSimulation(); },
    invalidateCompiled,
    closePopup(): void { canvasInteraction.closePopup(); },
    openSearchBar(): void { menuToolbar.openSearchBar(); },
    togglePresentation(): void { menuToolbar.togglePresentation(); },
    exitPresentation(): void { menuToolbar.exitPresentation(); },
    isPresentationMode(): boolean { return menuToolbar.isPresentationMode(); },
    navigateBack(): boolean { canvasInteraction.navigateBack(); return canvasInteraction.circuitStack.length >= 0; },
    updateZoomDisplay(): void { menuToolbar.updateZoomDisplay(); },
    clearDragMode(): void { /* dragMode is now owned by CanvasInteraction */ },
    fileInput: document.getElementById('file-input') as HTMLInputElement | null,
  });

  initAnalysisDialogs(ctx);

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

      // --- Embedded tutorial runner ---
      loadTutorial: (raw: unknown, basePath?: unknown) => {
        if (!isTutorialManifest(raw)) {
          window.parent.postMessage({ type: 'sim-error', error: 'Invalid tutorial manifest' }, '*');
          return;
        }
        const manifest = raw as TutorialManifest;
        const tutorialBasePath = typeof basePath === 'string' ? basePath : '';

        // Dispose previous tutorial runner if any
        if (activeTutorialRunner) {
          activeTutorialRunner.dispose();
          activeTutorialBar?.dispose();
          activeTutorialShelf?.dispose();
        }

        const canvasContainer = document.getElementById('canvas-container')!;
        const workspace = document.getElementById('workspace')!;

        const bar = new TutorialBar(canvasContainer);
        const shelf = new TutorialShelf(workspace, canvasContainer);

        const runner = new TutorialRunner(manifest, {
          setPalette: (components) => {
            palette.setAllowlist(components);
            paletteUI.render();
          },
          loadCircuitXml: (xml) => fileIOController.loadCircuitFromXml(xml),
          loadCircuitFromUrl: async (url) => {
            const fullUrl = tutorialBasePath ? tutorialBasePath + url : url;
            const res = await fetch(fullUrl);
            if (!res.ok) throw new Error(`Failed to fetch circuit: ${fullUrl}`);
            const xml = await res.text();
            await fileIOController.loadCircuitFromXml(xml);
          },
          loadCircuitSpec: async (spec) => {
            const built = facade.build(spec as import('../headless/netlist-types.js').CircuitSpec);
            const xml = serializeCircuitToDig(built, registry);
            await fileIOController.loadCircuitFromXml(xml);
            renderPipeline.scheduleRender();
          },
          loadEmptyCircuit: () => {
            circuit = new Circuit();
            fileIOController.loadCircuitFromXml(serializeCircuitToDig(circuit, registry));
          },
          getCircuitSnapshot: () => {
            return btoa(serializeCircuitToDig(circuit, registry));
          },
          setReadonlyComponents: (labels) => {
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
          highlight: (labels, durationMs) => {
            const labelSet = new Set(labels);
            const toSelect = circuit.elements.filter(
              (el) => labelSet.has(String(el.getProperties().get('label') ?? '')),
            );
            selection.boxSelect(toSelect, []);
            renderPipeline.scheduleRender();
            if (durationMs > 0) {
              setTimeout(() => { selection.clear(); renderPipeline.scheduleRender(); }, durationMs);
            }
          },
          runTests: async (testData) => {
            try {
              const coordinator = facade.compile(circuit);
              const { parseTestData } = await import('../testing/parser.js');
              const { executeTests } = await import('../testing/executor.js');
              const { detectInputCount } = await import('../testing/detect-input-count.js');
              const inputCount = detectInputCount(circuit, registry, testData);
              const parsed = parseTestData(testData, inputCount);
              const results = executeTests(facade as import('../testing/executor.js').RunnerFacade, coordinator, circuit, parsed);
              return { passed: results.passed, failed: results.failed, total: results.total };
            } catch (err) {
              return { passed: 0, failed: 1, total: 1, message: err instanceof Error ? err.message : String(err) };
            }
          },
          precheck: (testData) => {
            // Compile the circuit and verify that signal labels from test header exist
            try {
              facade.compile(circuit);
            } catch (err) {
              return { ok: false, error: `Compilation failed: ${err instanceof Error ? err.message : String(err)}` };
            }
            // Extract expected labels from test data header
            const hdrLine = testData.split('\n').find(
              (l: string) => l.trim().length > 0 && !l.trim().startsWith('#'),
            ) ?? '';
            const hdrNames = hdrLine.trim().split(/\s+/).filter((n: string) => n.length > 0);
            // Collect circuit labels
            const circuitLabels = new Set<string>();
            for (const el of circuit.elements) {
              const lbl = el.getProperties().getOrDefault('label', '') as string;
              if (lbl) circuitLabels.add(lbl);
            }
            const missing = hdrNames.filter((n: string) => !circuitLabels.has(n));
            if (missing.length > 0) {
              return { ok: false, error: `Missing labels: ${missing.join(', ')}. Double-click a component to set its label.` };
            }
            return { ok: true };
          },
          compile: () => {
            try {
              facade.compile(circuit);
              return { ok: true };
            } catch (err) {
              return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          },
          loadSolution: async (goalCircuit) => {
            if (typeof goalCircuit === 'string') {
              const fullUrl = tutorialBasePath ? tutorialBasePath + goalCircuit : goalCircuit;
              const res = await fetch(fullUrl);
              if (!res.ok) throw new Error(`Failed to fetch solution: ${fullUrl}`);
              const xml = await res.text();
              await fileIOController.loadCircuitFromXml(xml);
              renderPipeline.scheduleRender();
              return;
            }
            // TutorialCircuitSpec — build via facade
            const built = facade.build(goalCircuit as import('../headless/netlist-types.js').CircuitSpec);
            const xml = serializeCircuitToDig(built, registry);
            await fileIOController.loadCircuitFromXml(xml);
            renderPipeline.scheduleRender();
          },
          postToParent: (msg) => { window.parent.postMessage(msg, '*'); },
        });

        activeTutorialRunner = runner;
        activeTutorialBar = bar;
        activeTutorialShelf = shelf;

        // Wire bar actions → runner
        bar.onAction(async (action) => {
          switch (action) {
            case 'prev': await runner.prev(); break;
            case 'next': await runner.next(); break;
            case 'check': {
              bar.setCheckState('running');
              const result = await runner.check();
              bar.setCheckState(result.passed ? 'pass' : 'fail');
              // Re-update bar to reflect new completion state
              const sp = runner.progress.steps[runner.currentStepIndex];
              if (sp) bar.update(runner.currentStep, runner.currentStepIndex, runner.stepCount, sp);
              break;
            }
            case 'precheck': {
              const result = runner.precheck();
              if (result.ok) {
                showStatus(result.message);
              } else {
                showStatus(result.message, true);
              }
              break;
            }
            case 'solution': {
              const loaded = await runner.loadSolution();
              if (loaded) bar.setSolutionLoaded();
              break;
            }
          }
        });

        // Wire hint requests from shelf → runner → shelf
        shelf.onHintRequest(() => {
          const content = runner.revealHint();
          if (content !== null) {
            const sp = runner.progress.steps[runner.currentStepIndex];
            shelf.revealHint((sp?.hintsRevealed ?? 1) - 1, content);
          }
        });

        // Update UI on step changes — override goToStep to hook in
        const origGoToStep = runner.goToStep.bind(runner);
        runner.goToStep = async (index: number) => {
          await origGoToStep(index);
          const step = runner.currentStep;
          const sp = runner.progress.steps[runner.currentStepIndex];
          if (sp) {
            bar.update(step, runner.currentStepIndex, runner.stepCount, sp);
            shelf.setContent(step.instructions, step.hints, sp.hintsRevealed);
          }
          renderPipeline.scheduleRender();
        };

        // Load first step (or resume from saved progress)
        const startIndex = runner.progress.currentStepIndex;
        void runner.goToStep(startIndex);

        window.parent.postMessage({
          type: 'sim-tutorial-loaded',
          tutorialId: manifest.id,
          totalSteps: manifest.steps.length,
        }, '*');
      },
      tutorialGoto: (stepIndex: number) => {
        if (activeTutorialRunner) {
          void activeTutorialRunner.goToStep(stepIndex);
        }
      },
    },
  });

  // -------------------------------------------------------------------------
  // Test bridge — exposes coordinate queries for E2E tests
  // -------------------------------------------------------------------------

  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    (window as unknown as Record<string, unknown>).__test = createTestBridge(
      circuit, viewport, canvas, palette, registry, () => facade.getCoordinator(), () => placement,
      () => renderPipeline.state.scopePanels.map(e => e.panel),
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
      window.parent.postMessage({ type: 'sim-loaded' }, '*');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      window.parent.postMessage({ type: 'sim-error', error: msg }, '*');
    }
  }

  async function applyModuleAndLoad(): Promise<void> {
    if (params.module) {
      const result = await loadModuleConfig(params.module, params.base);
      if (result) {
        const { config, moduleBase } = result;
        applyModuleConfig(params, config, moduleBase);

        if (params.palette) {
          palette.setAllowlist(params.palette);
          paletteUI.render();
        }

        (window as unknown as Record<string, unknown>).__moduleConfig = config;
        (window as unknown as Record<string, unknown>).__moduleBase = moduleBase;
      } else {
        console.warn(`Module config not found: modules/${params.module}/config.json`);
      }
    }

    // Load all user-created subcircuits from IndexedDB and register them in
    // the registry so the palette shows them and circuits referencing them compile.
    try {
      const stored = await loadAllSubcircuits();
      for (const entry of stored) {
        await loadWithSubcircuits(entry.xml, ctx.httpResolver, registry);
      }
      if (stored.length > 0) {
        palette.refreshCategories();
        paletteUI.render();
      }
    } catch (err) {
      console.warn('Failed to load stored subcircuits:', err);
    }

    await autoLoadFile();
  }

  applyModuleAndLoad();
}
