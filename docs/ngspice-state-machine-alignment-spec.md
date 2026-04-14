# ngspice Transient State Machine Alignment Spec

## Status: PENDING APPROVAL

This spec describes 9 changes needed to make our transient step state machine match ngspice's exactly. Derived from exhaustive tracer analysis of both engines' state machines, cross-validated against ngspice source.

## Changes Required (Priority Order)

### Change 1: Add `_firsttime` flag with full lifecycle
**Files:** `analog-engine.ts`
- Set `true` at DCOP→transient handoff (ae:768)
- Checked for: LTE skip (C3), NR failure re-arm (C4), state2/state3 seed (C7)
- Cleared `false` when first step is accepted (at LTE skip point, matching dctran.c:864)
- Replaces `_stepCount === 0` checks that correspond to ngspice's `firsttime`

### Change 2: Implement transient INITF mode automaton in NR loop
**Files:** `newton-raphson.ts`, `state-pool.ts`, `analog-engine.ts`
- Add `"initTran"` and `"initPred"` to StatePool.initMode union
- Implement unified mode ladder in NR loop covering ALL modes:
  - initJct → initFix (+REORDER)
  - initFix: noncon=0 → initFloat (ipass=1); else stay
  - initTran: → initFloat (UNCONDITIONAL after iter 0)
  - initPred: → initFloat (UNCONDITIONAL)
  - initFloat: noncon=0 → return OK (CONVERGED); else continue
- Engine passes initMode="initTran" on step 0, "initPred" on step 1+
- Convergence return gated on initMode === "initFloat"

### Change 3: First step skips LTE (firsttime && converged → accept)
**Files:** `analog-engine.ts`
- After NR converges, before LTE computation:
  - if `_firsttime`: clear flag, skip LTE, break to acceptance
- ngspice ref: dctran.c:849-866

### Change 4: NR failure re-arms MODEINITTRAN when firsttime
**Files:** `analog-engine.ts`
- In NR failure block: if `_firsttime && statePool`: set `statePool.initMode = "initTran"`
- Ensures retry enters NR with initTran mode for charge initialization
- ngspice ref: dctran.c:820-821

### Change 5: Post-NIiter unconditional MODEINITPRED set
**Files:** `analog-engine.ts`
- Immediately after NR call returns (before converged/failed branch):
  - `statePool.initMode = "initPred"` (unconditional)
- Gets overwritten by re-arm (C4) on NR failure during firsttime
- ngspice ref: dctran.c:794

### Change 6: iterno==1 forced noncon=1
**Files:** `newton-raphson.ts`
- After updateOperatingPoints, before mode automaton:
  - if `iteration === 0`: `assembler.noncon = 1`
- Guarantees at least 2 NR iterations
- ngspice ref: niiter.c:957-961

### Change 7: State2/state3 seed after NIiter return (not at acceptance)
**Files:** `analog-engine.ts`
- Move `seedFromState1()` from acceptance block to immediately after post-NIiter initMode set
- Gate on `_firsttime` (fires on every NIiter return while firsttime=true, including retries)
- Remove existing `seedFromState1()` at ae:548
- ngspice ref: dctran.c:795-799

### Change 8: deltaOld ring expanded to 7 slots
**Files:** `timestep.ts`
- Expand `_deltaOld` from 4 to 7 slots
- Update rotation to shift all 7: `for (i=5; i>=0; i--) deltaOld[i+1] = deltaOld[i]`
- Update init to fill all 7 with maxTimeStep
- ngspice ref: cktdefs.h:93, dctran.c:316-317, 715-717

### Change 9: Device initMode migration (tranStep→initMode)
**Files:** `bjt.ts`, `mosfet.ts`, `capacitor.ts`, `inductor.ts`
- BJT: `isFirstCall = pool.tranStep === 0` → `pool.initMode === "initTran"`
- MOSFET: all `pool.tranStep === 0` checks → `pool.initMode === "initTran"`
- Capacitor/Inductor: add initTran handling for q→s1/ccap→s1 copies (or keep engine-level bulk copy as safety net)

### Change 10: DCOP fallback initMode not reset to initJct at each level
**Files:** `dc-operating-point.ts`
**ngspice ref:** `cktop.c:136, 283, 373, 583` — every fallback function opens with `ckt->CKTmode = firstmode` (= `MODEDCOP | MODEINITJCT`)
**Our code:** `dc-operating-point.ts:281` — after direct NR, `pool.initMode = "transient"` and is never reset
- After direct NR fails, `statePool.initMode` is stuck at `"transient"` for all subsequent fallback sub-solves (dynamicGmin, spice3Gmin, gillespieSrc)
- ngspice resets to `MODEINITJCT` at the entry of each fallback level, then transitions to `MODEINITFLOAT` after each successful sub-step (`cktop.c:171, 311, 495, 595`)
- Device models that branch on initMode (BJT, diode, MOSFET) produce wrong Jacobian stamps and current contributions when running in `"transient"` mode during a DC-OP solve
- Fix: at entry of each fallback function, set `statePool.initMode = "initJct"`; after each successful sub-step, set `statePool.initMode = "initFloat"`

### Change 11: DCOP fallback chain topology mismatch
**Files:** `dc-operating-point.ts`
**ngspice ref:** `cktop.c:57-75`
- ngspice selects **one** gmin method: `dynamic_gmin` when `CKTnumGminSteps == 1` (default), else `spice3_gmin`. They are **mutually exclusive** alternatives.
- Our engine runs **both** `dynamicGmin` then `spice3Gmin` sequentially as separate ladder rungs (`dc-operating-point.ts:312, 340`)
- ngspice selects **one** source-stepping method: `gillespie_src` when `CKTnumSrcSteps <= 1` (default), else `spice3_src`. We have `gillespieSrc` only.
- `spice3_src` (`cktop.c:583-628`) is entirely absent from our engine: uniform linear source stepping (no backtracking, no adaptive step, no gmin bootstrap). Fixed `srcFact = i / numSrcSteps` for `i = 0..numSrcSteps`.
- Fix: restructure fallback chain to match ngspice selector logic; add `spice3_src` level

### Change 12: gillespieSrc gmin bootstrap off-by-one
**Files:** `dc-operating-point.ts:699`
**ngspice ref:** `cktop.c:416` — `for (i = 0; i <= 10; i++)` = 11 iterations
- Our gmin bootstrap inside gillespieSrc: `for (decade = 0; decade < 10; decade++)` = 10 iterations
- The final decade (last factor-of-10 step down to bare gmin) is skipped
- Fix: change loop to 11 iterations

### Change 13: Missing gshunt in dynamicGmin target
**Files:** `dc-operating-point.ts:479`
**ngspice ref:** `cktop.c:148-157` — `gtarget = MAX(CKTgmin, CKTgshunt)`
- Our code: `gtarget = params.gmin` — uses only gmin, ignoring gshunt
- We have no `gshunt` concept at all
- Fix: add gshunt parameter; use `MAX(gmin, gshunt)` as target in dynamicGmin

### Change 14: Sparse solver — NISHOULDREORDER missing
**Files:** `sparse-solver.ts`, `newton-raphson.ts`
**ngspice ref:** `niiter.c:858, 861-880` — NISHOULDREORDER set/consumed; `nireinit.c:42`
- ngspice triggers full matrix reorder (SMPreorder = column reorder + pivot search) at:
  - Every MODEINITJCT NR iteration (`niiter.c:858`)
  - MODEINITTRAN iterno==1 — the DCOP→transient boundary (`niiter.c:1073`)
  - After SMPluFac returns E_SINGULAR (`niiter.c:889`)
  - MODEINITJCT→MODEINITFIX transition (`niiter.c:1065`)
  - Circuit re-initialization (`nireinit.c:42`)
- Our engine has no mode-driven reorder. `invalidateTopology()` exists but is never called from the NR loop or mode transitions. Reorder only happens on COO stamp-count change or after a threshold-failure retry in `factor()`.
- Fix: add `solver.forceReorder()` calls at mode transitions matching ngspice's triggers

### Change 15: Sparse solver — pivot threshold structurally dead + wrong value + no AbsThreshold
**Files:** `sparse-solver.ts:29, 947-968`
**ngspice ref:** `spconfig.h:331` (DEFAULT_THRESHOLD = 1e-3), `spfactor.c:219, 1106-1108`, `cktinit.c:66-67`
- Our `PIVOT_THRESHOLD = 0.01` vs ngspice's `RelThreshold = 1e-3` — 10× looser
- Our threshold check is **structurally dead**: we select column-max first (line 947-955), then check if `|x[pivotRow]| < 0.01 * maxVal` (line 964-968). Since `pivotRow` IS the argmax, `maxVal < 0.01 * maxVal` is always false. The check can never reject the selected pivot.
- ngspice applies RelThreshold **during** pivot search, eliminating weak candidates from contention before selecting the best. Threshold filters every candidate, not just the winner.
- ngspice has `AbsThreshold = 1e-13` (`CKTpivotAbsTol`): candidates with `|value| < 1e-13` are rejected regardless of relative magnitude. We have no equivalent — only a 1e-300 zero guard.
- ngspice uses Markowitz-criterion fill-minimizing pivot selection; we use pure column-max with AMD pre-permutation.
- ngspice's `spSMALL_PIVOT` fallback accepts the largest element even if below threshold and flags a warning. Our equivalent path is unreachable.
- Fix: restructure pivot selection to apply threshold during search (not after); add AbsThreshold; consider Markowitz cost metric

### Change 16: PMOS temperature scaling — missing type multiplier on tVbi/tVto
**Files:** `mosfet.ts:999-1002`
**ngspice ref:** `mos1temp.c:170-176`
- ngspice: `tVbi = vt0 - type*(gamma*sqrt(phi)) + 0.5*(egfet1-egfet) + type*0.5*(tPhi-phi)`
- Ours: `tVbi = VTO - gamma*sqrt(phi) + 0.5*(egfet1-egfet) + 0.5*(tPhi-phi)` — missing `type*` on both `gamma*sqrt(phi)` and `0.5*(tPhi-phi)` terms
- ngspice: `tVto = tVbi + type * gamma * sqrt(tPhi)`
- Ours: `tVto = tVbi + gamma * sqrt(tPhi)` — missing `type*`
- For NMOS (type=1) no error. For PMOS (type=-1) both gamma and delta-phi terms have wrong signs.
- At TNOM=300.15K the temperature correction is zero so the error vanishes, but any TNOM ≠ 300.15K produces wrong PMOS threshold voltage temperature drift.
- Fix: multiply gamma and delta-phi terms by `type`

### Change 17: MOSFET convergence check includes cap companion current in cd
**Files:** `fet-base.ts:433-503`
**ngspice ref:** `mos1conv.c:36-94`
- ngspice `MOS1convTest` uses `here->MOS1cd` which is set at `mos1load.c:563`: `cd = mode*cdrain - cbd`
- Our `checkConvergence` uses `cdFinal = mode*ids - cbdI - cqbd` — subtracts the junction capacitor companion current `cqbd` that ngspice does not include
- This makes our convergence criterion different from ngspice's for every transient step where junction cap companion currents are nonzero
- Fix: remove `cqbd` from the `cd` value used in convergence checking

### Change 18: MOSFET GMIN added to gm/gds in cutoff
**Files:** `mosfet.ts:583-584, 631`
**ngspice ref:** `mos1load.c:520-521` — `gm=0; gds=0` in cutoff
- Our `computeGm` and `computeGds` return `GMIN` when `vgst <= 0`
- ngspice sets gm=0 and gds=0 in cutoff; the GMIN conductance is added separately via bulk junction stamps (`CKTgmin` on gbs/gbd), not on channel conductances
- Fix: return 0 for gm/gds in cutoff, not GMIN

### Change 19: MODEINITPRED — device-level scalar copies not performed
**Files:** `bjt.ts`, `mosfet.ts`, `diode.ts`
**ngspice ref:** `bjtload.c:278-305`, `mos1load.c:206-225`, `dioload.c:141-148`
- During MODEINITPRED, ngspice explicitly copies operating-point scalars from state1→state0:
  - BJT: vbe, vbc, cc, cb, gpi, gmu, gm, go, gx (`bjtload.c:282-305`)
  - MOSFET: vbs, vgs, vds, vbd, von, vdsat, cd, cbs, cbd, gmbs, gm, gds, gbd, gbs (`mos1load.c:208-225`)
  - Diode: voltage, current, conduct (`dioload.c:142-147`)
- Our devices do not perform these copies. They recompute all scalars from scratch using the predicted node voltages.
- The copied scalars serve as the baseline for convergence checking during the predictor pass. Different baseline = different convergence behavior on the predictor iteration.
- Fix: add initPred handling to each device that copies state1→state0 for all stored scalars before recomputation

### Change 20: Cap/Inductor MODEINITPRED — charge/flux from last accepted vs predicted voltage
**Files:** `capacitor.ts:228-229`, `inductor.ts:240-241`
**ngspice ref:** `capload.c:54-56`, `indload.c:93-96`
- Capacitor: ngspice sets `state0[qcap] = state1[qcap]` (last accepted charge, order-0 in charge space). Ours computes `q0 = C * v_predicted` (order-1 in voltage space → different initial charge for NIintegrate).
- Inductor: ngspice sets `state0[flux] = state1[flux]` (last accepted flux). Ours computes `phi0 = L * i_predicted`.
- The companion model coefficients (geq, ieq) from integrateCapacitor differ because q0 differs.
- Fix: under initPred mode, use `s1[SLOT_Q]` / `s1[SLOT_PHI]` as q0/phi0 instead of computing from predicted voltages

### Change 21: MOSFET MODEINITJCT — missing non-zero startup voltages
**Files:** `mosfet.ts` (no primeJunctions equivalent)
**ngspice ref:** `mos1load.c:419-432`
- ngspice initializes MOSFET for DC-OP with `vbs = -1`, `vgs = tVto`, `vds = 0` (`mos1load.c:427-432`)
- Our MOSFET starts from zero for all voltages; the `von = isNaN(storedVon) ? tVto : storedVon` approximation only covers the von variable, not the initial vbs/vgs/vds
- Fix: add primeJunctions to MOSFET that sets vbs=-1, vgs=tVto, vds=0

### Change 22: Missing device `off` parameter — BJT, Diode, MOSFET
**Files:** `bjt.ts`, `diode.ts`, `mosfet.ts`
**ngspice ref:** `bjtload.c:270-275` (BJT), `dioload.c:132-134` (Diode), `mos1load.c:433-434` (MOSFET)
- ngspice devices support an `off` flag. When set:
  - MODEINITJCT: all junction voltages initialized to 0 (forces device into off state for DC-OP)
  - MODEINITFIX: convergence failure (CKTnoncon++) is suppressed for `off` devices (`bjtload.c:749-753`, `dioload.c:411-414`, `mos1load.c:737-739`)
- Our devices have no `off` property. `primeJunctions` always uses tVcrit; convergence is never suppressed.
- Fix: add `off` property to BJT, Diode, MOSFET; gate primeJunctions and convergence suppression on it

### Change 23: Missing UIC initial conditions — BJT, Diode
**Files:** `bjt.ts`, `diode.ts`
**ngspice ref:** `bjtload.c:258-264` (BJT icVBE/icVCE), `dioload.c:130-131` (Diode initCond)
- ngspice: under MODEINITJCT with MODETRANOP and MODEUIC, uses user-specified initial conditions (icVBE, icVCE for BJT; initCond for diode) instead of default junction priming
- Our devices have no `.ic` property and no UIC handling
- Fix: add ic properties and UIC branch to primeJunctions

### Change 24: _prevVoltages set per-step vs CKTrhsOld swapped per-NR-iterate
**Files:** `analog-engine.ts:307`, `newton-raphson.ts`
**ngspice ref:** `niiter.c:1088-1090` — `temp = CKTrhsOld; CKTrhsOld = CKTrhs; CKTrhs = temp` (pointer swap after each NR iteration)
- ngspice's `CKTrhsOld` holds the **previous NR iteration's** solution vector. Updated after every NR iteration via pointer swap.
- Our `_prevVoltages` is set once at `analog-engine.ts:307` (`this._prevVoltages.set(this._voltages)`) before the NR loop starts. It holds the **last accepted step's** solution, not the previous NR iterate.
- Device `checkConvergence` functions that compare current vs old voltages see different baselines: ngspice compares iter[n] vs iter[n-1]; we compare iter[n] vs start-of-step.
- This affects convergence behavior on every NR iteration after the first within a step.
- Fix: update `_prevVoltages` after each NR iteration to match ngspice's per-iterate swap semantics

### Change 25: Missing VSRC/ISRC breakpoint scheduling after step acceptance
**Files:** `analog-engine.ts` (acceptance block), voltage/current source components
**ngspice ref:** `vsrcacct.c:25-309`, `isrcacct.c:25-309`, called from `cktaccept.c:20-52`
- After each accepted transient step, ngspice calls `VSRCaccept`/`ISRCaccept` which register future waveform edge times into the breakpoint table via `CKTsetBreak`:
  - PULSE: schedules next rise/fall/period edge
  - PWL: schedules next knot time
  - TRNOISE/TRRANDOM: schedules next sample time
- Our engine has no equivalent. Source components evaluate their waveform at `_simTime` during stamping but never register future breakpoints.
- Consequence: the timestep controller cannot clip dt to land precisely on waveform edges. Edge timing is approximate (limited by LTE tolerance). After a sharp edge, ngspice cuts order to 1 (breakpoint behavior); we may not.
- Fix: implement `acceptStep()` callback for voltage/current sources that registers next waveform edge into `_timestep._breakpoints`

### Change 26: MOSFET MAX_EXP_ARG capped at 80 vs ~710
**Files:** `mosfet.ts:1314-1333`
**ngspice ref:** `mos1load.c:453-468` — uses `MAX_EXP_ARG` (≈ `ln(DBL_MAX)` ≈ 709.78)
- Our bulk diode `Math.exp(Math.min(vbs / VT, 80))` caps at exp(80) ≈ 5.5e34
- ngspice caps at exp(~710) ≈ 1.8e308
- The clamped range 80-710 produces different gbs/gbd/cbs/cbd values for forward biases between ~2.07V and ~18.3V (at VT=0.02585)
- Fix: raise cap to match ngspice's MAX_EXP_ARG

### Change 27: Missing MOSFET multiplicity parameter `m`
**Files:** `mosfet.ts`
**ngspice ref:** `mos1load.c:131-141` — `DrainSatCur = m * tSatCurDens * drainArea`
- ngspice's `MOS1m` scales: DrainSatCur, SourceSatCur, Beta, OxideCap, GateOverlapCaps
- Our model ignores `m` (defaults to 1 everywhere)
- Fix: add `m` parameter; apply scaling to all affected quantities

### Change 28: Permittivity constant ε₀ difference
**Files:** `mosfet.ts` (resolveParams)
**ngspice ref:** `mos1temp.c:64-71` — uses `8.854214871e-12`
- Our code uses `8.854187817e-12` (0.003% difference, slightly more accurate vs NIST value)
- Propagates into `oxideCapFactor`, `GAMMA` derivation from NSUB, `KP` derivation from UO/TOX
- Fix: use ngspice's exact constant `8.854214871e-12` for bit-exact match

### Change 29: Predictor always enabled — ngspice default has it off
**Files:** `analog-engine.ts:366-371`, `ni-pred.ts`
**ngspice ref:** `dctran.c:750-752` — `#ifdef PREDICTOR` (not defined in default build)
- ngspice's default build does NOT call NIpred. The predictor is gated behind `#ifdef PREDICTOR` which is not defined. The initial NR guess for each transient step is the last converged solution, unmodified.
- Our engine always calls `computeAgp()` + `predictVoltages()` at `analog-engine.ts:366-371`, extrapolating voltages before NR.
- This means our NR starting point differs from ngspice's on every transient step. Different starting point → different limiting paths, different iteration counts, different convergence trajectories.
- The MODEINITPRED mode handling in devices (Change 19) is also affected: ngspice never enters MODEINITPRED in the default build because the predictor doesn't run. Our engine enters a predictor-like path every step.
- Fix: gate predictor calls behind a configuration flag; default to OFF to match ngspice

### Change 30: Missing inductor INDvolt state slot copy on MODEINITTRAN
**Files:** `inductor.ts`
**ngspice ref:** `indload.c:114-117` — copies `state0[INDvolt]→state1[INDvolt]` on MODEINITTRAN
- ngspice stores and copies the inductor terminal voltage into state1 during MODEINITTRAN
- We have no SLOT_VOLT equivalent; the terminal voltage is not tracked as a state variable
- Fix: add SLOT_VOLT to inductor state schema; copy on initTran

### Change 31: Diode — no temperature scaling of any parameter
**Files:** `diode.ts`
**ngspice ref:** `diotemp.c:90-258`
- ngspice temperature-scales: IS (via EG/XTI), VJ, CJO, M, RS, TT, BV, and VT itself
- Our diode uses raw `params.*` values for all parameters; EG and XTI are declared but never referenced at runtime
- VT is a fixed constant (0.02585V) instead of `kT/q` at operating temperature
- Fix: implement `diotemp.c` equivalent; apply to IS, VJ, CJO, M, RS, TT, BV; make VT temperature-dependent

### Change 32: Diode — missing IBV knee self-consistent iteration
**Files:** `diode.ts`
**ngspice ref:** `diotemp.c:228-244`
- ngspice iterates up to 25 Newton steps to find effective BV (`xbv`) where forward and reverse exponentials join continuously at the breakdown knee
- We use raw `params.BV` directly — no knee matching
- Fix: implement the iterative BV solve from `diotemp.c:228-244`

### Change 33: Diode — missing IKF/IKR high-injection knee correction
**Files:** `diode.ts`
**ngspice ref:** `dioload.c:292-313`
- ngspice applies forward knee current (IKF) and reverse knee current (IKR) corrections to gd when the respective parameters are given
- We have no IKF or IKR parameters
- Fix: add IKF/IKR parameters and high-injection correction to gd

### Change 34: Diode — missing area/perimeter scaling
**Files:** `diode.ts`
**ngspice ref:** `dioload.c:96-98`, `diotemp.c:152`
- ngspice scales IS, RS, CJO by device `area` parameter; sidewall currents scale by `PJ` (perimeter)
- We have no `area` or `PJ` parameters
- Fix: add area parameter; apply scaling to IS, RS, CJO

### Change 35: Varactor — simplified charge integration (C*V instead of proper integral)
**Files:** `varactor.ts:259`
**ngspice ref:** `dioload.c:325` — `Q_depl = VJ*CJO*(1-(1-vd/VJ)^(1-M))/(1-M)`
- Our varactor computes `q0 = Cj * vNow` (linear approximation)
- ngspice computes the proper antiderivative of `CJO*(1-vd/VJ)^(-M)` with respect to vd
- Our own `computeJunctionCharge` in `diode.ts:186-187` has the correct integral — the varactor doesn't use it
- Fix: use `computeJunctionCharge` instead of `Cj * vNow`

### Change 36: Varactor — missing FC forward-bias linearization
**Files:** `varactor.ts:82-92`
**ngspice ref:** `dioload.c:321-332`
- ngspice switches to a linear capacitance approximation at `vd >= FC * VJ` to avoid singularity
- Our varactor has no FC parameter; the `CJO/(1+VR/VJ)^M` formula continues into forward bias and diverges as Vd→VJ
- Fix: add FC parameter and piecewise linearization matching `dioload.c:327-332`

### Change 37: Varactor — missing TT diffusion charge term
**Files:** `varactor.ts`
**ngspice ref:** `dioload.c:351-353` — `diffcap = TT * gdb`
- ngspice adds a transit-time diffusion capacitance to the total capacitance
- Our varactor has no TT parameter and no diffusion charge contribution
- Fix: add TT parameter; compute `Ct = TT * gd` and add to total cap

### Change 38: Capacitor/Inductor — missing IC initial conditions
**Files:** `capacitor.ts`, `inductor.ts`
**ngspice ref:** `capload.c:32-36,47-50`, `indload.c:44-50`
- ngspice supports `IC=` parameter on capacitors (initial voltage) and inductors (initial current), applied under MODEUIC
- Our components have no IC property and no UIC handling
- Fix: add IC parameter to both; apply when MODEUIC + MODEINITTRAN

### Change 39: Capacitor/Inductor — missing temperature coefficients
**Files:** `capacitor.ts`, `inductor.ts`
**ngspice ref:** `captemp.c:69-86`, `indtemp.c:55-72`
- ngspice applies `factor = 1 + tc1*(T-Tnom) + tc2*(T-Tnom)^2` then scales C or L by `factor * scale`
- We have no tc1, tc2, tnom, or scale parameters
- Fix: add temperature coefficient parameters; apply quadratic derating

### Change 40: Capacitor/Inductor — missing multiplicity parameter `m`
**Files:** `capacitor.ts`, `inductor.ts`
**ngspice ref:** `capload.c:74-79`, `indload.c:107`
- ngspice scales capacitor stamps by `m` (parallel multiplier) and divides inductance by `m`
- We have no `m` parameter on either component
- Fix: add `m` parameter; apply scaling in stamp functions

### ~~Change 41: Mutual inductance coupling~~ — VERIFIED CORRECT, MOVED TO CONFIRMED
**See Confirmed Correct section below.** Original investigation incorrectly reported this as missing. Our `CoupledInductorPair` (`coupled-inductor.ts`) matches ngspice's K element exactly.

### Change 42: Zener simplified model — incorrect breakdown amplitude and missing limiting
**Files:** `zener.ts` (simplified model path)
**ngspice ref:** `dioload.c:257-265`
- Simplified zener model uses `IBV` as breakdown exponential amplitude instead of `IS` (`zener.ts:209`); ngspice uses `IS` (`csat`)
- Simplified model has no breakdown-region pnjlim — NR can take unbounded steps into breakdown
- Simplified model uses N for breakdown emission coefficient instead of separate NBV
- The default "spice" model path delegates to `diode.ts` and avoids these issues
- Fix: correct breakdown formula in simplified model; add breakdown pnjlim; add NBV parameter

## Confirmed Correct (No Change)

- **State ring size:** 4 arrays correct for TRAP (ngspice uses 4 of 8)
- **State ring rotation:** s0.set(s1) at retry top equivalent to ngspice's pointer swap at step entry
- **Node damping gating:** isDcOp check correctly matches MODETRANOP|MODEDCOP
- **CKTstate0 damping snapshot:** Already implemented
- **stampCompanion timing:** Correct split (linear once, nonlinear per-iter)
- **Predictor placement:** Inside retry loop, matches ngspice
- **Integration coefficients (NIcomCof):** Trapezoidal order 1 ag[0]=1/dt, ag[1]=-1/dt — MATCH (`integration.ts:38-39` vs `nicomcof.c:39-40`). Trapezoidal order 2 ag[0]=2/dt, ccap=(2/dt)(q0-q1)-ccapPrev — MATCH (`integration.ts:41-42` vs `nicomcof.c:44-45`). xmu=0.5 — MATCH (hardcoded both sides). GEAR order 2 corrector (BDF-2 closed-form) — MATCH (`integration.ts:43-59` vs `nicomcof.c:53-123`). Predictor agp[] trapezoidal formula — MATCH (`ni-pred.ts:58-61` vs `nicomcof.c:142-145`). Call ordering (coefficients before NR) — MATCH. Variable mapping: CKTag→ag0, CKTagp→_agp, verified.
- **NIpred extrapolation formulas:** Trapezoidal order 1 (`ni-pred.ts:177-184` vs `nipred.c:47-52`) — MATCH. Trapezoidal order 2 Adams-Bashforth (`ni-pred.ts:190-201` vs `nipred.c:55-66`) — MATCH. GEAR polynomial (implemented in `ni-pred.ts:215-279`, dead code since method≠"gear"). Nodes predicted: full MNA dimension in both. Call site ordering — MATCH.
- **CKTpred array:** Dead code in default ngspice build. Both `#ifdef PREDICTOR` and `#ifdef NEWTRUNC` are undefined. `CKTpred` is never allocated, written, or read. The active LTE path uses per-device DEVtrunc on CKTstate* charge/flux (`ckttrunc.c:22-56`), not CKTpred. Our lack of a `_pred` array matches default ngspice. (Note: our predictor being always-on is a separate difference — see Change 29.)
- **DCOP iteration limits:** `params.maxIterations` ↔ `CKTdcMaxIter`, `params.dcTrcvMaxIter` ↔ `CKTdcTrcvMaxIter` — MATCH (`dc-operating-point.ts` vs `cktop.c`).
- **DCOP convergence criteria:** Per-sub-solve check on `result.converged` ↔ `converged == 0` — MATCH in semantics.
- **CKTaccept timing:** Fires after NR convergence + LTE acceptance in both engines. Device state equivalent at callback time (our state1 post-acceptTimestep = ngspice state0 pre-rotation). Breakpoint clearing after acceptance — MATCH.
- **CKTaccept per-device:** BJT, MOSFET, Diode, Capacitor, Inductor have **no** DEVaccept in ngspice (NULL function pointer). Our updateCompanion/updateState are additional bookkeeping with no ngspice counterpart — not a conflict.
- **MOSFET IDS formulas:** All regions (cutoff, linear, saturation) — MATCH (`mosfet.ts:500-550` vs `mos1load.c:500-546`). sarg body-effect, von/vth — MATCH (algebraically identical). gm, gds, gmbs — MATCH.
- **MOSFET fetlim:** EXACT MATCH (`newton-raphson.ts:288-331` vs `devsup.c:93-151`). limvds — EXACT MATCH (`newton-raphson.ts:345-360` vs `devsup.c:21-40`). Limiting call sequence (forward/reverse) — EXACT MATCH.
- **MOSFET Meyer capacitance model:** DEVqmeyer all four regions — EXACT MATCH (`mosfet.ts:803-855` vs `devsup.c:624-689`). Cap averaging (state0+state1) — MATCH. Gate overlap cap stamps — MATCH.
- **MOSFET bulk diode formula:** gbs/gbd/cbs/cbd structure — MATCH (`mosfet.ts:1314-1333` vs `mos1load.c:453-468`).
- **MOSFET temperature scaling (NMOS only):** KP ratio4 — MATCH. tPhi derivation — MATCH. Saturation current — MATCH. Junction cap capfact — MATCH. (PMOS has bugs, see Change 16.)
- **BJT MODEINITTRAN charge copies:** qbe, qbc, qcs q0→q1 — MATCH (`bjt.ts:1892-1893, 1936-1937, 1988-1989` vs `bjtload.c:715-724`). ccap copies — MATCH. Weil excess-phase cexbc history — MATCH.
- **MOSFET MODEINITTRAN:** Gate cap zeroing — MATCH (`fet-base.ts:570-578` vs `mos1load.c:862-873`). Charge Q=C*V (tranop) and incremental accumulation (tran) — MATCH (`fet-base.ts:599-613` vs `mos1load.c:829-852`).
- **Diode MODEINITTRAN:** Voltage from node vector = DC-OP value — MATCH functionally. q0→q1 via seedHistory — MATCH. ccap both 0 at step 0 — MATCH.
- **Capacitor MODEINITTRAN:** q0→q1 via seedHistory — MATCH. ccap0→ccap1 both 0 — MATCH.
- **Inductor MODEINITTRAN:** flux0→flux1 via seedHistory — MATCH. DC-OP short circuit (req=0, veq=0) — MATCH.
- **Coupled inductor / mutual inductance (K element):** `CoupledInductorPair` (`coupled-inductor.ts`) matches ngspice's K element. M = k*sqrt(L1*L2) — MATCH (`coupled-inductor.ts:158` vs `muttemp.c:41`). Self coefficient L*ag[0] — MATCH. Mutual coefficient M*ag[0] — MATCH. Off-diagonal stamps negative symmetric — MATCH (`coupled-inductor.ts:208-216` vs `indload.c:74-75`). TRAP history includes prior voltage — MATCH. BDF-2/GEAR-2 coefficients — MATCH. DC-OP short circuit (no stampCompanion during DCOP) — MATCH. MODEINITTRAN seed via seedHistory — MATCH.
- **MOSFET MOS1convTest formulas:** cdhat (normal + reverse mode) — MATCH. cbhat — MATCH. Tolerance formula — MATCH. (cd value used differs, see Change 17.)
- **Diode Id/gd formulas:** Forward (Shockley), weak-reverse (cubic approximation), breakdown (exponential) — all three regions MATCH (`diode.ts:225-239` vs `dioload.c:245-265`). N emission coefficient, RS series resistance stamping — MATCH.
- **Diode junction capacitance:** Depletion cap `CJO*(1-Vd/VJ)^(-M)` with FC linearization — MATCH (`diode.ts:124-141` vs `dioload.c:321-332`). Diffusion cap `TT*gd` — MATCH.
- **Diode convergence test (DIOconvTest):** cdhat formula, tolerance, pnjlim icheck gate — MATCH (`diode.ts:424-439` vs `dioconv.c:35-53`).
- **Diode pnjlim:** Forward limiting — MATCH. Breakdown reflection path — MATCH. Vcrit computation — MATCH (`diode.ts:365` vs `diotemp.c:187`).
- **Diode GMIN handling:** Added to gd and Id unconditionally — MATCH (`diode.ts:415-416` vs `dioload.c:295-313`).
- **Schottky diode:** No separate ngspice device — parameterized DIO. Our `schottky.ts` delegates entirely to `createDiodeElement` with physically correct parameter defaults (IS=1e-8, EG=0.69, TT=0, XTI=2). No formula differences from base diode. (Temperature gaps inherited from diode, see Change 31.)
- **LED:** No ngspice LED device. Our `led.ts` uses base diode physics. No formula errors in implemented subset. Missing RS, IKF/IKR, sidewall — capability gaps, not formula errors.
- **Tunnel diode:** No ngspice tunnel diode model exists. Our implementation is an independent empirical model (Esaki formula). Cannot verify against ngspice — document as no reference available.
- **Varactor reverse-bias capacitance:** `CJO/(1+VR/VJ)^M` algebraically identical to ngspice's `CJO/(1-vd/VJ)^M` for reverse bias — MATCH. pnjlim and convergence check patterns correct. (Forward-bias, charge integration, and TT gaps: see Changes 35-37.)
- **Capacitor companion model:** geq = ag0 * C, ceq = ccap - geq * vNow — MATCH (`capacitor.ts:234`, `integration.ts:62-64` vs `capload.c:67-79`). No voltage-dependent capacitance in either engine.
- **Inductor companion model:** geq = ag0 * L, ceq = ccap - geq * iNow, branch equation stamping — MATCH (`inductor.ts:203-230`, `integration.ts:109-111` vs `indload.c:108-124`).

## No ngspice Reference Available

- **Tunnel diode:** Our `tunnel-diode.ts` implements an independent empirical model (Esaki peak/valley + excess + Shockley). ngspice has no tunnel diode device type. The `DIOtunSatCur` (JTUN) parameter in `dioload.c:267-285` is a reverse leakage modifier, not an N-shaped NDR device. Our implementation cannot be verified against ngspice.

## Implementation Order

Phased approach recommended:
1. **Phase A (firsttime + LTE skip):** Changes 1, 3, 4, 5, 7 — the `_firsttime` lifecycle
2. **Phase B (mode automaton):** Changes 2, 6, 9 — the INITF state machine inside NR
3. **Phase C (structural):** Change 8 — deltaOld ring expansion
4. **Phase D (DCOP fallback):** Changes 10, 11, 12, 13 — DC operating point chain
5. **Phase E (sparse solver):** Changes 14, 15 — matrix reorder triggers and pivot selection
6. **Phase F (MOSFET correctness):** Changes 16, 17, 18, 26, 27, 28 — MOSFET model fixes
7. **Phase G (device INITF):** Changes 19, 20, 21, 22, 23 — per-device mode handling
8. **Phase H (NR/acceptance):** Changes 24, 25, 29 — per-iterate voltage tracking, source breakpoints, predictor gating
9. **Phase I (device params):** Changes 30, 38, 40 — INDvolt slot, IC params, multiplicity `m`
10. **Phase J (diode correctness):** Changes 31, 32, 33, 34 — diode temperature scaling, IBV knee solve, IKF/IKR, area scaling
11. **Phase K (varactor correctness):** Changes 35, 36, 37 — charge integration, FC linearization, TT diffusion
12. **Phase L (temperature):** Changes 39 — capacitor/inductor temperature coefficients
13. **Phase M (zener simplified):** Change 42 — simplified zener model fixes

Phase A is self-contained and can be tested independently. Phase B requires Phase A. Phase C is independent. Phases D-M are independent of each other but all benefit from Phase B (mode automaton) being in place first. Change 29 (predictor gating) interacts with Changes 19 and 20 (device MODEINITPRED handling) — if the predictor is off, MODEINITPRED is never entered, matching ngspice default behavior.
