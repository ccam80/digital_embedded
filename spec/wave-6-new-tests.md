# Wave 6 — New tests (§10.4)

> Source: `docs/harness-redesign-spec.md` §10.4, §10.5, §12.7.
> Wave dependency: Wave 3 (shape API + self-compare landed), Wave 5 (MCP shape mode + UI conflict notification landed).
> Sizing: sonnet.
> Runs in parallel with: Wave 4, Wave 5.
> Exit gate: all §10.4 tests pass; full regression sweep per §10.6 shows no new failures vs `spec/test-baseline.md`.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W6.T1 | Headless tests for shape, getStepAtTime, master switch, throw-on-conflict, defer initialize, idempotency | `src/solver/analog/__tests__/harness/*.test.ts` (likely a new `shape.test.ts` and `master-switch.test.ts`) | L |
| W6.T2 | MCP tests for `harness_query { mode: "shape" }`, stepEnd presence, `circuit_convergence_log` disable error | `scripts/mcp/__tests__/*.test.ts` | M |
| W6.T3 | E2E tests for UI panel conflict notification and panel `iterationDetails` | `e2e/**/*.spec.ts` | M |

---

## W6.T1 — Headless tests

Add the nine headless tests listed in §10.4. Each test is independent and can be in the same file or split. Recommend grouping by feature:

### `src/solver/analog/__tests__/harness/shape.test.ts` (new file)

```ts
import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session";
import { makeRC, makeHWR } from "./fixtures"; // or wherever the test factories live

describe("getSessionShape", () => {
  it("5-step self-compare returns presenceCounts: { both: 5, oursOnly: 0, ngspiceOnly: 0 }", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: () => makeRC().circuit,
      analysis: "tran",
      tStop: 5e-6,
      maxStep: 1e-6,
    });
    const shape = session.getSessionShape();
    expect(shape.presenceCounts).toEqual({ both: 5, oursOnly: 0, ngspiceOnly: 0 });
  });

  it("self-compare getStepShape(0).stepStartTimeDelta is exactly 0 (Goal F mechanical proof)", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: () => makeHWR().circuit,
      analysis: "dcop",
    });
    expect(session.getStepShape(0).stepStartTimeDelta).toBe(0);
  });

  // For the asymmetric-tail test, you may need a non-self-compare divergent fixture
  // OR a self-compare where ourSession.steps is artificially truncated after the run.
  // The simplest path: build a session, run it, then manually pop steps off
  // ourSession.steps before calling getSessionShape — but that requires a public
  // back door. If no back door exists, build a real divergent fixture (a circuit
  // known to produce different step counts between our engine and ngspice).
  it("truncated ourSession reports presence: ngspiceOnly for the missing tail", async () => {
    // Implement the test with whatever mechanism is cleanest given the file's
    // existing test infrastructure. If you must reach into protected fields,
    // do so via TypeScript `as any` cast — the harness owns its own internals
    // and there's no production-code consumer of this back door.
  });
});

describe("getStepAtTime", () => {
  it("returns 0 for t=0 on a session with boot step (0,0)", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: () => makeHWR().circuit,
      analysis: "dcop",
    });
    expect(session.getStepAtTime(0)).toBe(0);
  });

  it("returns null for t > simTime", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: () => makeRC().circuit,
      analysis: "tran",
      tStop: 1e-6,
    });
    expect(session.getStepAtTime(1e6)).toBeNull();
  });
});
```

### `src/headless/__tests__/master-switch.test.ts` (new file or merge into existing)

```ts
import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../default-facade";
// ... fixtures

describe("setCaptureHook master switch", () => {
  it("flips all five engine flags atomically when bundle is installed", () => {
    const facade = new DefaultSimulatorFacade(/* ... */);
    const circuit = /* trivial */;
    const coord = facade.compile(circuit) as DefaultSimulationCoordinator;
    const engine = coord.getAnalogEngine() as MNAEngine;

    const bundle: PhaseAwareCaptureHook = { iterationHook: noopHook, phaseHook: { onAttemptBegin: () => {}, onAttemptEnd: () => {} } };
    facade.setCaptureHook(bundle);

    expect(engine.postIterationHook).toBe(bundle.iterationHook);
    expect(engine.stepPhaseHook).toBe(bundle.phaseHook);
    expect(engine.detailedConvergence).toBe(true);
    expect(engine.limitingCollector).not.toBeNull();
    expect(engine.convergenceLog.enabled).toBe(true);
  });

  it("setConvergenceLogEnabled(false) throws when bundle installed", () => {
    const facade = new DefaultSimulatorFacade(/* ... */);
    const circuit = /* trivial */;
    facade.compile(circuit);
    facade.setCaptureHook(/* bundle */);
    expect(() => facade.setConvergenceLogEnabled(false)).toThrowError(/comparison harness/);
  });

  it("setCaptureHook(null) restores pre-hook log state", () => {
    const facade = new DefaultSimulatorFacade(/* ... */);
    const circuit = /* trivial */;
    const coord = facade.compile(circuit) as DefaultSimulationCoordinator;
    const engine = coord.getAnalogEngine() as MNAEngine;

    facade.setConvergenceLogEnabled(true);   // user enables BEFORE harness
    facade.setCaptureHook(/* bundle */);
    facade.setCaptureHook(null);
    expect(engine.convergenceLog.enabled).toBe(true);   // restored
  });
});
```

### `src/headless/__tests__/compile-defer-initialize.test.ts`

If Wave 2 already added the smoke tests, extend that file. If not, create it. Tests:

- `compile(c, { deferInitialize: true })` returns coordinator whose `dcOperatingPoint()` is null.
- After `coordinator.initialize()`, `getDcOpResult()` returns the cached result.
- `coordinator.initialize()` is idempotent — second call returns the same result without re-running.

### Acceptance (W6.T1)

- All nine §10.4 headless tests pass.
- Tests live in `src/**/__tests__/*.test.ts` and run as part of `npm run test:q`.

---

## W6.T2 — MCP tests

Add the three MCP tests listed in §10.4. Likely live in `scripts/mcp/__tests__/harness-mcp-verification.test.ts` or a new sibling file.

```ts
describe("harness_query shape mode", () => {
  it("returns a SessionShape object", async () => {
    // Use the MCP server's in-process test harness (look at how other harness-tools.test.ts tests work).
    const handle = await startHarnessSession({ /* trivial circuit */ });
    await runHarnessSession(handle, "dcop");
    const result = await callTool("harness_query", { handle, mode: "shape" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("presenceCounts");
    expect(parsed).toHaveProperty("steps");
    expect(parsed).toHaveProperty("largeTimeDeltas");
    expect(parsed.analysis).toMatch(/dcop|tran/);
  });
});

describe("harness_query stepEnd presence", () => {
  it("returns the presence field on stepEnd responses", async () => {
    const handle = await startHarnessSession({ /* trivial */ });
    await runHarnessSession(handle, "dcop");
    const result = await callTool("harness_query", { handle, mode: "stepEnd", stepIndex: 0 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.presence).toMatch(/both|oursOnly|ngspiceOnly/);
  });
});

describe("circuit_convergence_log disable conflict", () => {
  it("returns a clear error when a harness is installed", async () => {
    // Install a harness, then attempt to disable the log via the MCP tool.
    await startHarnessSession({ /* ... */ });
    const result = await callTool("circuit_convergence_log", { action: "disable" });
    // The result is an MCP error response, not a thrown exception.
    expect(result.content[0].text).toMatch(/comparison harness|harness session/);
  });
});
```

The exact `callTool` / `startHarnessSession` helpers depend on how the existing MCP tests are structured. Read `scripts/mcp/__tests__/harness-mcp-verification.test.ts` first.

### Acceptance (W6.T2)

- All three MCP tests pass.
- Tests live in `scripts/mcp/__tests__/*.test.ts` and run as part of `npm run test:q`.

---

## W6.T3 — E2E tests

Add the two E2E tests listed in §10.4. Live in `e2e/**/*.spec.ts`.

```ts
import { test, expect } from "@playwright/test";
import { SimulatorHarness } from "../fixtures/simulator-harness";

test.describe("convergence log panel + harness conflict", () => {
  test("panel toggle while harness active surfaces conflict notification", async ({ page }) => {
    const harness = await SimulatorHarness.create(page);
    await harness.loadCircuit(/* trivial */);

    // Start a comparison harness session via the postMessage API.
    await harness.startComparisonHarness();

    // Open the convergence log panel from the UI.
    await page.click("[data-testid='convergence-log-panel-toggle']");

    // Try to disable the log via the panel.
    await page.click("[data-testid='convergence-log-disable-button']");

    // Expect a notification.
    const notification = page.locator("[data-testid='notification']");
    await expect(notification).toContainText(/comparison harness/i);
  });

  test("panel auto-open shows iterationDetails for harness-enabled sessions", async ({ page }) => {
    const harness = await SimulatorHarness.create(page);
    await harness.loadCircuit(/* trivial */);
    await harness.startComparisonHarness();

    await page.click("[data-testid='convergence-log-panel-toggle']");

    // Verify that at least one log row exposes iterationDetails (e.g. via a toggle to expand the row).
    const detailRow = page.locator("[data-testid='iteration-details']").first();
    await expect(detailRow).toBeVisible();
  });
});
```

The exact selectors (`data-testid` attributes) and `SimulatorHarness` API depend on the existing E2E infrastructure. Read `e2e/fixtures/simulator-harness.ts` first to find the right helpers. If a `startComparisonHarness` method doesn't exist on the harness, you'll need to add it as a thin wrapper that posts the relevant `sim-` messages.

If the UI doesn't currently expose the disable button or the iteration details row via testable selectors, add the data-testid attributes to the relevant components in `src/app/convergence-log-panel.ts` (Wave 5's responsibility, but acceptable as an in-Wave-6 followup if discovered during test writing — surface it in `spec/progress.md` for the verifier).

### Acceptance (W6.T3)

- Both E2E tests pass via `npm run test:e2e -- convergence-log-panel`.
- The tests use the existing `SimulatorHarness` fixture.

---

## Wave 6 exit checklist

- [ ] All nine headless tests in §10.4 pass.
- [ ] All three MCP tests in §10.4 pass.
- [ ] Both E2E tests in §10.4 pass.
- [ ] `npm run test:q` — full sweep does not introduce new failures vs `spec/test-baseline.md`.
- [ ] Per §10.6 regression sweep: focused harness + e2e convergence-log-panel + MCP harness end-to-end all green (modulo known BJT failures).

## Hard rules

- Read `CLAUDE.md` and `spec/test-baseline.md` first.
- Read the existing test infrastructure (`SimulatorHarness`, MCP test helpers, fixture factories) before inventing new patterns.
- Do NOT modify production code in this wave. If a test reveals a Wave 3 or Wave 5 bug, surface it in `spec/progress.md` for the verifier.
- The tests must run as real tests, not as smoke checks or `xit` placeholders.
