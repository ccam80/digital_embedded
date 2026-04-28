# Setup-Load Cleanup — Batch Prompts + Coordinator Playbook

Spec contract: `spec/setup-load-cleanup.md` (single source of truth — every type, factory shape, grep, and clause referenced below lives there).
State file: `spec/.hybrid-state.json` — **single batch (`batch-1`) containing all 56 task_groups**.
Foundation (B.0): in flight outside this document. Wave does not start until `core/analog-types.ts`, `solver/analog/element.ts`, `core/registry.ts`, `compile/types.ts`, `solver/analog/composite-element.ts` (NEW), and `solver/analog/__tests__/test-helpers.ts` are landed per spec §B.0 + §A.15 + §A.19.

---

## Why a single batch (and not four)

The implement-hybrid skill enforces a **per-batch barrier**: batch N+1 cannot start until every task_group in batch N has `group_status == "passed"`. That gate is exactly what we DO NOT want here. Tests are not expected to be green during the wave; we want spec-compliance reviews to AGGREGATE without BLOCKING continued dispatch.

By collapsing all 56 task_groups into a single batch, we get:

- **No phase barrier.** The implementer spawn cap is `len(task_groups) + verifications_failed + stops_for_clarification + dead_implementers` = 56 + retries. The coordinator can dispatch any of the 56 groups whenever a slot is free; the hooks impose no ordering on which group runs when.
- **Verifier gate stays open.** As soon as any completed work exists that isn't reviewed (`completed > verifications_passed + verifications_failed`), a verifier can run. The coordinator chunks unreviewed groups into 4-group verifier assignments at its own discretion.
- **Failures still produce retry slots.** A failed verification creates a slot for one retry implementer per failed group, exactly as in the multi-batch model. Retries flow through the same continuous job pool as initial dispatches.
- **No hook editing.** The plugin's PreToolUse hooks remain untouched and continue to enforce correctness on counters.

The cost: the skill's "next-batch unblock" check is moot (there is no next batch). All convergence happens at the end of the single batch when every group_status reaches `"passed"`. The coordinator manages cadence via the continuous job pool below; the hooks never gate dispatch ordering.

---

## Priority order (NOT phases)

The 56 task_groups are tagged by ID prefix as a **dispatch-priority hint**, not as gated phases. The coordinator picks the next group to spawn from the highest-priority bucket that has unstarted work; it does NOT wait for a bucket to drain before drawing from the next one.

| Priority | Prefix | Coverage | Groups | Lines |
|---|---|---|---|---|
| P1 | `1.A.*` | B.1 engine/compiler/app + B.3 behavioral + B.4 sources + B.5 passives | 11 | ~21k |
| P2 | `2.B.*` | B.6 semis + B.7 switching + B.8 active + B.9 sensors/IO + B.10 wiring/memory/ff | 15 | ~26k |
| P3 | `3.C.*` | B.11 harness + B.12 fixtures + B.13 engine/solver tests | 15 | ~30k |
| P4 | `4.D.*` | B.14 component tests | 15 | ~29k |

Rationale for ordering: source-code rewrites (`1.A.*`, `2.B.*`) land before test-file rewrites (`3.C.*`, `4.D.*`) so test files have something to compile against, but tests being RED during the wave is expected and does NOT block. If P1 has only 1 unstarted group left and there's slot headroom for 14 more, the coordinator pulls from P2 immediately — no idle waiting.

---

## Coordinator playbook — continuous job pool, 15-agent cap

The coordinator runs a single steady-state scheduler. There are no sub-waves to start or end. At every notification (task return), the coordinator re-evaluates state and refills the slot pool.

### State tracked in coordinator memory (recomputed each cycle from `spec/.hybrid-state.json` + dispatch log)

- `live_implementers` — count of in-flight implementer / fix-implementer Tasks (background, not yet returned).
- `live_verifiers` — count of in-flight wave-verifier Tasks.
- `live_total = live_implementers + live_verifiers` — must stay ≤15.
- `unstarted_groups` — task_groups never spawned. Initially = all 56. Drawn down only when implementer is dispatched.
- `completed_unreviewed` — groups whose implementer returned with `complete-implementer.sh` but whose `group_status` is still `"pending"` because no verifier has covered them yet. Increases with implementer normal-finish, decreases when a verifier writes a verdict for the group.
- `failed_unfixed` — groups with `group_status == "failed"` that have NOT yet had a fix-implementer dispatched.
- `passed_groups` — groups with `group_status == "passed"`. Strictly grows.

### Spawn-decision algorithm (run on every Task return)

The coordinator runs `refill()` after each `TaskOutput` notification:

```
refill():
  while live_total < 15:

    # Priority A: dispatch a new implementer from the unstarted pool.
    # Picks from highest-priority bucket (P1 → P2 → P3 → P4) that has work.
    if unstarted_groups not empty:
      g = pick highest-priority unstarted group
      spawn implementer for g (model from per-group table)
      live_implementers += 1
      unstarted_groups.remove(g)
      continue

    # Priority B: dispatch a fix-implementer for an oldest failed group.
    # Each consumes one verifications_failed retry slot.
    if failed_unfixed not empty:
      g = pick oldest failed group
      spawn fix-implementer for g (with the verifier's failure summary)
      live_implementers += 1
      failed_unfixed.remove(g)
      continue

    # Priority C: dispatch a verifier covering 4 unreviewed groups.
    # The 4-group cap matches implement-hybrid's fan-out rule (ceil(n/4) verifiers).
    if completed_unreviewed.count >= 4:
      chunk = take 4 from completed_unreviewed (any cohesion-friendly subset)
      spawn wave-verifier for chunk
      live_verifiers += 1
      continue

    # Priority D: tail-end verifier — fewer than 4 unreviewed left,
    # AND no more unstarted, AND no more failed-unfixed (work is winding down).
    # Spawn a smaller verifier rather than letting the tail stall.
    if completed_unreviewed not empty
       and unstarted_groups empty
       and failed_unfixed empty:
      spawn wave-verifier for all groups in completed_unreviewed (1–3 groups)
      live_verifiers += 1
      completed_unreviewed.clear()
      continue

    # Nothing to do right now — exit the refill loop and wait for next return.
    break
```

**Why this avoids slowpoke hangs:** there is never a "wait for a sub-wave to drain" step. A 30-minute implementer on `4.D.bjt` does not block dispatch of any other group. Other implementers and verifiers continue to spawn and return; the slow one only holds 1 of 15 slots.

**Why verifiers stay well-fed at 4 groups:** Priority C only fires when `completed_unreviewed ≥ 4`. With 56 groups churning through the pool and ~14 other slots filled with implementers, the unreviewed pool fills up quickly enough that verifiers run roughly every 4 implementer returns. If unstarted_groups runs out before completed_unreviewed reaches 4, Priority D ensures the tail doesn't stall.

**Why the cap holds:** `live_total < 15` is checked before every spawn. The decrement happens immediately on Task return (the runtime auto-notifies). No counter race — both spawns and decrements happen sequentially on the coordinator side.

### How notifications drive the loop

The Task tool's `run_in_background: true` causes the runtime to auto-notify the coordinator when a Task completes. The coordinator does NOT poll; it acts on each notification:

1. **Notification arrives** for some task_id.
2. **Read `TaskOutput(task_id, block=true)`** to confirm the result (returns immediately because the task is already done; this is just to consume the result envelope).
3. **Decrement counters:** if it was an implementer, `live_implementers -= 1`; if a verifier, `live_verifiers -= 1`.
4. **Update derived state:**
   - Implementer normal finish → `completed_unreviewed.add(group_id)`. `complete-implementer.sh` already bumped `completed`.
   - Implementer clarification stop → record `CLARIFICATION NEEDED` from `spec/progress.md` into `spec/setup-load-cleanup-clarifications.md`. **Do NOT** respawn the group; clarifications are aggregated for end-of-wave user review (`stops_for_clarification` opens a retry slot, but we don't claim it now).
   - Implementer dead (TaskOutput shows completed but no counter movement after grace window) → invoke `mark-dead-implementer.sh`; the group goes back into `unstarted_groups` (eligible for re-dispatch via the dead-implementer retry slot).
   - Verifier returns → re-read `spec/.hybrid-state.json`. For each group in the verifier's chunk: if `group_status == "passed"`, add to `passed_groups` (no further action). If `group_status == "failed"`, add to `failed_unfixed`.
5. **Call `refill()`** to top up the slot pool.

### Initial bootstrap (start of wave)

Single message, spawn 15 implementers from the highest-priority buckets:

1. Read `spec/.hybrid-state.json`. Confirm all 56 groups are `pending` and counters are zero.
2. Spawn the test-baseline Task per the implement-hybrid skill (background, haiku) — does NOT count toward the 15-cap because it's not an implementer/verifier in the spawn-gated sense.
3. Pick the first 15 groups in priority order: all 11 P1 groups + the first 4 P2 groups (`2.B.bjt`, `2.B.mosfet`, `2.B.jfet`, `2.B.diode`).
4. Spawn all 15 as background implementer Tasks in one message. Set `live_implementers = 15`, `unstarted_groups = remaining 41`.
5. Now wait on notifications.

### Termination

The wave terminates when:

- `passed_groups.count == 56` AND
- `live_total == 0` AND
- `unstarted_groups`, `completed_unreviewed`, `failed_unfixed` are all empty.

When all four hold, run the convergence checks (next section). If they don't all hold but progress has stalled (no notification in a long window), the coordinator escalates to user instead of looping — same dead-subagent fallback as the standard skill.

### Failures and clarifications: aggregate, don't block

**Failures (verifier verdict = FAIL):** the group lands in `failed_unfixed`. Priority B in the algorithm dispatches a fix-implementer for it within the same continuous loop — no separate "retry pass" needed for failures that surface mid-wave. The fix-implementer's prompt includes the verifier's failure summary so it knows what to repair.

**Clarifications (implementer `stop-for-clarification.sh`):** the entry is copied verbatim from `spec/progress.md` to `spec/setup-load-cleanup-clarifications.md` and the group is parked. The `stops_for_clarification` counter opens a retry slot, but the coordinator does NOT claim it during the wave — clarifications need user input to resolve. At wave end, surface the open list to the user; on user resolution, spawn a fresh implementer for each clarified group (consumes the parked retry slot).

### End-of-wave summary

After termination (or after the user halts the wave to handle clarifications):

1. Read `spec/.hybrid-state.json` and `spec/setup-load-cleanup-clarifications.md`.
2. Append a `## End-of-wave summary` heading to this file with:
   - Total spawned (implementers + fix-implementers + verifiers).
   - Groups that passed first try vs after fix-implementer retry.
   - Groups still failed after retry (if any retry caps were hit — unlikely at 15-slot continuous flow but possible if the same group fails twice).
   - Open clarifications count (cross-link).
3. Surface to user.

### Convergence

Per spec §D point 3, the wave converges when:

- All 56 `group_status[g] == "passed"`.
- Repo-wide §C.1 greps return zero forbidden-pattern hits.
- `tsc --noEmit` returns zero errors.
- No NEW test failures vs `spec/test-baseline.md`.

If those four conditions hold, run cleanup per the implement-hybrid skill ("After All Phases" section). If not, residual goes to a follow-up spec (per CLAUDE.md "Completion Definition") rather than being treated as wave-complete.

---

## Hard constraints (every implementer prompt MUST include this block)

```text
## Your scope — STRICT FILE LIST

You own ONLY these files. Editing any other file = task failure.
{file_list}

## Hard rules
- Read `spec/setup-load-cleanup.md` Section A in full before editing.
- Make each assigned file fully comply with §A.
- Run §C.1 forbidden-pattern greps INSIDE your assigned files at end-of-task; report any non-zero hits in §C.4 format.
- Cross-file flow-on effects are SIGNALED in your per-file out-of-band report — DO NOT edit other files.
- Do NOT run tests. Do NOT fix tsc errors outside your owned files.
- Tests are RED across the project during this wave. That is expected.
- Do NOT touch `spec/`, `ref/ngspice/`, `tsc-errors.log`, `.vitest-*.log`, or any audit files.
- No "pragmatic patches", no "minimal diff", no "TODO". Implement the §A target shape exactly.
- Banned closing verdicts (per CLAUDE.md): *mapping*, *tolerance*, *equivalent to*, *pre-existing*, *intentional divergence*, *citation divergence*, *partial*. If tempted, STOP and write `CLARIFICATION NEEDED` to spec/progress.md.

## Reporting
At end-of-task, append to `spec/progress.md` one §C.4 block per owned file:

File: <path>
Status: complete | partial | blocked
Edits applied: <prose>
Forbidden-pattern greps (Section C.1):
  (only rows with ≥1 hit; "all clean" if zero)
Required-pattern greps (Section C.2):
  (only missing-where-applicable rows; "all present" if none missing)
Out-of-band findings (Section C.3): <bullets or none>
Flow-on effects (other files this change requires):
  - <one line per signal>
Notes: <free-form>

## Final bash call
- Normal finish: `bash "C:/Users/cca79/.claude/plugins/cache/claude-orchestrator-marketplace/claude-orchestrator/fb7ba7ebc0e0/scripts/complete-implementer.sh"`
- Spec ambiguity blocking work: write `CLARIFICATION NEEDED: <details>` to `spec/progress.md`, then `bash "C:/Users/cca79/.claude/plugins/cache/claude-orchestrator-marketplace/claude-orchestrator/fb7ba7ebc0e0/scripts/stop-for-clarification.sh"`. Surface the entry to the coordinator's clarification sink at `spec/setup-load-cleanup-clarifications.md` (the coordinator copies it there after your stop).

## Context files (read in this order)
1. `CLAUDE.md`
2. `spec/.context/rules.md`
3. `spec/.context/lock-protocol.md`
4. `spec/setup-load-cleanup.md` — Section A (target shape) and Section C (greps)
5. `spec/test-baseline.md`
6. `spec/progress.md` (to append your status)
```

---

## P1 — `1.A.*` (11 agents — engine/compiler/app + behavioral + sources + passives)

| Group ID | Files | Lines | Model | Notes |
|---|---|---|---|---|
| `1.A.engine` | `src/solver/analog/analog-engine.ts` | 1441 | sonnet | Apply §A.12 engine-side dead-flag deletions; rebase pin/internal-node consumers per §A.4/§A.7 |
| `1.A.compiler` | `src/solver/analog/compiler.ts` | 1418 | sonnet | Apply §A.21 in full (drop parallel-array writes; rewrite type discriminator; rewrite `compileSubcircuitToMnaModel` with `CompositeElement` per §A.15; strip dead-flag reads/writes) |
| `1.A.engine-misc` | `src/solver/analog/bridge-adapter.ts`, `src/solver/analog/controlled-source-base.ts`, `src/core/analog-engine-interface.ts`, `src/app/viewer-controller.ts` | 1888 | sonnet | bridge-adapter: §A.22 (both adapter classes extend `CompositeElement`). controlled-source-base: hosts shared `findBranchFor` per §A.6. analog-engine-interface: extend `ResolvedSimulationParams` with temp/nomTemp/copyNodesets. viewer-controller: replace `pinNodeIds` casts with typed `_pinNodes` Map access |
| `1.A.solver-core` | `src/solver/analog/newton-raphson.ts`, `src/solver/analog/timestep.ts`, `src/solver/analog/ckt-context.ts` | 2410 | sonnet | newton-raphson: drop `isNonlinear` blame guard (§A.12). timestep: replace `el.isReactive` with method-presence (§A.12) — both occurrences. ckt-context: delete `nonlinearElements`/`reactiveElements`/`elementsWithLte`/`elementsWithAcceptStep` cached lists (§A.12); verify §C.20 grep returns zero before deleting |
| `1.A.behav-gates` | `src/solver/analog/behavioral-gate.ts`, `src/solver/analog/behavioral-combinational.ts`, `src/solver/analog/behavioral-flipflop.ts`, `src/solver/analog/behavioral-flipflop/d-async.ts`, `src/solver/analog/behavioral-flipflop/jk.ts` | 1893 | sonnet | All classes refactor to `extends CompositeElement` (§A.15). MUST declare `readonly ngspiceLoadOrder` and `readonly stateSchema` per subclass mandate |
| `1.A.behav-rest` | `src/solver/analog/behavioral-sequential.ts`, `src/solver/analog/behavioral-remaining.ts`, `src/solver/analog/behavioral-flipflop/jk-async.ts` | 1979 | sonnet | `extends CompositeElement` per §A.15. behavioral-remaining note: 6 classes; engine routing change — see §A.15 "behavioral-remaining" note |
| `1.A.ff-vsrc` | `src/solver/analog/behavioral-flipflop/rs.ts`, `src/solver/analog/behavioral-flipflop/rs-async.ts`, `src/solver/analog/behavioral-flipflop/t.ts`, `src/components/sources/dc-voltage-source.ts`, `src/components/sources/ac-voltage-source.ts` | 1950 | sonnet | Flipflops: `extends CompositeElement`. dc-voltage-source: canonical inline-factory reference (§A.13). ac-voltage-source: `findBranchFor` on element factory (§A.6); §A.18 PropertyBag migration as needed |
| `1.A.sources-passives-1` | `src/components/sources/current-source.ts`, `src/components/sources/variable-rail.ts`, `src/components/io/ground.ts`, `src/components/passives/resistor.ts`, `src/components/passives/capacitor.ts`, `src/components/passives/inductor.ts` | 1991 | sonnet | variable-rail: `findBranchFor` on factory; verify §A.18 PropertyBag use. ground: `setup()` empty (no stamps). capacitor/inductor: §A.14 class pattern. inductor: `findBranchFor` per §A.6 |
| `1.A.passives-2` | `src/components/passives/polarized-cap.ts`, `src/components/passives/transformer.ts` | 1464 | sonnet | Both flat reactive (excluded from §A.15 composite mandate); keep direct `PoolBackedAnalogElement` impl |
| `1.A.passives-3` | `src/components/passives/tapped-transformer.ts`, `src/components/passives/transmission-line.ts` | 1665 | sonnet | tapped-transformer: migrate `props.getString("label")` (~line 343) to `props.get<string>("label") ?? ""` per §A.18; `findBranchFor` per §A.6. transmission-line: flat reactive top-level; segment sub-classes excluded from §A.15 |
| `1.A.passives-4` | `src/components/passives/crystal.ts`, `src/components/passives/memristor.ts`, `src/components/passives/analog-fuse.ts`, `src/components/passives/potentiometer.ts`, `src/components/passives/mutual-inductor.ts` | 2142 | sonnet | crystal: flat reactive (excluded from §A.15); `findBranchFor` per §A.6. mutual-inductor: §A.14 class pattern |

---

## P2 — `2.B.*` (15 agents — semiconductors + switching + active + sensors/IO + wiring/memory/flipflop)

| Group ID | Files | Lines | Model | Notes |
|---|---|---|---|---|
| `2.B.bjt` | `src/components/semiconductors/bjt.ts` | 2449 | sonnet | §A.13 inline-factory pattern with `internalLabels` recording (§A.7). NPN/PNP polarity-polymorphic — body polarity-independent. Initialize `label: ""` per §A.11 |
| `2.B.mosfet` | `src/components/semiconductors/mosfet.ts` | 2119 | sonnet | §A.13 inline-factory; §A.7 internal-label recording; NMOS/PMOS replication with polarity flag |
| `2.B.jfet` | `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts` | 2055 | sonnet | Mechanical replication twins. §A.13 + §A.7 |
| `2.B.diode` | `src/components/semiconductors/diode.ts`, `src/components/semiconductors/zener.ts` | 1765 | sonnet | §A.13 + §A.7 (diode allocates collector-prime if RS≠0). zener parameter delta over diode |
| `2.B.semi-misc` | `src/components/semiconductors/tunnel-diode.ts`, `src/components/semiconductors/varactor.ts`, `src/components/semiconductors/schottky.ts`, `src/components/semiconductors/diac.ts`, `src/components/semiconductors/scr.ts` | 1641 | sonnet | varactor & schottky: audit-only per §B.6 ("verified clean of dead flags") — confirm and report. tunnel-diode: VCCS topology |
| `2.B.thyristor-fgnfet` | `src/components/semiconductors/triac.ts`, `src/components/semiconductors/triode.ts`, `src/components/switching/fgnfet.ts` | 1945 | sonnet | triode: §A.13 (VCCS topology + 2 gds handles per PB-TRIODE). fgnfet: floating-gate variant |
| `2.B.fgpfet-sw` | `src/components/switching/fgpfet.ts`, `src/components/switching/switch.ts`, `src/components/switching/switch-dt.ts` | 1880 | sonnet | switch/switch-dt: canonical 4-stamp SW; §A.13 |
| `2.B.relay-fets` | `src/components/switching/relay.ts`, `src/components/switching/relay-dt.ts`, `src/components/switching/nfet.ts`, `src/components/switching/pfet.ts`, `src/components/switching/trans-gate.ts` | 2162 | sonnet | relay: `RelayInductorSubElement` extends `AnalogInductorElement`; do not redeclare inherited fields. relay needs `findBranchFor` for the coil winding per §A.6. trans-gate: composite of two SW sub-elements |
| `2.B.opamps` | `src/components/active/opamp.ts`, `src/components/active/real-opamp.ts`, `src/components/active/ota.ts`, `src/components/active/comparator.ts` | 2065 | sonnet | ota: §A.9 — migrate `_h*` from object fields to closure-locals. Composites extend `CompositeElement` per §A.15 where applicable |
| `2.B.timer-opto` | `src/components/active/schmitt-trigger.ts`, `src/components/active/timer-555.ts`, `src/components/active/optocoupler.ts` | 1938 | sonnet | timer-555 multi-element composite; §A.15 mandate |
| `2.B.adc-dac` | `src/components/active/analog-switch.ts`, `src/components/active/adc.ts`, `src/components/active/dac.ts` | 1893 | sonnet | adc/dac: composites — refactor to `extends CompositeElement` per §A.15 |
| `2.B.controlled` | `src/components/active/ccvs.ts`, `src/components/active/vcvs.ts`, `src/components/active/vccs.ts`, `src/components/active/cccs.ts` | 1539 | sonnet | ccvs/vcvs: `findBranchFor` lives on `controlled-source-base.ts` (already done in W1); these subclasses inherit the unified shape |
| `2.B.sensors-io` | `src/components/sensors/ldr.ts`, `src/components/sensors/ntc-thermistor.ts`, `src/components/sensors/spark-gap.ts`, `src/components/io/led.ts`, `src/components/io/clock.ts` | 1971 | sonnet | led: audit-only per §B.9 ("verified clean per spec author") — confirm and report |
| `2.B.io-mem` | `src/components/io/probe.ts`, `src/components/wiring/driver-inv.ts`, `src/components/memory/register.ts`, `src/components/memory/counter.ts`, `src/components/memory/counter-preset.ts`, `src/components/flipflops/t.ts`, `src/components/flipflops/rs.ts` | 1959 | haiku | All low-complexity per §B.9/§B.10 |
| `2.B.flipflops` | `src/components/flipflops/rs-async.ts`, `src/components/flipflops/jk.ts`, `src/components/flipflops/jk-async.ts`, `src/components/flipflops/d.ts`, `src/components/flipflops/d-async.ts` | 1531 | haiku | All low-complexity per §B.10 |

---

## P3 — `3.C.*` (15 agents — harness + test fixtures + engine/solver tests)

| Group ID | Files | Lines | Model | Notes |
|---|---|---|---|---|
| `3.C.harness-core` | `src/solver/analog/__tests__/harness/capture.ts`, `src/solver/analog/__tests__/harness/types.ts`, `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 2587 | sonnet | capture.ts: apply §A.23 in full (drop `isNonlinear`/`isReactive` snapshot fields; switch internal-label loop to `el.getInternalNodeLabels?.() ?? []` + offset-from-`_pinNodes.size`; pin-iteration sites to `[...el._pinNodes.values()]`). Snapshot types may keep `pinNodeIds` as a plain data record — flag as out-of-band per §C.3 |
| `3.C.compsess` | `src/solver/analog/__tests__/harness/comparison-session.ts` | 2963 | sonnet | Largest single file. Replace dead-flag reads, `pinNodeIds` consumers, `withNodeIds` if present |
| `3.C.harness-tests-1` | `src/solver/analog/__tests__/harness/netlist-generator.test.ts`, `src/solver/analog/__tests__/harness/slice.test.ts`, `src/solver/analog/__tests__/harness/boot-step.test.ts`, `src/solver/analog/__tests__/harness/harness-integration.test.ts`, `src/solver/analog/__tests__/harness/query-methods.test.ts` | 2393 | sonnet | Drop `withNodeIds` and 4-arg `makeVoltageSource` per §A.19; rewrite via `makeTestSetupContext` + `setupAll` |
| `3.C.harness-tests-2` | `src/solver/analog/__tests__/harness/lte-retry-grouping.test.ts`, `src/solver/analog/__tests__/harness/nr-retry-grouping.test.ts`, `scripts/mcp/harness-tools.ts`, `src/test-fixtures/registry-builders.ts`, `src/test-fixtures/model-fixtures.ts` | 1719 | sonnet | model-fixtures: factories drop legacy 5-arg shape per §A.3 |
| `3.C.engine-tests-1` | `src/solver/analog/__tests__/ckt-context.test.ts`, `src/solver/analog/__tests__/element-interface.test.ts`, `src/solver/analog/__tests__/timestep.test.ts`, `src/solver/analog/__tests__/rc-ac-transient.test.ts`, `src/solver/analog/__tests__/analog-engine.test.ts` | 2318 | sonnet | ckt-context.test: delete entire "precomputed lists" describe block (cached-list tautology tests). element-interface.test: review whether file still has reason to exist post-contract; if not, delete |
| `3.C.engine-tests-2` | `src/solver/analog/__tests__/ac-analysis.test.ts`, `src/solver/analog/__tests__/compiler.test.ts`, `src/solver/analog/__tests__/compile-analog-partition.test.ts` | 1971 | sonnet | Rewrite via factory + `setupAll` per §A.19 |
| `3.C.stamp-order` | `src/solver/analog/__tests__/setup-stamp-order.test.ts`, `src/solver/analog/__tests__/dcop-init-jct.test.ts` | 1648 | sonnet | setup-stamp-order is the canonical pattern for the new test shape — every section migrates to `makeTestSetupContext({startBranch})` + `setupAll` |
| `3.C.dc-pin` | `src/solver/analog/__tests__/dc-operating-point.test.ts`, `src/solver/analog/__tests__/digital-pin-loading.test.ts`, `src/solver/analog/__tests__/digital-pin-model.test.ts` | 1939 | sonnet | dc-operating-point uses heaviest factory paths; rewrite per §A.19 |
| `3.C.spice-behav-1` | `src/solver/analog/__tests__/spice-import-dialog.test.ts`, `src/solver/analog/__tests__/convergence-regression.test.ts`, `src/solver/analog/__tests__/behavioral-gate.test.ts`, `src/solver/analog/__tests__/behavioral-combinational.test.ts` | 1980 | sonnet | behavioral-*.test files: delete dedicated flag-only `it()` blocks per §B.13 |
| `3.C.behav-2` | `src/solver/analog/__tests__/behavioral-sequential.test.ts`, `src/solver/analog/__tests__/behavioral-remaining.test.ts`, `src/solver/analog/__tests__/behavioral-integration.test.ts`, `src/solver/analog/__tests__/bridge-adapter.test.ts`, `src/solver/analog/__tests__/bridge-compilation.test.ts` | 2037 | sonnet | Same flag-only deletions where indicated per §B.13 |
| `3.C.mna-buck` | `src/solver/analog/__tests__/mna-end-to-end.test.ts`, `src/solver/analog/__tests__/buckbjt-nr-probe.test.ts`, `src/core/__tests__/analog-types-setparam.test.ts` | 989 | sonnet | Compact group |
| `3.C.sparse` | `src/solver/analog/__tests__/sparse-solver.test.ts` | 2114 | sonnet | Solo (huge) |
| `3.C.coordinator` | `src/solver/__tests__/coordinator-bridge.test.ts`, `src/solver/__tests__/coordinator-bridge-hotload.test.ts`, `src/solver/__tests__/coordinator-capability.test.ts`, `src/solver/__tests__/coordinator-clock.test.ts`, `src/solver/__tests__/coordinator-speed-control.test.ts` | 1642 | sonnet | Coordinator-level tests — most should already be type-stable; sweep for any `pinNodeIds`/`withNodeIds`/`isReactive` survivors |
| `3.C.compile` | `src/compile/__tests__/compile.test.ts`, `src/compile/__tests__/compile-integration.test.ts`, `src/compile/__tests__/coordinator.test.ts`, `src/compile/__tests__/pin-loading-menu.test.ts` | 2391 | sonnet | compile-integration: 3 fake `ComponentDefinition` literals — extend to satisfy current type, no `unknown` casts |
| `3.C.editor` | `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts`, `src/editor/__tests__/wire-current-resolver.test.ts` | 1501 | sonnet | wire-current-resolver: large but mostly mechanical sweep |

---

## P4 — `4.D.*` (15 agents — component tests)

| Group ID | Files | Lines | Model | Notes |
|---|---|---|---|---|
| `4.D.bjt` | `src/components/semiconductors/__tests__/bjt.test.ts` | 3243 | sonnet | Solo (huge). Delete dedicated flag-only `it()` blocks per §B.14; rewrite construction via factory + `setupAll` |
| `4.D.mosfet` | `src/components/semiconductors/__tests__/mosfet.test.ts` | 2407 | sonnet | Solo (huge). Same pattern |
| `4.D.diode-tests` | `src/components/semiconductors/__tests__/diode.test.ts`, `src/components/semiconductors/__tests__/zener.test.ts` | 1825 | sonnet | Delete flag-only blocks per §B.14 |
| `4.D.semi-misc` | `src/components/semiconductors/__tests__/tunnel-diode.test.ts`, `src/components/semiconductors/__tests__/varactor.test.ts`, `src/components/semiconductors/__tests__/schottky.test.ts`, `src/components/semiconductors/__tests__/jfet.test.ts` | 1847 | sonnet | varactor/schottky: delete flag-only blocks |
| `4.D.thyristor` | `src/components/semiconductors/__tests__/scr.test.ts`, `src/components/semiconductors/__tests__/triac.test.ts`, `src/components/semiconductors/__tests__/triode.test.ts`, `src/components/semiconductors/__tests__/diac.test.ts`, `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts` | 2477 | sonnet | triode: delete dedicated flag-only `it()` block per §B.14 |
| `4.D.passive-1` | `src/components/passives/__tests__/capacitor.test.ts`, `src/components/passives/__tests__/inductor.test.ts`, `src/components/passives/__tests__/resistor.test.ts` | 1743 | sonnet | capacitor/inductor: delete flag-only blocks per §B.14 |
| `4.D.passive-2` | `src/components/passives/__tests__/polarized-cap.test.ts`, `src/components/passives/__tests__/transformer.test.ts`, `src/components/passives/__tests__/tapped-transformer.test.ts` | 2151 | sonnet | polarized-cap/transformer: delete flag-only blocks per §B.14 |
| `4.D.passive-3` | `src/components/passives/__tests__/transmission-line.test.ts`, `src/components/passives/__tests__/crystal.test.ts`, `src/components/passives/__tests__/memristor.test.ts`, `src/components/passives/__tests__/analog-fuse.test.ts` | 2279 | sonnet | transmission-line: delete flag-only blocks AND dead `getInternalNodeCount` assertions inside `it("requires branch row")` block; KEEP `branchCount` assertions per §B.14 |
| `4.D.opamp` | `src/components/active/__tests__/opamp.test.ts`, `src/components/active/__tests__/real-opamp.test.ts`, `src/components/active/__tests__/comparator.test.ts`, `src/components/active/__tests__/schmitt-trigger.test.ts` | 1946 | sonnet | Rewrite construction via factory + `setupAll`; add `let solver` + `beforeEach` blocks where missing |
| `4.D.timer-misc` | `src/components/active/__tests__/timer-555.test.ts`, `src/components/active/__tests__/timer-555-debug.test.ts`, `src/components/active/__tests__/ota.test.ts`, `src/components/active/__tests__/optocoupler.test.ts`, `src/components/active/__tests__/analog-switch.test.ts` | 1873 | sonnet | timer-555-debug: audit-only per §B.14 ("verify no field-form `allNodeIds` survives"). optocoupler/analog-switch: delete flag-only blocks |
| `4.D.adc-cs` | `src/components/active/__tests__/adc.test.ts`, `src/components/active/__tests__/dac.test.ts`, `src/components/active/__tests__/cccs.test.ts`, `src/components/active/__tests__/ccvs.test.ts` | 1462 | sonnet | ccvs: remove duplicate `import type { SetupContext }` (TS2300 cluster). adc: replace `ADCElementExt` cast with real factory construction |
| `4.D.sources` | `src/components/sources/__tests__/ac-voltage-source.test.ts`, `src/components/sources/__tests__/dc-voltage-source.test.ts`, `src/components/sources/__tests__/current-source.test.ts`, `src/components/sources/__tests__/variable-rail.test.ts`, `src/components/sources/__tests__/ground.test.ts` | 1740 | sonnet | Heaviest TS2554 cluster — convert all 4-arg `makeDcVoltageSource(p, n, br, V)` to `makeDcVoltageSource(Map, V)` + `setupAll({startBranch})` |
| `4.D.io` | `src/components/io/__tests__/led.test.ts`, `src/components/io/__tests__/probe.test.ts`, `src/components/io/__tests__/analog-clock.test.ts`, `src/io/__tests__/dts-load-repro.test.ts` | 1979 | sonnet | led: resolve any `LED_CAP_STATE_SCHEMA` import drift per §B.14 |
| `4.D.sensors` | `src/components/sensors/__tests__/ldr.test.ts`, `src/components/sensors/__tests__/ntc-thermistor.test.ts`, `src/components/sensors/__tests__/spark-gap.test.ts` | 1205 | haiku | All low-complexity per §B.14 |
| `4.D.switching` | `src/components/switching/__tests__/fuse.test.ts`, `src/components/switching/__tests__/switches.test.ts`, `src/components/switching/__tests__/trans-gate.test.ts` | 2116 | sonnet | trans-gate: delete dedicated flag-only `describe` block per §B.14 |

---

## Sizing rationale (token budget)

User constraint: ≤40,000 tokens of source per agent (≈10k lines at ~4 tok/line). Largest single-agent assignments:

- `4.D.bjt` — 3243 lines (~13k tok) ✓
- `3.C.compsess` — 2963 lines (~12k tok) ✓
- `2.B.bjt` — 2449 lines (~10k tok) ✓
- `4.D.mosfet` — 2407 lines (~10k tok) ✓
- `1.A.solver-core` — 2410 lines, three files ✓

All groups within budget. Sonnet selected for any group containing a file ≥500 lines or any group flagged "high" in §B; haiku reserved for low-complexity sweeps in `2.B.io-mem`, `2.B.flipflops`, `4.D.sensors`.

---

## End-of-wave summary

(Coordinator appends here after termination. Failures handled inline by Priority B during the wave generally don't surface here unless they failed twice; clarifications cross-link to `setup-load-cleanup-clarifications.md`.)

Suggested structure:

- **Spawn totals:** implementers / fix-implementers / verifiers.
- **Pass on first try:** count + list (or `(omitted: N)` if long).
- **Pass after fix-implementer retry:** count + list.
- **Failed twice (escalate to user):** count + list + reason.
- **Open clarifications:** count + cross-link.
- **Convergence-check results:** §C.1 grep, `tsc --noEmit`, test-baseline diff.
