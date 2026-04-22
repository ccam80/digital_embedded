/**
 * Tutorial step state machine — pure logic, no DOM dependencies.
 *
 * Drives a TutorialManifest through its steps, managing:
 *   - Palette restriction per step
 *   - Circuit loading (empty, carry-forward, or XML)
 *   - Locked / highlighted components
 *   - Step validation (test-vectors, compile-only, manual, equivalence fallback)
 *   - Progressive hint reveal
 *   - Progress persistence in localStorage
 */

import type {
  TutorialManifest,
  TutorialStep,
  TutorialProgress,
  StepProgress,
} from './types.js';
import { resolvePaletteSpec } from './presets.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface TestResult {
  passed: number;
  failed: number;
  total: number;
  message?: string;
}

export interface TutorialCallbacks {
  setPalette(components: string[] | null): void;
  /** Load a circuit from raw XML string. */
  loadCircuitXml(xml: string): Promise<void> | void;
  /** Load a circuit from a URL (relative to tutorial base path). */
  loadCircuitFromUrl(url: string): Promise<void> | void;
  /** Build and load a circuit from a TutorialCircuitSpec. */
  loadCircuitSpec(spec: import('./types.js').TutorialCircuitSpec): Promise<void> | void;
  loadEmptyCircuit(): void;
  /** Returns the current circuit state as base64 dig XML. */
  getCircuitSnapshot(): string;
  setReadonlyComponents(labels: string[] | null): void;
  highlight(labels: string[], durationMs: number): void;
  runTests(testData: string): Promise<TestResult>;
  /**
   * Pre-check: compile the circuit and verify that all required signal labels
   * from the test data header are present. Returns { ok, error? }.
   */
  precheck(testData: string): { ok: boolean; error?: string };
  compile(): { ok: boolean; error?: string };
  /** Load a goal/solution circuit (for explore-mode "Show Solution"). */
  loadSolution?(goalCircuit: import('./types.js').TutorialCircuitSpec | string): Promise<void> | void;
  postToParent(msg: unknown): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HIGHLIGHT_DEFAULT_MS = 3000;
const STORAGE_KEY_PREFIX = 'tutorial-progress-';

function storageKey(tutorialId: string): string {
  return `${STORAGE_KEY_PREFIX}${tutorialId}`;
}

function now(): string {
  return new Date().toISOString();
}

function makeStepProgress(stepId: string): StepProgress {
  return {
    stepId,
    completed: false,
    completedAt: null,
    hintsRevealed: 0,
    circuitSnapshot: null,
  };
}

function initProgress(manifest: TutorialManifest): TutorialProgress {
  return {
    tutorialId: manifest.id,
    currentStepIndex: 0,
    steps: manifest.steps.map(s => makeStepProgress(s.id)),
    lastActivityAt: now(),
  };
}

function loadProgress(manifest: TutorialManifest): TutorialProgress {
  try {
    const raw = localStorage.getItem(storageKey(manifest.id));
    if (raw) {
      const parsed = JSON.parse(raw) as TutorialProgress;
      // Reconcile: ensure every step has a progress entry (manifest may have grown)
      const stepMap = new Map(parsed.steps.map(s => [s.stepId, s]));
      const steps = manifest.steps.map(s => stepMap.get(s.id) ?? makeStepProgress(s.id));
      return { ...parsed, steps };
    }
  } catch (e) {
    // Corrupted localStorage entry or unavailable storage — surface the
    // anomaly and fall through to fresh init. Per
    // spec/i1-suppression-backlog.md §4.2 replaced prior silent swallow.
    console.warn(`[tutorial-runner] Failed to load progress for "${manifest.id}"; starting fresh.`, e);
  }
  return initProgress(manifest);
}

function saveProgress(progress: TutorialProgress): void {
  try {
    progress.lastActivityAt = now();
    localStorage.setItem(storageKey(progress.tutorialId), JSON.stringify(progress));
  } catch (e) {
    // localStorage quota exceeded or unavailable — surface the anomaly.
    // Per spec/i1-suppression-backlog.md §4.2 replaced prior silent swallow.
    console.warn(`[tutorial-runner] Failed to save progress for "${progress.tutorialId}".`, e);
  }
}

// ---------------------------------------------------------------------------
// TutorialRunner
// ---------------------------------------------------------------------------

export class TutorialRunner {
  private readonly _manifest: TutorialManifest;
  private readonly _callbacks: TutorialCallbacks;
  private _progress: TutorialProgress;

  constructor(manifest: TutorialManifest, callbacks: TutorialCallbacks) {
    this._manifest = manifest;
    this._callbacks = callbacks;
    this._progress = loadProgress(manifest);
  }

  // ---- Getters ----------------------------------------------------------------

  get manifest(): TutorialManifest {
    return this._manifest;
  }

  get currentStepIndex(): number {
    return this._progress.currentStepIndex;
  }

  get currentStep(): TutorialStep {
    return this._manifest.steps[this._progress.currentStepIndex];
  }

  get stepCount(): number {
    return this._manifest.steps.length;
  }

  get progress(): TutorialProgress {
    return this._progress;
  }

  // ---- Navigation -------------------------------------------------------------

  /**
   * Navigate to a step by index.
   *
   * Before leaving the current step, captures a circuit snapshot (for
   * carry-forward). Then applies the new step's palette, start circuit,
   * locked components, and highlights.
   */
  async goToStep(index: number): Promise<void> {
    if (index < 0 || index >= this._manifest.steps.length) return;

    // Capture snapshot of the step we're leaving (for carry-forward)
    const leavingProgress = this._currentStepProgress();
    if (leavingProgress) {
      leavingProgress.circuitSnapshot = this._callbacks.getCircuitSnapshot();
    }

    this._progress.currentStepIndex = index;
    saveProgress(this._progress);

    const step = this._manifest.steps[index];
    const cb = this._callbacks;

    // 1. Palette
    cb.setPalette(resolvePaletteSpec(step.palette));

    // 2. Start circuit
    await this._loadStartCircuit(step, index);

    // 3. Locked components
    cb.setReadonlyComponents(step.lockedComponents ?? null);

    // 4. Highlights
    if (step.highlight && step.highlight.length > 0) {
      cb.highlight(step.highlight, HIGHLIGHT_DEFAULT_MS);
    }

    // 5. Notify parent
    cb.postToParent({
      type: 'sim-tutorial-step-changed',
      stepIndex: index,
      stepId: step.id,
      title: step.title,
    });
  }

  /** Move to the next step. For guided steps, gated on current step completion. */
  async next(): Promise<void> {
    const step = this.currentStep;
    const mode = step.mode ?? 'guided';
    if (mode !== 'explore') {
      const sp = this._currentStepProgress();
      if (sp && !sp.completed) return;
    }
    if (this._progress.currentStepIndex < this._manifest.steps.length - 1) {
      await this.goToStep(this._progress.currentStepIndex + 1);
    }
  }

  /** Move to the previous step (always allowed). */
  async prev(): Promise<void> {
    if (this._progress.currentStepIndex > 0) {
      await this.goToStep(this._progress.currentStepIndex - 1);
    }
  }

  // ---- Validation -------------------------------------------------------------

  /**
   * Run the validation for the current step.
   *
   * Returns `{ passed, message }`. On pass, marks the step completed and
   * persists progress.
   */
  async check(): Promise<{ passed: boolean; message: string }> {
    const step = this.currentStep;
    const validation = this._effectiveValidation(step);

    let result: { passed: boolean; message: string };

    switch (validation) {
      case 'test-vectors': {
        const testData = step.testData ?? '';
        const tr = await this._callbacks.runTests(testData);
        const passed = tr.failed === 0 && tr.total > 0;
        result = {
          passed,
          message: tr.message ?? (passed
            ? `All ${tr.total} tests passed.`
            : `${tr.failed} of ${tr.total} tests failed.`),
        };
        break;
      }

      case 'compile-only': {
        const cr = this._callbacks.compile();
        result = {
          passed: cr.ok,
          message: cr.ok ? 'Circuit compiles successfully.' : (cr.error ?? 'Compilation failed.'),
        };
        break;
      }

      case 'equivalence':
        // Equivalence checking requires the goal circuit to be loaded as a
        // reference engine — not supported in-iframe. Fall back to test-vectors
        // if testData is available, otherwise treat as compile-only.
        if (step.testData) {
          const tr = await this._callbacks.runTests(step.testData);
          const passed = tr.failed === 0 && tr.total > 0;
          result = {
            passed,
            message: tr.message ?? (passed
              ? `All ${tr.total} tests passed.`
              : `${tr.failed} of ${tr.total} tests failed.`),
          };
        } else {
          const cr = this._callbacks.compile();
          result = {
            passed: cr.ok,
            message: cr.ok
              ? 'Circuit compiles successfully.'
              : (cr.error ?? 'Compilation failed.'),
          };
        }
        break;

      case 'manual':
      default:
        result = { passed: true, message: 'Step marked as complete.' };
        break;
    }

    if (result.passed) {
      const sp = this._currentStepProgress();
      if (sp && !sp.completed) {
        sp.completed = true;
        sp.completedAt = now();
        saveProgress(this._progress);
      }
    }

    this._callbacks.postToParent({
      type: 'sim-tutorial-check-result',
      stepIndex: this._progress.currentStepIndex,
      passed: result.passed,
      message: result.message,
    });

    return result;
  }

  /**
   * Pre-check: compile the circuit and verify that the required signal labels
   * from the test data are present. Does NOT run full test vectors — just
   * confirms the circuit is structurally ready to be tested.
   *
   * Only meaningful for steps with test-vectors validation.
   */
  precheck(): { ok: boolean; message: string } {
    const step = this.currentStep;
    const testData = step.testData;
    if (!testData) {
      return { ok: false, message: 'No test data for this step.' };
    }
    const result = this._callbacks.precheck(testData);
    return {
      ok: result.ok,
      message: result.ok ? 'Pre-check passed — labels and compilation OK.' : (result.error ?? 'Pre-check failed.'),
    };
  }

  /**
   * Load the goal/solution circuit for the current step (explore mode).
   * Returns true if a solution was available and loaded.
   */
  async loadSolution(): Promise<boolean> {
    const step = this.currentStep;
    const goal = step.goalCircuit;
    if (!goal || !this._callbacks.loadSolution) return false;
    await this._callbacks.loadSolution(goal);
    return true;
  }

  // ---- Hints ------------------------------------------------------------------

  /**
   * Reveal the next hint for the current step.
   *
   * Increments `hintsRevealed` and returns the hint content string, or `null`
   * if all hints have already been revealed (or there are none).
   */
  revealHint(): string | null {
    const step = this.currentStep;
    const hints = step.hints ?? [];
    const sp = this._currentStepProgress();
    if (!sp) return null;

    const nextIndex = sp.hintsRevealed;
    if (nextIndex >= hints.length) return null;

    sp.hintsRevealed = nextIndex + 1;
    saveProgress(this._progress);
    return hints[nextIndex].content;
  }

  // ---- Lifecycle --------------------------------------------------------------

  /** Persist progress and release resources. */
  dispose(): void {
    saveProgress(this._progress);
  }

  // ---- Private helpers --------------------------------------------------------

  private _currentStepProgress(): StepProgress | undefined {
    return this._progress.steps[this._progress.currentStepIndex];
  }

  /**
   * Determine the effective validation mode for a step, applying the default
   * logic: "test-vectors" if testData is present, "manual" otherwise.
   */
  private _effectiveValidation(step: TutorialStep): NonNullable<TutorialStep['validation']> {
    if (step.validation) return step.validation;
    return step.testData ? 'test-vectors' : 'manual';
  }

  /**
   * Load the start circuit for a step.
   *
   * - `null` / `undefined` → empty canvas
   * - `"carry-forward"` → load previous step's snapshot (base64 → XML, or empty)
   * - `TutorialCircuitSpec` → build via loadCircuitSpec callback
   * - `string` → file path, fetch via loadCircuitFromUrl callback
   */
  private async _loadStartCircuit(step: TutorialStep, stepIndex: number): Promise<void> {
    const sc = step.startCircuit;
    const cb = this._callbacks;

    if (sc === null || sc === undefined) {
      cb.loadEmptyCircuit();
      return;
    }

    if (sc === 'carry-forward') {
      const prevIndex = stepIndex - 1;
      const prevSnapshot = prevIndex >= 0
        ? this._progress.steps[prevIndex]?.circuitSnapshot
        : null;
      if (prevSnapshot) {
        // Snapshot is base64-encoded .dig XML
        const xml = atob(prevSnapshot);
        await cb.loadCircuitXml(xml);
      } else {
        cb.loadEmptyCircuit();
      }
      return;
    }

    if (typeof sc === 'string') {
      // .dig file path — delegate to URL-based loader
      await cb.loadCircuitFromUrl(sc);
      return;
    }

    // TutorialCircuitSpec object — build and load
    await cb.loadCircuitSpec(sc);
  }
}
