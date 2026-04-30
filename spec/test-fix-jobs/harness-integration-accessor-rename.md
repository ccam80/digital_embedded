# harness-integration: accessor expectations against fixture compile flow

## Category

`contract-update`

## Problem

The briefing names this cluster as "3 tests asserting on engine accessors that were renamed/relocated." Direct verification against the source rules out a rename: `MNAEngine` exposes `solver`, `statePool`, `elements`, `compiled`, `integrationOrder`, `currentDt`, `simTime`, `postIterationHook`, `preFactorHook`, `stepPhaseHook` — every accessor the test reaches for is present at its expected name (`src/solver/analog/analog-engine.ts:734`, `:748`, `:1043`, `:1219`, `:1224`, `:1229`, `:1234`).

What is actually broken is the contract between `buildHwrFixture()` (which compiles a circuit through `DefaultSimulatorFacade`, then hands the caller the *compiled circuit object* and a *fresh* expectation that a separate `MNAEngine` can be re-initialised against it) and `MNAEngine.init()` (which expects the supplied compiled circuit to still own a populated `statePool` and pool-backed elements).

Three failing tests share a common shape: they call `engine.init(buildHwrFixture().circuit)` on a fresh `MNAEngine` (the one created in `beforeEach`) instead of using the engine that the fixture already wired up. The fixture's facade-compiled circuit holds a `statePool`, but that statePool was sized and registered against the *fixture's* engine; on the fresh engine the post-init read of `engine.statePool`, `captureElementStates(...)`, and `findLargestDelta(...)` either reads `null` or sees zero pool-backed elements.

This is a contract violation: `buildHwrFixture` returns a `MNAEngine` (`engine`) intentionally so the consumer doesn't double-initialise. The failing tests ignore that field and create a parallel engine.

## Failing tests / sites

`src/solver/analog/__tests__/harness/harness-integration.test.ts`:

| Test | Lines | Failure |
|------|-------|---------|
| `captureElementStates snapshots pool-backed elements` | 233-239 | `expect(states.length).toBeGreaterThan(0)` — receives 0 |
| `MNAEngine exposes accessors after init` | 507-514 | `expect(engine.statePool).not.toBeNull()` — receives null |
| `findLargestDelta identifies worst convergence point` | 536-562 | `expect(result.delta).toBeGreaterThan(0)` — receives 0 because no NR iterations were captured against a viable engine |

`buildHwrFixture` returns `{ circuit, pool, engine }` (see `src/solver/analog/__tests__/harness/hwr-fixture.ts:18-22`) — the third field is the supported re-entry point.

## Migration

Discard the `beforeEach(() => { engine = new MNAEngine(); })` for the describe block, or scope it to the few tests that genuinely need a pristine engine (the only one is `MNAEngine accessors return null/empty before init`, lines 516-521). For every other test, take the engine from the fixture.

### Per-test patches

#### `captureElementStates snapshots pool-backed elements` (lines 233-239)

Before:
```ts
const { circuit, pool } = buildHwrFixture();
engine.init(circuit);
engine.dcOperatingPoint();
const states = captureElementStates(circuit.elements, pool);
```

After:
```ts
const { circuit, pool, engine } = buildHwrFixture();
engine.dcOperatingPoint();
const states = captureElementStates(circuit.elements, pool);
```

#### `MNAEngine exposes accessors after init` (lines 507-514)

Before:
```ts
const { circuit } = buildHwrFixture();
engine.init(circuit);
expect(engine.solver).not.toBeNull();
...
```

After:
```ts
const { engine } = buildHwrFixture();
// Force _setup() to run so solver/statePool are populated.
engine.dcOperatingPoint();
expect(engine.solver).not.toBeNull();
expect(engine.statePool).not.toBeNull();
expect(engine.elements.length).toBe(3);
expect(engine.compiled).not.toBeNull();
```

The `dcOperatingPoint()` call is mandatory: `_setup()` is lazy, and `engine.statePool` reads `_compiled.statePool` which is wired during the first DC-OP. Without that call the accessor returns null even on a correctly compiled circuit.

#### `findLargestDelta identifies worst convergence point` (lines 536-562)

Before:
```ts
const { circuit, pool } = buildHwrFixture();
engine.init(circuit);
const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
```

After:
```ts
const { circuit, pool, engine } = buildHwrFixture();
const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
```

The remainder of the test body (hook wiring, `dcOperatingPoint()`, `endStep`, `findLargestDelta`) is unchanged.

### `MNAEngine accessors return null/empty before init` (lines 516-521) — preserve current behaviour

This is the one test that genuinely needs a fresh engine. Either keep the `beforeEach` for this single test (rare) or replace with an inline `const engine = new MNAEngine()` at the top of the test body. Both are acceptable.

## ngspice citation

Not applicable — these tests assert engine-internal state visibility, not numerical parity.

## Tensions / uncertainties

- The "rename/relocation" framing in the briefing does not match what the source shows. If the briefing was written against an older revision where these accessors lived elsewhere (e.g. on `analogEngine.runtime` or a separate diagnostics surface), the rename has already landed. Either way, the failing assertions are reachable through the current names; the bug is the test wiring, not the contract surface.
- Escalation candidate: `engine.statePool` returns null until `dcOperatingPoint()` runs. The test "MNAEngine exposes accessors after init" is named as if `init()` alone should suffice. If the user's intent is that `init()` populates `statePool`, this is an architectural call, not a test fix — the engine currently defers pool wiring to `_setup()` (lazy) intentionally. Flag for user review whether `init()` should eagerly run `_setup()`.
- The fixture returns a single `MNAEngine` instance; if multiple tests in the suite share fixture compilation work for speed, that's a separate optimisation outside this spec's scope.
