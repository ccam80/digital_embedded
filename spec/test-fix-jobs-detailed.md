# Test-Fix Jobs — Detailed migration spec

Companion to `spec/test-fix-jobs.md`. Each §J subsection here is a
self-contained, mechanically-applicable spec for one job. Agents must:

1. **Read this spec end-to-end before editing.**
2. **Do not run tests.** No `npm test`, no `vitest`, no playwright.
3. **Do not investigate beyond the listed files.** If a question arises
   that this spec does not answer, STOP and return with the question.
4. **No shims, aliases, or compatibility layers.** Tests must exercise
   the production interface as documented here.
5. **No reverts.** Do not propose to undo any production-side change.
6. **Do not edit production source files** (anything outside `__tests__`)
   unless the job §-spec explicitly authorizes a specific source-file edit.

If a §-spec cannot be applied because production code differs from the
"current contract" described, STOP and report — do not improvise.

---

## §J1 — Hand-rolled `MockSolver` retired

### Files in scope (test files only)
1. `src/solver/analog/__tests__/bridge-adapter.test.ts`
2. `src/solver/analog/__tests__/bridge-compilation.test.ts`
3. `src/solver/__tests__/coordinator-bridge.test.ts`
4. `src/components/passives/__tests__/transformer.test.ts` (only the test at line ~190 named `winding_resistance_drops_voltage` — leave other `transformer.test.ts` failures for §J4/§J6)

### Migration pattern

For each test that currently uses a hand-rolled `MockSolver` (a class
inside the test file that maintains its own `_handles[]` and `stamps[]`
arrays):

#### Step 1 — Delete the `MockSolver` class entirely from the file.

#### Step 2 — Replace solver construction sites:

```ts
// BEFORE
const solver = new MockSolver();
```

```ts
// AFTER
import { SparseSolver } from "../sparse-solver.js";
import { makeTestSetupContext, setupAll } from "./test-helpers.js";

const solver = new SparseSolver();
solver._initStructure();
```

(Adjust the relative import path of `sparse-solver.js` and `test-helpers.js`
based on the test file's location: e.g.
`src/solver/__tests__/coordinator-bridge.test.ts` imports from
`../analog/sparse-solver.js` and `../analog/__tests__/test-helpers.js`.)

#### Step 3 — Insert a real `setup()` pass before each `load()`.

For every adapter/element under test:

```ts
const adapter = makeBridgeOutputAdapter(/* args as before */);
adapter.label = "OUT";  // give it a name for findDevice resolution

const setupCtx = makeTestSetupContext({
  solver,
  startBranch: 1,    // first branch row id (must be set if any element calls makeCur)
  startNode:   100,  // first internal-node id (must be set if any element calls makeVolt)
  elements: [adapter],
});
setupAll([adapter], setupCtx);
```

If the test instantiates multiple adapters / elements, pass them all in
the `elements:` array and the `setupAll([...])` call.

#### Step 4 — Replace stamp-recording assertions.

The `MockSolver`'s `stamps[]` and `sumStamp(row, col)` / `lastStamp(row, col)`
helpers are gone. Use `SparseSolver.getCSCNonZeros()` instead:

```ts
// BEFORE
expect(solver.sumStamp(2, 2)).toBe(0.02);

// AFTER (after solver._linkRows / solver.factor or after load())
const entries = solver.getCSCNonZeros();
const entry = entries.find((e) => e.row === 2 && e.col === 2);
expect(entry?.value).toBe(0.02);
```

**Important:** `getCSCNonZeros` reflects the matrix state *after the most
recent `factor()` or `_resetForAssembly`+`stampElement` cycle*. For unit
tests that only call `load()` and want to inspect raw stamped values
without factoring, use a different helper:

```ts
import { sumMatrixEntry } from "./test-helpers.js";  // see addendum below
```

If `sumMatrixEntry` does not yet exist in `test-helpers.ts`, **STOP — return with this question**: "test-helpers does not export `sumMatrixEntry`; please clarify which assertion API to use against an unfactored SparseSolver."

#### Step 5 — `stampRHS` recording.

Production code does not call `solver.stampRHS(row, value)` — RHS writes
go directly to the `rhs: Float64Array` buffer in `LoadContext` via
`stampRHS(rhs, row, value)` from `stamp-helpers.ts`. The `MockSolver`'s
`rhsStamps[]` recorder is therefore not real production behavior.

Replacement: pass an explicit `rhs: Float64Array` of known size into
`makeCtx` / `loadCtxFromFields`, call `load()`, then assert directly on
`rhs[row]`:

```ts
const rhs = new Float64Array(8);
const ctx = loadCtxFromFields({ solver, matrix: solver, rhs, rhsOld: rhs, /* ... */ });
adapter.load(ctx);
expect(rhs[branchRow]).toBe(5.0);
```

### Explicit non-goals
- Do not delete tests. Migrate them.
- Do not change the assertion intent (only the mechanism).
- Do not alter the production `bridge-adapter.ts` / `coordinator.ts`.

---

## §J2 — BJT-composite tests pass non-Map / wrong PropertyBag shape

### Files in scope
1. `src/components/active/__tests__/optocoupler.test.ts`
2. `src/components/active/__tests__/timer-555.test.ts`
3. `src/components/active/__tests__/ota.test.ts`
4. `src/components/active/__tests__/real-opamp.test.ts`
5. `src/components/active/__tests__/schmitt-trigger.test.ts`
6. `src/components/semiconductors/__tests__/scr.test.ts`
7. `src/components/semiconductors/__tests__/triac.test.ts` (only the failing tests in `setup-stamp-order.test.ts` referencing PB-TRIAC pull data from this fixture pattern)
8. `src/solver/analog/__tests__/setup-stamp-order.test.ts` (only the
   `PB-OPTO`, `PB-OTA`, `PB-REAL_OPAMP`, `PB-SCHMITT`, `PB-TRIAC`,
   `PB-TIMER555` tests)

### Migration pattern

For each fixture in these files that constructs a composite element (or
sub-element), apply two changes:

#### Step 1 — All `pinNodes` arguments must be `Map<string, number>` instances.

Search-and-replace within each file:

```ts
// BEFORE — plain object
factory({ B: 2, C: 1, E: 3 }, props, () => 0);
// or
factory({"B": 2, "C": 1, "E": 3}, props, () => 0);
```

```ts
// AFTER
factory(new Map([["B", 2], ["C", 1], ["E", 3]]), props, () => 0);
```

The pin label and node id must be preserved exactly. If the existing
literal already uses `new Map(...)`, leave it.

#### Step 2 — PropertyBag must be seeded with the matching `*_DEFAULTS` constant.

Each composite includes one or more sub-elements (e.g. optocoupler ⊃ BJT
+ LED + CCCS + VSENSE; OTA ⊃ VCCS + ...; real-opamp ⊃ VCVS + RC + ...).
A test that drives the composite must seed the PropertyBag with the
**superset** of every sub-element's defaults so that no `replaceModelParams`
call rejects a key. Defaults constants live alongside each sub-element:

| Composite | Required defaults to merge |
|---|---|
| Optocoupler | `BJT_NPN_DEFAULTS` (from `bjt.ts`) + the optocoupler's own `OPTOCOUPLER_DEFAULTS` |
| Timer-555 | `BJT_NPN_DEFAULTS` + its own `TIMER555_DEFAULTS` |
| OTA | `OTA_DEFAULTS` |
| Real-opamp | `REAL_OPAMP_DEFAULTS` |
| Schmitt | `SCHMITT_DEFAULTS` |
| SCR | `BJT_NPN_DEFAULTS` + `BJT_PNP_DEFAULTS` (it embeds both) + `SCR_DEFAULTS` |
| Triac | (read its source for the defaults constant) |

Helper pattern (insert into the test file if not already present):

```ts
import {
  BJT_NPN_DEFAULTS, BJT_PNP_DEFAULTS,
} from "../../semiconductors/bjt.js";

function makeOptocouplerProps(overrides: Record<string, number> = {}): PropertyBag {
  const props = createTestPropertyBag(); // from src/test-fixtures/model-fixtures.ts
  props.replaceModelParams({
    ...BJT_NPN_DEFAULTS,
    ...OPTOCOUPLER_DEFAULTS,
    ...overrides,
  });
  return props;
}
```

If the relevant `*_DEFAULTS` constant does **not** exist in the
production source for a given composite, **STOP — return with the
question**: "no `*_DEFAULTS` export found in `<file>`; please specify
the canonical defaults constant or authorize creating one."

#### Step 3 — Update tests that hand-write `replaceModelParams({...})`

If a test currently passes a partial parameter map missing one or more
sub-element keys (NF, ctr, gmMax, aol, vTH, voltage, etc.), replace it
with a call to the `make<Composite>Props()` helper from Step 2.

### Explicit non-goals
- Do not modify any production source file.
- Do not introduce a fallback in `properties.ts:setModelParam` that
  silently accepts unknown keys.
- Do not skip any failing test.

---

## §J3 — State-slot lookup by name (capacitor / inductor / resistor / clock)

### Files in scope
1. `src/components/passives/__tests__/capacitor.test.ts`
2. `src/components/passives/__tests__/inductor.test.ts`
3. `src/components/passives/__tests__/resistor.test.ts`
4. `src/components/io/__tests__/analog-clock.test.ts`

### Root cause
Tests use a hand-rolled `makeCaptureSolver()` mock that simulates
`allocElement` / `stampElement` / `stampRHS`, but the production element
path now requires `setup(ctx)` to allocate TSTALLOC handles and pool
slots before `load(ctx)` can stamp. The mock's `stamps[]` array is
indexed by handles that the mock never allocated (because tests skip
`setup()`), causing `stamps[h]` to be `undefined`.

### Migration pattern

#### Step 1 — Delete the `makeCaptureSolver()` helper.

Search the file for `function makeCaptureSolver` and delete the entire
function. Also delete `vi` from the `vitest` import (it is otherwise
only used by `makeCaptureSolver`).

#### Step 2 — Replace usage with real `SparseSolver` + `setupAll`.

```ts
// BEFORE
const { solver, stamps, rhsStamps } = makeCaptureSolver();
const ctx = makeCompanionCtx({ solver, rhs: voltages, dt: 1e-6, method: "trapezoidal", order: 2 });
analogElement.load(ctx);

const geqStamps = stamps.filter((s) => s[2] > 0);
expect(geqStamps.length).toBe(2);
```

```ts
// AFTER
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

const solver = new SparseSolver();
solver._initStructure();

const setupCtx = makeTestSetupContext({
  solver,
  startBranch: 10,   // arbitrary, must be set
  startNode: 100,    // arbitrary, must be set
  elements: [analogElement],
});
setupAll([analogElement], setupCtx);

const rhs = new Float64Array(8);
rhs[0] = 5; rhs[1] = 0;  // seed node voltages (was `voltages` Float64Array)
const ctx = makeCompanionCtx({ solver, rhs, dt: 1e-6, method: "trapezoidal", order: 2 });
analogElement.load(ctx);

const entries = solver.getCSCNonZeros();
const geqEntries = entries.filter((e) => e.value > 0);
expect(geqEntries.length).toBe(2);
```

**Required:** `setupAll` must be called **after** `withState()` so that
the element has its `_stateBase` set, but `setup()` will overwrite
`_stateBase` via `ctx.allocStates(...)`. The current `withState()`
helper in capacitor.test.ts manually sets `_stateBase = 0` and calls
`initState`. Replace `withState` with this pattern:

```ts
// New helper at top of test file
function withRealSetup(core: AnalogElement, solver: SparseSolverType): {
  element: PoolBackedAnalogElement;
  pool: StatePool;
  setupCtx: ReturnType<typeof makeTestSetupContext>;
} {
  const re = core as PoolBackedAnalogElement;
  const setupCtx = makeTestSetupContext({
    solver,
    startBranch: 10,
    startNode: 100,
    elements: [re],
  });
  setupAll([re], setupCtx);
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.initState(pool);
  return { element: re, pool, setupCtx };
}
```

Use `withRealSetup` in place of `withState`.

#### Step 3 — Replace state-slot-by-index access.

Search for any `el.stateSchema[<number>]` indexing and replace by name
lookup:

```ts
// BEFORE
const offset = el.stateSchema[2].offset;
```

```ts
// AFTER — read the slot name from the element source then look it up
const offset = el.stateSchema.V_PREV.offset;  // e.g.
```

The slot names per element are documented in each element's
`stateSchema` declaration at the top of its source file. If the test
file has more than 5 distinct slot indices to migrate and the source
file does not have a single, named-keyed `stateSchema` export, **STOP —
return with the question**: "schema for `<element>` lacks a named-key
export; please confirm whether to add one or use a different lookup
mechanism."

#### Step 4 — Resistor / clock specifics.

`resistor.test.ts:362` (`load(ctx) stamps G=1/R bit-exact for R=1kΩ`)
and `analog-clock.test.ts` have similar mock-solver patterns. Apply
Steps 1–2; Step 3 only applies to capacitor/inductor.

### Explicit non-goals
- Do not modify any production source file.
- Do not change which integration methods or test cases are covered.

---

## §J4 — Definitions no longer expose `branchCount`

### Files in scope
1. `src/components/passives/__tests__/inductor.test.ts` — test
   "InductorDefinition branchCount is 1" near line 240
2. `src/components/passives/__tests__/transformer.test.ts` — test
   "branchCount is 2" near line 814
3. `src/components/passives/__tests__/transmission-line.test.ts` — test
   "requires branch row" near line 745
4. `src/components/sources/__tests__/variable-rail.test.ts` — test
   "definition_has_requires_branch_row" near line 118

### Migration pattern

For each named test above:

#### Step 1 — Delete the test.

The `branchCount` field and `requires` / `requiresBranchRow` predicate
on `ModelEntry` / element definitions were removed (per spec
§A.21: "compiler drops eager branchCount pre-summation"). Asserting on
their absence is no longer meaningful — the new contract is that the
element allocates its own branch row inside `setup()`.

Use the `it("...", () => { ... })` block boundaries; remove the entire
block including its `it(` line and matching `});`. Leave surrounding
tests untouched.

#### Step 2 — Add a replacement test in the same file.

Right where the deleted test was, insert this replacement that asserts
the new contract:

```ts
it("element allocates a branch row in setup()", () => {
  const factory = getFactory(<Definition>.modelRegistry!.<defaultModel>!);
  const el = factory(new Map([/* canonical pin nodes for this element */]), <props>, () => 0);
  el.label = "L1"; // arbitrary label

  const solver = new SparseSolver();
  solver._initStructure();
  const setupCtx = makeTestSetupContext({
    solver,
    startBranch: 5,
    startNode: 100,
    elements: [el],
  });
  setupAll([el], setupCtx);

  expect(el.branchIndex).toBeGreaterThanOrEqual(0);
});
```

For elements with multiple branches (e.g. transformer with two
windings), the replacement asserts that `setup()` allocated more than
one branch via `findBranchFor(label, ctx)` lookups. If the element does
not expose a way to enumerate branch rows post-setup, **STOP — return
with the question**: "transformer/transmission-line element has multiple
branches but no enumeration accessor; please specify the assertion
shape."

For `transmission-line.test.ts` test "requires branch row": if the
production element does NOT own a primary branch row (TLINE may stamp
through internal sub-elements only), **STOP — return**.

For `variable-rail.test.ts` test "definition_has_requires_branch_row":
the variable-rail is a voltage source. Step-2 replacement uses the
voltage-source-style assertion on `el.branchIndex >= 0` after setup.

### Explicit non-goals
- Do not modify any production source file.
- Do not skip tests by renaming them or stubbing assertions.

---

## §J5 — `stateSchema` slot-count assertions

### Files in scope
1. `src/components/passives/__tests__/transmission-line.test.ts` — tests:
   - "SegmentInductorElement sub-elements declare stateSchema with 5 slots" (~line 901)
   - "SegmentCapacitorElement sub-elements declare stateSchema with 5 slots" (~line 912)
   - "CombinedRLElement sub-element declares stateSchema with 5 slots" (~line 923)
2. `src/solver/analog/__tests__/digital-pin-model.test.ts` — tests:
   - "output_load_branch_role_drive_loaded" (~line 157)
   - "output_load_branch_role_hiz_ideal" (~line 177)

### Migration pattern

Each test asserts a literal slot count. The slot count was rebalanced
during the wave (per §A.7 follow-up: tapped-transformer schema overshoots
actual usage, and segment elements may have been re-sized).

#### Step 1 — For each failing assertion, look up the production schema directly.

For transmission-line tests: open
`src/components/passives/transmission-line.ts` and find the
`stateSchema` declaration on `SegmentInductorElement`,
`SegmentCapacitorElement`, `CombinedRLElement`. Count the keys (each
key in the `stateSchema` object is one slot).

For digital-pin-model tests: open
`src/solver/analog/digital-pin-model.ts` and find the relevant schema /
branch-role definition.

#### Step 2 — Replace the literal expected count.

```ts
// BEFORE
expect(SegmentInductorElement.stateSchema.size).toBe(5);  // or similar literal
```

```ts
// AFTER — use Object.keys(...).length to make the test schema-driven
import { SegmentInductorElement } from "../transmission-line.js";
expect(Object.keys(SegmentInductorElement.prototype.stateSchema).length)
  .toBe(/* actual count from the source */);
```

If the test currently uses a literal-count assertion that was meant to
**lock the schema shape**, replace it with a deeper structural assertion
that lists the expected keys by name:

```ts
expect(Object.keys(stateSchema).sort()).toEqual(
  ["GEQ", "IEQ", "I_PREV", "V_PREV", "V_PREV_PREV"].sort()
);
```

If you cannot determine the canonical key set from the source, **STOP**.

### Explicit non-goals
- Do not modify the production schema definitions.

---

## §J6 — Transformer winding-resistance test missing `setup()`

### File in scope
1. `src/components/passives/__tests__/transformer.test.ts` — test
   `winding_resistance_drops_voltage` at line ~190.

### Migration pattern

This test currently calls `el.load(ctx)` without first running `setup()`,
so the closure-local TSTALLOC handles in the transformer factory are
still `-1`, causing `Cannot destructure property 'row' of handles[handle] as it is undefined`.

#### Step 1 — Insert `setup()` before the failing `load()`.

```ts
// BEFORE
const el = factory(pinNodes, props, () => 0);
// ... (test sets up rhs etc.)
el.load(ctx);
```

```ts
// AFTER
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

const solver = new SparseSolver();
solver._initStructure();
const el = factory(pinNodes, props, () => 0);
el.label = "T1";

const setupCtx = makeTestSetupContext({
  solver,
  startBranch: 10,
  startNode: 100,
  elements: [el],
});
setupAll([el], setupCtx);

// ... (test sets up rhs etc.)
el.load(ctx);
```

### Explicit non-goals
- Do not change any other test in this file.
- Do not modify production transformer source.

---

## §J7 — TSTALLOC golden sequences (PB-BJT, PB-IND, PB-SCR, PB-TLINE)

### Status
**BLOCKED on §E5 escalation.** Whether to re-record the goldens depends
on whether the new TSTALLOC order matches ngspice. Do not attempt this
job until the user confirms the new order is ngspice-correct.

If the user has already filed §E5 and approved re-recording: open
`src/solver/analog/__tests__/setup-stamp-order.test.ts`, run the failing
tests in capture mode (instructions in the test file's header comment),
and paste the captured `extRow`/`extCol` arrays in place of the existing
goldens. **Agents must NOT do this without explicit user authorization.**
If invoked without authorization, STOP and return.

---

## §J8 — `TEMP` key in default model bags (Zener, Schottky)

### File in scope
1. `src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts`
   — tests:
   - `ZenerDiode: default model entry has params record with TEMP key`
   - `SchottkyDiode: default model entry has params record with TEMP key`

### Investigation gate (do this BEFORE editing)

Open `src/components/semiconductors/zener.ts` and
`src/components/semiconductors/schottky.ts`. Find the constant that
holds the default param map for each model — likely named
`ZENER_DEFAULT_PARAMS`, `ZENER_DEFAULTS`, `SCHOTTKY_DEFAULT_PARAMS`,
or similar.

Inspect each defaults object. Two possibilities:

- **Case A:** The defaults object **already** contains `TEMP: 300.15`
  (or equivalent). In that case the test must be reading a different
  default-source than the production element actually uses. This is an
  ambiguity — STOP and return.

- **Case B:** The defaults object **does not** contain `TEMP`. Other
  diode variants (`diode.ts` `DIODE_DEFAULTS`) DO contain `TEMP: 300.15`.
  This means the Zener/Schottky defaults are missing a parameter that
  the temperature-recompute path requires. This is a production gap —
  STOP and return for user authorization to add `TEMP: 300.15` to the
  defaults objects.

**Do not pick a case yourself. Investigate and STOP for user input.**

### Explicit non-goals
- Do not modify production zener.ts / schottky.ts.

---

## §J9 — UTF-8 BOM artifact in `coordinator-speed-control.test.ts`

### File in scope
1. `src/solver/__tests__/coordinator-speed-control.test.ts` — test at
   line 271, `formatSpeed returns micros/s for rate in 1e-6 to 1e-3 range`.

### Migration pattern

The test asserts the literal `"Âµs/s"` (mojibake from a windows-1252 →
UTF-8 round trip), but production emits the correct `"µs/s"`.

#### Step 1 — Find the assertion.

Locate the line near `expect(...).toBe("Âµs/s")` (the actual byte
sequence is `\xC3\x82\xC2\xB5s/s`).

#### Step 2 — Replace the literal with the correct UTF-8 micro sign.

```ts
// BEFORE (mojibake)
expect(formatSpeed(rate)).toBe("Âµs/s");
```

```ts
// AFTER
expect(formatSpeed(rate)).toBe("µs/s");
```

The `µ` character (U+00B5, MICRO SIGN) is two bytes in UTF-8: `0xC2 0xB5`.
Save the file with UTF-8 encoding, no BOM. Confirm via `git diff` that
only the bytes inside the string literal change.

### Explicit non-goals
- Do not change the test's assertion intent.
- Do not modify the surrounding test code.

---

## §J10 — Compile output: `statePool` is `null` (deferred to setup)

### File in scope
1. `src/solver/analog/__tests__/compile-analog-partition.test.ts` — tests:
   - `compiled circuit has a statePool field that is a StatePool instance` (line ~514)
   - `statePool totalSlots is 0 when all elements have stateSize 0 ...` (line ~522)
   - `statePool is a fresh StatePool instance per compile call ...` (line ~542)
   - `elements with stateSize get contiguous _stateBase values assigned by compiler` (line ~551)

### Migration pattern

Per `compiler.ts` line 1595:
> // State pool: deferred to setup time (A5.3). Compiled statePool is null;
> const statePool = null as unknown as StatePool;

The compiler no longer allocates the StatePool — `setup()` does. Tests
that assert pool existence on the compiler output enforce a stale
contract.

#### Step 1 — Replace the four tests with three contract-locking tests.

Delete the four tests by their full `it("...", () => { ... })` blocks.
Insert these three replacements in the same describe block:

```ts
it("compiled circuit has statePool === null (deferred to setup time)", () => {
  const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
  const { partition, registry } = buildAndGatePartition(propsMap);
  const compiled = compileAnalogPartition(partition, registry);
  expect(compiled.statePool).toBeNull();
});

it("compiled elements have _stateBase === -1 (allocated by setup, not compiler)", () => {
  const propsMap = new Map<string, PropertyValue>([["model", "behavioral"]]);
  const { partition, registry } = buildAndGatePartition(propsMap);
  const compiled = compileAnalogPartition(partition, registry);
  for (const element of compiled.elements) {
    expect(element._stateBase).toBe(-1);
  }
});

it("setup() assigns contiguous _stateBase values via ctx.allocStates", () => {
  // Reuse the test-registry fixture that builds a stateful element.
  // Run real setup() against a SparseSolver and assert _stateBase is no
  // longer -1.

  // ... (the existing test 5 fixture body, but instead of asserting
  //      compiled.statePool.totalSlots === 7 and assignedBase === 0,
  //      run setupAll([elementWithState], setupCtx) and assert
  //      elementWithState._stateBase === 0 after setup.)
});
```

The third test requires migrating the existing `elements with
stateSize get contiguous _stateBase values assigned by compiler` test
fixture body. That body is large (~120 lines starting at line 551).
Keep the partition / registry / element-stub setup as-is; replace the
final assertion block:

```ts
// BEFORE (lines ~657-664)
const compiled = compileAnalogPartition(partition, registry);

// The element with stateSize:7 should have been assigned offset 0
expect(assignedBase).toBe(0);
expect(compiled.statePool.totalSlots).toBe(7);
// initState wrote 99.0 to slot 0
expect(compiled.statePool.state0[0]).toBe(99.0);
```

```ts
// AFTER
const compiled = compileAnalogPartition(partition, registry);

// Pool deferred to setup; compiler does not assign _stateBase or
// allocate a pool. Run the engine boot path (or a manual setupAll +
// initState pass) to verify the stateful element gets its slot.
const solver = new SparseSolver();
solver._initStructure();
const setupCtx = makeTestSetupContext({
  solver,
  startBranch: 1,
  startNode: 100,
  elements: compiled.elements,
});
setupAll(compiled.elements, setupCtx);

const stateful = compiled.elements.find(
  (e): e is typeof elementWithState => (e as any).poolBacked === true
)!;
expect(stateful._stateBase).toBe(0);

const pool = new StatePool(stateful.stateSize);
stateful.initState(pool);
expect(pool.state0[0]).toBe(99.0);
```

Update imports at the top of the file as needed:
```ts
import { SparseSolver } from "../sparse-solver.js";
import { makeTestSetupContext, setupAll } from "./test-helpers.js";
```

If the existing test fixture's `elementWithState.setup` is a no-op (it
is — line 568), the manual `_stateBase = 0` assignment must come from
the test:

Looking at the stub more closely (line 560–576): the stub's `setup` is a
no-op but its `initState` reads `this._stateBase`. Per the new contract
the compiler does NOT assign `_stateBase`; the element does, inside its
own `setup(ctx)`. The stub's `setup` therefore needs to be updated:

```ts
setup(ctx: import("../setup-context.js").SetupContext): void {
  this._stateBase = ctx.allocStates(this.stateSize);
},
```

Make this change to the stub at line 568 as part of this migration.

### Explicit non-goals
- Do not modify `compiler.ts`.
- Do not move the test to a different file.

---

## §J11 — Harness query API: `SlotTrace`, `ComponentSlotsSnapshot`, `StateHistoryReport`

### Files in scope
1. `src/solver/analog/__tests__/harness/query-methods.test.ts` — failing tests 34, 35, 37, 38, 57, 58
2. `src/solver/analog/__tests__/harness/stream-verification.test.ts` — test "12. state history: state1Slots and state2Slots populated"
3. `src/components/passives/__tests__/resistor.test.ts:362` — `load(ctx) stamps G=1/R bit-exact for R=1kΩ` (this is misclassified — it belongs to §J3 and is removed from §J11 scope)

### Investigation gate

Read the current production harness API in:
- `src/solver/analog/__tests__/harness/query.ts`
- `src/solver/analog/__tests__/harness/capture.ts`
- `src/solver/analog/__tests__/harness/types.ts`
- `src/solver/analog/__tests__/harness/comparison-session.ts`

Map the assertions used in the failing tests to currently-exported
methods/fields. The failures are `expected undefined to be defined`,
meaning the test is calling a method that does not exist or fields that
were renamed.

#### Step 1 — Tests 34, 35, 37, 38, 57, 58

These all hit `session.traceComponentSlot(...)`, `session.getStateHistory(...)`,
or `session.getComponentSlots(...)`. Read `comparison-session.ts` to find
the actual current method names. Three possibilities:

- **A:** The methods exist but return a slightly different shape (e.g.
  `state1Slots` was renamed to `state1`). Update the test assertion to
  the new field name.

- **B:** The methods were removed (replaced by free functions in
  `query.ts`). Migrate the test to call the free function directly.

- **C:** The methods exist but the underlying captured data is empty
  because the test fixture circuit has no pool-backed components, so
  `components.find(c => c.slotNames.length > 0)` returns undefined and
  the subsequent `poolBacked!.slotNames[0]` throws / returns undefined.
  In that case the fixture circuit needs a pool-backed component (e.g. a
  capacitor, inductor, or diode). Update the fixture builder.

If you cannot definitively pick A vs B vs C from reading the harness
sources, **STOP and return** with the specific method name that is
ambiguous and which shape variants you observed.

#### Step 2 — `stream-verification` test 12

`state1Slots and state2Slots populated`. Cross-reference
`comparison-session.ts` for the field name carrying state-1 / state-2
arrays in the verification stream. If the stream emits
`state1: number[]` (no `Slots` suffix), update the assertion.

### Explicit non-goals
- Do not modify any harness source file.
- Do not modify `query.ts` / `capture.ts` / `types.ts` /
  `comparison-session.ts` even if their API surface looks incomplete.

---

## §J12 — `behavioral-sequential` migrate to `DefaultSimulatorFacade`

### File in scope
1. `src/solver/analog/__tests__/behavioral-sequential.test.ts` — failing tests:
   - `counts_on_clock_edges` (~line 235)
   - `clear_resets_to_zero` (~line 249)
   - `output_voltages_match_logic` (~line 290)
   - `latches_all_bits` (~line 318)
   - `holds_value_across_timesteps` (~line 348)
   - `sequential_pin_loading_propagates` (~line 475)

### Investigation gate

Read the current `behavioral-sequential.test.ts` end to end. The failing
tests assert analog-rail voltages on flip-flop / counter outputs that
are 0 instead of 5/3/85/165 etc.

Two possible roots:
- **A — production regression:** The bridge adapter no longer drives
  rOut by default. This is K-class, NOT a J fix.
- **B — test-side regression:** The test wires the digital pins through
  a hand-rolled solver poke instead of the production
  `DefaultSimulatorFacade.compile()` + `step()` path. Per CLAUDE.md
  three-surface rule, headless-API tests must use the facade.

**Decision criterion:** If the failing tests build a circuit dictionary
(i.e., they go through `compileAnalogPartition` or the facade), root is
likely A — STOP and return. If they hand-build a synthesized partition
or hand-stamp into a SparseSolver, root is likely B — proceed to the
migration below.

#### Step 1 (only if root is B) — Migrate to `DefaultSimulatorFacade`.

```ts
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

it("counts_on_clock_edges", async () => {
  const facade = new DefaultSimulatorFacade();
  // Build the circuit through the facade — either via loadJson(jsonSpec)
  // for a JSON-defined circuit, or via the CircuitBuilder API.
  await facade.loadJson(<spec>);
  await facade.compile();

  // Drive the clock by stepping with the input signal toggled
  facade.setSignal(<clockNet>, true);
  await facade.step(1e-3);
  facade.setSignal(<clockNet>, false);
  await facade.step(1e-3);

  // Read output voltage / signal
  const out = facade.readSignal(<outNet>);
  expect(out).toBe(5);
});
```

If the existing test does NOT have a JSON-defined circuit available
and the migration would require fabricating one, **STOP and return**.

### Explicit non-goals
- Do not modify any production source file.
- Do not modify `behavioral-sequential.ts` even if it looks like the
  signal-drive path is incomplete.

---

## §J14 — Misc small-blast-radius rewrites

### J14a — `varactor.test.ts` `setup_allocates_handles_before_load`

#### File in scope
1. `src/components/semiconductors/__tests__/varactor.test.ts:162`

#### Migration

The test asserts on `el._h<something>` — a TSTALLOC handle field. Per
spec §A.9, handles are now closure-local in inline factories, not on
the returned literal.

##### Step 1 — Replace the field-existence assertion with a post-load matrix entry assertion.

```ts
// BEFORE
expect(el._hPP).toBeGreaterThanOrEqual(0);
```

```ts
// AFTER — assert that setup() registered a stamp at the expected (row, col) position
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

const solver = new SparseSolver();
solver._initStructure();
const setupCtx = makeTestSetupContext({
  solver,
  startBranch: 5,
  startNode: 100,
  elements: [el],
});
setupAll([el], setupCtx);
// Confirm setup allocated at least one matrix entry
const order = solver._getInsertionOrder();
expect(order.length).toBeGreaterThan(0);
```

If the test asserts on a SPECIFIC handle name with semantic meaning
(e.g. `_hAA` is the (anode,anode) diagonal stamp), **STOP and return**:
"varactor test asserts on closure-local handle name; please specify the
post-setup assertion that locks the same intent."

### J14b — `wire-current-resolver.test.ts`

#### Files in scope
1. `src/editor/__tests__/wire-current-resolver.test.ts` — failing tests:
   - `cross-component current equality through real compiled lrctest.dig`
   - `component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current`

#### Status
**STOP and return.** These are integration tests against real `.dig`
fixtures; the failure values (0 vs >0.045) suggest a production-side
regression (current resolver returns 0). This is K-class, not J-class.
Do NOT attempt to migrate.

### Explicit non-goals (across J14)
- Do not modify production source.
- Do not skip / rename failing tests.

---

## Section Z — Common addendum: helper that may not yet exist

If any §J-spec above tells you to use a helper that does not exist in
`src/solver/analog/__tests__/test-helpers.ts` (such as `sumMatrixEntry`),
**STOP and return**. Do not invent a helper. The user will add the
helper or revise the spec.

