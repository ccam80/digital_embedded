/**
 * Framework-level invariants for every component whose definition exposes a
 * digital execution model (`def.models.digital`).
 *
 * Iterates the default registry once and emits one parametrised assertion per
 * digital-capable definition for three cross-cutting structural contracts:
 *
 *   1. pinLayout input/output labels (in declaration order) match the digital
 *      model's inputSchema / outputSchema.
 *   2. At most one pin in pinLayout is flagged as a clock input
 *      (PinDeclaration.isClockCapable).  Combinational components have zero;
 *      edge-triggered components have one.
 *   3. propertyDefs entries declare unique, identifier-shaped keys.
 *
 * No simulator is constructed, no element is loaded, and no SLOT_ constants
 * are imported.  This file walks the registry data only.
 */

import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "@/components/register-all";
import { createSeededBag } from "@/core/registry";
import type { ComponentDefinition, DigitalModel } from "@/core/registry";
import type { PinDeclaration } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import { PropertyBag } from "@/core/properties";

// ---------------------------------------------------------------------------
// Resolve schemas (static array or function-of-PropertyBag) to string[]
// ---------------------------------------------------------------------------

function resolveSchema(
  schema: DigitalModel["inputSchema"] | DigitalModel["outputSchema"],
  props: PropertyBag,
): string[] | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === "function") return schema(props);
  return [...schema];
}

// ---------------------------------------------------------------------------
// Discover all digital-capable definitions in the default registry
// ---------------------------------------------------------------------------

interface DigitalCase {
  readonly name: string;
  readonly definition: ComponentDefinition;
  readonly digital: DigitalModel;
}

const REGISTRY = createDefaultRegistry();

const DIGITAL_CASES: readonly DigitalCase[] = REGISTRY
  .getAll()
  .flatMap<DigitalCase>((definition) => {
    // `models` lives on StandaloneComponentDefinition; internal-only
    // definitions have no `models` container.  Narrow via property access
    // rather than a type cast (B-2 bans `as any` / `as unknown as`).
    const models = (definition as { models?: { digital?: DigitalModel } }).models;
    const digital = models?.digital;
    if (digital === undefined) return [];
    return [{ name: definition.name, definition, digital }];
  });

// Sanity: the default registry must produce a non-empty digital cohort,
// otherwise the invariant suites below would be silent no-ops.
describe("digital registry cohort", () => {
  it("default registry exposes at least one digital-capable definition", () => {
    expect(DIGITAL_CASES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — pinLayout input/output labels match digital model schemas
// ---------------------------------------------------------------------------
//
// For both static (string[]) and functional ((props) => string[]) schemas,
// resolve the schema using a seeded PropertyBag derived from the definition's
// default model entry.  The resulting label list must equal the labels of
// the matching-direction PinDeclaration entries in pinLayout, in order.

describe("Invariant 1: pinLayout matches digital schemas", () => {
  it.each(DIGITAL_CASES.map((c) => [c.name, c] as const))(
    "%s: pinLayout input/output labels equal digital inputSchema/outputSchema",
    (_name, c) => {
      const props = createSeededBag(c.definition);
      const layout: readonly PinDeclaration[] = c.definition.pinLayout ?? [];

      const inputLabels = layout
        .filter((p) => p.direction === PinDirection.INPUT)
        .map((p) => p.label);
      const outputLabels = layout
        .filter((p) => p.direction === PinDirection.OUTPUT)
        .map((p) => p.label);

      const expectedInputs = resolveSchema(c.digital.inputSchema, props);
      const expectedOutputs = resolveSchema(c.digital.outputSchema, props);

      // A schema may be omitted entirely; only assert when the contract
      // declares one.  When declared, it must match the pinLayout exactly.
      if (expectedInputs !== undefined) {
        expect(inputLabels).toEqual(expectedInputs);
      }
      if (expectedOutputs !== undefined) {
        expect(outputLabels).toEqual(expectedOutputs);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Invariant 2 — clock-pin uniqueness
// ---------------------------------------------------------------------------
//
// PinDeclaration entries flag clock-capable inputs via `isClockCapable`
// (the runtime `Pin.isClock` flag is derived from this declaration plus the
// per-instance ClockConfig).  At most one input pin per component may be
// declared clock-capable; combinational components have zero.

describe("Invariant 2: at most one clock-capable input pin per digital component", () => {
  it.each(DIGITAL_CASES.map((c) => [c.name, c] as const))(
    "%s: pinLayout has 0 or 1 input pins flagged isClockCapable",
    (_name, c) => {
      const layout: readonly PinDeclaration[] = c.definition.pinLayout ?? [];
      const clockPins = layout.filter(
        (p) => p.direction === PinDirection.INPUT && p.isClockCapable === true,
      );
      expect(clockPins.length).toBeLessThanOrEqual(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Invariant 3 — propertyDefs key hygiene
// ---------------------------------------------------------------------------
//
// Without a reflection API exposing which property keys an executeFn /
// sampleFn reads, the strongest mechanical contract this layer can enforce
// is that declared keys are non-empty, unique, and shaped as valid
// JavaScript identifiers — the form `layout.getProperty(...)` callers use.

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Invariant 4 — clock-capable pin label convention
// ---------------------------------------------------------------------------
//
// Sequential components conventionally name their clock input "C", "CLK", or
// "CK".  When a pin is flagged `isClockCapable: true` its label must come from
// this allowlist so the visual convention (drawing the wire to a pin labelled
// "C") matches the runtime semantics (edge-detection on that pin).  A typo
// like flagging "DIN" as clock-capable, or naming the clock pin "Clk2" while
// flagging it, would silently break the wire-drawing convention this audit
// guards against.

const CLOCK_LABELS: ReadonlySet<string> = new Set(["C", "CLK", "CK"]);

describe("Invariant 4: isClockCapable pins use a recognised clock label", () => {
  it.each(DIGITAL_CASES.map((c) => [c.name, c] as const))(
    "%s: every isClockCapable pin has label C / CLK / CK",
    (_name, c) => {
      const layout: readonly PinDeclaration[] = c.definition.pinLayout ?? [];
      const clockPins = layout.filter(
        (p) => p.direction === PinDirection.INPUT && p.isClockCapable === true,
      );
      for (const pin of clockPins) {
        expect(CLOCK_LABELS.has(pin.label)).toBe(true);
      }
    },
  );
});

describe("Invariant 3: propertyDefs keys are unique identifier-shaped strings", () => {
  it.each(DIGITAL_CASES.map((c) => [c.name, c] as const))(
    "%s: propertyDefs keys are unique and match /^[a-zA-Z_][a-zA-Z0-9_]*$/",
    (_name, c) => {
      const propertyDefs = (c.definition as { propertyDefs?: ReadonlyArray<{ key: string }> })
        .propertyDefs ?? [];
      const keys = propertyDefs.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(key).toMatch(IDENT_RE);
      }
    },
  );
});
