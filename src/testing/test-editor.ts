/**
 * TestEditorPanel- CodeMirror 6 editor panel for Digital test vector syntax.
 *
 * Provides a code editor with syntax highlighting for Digital's test format:
 *   - Signal name headers (first line) → identifier color
 *   - Values (0, 1, X, C, Z, hex literals) → value color
 *   - Keywords (loop, end loop, repeat, bits) → keyword color
 *   - Comments (#...) → comment color
 *
 * The panel owns a CodeMirror EditorView. Content can be read and written
 * programmatically. The save() method writes the current editor content back
 * to a TestcaseElement's testData property by recreating the element with
 * the new data.
 *
 * In test environments without a DOM, the EditorView is not created and
 * getText()/setText() operate on an internal string buffer.
 */

import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { digitalTestLanguage } from './test-language.js';
import type { TestcaseElement } from '../components/misc/testcase.js';

// ---------------------------------------------------------------------------
// TestEditorPanel
// ---------------------------------------------------------------------------

/**
 * Code editor panel for Digital test vector files.
 *
 * Wraps a CodeMirror 6 EditorView mounted into a container HTMLElement.
 * Provides a simple getText/setText API for programmatic access.
 * The save() method propagates edited content to the associated Testcase component.
 *
 * When `container` is null (e.g. in headless/test contexts), the panel operates
 * in buffer-only mode: getText/setText work but no DOM is created.
 */
export class TestEditorPanel {
  private _view: EditorView | null = null;
  private _buffer: string = '';
  private _testcase: TestcaseElement | null = null;
  private readonly _container: HTMLElement | null;

  /** Returns the associated Testcase element, or null if none is set. */
  get testcase(): TestcaseElement | null { return this._testcase; }
  /** Returns the container element this panel is mounted in, or null in buffer mode. */
  get container(): HTMLElement | null { return this._container; }

  /**
   * Create a TestEditorPanel.
   *
   * @param container  DOM element to mount the CodeMirror editor into.
   *                   Pass null to run in buffer-only mode (no DOM required).
   * @param initialContent  Initial text content for the editor.
   */
  constructor(container: HTMLElement | null, initialContent: string = '') {
    this._container = container;
    this._buffer = initialContent;

    if (container !== null) {
      this._mountEditor(container, initialContent);
    }
  }

  /**
   * True if the CodeMirror EditorView is mounted (DOM mode).
   * False in buffer-only (headless/test) mode.
   */
  get isMounted(): boolean {
    return this._view !== null;
  }

  /**
   * Return the current editor content as a string.
   * In DOM mode, reads from the EditorView document.
   * In buffer mode, returns the internal buffer.
   */
  getText(): string {
    if (this._view !== null) {
      return this._view.state.doc.toString();
    }
    return this._buffer;
  }

  /**
   * Replace the editor content with the given text.
   * In DOM mode, dispatches a transaction to replace the entire document.
   * In buffer mode, updates the internal buffer.
   */
  setText(text: string): void {
    if (this._view !== null) {
      const state = this._view.state;
      this._view.dispatch({
        changes: { from: 0, to: state.doc.length, insert: text },
      });
    } else {
      this._buffer = text;
    }
  }

  /**
   * Associate a TestcaseElement with this editor.
   * The save() method will write the editor content to this testcase.
   */
  setTestcase(testcase: TestcaseElement): void {
    this._testcase = testcase;
    // Load the testcase's current data into the editor
    this.setText(testcase.testData);
  }

  /**
   * Save the current editor content to the associated TestcaseElement.
   *
   * Calls the provided updater function with the current editor content.
   * The updater is responsible for creating a new TestcaseElement with
   * the updated testData (elements are immutable after construction).
   *
   * If no updater is provided and a testcase is set, this is a no-op-
   * use setTestcaseUpdater to configure save behaviour.
   */
  save(onSave?: (content: string) => void): void {
    const content = this.getText();
    if (onSave !== undefined) {
      onSave(content);
    }
  }

  /**
   * Destroy the editor and release resources.
   * After calling destroy(), the panel must not be used.
   */
  destroy(): void {
    if (this._view !== null) {
      this._view.destroy();
      this._view = null;
    }
  }

  /**
   * Return the underlying CodeMirror EditorView (or null in buffer mode).
   * Exposed for testing and advanced integration.
   */
  getEditorView(): EditorView | null {
    return this._view;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _mountEditor(container: HTMLElement, initialContent: string): void {
    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      bracketMatching(),
      digitalTestLanguage,
      EditorView.lineWrapping,
    ];

    const state = EditorState.create({
      doc: initialContent,
      extensions,
    });

    this._view = new EditorView({
      state,
      parent: container,
    });
  }
}

// ---------------------------------------------------------------------------
// TestcaseUpdater type- passed to save() to apply editor content
// ---------------------------------------------------------------------------

/**
 * Callback type for save(). Receives the edited content string and is
 * responsible for updating the Testcase component with the new test data.
 *
 * Typical usage:
 *   editor.save((content) => {
 *     // rebuild the testcase element with new content
 *     testcaseElement.props.set('testData', content);
 *   });
 */
export type TestcaseUpdater = (content: string) => void;
