Note: phase 0-7 progress removed by user - all done and reviewed. 

## Recovery events

- **2026-04-25 — batch-p9-w9.1, mark-dead-implementer.sh**
  - Reason: Implementer agent `a54b079ddfba7560a` returned `TaskOutput` status `completed` but `complete-implementer.sh` was never invoked (counters did not advance — `completed=0` after run). Transcript tail showed the agent attempting to write `src/solver/analog/__tests__/phase-9-sweep.test.ts` via a Bash heredoc and hitting backtick template-literal parse failures, then exiting before retrying with the Write tool.
  - Partial output preserved: `test-results/phase-9-identifier-sweep.json` was written successfully and is on disk for the replacement implementer to reuse for 9.1.1. (Path subsequently superseded — see next recovery entry — by `spec/phase-9-snapshots/identifier-sweep.json`.)
  - Locks at `spec/.locks/{tasks,files}/` were stale (9.1.1 task lock plus two file locks); cleaned before respawn.

- **2026-04-25 — batch-p9-w9.1, mark-dead-implementer.sh (2nd)**
  - Reason: Implementer agent `afa46e4a446254f20` returned `TaskOutput` status `completed` but `complete-implementer.sh` was never invoked (counters did not advance — `completed=0` after run). Agent successfully Edited `src/solver/analog/__tests__/phase-9-sweep.test.ts` with all 11 tests and ran `npm test` to completion (vitest ~8189/193/10, playwright ~470/18). Agent then needed a parser helper script; `Write` was denied for `scripts/parse-test-log.mjs`; agent fell back to inline `node -e` which mangled backslashes in regex literals; agent reported it would Edit the placeholder JSON inline as last text before terminating without calling `complete-implementer.sh`.
  - Independent issue surfaced: Playwright wipes `test-results/` at the start of every run, so the placeholder snapshot files I (the coordinator) created were deleted by the implementer's `npm test` invocation. **Spec amended in this recovery**: snapshot paths moved from `test-results/phase-9-*.json` to `spec/phase-9-snapshots/*.json` (a directory test runners do not touch). The phase spec `spec/phase-9-legacy-reference-review.md`, the test file `src/solver/analog/__tests__/phase-9-sweep.test.ts`, and the helper `scripts/phase-9-identifier-sweep.cjs` were updated to point at the new paths. Empty placeholder JSONs created at the new paths.
  - **Out-of-scope work observed but kept**: This implementer also authored a Phase 8 review reset (created `spec/reviews/phase-8.md`, bulk-flipped 62 rows in `spec/ngspice-citation-audit.json` from `verified` → `unverified`, tightened three assertions in `src/solver/analog/__tests__/citation-audit.test.ts`, logged it in this file's "Phase 8 review reset — 2026-04-25" section). This was outside the implementer's Phase 9 prompt. Surfaced to the user; user confirmed they are running the Phase 8 reset in parallel and to keep all of it as-is. Third implementer is instructed to leave that work strictly alone.
  - Locks at `spec/.locks/{tasks,files}/` were stale (9.1.1 task lock plus five file locks); cleaned before respawn.

- **2026-04-25 — batch-p9-w9.1, mark-dead-implementer.sh (3rd)**
  - Reason: Implementer agent `a11e656fb32c412c2` returned `TaskOutput` status `completed` but `complete-implementer.sh` was never invoked (counters did not advance — `completed=0` after run). Agent successfully completed 9.1.1 (full identifier-sweep.json snapshot, all zero offending paths) and 9.1.2 (10 random citations sampled, all 10 verified, no expansions, citation-sample.json populated, 10 inventory rows transitioned `unverified` → `verified`). Authored both helper scripts: `scripts/phase-9-citation-sample.cjs` and `scripts/phase-9-baseline-parser.cjs`. Started 9.1.3: launched `npm test > /tmp/npm-test-phase9.log 2>&1; echo "EXIT=$?" >> /tmp/npm-test-phase9.log` in background, then used `Monitor` to wait for the EXIT marker. Agent died before Monitor returned. The npm test child process was killed when the agent terminated; vitest had completed (8183 passed / 199 failed / 10 skipped) but Playwright was cut off mid-run (~60 of ~488 tests).
  - Partial output preserved: `spec/phase-9-snapshots/identifier-sweep.json` and `spec/phase-9-snapshots/citation-sample.json` are complete and consistent with their tests. `spec/phase-9-snapshots/full-suite-baseline.json` is still the empty `{}` placeholder. The truncated npm test log at `/tmp/npm-test-phase9.log` (806 lines, no EXIT marker) is unusable as a baseline because Playwright never finished.
  - Locks at `spec/.locks/{tasks,files}/` were stale; cleaned before 4th-attempt respawn (which is narrowly scoped to 9.1.3 only — 9.1.1 and 9.1.2 are already done and leaving them alone).

## Task 9.1.1: Repo-wide identifier sweep
- **Status**: complete
- **Agent**: implementer
- **Files created**: spec/phase-9-snapshots/identifier-sweep.json
- **Files modified**: none
- **Tests**: 2/2 passing (IdentifierSweep::snapshotExists, IdentifierSweep::allZeroOffendingPaths)

## Task 9.1.2: Citation sample audit
- **Status**: complete
- **Agent**: implementer
- **Files created**: spec/phase-9-snapshots/citation-sample.json, scripts/phase-9-citation-sample.cjs
- **Files modified**: spec/ngspice-citation-audit.json (10 rows updated to verified: C-0171, C-0230, C-0343, C-0490, C-0520, C-0558, C-0638, C-0703, C-1110, C-1165)
- **Tests**: 7/7 passing (CitationSample all subtests)
- **Expansions**: none — all 10 sampled citations verified; no rot found

## Task 9.1.3: Full suite baseline
- **Status**: complete
- **Agent**: implementer (4th attempt, scoped to 9.1.3 only)
- **Files created**: spec/phase-9-snapshots/full-suite-baseline.json
- **Files modified**: none (no fix-chasing per phase spec)
- **Tests**: 2/2 passing (FullSuiteBaseline::snapshotExists, FullSuiteBaseline::schemaFields). Combined phase-9-sweep.test.ts result: 11/11 passing.
- **Baseline summary**: vitest 8183/8382 (199 failed, 10 skipped), playwright 470/488 (18 failed), exitCode 1. Hand-off artifact for Phase 10 acceptance triage.

## Wave 9.1 verification

- **First wave-verifier (`a24c1a8b9889c732b`)**: returned FAIL on a single rule violation — claimed `scripts/phase-9-identifier-sweep.cjs` had only 52 BANNED_IDENTIFIERS entries vs the authoritative 56 in `phase-0-identifier-audit.test.ts`, with `prevVoltage`, `prevCurrent`, `prevClockVoltage`, `math-min-700` allegedly missing. Coordinator re-audited the script: all 4 are present (lines 54, 59, 64, 78) and the script's total `id: "..."` count is 56, matching the authoritative source. The verifier had counted only single-line `{ id: "x", pattern: /y/ },` entries (52) and overlooked the 4 multi-line entries. False-positive FAIL.
- **Second wave-verifier (`a2a011494e22ddb8e`, re-run with explicit false-positive evidence in prompt)**: returned PASS. Independently confirmed the 56-entry count via `^\s*id:` grep on both files. Confirmed all 11 phase-9-sweep tests pass, 10 inventory rows transitioned correctly (only those 10), and all snapshot schemas validate.
- **Final batch state**: `group_status[9.1] = "passed"`, `verifications_passed=1`, `verifications_failed=1`, `completed=2`, `spawned=4`, `dead_implementers=3`.

## Phase 9 Complete
- **Batches**: 1 (`batch-p9-w9.1`)
- **All verified**: yes (after one false-positive FAIL, confirmed PASS on re-verify)
- **Deliverables landed**:
  - `spec/phase-9-snapshots/identifier-sweep.json` (56 banned identifiers, all zero offending paths)
  - `spec/phase-9-snapshots/citation-sample.json` (10 random samples, all 10 verified, no expansions)
  - `spec/phase-9-snapshots/full-suite-baseline.json` (8392 tests / 8183 passed / 199+18 failed / 10 skipped, exitCode=1; Phase 10 acceptance triage input)
  - `src/solver/analog/__tests__/phase-9-sweep.test.ts` (11 tests, all passing)
  - `scripts/phase-9-identifier-sweep.cjs`, `scripts/phase-9-citation-sample.cjs`, `scripts/phase-9-baseline-parser.cjs`
  - `spec/phase-9-legacy-reference-review.md` (path amendment: snapshots moved out of `test-results/` to `spec/phase-9-snapshots/` per recovery)
  - 10 row transitions (`unverified` → `verified`) in `spec/ngspice-citation-audit.json` for: C-0171, C-0230, C-0343, C-0490, C-0520, C-0558, C-0638, C-0703, C-1110, C-1165
- **Recovery cost**: 4 implementer attempts (3 dead) + 2 verifier runs (1 false-positive FAIL).
- **Commit**: deferred — working tree contains parallel user work (Phase 8 reset, tutorial HTML rearrange) that should not be bundled into the Phase 9 commit. User to decide commit scope.

## Wave 10.1: Resistive divider — interactive identify-and-fix session (2026-04-25)

- **Mode**: interactive (no implementer protocol). User explicitly asked to triage divergences and decide fixes one at a time rather than auto-file PARITY tickets.
- **Status**: PASS. `npx vitest run src/solver/analog/__tests__/ngspice-parity/resistive-divider.test.ts` → `1 passed  0 failed  0 skipped`. All `absDelta === 0` assertions hold across `rhsOld`, `state0`, `noncon`, `diagGmin`, `srcFact`, `initMode`, `order`, `delta`. NR iteration count matches ngspice exactly.

### Three blockers surfaced in order, all fixed:

**Blocker 1 — DLL path mismatch (environment).**
- `parity-helpers.ts:DLL_PATH` hard-coded `C:/local_working_projects/digital_in_browser/third_party/ngspice/bin/ngspice.dll`. No `third_party/` directory exists in the working tree. Test silently skipped (`describeIfDll` gate).
- Built DLL actually lives at `ref/ngspice/visualc-shared/x64/Release/bin/spice.dll` (6,685,696 bytes, mtime 2026-04-13, SHA256 `A24B1625E83F392DCA087A084F703D6A804A48C2D3AFA459C7F71274D476681C`). The instrumentation source (`ni_instrument_register`, `ni_topology_register`) is in `ref/ngspice/src/maths/ni/niiter.c`, so the build is the modified one — just emitted under a different name and path than `BUILD-SHARED-WIN.md` documents.
- **Fix (option B per user)**: updated `parity-helpers.ts:DLL_PATH` to point at `ref/ngspice/visualc-shared/x64/Release/bin/spice.dll`; updated `spec/phase-10-bit-exact-ngspice-parity.md` §1 "DLL presence" clause to match.

**Blocker 2 — Stale fixture envelope.**
- `resistive-divider.dts` and `diode-resistor.dts` (both pre-date the `format`/`version` envelope rollout) were missing the required `"format": "dts", "version": 1` top-level keys. Schema rejected at `dts-schema.ts:176`. The other six Phase-10 fixtures already have the envelope.
- **Fix**: appended `"format": "dts", "version": 1` to `resistive-divider.dts`. (`diode-resistor.dts` will need the same when W10.2 runs.)

**Blocker 3 — Coordinator conflated standalone `.op` with transient-boot DCOP. ARCHITECTURAL FIX, deeper than W10.1.**
- First-iteration divergence: `ours=MODETRANOP|MODEINITJCT` vs `ngspice=MODEDCOP|MODEINITJCT`.
- Trace: `comparison-session.runDcOp()` → `coordinator.initialize()` → `(this._analog as MNAEngine).transientDcop()` → sets `MODETRANOP|MODEINITJCT`. Meanwhile ngspice side ran `.op` netlist → `dcop.c::DCop` → `CKTop(MODEDCOP|MODEINITJCT, ...)`. Apples-to-oranges.
- Engine had `dcOperatingPoint()` (standalone, MODEDCOP, `analog-engine.ts:761`) AND `transientDcop()` (transient-boot, MODETRANOP, `analog-engine.ts:855`) — both correct in isolation. The coordinator only ever called the second one and exposed its cached result via `coordinator.dcOperatingPoint()`. Every public consumer of "DC operating point" (headless `getDcOpResult()`, MCP `circuit_dc_op`, AC linearization, postMessage) silently received the wrong variant.
- ngspice handles this with **no separate "initialize" step**: `CKTsetup` (once) does pure structural prep, then `CKTdoJob` dispatches each analysis directive (`.op`, `.tran`, `.ac`) and each is fully self-contained. `cktdojob.c:117` zeros `CKTdelta` between jobs; `dcop.c` runs `.op` with MODEDCOP; `dctran.c:230` runs the warm-start with MODETRANOP and writes `CKTdelta = delta` only at line 319, AFTER CKTop returns.
- **Fix landed (matches ngspice job-dispatcher semantics):**
  - **`src/solver/coordinator.ts`**: deleted `initialize()`, removed `_initialized` and `_cachedDcOpResult` fields. Added `_transientSeeded` one-shot guard. `step()` now lazily runs `engine.transientDcop()` (MODETRANOP) on first call. `dcOperatingPoint()` now calls `engine.dcOperatingPoint()` (MODEDCOP standalone `.op`) on every invocation — no caching, matches ngspice's per-job semantics. `reset()` clears `_transientSeeded` and `_analysisPhase`.
  - **`src/solver/coordinator-types.ts`**: removed `initialize(): void` from the `SimulationCoordinator` interface.
  - **`src/headless/default-facade.ts`**: removed `deferInitialize?: boolean` from `compile()` opts and the `coordinator.initialize()` call site. Updated the `setCaptureHook` doc comment.
  - **`src/solver/analog/analog-engine.ts`**: `dcOperatingPoint()` and `_transientDcop()` now zero `_timestep.currentDt` on entry, mirroring `cktdojob.c:117` reset. The first subsequent `step()` re-applies firstStep via the existing `TimestepController._isFirstGetClampedDt` branch (timestep.ts:272-282). Without this, the harness reported `delta=1e-9` (firstStep default from controller construction) during DCOP, while ngspice reports `delta=0` — surfaced as the second real divergence after the mode fix.
  - **`src/solver/analog/__tests__/harness/comparison-session.ts`**: dropped `{ deferInitialize: true }` from the `compile()` call. `_initWithCircuit` no longer pre-runs DCOP at init time. `runDcOp()` now invokes `coordinator.dcOperatingPoint()` to drive the standalone `.op` capture; `runTransient()` is unchanged (its `coordinator.step()` loop lazily seeds via the new `_transientSeeded` guard).
  - **Deleted**: `src/headless/__tests__/compile-defer-initialize.test.ts` (the entire file was a smoke test for the deleted feature).
  - **Updated**: `src/headless/__tests__/master-switch.test.ts` (3 sites), `src/solver/__tests__/coordinator-visualization.test.ts` (1 site), `src/solver/__tests__/coordinator-capability.test.ts` (2 sites), `scripts/mcp/__tests__/harness-shape-mcp.test.ts` (1 site) — removed all `{ deferInitialize: true }` arguments and `coordinator.initialize()` calls.
- **Blast radius beyond W10.1**: the architectural fix changes the contract for **every** consumer that asked for "the DC operating point" (MCP `circuit_dc_op`, headless `getDcOpResult`, AC analysis bias linearization, postMessage). They now get standalone `.op` (MODEDCOP) instead of transient-boot DCOP (MODETRANOP). Numerical results may change for circuits where the mode-bit-gated paths diverge (CKTsrcFact source scaling, MOSFET/BJT cap bookkeeping, gmin/source-stepping ladder ordering). Type-check passed; only pre-existing parse errors in unrelated `comparator.test.ts` and `analog-shape-audit.test.ts` remain. Full-suite regression check not yet run — that's owed before merging.

### Open items for the parallel session continuing W10.2..W10.8:

1. **`diode-resistor.dts` envelope**: needs the same `"format": "dts", "version": 1` footer added before W10.2 can run (will fail with the same dts-schema error otherwise).
2. **Full-suite regression sweep**: the coordinator/engine architectural fix changes the DC OP variant returned by every public surface. Run `npm test` and walk the failures to confirm none reflect actual numerical regressions vs. the Phase 9 baseline (`spec/phase-9-snapshots/full-suite-baseline.json`: 8183 passing / 199+18 failing pre-fix).
3. **No tickets filed**: per the user's interactive mode, all three W10.1 blockers were resolved live rather than written to `spec/phase-10-parity-tickets.md`. The ticket sink remains empty. Subsequent waves can either follow the same interactive cadence or revert to ticket-filing.
4. **Files touched but not yet committed**: list above (coordinator, coordinator-types, default-facade, analog-engine, comparison-session, parity-helpers, resistive-divider.dts, master-switch.test.ts, coordinator-visualization.test.ts, coordinator-capability.test.ts, harness-shape-mcp.test.ts, phase-10-bit-exact-ngspice-parity.md, plus deletion of compile-defer-initialize.test.ts).
