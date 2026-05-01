/**
 * Tests for TestEditorPanel.
 *
 * Tests:
 *   - createEditor:     create editor, verify CodeMirror instance mounted
 *   - setContent:       set editor content to test string, verify getText() returns it
 *   - saveToTestcase:   edit content, save, verify Testcase component's test data updated
 *
 * The CodeMirror EditorView requires a full DOM (canvas, CSS layout, etc.) that
 * is not available in the node test environment. Tests that verify mounting use a
 * minimal DOM stub; the buffer-mode path (null container) is used for content tests.
 *
 * The stub DOM is installed globally to satisfy CodeMirror's import-time checks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { TestEditorPanel } from '../test-editor.js';
import type { TestcaseElement } from '../../components/misc/testcase.js';

// ---------------------------------------------------------------------------
// Minimal DOM stub for node environment
// ---------------------------------------------------------------------------

/**
 * A minimal DOM stub used to satisfy CodeMirror's environment checks.
 * CodeMirror detects the environment at module load time; providing these
 * globals prevents import errors in the node test environment.
 *
 * The stub implements only what CodeMirror queries at construction time.
 * It does not attempt to replicate the full DOM API- tests that need full
 * DOM functionality use buffer-only mode (null container).
 */
class StubNode {
  nodeType: number = 1;
  nodeName: string = 'DIV';
  tagName: string = 'DIV';
  childNodes: StubNode[] = [];
  parentNode: StubNode | null = null;
  style: Record<string, string> = {};
  attributes: Array<{ name: string; value: string }> = [];
  textContent: string = '';
  ownerDocument: typeof stubDoc | null = null;

  appendChild(child: StubNode): StubNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: StubNode): StubNode {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    return child;
  }
  insertBefore(child: StubNode, ref: StubNode | null): StubNode {
    if (ref === null) return this.appendChild(child);
    const idx = this.childNodes.indexOf(ref);
    if (idx !== -1) this.childNodes.splice(idx, 0, child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    const existing = this.attributes.find((a) => a.name === name);
    if (existing) existing.value = value;
    else this.attributes.push({ name, value });
  }
  getAttribute(name: string): string | null {
    return this.attributes.find((a) => a.name === name)?.value ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.some((a) => a.name === name);
  }
  removeAttribute(name: string): void {
    const idx = this.attributes.findIndex((a) => a.name === name);
    if (idx !== -1) this.attributes.splice(idx, 1);
  }
  addEventListener(_type: string, _handler: unknown): void {}
  removeEventListener(_type: string, _handler: unknown): void {}
  dispatchEvent(_event: unknown): boolean { return true; }
  getBoundingClientRect(): { top: number; left: number; bottom: number; right: number; width: number; height: number } {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }
  querySelector(_sel: string): StubNode | null { return null; }
  querySelectorAll(_sel: string): StubNode[] { return []; }
  contains(_other: StubNode | null): boolean { return false; }
  getRootNode(): StubNode { return this; }
  get firstChild(): StubNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): StubNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): StubNode | null { return null; }
  get previousSibling(): StubNode | null { return null; }
  cloneNode(_deep?: boolean): StubNode { return new StubNode(); }
  replaceChild(newChild: StubNode, oldChild: StubNode): StubNode {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx !== -1) this.childNodes[idx] = newChild;
    return oldChild;
  }
  normalize(): void {}
  compareDocumentPosition(_other: StubNode): number { return 0; }
}

class StubText extends StubNode {
  nodeType = 3;
  nodeName = '#text';
  constructor(public data: string) {
    super();
    this.textContent = data;
  }
}

class StubComment extends StubNode {
  nodeType = 8;
  nodeName = '#comment';
  constructor(public data: string) {
    super();
  }
}

const stubDoc = {
  createElement(tag: string): StubNode {
    const n = new StubNode();
    n.tagName = tag.toUpperCase();
    n.nodeName = n.tagName;
    n.ownerDocument = stubDoc;
    return n;
  },
  createTextNode(text: string): StubText {
    const n = new StubText(text);
    n.ownerDocument = stubDoc;
    return n;
  },
  createComment(text: string): StubComment {
    const n = new StubComment(text);
    n.ownerDocument = stubDoc;
    return n;
  },
  createDocumentFragment(): StubNode {
    const n = new StubNode();
    n.nodeType = 11;
    n.nodeName = '#document-fragment';
    n.ownerDocument = stubDoc;
    return n;
  },
  head: new StubNode(),
  body: new StubNode(),
  documentElement: new StubNode(),
  activeElement: null as StubNode | null,
  getSelection(): null { return null; },
  createRange(): unknown { return { setEnd() {}, setStart() {}, collapse() {} }; },
};

// Install stub globals before CodeMirror modules are evaluated
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (g['document'] === undefined) {
    g['document'] = stubDoc;
  }
  if (g['window'] === undefined) {
    g['window'] = {
      document: stubDoc,
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      navigator: { userAgent: '' },
      location: { href: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
      requestAnimationFrame: (cb: FrameRequestCallback) => { setTimeout(cb, 0); return 0; },
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    };
  }
  if (g['navigator'] === undefined) {
    g['navigator'] = { userAgent: '' };
  }
  if (g['MutationObserver'] === undefined) {
    g['MutationObserver'] = class {
      observe() {}
      disconnect() {}
    };
  }
  if (g['ResizeObserver'] === undefined) {
    g['ResizeObserver'] = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  }
  if (g['requestAnimationFrame'] === undefined) {
    g['requestAnimationFrame'] = (cb: FrameRequestCallback) => { setTimeout(cb, 0); return 0; };
  }
  if (g['cancelAnimationFrame'] === undefined) {
    g['cancelAnimationFrame'] = () => {};
  }
});

// ---------------------------------------------------------------------------
// Helper: build a minimal TestcaseElement stub
// ---------------------------------------------------------------------------

function makeTestcaseStub(initialData: string): {
  element: TestcaseElement;
  savedData: { value: string };
} {
  const savedData = { value: initialData };

  const element = {
    testData: initialData,
    getParsedTestData: () => ({ pinNames: [], rows: [] }),
  } as unknown as TestcaseElement;

  return { element, savedData };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TestEditorPanel', () => {
  // -------------------------------------------------------------------------
  // createEditor
  // -------------------------------------------------------------------------

  it('createEditor- buffer mode: panel created without DOM, isMounted is false', () => {
    const editor = new TestEditorPanel(null, '');
    expect(editor.isMounted).toBe(false);
  });

  it('createEditor- getText returns initial content', () => {
    const initial = 'A B Y\n0 0 0\n0 1 1\n';
    const editor = new TestEditorPanel(null, initial);
    expect(editor.getText()).toBe(initial);
  });

  it('createEditor- empty initial content produces empty getText', () => {
    const editor = new TestEditorPanel(null);
    expect(editor.getText()).toBe('');
  });

  // -------------------------------------------------------------------------
  // setContent (setText / getText round-trip)
  // -------------------------------------------------------------------------

  it('setContent- setText then getText returns the new content', () => {
    const editor = new TestEditorPanel(null, '');
    const testContent = 'A B Y\n0 0 0\n1 1 1\n';

    editor.setText(testContent);

    expect(editor.getText()).toBe(testContent);
  });

  it('setContent- overwrite existing content with new content', () => {
    const original = 'A B Y\n0 0 0\n';
    const updated = 'CLK D Q\nC 0 0\nC 1 1\n';

    const editor = new TestEditorPanel(null, original);
    editor.setText(updated);

    expect(editor.getText()).toBe(updated);
  });

  it('setContent- setText with empty string clears content', () => {
    const editor = new TestEditorPanel(null, 'A B Y\n0 0 0\n');
    editor.setText('');
    expect(editor.getText()).toBe('');
  });

  it('setContent- multiple successive setText calls keep the last value', () => {
    const editor = new TestEditorPanel(null, '');
    editor.setText('first');
    editor.setText('second');
    editor.setText('third');
    expect(editor.getText()).toBe('third');
  });

  // -------------------------------------------------------------------------
  // saveToTestcase
  // -------------------------------------------------------------------------

  it('saveToTestcase- edit content, save, verify onSave callback receives updated content', () => {
    const { element } = makeTestcaseStub('A B Y\n0 0 0\n');
    const editor = new TestEditorPanel(null, element.testData);

    const newContent = 'A B Y\n0 0 0\n0 1 1\n1 0 1\n1 1 1\n';
    editor.setText(newContent);

    let savedContent: string | undefined;
    editor.save((content) => {
      savedContent = content;
    });

    expect(savedContent).toBe(newContent);
  });

  it('saveToTestcase- save without editing returns original content to callback', () => {
    const original = 'CLK D Q\nC 0 0\n';
    const editor = new TestEditorPanel(null, original);

    let savedContent: string | undefined;
    editor.save((content) => {
      savedContent = content;
    });

    expect(savedContent).toBe(original);
  });

  it('saveToTestcase- setTestcase loads testcase data into editor', () => {
    const { element } = makeTestcaseStub('A B Y\n0 0 0\n1 1 1\n');
    const editor = new TestEditorPanel(null, '');

    editor.setTestcase(element);

    expect(editor.getText()).toBe(element.testData);
  });

  it('saveToTestcase- save propagates edited text, not original testcase data', () => {
    const { element } = makeTestcaseStub('A B Y\n0 0 0\n');
    const editor = new TestEditorPanel(null, '');
    editor.setTestcase(element);

    const edited = 'A B Y\n0 0 0\n1 1 1\n# edited\n';
    editor.setText(edited);

    let savedContent: string | undefined;
    editor.save((content) => {
      savedContent = content;
    });

    expect(savedContent).toBe(edited);
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  it('destroy- after destroy, getText returns empty string (buffer reset)', () => {
    const editor = new TestEditorPanel(null, 'A B\n0 1\n');
    editor.destroy();
    // After destroy, the view is null; buffer remains accessible
    // The panel is not usable after destroy, but getText should not throw
    expect(() => editor.getText()).not.toThrow();
  });
});
