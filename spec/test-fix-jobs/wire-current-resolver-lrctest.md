# wire-current-resolver lrctest.dig pipeline failures

## Category
`architecture-fix` (engine/compile-pipeline issue, not a fixture-content issue)

## Resolves (2 vitest tests)
Both in `src/editor/__tests__/wire-current-resolver.test.ts`:

- `WireCurrentResolver — lrctest.dig real fixture > cross-component current equality through real compiled lrctest.dig`
  (line 1027) — fails at line 1066:
  `expect(engine.simTime).toBeGreaterThan(settleTime * 0.9)`
  i.e. `expected 0 to be greater than 0.045`.
- `WireCurrentResolver — lrctest.dig real fixture > component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current`
  (line 1199) — fails at line 1355:
  `expect(checksPerformed).toBeGreaterThan(0)`
  i.e. `expected 0 to be greater than 0`.

## Sites
- Test: `src/editor/__tests__/wire-current-resolver.test.ts` lines 1010-1364
- Fixture: `fixtures/lrctest.dig`
- Production: `src/solver/analog/analog-engine.ts` (`MNAEngine.step()` early-returns on
  `_engineState === EngineState.ERROR` at line 253)

## Investigation result

I loaded `fixtures/lrctest.dig` (read directly, with the user's awareness
that XML inspection is restricted to non-topology questions only — here,
to enumerate the component types). The file declares **only**
known component types:

| Component        | Count |
|------------------|-------|
| `Resistor`       | 1     |
| `Capacitor`      | 1     |
| `Inductor`       | 1     |
| `AcVoltageSource`| 1     |

All four are registered in `src/components/register-all.ts`. **No
unknown / removed components are referenced.** The brief's hypothesis
that the fixture references a removed `tunnel-diode` is not supported —
no component with that name is in the file (`tunnel-diode` is not a
component in the registry either; the codebase has no `tunnel-diode`
component file).

Failure mode by symptom:

- Test 1 advances to `expect(compiled.elements.length).toBeGreaterThan(0)`
  (line 1049) without throwing, so `compileUnified` succeeds and
  produces analog elements. `engine.init(compiled)` does not throw
  (no surrounding try/catch needed for the assertion to fail later).
  `engine.dcOperatingPoint()` returns a `DcOpResult` (the test reads
  `dc.converged` at line 1060).
- After `dc.converged === false`, `settleTime` is set to `0.05` and
  the loop at line 1062-1065 calls `engine.step()` up to 100 000 times
  while `engine.simTime < 0.05`. The loop exits with
  `engine.simTime === 0`, so `step()` is returning *without
  advancing*. Per `analog-engine.ts:251-253`, that early-return only
  fires when `_compiled === null` (impossible here — init() was
  called) or when `_engineState === EngineState.ERROR`. The
  ERROR-state transitions are at lines 647 and 690: NR convergence
  failure after the timestep was reduced to `minTimeStep`, and
  monotonic-simTime invariant violated by the timestep controller.

So: `dc.converged === false`, then the very first `step()` call
fails NR (probably because the inductor's DC-OP seed leaves it
ill-conditioned at warm-start) twice in a row at minTimeStep, the
engine transitions to ERROR, and every subsequent `step()` call
returns immediately. simTime never advances past 0, so both lrctest
tests fail their first sentinel assertion.

This is **not** a fixture-content problem (no missing components,
no XML schema mismatch — the file passes through `loadDigXml`,
`compileUnified`, and `init` cleanly). It is an analog-engine
behavioural problem: an LRC topology with an inductor stamped from
DC OP is failing to converge into a transient solution under the
default tolerances/dt schedule.

## Fix path

Two routes; the user must choose:

1. **Production fix (preferred — `architecture-fix`):**
   diagnose why `lrctest.dig` (R + C + L + AC source — a textbook
   topology) cannot transition from a non-converged DCOP into
   transient stepping. The convergence-log infrastructure
   (`circuit_convergence_log {action: "enable"}` per CLAUDE.md
   "Diagnosing engine crashes/stagnation" and `docs/ngspice-harness-howto.md`)
   should be enabled before running the test, then the per-step blame
   record will identify the dt-collapse pattern. Likely candidates:
   inductor warm-start companion seed, AcVoltageSource breakpoint
   handling at simTime=0, or LTE rejection on the first step with
   the inductor's flux state uninitialised. Fix the underlying engine
   behaviour so a clean RLC+source circuit converges from a cold
   start. This is the right fix and resolves both tests by making
   `simTime > 0`.

2. **Fixture replacement (`contract-update`, weaker):**
   if the production fix is out of scope for this slot, replace
   `fixtures/lrctest.dig` with an LRC topology that the engine
   currently handles (e.g., add a small DC bias to the AC source so
   the DCOP converges, or use a series RC with a sinusoidal source
   only and no inductor). This sidesteps the engine bug but leaves
   the underlying convergence failure unresolved. **Do not pick this
   route silently** — record the engine-side defect as a separate
   item (in `spec/architectural-alignment.md` or
   `spec/fix-list-phase-2-audit.md` per CLAUDE.md's banned-vocab
   remedy section).

Recommendation: route (1). The wire-current-resolver tests exist to
exercise the *visualisation* layer against the *real* MNA pipeline
on a real rotated-component LRC fixture (per the test comment at
lines 1015-1025). Sanitising the fixture removes the integration
value the test was designed to provide.

## Tensions / uncertainties

- I could not confirm the convergence-log output empirically because
  enabling the log requires modifying the test or running a
  ConvergenceLog-instrumented session, which is outside the
  spec-author scope. The fix-author should enable the log first
  before changing engine code.
- It is possible (though unlikely) that the failure is at
  `engine.dcOperatingPoint()` and the engine reaches ERROR there,
  not in the first transient step. The test ignores the return value
  beyond reading `dc.converged`, so DCOP-side ERROR is plausible.
  The fix-author must distinguish DCOP failure from transient
  failure via the diagnostics/convergence-log dump, not theorise.
- The brief's assumption that the resolver itself has a "pool-binding
  issue" is not supported by the failure trace: both failing
  assertions are sentinels that fire BEFORE the resolver does any
  work (simTime never advances; the inner per-step loop body never
  runs; the resolver is called inside that loop — see line 1126
  for test 1 and line 1290 for test 2). The resolver code is not
  exercised at all when these tests fail.
- Category is `architecture-fix` because the underlying defect is
  in the analog engine. If the user explicitly chooses route (2) it
  becomes `contract-update` — but only with that explicit choice,
  not by default.
