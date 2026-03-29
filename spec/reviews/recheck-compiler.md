# Review Report: Recheck Compiler Post-Fix Audit

## Summary

| Item | Count |
|------|-------|
| Violations critical | 3 |
| Violations major | 1 |
| Violations minor | 1 |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 6 |
| Verdict | has-violations |

---

## Banned Terms Grep Results (entire src/)

The following banned terms have zero matches in src/:
- expandTransistorModel: 0 matches
- TransistorExpansionResult: 0 matches
- missing-transistor-model: 0 matches
- invalid-transistor-model: 0 matches
- requiresBranchRow: 0 matches
- makeVddSource: 0 matches
- TransistorModelRegistry / transistorModelRegistry: 0 matches
- vddNodeId / vddBranchIdx: 0 matches
- analog-pins in production code: 0 matches

The subcircuitModel OLD field on MnaModel is confirmed gone from registry.ts.
Remaining subcircuitModels / subcircuitModelRegistry identifiers are parameter
names referencing the renamed SubcircuitModelRegistry class -- not the old field.

---

## File Status Checks

**transistor-expansion.ts:** PASS. Repurposed to registerAnalogFactory/getAnalogFactory only.
No expandTransistorModel, no VDD/GND special-casing.

**compiler.ts:** PASS. expand route gone. makeVddSource gone. vddNodeId/vddBranchIdx gone.
requiresBranchRow gone. resolveSubcircuitModels present and correct. pc.model = null
is direct (line 123, no cast). Three as-unknown casts at lines 208/1353/1389 are
pre-existing PropertyBag storage workarounds, not the banned expansion casts.

**transistor-models/darlington.ts:** PASS. Produces MnaSubcircuitNetlist. Key is
'darlington'. subcircuitRefs set correctly. No throwing factory.

**transistor-models/cmos-gates.ts:** PASS. All functions return MnaSubcircuitNetlist.

**transistor-models/cmos-flipflop.ts:** PASS. Returns MnaSubcircuitNetlist.

**src/core/analog-types.ts:** PASS. No missing-transistor-model or
invalid-transistor-model. Contains unresolved-model-ref.

**src/compile/types.ts:** PASS. PartitionedComponent.model is DigitalModel | MnaModel | null.
DiagnosticCode includes unresolved-model-ref.

---

## Violations

### Violation 1 -- Actively failing test: digital_only_component_emits_diagnostic

**File:** src/solver/analog/__tests__/analog-compiler.test.ts
**Test:** BehavioralCompilation::digital_only_component_emits_diagnostic
**Line:** 311
**Rule violated:** Tests ALWAYS assert desired behaviour. Failing tests must be fixed.
**Severity:** critical

Test is actively failing: expected [] to have a length of 1 but got +0.

The test wires PureDigital at {x:10, y:0} -- completely isolated from the analog
components at {x:30} and {x:0}. compile.ts:381-387 only emits
unsupported-component-in-analog when the digital component pin is in an analog-domain
connectivity group (touchesAnalogGroup). Since no wire connects the digital component
to the analog circuit, touchesAnalogGroup is always false and the diagnostic is never
emitted.

The test intent is correct per spec -- a digital-only component wired into an analog
net should produce the diagnostic -- but the circuit topology cannot satisfy the
precondition. The fix agent wrote or left a test whose circuit cannot trigger the
code path being tested.

Circuit in test:
  AnalogR pins at x:30 and x:0
  PureDigital pin at x:10  (isolated wire, no shared node)
  Ground at x:0

---

### Violation 2 -- Actively failing test: rejects_digital_only_component

**File:** src/solver/analog/__tests__/compiler.test.ts
**Test:** AnalogCompiler::rejects_digital_only_component
**Line:** 425
**Rule violated:** Tests ALWAYS assert desired behaviour. Failing tests must be fixed.
**Severity:** critical

Test is actively failing: expected [] to have a length of 1 but got +0.

Same root cause as Violation 1. The And gate (digital-only) is wired at x:10 and
x:20, isolated from AnalogR at x:30 and Ground at x:0. touchesAnalogGroup is false.
No unsupported-component-in-analog diagnostic is emitted.

---

### Violation 3 -- Actively failing test: analog_internals_without_transistorModel_falls_through_to_analogFactory

**File:** src/solver/analog/__tests__/analog-compiler.test.ts
**Test:** SimulationMode::analog_internals_without_transistorModel_falls_through_to_analogFactory
**Line:** 547
**Rule violated:** Tests ALWAYS assert desired behaviour. Failing tests must be fixed.
**Severity:** critical

Test is actively failing: expected spy to be called once, but got 0 times.

The test sets simulationModel=cmos on BehavioralAnd which has only
mnaModels: { behavioral: ... } and no subcircuitRefs. Under v2 architecture,
getActiveModelKey throws on 'cmos' (not a valid key). resolveModelAssignments catches
the throw and assigns modelKey=neutral / model=null. The component is treated as
infrastructure; the factory is never called.

The test asserts the old 'fall-through' behavior from the v1/expand architecture:
when no subcircuit matched, the compiler would silently call the MNA factory anyway.
That behavior was intentionally eliminated in Wave 4. The test was not updated to
test the new behavior (invalid-simulation-model diagnostic emitted, factory NOT called).

This is a fix agent error: the old test was left in place unchanged, verifying
removed behavior.

Test name itself: 'falls_through_to_analogFactory' -- describes removed behavior.
Test comment: 'Fuse/switch case: analog-internals but no subcircuitRefs use analogFactory'
-- describes removed behavior.

---

### Violation 4 -- Historical-provenance comments in analog-compiler.test.ts SimulationMode block

**File:** src/solver/analog/__tests__/analog-compiler.test.ts
**Lines:** 379, 381, 385, 396
**Rule violated:** No historical-provenance comments. Any comment describing what code
replaced, what it used to do, why it changed, or where it came from is banned.
**Severity:** major

Four comments in the SimulationMode describe block refer to the removed 'analog-pins'
mode as if it were the mode being tested. The actual property being set is 'behavioral'.

Line 379: // Set mode to 'analog-pins' explicitly and
Line 381: // property the compiler would NOT have taken the analog-pins path.
Line 385: expect(spy1).toHaveBeenCalledOnce(); // explicit analog-pins -> factory called
Line 396: // simulationModel explicitly set to 'analog-pins' -> compiles normally

These comments describe the removed 'analog-pins' compile route as if it were still
the active concept. A developer reading them would believe 'analog-pins' is a valid
mode key, when the code actually sets 'behavioral'.

---

### Violation 5 -- Historical-provenance comment in spice-model-overrides.test.ts

**File:** src/solver/analog/__tests__/spice-model-overrides.test.ts
**Lines:** 293-294
**Rule violated:** No historical-provenance comments.
**Severity:** minor

Comment at line 293-294:
  // Override IS to exactly DIODE_DEFAULTS.IS (1e-14) -- previously this was
  // indistinguishable from 'no override' in the lossy-diff approach.

'previously this was indistinguishable from' describes how the old implementation
behaved. This is a banned historical-provenance comment.

---

## Gaps

### Gap 1 -- Tunnel-diode tests 3 actively failing

**Spec requirement:** All tests must pass.
**Found:** Three tunnel-diode tests fail with:
  Cannot read properties of undefined (reading 'IP') at tunnel-diode.ts:125

The factory reads _modelParams from props without a null guard:
  const modelParams = props._modelParams as Record<string, number>;
  const ip = modelParams.IP;  // crashes when modelParams is undefined

The test infrastructure does not inject _modelParams into the PropertyBag before
calling the factory. Fix agents did not address this gap.

Failing tests: peak_current_at_vp, valley_current_at_vv, nr_converges_in_ndr_region
File reference: src/components/semiconductors/tunnel-diode.ts:125

---

### Gap 2 -- MCP surface test spice-model-overrides-mcp actively failing

**Spec requirement:** CLAUDE.md three-surface rule -- MCP surface test must pass.
**Found:** 'patch with _spiceModelOverrides changes DC operating point vs default'
fails at src/headless/__tests__/spice-model-overrides-mcp.test.ts:165 with
'expected false to be true'.

The test asserts that applying IS=1e-10 override produces different node voltages
than the default IS. The assertion fails -- either the override is not being applied
through the MCP patch path, or DC OP convergence produces identical results for
both parameter values. Fix agents did not resolve this.

---

### Gap 3 -- analog_internals_without_transistorModel test not replaced with new-architecture test

**Spec requirement:** Tests must verify new behavior when old behavior is removed.
**Found:** Test at line 540-549 verifies the old 'fall-through to analogFactory'
behavior that was intentionally eliminated in Wave 4. No replacement test verifying
the new behavior (invalid model key -> invalid-simulation-model diagnostic) was added.
The new behavior is untested in this file.

---

## Weak Tests

### Weak Test 1 -- cmos-gates.test.ts line 845: toBeDefined() with stale label

**Test path:** src/solver/analog/__tests__/cmos-gates.test.ts -- loop at line 844-846
**Issue:** Uses toBeDefined() -- weak assertion. Does not verify the actual string
value (e.g., 'CmosAnd2' for And). Would pass if subcircuitRefs.cmos was any truthy
value. The assertion message also uses the stale term 'transistorModel':

  expect(def.subcircuitRefs?.cmos, name + ' transistorModel').toBeDefined();

Should assert exact values per component, e.g.:
  expect(def.subcircuitRefs?.cmos).toBe('CmosAnd2')  // for And

---

### Weak Test 2 -- analog-compiler.test.ts digital_only_component_emits_diagnostic

**Test path:** src/solver/analog/__tests__/analog-compiler.test.ts::BehavioralCompilation::digital_only_component_emits_diagnostic
**Issue:** Beyond being Violation 1, the assertion is permanently unreachable with
the current circuit topology. The digital-only component is on an isolated wire at
x:10 that shares no node with the analog components. No compiler improvement could
make this test pass without fixing the circuit topology first.

---

## Legacy References

### Legacy Reference 1

**File:** src/solver/analog/__tests__/analog-compiler.test.ts:379
**Evidence:** comment text: Set mode to 'analog-pins' explicitly and
'analog-pins' is the removed mode name from v1 architecture.

### Legacy Reference 2

**File:** src/solver/analog/__tests__/analog-compiler.test.ts:381
**Evidence:** comment text: property the compiler would NOT have taken the analog-pins path.
'analog-pins path' references the removed compile route.

### Legacy Reference 3

**File:** src/solver/analog/__tests__/analog-compiler.test.ts:385
**Evidence:** inline comment: explicit analog-pins -> factory called
Stale mode name in inline comment.

### Legacy Reference 4

**File:** src/solver/analog/__tests__/analog-compiler.test.ts:396
**Evidence:** comment text: simulationModel explicitly set to 'analog-pins' -> compiles normally
Stale mode name -- actual code sets 'behavioral', not 'analog-pins'.

### Legacy Reference 5

**File:** src/solver/analog/__tests__/analog-compiler.test.ts:382
**Evidence:** const analogPinsProps = new Map([["simulationModel", "behavioral"]]);
Variable named analogPinsProps but sets simulationModel=behavioral.
The variable name is a stale reference to the removed analog-pins mode.

### Legacy Reference 6

**File:** src/solver/analog/__tests__/cmos-gates.test.ts:845
**Evidence:** assertion message string contains 'transistorModel'
transistorModel was the old field name on MnaModel (replaced by subcircuitRefs
in Wave 4). Using it as an assertion label is a stale reference to the removed field.

---

## Active Test Failures Summary

| Test | File | Root Cause |
|------|------|------------|
| digital_only_component_emits_diagnostic | analog-compiler.test.ts:311 | Circuit topology does not connect digital component to analog net |
| rejects_digital_only_component | compiler.test.ts:425 | Circuit topology does not connect digital component to analog net |
| analog_internals_without_transistorModel_falls_through_to_analogFactory | analog-compiler.test.ts:547 | Tests removed v1 fall-through behavior |
| patch with _spiceModelOverrides changes DC operating point | spice-model-overrides-mcp.test.ts:165 | MCP override not affecting DC OP result |
| peak_current_at_vp | tunnel-diode.ts ref | _modelParams not injected in test |
| valley_current_at_vv | tunnel-diode.ts ref | _modelParams not injected in test |
| nr_converges_in_ndr_region | tunnel-diode.ts ref | _modelParams not injected in test |
