# Manual Fix List

> Generated 2026-05-01, compacted 2026-05-04. Source: `spec/merged-implementer-contracts.md` cross-referenced against the four phase docs.
> Phase tags: `phase-1-engine-infrastructure` (Phase1 File N), `phase-component-model-correctness-job` (Component A/B/C/G), `phase-composite-architecture` (Composite I/D/M/E), `phase-test-contract-updates` (Test 1.x / UC-7).

## How to read this file

- §0 (Architectural Updates) is mandatory reading before touching any remaining task — it captures every spec-line citation that has drifted, every architectural ripple in flight, and every contract change that supersedes the original phase-doc text.
- §3 POISON-PATTERN WARNING is mandatory reading before touching any test file.
- Completed items in §1, §2, §4 appear as J-ID rosters only; consult git history for landing-commit details.
- Remaining items in §2e, §2g, §3, §4c–§4g carry full per-file detail.

---

## §0. Architectural Updates (flow-on notes — applies to all remaining work)

### Module relocations
- `src/core/analog-types.ts` **DELETED**. Types moved to natural owners under `src/solver/analog/`:
  - `AnalogElement`, `PoolBackedAnalogElement`, `isPoolBacked` → `element.ts` (now ~265 lines, was a 32-line shim)
  - `IntegrationMethod` → `integration.ts`; `SparseSolverStamp` → `sparse-solver.ts`
  - `ComplexSparseSolver` (interface) **renamed** `ComplexSparseSolverStamp` → `complex-sparse-solver.ts`
  - `StatePoolRef` → `state-pool.ts`; `AcParams`/`AcResult` → `ac-analysis.ts`
  - `NGSPICE_LOAD_ORDER`, `TYPE_ID_TO_NGSPICE_LOAD_ORDER`, `getNgspiceLoadOrderByTypeId`, `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` → `ngspice-load-order.ts` (NEW)
  - `Diagnostic*` → `src/compile/types.ts` (canonical home)
- `src/headless/spice-model-apply.ts` moved to `src/app/spice-model-apply.ts`; `applyParsedSpiceModel` renamed `applySpiceImportResult` and now takes explicit `element: CircuitElement`.

### Field deletions
- `participatesInLoad?: boolean` on `AnalogElement` **DELETED**. Wrapper is now `SubcircuitWrapperElement` class (`src/solver/analog/subcircuit-wrapper-element.ts`) with no-op `setup()`/`load()`. Engine walks every element unconditionally.
- `accept?` slot on `AnalogElement` **DELETED**. Use `acceptStep?` exclusively (J-178).
- `ngspiceNodeMap` field on `ModelEntry`/`StandaloneComponentDefinition`/`MnaModel` **DELETED**. Cross-system pin-rename is owned by `TYPE_ID_TO_DECK_PIN_LABEL_ORDER`.
- Schema-init mechanism (§4d) **DELETED**: `init` field on `SlotDescriptor`, `SlotInit` union, and `applyInitialValues` are all gone. State arrays start zero. Non-zero startup values live in instance fields populated in `setup()` (booleans `_intact`, `_firstSample`, `_ncBootState`, etc.). DCOP populates `state0` via bottom-of-load idiom; engine seeds `state1` from `state0` in `analog-engine.ts:1437` once after DCOP (mirrors `dctran.c:349-350`).

### Pin-key alignment
- `resistor`/`inductor`/`crystal`/`memristor`/`potentiometer` use `pos`/`neg` (NOT `A`/`B`); third terminal `W` retained on potentiometer.
- §3 test files citing `A`/`B` for these components must rename — tracked under each test's own J-ID.
- **Outstanding callsite blockers**: `src/solver/analog/__tests__/setup-stamp-order.test.ts:866-872` `MemristorElement(A,B)` (was J-129; file now deleted) and any §3 test still on the `A/B` pin-key.

### Interface contracts
- `SubcircuitElementParam` is a **CLOSED** 4-arm union (`number | string | siblingBranch | siblingState`). Booleans must encode as 0/1 numbers. Affects J-019 (adc.ts) and J-023 (dac.ts).
- `SubcircuitElement.subElementName?: string` and `internalNetLabels?` are declared directly on the interface (`mna-subcircuit-netlist.ts:30`); inline `& { subElementName: string }` casts are dead — strip on contact.
- `internalOnly?: boolean` on `ModelEntryNetlist` is honoured by `getAllStandalone()`/`getByCategory()` (registry filters at registration); palette and SPICE-import paths are structurally safe — no per-call guards needed.
- `setSimTime(t: number)` is a **method** on `SimulationCoordinator`/`AnalogEngine`, not an accessor.
- `SimulationCoordinator` carries `getRuntimeDiagnostics()`, `setLimitingCapture()`, `getLimitingEvents()` (J-181/182/183).
- `LimitingEvent.limitType` includes `"railLim"` (J-179). Single source of truth: `newton-raphson.ts`. Re-export only — duplicate definitions in `harness/types.ts` removed.

### Compiler / netlist ripples
- `labelToNodeId` ngspice two-namespace semantics (J-175): bare label registered only for 1-pin labeled elements (Port/In/Out/Ground); multi-pin devices register `label:pinLabel` per pin. AC analysis `sourceLabel`/`outputNodes` now require single-node labels (1-pin or pin-form `V1:pos`).
- `resolveSubcircuitModels` (compiler.ts) copies static entries from `instanceProps` into `mergedProps` so structural props reach netlist builders.
- Netlist builders use `params.getOrDefault<T>("name", default)`, NOT `getModelParam<T>("name")`, for structural props (`bits`, `bipolar`, `sar`, `vIH`, `vIL`, `inputCount`/`outputCount`). These props MUST also appear in the parent's `instance` paramDefs section so the compiler merger forwards them.
- `harness_describe` groups `internalOnly` sub-elements via the `<parentLabel>:<subElementName>` label shape stamped at expansion (NOT via the `internalOnly` registry flag).

### Architectural shapes (supersede phase-doc spec text)
- **Norton, not Thévenin, for `BehavioralOutputDriverElement`** (J-145): rOut folded as `1/rOut` conductance into the driver's own 2×2 stamp. `DigitalOutputPinLoaded` no longer has a separate Resistor child or `driveNode` internal net.
- **Tri-state via `OUTPUT_LOGIC_LEVEL_ENABLE` slot + sibling `enableLogic` siblingState ref** (J-145/J-146); high-Z = 1 GΩ shunt + zero current injection.
- **`SAR_BITS` slot in `adc-driver` is per-step internal** (not externally consumed); external siblings consume per-bit `OUTPUT_D<i>` slots.
- **Comparator is a 3-file family**: `comparator.ts` (parent), `comparator-driver.ts` (open-collector), `comparator-pushpull-driver.ts` (push-pull). Both drivers are PoolBacked, share `COMPARATOR_SCHEMA` (`OUTPUT_LATCH`, `OUTPUT_WEIGHT`).
- **Decoder/demux drivers** use whole-vector hold-on-indeterminate; demux analog model is 1-bit (multi-bit demuxes fall through to digital).

### `params.uic` wiring
- Now propagates through `CKTCircuitContext.cktMode` and toggles `MODEUIC` (mirrors `cktdefs.h:185`, `dctran.c:117-189` UIC fast path). `uic: true` on capacitor/inductor honours initial conditions in transient.

### Runtime-diagnostic emission
- `RuntimeDiagnosticAware` interface (`element.ts`) + `isRuntimeDiagnosticAware` type-guard. Elements declare `setDiagnosticEmitter(emit)` setter. `MNAEngine.init()` walks `compiled.elements` and installs `(d) => this._diagnostics.emit(d)` on every implementer. Production factories DO NOT pass an `emitDiagnostic` constructor param. Hot path is V8-inlined `() => {}` default until `setDiagnosticEmitter` runs.

### Test infrastructure (§4 — non-negotiable)
- `src/solver/analog/__tests__/test-helpers.ts` **DELETED** (§4a).
- All test fixture construction goes through `buildFixture(opts)` (`src/solver/analog/__tests__/fixtures/build-fixture.ts`). Returns `{ facade, coordinator, engine, pool, circuit, elementLabels }`. `dtsPath` OR `build:(registry, facade)=>Circuit`. Always warm-starts via `coordinator.step()` (no `skipDcOp`/`skipBoot` escape hatches).
- Tests drive via `coordinator.dcOperatingPoint()` / `coordinator.step(dt)` / `coordinator.captureElementStates(idx)` / `engine.compiled.solver.getCSCNonZeros()` / `engine.getNodeVoltage()`.
- **No test calls `element.setup()` or `element.load()`. No test fabricates a `LoadContext`/`SetupContext`/`StatePool`.** See §3 poison-pattern warning.
- `as unknown as` casts on coordinator/engine internals are forbidden.

### §4f abstract-base migration
- `AbstractAnalogElement` and `AbstractPoolBackedAnalogElement` (`element.ts`) own field declarations and `super(pinNodes)` by-reference storage. Subclass `extends Abstract...`; declare `readonly ngspiceLoadOrder` and implement abstract `setup`/`load`/`getPinCurrents`/`setParam`. Pool-backed subclasses also declare `readonly stateSchema` / `readonly stateSize`; trivial `initState(pool) { this._pool = pool; }` lives on the base.
- All §4f-named class-based leaves (Waves 1-9) are migrated. `_pinNodes = new Map(pinNodes)` defensive copies are gone from those files. Inline object literals in tests/fixtures are converted via the Wave 8 recipe (local class extending the base).

### §4g abstract-base privacy gates (in flight)
- Phase A: `pinNodes` getter on the abstract base; migrate all read sites (`_pinNodes` → `pinNodes`).
- Phase B: rename to ECMAScript private `#pinNodes`; getter narrows to `ReadonlyMap`. Patcher writes through closure-captured `patchWork[i].map` (NOT through `el.pinNodes`).
- Phase C: collapse `interface AnalogElement` + `abstract class AbstractAnalogElement` into a single nominal-branded `abstract class AnalogElement`; same for the pool-backed pair. After C: only path to an `AnalogElement` is `new SomeSubclass(...)`.

### Bus-pin caveat
- `counter-preset`/`register`/`jk`/`jk-async`/`d-async` drivers use `(vIn >>> i) & 1` integer-extraction that assumes a multi-bit `bridge-input-driver` (J-135). Until J-135 lands, multi-bit composites won't decode correctly — bridges are correctly 1-bit only because multi-bit signals never cross a bridge today.

### Other latent / known
- `MEMRISTOR_SCHEMA.indexOf("W")` is wrong — schema is a `ReadonlyMap`; use `.get("W")`. Affects pending J-050 NEW FILE.
- `memristor-rollback.test.ts` carries `metadata: {}` on `CircuitSpec` literal — field doesn't exist; fix on author.
- `bjt.ts:580/584` (L0) and `:1202/1206` (L1) are object-literal factories blocking the 3 retained `as AnalogElement & { label?: string; elementIndex?: number }` casts in `bjt.test.ts:409,460,2750` — see §4g Wave 11b.
- `setup-stamp-order.test.ts` was DELETED 2026-05-04 (J-129); all 55 active blocks were Category P1 engine-impersonator stamp-order tests, fully covered by `ngspice-parity/load-order-parity.test.ts`. Same-pattern dangling block in `analog-switch.test.ts:203-285` deleted in same commit.

---

## Locked Decisions (recorded 2026-05-01)

- **J-001** (`comparison-session.ts` UC-7) — STRUCK; non-source acknowledgement.
- **J-005** (`spec/setup-load-split/00-engine.md` UC-7) — STRUCK; documentation fence.
- **J-007** (`compile-bridge-guard.test.ts`) — KEPT with strong-justification gate; user deleted in frustration; agent must justify when reached or drop it.
- **J-038** (`buf.ts`) — MAKE THE FILE; BUF is user-facing.
- **J-163/164/165/166/167/169** (flip-flop class-removal files) — DELETE THE FILE UNCONDITIONALLY IF EMPTY after class removal.

---

## §1. Engine / Internals — COMPLETE

All §1a–§1e items landed 2026-05-02 / 05-03.

- §1a (type/interface foundations): J-178, J-100, J-101, J-070
- §1b (solver core): J-179, J-180, J-181, J-182, J-183
- §1c (compiler/engine setup): J-175 (incl. labelToNodeId remediation), J-132
- §1d (headless/harness/IO): J-105, J-004, J-006, J-104, J-103 + harness-tools cast hygiene
- §1e (deletions): J-176, J-177

---

## §2. Components

### §2a Behavioural-driver leaves — COMPLETE
J-171, J-033, J-034, J-035, J-036, J-135, J-136, J-134, J-153, J-150, J-151, J-161, J-160, J-152, J-137, J-149, J-144, J-143, J-139, J-140, J-154, J-145, J-146, J-158, J-157, J-138, J-142, J-159, J-156, J-155, J-148, J-147, J-141, J-022, J-018, J-020, J-028, J-030, J-025, J-024, J-063, J-095, J-091, J-093, J-068, J-067, J-065, J-066, J-069.

### §2b Pool-backed migrations — COMPLETE
J-056 (analog-fuse), J-060 (memristor), J-086 (spark-gap), J-085 (ntc-thermistor), J-027 (real-opamp), J-021 (comparator triplet).

### §2c Pin-key alignment outliers — COMPLETE
J-061 (resistor + 23-file `ngspiceNodeMap` deletion sweep), J-059 (inductor), J-058 (crystal), potentiometer (no J-ID; folded in).

### §2d BJT factory rename — COMPLETE
J-078 (bjt.ts), J-082 (triac.ts), J-026 (optocoupler.ts), J-031 (timer-555.ts), J-032 (vcvs.ts comparator preset).

### §2e Composite class deletions / netlist conversions — REMAINING

- [ ] `src/components/semiconductors/scr.ts` — ssM1 — Declare `SCR_NETLIST`; delete `ScrCompositeElement`, `createScrElement` (J-081).
- [ ] `src/components/semiconductors/diac.ts` — ssM2 — Declare `DIAC_NETLIST`; delete `createDiacElement` (J-079).
- [ ] `src/components/semiconductors/diode.ts` — Test 1.46 — Architecture-fix: gate `ctx.limitingCollector?.push(...)` on MODEINIT* mask matching `dioload.c:139-205` (J-080).
- [ ] `src/components/active/adc.ts` — ssM23 — Declare `buildAdcNetlist`; delete `ADCAnalogElement` (J-019).
- [ ] `src/components/active/dac.ts` — ssM22 + Phase1 ssG — Declare `buildDacNetlist`; delete `DACAnalogElement`; set `rOut.default: 1` (J-023).
- [ ] `src/components/active/schmitt-trigger.ts` — ssG9 + ssM25 — Delete empty `accept(){}`; declare netlist + driver (J-029).
- [ ] `src/components/passives/transmission-line.ts` — ssM6 — Declare `buildTransmissionLineNetlist`; delete `TransmissionLineElement` and 5 inline sub-element classes (J-064). **NB**: §4g Wave 11a ALSO converts this — coordinate.
- [ ] `src/components/passives/tapped-transformer.ts` — ssM26 — Declare `buildTappedTransformerNetlist`; delete `AnalogTappedTransformerElement` (J-062).
- [ ] `src/components/passives/capacitor.ts` — ssD3 — Docstring-only update on `AnalogCapacitorElement` (J-057).
- [ ] `src/components/switching/switch.ts` — ssM7 — Add `SWITCH_SCHEMA` with `CLOSED` slot; reads `s1[CLOSED]`; remove `closed` ctor param (J-098).
- [ ] `src/components/switching/relay.ts` — ssB6 + ssM7 — Pin-key rename; declare `RELAY_NETLIST`; delete composite (J-097).
- [ ] `src/components/switching/relay-dt.ts` — ssB7 + ssM7 — Pin-key rename; declare double-throw netlist; delete composite (J-096).
- [ ] `src/components/switching/fgnfet.ts` — ssM8 — Declare `FGNFET_NETLIST`; delete `FGNFETAnalogElement` and inline sub-elements (J-092). **NB**: §4g Wave 11a coordinates.
- [ ] `src/components/switching/fgpfet.ts` — ssM9 — Declare `FGPFET_NETLIST`; delete `FGPFETAnalogElement` and inline sub-elements (J-094). **NB**: §4g Wave 11a coordinates.

### §2f Gate user-facing components — COMPLETE
J-037, J-042, J-039, J-040, J-044, J-043, J-041, J-038.

### §2g Behavioural-element file deletions — partially done

**REMAINING:**
- [ ] `src/solver/analog/behavioral-gate.ts` — ssM10 — Delete `BehavioralGateElement` and `GateTruthTable`; delete file if no exports (J-170).
- [ ] `src/solver/analog/behavioral-combinational.ts` — ssG10 + ssM11 — Delete 3 empty `accept(){}` stubs and 3 composite classes (J-133).
- [ ] `src/solver/analog/behavioral-sequential.ts` — ssM12 — Delete 3 composite classes (J-173).
- [ ] `src/solver/analog/behavioral-remaining.ts` — ssG11 + ssM13 — Delete 3 empty `accept(){}` stubs and 5 composite classes (J-172).
- [ ] `src/solver/analog/bridge-adapter.ts` — ssM21 — Delete `BridgeOutputAdapter`/`BridgeInputAdapter`; keep factories wrapping new driver leaves (J-174).

**COMPLETE**: J-162, J-163, J-164, J-165, J-166, J-167, J-169, J-168 (flip-flop class deletions; `behavioral-flipflop/` directory removed; orphan `behavioral-flipflop-variants.ts` and `behavioral-flipflop/index.ts` also deleted).

---

## §3. Tests

### ⚠️ POISON-PATTERN WARNING (mandatory before touching ANY test file)

The §4a deletion of `test-helpers.ts` removed the official engine-impersonator surface — but **other test files have rolled their own equivalents inline**. They are not on the §4c migration list because they don't import the deleted helpers; they reimplement the same anti-pattern locally. They are still poison and must be eradicated on contact.

**A test file is poison if it does ANY of the following inline:**
- Constructs its own `CKTCircuitContext` / `LoadContext` / `SetupContext` / fake matrix / fake RHS / fake solver / fake coordinator that mimics the engine's shape.
- Allocates its own `StatePool` (calls `new StatePool(...)` or fabricates `pool.state0` / `pool.state1` arrays directly) outside `buildFixture`.
- Calls `element.setup(ctx)`, `element.load(ctx)`, `element.acceptStep(...)`, `element.initState(...)`, `element.applyInitialValues(...)`, or any other internal lifecycle method directly.
- Calls `compileUnified(...)` or any solver-stage entry point directly to bypass the facade.
- Hand-rolls a `LoadContext` literal and passes it to `load()`.
- Manually walks elements via `mnaEngine._setup()` / `_load()` / `_walkSubElements`.

**The non-negotiable contract:** every test goes through `buildFixture(opts)` (§4b) + the public coordinator/engine surface. **No test calls `element.setup()` or `element.load()` directly. No test fabricates a context or pool.**

**When you encounter poison in §3 (regardless of which J-ID brought you to the file):**
1. STOP the in-progress §3 work for that file.
2. Surface the finding to the user.
3. Migrate to `buildFixture` first (treat as off-list §4c sibling).
4. Apply the §3 contract-update edits on top.
5. Add to §4c retroactively.

**Banned closing verdicts**: *"low-priority"*, *"out of scope"*, *"can address later"*, *"the test still passes"*. Wide-scope-default applies — the engine-impersonator pattern was passing tests for months while masking the J-056 schema-init bug.

### §3a Test fixtures / helpers — REMAINING
- [ ] `src/test-utils/falstad-fixture-reference.ts` — ssB8 — Pin-key rename for resistor/inductor/crystal/memristor (J-184).
- [ ] `src/test-utils/mock-coordinator.ts` — ssC7 — Add no-op `setLimitingCapture`/`getLimitingEvents` on `MockCoordinator` (J-185).
- [ ] `src/solver/analog/__tests__/test-helpers.ts` — Test 1.45 — UC-2 sweep at 151, 189 (J-131). **NB**: file was deleted in §4a — this row is moot if pre-deletion line citations no longer apply; verify on pickup.
- [ ] `src/solver/analog/__tests__/fixtures/analog-fixtures.ts` — ssB11 — Pin-key rename at 166, 181 (J-122).

### §3b UC-7 retentions (NO-CHANGE acknowledgements) — REMAINING
- [ ] `capacitor.test.ts:306` `_stateBase===-1` (J-047)
- [ ] `crystal.test.ts:452` (J-048)
- [ ] `inductor.test.ts:301` (J-049)
- [ ] `polarized-cap.test.ts:478` (J-051)
- [ ] `compile-analog-partition.test.ts:528,549,555` (J-116)

### §3c Engine / solver unit tests

**COMPLETE**: J-129 (setup-stamp-order — file deleted with parity citation).

**REMAINING:**
- [ ] `compile-bridge-guard.test.ts` — Test 1.2 — UC-1 M2 at 134 (J-007). **Locked**: produce strong justification or delete.
- [ ] `sparse-solver.test.ts` — Test 1.44 — UC-1 M1 at 579 (J-130).
- [ ] `ckt-load.test.ts` — ssB15 — Pin-key rename at 41 (J-115).
- [ ] `compiler.test.ts` — ssB16 — Pin-key rename at 98, 128 (J-117).
- [ ] `ac-analysis.test.ts` — ssB13 — Pin-key rename at 50, 80, 109 (J-106).
- [ ] `ckt-context.test.ts` — ssB14 + Phase1 File 7 — Pin-key at 26; replace `allocates_all_buffers_at_init` → `allocates_all_buffers_after_setup` (J-114).
- [ ] `competing-voltage-constraints.test.ts` — Phase1 File 8 — Migrate from `compileUnified+result.analog.diagnostics` to `facade.compile()+coordinator.dcOperatingPoint()+coordinator.getRuntimeDiagnostics()` (J-118).
- [ ] `dc-operating-point.test.ts` — Test 1.36 + ssB17 — Delete `makeDiode`; migrate 5 tests to M1 with `params.noOpIter`; pin-key at 60 (J-120).
- [ ] `analog-engine.test.ts` — Test 1.27 + 1.27b + ssB12 — UC-1 sweep + accessor-test rename + delete `accessors return null/empty before init`; pin-key at 43 (J-107).
- [ ] `convergence-regression.test.ts` — Test 1.35 + ssB18 — Migrate HWR tests to M1/M3; delete `makeHalfWaveRectifier`/`makeRCCircuit`; pin-key at 26 (J-119).
- [ ] `bridge-adapter.test.ts` — Test 1.32 — UC-2 at 175, 239, 271 (J-112).
- [ ] `bridge-compilation.test.ts` — Test 1.33 — UC-2 at 362 (J-113).
- [ ] `dcop-init-jct.test.ts` — ssA7 — BJT factory rename at 16, 17, 134, 172, 189 (J-121).
- [ ] `mna-end-to-end.test.ts` — Test 1.41 — UC-1 sweep at 15 sites (J-127).
- [ ] `rc-ac-transient.test.ts` — Test 1.42 — UC-1 sweep at 7 sites (J-128).
- [ ] `behavioral-combinational.test.ts` — Test 1.28 — UC-1, UC-5 contract-update (J-108).
- [ ] `behavioral-gate.test.ts` — Test 1.29 — UC-2 sweep + Entry 1 pin-loading migration (J-109).
- [ ] `behavioral-integration.test.ts` — Test 1.30 — UC-1 M1 of `beforeEach` at 315 (J-110).
- [ ] `behavioral-sequential.test.ts` — Test 1.31 — Counter/Register Entry 1 migration; UC-1 + UC-5 (J-111).

### §3d Harness-integration tests — REMAINING
- [ ] `harness/boot-step.test.ts` — Test 1.37 — UC-1 M1 at 35 (J-123).
- [ ] `harness/harness-integration.test.ts` — Test 1.38 + 1.38b — M3 migration; rename accessor test; delete `MNAEngine accessors return null/empty before init` (J-124).
- [ ] `harness/lte-retry-grouping.test.ts` — Test 1.39 — UC-1 M1 at 8 sites (J-125).
- [ ] `harness/nr-retry-grouping.test.ts` — Test 1.40 — UC-1 M1 at 7 sites (J-126).

### §3e Component tests

**COMPLETE**: J-072 (diode.test.ts — full rewrite onto buildFixture; 38→16 tests; 22 P1/P2 deletes cited to `ngspice-parity/diode-resistor.test.ts`; 4 new closed-form sanity probes anchor `computeJunctionCapacitance`/`computeJunctionCharge` public-export contract).

**REMAINING:**
- [ ] `analog-switch.test.ts` — Test 1.3 — UC-1, UC-2 at 253, 277 (J-008).
- [ ] `cccs.test.ts` — Test 1.4 — UC-1 at 241, 252, 263, 289 (J-009). **NB**: also tracked as §4c row landed; verify.
- [ ] `ccvs.test.ts` — Test 1.5 — UC-1 at 236, 255, 266, 292 (J-010). **NB**: §4c row landed; verify.
- [ ] `comparator-rollback.test.ts` — ssG8 — NEW FILE; LTE-rejection rollback for `OUTPUT_WEIGHT` (J-011).
- [ ] `dac.test.ts` — Test 1.6 — UC-1 at 143 (J-012).
- [ ] `optocoupler.test.ts` — ssM4 — Update lines 85-87 to assert `participatesInLoad: false` on wrapper (J-013). **NB**: `participatesInLoad` field deleted (§0); revise spec text — assert wrapper class identity instead.
- [ ] `real-opamp-raillim.test.ts` — ssC2 — NEW FILE; railLim LimitingEvent capture (J-014).
- [ ] `timer-555-debug.test.ts` — Test 1.7 — UC-1 at 165; UC-3 at 180, 201 (J-015).
- [ ] `vccs.test.ts` — Test 1.8 — UC-1 at 131, 148, 165, 181 (J-016).
- [ ] `vcvs.test.ts` — Test 1.9 — UC-1 at 125, 140, 156, 174, 189 (J-017).
- [ ] `led.test.ts` — Test 1.10 + 1.10b + 1.10c — M1 migration of 4 forward-drop tests + Entry 5 junction-cap + 7.a/7.d; delete tests for MODEINITJCT and null-collector branches (J-045). **NB**: file partially landed under §4c with deletions + LED EG fix.
- [ ] `analog-fuse-rollback.test.ts` — ssG2 — NEW FILE; LTE-rejection rollback for `I2T_ACCUM`/`CONDUCT` (J-046).
- [ ] `memristor-rollback.test.ts` — ssB4 — NEW FILE; LTE rollback for `W` (J-050). **NB**: pre-existing draft has 2 TS errors (`MEMRISTOR_SCHEMA.indexOf("W")` should be `.get`; `metadata: {}` not on `CircuitSpec`).
- [ ] `potentiometer.test.ts` — Test 1.11 — Entry 11 W↔B index swap; M1; resload citation (J-052).
- [ ] `resistor.test.ts` — Test 1.12 — Entry 4 contract-update; M1; bit-exact stamp; resload.c:34-37 citation (J-053). **NB**: §4c partial landing already deleted 5 matrix-peek tests (covered by `ngspice-parity/resistive-divider.test.ts`).
- [ ] `tapped-transformer.test.ts` — Rewrite against new `buildTappedTransformerNetlist` (Inductor×3 + TransformerCoupling×3); current tests instantiate deleted `AnalogTappedTransformerElement` (7 occurrences) (J-NEW-tt1).
- [ ] `tx_trace.test.ts` — Same rewrite or delete if duplicates main suite (J-NEW-tt2). **NB**: deleted under §4c.
- [ ] `transformer.test.ts` — Test 1.13 + Phase1 File 6 + UC-7 — UC-2 at 176; unskip `analogFactory creates element with correct branch indices`; line 663 retained (J-054).
- [ ] `transmission-line.test.ts` — Test 1.14 — UC-1 + UC-2 across 6 engine sites and 3 `_stateBase` writes (J-055). **NB**: 14/14 pass post §4f-Wave-1; see follow-on at §4f.
- [ ] `bjt.test.ts` — ssA5 — BJT factory rename at 24 sites (J-071). **NB**: 3 retained `as AnalogElement & {…}` casts blocked on §4g Wave 11b (`bjt.ts:580/584/1202/1206` literal-to-class migration); minimum-viable closure for Wave 8 if landed alone.
- [ ] `jfet.test.ts` — Test 1.16 — Entry 9 saturation-circuit migration + UC-2 sweep; jfetload.c citations (J-073). **NB**: §4c partial landing migrated 21/21 tests; verify J-073 contract still applies.
- [ ] `phase-3-xfact-predictor.test.ts` — ssA8 — L1 conversion at 11, 313 (J-074).
- [ ] `schottky.test.ts` — Test 1.17 — UC-1 + UC-2 at 71, 285, 314 (J-075).
- [ ] `varactor.test.ts` — Test 1.18 — UC-1 M1 at 121 (J-076).
- [ ] `zener.test.ts` — Test 1.19 — UC-2 at 59 (J-077).
- [ ] `ntc-thermistor-rollback.test.ts` — ssG6 — NEW FILE; LTE rollback for `TEMPERATURE` (J-083).
- [ ] `spark-gap-rollback.test.ts` — ssG4 — NEW FILE; LTE rollback for `CONDUCTING` (J-084).
- [ ] `ac-voltage-source.test.ts` — Test 1.20 — UC-1 M1 at 337 (J-087).
- [ ] `current-source-kcl.test.ts` — Test 1.21 — UC-1 M1 at 73, 109 (J-088).
- [ ] `fuse.test.ts` — Test 1.22 — UC-1 M1 at 6 sites (J-089).
- [ ] `trans-gate.test.ts` — Test 1.23 — UC-1 + UC-3 with state inspection (J-090).
- [ ] `resolve-simulation-params.test.ts` — Test 1.25 — UC-1 M2 at 115, 130, 137 (J-099).
- [ ] `wire-current-resolver.test.ts` — Test 1.26 + ssB10 — UC-1 M2 at 7 sites; pin-key at 33, 111 (J-102).

### §3f E2E tests — REMAINING
- [ ] `e2e/gui/analog-bjt-convergence.spec.ts` — Test 1.1 — Insert `placeLabeled('Diode', 43, 12, 'TD', 90)` after line 153 (J-002).
- [ ] `e2e/gui/component-sweep.spec.ts` — Phase1 ssE — Wire VDD/GND/inputs in CMOS-mode sweep (lines 766-789) using property label `'voltage'` (J-003).

---

## §4. Test Infrastructure Deprecation

### §4a Helper deletions — COMPLETE (2026-05-03)
`src/solver/analog/__tests__/test-helpers.ts` DELETED. All 9 exports (state/init/NR + setup/load impersonators) removed.

### §4b `buildFixture` — COMPLETE (2026-05-03)
`src/solver/analog/__tests__/fixtures/build-fixture.ts` (NEW) and `harness/hwr-fixture.ts` (thin wrapper) landed. Shape and contract in §0.

### §4c Per-file callsite migration

**COMPLETE (this session):**
analog-fuse.test.ts (exemplar), adc.test.ts, timer-555.test.ts, led.test.ts, crystal.test.ts, polarized-cap.test.ts, resistor.test.ts, jfet.test.ts, variable-rail.test.ts, switches.test.ts, transmission-line.test.ts, tx_trace.test.ts (deleted), inductor.test.ts (gap-fill), capacitor.test.ts (gap-fill), ccvs.test.ts (gap-fill), cccs.test.ts (gap-fill), coordinator-bridge.test.ts (gap-fill, re-migrated), coordinator.test.ts (gap-fill).

**REMAINING:**
- [ ] `dac.test.ts` (2)
- [ ] `opamp.test.ts` (5)
- [ ] `ota.test.ts` (8)
- [ ] `real-opamp.test.ts` (3)
- [ ] `real-opamp-raillim.test.ts` (1)
- [ ] `memristor.test.ts` (4)
- [ ] `tapped-transformer.test.ts` (2)
- [ ] `transformer.test.ts` (5)
- [ ] `diac.test.ts` (3)
- [ ] `diode.test.ts` (9) **NB**: J-072 already landed full rewrite — this row may be moot.
- [ ] `mosfet.test.ts` (11)
- [ ] `triode.test.ts` (5)
- [ ] `ldr.test.ts` (6)
- [ ] `ntc-thermistor.test.ts` (3)
- [ ] `spark-gap.test.ts` (3)
- [ ] `buckbjt-convergence.test.ts` (2)
- [ ] `ckt-context.test.ts` (2)
- [ ] `ckt-load.test.ts` (21)
- [ ] `controlled-source-base.test.ts` (5)
- [ ] `dc-operating-point.test.ts` (6)
- [ ] `dcop-init-jct.test.ts` (8)
- [ ] `harness/boot-step.test.ts` (2)
- [ ] `harness/harness-integration.test.ts` (3)
- [ ] `harness/test-npn-harness.test.ts` (1)
- [ ] `newton-raphson.test.ts` (5)
- [ ] `ngspice-bridge-smoke.test.ts` (1)
- [ ] `ngspice-parity/bjt-common-emitter.test.ts` (1)
- [ ] `ngspice-parity/diode-resistor.test.ts` (1)
- [ ] `ngspice-parity/load-order-parity.test.ts` (2)
- [ ] `ngspice-parity/mosfet-inverter.test.ts` (1)
- [ ] `ngspice-parity/resistive-divider.test.ts` (1)
- [ ] `phase-3-nr-reorder.test.ts` (2)
- [ ] `rc-ac-transient.test.ts` (3)

**Acceptance per file**: zero references to deleted helpers; assertions hold; zero `as unknown as` on coordinator/engine internals.

### §4d Schema-init mechanism removal — COMPLETE (2026-05-03)
- `state-schema.ts` `init` field/`SlotInit`/`applyInitialValues` deleted.
- `analog-fuse.ts` migrated to `_intact`/`_diagEmitted` instance fields; boot-blown latent bug fixed.
- 16 other pool-backed elements audited and migrated (mosfet MODE, diode/zener GEQ, bjt VBE/GX, analog-switch NC_CURRENT_STATE, adc-driver PREV_CLK NaN/SAR_BIT_INDEX, 9 behavioral driver leaves) — see §0 for the four-part seeding contract.
- Diagnostic-emission setter pattern landed (`RuntimeDiagnosticAware` interface).

### §4e Engine quirks — open critical bugs

- [x] **LED color-preset `EG`** — landed 2026-05-03 (red/green/yellow/blue/white assigned proper LED bandgaps in eV; restores negative TC).

- [ ] **PolarizedCap MODEUIC NaN false-convergence**. Reproduction: `Vsrc=5V → R=1kΩ → PolarizedCap(C=1µF, ESR=1mΩ, R_leak≈25MΩ, IC=0) → GND` with `params.uic: true`. After ~106 transient steps, `getRuntimeDiagnostics()` is empty, every step logged `converged: true, iterations: 2`, but `cap:pos` and `R1:neg` are NaN. Suspected: cap's `cond1` path in `polarized-cap.ts:475-485` overrides `vNow` with `_IC` for companion stamps but `MNAEngine` never seeds `CKTrhsOld[cap_internal]` from `_IC` at the DCOP→transient handover (ngspice `dctran.c:117-189` UIC fast path). Cap's `load()` reads stale rhsOld → NaN matrix entries; NR `noncon` accumulator treats NaN-vs-NaN as ≤ tol. **Course of action**: (a) wire MODEUIC IC seeding through `MNAEngine._setup()` / `_transientDcop()` so per-element ICs land in `_ctx.rhsOld` before first transient stamp; (b) tighten NR convergence to reject NaN deltas (`Number.isFinite` guard on `noncon` and per-iteration solution).

- [x] **`compiler.ts:392` sibling-branch labelRef snapshot** — landed 2026-05-05 via §4g Wave 10. The eager `subProps.set(paramKey, \`${labelRef.value}:${ref.subElementName}\`)` site is gone; replaced with `labelPatchWork.push({ target, paramKey, template })` and drained inside `PatcherLeaf.setup()` after `setLabel` runs. Per-leaf label-prop reads moved from ctor → `setup()` body in `relay-coupling.ts` / `internal-cccs.ts` / `transformer-coupling.ts`. Verified by 3 new behavioural transient cases in `tapped-transformer.test.ts` (10/10 pass) which previously threw `findBranch(":L2") returned 0` at setup. The Wave 10 commit also surfaced two pre-existing latent bugs that Wave 10's correct label resolution exposed for the first time — see Bug 4 and Bug 5 below.

- [ ] **`capture.ts::buildTopology` matrix-row-label heuristic hallucinates internal-node IDs**. `src/solver/analog/__tests__/harness/capture.ts:122` computes internal-node IDs as `nodeId = pinCount + p` (positional) — does not match IDs from `ctx.makeVolt(...)`. Internal-node labels (`jfet:DP`, `jfet:SP`) get merged onto wrong matrix rows. Discovered while migrating PJFET `emits_stamps_when_conducting`. **Course of action**: rewrite `buildTopology` to use actual `ctx.makeVolt` returns (capture at setup time and thread through), OR remove internal-node label slots from `MatrixRowLabel` entirely. Reviewer must reject any future test relying on `(session as any)._ourTopology.matrixRowLabels` substring matches.

- [ ] **§4e Bug 4 — Optocoupler `InternalCccs` sense-branch invisibility**. `src/components/active/__tests__/optocoupler-cccs.test.ts:69` fails at sub-element setup: `InternalCccs: ctx.findBranch("tx:vSense") returned 0; sibling "vSense" did not allocate a branch`. The label resolves correctly post-Wave-10 (`tx:vSense`, not `:vSense` — Bug 2 verified fixed); the bug is downstream. `InternalZeroVoltSense` declares `branchCount: 1` in `OPTOCOUPLER_NETLIST` (`optocoupler.ts:53`) but its branch is not visible to `InternalCccs.findBranch` at sibling-setup time. Possible causes: (a) `InternalZeroVoltSense.setup()` does not call `ctx.makeCur(...)` / write `branchIndex`; (b) `findBranchFor` is not implemented on `InternalZeroVoltSense` and the engine has no lazy-allocation fallback; (c) sub-element load order interleaves under the global ngspice ordinal so the cccs leaf's setup runs before the sense leaf's, with no lazy resolution. **Course of action**: audit `InternalZeroVoltSense.ts` against `vsrcsetup.c` (the digiTS analogue is just a 0V VSRC); confirm whether `findBranchFor` is mandatory for siblingBranch resolution; verify that the netlist's element iteration order maps to setup order through the global `ngspiceLoadOrder` sort.

- [ ] **§4e Bug 5 — Compiler siblingState slot lookup returns -1 for Switch `CLOSED`**. `src/components/switching/__tests__/relay-actuation.test.ts:90` fails at compile time (before any setup runs): `siblingState: unknown slot "CLOSED" on "contactSW"` thrown from `compiler.ts:492`. The Switch component declares `SWITCH_SCHEMA = defineStateSchema("Switch", [{ name: "CLOSED", doc: "..." }])` (`switch.ts:40-42`) and `SwitchAnalogElement extends AbstractPoolBackedAnalogElement` with `readonly stateSchema = SWITCH_SCHEMA` (`switch.ts:322`). The compiler's lookup `siblingSchema?.indexOf.get(ref.slotName) ?? -1` returns -1, meaning either `siblingEl` is not recognised as pool-backed by `isPoolBacked(...)` at `constructedByName.get("contactSW")` time, or the `defineStateSchema` `indexOf` Map is keyed differently than the `name` string passed in. **Course of action**: (a) breakpoint at `compiler.ts:485-490` and inspect `siblingEl` and `siblingSchema?.indexOf`; (b) read `defineStateSchema` and confirm `indexOf` is keyed by slot name string (not normalised, not slot index); (c) verify Switch's `kind: "default"` model factory returns a `SwitchAnalogElement` instance (not a wrapper that fails the pool-backed type guard).

### §4f AnalogElement → Abstract base migration — Waves 1–9 COMPLETE

Surfaced 2026-05-04 by transmission-line.test.ts 6-hour-hang investigation. See §0 for architectural overview.

**LANDED Waves 1–9** (~60 files): transmission-segment trio + 4 standalone passives + 16 gate/mux/decoder drivers + 10 flipflop/counter/register/latch drivers + 6 analog drivers (comparator/dac/adc/schmitt/timer/opamp) + 7 switch/relay/bridge + 8 internal/transformer/passives + ~30 test-mock migrations (Waves 8a-e) + 2 standalone passives Wave 9a (resistor/polarized-cap) + 3 sensors Wave 9b + 2 bridge drivers Wave 9d + 3 IO/special Wave 9e (probe/controlled-source-base/subcircuit-wrapper) + 6 test follow-ons Wave 9f. Wave 0a sweep landed (9 redundant `implements` clauses stripped).

**REMAINING in §4f scope:**
- [ ] `bjt.test.ts` (Wave 8d) — 3 retained `as AnalogElement & { label?: string; elementIndex?: number }` casts blocked on §4g Wave 11b migrating `bjt.ts:580/584/1202/1206` factories.

### §4g Single-class collapse + `#pinNodes` privacy + completeness sweep

Surfaced 2026-05-04. See §0 for Phase A/B/C target and bus-pin caveat.

#### Wave 0a (rebaseline) — COMPLETE
Stripped 9 redundant `implements (Pool)?AnalogElement` clauses on already-migrated classes.

#### Wave 0 (prereqs) — COMPLETE
§4f Waves 1–7, Wave 0a, Wave 8 (test mocks).

#### Wave 9 (§4f completeness sweep, 10 standalone production files) — COMPLETE
9a, 9b, 9d, 9e, 9f all landed. nfet/pfet/mutual-inductor moved to Wave 11a (parents converted to `kind: "netlist"`).

**Acceptance gate met**: zero `class … implements (Pool)?AnalogElement` outside `element.ts`, Wave 11a scope (nfet/pfet/mutual-inductor), and harness/test-fixture files Wave 8 covers.

#### Wave 10 — Compiler internal literals → real classes + §4e Bug 2 labelPatchWork channel — COMPLETE (2026-05-05)

- [x] `src/solver/analog/compiler.ts` — `makeInternalNetAllocator` literal → `class InternalNetAllocator extends AbstractAnalogElement`. Ctor `(labelRef, suffix, slot)`.
- [x] `src/solver/analog/compiler.ts` — Patcher leaf literal → `class PatcherLeaf extends AbstractAnalogElement`. Ctor `(patchWork, labelPatchWork, labelRef)`; `setup()` drains both collections.
- [x] **§4e Bug 2 — `labelPatchWork` channel**. compiler.ts site (was :390-393) replaced with `labelPatchWork.push({ target, paramKey, template })`; `PatcherLeaf.setup()` drains after `setLabel` runs. Per-leaf label-prop reads (`coilBranch`/`sense`/`L1_branch`/`L2_branch`) and the empty-string-throw moved from ctor body → `setup()` body in `relay-coupling.ts`, `internal-cccs.ts`, `transformer-coupling.ts`. Patcher install gate widened to `patchWork.length > 0 || labelPatchWork.length > 0`.
- [x] **Tests**: `tapped-transformer.test.ts` un-skipped + 3 behavioural transient cases (centre-tap voltage halving, symmetric secondary halves, secondary swings under transient drive) — 10/10 pass. Optocoupler and Relay regression tests added; both fail on separate pre-existing latent bugs that this Wave's setup-time label resolution exposes for the first time — see §4e Bug 4 and Bug 5.
- [x] Sweep `Grep :\s*AnalogElement\s*=\s*\{` across `src/solver/analog/*.ts` → 0 hits.

**Acceptance**:
- ✓ `Grep :\s*AnalogElement\s*=\s*\{` in `src/solver/analog/` → 0. (Wave 11b owns the 4 remaining hits at `src/components/sources/dc-voltage-source.ts:176`, `current-source.ts:177`, `active/opamp.ts:203`, `io/ground.ts:112`.)
- ✓ `Grep \$\{labelRef\.value\}` in `compiler.ts` → 0 outside `labelPatchWork.push(...)` triples / `InternalNetAllocator.setup()`.
- ✓ `tapped-transformer.test.ts` 10/10 (7 smoke + 3 new behavioural). `transmission-line.test.ts` 14/14 (patcher canary preserved across the inline-literal → class conversion).
- ✗ `optocoupler-cccs.test.ts` 0/1 — fails at setup with `findBranch("tx:vSense") returned 0` (label resolved correctly; downstream §4e Bug 4).
- ✗ `relay-actuation.test.ts` 0/1 — fails at compile with `siblingState: unknown slot "CLOSED" on "contactSW"` (compile-time, before any setup; §4e Bug 5).

#### Wave 11 — Inline-form parent composites + factory-literal leaves (umbrella zero-smell gate)

Closes the rest of `_pinNodes = new Map(...)` / `_pinNodes: new Map(...)` in production. Two halves; lands together so the acceptance grep reaches zero in one pass.

##### Wave 11a — Parent composites: `kind: "inline"` → `kind: "netlist"` (5 files, exemplar: `transmission-line.ts`)

Universal recipe: parent's job becomes `buildXNetlist(props): CircuitSpec`. Each former child sub-element emitted as a top-level analog element with own connectivity row. Children's `pinNodes` Maps constructed by the composite compiler with patch-aware refs (existing `transmission-segment-l.ts` path). No special handling for shared-state coupling — each former child has own state schema; cross-coupling becomes a normal sibling-state read.

- [ ] `src/components/switching/trans-gate.ts` — composite of two `NFETSWSubElement` children sharing D/S nodes. Two top-level SW elements `(D=out1, S=out2)` + inverted control voltage handling for PFET sub-element. Preserve PB-TRANSGATE TSTALLOC ordering: NFET emitted first.
- [ ] `src/components/switching/nfet.ts` — composite of one `NFETSWSubElement` (analog) + one behavioral driver leaf (digital body model). Driver's `OUTPUT_LOGIC_LEVEL` slot consumed by SW via siblingState. **Coordinate with §2e J-092** (FGNFET netlist conversion).
- [ ] `src/components/switching/pfet.ts` — same shape as nfet, mirror polarities. **Coordinate with §2e J-094**.
- [ ] `src/components/semiconductors/triode.ts` — composite of one `VCCS` child. Emit VCCS as top-level sub-element with triode gain → VCCS gain. Pin-label translation P/G/K → ctrl±/out± becomes connectivity row.
- [ ] `src/components/passives/transformer.ts` + `src/components/passives/mutual-inductor.ts` — paired migration. Emit `InductorSubElement(L1)` + `InductorSubElement(L2)` + `MutualInductorElement(K)` as three top-level sub-elements. **Exemplar already exists**: `tapped-transformer.ts` (also §2e J-062) is `kind: "netlist"` — copy structure. **Order Wave 10 BEFORE this row** (K-coupling needs `labelPatchWork` for sibling-branch label resolution).

##### Wave 11b — Object-literal factory leaves: literal → class (16 file-sites)

Universal recipe: replace `return { _pinNodes: new Map(pinNodes), label: "", _stateBase: -1, branchIndex: -1, ngspiceLoadOrder: …, setup, load, getPinCurrents, setParam }` with local class extending `AbstractAnalogElement` (or `AbstractPoolBackedAnalogElement` if pool-backed); `return new XElement(pinNodes, props)`.

**Pattern A (pool-backed) — 7 file-sites:**
- [ ] `bjt.ts:580` (L0) + `:584` (`_pinNodes`). **Unblocks bjt.test.ts cast cleanup (§3e J-071 / §4f Wave 8d).**
- [ ] `bjt.ts:1202` (L1) + `:1206`. Same as above.
- [ ] `diode.ts:480` + `:484`. Confirm DIODE+CAP GEQ slot schema per §4d audit.
- [ ] `zener.ts:244` + `:248`. Confirm GEQ slot schema.
- [ ] `mosfet.ts:859`. MOSFET MODE slot. **Spec drift correction**: original spec said `:277, :384` but those are in `analog-switch.ts`; current grep finds ONE literal at `:859`. Re-audit on migration.
- [ ] `njfet.ts:330`. Standard ctor.
- [ ] `pjfet.ts:304`. Standard ctor.

**Pattern B (plain `AnalogElement`) — 9 file-sites:**
- [ ] `opamp.ts:203` + `:208`.
- [ ] `ota.ts:186`.
- [ ] `analog-switch.ts:277` (SPST) + `:384` (SPDT). **Spec drift**: original spec said `:859`; correct lines are `:277,:384`. Migrate as TWO classes.
- [ ] `dc-voltage-source.ts:176` + `:180`. Confirm whether lazy `findBranchFor` accessor (vsrcfbr.c:26-39 port) lives on class or sibling — keep verbatim first pass.
- [ ] `current-source.ts:177` + `:182`.
- [ ] `ac-voltage-source.ts:610`. Note explicit `<string, number>` generic — preserve in class ctor.
- [ ] `variable-rail.ts:177`. Confirm hot-loadable `voltage` setParam routes through `coordinator.setComponentProperty` post-migration.
- [ ] `ground.ts:112` + `:115`. Single-pin element.
- [ ] `clock.ts:271`. **Non-standard ctor**: literal builds pin-node Map inline from positional `nodePos`. Class ctor accepts `nodePos: number` and constructs Map internally (preferred — preserves call-site signature).

##### Wave 11 dependencies
- Wave 9 must land first (zero `implements (Pool)?AnalogElement` outside `element.ts`).
- Wave 10 must land before 11a's `transformer.ts` row.
- Wave 11b independent of 11a; can land in parallel.

**Acceptance for Wave 11 (umbrella zero-smell gate):**
- `Grep _pinNodes\s*=\s*new Map\(` outside `element.ts` → 0.
- `Grep _pinNodes:\s*new Map\(` outside `element.ts` → 0.
- `Grep kind:\s*"inline"` across `src/components/{switching,semiconductors,passives}/` returns hits ONLY in files outside 11a list.
- All 11a parents have `buildXNetlist` function and `kind: "netlist"` model entry.
- All targeted vitest passes for migrated parents (trans-gate, nfet, pfet, triode, transformer) green.
- Headless transmission-line, op-amp inverter, and CMOS-inverter regression circuits compile/run without NaN/hang.

#### Phase A — Add public getter, migrate all read sites — LANDED 2026-05-05 (commit b109bec9)

- [x] **A.1** — `AbstractAnalogElement` adds `get pinNodes(): Map<string, number> { return this._pinNodes; }` (live Map, not Readonly yet). Interface narrowed to `readonly pinNodes: Map<string, number>` (was `_pinNodes`).
- [x] **A.2** — All external `_pinNodes` reads renamed to `pinNodes` across ~60 files (production drivers + tests + harness mocks + utility classes). Object-literal property keys, `this._pinNodes` reads in subclasses, `el._pinNodes` external accesses, JSDoc references — all renamed.
- [x] **A.3** — `element.ts` retains the field declaration + sole ctor write `this._pinNodes = pinNodes as Map<string, number>`. Internal element.ts references stay as `_pinNodes`.
- [x] **A.4** — `tsc --noEmit` → 223 errors, **identical** to pre-Phase-A baseline (commit `cc566302` cleaned up a dangling `MNAEngine` import in `sparse-solver.test.ts` left by the `(session as any)._engine` migration; without it the count was 224). Diff against baseline is line-number shifts only — same pre-existing errors at different positions due to stub-test deletion + harness-integration.test.ts edits.

**Acceptance met**: `Grep \b_pinNodes\b src/` → 10 hits, all in `src/solver/analog/element.ts`.

**Fold-ins in same commit (orchestrator-approved; surfaced by hook block during commit gate):**
- **B6 pin-key sweep** (closes the §3 / §4c partial work for these test files): `:A`/`:B` → `:pos`/`:neg` for resistor/inductor/crystal/memristor wiring. ~70 sites across `mosfet.test.ts`, `trans-gate.test.ts`, `behavioral-combinational.test.ts`, `behavioral-gate.test.ts`, `sparse-solver.test.ts`, `harness-integration.test.ts`, `harness/node-mapping.ts` (doc-example).
- **B1 sparse-solver `debugView` getter**: `SparseSolver` adds public `get debugView(): { readonly rowHead/colHead/elNextInRow/elNextInCol/elRow/elCol/elVal/elCount/elCapacity/intToExtCol/perm/permInv }`. 28 sites in `sparse-solver.test.ts` migrate from `(solver as any)._field` → `solver.debugView.field`. `(session as any)._engine` site at :635 also handled. **Production rule**: `debugView` is whitebox-only; do NOT widen access or use from production code paths.
- **B1 mosfet stub-test deletion**: deleted `describe("PMOS temperature scaling", ...)` block (two `it` cases asserting only `toBeDefined()` on `(nmos as any)._p._tVto`). Temperature-correction parity is the ngspice-parity harness's job; whitebox model-state probing is a smell.
- **B3 lint rule refinement**: `scripts/lint-bans.mjs` B3 exclude regex extended to include `src/solver/analog/timestep.ts` and `src/solver/analog/__tests__/timestep.test.ts` so legitimate `TimestepController.accept(...)` calls (different API from the deleted `AnalogElement.accept`) stop tripping the rule.
- **B4 narrative-comment delete** at `mosfet.test.ts` (above the `S_VBD = MOSFET_SCHEMA.indexOf.get("VBD")!` block). The lint regex matches `_SCHEMA.indexOf(` (function call); the actual code is `.indexOf.get(...)` (Map property + Map lookup) which is the canonical schema-as-Map pattern and was not violating. Only the comment text contained the literal substring.
- **3 unused-parameter renames** in test stubs: `factory: (_pinNodes: ReadonlyMap<...>, ...) => ...` → `(_pn: ReadonlyMap<...>, ...) => ...` in `compile.test.ts:277`, `coordinator.test.ts:233`, `compile-analog-partition.test.ts:573`. The leading-underscore parameter convention is for "intentionally unused"; renaming the token avoids the acceptance grep tripping on parameter names.

**Pre-existing Wave 11 work landed in commit c28b6367 (preceding Phase A)**: 6 inline→netlist parents (`transformer`/`mutual-inductor`/`triode`/`nfet`/`pfet`/`trans-gate`) + 16 literal→class leaves + 3 new `internalOnly` typeIds (`FetSW`, `BehavioralFETDriver`, `TriodeAnalog`). New file: `triode-analog-element.ts`, `behavioral-fet-driver.ts`, `fet-sw.ts`. Latent bug folded in: `TriodeAnalog._vgk/_op` moved to pool slots — fixed NR-retry rollback gap.

#### Phase B — `#pinNodes` true privacy — REMAINING

- [ ] **B.1** — In `AbstractAnalogElement`, change to:
  ```ts
  readonly #pinNodes: Map<string, number>;
  constructor(pinNodes: ReadonlyMap<string, number>) {
    this.#pinNodes = pinNodes as Map<string, number>;
  }
  get pinNodes(): ReadonlyMap<string, number> { return this.#pinNodes; }
  ```
- [ ] **B.2** — `tsc --noEmit`. Errors surface at: (a) `el.pinNodes.set/delete(...)` callers — these are the smell; audit each (patcher should write through closure-captured `patchWork[i].map`, not via getter); (b) subclass `_pinNodes` redeclarations.
- [ ] **B.3** — All errors resolved; full test suite green. Transmission-line tests are the verifier for the patcher's "writes through captured reference" property.

**Acceptance**: `Grep \b_pinNodes\b` → hits only in JSDoc; `Grep \.pinNodes\.set\(` and `\.pinNodes\.delete\(` → 0.

#### Phase C — Collapse interfaces into single abstract classes — REMAINING

- [ ] **C.1** — Delete `export interface AnalogElement { ... }` (element.ts:37–255).
- [ ] **C.2** — Rename `export abstract class AbstractAnalogElement` → `export abstract class AnalogElement`. Drop `implements AnalogElement`.
- [ ] **C.3** — Add nominal brand:
  ```ts
  export abstract class AnalogElement {
    private readonly __analogElementBrand!: never;
    // ... existing fields, constructor, abstract methods
  }
  ```
- [ ] **C.4** — Same for pool-backed pair: delete interface, rename abstract → `PoolBackedAnalogElement`, drop `implements`. Brand inherits.
- [ ] **C.5** — Update `implements AnalogElement` → `extends AnalogElement` (mechanical sed); same for pool-backed. Post-Wave-9 should be no-op.
- [ ] **C.6** — Update `isPoolBacked` type guard signature if needed.
- [ ] **C.7** — `tsc --noEmit` clean; full test suite green.

**Acceptance**:
- `Grep ^export\s+interface\s+(AnalogElement|PoolBackedAnalogElement)` → 0.
- `Grep \bAbstractAnalogElement\b` and `\bAbstractPoolBackedAnalogElement\b` → 0.
- `Grep implements\s+(AnalogElement|PoolBackedAnalogElement)\b` → 0.
- `Grep :\s*AnalogElement\s*=\s*\{` → 0.

#### §4g cross-cutting design notes

- **Why `#pinNodes`, not `private _pinNodes`**: TS `private` is erased at runtime; subclasses, harness code, `as any` casts can still reach the field. ES `#name` is genuinely inaccessible. Contract is "the only writer is the patcher's closure-captured Map ref" — any runtime escape hatch reopens the bug class.
- **Why `ReadonlyMap` getter, mutable Map internally**: Map MUST remain mutable for patcher back-fill. Patcher captures Map ref at compile time (`patchWork`) and writes through closure capture. Getter exposes `ReadonlyMap` so only the engine compiler is the writer.
- **Risk: subclasses that override `pinNodes` getter**. Document the contract; consider ESLint rule forbidding `get pinNodes()` outside `element.ts`. Lower priority — no current subclass overrides.
- **§4e bug interactions**: Bug 1 (PolarizedCap MODEUIC NaN) — separate from §4g; depends on `IcLoadable` typed interface spec. Bug 2 (compiler.ts:392 labelRef snapshot) — bundled in Wave 10. Bug 3 (capture.ts buildTopology) — independent; `onNodeAllocated` channel on `SetupContext` is a separate spec.

#### §4g migration order summary

```
Wave 0a (rebaseline) → LANDED 2026-05-04
Wave 0 (prereqs)     → LANDED (Wave 0a + Wave 8 test mocks)
Wave 8 (test mocks)  → LANDED (bjt.test.ts 3 casts cleared by Wave 11b)
Wave 9 (completeness)→ LANDED (10 production files)
Wave 10 (compiler internals + §4e Bug 2)        → LANDED 2026-05-05 (3a7eba2b)
Wave 11a (parents → netlist) + 11b (literals)   → LANDED 2026-05-05 (c28b6367)
Phase A (read-site sweep + lint-bans hygiene)   → LANDED 2026-05-05 (b109bec9 + cc566302 fix)
Phase B (#pinNodes)                             → REMAINING (next)
Phase C (interface delete)                      → REMAINING (depends on B)
```

**Phases B and C are eligible to run in parallel** per orchestrator decision 2026-05-05: the `_pinNodes` field is now uniquely owned by `element.ts` (Phase A's acceptance gate), and Phase C's interface→class collapse is mechanical given the `extends AbstractAnalogElement` invariant established by Wave 11. Caveats for parallel execution:
- Both phases edit `element.ts`. Sequence the file edits or land in two commits with a known ordering.
- Phase B edits subclass `_pinNodes` redeclarations (none expected post-Wave 11) and any `pinNodes.set/.delete()` callers (only the patcher's InternalNetAllocator at `compiler.ts:235` per current grep). Phase C edits `implements (Pool)?AnalogElement` clauses → `extends`. The two edit-sets do not overlap outside `element.ts` itself.

Each phase lands as own commit with acceptance grep as gate.

---

## Stats

- Total files: 183 (185 J-IDs in source contracts; J-001 and J-005 struck)
- Engine: 21 — COMPLETE
- Components: 89 — §2a/§2b/§2c/§2d/§2f COMPLETE; §2e (14 items) and §2g (5 items) REMAINING
- Tests: 73 — §3 mostly REMAINING; partial completions in §3c (J-129) and §3e (J-072)
- Unclassified: 0
