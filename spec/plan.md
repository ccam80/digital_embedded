# Implementation Plan: Master Circuit Assertions

## Goal
Replace placeholder assertions in `e2e/gui/master-circuit-assembly.spec.ts` with precise ngspice-verified voltage assertions across all three master circuits.

## Dependency Graph
```
Phase 1 (Master 1) → Phase 2 (Master 2) → Phase 3 (Master 3)
```
Sequential because all phases edit the same file.

## Phase Summary

| Phase | Name | Waves | Tasks | Complexity |
|-------|------|-------|-------|------------|
| 1 | Master 1: Digital Logic Assertions | 1.1 | 2 | M |
| 2 | Master 2: Analog Assertions | 2.1 | 5 | L |
| 3 | Master 3: Mixed-Signal Assertions | 3.1 | 5 | L |

## Verification Measures
- `npx playwright test e2e/gui/master-circuit-assembly.spec.ts` — all 3 master tests must pass
- Voltage assertions use 0.1% tolerance against ngspice reference values
- No placeholder/range-only assertions remain
