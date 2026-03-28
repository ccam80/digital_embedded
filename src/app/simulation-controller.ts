/**
 * SimulationController — compile/bind, simulation loop, speed control, analog viz.
 *
 * Extracted from app-init.ts (Step 4 of modularization plan).
 * Owns: compileAndBind, invalidateCompiled, startSimulation, stopSimulation,
 * _startRenderLoop, analog visualization, speed control UI, toolbar sim buttons,
 * engine settings (load/save/apply), _friendlyAnalogError.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import { EngineState } from '../core/engine-interface.js';
import { WireCurrentResolver } from '../editor/wire-current-resolver.js';
import type { CompiledCircuitUnified } from '../compile/types.js';
import { CurrentFlowAnimator } from '../editor/current-animation.js';
import { VoltageRangeTracker } from '../editor/voltage-range.js';
import { voltageToColor } from '../editor/voltage-color.js';
import { SliderPanel } from '../editor/slider-panel.js';
import { SliderEngineBridge } from '../editor/slider-engine-bridge.js';
import type { Wire } from '../core/circuit.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const SETTINGS_STORAGE_KEY = 'digital-js:engine-settings';

export interface EngineSettings {
  snapshotBudgetMb: number;
  oscillationLimit: number;
  currentSpeedScale: number;
  currentScaleMode: 'linear' | 'logarithmic';
}

export interface SimulationController {
  compileAndBind(): boolean;
  invalidateCompiled(): void;
  startSimulation(): void;
  stopSimulation(): void;
  isSimActive(): boolean;
  loadEngineSettings(): EngineSettings;
  saveEngineSettings(settings: EngineSettings): void;
  applyCurrentVizSettings(s: EngineSettings): void;
  /** Sync the speed display DOM elements to the current coordinator speed. */
  updateSpeedDisplay(): void;
  /** Exposed for selection onChange and context menu in app-init */
  activeSliderPanel: SliderPanel | null;
}

// ---------------------------------------------------------------------------
// Callbacks passed in from app-init for viewer state that hasn't been
// extracted yet (viewer panels live in app-init until a later step).
// ---------------------------------------------------------------------------

export interface SimControllerCallbacks {
  /** Tear down viewer panels — they hold stale net IDs after recompile. */
  disposeViewers(): void;
  /**
   * Rebuild viewer panels after a successful compile, if the viewer panel is
   * open and there are watched signals.
   */
  rebuildViewersIfOpen(): void;
}

// ---------------------------------------------------------------------------
// parseTimeValue — parse SI time strings like "5m", "100u", "1n" → seconds
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable time string with SI suffixes into seconds.
 * Examples: "5m" → 0.005, "100u" → 0.0001, "1n" → 1e-9, "0.01" → 0.01.
 * Returns NaN for invalid input.
 */
export function parseTimeValue(s: string): number {
  const t = s.trim();
  const suffixes: Record<string, number> = {
    s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12,
    m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12,
  };
  // Try two-char suffix first, then one-char
  for (const suffix of ['ms', 'us', 'ns', 'ps', 's', 'm', 'u', 'n', 'p']) {
    if (t.toLowerCase().endsWith(suffix)) {
      const num = parseFloat(t.slice(0, -suffix.length));
      return isNaN(num) ? NaN : num * suffixes[suffix];
    }
  }
  return parseFloat(t);
}

// ---------------------------------------------------------------------------
// initSimulationController
// ---------------------------------------------------------------------------

export function initSimulationController(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  callbacks: SimControllerCallbacks,
): SimulationController {
  const { facade, binding } = ctx;

  // -------------------------------------------------------------------------
  // Analog state
  // -------------------------------------------------------------------------

  let runRafHandle = -1;
  let _wireCurrentResolver: WireCurrentResolver | null = null;
  const analogVoltageTracker = new VoltageRangeTracker();
  let activeSliderPanel: SliderPanel | null = null;

  // -------------------------------------------------------------------------
  // Engine settings
  // -------------------------------------------------------------------------

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

  function applyCurrentVizSettings(s: EngineSettings): void {
    if (renderPipeline.state.currentFlowAnimator) {
      renderPipeline.state.currentFlowAnimator.setSpeedScale(s.currentSpeedScale);
      renderPipeline.state.currentFlowAnimator.setScaleMode(s.currentScaleMode);
    }
  }

  // Apply saved settings on startup
  const initialEngineSettings = loadEngineSettings();
  (facade.getCoordinator() as unknown as { setSnapshotBudget?(n: number): void } | null)
    ?.setSnapshotBudget?.(initialEngineSettings.snapshotBudgetMb * 1024 * 1024);

  // -------------------------------------------------------------------------
  // Helper: friendly error messages for analog pipeline failures
  // -------------------------------------------------------------------------

  function _friendlyAnalogError(raw: string, circ: import('../core/circuit.js').Circuit): string {
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

    if (raw.includes('unknown component type')) {
      const match = raw.match(/"([^"]+)"/);
      const typeName = match ? match[1] : 'unknown';
      return `Couldn't find the component type "${typeName}" — check that it's ` +
        `registered and spelled correctly.`;
    }

    if (raw.includes('digital-only')) {
      const match = raw.match(/"([^"]+)"/);
      const typeName = match ? match[1] : 'unknown';
      return `"${typeName}" is a digital-only component and can't be used in an analog circuit. ` +
        `Replace it with an analog equivalent or switch to digital mode.`;
    }

    return raw;
  }

  // -------------------------------------------------------------------------
  // Analog visualization
  // -------------------------------------------------------------------------

  function _activateAnalogVisualization(coordinator: SimulationCoordinator): void {
    analogVoltageTracker.reset();
    _wireCurrentResolver = new WireCurrentResolver();
    renderPipeline.state.currentFlowAnimator = new CurrentFlowAnimator(_wireCurrentResolver);
    renderPipeline.state.currentFlowAnimator.setEnabled(true);
    applyCurrentVizSettings(loadEngineSettings());
    ctx.wireRenderer.setVoltageTracker(analogVoltageTracker);

    ctx.elementRenderer.setAnalogContext((element) => {
      const pinVoltages = coordinator.getPinVoltages(element);
      if (!pinVoltages) return undefined;
      const tracker = analogVoltageTracker;
      const scheme = ctx.colorSchemeManager.getActive();
      return {
        getPinVoltage: (pinLabel: string) => pinVoltages.get(pinLabel),
        voltageColor: (voltage: number) => voltageToColor(voltage, tracker, scheme),
      };
    });

    const sliderContainer = document.getElementById('slider-panel');
    if (sliderContainer) {
      sliderContainer.style.display = '';
      activeSliderPanel = new SliderPanel(sliderContainer);
      new SliderEngineBridge(activeSliderPanel, coordinator);
    }
  }

  function _updateAnalogVisualization(coordinator: SimulationCoordinator, wallDt: number): void {
    if (renderPipeline.state.currentFlowAnimator && _wireCurrentResolver) {
      const resolverCtx = coordinator.getCurrentResolverContext();
      if (resolverCtx) _wireCurrentResolver.resolve(resolverCtx);
      renderPipeline.state.currentFlowAnimator.update(wallDt, ctx.getCircuit());
    }
    coordinator.updateVoltageTracking();
    const vRange = coordinator.voltageRange;
    if (vRange !== null) {
      analogVoltageTracker.update(vRange.min, vRange.max);
    }
  }

  function _deactivateAnalogVisualization(): void {
    if (renderPipeline.state.currentFlowAnimator) {
      renderPipeline.state.currentFlowAnimator.setEnabled(false);
      renderPipeline.state.currentFlowAnimator = null;
    }
    _wireCurrentResolver = null;
    ctx.wireRenderer.setVoltageTracker(null);
    ctx.elementRenderer.setAnalogContext(null);
    if (activeSliderPanel) {
      activeSliderPanel.dispose();
      activeSliderPanel = null;
    }
    const sliderContainer = document.getElementById('slider-panel');
    if (sliderContainer) sliderContainer.style.display = 'none';
  }

  function disposeAnalog(): void {
    _deactivateAnalogVisualization();
    facade.invalidate();
  }

  // -------------------------------------------------------------------------
  // isSimActive
  // -------------------------------------------------------------------------

  function isSimActive(): boolean {
    return facade.getCoordinator().getState() === EngineState.RUNNING;
  }

  // -------------------------------------------------------------------------
  // compileAndBind
  // -------------------------------------------------------------------------

  function compileAndBind(): boolean {
    renderPipeline.clearDiagnosticOverlays();

    const circuit = ctx.getCircuit();
    circuit.normalizeWires();

    if (binding.isBound) {
      facade.getCoordinator().stop();
      binding.unbind();
    }
    disposeAnalog();

    try {
      facade.compile(circuit);
      const coordinator = facade.getCoordinator();
      const unified = coordinator.compiled;

      const compileErrors = unified.diagnostics.filter(d => d.severity === 'error');
      const compileWarnings = unified.diagnostics.filter(d => d.severity === 'warning');

      if (compileErrors.length > 0) {
        const combined = compileErrors.map(d => d.message).join(' | ');
        console.error('Compilation diagnostics:', compileErrors);
        ctx.showStatus(`Circuit problem: ${combined}`, true);
      }

      const allDiags = [...compileErrors, ...compileWarnings];
      if (allDiags.length > 0) {
        if (compileWarnings.length > 0) {
          console.warn('Compilation warnings:', compileWarnings.map(d => d.message));
        }
        const resolverCtx = coordinator.getCurrentResolverContext();
        if (resolverCtx !== null) {
          const wireToNodeId = new Map<Wire, number>();
          for (const [wire, addr] of unified.wireSignalMap) {
            if (addr.domain === 'analog') wireToNodeId.set(wire, addr.nodeId);
          }
          renderPipeline.populateDiagnosticOverlays(
            allDiags as unknown as import('../core/analog-engine-interface.js').SolverDiagnostic[],
            wireToNodeId,
          );
        }
        renderPipeline.scheduleRender();
      }

      if (compileErrors.length > 0) {
        facade.invalidate();
        return false;
      }

      // Cast to full CompiledCircuitUnified to access pinSignalMap (the coordinator-types
      // interface only exposes a narrowed ReadonlyMap subset).
      const fullUnified = unified as unknown as CompiledCircuitUnified;
      binding.bind(circuit, coordinator, fullUnified.wireSignalMap, fullUnified.pinSignalMap);

      const dcResult = facade.getDcOpResult();
      ctx.compiledDirty = false;
      if (dcResult && !dcResult.converged) {
        ctx.showStatus('Warning: DC operating point did not converge — results may be inaccurate', true);
      } else {
        ctx.clearStatus();
      }

      callbacks.rebuildViewersIfOpen();

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Compilation failed:', msg, err);
      const friendly = _friendlyAnalogError(msg, ctx.getCircuit());
      ctx.showStatus(`Compilation error: ${friendly}`, true);
      facade.invalidate();
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // invalidateCompiled
  // -------------------------------------------------------------------------

  function invalidateCompiled(): void {
    ctx.compiledDirty = true;
    const eng = facade.getCoordinator();
    if (eng.getState() === EngineState.RUNNING) eng.stop();
    if (binding.isBound) binding.unbind();
    disposeAnalog();
    callbacks.disposeViewers();
    renderPipeline.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Simulation loop
  // -------------------------------------------------------------------------

  function _startRenderLoop(coordinator: SimulationCoordinator): void {
    let lastTime = performance.now();

    const tick = (now: number): void => {
      if (coordinator.getState() !== EngineState.RUNNING) {
        runRafHandle = -1;
        renderPipeline.scheduleRender();
        return;
      }

      const wallDt = (now - lastTime) / 1000;
      lastTime = now;
      const frame = coordinator.computeFrameSteps(wallDt);

      try {
        if (frame.simTimeGoal !== null) {
          const stepStart = performance.now();
          facade.step(coordinator);
          while (coordinator.simTime! < frame.simTimeGoal) {
            if (performance.now() - stepStart > frame.budgetMs) break;
            facade.step(coordinator);
            if (coordinator.getState() === EngineState.ERROR) {
              ctx.showStatus('Simulation error: solver failed to converge', true);
              stopSimulation();
              return;
            }
          }
        } else {
          for (let i = 0; i < frame.steps; i++) {
            facade.step(coordinator);
          }
        }
      } catch (err) {
        ctx.showStatus(`Simulation error: ${err instanceof Error ? err.message : String(err)}`, true);
        stopSimulation();
        return;
      }

      if (coordinator.timingModel !== 'discrete') {
        _updateAnalogVisualization(coordinator, wallDt);
      }

      renderPipeline.scheduleRender();
      runRafHandle = requestAnimationFrame(tick);
    };
    runRafHandle = requestAnimationFrame(tick);
  }

  function startSimulation(): void {
    const coordinator = facade.getCoordinator();
    if (coordinator.getState() === EngineState.RUNNING) return;

    ctx.selection.clear();
    coordinator.start();

    if (coordinator.timingModel !== 'discrete') {
      _activateAnalogVisualization(coordinator);
    }

    _startRenderLoop(coordinator);
  }

  function stopSimulation(): void {
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    facade.getCoordinator().stop();
    renderPipeline.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Speed control UI
  // -------------------------------------------------------------------------

  const speedInput = document.getElementById('speed-input') as HTMLInputElement | null;
  const speedUnitEl = document.querySelector('.speed-unit') as HTMLElement | null;

  function updateSpeedDisplay(): void {
    if (!speedInput) return;
    const fmt = facade.getCoordinator().formatSpeed();
    speedInput.value = String(facade.getCoordinator().speed);
    if (speedUnitEl) speedUnitEl.textContent = fmt.unit;
  }

  document.getElementById('btn-speed-down')?.addEventListener('click', () => {
    facade.getCoordinator().adjustSpeed(0.1);
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-up')?.addEventListener('click', () => {
    facade.getCoordinator().adjustSpeed(10);
    updateSpeedDisplay();
  });

  speedInput?.addEventListener('change', () => {
    facade.getCoordinator().parseSpeed(speedInput.value);
    updateSpeedDisplay();
  });

  // -------------------------------------------------------------------------
  // Toolbar: Step / Run / Stop / Micro-step / Run-to-break
  // -------------------------------------------------------------------------

  document.getElementById('btn-step')?.addEventListener('click', () => {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    if (coordinator.getState() === EngineState.RUNNING) coordinator.stop();
    try {
      facade.step(coordinator);
      ctx.clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.showStatus(`Simulation error: ${msg}`, true);
    }
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-run')?.addEventListener('click', () => {
    if (!ctx.ensureCompiled()) return;
    startSimulation();
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    if (!isSimActive()) return;
    stopSimulation();
    binding.unbind();
    facade.invalidate();
    ctx.compiledDirty = true;
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-micro-step')?.addEventListener('click', () => {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    if (coordinator.supportsMicroStep()) {
      if (coordinator.getState() === EngineState.RUNNING) coordinator.stop();
      try { coordinator.microStep(); ctx.clearStatus(); } catch (err) {
        ctx.showStatus(`Simulation error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    } else {
      try { facade.step(coordinator); ctx.clearStatus(); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.showStatus(`Simulation error: ${msg}`, true);
      }
    }
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-step-to-time')?.addEventListener('click', async () => {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    if (coordinator.getState() === EngineState.RUNNING) coordinator.stop();
    const input = document.getElementById('step-to-time-input') as HTMLInputElement | null;
    const btn = document.getElementById('btn-step-to-time') as HTMLButtonElement | null;
    const raw = input?.value ?? '1m';
    const delta = parseTimeValue(raw);
    if (delta <= 0 || !isFinite(delta)) {
      ctx.showStatus(`Invalid time value: "${raw}". Use SI suffixes: 1m, 100u, 1n.`, true);
      return;
    }
    const currentTime = coordinator.simTime ?? 0;
    if (btn) btn.disabled = true;
    try {
      await coordinator.stepToTime(currentTime + delta);
      ctx.clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.showStatus(`Simulation error: ${msg}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-run-to-break')?.addEventListener('click', () => {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    if (!coordinator.supportsRunToBreak()) {
      ctx.showStatus('Run-to-break is not available for this circuit type');
      return;
    }
    if (coordinator.getState() === EngineState.RUNNING) return;
    try {
      coordinator.runToBreak();
      ctx.clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.showStatus(`Simulation error: ${msg}`, true);
    }
    renderPipeline.scheduleRender();
  });

  // Toolbar mirror buttons
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
  // Return controller interface
  // -------------------------------------------------------------------------

  return {
    compileAndBind,
    invalidateCompiled,
    startSimulation,
    stopSimulation,
    isSimActive,
    loadEngineSettings,
    saveEngineSettings,
    applyCurrentVizSettings,
    updateSpeedDisplay,
    get activeSliderPanel() { return activeSliderPanel; },
    set activeSliderPanel(v) { activeSliderPanel = v; },
  };
}
