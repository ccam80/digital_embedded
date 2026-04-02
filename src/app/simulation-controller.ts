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
import type { CompiledCircuitUnified, SignalValue } from '../compile/types.js';
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
  /**
   * Hot-recompile: if the sim is running, snapshot signals, recompile,
   * restore surviving signals, and resume. If not running, delegates to
   * invalidateCompiled().
   */
  hotRecompile(): void;
  startSimulation(): void;
  stopSimulation(): void;
  /** Pause simulation without destroying compiled state (resumable). */
  pauseSimulation(): void;
  isSimActive(): boolean;
  loadEngineSettings(): EngineSettings;
  saveEngineSettings(settings: EngineSettings): void;
  applyCurrentVizSettings(s: EngineSettings): void;
  /** Sync the speed display DOM elements to the current coordinator speed. */
  updateSpeedDisplay(): void;
  /** Sync the play/pause button icon to the current engine state. */
  updateRunButtonIcon(): void;
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
          renderPipeline.populateDiagnosticOverlays(allDiags, wireToNodeId);
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
  // hotRecompile — recompile without killing a running simulation
  // -------------------------------------------------------------------------

  function hotRecompile(): void {
    const coordinator = facade.getCoordinator();
    const wasRunning = coordinator.getState() === EngineState.RUNNING;

    // If sim isn't running, nothing to preserve — just invalidate.
    if (!wasRunning) {
      invalidateCompiled();
      return;
    }

    // 1. Snapshot all signal state by stable keys (labels + pins).
    const savedLabels = new Map<string, SignalValue>();
    for (const [label, addr] of coordinator.compiled.labelSignalMap) {
      try { savedLabels.set(label, coordinator.readSignal(addr)); } catch { /* skip */ }
    }

    const savedPins = new Map<string, SignalValue>();
    const fullUnified = coordinator.compiled as unknown as CompiledCircuitUnified;
    if (fullUnified.pinSignalMap) {
      for (const [pinKey, addr] of fullUnified.pinSignalMap) {
        try { savedPins.set(pinKey, coordinator.readSignal(addr)); } catch { /* skip */ }
      }
    }

    const savedSimTime = coordinator.simTime;

    // 2. Pause the render loop (don't destroy state yet).
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    coordinator.stop();

    // 3. Recompile. On failure, fall back to full invalidation.
    if (!compileAndBind()) {
      ctx.showStatus('Quick restart after making changes failed, trying a more serious reset', true);
      invalidateCompiled();
      return;
    }

    // 4. Restore surviving signals in the new coordinator.
    const newCoordinator = facade.getCoordinator();
    const newCompiled = newCoordinator.compiled as unknown as CompiledCircuitUnified;

    // Restore labeled signals.
    for (const [label, value] of savedLabels) {
      const addr = newCompiled.labelSignalMap.get(label);
      if (addr) {
        try { newCoordinator.writeSignal(addr, value); } catch { /* net gone or type mismatch */ }
      }
    }

    // Restore pin-level signals (covers unlabeled components too).
    if (newCompiled.pinSignalMap) {
      for (const [pinKey, value] of savedPins) {
        const addr = newCompiled.pinSignalMap.get(pinKey);
        if (addr) {
          try { newCoordinator.writeSignal(addr, value); } catch { /* pin gone or type mismatch */ }
        }
      }
    }

    // Restore sim time if analog is present.
    if (savedSimTime !== null) {
      (newCoordinator as unknown as { setSimTime(t: number): void }).setSimTime(savedSimTime);
    }

    // 5. Resume.
    startSimulation();
  }

  // -------------------------------------------------------------------------
  // Simulation loop
  // -------------------------------------------------------------------------

  let _lastSpeedWarningTime = 0;
  let _stepByGoal: number | null = null;

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
        const stepStart = performance.now();
        if (frame.simTimeGoal !== null) {
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
          facade.step(coordinator);
        }
        // Speed warning: detect when we couldn't keep up with the target
        if (frame.simTimeGoal !== null && coordinator.simTime! < frame.simTimeGoal) {
          const now2 = performance.now();
          if (now2 - _lastSpeedWarningTime > 2000) {
            _lastSpeedWarningTime = now2;
            ctx.showStatus('Simulation running slower than requested speed');
          }
        } else if (_lastSpeedWarningTime > 0) {
          _lastSpeedWarningTime = 0;
          ctx.clearStatus();
        }
      } catch (err) {
        ctx.showStatus(`Simulation error: ${err instanceof Error ? err.message : String(err)}`, true);
        stopSimulation();
        return;
      }

      _updateAnalogVisualization(coordinator, wallDt);

      // Auto-pause at step-to goal
      if (_stepByGoal !== null && coordinator.simTime !== null && coordinator.simTime >= _stepByGoal) {
        _stepByGoal = null;
        coordinator.syncTimeTarget();
        pauseSimulation();
        return;
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

    _activateAnalogVisualization(coordinator);

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
    speedInput.value = fmt.value;
    if (speedUnitEl) speedUnitEl.textContent = fmt.unit;
  }

  speedInput?.addEventListener('change', () => {
    facade.getCoordinator().parseSpeed(speedInput.value);
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-down')?.addEventListener('click', () => {
    facade.getCoordinator().adjustSpeed(0.1);
    updateSpeedDisplay();
  });

  document.getElementById('btn-speed-up')?.addEventListener('click', () => {
    facade.getCoordinator().adjustSpeed(10);
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
    stopSimulation();
    binding.unbind();
    facade.invalidate();
    ctx.compiledDirty = true;
    ctx.clearStatus();
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

  // -------------------------------------------------------------------------
  // Play/Pause toggle
  // -------------------------------------------------------------------------

  const runBtn = document.getElementById('btn-tb-run') as HTMLButtonElement | null;

  function updateRunButtonIcon(): void {
    if (!runBtn) return;
    if (isSimActive()) {
      runBtn.innerHTML = '&#10074;&#10074;';  // ❚❚ pause
      runBtn.title = 'Pause simulation';
    } else {
      runBtn.innerHTML = '&#9654;';  // ▶ play
      runBtn.title = 'Start simulation';
    }
  }

  function pauseSimulation(): void {
    if (runRafHandle !== -1) {
      cancelAnimationFrame(runRafHandle);
      runRafHandle = -1;
    }
    facade.getCoordinator().stop();
    updateRunButtonIcon();
    renderPipeline.scheduleRender();
  }

  runBtn?.addEventListener('click', () => {
    if (isSimActive()) {
      pauseSimulation();
    } else {
      if (!ctx.ensureCompiled()) return;
      startSimulation();
      updateRunButtonIcon();
    }
  });

  // Stop = destructive reset
  document.getElementById('btn-tb-stop')?.addEventListener('click', () => {
    document.getElementById('btn-stop')?.click();
    updateRunButtonIcon();
  });

  // -------------------------------------------------------------------------
  // Step-by dropdown
  // -------------------------------------------------------------------------

  let currentStepDelta = 1e-3; // default 1ms
  const stepByLabel = document.getElementById('step-by-label');
  const stepDropdown = document.getElementById('step-dropdown');

  // Step-to: advance at current speed, auto-pause at goal
  document.getElementById('btn-step-to')?.addEventListener('click', () => {
    _executeStepTo(currentStepDelta);
  });

  // Time dropdown toggle
  document.getElementById('btn-step-time')?.addEventListener('click', () => {
    stepDropdown?.classList.toggle('open');
  });

  // Fast-forward: reach target time as fast as possible
  document.getElementById('btn-step-ff')?.addEventListener('click', () => {
    _executeStepFf(currentStepDelta);
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (stepDropdown?.classList.contains('open') &&
        !(e.target as HTMLElement)?.closest('.step-dropdown-container')) {
      stepDropdown.classList.remove('open');
    }
  });

  // Preset click handler — selects time only, does not step
  stepDropdown?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.step-preset') as HTMLElement | null;
    if (!target) return;

    // Custom toggle
    if (target.id === 'step-custom-toggle') {
      const row = document.getElementById('step-custom-row');
      if (row) row.style.display = row.style.display === 'none' ? 'block' : 'none';
      return;
    }

    const timeStr = target.dataset.time;
    if (!timeStr) return;

    currentStepDelta = parseFloat(timeStr);
    if (stepByLabel) stepByLabel.textContent = target.textContent ?? '';
    stepDropdown.classList.remove('open');
  });

  // Custom input
  document.getElementById('step-custom-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target as HTMLInputElement;
    const delta = parseTimeValue(input.value);
    if (delta <= 0 || !isFinite(delta)) {
      ctx.showStatus(`Invalid time: "${input.value}". Use SI suffixes: 1m, 100u, 1n.`, true);
      return;
    }
    currentStepDelta = delta;
    if (stepByLabel) stepByLabel.textContent = input.value;
    stepDropdown?.classList.remove('open');
  });

  /** Step-to: advance at current speed via the render loop, auto-pause at goal. */
  function _executeStepTo(delta: number): void {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    const currentTime = coordinator.simTime ?? 0;
    _stepByGoal = currentTime + delta;
    coordinator.syncTimeTarget();
    coordinator.addTimeBreakpoint(_stepByGoal);
    if (coordinator.getState() !== EngineState.RUNNING) {
      startSimulation();
      updateRunButtonIcon();
    }
  }

  /** Fast-forward: reach target time as fast as possible, then restore prior state. */
  async function _executeStepFf(delta: number): Promise<void> {
    if (!ctx.ensureCompiled()) return;
    const coordinator = facade.getCoordinator();
    const wasRunning = coordinator.getState() === EngineState.RUNNING;
    if (!wasRunning) {
      startSimulation();
      updateRunButtonIcon();
    }
    const currentTime = coordinator.simTime ?? 0;
    try {
      await coordinator.stepToTime(currentTime + delta);
      coordinator.syncTimeTarget();
      ctx.clearStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.showStatus(`Simulation error: ${msg}`, true);
    }
    if (!wasRunning) {
      pauseSimulation();
    }
    renderPipeline.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Return controller interface
  // -------------------------------------------------------------------------

  return {
    compileAndBind,
    invalidateCompiled,
    hotRecompile,
    startSimulation,
    stopSimulation,
    pauseSimulation,
    isSimActive,
    loadEngineSettings,
    saveEngineSettings,
    applyCurrentVizSettings,
    updateSpeedDisplay,
    updateRunButtonIcon,
    get activeSliderPanel() { return activeSliderPanel; },
    set activeSliderPanel(v) { activeSliderPanel = v; },
  };
}
