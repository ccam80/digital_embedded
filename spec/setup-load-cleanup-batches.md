# Setup-Load Cleanup — Batch Prompts

Spec contract: `spec/setup-load-cleanup.md` (single source of truth — every type, factory shape, grep, and clause referenced below lives there).
State file: `spec/.hybrid-state.json`
Foundation (B.0): in flight outside this document. Wave does not start until `core/analog-types.ts`, `solver/analog/element.ts`, `core/registry.ts`, `compile/types.ts`, `solver/analog/composite-element.ts` (NEW), and `solver/analog/__tests__/test-helpers.ts` are landed per spec §B.0 + §A.15 + §A.19.

## Wave structure

| Batch | Coverage | Task groups (agents) | Files | Total source lines |
|---|---|---|---|---|
| `batch-1` | B.1 engine/compiler/app + B.3 behavioral + B.4 sources + B.5 passives | 11 | 37 | ~20,959 |
| `batch-2` | B.6 semiconductors + B.7 switching + B.8 active + B.9 sensors/IO + B.10 wiring/memory/flipflop | 15 | 53 | ~26,008 |
| `batch-3` | B.11 harness + B.12 fixtures + B.13 engine/solver tests | 15 | 51 | ~29,750 |
| `batch-4` | B.14 component tests | 15 | 51 | ~28,932 |

Sequential batches; full verification on each before next batch unblocks (per implement-hybrid skill gate). Within each batch, all task_groups dispatch in parallel.

## Hard constraints (shared across all agents)

Every agent prompt MUST include the following block verbatim:

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
```
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
```

## Final bash call
- Normal finish: `bash "C:/Users/cca79/.claude/plugins/cache/claude-orchestrator-marketplace/claude-orchestrator/fb7ba7ebc0e0/scripts/complete-implementer.sh"`
- Spec ambiguity blocking work: write `CLARIFICATION NEEDED: <details>` to `spec/progress.md`, then `bash "C:/Users/cca79/.claude/plugins/cache/claude-orchestrator-marketplace/claude-orchestrator/fb7ba7ebc0e0/scripts/stop-for-clarification.sh"`

## Context files (read in this order)
1. `CLAUDE.md`
2. `spec/.context/rules.md`
3. `spec/.context/lock-protocol.md`
4. `spec/setup-load-cleanup.md` — Section A (target shape) and Section C (greps)
5. `spec/test-baseline.md`
6. `spec/progress.md` (to append your status)
```

---

## batch-1 — Engine/compiler/app + behavioral + sources + passives (11 agents)

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

## batch-2 — Semiconductors + switching + active + sensors/IO + wiring/memory/flipflop (15 agents)

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
| `2.B.controlled` | `src/components/active/ccvs.ts`, `src/components/active/vcvs.ts`, `src/components/active/vccs.ts`, `src/components/active/cccs.ts` | 1539 | sonnet | ccvs/vcvs: `findBranchFor` lives on `controlled-source-base.ts` (already done in batch-1); these subclasses inherit the unified shape |
| `2.B.sensors-io` | `src/components/sensors/ldr.ts`, `src/components/sensors/ntc-thermistor.ts`, `src/components/sensors/spark-gap.ts`, `src/components/io/led.ts`, `src/components/io/clock.ts` | 1971 | sonnet | led: audit-only per §B.9 ("verified clean per spec author") — confirm and report |
| `2.B.io-mem` | `src/components/io/probe.ts`, `src/components/wiring/driver-inv.ts`, `src/components/memory/register.ts`, `src/components/memory/counter.ts`, `src/components/memory/counter-preset.ts`, `src/components/flipflops/t.ts`, `src/components/flipflops/rs.ts` | 1959 | haiku | All low-complexity per §B.9/§B.10 |
| `2.B.flipflops` | `src/components/flipflops/rs-async.ts`, `src/components/flipflops/jk.ts`, `src/components/flipflops/jk-async.ts`, `src/components/flipflops/d.ts`, `src/components/flipflops/d-async.ts` | 1531 | haiku | All low-complexity per §B.10 |

---

## batch-3 — Harness + test fixtures + engine/solver tests (15 agents)

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

## batch-4 — Component tests (15 agents)

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

## Convergence (post-batch-4)

After batch-4 fully verifies, the convergence pass runs Section §C.1 greps repo-wide and `tsc --noEmit` to confirm:

- Zero forbidden-pattern hits repo-wide
- Zero TypeScript errors
- No NEW test failures relative to `spec/test-baseline.md`

Per §D point 3, convergence may take more than one pass; residual goes to a follow-up spec/fix list rather than being treated as wave-complete.

## Sizing rationale (token budget)

User constraint: ≤40,000 tokens of source per agent (≈10k lines at ~4 tok/line). Largest single-agent assignments:

- `4.D.bjt` — 3243 lines (~13k tok) ✓
- `3.C.compsess` — 2963 lines (~12k tok) ✓
- `2.B.bjt` — 2449 lines (~10k tok) ✓
- `4.D.mosfet` — 2407 lines (~10k tok) ✓
- `1.A.solver-core` — 2410 lines, three files ✓

All groups within budget. Sonnet selected for any group containing a file ≥500 lines or any group flagged "high" in §B; haiku reserved for low-complexity sweeps in `2.B.io-mem`, `2.B.flipflops`, `4.D.sensors`.
