# CKTop vs dc-operating-point.ts — Line-by-Line Code Mapping

## 1. CKTop Main Function (cktop.c:27-86)

| # | ngspice CKTop (C) | dc-operating-point.ts (TS) | Status |
|---|-------------------|----------------------------|--------|
| 1 | `CKTop (CKTcircuit * ckt, long int firstmode, long int continuemode, int iterlim)` (line 28-29) | `function cktop(opts: CKTopCallOptions, firstMode: InitMode, _continueMode: InitMode, maxIter: number)` (line 267-272) | DIFF |
| 2 | `int converged;` (line 31) | No local `converged` declaration; return value is `{ converged, iterations, voltages }` | DIFF |
| 3 | `SetAnalyse("op", 0);` (line 33) | MISSING_OURS |
| 4 | `ckt->CKTmode = firstmode;` (line 35) | `opts.ladder.pool.initMode = firstMode;` (line 275) | DIFF |
| 5 | `if (!ckt->CKTnoOpIter) {` (line 37) | `if (opts.params.noOpIter) {` (line 277) | DIFF |
| 6 | `if ((ckt->CKTnumGminSteps <= 0) && (ckt->CKTnumSrcSteps <= 0)) ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 40-41) | MISSING_OURS |
| 7 | `else ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 43) | MISSING_OURS |
| 8 | `converged = NIiter (ckt, iterlim);` (line 46) | `return newtonRaphson({ ...opts.nrBase, maxIterations: maxIter, elements: opts.elements, dcopModeLadder: opts.ladder });` (line 284-290) | DIFF |
| 9 | `} else { converged = 1; }` (line 47-49) | `return { converged: true, iterations: 0, voltages: opts.voltages ?? new Float64Array(opts.nrBase.matrixSize) };` (line 278-283) | DIFF |
| 10 | `if (converged != 0) {` (line 52) | `if (directResult.converged) { ... } // inverted sense` (line 483) | DIFF |
| 11 | `if (ckt->CKTnumGminSteps >= 1) {` (line 56) | `const numGminSteps = params.numGminSteps ?? 1;` (line 507) | DIFF |
| 12 | `if (ckt->CKTnumGminSteps == 1) converged = dynamic_gmin(ckt, firstmode, continuemode, iterlim);` (line 57-58) | `if (numGminSteps <= 1) { gminResult = dynamicGmin(...); }` (line 509-510) | DIFF |
| 13 | `else converged = spice3_gmin(ckt, firstmode, continuemode, iterlim);` (line 59-60) | `else { gminResult = spice3Gmin(...); }` (line 511-512) | DIFF |
| 14 | `if (!converged) return (0);` (line 62-63) | `if (gminResult.converged) { dcopFinalize(...); return { ... }; }` (line 516-538) | DIFF |
| 15 | `if (ckt->CKTnumSrcSteps >= 1) {` (line 71) | `const numSrcSteps = params.numSrcSteps ?? 1;` (line 543) | DIFF |
| 16 | `if (ckt->CKTnumSrcSteps == 1) converged = gillespie_src(ckt, firstmode, continuemode, iterlim);` (line 72-73) | `if (numSrcSteps <= 1) { srcResult = gillespieSrc(...); }` (line 545-546) | DIFF |
| 17 | `else converged = spice3_src(ckt, firstmode, continuemode, iterlim);` (line 74-75) | `else { srcResult = spice3Src(...); }` (line 547-548) | DIFF |
| 18 | `ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 79) | MISSING_OURS |
| 19 | `return (converged);` (line 85) | `return { converged: false, method: "direct", iterations: totalIterations, nodeVoltages: new Float64Array(matrixSize), diagnostics: diagnostics.getDiagnostics() };` (line 607-613) | DIFF |

## 2. solveDcOperatingPoint Entry / DCop Wrapper (dcop.c:21-84 vs dc-operating-point.ts:395-500)

| # | ngspice DCop (C) | dc-operating-point.ts (TS) | Status |
|---|------------------|----------------------------|--------|
| 20 | `int converged; int error;` (line 29-30) | `const { solver, elements, matrixSize, params, diagnostics, ... } = opts;` (line 396) | DIFF |
| 21 | `error = CKTnames(ckt, &numNames, &nameList);` (line 51) | MISSING_OURS |
| 22 | `error = SPfrontEnd->OUTpBeginPlot(...)` (line 53-57) | MISSING_OURS |
| 23 | `if (ckt->CKTsoaCheck) error = CKTsoaInit();` (line 62-63) | MISSING_OURS |
| 24 | `converged = CKTop(ckt, (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITJCT, (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITFLOAT, ckt->CKTdcMaxIter);` (line 81-84) | `const directResult = cktop({ nrBase, params, elements, voltages: new Float64Array(matrixSize), ladder }, "initJct", "initFloat", params.maxIterations);` (line 470-475) | DIFF |
| 25 | `if(converged != 0) { fprintf(stdout,"\nDC solution failed -\n"); CKTncDump(ckt); return(converged); }` (line 86-123) | `const ncNodes = cktncDump(...); diagnostics.emit(makeDiagnostic("dc-op-failed", ...));` (line 581-605) | DIFF |
| 26 | `ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;` (line 127) | `pool.initMode = "initSmsig";` (line 319) | DIFF |
| 27 | `converged = CKTload(ckt);` (line 153) | `newtonRaphson({ ...nrBase, postIterationHook: undefined, maxIterations: 1, exactMaxIterations: true, elements, initialGuess: voltages });` (line 321-328) | DIFF |
| 28 | `CKTdump(ckt, 0.0, plot);` (line 160-171) | MISSING_OURS |
| 29 | `if (ckt->CKTsoaCheck) error = CKTsoaCheck(ckt);` (line 162-173) | MISSING_OURS |
| 30 | `SPfrontEnd->OUTendPlot (plot);` (line 178) | MISSING_OURS |
| 31 | `return(converged);` (line 179) | `return { converged: true, method: "direct", iterations: directResult.iterations, nodeVoltages: directResult.voltages, diagnostics: diagnostics.getDiagnostics() };` (line 493-499) | DIFF |
| 32 | MISSING_NGSPICE | `pool.initMode = "transient";` (line 330) | MISSING_NGSPICE |

## 3. dcopFinalize (dcop.c:127-178 vs dc-operating-point.ts:312-332)

| # | ngspice DCop (C) | dc-operating-point.ts (TS) | Status |
|---|------------------|----------------------------|--------|
| 33 | `ckt->CKTmode = (ckt->CKTmode & MODEUIC) | MODEDCOP | MODEINITSMSIG;` (line 127) | `pool.initMode = "initSmsig";` (line 319) | DIFF |
| 34 | `converged = CKTload(ckt);` (line 153) | `newtonRaphson({ ...nrBase, maxIterations: 1, exactMaxIterations: true, elements, initialGuess: voltages });` (line 321-328) | DIFF |
| 35 | MISSING_NGSPICE | `pool.initMode = "transient";` (line 330) | MISSING_NGSPICE |

## 4. dynamic_gmin (cktop.c:133-269)

| # | ngspice dynamic_gmin (C) | dc-operating-point.ts dynamicGmin (TS) | Status |
|---|--------------------------|----------------------------------------|--------|
| 36 | `double OldGmin, gtarget, factor;` (line 137) | `let factor`, `let oldGmin`, `const gtarget` (line 674-678) | MATCH |
| 37 | `int success, failed, converged;` (line 138) | No `success`/`failed` flags; uses `while(true)` with `break`/`return` | DIFF |
| 38 | `int NumNodes, iters, i;` (line 140) | No `NumNodes`; `totalIter` instead of `iters` (line 679) | DIFF |
| 39 | `double *OldRhsOld, *OldCKTstate0;` (line 141) | `const savedVoltages = new Float64Array(matrixSize);` `const savedState0 = ...` (line 669-670) | MATCH |
| 40 | `CKTnode *n;` (line 142) | MISSING_OURS |
| 41 | `ckt->CKTmode = firstmode;` (line 144) | `statePool.initMode = "initJct";` (line 666) | DIFF |
| 42 | `SPfrontEnd->IFerrorf(ERR_INFO, "Starting dynamic gmin stepping");` (line 145-146) | MISSING_OURS |
| 43 | `NumNodes = 0; for (n = ckt->CKTnodes; n; n = n->next) NumNodes++;` (line 148-150) | MISSING_OURS |
| 44 | `OldRhsOld = TMALLOC(double, NumNodes + 1);` (line 152) | `const savedVoltages = new Float64Array(matrixSize);` (line 669) | DIFF |
| 45 | `OldCKTstate0 = TMALLOC(double, ckt->CKTnumStates + 1);` (line 153-154) | `const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);` (line 670) | DIFF |
| 46 | `for (n = ckt->CKTnodes; n; n = n->next) ckt->CKTrhsOld[n->number] = 0;` (line 156-157) | `voltages.fill(0);` via `zeroState(voltages, statePool)` (line 663-664) | DIFF |
| 47 | `for (i = 0; i < ckt->CKTnumStates; i++) ckt->CKTstate0[i] = 0;` (line 159-160) | `statePool.state0.fill(0);` via `zeroState(voltages, statePool)` (line 663-664) | DIFF |
| 48 | `factor = ckt->CKTgminFactor;` (line 162) | `let factor = params.gminFactor ?? 10;` (line 674) | MATCH |
| 49 | `OldGmin = 1e-2;` (line 163) | `let oldGmin = 1e-2;` (line 676) | MATCH |
| 50 | `ckt->CKTdiagGmin = OldGmin / factor;` (line 164) | `let diagGmin = oldGmin;` (line 677) | DIFF |
| 51 | `gtarget = MAX(ckt->CKTgmin, ckt->CKTgshunt);` (line 165) | `const gtarget = Math.max(params.gmin, params.gshunt ?? 0);` (line 678) | MATCH |
| 52 | `success = failed = 0;` (line 166) | No explicit flags; `while(true)` loop | DIFF |
| 53 | `while ((!success) && (!failed)) {` (line 168) | `while (true) {` (line 682) | DIFF |
| 54 | `fprintf(stderr, "Trying gmin = %12.4E ", ckt->CKTdiagGmin);` (line 169) | MISSING_OURS |
| 55 | `ckt->CKTnoncon = 1;` (line 170) | MISSING_OURS |
| 56 | `iters = ckt->CKTstat->STATnumIter;` (line 171) | MISSING_OURS |
| 57 | `ni_set_phase_flags(NI_PHASE_GMIN_DYN, ckt->CKTdiagGmin, 1.0);` (line 173) | `onPhaseBegin?.("dcopGminDynamic", diagGmin);` (line 684) | DIFF |
| 58 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 174) | `const result = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages, diagonalGmin: diagGmin });` (line 685-691) | DIFF |
| 59 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 175) | MISSING_OURS |
| 60 | `iters = (ckt->CKTstat->STATnumIter) - iters;` (line 176) | `result.iterations` returned directly from NR | DIFF |
| 61 | `if (converged == 0) {` (line 178) | `if (result.converged) {` (line 695) | MATCH |
| 62 | `ckt->CKTmode = continuemode;` (line 179) | `statePool.initMode = "initFloat";` (line 699) | DIFF |
| 63 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful gmin step");` (line 180-181) | MISSING_OURS |
| 64 | `if (ckt->CKTdiagGmin <= gtarget) { success = 1; }` (line 183-184) | `if (diagGmin <= gtarget) { break; }` (line 701-703) | MATCH |
| 65 | `i = 0; for (n = ckt->CKTnodes; n; n = n->next) { OldRhsOld[i] = ckt->CKTrhsOld[n->number]; i++; }` (line 186-189) | `saveSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 707) | DIFF |
| 66 | `for (i = 0; i < ckt->CKTnumStates; i++) { OldCKTstate0[i] = ckt->CKTstate0[i]; }` (line 192-194) | `saveSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 707) | DIFF |
| 67 | `if (iters <= (ckt->CKTdcTrcvMaxIter / 4)) {` (line 196) | `if (result.iterations <= iterLo) {` (line 713) | MATCH |
| 68 | `factor *= sqrt(factor);` (line 197) | `factor = Math.min(factor * Math.sqrt(factor), 10);` (line 716) | DIFF |
| 69 | `if (factor > ckt->CKTgminFactor) factor = ckt->CKTgminFactor;` (line 198-199) | `Math.min(..., 10)` (line 716) | DIFF |
| 70 | `if (iters > (3 * ckt->CKTdcTrcvMaxIter / 4)) factor = sqrt(factor);` (line 202-203) | `} else if (result.iterations > iterHi) { factor = Math.sqrt(factor); }` (line 717-720) | MATCH |
| 71 | `OldGmin = ckt->CKTdiagGmin;` (line 205) | `oldGmin = diagGmin;` (line 725) | MATCH |
| 72 | `if ((ckt->CKTdiagGmin) < (factor * gtarget)) {` (line 207) | `if (diagGmin < factor * gtarget) {` (line 729) | MATCH |
| 73 | `factor = ckt->CKTdiagGmin / gtarget;` (line 208) | `factor = diagGmin / gtarget;` (line 731) | MATCH |
| 74 | `ckt->CKTdiagGmin = gtarget;` (line 209) | `diagGmin = gtarget;` (line 732) | MATCH |
| 75 | `} else { ckt->CKTdiagGmin /= factor; }` (line 210-211) | `} else { diagGmin /= factor; }` (line 733-735) | MATCH |
| 76 | `} else {` (line 214) | `} else {` (line 736) | MATCH |
| 77 | `if (factor < 1.00005) { failed = 1; ... }` (line 215-218) | `if (factor < 1.00005) { return { converged: false, ... }; }` (line 740-741) | MATCH |
| 78 | `SPfrontEnd->IFerrorf(ERR_WARNING, "Last gmin step failed");` (line 217-218) | MISSING_OURS |
| 79 | `SPfrontEnd->IFerrorf(ERR_WARNING, "Further gmin increment");` (line 220-221) | MISSING_OURS |
| 80 | `factor = sqrt(sqrt(factor));` (line 222) | `factor = Math.sqrt(Math.sqrt(factor));` (line 744) | MATCH |
| 81 | `ckt->CKTdiagGmin = OldGmin / factor;` (line 223) | `diagGmin = oldGmin / factor;` (line 745) | MATCH |
| 82 | `i = 0; for (n = ckt->CKTnodes; n; n = n->next) { ckt->CKTrhsOld[n->number] = OldRhsOld[i]; i++; }` (line 225-228) | `restoreSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 747) | DIFF |
| 83 | `for (i = 0; i < ckt->CKTnumStates; i++) { ckt->CKTstate0[i] = OldCKTstate0[i]; }` (line 230-232) | `restoreSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 747) | DIFF |
| 84 | `ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 238) | `diagonalGmin: params.gshunt ?? 0` passed to final NR call (line 758) | DIFF |
| 85 | `FREE(OldRhsOld);` (line 239) | MISSING_OURS |
| 86 | `FREE(OldCKTstate0);` (line 240) | MISSING_OURS |
| 87 | `if (ckt->CKTnumSrcSteps <= 0) ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 244-245) | MISSING_OURS |
| 88 | `else ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 247) | MISSING_OURS |
| 89 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 252) | `onPhaseBegin?.("dcopGminDynamic", 0);` (line 752) | DIFF |
| 90 | `converged = NIiter(ckt, iterlim);` (line 253) | `const cleanResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages, diagonalGmin: params.gshunt ?? 0 });` (line 753-759) | DIFF |
| 91 | `if (converged != 0) { SPfrontEnd->IFerrorf(ERR_WARNING, "Dynamic gmin stepping failed"); }` (line 255-257) | MISSING_OURS |
| 92 | `else { SPfrontEnd->IFerrorf(ERR_INFO, "Dynamic gmin stepping completed"); }` (line 258-260) | MISSING_OURS |
| 93 | `return (converged);` (line 268) | `if (cleanResult.converged) { return { converged: true, ... }; } return { converged: false, ... };` (line 763-767) | DIFF |

## 5. spice3_gmin (cktop.c:284-356)

| # | ngspice spice3_gmin (C) | dc-operating-point.ts spice3Gmin (TS) | Status |
|---|-------------------------|---------------------------------------|--------|
| 94 | `int converged, i;` (line 289) | `let totalIter = 0;` (line 807) | DIFF |
| 95 | `ckt->CKTmode = firstmode;` (line 291) | `statePool.initMode = "initJct";` (line 804) | DIFF |
| 96 | `SPfrontEnd->IFerrorf(ERR_INFO, "Starting gmin stepping");` (line 292-293) | MISSING_OURS |
| 97 | `if (ckt->CKTgshunt == 0) ckt->CKTdiagGmin = ckt->CKTgmin; else ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 295-298) | `let diagGmin = params.gmin;` (line 811) | DIFF |
| 98 | `for (i = 0; i < ckt->CKTnumGminSteps; i++) ckt->CKTdiagGmin *= ckt->CKTgminFactor;` (line 300-301) | `for (let k = 0; k < numGminSteps; k++) { diagGmin *= gminFactor; }` (line 812-814) | MATCH |
| 99 | `for (i = 0; i <= ckt->CKTnumGminSteps; i++) {` (line 304) | `for (let i = 0; i <= numGminSteps; i++) {` (line 817) | MATCH |
| 100 | `fprintf(stderr, "Trying gmin = %12.4E ", ckt->CKTdiagGmin);` (line 305) | MISSING_OURS |
| 101 | `ckt->CKTnoncon = 1;` (line 306) | MISSING_OURS |
| 102 | `ni_set_phase_flags(NI_PHASE_GMIN_SP3, ckt->CKTdiagGmin, 1.0);` (line 307) | `onPhaseBegin?.("dcopGminSpice3", diagGmin);` (line 818) | DIFF |
| 103 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 308) | `const result = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages, diagonalGmin: diagGmin });` (line 819-825) | DIFF |
| 104 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 309) | MISSING_OURS |
| 105 | `if (converged != 0) { ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 311-312) | `if (!result.converged) {` (line 828) | DIFF |
| 106 | `SPfrontEnd->IFerrorf(ERR_WARNING, "gmin step failed");` (line 313-314) | MISSING_OURS |
| 107 | `break; }` (line 315-316) | `return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };` (line 831) | DIFF |
| 108 | `ckt->CKTdiagGmin /= ckt->CKTgminFactor;` (line 318) | `diagGmin /= gminFactor;` (line 840) | MATCH |
| 109 | `ckt->CKTmode = continuemode;` (line 319) | `statePool.initMode = "initFloat";` (line 836) | DIFF |
| 110 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful gmin step");` (line 321-322) | MISSING_OURS |
| 111 | `ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 325) | `diagonalGmin: params.gshunt ?? 0` passed to final NR call (line 851) | DIFF |
| 112 | `if (ckt->CKTnumSrcSteps <= 0) ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 329-330) | MISSING_OURS |
| 113 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 337) | `onPhaseBegin?.("dcopGminSpice3", 0);` (line 844) | DIFF |
| 114 | `converged = NIiter(ckt, iterlim);` (line 338) | `const cleanResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, ... });` (line 845-851) | DIFF |
| 115 | `if (converged == 0) { SPfrontEnd->IFerrorf(ERR_INFO, "gmin stepping completed"); }` (line 340-342) | MISSING_OURS |
| 116 | `else { SPfrontEnd->IFerrorf(ERR_WARNING, "gmin stepping failed"); }` (line 350-352) | MISSING_OURS |
| 117 | `return (converged);` (line 355) | `return cleanResult.converged ? { converged: true, ... } : { converged: false, ... };` (line 855-858) | DIFF |

## 6. gillespie_src (cktop.c:369-569)

| # | ngspice gillespie_src (C) | dc-operating-point.ts gillespieSrc (TS) | Status |
|---|--------------------------|----------------------------------------|--------|
| 118 | `int converged, NumNodes, i, iters;` (line 374) | `let totalIter = 0;` (line 961) | DIFF |
| 119 | `double raise, ConvFact;` (line 375) | `let raise = 0.001; let convFact = 0;` (line 1017-1018) | MATCH |
| 120 | `double *OldRhsOld, *OldCKTstate0;` (line 376) | `const savedVoltages = new Float64Array(matrixSize); const savedState0 = ...` (line 958-959) | MATCH |
| 121 | `CKTnode *n;` (line 377) | MISSING_OURS |
| 122 | `NG_IGNORE(iterlim);` (line 379) | MISSING_OURS |
| 123 | `ckt->CKTmode = firstmode;` (line 381) | `statePool.initMode = "initJct";` (line 954) | DIFF |
| 124 | `SPfrontEnd->IFerrorf(ERR_INFO, "Starting source stepping");` (line 382-383) | MISSING_OURS |
| 125 | `ckt->CKTsrcFact = 0;` (line 385) | `scaleAllSources(elements, 0);` (line 956) | DIFF |
| 126 | `raise = 0.001;` (line 386) | `let raise = 0.001;` (line 1017) | MATCH |
| 127 | `ConvFact = 0;` (line 387) | `let convFact = 0;` (line 1018) | MATCH |
| 128 | `NumNodes = 0; for (n = ckt->CKTnodes; n; n = n->next) { NumNodes++; }` (line 389-392) | MISSING_OURS |
| 129 | `OldRhsOld = TMALLOC(double, NumNodes + 1);` (line 394) | `const savedVoltages = new Float64Array(matrixSize);` (line 958) | DIFF |
| 130 | `OldCKTstate0 = TMALLOC(double, ckt->CKTnumStates + 1);` (line 395-396) | `const savedState0 = statePool ? new Float64Array(statePool.state0.length) : new Float64Array(0);` (line 959) | DIFF |
| 131 | `for (n = ckt->CKTnodes; n; n = n->next) ckt->CKTrhsOld[n->number] = 0;` (line 398-399) | `const voltages = new Float64Array(matrixSize); zeroState(voltages, statePool);` (line 951-952) | DIFF |
| 132 | `for (i = 0; i < ckt->CKTnumStates; i++) ckt->CKTstate0[i] = 0;` (line 401-402) | `zeroState(voltages, statePool);` (line 952) | DIFF |
| 133 | `fprintf(stderr, "Supplies reduced to %8.4f%% ", ckt->CKTsrcFact * 100);` (line 406) | MISSING_OURS |
| 134 | `ni_set_phase_flags(NI_PHASE_SRC_STEP, 0.0, ckt->CKTsrcFact);` (line 407) | `onPhaseBegin?.("dcopSrcSweep", 0);` (line 964) | DIFF |
| 135 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 408) | `const zeroResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages });` (line 965-970) | DIFF |
| 136 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 409) | MISSING_OURS |
| 137 | `if (converged != 0) {` (line 413) | `if (!zeroResult.converged) {` (line 974) | MATCH |
| 138 | `fprintf(stderr, "\n");` (line 414) | MISSING_OURS |
| 139 | `if (ckt->CKTgshunt <= 0) { ckt->CKTdiagGmin = ckt->CKTgmin; } else { ckt->CKTdiagGmin = ckt->CKTgshunt; }` (line 415-419) | `let diagGmin = params.gmin * 1e10;` (line 978) | DIFF |
| 140 | `for (i = 0; i < 10; i++) ckt->CKTdiagGmin *= 10;` (line 421-422) | `let diagGmin = params.gmin * 1e10;` (line 978) | DIFF |
| 141 | `for (i = 0; i <= 10; i++) {` (line 424) | `for (let decade = 0; decade <= 10; decade++) {` (line 980) | MATCH |
| 142 | `fprintf(stderr, "Trying gmin = %12.4E ", ckt->CKTdiagGmin);` (line 425) | MISSING_OURS |
| 143 | `ckt->CKTnoncon = 1;` (line 426) | MISSING_OURS |
| 144 | `ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 430) | MISSING_OURS |
| 145 | `ni_set_phase_flags(NI_PHASE_SRC_STEP | NI_PHASE_GMIN_SP3, ckt->CKTdiagGmin, ckt->CKTsrcFact);` (line 435-436) | `onPhaseBegin?.("dcopSrcSweep", 0);` (line 981) | DIFF |
| 146 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 437) | `const bResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages, diagonalGmin: diagGmin });` (line 982-988) | DIFF |
| 147 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 438) | MISSING_OURS |
| 148 | `if (converged != 0) { ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 440-441) | `if (!bResult.converged) {` (line 991) | DIFF |
| 149 | `SPfrontEnd->IFerrorf(ERR_WARNING, "gmin step failed");` (line 442-443) | MISSING_OURS |
| 150 | `ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 446) | MISSING_OURS |
| 151 | `break; }` (line 449) | `break;` (line 993) | MATCH |
| 152 | `ckt->CKTdiagGmin /= 10;` (line 452) | `diagGmin /= 10;` (line 999) | MATCH |
| 153 | `ckt->CKTmode = continuemode;` (line 453) | `statePool.initMode = "initFloat";` (line 997) | DIFF |
| 154 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful gmin step");` (line 454-455) | MISSING_OURS |
| 155 | `ckt->CKTdiagGmin = ckt->CKTgshunt;` (line 457) | No explicit gshunt reset after bootstrap loop | DIFF |
| 156 | MISSING_NGSPICE | `if (!bootstrapConverged) { scaleAllSources(elements, 1); return { converged: false, ... }; }` (line 1004-1007) | MISSING_NGSPICE |
| 157 | zero-source converged path (line 462-476) | `} else { onPhaseEnd?.("dcopSubSolveConverged", true); statePool.initMode = "initFloat"; }` (line 1008-1013) | DIFF |
| 158 | `i = 0; for (n = ckt->CKTnodes; n; n = n->next) { OldRhsOld[i] = ckt->CKTrhsOld[n->number]; i++; }` (line 463-467) | `saveSnapshot` not called here; voltages already set | DIFF |
| 159 | `for (i = 0; i < ckt->CKTnumStates; i++) OldCKTstate0[i] = ckt->CKTstate0[i];` (line 469-470) | MISSING_OURS |
| 160 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful source step");` (line 473-474) | MISSING_OURS |
| 161 | `ckt->CKTsrcFact = ConvFact + raise;` (line 475) | `let srcFact = raise;` (line 1019) | DIFF |
| 162 | `if (converged == 0) do {` (line 479-480) | `while (raise >= 1e-7 && convFact < 1) {` (line 1025) | DIFF |
| 163 | `fprintf(stderr, "Supplies reduced to %8.4f%% ", ckt->CKTsrcFact * 100);` (line 481-482) | MISSING_OURS |
| 164 | `iters = ckt->CKTstat->STATnumIter;` (line 484) | MISSING_OURS |
| 165 | `ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 488) | MISSING_OURS |
| 166 | `ni_set_phase_flags(NI_PHASE_SRC_STEP, 0.0, ckt->CKTsrcFact);` (line 491) | `onPhaseBegin?.("dcopSrcSweep", srcFact);` (line 1028) | DIFF |
| 167 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 492) | `const stepResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages });` (line 1029-1034) | DIFF |
| 168 | `ni_set_phase_flags(0, 0.0, 1.0);` (line 493) | MISSING_OURS |
| 169 | `iters = (ckt->CKTstat->STATnumIter) - iters;` (line 495) | `stepResult.iterations` returned directly | DIFF |
| 170 | `ckt->CKTmode = continuemode;` (line 497) | `statePool.initMode = "initFloat";` (line 1040) | DIFF |
| 171 | `if (converged == 0) {` (line 499) | `if (stepResult.converged) {` (line 1037) | MATCH |
| 172 | `ConvFact = ckt->CKTsrcFact;` (line 500) | `convFact = srcFact;` (line 1045) | MATCH |
| 173 | `i = 0; for (n = ckt->CKTnodes; n; n = n->next) { OldRhsOld[i] = ckt->CKTrhsOld[n->number]; i++; }` (line 502-506) | `voltages.set(stepResult.voltages); saveSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 1043-1044) | DIFF |
| 174 | `for (i = 0; i < ckt->CKTnumStates; i++) OldCKTstate0[i] = ckt->CKTstate0[i];` (line 508-509) | `saveSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 1044) | DIFF |
| 175 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful source step");` (line 511-512) | MISSING_OURS |
| 176 | `ckt->CKTsrcFact = ConvFact + raise;` (line 514) | `srcFact = convFact + raise;` (line 1048) | MATCH |
| 177 | `if (iters <= (ckt->CKTdcTrcvMaxIter / 4)) { raise = raise * 1.5; }` (line 516-518) | `if (stepResult.iterations <= srcIterLo) { raise *= 1.5; }` (line 1051-1054) | MATCH |
| 178 | `if (iters > (3 * ckt->CKTdcTrcvMaxIter / 4)) { raise = raise * 0.5; }` (line 520-522) | `} else if (stepResult.iterations > srcIterHi) { raise *= 0.5; }` (line 1055-1058) | MATCH |
| 179 | `/* if (raise>0.01) raise=0.01; */` (line 524) | MISSING_OURS |
| 180 | `} else {` (line 526) | `} else {` (line 1061) | MATCH |
| 181 | `if ((ckt->CKTsrcFact - ConvFact) < 1e-8) break;` (line 528-529) | `if ((srcFact - convFact) < 1e-8) { break; }` (line 1065-1067) | MATCH |
| 182 | `raise = raise / 10;` (line 531) | `raise /= 10;` (line 1069) | MATCH |
| 183 | `if (raise > 0.01) raise = 0.01;` (line 533-534) | `if (raise > 0.01) { raise = 0.01; }` (line 1070-1072) | MATCH |
| 184 | `ckt->CKTsrcFact = ConvFact;` (line 536) | No explicit `srcFact = convFact` here; done via `srcFact = convFact + raise` (line 1076) | DIFF |
| 185 | `i = 0; for (n = ckt->CKTnodes; n; n = n->next) { ckt->CKTrhsOld[n->number] = OldRhsOld[i]; i++; }` (line 538-542) | `restoreSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 1074) | DIFF |
| 186 | `for (i = 0; i < ckt->CKTnumStates; i++) ckt->CKTstate0[i] = OldCKTstate0[i];` (line 544-545) | `restoreSnapshot(voltages, savedVoltages, statePool, savedState0);` (line 1074) | DIFF |
| 187 | `if ((ckt->CKTsrcFact) > 1) ckt->CKTsrcFact = 1;` (line 549-550) | `if (srcFact > 1) { srcFact = 1; }` (line 1081-1082) | MATCH |
| 188 | `} while ((raise >= 1e-7) && (ConvFact < 1));` (line 552) | `while (raise >= 1e-7 && convFact < 1) {` (line 1025) | MATCH |
| 189 | `FREE(OldRhsOld);` (line 554) | MISSING_OURS |
| 190 | `FREE(OldCKTstate0);` (line 555) | MISSING_OURS |
| 191 | `ckt->CKTsrcFact = 1;` (line 556) | `scaleAllSources(elements, 1);` (line 1086) | DIFF |
| 192 | `if (ConvFact != 1) {` (line 558) | `if (convFact >= 1) {` (line 1089) | DIFF |
| 193 | `ckt->CKTsrcFact = 1;` (line 559) | `scaleAllSources(elements, 1);` already called (line 1086) | DIFF |
| 194 | `ckt->CKTcurrentAnalysis = DOING_TRAN;` (line 560) | MISSING_OURS |
| 195 | `SPfrontEnd->IFerrorf(ERR_WARNING, "source stepping failed");` (line 561-562) | MISSING_OURS |
| 196 | `return (E_ITERLIM);` (line 563) | `return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };` (line 1093) | DIFF |
| 197 | `SPfrontEnd->IFerrorf(ERR_INFO, "Source stepping completed");` (line 565-566) | MISSING_OURS |
| 198 | `return (0);` (line 567) | `return { converged: true, iterations: totalIter, voltages };` (line 1090) | DIFF |

## 7. spice3_src (cktop.c:582-628)

| # | ngspice spice3_src (C) | dc-operating-point.ts spice3Src (TS) | Status |
|---|------------------------|--------------------------------------|--------|
| 199 | `int converged, i;` (line 587) | `let totalIter = 0;` (line 884) | DIFF |
| 200 | `NG_IGNORE(iterlim);` (line 589) | MISSING_OURS |
| 201 | `ckt->CKTmode = firstmode;` (line 591) | `statePool.initMode = "initJct";` (line 883) | DIFF |
| 202 | `SPfrontEnd->IFerrorf(ERR_INFO, "Starting source stepping");` (line 592-593) | MISSING_OURS |
| 203 | `for (i = 0; i <= ckt->CKTnumSrcSteps; i++) {` (line 595) | `for (let i = 0; i <= numSrcSteps; i++) {` (line 888) | MATCH |
| 204 | `ckt->CKTsrcFact = ((double) i) / ((double) ckt->CKTnumSrcSteps);` (line 596) | `const srcFact = i / numSrcSteps; scaleAllSources(elements, srcFact);` (line 889-890) | DIFF |
| 205 | `ckt->enh->conv_debug.last_NIiter_call = MIF_TRUE;` (line 599) | MISSING_OURS |
| 206 | `converged = NIiter(ckt, ckt->CKTdcTrcvMaxIter);` (line 602) | `const result = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages });` (line 892-897) | DIFF |
| 207 | `ckt->CKTmode = continuemode;` (line 603) | `statePool.initMode = "initFloat";` (line 906) | DIFF |
| 208 | `if (converged != 0) {` (line 604) | `if (!result.converged) {` (line 899) | MATCH |
| 209 | `ckt->CKTsrcFact = 1;` (line 605) | `scaleAllSources(elements, 1);` (line 901) | DIFF |
| 210 | `ckt->CKTcurrentAnalysis = DOING_TRAN;` (line 606) | MISSING_OURS |
| 211 | `SPfrontEnd->IFerrorf(ERR_WARNING, "source stepping failed");` (line 607-608) | MISSING_OURS |
| 212 | `ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 611) | MISSING_OURS |
| 213 | `return (converged);` (line 614) | `return { converged: false, iterations: totalIter, voltages: new Float64Array(matrixSize) };` (line 902) | DIFF |
| 214 | `SPfrontEnd->IFerrorf(ERR_INFO, "One successful source step");` (line 616-617) | MISSING_OURS |
| 215 | `SPfrontEnd->IFerrorf(ERR_INFO, "Source stepping completed");` (line 619-620) | MISSING_OURS |
| 216 | `ckt->CKTsrcFact = 1;` (line 621) | `scaleAllSources(elements, 1);` (line 911) | DIFF |
| 217 | `ckt->enh->conv_debug.last_NIiter_call = MIF_FALSE;` (line 624) | MISSING_OURS |
| 218 | `return (0);` (line 627) | No direct return after loop; falls through to final clean solve (line 914-927) | DIFF |
| 219 | MISSING_NGSPICE | `onPhaseBegin?.("dcopSrcSweep", 1); const cleanResult = newtonRaphson({ ...nrBase, maxIterations: params.dcTrcvMaxIter, elements, initialGuess: voltages, diagonalGmin: params.gshunt ?? 0 });` (line 914-921) | MISSING_NGSPICE |
| 220 | MISSING_NGSPICE | `onPhaseEnd?.(cleanResult.converged ? "accepted" : "finalFailure", cleanResult.converged);` (line 923) | MISSING_NGSPICE |

## 8. cktncDump / CKTncDump (dcop.c:88 vs dc-operating-point.ts:359-379)

| # | ngspice DCop (C) | dc-operating-point.ts cktncDump (TS) | Status |
|---|------------------|--------------------------------------|--------|
| 221 | `CKTncDump(ckt);` (line 88) | `const ncNodes = cktncDump(srcResult.voltages, directResult.voltages, params.reltol, params.voltTol, params.abstol, nodeCount, matrixSize);` (line 581-589) | DIFF |
| 222 | MISSING_NGSPICE | `for (let i = 0; i < matrixSize; i++) { const delta = Math.abs(voltages[i] - prevVoltages[i]); ... }` (line 369-378) | DIFF |

## 9. Helpers (dc-operating-point.ts only)

| # | ngspice CKTop (C) | dc-operating-point.ts (TS) | Status |
|---|-------------------|----------------------------|--------|
| 223 | MISSING_NGSPICE | `function scaleAllSources(elements, factor)` (line 131-137) | MISSING_NGSPICE |
| 224 | MISSING_NGSPICE | `function zeroState(voltages, statePool)` (line 146-154) | MISSING_NGSPICE |
| 225 | MISSING_NGSPICE | `function saveSnapshot(voltages, saved, statePool, savedState)` (line 165-175) | MISSING_NGSPICE |
| 226 | MISSING_NGSPICE | `function restoreSnapshot(voltages, saved, statePool, savedState)` (line 186-196) | MISSING_NGSPICE |
| 227 | MISSING_NGSPICE | `export type DcOpNRPhase = ...` (line 35-42) | MISSING_NGSPICE |
| 228 | MISSING_NGSPICE | `export type DcOpNRAttemptOutcome = ...` (line 44-49) | MISSING_NGSPICE |
| 229 | MISSING_NGSPICE | `export interface DcOpOptions { ... }` (line 58-117) | MISSING_NGSPICE |
| 230 | MISSING_NGSPICE | `interface CKTopCallOptions { ... }` (line 209-247) | MISSING_NGSPICE |
| 231 | MISSING_NGSPICE | `interface StepResult { ... }` (line 620-624) | MISSING_NGSPICE |
| 232 | MISSING_NGSPICE | `interface NrBase { ... }` (line 627-636) | MISSING_NGSPICE |
| 233 | MISSING_NGSPICE | `const nrBase = { solver, matrixSize, nodeCount, reltol: params.reltol, abstol: params.voltTol, iabstol: params.abstol, isDcOp: true, ... };` (line 398-415) | MISSING_NGSPICE |
| 234 | MISSING_NGSPICE | `const hasNonlinear = elements.some(el => el.isNonlinear);` (line 441) | MISSING_NGSPICE |
| 235 | MISSING_NGSPICE | `onPhaseBegin?.("dcopInitJct");` (line 445) | MISSING_NGSPICE |
| 236 | MISSING_NGSPICE | `const ladder = { runPrimeJunctions() { ... }, pool: ..., onModeBegin(...) { ... }, onModeEnd(...) { ... } };` (line 449-468) | MISSING_NGSPICE |
| 237 | MISSING_NGSPICE | `let totalIterations = directResult.iterations;` (line 502) | MISSING_NGSPICE |
| 238 | MISSING_NGSPICE | `diagnostics.emit(makeDiagnostic("dc-op-converged", ...));` (line 485-492) | MISSING_NGSPICE |
| 239 | MISSING_NGSPICE | `diagnostics.emit(makeDiagnostic("dc-op-gmin", ...));` (line 523-530) | MISSING_NGSPICE |
| 240 | MISSING_NGSPICE | `diagnostics.emit(makeDiagnostic("dc-op-source-step", ...));` (line 559-566) | MISSING_NGSPICE |
| 241 | MISSING_NGSPICE | `diagnostics.emit(makeDiagnostic("dc-op-failed", ...));` (line 593-605) | MISSING_NGSPICE |

## 10. CKTconvTest (cktop.c:96-118)

| # | ngspice CKTconvTest (C) | dc-operating-point.ts (TS) | Status |
|---|-------------------------|----------------------------|--------|
| 242 | `int CKTconvTest(CKTcircuit * ckt)` (line 97) | MISSING_OURS |
| 243 | `for (i = 0; i < DEVmaxnum; i++) { if (DEVices[i] && DEVices[i]->DEVconvTest && ckt->CKThead[i]) { error = DEVices[i]->DEVconvTest(ckt->CKThead[i], ckt); } ... }` (line 102-115) | MISSING_OURS |
| 244 | `return (OK);` (line 117) | MISSING_OURS |

---

## Summary Statistics

| Status | Count |
|--------|-------|
| MATCH | 38 |
| DIFF | 131 |
| MISSING_OURS | 62 |
| MISSING_NGSPICE | 20 |
| **Total** | **251** |

### MATCH Breakdown
Lines where the logic, operation, and operands are identical between ngspice C and our TS:
- Factor/gmin arithmetic (factor adaptation, gmin division, gtarget comparison)
- Loop termination conditions (factor < 1.00005, raise >= 1e-7, srcFact > 1 clamp)
- Source stepping raise adaptation (1.5x / 0.5x thresholds)
- Save/restore trigger points and backtrack sqrt(sqrt) factor reduction

### DIFF Breakdown
Most DIFFs fall into these categories:
1. **Return value shape**: ngspice returns `int` (0/1/E_ITERLIM); ours returns `{ converged, iterations, voltages }` struct
2. **Mode flags vs enum strings**: ngspice uses bitmask `MODEINITJCT|MODEDCOP`; ours uses string `"initJct"`
3. **Source scaling mechanism**: ngspice sets `CKTsrcFact` (read by CKTload); ours calls `scaleAllSources()` on elements directly
4. **NIiter vs newtonRaphson**: ngspice calls `NIiter(ckt, maxIter)` mutating global state; ours calls `newtonRaphson({...})` with explicit params
5. **Iteration counting**: ngspice computes `iters = STATnumIter_after - STATnumIter_before`; ours reads `result.iterations`
6. **Save/restore**: ngspice uses indexed node-linked-list copy loops; ours uses `Float64Array.set()` via helper functions
7. **gshunt handling**: ngspice sets `CKTdiagGmin = CKTgshunt` then calls NIiter; ours passes `diagonalGmin: params.gshunt ?? 0` as NR option
8. **Clean solve maxIter**: ngspice dynamic_gmin uses `iterlim` (dcMaxIter=100); ours uses `params.dcTrcvMaxIter` (50)

### MISSING_OURS Breakdown
- `fprintf`/`IFerrorf` diagnostic messages (not critical, informational only)
- XSPICE `conv_debug.last_NIiter_call` flags
- `SetAnalyse` progress reporting
- `CKTnoncon = 1` manual reset before NIiter (done inside our NR)
- `ni_set_phase_flags` clear calls (our phase tracking uses different mechanism)
- `FREE()` memory deallocation (JS garbage collected)
- `CKTcurrentAnalysis = DOING_TRAN` analysis mode tracking
- `NumNodes` counting loop (we use `matrixSize` directly)
- `CKTconvTest` device-level convergence test function

### MISSING_NGSPICE Breakdown
- Type definitions, interfaces, options structs (TS language requirement)
- Diagnostic emission (`makeDiagnostic` calls)
- `scaleAllSources` helper (ngspice uses `CKTsrcFact` global read by CKTload)
- `zeroState`, `saveSnapshot`, `restoreSnapshot` helpers (ngspice does inline)
- `pool.initMode = "transient"` reset after finalization
- Mode ladder / `dcopModeLadder` harness integration
- `onPhaseBegin`/`onPhaseEnd` callbacks
- spice3Src final clean solve with gshunt (ngspice spice3_src has no final clean solve)
