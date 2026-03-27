import type { TutorialStep, StepProgress } from './types.js';

type CheckState = 'idle' | 'running' | 'pass' | 'fail';
export type BarAction = 'prev' | 'next' | 'check' | 'precheck' | 'solution';

/**
 * Bottom navigation bar for the tutorial system.
 *
 * Adapts its button layout based on step mode:
 *
 *   **guided** (default):
 *     [Prev] [step] [title] [Pre-check] [Check] [Next]
 *     - Next is gated until the step is completed (tests pass)
 *     - Pre-check verifies compilation + label presence before full test run
 *     - No "Show Solution" button
 *
 *   **explore**:
 *     [Prev] [step] [title] [Check?] [Solution] [Next]
 *     - Next is always enabled (not gated)
 *     - Check is shown only if the step has test data (optional)
 *     - "Show Solution" loads the goal circuit
 */
export class TutorialBar {
  private readonly container: HTMLElement;
  private readonly bar: HTMLDivElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly stepSpan: HTMLSpanElement;
  private readonly titleSpan: HTMLSpanElement;
  private readonly precheckBtn: HTMLButtonElement;
  private readonly checkBtn: HTMLButtonElement;
  private readonly solutionBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;

  private actionCallback: ((action: BarAction) => void) | null = null;
  private revertTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    this.bar = document.createElement('div');
    this.bar.id = 'tutorial-bar';

    this.prevBtn = this._btn('prev', '&lsaquo; Prev');
    this.prevBtn.disabled = true;

    this.stepSpan = document.createElement('span');
    this.stepSpan.className = 'tutorial-bar-step';
    this.stepSpan.textContent = '1 / 1';

    this.titleSpan = document.createElement('span');
    this.titleSpan.className = 'tutorial-bar-title';

    this.precheckBtn = this._btn('precheck', 'Pre-check');
    this.precheckBtn.classList.add('tutorial-bar-precheck');

    this.checkBtn = this._btn('check', 'Check');
    this.checkBtn.classList.add('tutorial-bar-check');

    this.solutionBtn = this._btn('solution', 'Show Solution');
    this.solutionBtn.classList.add('tutorial-bar-solution');

    this.nextBtn = this._btn('next', 'Next &rsaquo;');

    this.bar.append(
      this.prevBtn, this.stepSpan, this.titleSpan,
      this.precheckBtn, this.checkBtn, this.solutionBtn, this.nextBtn,
    );

    this.bar.addEventListener('click', this.handleClick);
    container.classList.add('has-tutorial-bar');
    container.appendChild(this.bar);
  }

  /**
   * Refresh the bar for a new step. Sets button visibility and enabled states
   * based on step mode, validation type, and completion status.
   */
  update(step: TutorialStep, index: number, total: number, progress: StepProgress): void {
    this.stepSpan.textContent = `${index + 1} / ${total}`;
    this.titleSpan.textContent = step.title;

    this.prevBtn.disabled = index === 0;

    const isLast = index === total - 1;
    const isGuided = step.mode === undefined || step.mode === 'guided';
    const validation = step.validation ?? (step.testData ? 'test-vectors' : 'manual');
    const hasTests = validation === 'test-vectors' || validation === 'equivalence';
    const hasGoal = !!step.goalCircuit;

    if (isGuided) {
      // Guided: Pre-check + Check visible, Solution hidden, Next gated
      this.precheckBtn.style.display = hasTests ? '' : 'none';
      this.checkBtn.style.display = '';
      this.checkBtn.textContent = validation === 'manual' ? 'Complete' : 'Check';
      this.solutionBtn.style.display = 'none';
      this.nextBtn.disabled = isLast || !progress.completed;
    } else {
      // Explore: No Pre-check, Check optional, Solution visible, Next free
      this.precheckBtn.style.display = 'none';
      this.checkBtn.style.display = hasTests ? '' : 'none';
      this.checkBtn.textContent = 'Check';
      this.solutionBtn.style.display = hasGoal ? '' : 'none';
      this.solutionBtn.textContent = 'Show Solution';
      this.solutionBtn.classList.remove('loaded');
      this.nextBtn.disabled = isLast;
    }
  }

  setCheckState(state: CheckState): void {
    if (this.revertTimer !== null) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }

    this.checkBtn.classList.remove('pass', 'fail', 'running');
    this.checkBtn.disabled = false;

    switch (state) {
      case 'idle':
        break;
      case 'running':
        this.checkBtn.textContent = 'Checking\u2026';
        this.checkBtn.classList.add('running');
        this.checkBtn.disabled = true;
        break;
      case 'pass':
        this.checkBtn.textContent = 'Passed!';
        this.checkBtn.classList.add('pass');
        this.revertTimer = setTimeout(() => this.setCheckState('idle'), 2000);
        break;
      case 'fail':
        this.checkBtn.textContent = 'Try again';
        this.checkBtn.classList.add('fail');
        this.revertTimer = setTimeout(() => this.setCheckState('idle'), 2000);
        break;
    }
  }

  /** Mark the solution button as loaded (visual feedback). */
  setSolutionLoaded(): void {
    this.solutionBtn.textContent = 'Solution loaded';
    this.solutionBtn.classList.add('loaded');
  }

  onAction(callback: (action: BarAction) => void): void {
    this.actionCallback = callback;
  }

  show(): void { this.bar.style.display = ''; }
  hide(): void { this.bar.style.display = 'none'; }

  dispose(): void {
    if (this.revertTimer !== null) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    this.bar.removeEventListener('click', this.handleClick);
    this.bar.remove();
    this.container.classList.remove('has-tutorial-bar');
    this.actionCallback = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _btn(action: string, html: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'tutorial-bar-btn';
    btn.dataset['action'] = action;
    btn.innerHTML = html;
    return btn;
  }

  private readonly handleClick = (e: MouseEvent): void => {
    if (this.actionCallback === null) return;
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (target === null || (target as HTMLButtonElement).disabled) return;
    const action = target.dataset['action'] as BarAction;
    this.actionCallback(action);
  };
}
