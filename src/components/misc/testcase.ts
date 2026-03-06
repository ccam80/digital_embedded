/**
 * Testcase component — placeable test case element.
 *
 * Contains embedded truth table test data. Displayed as a labeled box on
 * the canvas. The test data is accessible to the test executor (Phase 6).
 *
 * No simulation behavior — executeFn is a no-op. The component acts as a
 * data carrier only: its test data property holds the truth table as a
 * newline-delimited string in Digital's test format.
 *
 * Test data format (same as Digital's .dig testcase format):
 *   - First line: whitespace-separated pin names (inputs then outputs)
 *   - Subsequent lines: whitespace-separated values for each row
 *   - Values: 0, 1, x (don't care), or decimal/hex integers
 *   - Comments: lines starting with #
 *
 * Example:
 *   A B | Y
 *   0 0   0
 *   0 1   1
 *   1 0   1
 *   1 1   1
 *
 * Pin layout: none (Testcase has no circuit connections)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { createInverterConfig, resolvePins } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// TestcaseRow — one row of parsed test data
// ---------------------------------------------------------------------------

export interface TestcaseRow {
  /** Raw whitespace-split tokens for this row (values or don't-cares). */
  readonly tokens: readonly string[];
}

// ---------------------------------------------------------------------------
// TestcaseData — parsed test data extracted from the raw string
// ---------------------------------------------------------------------------

export interface TestcaseData {
  /** Pin names as declared in the test header. */
  readonly pinNames: readonly string[];
  /** Data rows (comments and blank lines already filtered). */
  readonly rows: readonly TestcaseRow[];
}

// ---------------------------------------------------------------------------
// parseTestData — parse raw test string into structured data
// ---------------------------------------------------------------------------

export function parseTestData(raw: string): TestcaseData {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const dataLines = lines.filter((l) => l.length > 0 && !l.startsWith("#"));

  if (dataLines.length === 0) {
    return { pinNames: [], rows: [] };
  }

  // First non-comment line is the header: pin names separated by whitespace.
  // The pipe character '|' is used as a visual separator in Digital's format
  // and is ignored (treated as whitespace).
  const headerTokens = dataLines[0]
    .replace(/\|/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const rows: TestcaseRow[] = dataLines.slice(1).map((line) => {
    const tokens = line
      .replace(/\|/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    return { tokens };
  });

  return { pinNames: headerTokens, rows };
}

// ---------------------------------------------------------------------------
// Pin layout — no circuit connections
// ---------------------------------------------------------------------------

function buildTestcasePinDeclarations(): PinDeclaration[] {
  return [];
}

// ---------------------------------------------------------------------------
// TestcaseElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class TestcaseElement extends AbstractCircuitElement {
  private readonly _label: string;
  private readonly _testData: string;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Testcase", instanceId, position, rotation, mirror, props);

    this._label = props.getOrDefault<string>("label", "Testcase");
    this._testData = props.getOrDefault<string>("testData", "");

    const decls = buildTestcasePinDeclarations();
    this._pins = resolvePins(
      decls,
      position,
      rotation,
      createInverterConfig([]),
      { clockPins: new Set<string>() },
      1,
    );
  }

  /** The raw test data string. */
  get testData(): string {
    return this._testData;
  }

  /** Parse and return the structured test data. */
  getParsedTestData(): TestcaseData {
    return parseTestData(this._testData);
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const { x, y } = this.position;

    ctx.save();
    ctx.translate(x, y);

    // Component body — labeled box
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Testcase icon: small table lines indicating a truth table
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Horizontal divider
    ctx.drawLine(0.3, 0.7, COMP_WIDTH - 0.3, 0.7);

    // Vertical divider
    const midX = COMP_WIDTH / 2;
    ctx.drawLine(midX, 0.3, midX, COMP_HEIGHT - 0.3);

    // Row lines
    ctx.drawLine(0.3, 1.1, COMP_WIDTH - 0.3, 1.1);
    ctx.drawLine(0.3, 1.5, COMP_WIDTH - 0.3, 1.5);

    // Label
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText(this._label, COMP_WIDTH / 2, COMP_HEIGHT + 0.3, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Testcase — embedded truth table test element.\n" +
      "Contains test data (pin names + expected input/output rows).\n" +
      "No simulation behavior — acts as data carrier for the test executor.\n" +
      "testData: newline-delimited string in Digital test format."
    );
  }
}

// ---------------------------------------------------------------------------
// executeTestcase — no-op (no simulation behavior)
// ---------------------------------------------------------------------------

export function executeTestcase(
  _index: number,
  _state: Uint32Array,
  _layout: ComponentLayout,
): void {
  // Testcase has no simulation behavior — it is a data carrier only.
}

// ---------------------------------------------------------------------------
// TESTCASE_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const TESTCASE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "testData",
    propertyKey: "testData",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TESTCASE_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "Testcase",
    description: "Label shown below the testcase component",
  },
  {
    key: "testData",
    type: PropertyType.STRING,
    label: "Test data",
    defaultValue: "",
    description:
      "Truth table test data in Digital format: header line with pin names, then one row per test vector",
  },
];

// ---------------------------------------------------------------------------
// TestcaseDefinition
// ---------------------------------------------------------------------------

function testcaseFactory(props: PropertyBag): TestcaseElement {
  return new TestcaseElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TestcaseDefinition: ComponentDefinition = {
  name: "Testcase",
  typeId: -1,
  factory: testcaseFactory,
  executeFn: executeTestcase,
  pinLayout: buildTestcasePinDeclarations(),
  propertyDefs: TESTCASE_PROPERTY_DEFS,
  attributeMap: TESTCASE_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.MISC,
  helpText:
    "Testcase — embedded truth table test element.\n" +
    "Contains test data (pin names + expected input/output rows).\n" +
    "No simulation behavior — acts as data carrier for the test executor.\n" +
    "testData: newline-delimited string in Digital test format.",
};
