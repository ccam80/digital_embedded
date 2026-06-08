# Fix-list clustering — shared-root hubs

86 fix-list items → **48 connected-component clusters**.

Edges: shared source file · shared theme + substrate file · shared 2-item test file.
Clusters sorted by remaining (open) test payoff.

**15 multi-item hubs**, **33 singletons**.


## Cluster 1 [HUB] — 10/10 item(s) open · 21/59 tests still failing
- themes: opamp-convergence×4, node-mapping×4, deck-emission×2, temperature×2, state-pool×2, param-instantiation×1, integration-tran×1, numeric-ulp×1
- dirs: src/components/semiconductors (6), src/solver/analog (2), src/solver/analog/__tests__/harness (2), src/components/active (1), src/solver/analog/__tests__ (1)
  - **[PARTIAL] (11/49t)** `composite-leaf-givenness`
    - Do not mark leaf-default model params as given during composite expansion. Use a non-given default-seeding path so isModelParamGiven only re
  - **[OPEN] (2/2t)** `src/components/semiconductors/diode.ts:839`
    - Always allocate the RS internal prime node at setup() regardless of RS value (or re-run topology setup on RS hot-load), so a nonzero RS load
  - **[OPEN] (1/1t)** `src/solver/analog/__tests__/mna-end-to-end.test.ts:435`
    - Set the test Vt to CONSTKoverQ*300.15 (=0.0258646V) rather than 0.02585, matching the engine REFTEMP of 300.15K (27C). No source change; the
  - **[OPEN] (1/1t)** `src/solver/analog/__tests__/harness/comparison-session.ts:1480`
    - Index the 1-based voltages array with row+1 in the branch loop (ourFinal.voltages[row+1] and ngFinal.voltages[row+1]) at comparison-session.
  - **[OPEN] (1/1t)** `src/solver/analog/compiler.ts:1571`
    - In the analog compiler, resolve parsed .nodeset net/pin names to MNA node ids and pass a nodesets Map into the ConcreteCompiledAnalogCircuit
  - **[OPEN] (1/1t)** `src/components/semiconductors/diode.ts:942`
    - Same as full_iteration_paired_blocking: use harness_get_attempt on DIAC1_D_rev across the failing DCOP iters to confirm the breakdown pnjlim
  - **[OPEN] (1/1t)** `src/solver/analog/__tests__/harness/comparison-session.ts:3066`
    - In getLimitingComparison normalize the SPICE type prefix when matching ng events to the requested label (strip leading device-type letter D/
  - **[OPEN] (1/1t)** `src/components/semiconductors/diode.ts:1388`
    - Borderline NR-tolerance gap, not a temperature-override bug. Either re-run a full DCOP before reading vfAfter, or the single step settles wi
  - **[OPEN] (1/1t)** `src/components/semiconductors/diode.ts:1379`
    - Make the diode setParam(BV,...) path re-establish the breakdown regime: ensure the finite-BV branch flags/seed used at setup (and the warm-s
  - **[OPEN] (1/1t)** `src/components/semiconductors/diode.ts:1258`
    - Make _recordLimit emit the junction name VD (matching the DIOvoltage state-slot name at diode.ts:68 and ngspice diodefs.h:196) instead of th

## Cluster 2 [HUB] — 4/4 item(s) open · 14/14 tests still failing
- themes: digital-level-contract×1, opamp-convergence×1, state-pool×1, integration-tran×1
- dirs: src/components/active (4)
  - **[OPEN] (8/8t)** `driver-ctrl-contract`
    - The driver must stamp the NORMALIZED logic level onto ctrl_out, not the rail-level vTarget. With latch=0 inactive the logic level is 1 (-> o
  - **[OPEN] (4/4t)** `comparator-latch-polarity`
    - Invert the latch transition conditions at lines 165-166: latch should go to 1 (sinking) when vPlus < vTl and release to 0 when vPlus >= vTh,
  - **[OPEN] (1/1t)** `src/components/active/comparator-driver.ts:181`
    - The DC weight collapse pre-saturates OUTPUT_WEIGHT so the transient integration test starts at the target. Either the DC branch should not p
  - **[OPEN] (1/1t)** `src/components/active/timer-555.ts:56`
    - The discharge BJT must saturate and pull DIS toward GND when the base is driven to vDrop. Investigate the bjtDis NpnBJT spice-model area/IS 

## Cluster 3 [HUB] — 3/3 item(s) open · 12/12 tests still failing
- themes: opamp-convergence×1, integration-tran×1
- dirs: src/components/active (3)
  - **[OPEN] (7/7t)** `real-opamp-raillim`
    - Same fix as the sibling record: replace the hard RHS-branch switch at real-opamp.ts:541-556 with a continuous-Jacobian rail-saturation linea
  - **[OPEN] (3/3t)** `src/components/active/real-opamp.ts:553`
    - In the transient gain-stage the vos offset must propagate through the same loop gain as the steady-state DC path; the line-555 RHS uses aEff
  - **[OPEN] (2/2t)** `src/components/active/real-opamp.ts:170`
    - Either the param default vos at real-opamp.ts:170 (1e-3) is non-zero while the test fixture assumes 0, or the gain-stage vos term at line 55

## Cluster 4 [HUB] — 7/10 item(s) open · 10/20 tests still failing
- themes: integration-tran×8, opamp-convergence×5, deck-emission×4, digital-threshold×2, state-pool×1
- dirs: src/solver/analog (8), src/components/passives (1)
  - **[OPEN] (4/4t)** `src/components/passives/crystal.ts:195`
    - Add a setParam path on the composite that recomputes Ls/Rs (crystalMotionalInductance/crystalSeriesResistance) and delegates resistance/indu
  - **[OPEN] (1/1t)** `UNRESOLVED`
    - Run harness on an equivalent RC .dts (R=1k C=1uF stopTime=5e-3) and compare cap-node voltage trajectory vs ngspice via harness_get_attempt t
  - **[OPEN] (1/1t)** `src/solver/analog/analog-engine.ts:2282`
    - Either the test must take one accepted transient step before reading state1 (its name says after accepted transient step but it builds with 
  - **[OPEN] (1/1t)** `src/solver/analog/analog-engine.ts:625`
    - Either the rejection path must restore state pool s0 from s1 before the retry to honor the asserted invariant, or the test invariant is wron
  - **[OPEN] (1/1t)** `src/solver/analog/analog-engine.ts:1082`
    - Make the transient first-step seeding (currentDt=firstStep and _seedFromDcop) robust to the transformer coupled-inductor DCOP path so MODEIN
  - **[OPEN] (1/1t)** `src/solver/analog/analog-engine.ts:681`
    - Confirm via convergence log whether the engine errors on this fixture; if it errors, ensure the error-exit path records a StepRecord so the 
  - **[OPEN] (1/1t)** `src/solver/analog/analog-engine.ts:1091`
    - Trace why _params.firstStep (resolveSimulationParams) is 0 for these transformer transient runs so the first-step dt feeds a nonzero ag0; th
  - **[DONE] (0/5t)** `src/solver/analog/dc-operating-point.ts:496`
    - Enable/repair the OPtran pseudo-transient fallback (dc-operating-point.ts lines 496-521 gated by params.optran and ctx.opTranFallback) so th
  - **[DONE] (0/3t)** `src/solver/analog/dc-operating-point.ts:403`
    - Compare our dynamicGmin-to-newGmin fallthrough and gillespieSrc backtracking attempt sequence against ngspice cktop.c dynamic_gmin/gillespie
  - **[DONE] (0/2t)** `src/solver/analog/analog-engine.ts:317`
    - Run the initial transient operating-point solve at init()/compile() time (capturing the source value present then) so a later hot setSignal 

## Cluster 5 [HUB] — 2/2 item(s) open · 8/8 tests still failing
- themes: numeric-ulp×1, integration-tran×1, state-pool×1
- dirs: src/solver/analog (2)
  - **[OPEN] (6/6t)** `src/solver/analog/ckt-terr.ts:53`
    - Source line 53 already matches ngspice cktterr.c:25 truncated literal. The test factor 2/9 at test line 233 is the divergent value; per SPIC
  - **[OPEN] (2/2t)** `src/solver/analog/ckt-terr.ts:190`
    - Delete the line 190 early return; let denom=Math.max(abstol, factor*ddiff) clamp to abstol when ddiff===0, matching cktterr.c:69, then retur

## Cluster 6 [HUB] — 2/2 item(s) open · 7/7 tests still failing
- themes: digital-level-contract×1, digital-threshold×1, opamp-convergence×1
- dirs: src/components/switching (1), src/solver/digital (1)
  - **[OPEN] (6/6t)** `src/components/switching/behavioral-fet-driver.ts:135`
    - Classify the gate logic level on V(G) against a fixed logic reference (or add hysteresis/continuation smoothing) instead of the source-relat
  - **[OPEN] (1/1t)** `src/solver/digital/compiler.ts:647`
    - Add an FGPFET (and FGNFET) branch in the Step 8d seeding loop (compiler.ts:645-665) that writes initialStateSlots[stBase+1] = blown property

## Cluster 7 [HUB] — 2/2 item(s) open · 7/9 tests still failing
- themes: (none matched)
- dirs: src/components/active (1), src/solver (1)
  - **[OPEN] (4/4t)** `src/solver/coordinator.ts:716`
    - Composite param hot-load must fan out to every compiled sub-element of the CircuitElement (build a one-to-many map) and route plain model-pa
  - **[PARTIAL] (3/5t)** `schmitt-rout-key`
    - Change the rOut sub-element param map from {R: rOut} to {resistance: rOut} in SCHMITT_NON_INVERTING_NETLIST (and SCHMITT_INVERTING_NETLIST l

## Cluster 8 [HUB] — 3/3 item(s) open · 7/7 tests still failing
- themes: opamp-convergence×1, numeric-ulp×1, state-pool×1, integration-tran×1, temperature×1
- dirs: src/components/passives (3)
  - **[OPEN] (4/4t)** `src/components/passives/capacitor.ts:641`
    - Test targets wrong leaf: probe cap:rLeak (or cap:rEsr) for DC series current, not cap:cBody. Source is correct; if a total-component current
  - **[OPEN] (2/2t)** `src/components/passives/capacitor.ts:592`
    - The invariant cannot be met through the C*vcap path while node voltages carry 1-ULP solver roundoff between identical steps. Either the reco
  - **[OPEN] (1/1t)** `src/components/passives/capacitor.ts:491`
    - In capacitor.ts setParam, after setting _nominalC recompute this.C = _nominalC * _SCALE (or have the engine re-run computeTemperature on any

## Cluster 9 [singleton] — 1/1 item(s) open · 6/6 tests still failing
- themes: integration-tran×1
- dirs: src/components/digital-pins (1)
  - **[OPEN] (6/6t)** `src/components/digital-pins/digital-output-pin-loaded.ts:99`
    - Either re-settle to DCOP after setComponentProperty (zero out cOut companion) before reading, or have the test compare against the transient

## Cluster 10 [singleton] — 1/1 item(s) open · 5/5 tests still failing
- themes: opamp-convergence×1
- dirs: src/solver/analog (1)
  - **[OPEN] (5/5t)** `src/solver/analog/ckt-load.ts:127`
    - The load path is family-bucket driven (runByDeviceFamily over elementsByFamily); the hand-built fixtures must populate elementsByFamily from

## Cluster 11 [HUB] — 4/4 item(s) open · 5/5 tests still failing
- themes: integration-tran×4, numeric-ulp×1, digital-threshold×1, opamp-convergence×1
- dirs: src/components/passives (2), src/solver/analog (2)
  - **[OPEN] (2/2t)** `src/components/passives/inductor.ts:891`
    - Investigate why the transient timestep never advances for coupled inductors (MutualInductor + 3 Inductors): the engine accepts only the t=0 
  - **[OPEN] (1/1t)** `src/solver/analog/timestep.ts:435`
    - Replay from the first non-matching delta: compare our computeNewDt (timestep.ts:412-456, 2x growth cap line 440) and getClampedDt post-break
  - **[OPEN] (1/1t)** `src/components/passives/inductor.ts:685`
    - In setParam(IC), when stateBase/pool are live, seed s0[PHI]=s1[PHI]=(_effectiveL/_M)*value (mirror the memristor initialState setParam that 
  - **[OPEN] (1/1t)** `src/solver/analog/timestep.ts:616`
    - Test-precondition gap, not a source bug: shouldReject and cktTerr match ngspice. To exercise the rollback path the fixture needs sharper flu

## Cluster 12 [singleton] — 1/1 item(s) open · 4/4 tests still failing
- themes: opamp-convergence×1, state-pool×1, integration-tran×1
- dirs: src/components/sensors (1)
  - **[OPEN] (4/4t)** `src/components/sensors/spark-gap.ts:226`
    - Make the CONDUCTING slot written to s0 in load() reach state1 each accepted step (boot DCOP seeds s1 so init tests pass; the transient per-s

## Cluster 13 [HUB] — 2/2 item(s) open · 4/4 tests still failing
- themes: integration-tran×2, state-pool×1
- dirs: src/components/passives (2)
  - **[OPEN] (3/3t)** `src/components/passives/memristor.ts:259`
    - Assert the seed against fix.pool.state1[mem._stateBase+SLOT_W] (last-accepted, pre-first-step) instead of state0[W], or relax to verify stat
  - **[OPEN] (1/1t)** `src/components/passives/memristor.ts:226`
    - In DC mode the memristor must read the last-accepted W from s1 (like the inductor), not s0. Reading s0 only holds the seed on the FIRST load

## Cluster 14 [HUB] — 2/2 item(s) open · 4/4 tests still failing
- themes: temperature×2, digital-threshold×1, opamp-convergence×1, deck-emission×1, numeric-ulp×1
- dirs: src/components/semiconductors (2)
  - **[OPEN] (2/2t)** `src/components/semiconductors/mosfet.ts:1375`
    - Source is ngspice-correct (mos1load.c von formula). The test needs a fixture with nonzero GAMMA and a nonzero Vbs so PHI feeds the body-effe
  - **[OPEN] (2/2t)** `src/components/semiconductors/mosfet.ts:420`
    - Drill the temp pass tTransconductance (KP/ratio4) tVto and tPhi lines 420 423-430 against mos1temp.c at instanceTemp=350K; the absDelta 3.98

## Cluster 15 [singleton] — 1/1 item(s) open · 3/3 tests still failing
- themes: (none matched)
- dirs: src/test-utils (1)
  - **[OPEN] (3/3t)** `src/test-utils/non-engine-coordinator.ts:126`
    - Change non-engine-coordinator.ts line 126 from let nextSnapshotId = 1 to let nextSnapshotId = 0 to match DigitalEngine 0-based snapshot IDs.

## Cluster 16 [HUB] — 2/2 item(s) open · 2/3 tests still failing
- themes: digital-threshold×1, numeric-ulp×1, integration-tran×1
- dirs: src/components/passives (2)
  - **[PARTIAL] (1/2t)** `src/components/passives/polarized-cap.ts:207`
    - Align the leaf stamp accumulation order on the nCap diagonal with ngspice. The leaf order in POLARIZED_CAP_NETLIST_BUILDER elements[] (polar
  - **[OPEN] (1/1t)** `src/components/passives/polarized-cap.ts:641`
    - Read the ESR-limited current off cap:rEsr (the resistor in the series path), not the cap:cBody companion current, and read it at the first t

## Cluster 17 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: temperature×1
- dirs: src/components/semiconductors (1)
  - **[OPEN] (2/2t)** `src/components/semiconductors/zener.ts:230`
    - Add a tIS (DIOtSatCur) derivation to _computeZenerTp mirroring diotemp.c:175-185 (scale IS by exp((T/TNOM-1)*EG/vt)*(T/TNOM)^(XTI/N)) and us

## Cluster 18 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: deck-emission×1
- dirs: src/components/switching (1)
  - **[OPEN] (2/2t)** `src/components/switching/trans-gate.ts:337`
    - Mark TransGateDefinition pairedSpiceEquivalent:false (like fuse/opamp/ota) and switch these tests from ComparisonSession.create (T3 paired) 

## Cluster 19 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: (none matched)
- dirs: src/components/digital-pins (1)
  - **[OPEN] (2/2t)** `src/components/digital-pins/digital-input-pin-loaded.ts:13`
    - Reconcile rIn default: either the source default should be 100k or the test must assert the 1MOhm sag (approx 4.9505); the loaded vs unloade

## Cluster 20 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: (none matched)
- dirs: src/components/gates (1)
  - **[OPEN] (2/2t)** `src/components/gates/and.ts:196`
    - Have buildAndGateNetlist read the per-pin loaded flag and per-pin ResolvedPinElectrical (the _pinLoading / _pinElectrical maps set on props 

## Cluster 21 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: digital-level-contract×1, digital-threshold×1
- dirs: src/components/active (1)
  - **[OPEN] (2/2t)** `adc-thresholder-midpoint`
    - clk_result carries logic levels 0.0/0.5/1.0 from DigitalInputThresholder. The driver must classify clk high only when vClock > 0.5 (above in

## Cluster 22 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: digital-threshold×1, integration-tran×1
- dirs: src/solver/analog (1)
  - **[OPEN] (2/2t)** `src/solver/analog/ni-integrate.ts:64`
    - Drill the first-transient-step ag fed to the inductor load: at MODEINITTRAN the engine ag[0] driving geq (ni-integrate.ts:64) is half of ngs

## Cluster 23 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: deck-emission×1
- dirs: src/solver/analog/behavioral-drivers (1)
  - **[OPEN] (2/2t)** `src/solver/analog/behavioral-drivers/bridge-output-driver.ts:154`
    - The bridge boundary drivers inject a parasitic 1/rHiZ (and 1/rOut) conductance that the ngspice deck has no counterpart for. Either suppress

## Cluster 24 [singleton] — 1/1 item(s) open · 2/2 tests still failing
- themes: (none matched)
- dirs: src/components/io (1)
  - **[OPEN] (2/2t)** `src/components/io/clock.ts:306`
    - Make _vdd (and _halfPeriod) mutable and implement setParam: key vdd updates _vdd, key Frequency recomputes _halfPeriod = 1/(2*value). The in

## Cluster 25 [HUB] — 2/2 item(s) open · 2/2 tests still failing
- themes: integration-tran×1
- dirs: src/components/semiconductors/__tests__ (2)
  - **[OPEN] (1/1t)** `src/components/semiconductors/__tests__/schottky.test.ts:138`
    - Test-design bug: assert on the diode internal voltage drop (V(D1:A)-V(D1:K)) or the cathode node, not the source-clamped anode node. Diode s
  - **[OPEN] (1/1t)** `src/components/semiconductors/__tests__/schottky.test.ts:156`
    - Test-design bug: read a non-source-clamped node (cathode D1:K or the internal prime) to observe the CJO-dependent transient. The diode cap p

## Cluster 26 [HUB] — 2/2 item(s) open · 2/2 tests still failing
- themes: digital-threshold×2
- dirs: src/solver (1), src/components/active (1)
  - **[OPEN] (1/1t)** `src/solver/coordinator.ts:915`
    - Make setComponentProperty fan out the param to ALL analog sub-elements whose CircuitElement is the target (iterate elementToCircuitElement c
  - **[OPEN] (1/1t)** `src/components/active/dac-driver.ts:196`
    - Stamp a Thevenin output (target voltage behind rOut) in DACDriver.load instead of an ideal VSRC branch, and wire the rOut param into the dri

## Cluster 27 [HUB] — 1/3 item(s) open · 1/5 tests still failing
- themes: digital-threshold×1
- dirs: src/components/sources (3)
  - **[OPEN] (1/1t)** `src/components/sources/ac-voltage-source.ts:498`
    - This is a test-expectation issue: either step the fixture to a non-trivial t (e.g. a few modulation periods, t ~ 1/modFreq) before reading, 
  - **[DONE] (0/2t)** `src/components/sources/ac-voltage-source.ts:427`
    - Add a case noise arm to enumWaveformCoeffs returning functionType TRNOISE with the seeded coeffs so the noise enum routes onto evaluateNgspi
  - **[DONE] (0/2t)** `src/components/sources/ac-voltage-source.ts:513`
    - Retarget the statistical audit at the seeded TRNOISE generator via evaluateNgspiceWaveform with a TRNOISE coefficient vector (randnumb recon

## Cluster 28 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: opamp-convergence×1
- dirs: src/solver/analog/__tests__ (1)
  - **[OPEN] (1/1t)** `src/solver/analog/__tests__/newton-raphson.test.ts:130`
    - Change the expectation at newton-raphson.test.ts:130 to toBe(3) to match the INITJCT/INITFIX/INITFLOAT ladder both engines run. No source ch

## Cluster 29 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: opamp-convergence×1
- dirs: src/components/active (1)
  - **[OPEN] (1/1t)** `src/components/active/ota.ts:226`
    - This is a test-contract error not a source bug: gmMax only bounds the linearization slope and cancels at the fixed point. Either assert on c

## Cluster 30 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/passives (1)
  - **[OPEN] (1/1t)** `src/components/passives/analog-fuse.ts:323`
    - Seed _intact from props.blown: add a blown param to AnalogFuseElement constructor (initializing _intact = !blown) and pass props.getOrDefaul

## Cluster 31 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: deck-emission×1, node-mapping×1
- dirs: src/components/switching (1)
  - **[OPEN] (1/1t)** `src/components/switching/current-controlled-switch.ts:311`
    - This is an architectural divergence to escalate, not a numerical bug: the normallyClosed inversion in current-controlled-switch.ts:311 has n

## Cluster 32 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: temperature×1, state-pool×1
- dirs: src/components/sensors (1)
  - **[OPEN] (1/1t)** `src/components/sensors/ntc-thermistor.ts:298`
    - In getPinCurrents branch on _selfHeating like load() does: when !_selfHeating use this._tAmbient for tOld (and computeRFromT) so a hot-loade

## Cluster 33 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: opamp-convergence×1, state-pool×1
- dirs: src/components/semiconductors (1)
  - **[OPEN] (1/1t)** `src/components/semiconductors/triode-analog-element.ts:311`
    - This is correct SPICE-parity caching - the slot is meant to lag by one iteration. The test expectation at line 98 (cached VPK == final node 

## Cluster 34 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: digital-threshold×1, integration-tran×1
- dirs: src/solver/analog/behavioral-drivers (1)
  - **[OPEN] (1/1t)** `src/solver/analog/behavioral-drivers/mux-driver.ts:95`
    - Re-settle to DCOP after the threshold hotload before reading, or restructure the thresholder/driver chain so a within-step NR fully propagat

## Cluster 35 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: node-mapping×1, schema-partial×1, state-pool×1, integration-tran×1
- dirs: src/solver/analog/behavioral-drivers (1)
  - **[OPEN] (1/1t)** `src/solver/analog/behavioral-drivers/d-flipflop-driver.ts:85`
    - Replace the multiplicative edge detector and instance-field _firstSample with the documented NaN-sentinel scheme in SLOT_LAST_CLOCK: detect 

## Cluster 36 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/memory (1)
  - **[OPEN] (1/1t)** `src/components/memory/counter.ts:279`
    - Two parts: (1) the analog loading override path requires the behavioral netlist; either the test must set model:behavioral or the override c

## Cluster 37 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/active (1)
  - **[OPEN] (1/1t)** `src/components/active/ccvs.ts:180`
    - Add a transresistance branch to setParam (line 180-184) that, when the expression is the default I(sense) linear shortcut, reparses value * 

## Cluster 38 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/memory (1)
  - **[OPEN] (1/1t)** `src/components/memory/program-counter.ts:240`
    - Fixture/test bug: build the PC at bitWidth>=2 so Q=2 is representable. Source line 240 is correct ngspice-style modular increment.

## Cluster 39 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: digital-threshold×1, deck-emission×1, numeric-ulp×1
- dirs: src/solver/analog (1)
  - **[OPEN] (1/1t)** `src/solver/analog/ngspice-load-order.ts:0`
    - Align the per-leaf load() walk order for the PolarizedCap composite so rEsr/rLeak/cBody stamp the nCap diagonal in the same sequence ngspice

## Cluster 40 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/active (1)
  - **[OPEN] (1/1t)** `src/components/active/opamp.ts:298`
    - In setParam, when key===rOut update this._rOut (or make load/G read this._p.rOut directly so the live value drives the conductance). The cac

## Cluster 41 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: (none matched)
- dirs: src/components/active (1)
  - **[OPEN] (1/1t)** `src/components/active/vccs.ts:162`
    - Implement setParam so key transconductance (and gain/m) rebuilds the linear expression / effectiveGm = transconductance*m used in stampOutpu

## Cluster 42 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: state-pool×1
- dirs: src/components/flipflops (1)
  - **[OPEN] (1/1t)** `src/components/flipflops/monoflop.ts:163`
    - Seed prevClock from the actual initial clock level so a pre-existing high does not register as a rising edge (e.g. initialize prevClock=cloc

## Cluster 43 [singleton] — 1/1 item(s) open · 1/1 tests still failing
- themes: deck-emission×1, state-pool×1
- dirs: src/components/graphics (1)
  - **[OPEN] (1/1t)** `src/components/graphics/graphic-card.ts:348`
    - Mask the packed output to the data bus width: read dataBits via layout.getProperty(index, dataBits) and AND the result with ((1<<dataBits)-1

## Cluster 44 [singleton] — 0/1 item(s) open · 0/8 tests still failing
- themes: digital-level-contract×1, digital-threshold×1
- dirs: src/solver/analog/behavioral-drivers (1)
  - **[DONE] (0/8t)** `src/solver/analog/behavioral-drivers/digital-input-thresholder.ts:73`
    - Replace the three-way dead-band classifier with a single midpoint comparison v > 0.5 ? 1.0 : 0.0 (normalized {0,1} contract) and drop the vI

## Cluster 45 [singleton] — 0/1 item(s) open · 0/2 tests still failing
- themes: digital-threshold×1, opamp-convergence×1, deck-emission×1, numeric-ulp×1
- dirs: src/components/passives (1)
  - **[DONE] (0/2t)** `src/components/passives/transmission-line-element.ts:268`
    - This is a zero-tolerance Object.is comparison failing on a 1-ULP delta where ours is more accurate than ngspice. To reach bit-exact match th

## Cluster 46 [singleton] — 0/1 item(s) open · 0/2 tests still failing
- themes: (none matched)
- dirs: src/editor (1)
  - **[DONE] (0/2t)** `src/editor/wire-current-resolver.ts:32`
    - Add an element identity field (elementIndex or label) to ComponentCurrentPath and populate it at the push sites in resolve() (lines 298 and 

## Cluster 47 [singleton] — 0/1 item(s) open · 0/1 tests still failing
- themes: integration-tran×1
- dirs: src/solver/digital (1)
  - **[DONE] (0/1t)** `src/solver/digital/bus-resolution.ts:75`
    - Mask each driver value and non-highZ mask to the net declared bit width before the conflict XOR at bus-resolution.ts:75 (carry the net width

## Cluster 48 [singleton] — 0/1 item(s) open · 0/1 tests still failing
- themes: (none matched)
- dirs: src/solver/analog/behavioral-drivers (1)
  - **[DONE] (0/1t)** `src/solver/analog/behavioral-drivers/bridge-input-driver.ts:124`
    - In setParam case cIn forward the value to the child cap: this._capChild?.setParam(capacitance, value) (and reconcile when _capChild is null 
