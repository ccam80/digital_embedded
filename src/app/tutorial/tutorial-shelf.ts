import { renderMarkdown } from './markdown-renderer.js';
import type { TutorialHint } from './types.js';

/**
 * Pull-out instructions shelf for the tutorial system.
 * Sits in #workspace between the palette and canvas-container.
 * Manages the #tutorial-shelf DOM element.
 */
export class TutorialShelf {
  private shelf: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private collapseBtn: HTMLButtonElement;
  private body: HTMLDivElement;
  private hintsSection: HTMLDivElement;
  private hintBtn: HTMLButtonElement;
  private hintContent: HTMLDivElement;

  private totalHints: number = 0;
  private hintsRevealed: number = 0;
  private hintRequestCallback: (() => void) | null = null;
  private toggleCallback: ((collapsed: boolean) => void) | null = null;

  constructor(workspace: HTMLElement, insertBefore: HTMLElement) {
    this.shelf = document.createElement('div');
    this.shelf.id = 'tutorial-shelf';

    // Header
    const header = document.createElement('div');
    header.className = 'tutorial-shelf-header';

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'tutorial-shelf-title';
    this.titleEl.textContent = 'Instructions';

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.className = 'tutorial-shelf-collapse';
    this.collapseBtn.title = 'Collapse';
    this.collapseBtn.innerHTML = '&lsaquo;';
    this.collapseBtn.addEventListener('click', () => this.toggle());

    header.appendChild(this.titleEl);
    header.appendChild(this.collapseBtn);

    // Body
    this.body = document.createElement('div');
    this.body.className = 'tutorial-shelf-body';

    // Hints section
    this.hintsSection = document.createElement('div');
    this.hintsSection.className = 'tutorial-shelf-hints';

    this.hintBtn = document.createElement('button');
    this.hintBtn.className = 'tutorial-shelf-hint-btn';
    this.hintBtn.textContent = 'Show hint';
    this.hintBtn.addEventListener('click', () => {
      if (this.hintRequestCallback) this.hintRequestCallback();
    });

    this.hintContent = document.createElement('div');
    this.hintContent.className = 'tutorial-shelf-hint-content';

    this.hintsSection.appendChild(this.hintBtn);
    this.hintsSection.appendChild(this.hintContent);

    this.shelf.appendChild(header);
    this.shelf.appendChild(this.body);
    this.shelf.appendChild(this.hintsSection);

    workspace.insertBefore(this.shelf, insertBefore);
  }

  /**
   * Render markdown into the body. Set up the hint section based on
   * available hints and how many have already been revealed.
   */
  setContent(markdown: string, hints?: TutorialHint[], hintsRevealed: number = 0): void {
    this.body.innerHTML = renderMarkdown(markdown);

    this.totalHints = hints ? hints.length : 0;
    this.hintsRevealed = hintsRevealed;
    this.hintContent.innerHTML = '';

    if (this.totalHints === 0) {
      this.hintsSection.style.display = 'none';
      return;
    }

    this.hintsSection.style.display = '';

    // Render already-revealed hints
    for (let i = 0; i < hintsRevealed && i < this.totalHints; i++) {
      const block = this._createHintBlock(hints![i].content);
      this.hintContent.appendChild(block);
    }

    this._updateHintButton();
  }

  /**
   * Append a newly revealed hint block to the hints section.
   * Updates the hint button label or hides it when all hints are revealed.
   */
  revealHint(index: number, content: string): void {
    this.hintsRevealed = index + 1;
    const block = this._createHintBlock(content);
    this.hintContent.appendChild(block);
    this._updateHintButton();
  }

  collapse(): void {
    this.shelf.classList.add('tutorial-shelf-collapsed');
    this.collapseBtn.innerHTML = '&rsaquo;';
    this.collapseBtn.title = 'Expand';
    if (this.toggleCallback) this.toggleCallback(true);
  }

  expand(): void {
    this.shelf.classList.remove('tutorial-shelf-collapsed');
    this.collapseBtn.innerHTML = '&lsaquo;';
    this.collapseBtn.title = 'Collapse';
    if (this.toggleCallback) this.toggleCallback(false);
  }

  toggle(): void {
    if (this.shelf.classList.contains('tutorial-shelf-collapsed')) {
      this.expand();
    } else {
      this.collapse();
    }
  }

  /** Register handler for when the user clicks the hint button. */
  onHintRequest(callback: () => void): void {
    this.hintRequestCallback = callback;
  }

  /** Register handler for collapse/expand events. */
  onToggle(callback: (collapsed: boolean) => void): void {
    this.toggleCallback = callback;
  }

  show(): void {
    this.shelf.style.display = '';
  }

  hide(): void {
    this.shelf.style.display = 'none';
  }

  dispose(): void {
    this.shelf.remove();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _createHintBlock(content: string): HTMLDivElement {
    const block = document.createElement('div');
    block.className = 'tutorial-shelf-hint-block';
    block.innerHTML = renderMarkdown(content);
    return block;
  }

  private _updateHintButton(): void {
    const remaining = this.totalHints - this.hintsRevealed;
    if (remaining <= 0) {
      this.hintBtn.style.display = 'none';
    } else {
      this.hintBtn.style.display = '';
      this.hintBtn.textContent =
        remaining < this.totalHints
          ? `Show hint (${remaining} remaining)`
          : 'Show hint';
    }
  }
}
