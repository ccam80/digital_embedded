# ngspice Compliance Session Report

**Date:** 2026-04-07
**Scope:** Review of ngspice compliance report findings, investigation of all gaps, production of diffs, and partial execution.

---

## Changes Executed

### Phase A — Items 1-2: NR convergence fixes

**Files modified:**
- `src/solver/analog/analog-engine.ts`
- `src/solver/analog/newton-raphson.ts`

**Item 1: Stale `method` variable in retry stampCompanion calls**

The `step()` method captured `const method = this._timestep.currentMethod` at entry. Inside the NR-failure and LTE-rejection retry loops, after setting `this._timestep.currentMethod = "bdf1"`, the `stampCompanion` call still passed the stale `method` variable. Companion models received the wrong integration method (e.g., trapezoidal instead of BDF-1), producing incorrect Norton equivalent stamps during retry.

Fix: Two sites in `analog-engine.ts` (~line 375 and ~466) changed `method` → `this._timestep.currentMethod` in stampCompanion calls.

**Item 2: NR maxIter floor of 100**

ngspice `NIiter` (niiter.c:37-38) unconditionally floors `maxIter` to 100: `if (maxIter < 100) maxIter = 100;`. Our transient NR calls passed `transientMaxIterations: 10` with no floor — a 10x under-iteration mismatch.

Fix: In `newtonRaphson()`, destructured `maxIterations` renamed to `rawMaxIter`, added `const maxIterations = Math.max(rawMaxIter, 100)`.

### Phase B — Items 3-7: Timestep and breakpoint handling

**Files modified:**
- `src/solver/analog/timestep.ts`
- `src/solver/analog/analog-engine.ts`

**Item 3: Initial timestep too large**

We started at `maxTimeStep` (5µs). ngspice uses `MIN(finalTime/100, userStep)/10`. Fix: Constructor now sets `currentDt = params.maxTimeStep / 100`.

**Item 4: No post-breakpoint order reset**

ngspice forces order=1 at breakpoints (dctran.c:493). Fix: `accept()` now sets `currentMethod = "bdf1"` after consuming a breakpoint.

**Item 5: No post-breakpoint delta reduction**

ngspice applies `0.1 * MIN(savedDelta, nextBreakpointGap)` after breakpoints. Fix: Added `_savedDelta` field, saved in `getClampedDt()`, applied in `accept()` after breakpoint consumption.

**Item 6: No step-equalisation before breakpoints**

ngspice splits approach into 2 equal steps when within 1.9×dt of breakpoint (dctran.c:540-542). Fix: `getClampedDt()` now checks `simTime + 1.9 * dt > nextBp` and returns `(nextBp - simTime) / 2`.

**Item 7: No order-promotion trial**

ngspice speculatively tries order=2 on accepted steps (dctran.c:820-829), keeping it only if newdelta > 1.05× current. Fix: New `tryOrderPromotion()` method on `TimestepController`, called after `checkMethodSwitch` in the step-accepted path.

### Phase C — Item 8: LTE CKTterr rewrite

**Files modified/created:**
- `src/solver/analog/ckt-terr.ts` (new)
- `src/solver/analog/timestep.ts`
- `src/solver/analog/element.ts`
- `src/solver/analog/fet-base.ts`
- `src/components/passives/capacitor.ts`
- `src/components/passives/inductor.ts`
- `src/components/semiconductors/diode.ts`
- `src/components/semiconductors/bjt.ts`
- `src/components/semiconductors/mosfet.ts`

Replaced the simplified `(dt/12) * |I_prev - I_prev_prev|` LTE formula with ngspice's CKTterr algorithm: (order+1)-th divided differences of charge history with method-specific coefficients and dual voltage/charge tolerance.

Key design: `cktTerr()` function is completely allocation-free — 10 scalar `number` params (including q0, q1, q2 instead of an array), unrolled divided differences for order=1 and order=2, scalar locals only. `computeNewDt` returns via pre-allocated `_lteResult` object.

Each of the 5 core devices (capacitor, inductor, diode, BJT, MOSFET) gained charge/flux history slots in their state schemas and a `getLteTimestep` method that calls `cktTerr` with scalar params. The old `getLteEstimate` interface was removed from `computeNewDt` (no legacy fallback).

New infrastructure in `TimestepController`: `_deltaOld` (timestep history), `currentOrder` (numeric integration order), `_lteParams` (pre-allocated tolerance params).

### Phase E — Item 11: stampLinear hoist + NR allocation cleanup

**Files modified:**
- `src/solver/analog/sparse-solver.ts`
- `src/solver/analog/newton-raphson.ts`
- `src/components/semiconductors/bjt.ts`
- `src/components/semiconductors/mosfet.ts`

**stampLinear hoist:** Linear element stamps (resistors, voltage sources) produce identical matrix entries every NR iteration. Hoisted `stampLinear` before the NR loop. Added CSC-level save/restore checkpoint: `captureLinearRhs()`, `saveLinearBase(linearCooCount)`, `restoreLinearBase()`. Subsequent iterations restore the linear base and only re-stamp nonlinear contributions. `_refillCSC(cooStart)` does partial scatter for nonlinear COO entries only.

**pnjlim reusable result:** Replaced per-call `return { value, limited }` allocation with module-level `_pnjlimResult` object, mutated and returned. Callers in bjt.ts (×2) and mosfet.ts refactored to extract `.value`/`.limited` before the second `pnjlim` call.

**trace gating:** Added `enableTrace?: boolean` to `NROptions`. When false (default), `trace.push(_makeTrace(...))` and oscillation detection are skipped entirely — zero per-iteration object allocation.

### Phase F — Item 12: Convergence logging system

**Files modified/created:**
- `src/solver/analog/convergence-log.ts` (new)
- `src/solver/analog/analog-engine.ts`
- `src/core/analog-engine-interface.ts`
- `src/solver/coordinator-types.ts`
- `src/solver/coordinator.ts`
- `src/solver/null-coordinator.ts`
- `src/headless/default-facade.ts`
- `scripts/mcp/simulation-tools.ts`
- `src/io/postmessage-adapter.ts`
- `src/test-utils/mock-coordinator.ts`
- `src/core/__tests__/analog-engine-interface.test.ts`

Boolean-gated ring buffer (`ConvergenceLog`, 128-slot capacity). `StepRecord` captures per-step data: entry/exit dt, method, all NR attempts (iterations, converged, blame element/node, trigger), LTE stats, outcome. `NRAttemptRecord` per NR call. 12 instrumentation sites in `step()`, all gated by `const logging = this._convergenceLog.enabled`.

Surfaced through all layers:
- Coordinator: `supportsConvergenceLog()`, `setConvergenceLogEnabled()`, `getConvergenceLog(lastN?)`, `clearConvergenceLog()`
- Facade: 3 pass-through methods
- MCP: `circuit_convergence_log` tool (enable/disable/read/clear)
- postMessage: `sim-convergence-log` → `sim-convergence-log-data`

Zero-cost when disabled (~0.5ns/step — single boolean read + branch-predicted-away checks).

---

## Known Issue: Buck BJT Convergence Regression

The buck BJT circuit now fails to converge at step 0 in the UI. Before this session's changes, it ran at ~300ms/s. The compliance report noted it was failing at step 7/5µs — the changes made it worse, not better.

Likely cause: The combination of Phase B's 100× smaller initial timestep (item 3) with the maxIter floor of 100 (item 2) means the first step now has dt=50ns and allows 100 NR iterations. If the DC operating point is marginal, the first transient step from that OP may diverge. The convergence logging system is now in place to diagnose exactly what's happening — enable it and read the step-0 record.

The DC-OP algorithm itself is also wrong (items 14-16 below) — we use `spice3_gmin` fixed-decade stepping instead of ngspice's default `dynamic_gmin` with adaptive backtracking. A bad DC operating point poisons all subsequent transient steps.

---

## Test Failures Inventory

Tests that are currently failing (causes are mixed — maxIter floor, trace gating, schema size changes, LTE interface change, initial timestep change):

### newton-raphson.test.ts
- `reports_non_convergence`
- `max_iterations_declared_failed`
- `convergence_trace_populated`

### dc-operating-point.test.ts
- 3 failures (trace-dependent assertions and/or maxIter floor)

### timestep.test.ts
- `safety_factor_0_9`
- `largest_error_element_tracked`
- 1 additional (mock elements use `getLteEstimate` not `getLteTimestep`)

### passives/__tests__/
- Capacitor stateSize (expects 6, now 9)
- Inductor stateSize (expects 4, now 7)

### buckbjt-convergence.test.ts
- `survives 600µs of sim time`

### Semiconductor state schema tests
- bjt.test.ts: `stateSize_is_24` (expects 24, now larger due to charge slots)
- bjt.test.ts: `stateSchema_size_equals_stateSize`
- diode-state-pool.test.ts: `stateSize is 8 when CJO > 0` (expects 8/10, now 11/13)
- diode-state-pool.test.ts: `stateSize is 8 when TT > 0`
- diode-state-pool.test.ts: `stateSchema is DIODE_CAP_SCHEMA`

### E2E (Playwright)
- 7 failures reported in original compliance report, likely worsened by step-0 convergence regression

---

## Remaining Work

### CRITICAL: DC-OP Algorithm Replacement (Items 14-16)

Our DC-OP fallback chain implements the WRONG algorithms. `spice3_gmin` (fixed decade steps) is NOT ngspice's default — it only fires when user sets `.options gminsteps >= 2`. The default is `dynamic_gmin` → `new_gmin` → `gillespie_src`.

**Complete diff spec at:**
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\3fdda0b0-56be-4764-a53e-f861470ca2aa\tasks\a39c1882efca3448f.output`

ngspice default fallback chain:

| Step | Algorithm | Mechanism |
|------|-----------|-----------|
| 0 | Direct NR | — |
| 1a | `dynamic_gmin` | Adaptive diagonal shunting with backtracking |
| 1b | `new_gmin` | Adaptive device-level CKTgmin with backtracking (if 1a fails) |
| 2 | `gillespie_src` | Adaptive source stepping starting at 0.1%, backtracking |

Our current chain:

| Step | Algorithm | Problem |
|------|-----------|---------|
| 0 | Direct NR | Match |
| 1 | `spice3_gmin` | Fixed decades, no backtracking — WRONG ALGORITHM |
| 2 | Fixed 10% source stepping | No adaptivity, no backtracking — WRONG ALGORITHM |

Diff covers:
- `src/core/constants.ts` — shared mutable `deviceGmin` (ES module live binding, mirrors ngspice `ckt->CKTgmin`)
- `src/solver/analog/dc-operating-point.ts` — complete rewrite with `dynamic_gmin`, `new_gmin`, `gillespie_src`
- `src/core/analog-engine-interface.ts` — `DcOpResult.method` union extended
- 13 device files — one-line change each: `const GMIN = 1e-12` → `import { deviceGmin as GMIN } from "../../core/constants.js"` (live binding)
- Pre-allocated buffers: 4 × Float64Array at DC-OP entry, zero mid-solve allocation
- `setDeviceGmin()` wrapped in try/finally for `new_gmin` to guarantee reset

### LTE Device Migration (5 remaining devices)

Devices with charge/flux storage that lack `getLteTimestep`:

| Device | File | Sub-models |
|--------|------|-----------|
| Polarized Cap | `polarized-cap.ts` | 1 capacitor |
| Crystal | `crystal.ts` | 2 caps (C_s, C_0) + 1 inductor (L_s) |
| Transformer | `transformer.ts` | 2 coupled inductors (schema already has history — just needs method) |
| Tapped Transformer | `tapped-transformer.ts` | 3 coupled inductors (+3 prev-prev slots needed) |
| Varactor | `varactor.ts` | 1 voltage-dependent cap |

**Survey and old-interface diffs at:**
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\3fdda0b0-56be-4764-a53e-f861470ca2aa\tasks\ae09f16d92e62e5bc.output`

NOTE: These diffs use the old `getLteEstimate` interface. They need regeneration against `getLteTimestep` + `cktTerr` (charge-based slots instead of current-based, scalar cktTerr calls). The device classification (which 5 need it, which 11 don't) is correct and reusable.

Transmission line was skipped: composite element with private sub-elements not visible to the engine's element iteration. Needs the outer element to aggregate LTE across N segments internally — separate architectural work.

### Convergence Log UI Panel

The convergence logging system is implemented across headless, MCP, and postMessage surfaces. The UI panel is NOT implemented. The postMessage contract is in place:

- Parent → iframe: `sim-convergence-log` with `{ action: 'enable' | 'disable' | 'read' | 'clear', lastN?: number }`
- Iframe → parent: `sim-convergence-log-data` with `{ records: StepRecord[], enabled: boolean }`

The panel should:
1. Send `sim-convergence-log` with `action: 'enable'` when opened
2. Poll or hook into step observer to read data
3. Display: step index, iteration count, converged, dt, method, LTE ratio
4. Show NR attempt details on expand/click

### Trace Array Cleanup

The `ConvergenceTrace[]` array in `NRResult` is a partially completed feature. Investigation found:
- Full array accumulated per NR call, only `trace[trace.length - 1]` ever read
- Two live reads: `largestChangeElement` (transient failure blame) and `largestChangeNode` (DCOP failure blame)
- `oscillating` field: computed, never read by any consumer
- `fallbackLevel` field: typed as 3-value union, hard-coded to `"none"` everywhere

Recommended cleanup: Move `blameElement` and `blameNode` to scalar fields on `NRResult`. Remove `ConvergenceTrace` type, `_makeTrace` function, and `trace` array. The new convergence logging system supersedes the original intent.

**Trace investigation at:**
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\3fdda0b0-56be-4764-a53e-f861470ca2aa\tasks\a3d9e16d60046b413.output`

### `timestep.reject()` Dead Code (Item 10)

The `reject()` method on `TimestepController` is no longer called — LTE rejection uses `newDt` directly. Can be deleted.

### Incorrect `isReactive: true` Flags

Several devices declare `isReactive: true` but have no `stampCompanion` — they waste a check per element per step in `computeNewDt`. Identified: tunnel diode, SCR, triac, LED (simplified), zener (simplified).

---

## Reference: All Investigation Agent Outputs

| Agent | Topic | Output File |
|-------|-------|-------------|
| NIiter maxIter verification | Confirmed ngspice floors to 100 | `tasks/a03db24be62aa65c6.output` |
| Buck BJT convergence trace | H2 (stale method) + H4 (maxIter) root causes | `tasks/a186578b60f9efe7f.output` |
| LTE CKTterr specification | Full algorithm + device mapping | `tasks/af1557ea1a835692b.output` |
| Device GMIN audit | 15 files with hardcoded GMIN, ngspice CKTgmin/CKTdiagGmin distinction | `tasks/a469b8bb0239981d5.output` |
| Initial timestep/breakpoints | 4 gaps: init dt, order reset, delta reduction, step equalisation | `tasks/a66a74aa2e1b56d32.output` |
| Integration order promotion | Speculative order-2 trial missing | `tasks/a529aa0a8d93616b2.output` |
| Sweep for missed items | 17 additional items triaged (4 genuinely new) | `tasks/a15409593aaa0fd77.output` |
| GMIN fidelity + alloc audit | Per-device copy is WRONG; diagonal approach correct; CKTgmin is static | `tasks/a5ca2c6480107f86c.output` |
| Gmin fallback chain verification | dynamic_gmin + new_gmin + gillespie_src are DEFAULT path | `tasks/a56d762d62524ee52.output` |
| stampLinear alloc audit | subarray() views in hot loop, pnjlim alloc, trace alloc | `tasks/adf9440a9bf32046f.output` |
| LTE alloc audit | 14 hot-path allocations; fix: scalar params + unrolled div-diff | `tasks/a2b57a4b6b3531efc.output` |
| Convergence logging design | Ring buffer + 12 instrumentation sites + zero-cost gating | `tasks/ad5e4b9f3691c439a.output` |
| Logging surface design | Coordinator/facade/MCP/postMessage patterns | `tasks/a4ea83fc17c65b904.output` |
| Trace investigation | Partially completed feature, replace with blame scalars | `tasks/a3d9e16d60046b413.output` |
| LTE device migration survey | 5 devices need it, 11 don't, transmission line deferred | `tasks/ae09f16d92e62e5bc.output` |

## Reference: All Diff Agent Outputs

| Agent | Scope | Output File |
|-------|-------|-------------|
| Phase A diffs (items 1-2) | stale method + maxIter floor | `tasks/a2a47966e8bf43b23.output` |
| Phase B diffs (items 3-7) | timestep/breakpoint gaps | `tasks/a229a652b9b7a3f96.output` |
| Original LTE diff (item 8) | First version, had 14 allocations | `tasks/afad7f207d8785536.output` |
| Revised LTE diff (item 8) | Allocation-free with scalar params | `tasks/aebd7b8c5af53803a.output` |
| Original GMIN diff (item 9) | **CANCELLED** — per-device setParam approach was wrong | `tasks/abfcc7c5f69a41665.output` |
| Original stampLinear diff (item 11) | First version, had subarray() allocs | `tasks/a98c46fb4ff4f5bb0.output` |
| Revised stampLinear diff (item 11) | CSC-level + pnjlim + trace gating | `tasks/aa6b28f5fccb0d8a9.output` |
| Convergence logging diffs (item 12) | All 9 change groups, all surfaces | `tasks/af140c2a0fbbc9df0.output` |
| DC-OP algorithm design (items 14-16) | dynamic_gmin + new_gmin + gillespie_src + shared deviceGmin | `tasks/a39c1882efca3448f.output` |
| LTE device migration survey | 5 devices + old-interface diffs | `tasks/ae09f16d92e62e5bc.output` |

All output files are in:
`C:\Users\cca79\AppData\Local\Temp\claude\C--local-working-projects-digital-in-browser\3fdda0b0-56be-4764-a53e-f861470ca2aa\tasks\`
