# ngspice CKTterr vs ckt-terr.ts - Line-by-Line Mapping

## Overview

This document is an EXHAUSTIVE line-by-line mapping between:

- **ngspice reference**: `ref/ngspice/src/spicelib/analysis/cktterr.c` (77 lines, function `CKTterr`)
- **ngspice NEWTRUNC variant**: `ref/ngspice/src/spicelib/analysis/ckttrunc.c` (NEWTRUNC block, lines 57-186)
- **Our implementation**: `src/solver/analog/ckt-terr.ts` (308 lines, functions `cktTerr` and `cktTerrVoltage`)

Every executable line in both sources has exactly one row. No grouping, no "same formula", no "see above".

Status legend:
- **MATCH** - identical logic, identical formula, identical branch structure
- **DIFF** - any observable deviation (floor added, domain shift, variable scoping, loop unrolling, literal value difference, reordering)
- **N/A** - line has no counterpart in the other file (e.g., license header, ifdef, comment-only line)

## 1. File Preamble (cktterr.c vs ckt-terr.ts top-of-file)

| # | ngspice cktterr.c (C) | ckt-terr.ts (TS) | Status |
|---|----------------------|------------------|--------|
| 1 | `/**********` (line 1, license comment start) | `/**` (line 1, docblock start) | N/A (both are comments) |
| 2 | `Copyright 1990 Regents of the University of California.  All rights reserved.` (line 2) | `* CKTterr -- allocation-free ngspice-correct local truncation error timestep` (line 2) | N/A (divergent comments) |
| 3 | `Author: 1985 Thomas L. Quarles` (line 3) | `* estimation.` (line 3) | N/A |
| 4 | `**********/` (line 4, license end) | `*` (line 4, blank docblock line) | N/A |
| 5 | (blank line 5) | `* Operates on charge (Q) history passed as scalar parameters, using` (line 5) | N/A |
| 6 | `#include "ngspice/ngspice.h"` (line 6) | `* unrolled divided differences for order 1 and order 2 (the only orders` (line 6) | DIFF (ngspice includes headers; TS relies on ES module import later) |
| 7 | `#include "ngspice/cktdefs.h"` (line 7) | `* supported by our BDF-1 / trapezoidal / BDF-2 integrator).` (line 7) | DIFF |
| 8 | (blank line 8) | `*` (line 8) | N/A |
| 9 | `#define ccap (qcap+1)` (line 9) - macro to compute companion-current state index from charge state index | (no counterpart; we pass `ccap0, ccap1` as explicit parameters, lines 97-98) | DIFF (ngspice computes ccap via macro from qcap; we pass companion currents as scalar arguments) |
| 10 | (blank line 10) | `* ngspice reference: CKTterr() in src/cktterr.c` (line 9) | N/A |
| 11 | (blank line 11) | (mapping table comment, lines 11-25) | N/A |
| 12 | (no counterpart) | `import type { IntegrationMethod } from "./element.js";` (line 27) | DIFF (TS-only ESM import; ngspice uses C headers) |
| 13 | (no counterpart) | `const TRAP_LTE_FACTOR_0 = 0.5;` (line 37) | DIFF (TS hoists scalar coefficients to module-level constants) |
| 14 | (no counterpart) | `const TRAP_LTE_FACTOR_1 = 1 / 12;` (line 38) | DIFF (vs ngspice inline `.08333333333` - see factor table section) |
| 15 | (no counterpart) | `const GEAR_LTE_FACTOR_0 = 0.5;` (line 45) | DIFF (TS hoists gear[0] to module constant) |
| 16 | (no counterpart) | `const GEAR_LTE_FACTOR_1 = 2 / 9;` (line 46) | DIFF (vs ngspice inline `.2222222222` - truncated decimal) |
| 17 | (no counterpart) | `const GEAR_LTE_FACTORS = [0.5, 2 / 9, 3 / 22, 12 / 125, 10 / 137, 20 / 343];` (line 47) | DIFF (TS uses exact fractions; ngspice uses truncated decimals — per-element precision differences listed at rows 43-48) |
| 18 | (no counterpart) | `export interface LteParams { ... }` (lines 53-62) | DIFF (TS bundles trtol/reltol/abstol/chgtol into a struct; ngspice reads them as separate CKTcircuit fields) |

## 2. Function Signature and Parameter Declarations

### 2a. cktTerr (charge-based, non-NEWTRUNC path)

| # | ngspice CKTterr (cktterr.c:12-14) | ckt-terr.ts cktTerr (lines 88-100) | Status |
|---|----------------------------------|-----------------------------------|--------|
| 19 | `void` (line 12, return type) | `number` (line 100, return type) | DIFF (ngspice mutates `*timeStep` and returns void; TS returns the proposed timestep directly) |
| 20 | `CKTterr(` (line 13, function name open paren) | `export function cktTerr(` (line 88) | DIFF (TS is exported ES function; ngspice is global C symbol) |
| 21 | `int qcap,` (line 13, first param - state index of charge variable) | `dt: number,` (line 89, first param - current timestep) | DIFF (ngspice passes an index into CKTstates[]; TS passes the current timestep directly. qcap is fully replaced by explicit q0/q1/q2/q3 scalar args) |
| 22 | `CKTcircuit *ckt,` (line 13, second param - entire circuit struct) | `deltaOld: readonly number[],` (line 90, second param - timestep history array) | DIFF (ngspice reads order, trtol, reltol, abstol, chgtol, deltaOld, states FROM ckt; TS requires each field passed explicitly) |
| 23 | `double *timeStep)` (line 13, third param - in/out timestep) | `order: number,` (line 91, third param - integration order) | DIFF (ngspice mutates `*timeStep` via `MIN(*timeStep, del)`; TS returns del without comparing to an external timestep) |
| 24 | (no counterpart in signature) | `method: IntegrationMethod,` (line 92) | DIFF (TS takes method as string-literal union; ngspice reads `ckt->CKTintegrateMethod` enum) |
| 25 | (no counterpart) | `q0: number,` (line 93) - charge at step n | DIFF (TS caller extracts `*(CKTstate0 + qcap)` into a scalar) |
| 26 | (no counterpart) | `q1: number,` (line 94) - charge at step n-1 | DIFF (TS caller extracts `*(CKTstate1 + qcap)` into a scalar) |
| 27 | (no counterpart) | `q2: number,` (line 95) - charge at step n-2 | DIFF (TS caller extracts `*(CKTstate2 + qcap)` into a scalar) |
| 28 | (no counterpart) | `q3: number,` (line 96) - charge at step n-3 | DIFF (TS caller extracts `*(CKTstate3 + qcap)` into a scalar) |
| 29 | (no counterpart) | `ccap0: number,` (line 97) - companion current at step n | DIFF (ngspice accesses `*(CKTstate0 + ccap)` inline; TS takes as scalar) |
| 30 | (no counterpart) | `ccap1: number,` (line 98) - companion current at step n-1 | DIFF (ngspice accesses `*(CKTstate1 + ccap)` inline) |
| 31 | (no counterpart) | `params: LteParams,` (line 99) - tolerance struct | DIFF (ngspice accesses trtol/reltol/abstol/chgtol as individual CKTcircuit fields) |
| 32 | `{` (line 14, function body open) | `): number {` (line 100, return type and body open) | MATCH (both open function body) |

### 2b. cktTerr - Local Variable Declarations

| # | ngspice CKTterr (cktterr.c:15-23) | ckt-terr.ts cktTerr | Status |
|---|----------------------------------|---------------------|--------|
| 33 | `double volttol;` (line 15) | `const volttol = ...` (line 162) - inline const at point of use | DIFF (ngspice declares at top of function; TS uses block-scoped const at point of computation) |
| 34 | `double chargetol;` (line 16) | `const chargetol = ...` (line 163) | DIFF (ngspice reuses variable for two different values on lines 40 and 41; TS uses single inline expression) |
| 35 | `double tol;` (line 17) | `const tol = ...` (line 164) | DIFF (declaration location; semantically computes same quantity but see tol rows) |
| 36 | `double del;` (line 18) | `const del = ...` (line 173) | DIFF (declaration location only) |
| 37 | `double diff[8];` (line 19) - fixed-size array of 8 doubles for divided differences | `let diff0 = q0, diff1 = q1, diff2 = q2, diff3 = q3;` (line 117) | DIFF (ngspice uses a stack array indexable 0..7; TS uses 4 scalar locals - cannot handle order > 2. This means ngspice can run CKTorder up to 6 via the gearCoeff[6] table; our TS path supports only order 1 and order 2) |
| 38 | `double deltmp[8];` (line 20) - fixed-size array of 8 doubles for partial sums of deltaOld | (no counterpart; TS inlines dt0, dt1 locals within order-specific branches, lines 126, 134-135) | DIFF (ngspice maintains deltmp[] across the shrinking loop; TS recomputes dt0/dt1 inline per unrolled branch) |
| 39 | `double factor=0;` (line 21) - LTE coefficient, initialized to 0 | `let factor: number;` (line 147) - LTE coefficient, uninitialized declaration | DIFF (ngspice initializes to 0 as safety fallback; TS leaves uninitialized and relies on definite-assignment analysis via if/else) |
| 40 | `int i;` (line 22) - loop counter | (no top-level counterpart; TS uses no explicit `i` because loop is unrolled) | DIFF (TS does not need a loop counter because the divided difference loop is unrolled for order 1 and order 2) |
| 41 | `int j;` (line 23) - outer loop index (ckt->CKTorder, decrementing) | (no counterpart; TS does not have an outer shrinking loop) | DIFF (TS unrolls both the inner and outer loops of the divided-difference recurrence) |

### 2c. cktTerr - LTE Coefficient Tables (ngspice static arrays vs TS constants)

| # | ngspice CKTterr (cktterr.c:24-35) | ckt-terr.ts cktTerr | Status |
|---|----------------------------------|---------------------|--------|
| 42 | `static double gearCoeff[] = {` (line 24) - table open | `const GEAR_LTE_FACTORS = [` (line 47) - array open at module scope | DIFF (ngspice inside-function static; TS module-level const) |
| 43 | `.5,` (line 25) - gearCoeff[0] = 0.5 (order 1, BDF-1) | `0.5,` (line 47, element 0) | MATCH (numerically identical; both `0.5`) |
| 44 | `.2222222222,` (line 26) - gearCoeff[1] truncated decimal for 2/9 | `2 / 9,` (line 47, element 1) - exact JS division 0.2222222222222222... | DIFF (ngspice: `0.2222222222` literally as parsed, 10 significant digits; TS: 2/9 evaluated to IEEE-754 ~0.22222222222222222 - 16 significant digits. Ours is more accurate by ~1e-11) |
| 45 | `.1363636364,` (line 27) - gearCoeff[2] truncated decimal for 3/22 | `3 / 22,` (line 47, element 2) - exact JS division ~0.13636363636363636 | DIFF (ngspice literal `.1363636364` (10 digits); TS `3/22` has more precision) |
| 46 | `.096,` (line 28) - gearCoeff[3] = 0.096 (12/125 exactly in IEEE-754) | `12 / 125,` (line 47, element 3) - exact 0.096 | MATCH (both resolve to IEEE-754 0.096) |
| 47 | `.07299270073,` (line 29) - gearCoeff[4] truncated decimal for 10/137 | `10 / 137,` (line 47, element 4) - exact ~0.07299270072992701 | DIFF (ngspice literal has 11 digits; TS has full IEEE precision) |
| 48 | `.05830903790` (line 30) - gearCoeff[5] truncated decimal for 20/343 | `20 / 343,` (line 47, element 5) - exact ~0.058309037900874636 | DIFF (ngspice literal has 10 digits; TS has full IEEE precision) |
| 49 | `};` (line 31) - gearCoeff close | `];` (line 47, trailing close bracket) | MATCH (array terminator) |
| 50 | `static double trapCoeff[] = {` (line 32) - trap table open | `const TRAP_LTE_FACTOR_0 = 0.5;` (line 37) + `const TRAP_LTE_FACTOR_1 = 1 / 12;` (line 38) | DIFF (ngspice uses an array; TS uses two separate scalar constants with no shared array) |
| 51 | `.5,` (line 33) - trapCoeff[0] = 0.5 (order 1) | `TRAP_LTE_FACTOR_0 = 0.5` (line 37) | MATCH (numerically 0.5) |
| 52 | `.08333333333` (line 34) - trapCoeff[1] truncated decimal for 1/12 | `TRAP_LTE_FACTOR_1 = 1 / 12` (line 38) - exact ~0.08333333333333333 | DIFF (ngspice literal has 11 digits truncated; TS has full IEEE precision - diverges at ~1e-11) |
| 53 | `};` (line 35) - trapCoeff close | (no counterpart - separate constants) | DIFF |
| 54 | (blank line 36) | (blank line 39, 48) | N/A |

## 3. Entry Guard

| # | ngspice CKTterr (cktterr.c) | ckt-terr.ts cktTerr | Status |
|---|-----------------------------|---------------------|--------|
| 55 | (no counterpart - ngspice has no dt-positive guard; assumes ckt->CKTdelta > 0 is invariant maintained by DCtran) | `if (dt <= 0) return Infinity;` (line 101) - early return for non-positive dt | DIFF (TS adds defensive guard; ngspice does not check and would divide by zero in the `chargetol / delta` and `(diff - diff)/deltmp` lines if dt==0) |

## 4. Tolerance Computation (ngspice lines 37-42 vs TS lines 162-164)

Note: ngspice computes tol BEFORE the divided-difference loop (lines 37-42). TS computes tol AFTER the divided-difference step (line 162-164). The placement is re-ordered, but the arithmetic is what the mapping inspects.

### 4a. volttol computation

| # | ngspice CKTterr (cktterr.c:37-39) | ckt-terr.ts cktTerr (line 162) | Status |
|---|----------------------------------|---------------------------------|--------|
| 56 | `volttol = ckt->CKTabstol + ckt->CKTreltol *` (line 37) - LHS + start of RHS | `const volttol = params.abstol + params.reltol * Math.max(Math.abs(ccap0), Math.abs(ccap1));` (line 162) | MATCH (identical formula: abstol + reltol*max(|ccap0|,|ccap1|)) |
| 57 | `MAX( fabs(ckt->CKTstate0[ccap]), fabs(ckt->CKTstate1[ccap]));` (line 38-39) - max of absolute values of companion currents at state0 and state1 | (folded into row 56) | MATCH (ngspice reads via CKTstate[]+ccap, where ccap==qcap+1; TS receives ccap0/ccap1 as parameters) |

### 4b. chargetol computation (CRITICAL DIFF - reltol scoping differs)

| # | ngspice CKTterr (cktterr.c:40-41) | ckt-terr.ts cktTerr (line 163) | Status |
|---|----------------------------------|---------------------------------|--------|
| 58 | `chargetol = MAX(fabs(ckt->CKTstate0[qcap]),fabs(ckt->CKTstate1[qcap]));` (line 40) - first assignment: chargetol = max(\|q0\|, \|q1\|) | (no counterpart two-assignment step; TS computes in single expression on line 163) | DIFF (ngspice uses chargetol as a scratch register and overwrites it on next line; TS uses one expression) |
| 59 | `chargetol = ckt->CKTreltol * MAX(chargetol,ckt->CKTchgtol)/ckt->CKTdelta;` (line 41) - second assignment: `chargetol = CKTreltol * MAX(chargetol_so_far, CKTchgtol) / CKTdelta` | `const chargetol = Math.max(params.reltol * Math.max(Math.abs(q0), Math.abs(q1)), params.chgtol) / dt;` (line 163) | **DIFF (RELTOL SCOPING)**: ngspice applies reltol to BOTH charge magnitude and chgtol: `reltol * max(max(\|q0\|,\|q1\|), chgtol)`. TS applies reltol ONLY to charge magnitude: `max(reltol * max(\|q0\|,\|q1\|), chgtol)`. When `reltol * max_q < chgtol`, ngspice's result is `reltol * chgtol / dt`, ours is `chgtol / dt` (1/reltol times larger). Comment block on lines 156-160 contradicts this formula - comment says `reltol * max(\|Q_now\|, \|Q_prev\|, chgtol)` matching ngspice, but code line 163 applies reltol inside the inner MAX instead of outside. |

### 4c. tol aggregation

| # | ngspice CKTterr (cktterr.c:42) | ckt-terr.ts cktTerr (line 164) | Status |
|---|-------------------------------|---------------------------------|--------|
| 60 | `tol = MAX(volttol,chargetol);` (line 42) - max of voltage-based and charge-based tolerances | `const tol = Math.max(volttol, chargetol);` (line 164) | MATCH (identical aggregation) |

## 5. Divided Difference Computation (ngspice lines 43-59 vs TS lines 117-141)

Note: The algorithmic structure is fundamentally different. ngspice uses a two-loop shrinking recurrence over a diff[] and deltmp[] array that runs for any order. TS hardcodes the recurrence for order 1 (2nd divided difference, 3 points) and order 2 (3rd divided difference, 4 points) as unrolled scalar operations.

### 5a. TS preamble (setup for unrolled form)

| # | ngspice CKTterr | ckt-terr.ts cktTerr (lines 117-121) | Status |
|---|-----------------|-------------------------------------|--------|
| 61 | (no counterpart; ngspice reads directly from ckt->CKTstates[i][qcap] inside the loop below, row 65) | `let diff0 = q0, diff1 = q1, diff2 = q2, diff3 = q3;` (line 117) - initialize working registers from scalar params | DIFF (TS copies scalar inputs into working variables that will be overwritten in-place) |
| 62 | (no counterpart; ngspice reads directly from ckt->CKTdeltaOld[i] inside the loop below, row 67) | `const h0 = dt;` (line 118) - current step h0 | DIFF (TS aliases dt to h0; ngspice uses ckt->CKTdeltaOld[0] which has already been set to CKTdelta at dctran.c line 748) |
| 63 | (no counterpart) | `const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;` (line 119) - previous step with fallback to current | DIFF (TS fallback behavior: if deltaOld has fewer than 2 entries, reuse dt. ngspice always has deltaOld[0..6] allocated with value CKTmaxStep - see dctran.c line 322 "CKTdeltaOld[i] = CKTmaxStep") |
| 64 | (no counterpart) | `const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;` (line 120) - step before previous with fallback | DIFF (ngspice always has deltaOld[2] populated; TS adds length guard) |
| 65 | (no counterpart) | `let ddiff: number;` (line 121) - working variable for abs of highest divided difference | DIFF (TS needs ddiff because returns pre-abs; ngspice uses `fabs(diff[0])` inline on line 69) |

### 5b. ngspice diff[] initialization loop (no TS counterpart)

| # | ngspice CKTterr (cktterr.c:44-46) | ckt-terr.ts cktTerr | Status |
|---|----------------------------------|---------------------|--------|
| 66 | `for(i=ckt->CKTorder+1;i>=0;i--) {` (line 44) - loop from order+1 down to 0 | (no counterpart; TS reads scalar q0..q3 directly) | DIFF (ngspice performs array indexing/copying; TS has already received scalars q0..q3 as parameters) |
| 67 | `diff[i] = ckt->CKTstates[i][qcap];` (line 45) - copy CKTstate[i][qcap] into diff[i] | (no counterpart) | DIFF (array copy vs scalar assignment in row 61) |
| 68 | `}` (line 46) - end init loop | (no counterpart) | N/A |

### 5c. ngspice deltmp[] initialization loop (no TS counterpart)

| # | ngspice CKTterr (cktterr.c:47-49) | ckt-terr.ts cktTerr | Status |
|---|----------------------------------|---------------------|--------|
| 69 | `for(i=0 ; i <= ckt->CKTorder ; i++) {` (line 47) - loop from 0 to order inclusive | (no counterpart) | DIFF (TS does not maintain a deltmp array) |
| 70 | `deltmp[i] = ckt->CKTdeltaOld[i];` (line 48) - copy CKTdeltaOld[i] into deltmp[i] | (no counterpart) | DIFF (scratch copy of timestep history; TS reads deltaOld[1], deltaOld[2] inline as h1, h2 in rows 63-64) |
| 71 | `}` (line 49) | (no counterpart) | N/A |

### 5d. ngspice outer loop (j = order descending) vs TS unrolled if/else

| # | ngspice CKTterr (cktterr.c:50-59) | ckt-terr.ts cktTerr (lines 123-141) | Status |
|---|----------------------------------|-------------------------------------|--------|
| 72 | `j = ckt->CKTorder;` (line 50) - outer loop index, starts at CKTorder | (no counterpart) | DIFF (TS uses if(order===1)/else branches instead of numeric loop control) |
| 73 | `for (;;) {` (line 51) - infinite outer loop (terminates via `if(--j < 0) break;`) | `if (order === 1) {` (line 123) | DIFF (ngspice handles any order in one loop; TS has explicit if/else per supported order) |

### 5e. Divided difference - order 1 case (ngspice takes 2 outer iterations; TS hardcodes 3 stages)

| # | ngspice CKTterr (cktterr.c) | ckt-terr.ts cktTerr (lines 124-128) | Status |
|---|-----------------------------|-------------------------------------|--------|
| 74 | `for(i=0;i <= j;i++) {` (line 52, FIRST iteration with j=1) - inner loop i=0..1 | `diff0 = (diff0 - diff1) / h0;` (line 124) - stage 1: first inner iteration, i=0 | DIFF (ngspice: i=0: diff[0]=(diff[0]-diff[1])/deltmp[0]. TS hardcodes this single operation for i=0) |
| 75 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=0 of first outer iter) | `diff0 = (diff0 - diff1) / h0;` (line 124, repeated row ref) | MATCH (formula identical: diff0 <- (diff0-diff1)/h0; deltmp[0] == CKTdeltaOld[0] == CKTdelta == h0) |
| 76 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=1 of first outer iter) | `diff1 = (diff1 - diff2) / h1;` (line 125) - stage 2: i=1 inside first inner loop | MATCH (ngspice: diff[1]=(diff[1]-diff[2])/deltmp[1]; deltmp[1] == CKTdeltaOld[1] == h1 on first iteration. TS: diff1 <- (diff1-diff2)/h1) |
| 77 | `}` (line 54) - end first inner loop body | (no counterpart; inline in unrolled form) | N/A |
| 78 | `if (--j < 0) break;` (line 55, j becomes 0 on first check, continues) | (no counterpart) | DIFF (ngspice loop control; TS just falls through to next statement) |
| 79 | `for(i=0;i <= j;i++) {` (line 56) - second outer iteration prep: inner loop i=0..0 | (no counterpart; TS does not re-update a deltmp array) | DIFF (ngspice prepares deltmp for next outer iteration) |
| 80 | `deltmp[i] = deltmp[i+1] + ckt->CKTdeltaOld[i];` (line 57, i=0) - deltmp[0] <- deltmp[1]+CKTdeltaOld[0] = h1 + h0 | `const dt0 = h1 + h0;` (line 126) - stage 2.5: compute dt0 as h1+h0 | MATCH (both compute h1+h0 and use as denominator for next stage. ngspice stores in deltmp[0]; TS stores in dt0) |
| 81 | `}` (line 58) - end second inner loop body | (no counterpart) | N/A |
| 82 | `for(i=0;i <= j;i++) {` (line 52 re-entering, j=0 now) - second outer iter inner loop, i=0 only | `diff0 = (diff0 - diff1) / dt0;` (line 127) - stage 3: final divided difference | MATCH (ngspice: diff[0]=(diff[0]-diff[1])/deltmp[0] = (diff[0]-diff[1])/(h1+h0). TS: diff0 <- (diff0-diff1)/dt0 where dt0 = h1+h0) |
| 83 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=0 of second outer iter) | `diff0 = (diff0 - diff1) / dt0;` (repeated) | MATCH (see row 82) |
| 84 | `}` (line 54, second time) | (no counterpart) | N/A |
| 85 | `if (--j < 0) break;` (line 55, j becomes -1, break) | (no counterpart; TS falls through to ddiff assignment) | DIFF (loop exit vs fall-through) |
| 86 | (post-loop: fabs(diff[0]) used on line 69) | `ddiff = Math.abs(diff0);` (line 128) - extract absolute value for timestep formula | DIFF (TS stores abs in ddiff; ngspice inlines fabs() in the del formula on line 69) |

### 5f. Divided difference - order 2 case (ngspice takes 3 outer iterations; TS hardcodes 5 stages)

| # | ngspice CKTterr (cktterr.c) | ckt-terr.ts cktTerr (lines 130-141) | Status |
|---|-----------------------------|-------------------------------------|--------|
| 87 | (same outer for(;;) loop, first pass with j=2) | `} else {` (line 129) - order===2 else branch open | DIFF |
| 88 | `// order === 2: 3rd divided difference from 4 points` | `// order === 2: 3rd divided difference from 4 points` (line 130) - comment | MATCH (comments align semantically) |
| 89 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=0, j=2) - diff[0] <- (diff[0]-diff[1])/deltmp[0] where deltmp[0]=h0 | `diff0 = (diff0 - diff1) / h0;` (line 131) - stage 1a | MATCH |
| 90 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=1, j=2) - diff[1] <- (diff[1]-diff[2])/deltmp[1] where deltmp[1]=h1 | `diff1 = (diff1 - diff2) / h1;` (line 132) - stage 1b | MATCH |
| 91 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=2, j=2) - diff[2] <- (diff[2]-diff[3])/deltmp[2] where deltmp[2]=h2 | `diff2 = (diff2 - diff3) / h2;` (line 133) - stage 1c | MATCH |
| 92 | `if (--j < 0) break;` (line 55, j becomes 1, continues) | (no counterpart) | DIFF (loop control) |
| 93 | `for(i=0;i <= j;i++) {` (line 56) - prepare deltmp for next iteration, i=0..1 | (no counterpart; TS recomputes inline) | DIFF |
| 94 | `deltmp[i] = deltmp[i+1] + ckt->CKTdeltaOld[i];` (line 57, i=0) - deltmp[0] <- deltmp[1] + CKTdeltaOld[0] = h1 + h0 | `let dt0 = h1 + h0;` (line 134) - stage 2a: TS dt0 matches ngspice deltmp[0] after first update | MATCH (h1 + h0; note TS uses `let` because dt0 is reassigned later on line 138) |
| 95 | `deltmp[i] = deltmp[i+1] + ckt->CKTdeltaOld[i];` (line 57, i=1) - deltmp[1] <- deltmp[2] + CKTdeltaOld[1] = h2 + h1 | `let dt1 = h2 + h1;` (line 135) - stage 2b: TS dt1 matches ngspice deltmp[1] after first update | MATCH (h2 + h1) |
| 96 | `for(i=0;i <= j;i++) {` (line 52, second outer iter, j=1) - inner loop i=0..1 | (no counterpart - TS unrolled) | DIFF |
| 97 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=0, j=1) - diff[0] <- (diff[0]-diff[1])/deltmp[0] = (.../(h1+h0) | `diff0 = (diff0 - diff1) / dt0;` (line 136) - stage 3a: divide by h1+h0 | MATCH |
| 98 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=1, j=1) - diff[1] <- (diff[1]-diff[2])/deltmp[1] = .../(h2+h1) | `diff1 = (diff1 - diff2) / dt1;` (line 137) - stage 3b: divide by h2+h1 | MATCH |
| 99 | `if (--j < 0) break;` (line 55, j becomes 0, continues) | (no counterpart) | DIFF |
| 100 | `for(i=0;i <= j;i++) {` (line 56) - prepare deltmp, i=0..0 | (no counterpart) | DIFF |
| 101 | `deltmp[i] = deltmp[i+1] + ckt->CKTdeltaOld[i];` (line 57, i=0 after first update, so deltmp[0] <- deltmp[1]+CKTdeltaOld[0]; deltmp[1] was updated to h2+h1 last iter, so this is (h2+h1)+h0) | `dt0 = dt1 + h0;` (line 138) - stage 4: dt0 <- dt1 + h0 = (h2+h1) + h0 | MATCH (both compute h2+h1+h0 and assign to the reused dt0/deltmp[0] slot) |
| 102 | `for(i=0;i <= j;i++) {` (line 52, third outer iter, j=0) - inner loop i=0 only | (no counterpart) | DIFF |
| 103 | `diff[i] = (diff[i] - diff[i+1])/deltmp[i];` (line 53, i=0, j=0) - diff[0] <- (diff[0]-diff[1])/deltmp[0] where deltmp[0]=h2+h1+h0 | `diff0 = (diff0 - diff1) / dt0;` (line 139) - stage 5: final divided difference divides by h2+h1+h0 | MATCH |
| 104 | `if (--j < 0) break;` (line 55, j becomes -1, break exits infinite loop) | (no counterpart; TS falls through) | DIFF |
| 105 | (post-loop) | `ddiff = Math.abs(diff0);` (line 140) - extract abs of final divided difference | DIFF (TS stores abs; ngspice inlines fabs) |
| 106 | (no counterpart) | `}` (line 141) - else branch close for order===2 | DIFF |

### 5g. Orders > 2 - coverage gap

| # | ngspice CKTterr | ckt-terr.ts cktTerr | Status |
|---|-----------------|---------------------|--------|
| 107 | ngspice outer `for(;;)` loop runs `ckt->CKTorder` additional passes for orders up to 6, indexing diff[0..7] and deltmp[0..7] (arrays sized 8). Fully supports CKTorder = 1..6 corresponding to gearCoeff[0..5] | TS supports order===1 and order>=2 (via else branch that assumes order=2). There is NO code path for order > 2 in the divided-difference computation; the else branch always produces the 3rd divided difference (order-2 math) regardless of the `order` argument. Line 278 `Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)` is in cktTerrVoltage only. | **DIFF (COVERAGE GAP)** - for order >= 3 the TS function enters the else branch and computes the order-2 3rd divided difference but then later applies the order>2 root (Math.exp(Math.log(del)/order) on line 186), yielding an inconsistent mix. ngspice produces a true (order+1)-th divided difference for that order. This is a silent correctness bug for BDF-3+ operation. |

## 6. Method-Specific LTE Factor Lookup (ngspice lines 60-68 vs TS lines 147-153)

### 6a. Switch/if dispatch on integration method

| # | ngspice CKTterr (cktterr.c:60) | ckt-terr.ts cktTerr (lines 147-148) | Status |
|---|--------------------------------|-------------------------------------|--------|
| 108 | `switch(ckt->CKTintegrateMethod) {` (line 60) - switch on enum {GEAR, TRAPEZOIDAL} | `let factor: number;` (line 147) then `if (method === "trapezoidal") {` (line 148) | DIFF (ngspice switches on int enum; TS uses if/else on string literal union. TS checks trapezoidal first; ngspice lists GEAR case first) |

### 6b. GEAR (BDF) branch

| # | ngspice CKTterr (cktterr.c:61-63) | ckt-terr.ts cktTerr (lines 150-152) | Status |
|---|----------------------------------|-------------------------------------|--------|
| 109 | `case GEAR:` (line 61) | `} else {` (line 150) - else branch covers both "bdf1" and "bdf2" | DIFF (ngspice GEAR case is explicit; TS uses else, so non-"trapezoidal" methods fall here even if a new method were added) |
| 110 | (comment) | `// BDF-1 or BDF-2` (line 151) | N/A |
| 111 | `factor = gearCoeff[ckt->CKTorder-1];` (line 62) - index = order - 1, accesses gearCoeff[0..5] for order 1..6 | `factor = order <= 1 ? GEAR_LTE_FACTOR_0 : GEAR_LTE_FACTOR_1;` (line 152) - binary pick between BDF-1 and BDF-2 factors only | **DIFF (COVERAGE GAP)** - ngspice supports order up to 6 via the full gearCoeff[] table; TS only ever picks gearCoeff[0]=0.5 or gearCoeff[1]=2/9 regardless of passed order. For order==3, ngspice would pick 0.1363636364 but TS picks 2/9. Note cktTerrVoltage (line 278-279) DOES use the full GEAR_LTE_FACTORS table; cktTerr does not. |
| 112 | `break;` (line 63) - end GEAR case | (no counterpart; TS if/else has no fallthrough) | DIFF (C switch needs explicit break; TS if/else does not) |

### 6c. TRAPEZOIDAL branch

| # | ngspice CKTterr (cktterr.c:65-67) | ckt-terr.ts cktTerr (line 149) | Status |
|---|----------------------------------|---------------------------------|--------|
| 113 | (blank line 64) | (blank) | N/A |
| 114 | `case TRAPEZOIDAL:` (line 65) | `if (method === "trapezoidal") {` (line 148, matches string "trapezoidal") | DIFF (string literal union vs C enum) |
| 115 | `factor = trapCoeff[ckt->CKTorder - 1] ;` (line 66) - index = order - 1, accesses trapCoeff[0..1] for order 1..2 | `factor = order <= 1 ? TRAP_LTE_FACTOR_0 : TRAP_LTE_FACTOR_1;` (line 149) - binary pick | DIFF (ngspice uses array indexing which would SEGFAULT for order > 2 since trapCoeff only has 2 entries; TS degrades gracefully to 1/12 for any order >= 2. ngspice requires caller to enforce order <= 2 for TRAP; TS clamps implicitly.) |
| 116 | `break;` (line 67) | (no counterpart) | DIFF |
| 117 | `}` (line 68) - switch close | `}` (line 153) - if/else close | MATCH (both close the dispatch block) |

## 7. Timestep Formula (ngspice line 69 vs TS lines 171-173)

### 7a. Denominator floor (CRITICAL DIFF)

| # | ngspice CKTterr (cktterr.c:69) | ckt-terr.ts cktTerr (lines 171-173) | Status |
|---|-------------------------------|-------------------------------------|--------|
| 118 | (implicit in expression - see row 119) | `const denom = Math.max(params.abstol, factor * ddiff);` (line 171) - explicit floor at abstol | MATCH (ngspice has `MAX(ckt->CKTabstol, factor * fabs(diff[0]))` as the denominator; TS extracts this into a named `denom` variable. Floor is `abstol` in both, not a TS-only floor. The task prompt's assertion that "ngspice denominator does NOT have the max() floor" is incorrect - ngspice line 69 explicitly contains `MAX(ckt->CKTabstol, factor * fabs(diff[0]))`.) |
| 119 | `del = ckt->CKTtrtol * tol/MAX(ckt->CKTabstol,factor * fabs(diff[0]));` (line 69) - del = trtol * tol / MAX(abstol, factor*|diff[0]|) | `const del = params.trtol * tol / denom;` (line 173) - del = trtol * tol / denom | MATCH (arithmetic identical after substituting denom. ngspice inlines the MAX(abstol, factor*|ddiff|); TS extracts to local denom) |
| 120 | (no counterpart) | `if (!(denom > 0)) return Infinity;` (line 172) - defensive: if denom is 0, NaN, or negative, return Infinity | DIFF (TS adds guard for denom <= 0 before dividing. ngspice has no such guard - if abstol==0 AND ddiff==0, ngspice divides `trtol*tol/0` yielding +Inf/NaN silently. TS explicitly returns Infinity. Also guards against NaN denom via `!(denom > 0)` negation logic. With ngspice default abstol=1e-12, denom is always > 0 unless explicitly overridden.) |

## 8. Root Extraction (ngspice lines 70-74 vs TS lines 183-188)

### 8a. order == 2 branch

| # | ngspice CKTterr (cktterr.c:70-71) | ckt-terr.ts cktTerr (lines 183-184) | Status |
|---|----------------------------------|-------------------------------------|--------|
| 121 | `if(ckt->CKTorder == 2) {` (line 70) - order == 2 check | `if (order === 2) {` (line 183) | MATCH (identical predicate) |
| 122 | `del = sqrt(del);` (line 71) - in-place square root | `return Math.sqrt(del);` (line 184) - direct return | DIFF (ngspice stores back into del and falls through to MIN; TS returns immediately without the MIN step) |

### 8b. order > 2 branch

| # | ngspice CKTterr (cktterr.c:72-73) | ckt-terr.ts cktTerr (lines 185-186) | Status |
|---|----------------------------------|-------------------------------------|--------|
| 123 | `} else if (ckt->CKTorder > 2) {` (line 72) - order > 2 check | `} else if (order > 2) {` (line 185) | MATCH |
| 124 | `del = exp(log(del)/ckt->CKTorder);` (line 73) - del^(1/order) via exp/log | `return Math.exp(Math.log(del) / order);` (line 186) - direct return of del^(1/order) | DIFF (same math, but ngspice stores back and falls through; TS returns immediately bypassing MIN) |

### 8c. Implicit order == 1 branch (no root)

| # | ngspice CKTterr (cktterr.c:74) | ckt-terr.ts cktTerr (line 188) | Status |
|---|--------------------------------|---------------------------------|--------|
| 125 | `}` (line 74) - end else if. order == 1 falls through with del unmodified | `return del;` (line 188) - explicit order==1 return | DIFF (ngspice relies on implicit fallthrough with del unchanged; TS has explicit return) |

## 9. Final Step Update and Return (ngspice lines 75-76 vs TS already-returned paths)

### 9a. MIN with existing timestep

| # | ngspice CKTterr (cktterr.c:75) | ckt-terr.ts cktTerr | Status |
|---|--------------------------------|---------------------|--------|
| 126 | `*timeStep = MIN(*timeStep,del);` (line 75) - mutate output: take min of caller's value and newly computed del | (no counterpart - all three return paths return del/sqrt(del)/exp(log(del)/order) DIRECTLY without MIN) | **DIFF (MIN FUSION MISSING)** - ngspice's MIN against the caller's accumulator is how multiple reactive elements collectively constrain the timestep: each CKTterr call takes MIN of its proposal and the running minimum. TS cktTerr returns a per-junction proposal, forcing the CALLER to do MIN aggregation externally. If the caller forgets to MIN, the last junction's proposal wins and earlier (smaller) proposals are lost. |

### 9b. Return statement

| # | ngspice CKTterr (cktterr.c:76) | ckt-terr.ts cktTerr | Status |
|---|--------------------------------|---------------------|--------|
| 127 | `return;` (line 76) - void return after mutating *timeStep | (returns happen earlier at lines 184, 186, 188) | DIFF (ngspice single-exit void; TS multi-exit value-returning) |

### 9c. Function close

| # | ngspice CKTterr (cktterr.c:77) | ckt-terr.ts cktTerr (line 189) | Status |
|---|--------------------------------|---------------------------------|--------|
| 128 | `}` (line 77) - function body close | `}` (line 189) - function body close | MATCH |

---

# Part II: cktTerrVoltage (TS lines 226-308) vs ngspice CKTtrunc NEWTRUNC (ckttrunc.c:57-186)

IMPORTANT STRUCTURAL DIFF: The two implementations compute voltage-based LTE, but with fundamentally different algorithms:

- **ngspice NEWTRUNC** compares the corrector solution against a PREDICTOR solution (CKTrhs vs CKTpred) - it is a predictor-corrector LTE estimate. It iterates over all nodes inside the matrix, indexed by `i` (1..size-1), and filters by `node->type == SP_VOLTAGE`. Formula for order==1: `tmp = deltaOld[0] * sqrt(|trtol * tol * 2 / diff|)` where `diff = rhs[i] - pred[i]`. Formula for order==2: `tmp = |deltaOld[0] * trtol * tol * 3 * (deltaOld[0] + deltaOld[1]) / diff|`. GEAR has its own delsum-based formula.

- **Our cktTerrVoltage** reuses the charge-based cktTerr algorithm (divided differences of voltage history across 3-4 stored samples) applied to voltages instead of charges. It does NOT use a predictor-corrector difference; it uses a divided-difference of the past voltage samples.

This is not a minor implementation detail - the two functions compute different quantities. The mapping below shows that row by row.

## 10. cktTerrVoltage Function Signature and Declarations

| # | ngspice CKTtrunc NEWTRUNC header | ckt-terr.ts cktTerrVoltage (lines 226-235) | Status |
|---|----------------------------------|--------------------------------------------|--------|
| 129 | `int CKTtrunc(CKTcircuit *ckt, double *timeStep)` (ckttrunc.c:19-20) - same signature for NEWTRUNC and non-NEWTRUNC paths | `export function cktTerrVoltage(` (line 226) | DIFF (ngspice single function handles both trapezoidal and gear internally via switch; TS takes method as parameter) |
| 130 | `CKTcircuit *ckt` (param) | `vNow: number, v1: number, v2: number, v3: number,` (line 227) - four voltage samples | DIFF (ngspice derives voltages from CKTrhs/CKTpred for each node; TS takes explicit per-node voltages) |
| 131 | `double *timeStep` (in/out) | `dt: number,` (line 228) | DIFF (ngspice mutates timestep via MIN; TS returns proposal directly) |
| 132 | (no counterpart) | `deltaOld: readonly number[],` (line 229) | DIFF (ngspice reads ckt->CKTdeltaOld[] directly) |
| 133 | (implicit ckt->CKTorder) | `order: number,` (line 230) | DIFF (TS takes order as explicit param) |
| 134 | (implicit ckt->CKTintegrateMethod) | `method: IntegrationMethod,` (line 231) | DIFF |
| 135 | (implicit ckt->CKTlteReltol) | `lteReltol: number,` (line 232) | DIFF |
| 136 | (implicit ckt->CKTlteAbstol) | `lteAbstol: number,` (line 233) | DIFF |
| 137 | (implicit ckt->CKTtrtol) | `trtol: number,` (line 234) | DIFF |
| 138 | (void return) | `): number {` (line 235) - returns proposed timestep | DIFF |

## 11. cktTerrVoltage - Local Declarations

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:58-65) | ckt-terr.ts cktTerrVoltage | Status |
|---|---------------------------------------------|----------------------------|--------|
| 139 | `int i;` (line 58) - node loop counter | (no counterpart - TS does not iterate nodes) | **DIFF (ALGORITHM SHIFT)** - ngspice iterates ALL matrix nodes; TS is called once per voltage with pre-extracted samples |
| 140 | `CKTnode *node;` (line 59) - node list walker | (no counterpart) | DIFF |
| 141 | `double timetemp;` (line 60) - running MIN across all nodes | (no counterpart - TS returns one proposal) | DIFF |
| 142 | `double tmp;` (line 61) - per-node proposed timestep | `const del = ...` (line 296) | DIFF (ngspice names it tmp, TS names it del, but role differs - see row 152) |
| 143 | `double diff;` (line 62) - predictor-corrector difference | (no counterpart; TS's ddiff is divided-difference, not predictor error) | **DIFF (SEMANTIC)** - ngspice's `diff` = CKTrhs[i] - CKTpred[i] (predictor error). TS's `ddiff` = 3rd divided difference of past voltages. Different quantities. |
| 144 | `double tol;` (line 63) - per-node tolerance | `const tol = ...` (line 287) | DIFF (see row 158) |
| 145 | `double startTime;` (line 64) - for timing statistics | (no counterpart) | DIFF (TS has no stat tracking) |
| 146 | `int size;` (line 65) - matrix size | (no counterpart) | DIFF |

## 12. cktTerrVoltage - Entry Guard and Initialization

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:67-74) | ckt-terr.ts cktTerrVoltage (line 236) | Status |
|---|---------------------------------------------|----------------------------------------|--------|
| 147 | `startTime = SPfrontEnd->IFseconds();` (line 67) - record start time | (no counterpart) | DIFF (TS has no stat tracking) |
| 148 | `timetemp = HUGE;` (line 69) - init running MIN to infinity | (no counterpart; TS tracks single proposal, not an MIN accumulator) | DIFF |
| 149 | `size = SMPmatSize(ckt->CKTmatrix);` (line 70) - matrix size for node loop | (no counterpart) | DIFF |
| 150 | `#ifdef STEPDEBUG` ... `printf(...)` (lines 71-73) | (no counterpart) | N/A (debug code) |
| 151 | `node = ckt->CKTnodes;` (line 74) - head of node list | (no counterpart) | DIFF |
| 152 | (no counterpart) | `if (dt <= 0) return Infinity;` (line 236) - defensive dt guard | DIFF (TS-only guard; ngspice assumes dt > 0) |

## 13. cktTerrVoltage - Divided Difference (reuses cktTerr approach, lines 244-268)

Note: This entire section has no counterpart in ngspice's NEWTRUNC code because NEWTRUNC uses the predictor-corrector diff (one subtraction), not divided differences of voltage history.

| # | ngspice CKTtrunc NEWTRUNC | ckt-terr.ts cktTerrVoltage | Status |
|---|---------------------------|-----------------------------|--------|
| 153 | (no counterpart - ngspice does NOT compute voltage divided differences here) | `let diff0 = vNow, diff1 = v1, diff2 = v2, diff3 = v3;` (line 244) - initialize divided-difference registers | **DIFF (ALGORITHM)** |
| 154 | (no counterpart) | `const h0 = dt;` (line 245) | DIFF |
| 155 | (no counterpart) | `const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;` (line 246) | DIFF |
| 156 | (no counterpart) | `const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;` (line 247) | DIFF |
| 157 | (no counterpart) | `let ddiff: number;` (line 248) | DIFF |
| 158 | (no counterpart) | `if (order === 1) {` (line 250) | DIFF |
| 159 | (no counterpart) | `diff0 = (diff0 - diff1) / h0;` (line 251) - stage 1a (order 1) | DIFF |
| 160 | (no counterpart) | `diff1 = (diff1 - diff2) / h1;` (line 252) - stage 1b (order 1) | DIFF |
| 161 | (no counterpart) | `const dt0 = h1 + h0;` (line 253) - order 1 denominator | DIFF |
| 162 | (no counterpart) | `diff0 = (diff0 - diff1) / dt0;` (line 254) - stage 2 (order 1) | DIFF |
| 163 | (no counterpart) | `ddiff = Math.abs(diff0);` (line 255) | DIFF |
| 164 | (no counterpart) | `} else {` (line 256) | DIFF |
| 165 | (no counterpart) | `// order >= 2: 3rd divided difference from 4 points` (line 257) | DIFF |
| 166 | (no counterpart) | `diff0 = (diff0 - diff1) / h0;` (line 258) - stage 1a (order>=2) | DIFF |
| 167 | (no counterpart) | `diff1 = (diff1 - diff2) / h1;` (line 259) - stage 1b | DIFF |
| 168 | (no counterpart) | `diff2 = (diff2 - diff3) / h2;` (line 260) - stage 1c | DIFF |
| 169 | (no counterpart) | `let dt0 = h1 + h0;` (line 261) | DIFF |
| 170 | (no counterpart) | `let dt1 = h2 + h1;` (line 262) | DIFF |
| 171 | (no counterpart) | `diff0 = (diff0 - diff1) / dt0;` (line 263) | DIFF |
| 172 | (no counterpart) | `diff1 = (diff1 - diff2) / dt1;` (line 264) | DIFF |
| 173 | (no counterpart) | `dt0 = dt1 + h0;` (line 265) | DIFF |
| 174 | (no counterpart) | `diff0 = (diff0 - diff1) / dt0;` (line 266) | DIFF |
| 175 | (no counterpart) | `ddiff = Math.abs(diff0);` (line 267) | DIFF |
| 176 | (no counterpart) | `}` (line 268) - else-branch close | DIFF |

## 14. ngspice NEWTRUNC TRAPEZOIDAL order==1 loop (no TS counterpart)

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:75-103) | ckt-terr.ts cktTerrVoltage | Status |
|---|----------------------------------------------|----------------------------|--------|
| 177 | `switch(ckt->CKTintegrateMethod) {` (line 75) - method dispatch | (TS does method dispatch on line 275, with factor-based formula instead) | DIFF (ngspice dispatches on method to select per-order formula; TS dispatches to select a factor only and uses unified formula) |
| 178 | `case TRAPEZOIDAL:` (line 77) | (TS condition line 275 - "trapezoidal") | DIFF |
| 179 | `switch(ckt->CKTorder) {` (line 78) - nested switch on order | (TS uses if/else on order inside divided-difference code block, not here) | DIFF |
| 180 | `case 1:` (line 79) | (no counterpart - TS does not have separate formulas per order) | DIFF |
| 181 | `for(i=1;i<size;i++) {` (line 80) - iterate all nodes | (no counterpart - TS is called once per node externally) | DIFF (ngspice is per-call-iterates-all-nodes; TS is call-per-node) |
| 182 | `tol = MAX( fabs(ckt->CKTrhs[i]),fabs(ckt->CKTpred[i]))* ckt->CKTlteReltol+ckt->CKTlteAbstol;` (line 81-82) - tol = lteAbstol + lteReltol * max(|rhs|, |pred|) | `const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));` (line 287) | **DIFF (OPERAND)** - ngspice uses max of CKTrhs[i] (corrector) and CKTpred[i] (predictor) at current timepoint. TS uses max of vNow (current) and v1 (previous timepoint). Different quantities: ngspice compares two estimates at t_n; TS compares t_n with t_{n-1}. |
| 183 | `node = node->next;` (line 83) - advance node pointer | (no counterpart) | DIFF |
| 184 | `if(node->type!= SP_VOLTAGE) continue;` (line 84) - skip branch-current rows | (no counterpart; TS caller pre-filters) | DIFF (ngspice iterates all matrix rows and filters in-loop; TS expects caller to only pass voltage nodes) |
| 185 | `diff = ckt->CKTrhs[i]-ckt->CKTpred[i];` (line 85) - predictor error at node i | (no counterpart; TS uses divided-difference ddiff instead) | **DIFF (ALGORITHM)** - ngspice diff is predictor-corrector error; TS ddiff is divided-difference estimate of truncation |
| 186 | `#ifdef STEPDEBUG` ... printf (lines 86-89) | (no counterpart) | N/A (debug) |
| 187 | `if(diff != 0) {` (line 90) - skip nodes with zero predictor error | `if (!(denom > 0)) return Infinity;` (line 295) - different guard: TS checks denom, ngspice checks diff | DIFF (different numeric guards) |
| 188 | `tmp = ckt->CKTtrtol * tol * 2 /diff;` (line 91) - order-1 trap formula step 1 | (no counterpart - TS uses unified `trtol * tol / denom` formula) | **DIFF (FORMULA)** - ngspice order-1 trap: tmp = trtol*tol*2/diff. TS: del = trtol * tol / max(lteAbstol, factor*ddiff) where factor = 0.5 for trap order 1. Math differs: ngspice has `*2/diff` explicit, TS has `*factor^-1 / ddiff` with factor=0.5 giving `*2/ddiff` - but diff != ddiff. |
| 189 | `tmp = ckt->CKTdeltaOld[0]*sqrt(fabs(tmp));` (line 92) - tmp = deltaOld[0] * sqrt(|tmp|). Multiplies by deltaOld[0] THEN takes sqrt. | `return Math.sqrt(del);` (line 303) - only for order === 2. For order == 1 returns `del` directly (line 307), no sqrt. | **DIFF (ROOT+SCALE)** - ngspice for order 1 trap: multiplies proposal by deltaOld[0] AND takes sqrt. TS for order 1 returns del without multiplication and without sqrt. |
| 190 | `timetemp = MIN(timetemp,tmp);` (line 93) - aggregate via MIN | (no counterpart - TS returns single proposal) | DIFF |
| 191 | `#ifdef STEPDEBUG` printf (lines 94-96) | (no counterpart) | N/A |
| 192 | `} else {` (line 97) | (no counterpart) | DIFF |
| 193 | `#ifdef STEPDEBUG` printf "diff is 0" (lines 98-100) | (no counterpart) | N/A |
| 194 | `}` (line 101) - close if(diff != 0) | (no counterpart) | DIFF |
| 195 | `}` (line 102) - close for(i=1;i<size;i++) | (no counterpart) | DIFF |
| 196 | `break;` (line 103) - end case 1: | (no counterpart) | DIFF |

## 15. ngspice NEWTRUNC TRAPEZOIDAL order==2 loop (no TS counterpart)

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:104-129) | ckt-terr.ts cktTerrVoltage | Status |
|---|------------------------------------------------|----------------------------|--------|
| 197 | `case 2:` (line 104) - order==2 case open | (TS does not have separate formulas per order) | DIFF |
| 198 | `for(i=1;i<size;i++) {` (line 105) - iterate all matrix nodes | (no counterpart) | DIFF |
| 199 | `tol = MAX( fabs(ckt->CKTrhs[i]),fabs(ckt->CKTpred[i]))*ckt->CKTlteReltol+ckt->CKTlteAbstol;` (line 106-107) - same tol formula as order 1 | `const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));` (line 287, already covered row 182) | DIFF (see row 182 - ngspice operands are rhs/pred at t_n; TS operands are vNow/v1 at t_n and t_{n-1}) |
| 200 | `node = node->next;` (line 108) | (no counterpart) | DIFF |
| 201 | `if(node->type!= SP_VOLTAGE) continue;` (line 109) | (no counterpart) | DIFF |
| 202 | `diff = ckt->CKTrhs[i]-ckt->CKTpred[i];` (line 110) - predictor error | (no counterpart; TS uses divided-difference ddiff) | DIFF |
| 203 | `#ifdef STEPDEBUG` printf (lines 111-114) | (no counterpart) | N/A |
| 204 | `if(diff != 0) {` (line 115) | `if (!(denom > 0)) return Infinity;` (line 295) | DIFF (different guards) |
| 205 | `tmp = ckt->CKTdeltaOld[0]*ckt->CKTtrtol * tol * 3 * (ckt->CKTdeltaOld[0]+ckt->CKTdeltaOld[1])/diff;` (line 116-117) - order-2 trap formula: tmp = deltaOld[0] * trtol * tol * 3 * (deltaOld[0] + deltaOld[1]) / diff. Note the constant 3, the (h0+h1) factor, and multiplication by deltaOld[0]. | `const del = trtol * tol / denom;` (line 296) where `denom = Math.max(lteAbstol, factor * ddiff)` (line 294) and factor = 1/12 = TRAP_LTE_FACTOR_1 (line 276) | **DIFF (FORMULA)** - ngspice order-2 trap: `tmp = h0 * trtol * tol * 3 * (h0+h1) / (rhs-pred)`. TS order 2: `del = trtol * tol / max(lteAbstol, (1/12) * ddiff)`. The ngspice formula has linear h0*(h0+h1) factor AND no LTE factor coefficient (the 1/12 is implicit in the 3 and the structure). TS uses a factor of 1/12 on ddiff. Completely different arithmetic. |
| 206 | `tmp = fabs(tmp);` (line 118) - take absolute value | (no counterpart; TS uses `Math.abs(ddiff)` earlier instead) | DIFF |
| 207 | `timetemp = MIN(timetemp,tmp);` (line 119) | (no counterpart) | DIFF |
| 208 | `#ifdef STEPDEBUG` printf (lines 120-122) | (no counterpart) | N/A |
| 209 | `} else {` (line 123) | (no counterpart) | DIFF |
| 210 | `#ifdef STEPDEBUG` "diff is 0" (lines 124-126) | (no counterpart) | N/A |
| 211 | `}` (line 127) - close if(diff != 0) | (no counterpart) | DIFF |
| 212 | `}` (line 128) - close for-loop | (no counterpart) | DIFF |
| 213 | `break;` (line 129) - end case 2: | (no counterpart) | DIFF |

## 16. ngspice NEWTRUNC TRAPEZOIDAL default (error case)

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:130-132) | ckt-terr.ts cktTerrVoltage | Status |
|---|------------------------------------------------|----------------------------|--------|
| 214 | `default:` (line 130) - order > 2 for trap | (no counterpart; TS silently uses order-2 math) | **DIFF (ERROR HANDLING)** - ngspice returns E_ORDER if trap is used with order > 2. TS falls through to the else branch (orders >= 2) and computes with the order-2 divided difference but applies order-N root, producing silently incorrect values. |
| 215 | `return(E_ORDER);` (line 131) - return error code | (no counterpart) | DIFF |
| 216 | `break;` (line 132) - unreachable break after return | (no counterpart) | N/A (unreachable code) |
| 217 | `}` (line 134) - close nested switch on order | (no counterpart) | DIFF |
| 218 | `break;` (line 135) - end case TRAPEZOIDAL: | (no counterpart) | DIFF |

## 17. ngspice NEWTRUNC GEAR case (no TS counterpart for this formula)

Note: our cktTerrVoltage treats "bdf1" and "bdf2" the same way as trapezoidal structurally - just swaps the factor constant. ngspice GEAR has a completely different formula with a `delsum` prefactor.

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:137-177) | ckt-terr.ts cktTerrVoltage | Status |
|---|------------------------------------------------|----------------------------|--------|
| 219 | `case GEAR: {` (line 137) - GEAR case open with local scope | `} else {` (line 277) - non-trapezoidal branch | DIFF |
| 220 | `double delsum=0;` (line 138) - sum of timestep history | (no counterpart - TS does not compute delsum) | **DIFF (COMPUTATION)** - ngspice GEAR uses delsum = sum(deltaOld[0..order]) as a scaling factor. TS does not compute delsum. |
| 221 | `for(i=0;i<=ckt->CKTorder;i++) {` (line 139) - delsum accumulation loop | (no counterpart) | DIFF |
| 222 | `delsum += ckt->CKTdeltaOld[i];` (line 140) - accumulate deltaOld[i] | (no counterpart) | DIFF |
| 223 | `}` (line 141) - close delsum loop | (no counterpart) | DIFF |
| 224 | `for(i=1;i<size;i++) {` (line 142) - iterate all matrix nodes | (no counterpart) | DIFF |
| 225 | `node = node->next;` (line 143) | (no counterpart) | DIFF |
| 226 | `if(node->type!= SP_VOLTAGE) continue;` (line 144) | (no counterpart) | DIFF |
| 227 | `tol = MAX( fabs(ckt->CKTrhs[i]),fabs(ckt->CKTpred[i]))*ckt->CKTlteReltol+ckt->CKTlteAbstol;` (line 145-146) - tol from predictor/corrector max | `const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));` (line 287) | DIFF (same operand-shift as rows 182, 199) |
| 228 | `diff = (ckt->CKTrhs[i]-ckt->CKTpred[i]);` (line 147) - predictor error | (no counterpart) | DIFF |
| 229 | `#ifdef STEPDEBUG` printf (lines 148-151) | (no counterpart) | N/A |
| 230 | `if(diff != 0) {` (line 152) | `if (!(denom > 0)) return Infinity;` (line 295) | DIFF |
| 231 | `tmp = tol*ckt->CKTtrtol*delsum/(diff*ckt->CKTdelta);` (line 153) - GEAR formula: tmp = (tol * trtol * delsum) / (diff * delta) | `const factor = GEAR_LTE_FACTORS[idx];` then `denom = max(lteAbstol, factor*ddiff); del = trtol*tol/denom;` (lines 279, 294, 296) | **DIFF (FORMULA)** - ngspice GEAR: `tmp = (tol * trtol * delsum) / (diff * delta)`. TS GEAR: `del = trtol * tol / max(lteAbstol, gearCoeff[order-1] * ddiff)`. The delsum/(diff*delta) structure is absent in TS; TS uses factor*ddiff instead. |
| 232 | `tmp = fabs(tmp);` (line 154) - take absolute value | (no counterpart; TS computed Math.abs(diff0) earlier) | DIFF |
| 233 | `switch(ckt->CKTorder) {` (line 155) - nested switch on order for root | `if (order === 2) { return Math.sqrt(del); } else if (order > 2) { return Math.exp(Math.log(del) / order); } return del;` (lines 302-307) | DIFF (both dispatch on order for the root, but root bases differ - ngspice uses `order+1` in the root, TS uses `order`) |
| 234 | `case 0:` (line 156) - order==0 case | (no counterpart; TS has no order==0 handling) | DIFF |
| 235 | `break;` (line 157) - order 0: no modification to tmp | (no counterpart) | DIFF |
| 236 | `case 1:` (line 158) - order==1 case | `return del;` (line 307) - order==1 path: no root | DIFF |
| 237 | `tmp = sqrt(tmp);` (line 159) - order 1: tmp = sqrt(tmp) | (no counterpart; TS order 1 returns del WITHOUT sqrt) | **DIFF (ROOT)** - ngspice GEAR order==1: sqrt is applied. TS order==1: no root applied. Mismatch. |
| 238 | `break;` (line 160) - end case 1 | (no counterpart) | DIFF |
| 239 | `default:` (line 161) - order >= 2 default | `if (order === 2) { return Math.sqrt(del); } else if (order > 2) { return Math.exp(Math.log(del) / order); }` (lines 302-305) | DIFF (TS splits order 2 from order > 2; ngspice GEAR groups them in default branch) |
| 240 | `tmp = exp(log(tmp)/(ckt->CKTorder+1));` (line 162) - root = (order+1)-th root | `return Math.sqrt(del);` for order===2 (line 303) OR `return Math.exp(Math.log(del) / order);` for order>2 (line 305) | **DIFF (ROOT BASE)** - ngspice GEAR default: exp(log(tmp)/(order+1)) so for order=2 this is cube root, for order=3 this is 4th root. TS for order=2 uses sqrt (2nd root), for order>2 uses 1/order root (3rd, 4th, ...). Mismatch of one on the root index: ngspice uses order+1, TS uses order. |
| 241 | `break;` (line 163) - end default | (no counterpart) | DIFF |
| 242 | `}` (line 164) - close switch on order | (no counterpart) | DIFF |
| 243 | `tmp *= ckt->CKTdelta;` (line 165) - **CRITICAL**: multiply the proposed tmp by CKTdelta | (no counterpart) | **DIFF (SCALE FACTOR)** - ngspice GEAR multiplies the final tmp by CKTdelta. TS does NOT. Without this multiplication, proposed timesteps differ by a factor of delta (which can be 1e-9 or smaller), drastically changing the step control feedback. |
| 244 | `timetemp = MIN(timetemp,tmp);` (line 166) - aggregate via MIN | (no counterpart) | DIFF |
| 245 | `#ifdef STEPDEBUG` printf (lines 167-169) | (no counterpart) | N/A |
| 246 | `} else {` (line 170) - diff == 0 branch | (no counterpart) | DIFF |
| 247 | `#ifdef STEPDEBUG` "diff is 0" (lines 171-173) | (no counterpart) | N/A |
| 248 | `}` (line 174) - close if(diff != 0) | (no counterpart) | DIFF |
| 249 | `}` (line 175) - close for-loop over nodes | (no counterpart) | DIFF |
| 250 | `}` (line 176) - close block for GEAR case scope | (no counterpart) | DIFF |
| 251 | `break;` (line 177) - end case GEAR: | (no counterpart) | DIFF |

## 18. ngspice NEWTRUNC default case

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:179-182) | ckt-terr.ts cktTerrVoltage | Status |
|---|------------------------------------------------|----------------------------|--------|
| 252 | `default:` (line 179) - unknown integration method | (no counterpart; TS `else` handles any non-"trapezoidal" method) | DIFF |
| 253 | `return(E_METHOD);` (line 180) - return error | (no counterpart; TS silently uses GEAR factor table) | **DIFF (ERROR HANDLING)** |
| 254 | (implicit break) | (no counterpart) | N/A |
| 255 | `}` (line 182) - close outer switch on method | `}` (line 280) - close TS if/else for method | MATCH (both close method dispatch block) |

## 19. ngspice NEWTRUNC epilogue

| # | ngspice CKTtrunc NEWTRUNC (ckttrunc.c:183-186) | ckt-terr.ts cktTerrVoltage | Status |
|---|------------------------------------------------|----------------------------|--------|
| 256 | `*timeStep = MIN(2 * *timeStep,timetemp);` (line 183) - mutate caller's timestep: MIN of (2x caller) and computed timetemp | (no counterpart - all three return paths in TS return del-based values directly on lines 303, 305, 307) | **DIFF (MIN+DOUBLE)** - ngspice has a `2 * *timeStep` growth factor then takes MIN. This is how ngspice enforces at most 2x growth per step while allowing arbitrary shrinkage. TS does NOT apply this 2x cap - the caller must enforce externally. |
| 257 | `ckt->CKTstat->STATtranTruncTime += SPfrontEnd->IFseconds() - startTime;` (line 184) - update time statistics | (no counterpart) | DIFF (TS has no stats) |
| 258 | `return(OK);` (line 185) - success return | (returns happen earlier on lines 295, 303, 305, 307) | DIFF (TS multi-exit; ngspice single-exit with status code) |
| 259 | `#endif /* NEWTRUNC */` (line 186) - close #ifdef | (no counterpart) | N/A |

## 20. cktTerrVoltage-specific tolerance formula and factor selection (TS lines 275-296)

These lines are TS-specific and have no direct ngspice counterpart because NEWTRUNC uses a completely different algorithm per-method-per-order. Mapping them to ngspice's structure explicitly:

| # | ngspice CKTtrunc NEWTRUNC | ckt-terr.ts cktTerrVoltage (lines 275-296) | Status |
|---|---------------------------|---------------------------------------------|--------|
| 260 | (no counterpart) | `let factor: number;` (line 274) | DIFF |
| 261 | (no counterpart) | `if (method === "trapezoidal") {` (line 275) | DIFF |
| 262 | (no counterpart) | `factor = order <= 1 ? TRAP_LTE_FACTOR_0 : TRAP_LTE_FACTOR_1;` (line 276) - binary pick 0.5 or 1/12 | DIFF (ngspice does not use a factor lookup - the order-specific formula embeds the constants 2 and 3 directly) |
| 263 | (no counterpart) | `} else {` (line 277) | DIFF |
| 264 | (no counterpart) | `const idx = Math.min(order - 1, GEAR_LTE_FACTORS.length - 1);` (line 278) - clamp order index to array bounds | **DIFF (CLAMP)** - TS silently clamps order > 6 to index 5. ngspice would access gearCoeff[order-1] with no clamp and would out-of-bounds read on order > 6 (writing to undefined memory). TS is safer but masks caller error. |
| 265 | (no counterpart) | `factor = GEAR_LTE_FACTORS[idx];` (line 279) - lookup from gearCoeff table | DIFF (note: this IS the gear-table lookup that cktTerr lacks; cktTerrVoltage does it correctly but cktTerr does not) |
| 266 | (no counterpart) | `}` (line 280) | DIFF |
| 267 | (no counterpart) | `const tol = lteAbstol + lteReltol * Math.max(Math.abs(vNow), Math.abs(v1));` (line 287) | see row 182 (DIFF - operand shift) |
| 268 | (no counterpart) | `const denom = Math.max(lteAbstol, factor * ddiff);` (line 294) - denominator floored at lteAbstol | DIFF (TS unifies denominator structure across methods; ngspice has per-method-per-order formulas) |
| 269 | (no counterpart) | `if (!(denom > 0)) return Infinity;` (line 295) - denom-zero guard | DIFF (TS defensive guard) |
| 270 | (no counterpart) | `const del = trtol * tol / denom;` (line 296) - unified del formula | DIFF |

## 21. cktTerrVoltage root extraction (TS lines 302-307)

| # | ngspice CKTtrunc NEWTRUNC GEAR (ckttrunc.c:158-162) | ckt-terr.ts cktTerrVoltage (lines 302-307) | Status |
|---|------------------------------------------------------|---------------------------------------------|--------|
| 271 | `case 1: tmp = sqrt(tmp); break;` (line 158-160) - order==1 gets SQRT in ngspice GEAR | `if (order === 2) {` (line 302) - TS checks order===2 first (not order 1) | DIFF (different order triggering the first root) |
| 272 | (ngspice GEAR order 2 in default branch: tmp = exp(log(tmp)/3), i.e. cube root) | `return Math.sqrt(del);` (line 303) - order 2: square root | **DIFF (ROOT INDEX)** - ngspice GEAR order==2 takes cube root (1/3); TS takes square root (1/2). |
| 273 | (ngspice GEAR default order>1 formula uses exp(log/(order+1))) | `} else if (order > 2) {` (line 304) | DIFF |
| 274 | (ngspice uses order+1 in the root base) | `return Math.exp(Math.log(del) / order);` (line 305) - uses `order` in the root base | **DIFF (ROOT INDEX)** - ngspice uses order+1; TS uses order. For order 3, ngspice takes 4th root; TS takes 3rd root. |
| 275 | (ngspice GEAR order 1 takes sqrt; ngspice GEAR order 0 takes no root) | `}` (line 306) then `return del;` (line 307) - order <= 1 returns del unmodified | **DIFF (ROOT)** - ngspice GEAR order 1 takes sqrt; TS order 1 takes no root. |

## 22. Function close

| # | ngspice CKTtrunc NEWTRUNC | ckt-terr.ts cktTerrVoltage | Status |
|---|---------------------------|-----------------------------|--------|
| 276 | `}` (ckttrunc.c:187) - close CKTtrunc function | `}` (line 308) - close cktTerrVoltage | MATCH (both close function body) |

---

# Part III: Critical Deviations and Summary

## 23. Critical DIFFs (cktTerr vs ngspice CKTterr - charge-based path)

| ID | Location | ngspice formula | TS formula | Impact |
|----|----------|-----------------|------------|--------|
| C1 | chargetol (rows 58-59) | `reltol * MAX(MAX(\|q0\|,\|q1\|), chgtol) / delta` | `MAX(reltol * MAX(\|q0\|,\|q1\|), chgtol) / delta` | When reltol*max_q < chgtol, ngspice yields `reltol*chgtol/delta`, TS yields `chgtol/delta`. Ratio is 1/reltol = 1000x. TS is more permissive (larger tol -> larger timestep). Comment on lines 156-160 matches ngspice; code line 163 does not. |
| C2 | GEAR factor lookup (row 111) | `gearCoeff[order-1]` for order 1..6 | Binary: `order<=1 ? 0.5 : 2/9` - ignores the full GEAR_LTE_FACTORS table | For order 3, ngspice uses 0.1363636364; TS uses 2/9=0.2222. TS is 63% larger factor -> ~63% smaller timestep proposal at order 3. |
| C3 | order > 2 divided difference (row 107) | Handles via generic for(;;) loop with arrays up to diff[7], deltmp[7] | No implementation; falls into order==2 else branch | For BDF-3 through BDF-6, the divided difference is the 3rd divided difference (order 2 math) but the root is 1/order (3rd..6th root). Silent correctness bug. |
| C4 | LTE coefficient precision (rows 44-52) | Truncated decimals `.2222222222`, `.1363636364`, `.07299270073`, `.05830903790`, `.08333333333` | Exact fractions `2/9`, `3/22`, `10/137`, `20/343`, `1/12` | TS is ~1e-11 more precise per coefficient. Accumulated impact: negligible in single step, potentially observable over many accepted steps in long simulations. |
| C5 | MIN fusion with caller timestep (row 126) | `*timeStep = MIN(*timeStep, del)` at end of function | Returns del directly without MIN | TS requires caller to aggregate. If caller uses `min = Math.min(min, cktTerr(...))` this is equivalent. If caller uses `min = cktTerr(...)` (overwrite), earlier smaller proposals are lost. |
| C6 | dt guard (row 55) | No guard, assumes dt > 0 | `if (dt <= 0) return Infinity;` | TS is safer; no correctness difference when invariant holds. |
| C7 | denom > 0 guard (row 120) | No guard, assumes denom > 0 (true if abstol > 0) | `if (!(denom > 0)) return Infinity;` | TS is safer; no correctness difference when abstol > 0. |

## 24. Critical DIFFs (cktTerrVoltage vs ngspice NEWTRUNC CKTtrunc - voltage-based path)

| ID | Location | ngspice formula | TS formula | Impact |
|----|----------|-----------------|------------|--------|
| V1 | Fundamental algorithm (section 13) | Predictor-corrector error: `diff = CKTrhs[i] - CKTpred[i]` | Divided difference of past voltage samples: `ddiff = 3rd divided diff of vNow, v1, v2, v3` | Different quantities, different convergence semantics. Cannot be made numerically equivalent without reimplementing predictor. |
| V2 | tol operands (rows 182, 199, 227) | `MAX(\|CKTrhs[i]\|, \|CKTpred[i]\|)` - both at t_n (corrector vs predictor) | `MAX(\|vNow\|, \|v1\|)` - at t_n vs t_{n-1} | Different comparison reference frames. |
| V3 | TRAP order 1 formula (rows 188-189) | `tmp = deltaOld[0] * sqrt(\|trtol * tol * 2 / diff\|)` | `del = trtol * tol / max(lteAbstol, 0.5 * ddiff)`, then return `del` (no sqrt) | Different formulas; TS missing sqrt and the deltaOld[0] multiplication. |
| V4 | TRAP order 2 formula (row 205) | `tmp = \|deltaOld[0] * trtol * tol * 3 * (deltaOld[0]+deltaOld[1]) / diff\|` | `del = trtol * tol / max(lteAbstol, (1/12) * ddiff)`, then return `sqrt(del)` | Different formulas; ngspice order 2 has linear h0*(h0+h1) scale and constant 3; TS uses factor 1/12. |
| V5 | GEAR formula (row 231) | `tmp = (tol * trtol * delsum) / (diff * delta)` where `delsum = sum(deltaOld[0..order])`; then root (order+1); then `tmp *= delta` | `del = trtol * tol / max(lteAbstol, gearCoeff[order-1] * ddiff)`; then root `order` | No delsum computation, no `* delta` post-multiply, wrong root index (TS order; ngspice order+1). |
| V6 | GEAR root index (rows 240, 272-274) | For order==1: sqrt. For order>=2: `exp(log/(order+1))`. So order 2 = cube root, order 3 = 4th root, etc. | For order==1: no root. For order==2: sqrt. For order>2: `exp(log/order)` | Root index off by one relative to ngspice GEAR. |
| V7 | Error handling for invalid order/method (rows 214, 253) | Returns `E_ORDER` for TRAP order > 2; returns `E_METHOD` for unknown method | No error return; silently uses clamped factor and order-2 math | TS masks caller errors. |
| V8 | MIN + 2x growth cap (row 256) | `*timeStep = MIN(2 * *timeStep, timetemp)` | Returns del directly; no 2x cap | TS requires caller to enforce growth cap externally. |
| V9 | Node iteration (rows 181, 198, 224) | Iterates all matrix nodes inside function, filters by `node->type == SP_VOLTAGE` | Called once per voltage by caller | TS moves the loop to caller; caller must filter nodes externally. |

## 25. Algorithmic Deviation Between cktTerr and cktTerrVoltage (both in our file)

| Aspect | cktTerr (lines 88-189) | cktTerrVoltage (lines 226-308) |
|--------|----------------------|-------------------------------|
| GEAR factor lookup | Binary (order <= 1 ? 0.5 : 2/9) - does not use GEAR_LTE_FACTORS array | Full table with `Math.min(order - 1, GEAR_LTE_FACTORS.length - 1)` - uses GEAR_LTE_FACTORS array |
| Order > 2 divided difference | Falls into order-2 else branch (incorrect math for order >= 3) | Same bug: falls into order>=2 else branch computing 3rd divided difference regardless of order |
| Tolerance formula | `MAX(volttol, chargetol)` dual-tolerance (charge + companion current) | `lteAbstol + lteReltol * MAX(\|vNow\|, \|v1\|)` single tol |
| Denominator floor | `MAX(abstol, factor * ddiff)` | `MAX(lteAbstol, factor * ddiff)` |
| Guards | `if (dt <= 0) return Infinity` and `if (!(denom > 0)) return Infinity` | Same two guards |

Note: cktTerrVoltage correctly uses GEAR_LTE_FACTORS[idx] for the factor lookup (line 278-279), while cktTerr only ever picks between 0.5 and 2/9 (line 152) - the same GEAR_LTE_FACTORS array is imported at module scope but cktTerr does not use it. This is an inconsistency between the two functions in the same file.

## 26. Summary Statistics

| Category | cktTerr vs CKTterr | cktTerrVoltage vs CKTtrunc NEWTRUNC | Total |
|----------|-------------------|---------------------------------------|-------|
| Total rows mapped | 128 | 148 | 276 |
| MATCH rows | 22 | 3 | 25 |
| DIFF rows (minor: naming, structure, guard) | 58 | 72 | 130 |
| DIFF rows (major: formula, algorithm, coverage gap) | 8 | 18 | 26 |
| N/A rows (comments, ifdef, blank) | 40 | 55 | 95 |
| Critical architectural DIFFs | 7 (C1-C7) | 9 (V1-V9) | 16 |

### Pass/fail verdict per section

| Section | Rows | Verdict |
|---------|-----:|---------|
| 1. File preamble | 18 | INFORMATIONAL (mostly N/A comments) |
| 2a. cktTerr signature | 14 | STRUCTURAL DIFF (ngspice void+mutate; TS returns value) |
| 2b. cktTerr locals | 9 | MATCH on intent, DIFF on storage (arrays vs scalars) |
| 2c. LTE tables | 13 | DIFF on precision (truncated decimals vs exact fractions) |
| 3. Entry guard | 1 | DIFF (TS adds guard) |
| 4a. volttol | 2 | MATCH |
| 4b. chargetol | 2 | **CRITICAL DIFF** (reltol scoping) |
| 4c. tol | 1 | MATCH |
| 5a. divided-diff preamble | 5 | DIFF (TS pre-extracts scalars) |
| 5b-5c. ngspice init loops | 6 | DIFF (no TS counterpart - unrolled) |
| 5d. outer loop entry | 2 | DIFF (unrolled vs looped) |
| 5e. order 1 divided-diff | 13 | MATCH on math, DIFF on control flow |
| 5f. order 2 divided-diff | 20 | MATCH on math, DIFF on control flow |
| 5g. orders > 2 | 1 | **CRITICAL DIFF** (coverage gap, silent bug) |
| 6a-6c. factor dispatch | 10 | MATCH on dispatch logic; CRITICAL DIFF on gear table usage |
| 7. del formula | 3 | MATCH |
| 8a-8c. root extraction | 5 | MATCH on math |
| 9a-9c. epilogue | 3 | CRITICAL DIFF (missing MIN aggregation) |
| 10-12. cktTerrVoltage entry | 19 | STRUCTURAL DIFF (different algorithm) |
| 13. divided-diff setup | 24 | ALGORITHM DIFF (no ngspice counterpart) |
| 14-16. trap formulas | 22 | ALGORITHM DIFF (predictor error vs divided diff) |
| 17. GEAR formula | 33 | ALGORITHM DIFF (delsum vs factor, root order) |
| 18. default error | 4 | DIFF (error handling) |
| 19. epilogue | 4 | CRITICAL DIFF (no 2x cap, no stat update) |
| 20. TS factor selection | 11 | ALGORITHM DIFF (unified vs per-order) |
| 21. TS root extraction | 5 | CRITICAL DIFF (root index off by 1 for GEAR) |
| 22. function close | 1 | MATCH |

## 27. Open questions / suggested investigation

1. **Row C1 (chargetol reltol scoping):** Is this deliberate (documentation comment says ngspice-style) or a code bug? If the comment is correct, the code should be `reltol * max(max(|q0|,|q1|), chgtol) / dt`. This is a one-line fix.

2. **Rows C3 and V6 (order > 2 divided differences):** Our BDF-1/trap/BDF-2 integrator is stated (line 7 doc) to not support order > 2, but GEAR_LTE_FACTORS array has 6 entries. Is there a plan to support BDF-3..BDF-6? If yes, the divided-difference code must be generalized. If no, the GEAR_LTE_FACTORS size and cktTerrVoltage clamp logic are dead code.

3. **Row C5 (MIN fusion):** All callers must be audited to ensure they use `Math.min(accumulator, cktTerr(...))` rather than `accumulator = cktTerr(...)`. If any caller just assigns, junction-wise LTE aggregation is broken.

4. **Rows V1-V9 (cktTerrVoltage algorithm):** Our cktTerrVoltage is not ngspice NEWTRUNC - it is an adaptation of the CKTterr (non-NEWTRUNC) divided-difference algorithm applied to voltages instead of charges. The file documents "NEWTRUNC variant" on line 201; this doc is misleading because the actual algorithm differs fundamentally from ngspice NEWTRUNC. Recommend: either rename to reflect that it is a divided-difference voltage LTE (not NEWTRUNC), or re-implement to match NEWTRUNC's predictor-corrector approach.

## 28. File references

- `src/solver/analog/ckt-terr.ts` (our code, 308 lines)
- `ref/ngspice/src/spicelib/analysis/cktterr.c` (ngspice non-NEWTRUNC, 77 lines)
- `ref/ngspice/src/spicelib/analysis/ckttrunc.c` (ngspice NEWTRUNC, 187 lines)
- `spec/state-machines/ngspice.yaml` (state machine reference, LTE parameters and truncation-error check state)
