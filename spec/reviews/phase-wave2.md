# Review Report: Wave 2 -- Component Sweep + Hot-Loadable setParam (Tasks 2.2-2.10)

## Summary

| Metric | Value |
|--------|-------|
| Tasks reviewed | 9 (Tasks 2.2-2.10) |
| Violations | 14 |
| Gaps | 7 |
| Weak tests | 1 |
| Legacy references | 26 |
| Verdict | **has-violations** |

---

## Violations

### V-01: Split factory pattern in passives (CRITICAL)

- **File**: src/components/passives/resistor.ts, lines 189-205
- **Rule violated**: rules.md No fallbacks. No backwards compatibility shims.
- **Evidence**: Two factory functions: createResistorElement (getOrDefault, mnaModels) and createResistorElementFromModelParams (getModelParam, modelRegistry). Spec says ONE factory using getModelParam.
- **Severity**: critical

### V-02: Split factory in capacitor.ts (CRITICAL)

- **File**: src/components/passives/capacitor.ts, line 205
- **Rule violated**: rules.md No fallbacks. No backwards compatibility shims.
- **Evidence**: createCapacitorElementFromModelParams alongside old factory. Progress.md documents: split factory into two variants.
- **Severity**: critical

### V-03: Split factory in inductor.ts (CRITICAL)

- **File**: src/components/passives/inductor.ts, line 223
- **Rule violated**: rules.md No fallbacks. No backwards compatibility shims.
- **Severity**: critical

### V-04: Split factory across remaining 8 passive files (CRITICAL)

- **Files**: crystal.ts:402, memristor.ts:320, polarized-cap.ts:403, potentiometer.ts:324, tapped-transformer.ts:521, transformer.ts:436, transmission-line.ts:645, analog-fuse.ts:295
- **Rule violated**: rules.md No fallbacks. No backwards compatibility shims.
- **Severity**: critical

### V-05: mnaModels dead code on ComponentModels type (CRITICAL)

- **Files**: 47 component source files
- **Rule violated**: rules.md All replaced or edited code is removed entirely.
- **Evidence**: 140+ TS errors: mnaModels does not exist in type ComponentModels. Type updated but property not removed from 47 files.
- **Severity**: critical

### V-06: setParam missing from ground.ts (CRITICAL)

- **File**: src/components/io/ground.ts, line 113
- **Rule violated**: Task 2.10: setParam required on AnalogElementCore
- **Evidence**: TS2741: Property setParam missing.
- **Severity**: critical

### V-07: setParam missing from led.ts (CRITICAL)

- **File**: src/components/io/led.ts, line 177
- **Rule violated**: Task 2.10
- **Evidence**: TS2741.
- **Severity**: critical

### V-08: setParam missing from probe.ts (CRITICAL)

- **File**: src/components/io/probe.ts, line 243
- **Rule violated**: Task 2.10
- **Evidence**: TS2741.
- **Severity**: critical

### V-09: setParam missing from switch.ts and switch-dt.ts (CRITICAL)

- **Files**: switch.ts:327, switch-dt.ts:340
- **Rule violated**: Task 2.10
- **Evidence**: TS2741 for SpstAnalogElement and SpdtAnalogElement.
- **Severity**: critical

### V-10: setParam missing from passive class-based factories (CRITICAL)

- **Files**: analog-fuse.ts:276, crystal.ts:384, polarized-cap.ts:384, tapped-transformer.ts:501, transformer.ts:416, transmission-line.ts:624
- **Rule violated**: Task 2.10
- **Evidence**: TS2741. FromModelParams variant has setParam but original factory in mnaModels does not.
- **Severity**: critical

### V-11: setParam missing from behavioral gate/remaining factories (CRITICAL)

- **Files**: behavioral-gate.ts (7 instances, lines 333-391), behavioral-remaining.ts (4 instances, lines 511-817)
- **Rule violated**: Task 2.10
- **Evidence**: BehavioralGateElement class and behavioral-remaining factory objects missing setParam.
- **Severity**: critical

### V-12: setParam missing from test fixture (MAJOR)

- **File**: src/test-fixtures/model-fixtures.ts, line 15
- **Rule violated**: Task 2.10
- **Evidence**: TS2741: stub AnalogElementCore missing setParam.
- **Severity**: major

### V-13: legacy in test comment (MINOR)

- **File**: src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts, lines 3 and 57
- **Rule violated**: rules.md No historical-provenance comments
- **Severity**: minor

### V-14: Progress.md documents split factory as intentional (MAJOR)

- **File**: spec/progress.md, Task 2.3 entry
- **Rule violated**: rules.md No backwards compatibility shims.
- **Evidence**: Agent documented split factory into two variants as the pattern.
- **Severity**: major

---

## Gaps

### G-01: Tasks 2.4-2.9 not tracked in progress.md
- No entries for Tasks 2.4 (Gates), 2.5 (Flip-flops), 2.7 (Sources+sensors), 2.8 (IO+memory), 2.9 (Switching+wiring).

### G-02: Task 2.10 test file not created
- Spec requires src/core/__tests__/analog-types-setparam.test.ts. Not verified.

### G-03: setParam not in IO analog factories
- ground.ts, led.ts, probe.ts factories missing setParam.

### G-04: setParam not in switching analog factories
- switch.ts, switch-dt.ts factories missing setParam.

### G-05: Behavioral gate/remaining factories missing setParam
- behavioral-gate.ts (7), behavioral-remaining.ts (4) missing setParam.

### G-06: mnaModels not removed from component definitions
- 47 files still have mnaModels. 140+ TypeScript errors.

### G-07: Task 2.10 acceptance criterion violated
- 1101 TypeScript errors including 25 setParam-missing and 140+ mnaModels errors from Wave 2.

---

## Weak Tests

### WT-01: trivially true assertions
- src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts lines 52-54: typeof params is object without checking keys.

---

## Legacy References

### LR-01 to LR-08: Ported from in flip-flop files
- d-async.ts:7, d.ts:5, jk.ts:10, jk-async.ts:7, rs-async.ts:10, monoflop.ts:8, t.ts:11, rs.ts:10

### LR-09: Ported from in driver.ts
- src/components/wiring/driver.ts:33

### LR-10 to LR-17: Ported from in memory files
- rom.ts:25, counter-preset.ts:12, eeprom.ts:26, counter.ts:9, lookup-table.ts:13, program-memory.ts:22, register.ts:7, register-file.ts:8

### LR-18 to LR-25: Ported from in switching files
- nfet.ts:14, relay.ts:25, relay-dt.ts:21, trans-gate.ts:16, fuse.ts:23, pfet.ts:14, fgpfet.ts:14, fgnfet.ts:15

### LR-26: legacy in test file
- src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts, lines 3 and 57
