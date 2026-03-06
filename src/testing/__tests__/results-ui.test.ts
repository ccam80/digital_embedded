/**
 * Test suite for TestResultsPanel UI component.
 *
 * Uses a minimal DOM stub so tests run in node environment without jsdom.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestResultsPanel } from "../results-ui.js";
import type { TestResults } from "@/headless/types.js";

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

class StubElement {
  tagName: string;
  private _className: string = "";
  textContent: string = "";
  title: string = "";
  innerHTML: string = "";
  style: Record<string, string> = {};
  children: StubElement[] = [];
  classList: {
    add(name: string): void;
    contains(name: string): boolean;
  };

  private _classSet: Set<string> = new Set();
  private readonly _listeners: Map<string, Array<(event: any) => void>> =
    new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = {
      add: (name: string) => {
        this._classSet.add(name);
        this._updateClassName();
      },
      contains: (name: string) => this._classSet.has(name),
    };
  }

  get className(): string {
    return this._className;
  }

  set className(value: string) {
    this._className = value;
    this._classSet.clear();
    if (value) {
      for (const cls of value.split(/\s+/)) {
        if (cls) this._classSet.add(cls);
      }
    }
  }

  private _updateClassName(): void {
    this._className = Array.from(this._classSet).join(" ");
  }

  appendChild(child: StubElement): StubElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: StubElement): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  querySelector(selector: string): StubElement | null {
    const parts = selector.trim().split(/\s+/);
    for (const child of this.children) {
      const result = this._queryDescendant(parts, 0, child);
      if (result) return result;
    }
    return null;
  }

  querySelectorAll(selector: string): StubElement[] {
    const parts = selector.trim().split(/\s+/);
    const results: StubElement[] = [];
    for (const child of this.children) {
      this._queryAllDescendants(parts, 0, child, results);
    }
    return results;
  }

  private _queryDescendant(parts: string[], index: number, root: StubElement): StubElement | null {
    if (index >= parts.length) {
      return root;
    }

    if (this._matchesSelector(root, parts[index])) {
      if (index === parts.length - 1) {
        return root;
      }
      for (const child of root.children) {
        const result = this._queryDescendant(parts, index + 1, child);
        if (result) return result;
      }
    }

    for (const child of root.children) {
      const result = this._queryDescendant(parts, index, child);
      if (result) return result;
    }
    return null;
  }

  private _queryAllDescendants(parts: string[], index: number, root: StubElement, results: StubElement[]): void {
    if (index >= parts.length) {
      results.push(root);
      return;
    }

    if (this._matchesSelector(root, parts[index])) {
      if (index === parts.length - 1) {
        results.push(root);
      } else {
        for (const child of root.children) {
          this._queryAllDescendants(parts, index + 1, child, results);
        }
      }
    }

    for (const child of root.children) {
      this._queryAllDescendants(parts, index, child, results);
    }
  }

  private _matchesSelector(elem: StubElement, selector: string): boolean {
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return elem._classSet.has(className);
    }
    const validTags = ["table", "thead", "tbody", "tr", "th", "td", "div"];
    if (validTags.includes(selector)) {
      return elem.tagName === selector.toUpperCase();
    }
    return false;
  }

  setAttribute(_name: string, _value: string): void {}

  addEventListener(event: string, cb: (e: any) => void): void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(cb);
  }

  dispatchEvent(event: string): void {
    for (const cb of this._listeners.get(event) ?? []) {
      cb({ target: this });
    }
  }

  get lastChild(): StubElement | undefined {
    return this.children[this.children.length - 1];
  }
}

// Install stub document globally
const stubDocument = {
  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  },
  createTextNode(text: string): { textContent: string } {
    return { textContent: text };
  },
};

(globalThis as any).document = stubDocument;
(globalThis as any).HTMLElement = StubElement;

describe("TestResultsPanel", () => {
  let container: StubElement;

  beforeEach(() => {
    container = stubDocument.createElement("div");
  });

  afterEach(() => {
    // Stub cleanup (no-op for stub)
  });

  it("rendersTable", () => {
    const panel = new TestResultsPanel(container);

    const results: TestResults = {
      passed: 3,
      failed: 1,
      total: 4,
      vectors: [
        {
          passed: true,
          inputs: { A: 0, B: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: true,
          inputs: { A: 0, B: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
        {
          passed: true,
          inputs: { A: 1, B: 0 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
        {
          passed: false,
          inputs: { A: 1, B: 1 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 1 },
        },
      ],
    };

    panel.render(results);

    const table = container.querySelector("table");
    expect(table).toBeTruthy();

    const rows = table!.querySelectorAll("tbody tr");
    expect(rows.length).toBe(4);
  });

  it("summaryText", () => {
    const panel = new TestResultsPanel(container);

    const results: TestResults = {
      passed: 3,
      failed: 1,
      total: 4,
      vectors: [
        {
          passed: true,
          inputs: { A: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: true,
          inputs: { A: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
        {
          passed: true,
          inputs: { A: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
        {
          passed: false,
          inputs: { A: 0 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 0 },
        },
      ],
    };

    panel.render(results);

    const summary = container.querySelector(".test-summary");
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toContain("3/4 passed");
  });

  it("failedCellsMarked", () => {
    const panel = new TestResultsPanel(container);

    const results: TestResults = {
      passed: 1,
      failed: 1,
      total: 2,
      vectors: [
        {
          passed: true,
          inputs: { A: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: false,
          inputs: { A: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 0 },
        },
      ],
    };

    panel.render(results);

    const rows = container.querySelectorAll("tbody tr");
    const failedRow = rows[1];
    expect(failedRow.classList.contains("test-failed")).toBe(true);

    const cells = failedRow.querySelectorAll("td");
    const outputCell = Array.from(cells).find((cell) =>
      cell.classList.contains("test-output-fail")
    );
    expect(outputCell).toBeTruthy();
  });

  it("allPassStyling", () => {
    const panel = new TestResultsPanel(container);

    const results: TestResults = {
      passed: 2,
      failed: 0,
      total: 2,
      vectors: [
        {
          passed: true,
          inputs: { A: 0 },
          expectedOutputs: { Y: 0 },
          actualOutputs: { Y: 0 },
        },
        {
          passed: true,
          inputs: { A: 1 },
          expectedOutputs: { Y: 1 },
          actualOutputs: { Y: 1 },
        },
      ],
    };

    panel.render(results);

    const summary = container.querySelector(".test-summary");
    expect(summary!.classList.contains("test-all-pass")).toBe(true);
  });

  it("emptyResults", () => {
    const panel = new TestResultsPanel(container);

    const results: TestResults = {
      passed: 0,
      failed: 0,
      total: 0,
      vectors: [],
    };

    panel.render(results);

    const noVectorsMsg = container.querySelector(".test-no-vectors");
    expect(noVectorsMsg).toBeTruthy();
    expect(noVectorsMsg!.textContent).toContain("No test vectors");
  });
});
