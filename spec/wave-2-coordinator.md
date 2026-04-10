# Wave 2 — Coordinator E1 wiring + facade + engine drain

> Source: `docs/harness-redesign-spec.md` §7, §8, §9.6, §9.7, §9.10, §11.1, §12.3.
> Wave dependency: Wave 1 (types and interface stubs landed).
> Sizing: sonnet (medium-complexity refactor with cross-file lifecycle implications).
> Goals implemented: D (master switch) and E (DCOP deferral via `coordinator.initialize()`).
> Exit gate: see bottom of file.

## Tasks in this wave

| ID | Title | Files | Complexity |
|----|-------|-------|------------|
| W2.T1 | Coordinator: drop in-constructor DCOP, add `initialize()`, add `applyCaptureHook` master switch, add throw-on-conflict | `src/solver/coordinator.ts` | L |
| W2.T2 | Facade: new `setCaptureHook(bundle)` signature, `compile(c, opts)` with `deferInitialize`, throw-on-conflict | `src/headless/default-facade.ts` | M |
| W2.T3 | Engine: drain `iterationDetails` from capture into `NRAttemptRecord` when convergence-log is enabled | `src/solver/analog/analog-engine.ts` | M |
| W2.T4 | Smoke test for `compile(c, { deferInitialize: true })` and `coordinator.initialize()` idempotency | `src/headless/__tests__/*.test.ts` (new or existing) | S |

---

## Goals D and E in plain language

**Goal D — master switch.** Today the harness wires four engine flags one at a time (`postIterationHook`, `stepPhaseHook`, `detailedConvergence`, `limitingCollector`) plus `convergenceLog.enabled`. Spec §7.2 calls this fragile because a future engine field could be added and the harness would silently miss it. Wave 2 introduces `coordinator.applyCaptureHook(bundle | null)` as the single atomic gate that toggles all five.

**Goal E — defer DCOP.** Today `DefaultSimulationCoordinator` constructor calls `engine.dcOperatingPoint()` at line :121, which forces the harness to install a buffering hook BEFORE compile to capture in-constructor DCOP attempts. Wave 2 moves the DCOP call into a new `coordinator.initialize()` method, opt-out via `compile(circuit, { deferInitialize: true })`. Wave 3 will eliminate the buffer entirely on top of this.

---

## W2.T1 — `src/solver/coordinator.ts`

### Constructor changes at `:87-146`

1. **Drop the `captureHook?: MNAEngine["stepPhaseHook"]` constructor parameter** (if it exists in the current signature). Existing call sites pass nothing or `undefined`; the new install path goes through `applyCaptureHook` after construction.
2. **Drop the hook install at `:116-120`** — the line that does something like `engine.stepPhaseHook = captureHook ?? null`. Move that responsibility to `applyCaptureHook`.
3. **Drop the in-constructor DCOP call at `:121`**: remove `this._cachedDcOpResult = engine.dcOperatingPoint();`. Constructor now stops at engine creation. `_cachedDcOpResult` initializes to `null` (or whatever the field default is) and is filled by `initialize()`.

### New private fields

```ts
private _initialized: boolean = false;
private _convergenceLogPreHookState: boolean = false;
private _captureHookInstalled: boolean = false;
```

`_captureHookInstalled` tracks whether a non-null bundle is currently installed; it gates the throw in `setConvergenceLogEnabled`.

### New `initialize()` method (per §8.3)

```ts
initialize(): void {
  if (this._initialized) return;
  if (!this._analog) {
    this._initialized = true;
    return;
  }
  this._cachedDcOpResult = (this._analog as MNAEngine).dcOperatingPoint();
  this._initialized = true;
}
```

The method is idempotent — second call is a no-op. Use whatever the actual engine field name is (`this._analog`, `this._engine`, etc.) — adjust to match the real source.

### New `applyCaptureHook(bundle)` method (per §7.3)

```ts
applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void {
  if (!this._analog) return;
  const e = this._analog as MNAEngine;

  if (bundle === null) {
    e.postIterationHook = null;
    e.stepPhaseHook = null;
    e.detailedConvergence = false;
    e.limitingCollector = null;
    // Restore the convergence log to the state it had before the hook was installed.
    e.convergenceLog.enabled = this._convergenceLogPreHookState;
    this._captureHookInstalled = false;
    return;
  }

  // Capture the pre-hook log state so we can restore it on uninstall.
  if (!this._captureHookInstalled) {
    this._convergenceLogPreHookState = e.convergenceLog.enabled;
  }
  e.postIterationHook = bundle.iterationHook;
  e.stepPhaseHook = bundle.phaseHook;
  e.detailedConvergence = true;
  e.limitingCollector = [];
  e.convergenceLog.enabled = true;
  this._captureHookInstalled = true;
}
```

Notes:
- Pre-hook state is captured ONLY on the first install (when `_captureHookInstalled` was false). Subsequent re-installs without an intervening uninstall keep the original pre-hook state.
- Uninstall (`bundle === null`) restores the pre-hook state. If the user had the convergence log enabled via UI before the harness was installed, it stays enabled after the harness is removed. If they had it disabled, it goes back to disabled.

### Throw in `setConvergenceLogEnabled` at `:382-384` (per §7.5)

```ts
setConvergenceLogEnabled(enabled: boolean): void {
  if (this._captureHookInstalled && enabled === false) {
    throw new Error(
      "Cannot disable convergence log while a comparison harness capture hook is installed. " +
      "Call setCaptureHook(null) first."
    );
  }
  // ... existing implementation
}
```

The throw catches any caller attempting to disable the log while the harness master switch is on. Calling with `enabled === true` while installed is a silent no-op (already true). Calling with `enabled === false` while NOT installed is the existing behavior.

### Acceptance (W2.T1)

- Constructor no longer calls `engine.dcOperatingPoint()`.
- `coordinator.initialize()` exists and runs DCOP exactly once (idempotent).
- `coordinator.applyCaptureHook(bundle)` flips all five flags atomically; passing `null` restores the pre-hook log state.
- `coordinator.setConvergenceLogEnabled(false)` throws the §7.5 message when `_captureHookInstalled` is true.
- `npx tsc --noEmit` — file compiles.

---

## W2.T2 — `src/headless/default-facade.ts`

### `setCaptureHook` signature change at `:118-120` (per §7.3, §9.6)

Old signature:
```ts
setCaptureHook(hook: MNAEngine["stepPhaseHook"]): void
```

New signature:
```ts
setCaptureHook(bundle: PhaseAwareCaptureHook | null): void {
  this._captureHook = bundle;
  // Forward to active coordinator if one already exists. The coordinator
  // owns the master-switch responsibility once installed.
  if (this._coordinator instanceof DefaultSimulationCoordinator) {
    this._coordinator.applyCaptureHook(bundle);
  }
}
```

The stored `_captureHook` field's type changes to `PhaseAwareCaptureHook | null`. Update the import alias at the top of the file (`CaptureHook` → `PhaseAwareCaptureHook`).

### `compile` signature change at `:122-134` (per §8.3, §9.6)

```ts
compile(circuit: Circuit, opts?: { deferInitialize?: boolean }): SimulationCoordinator {
  this._disposeCurrentEngine();
  this._circuit = null;
  this._coordinator = new NullSimulationCoordinator();

  const unified = compileUnified(circuit, this._registry);
  const coordinator = new DefaultSimulationCoordinator(unified, this._registry);
  this._coordinator = coordinator;
  this._circuit = circuit;

  // Apply capture hook BEFORE initialize so the in-init DCOP is captured.
  if (this._captureHook) coordinator.applyCaptureHook(this._captureHook);

  if (!opts?.deferInitialize) {
    coordinator.initialize();
  }
  return coordinator;
}
```

`opts` is optional; existing call sites that pass only `circuit` are unaffected because `initialize()` runs by default. The harness opts in via `compile(circuit, { deferInitialize: true })` (Wave 3 will use this).

### Throw in `setConvergenceLogEnabled` at `:393-396` (per §7.5)

```ts
setConvergenceLogEnabled(enabled: boolean): void {
  if (this._captureHook !== null && enabled === false) {
    throw new Error(
      "Cannot disable convergence log while a comparison harness capture hook is installed. " +
      "Call setCaptureHook(null) first."
    );
  }
  // ... forward to coordinator (which also throws as a defense-in-depth)
}
```

### Acceptance (W2.T2)

- `setCaptureHook(bundle: PhaseAwareCaptureHook | null)` is the new signature.
- `compile(circuit, { deferInitialize: true })` returns a coordinator that has NOT yet run DCOP.
- `compile(circuit)` (no opts) calls `initialize()` immediately — backward compatible.
- `setConvergenceLogEnabled(false)` throws when a capture hook is installed.
- `npx tsc --noEmit` — file compiles.

---

## W2.T3 — `src/solver/analog/analog-engine.ts`

### Drain `iterationDetails` per §7.4, §11.1 Q5

Two sites:
1. `step()` at `:400-408` — the `stepRec.attempts.push` branch.
2. `dcOperatingPoint()` at `:676-687` — the corresponding push branch.

At BOTH sites, after the existing `attempts.push({...})` (or wherever the attempt record is built), wrap the iterationDetails attachment in:

```ts
if (this._convergenceLog.enabled) {
  // populate stepRec.attempts[i].iterationDetails from the capture
  const detail = /* drain from capture mechanism — see below */;
  stepRec.attempts[stepRec.attempts.length - 1].iterationDetails = detail;
}
```

**Where does the iteration detail come from?** Wave 1 / Wave 3 will plumb a `drainForLog(): IterationDetail[]` method on the iteration capture (in `capture.ts`). For Wave 2, the engine code needs the gate condition wired. The actual data source depends on what's available at the engine layer at this point in the cycle.

**Pragmatic Wave 2 approach:** If the engine doesn't currently have access to a drain method, write the gate condition with a TODO marker AND a stub call to a future capture method:

```ts
if (this._convergenceLog.enabled && this._postIterationHook) {
  // The hook holds the per-iteration buffer; drain it onto the attempt record.
  // Wave 3 will provide drainForLog() on the iteration capture.
  const drainable = this._postIterationHook as unknown as { drainForLog?: () => IterationDetail[] };
  if (typeof drainable.drainForLog === "function") {
    stepRec.attempts[stepRec.attempts.length - 1].iterationDetails = drainable.drainForLog();
  }
}
```

This keeps Wave 2's gate present without requiring the capture API to exist yet. Wave 3 implements `drainForLog()` on the iteration capture and the engine call site picks it up automatically.

**Per §11.1 Q5**, the gate is `convergenceLog.enabled` ONLY — but the drain itself only has data when SOMETHING is feeding it. The optional-chaining pattern above lets Wave 2 land safely; Wave 3 wires up the data source.

If `IterationDetail` isn't yet imported in `analog-engine.ts`, add the import from `convergence-log.ts`.

### Acceptance (W2.T3)

- Both `step()` and `dcOperatingPoint()` push branches contain the `convergenceLog.enabled` gate around an `iterationDetails` attachment.
- The gate code compiles even before Wave 3 lands the `drainForLog()` method (use the optional-chaining pattern).
- No regression: existing tests that don't enable the convergence log are unaffected (the gate is false → no work done).

---

## W2.T4 — Smoke test for deferred initialize

Create or extend a unit test (likely `src/headless/__tests__/default-facade.test.ts` if it exists, or create `src/headless/__tests__/compile-defer-initialize.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../default-facade";
import { createDefaultRegistry } from "../../components/registry/default";
// ... whatever fixtures are appropriate; a tiny RC circuit is fine.

describe("compile deferInitialize", () => {
  it("does NOT run DCOP when deferInitialize is true", () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    // Build a trivial circuit that compiles successfully.
    const circuit = /* tiny RC or single-resistor */;
    const coord = facade.compile(circuit, { deferInitialize: true });
    expect(coord.getDcOpResult()).toBeNull();   // or whatever the uninitialized return is
  });

  it("runs DCOP when initialize() is called explicitly", () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = /* same */;
    const coord = facade.compile(circuit, { deferInitialize: true });
    coord.initialize();
    expect(coord.getDcOpResult()).not.toBeNull();
  });

  it("initialize() is idempotent", () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = /* same */;
    const coord = facade.compile(circuit, { deferInitialize: true });
    coord.initialize();
    const first = coord.getDcOpResult();
    coord.initialize();
    expect(coord.getDcOpResult()).toBe(first);
  });

  it("compile without opts runs DCOP immediately (backwards compatible)", () => {
    const facade = new DefaultSimulatorFacade(createDefaultRegistry());
    const circuit = /* same */;
    const coord = facade.compile(circuit);   // no opts
    expect(coord.getDcOpResult()).not.toBeNull();
  });
});
```

You'll need to figure out what shape the trivial circuit takes — look at any existing facade test for the conventional pattern (e.g. `src/headless/__tests__/`).

### Acceptance (W2.T4)

- All four sub-tests pass.
- Tests live in a `*.test.ts` file under `src/headless/__tests__/` and run as part of the standard vitest sweep.

---

## Wave 2 exit checklist

- [ ] `npx tsc --noEmit` — entire codebase compiles. Comparison-session.ts is allowed to fail (Wave 3 fixes it). Other consumers of `compile()` and `setCaptureHook()` MUST compile.
- [ ] `coordinator.ts`: constructor no longer runs DCOP, `initialize()` exists and is idempotent, `applyCaptureHook()` exists and atomically toggles 5 engine flags + tracks pre-hook log state, `setConvergenceLogEnabled(false)` throws when installed.
- [ ] `default-facade.ts`: `setCaptureHook(bundle | null)` new signature, `compile(c, { deferInitialize?: boolean })` new signature, `setConvergenceLogEnabled(false)` throws when installed.
- [ ] `analog-engine.ts`: both push branches have `convergenceLog.enabled` gate around `iterationDetails` attachment.
- [ ] `compile(c, { deferInitialize: true })` smoke tests pass.
- [ ] Existing test sweep: anything that does not touch the harness still passes. **Do not** attempt to fix `comparison-session.ts` failures here — Wave 3 owns that.

## Hard rules

- Read `CLAUDE.md` for non-negotiable project rules.
- No "pragmatic" reductions. If an interface change ripples wider than expected, do the wider work — do not narrow the change.
- The `_convergenceLogPreHookState` field is required even though it adds one boolean — the spec specifies tracked-restore semantics, not always-disable-on-uninstall.
