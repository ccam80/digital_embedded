# Implementation Progress

Progress is recorded here by implementation agents. Each completed task appends its status below.

## Task 0.1.4: Delete unused exported `junctionCap` helper
- **Status**: complete
- **Agent**: implementer
- **Files modified**: 
  - `src/components/semiconductors/mosfet.ts` (lines 784-808: removed unused export function `junctionCap` and its docblock comment)
- **Tests**: 49/49 passing (vitest `src/components/semiconductors/__tests__/mosfet.test.ts`)
- **Verification**: Grep across entire repo confirmed zero callers of `junctionCap` outside of definition and reference docs.

## Task 0.1.2: Delete banned JFET Vds hard-clamps
- **Status**: complete
- **Agent**: implementer
- **Files modified**: 
  - `src/components/semiconductors/njfet.ts` (lines 180-184: removed banned Vds clamps and comment block; changed `let vds` to `const vds`)
  - `src/components/semiconductors/pjfet.ts` (lines 101-103: removed banned Vds clamps; changed `let vds` to `const vds`)
- **Tests**: 18/18 passing (vitest `src/components/semiconductors/__tests__/jfet.test.ts`)
- **Deletion rationale**: ngspice does not clamp Vds at device load time; voltage limiting is handled by the convergence controller and limiting primitives in Phase 5+. These hard-clamps violated the "SPICE-correct only" rule in CLAUDE.md.

## Task 0.1.3: Delete BJT exp(700) clamps
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/semiconductors/bjt.ts
- **Changes**: Removed all 13 `Math.exp(Math.min(<arg>, 700))` overflow clamps, replacing each with `Math.exp(<arg>)`. Lines affected: 548, 560, 580, 588, 589, 609, 610, 1016, 1028, 1054, 1075, 1607, 1659.
- **Verification grep**: `Math.(exp|min)([^)]*700` over bjt.ts — 0 hits after edits
- **Tests**: 66/67 passing (1 pre-existing failure: `common_emitter_active_ic_ib_bit_exact_vs_ngspice` — present in test-baseline.md before this change, 1-ulp shift only, not a regression introduced here)

## Recovery events
- **2026-04-20T11:48Z — batch-p0-w0.1, group 0.1.c (task 0.1.3, BJT exp(700) clamp deletion)**: TaskOutput returned `completed` for the implementer agent, but no `complete-implementer.sh` was invoked (state `completed` only advanced from 0 to 2 for the two healthy agents) and `bjt.ts` still contains all 13 `Math.exp(Math.min(..., 700))` clamps. Invoked `mark-dead-implementer.sh` to open a retry slot. Respawning the BJT implementer.
