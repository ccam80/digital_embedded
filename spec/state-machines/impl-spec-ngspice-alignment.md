# ngspice Alignment Implementation Spec

## Governing Principles

1. **100% numerical alignment with ngspice default build** (no PREDICTOR, no WANT_SENSE2, no CLUSTER, no SHARED_MODULE). Same formula, same operands, same operation order within IEEE-754 rounding.
2. **Zero allocations in hot paths.** No `new`, no object literals, no closures, no array methods that allocate (`.filter`, `.map`, `.slice`, `.spread`) inside NR iterations, per-step code, or per-device-load code. All buffers and scratch objects pre-allocated at compile/init time, mutated in place.
3. **Single device load function.** The split of `updateOperatingPoint` / `stamp` / `stampNonlinear` / `stampReactiveCompanion` is replaced by a single `load(ckt)` call per device, matching ngspice's `DEVload`. All ~55 analog element implementations must be rewritten.
4. **Only permitted additions over ngspice:** convergence logging, diagnostics emission, blame tracking. Everything else (method switching, extra clean solves, extra mode transitions) that has no ngspice counterpart must be removed.
5. **No objects-as-return-values in hot paths.** Functions that ngspice implements as void+pointer-mutation must use pre-allocated mutable result structs, not freshly allocated object literals.

---

## Phase 1: Zero-Alloc Infrastructure + Sparse Solver Alignment

### Wave 1A: Pre-allocated result structs

**Goal:** Eliminate every per-call allocation in NR, integration, LTE, and DC-OP paths.

| Current allocation | File:line | Fix |
|---|---|---|
| `newtonRaphson` returns `{ converged, iterations, voltages, ... }` | newton-raphson.ts:481,542,561,678,724 | Pre-allocate `NRResult` struct on `MNAEngine` at compile time. `newtonRaphson` writes into it via mutation. Caller reads fields. |
| `new MNAAssembler(solver)` per NR call | newton-raphson.ts:442 | Allocate once on `MNAEngine` at compile. Pass to `newtonRaphson`. |
| `new Float64Array(matrixSize)` for voltages/prevVoltages buffers | newton-raphson.ts:447,449 | Already mitigated via optional buffer params. Make MANDATORY — caller must always provide. Remove fallback `new`. |
| `convergenceFailedElements = []` per iteration | newton-raphson.ts:575 | Pre-allocate fixed-size array on assembler. Reset length to 0 each iteration. |
| `integrateCapacitor`/`integrateInductor` return `{ geq, ceq, ccap, ag0 }` | integration.ts:35,77,96,137 | Convert to void functions writing into pre-allocated result struct per element. Or inline into device `load()`. |
| `computeIntegrationCoefficients` returns `{ ag0, ag1 }` | integration.ts:476,479,493,499 | Eliminate function — coefficients already computed by `computeNIcomCof` into `ag[]` array. |
| `solveGearVandermonde` allocates `mat[][]` per call | integration.ts:351-355 | Pre-allocate 7x7 flat `Float64Array(49)` on engine at compile time. Pass as scratch buffer. |
| NR options object `{ solver, elements, ... }` per step | analog-engine.ts:425-451 | Pre-allocate `NROptions` struct on engine. Mutate fields before each NR call. |
| `preIterationHook` closure per step | analog-engine.ts:443-450 | Bind once at compile time as engine method. Set on pre-allocated options struct. |
| `elements.filter(isPoolBacked)` per step | analog-engine.ts:347 | Pre-compute filtered list at compile time. Store on engine. |
| `(t) => this._timestep.addBreakpoint(t)` per element per step | analog-engine.ts:661 | Bind once at compile time as engine method. |
| `new Float64Array(matrixSize)` x20+ in dc-operating-point.ts | dc-operating-point.ts:663,669,670,801,879,951,958,959,etc. | Pre-allocate all DC-OP scratch buffers at compile time on the engine/coordinator. Pass as params. |
| DC-OP result objects | dc-operating-point.ts:493,527,567,607 | Pre-allocate single `DcOpResult` struct. Mutate and return reference. |
| `nrBase` / `ladder` objects per DC-OP call | dc-operating-point.ts:398,449 | Pre-allocate at compile time. Mutate fields per call. |
| `stepRec = { ... }` with `attempts: []` | analog-engine.ts:317-329 | Logging-only — permitted but must use pre-allocated pool. |

### Wave 1B: Sparse solver alignment (SMPpreOrder / NISHOULDREORDER / E_SINGULAR)

**ngspice reference:** niiter.c:844-901

**Current state:** `preorder()` is a no-op. `NISHOULDREORDER` lifecycle managed internally by solver. E_SINGULAR recovery re-factors without re-loading.

**Fixes:**

1. **`preorder()` must do real diagonal column swap.** ngspice `SMPpreOrder` (sppreord.c) swaps columns so that the largest element in each row lands on the diagonal. Our `preorder()` in sparse-solver.ts must implement this. Called once, gated by `didPreorder` flag.
   - ngspice ref: niiter.c:844-854
   - Our file: src/solver/analog/sparse-solver.ts — find `preorder()` method

2. **NISHOULDREORDER flag lifecycle must be explicit.** Currently our solver internally decides when to reorder. Must match ngspice:
   - Set on `MODEINITJCT` entry: niiter.c:856-858
   - Set on `MODEINITTRAN` when `iterno <= 1`: niiter.c:1073
   - Cleared after successful reorder: niiter.c:880
   - Our file: newton-raphson.ts — add explicit `solver.forceReorder()` calls at these exact points

3. **E_SINGULAR recovery must re-load then re-factor.** ngspice sets `NISHOULDREORDER` and does `continue` (returns to top of for(;;), re-executes CKTload). Our code at newton-raphson.ts:530-533 only re-factors without re-loading.
   - ngspice ref: niiter.c:888-891
   - Our file: newton-raphson.ts:530-534
   - Fix: on E_SINGULAR, set reorder flag AND `continue` to restart from CKTload (stamp all devices again)

---

## Phase 2: NR Loop Alignment (NIiter)

### Wave 2A: NIiter structural alignment

**ngspice reference:** niiter.c:608-1095
**Our file:** newton-raphson.ts:435-724

**Signature change:** `newtonRaphson` becomes a void function writing into pre-allocated `NRResult`. Takes pre-allocated `NROptions` struct by reference.

**Exact fixes (by ngspice line):**

| ngspice line | What | Our fix |
|---|---|---|
| 622 | `maxIter = max(maxIter, 100)` | Keep but verify `exactMaxIterations` gate. newton-raphson.ts:439 |
| 657 | `CKTnoncon=0` | Match. Already done at mna-assembler.ts via `assembler.noncon = 0`. Keep. |
| 660 | `ni_limit_reset()` | Match. Already done. Keep. |
| 662-666 | `#ifdef NEWPRED ... if(1)` | No NEWPRED. Always enter. Match. |
| 667 | `CKTload(ckt)` | **CRITICAL: Must be single `load()` call per device. See Phase 3.** |
| 670 | `iterno++` | Our `iteration` counter in for-loop header. Match. |
| 844-854 | Preorder gate | Add real preorder. See Wave 1B. |
| 856-858 | NISHOULDREORDER on initJct/initTran | Add explicit `solver.forceReorder()`. newton-raphson.ts — after INITF dispatcher |
| 861-901 | Factor: reorder vs numeric, E_SINGULAR | Fix E_SINGULAR to re-load+re-factor. See Wave 1B. |
| 906-909 | Save OldCKTstate0 for damping | Already done at newton-raphson.ts:547-551. Verify allocation is one-time. |
| 927 | `SMPsolve` | Match via `solver.solve(voltages)`. Keep. |
| 940-942 | Ground node zeroing | Verify solver handles this. |
| 944-955 | Iteration limit check | Match. newton-raphson.ts:560-561. Fix return to mutate pre-allocated result. |
| 957-961 | Convergence check: `noncon==0 && iterno!=1` | **DIFF:** ngspice checks `iterno!=1` (skips convergence on first iteration after load). Ours checks `iteration === 0` and forces `noncon = 1`. Verify equivalence — ngspice `iterno` is 1 after first load (incremented at line 670 before this check), so `iterno!=1` means "not the first load". Our `iteration === 0` also means "first load". MATCH. |
| 958 | `NIconvTest(ckt)` | Our inline convergence loop. Match formula. Already mostly aligned except: |
| — | — NIconvTest short-circuits on first failure | Ours continues to track largest change. **Acceptable** (our addition is blame tracking). |
| 1020-1043 | Newton damping | Already aligned at newton-raphson.ts:613-631. Verify `isDcOp` gate matches `MODETRANOP || MODEDCOP`. |
| 1050-1084 | INITF dispatcher | Verify all mode transitions match. See detailed check below. |
| 1088-1090 | Swap RHS vectors | Match at newton-raphson.ts:718-720. |

**INITF dispatcher detailed check:**

| ngspice mode | ngspice action | Our action | Status |
|---|---|---|---|
| MODEINITFLOAT | if noncon==0: return OK | if noncon===0 && globalConverged && elemConverged: return converged | **MATCH** — NEWCONV IS defined by default (`macros.h:19`), so ngspice NIconvTest calls `CKTconvTest(ckt)` which iterates `DEVconvTest` per device. Our `elemConverged` via `checkAllConverged` is the correct equivalent. The combined `noncon===0 && globalConverged && elemConverged` check matches ngspice's `noncon==0` (which includes the CKTconvTest result assigned back to noncon at niconv.c:69-72). |
| MODEINITFLOAT + hadNodeset | if ipass: noncon=ipass; ipass=0 | if ipass>0: ipass--; noncon=1 | **DIFF** — ngspice zeros ipass in one shot; ours decrements. ngspice sets noncon=ipass (which is 1); ours sets noncon=1. Net effect: ngspice runs one extra iteration after initFix→initFloat transition. Ours also runs one extra (ipass goes 1→0). **Actually equivalent** for ipass=1 case. But ngspice also gates on `hadNodeset` — we don't. Must add `hadNodeset` gate. |
| MODEINITJCT | mode = initFix; NISHOULDREORDER | initMode = "initFix"; forceReorder() | Match |
| MODEINITFIX | if noncon==0: mode = initFloat; ipass=1 | Same | Match |
| MODEINITSMSIG | mode = initFloat | Same | Match |
| MODEINITTRAN | if iterno<=1: NISHOULDREORDER; mode=initFloat | if iteration<=0: forceReorder; initMode=initFloat | **DIFF** — ngspice `iterno<=1` vs ours `iteration<=0`. ngspice iterno is 1 after first CKTload (incremented at line 670). Our iteration is 0 on the first pass through the loop. So ngspice triggers reorder when iterno=1 (first pass). Ours triggers when iteration=0 (first pass). **MATCH.** |
| MODEINITPRED | mode = initFloat | Same | Match |

### Wave 2B: pnjlim / fetlim numerical fixes

**pnjlim — ngspice ref:** devsup.c DEVpnjlim
**Our file:** newton-raphson.ts:282-314

| Line | Bug | Fix |
|---|---|---|
| 287 | `const arg = (vnew - vold) / vt` — missing `+1` | Fix to `const arg = 1 + (vnew - vold) / vt` |
| 289 | `vnew = vold + vt * (2 + Math.log(arg - 2))` | Fix to `vnew = vold + vt * (2 + Math.log(arg))` (since arg already includes +1) |
| 291 | `vnew = vold - vt * (2 + Math.log(2 - arg))` | Fix to match ngspice: `vnew = vold - vt * (2 + Math.log(2 - arg))` where arg = 1 + delta/vt, so 2-arg = 1 - delta/vt. Verify. |

**fetlim — ngspice ref:** devsup.c DEVfetlim
**Our file:** newton-raphson.ts:339-381

| Line | Bug | Fix |
|---|---|---|
| 341 | `const vtstlo = Math.abs(vold - vto) + 1` | Fix to `const vtstlo = vtsthi / 2 + 2` matching ngspice exactly |

### Wave 2C: CKTload replacement (MNAAssembler → single-pass)

**ngspice reference:** cktload.c:29-158
**Our files:** mna-assembler.ts:54-82, newton-raphson.ts:494-512

**Current split-pass order in stampAll:**
1. `updateOperatingPoint(voltages)` — all nonlinear, iteration > 0 only
2. `stamp(solver)` — all elements
3. `stampNonlinear(solver)` — nonlinear elements
4. `stampReactiveCompanion(solver)` — reactive elements
5. `solver.finalize()` — COO→CSC rebuild

**ngspice CKTload order per device:**
1. Read node voltages from CKTrhsOld
2. Apply voltage limiting (ALL iterations including iter 0 for junction init)
3. Evaluate device equations
4. Stamp conductance matrix + RHS
5. Call NIintegrate for reactive elements (companion model)
6. Set CKTnoncon if limiting occurred
— then after ALL devices:
7. Apply nodesets/ICs (if DC mode + initJct/initFix)

**Required change:**
- Element interface gets single `load(ctx: LoadContext): void` method
- `LoadContext` is a pre-allocated struct containing: solver, voltages (CKTrhsOld), iteration number, initMode, dt, method, order, deltaOld, ag[], limitingCollector, srcFact
- Each device's `load()` does ALL of: read voltages → limit → evaluate → stamp → integrate
- The assembler loop becomes: clear matrix, for each element call `element.load(ctx)`, finalize
- Nodesets/ICs applied AFTER device loop, inside CKTload, not as separate step
- `CKTnoncon` incremented inside each device's `load()` when limiting occurs

**Impact:** All ~55 analog element implementations must be rewritten. This is the largest single change.

---

## Phase 3: Numerical Fixes

### Wave 3A: ckt-terr.ts formula fixes

**ngspice reference:** cktterr.c, ckttrunc.c (NEWTRUNC)
**Our file:** src/solver/analog/ckt-terr.ts

| Bug ID | Line | Fix |
|---|---|---|
| C1 | 163 | chargetol: change `Math.max(params.reltol * Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol)` to `params.reltol * Math.max(Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol)` |
| C2 | 152 | cktTerr GEAR factor: change `order <= 1 ? GEAR_LTE_FACTOR_0 : GEAR_LTE_FACTOR_1` to `GEAR_LTE_FACTORS[Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)]` |
| V5 | 277-296 | cktTerrVoltage GEAR formula: rewrite to match ngspice NEWTRUNC GEAR: `tmp = (tol * trtol * delsum) / (diff * delta)` where `delsum = sum(deltaOld[0..order])`. Then root by `order+1`. Then multiply by `delta`. |
| V6 | 302-307 | cktTerrVoltage root index: GEAR order 1 must take sqrt. GEAR order>=2 must use `exp(log(tmp)/(order+1))` not `exp(log(del)/order)`. |
| V3 | 296 | cktTerrVoltage TRAP order 1: must include `deltaOld[0] * sqrt(|trtol * tol * 2 / diff|)` scaling. |
| V4 | 296 | cktTerrVoltage TRAP order 2: must use `|deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff|` formula. |

**Decision on cktTerrVoltage algorithm:** Our divided-difference approach (V1) diverges from ngspice's predictor-corrector approach. Since PREDICTOR is undef'd, the NEWTRUNC code that uses `CKTpred` is also dead in default ngspice builds. The non-NEWTRUNC path (plain CKTterr applied per-device via DEVtrunc function pointers) is what runs. Our cktTerrVoltage is only called for elements that don't have charge-based LTE (voltage-only elements). **If no default-build ngspice device uses the NEWTRUNC voltage path, then cktTerrVoltage's algorithm choice is moot — only cktTerr matters.** Must verify which ngspice devices use DEVtrunc vs which rely on NEWTRUNC.

### Wave 3B: Integration coefficient fixes

**ngspice reference:** nicomcof.c:17-127, niinteg.c:17-80
**Our files:** src/solver/analog/integration.ts

| Bug | Line | Fix |
|---|---|---|
| NIcomCof trap order 2 rounding | integration.ts:434 | Change `1 / (dt * (1 - xmu))` to `1.0 / dt / (1.0 - xmu)` to match ngspice operand grouping |
| NIintegrate trap order 2 ccapPrev coefficient | integration.ts:53,114 | Change `- ccapPrev` to `- ag1 * ccapPrev` where `ag1 = xmu / (1 - xmu)`. Currently only correct when xmu=0.5. |
| `computeIntegrationCoefficients` ag1 | integration.ts:480-483 | Fix `ag1: -ag0` to `ag1: xmu / (1 - xmu)` for trap order 2. Or better: eliminate this function entirely — it duplicates `computeNIcomCof` with bugs. |
| `solveGearVandermonde` mat allocation | integration.ts:351-355 | Use pre-allocated flat Float64Array(49) scratch buffer instead of per-call `new Array` |

### Wave 3C: Convert integration functions to zero-alloc

`integrateCapacitor` and `integrateInductor` currently return `{ geq, ceq, ccap, ag0 }` objects. Since these will be folded into the unified device `load()` function (Phase 2, Wave 2C), the return-object pattern disappears — the device writes directly into its own pre-allocated state and stamps the solver directly. No separate fix needed if Phase 2 is done first.

---

## Phase 4: DC Operating Point Alignment

### Wave 4A: CKTop / DCop flow fixes

**ngspice reference:** cktop.c:27-86, dcop.c:21-84
**Our file:** src/solver/analog/dc-operating-point.ts

| Bug | ngspice ref | Our line | Fix |
|---|---|---|---|
| `CKTnoncon = 1` before NIiter | cktop.c:170 | MISSING | Add `assembler.noncon = 1` before each NR call in gmin/src stepping loops |
| Missing `hadNodeset` gate on ipass | niiter.c:1051-1052 | newton-raphson.ts:667 | Add check: only do ipass logic when DC mode AND hadNodeset is true |
| dcopFinalize sets `initMode = "transient"` | NOT IN NGSPICE | dc-operating-point.ts:330 | Remove this line |
| XSPICE `conv_debug.last_NIiter_call` | cktop.c:40-43,79,244-247 | MISSING | Map to our diagnostics system. These flags control XSPICE convergence debug output — implement as diagnostic flags, not numerical. |

### Wave 4B: dynamic_gmin fixes

**ngspice reference:** cktop.c:133-269
**Our file:** dc-operating-point.ts:652-767

| Bug | ngspice ref | Our line | Fix |
|---|---|---|---|
| Initial diagGmin is `oldGmin` not `oldGmin/factor` | cktop.c:164 | dc-operating-point.ts:677 | Change `let diagGmin = oldGmin` to `let diagGmin = oldGmin / factor` |
| Factor adaptation caps at literal 10, not gminFactor | cktop.c:198-199 | dc-operating-point.ts:716 | Change `Math.min(factor * Math.sqrt(factor), 10)` to `Math.min(factor * Math.sqrt(factor), params.gminFactor ?? 10)` (use actual param, not hardcoded) |
| Clean solve uses dcTrcvMaxIter (50) instead of iterlim (dcMaxIter=100) | cktop.c:253 | dc-operating-point.ts:753-759 | Change `maxIterations: params.dcTrcvMaxIter` to `maxIterations: params.maxIterations` (dcMaxIter) |
| Zero-alloc: `new Float64Array(matrixSize)` for voltages/saved | dc-operating-point.ts:663,669,670 | Pre-allocate on coordinator at compile time. Pass as scratch buffers. |

### Wave 4C: spice3_gmin fixes

**ngspice reference:** cktop.c:284-356
**Our file:** dc-operating-point.ts:790-858

| Bug | ngspice ref | Our line | Fix |
|---|---|---|---|
| Initial diagGmin ignores gshunt | cktop.c:295-298 | dc-operating-point.ts:811 | Change `let diagGmin = params.gmin` to `let diagGmin = (params.gshunt ?? 0) === 0 ? params.gmin : (params.gshunt ?? 0)` |
| Zero-alloc | dc-operating-point.ts:801,831,858 | Pre-allocate scratch buffers |

### Wave 4D: gillespie_src fixes

**ngspice reference:** cktop.c:369-569
**Our file:** dc-operating-point.ts:940-1093

| Bug | ngspice ref | Our line | Fix |
|---|---|---|---|
| Missing explicit diagGmin=gshunt reset after bootstrap | cktop.c:457 | dc-operating-point.ts:~1003 | Add `diagGmin = params.gshunt ?? 0` after bootstrap loop exit |
| srcFact initialization: ngspice `ConvFact + raise` vs ours `raise` | cktop.c:475 | dc-operating-point.ts:1019 | Verify: ngspice ConvFact=0 at this point so ConvFact+raise = raise. Our `srcFact = raise` should match. Actually — ngspice line 475 runs AFTER the zero-source convergence, where ConvFact was set at line 462-476. Need to trace the exact ConvFact value. If zero-source converged without bootstrap, ConvFact remains 0 (set at line 387). If bootstrap was needed, ConvFact is still 0 (bootstrap doesn't set it). So `ConvFact + raise = 0 + 0.001 = raise`. MATCH. |
| Zero-alloc | dc-operating-point.ts:951,958,959,1006,1093 | Pre-allocate scratch buffers |

### Wave 4E: spice3_src fixes

**ngspice reference:** cktop.c:582-628
**Our file:** dc-operating-point.ts:869-927

| Bug | ngspice ref | Our line | Fix |
|---|---|---|---|
| Extra final clean solve not in ngspice | NOT IN NGSPICE | dc-operating-point.ts:914-927 | **Remove entirely.** ngspice spice3_src returns directly after the stepping loop. |
| Zero-alloc | dc-operating-point.ts:879,902,927 | Pre-allocate scratch buffers |

---

## Phase 5: Transient Step Alignment (DCtran)

### Wave 5A: analog-engine.ts step() alignment

**ngspice reference:** dctran.c:715-973 + acceptance at ~386-489
**Our file:** src/solver/analog/analog-engine.ts:256-670

| Fix | ngspice ref | Our line | Detail |
|---|---|---|---|
| Remove `checkMethodSwitch` call | NOT IN NGSPICE | analog-engine.ts:638 | Remove entirely. ngspice has no runtime method switching. `CKTintegrateMethod` is set once. |
| Remove BDF-2 history push loop | NOT IN NGSPICE | analog-engine.ts:612-621 | Remove entirely. Only existed to support method switching. |
| Remove `_signHistory`, `_stableOnBdf2` fields | NOT IN NGSPICE | analog-engine.ts (fields) | Remove. |
| Fix initial integration method | dctran.c default TRAPEZOIDAL | timestep.ts:150 | Change `this.currentMethod = "bdf1"` to `this.currentMethod = "trapezoidal"`. Remove "bdf1" as a method option — ngspice GEAR order 1 IS BDF-1, but the default is TRAPEZOIDAL, not GEAR. |
| Implement XSPICE breakpoint backup | dctran.c:830-846 | analog-engine.ts — after NR convergence check | Add `else if` branch: if a breakpoint was overshot (simTime > next breakpoint), back up time and retry with dt = breakpoint - prevTime. Set order = 1. |
| Remove `updateChargeFlux` separate loop | dctran.c — handled inside DEVload | analog-engine.ts:506-510 | Remove. Charge/flux updates are part of unified `load()`. |
| Remove `stampCompanion` pre-NR loop | dctran.c — handled inside DEVload | analog-engine.ts:418-422 | Remove. Companion stamping is part of unified `load()`. |
| Remove `updateCompanion` post-accept loop | dctran.c — inside DEVaccept | analog-engine.ts:645-649 | Fold into `acceptStep` or unified accept pass. |
| Remove `updateState` post-accept loop | dctran.c — inside DEVaccept | analog-engine.ts:652-656 | Fold into `acceptStep`. |
| Fix preIterationHook to not be a closure | analog-engine.ts:443-450 | Bind as engine method at compile time. Pre-set on NROptions struct. |
| Remove `elements.filter(isPoolBacked)` per step | analog-engine.ts:347 | Pre-compute at compile time. |
| Fix olddelta placement | dctran.c:740 | analog-engine.ts:337,583 | Currently equivalent but verify semantics match ngspice's "top of retry iteration" placement. |

### Wave 5B: Timestep controller alignment

**ngspice reference:** dctran.c (inline timestep logic)
**Our file:** src/solver/analog/timestep.ts

| Fix | ngspice ref | Our line | Detail |
|---|---|---|---|
| Remove `checkMethodSwitch()` method entirely | NOT IN NGSPICE | timestep.ts:449-505 | Delete method and all supporting fields (`_signHistory`, `_stableOnBdf2`). |
| Remove `_updateMethodForStartup()` BDF-1 forcing | NOT IN NGSPICE | timestep.ts:679-690 | ngspice starts with trapezoidal (or user-specified method). There is no BDF-1 startup phase. Delete. |
| Fix breakpoint proximity: use AlmostEqualUlps + delmin band | dctran.c:553-554,628 | timestep.ts:402 | Change `simTime >= this._breakpoints[0]!.time` to use ULP-based comparison with delmin band: `AlmostEqualUlps(simTime, bp, 100) || bp - simTime <= delmin` |
| Fix first-step breakpoint gap formula | dctran.c:572-573 | timestep.ts:316 | Change `nextBreakGap` (breaks[0]-simTime) to `breaks[1]-breaks[0]` matching ngspice. This requires having at least 2 breakpoints. |
| Fix `_savedDelta` capture timing | dctran.c:595 vs 323 | timestep.ts:306 | ngspice captures `savedDelta` only at breakpoint hit (dctran.c:595), not every step. Ours captures every step. Change to match. |
| Initial method | dctran.c default | timestep.ts:150 | `"trapezoidal"` not `"bdf1"`. |

### Wave 5C: PREDICTOR audit

**Scope:** Verify that our predictor code path is properly gated OFF by default and that `#ifndef PREDICTOR` device xfact paths are implemented.

1. **Verify gate:** `this._params.predictor ?? false` at analog-engine.ts:376. The `predictor` param defaults to `false`/`undefined` in resolved params. **Confirm this is the case** by tracing `ResolvedSimulationParams.predictor` through defaults.

2. **Verify no bypass:** Ensure no other code path calls `predictVoltages` or `computeAgp` without checking the gate.

3. **Identify xfact gap:** In ngspice, every `#ifndef PREDICTOR` device load function computes `xfact = CKTdeltaOld[0] / CKTdeltaOld[1]` and uses it to extrapolate terminal voltages as an initial guess. Our devices currently do NOT do this. Each device's new `load()` function must include xfact extrapolation when predictor is disabled (always, for us).

4. **xfact formula:**
   ```
   xfact = CKTdeltaOld[0] / CKTdeltaOld[1]
   vbe = (1 + xfact) * state1_vbe - xfact * state2_vbe  // example for BJT
   ```
   Each device extrapolates its junction voltages from the previous two accepted solutions.

---

## Phase 6: Model Rewrites

### Wave 6A: Define unified `load()` interface

```typescript
interface LoadContext {
  // Pre-allocated, mutated per-call:
  solver: SparseSolver;
  voltages: Float64Array;        // CKTrhsOld — previous NR solution
  iteration: number;             // iterno
  initMode: InitMode;            // CKTmode & INITF
  dt: number;                    // CKTdelta (0 for DC)
  method: IntegrationMethod;     // CKTintegrateMethod
  order: number;                 // CKTorder
  deltaOld: readonly number[];   // CKTdeltaOld[7]
  ag: Float64Array;              // CKTag[] integration coefficients
  srcFact: number;               // CKTsrcFact for source stepping
  noncon: { value: number };     // CKTnoncon — mutable counter
  limitingCollector: LimitEvent[] | null;
  isDcOp: boolean;
  isTransient: boolean;
  xfact: number;                 // #ifndef PREDICTOR extrapolation factor
}

interface AnalogElement {
  load(ctx: LoadContext): void;                    // replaces stamp + stampNonlinear + updateOperatingPoint + stampReactiveCompanion + NIintegrate
  accept?(simTime: number, addBreakpoint: (t: number) => void): void;  // DEVaccept
  checkConvergence?(ctx: LoadContext): boolean;    // DEVconvTest (NEWCONV)
  getLteTimestep?(ctx: LteContext): number;        // DEVtrunc
  // ... non-hot-path methods unchanged
}
```

### Wave 6B: Rewrite each element

Every element must be converted from the split interface to unified `load()`. The load function must follow this exact order (matching ngspice DEVload):

1. Read terminal voltages from `ctx.voltages` (via `pinNodeIds`)
2. If `iteration > 0` or `initMode !== "initJct"`: apply voltage limiting (pnjlim/fetlim for junctions)
3. If limiting occurred: `ctx.noncon.value++`
4. If `initMode === "initJct"` or `initMode === "initFix"`: use junction initial conditions (Vt * log(Is) etc.)
5. If `iteration === 0 && !isDcOp`: apply xfact extrapolation from previous accepted voltages
6. Evaluate device equations (currents, conductances from voltages)
7. Stamp conductance matrix and RHS via `ctx.solver`
8. If reactive: call integration (NIintegrate equivalent) using `ctx.ag[]`, stamp companion model
9. Store operating point for next iteration

**Element list (all must be rewritten):**

| Category | Elements | Count |
|---|---|---|
| Passive linear | Resistor, Potentiometer, NTC, LDR, Fuse, SparkGap | 6 |
| Passive reactive | Capacitor, PolarizedCap, Inductor, Transformer, TappedTransformer, Crystal, Memristor, TransmissionLine | 8 |
| Diode family | Diode, Schottky, Zener, Varactor, TunnelDiode, LED (if separate) | 5-6 |
| BJT | NPN, PNP | 2 |
| FET | NMOS, PMOS, NJFET, PJFET | 4 |
| Thyristor | SCR, Triac, Diac | 3 |
| Vacuum tube | Triode | 1 |
| Sources | DcVoltage, AcVoltage, CurrentSource, VariableRail, VCVS, VCCS, CCVS, CCCS | 8 |
| Bridge adapters | BridgeInput, BridgeOutput | 2 |
| Behavioral/digital | BehavioralGate, Counter, Register, Mux, Demux, Decoder, Flipflops (7) | 13 |
| Probe | AnalogProbe | 1 |
| **Total** | | **~55** |

For each element, the implementation spec is: take the existing `stamp()` + `stampNonlinear()` + `updateOperatingPoint()` + `stampReactiveCompanion()` bodies and fuse them into a single `load()` in the correct ngspice DEVload order. Add xfact extrapolation. Remove the old methods.

---

## Phase 7: Verification

After each phase, run the ngspice comparison harness (`docs/ngspice-harness-howto.md`) on:
- Simple resistive divider (DC-OP)
- RC circuit (transient — capacitor integration)
- Diode IV curve (DC sweep — junction limiting)
- BJT common-emitter (DC-OP — gmin stepping)
- RLC oscillator (transient — LTE, order promotion)
- Op-amp circuit (DC-OP — source stepping)

Compare per-NR-iteration node voltages, device states, and convergence flow against ngspice. Zero tolerance for numerical divergence.

---

## Dependency Graph

```
Phase 1A (zero-alloc structs)
  ↓
Phase 1B (sparse solver) ──────────────────────────┐
  ↓                                                 │
Phase 2A (NIiter alignment) ◄───────────────────────┘
  ↓
Phase 2B (pnjlim/fetlim)
  ↓
Phase 2C (CKTload single-pass) ◄── Phase 6A (load interface)
  ↓                                      ↓
Phase 3A (ckt-terr formulas)       Phase 6B (model rewrites, ~55 elements)
  ↓                                      ↓
Phase 3B (integration coefficients)      │
  ↓                                      │
Phase 4A-E (DC-OP alignment) ◄──────────┘
  ↓
Phase 5A (step() alignment) ◄── Phase 5B (timestep controller)
  ↓
Phase 5C (PREDICTOR audit + xfact)
  ↓
Phase 7 (verification)
```

**Critical path:** 1A → 1B → 2A → 6A → 6B → 2C → 4A → 5A → 7

---

## File Impact Summary

| File | Change Type |
|---|---|
| src/solver/analog/newton-raphson.ts | Major rewrite (zero-alloc, E_SINGULAR, ipass, convergence) |
| src/solver/analog/mna-assembler.ts | **Delete** — replaced by CKTload single-pass in newton-raphson.ts |
| src/solver/analog/analog-engine.ts | Major rewrite (step alignment, remove method switching, zero-alloc) |
| src/solver/analog/dc-operating-point.ts | Major rewrite (all 7 numerical fixes, zero-alloc) |
| src/solver/analog/timestep.ts | Significant rewrite (remove method switching, fix breakpoints, initial method) |
| src/solver/analog/integration.ts | Moderate fixes (coefficients, ccapPrev, zero-alloc mat) |
| src/solver/analog/ckt-terr.ts | Moderate fixes (6 formula corrections) |
| src/solver/analog/element.ts | Interface redesign (unified load) |
| src/solver/analog/sparse-solver.ts | Moderate (real preorder, NISHOULDREORDER lifecycle) |
| src/solver/analog/ni-pred.ts | Audit only (verify gate, no functional changes if predictor stays off) |
| ~55 element implementation files | Full rewrite of hot-path methods |

---

## Appendix A: Buffer Ownership Architecture

### Design: CKTCircuitContext

All pre-allocated buffers live on a single `CKTCircuitContext` object, allocated once during `MNAEngine.init()`. This replaces ngspice's `CKTcircuit *ckt` struct — the single bag of state that every function receives.

```typescript
/** Pre-allocated once at init(). Mutated per-call. Never re-created. */
class CKTCircuitContext {
  // ── Matrix & solver ──
  solver: SparseSolver;

  // ── Node voltages (ngspice CKTrhs / CKTrhsOld) ──
  rhsOld: Float64Array;          // matrixSize — previous NR iteration solution
  rhs: Float64Array;             // matrixSize — current NR iteration solution
  rhsSpare: Float64Array;        // matrixSize — scratch for solve

  // ── Accepted solution buffers ──
  acceptedVoltages: Float64Array; // matrixSize — last accepted solution
  prevAcceptedVoltages: Float64Array; // matrixSize — for rollback on retry

  // ── DC-OP scratch (reused across gmin/src stepping) ──
  dcopVoltages: Float64Array;    // matrixSize
  dcopSavedVoltages: Float64Array; // matrixSize
  dcopSavedState0: Float64Array; // statePool.state0.length
  dcopOldState0: Float64Array;   // statePool.state0.length — NR damping

  // ── Integration coefficients (ngspice CKTag[7]) ──
  ag: Float64Array;              // 7 entries

  // ── Predictor coefficients (ngspice CKTagp[7]) — unused when PREDICTOR off ──
  agp: Float64Array;             // 7 entries

  // ── Timestep history (ngspice CKTdeltaOld[7]) ──
  deltaOld: number[];            // 7 entries — on TimestepController

  // ── Gear Vandermonde scratch (7x7 flat) ──
  gearMatScratch: Float64Array;  // 49 entries

  // ── NR result (mutated, never re-created) ──
  nrResult: NRResult;            // { converged, iterations, voltages (ref to rhs/rhsOld), largestChangeElement, largestChangeNode }

  // ── DC-OP result (mutated, never re-created) ──
  dcopResult: DcOpResult;        // { converged, method, iterations, nodeVoltages (ref), diagnostics }

  // ── Load context (mutated per-iteration, passed to every element.load()) ──
  loadCtx: LoadContext;          // see Phase 6A interface

  // ── LTE context (mutated per-step) ──
  lteCtx: LteContext;

  // ── Assembler state (replaces MNAAssembler) ──
  noncon: number;                // CKTnoncon — convergence flag counter

  // ── Mode flags ──
  initMode: InitMode;
  isDcOp: boolean;
  isTransient: boolean;
  srcFact: number;               // CKTsrcFact for source stepping

  // ── Compiled circuit ref ──
  elements: AnalogElement[];
  matrixSize: number;
  nodeCount: number;
  statePool: StatePool | null;

  // ── Pre-computed lists (avoid filter/map in hot path) ──
  nonlinearElements: AnalogElement[];
  reactiveElements: AnalogElement[];
  poolBackedElements: PoolBackedAnalogElement[];
  elementsWithConvergence: AnalogElement[];
  elementsWithLte: AnalogElement[];
  elementsWithAcceptStep: AnalogElement[];
}
```

**Ownership rule:** `CKTCircuitContext` is a field on `MNAEngine`. Created in `init()`. Every function that currently takes `solver`, `elements`, `matrixSize`, etc. as separate params instead takes `ctx: CKTCircuitContext`. This includes `newtonRaphson`, `solveDcOperatingPoint`, `dynamicGmin`, `spice3Gmin`, `gillespieSrc`, `spice3Src`, `cktop`.

**Threading:** `solveDcOperatingPoint` becomes a method on `MNAEngine` (or takes `ctx` as first param), not a standalone function. This gives it access to all pre-allocated buffers without allocation.

### NRResult — Pre-allocated Mutable Struct

```typescript
class NRResult {
  converged = false;
  iterations = 0;
  voltages: Float64Array = null!; // points to ctx.rhsOld after swap
  largestChangeElement = -1;
  largestChangeNode = -1;
}
```

`newtonRaphson()` writes into `ctx.nrResult` via mutation. Returns `void`. Caller reads `ctx.nrResult.converged` etc.

### DcOpResult — Pre-allocated Mutable Struct

```typescript
class DcOpResult {
  converged = false;
  method: "direct" | "gmin" | "source" = "direct";
  iterations = 0;
  nodeVoltages: Float64Array = null!; // points to ctx.dcopVoltages
}
```

---

## Appendix B: CKTload Loop — Exact Code Structure

This replaces `MNAAssembler.stampAll()`. Lives inside `newtonRaphson()` where the current `assembler.stampAll(...)` call is.

```typescript
// ── CKTload equivalent ──
// ngspice ref: cktload.c:29-158

function cktLoad(ctx: CKTCircuitContext, iteration: number): void {
  const { solver, elements, matrixSize, loadCtx } = ctx;

  // Step 1: Clear matrix and RHS (cktload.c:53-56)
  solver.beginAssembly(matrixSize);

  // Step 2: Update loadCtx fields for this iteration
  loadCtx.iteration = iteration;
  loadCtx.solver = solver;
  // voltages already points to ctx.rhsOld (previous NR solution)

  // Step 3: Device load loop (cktload.c:61-73)
  // SINGLE PASS — each element does everything in its load()
  for (let i = 0; i < elements.length; i++) {
    elements[i].load(loadCtx);
  }

  // Step 4: Apply nodesets and ICs AFTER device loads (cktload.c:104-158)
  // Only in DC mode during initJct or initFix
  if (loadCtx.isDcOp &&
      (loadCtx.initMode === "initJct" || loadCtx.initMode === "initFix")) {
    applyNodesetsAndICs(solver, ctx.nodesets, ctx.ics,
                        ctx.srcFact, loadCtx.initMode);
  }

  // Step 5: Finalize matrix (COO→CSC rebuild)
  solver.finalize();
}
```

**Key differences from current code:**
1. NO separate `updateOperatingPoint` pass
2. NO separate `stampNonlinear` pass
3. NO separate `stampReactiveCompanion` pass
4. Nodesets/ICs applied inside CKTload, not as a separate step in the NR loop
5. `solver.finalize()` is part of CKTload, not separate

The NR loop in `newtonRaphson()` then becomes:

```typescript
function newtonRaphson(ctx: CKTCircuitContext): void {
  const result = ctx.nrResult;
  let ipass = 0;
  let didPreorder = false;

  // ... UIC bypass check ...

  for (let iteration = 0; ; iteration++) {
    // Step A: Clear noncon
    ctx.noncon = 0;

    // Step B: CKTload (single call, replaces stampAll)
    cktLoad(ctx, iteration);

    // Step C: iterno++ (implicit in for-loop)

    // Step D: Preorder (one-time)
    if (!didPreorder) {
      ctx.solver.preorder();  // REAL diagonal column swap
      didPreorder = true;
    }

    // Step E: Diagonal gmin
    if (ctx.diagonalGmin) {
      ctx.solver.addDiagonalGmin(ctx.diagonalGmin);
    }

    // Step F: Factor
    let factorOk = ctx.solver.factor();
    if (!factorOk) {
      if (!ctx.solver.lastFactorUsedReorder) {
        ctx.solver.forceReorder();
        // E_SINGULAR: must re-load then re-factor (ngspice does continue)
        continue; // goes back to Step A → re-executes cktLoad
      }
      // Fatal singular
      result.converged = false;
      result.iterations = iteration + 1;
      return;
    }

    // Step G: Save OldCKTstate0 for damping (one-time alloc via ctx)
    if (ctx.statePool) {
      ctx.dcopOldState0.set(ctx.statePool.state0);
    }

    // Step H: Solve
    ctx.solver.solve(ctx.rhs);

    // Step I: Iteration limit
    if (iteration + 1 > ctx.maxIterations) {
      result.converged = false;
      result.iterations = iteration + 1;
      result.voltages = ctx.rhsOld;
      return;
    }

    // Step J: Convergence check
    if (ctx.noncon === 0 && iteration > 0) {
      // NIconvTest: node convergence
      let globalConverged = true;
      for (let i = 0; i < matrixSize; i++) {
        const absTol = i < ctx.nodeCount ? ctx.voltTol : ctx.abstol;
        const tol = ctx.reltol * Math.max(Math.abs(ctx.rhs[i]),
                                           Math.abs(ctx.rhsOld[i])) + absTol;
        if (Math.abs(ctx.rhs[i] - ctx.rhsOld[i]) > tol) {
          globalConverged = false;
          break; // ngspice short-circuits (unless blame tracking enabled)
        }
      }
      // NEWCONV: device convergence (CKTconvTest)
      if (globalConverged) {
        for (let i = 0; i < ctx.elementsWithConvergence.length; i++) {
          if (!ctx.elementsWithConvergence[i].checkConvergence!(ctx.loadCtx)) {
            globalConverged = false;
            break;
          }
        }
      }
      ctx.noncon = globalConverged ? 0 : 1;
    } else if (iteration === 0) {
      ctx.noncon = 1; // force at least 2 iterations
    }

    // Step K: Newton damping
    if (ctx.nodeDamping && ctx.noncon !== 0 && ctx.isDcOp && iteration > 0) {
      // ... damping code (unchanged from current) ...
    }

    // Step L: INITF dispatcher
    const curInitMode = ctx.initMode;
    if (curInitMode === "initFloat" || curInitMode === "transient") {
      if (ctx.isDcOp && ctx.hadNodeset) {
        if (ipass > 0) { ipass = 0; ctx.noncon = 1; }
      }
      if (ctx.noncon === 0) {
        result.converged = true;
        result.iterations = iteration + 1;
        result.voltages = ctx.rhs;
        return;
      }
    } else if (curInitMode === "initJct") {
      ctx.initMode = "initFix";
      ctx.solver.forceReorder();
    } else if (curInitMode === "initFix") {
      if (ctx.noncon === 0) {
        ctx.initMode = "initFloat";
      }
      ipass = 1;
    } else if (curInitMode === "initTran") {
      if (iteration <= 0) ctx.solver.forceReorder();
      ctx.initMode = "initFloat";
    } else if (curInitMode === "initPred") {
      ctx.initMode = "initFloat";
    } else if (curInitMode === "initSmsig") {
      ctx.initMode = "initFloat";
    }

    // Step M: Swap RHS vectors (pointer swap, zero alloc)
    const tmp = ctx.rhs;
    ctx.rhs = ctx.rhsOld;
    ctx.rhsOld = tmp;
  }
}
```

---

## Appendix C: Preorder Algorithm (SMPpreOrder)

**ngspice source:** `ref/ngspice/src/maths/sparse/sputils.c:177-301`

Our `SparseSolver.preorder()` must implement the MNA preorder algorithm. This is a one-time operation before the first factorization that fixes structural zeros on the diagonal caused by voltage source branch equations.

### Algorithm

```
function preorder():
  if already_done: return
  
  do:
    anotherPassNeeded = false
    swapped = false
    
    // Phase 1: Handle lone twins (unambiguous swaps)
    for each column J where diagonal[J] is zero:
      twins = countTwins(J)  // find symmetric pairs (J,Row)/(Row,J) with |value|=1
      if twins == 1:
        swapColumns(twin1.col, twin2.col)  // swap column linked lists + mappings
        swapped = true
      else if twins > 1:
        anotherPassNeeded = true
        remember startAt = J
    
    // Phase 2: Handle one multi-twin diagonal (arbitrary choice)
    if anotherPassNeeded:
      for J from startAt where diagonal[J] is zero:
        twins = countTwins(J)
        swapColumns(twin1.col, twin2.col)  // pick first pair
        swapped = true
        break
        
  while anotherPassNeeded

  mark preorder_done
```

### countTwins(col):
Walk down column `col`. For each element with |value| == 1.0, check if a symmetric partner exists in column `element.row` at row `col` with |value| == 1.0. Count pairs, early-exit at 2.

### swapColumns(col1, col2):
1. Swap `firstInCol[col1]` ↔ `firstInCol[col2]` (swap column linked lists)
2. Swap `intToExtColMap[col1]` ↔ `intToExtColMap[col2]` (update permutation)
3. Update `extToIntColMap` reverse mapping
4. Set `diagonal[col1]` = twin2, `diagonal[col2]` = twin1
5. Toggle determinant sign parity

### Implementation in our SparseSolver

Our solver uses COO→CSC format, not linked lists. The preorder must run after `finalize()` builds the CSC structure but before `factor()`. Implementation options:

**Option A (recommended):** Work on the CSC arrays directly. For each column with zero diagonal:
1. Scan CSC column `J` for entries with |value| == 1.0 at row `R`
2. Scan CSC column `R` for entry at row `J` with |value| == 1.0
3. If found: swap columns J and R in CSC (swap `colPtr` segments, update `rowIdx`, update column permutation)

**Option B:** Convert preorder logic to work on COO before CSC build. Less efficient but simpler.

The key requirement: after preorder, all structural zeros on the diagonal that can be fixed by column swaps ARE fixed. This ensures Markowitz pivot search doesn't encounter preventable zero pivots.

---

## Appendix D: Reference load() Implementations

### D1: Resistor — Simplest baseline

**ngspice ref:** resload.c RESload

```typescript
// Resistor element — unified load()
// ngspice ref: resload.c lines 17-42

load(ctx: LoadContext): void {
  const { solver, voltages } = ctx;
  const posNode = this._posNode;   // RESposNode
  const negNode = this._negNode;   // RESnegNode
  const g = this._conductance;     // RESconduct = 1/R, pre-computed at setup
  const m = this._multiplier;      // RESm

  // Read terminal voltages from previous NR solution (CKTrhsOld)
  const vPos = posNode > 0 ? voltages[posNode - 1] : 0;
  const vNeg = negNode > 0 ? voltages[negNode - 1] : 0;

  // Store current for output (resload.c:33-34)
  this._current = (vPos - vNeg) * g;

  // Stamp conductance matrix (resload.c:36-41)
  const gm = g * m;
  solver.stamp(posNode, posNode, gm);
  solver.stamp(negNode, negNode, gm);
  solver.stamp(posNode, negNode, -gm);
  solver.stamp(negNode, posNode, -gm);

  // No RHS stamp — pure conductance, no current source
  // No mode checks — resistor is unconditionally linear
  // No convergence check — always converges in 1 iteration
  // No integration — not reactive
}
```

### D2: Capacitor — Reactive baseline with NIintegrate

**ngspice ref:** capload.c CAPload

```typescript
// Capacitor element — unified load()
// ngspice ref: capload.c lines 17-86

load(ctx: LoadContext): void {
  const { solver, voltages, initMode, isDcOp, isTransient, ag } = ctx;
  const posNode = this._posNode;
  const negNode = this._negNode;
  const C = this._capacitance;     // CAPcapac
  const m = this._multiplier;      // CAPm

  // Gate: capacitors only participate in tran/ac/tranop (capload.c:30)
  if (!isTransient && !isDcOp) return;

  // Determine if using initial condition (capload.c:32-36)
  const cond1 = (isDcOp && initMode === "initJct") ||
                (ctx.uic && initMode === "initTran");

  // Read terminal voltage (capload.c:49-51)
  let vcap: number;
  if (cond1) {
    vcap = this._initCond;           // CAPinitCond (user IC)
  } else {
    const vPos = posNode > 0 ? voltages[posNode - 1] : 0;
    const vNeg = negNode > 0 ? voltages[negNode - 1] : 0;
    vcap = vPos - vNeg;
  }

  if (isTransient) {
    // #ifndef PREDICTOR (capload.c:53-65)
    // PREDICTOR is off in default build, so this block always runs
    if (initMode === "initPred") {
      // Copy state1 charge to state0 (capload.c:55-56)
      this._stateRef.qcap0 = this._stateRef.qcap1;
    } else {
      // Compute charge: Q = C * V (capload.c:58)
      this._stateRef.qcap0 = C * vcap;
      if (initMode === "initTran") {
        // Seed state1 from state0 (capload.c:60-62)
        this._stateRef.qcap1 = this._stateRef.qcap0;
      }
    }

    // ── NIintegrate (capload.c:67-68) ──
    // ngspice: NIintegrate(ckt, &geq, &ceq, cap, qcap)
    //
    // Inline the integration using pre-computed ag[] coefficients.
    // ag[] was computed by computeNIcomCof() before the NR loop.
    //
    // For GEAR (BDF):
    //   ccap = ag[0]*q0 + ag[1]*q1 + ag[2]*q2 + ...
    //   geq = ag[0] * C
    //   ceq = ccap - ag[0] * q0
    //       = ccap - geq * vcap  (since q0 = C * vcap for linear cap)
    //
    // For TRAPEZOIDAL order 1 (BDF-1):
    //   ccap = (q0 - q1) / dt  =  ag[0]*q0 + ag[1]*q1
    //   geq = ag[0] * C
    //   ceq = ccap - geq * vcap
    //
    // For TRAPEZOIDAL order 2:
    //   ccap = -ag[1]*ccapPrev + ag[0]*(q0 - q1)
    //   geq = ag[0] * C
    //   ceq = ccap - ag[0] * q0

    const q0 = this._stateRef.qcap0;
    const q1 = this._stateRef.qcap1;

    // Compute companion current (NIintegrate body, niinteg.c:28-63)
    let ccap: number;
    if (ctx.order >= 2 && ag.length > 2) {
      // GEAR / BDF-2+: ccap = sum(ag[k] * state_k[qcap])
      ccap = ag[0] * q0 + ag[1] * q1 + ag[2] * this._stateRef.qcap2;
      for (let k = 3; k <= ctx.order && k < ag.length; k++) {
        ccap += ag[k] * this._getQHistory(k);
      }
    } else {
      // BDF-1 / Trap order 1: ccap = ag[0]*q0 + ag[1]*q1
      ccap = ag[0] * q0 + ag[1] * q1;
    }

    // Store companion current in state (niinteg.c:63)
    this._stateRef.ccap0 = ccap;

    // geq and ceq (niinteg.c:77-78)
    const geq = ag[0] * C;
    const ceq = ccap - ag[0] * q0;
    //                 ^^^^^^^^^ ngspice: ag[0] * CKTstate0[qcap], NOT geq * vcap

    // Seed state1 companion current on first tran step (capload.c:70-72)
    if (initMode === "initTran") {
      this._stateRef.ccap1 = this._stateRef.ccap0;
    }

    // Stamp companion model (capload.c:74-79)
    const geqm = geq * m;
    const ceqm = ceq * m;
    solver.stamp(posNode, posNode, geqm);
    solver.stamp(negNode, negNode, geqm);
    solver.stamp(posNode, negNode, -geqm);
    solver.stamp(negNode, posNode, -geqm);
    solver.stampRHS(posNode, -ceqm);
    solver.stampRHS(negNode, ceqm);
  } else {
    // DC: just store charge, no stamp (capload.c:84)
    this._stateRef.qcap0 = C * vcap;
  }
}
```

**Key pattern for NIintegrate inside load():** The `ag[]` coefficients are computed ONCE per timestep by `computeNIcomCof()` (called from the engine before the NR retry loop). Each reactive element's `load()` uses these pre-computed coefficients directly — no function call to `integrateCapacitor()`, no returned object. The element reads `ag[0..order]` from the context, computes `ccap` as a dot product of `ag[]` with charge history, then derives `geq = ag[0] * C` and `ceq = ccap - ag[0] * q0`.

### D3: Diode — Nonlinear with limiting, integration, convergence

**ngspice ref:** dioload.c DIOload

```typescript
// Diode element — unified load()
// ngspice ref: dioload.c lines 21-441

load(ctx: LoadContext): void {
  const { solver, voltages, initMode, iteration, ag, noncon } = ctx;
  const posNode = this._posNode;        // DIOposNode (external anode)
  const posPrimeNode = this._intNode;   // DIOposPrimeNode (internal anode after Rs)
  const negNode = this._negNode;        // DIOnegNode (cathode)

  let cd = 0;     // total diode current
  let gd = 0;     // total diode conductance
  let vd: number; // junction voltage
  let Check = 1;  // limiting flag (1 = need convergence check)

  const csat = this._tSatCur;         // area-scaled saturation current
  const gspr = this._tConductance * this._area; // series resistance conductance
  const vt = CONSTKoverQ * this._temp;
  const vte = this._emissionCoeff * vt;

  // ══════════════════════════════════════════════
  // INITIALIZATION — read or set junction voltage
  // dioload.c:126-204
  // ══════════════════════════════════════════════

  if (initMode === "initSmsig") {
    // Small-signal: use stored operating point (dioload.c:128)
    vd = this._state.vd0;
  } else if (initMode === "initTran") {
    // First transient step: use previous timepoint (dioload.c:130)
    vd = this._state.vd1;
  } else if (initMode === "initJct" && ctx.uic) {
    // UIC: use user initial condition (dioload.c:132-133)
    vd = this._initCond;
  } else if (initMode === "initJct" && this._off) {
    // Device off: vd = 0 (dioload.c:135)
    vd = 0;
  } else if (initMode === "initJct") {
    // Normal junction init: vd = Vcrit (dioload.c:137)
    vd = this._tVcrit;
  } else if (initMode === "initFix" && this._off) {
    // Fix mode, device off (dioload.c:139)
    vd = 0;
  } else {
    // ── Normal iteration: read from solution vector ──

    // #ifndef PREDICTOR block (dioload.c:140-155)
    // PREDICTOR is off, so when initPred: copy state and extrapolate
    if (initMode === "initPred") {
      this._state.vd0 = this._state.vd1;
      // DEVpred extrapolation: vd = (1 + xfact) * state1_vd - xfact * state2_vd
      // xfact = deltaOld[0] / deltaOld[1] — passed via ctx
      vd = (1 + ctx.xfact) * this._state.vd1 - ctx.xfact * this._state.vd2;
      this._state.cd0 = this._state.cd1;
      this._state.gd0 = this._state.gd1;
    } else {
      // Read from CKTrhsOld (dioload.c:151-152)
      const vPosPrime = posPrimeNode > 0 ? voltages[posPrimeNode - 1] : 0;
      const vNeg = negNode > 0 ? voltages[negNode - 1] : 0;
      vd = vPosPrime - vNeg;
    }

    // ── Voltage limiting (dioload.c:183-204) ──
    if (this._breakdownVoltageGiven &&
        vd < Math.min(0, -this._tBrkdwnV + 10 * this._brkdEmCoeff * vt)) {
      // Breakdown limiting path
      let vdtemp = -(vd + this._tBrkdwnV);
      const limResult = pnjlim(vdtemp,
        -(this._state.vd0 + this._tBrkdwnV),
        this._brkdEmCoeff * vt, this._tVcrit);
      vdtemp = limResult.value;
      if (limResult.limited) Check = 1;
      vd = -(vdtemp + this._tBrkdwnV);
    } else {
      // Normal forward limiting
      const limResult = pnjlim(vd, this._state.vd0, vte, this._tVcrit);
      vd = limResult.value;
      if (limResult.limited) Check = 1;
    }
  }

  // ══════════════════════════════════════════════
  // DEVICE EQUATIONS — compute current and conductance
  // dioload.c:209-313
  // ══════════════════════════════════════════════

  if (vd >= -3 * vte) {
    // Forward bias
    const evd = Math.exp(vd / vte);
    cd = csat * (evd - 1);
    gd = csat * evd / vte;
  } else if (!this._breakdownVoltageGiven || vd >= -this._tBrkdwnV) {
    // Reverse bias (cubic approximation)
    const arg = 3 * vte / (vd * CONSTe);
    const arg3 = arg * arg * arg;
    cd = -csat * (1 + arg3);
    gd = csat * 3 * arg3 / vd;
  } else {
    // Breakdown
    const evrev = Math.exp(-(this._tBrkdwnV + vd) / (this._brkdEmCoeff * vt));
    cd = -csat * evrev;
    gd = csat * evrev / (this._brkdEmCoeff * vt);
  }

  // Add gmin (dioload.c:305-307)
  gd += ctx.gmin;
  cd += ctx.gmin * vd;

  // ══════════════════════════════════════════════
  // CHARGE STORAGE — NIintegrate (dioload.c:315-401)
  // ══════════════════════════════════════════════

  if (ctx.isTransient || initMode === "initSmsig" ||
      (ctx.isDcOp && ctx.uic)) {
    // Compute junction charge: depletion + diffusion
    const capd = this._computeCapacitance(vd); // czero, deplcap, diffcap
    this._cap = capd;

    if (initMode === "initSmsig") {
      // Store capacitance for AC analysis, skip integration
      this._state.ccap0 = capd;
      // Store operating point and continue (dioload.c:370-373)
      this._state.vd0 = vd;
      this._state.cd0 = cd;
      this._state.gd0 = gd;
      return; // continue in ngspice
    }

    // Compute total charge Q
    const qd = this._computeCharge(vd); // deplcharge + diffcharge
    this._state.qcap0 = qd;

    if (initMode === "initTran") {
      this._state.qcap1 = this._state.qcap0; // seed state1
    }

    // ── NIintegrate inline (dioload.c:395) ──
    // NIintegrate(ckt, &geq, &ceq, capd, here->DIOcapCharge)
    let ccap: number;
    if (ctx.order >= 2 && ag.length > 2) {
      ccap = ag[0] * this._state.qcap0 + ag[1] * this._state.qcap1
           + ag[2] * this._state.qcap2;
      for (let k = 3; k <= ctx.order && k < ag.length; k++) {
        ccap += ag[k] * this._getQHistory(k);
      }
    } else {
      ccap = ag[0] * this._state.qcap0 + ag[1] * this._state.qcap1;
    }
    this._state.ccap0 = ccap;

    const geq = ag[0] * capd;
    const ceq_cap = ccap - ag[0] * this._state.qcap0;

    if (initMode === "initTran") {
      this._state.ccap1 = this._state.ccap0;
    }

    // Add reactive contributions to DC current/conductance (dioload.c:397-398)
    gd += geq;
    cd += this._state.ccap0;
  }

  // ══════════════════════════════════════════════
  // CONVERGENCE CHECK (dioload.c:411-416)
  // ══════════════════════════════════════════════

  if (!(initMode === "initFix" && this._off)) {
    if (Check === 1) {
      noncon.value++;
    }
  }

  // ══════════════════════════════════════════════
  // STORE STATE (dioload.c:417-419)
  // ══════════════════════════════════════════════

  this._state.vd0 = vd;
  this._state.cd0 = cd;
  this._state.gd0 = gd;

  // ══════════════════════════════════════════════
  // STAMP MATRIX (dioload.c:425-441)
  // ══════════════════════════════════════════════

  // Linearized current source: cdeq = cd - gd * vd
  const cdeq = cd - gd * vd;

  // RHS stamps (dioload.c:429-430)
  solver.stampRHS(negNode, cdeq);
  solver.stampRHS(posPrimeNode, -cdeq);

  // Conductance stamps (dioload.c:434-441)
  // Series resistance: pos ↔ posPrime
  solver.stamp(posNode, posNode, gspr);
  solver.stamp(posPrimeNode, posPrimeNode, gd + gspr);
  solver.stamp(posNode, posPrimeNode, -gspr);
  solver.stamp(posPrimeNode, posNode, -gspr);
  // Junction: posPrime ↔ neg
  solver.stamp(negNode, negNode, gd);
  solver.stamp(negNode, posPrimeNode, -gd);
  solver.stamp(posPrimeNode, negNode, -gd);
}
```

**Key patterns demonstrated:**
1. **Single function** — voltage read, limiting, evaluation, integration, convergence check, state store, and matrix stamp ALL in one `load()` call
2. **xfact extrapolation** — `#ifndef PREDICTOR` path uses `ctx.xfact` for initPred initial guess
3. **NIintegrate inline** — uses `ctx.ag[]` directly, no separate function call, no allocation
4. **noncon via mutable ref** — `noncon.value++` increments the shared counter (matches `ckt->CKTnoncon++`)
5. **State reads/writes** — all via pre-allocated `_state` (mapped to state pool slots), never allocating

---

## Appendix E: Test Verification Plan

### Approach: Per-iteration numerical comparison against ngspice

The ngspice comparison harness (`docs/ngspice-harness-howto.md`) captures per-NR-iteration data from both engines. For each test circuit:

1. Run ngspice with instrumentation enabled (our patched build captures `CKTrhsOld[]`, `CKTstate0[]`, `CKTnoncon`, `CKTdiagGmin`, `CKTmode`, `CKTorder`, `CKTdelta` per iteration)
2. Run our engine on the same netlist with convergence logging enabled
3. Compare vectors element-by-element with zero tolerance (exact IEEE-754 match)

### Required test circuits

| Circuit | Tests | Key behaviors |
|---|---|---|
| 1. Resistive divider (2R) | DC-OP | Linear stamp, direct convergence (1 iteration) |
| 2. Diode + resistor | DC-OP | pnjlim, initJct→initFix→initFloat, noncon |
| 3. BJT common-emitter | DC-OP | Multi-junction limiting, gmin stepping |
| 4. RC series (pulse source) | Transient | NIintegrate for cap, LTE, order promotion |
| 5. RLC series (AC source) | Transient | Inductor integration, ringing (tests that method switching is gone) |
| 6. Op-amp inverting amplifier | DC-OP | Source stepping, many nodes |
| 7. Diode bridge rectifier | Transient | Multiple junctions, breakpoints |
| 8. MOSFET inverter | DC-OP + Transient | fetlim, FET equations |

### Pass/fail criteria

- **DC-OP:** Every NR iteration's `rhsOld[]` vector matches to 15 significant digits (IEEE-754 double). Mode transitions (initJct→initFix→initFloat) match exactly. Total iteration count matches.
- **Transient:** Every accepted timestep's dt, order, and method match. Per-step NR iteration count matches. Node voltages at each accepted timepoint match to 15 significant digits.
- **Convergence flow:** `noncon` value matches at every iteration. `diagGmin` value matches at every gmin step. `srcFact` matches at every source step.

### Harness integration

Tests live in `src/solver/analog/__tests__/ngspice-parity/`. Each test:
1. Loads a `.cir` netlist via the MCP harness
2. Runs ngspice comparison (`harness_run`)
3. Captures per-iteration data from both engines
4. Asserts exact match

---

## Appendix F: Downstream Migration Plan

### Consumers that break (from audit)

The element interface change affects two categories:

**Category 1: Infrastructure code that calls element methods directly (7 files)**

| File | Current calls | Migration |
|---|---|---|
| mna-assembler.ts | stamp, stampNonlinear, stampReactiveCompanion, updateOperatingPoint, shouldBypass, checkConvergence | **DELETE file.** Replaced by CKTload loop inside newtonRaphson. |
| newton-raphson.ts | via MNAAssembler | CKTload loop replaces assembler. |
| analog-engine.ts | stampCompanion, updateChargeFlux, updateCompanion, updateState, acceptStep | stampCompanion/updateChargeFlux/updateCompanion/updateState all folded into `load()` or `accept()`. acceptStep unchanged. |
| timestep.ts | getLteTimestep | Unchanged — getLteTimestep stays on interface. |
| ac-analysis.ts | stampAc | Unchanged — AC is separate from transient load(). |
| dc-operating-point.ts | setSourceScale, primeJunctions | Unchanged — cold path methods stay on interface. |
| compiler.ts | setParam, isPoolBacked | Unchanged — cold path. |

**Category 2: Test files with mock elements (~25 files)**

Mock elements in test helpers must be updated to implement `load()` instead of the old split methods. The test helper at `src/solver/analog/__tests__/test-helpers.ts` creates mock `AnalogElement` objects — this must be rewritten to provide `load(ctx)` implementations.

All component-specific tests (e2e and integration) that compile real circuits and run them will continue to work once the element implementations are updated — they don't call element methods directly.

**Category 3: NOT affected**

- Headless facade — no element references
- postMessage adapter — no element references  
- MCP server — no element references
- Editor — engine-agnostic by design

### Migration order

1. Define new interface with `load()` (keep old methods as deprecated)
2. Implement `load()` on all elements (can coexist with old methods temporarily)
3. Switch NR loop to use CKTload (calls `load()`)
4. Remove old method calls from engine/assembler
5. Remove deprecated methods from interface
6. Update test mocks
7. Delete mna-assembler.ts
