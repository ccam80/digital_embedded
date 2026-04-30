# Test-Fix Jobs

Each job lives in `spec/test-fix-jobs/<name>.md` and is self-contained:
problem statement, sites, verified ngspice citations, fix shape, blast
radius, tensions/uncertainties.

## Categories

- **architecture-fix** — production code doesn't match ngspice and should
- **contract-update** — tests don't match the (correct) production contract
- **few-ULP** — actual numerical FP-ordering divergence at the few-ULP level

Anything bigger than few-ULP that "looks numerical" is a `contract-update`
in disguise (test reading wrong slot/index/fixture) until proved otherwise.

## Hard rules for any agent acting on these specs

1. No shims, aliases, backwards-compat hacks.
2. No "pragmatic" / "minimal diff" framing — implement the cleanest final shape.
3. No scope reduction, no deferral, no TODO comments.
4. No `(coord as any)._private` tunneling. Use facade / coordinator / harness public APIs only.
5. No banned-vocab closing verdicts (`tolerance`, `mapping`, `equivalent under`, `pre-existing`,
   `intentional divergence`, `partial`, `citation divergence`). If you'd be tempted, escalate.
6. Composite components extend `CompositeElement` (in `src/solver/analog/composite-element.ts`)
   via the new `CompositeComponentBase` abstraction once that lands. Per-component manual prop
   merging is forbidden.

---

## Composite component family

- [composite-component-base.md](test-fix-jobs/composite-component-base.md) — central:
  `CompositeComponentBase`, `PropertyBag.forModel(modelDefaults, overrides)` auto-merge,
  typed `bindSubPin` API replacing `(child as any)._pinNodes.set(...)`. **architecture-fix.**
- [composite-scr.md](test-fix-jobs/composite-scr.md) — Q1 NPN + Q2 PNP latch via shared
  internal node. **architecture-fix.**
- [composite-triac.md](test-fix-jobs/composite-triac.md) — Q1..Q4 + 2 latch nodes; resolves
  `triggers_triac` (`PropertyBag: model param "NF" not found`). **architecture-fix.**
- [composite-diac.md](test-fix-jobs/composite-diac.md) — promote anonymous literal to
  `DiacCompositeElement`; resolves `blocks_below_breakover` (anonymous literal's `_stateBase: -1`
  never initialized). **architecture-fix.**
- [composite-optocoupler.md](test-fix-jobs/composite-optocoupler.md) — DIO + VSRC + CCCS + BJT;
  setup order forced by `findBranch` dependency, not `NGSPICE_LOAD_ORDER` ascending.
  **architecture-fix.**
- [composite-timer-555.md](test-fix-jobs/composite-timer-555.md) — three resistors + 2 VCVS
  comparators + discharge BJT + RS-FF; custom `load()` interleaves stamps with FF state update.
  **architecture-fix.**
- [composite-transmission-line.md](test-fix-jobs/composite-transmission-line.md) —
  N-segment R/L/G/C with last segment as `CombinedRLElement`; lazy `addSubElement`
  registration inside `setup()`. **architecture-fix.**
- [composite-real-opamp.md](test-fix-jobs/composite-real-opamp.md) — recommends real-opamp
  stays a leaf `PoolBackedAnalogElement` (not a `CompositeElement`); `railLim` is per-element
  NR-limiter discipline, not composite shape. **architecture-fix.**
- [composite-behavioral-families.md](test-fix-jobs/composite-behavioral-families.md) — audit
  result: behavioral-gate / -combinational / -remaining / -sequential / -flipflop already
  extend `CompositeElement` cleanly. No rework. **architecture-fix (audit-only).**

## Compiler architecture

- [topology-validation-after-setup.md](test-fix-jobs/topology-validation-after-setup.md) —
  pull pre-flight validation into a post-setup hook in `analog-engine._setup()`; populated
  `branchIndex` enables `detectVoltageSourceLoops` / `detectInductorLoops`. **architecture-fix.**
- [digital-pin-loaded-vs-unloaded.md](test-fix-jobs/digital-pin-loaded-vs-unloaded.md) —
  split `DigitalInputPinModel` into `DigitalInputPinLoaded` / `DigitalInputPinUnloaded`;
  compiler picks at instantiation; delete `_loaded` flag. **architecture-fix.**

## Element-level production

- [real-opamp-rail-limited-nr.md](test-fix-jobs/real-opamp-rail-limited-nr.md) — full
  pool-backing + `railLim` voltage limiter clamping `vOut` (not just `vInt`) and bumping
  `ctx.noncon.value` on overshoot. **architecture-fix.**
- [setup-stamp-order-bjt-ind.md](test-fix-jobs/setup-stamp-order-bjt-ind.md) — uncovers two
  latent production bugs: `createBjtElement` always returns L0 (9 entries; L1 with 20 entries
  is unreachable); inductor reads `A`/`B` while tests pass `pos`/`neg`. **architecture-fix.**
- [setup-stamp-order-opto-555.md](test-fix-jobs/setup-stamp-order-opto-555.md) — golden
  re-record gated on composite-base + BJT factory dispatch fix. **contract-update**
  (depends on composite-component-base.md).
- [ckt-context-buffer-allocation.md](test-fix-jobs/ckt-context-buffer-allocation.md) —
  needs user decision: thread matrix size into constructor (architecture-fix) vs rename test
  to `allocates_all_buffers_after_setup` and call deferred sizers (contract-update).
- [potentiometer-double-stamp.md](test-fix-jobs/potentiometer-double-stamp.md) — production
  matches `resload.c` 1:1; test diagonal-row indices have W↔B swap. **contract-update**
  (brief was wrong about a 2× production stamp bug).
- [wire-current-resolver-lrctest.md](test-fix-jobs/wire-current-resolver-lrctest.md) — engine
  enters ERROR state on first transient step; `simTime` never advances. NOT a tunnel-diode
  fixture issue (lrctest only uses Resistor/Cap/Inductor/AcVoltageSource). **architecture-fix.**

## LTE / NR / DC-OP

- [rlc-lte-adaptive-subdivision.md](test-fix-jobs/rlc-lte-adaptive-subdivision.md) — adaptive
  rejection-and-retry loop is correct; failure is `setSignal` mutating source param before
  first `step()` runs `_transientDcop()`, so DCOP solves with the new value already applied.
  Three resolution options. **architecture-fix.**
- [dc-op-strategy-direct-vs-gmin.md](test-fix-jobs/dc-op-strategy-direct-vs-gmin.md) — test
  uses a thin `makeDiode` mock missing MODEINITJCT seed, pnjlim, GMIN injection, and
  current-based convTest; production has all four. Migrate test to `createDiodeElement`.
  **contract-update.**
- [nr-diode-convergence-drift.md](test-fix-jobs/nr-diode-convergence-drift.md) — Vd=5.005V,
  Ireverse=0.005A, Shockley 1.35% — past few-ULP. Most likely root: NR convergence gating
  off-by-one OR missing MODEINITJCT seed. **architecture-fix; ESCALATE.**
- [dc-op-parity-divergence.md](test-fix-jobs/dc-op-parity-divergence.md) — four parity tests
  (`bjt-common-emitter:dc_op_match`, `mosfet-inverter:dc_op_match`, `rc-transient:transient_per_step_match`,
  `rlc-oscillator:transient_oscillation_match`) at `absDelta === 0` bar. **architecture-fix; ESCALATE.**
- [harness-comparison-matrix-divergence.md](test-fix-jobs/harness-comparison-matrix-divergence.md) —
  five matrix-entry divergences in comparison-session tests; per-iteration (row, col, ours,
  ngspice) extraction documented. **architecture-fix; ESCALATE.**
- [hotload-bf-param-drift.md](test-fix-jobs/hotload-bf-param-drift.md) — 30 ppm drift; same
  family as `bjt-common-emitter:dc_op_match`. Phase A failure on default BF=100 means hot-load
  path is not the source — engine BJT load is. **architecture-fix.**
- [ckt-terr-lte-literals.md](test-fix-jobs/ckt-terr-lte-literals.md) — Gear factor literals:
  tests use rationals (`2/9`, `3/22`); production exports ngspice's truncated decimals
  (`0.2222222222`, `0.1363636364`). **contract-update.**
- [nr-reorder-citation.md](test-fix-jobs/nr-reorder-citation.md) — `phase-3-nr-reorder.test.ts`
  asserts `niiter.c:888-891`; production emits `niiter.c:881-902`; correct narrow range is
  889-894. **contract-update.**

## E2E / fixtures

- [cmos-mode-gate-timeouts.md](test-fix-jobs/cmos-mode-gate-timeouts.md) — single-gate-no-wiring
  CMOS netlists create floating subnets; NR damps via gmin and never converges. Needs the
  post-setup topology validator + a "nonlinear-only subnet with no DC ground path" detector.
  **architecture-fix.**
- [master-circuit-assembly-suite.md](test-fix-jobs/master-circuit-assembly-suite.md) — Master
  1: cmos engine-class; Master 2: status-bar from compile diagnostic; Master 3: DAC `rOut`
  default 100Ω forms divider with R1=1k (~9% drop). **architecture-fix (mixed).**
- [adc-bits-4-status-error.md](test-fix-jobs/adc-bits-4-status-error.md) — width-sweep wires
  only `D0`; `EOC, D1..D(N-1)` outputs are unwired and each `DigitalOutputPinModel` produces
  a structurally singular floating subnet. Needs per-net Hi-Z fallback. **architecture-fix.**
- [bjt-convergence-fixture-tunnel-diode.md](test-fix-jobs/bjt-convergence-fixture-tunnel-diode.md) —
  `TD` is NOT a deleted tunnel-diode component (no such component existed). `buildBuckBJT`
  references `'TD'` in 3 wiring/trace calls but never calls
  `placeLabeled('Diode', 43, 12, 'TD', 90)`. One-line fixture fix. **contract-update.**

## Test migrations (mock/accessor cleanup)

- [behavioral-tests-via-harness.md](test-fix-jobs/behavioral-tests-via-harness.md) —
  9 failing tests across `behavioral-sequential.test.ts` / `behavioral-gate.test.ts` /
  `behavioral-combinational.test.ts`. Recommendation: keep facade/harness duality with
  explicit names (`SimulatorFacade` = bounded production-call API; `ComparisonSession` =
  bounded numerical-investigation API; single hand-off via `setCaptureHook`). All migrate to
  `.dts` fixture + `ComparisonSession.createSelfCompare`. **contract-update.**
- [convergence-regression-state-pool.md](test-fix-jobs/convergence-regression-state-pool.md) —
  5 tests reading `coordinator.statePool` directly; migrate to `coordinator.captureElementStates`.
  **contract-update.**
- [harness-integration-accessor-rename.md](test-fix-jobs/harness-integration-accessor-rename.md) —
  brief framing was wrong; accessors exist. Real fault: tests build a fresh `MNAEngine` in
  `beforeEach` and ignore the engine returned by `buildHwrFixture()`. **contract-update.**
- [resistor-stamp-via-facade.md](test-fix-jobs/resistor-stamp-via-facade.md) — fixes ngspice
  citation (`resload.c:34-37` for DC-load, not `:45-48` which is `RESacload`). Migrates to
  facade + `getCSCNonZeros()`. **contract-update.**
- [led-junction-cap-transient.md](test-fix-jobs/led-junction-cap-transient.md) — `mockSolver`
  returns 0; folds in latent bug (test filters stamps on `(row=0, col=0)` but pin map puts
  LED at MNA node 1). **contract-update.**
- [led-temp-and-forward-drop.md](test-fix-jobs/led-temp-and-forward-drop.md) — signal label
  drift (`led:in` vs actual). **contract-update.**
- [led-pnjlim-event-push.md](test-fix-jobs/led-pnjlim-event-push.md) — agent disagrees with
  brief: the MODEINITJCT push test currently passes and documents an intentional digiTS
  contract. Deletion is escalated, not done. **contract-update; ESCALATE.**
- [jfet-conducting-stamps.md](test-fix-jobs/jfet-conducting-stamps.md) — fixture feeds same
  `voltages` buffer to `load()` 50× without iterating; pnjlim/fetlim trap `vgs` at `vcrit≈0.78V`
  → device stays in cutoff. **contract-update.**

---

## Open user decisions

The following items require user decisions before implementation. Each
links to its spec for context.

1. **Composite refactor — `setPinNode` interface placement.** Optional method on
   `AnalogElement`, or duck-typed inside `bindSubPin`? Only `VsenseSubElement` and
   `CccsSubElement` implement it today.
2. **Composite refactor — `PropertyBag.forModel` schema validation.** Should `forModel`
   accept the `ParamDef[]` schema for higher-quality unknown-key error messages, folding in
   `model-params.ts:84-94`'s `deviceParams()`?
3. **Real-opamp boundary.** Confirm real-opamp stays a leaf `PoolBackedAnalogElement` (not
   `CompositeElement`); pool-backing + `railLim` are independent of the composite refactor.
4. **Optocoupler hot-loadable params.** `CccsSubElement.gain` is `private readonly`. Per
   the user's hot-loadable-params policy it must become mutable. Land in the same PR as the
   composite-base refactor, or as a follow-up?
5. **`getPinCurrents` placeholders.** SCR / TRIAC / optocoupler return all-zeros today.
   Real per-pin current resolution is a separate aggregation problem — out-of-scope flag.
6. **Topology-validation surface.** Where to surface post-setup diagnostics: on the
   compile-result vs via a new compile-pipeline warmup step? Spec recommends warmup.
7. **Digital-pin classes — `role` axis.** Fold the output-pin `role` axis with the loaded
   axis (4 classes), or keep `role` internal to two output classes? Spec recommends keeping
   internal.
8. **BJT default model level.** `BJT_NPN_DEFAULTS` does not specify L0 vs L1; the unreachable
   L1 factory must be wired up — which level is the default?
9. **Inductor pin-key alignment.** Capacitor uses `pos`/`neg`; inductor uses `A`/`B`. Align
   inductor on `pos`/`neg`? Currently 4 of 5 stamp allocations receive `undefined`.
10. **`ckt-context` buffer-allocation contract.** Option A — thread matrix size into the
    constructor (architecture-fix; non-trivial engine refactor). Option B — rename test to
    `allocates_all_buffers_after_setup` and call deferred sizers (contract-update; matches
    ngspice's `cktinit.c` precedent).
11. **LED pnjlim MODEINITJCT contract.** Keep current behavior (push under MODEINITJCT —
    intentional digiTS contract per `diode.ts:609-619`) or align with ngspice (no push under
    MODEINITJCT)?
12. **Behavioral-tests harness — `digitalPinLoadingOverrides` direction.** Per-pin direct
    on the element (artificial; production never does this) vs per-net override (matches
    production)? Spec recommends per-net only.
13. **Behavioral-tests harness — single typed accessor addition.**
    `ComparisonSession.getMatrixInsertionOrder()` to avoid `(harness as any)._engine`
    tunneling — add or accept the tunneling?
14. **Behavioral-tests — observable-behavior reformulation vs structural assertions.**
    Should pin-loading tests assert via voltage-sag through finite-impedance source instead
    of matrix-allocation pairs? Spec recommends keeping structural via `_getInsertionOrder()`.
15. **`setSignal` + DCOP ordering.** Add `setSignalAtTime(label, value, time)` with
    breakpoint-driven event scheduling (cleanest), rewrite RLC tests to use PULSE source
    idiom, or per-test step-then-set ordering? RLC LTE tests gate on this.
16. **Few-ULP threshold.** `CLAUDE.md` does not specify a numerical threshold for the
    `few-ULP` category. Choose a value (conventional `≤16 ulp`?).
17. **LU pivot-order alignment with Sparse 1.3.** If digiTS LU and ngspice's Sparse 1.3 must
    be bit-exact at the last ULP, this is an architectural-alignment item to formalize.
18. **`docs/ngspice-harness-howto.md` is missing.** `CLAUDE.md` cites this as the entry point
    for any numerical-discrepancy investigation; it does not exist in the tree. Author it?

## Latent bugs uncovered (not in scope but in blast radius)

These were discovered during investigation. Per project policy on latent
bugs in the same blast radius, they are documented for fold-in
consideration in their respective specs.

- **`createBjtElement` always returns L0** when the L1 factory exists with the full 20-entry
  TSTALLOC sequence (unreachable code). See `setup-stamp-order-bjt-ind.md`.
- **Inductor reads `A`/`B` pin keys** while the rest of the codebase uses `pos`/`neg`.
  Documented in `setup-stamp-order-bjt-ind.md`.
- **DIAC anonymous literal element** has `_stateBase: -1` never initialized, producing
  `1e+171` divergence on first `load()`. Documented in `composite-diac.md`.
- **Diode `setParam("AREA"|"IS"|"CJO", ...)` does not re-apply area scaling.** Same blast
  radius as the named DC-OP failures. Documented in `dc-op-parity-divergence.md`.
- **`load-context.ts` declares `noncon: { value: number }`** but `newton-raphson.ts:351`
  writes `ctx.noncon = 0`, replacing the object. Element-side code increments
  `ctx.noncon.value`. Verify increment plumbing before declaring real-opamp green. Documented
  in `real-opamp-rail-limited-nr.md`.
