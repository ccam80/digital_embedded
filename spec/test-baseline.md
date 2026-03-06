# Test Baseline
- **Timestamp**: 2026-03-07T12:49:00Z
- **Phase**: Engine Remaining Work
- **Command**: `npx vitest run`
- **Result**: 4486/4495 passing, 8 failing, 0 errors (1 skipped)

## Failing Tests (pre-existing)
| Test | Status | Summary |
|------|--------|---------|
| src/engine/__tests__/delay.test.ts :: Delays :: defaultDelayIs10ns | FAIL | PropertyBag: key "delay" not found |
| src/engine/__tests__/delay.test.ts :: Delays :: definitionOverridesGlobalDefault | FAIL | PropertyBag: key "delay" not found |
| src/components/io/__tests__/io.test.ts :: InComponent > draw :: draw shows no text when label is empty | FAIL | expected 1 to be +0 |
| src/components/pld/__tests__/pld.test.ts :: Diode > rendering :: blown diode draw() calls setColor ERROR for the blow mark | FAIL | expected 0 to be >= 1 |
| src/components/pld/__tests__/pld.test.ts :: DiodeForward > rendering :: blown DiodeForward draw() shows ERROR color marker | FAIL | expected 0 to be >= 1 |
| src/components/switching/__tests__/fets.test.ts :: FGNFET :: draw -- renders blown X mark when blown | FAIL | expected ['COMPONENT','WIRE_ERROR'] to include 'ERROR' |
| src/components/switching/__tests__/fets.test.ts :: FGPFET :: draw -- renders blown indicator when blown | FAIL | expected ['COMPONENT','WIRE_ERROR'] to include 'ERROR' |
| src/components/switching/__tests__/fuse.test.ts :: Fuse -- rendering :: draw_blown -- uses ERROR color for blown indicator | FAIL | expected ['COMPONENT','WIRE_ERROR'] to include 'ERROR' |
