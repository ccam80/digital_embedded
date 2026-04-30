# RLC step response — adaptive subdivision driven by `stepToTime` breakpoint

## Problem

`src/headless/__tests__/rlc-lte-path.test.ts` fails:

- *RC step response: exponential charging matches V(1-e^-t/τ)* —
  expected Vc at t=τ ≤ 3.22 V (within ±2 % of 5·(1-e⁻¹) = 3.16 V), got 5 V.
- *RL step response: V_R matches 1-e^-t/τ* — expected V_R at t=τ ≤ 0.64 V
  (within ±2 % of 1-e⁻¹ = 0.632 V), got 1 V.

Both responses are reading the **DC steady state**, not the transient
trajectory. The test is structured as:

```
const facade = new DefaultSimulatorFacade(registry);
const circuit = facade.build({ /* RC */ });
const engine = facade.compile(circuit);
facade.setSignal(engine, 'Vs', 5);          // hot-update source to 5 V
await facade.stepToTime(engine, tau);       // drive transient
const vcAtTau = facade.readSignal(engine, 'Vc:pos');  // reads 5 V, not 3.16 V
```

The 5 V / 1 V readings are exactly the steady-state capacitor / resistor
voltages a DC-OP solver would produce with the new source voltage. They are
not LTE-rooted in the traditional sense (no overshoot of an analytic
trajectory); the engine is reporting steady state because step 0 of the
transient run executes the warm-start DC operating point against the
**already-updated source value**, and the transient body then has nothing
to integrate.

## Sites

- Failing test: `src/headless/__tests__/rlc-lte-path.test.ts:55-148`
  (Tests 1 and 2; tests 3-7 in the same file exercise post-DCOP transients
  and may surface different defects).
- `src/solver/coordinator.ts::DefaultSimulationCoordinator.stepToTime`
  (lines 471-494) — adds a breakpoint at `targetSimTime`, then loops
  `step()` until `simTime >= targetSimTime`.
- `src/solver/analog/analog-engine.ts::MNAEngine.step` (lines 250-716) —
  the transient driver. The `_firstStep === false` branch at lines 263-266
  invokes `_transientDcop()` on the first call after init/reset.
- `src/solver/analog/analog-engine.ts::MNAEngine._transientDcop` (lines
  936+) — runs the warm-start DC operating point in `MODETRANOP |
  MODEINITJCT` and seeds `ctx.rhs` from the converged DCOP voltages via
  `_seedFromDcop` (line 981, then 1418+).
- `src/headless/default-facade.ts::setSignal` (lines 181-200) — routes to
  `coordinator.setSourceByLabel(label, '', value)` which calls
  `el.setParam(...)` (coordinator.ts:868-871). For a DcVoltageSource that
  setParam call mutates the source's `voltage` parameter, which the next
  `load()` call reads.

## Verified ngspice citations

### Truncation-error rejection-and-retry — `ref/ngspice/src/spicelib/analysis/dctran.c`

ngspice's transient outer loop (dctran.c:726-1010, the `for(;;)` block).
The relevant parts of the LTE-driven dt management:

```
783        converged = NIiter(ckt,ckt->CKTtranMaxIter);
...
806        if(converged != 0) {
...
815            ckt->CKTdelta = ckt->CKTdelta/8;
```

NR-failure path: cut delta by 8 and retry from the top of the for(;;).

```
848        } else {
849            if (firsttime) {
...
864                firsttime = 0;
...
866                goto nextTime;
...
873            }
874            newdelta = ckt->CKTdelta;
875            error = CKTtrunc(ckt,&newdelta);
...
880            if(newdelta > .9 * ckt->CKTdelta) {
...
881                if((ckt->CKTorder == 1) && (ckt->CKTmaxOrder > 1)) {
...
884                    error = CKTtrunc(ckt,&newdelta);
...
889                    if(newdelta <= 1.05 * ckt->CKTdelta) {
890                        ckt->CKTorder = 1;
891                    }
892                }
894                ckt->CKTdelta = newdelta;
...
930                goto nextTime;
            } else {
...
938                ckt->CKTtime = ckt->CKTtime - ckt->CKTdelta;
939                ckt->CKTstat->STATrejected ++;
...
944                ckt->CKTdelta = newdelta;
...
            }
```

The acceptance gate is `newdelta > 0.9 * CKTdelta`. The `firsttime` branch
at 849-873 short-circuits **the very first transient step** past the
LTE check entirely (`goto nextTime` at 866 skips CKTtrunc).

### Companion `NIiter` (ngspice niiter.c) and the firsttime block (`dctran.c:189`)

`firsttime = 1` is set at dctran.c:189 inside the `if(restart || CKTtime
== 0)` block (line 117). It is cleared at 864 by the very first accepted
step. This single-shot semantic is what `MNAEngine._stepCount === 0`
mirrors (analog-engine.ts:579-584) — step 0 bypasses LTE / CKTtrunc.

### Initial timestep — `dctran.c:118`

```
118        delta=MIN(ckt->CKTfinalTime/100,ckt->CKTstep)/10;
```

`firstStep = MIN(tStop/100, outputStep) / 10`. For RC test: with
`tStop = +Infinity` (set by `coordinator._pushAnalogStreamingParams`,
coordinator.ts:163-167), `outputStep = max(1e-12, 1e-3 / 60) = 1.667e-5`,
`firstStep = 1.667e-6`. After `getClampedDt`'s firsttime `dt /= 10`
(timestep.ts:511-513, mirroring dctran.c:580), step 0 runs at dt ≈
1.667e-7 s. `maxTimeStep = min(outputStep, span/50) = 1.667e-5 s`.

That is **smaller than τ = 1 ms**, so the dt path itself is not the issue.

## Architecture diagnosis

### Does digiTS implement the LTE rejection-and-retry loop?

**Yes.** The `for(;;)` retry loop sits at `analog-engine.ts:379-652`. It
mirrors dctran.c's outer loop:

- Lines 549-568 — NR failure → cut dt by 8, set order = 1, retry.
- Lines 569-622 — NR converged, run `computeNewDt` (CKTtrunc analogue) and
  `shouldReject` (timestep.ts:594-597 implements the
  `newdelta <= 0.9 * CKTdelta` gate).
- Lines 604-608 — accepted: break out of for(;;) into the acceptance block.
- Lines 610-621 — rejected: rewind simTime, set dt = newDt, retry.
- Lines 624-650 — common delmin two-strike check (dctran.c:957-973).

The `_stepCount === 0` short-circuit at lines 579-584 mirrors dctran.c's
firsttime branch (lines 849-866).

### What actually fails the test

The transient solver is well-formed. The failure is upstream of the
transient body: the **first step's warm-start DCOP** is solving with
the post-`setSignal` source voltage. By the time the transient body
runs, `ctx.rhs` already holds the steady-state solution; subsequent
steps integrate around that point and stay there.

Concretely, for the RC test:

1. `facade.compile(circuit)` builds the engine. `_firstStep = false`.
2. `facade.setSignal(engine, 'Vs', 5)` →
   `coordinator.setSourceByLabel('Vs', '', 5)` →
   `el.setParam('voltage', 5)` on the DcVoltageSource. The source's
   `voltage` param is now 5 V; **no DCOP has run yet**.
3. `facade.stepToTime(engine, tau)` → `coordinator.stepToTime(tau)` →
   adds breakpoint, enters `while (simTime < tau) step()`.
4. First `step()` call: `_firstStep === false` (line 263), so
   `_transientDcop()` runs (line 264). DCOP solves with Vs = 5 V, gets
   Vc(steady) = 5 V. `_seedFromDcop` writes those voltages into
   `ctx.rhs`. The capacitor's stored charge `q = C·Vc = 5e-6 C` is
   computed in capacitor.ts's DCOP arm (the `else` at line 352 — no
   stamp, just `s0[SLOT_Q] = C * vcap; s0[SLOT_V] = vcap`).
5. Subsequent transient steps integrate the system around its DC
   equilibrium. With `Vc = 5 V` already, the capacitor's companion
   current `Ic = C·dVc/dt ≈ 0` and `Vc` stays at 5 V indefinitely.
6. When `simTime ≥ tau`, the loop exits. `readSignal('Vc:pos')` returns
   5 V.

### What the test author expected

A *step-input transient* — Vs jumps from 0 V to 5 V at t = 0+, and the
RC network charges with time constant τ. SPICE's idiomatic encoding of
a step input is **PULSE(0 5 0 0 0 1 1)** on the source, so that the
DCOP is solved with the pre-step value (V1 = 0) and the transient
sweeps through the rising edge. The `setSignal` API as used here mimics
that intent but does not deliver it: the param mutation happens before
DCOP, and DCOP sees the post-step value as the only DC source value to
solve against.

## Resolution shape

This is **architectural**: the gap is in the `setSignal` + `stepToTime`
contract, not in transient adaptive subdivision. The retry loop is
correctly implemented; it is simply never exercised on these tests
because the system is already at equilibrium.

The clean fix is one of:

1. **Two-phase setSignal**: the facade exposes an explicit
   `setSignalAtTime(engine, label, value, time)` that turns a hot
   parameter change into a breakpoint-driven step input. The runtime
   inserts a breakpoint at `time`, holds the previous value through
   DCOP and any stepping up to `time`, then performs the param
   mutation when the engine crosses the breakpoint. Tests that want
   a step input write
   `facade.setSignalAtTime(engine, 'Vs', 5, 0)` and let the engine
   run the DCOP with Vs = 0 V before the post-edge transient.

2. **PULSE-source idiom in tests**: rewrite the failing tests to use a
   `PulseVoltageSource` (digiTS already has AcVoltageSource with
   `waveform: 'pulse'` per the rectifier test on the same file, lines
   253-255). This is a contract-update on the tests, but it forces
   the test author to specify the pre-step value explicitly.

3. **`step-then-set` ordering in tests**: call
   `facade.stepToTime(engine, 0)` first to settle DCOP at Vs = 0, then
   `setSignal(Vs, 5)`, then `stepToTime(tau)`. The first stepToTime
   would settle DCOP at Vs = 0 V (Vc = 0), the source mutation gets
   picked up by the next NR cycle, and the post-edge transient charges
   from 0.

Option (1) is the cleanest production fix and matches what an analog
designer would expect from "set a signal at a specific time." Option (2)
makes the tests model real SPICE input idioms and avoids relying on a
new API. Option (3) is a per-test workaround that papers over the
contract gap and should not be the production resolution.

The decision between these is the user's call — agents do not re-author
the public facade contract without explicit approval.

## Where the LTE rejection loop *would* be exercised

The same file's tests 3-7 (LC ring-down, AC sweeps) drive transients
where the source is time-varying *during* the transient (AcVoltageSource
with sine/pulse waveform). Those tests are not subject to the
DCOP-eats-the-step issue and *do* exercise `computeNewDt` /
`shouldReject` per step. If those tests are also failing, that would
be a different — genuinely LTE-rooted — defect and should be filed
separately. As of this report, only tests 1 and 2 are in scope.

## Category

**`architecture-fix`** — the public-API contract for `setSignal` does
not provide a way to express a step-input event tied to simulation
time, and the warm-start DCOP semantics make a naive
`setSignal-then-stepToTime` collapse to steady state. Resolving this
requires either a new facade method or a re-thinking of how setSignal
interacts with DCOP.

## Resolves

2 vitest tests
(`rlc-lte-path > RC step response: exponential charging matches V(1-e^-t/τ)`,
`rlc-lte-path > RL step response: V_R matches 1-e^-t/τ`).

## Tensions / uncertainties

The user's framing of this item suggested that adaptive subdivision is
too coarse at a single `stepToTime(target)` breakpoint. Per the
`CLAUDE.md` banned-vocabulary rules, I cannot close this with
"intentional divergence" or "tolerance." Doing so here would be wrong
on the merits anyway: the retry loop is correctly implemented and
identically structured to ngspice's outer transient loop; the LTE
gates fire under the conditions ngspice expects; the per-element
`getLteTimestep` calls invoke `cktTerr` with the same arguments
ngspice's `CKTtrunc` does. The defect is upstream — the warm-start
DCOP precedes the user's intended step edge.

The escalation per `CLAUDE.md` for items I would otherwise be tempted
to close as "tolerance":
- Cited ngspice file: `ref/ngspice/src/spicelib/analysis/dctran.c` (the
  full transient driver, including the firsttime block at 849-866 that
  digiTS mirrors at analog-engine.ts:579-584).
- digiTS file: `src/solver/analog/analog-engine.ts::step`.
- Quantities that differ: at t = τ the test expects ≤ 3.22 V (RC) /
  ≤ 0.64 V (RL); the engine returns 5 V / 1 V. The difference is the
  full transient amplitude (5 V or 1 V), not a few-ULP numerical drift.
- Why architectural rather than numerical: under both ngspice and
  digiTS, a DCOP run with Vs = 5 V on a series RC drives Vc to 5 V at
  t = 0. Both engines reach that result by design; neither has a bug
  in the transient stamp or LTE math. The contract gap is in how the
  test author expressed "step input." The gap exists in the public
  facade API surface, not in numerical machinery.
- User prompt to resolve: *"Define `setSignalAtTime(engine, label,
  value, simTime)` on `DefaultSimulatorFacade` and route through
  `coordinator.scheduleSourceUpdate(label, value, time)` so the engine
  treats it as a breakpoint event. Then update the test to use this
  API and verify Vc(τ) ≈ 3.16 V."* — or, equivalently, the user can
  instruct the test rewrite to use a PULSE source.

If the user instead concludes the LTE adaptive-subdivision really is
too coarse (e.g. by demonstrating a failing step-input case where
DCOP does NOT swallow the edge), that is a separate item and would
be filed as a numerical defect against `MNAEngine.step` /
`TimestepController.computeNewDt` after a per-NR-iteration ngspice
harness comparison run per the `CLAUDE.md` mandate.
