# Review Report: Wave 4.1 -- Coordinator Interface + Core Implementation

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 3 (P4-1, P4-2, P4-3) |
| Violations | 4 |
| Gaps | 2 |
| Weak tests | 4 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 -- Incomplete stub implementation in production code (critical)

**File**: src/compile/coordinator.ts, lines 107-114

**Rule violated**: Rules -- Completeness: Never mark work as deferred, TODO, or not implemented. Code Hygiene: No fallbacks.

**Evidence** (coordinator.ts lines 107-114):

    for (const bridge of this._bridges) {
      if (bridge.direction !== digital-to-analog) continue;
      const raw = digital.getSignalRaw(bridge.digitalNetId);
      const voltage = this._digitalToVoltage(raw !== 0, bridge);
      analog.addBreakpoint(analog.simTime);
      void voltage;
    }

The digital-to-analog bridge direction is not implemented. _digitalToVoltage() correctly computes the output voltage, but void voltage immediately discards the result. In its place, analog.addBreakpoint(analog.simTime) registers the current simulation time as a breakpoint -- this has no effect on analog node voltages and is a no-op placeholder. The AnalogEngine interface does not expose a setNodeVoltage() method, so the agent could not stamp the voltage onto the analog node. Rather than flagging this as a gap, the agent silently left the bridge sync half-unimplemented with dead code that suggests the motion of doing something.

**Severity**: critical

---

### V2 -- Unused import symbols in test file (minor)

**File**: src/compile/__tests__/coordinator.test.ts, lines 15-16

**Rule violated**: Code Hygiene -- no dead code.

**Evidence** (lines 15-16):

    import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from ../../core/pin.js;
    import type { PinDeclaration } from ../../core/pin.js;

resolvePins, createInverterConfig, createClockConfig, and PinDeclaration are imported but never referenced in the file. These are dead imports from what appears to be a copy-paste from another test module.

**Severity**: minor

---

### V3 -- Duplicate import of PinDirection (minor)

**File**: src/compile/__tests__/coordinator.test.ts, lines 11 and 15

**Rule violated**: Code Hygiene -- no redundant code.

**Evidence**:

    line 11: import { PinDirection } from ../../core/pin.js;
    line 15: import { PinDirection, resolvePins, createInverterConfig, createClockConfig } from ../../core/pin.js;

PinDirection is imported twice from the same module. One import statement is entirely redundant.

**Severity**: minor

---

### V4 -- Missing TransistorModelRegistry parameter on constructor (major)

**File**: src/compile/coordinator.ts, line 33

**Rule violated**: Spec adherence -- P4-2 constructor specification.

**Evidence**:

The spec states: Constructor accepts CompiledCircuitUnified and optional TransistorModelRegistry.

The implementation at line 33:

    constructor(compiled: CompiledCircuitUnified) {

The optional TransistorModelRegistry parameter is entirely absent. This is not a trivial omission -- the TransistorModelRegistry is passed to the analog compiler and is required for circuits with transistor components (BJT, MOSFET, etc.). Without it, the coordinator cannot be used with any circuit that requires custom transistor models. The spec explicitly calls this parameter out.

**Severity**: major

---

## Gaps

### G1 -- Analog-only test case does not verify voltage via readByLabel() or readSignal()

**Spec requirement** (P4-3, test case 2): Analog-only circuit: Construct coordinator from a compiled resistor divider. Verify analogBackend is non-null, digitalBackend is null. Step and verify voltage via readByLabel().

**What was found**: The analog-only describe block contains three tests: has null digitalBackend and non-null analogBackend, step does not throw for analog-only circuit, and readSignal with digital address throws FacadeError on analog-only coordinator. None of these tests call readByLabel() or readSignal() with an analog address to verify that an actual voltage is returned. The spec requirement -- verify voltage via readByLabel() -- is entirely absent.

**File**: src/compile/__tests__/coordinator.test.ts

---

### G2 -- No mixed-signal coordinator test

**Spec requirement** (P4-2 acceptance + P4-3 coverage of bridge-sync): The spec describes mixed-signal bridge-sync as the core novel behaviour of DefaultSimulationCoordinator. The implementation covers the digital-only degenerate case but has no test that constructs a coordinator from a mixed-signal circuit (both digital and analog domains with bridges present) and exercises the bridge-sync path in _stepMixed(). The bridge-sync logic in _stepMixed() (lines 97-114) is completely untested. This is particularly significant given that the digital-to-analog bridge direction is also broken (V1 above).

**File**: src/compile/__tests__/coordinator.test.ts

---

## Weak Tests

### WT1 -- Silent early-exit makes analog test vacuously pass

**Test path**: src/compile/__tests__/coordinator.test.ts :: DefaultSimulationCoordinator - analog-only :: has null digitalBackend and non-null analogBackend

**What is wrong**: The test contains if (unified.analog === null) return; on line 439. If compileUnified produces analog: null for the resistor-divider circuit (e.g. due to a regression), the test returns immediately without asserting anything and registers as passing. This is functionally equivalent to a skipped test.

**Evidence** (line 439):

    if (unified.analog === null) return;   // silent vacuous pass

---

### WT2 -- Silent early-exit makes analog test vacuously pass

**Test path**: src/compile/__tests__/coordinator.test.ts :: DefaultSimulationCoordinator - analog-only :: step does not throw for analog-only circuit

**What is wrong**: Same if (unified.analog === null) return; guard on line 449. If the analog domain is missing, the test body is skipped entirely with no assertion failure.

**Evidence** (line 449):

    if (unified.analog === null) return;   // silent vacuous pass

---

### WT3 -- Silent early-exit makes analog test vacuously pass

**Test path**: src/compile/__tests__/coordinator.test.ts :: DefaultSimulationCoordinator - analog-only :: readSignal with digital address throws FacadeError on analog-only coordinator

**What is wrong**: Same if (unified.analog === null) return; guard on line 458. If compileUnified fails to produce an analog domain, the test never reaches the expect(...).toThrow() assertion.

**Evidence** (line 458):

    if (unified.analog === null) return;   // silent vacuous pass

---

### WT4 -- Weak analog step assertion: does not throw verifies nothing about simulation output

**Test path**: src/compile/__tests__/coordinator.test.ts :: DefaultSimulationCoordinator - analog-only :: step does not throw for analog-only circuit

**What is wrong**: Even when the test body executes, the only assertion is expect(() => coord.step()).not.toThrow(). This verifies that stepping does not crash -- it does not verify that the analog engine advanced its simulation time, that node voltages changed, or that any meaningful computation occurred. Per spec P4-3 test case 2: verify voltage via readByLabel() -- this test does not do that.

**Evidence**:

    const coord = new DefaultSimulationCoordinator(unified);
    expect(() => coord.step()).not.toThrow();
    coord.dispose();

---

## Legacy References

None found.
