
## Task 0.1.1: Delete `derivedNgspiceSlots` from the parity harness
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/__tests__/harness/types.ts` — deleted `DerivedNgspiceSlot` interface and `derivedNgspiceSlots?` field from `DeviceMapping`
  - `src/solver/analog/__tests__/harness/device-mappings.ts` — tightened module docstring (removed "formula / sign flip / mapping table / tolerance" enumeration and Track B sentence)
  - `src/solver/analog/__tests__/harness/ngspice-bridge.ts` — deleted `if (mapping.derivedNgspiceSlots)` block in `_unpackElementStates`
  - `src/solver/analog/__tests__/harness/compare.ts` — deleted `if (mapping.derivedNgspiceSlots)` block and simplified comment
  - `src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts` — deleted `if (mapping.derivedNgspiceSlots)` block
  - `src/solver/analog/__tests__/harness/harness-integration.test.ts` — removed `derivedNgspiceSlots.VSB` reference from comment
- **Tests**: 216 passed / 253 total. 37 pre-existing failures in capacitor.ts:272 and inductor.ts:340 (unrelated to this task; none in modified files). Zero hits for `derivedNgspiceSlots` in src/ scripts/ e2e/ (confirmed via Grep tool).

## Task 0.1.2: Strip historical doc-comment residue
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - src/components/semiconductors/bjt.ts
  - src/components/semiconductors/mosfet.ts
  - src/components/semiconductors/njfet.ts
  - src/components/semiconductors/pjfet.ts
  - src/components/semiconductors/varactor.ts
  - src/components/semiconductors/__tests__/bjt.test.ts
  - src/components/semiconductors/__tests__/jfet.test.ts
  - src/components/semiconductors/__tests__/diode.test.ts
  - src/components/active/__tests__/timer-555.test.ts
  - src/solver/analog/__tests__/ckt-mode.test.ts
  - src/solver/analog/coupled-inductor.ts
  - src/solver/analog/__tests__/harness/device-mappings.ts — NO EDIT: banned sentence already absent (locked by 0.1.1; verified absent)
- **Tests**: 753/803 passing; 50 pre-existing failures unrelated to comment-only edits
- **Pre-existing failures**: timer-555 internal_divider_voltages numerical; capacitor/mosfet/led/bjt/diode/pjfet/scr/triac/tunnel-diode/zener Cannot-read-properties engine crashes; diode IKR precision; diode cap gate NaN; mosfet DC OP convergence
