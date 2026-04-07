# MNA Engine ngspice Compliance Report

**Date:** 2026-04-07
**Scope:** Full audit and implementation of ngspice-correct NR solver, transient stepping, convergence, device models, and DC operating point.

## Problem

The MNA engine had a ~10,000x performance regression after additions of line search, Newton damping, and tightened convergence conditions. These mechanisms are not present in ngspice and interact destructively with each other and with the existing device-level voltage limiting (pnjlim/fetlim).

## Changes Made

### 1. Newton-Raphson Solver (`src/solver/analog/newton-raphson.ts`)

| Change | Rationale | ngspice Reference |
|--------|-----------|-------------------|
| Removed backtracking line search | ngspice NIiter has no line search. Was destroying quadratic convergence by halving steps when max voltage change grew between iterations. | `niiter.c` — complete source reviewed, no line search present |
| Node damping gated on `isDcOp` flag | ngspice only damps during DCOP/TRANOP, never transient. Damping was unconditionally applied, fighting pnjlim/fetlim. | `niiter.c:290-316` — conditional on `CKTnodeDamping` and mode flags |
| Convergence formula: `reltol * max(\|old\|,\|new\|) + absTol` with split voltage/current tolerances | Was using only `\|new\|` and a single tolerance. Voltage rows use VNTOL (1e-6), branch/current rows use ABSTOL (1e-12). | `niconv.c:NIconvTest` — exact formula verified |
| pnjlim forward-bias: `vold + vt*(2+log(arg-2))` and `vold - vt*(2+log(2-arg))` | Was using `vold + vt*log(1+arg)` which clips ~60% more aggressively. Negative-arg fallback was `vcrit` instead of smooth formula. | `devsup.c:50-58` — exact code verified |
| `PnjlimResult` return type with `{value, limited}` | Enables ngspice icheck mechanism — the `*icheck` output parameter of DEVpnjlim. | `devsup.c` — `*icheck` set on clipping |
| `diagonalGmin` option for gmin stepping | Gmin added to all CSC diagonal elements between finalize() and factor(), matching ngspice LoadGmin. | `spsmp.c:448-478` — `diag->Real += Gmin` |

### 2. Transient Step Loop (`src/solver/analog/analog-engine.ts`)

| Change | Rationale | ngspice Reference |
|--------|-----------|-------------------|
| ERROR state guard at top of step() | Without this, after ERROR the UI kept calling step() burning 200 iterations per frame with no time advance. | DCtran returns fatally; caller never re-enters |
| While-loop dt reduction (replacing single-shot retry) | ngspice's for(;;) outer loop reduces dt by /8 repeatedly until convergence or delmin. Original did one retry then accepted non-converged results, corrupting state. | `dctran.c:723-739` — `/8` reduction, loop back |
| Never accept non-converged NR results | ngspice has no "accept non-converged" path. Original accepted on first failure, poisoning all subsequent steps. | `dctran.c` — no such path exists |
| Two-strike delmin gated on `dt <= minTimeStep` | Was triggering on any double-failure at any timestep. ngspice only triggers when delta has reached the minimum. | `dctran.c:650-660` — `if (delta <= delmin)` |
| `transientMaxIterations` (ITL4=10) for transient NR | Was using `maxIterations=100` for both DC and transient. ngspice uses ITL4=10, failing fast to trigger adaptive step reduction. | `cktntask.c:96` — `TSKtranMaxIter = 10` |
| BDF-1 reset on NR failure | Trapezoidal rings at discontinuities. ngspice resets integration order to 1 on convergence failure. | `dctran.c:735` — `order = 1` |
| LTE rejection uses LTE-computed newDt directly | `reject()` was blindly halving. ngspice uses `delta = newdelta` from CKTtrunc. | `dctran.c:643` |
| LTE retry uses same while-loop reduction pattern | Was a copy-paste with same bugs plus a double-reduction (/2 then /8 = /16). | Same outer loop in DCtran |

### 3. DC Operating Point (`src/solver/analog/dc-operating-point.ts`)

| Change | Rationale | ngspice Reference |
|--------|-----------|-------------------|
| Diagonal augmentation via `addDiagonalGmin` (replaced shunt elements) | ngspice adds gmin to ALL matrix diagonals (including branch rows) via LoadGmin. Shunt elements only covered node rows and added unnecessary elements to the stamp loop. | `spsmp.c:448-478` |
| Final clean solve after gmin stepping | ngspice always runs a final NIiter with gmin=0 after stepping succeeds. Original returned the gmin-augmented solution directly. | `cktop.c:307-309` |
| `isDcOp: true` passed to NR calls | Enables damping during DC op only. | `niiter.c:290-316` |

### 4. Device icheck Mechanism (10 device files)

ngspice has two independent convergence signals per device per iteration:
1. **icheck in DEVload** — boolean "was pnjlim clipping active?" → sets `CKTnoncon++`
2. **DEVconvTest** — current-prediction tolerance test, completely separate

Our code previously had only the current-prediction test. Now all 10 PN-junction device types implement the icheck gate:

| File | Pattern | Junction(s) |
|------|---------|-------------|
| `bjt.ts` (both variants) | Closure `icheckLimited`, OR across VBE+VBC | B-E, B-C |
| `diode.ts` | Closure `pnjlimLimited` | Anode-cathode |
| `mosfet.ts` | Class field `_pnjlimLimited` | Body diodes (VBS, VBD) |
| `fet-base.ts` | Protected field + check in `checkConvergence` | Shared by MOSFET/JFET |
| `njfet.ts`, `pjfet.ts` | Set `_pnjlimLimited` in limitVoltages + updateOperatingPoint | Gate junction |
| `scr.ts`, `triac.ts` | Closure, OR across two junctions | VAK+VGK / VMT+VG1 |
| `varactor.ts`, `zener.ts`, `led.ts` | Closure, single junction | Anode-cathode |

### 5. FET Convergence Fix (`src/solver/analog/fet-base.ts`)

`checkConvergence` was reading VBS from pool state (which `updateOperatingPoint` had just written), making `delvbs = 0` always. Now computes from raw node voltages via `pinNodeIds[3]`, matching ngspice `mos1conv.c:36-43`.

### 6. Simulation Parameters (`src/core/analog-engine-interface.ts`)

| Parameter | Old | New | ngspice |
|-----------|-----|-----|---------|
| `minTimeStep` | `1e-14` (absolute) | `5e-17` (`1e-11 * maxTimeStep`) | `traninit.c:34`: `delmin = 1e-11 * maxStep` |
| `transientMaxIterations` | (did not exist, used `maxIterations=100`) | `10` | `cktntask.c:96`: `TSKtranMaxIter = 10` |

### 7. Timestep Controller (`src/solver/analog/timestep.ts`)

When no reactive elements report LTE (`worstRatio <= 0`), step now grows toward maxTimeStep (`dt * 2`) instead of holding constant. Prevents permanent step collapse in non-reactive circuits after NR failure.

---

## Current Test Results

```
COMBINED: 8463 passed, 16 failed (vitest: 7982/7991 12.2s, playwright: 481/488 171.6s)
```

### Vitest Failures (9)

| Test | Failure | Action Needed |
|------|---------|---------------|
| `bjt.test.ts: stateSize_is_24` | expected 24, got 33 | Schema change from earlier work; update test expectation |
| `bjt.test.ts: stateSchema_size_equals_stateSize` | expected 24, got 33 | Same |
| `diode-state-pool.test.ts: stateSize is 8 when CJO > 0` | expected 8, got 10 | Schema change from earlier work; update test expectation |
| `diode-state-pool.test.ts: stateSize is 8 when TT > 0` | expected 8, got 10 | Same |
| `diode-state-pool.test.ts: stateSchema is DIODE_CAP_SCHEMA` | expected 8, got 10 | Same |
| **`buckbjt-convergence.test.ts: survives 2000 steps`** | **ERROR at step 7, simTime=5µs** | **INVESTIGATE — engine ERRORs at first switching edge** |
| **`buckbjt-convergence.test.ts: survives 600µs`** | **ERROR at step 7, simTime=5µs** | **Same root cause** |
| **`buckbjt-mcp-surface.test.ts: 50 steps advance simTime`** | **ERROR at step 6, simTime=5µs** | **Same root cause** |
| `dc-operating-point.test.ts: gmin_stepping_fallback` | got source-stepping, expected gmin-stepping | Improved convergence formula makes direct NR succeed; adjust test to force gmin fallback |

### Playwright Failures (7)

Likely downstream of the buck BJT convergence issue — E2E tests that exercise BJT switching circuits.

---

## Outstanding Issues

### CRITICAL: Buck BJT convergence failure at 5µs

The engine correctly ERRORs (no longer locks) at the first switching edge of a buck converter circuit. The while-loop reduction to delmin isn't saving it. Possible causes to investigate:
- Is the while loop executing multiple /8 reductions, or hitting delmin too fast?
- Is the BDF-1 reset actually propagating to companion stamps? (The `method` variable captured at the top of step() is used inside the while loop — if it still holds "trapezoidal", the companions are being restamped with the wrong method despite `currentMethod` being set to BDF-1)
- Are the pnjlim or icheck changes making BJT convergence harder at the switching edge specifically?
- Log the iteration count and dt at each reduction to see the reduction trajectory.

### NOT YET IMPLEMENTED: LTE estimation uses simplified formula

**Current code** (`diode.ts:339-356`): Uses first-difference of capacitor current scaled by `dt/12`:
```
truncationError = (dt / 12) * |I_prev - I_prev_prev|
```

**ngspice CKTterr** (`cktterr.c`): Uses (order+1)-th divided differences of charge history with method-specific coefficients:
- Trapezoidal: `factor = [0.5, 0.08333]` for orders 1, 2
- Gear: `factor = [0.5, 0.2222, 0.1364, ...]` for orders 1-6
- Tolerance: `max(volttol, chargetol)` where:
  - `volttol = abstol + reltol * max(|V_now|, |V_prev|)`
  - `chargetol = reltol * max(|Q_now|, |Q_prev|, chgtol) / delta`
- Step formula: `del = trtol * tol / max(abstol, factor * |diff[0]|)` with order-dependent root

This affects step size selection accuracy. The simple approximation over-estimates or under-estimates LTE depending on signal shape, causing either unnecessarily small steps (performance) or unnecessarily large steps (accuracy). Implementing the full divided-difference formula requires maintaining charge state history across timesteps.

### `timestep.reject()` is now dead code

The `reject()` method on TimestepController is no longer called — the LTE rejection path uses `newDt` directly. Can be removed or kept.

### INVESTIGATE: NIiter maxIter floor of 100

The verify-niiter-retry agent reported that ngspice NIiter (`niiter.c:37-38`) has: `if (maxIter < 100) maxIter = 100;`. If accurate, this means ITL4=10 is passed as the argument but NIiter internally floors it to 100. This would mean our `transientMaxIterations: 10` is MORE aggressive than ngspice, not matching it. The convergence check would use `iterno > 100` even during transient. This needs verification — it could explain why the buck BJT fails at step 7 (10 iterations may not be enough for a stiff switching circuit, and ngspice actually uses 100 too despite ITL4=10 being the "setting").

### NOT YET IMPLEMENTED: Performance — stampLinear inside NR loop

`newton-raphson.ts:284` calls `assembler.stampLinear(elements)` every NR iteration. Linear elements (resistors, voltage sources) produce identical stamps every time. In ngspice, CKTload combines linear and nonlinear stamping in one pass, but the matrix uses pre-allocated pointers so only changed values are written. Our code rebuilds the entire COO triplet set and does a full CSC scatter (`_refillCSC` in `sparse-solver.ts:410-428`) every iteration. This is a constant-factor overhead of 2-10x per NR iteration depending on circuit composition. Not a regression from this session's changes, but a structural performance gap vs ngspice.

### NOT YET IMPLEMENTED: Device-level gmin not connected to params.gmin

Devices hardcode `const GMIN = 1e-12`. ngspice has two separate gmin values: `CKTdiagGmin` (diagonal augmentation, used during gmin stepping) and `CKTgmin` (device-level conductance floor, used in DEVload). Our diagonal augmentation is correct, but if a user changes `params.gmin`, the device-level floor doesn't change. ngspice's `new_gmin` variant actually steps `CKTgmin` directly instead of using diagonal augmentation. We only implement the `spice3_gmin` variant.

### NOT YET CHECKED: Initial timestep and breakpoint handling

ngspice initializes the first transient timestep as `MIN(finalTime/100, userStep) / 10` — much smaller than our `maxTimeStep`. After a breakpoint, ngspice resets `order = 1` and reduces delta by `0.1 * MIN(savedDelta, nextBreakpointGap)`. Our breakpoint clamping may not include the order reset or the 10x reduction after a breakpoint.

### NOT YET CHECKED: Integration order increase on step acceptance

ngspice tries order 2 on acceptance when currently at order 1: runs CKTtrunc at order 2, keeps it if `newdelta > 1.05 * delta`. Our method-switching state machine should be compared against this.

---

## ngspice Source References Used

All ngspice code was fetched from `github.com/imr/ngspice` (mirror of official SourceForge repo) and verified by reading raw file content:

- `src/maths/ni/niiter.c` — NIiter Newton iteration loop
- `src/maths/ni/niconv.c` — NIconvTest node convergence
- `src/maths/sparse/spsmp.c` — LoadGmin diagonal augmentation
- `src/spicelib/analysis/cktop.c` — CKTdcOp, spice3_gmin, dynamic_gmin
- `src/spicelib/analysis/dctran.c` — DCtran transient loop, retry, LTE
- `src/spicelib/analysis/cktterr.c` — CKTterr truncation error
- `src/spicelib/analysis/traninit.c` — CKTdelmin computation
- `src/spicelib/analysis/cktntask.c` — Default parameter values (ITL1-5, tolerances)
- `src/spicelib/devices/devsup.c` — DEVpnjlim, DEVfetlim, DEVlimvds
- `src/spicelib/devices/bjt/bjtload.c` — BJT icheck mechanism
- `src/spicelib/devices/bjt/bjtconv.c` — BJTconvTest
- `src/spicelib/devices/dio/dioload.c` — Diode icheck mechanism
- `src/spicelib/devices/dio/dioconv.c` — DIOconvTest
- `src/spicelib/devices/mos1/mos1load.c` — MOSFET voltage limiting + icheck
- `src/spicelib/devices/mos1/mos1conv.c` — MOS1convTest (delvbs from raw nodes)
- `src/include/ngspice/cktdefs.h` — CKTdiagGmin vs CKTgmin field definitions
