# Analog Shape Audit Hardening Spec

## Problem

The analog shape audit (`analog-shape-render-audit.test.ts`) has the right skeleton but three structural gaps compared to the digital audit:

| Gap | Digital audit | Analog audit |
|-----|--------------|--------------|
| Assertion granularity | `expect.soft()` per metric → one summary failure per category | Same `expect.soft()` but CI shows "2 failed" hiding 187 individual errors |
| Text comparison | Full structural text comparison (content, position, anchor) | Column hardcoded `"ok"` — no text comparison at all |
| Property-diversity | Separate `shape-audit.test.ts` loads real `.dig` fixtures with non-default props | No analog equivalent — only default props tested |

Current analog results: 28% pixel match, 41% pin position match, 187 rotation/mirror mismatches, 0% text coverage.

## Goals

1. **Per-component assertion** — each component gets its own pass/fail verdict, not one aggregated summary. Failures fail loudly.
2. **Text comparison** — extract and compare text draw calls from Falstad reference vs TS rendering.
3. **Rotation/mirror audit** — per-(type, rotation, mirror) individual tests.
4. **Preserve the diagnostic table** — the detailed console output is valuable; keep it.

## Non-goals

- Fixing the actual shape/pin bugs (that's the subsequent audit fix cycle).
- Changing the digital audit structure.
- Adding new Falstad reference data (use existing `falstad-shapes.json`).

---

## Changes

### 1. Per-component assertions (modify `analog-shape-render-audit.test.ts`)

**Current:** Individual `it.each` tests per component do computation only — all assertions are deferred to the final `"summary"` test using `expect.soft()`.

**Target:** Each `it.each` test asserts its own results inline, so CI reports one failure per broken component. The summary test remains for the diagnostic table but adds no new assertions.

#### 1a. Covered-type tests (have Falstad reference)

Each per-component test should assert:

```
expect(pixelDice, `${typeName} pixel Dice`).toBeGreaterThanOrEqual(DICE_THRESHOLD);
expect(extent.maxDelta, `${typeName} extent`).toBeLessThanOrEqual(EXTENT_THRESHOLD);
expect(bboxOverflow, `${typeName} bbox`).toBeLessThanOrEqual(0);
expect(textOverlaps, `${typeName} text overlap`).toBe(0);
expect(pinCountDelta, `${typeName} pin count`).toBe(0);        // when ref exists
expect(pinPosMismatches, `${typeName} pin positions`).toBe(0);  // when ref exists
expect(pinDetachedCount, `${typeName} detached pins`).toBe(0);
expect(textResult.missingInTS.length, `${typeName} missing text`).toBe(0);  // NEW
expect(textResult.extraInTS.length, `${typeName} extra text`).toBe(0);      // NEW
```

Every assertion fires unconditionally. No skip lists, no gating, no relaxed thresholds.

#### 1b. Threshold constants

Define at the top of the file — same values as digital:

```ts
const DICE_THRESHOLD = 0.99;
const EXTENT_THRESHOLD = 0;  // zero tolerance, same as digital
```

#### 1c. Summary test changes

- Remove all `expect.soft()` assertions from the summary.
- Keep the diagnostic table and outlier sections (console output only).
- The summary becomes purely informational — all real assertions live in the per-component tests.

### 2. Text comparison (modify `analog-shape-render-audit.test.ts` + `falstad-fixture-reference.ts`)

#### 2a. Current state

Probing reveals three categories of text mismatch:

| Category | Components | Falstad text | TS text | Notes |
|---|---|---|---|---|
| **Both emit, different format** | Resistor, Capacitor, Inductor | `"1.0k"`, `"10.0μF"`, `"1.0H"` | `"1000Ω"`, `"1µF"`, `"1mH"` | Value formatting differs (SI prefix, units) |
| **Falstad-only (symbol labels)** | OpAmp, RealOpAmp, VoltageComparator, OTA | `"+"`, `"-"`, `"≥?"` | none | TS doesn't draw +/− input labels |
| **Falstad-only (pin/port labels)** | Timer555, VCVS, VCCS, CCVS, CCCS | `"dis"`, `"tr"`, `"A+"`, etc. | none | TS doesn't draw port labels on body |
| **Falstad-only (value text)** | PolarizedCap, AcVoltageSource, VariableRail, LDR, NTCThermistor | `"10.0μF"`, `"40.0Hz"`, `"+5.0V"`, etc. | none | TS doesn't draw component values |
| **TS-only** | ADC, DAC | none (no Falstad ref) | `"ADC"`, `"DAC"`, `"8-bit"` | Uncovered — no Falstad reference exists |

19/55 Falstad components emit text; only 3 TS components do for the same set. The 36 Falstad components without text genuinely have no text in CircuitJS1 — they're semiconductors, switches, etc. that are pure geometry.

#### 2b. Text comparison strategy

The text content diverges by design in some cases (value formatting), but structural text (symbol labels like `"+"`, `"-"`) represents real missing rendering. Split the comparison into two tiers:

**Tier 1 — Structural symbol text (assert):** `"+"`, `"-"`, `"≥?"` on OpAmp/Comparator/OTA. These are part of the schematic symbol standard and must be present. Missing these means the symbol is ambiguous.

**Tier 2 — Value/label text (report only):** Component values (`"1.0k"`), pin labels on IC bodies (`"dis"`, `"tr"`), polarity markers (`"+"`on PolarizedCap). These are informational — differences are logged in the diagnostic table but not asserted, because TS may legitimately format or place them differently.

#### 2c. Extract Falstad text calls

`falstad-shapes.json` contains `{"type":"text","text":"1.0k","x":27,"y":-10}` calls. These are currently skipped in `replayDraw()` (line 244: `// text: skip`).

Add to `falstad-fixture-reference.ts`:

```ts
export interface FalstadTextRef {
  text: string;
  x: number;  // grid coords (px × PX_TO_GRID)
  y: number;
}

// New export: Map<tsType, FalstadTextRef[]>
export const FALSTAD_TEXT_REFS: ReadonlyMap<string, FalstadTextRef[]>;
```

Build this in `ensureBuilt()` by filtering `comp.draws` for `type === "text"` entries, converting coordinates to grid units.

#### 2d. Add text comparison to per-component tests

Add `textResult` field to `AnalogResult`:

```ts
interface AnalogResult {
  // ... existing fields ...
  textResult: TextCompareResult;  // NEW — was missing entirely
}
```

In the covered-type `it.each`:

```ts
// --- Text comparison ---
const falstadTexts = FALSTAD_TEXT_REFS.get(typeName) ?? [];
const tsTexts = extractTSTexts(tsCtx.calls);

// Reuse compareTexts() from shape-rasterizer
const textResult = compareTexts(
  falstadTexts.map(t => ({ text: t.text, x: t.x, y: t.y, anchor: 'left' as const })),
  tsTexts,
);
```

#### 2e. Fix the hardcoded "ok" column

Replace line 542:

```ts
// BEFORE (hardcoded — always says "ok"):
(isUncov ? "N/A" : "ok").padEnd(8)

// AFTER (computed from actual comparison):
txtStr.padEnd(8)
```

Where `txtStr` is computed the same way as in the digital audit:
```ts
const txtMissing = r.textResult.missingInTS.length;
const txtExtra = r.textResult.extraInTS.length;
const txtStr = isUncov ? "N/A" :
  txtMissing === 0 && txtExtra === 0 ? "ok" : `-${txtMissing}/+${txtExtra}`;
```

#### 2f. Assertions

Text comparison asserts per-component, no gating:

```ts
// Full text comparison in the diagnostic table (all components)
// Structural symbol text is asserted directly:
const SYMBOL_TEXT_REQUIRED: Record<string, string[]> = {
  OpAmp: ["+", "-"],
  RealOpAmp: ["+", "-"],
  VoltageComparator: ["+", "-"],
  OTA: ["+", "-"],
};

const required = SYMBOL_TEXT_REQUIRED[typeName];
if (required) {
  for (const sym of required) {
    const found = tsTexts.some(t => t.text === sym);
    expect(found, `${typeName} missing symbol text "${sym}"`).toBe(true);
  }
}
```

### 3. Rotation/mirror fixture audit (new file `analog-shape-audit.test.ts`)

The digital `shape-audit.test.ts` loads real `.dig` fixture files and tests property-dependent pin layouts. Analog components don't have property-dependent pin layouts (a resistor always has 2 pins regardless of value), so the analog equivalent focuses on the primary gap: **rotation/mirror coverage from real circuit instances**.

The existing rotation/mirror section in `analog-shape-render-audit.test.ts` (section 4 below) tests transforms programmatically but aggregates results into a single summary assertion. This new file replaces that approach with individual tests.

#### 3a. Test matrix

For every analog type in the registry with a Falstad pin reference, test all 8 transform combinations (4 rotations × 2 mirrors) at a non-origin position. This gives complete coverage:

- 46 types with pin references × 8 transforms = **368 test instances**
- Each instance checks every pin's world position

#### 3b. Test structure — per-component, per-transform

```ts
// analog-shape-audit.test.ts
import { ALL_ANALOG_TYPES, FALSTAD_PIN_POSITIONS, falstadWorldPosition } from "@/test-utils/falstad-fixture-reference";
import { pinWorldPosition } from "@/core/pin";
import type { Rotation } from "@/core/pin";

const ROTATIONS: Rotation[] = [0, 1, 2, 3];
const MIRRORS = [false, true];

describe("analog fixture pin audit — all rotations × mirrors", () => {
  // Build test cases: one entry per (type, rotation, mirror) triple
  interface TransformCase {
    typeName: string;
    rotation: Rotation;
    mirror: boolean;
    label: string;  // for test name: "Resistor rot=1 mir=true"
  }

  const cases: TransformCase[] = [];
  for (const typeName of ALL_ANALOG_TYPES) {
    if (!FALSTAD_PIN_POSITIONS.has(typeName)) continue;
    for (const rot of ROTATIONS) {
      for (const mir of MIRRORS) {
        cases.push({
          typeName,
          rotation: rot,
          mirror: mir,
          label: `${typeName} rot=${rot} mir=${mir}`,
        });
      }
    }
  }

  it.each(cases)("$label", ({ typeName, rotation, mirror }) => {
    const def = registry.get(typeName);
    if (!def) return;

    const props = buildDefaultProps(registry, typeName);
    const element = def.factory(props);
    element.rotation = rotation;
    element.mirror = mirror;
    element.position = { x: 7, y: 13 };  // non-origin, non-grid-aligned

    const refPins = FALSTAD_PIN_POSITIONS.get(typeName)!;
    const tsPins = element.getPins();

    // Pin count must match (prerequisite for position checks)
    expect(tsPins.length, `${typeName} pin count`).toBe(refPins.length);
    if (tsPins.length !== refPins.length) return;

    for (let i = 0; i < tsPins.length; i++) {
      const tsWorld = pinWorldPosition(element, tsPins[i]);
      const expected = falstadWorldPosition(
        refPins[i].x, refPins[i].y,
        element.position.x, element.position.y,
        rotation, mirror,
      );

      expect(tsWorld.x, `${typeName} pin ${refPins[i].label} x`).toBeCloseTo(expected.x, 1);
      expect(tsWorld.y, `${typeName} pin ${refPins[i].label} y`).toBeCloseTo(expected.y, 1);
    }
  });
});
```

Every test runs unconditionally. Failed transforms fail loudly. CI output reads: `FAIL Resistor rot=1 mir=true`, `FAIL NpnBJT rot=2 mir=false`, etc.

#### 3c. No `.dig` fixture files needed

Unlike the digital property-diversity audit, we don't need fixture `.dig` files because:
1. Analog pin layouts are property-independent — no "non-default props" dimension to test.
2. Programmatic generation gives complete coverage (every type × every transform) without maintaining fixture files.
3. The test is self-contained and doesn't depend on external file discovery.

### 4. Rotation/mirror audit tightening (modify existing section in `analog-shape-render-audit.test.ts`)

The rotation/mirror section currently collects mismatches in an array and asserts in a summary. Change to per-component assertions:

```ts
it.each(computeAllTypes())(
  "$typeName pin transforms",
  ({ typeName }) => {
    // ... existing setup ...
    const componentMismatches: TransformMismatch[] = [];

    for (const rot of ROTATIONS) {
      for (const mir of MIRRORS) {
        // ... existing comparison ...
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
          componentMismatches.push(...);
        }
      }
    }

    // Assert unconditionally — failures fail loudly
    expect(
      componentMismatches.length,
      `${typeName} has ${componentMismatches.length} transform mismatches`
    ).toBe(0);
  },
);
```

Remove the `"summary: zero pin transform mismatches"` test — it's now redundant.

---

## File changes summary

| File | Action |
|------|--------|
| `src/fixtures/__tests__/analog-shape-render-audit.test.ts` | Modify: per-component assertions (unconditional), text comparison, summary becomes diagnostic-only, rotation/mirror per-component assertions |
| `src/test-utils/falstad-fixture-reference.ts` | Modify: add `FALSTAD_TEXT_REFS` export, extract text calls from JSON |
| `src/fixtures/__tests__/analog-shape-audit.test.ts` | **New**: per-(type, rotation, mirror) pin audit — 368 individual tests |

No new fixture `.dig` files — tests generate instances programmatically.

## Verification

After implementation, the test suite should:

1. `npx vitest run analog-shape-render-audit` — each component reports pass/fail individually. Currently ~33 components fail with strict thresholds. Each failure is visible in CI by component name.
2. `npx vitest run analog-shape-audit` — 368 individual tests (46 types × 8 transforms), each reporting pass/fail independently. Currently ~7 types pass all transforms, rest fail individually.
3. The diagnostic table output is preserved and now includes accurate text comparison columns.
4. Text comparison column shows real data: e.g., OpAmp shows `-2/+0` (missing `"+"` and `"-"`), Resistor shows `-1/+1` (different value format).

## Subsequent work

Once this spec is implemented, the audit fix cycle proceeds component-by-component:
1. Pick a failing component from the test output.
2. Fix its shape/pins to match Falstad reference.
3. Verify the test passes.
4. Repeat until all tests are green.
