# Test Baseline (Shape Fix Wave)
- **Timestamp**: 2026-03-11T17:36:00Z
- **Command**: `npx vitest run`
- **Result**: 5321/5360 passing, 38 failing, 1 skipped

## Pre-existing Failures (DO NOT chase these)
- fixture-audit.test.ts: 34 failures (orphan wires, disconnected tunnels, bounding box violations)
- shape-audit.test.ts: 2 failures (Mul pins, Mul dimensions)
- wiring.test.ts: BusSplitter pin count assertion (expects 2 outputs, gets 3)
- delay.test.ts: 2 failures (PropertyBag key "delay" not found)
- io.test.ts: 1 failure (InComponent draw text)
- pld.test.ts: 2 failures (Diode blown color)
- fets.test.ts: 2 failures (FGNFET/FGPFET blown color)
- fuse.test.ts: 1 failure (blown color)
- **Total: 38 known failures across 4+ test files**
