# Review Report: Phase 2 - NR Loop Alignment

Scope: Wave 2.1 (Tasks 2.1.1, 2.1.2, 2.1.3) + Wave 2.2 (Tasks 2.2.1, 2.2.2, 2.2.3) + batch-5-fix remediation (af407a3b)
Reviewed: 2026-04-18
Reviewer: claude-orchestrator:reviewer (ab3a8e9e345af2e9c)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 6 |
| Violations critical | 0 |
| Violations major | 3 |
| Violations minor | 3 |
| Gaps | 2 |
| Weak tests | 3 |
| Legacy references | 2 |

Verdict: has-violations
## Violations

### V-01 Major: Historical-provenance comment in newton-raphson.ts JSDoc

File: src/solver/analog/newton-raphson.ts
Line: 50
Rule: rules.md historical-provenance comment ban

The JSDoc for applyNodesetsAndICs reads: on specific nodes. Called after CKTload (stampAll) during each NR iteration.

The phrase CKTload (stampAll) is a historical-provenance reference. stampAll is the deleted MNAAssembler method. The parenthetical (stampAll) is a dead-name reference to a deleted API decorating retained code.

Severity: major

### V-02 Major: Stale comment in ckt-load.ts file-header JSDoc references deleted MNAAssembler.stampAll

File: src/solver/analog/ckt-load.ts
Line: 2
Rule: rules.md historical-provenance comment ban

The file-level JSDoc reads: cktLoad - single-pass device load replacing MNAAssembler.stampAll().

Replacing MNAAssembler.stampAll() is a historical-provenance statement. MNAAssembler has been deleted. The comment describes what this code replaced, which is exactly what the rule bans.

Severity: major

### V-03 Major: cktLoad does not apply srcFact scaling to nodeset stamp RHS values

File: src/solver/analog/ckt-load.ts
Lines: 54-58
Rule: CLAUDE.md SPICE-Correct Implementations Only; spec task 2.2.1 acceptance criteria

The nodeset stamping in cktLoad applies (1e10 * value) to the RHS, but does not scale by ctx.srcFact. Compare with applyNodesetsAndICs in newton-raphson.ts which takes a srcFact parameter and applies (G_NODESET * value * srcFact):

- applyNodesetsAndICs (newton-raphson.ts line 72): solver.stampRHS(nodeId, G_NODESET * value * srcFact);
- cktLoad (ckt-load.ts line 57): ctx.solver.stampRHS(node, 1e10 * value);  // missing * ctx.srcFact

ngspice cktload.c applies CKTsrcFact scaling to nodeset voltages during source-stepping convergence aids. Without srcFact scaling, the nodeset stamps will enforce the full target voltage even when the circuit is mid-way through source stepping, diverging from ngspice behavior.

Note: Appendix B in plan.md also omits srcFact in the pseudocode (which itself may be a spec error), but applyNodesetsAndICs (the function this code replaces) does apply srcFact. The discrepancy between the function that was replaced (which applied srcFact correctly) and the new cktLoad (which does not) is a regression.

Severity: major

### V-04 Minor: TODO comments in harness test helper file

File: src/solver/analog/__tests__/harness/netlist-generator.ts
Lines: 269, 281, 298
Rule: rules.md ban on TODO/FIXME/HACK comments

Three TODO comments exist in the ngspice harness test helper:
- Line 269: TODO: this is an approximation - triangle wave has no exact SPICE transient primitive.
- Line 281: TODO: this is an approximation - sawtooth has no exact SPICE transient primitive.
- Line 298: TODO: sweep/am/fm/noise/expression waveforms are not representable in SPICE

The rules.md prohibition on TODO comments applies universally. These were not introduced by Phase 2 tasks, but they exist in files that are in scope as part of the Phase 2 test surface.

Severity: minor

### V-05 Minor: applyNodesetsAndICs is dead code retained without a production caller

File: src/solver/analog/newton-raphson.ts
Lines: 45-79
Rule: rules.md - All replaced or edited code is removed entirely. Scorched earth.

The applyNodesetsAndICs exported function is no longer called by any production code. The NR loop calls cktLoad, which internally applies nodesets (ckt-load.ts lines 54-58). Searches confirm applyNodesetsAndICs is referenced only in its own definition and in newton-raphson.test.ts test imports.

This is retained dead code kept solely so the associated tests continue to pass - a classic retain dead code to avoid deleting tests pattern. The function, its export, and the five associated tests should all be removed.

Severity: minor (overlaps with G-02)

### V-06 Minor: Weak assertion pattern in noncon test

File: src/solver/analog/__tests__/ckt-load.test.ts
Line: 154
Rule: rules.md Test the specific: exact values, exact types, exact error messages where applicable.

The noncon_incremented_by_device_limiting test only asserts ctx.noncon > 0:

    expect(ctx.noncon).toBeGreaterThan(0);

This is a trivially weak assertion. For a known diode circuit with a 5V forced anode voltage (far above vcrit), the pnjlim call should produce a specific noncon increment. The assertion does not verify any specific count or that limiting actually occurred - it only checks the counter is non-zero, which would also pass if noncon were erroneously set to 1e6.

Severity: minor (weak test)

## Gaps

### G-01: cktLoad does not stamp ICs (initial conditions)

Spec requirement: Task 2.2.1 states Applies nodesets/ICs after device loads (only in DC mode during initJct/initFix). The spec description explicitly lists ICs alongside nodesets.

What was found: cktLoad (ckt-load.ts lines 54-58) only iterates ctx.nodesets. There is no loop over ctx.ics. The old applyNodesetsAndICs function in newton-raphson.ts applied both nodesets and ICs (with ICs stamped unconditionally for all modes). The new cktLoad silently drops IC application.

File: src/solver/analog/ckt-load.ts

Note: Appendix B in plan.md also omits ICs from the pseudocode. This may be a spec ambiguity. Since the existing applyNodesetsAndICs function (which cktLoad was designed to replace) applied ICs, and the task spec text explicitly mentions nodesets/ICs, this is reported as a gap. If plan.md Appendix B intentionally excludes ICs, the task text contradicts the pseudocode and the user must adjudicate.

### G-02: applyNodesetsAndICs function retained without a caller - dead code

Spec requirement: Task 2.2.1 acceptance criteria - Nodesets/ICs applied inside cktLoad, not as a separate step. Task 2.2.2 and rules.md - All replaced or edited code is removed entirely.

What was found: applyNodesetsAndICs remains exported from newton-raphson.ts and has five dedicated tests in newton-raphson.test.ts. No production call site invokes it anymore. The function is retained solely to keep its tests passing.

Per rules.md Scorched earth: the function, its export, and the five associated tests should all be removed. The nodeset behavior is now tested via the nodesets_applied_after_device_loads test in ckt-load.test.ts.

File: src/solver/analog/newton-raphson.ts lines 61-79; src/solver/analog/__tests__/newton-raphson.test.ts lines 384-443

## Weak Tests

### WT-01: single_pass_stamps_all_contributions - trivially weak assertions

Test path: src/solver/analog/__tests__/ckt-load.test.ts::CKTload::single_pass_stamps_all_contributions

Problem: The test asserts only Number.isFinite(solution[0]) and Number.isFinite(solution[1]). This checks that values are numbers (not NaN/Infinity), but does not verify any specific voltage. A circuit with Vs=5V, R=1kOhm, and a diode has a well-defined operating point. The test should assert concrete voltage values (node 1 ~5V, node 2 ~0.6-0.75V). As written, the test would pass even if the solver returned numerically wrong but finite values.

Spec requirement: Task 2.2.1 - Assert the solver matrix contains all stamps (linear + nonlinear + reactive companion) from a single pass. Asserting isFinite on solution elements does not verify the matrix contains all stamps.

### WT-02: writes_into_ctx_nrResult - trivially-true type/length checks

Test path: src/solver/analog/__tests__/newton-raphson.test.ts::NR::writes_into_ctx_nrResult

Problem: The test includes expect(ctx.nrResult.voltages).toBeInstanceOf(Float64Array) - a trivially-true type check. The voltages field is typed Float64Array and guaranteed by construction, so this assertion adds no signal. The .length === 3 check is also guaranteed by construction (matrixSize=3). These weak assertions surround the meaningful toBeCloseTo(2.5, 4) but dilute the test intent.

### WT-03: noncon_incremented_by_device_limiting - toBeGreaterThan(0) without specific value

Test path: src/solver/analog/__tests__/ckt-load.test.ts::CKTload::noncon_incremented_by_device_limiting

Problem: expect(ctx.noncon).toBeGreaterThan(0) does not verify a specific count. The diode with anode forced to 5V should produce a deterministic noncon increment. The assertion does not verify the actual limiting behavior (the pnjlim call returning limited=true), only that the counter is non-zero.

Evidence: expect(ctx.noncon).toBeGreaterThan(0);

## Legacy References

### LR-01: MNAAssembler referenced in sparse-solver.ts JSDoc

File: src/solver/analog/sparse-solver.ts
Line: 225
Evidence: Called at compile time by every caller (element factories, MNAAssembler).

MNAAssembler has been deleted. This JSDoc for allocElement refers to a deleted class as a caller. It is a stale historical reference that should name the actual callers post-deletion (element load() implementations, cktLoad via element.load).

### LR-02: MNAAssembler.stampAll() referenced in ckt-load.ts file header JSDoc

File: src/solver/analog/ckt-load.ts
Line: 2
Evidence: cktLoad - single-pass device load replacing MNAAssembler.stampAll().

Already cited in V-02 as a violation. Also recorded here as a legacy reference: MNAAssembler.stampAll() is the deleted API name.

## Additional Observations (informational, not violations)

- Task 2.1.1 pnjlim: Implementation matches ngspice DEVpnjlim devsup.c:50-58 exactly. Variable-mapping table present in JSDoc. All four spec-required tests present. Shared result object _pnjlimResult pattern is sound for single-threaded JS.
- Task 2.1.2 fetlim: vtstlo = vtsthi / 2 + 2 at newton-raphson.ts line 173 is correct. Both spec-required tests present with correct expected values.
- Task 2.1.3 hadNodeset gate: condition (ctx.isDcOp AND ctx.hadNodeset AND ipass > 0) at newton-raphson.ts line 504 matches the spec. updateHadNodeset() correctly derives from nodesets.size > 0. Both spec-required tests present.
- Task 2.2.2 MNAAssembler deletion: mna-assembler.ts deleted. mna-assembler.test.ts deleted. No import of MNAAssembler in newton-raphson.ts. CKTCircuitContext.assembler field absent. Inline convergence loop via ctx.elementsWithConvergence confirmed in newton-raphson.ts lines 417-446.
- Task 2.2.3 E_SINGULAR recovery: e_singular_recovery_via_cktLoad test correctly uses proxy solver, asserts converged === true, factorCallCount >= 2, lastFactorUsedReorder === true, iterations === 3. Control flow verified.
- batch-5-fix xfact formula: ctx.loadCtx.xfact = ctx.deltaOld[0] / ctx.deltaOld[1] at analog-engine.ts line 418 - no guard, matches spec. Test uses toBe exact equality.
- mna-end-to-end.test.ts: This file exists and was not listed in progress.md for any Phase 2 task. It appears outside tracked scope and exercises the full compiler-engine pipeline including MOSFET tests.

