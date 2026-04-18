# Test Baseline

- **Timestamp**: 2026-04-18T00:00:00Z
- **Phase**: phase_catchup (about to start Wave C1)
- **Command**: npm run test:q
- **Result**: BROKEN — suite hangs indefinitely; cannot run to completion.

## Current pre-catchup state (AUTHORITATIVE for phase_catchup)

The test suite does **not** run to completion in this phase. Implementers must not attempt a full suite run. Use targeted tests only (`npm test -- <path-pattern>`) scoped to the files modified in the current task.

Known root causes (all remediated by phase_catchup):

1. **Seven production modules import the deleted `integrateCapacitor` / `integrateInductor` symbols** — `fet-base.ts`, `mosfet.ts`, `diode.ts`, `varactor.ts`, `tunnel-diode.ts`, `led.ts`, `digital-pin-model.ts`. Any runtime test touching these modules fails at module-load. Fixed by Wave C2.
2. **`src/core/analog-types.ts::AnalogElementCore` still carries pre-migration split method set**; its sibling `AnalogElement` was migrated. tsc breakage + mock confusion. Fixed by Wave C1.
3. **Test files still driving elements through deleted methods** across `controlled-source-base.test.ts`, `behavioral-*.test.ts`, `fet-base.test.ts`, `dcop-init-jct.test.ts`, `varactor.test.ts`, `sparse-solver.test.ts`, `test-helpers.ts` mock factory. Fixed by Wave C3.
4. **`cktLoad` drops `srcFact` scaling on nodesets, never stamps ICs**, vs ngspice `cktload.c:96-136`. Fixed by Wave C7.
5. **Dead code paths** — `applyNodesetsAndICs` helper, `rawMaxIter` tautological ternary, `SparseSolver.stamp(row,col,value)` wrapper, five obsolete tests. Fixed by Waves C5, C6.6, C7.2.
6. **Missing spec-required parity tests** — every per-element parity test from Phase 6 Tasks 6.2.1–6.2.5, plus `buckbjt-convergence.test.ts` (Task 6.2.3), plus Phase 3 rounding differential tests. Fixed by Wave C4.
7. **Weak assertions and `toBeCloseTo`** across `integration.test.ts`, `ckt-terr.test.ts`. Fixed by Wave C8.

## Pre-catchup rule for implementers

- **Do not** interpret a test failure you see during phase_catchup as caused by your own changes without verifying it against the Phase 0 historical baseline below and against this known-broken list.
- When a spec-exact test detects real ngspice divergence, **surface the divergence** to the user — do not soften the assertion, do not relax `toBe` to `toBeCloseTo`, do not add `?.` guards, do not cast with `as any`.
- Hanging tests are expected until Wave C2 lands (module-load crashes resolved).
- Wave C2.4 is an atomic-migration gate — `tsc --noEmit` is expected to succeed only after the full Wave 6.4 body lands.

## CRITICAL TEST INVOCATION RULE (for implementers AND verifiers)

**Do NOT use `npm test` or `npm run test:q`** — those commands are hanging the whole machine during phase_catchup because some test files still fail at module-load and the npm wrapper gets stuck. Use `vitest` directly with a file-path scope instead.

- ✅ `npx vitest run path/to/file.test.ts --reporter=verbose` — targeted, fast, non-hanging
- ✅ `npx vitest run --reporter=default path/to/file.test.ts` — targeted with default reporter
- ❌ `npm test -- ...` — hangs
- ❌ `npm run test:q` — hangs
- ❌ `npm test` — hangs

Always target a specific file (or directory) you just edited. Never attempt a full run until the catchup phase completes.

---

## Historical baseline (Phase 0, captured 2026-04-15T21:58:00Z)

Kept for reference only. Most of these failing tests will be retargeted or replaced by phase_catchup; do not use this list to triage failures during phase_catchup.

- **Command**: npm run test:q
- **Result**: 8333/8368 passing, 35 failing, 0 errors
- **Duration**: 17.9 seconds across 365 files

### Phase 0 failing tests

| Test File | Test Name | Error Type | Summary |
|-----------|-----------|-----------|---------|
| src/editor/__tests__/wire-current-resolver.test.ts | cross-component current equality through real compiled lrctest.dig | Assertion | expected 0.0108 to be greater than 0.045 |
| src/editor/__tests__/wire-current-resolver.test.ts | component-as-node KCL: wire at pin A ≈ wire at pin B ≈ body current | Assertion | expected 272.02 to be less than 0.01 |
| src/headless/__tests__/rlc-lte-path.test.ts | RC step response: exponential charging matches V(1-e^-t/τ) | Assertion | expected 6.2e+30 to be ≤ 3.22 |
| src/headless/__tests__/rlc-lte-path.test.ts | RL step response: V_R matches 1-e^-t/τ (R=10, L=1mH, τ=100µs) | Assertion | expected 2.2e+6 to be ≤ 0.64 |
| src/headless/__tests__/rlc-lte-path.test.ts | series RLC ring-down: oscillatory with strictly decreasing envelope | Engine Stagnation | simTime stuck at 0.001217s |
| src/headless/__tests__/rlc-lte-path.test.ts | reltol configurability: tight reltol produces different result and more steps | Engine Stagnation | simTime stuck at 0.0000348s |
| src/headless/__tests__/rlc-lte-path.test.ts | RC capacitor zero-crossings at f=20Hz (f<<fc): 2±1 crossings and peak≥0.95 | Assertion | expected 99 to be ≤ 3 |
| src/headless/__tests__/rlc-lte-path.test.ts | RL resistor zero-crossings at f=200Hz (f<<fc): ≥6 crossings over 4 periods | Engine Stagnation | simTime stuck at 0.0093s |
| src/io/dts-schema.ts | circuit.metadata.models entry survives serialize -> deserialize | Schema Validation | modelParamDeltas.params["ICVBE"] must be number or string (multiple) |
