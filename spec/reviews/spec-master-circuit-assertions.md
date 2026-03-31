# Spec Review: master-circuit-assertions.md

## Overall Verdict: needs-revision

## Summary

The spec is a well-structured roadmap for expanding master circuit E2E assertions from "wiring passes" to "precise voltage verification." Most code references are accurate. However, several issues must be resolved before implementation can proceed reliably.

## Blocking Issues

### 1. Contradictory Master 3 ngspice values (lines 41-48)

**Location**: "ngspice Reference Values" → Master 3 — m3_dc  
**Problem**: The spec states `v_rc = 3.125000` and `v_cap = 3.125000`, then the note contradicts itself:

> "V_cap = V_dac × R1/(R_dac+R1) ≈ 3.125 × 1000/1100 ≈ 2.841V at DC with R_dac load, BUT at full settle V_cap → V_dac since C blocks DC through R1"

Three different values are given for the same node (3.125V, 2.841V, "V_dac"). The note also admits: "Values above are analytical (confirmed by the steady-state math)" followed by "Rerun with proper .print needed." These are **unverified** analytical estimates being proposed as 0.1% reference values.

**Suggestion**: Run the actual ngspice transient simulation with `.print tran` directives (the spec even provides the commands on lines 239-243). Replace analytical guesses with measured values before using them as assertion targets.

### 2. Missing ngspice references block multiple phases

**Location**: "Still needed" (line 65) and "ngspice Netlists Still Needed" (lines 215-238)  
**Problem**: Four sets of ngspice reference values are explicitly marked as missing:
- CMOS AND gate voltages → blocks **Master 1 Phase C**
- Pin electrical / rOut override values → blocks **Master 2 Phase F** and **Master 3 Phase E**
- Pin loading voltage delta → blocks **Master 2 Phase E**
- Master 3 transient re-run → blocks **Master 3 Phases A-C** (0.1% assertions use unverified values)

**Suggestion**: Run the ngspice simulations and populate the reference values before implementing the assertion phases. Without these, the 0.1% tolerance claims are guesses.

### 3. `readOutput` / `readAllSignals` not available on UICircuitBuilder

**Location**: Master 1 Phase B (line 81), "Missing / May Need" (line 211-212)  
**Problem**: Phase B requires reading individual digital output values (D_FF Q, Counter CNT_Y) after stepping. `readOutput` and `readAllSignals` don't exist as methods on `UICircuitBuilder`. The spec acknowledges this but doesn't specify how to implement them.

**Suggestion**: Either (a) spec a task to add `readOutput(label)` to UICircuitBuilder (it could delegate to the test-bridge's existing `readAllSignals`), or (b) reformulate Phase B to use `runTestVectors` with expected Q/CNT_Y values (as the spec itself suggests on line 81).

### 4. Switch blocker for Master 2 Phase A

**Location**: Line 104  
**Problem**: "Switch CTRL not toggling (voltages ≈ 0). Being fixed in parallel session." — Phase A assertions (0.1% voltage checks) cannot be validated until the switch bug is fixed. All subsequent Master 2 phases depend on Phase A.

**Suggestion**: Track the switch fix as a prerequisite dependency. Phase A assertions should not be merged until the switch bug fix is confirmed working.

## Quality Issues

### 5. Phase F placement ambiguity (Master 2 vs Master 3)

**Location**: Master 2 Phase F (lines 141-153)  
**Problem**: Line 152 says: "This flow fits better on Master 3 (mixed-signal) where digital pins drive analog loads." Yet it's listed under Master 2. This creates confusion about where to implement it.

**Suggestion**: Move Phase F to Master 3 (as Phase E already covers rOut there), or commit to keeping it in Master 2 and remove the contradictory note.

### 6. Pin loading assertions are qualitative, not quantitative

**Location**: Master 2 Phase E (lines 127-139)  
**Problem**: Every other phase targets 0.1% tolerance, but Phase E falls back to "just assert `P_DIV !== previousValue` (qualitative check)." The note says: "Need to determine expected voltage shift. May need ngspice ref with loading model."

**Suggestion**: Either (a) produce the ngspice reference with the loading model so a quantitative assertion can be written, or (b) explicitly mark this phase as a qualitative smoke test and don't claim 0.1% parity.

### 7. `getCircuitDomain()` deletion recommendation without task

**Location**: Line 9  
**Problem**: The spec says "Consider deleting the method entirely" for `getCircuitDomain()` at `src/app/test-bridge.ts:228`. This is an actionable recommendation buried in a status section with no corresponding task or phase.

**Suggestion**: Either add a cleanup task for this deletion, or remove the recommendation from the spec (it's a tangent to the assertion work).

### 8. Master 3 comparator wiring direction should be explicit

**Location**: Master 3 Phase A, line 165  
**Problem**: The note says "Comparator in- gets RC voltage (3.125V), in+ gets Vref2 (2.5V)" — this matches the test code (line 335: CMP.in- wired to RC node, line 344: CMP.in+ wired to Vref2). However, the Phase B description (line 173) relies on understanding this polarity to predict the comparator flip. If wiring ever changes, all Phase B+ assertions break silently.

**Suggestion**: Add an explicit assertion in Phase A that verifies comparator output is LOW (confirming the wiring polarity) before Phase B tests the flip.

## Informational

### 9. Existing test assertions are much looser than spec targets

The current test code uses wide range checks (`> 2.0, < 6.0` for a 2.5V expected value). The spec proposes 0.1% tolerance. This is a large jump — the implementation should include a validation step confirming the simulator actually achieves 0.1% agreement with ngspice before locking in tight tolerances.

### 10. Property label table is accurate

The "Property Labels" table (lines 250-261) was verified against `src/editor/property-panel.ts` MODEL_LABELS and the existing test code. All labels match.

### 11. UI Methods Inventory is accurate

All "Available" methods were confirmed to exist on `UICircuitBuilder`. The "Missing / May Need" section correctly identifies gaps.

## Code Reference Verification

| Reference | Status |
|-----------|--------|
| `src/app/test-bridge.ts:228` getCircuitDomain | FOUND |
| `src/editor/property-panel.ts:24` MODEL_LABELS | FOUND (lines 21-25) |
| `src/components/gates/and.ts:130` CMOS_AND2_NETLIST | FOUND |
| `e2e/gui/pin-loading-wire-override.spec.ts` | FOUND |
| `e2e/gui/hotload-params-e2e.spec.ts` | FOUND |
| `e2e/circuits/debug/master3-wiring-code.ts` | FOUND |
| `e2e/circuits/debug/master3-reference.dig` | FOUND |
| `e2e/wire-capture.spec.ts` | FOUND |
| UICircuitBuilder methods (12 listed) | 10/12 FOUND; `readOutput`, `readAllSignals` correctly listed as missing |
| Pin loading model in `src/solver/analog/compiler.ts` | NOT FOUND in compiler; handled at bridge/adapter layer |
