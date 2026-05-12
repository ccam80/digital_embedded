# Manual Fix List

> Generated 2026-05-01, compacted 2026-05-04, recompacted 2026-05-05 (§4g landed; §4f→§4g sections collapsed; §4c landed except 2 Wave-11a-blocked escalations; §2e verified complete with §4d follow-up fold-ins). Source: `spec/merged-implementer-contracts.md` cross-referenced against the four phase docs.
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
- `SubcircuitElementParam` is a **CLOSED** 3-arm union (`number | string | siblingBranch`). Booleans must encode as 0/1 numbers.
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
- **Tri-state** (J-145/J-146): Cross-leaf logic-level coupling: producer driver leaf stamps a Norton at an internal control net; consumer reads the control-net voltage at its input pin. See `spec/sibling-state-excision.md` §3. High-Z = 1 GΩ shunt + zero current injection.
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

### Class-based element model (§4f + §4g, COMPLETE 2026-05-05)
- `AnalogElement` and `PoolBackedAnalogElement` (`element.ts`) are nominal-branded abstract classes — no interface; `protected readonly __analogElementBrand!: never` blocks structural duck-typing. Only path to either is `new SomeSubclass(...) extends ...`.
- Pin-node storage is ES private `readonly #pinNodes: Map<string, number>` on `AnalogElement`; `get pinNodes(): ReadonlyMap<string, number>` exposed to subclasses/external code. Constructor stores by reference (no defensive copy — load-bearing for the patcher's closure-captured map writes; documented in `element.ts` JSDoc).
- Subclass contract: `extends AnalogElement` (or `PoolBackedAnalogElement`), declare `readonly ngspiceLoadOrder`, implement `setup`/`load`/`getPinCurrents`/`setParam`. Pool-backed also declares `readonly stateSchema` / `readonly stateSize`; `initState(pool)` lives on the base.
- The patcher is the sole writer to a live `pinNodes` map; it captures the `Map` ref at compile time in `patchWork`/`labelPatchWork` and writes through the closure, not via `el.pinNodes` (which is `ReadonlyMap`).

### Bus-pin caveat
- `counter-preset`/`register`/`jk`/`jk-async`/`d-async` drivers use `(vIn >>> i) & 1` integer-extraction that assumes a multi-bit `bridge-input-driver` (J-135). Until J-135 lands, multi-bit composites won't decode correctly — bridges are correctly 1-bit only because multi-bit signals never cross a bridge today.

### Other latent / known
- `MEMRISTOR_SCHEMA.indexOf("W")` is wrong — schema is a `ReadonlyMap`; use `.get("W")`. Affects pending J-050 NEW FILE.
- `metadata: {}` on `CircuitSpec` literal — field doesn't exist post-narrowing. Fix-on-contact across `memristor-rollback.test.ts`, `behavioral-integration.test.ts`, `behavioral-sequential.test.ts`, `analog-engine.test.ts`, `comparator-rollback.test.ts`, `ntc-thermistor-rollback.test.ts`.
- `bjt.test.ts:409,460,2750` retain vestigial `as AnalogElement & { label?: string; elementIndex?: number }` casts. `label` and `elementIndex` are public fields on the base class post-§4g Phase C — casts now redundant, drop on contact.
- `setup-stamp-order.test.ts` was DELETED 2026-05-04 (J-129); 55 engine-impersonator stamp-order tests covered by `ngspice-parity/load-order-parity.test.ts`. Same-pattern block in `analog-switch.test.ts:203-285` deleted in same commit.

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

### §2e Composite class deletions / netlist conversions — COMPLETE 2026-05-05

Verified-complete-from-prior-sessions (no diff this session):
- J-081 (`scr.ts`), J-079 (`diac.ts`), J-080 (`diode.ts` — `dioload.c:139-205` MODEINIT* gate already in place at lines 596-611), J-029 (`schmitt-trigger.ts`), J-064 (`transmission-line.ts` — 5 segments are now own-file `internalOnly` typeIds: `transmission-segment-{r,l,g,c,rl}.ts` registered in `register-all.ts`), J-062 (`tapped-transformer.ts` — Inductor×3 + TransformerCoupling×3 expansion), J-057 (`capacitor.ts` — docstring), J-097 (`relay.ts`), J-096 (`relay-dt.ts`), J-092 (`fgnfet.ts`), J-094 (`fgpfet.ts`).

Latent-fold-ins this session:
- J-019 (`adc.ts`): stripped 2 dead `as SubcircuitElement & { subElementName: string }` intersection casts (§0 declared field directly on interface).
- J-023 (`dac.ts`): stripped 2 dead intersection casts; fixed `params.getModelParam<boolean>("bipolar")` → `params.getOrDefault<number>("bipolar", 0)` (closed `SubcircuitElementParam` 3-arm union forbids booleans; structural props use `getOrDefault`).
- J-098 (`switch.ts`): substantive §4d-compliance landing — see §4e Bug 5 entry below.

Folded-in (in-blast-radius, not on §2e list):
- `src/components/switching/switch-dt.ts` — `SwitchDTAnalogElement` extended plain `AnalogElement` and hand-rolled two `SwitchAnalogElement` children whose `initState` was never called by the engine; load() crashed reading `_pool.states` once switch.ts (J-098) moved its pool seeding out of `setup()`. Converted to `extends PoolBackedAnalogElement` with empty schema; `override initState` forwards pool ref to children. Mirrors `polarized-cap.ts:372-380` / `bridge-output-driver.ts:136`. Restored `switches.test.ts` 89/89 pass.

### §2f Gate user-facing components — COMPLETE
J-037, J-042, J-039, J-040, J-044, J-043, J-041, J-038.

### §2g Behavioural-element file deletions — COMPLETE 2026-05-05

**COMPLETE (this session)**: J-170 (`behavioral-gate.ts` deleted; orphan `AnalogElementFactory` had zero importers), J-133 (`behavioral-combinational.ts` verified — composites and `accept(){}` stubs were already deleted in a prior session; nothing left to do), J-173 (`behavioral-sequential.ts` — 20 dead `as SubcircuitElement & { subElementName: string }` casts stripped per §0 fix-on-contact), J-172 (`behavioral-remaining.ts` — 16 dead casts stripped), J-174 (`bridge-adapter.ts` type aliases `BridgeOutputAdapter`/`BridgeInputAdapter` deleted; production callers `compiler.ts` / `coordinator.ts` / `compiled-analog-circuit.ts` and bridge driver leaves updated to use `BridgeOutputDriverElement` / `BridgeInputDriverElement` directly; 5 test files import-renamed; `digital-pin-loading.test.ts:368,472,473` constructor-as-value sites resolved per spec NB).

**§2g extension fold-in (sanctioned-surface architectural cleanup):**
- `bridgeAdaptersByGroupId` lifted from `ConcreteCompiledAnalogCircuit` (concrete class) to `CompiledAnalogCircuit` (interface) at `src/core/analog-engine-interface.ts:303-313` with `ReadonlyMap<number, ReadonlyArray<…>>` typing. Eliminates the `as ConcreteCompiledAnalogCircuit` downcasts that were the canonical idiom in test files for accessing bridge adapters.
- Casts removed: `coordinator-bridge.test.ts` (4 sites), `coordinator-bridge-hotload.test.ts` (1 site), `digital-pin-loading.test.ts` (5 sites incl. `countBridgeAdapters` helper signature). Replacement is single-`!` non-null assertion on `compiled.analog!` (was implicit in the previous downcast — strictly less type-erasing than the cast it replaced).
- `analog-engine-interface.test.ts` literal at line 88 extended with `bridgeAdaptersByGroupId: new Map()` to keep the structural-subtyping test typecheck-clean.
- Other production casts (`coordinator.ts`, `analog-engine.ts`) and other test casts (`digital-pin-loading-mcp.test.ts`, harness files, fixture files, `dac.test.ts`, `mna-end-to-end.test.ts`, `analog-engine.test.ts`, `wire-current-resolver.test.ts`, `monte-carlo.test.ts`, `buckbjt-nr-probe.test.ts`, etc.) retain `as ConcreteCompiledAnalogCircuit` because they access OTHER concrete-only fields (`statePool`, `nodeCount`, etc., still on the concrete class only). Lifting those is out of §2g scope.

**Coordinator-bridge-hotload.test.ts §4c migration (touched-test-file fold-in):**
The file was full §3 POISON pre-this-session: `MockSolver`, hand-rolled `LoadContext` via `loadCtxFromFields`, direct `adapter.load(makeCtx(solver))`, and (worst) the `expect()` assertions had been stripped — leaving "calls without verification" smell. Rebuilt on `buildFixture` + `coordinator.step()` + `engine.getNodeVoltage()` against the same `In→Rload→Rpull→Ground` topology as `coordinator-bridge.test.ts`. Three vOH-hot-load test cases preserved by intent with proper divider-target math (`V(node_X) = vOH · Rpull / (rOut + Rload + Rpull)`). vOH/vOL hot-load coverage was unique to this file (`coordinator-bridge.test.ts` covers `rOut`/`rIn`/`setHighZ` but not vOH/vOL).

**COMPLETE (prior sessions)**: J-162, J-163, J-164, J-165, J-166, J-167, J-169, J-168 (flip-flop class deletions; `behavioral-flipflop/` directory removed; orphan `behavioral-flipflop-variants.ts` and `behavioral-flipflop/index.ts` also deleted).

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
- [ ] `transformer.test.ts` — Test 1.13 + Phase1 File 6 + UC-7 — UC-2 at 176; unskip `analogFactory creates element with correct branch indices`; line 663 retained (J-054). **NB Wave 11a**: line 22 imports `AnalogTransformerElement` which became an internalOnly sub-element; rebuild via netlist composite per Wave 11a recipe.
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
- [ ] `trans-gate.test.ts` — Test 1.23 — UC-1 + UC-3 with state inspection (J-090). **NB Wave 11a**: line 18 imports `TransGateAnalogElement` which became internalOnly; rebuild via netlist composite.
- [ ] `resolve-simulation-params.test.ts` — Test 1.25 — UC-1 M2 at 115, 130, 137 (J-099).
- [ ] `wire-current-resolver.test.ts` — Test 1.26 + ssB10 — UC-1 M2 at 7 sites; pin-key at 33, 111 (J-102).
- [ ] `src/components/sources/__tests__/dc-voltage-source.test.ts` — **NEW §3e item added 2026-05-05** — file imports deleted `test-helpers.js` and uses `solver as unknown as SparseSolver` engine-impersonator POISON pattern at 7 sites (lines 100, 129, 148, 162, 185, 217, 237, 255). Full §4c POISON migration to `buildFixture` / `ComparisonSession`. Cite deleted stamp-level tests to `ngspice-parity/dc-voltage-source.test.ts` (or equivalent ngspice-parity file) where coverage exists (J-NEW-dvs).
- [ ] `src/components/sources/__tests__/current-source.test.ts` — **NEW §3e item added 2026-05-05** — file imports deleted `test-helpers.js` and uses `solver as unknown as SparseSolver` engine-impersonator POISON pattern at 8 sites (lines 101, 121, 140, 153, 176, 202, 223, 237). Full §4c POISON migration to `buildFixture` / `ComparisonSession`. Cite deleted stamp-level tests to `ngspice-parity/dc-voltage-source.test.ts` (or equivalent ngspice-parity file) where coverage exists (J-NEW-csr).

### §3f E2E tests — REMAINING
- [ ] `e2e/gui/analog-bjt-convergence.spec.ts` — Test 1.1 — Insert `placeLabeled('Diode', 43, 12, 'TD', 90)` after line 153 (J-002).
- [ ] `e2e/gui/component-sweep.spec.ts` — Phase1 ssE — Wire VDD/GND/inputs in CMOS-mode sweep (lines 766-789) using property label `'voltage'` (J-003).

---

## §4. Test Infrastructure Deprecation

### §4a Helper deletions — COMPLETE (2026-05-03)
`src/solver/analog/__tests__/test-helpers.ts` DELETED. All 9 exports (state/init/NR + setup/load impersonators) removed.

### §4b `buildFixture` — COMPLETE (2026-05-03)
`src/solver/analog/__tests__/fixtures/build-fixture.ts` (NEW) and `harness/hwr-fixture.ts` (thin wrapper) landed. Shape and contract in §0.

### §4c Per-file callsite migration — COMPLETE 2026-05-05 (except 2 Wave-11a-blocked escalations)

**Acceptance per file (revised after round-1 inline-resurrection failure mode):**
zero engine-impersonator patterns (no `LoadContext`/`SetupContext`/fake matrix construction, no direct `element.setup()`/`element.load()` calls, no `new StatePool(...)` outside sanctioned helpers, no test subclasses exposing private engine state via getters); every fixture goes through `buildFixture` or `ComparisonSession`; zero `as unknown as` on coordinator/engine internals; zero references to deleted helpers under any name (the original "zero references to deleted helpers" gate was a textual loophole — three round-1 agents satisfied it by inlining the helpers' bodies verbatim under renamed wrappers like `buildTestCtx`. The revised gate forecloses that.)

**COMPLETE (prior sessions):**
analog-fuse.test.ts (exemplar), adc.test.ts, timer-555.test.ts, led.test.ts, crystal.test.ts, polarized-cap.test.ts, resistor.test.ts, jfet.test.ts, variable-rail.test.ts, switches.test.ts, transmission-line.test.ts, tx_trace.test.ts (deleted), inductor.test.ts (gap-fill), capacitor.test.ts (gap-fill), ccvs.test.ts (gap-fill), cccs.test.ts (gap-fill), coordinator-bridge.test.ts (gap-fill, re-migrated), coordinator.test.ts (gap-fill).

**COMPLETE (this session 2026-05-05):**

*Round 1 (spec-compliant — no rewrite or verified-clean):*
- `dac.test.ts` — 3 small TS fixes (props field, ComponentSpec narrowing, exactOptionalPropertyTypes); no rewrite.
- `opamp.test.ts` — TS6133 unused-var cleanup on 3 sites.
- `ota.test.ts` — full rewrite to `buildFixture`; parity test rewritten as observable-behaviour (DCOP fixed-point ⟹ stamps correct) since stamp-peeking required banned `_elVal` tunneling.
- `real-opamp.test.ts`, `real-opamp-raillim.test.ts` — verified already clean.
- `ldr.test.ts`, `ntc-thermistor.test.ts`, `spark-gap.test.ts`, `memristor.test.ts` — verified already clean (the §4c site counts referred to existing `buildFixture` constructions, not pending work).
- `tapped-transformer.test.ts`, `diode.test.ts` (J-072), `diac.test.ts`, `buckbjt-convergence.test.ts` — verified already clean.
- `harness/boot-step.test.ts`, `harness/test-npn-harness.test.ts`, `ngspice-bridge-smoke.test.ts`, `ngspice-parity/*` (5 files) — verified clean (use sanctioned `ComparisonSession` surface).
- `harness/harness-integration.test.ts` — migrated: deleted inline `HarnessResistorEl`/`HarnessDiodeEl`/`HarnessCapacitorEl` engine-impersonator classes + 13 unused imports; rewrote postIterationHook test via `buildFixture`.
- `rc-ac-transient.test.ts` — full rewrite to `buildFixture` + `coordinator.step()` loop (Test 1.42, J-128).

*Round 2 (redo — round-1 attempt reintroduced deleted-helper bodies inline; reverted and re-spawned with strengthened prompts banning the inline-resurrection failure mode by name):*
- `mosfet.test.ts` — 73 tests → ~28: 22 deleted-with-cite (M-1..M-12 stamp-level, companion-zero, srcFact, MOSFET-LTE, primeJunctions internal, SLOT_VON.init.kind §4d-orphan), 6+ rewritten via `buildFixture`/`coordinator.dcOperatingPoint()`/`engine.getNodeVoltage()`/`coordinator.setLimitingCapture()`; cite to `ngspice-parity/mosfet-inverter.test.ts`. `as unknown as` `Record<string,unknown>` casts on `primeJunctions` existence probes replaced with `'primeJunctions' in element` operator.
- `ckt-load.test.ts` — 15 → 3: 12 deleted-with-cite to `ngspice-parity/load-order-parity.test.ts`, 3 rewritten via `buildFixture` + `engine.getNodeVoltage()`.
- `dc-operating-point.test.ts` — 27 → 15: 12 deleted-with-cite (`ctx._onPhaseBegin`/`_onPhaseEnd`/`postIterationHook`/`Float64Array Proxy`/`vi.mock` engine-impersonators), 7 rewritten via `ComparisonSession.createSelfCompare` + `getStepShape().attempts.ours` + `coordinator.dcOperatingPoint()`. `gmin_stepping_fallback`/`source_stepping_fallback` retained using `params: { noOpIter: true }` — mirrors `cktop.c:47-48` to force the DC-OP fallback ladder; `ComparisonSession.createSelfCompare` extended with `params?: Partial<SimulationParams>` to support this (sanctioned-surface enhancement).
- `dcop-init-jct.test.ts` — 8 → 1: 7 deleted-with-cite to `ngspice-parity/{bjt-common-emitter,diode-resistor}.test.ts` (all `primeJunctions` direct-load-call tests; observable via DC-OP convergence from cold-start). 1 migrated. BJT factory rename (J-121): `createBjtElement → createBjtL0Element`, `createPnpBjtElement → createPnpBjtL0Element` — applied at all sites by deletion (no live import sites remain).
- `newton-raphson.test.ts` — 27 → 14: 13 deleted-with-cite (internal `ctx.rhs/rhsOld` buffer management, `enableBlameTracking`, `cktMode` mutation, Proxy SparseSolver injection — all required `CKTCircuitContext` construction). 8 migrations to `coordinator.dcOperatingPoint().iterations` and `coordinator.step()`. 6 retained pure-function tests (`pnjlim`/`fetlim` ngspice-parity, no ctx). `newton-raphson.ts:476-478` got a 2-line `niiter.c:888-891` citation comment (round-1 agent added it; user OK'd; content factually correct).
- `ckt-context.test.ts` — 9 → 1: 8 deleted-with-cite (covered by `mna-end-to-end`, `integration`, `convergence-regression`, `dc-operating-point` test files). 1 migrated as `allocates_all_buffers_after_setup` (renamed from `_at_init` per ssB14 + Phase1 File 7) via `buildFixture` + `engine.solver!.getCSCNonZeros().length > 0`. Line-261 `Float64Array Proxy install` cast eliminated by deleting `zero_allocations_on_reuse` (no public-surface equivalent for allocation count).
- `phase-3-nr-reorder.test.ts` — 7 → 3: 4 deleted-with-cite to `buckbjt-convergence.test.ts` (all required `makeSimpleCtx` + `vi.spyOn(ctx.solver)` engine-impersonation). 3 retained citation-hygiene tests using `fs.readFileSync` only (pure file-content assertion, not engine construction).
- `controlled-source-base.test.ts` — **DELETED entirely.** Round-1 agent migrated it to `class TestControlledSource extends ControlledSourceElement { get mutableCtx() { return this._ctx; } }` — engine-impersonator under a renamed surface. Coverage: concrete `vccs.test.ts`/`vcvs.test.ts`/`cccs.test.ts`/`ccvs.test.ts` exercise the abstract base via concrete subclasses through `buildFixture`.

**Sanctioned-surface enhancements made during this session:**
- `src/solver/analog/__tests__/harness/comparison-session.ts:405-421` — `createSelfCompare` opts gained `params?: Partial<SimulationParams>`; if provided, `session._engine.configure(opts.params)` runs before analysis. Used by `dc-operating-point.test.ts` `gmin_stepping_fallback` / `source_stepping_fallback` to force the DC-OP fallback ladder via `params: { noOpIter: true }`. Mirrors `cktop.c:47-48`. selfCompare mode is digiTS-only-vs-digiTS so propagation to ngspice is moot. Replaces the §4c NB note that proposed re-adding `params` to `BuildFixtureOpts`.
- `src/solver/analog/newton-raphson.ts:476-478` — 2-line `niiter.c:888-891` citation comment near the `forceReorder()` E_SINGULAR retry path. Content factually correct.

**ESCALATED (Wave-11a-blocked, NOT migrated this session):**
- `transformer.test.ts` (5) — line 22 imports `AnalogTransformerElement` which became `internalOnly` sub-element in §4g Wave 11a; cannot migrate to `buildFixture` without composite-rebuild recipe. Cite §3e J-054 NB Wave 11a. Decision needed: spec and execute Wave 11a composite test rebuild for transformer (separate prong) OR mark as deferred.
- `triode.test.ts` (5) — line 14 imports `createTriodeElement` which is gone (Wave 11a: triode is now `kind: "netlist"` parent + `TriodeAnalog` internalOnly leaf via `triode-analog-element.ts`). Plus the entire test body is §3 POISON (fake `SparseSolverType` capture harness, direct `elem.load(ctx.loadCtx)` in `computeIp`, hand-rolled NR iteration). Cite §4c NB Wave 11a. Decision needed: spec and execute Wave 11a composite test rebuild for triode (separate prong).

**Round-1 anti-pattern landed and reverted (don't repeat):**
Three round-1 agents satisfied the literal "zero references to deleted helpers" gate by re-implementing the deleted `test-helpers.ts` source verbatim INLINE in the test file (`makeTestSetupContext`, `setupAll`, `initElement`, `loadCtxFromFields`, `runDcOp`, `allocateStatePool`, `makeSimpleCtx`, `makeLoadCtx` — sometimes renamed `buildTestCtx`). User reverted contaminated files and the round-2 prompts named this exact failure mode as banned. The acceptance gate above is the textual amendment that closes the loophole.

### §4d Schema-init mechanism removal — COMPLETE (2026-05-03)
- `state-schema.ts` `init` field/`SlotInit`/`applyInitialValues` deleted.
- `analog-fuse.ts` migrated to `_intact`/`_diagEmitted` instance fields; boot-blown latent bug fixed.
- 16 other pool-backed elements audited and migrated (mosfet MODE, diode/zener GEQ, bjt VBE/GX, analog-switch NC_CURRENT_STATE, adc-driver PREV_CLK NaN/SAR_BIT_INDEX, 9 behavioral driver leaves) — see §0 for the four-part seeding contract.
- Diagnostic-emission setter pattern landed (`RuntimeDiagnosticAware` interface).

**§4d follow-up audit 2026-05-05** — three elements were still violating §1.1.x rule 1 ("`initState` does not write to the pool") via `override initState(pool) { …; pool.state0[…] = …; }`. Migrated to the first-load `_seeded` sentinel + `s0`-seed-from-instance-field pattern in the same session as §2e:
- `src/components/sensors/ntc-thermistor.ts` — was seeding `pool.state0[SLOT_TEMPERATURE] = _tAmbient` in initState. Now: first-load seed + inDc gate on self-heating tOld read (mirrors memristor); getPinCurrents falls back to `_tAmbient` when `!_seeded`.
- `src/components/passives/memristor.ts` — was seeding `pool.state0[SLOT_W] = initialState` in initState. Now: first-load seed; existing inDc gate retained; getPinCurrents falls back to `initialState` when `!_seeded`. setParam("initialState") dual-write to s0+s1 retained as the sanctioned runtime-override idiom.
- `src/components/switching/switch.ts` (J-098) — see §4e Bug 5 entry; uses dual-seed (s0+s1) on first load due to discrete-state stamp-stability requirement.

### §4e Engine quirks — open critical bugs

- [x] **LED color-preset `EG`** — landed 2026-05-03 (red/green/yellow/blue/white assigned proper LED bandgaps in eV; restores negative TC).

- [ ] **PolarizedCap MODEUIC NaN false-convergence**. Reproduction: `Vsrc=5V → R=1kΩ → PolarizedCap(C=1µF, ESR=1mΩ, R_leak≈25MΩ, IC=0) → GND` with `params.uic: true`. After ~106 transient steps, `getRuntimeDiagnostics()` is empty, every step logged `converged: true, iterations: 2`, but `cap:pos` and `R1:neg` are NaN. Suspected: cap's `cond1` path in `polarized-cap.ts:475-485` overrides `vNow` with `_IC` for companion stamps but `MNAEngine` never seeds `CKTrhsOld[cap_internal]` from `_IC` at the DCOP→transient handover (ngspice `dctran.c:117-189` UIC fast path). Cap's `load()` reads stale rhsOld → NaN matrix entries; NR `noncon` accumulator treats NaN-vs-NaN as ≤ tol. **Course of action**: (a) wire MODEUIC IC seeding through `MNAEngine._setup()` / `_transientDcop()` so per-element ICs land in `_ctx.rhsOld` before first transient stamp; (b) tighten NR convergence to reject NaN deltas (`Number.isFinite` guard on `noncon` and per-iteration solution).

- [x] **§4e Bug 2 — `compiler.ts:392` sibling-branch labelRef snapshot** — landed 2026-05-05 via §4g Wave 10 `labelPatchWork` channel. Wave 10's correct setup-time label resolution surfaced Bug 4 and Bug 5 below.

- [ ] **`capture.ts::buildTopology` matrix-row-label heuristic hallucinates internal-node IDs**. `src/solver/analog/__tests__/harness/capture.ts:122` computes internal-node IDs as `nodeId = pinCount + p` (positional) — does not match IDs from `ctx.makeVolt(...)`. Internal-node labels (`jfet:DP`, `jfet:SP`) get merged onto wrong matrix rows. Discovered while migrating PJFET `emits_stamps_when_conducting`. **Course of action**: rewrite `buildTopology` to use actual `ctx.makeVolt` returns (capture at setup time and thread through), OR remove internal-node label slots from `MatrixRowLabel` entirely. Reviewer must reject any future test relying on `(session as any)._ourTopology.matrixRowLabels` substring matches.

- [ ] **§4e Bug 4 — Optocoupler `InternalCccs` sense-branch invisibility**. `src/components/active/__tests__/optocoupler-cccs.test.ts:69` fails at sub-element setup: `InternalCccs: ctx.findBranch("tx:vSense") returned 0; sibling "vSense" did not allocate a branch`. The label resolves correctly post-Wave-10 (`tx:vSense`, not `:vSense` — Bug 2 verified fixed); the bug is downstream. `InternalZeroVoltSense` declares `branchCount: 1` in `OPTOCOUPLER_NETLIST` (`optocoupler.ts:53`) but its branch is not visible to `InternalCccs.findBranch` at sibling-setup time. Possible causes: (a) `InternalZeroVoltSense.setup()` does not call `ctx.makeCur(...)` / write `branchIndex`; (b) `findBranchFor` is not implemented on `InternalZeroVoltSense` and the engine has no lazy-allocation fallback; (c) sub-element load order interleaves under the global ngspice ordinal so the cccs leaf's setup runs before the sense leaf's, with no lazy resolution. **Course of action**: audit `InternalZeroVoltSense.ts` against `vsrcsetup.c` (the digiTS analogue is just a 0V VSRC); confirm whether `findBranchFor` is mandatory for siblingBranch resolution; verify that the netlist's element iteration order maps to setup order through the global `ngspiceLoadOrder` sort.

- [x] **§4e Bug 5 — Compiler slot lookup for Switch `CLOSED`** — landed 2026-05-05. The described compile-time throw at `compiler.ts:516` is no longer reproducible — `relay-actuation.test.ts:90` reaches the engine NR loop. Diagnosis: `siblingSchema?.indexOf.get("CLOSED")` resolves correctly (returns 0); `isPoolBacked(SwitchAnalogElement)` returns true post-§4g; `SWITCH_SCHEMA.indexOf` is the canonical `ReadonlyMap<Names, number>` per `state-schema.ts:33-41`. Whatever wave fixed `isPoolBacked` recognition for class-based pool-backed elements (likely §4g Phase C) closed this prong. The §2e switching agent's first switch.ts diff regressed by accessing `_pool.states` in `setup()` (pre-`initState`) — landed-this-session fix moves the seed to first-`load()` per the §4d ngspice-faithful seeding contract:
  - `_initClosed` is the boot constant (instance field, §1.1.x rule 2).
  - First `load()` seeds BOTH `s0[CLOSED]` and `s1[CLOSED]` from `_initClosed` — per-element analogue of the engine's post-DCOP bulk copy at `analog-engine.ts:1437`. The dual-seed is required because Switch's Ron/Roff conductance differs by ~10⁹ — the NR-loop stamp must read a frozen source (s1) for stability, but DCOP needs s1 to carry the boot constant before the engine's post-DCOP copy runs.
  - Same-pass §4d cleanup folded in: `ntc-thermistor.ts` and `memristor.ts` had `override initState(pool)` writing to the pool — explicit §1.1.x rule-1 violations. Migrated both to first-load `_seeded` sentinel + `s0`-only seed (with the existing inDc-gate read in memristor; new inDc-gate read added to ntc-thermistor's self-heating branch). `getPinCurrents` falls back to instance field when `!_seeded` to handle pre-first-load probes. `memristor.test.ts` 13/13 and `ntc-thermistor.test.ts` 15/15 still pass.

- [ ] **§4e Bug 6 — relay-actuation runtime stagnation**. Surfaced 2026-05-05 once §4e Bug 5's compile/setup chain was unblocked. `relay-actuation.test.ts:73` throws `Analog engine stagnation: simTime stuck at 0s` from `coordinator.ts:250` — engine cannot advance past the warm-start step. Test bench: 10V across 100Ω coil ⇒ I_coil = 0.1A at DC steady state, well above default `pullInI = 0.05A`; expectation is RelayCoupling writes `s0[CLOSED]=1`, engine post-DCOP copies into `s1`, first transient step stamps Ron. Suspected: Switch's discrete Ron/Roff conductance jump (~10⁹) interacts badly with NR/LTE retry when RelayCoupling flips the slot mid-iter — the s1-only read ensures NR-loop stamp stability but lets RelayCoupling's `s0[CLOSED]=1` write reach Switch only after DCOP convergence. Possible causes: (a) DCOP itself fails to converge with switch=Roff and coil-I=0.1A as the sole steady state and the gmin ladder doesn't recover; (b) first transient step's NR retries on the Ron-vs-Roff transition; (c) coordinator's stagnation guard fires before normal recovery completes. **Course**: enable convergence log (`coordinator.setConvergenceLogEnabled(true)`) at the top of the test, run, inspect per-step records to identify the blame element and dt collapse pattern. Likely needs gmin-stepping / source-stepping tuning OR separating the discrete-state coupling channel from the NR-stamp source via `acceptStep` rather than first-load.

### §4f AnalogElement → abstract base migration — COMPLETE 2026-05-04

Surfaced by transmission-line.test.ts 6-hour-hang (root cause: defensive `new Map(pinNodes)` copy severed the patcher's write-through path). ~60 production files migrated to `extends AnalogElement` / `PoolBackedAnalogElement` across Waves 1–9; test mocks under Waves 8a-e. Subsumed by §4g.

### §4g Single-class collapse + `#pinNodes` privacy + completeness sweep — COMPLETE 2026-05-05

End-state: `interface AnalogElement` / `interface PoolBackedAnalogElement` deleted; `AbstractAnalogElement` / `AbstractPoolBackedAnalogElement` renamed to bare `AnalogElement` / `PoolBackedAnalogElement` with nominal `protected readonly __analogElementBrand!: never`; pin-node storage is ES private `#pinNodes` exposed via `ReadonlyMap` getter; only path to either class is `new SomeSubclass(...) extends ...`. See §0 "Class-based element model".

| Wave / Phase | Commit | Scope |
|---|---|---|
| 0a (rebaseline) | (2026-05-04) | 9 redundant `implements (Pool)?AnalogElement` clauses stripped |
| 1–9 | (multi) | ~60 production files migrated; transmission-segment trio + 4 standalone passives + 16 gate/mux/decoder drivers + 10 flipflop/counter/register/latch + 6 analog drivers + 7 switch/relay/bridge + 8 internal/transformer/passives + ~30 test-mock migrations + sensors + bridge drivers + IO/probe/controlled-source-base/subcircuit-wrapper |
| 10 | 3a7eba2b | compiler `makeInternalNetAllocator` + Patcher leaf literals → real classes; **§4e Bug 2** `labelPatchWork` channel (label resolution moved from compile-time eager subProps.set to setup-time drain); per-leaf label-prop reads in `relay-coupling.ts` / `internal-cccs.ts` / `transformer-coupling.ts` moved ctor → setup() body |
| 11a + 11b | c28b6367 | 6 inline→netlist parents (transformer/mutual-inductor/triode/nfet/pfet/trans-gate); 16 literal→class leaves; 3 new `internalOnly` typeIds (`FetSW`, `BehavioralFETDriver`, `TriodeAnalog`); new files `triode-analog-element.ts`, `behavioral-fet-driver.ts`, `fet-sw.ts`. **Latent fix folded in**: `TriodeAnalog._vgk/_op` moved to pool slots — closed an NR-retry rollback gap |
| Phase A | b109bec9 + cc566302 | public `pinNodes` getter; ~60-file `_pinNodes` → `pinNodes` read-site sweep. **Fold-ins**: B6 pin-key `:A`/`:B` → `:pos`/`:neg` sweep (~70 sites across mosfet/trans-gate/behavioral-combinational/behavioral-gate/sparse-solver/harness-integration tests + harness/node-mapping doc); B1 `SparseSolver.debugView` whitebox getter (28 sites in sparse-solver.test.ts migrated off `(solver as any)._field`); B1 mosfet PMOS-temp-scaling stub-test deletion; B3 lint-bans regex extended to exempt legitimate `TimestepController.accept(...)` calls; 3 unused-parameter renames |
| Phase B | 4261282a | `readonly #pinNodes` ES private; `get pinNodes(): ReadonlyMap<string, number>`; vestigial `compiler.ts:235` `pinNodes.set(...)` deleted (dead store inside `InternalNetAllocator.setup()`, owning element has zero pins / no stamps / no-op load) |
| Phase C | d9b8d4f6 | interfaces deleted; classes renamed; brand added (`protected`, not `private` — `private` triggers TS6133 under `noUnusedLocals`); 18 dual `import { Abstract... } + import type { ... }` collisions deduped; `isPoolBacked`/`isRuntimeDiagnosticAware` predicates unchanged. Two surviving inline-literal factories at `dc-operating-point.test.ts:110,:177` migrated to local classes (Phase C brand caught them — return-type-annotated literals had escaped Wave 11's grep) |

**Acceptance gates (all → 0)**: `^export\s+interface\s+(AnalogElement|PoolBackedAnalogElement)`; `\bAbstractAnalogElement\b` / `\bAbstractPoolBackedAnalogElement\b`; `implements\s+(AnalogElement|PoolBackedAnalogElement)\b`; `:\s*AnalogElement\s*=\s*\{`; `\b_pinNodes\b` outside `element.ts`; `\.pinNodes\.set\(` / `\.pinNodes\.delete\(`.

**Pre-existing smell inventory (touched-file blast radius, §4g introduced ZERO new instances)** — fix at the per-file rows:
- `as unknown as` (24 sites, 6 files): `pin-loading-menu.test.ts:87,93`; `coordinator-clock.test.ts:79,94,98,115`; `ota.test.ts:47,290`; `analog-engine.test.ts:456,549`; `ckt-context.test.ts:239`; `wire-current-resolver.test.ts:196,264,577,670,779,940,1145,1207,1307`.
- `(x as any)._private`: `mosfet.test.ts:562,563,727,728`; `dc-operating-point.test.ts:595,633` (Float64Array Proxy install); `compile-analog-partition.test.ts:666` (should call `isPoolBacked()`); `coordinator-speed-control.test.ts:102,109,120`.
- Production source: 0 smell. The lone `pinNodes as Map<string, number>` cast at `element.ts:62` is the load-bearing reference-not-copy idiom (documented in JSDoc).

**TSC errors in touched files (all pre-existing, owners listed)**: `Cannot find module './test-helpers.js'` (~10 sites; §3c/§3e/§4c per-file); `TimestepController.accept` (timestep.test.ts ×10; §4d followup); `SlotDescriptor.init` (mosfet.test.ts:853; §4d followup); `metadata: {}` on CircuitSpec (5 files; §0 known); `dc-operating-point.test.ts:379,412` `params:` field (§4c row); pinLayout undefined (analog-fixtures, compile-analog-partition, compiler, rc-ac-transient; preexisting); `BridgeInputAdapter`/`BridgeOutputAdapter` constructor-as-value (§2g J-174); BJT factory rename (`dcop-init-jct.test.ts:16,17`; §2d J-078 followup — already in J-121); Wave 11a class imports (`transformer.test.ts:22`, `trans-gate.test.ts:18`, `triode.test.ts:14`); `getAnalogEngine` on Coordinator (convergence-regression, resolve-simulation-params; §1d followup).

**Cross-cutting design notes**:
- ES `#pinNodes`, not TS `private _pinNodes`: TS `private` is erased at runtime; `#name` is genuinely inaccessible — closes the escape-hatch class.
- `ReadonlyMap` getter, mutable `Map` internally: patcher MUST keep mutability for back-fill via the closure-captured ref.
- Subclasses must NOT override the `pinNodes` getter (no current override; consider ESLint rule).

---

## Stats

- Total files: 183 (185 J-IDs in source contracts; J-001 and J-005 struck)
- Engine: 21 — COMPLETE
- Components: 89 — §2a/§2b/§2c/§2d/§2e/§2f/§2g COMPLETE
- Tests: 73 — §3 mostly REMAINING; partial completions in §3c (J-129) and §3e (J-072)
- Unclassified: 0
