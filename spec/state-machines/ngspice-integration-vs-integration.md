# ngspice Integration vs our integration.ts + ni-pred.ts — Line-by-Line Mapping

Scope:
- Section 1: NIcomCof (ref/ngspice/src/maths/ni/nicomcof.c:17-127) vs integration.ts computeNIcomCof + solveGearVandermonde + computeIntegrationCoefficients
- Section 2: NIintegrate (ref/ngspice/src/maths/ni/niinteg.c:17-80) vs integration.ts integrateCapacitor + integrateInductor
- Section 3a: nicomcof.c `#ifdef PREDICTOR` block (nicomcof.c:129-207) vs ni-pred.ts computeAgp + _computeAgpGear
- Section 3b: NIpred (ref/ngspice/src/maths/ni/nipred.c:21-148) vs ni-pred.ts predictVoltages + _predictVoltagesGear
- Section 4: LTE factor tables (ngspice trdefs.h / geardefs.h) vs ckt-terr.ts (note: LTE tables live outside integration.ts/ni-pred.ts scope but listed per task)

Status legend: MATCH (identical logic / expression / operand order / indexing / bounds / control flow). DIFF (any deviation — renamed variable, extra guard, inverted bound, different operand grouping, different RHS construction, fused loops, different dispatch order, defensive fallback, extracted helper, different index base).

Sources of truth:
- Our files: `src/solver/analog/integration.ts` (501 lines), `src/solver/analog/ni-pred.ts` (279 lines). LTE table in `src/solver/analog/ckt-terr.ts` (lines 37-47).
- ngspice files: `ref/ngspice/src/maths/ni/nicomcof.c` (209 lines), `ref/ngspice/src/maths/ni/niinteg.c` (80 lines), `ref/ngspice/src/maths/ni/nipred.c` (153 lines).

When a single ngspice C line corresponds to multiple TS lines (or vice versa), each TS line gets its own row mapped back to the shared C line.

## 1. NIcomCof (nicomcof.c:17-209) vs computeNIcomCof + solveGearVandermonde + computeIntegrationCoefficients

| # | ngspice NIcomCof (C) | our TS | Status |
|---|-------------------|--------|--------|
| 1 | `int NIcomCof(CKTcircuit *ckt)` (nicomcof.c:17-18) | `export function computeNIcomCof(dt, deltaOld, order, method, ag): void` (integration.ts:419-425) | DIFF — void return vs int; params unpacked explicitly instead of walking ckt |
| 2 | `double mat[8][8];` (nicomcof.c:21) | `const mat: number[][] = []; for (let i = 0; i < n; i++) mat.push(new Array<number>(n).fill(0));` (integration.ts:351-355) | DIFF — per-call alloc of size (order+1)x(order+1) vs fixed 8x8 stack |
| 3 | `int i,j,k;` (nicomcof.c:22) | loop indices declared with `let` per-loop (integration.ts:353,358,363,364,368,371,378,379,386,393,394,406,407) | DIFF — scoping |
| 4 | `double arg;` (nicomcof.c:23) | `let arg = 0;` (integration.ts:367) | DIFF — initialised at declaration |
| 5 | `double arg1;` (nicomcof.c:24) | `let arg1 = 1;` (integration.ts:370), declared inside inner loop | DIFF — scope and initialisation timing differ |
| 6 | comment `/* timestep-dependent terms */` (nicomcof.c:26-28) | doc comment above computeNIcomCof (integration.ts:306-316) | MATCH (comment) |
| 7 | comment `/* compute coefficients for particular integration method */` (nicomcof.c:30-32) | absent | DIFF |
| 8 | `switch(ckt->CKTintegrateMethod) {` (nicomcof.c:33) | `if (method === 'trapezoidal') ... else if (method === 'bdf2') ... else if (method === 'gear') ... else {...}` (integration.ts:428-458) | DIFF — 4-branch if-ladder vs 3-case switch; adds explicit bdf1/bdf2 branches |
| 9 | (no pre-switch dt guard in ngspice) | `if (dt <= 0) { ag.fill(0); return; }` (integration.ts:426) | DIFF — defensive guard |
| 10 | `case TRAPEZOIDAL:` (nicomcof.c:35) | `if (method === 'trapezoidal')` (integration.ts:428) | MATCH |
| 11 | `switch(ckt->CKTorder) {` (nicomcof.c:36) | `if (order === 1) {...} else {...}` (integration.ts:429-436) | DIFF — if/else vs switch; no E_ORDER default |
| 12 | `case 1:` (nicomcof.c:38) | `if (order === 1)` (integration.ts:429) | MATCH |
| 13 | `ckt->CKTag[0] = 1/ckt->CKTdelta;` (nicomcof.c:39) | `ag[0] = 1 / dt;` (integration.ts:430) | MATCH |
| 14 | `ckt->CKTag[1] = -1/ckt->CKTdelta;` (nicomcof.c:40) | `ag[1] = -1 / dt;` (integration.ts:431) | MATCH |
| 15 | `break;` (nicomcof.c:41) | implicit end of `if (order === 1)` (integration.ts:432) | MATCH |
| 16 | `case 2:` (nicomcof.c:43) | `else {` (integration.ts:432) | DIFF — ngspice matches order==2; ours matches any non-1 order including >=3 |
| 17 | file-level `#define xmu 0.5` (nicomcof.c:14) | `const xmu = 0.5;` (integration.ts:433) | DIFF — function-local const vs file-wide macro |
| 18 | `ckt->CKTag[0] = 1.0 / ckt->CKTdelta / (1.0 - xmu);` (nicomcof.c:44) | `ag[0] = 1 / (dt * (1 - xmu));` (integration.ts:434) | DIFF — operand grouping `1/dt/(1-xmu)` vs `1/(dt*(1-xmu))`; different FP rounding path |
| 19 | `ckt->CKTag[1] = xmu / (1.0 - xmu);` (nicomcof.c:45) | `ag[1] = xmu / (1 - xmu);` (integration.ts:435) | MATCH |
| 20 | `break;` (nicomcof.c:46) | implicit (integration.ts:436) | MATCH |
| 21 | `default: return(E_ORDER);` (nicomcof.c:48-49) | absent — order>=3 silently accepted into xmu branch | DIFF — missing E_ORDER path |
| 22 | `break;` end TRAPEZOIDAL (nicomcof.c:51) | implicit end of `if (method==='trapezoidal')` (integration.ts:436) | MATCH |
| 23 | `case GEAR:` (nicomcof.c:53) | `else if (method === 'gear')` (integration.ts:452) | MATCH |
| 24 | `switch(ckt->CKTorder) {` (nicomcof.c:54) | `solveGearVandermonde(dt, deltaOld, order, ag);` delegate (integration.ts:453) | DIFF — ours extracts to helper; ngspice inlines |
| 25 | `case 1:` (nicomcof.c:56) | no case-1 short-circuit; order 1 runs full Vandermonde (integration.ts:343-417) | DIFF — ngspice falls through into case 2..6 block |
| 26 | commented-out `/* ckt->CKTag[0] = 1/ckt->CKTdelta; */` (nicomcof.c:57) | absent | DIFF |
| 27 | commented-out `/* ckt->CKTag[1] = -1/ckt->CKTdelta; */` (nicomcof.c:58) | absent | DIFF |
| 28 | commented-out `/* break; */` (nicomcof.c:59) | absent | DIFF |
| 29 | `case 2:` (nicomcof.c:61) | solveGearVandermonde handles order 2 generically (integration.ts:343) | DIFF — ngspice explicit case; ours generic |
| 30 | `case 3:` (nicomcof.c:62) | solveGearVandermonde handles order 3 generically | DIFF |
| 31 | `case 4:` (nicomcof.c:63) | solveGearVandermonde handles order 4 generically | DIFF |
| 32 | `case 5:` (nicomcof.c:64) | solveGearVandermonde handles order 5 generically | DIFF |
| 33 | `case 6:` (nicomcof.c:65) | solveGearVandermonde handles order 6 generically | DIFF |
| 34 | `bzero(ckt->CKTag,7*sizeof(double));` (nicomcof.c:66) | `for (let i = 0; i <= order; i++) ag[i] = 0;` (integration.ts:358) | DIFF — ngspice zeroes exactly 7 slots; ours zeroes order+1 |
| 35 | `ckt->CKTag[1] = -1/ckt->CKTdelta;` (nicomcof.c:67) | `ag[1] = -1 / dt;` (integration.ts:359) | MATCH |
| 36 | `/* first, set up the matrix */` (nicomcof.c:68) | `// Set up matrix columns. ngspice nicomcof.c:70-86.` (integration.ts:361) | MATCH (comment) |
| 37 | `arg=0;` (nicomcof.c:69) | `let arg = 0;` (integration.ts:367) | MATCH |
| 38 | `for(i=0;i<=ckt->CKTorder;i++) { mat[0][i]=1; }` (nicomcof.c:70) | `for (let i = 0; i <= order; i++) mat[0][i] = 1;` (integration.ts:363) | MATCH |
| 39 | `for(i=1;i<=ckt->CKTorder;i++) { mat[i][0]=0; }` (nicomcof.c:71) | `for (let i = 1; i <= order; i++) mat[i][0] = 0;` (integration.ts:364) | MATCH |
| 40 | SPICE2 difference comment block (nicomcof.c:72-78) | `// Columns 1..order: arg accumulates deltaOld[i-1], mat[j][i] = (arg/dt)^j.` (integration.ts:366) | DIFF — comment condensed; rationale dropped |
| 41 | `for(i=1;i<=ckt->CKTorder;i++) {` (nicomcof.c:79) | `for (let i = 1; i <= order; i++) {` (integration.ts:368) | MATCH |
| 42 | `arg += ckt->CKTdeltaOld[i-1];` (nicomcof.c:80) | `arg += deltaOld[i - 1] > 0 ? deltaOld[i - 1] : dt;` (integration.ts:369) | DIFF — ours replaces <=0 with dt via ternary; ngspice adds raw |
| 43 | `arg1 = 1;` (nicomcof.c:81) | `let arg1 = 1;` (integration.ts:370) | MATCH |
| 44 | `for(j=1;j<=ckt->CKTorder;j++) {` (nicomcof.c:82) | `for (let j = 1; j <= order; j++) {` (integration.ts:371) | MATCH |
| 45 | `arg1 *= arg/ckt->CKTdelta;` (nicomcof.c:83) | `arg1 *= arg / dt;` (integration.ts:372) | MATCH |
| 46 | `mat[j][i]=arg1;` (nicomcof.c:84) | `mat[j][i] = arg1;` (integration.ts:373) | MATCH |
| 47 | `}` (nicomcof.c:85) | `}` (integration.ts:374) | MATCH |
| 48 | `}` (nicomcof.c:86) | `}` (integration.ts:375) | MATCH |
| 49 | `/* lu decompose */` + weirdness comment (nicomcof.c:87-94) | `// LU decomposition, starting at i=1 (column 0 is trivial). nicomcof.c:95-102.` (integration.ts:377) | MATCH (comment) |
| 50 | `for(i=1;i<=ckt->CKTorder;i++) {` (nicomcof.c:95) | `for (let i = 1; i <= order; i++) {` (integration.ts:378) | MATCH |
| 51 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:96) | `for (let j = i + 1; j <= order; j++) {` (integration.ts:379) | MATCH |
| 52 | (no pivot guard) | `if (Math.abs(mat[i][i]) < 1e-300) {` (integration.ts:380) | DIFF — defensive guard absent in ngspice |
| 53 | (no fallback body) | `ag[0] = 1 / dt; ag[1] = -1 / dt;` (integration.ts:381) | DIFF — BDF-1 fallback |
| 54 | (no fallback body) | `for (let k = 2; k <= order; k++) ag[k] = 0;` (integration.ts:382) | DIFF |
| 55 | (no fallback body) | `return;` (integration.ts:383) | DIFF |
| 56 | (no fallback body) | `}` close guard (integration.ts:384) | DIFF |
| 57 | `mat[j][i] /= mat[i][i];` (nicomcof.c:97) | `mat[j][i] /= mat[i][i];` (integration.ts:385) | MATCH |
| 58 | `for(k=i+1;k<=ckt->CKTorder;k++) {` (nicomcof.c:98) | `for (let k = i + 1; k <= order; k++) {` (integration.ts:386) | MATCH |
| 59 | `mat[j][k] -= mat[j][i]*mat[i][k];` (nicomcof.c:99) | `mat[j][k] -= mat[j][i] * mat[i][k];` (integration.ts:387) | MATCH |
| 60 | `}` end k (nicomcof.c:100) | `}` (integration.ts:388) | MATCH |
| 61 | `}` end j (nicomcof.c:101) | `}` (integration.ts:389) | MATCH |
| 62 | `}` end i (nicomcof.c:102) | `}` (integration.ts:390) | MATCH |
| 63 | `/* forward substitution */` (nicomcof.c:103) | `// Forward substitution. nicomcof.c:104-108.` (integration.ts:392) | MATCH (comment) |
| 64 | `for(i=1;i<=ckt->CKTorder;i++) {` (nicomcof.c:104) | `for (let i = 1; i <= order; i++) {` (integration.ts:393) | MATCH |
| 65 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:105) | `for (let j = i + 1; j <= order; j++) {` (integration.ts:394) | MATCH |
| 66 | `ckt->CKTag[j]=ckt->CKTag[j]-mat[j][i]*ckt->CKTag[i];` (nicomcof.c:106) | `ag[j] = ag[j] - mat[j][i] * ag[i];` (integration.ts:395) | MATCH |
| 67 | `}` (nicomcof.c:107) | `}` (integration.ts:396) | MATCH |
| 68 | `}` (nicomcof.c:108) | `}` (integration.ts:397) | MATCH |
| 69 | `/* backward substitution */` (nicomcof.c:109) | `// Backward substitution. nicomcof.c:110-116.` (integration.ts:399) | MATCH (comment) |
| 70 | (no last-pivot guard) | `if (Math.abs(mat[order][order]) < 1e-300) {` (integration.ts:400) | DIFF — defensive guard |
| 71 | (no fallback) | `ag[0] = 1 / dt; ag[1] = -1 / dt;` (integration.ts:401) | DIFF |
| 72 | (no fallback) | `for (let k = 2; k <= order; k++) ag[k] = 0;` (integration.ts:402) | DIFF |
| 73 | (no fallback) | `return;` (integration.ts:403) | DIFF |
| 74 | (no fallback) | `}` (integration.ts:404) | DIFF |
| 75 | `ckt->CKTag[ckt->CKTorder] /= mat[ckt->CKTorder][ckt->CKTorder];` (nicomcof.c:110) | `ag[order] /= mat[order][order];` (integration.ts:405) | MATCH |
| 76 | `for(i=ckt->CKTorder-1;i>=0;i--) {` (nicomcof.c:111) | `for (let i = order - 1; i >= 0; i--) {` (integration.ts:406) | MATCH |
| 77 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:112) | `for (let j = i + 1; j <= order; j++) {` (integration.ts:407) | MATCH |
| 78 | `ckt->CKTag[i]=ckt->CKTag[i]-mat[i][j]*ckt->CKTag[j];` (nicomcof.c:113) | `ag[i] = ag[i] - mat[i][j] * ag[j];` (integration.ts:408) | MATCH |
| 79 | `}` end j (nicomcof.c:114) | `}` (integration.ts:409) | MATCH |
| 80 | (no per-row pivot guard) | `if (Math.abs(mat[i][i]) < 1e-300) {` (integration.ts:410) | DIFF — guard absent in ngspice |
| 81 | (no fallback) | `ag[0] = 1 / dt; ag[1] = -1 / dt;` (integration.ts:411) | DIFF |
| 82 | (no fallback) | `for (let k = 2; k <= order; k++) ag[k] = 0;` (integration.ts:412) | DIFF |
| 83 | (no fallback) | `return;` (integration.ts:413) | DIFF |
| 84 | (no fallback) | `}` (integration.ts:414) | DIFF |
| 85 | `ckt->CKTag[i] /= mat[i][i];` (nicomcof.c:115) | `ag[i] /= mat[i][i];` (integration.ts:415) | MATCH |
| 86 | `}` end i (nicomcof.c:116) | `}` (integration.ts:416) | MATCH |
| 87 | `break;` end GEAR case 2..6 (nicomcof.c:117) | end of solveGearVandermonde (integration.ts:417) | MATCH |
| 88 | `default: return(E_ORDER);` (nicomcof.c:120-121) | absent — any order accepted | DIFF |
| 89 | `break;` end GEAR case (nicomcof.c:123) | implicit — else-if chain exit (integration.ts:454) | MATCH |
| 90 | `default: return(E_METHOD);` (nicomcof.c:125-126) | `else { ag[0]=1/dt; ag[1]=-1/dt; }` (integration.ts:454-458) | DIFF — ngspice errors; ours silently treats unknown as BDF-1 |
| 91 | n/a — ngspice has no 'bdf2' method; order==2 always routes through GEAR Vandermonde (nicomcof.c:79-116) | `} else if (method === 'bdf2') {` (integration.ts:437) | DIFF — added method branch with no ngspice equivalent |
| 92 | n/a | `const h1 = deltaOld[1] > 0 ? deltaOld[1] : dt;` (integration.ts:438) | DIFF — defensive substitute |
| 93 | ngspice implicit: first Vandermonde column slot mat[1][1] = deltaOld[0]/delta | `const r1 = 1;` (integration.ts:439) | DIFF — hard-coded on assumption deltaOld[0]==dt |
| 94 | ngspice: `arg += deltaOld[1]; mat[1][2] = arg/delta` where arg=deltaOld[0]+deltaOld[1] | `const r2 = (dt + h1) / dt;` (integration.ts:440) | DIFF — ngspice uses raw deltaOld[0]; ours uses dt |
| 95 | ngspice: det emerges from full LU on row 2 | `const u22 = r2 * (r2 - r1);` (integration.ts:441) | DIFF — closed-form 2x2 det instead of LU |
| 96 | (no near-singular guard) | `if (Math.abs(u22) < 1e-30) {` (integration.ts:442) | DIFF — guard |
| 97 | (no fallback) | `ag[0] = 1 / dt;` (integration.ts:443) | DIFF — BDF-1 fallback |
| 98 | (no fallback) | `ag[1] = -1 / dt;` (integration.ts:444) | DIFF |
| 99 | (no fallback) | `} else {` (integration.ts:445) | DIFF |
| 100 | ngspice RHS: `ag[1] = -1/delta` at nicomcof.c:67 (others zero) | `const rhs2 = r1 / dt;` (integration.ts:446) | DIFF — RHS reconstructed with OPPOSITE sign using r1, not -1 |
| 101 | ngspice back-sub: `ag[2] /= mat[2][2]` (nicomcof.c:110 for order=2) | `const ag2 = rhs2 / u22;` (integration.ts:447) | DIFF — algebraic shortcut vs back-sub step |
| 102 | ngspice: `ag[1] -= mat[1][2]*ag[2]; ag[1] /= mat[1][1]` (nicomcof.c:112,115 iter i=1) | `ag[1] = (-1 / dt - r2 * ag2) / r1;` (integration.ts:448) | DIFF — closed form assumes mat[1][1]==r1==1; ngspice divides explicitly |
| 103 | ngspice: `ag[0] -= mat[0][1]*ag[1] + mat[0][2]*ag[2]; ag[0] /= mat[0][0]` where mat[0][*]=1 (nicomcof.c:113-115) | `ag[0] = -(ag[1] + ag2);` (integration.ts:449) | DIFF — closed-form shortcut; mat[0][0]=1 not divided |
| 104 | ngspice: back-sub already stored ag[2] via `ag[order] /= mat[order][order]` (nicomcof.c:110) | `ag[2] = ag2;` (integration.ts:450) | DIFF — direct assignment from local |
| 105 | (no else close) | `}` end bdf2 non-degenerate branch (integration.ts:451) | DIFF |
| 106 | n/a — `default: return(E_METHOD)` in ngspice (nicomcof.c:125-126) | `} else { // BDF-1 ag[0] = 1/dt; ag[1] = -1/dt; }` (integration.ts:454-458) | DIFF — ngspice errors on unknown; ours silently handles as BDF-1 |
| 107 | n/a (ngspice only has NIcomCof) | `export function computeIntegrationCoefficients(dt, h1, order, method, xmu=0.5): {ag0, ag1}` (integration.ts:469-475) | DIFF — duplicate helper with no ngspice analog |
| 108 | n/a | `if (dt <= 0) return { ag0: 0, ag1: 0 };` (integration.ts:476) | DIFF — defensive guard |
| 109 | trapezoidal order 1 (nicomcof.c:38-41) | `if (order <= 1) return { ag0: 1/dt, ag1: -1/dt };` (integration.ts:478-479) | DIFF — collapses BDF-1 and trap order 1 under order<=1 |
| 110 | trapezoidal order 2 (nicomcof.c:43-46) | `else if (method === 'trapezoidal') { const ag0 = 1/(dt*(1-xmu)); return { ag0, ag1: -ag0 }; }` (integration.ts:480-483) | **CRITICAL DIFF** — ngspice ag[1] = xmu/(1-xmu); ours ag1 = -ag0 = -1/(dt*(1-xmu)). DIFFERENT VALUES (not equal in general) |
| 111 | gear order 2 (nicomcof.c via Vandermonde) | `else { /* BDF-2 closed-form */ ... }` (integration.ts:484-500) | DIFF — mirrors closed-form; returns only ag0,ag1 (no ag2) |
| 112 | BDF-2 clone: `const safeH1 = h1 > 0 ? h1 : dt;` (integration.ts:485) | same as #92 (duplicate) | DIFF |
| 113 | BDF-2 clone: `const r1 = 1;` (integration.ts:489) | same as #93 (duplicate) | DIFF |
| 114 | BDF-2 clone: `const r2 = (dt + safeH1) / dt;` (integration.ts:490) | same as #94 (duplicate) | DIFF |
| 115 | BDF-2 clone: `const u22 = r2 * (r2 - r1);` (integration.ts:491) | same as #95 (duplicate) | DIFF |
| 116 | BDF-2 clone: guard `if (Math.abs(u22) < 1e-30) return { ag0: 1/dt, ag1: -1/dt };` (integration.ts:492-494) | same as #96-98 (duplicate) | DIFF |
| 117 | BDF-2 clone: `const rhs2 = r1 / dt;` (integration.ts:495) | same as #100 (duplicate) | DIFF |
| 118 | BDF-2 clone: `const ag2 = rhs2 / u22;` (integration.ts:496) | same as #101 (duplicate) | DIFF |
| 119 | BDF-2 clone: `const ag1val = (-1 / dt - r2 * ag2) / r1;` (integration.ts:497) | same as #102 (duplicate, local var name differs) | DIFF |
| 120 | BDF-2 clone: `const ag0val = -(ag1val + ag2);` (integration.ts:498) | same as #103 (duplicate) | DIFF |
| 121 | BDF-2 clone: `return { ag0: ag0val, ag1: ag1val };` (integration.ts:499) | no ngspice analog — ag2 DROPPED from return | DIFF — loses ag2 information |

## 2. NIintegrate (niinteg.c:17-80) vs integrateCapacitor + integrateInductor

ngspice NIintegrate handles both capacitors and inductors via pointer indirection (qcap state slot). Ours splits into integrateCapacitor (integration.ts:23-78) and integrateInductor (integration.ts:84-138). Each C line is mapped against BOTH TS functions.

| # | ngspice NIintegrate (C) | our TS | Status |
|---|-------------------|--------|--------|
| 122 | `#define ccap qcap+1` (niinteg.c:15) | ccap returned as struct field, not stored in state (integration.ts:77,137) | DIFF — ngspice indexes next-slot macro; ours returns via object |
| 123 | `int NIintegrate(CKTcircuit *ckt, double *geq, double *ceq, double cap, int qcap)` (niinteg.c:17-18) | `export function integrateCapacitor(C, vNow, q0, q1, q2, dt, h1, order, method, ccapPrev, xmu=0.5, qHistory?, ag?): {geq, ceq, ccap, ag0}` (integration.ts:23-34) | DIFF — capacitor version; far more parameters; result object |
| 124 | same ngspice line (niinteg.c:17-18) | `export function integrateInductor(L, iNow, phi0, phi1, phi2, dt, h1, order, method, ccapPrev, xmu=0.5, phiHistory?, ag?): {geq, ceq, ccap, ag0}` (integration.ts:84-95) | DIFF — inductor version; ngspice single function vs ours split |
| 125 | `static char *ordmsg = ...;` (niinteg.c:20) | absent | DIFF |
| 126 | `static char *methodmsg = ...;` (niinteg.c:21) | absent | DIFF |
| 127 | (no dt guard) | cap: `if (dt <= 0) return { geq: 0, ceq: 0, ccap: 0, ag0: 0 };` (integration.ts:35) | DIFF — defensive guard |
| 128 | (no dt guard) | ind: `if (dt <= 0) return { geq: 0, ceq: 0, ccap: 0, ag0: 0 };` (integration.ts:96) | DIFF — defensive guard |
| 129 | (local ag0/ccap implicit via ckt->CKTag and state slots) | cap: `let ag0: number; let ccap: number;` (integration.ts:37-38) | DIFF — explicit local declarations |
| 130 | (same as #129) | ind: `let ag0: number; let ccap: number;` (integration.ts:98-99) | DIFF |
| 131 | `switch(ckt->CKTintegrateMethod) {` (niinteg.c:23) | cap: `if (method === 'gear' && ag && order >= 2) ... else if (order <= 1) ... else if (method === 'trapezoidal') ... else {...}` (integration.ts:40-73) | DIFF — dispatch ORDER different: ngspice method→order; ours 4-branch if-ladder with GEAR-guarded-by-order first |
| 132 | same (niinteg.c:23) | ind: same ladder (integration.ts:101-133) | DIFF |
| 133 | `case TRAPEZOIDAL:` (niinteg.c:25) | flattened — splits into `order<=1` branch and `method==='trapezoidal'` branch | DIFF |
| 134 | `switch(ckt->CKTorder) {` (niinteg.c:26) | split across if branches | DIFF |
| 135 | `case 1:` (niinteg.c:27) | cap: `else if (order <= 1)` (integration.ts:48) | DIFF — ngspice ==1; ours <=1 |
| 136 | same (niinteg.c:27) | ind: `else if (order <= 1)` (integration.ts:109) | DIFF |
| 137 | `ckt->CKTstate0[ccap] = ckt->CKTag[0]*ckt->CKTstate0[qcap] + ckt->CKTag[1]*ckt->CKTstate1[qcap];` (niinteg.c:28-29) | cap: `ag0 = 1 / dt;` (integration.ts:49) | DIFF — ngspice uses precomputed ag[]; ours re-derives 1/dt locally |
| 138 | (cont. from niinteg.c:28-29) | cap: `ccap = (q0 - q1) / dt;` (integration.ts:50) | DIFF — ngspice: ag[0]*q0 + ag[1]*q1 with ag[1]=-1/dt; ours fuses into (q0-q1)/dt. Algebraically equal for BDF-1 only |
| 139 | same ngspice line (niinteg.c:28-29) | ind: `ag0 = 1 / dt;` (integration.ts:110) | DIFF |
| 140 | same (niinteg.c:28-29) | ind: `ccap = (phi0 - phi1) / dt;` (integration.ts:111) | DIFF |
| 141 | `break;` (niinteg.c:30) | implicit end of order<=1 branch | MATCH |
| 142 | `case 2:` (niinteg.c:31) | cap: `else if (method === 'trapezoidal')` (integration.ts:51) | DIFF — ngspice matches order==2 inside TRAP; ours matches method=='trapezoidal' (with order>1 implied) |
| 143 | same (niinteg.c:31) | ind: `else if (method === 'trapezoidal')` (integration.ts:112) | DIFF |
| 144 | `ckt->CKTstate0[ccap] = - ckt->CKTstate1[ccap] * ckt->CKTag[1] + ckt->CKTag[0] * (ckt->CKTstate0[qcap] - ckt->CKTstate1[qcap]);` (niinteg.c:32-34) | cap: `ag0 = 1 / (dt * (1 - xmu));` (integration.ts:52) | DIFF — ours re-derives ag0 locally; ngspice reads ag[0] |
| 145 | (cont. niinteg.c:32-34) | cap: `ccap = (1 / (dt * (1 - xmu))) * (q0 - q1) - ccapPrev;` (integration.ts:53) | **CRITICAL DIFF** — ngspice: ccap = -ag[1]*ccapPrev + ag[0]*(q0-q1) where ag[1]=xmu/(1-xmu). Ours: ccap = ag[0]*(q0-q1) - ccapPrev. Coefficient on ccapPrev: ngspice=-xmu/(1-xmu); ours=-1. These DIFFER unless xmu=0.5 (where ngspice coeff = -1) |
| 146 | same (niinteg.c:32-34) | ind: `ag0 = 1 / (dt * (1 - xmu));` (integration.ts:113) | DIFF |
| 147 | same (niinteg.c:32-34) | ind: `ccap = (1 / (dt * (1 - xmu))) * (phi0 - phi1) - ccapPrev;` (integration.ts:114) | DIFF |
| 148 | `break;` (niinteg.c:35) | implicit end of trapezoidal branch | MATCH |
| 149 | `default: errMsg = TMALLOC; strcpy(errMsg,ordmsg); return(E_ORDER);` (niinteg.c:36-39) | absent | DIFF |
| 150 | `break;` end TRAPEZOIDAL (niinteg.c:41) | n/a | MATCH implicit |
| 151 | `case GEAR:` (niinteg.c:42) | cap: `if (method === 'gear' && ag && order >= 2)` (integration.ts:40) | DIFF — ours requires ag non-null AND order>=2; ngspice accepts order 1..6 |
| 152 | same (niinteg.c:42) | ind: `if (method === 'gear' && ag && order >= 2)` (integration.ts:101) | DIFF |
| 153 | `ckt->CKTstate0[ccap]=0;` (niinteg.c:43) | cap: implicit via `ccap = ag[0] * q0 + ...` fresh assignment (integration.ts:43) | DIFF — no explicit zero; ours initializes via expression |
| 154 | same (niinteg.c:43) | ind: implicit via `ccap = ag[0] * phi0 + ...` (integration.ts:104) | DIFF |
| 155 | comment/ag0 prep | cap: `ag0 = ag[0];` (integration.ts:42) | DIFF — ours caches ag[0] into ag0 local; ngspice reads ag[0] directly |
| 156 | same | ind: `ag0 = ag[0];` (integration.ts:103) | DIFF |
| 157 | `switch(ckt->CKTorder) {` (niinteg.c:44) | ours unrolls k=0,1,2 then loops 3..order (integration.ts:43-47 cap) | DIFF — ngspice explicit case-labels with fall-through |
| 158 | `case 6: ckt->CKTstate0[ccap] += ckt->CKTag[6]*ckt->CKTstate6[qcap];` (niinteg.c:46-47) | cap: `for (let k = 3; k <= order; k++) { const qk = qHistory ? qHistory[k-3] : 0; ccap += ag[k] * qk; }` (integration.ts:44-47) iteration k=6 reads qHistory[3] | DIFF — ngspice reads dedicated state slot 6; ours reads qHistory[k-3] |
| 159 | `/* fall through */` (niinteg.c:48) | loop continues (integration.ts:44) | DIFF |
| 160 | `case 5: ckt->CKTstate0[ccap] += ckt->CKTag[5]*ckt->CKTstate5[qcap];` (niinteg.c:49-50) | cap: loop k=5 reads qHistory[2] (integration.ts:46) | DIFF |
| 161 | `/* fall through */` (niinteg.c:51) | loop continues | DIFF |
| 162 | `case 4: ckt->CKTstate0[ccap] += ckt->CKTag[4]*ckt->CKTstate4[qcap];` (niinteg.c:52-53) | cap: loop k=4 reads qHistory[1] (integration.ts:46) | DIFF |
| 163 | `/* fall through */` (niinteg.c:54) | loop continues | DIFF |
| 164 | `case 3: ckt->CKTstate0[ccap] += ckt->CKTag[3]*ckt->CKTstate3[qcap];` (niinteg.c:55-56) | cap: loop k=3 reads qHistory[0] (integration.ts:46) | DIFF |
| 165 | `/* fall through */` (niinteg.c:57) | loop continues | DIFF |
| 166 | `case 2: ckt->CKTstate0[ccap] += ckt->CKTag[2]*ckt->CKTstate2[qcap];` (niinteg.c:58-59) | cap: unrolled term `ag[2] * q2` inside expression `ccap = ag[0]*q0 + ag[1]*q1 + ag[2]*q2` (integration.ts:43) | DIFF — ngspice += per-case; ours single expression |
| 167 | `/* fall through */` (niinteg.c:60) | n/a | DIFF |
| 168 | `case 1: ckt->CKTstate0[ccap] += ckt->CKTag[1]*ckt->CKTstate1[qcap];` (niinteg.c:61-62) | cap: unrolled `ag[1] * q1` in same expression (integration.ts:43) | DIFF |
| 169 | `ckt->CKTstate0[ccap] += ckt->CKTag[0]*ckt->CKTstate0[qcap];` (niinteg.c:63) | cap: unrolled `ag[0] * q0` in same expression (integration.ts:43) | DIFF |
| 170 | `break;` (niinteg.c:64) | implicit end of GEAR branch | MATCH |
| 171 | `default: return(E_ORDER);` (niinteg.c:66-67) | absent — guarded by order>=2, any order acceptable | DIFF |
| 172 | `break;` end GEAR (niinteg.c:70) | implicit | MATCH |
| 173 | mirror niinteg.c:46-47 (inductor GEAR order=6) | ind: loop k=6 reads phiHistory[3] (integration.ts:105-108) | DIFF |
| 174 | mirror niinteg.c:49-50 | ind: loop k=5 reads phiHistory[2] | DIFF |
| 175 | mirror niinteg.c:52-53 | ind: loop k=4 reads phiHistory[1] | DIFF |
| 176 | mirror niinteg.c:55-56 | ind: loop k=3 reads phiHistory[0] | DIFF |
| 177 | mirror niinteg.c:58-59 | ind: `ag[2] * phi2` term in `ccap = ag[0]*phi0 + ag[1]*phi1 + ag[2]*phi2` (integration.ts:104) | DIFF |
| 178 | mirror niinteg.c:61-62 | ind: `ag[1] * phi1` term in same expression (integration.ts:104) | DIFF |
| 179 | mirror niinteg.c:63 | ind: `ag[0] * phi0` term in same expression (integration.ts:104) | DIFF |
| 180 | `default: errMsg = TMALLOC; strcpy(errMsg,methodmsg); return(E_METHOD);` (niinteg.c:72-75) | cap: else branch doing BDF-2 closed form (integration.ts:54-73) | DIFF — ngspice errors; ours runs BDF-2 math |
| 181 | same (niinteg.c:72-75) | ind: else branch doing BDF-2 closed form (integration.ts:115-133) | DIFF |
| 182 | n/a (ngspice order-2 routes through NIcomCof GEAR Vandermonde + NIintegrate GEAR case-2) | cap: `const safeH1 = h1 > 0 ? h1 : dt;` (integration.ts:56) | DIFF |
| 183 | n/a | cap: comment block referencing nicomcof.c:79-86 (integration.ts:57-59) | DIFF |
| 184 | n/a | cap: `const r1 = 1;` (integration.ts:60) | DIFF |
| 185 | n/a | cap: `const r2 = (dt + safeH1) / dt;` (integration.ts:61) | DIFF |
| 186 | n/a | cap: `const u22 = r2 * (r2 - r1);` (integration.ts:62) | DIFF |
| 187 | n/a | cap: `if (Math.abs(u22) < 1e-30) {` (integration.ts:63) | DIFF — near-singular guard |
| 188 | n/a | cap: `ag0 = 1 / dt;` (integration.ts:64) | DIFF — BDF-1 fallback |
| 189 | n/a | cap: `ccap = (q0 - q1) / dt;` (integration.ts:65) | DIFF |
| 190 | n/a | cap: `} else {` (integration.ts:66) | DIFF |
| 191 | n/a | cap: `const rhs2 = r1 / dt;` (integration.ts:67) | DIFF |
| 192 | n/a | cap: `const ag2 = rhs2 / u22;` (integration.ts:68) | DIFF |
| 193 | n/a | cap: `const ag1 = (-1 / dt - r2 * ag2) / r1;` (integration.ts:69) | DIFF |
| 194 | n/a | cap: `ag0 = -(ag1 + ag2);` (integration.ts:70) | DIFF |
| 195 | n/a | cap: `ccap = ag0 * q0 + ag1 * q1 + ag2 * q2;` (integration.ts:71) | DIFF — ngspice would compute via NIintegrate GEAR case-2 fall-through; here done inline with locally-derived coeffs |
| 196 | n/a | cap: `}` end non-singular branch (integration.ts:72) | DIFF |
| 197 | n/a | cap: `}` end BDF-2 else (integration.ts:73) | DIFF |
| 198 | n/a | ind: `const safeH1 = h1 > 0 ? h1 : dt;` (integration.ts:116) | DIFF |
| 199 | n/a | ind: comment block (integration.ts:117-119) | DIFF |
| 200 | n/a | ind: `const r1 = 1;` (integration.ts:120) | DIFF |
| 201 | n/a | ind: `const r2 = (dt + safeH1) / dt;` (integration.ts:121) | DIFF |
| 202 | n/a | ind: `const u22 = r2 * (r2 - r1);` (integration.ts:122) | DIFF |
| 203 | n/a | ind: `if (Math.abs(u22) < 1e-30) {` (integration.ts:123) | DIFF |
| 204 | n/a | ind: `ag0 = 1 / dt;` (integration.ts:124) | DIFF |
| 205 | n/a | ind: `ccap = (phi0 - phi1) / dt;` (integration.ts:125) | DIFF |
| 206 | n/a | ind: `} else {` (integration.ts:126) | DIFF |
| 207 | n/a | ind: `const rhs2 = r1 / dt;` (integration.ts:127) | DIFF |
| 208 | n/a | ind: `const ag2 = rhs2 / u22;` (integration.ts:128) | DIFF |
| 209 | n/a | ind: `const ag1 = (-1 / dt - r2 * ag2) / r1;` (integration.ts:129) | DIFF |
| 210 | n/a | ind: `ag0 = -(ag1 + ag2);` (integration.ts:130) | DIFF |
| 211 | n/a | ind: `ccap = ag0 * phi0 + ag1 * phi1 + ag2 * phi2;` (integration.ts:131) | DIFF |
| 212 | n/a | ind: `}` (integration.ts:132) | DIFF |
| 213 | n/a | ind: `}` (integration.ts:133) | DIFF |
| 214 | `*ceq = ckt->CKTstate0[ccap] - ckt->CKTag[0] * ckt->CKTstate0[qcap];` (niinteg.c:77) | cap: `const ceq = ccap - geq * vNow;` (integration.ts:76) | **DIFF** — ngspice: ccap - ag[0]*q0. Ours: ccap - (ag0*C)*vNow = ccap - ag0*C*vNow. If vNow == q0/C (linear cap) these match; otherwise differ |
| 215 | same (niinteg.c:77) | ind: `const ceq = ccap - geq * iNow;` (integration.ts:136) | DIFF — dual of #214; ngspice uses ag[0]*phi0 |
| 216 | `*geq = ckt->CKTag[0] * cap;` (niinteg.c:78) | cap: `const geq = ag0 * C;` (integration.ts:75) | MATCH |
| 217 | same (niinteg.c:78) | ind: `const geq = ag0 * L;` (integration.ts:135) | MATCH — inductor dual |
| 218 | `return(OK);` (niinteg.c:79) | cap: `return { geq, ceq, ccap, ag0 };` (integration.ts:77) | DIFF — object return with 4 fields |
| 219 | same (niinteg.c:79) | ind: `return { geq, ceq, ccap, ag0 };` (integration.ts:137) | DIFF |

## 3a. NIcomCof PREDICTOR block (nicomcof.c:129-207) vs computeAgp + _computeAgpGear

| # | ngspice NIcomCof PREDICTOR (C) | our TS | Status |
|---|-------------------|--------|--------|
| 220 | `#ifdef PREDICTOR` (nicomcof.c:129) | no compile guard — always compiled (ni-pred.ts) | DIFF |
| 221 | `/* ok, have the coefficients for corrector, now for the predictor */` (nicomcof.c:130) | doc comment above computeAgp (ni-pred.ts:29-46) | MATCH (comment) |
| 222 | `switch(ckt->CKTintegrateMethod) {` (nicomcof.c:132) | `if (method !== 'gear') {...} else {...}` (ni-pred.ts:56-65) | DIFF — if/else vs switch |
| 223 | `default: return(E_METHOD);` (nicomcof.c:134-135) | absent — bdf1/trap/bdf2 all enter trap branch; anything else enters GEAR branch | DIFF |
| 224 | `case TRAPEZOIDAL:` (nicomcof.c:137) | `if (method !== 'gear')` (ni-pred.ts:56) | DIFF — ours runs trap predictor for bdf1, trapezoidal, AND bdf2; ngspice only for method==TRAPEZOIDAL |
| 225 | comment block Adams-Bashford (nicomcof.c:138-141) | `// nicomcof.c:141-145 - TRAPEZOIDAL predictor coefficients` (ni-pred.ts:57) | MATCH (comment) |
| 226 | `arg = ckt->CKTdelta/(2*ckt->CKTdeltaOld[1]);` (nicomcof.c:142) | `const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : delta;` (ni-pred.ts:58) | DIFF — ours splits computation; adds defensive `>0` guard |
| 227 | (part of same expression, nicomcof.c:142) | `const arg = delta / (2.0 * dOld1);` (ni-pred.ts:59) | DIFF — uses guarded dOld1 instead of raw deltaOld[1] |
| 228 | `ckt->CKTagp[0] = 1+arg;` (nicomcof.c:143) | `agp[0] = 1.0 + arg;` (ni-pred.ts:60) | MATCH |
| 229 | `ckt->CKTagp[1] = -arg;` (nicomcof.c:144) | `agp[1] = -arg;` (ni-pred.ts:61) | MATCH |
| 230 | `break;` (nicomcof.c:145) | implicit end of if-branch | MATCH |
| 231 | `case GEAR:` (nicomcof.c:147) | `else { _computeAgpGear(order, delta, deltaOld, agp); }` (ni-pred.ts:62-65) | DIFF — helper extracted |
| 232 | comment `CONSTRUCT GEAR PREDICTOR...` (nicomcof.c:149-153) | doc comment above _computeAgpGear (ni-pred.ts:66-71) | MATCH (comment) |
| 233 | (no const n) | `const n = order + 1;` (ni-pred.ts:78) | DIFF |
| 234 | `double mat[8][8];` reused from outer scope (nicomcof.c:21) | `const mat = new Float64Array(n * n);` (ni-pred.ts:79) | DIFF — Float64Array flat; ngspice 2D fixed-size |
| 235 | (RHS lives in agp in ngspice) | `const rhs = new Float64Array(n);` (ni-pred.ts:80) | DIFF — separate rhs array |
| 236 | `bzero(ckt->CKTagp,7*sizeof(double));` (nicomcof.c:154) | no explicit bzero of agp; rhs[] init'd to zeros via Float64Array (ni-pred.ts:80) | DIFF — ngspice zeroes agp; ours uses separate zeroed rhs |
| 237 | `/* SET UP RHS OF EQUATIONS */` (nicomcof.c:155) | absent explicit comment | DIFF |
| 238 | `ckt->CKTagp[0]=1;` (nicomcof.c:156) | `rhs[0] = 1.0;` (ni-pred.ts:81) | DIFF — RHS stored in separate array; not in agp[] |
| 239 | `for(i=0;i<=ckt->CKTorder;i++) { mat[0][i] = 1; }` (nicomcof.c:157-159) | `mat[i * n + 0] = 1.0;` set inside per-row loop (ni-pred.ts:92) | DIFF — ngspice row 0 all 1s; ours COLUMN 0 all 1s (note layout inversion) |
| 240 | `arg = 0;` (nicomcof.c:160) | `let tBack = 0.0;` reset each outer iteration i (ni-pred.ts:86) | DIFF — ngspice arg persists across i; ours resets tBack per i |
| 241 | `for(i=0;i<=ckt->CKTorder;i++){` (nicomcof.c:161) | `for (let i = 0; i < n; i++) {` (ni-pred.ts:85) | MATCH |
| 242 | `arg += ckt->CKTdeltaOld[i];` (nicomcof.c:162) | `for (let k = 0; k < i; k++) { tBack += (k + 1 < deltaOld.length ? deltaOld[k + 1] : delta); }` (ni-pred.ts:87-89) | **CRITICAL INDEX SHIFT** — ngspice indexes deltaOld[i] starting from 0; ours indexes deltaOld[k+1] starting from 1. Also ngspice accumulates ONCE per outer i; ours recomputes from scratch |
| 243 | (same line) | `const t = tBack / delta;` (ni-pred.ts:90) | DIFF — normalised time; ngspice uses arg/delta inline |
| 244 | `arg1 = 1;` (nicomcof.c:163) | `let factorial = 1.0;` (ni-pred.ts:91) | DIFF — split into factorial vs power |
| 245 | (same) | `mat[i * n + 0] = 1.0;` (ni-pred.ts:92) | DIFF — ours writes COLUMN-0 per row; ngspice wrote ROW-0 in outer loop |
| 246 | (same) | `let tPow = 1.0;` (ni-pred.ts:93) | DIFF |
| 247 | `for(j=1;j<=ckt->CKTorder;j++) {` (nicomcof.c:164) | `for (let j = 1; j < n; j++) {` (ni-pred.ts:94) | MATCH |
| 248 | `arg1 *= arg/ckt->CKTdelta;` (nicomcof.c:165) | `tPow *= t;` (ni-pred.ts:95) | DIFF — ngspice accumulates (arg/delta)^j into single var; ours tracks t^j separately |
| 249 | (same) | `factorial *= j;` (ni-pred.ts:96) | DIFF — NEW STEP: ours divides by factorial which ngspice does NOT |
| 250 | `mat[j][i]=arg1;` (nicomcof.c:166) | `mat[i * n + j] = tPow / factorial;` (ni-pred.ts:97) | **CRITICAL DIFF** — (1) ngspice: mat[j][i]=(arg/delta)^j without /factorial; ours: mat[i][j]=t^j/j!. (2) DIFFERENT formula (factorial division) — ngspice Vandermonde; ours Taylor/Adams collocation. (3) Transposed indexing — ngspice mat[j][i] row=deriv-order col=time-index; ours mat[i][j] row=time-index col=deriv-order |
| 251 | `}` end j (nicomcof.c:167) | `}` (ni-pred.ts:98) | MATCH |
| 252 | `}` end i (nicomcof.c:168) | `}` (ni-pred.ts:99) | MATCH |
| 253 | comment `/* LU DECOMPOSITION */` (nicomcof.c:169-175) | `// LU decomposition - Gaussian elimination without pivoting` (ni-pred.ts:101) | MATCH (comment) |
| 254 | `for(i=0;i<=ckt->CKTorder;i++) {` (nicomcof.c:176) | `for (let k = 0; k < n; k++) {` (ni-pred.ts:102) | DIFF — index renamed i→k (outer pivot index) |
| 255 | (no pivot guard) | `const pivot = mat[k * n + k];` (ni-pred.ts:103) | DIFF — caches pivot |
| 256 | (no pivot guard) | `if (Math.abs(pivot) < 1e-30) {` (ni-pred.ts:104) | DIFF — defensive guard |
| 257 | (no fallback) | `agp.fill(0);` (ni-pred.ts:105) | DIFF — zero-out on near-singular |
| 258 | (no fallback) | `return;` (ni-pred.ts:106) | DIFF |
| 259 | (no fallback) | `}` (ni-pred.ts:107) | DIFF |
| 260 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:177) | `for (let i = k + 1; i < n; i++) {` (ni-pred.ts:108) | DIFF — variable renamed j→i |
| 261 | `mat[j][i] /= mat[i][i];` (nicomcof.c:178) | `const factor = mat[i * n + k] / pivot;` (ni-pred.ts:109) | DIFF — ngspice mutates mat[j][i]; ours stores factor in LOCAL only (mat not mutated at that cell) |
| 262 | `for(k=i+1;k<=ckt->CKTorder;k++) {` (nicomcof.c:179) | `for (let j = k; j < n; j++) {` (ni-pred.ts:110) | DIFF — ngspice starts k=i+1; ours starts j=k (outer). Ours INCLUDES the pivot column that ngspice skipped |
| 263 | `mat[j][k] -= mat[j][i]*mat[i][k];` (nicomcof.c:180) | `mat[i * n + j] -= factor * mat[k * n + j];` (ni-pred.ts:111) | DIFF — index variables renamed; semantically same row operation |
| 264 | (no RHS update in LU) | `rhs[i] -= factor * rhs[k];` (ni-pred.ts:113) | DIFF — ours FUSES forward-sub into LU loop; ngspice runs separate forward-sub block |
| 265 | `}` end k (nicomcof.c:181) | `}` end j (ni-pred.ts:112) | MATCH (structure) |
| 266 | `}` end j (nicomcof.c:182) | `}` end i (ni-pred.ts:114) | MATCH |
| 267 | `}` end i (nicomcof.c:183) | `}` end k (ni-pred.ts:115) | MATCH |
| 268 | `/* FORWARD SUBSTITUTION */` (nicomcof.c:184-186) | fused into LU above — not present as separate block | DIFF |
| 269 | `for(i=0;i<=ckt->CKTorder;i++) {` (nicomcof.c:187) | fused | DIFF |
| 270 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:188) | fused | DIFF |
| 271 | `ckt->CKTagp[j] -= mat[j][i]*ckt->CKTagp[i];` (nicomcof.c:189) | fused as `rhs[i] -= factor * rhs[k];` (ni-pred.ts:113) | DIFF — ngspice reads stored mat[j][i]; ours uses LOCAL factor (mat not mutated) |
| 272 | `}` (nicomcof.c:190) | n/a | DIFF |
| 273 | `}` (nicomcof.c:191) | n/a | DIFF |
| 274 | `/* BACKWARD SUBSTITUTION */` (nicomcof.c:192-194) | `// Back substitution (nicomcof.c:197-205)` (ni-pred.ts:117) | MATCH (comment) |
| 275 | `ckt->CKTagp[ckt->CKTorder] /= mat[ckt->CKTorder][ckt->CKTorder];` (nicomcof.c:195) | handled as final iteration of unified back-sub loop (ni-pred.ts:118-124) | DIFF — ngspice pulls last row out; ours handles uniformly |
| 276 | `for(i=ckt->CKTorder-1;i>=0;i--) {` (nicomcof.c:196) | `for (let i = n - 1; i >= 0; i--) {` (ni-pred.ts:118) | DIFF — ngspice starts order-1 (skips last); ours starts n-1==order (handles all) |
| 277 | (agp accumulator in place) | `let sum = rhs[i];` (ni-pred.ts:119) | DIFF — ours accumulates into local sum; ngspice updates agp[i] in place |
| 278 | `for(j=i+1;j<=ckt->CKTorder;j++) {` (nicomcof.c:197) | `for (let j = i + 1; j < n; j++) {` (ni-pred.ts:120) | MATCH |
| 279 | `ckt->CKTagp[i] -= mat[i][j]*ckt->CKTagp[j];` (nicomcof.c:198) | `sum -= mat[i * n + j] * agp[j];` (ni-pred.ts:121) | DIFF — ngspice subtracts from agp[i] directly; ours subtracts from local sum |
| 280 | `}` end j (nicomcof.c:199) | `}` (ni-pred.ts:122) | MATCH |
| 281 | `ckt->CKTagp[i] /= mat[i][i];` (nicomcof.c:200) | `agp[i] = sum / mat[i * n + i];` (ni-pred.ts:123) | DIFF — ngspice in-place div; ours assigns fresh value from sum |
| 282 | `}` end i (nicomcof.c:201) | `}` (ni-pred.ts:124) | MATCH |
| 283 | comment `/* FINISHED */` (nicomcof.c:202-204) | absent | DIFF |
| 284 | `break;` end GEAR predictor (nicomcof.c:205) | implicit end of _computeAgpGear | MATCH |
| 285 | `}` end switch (nicomcof.c:206) | implicit | MATCH |
| 286 | `#endif /* PREDICTOR */` (nicomcof.c:207) | no guard | DIFF |
| 287 | `return(OK);` (nicomcof.c:208) | void return | DIFF |

## 3b. NIpred (nipred.c:21-148) vs predictVoltages + _predictVoltagesGear

| # | ngspice NIpred (C) | our TS | Status |
|---|-------------------|--------|--------|
| 288 | `#ifdef PREDICTOR` (nipred.c:19) | no compile guard | DIFF |
| 289 | `int NIpred(CKTcircuit * ckt)` (nipred.c:21-22) | `export function predictVoltages(history, deltaOld, order, method, agp, out): boolean` (ni-pred.ts:160-167) | DIFF — boolean return; explicit parameters instead of ckt |
| 290 | `int i;` (nipred.c:24) | declared per loop `let i` (ni-pred.ts:179 etc.) | DIFF — scope |
| 291 | `int size;` (nipred.c:25) | `const nodeCount = out.length;` (ni-pred.ts:168) | DIFF — renamed; ngspice size is matrix size (uses `i <= size` for size+1 iterations) |
| 292 | `CKTnode *node;` (nipred.c:26) | absent (not needed — no node walk in TS) | DIFF |
| 293 | comment block (nipred.c:28-35) | JSDoc comment (ni-pred.ts:130-159) | MATCH (comment) |
| 294 | `size = SMPmatSize(ckt->CKTmatrix);` (nipred.c:38) | `const nodeCount = out.length;` (ni-pred.ts:168) | DIFF — loop bounds differ: ngspice i=0..size inclusive; ours i=0..nodeCount-1 |
| 295 | (no filled guard) | `const filled = history.filled;` (ni-pred.ts:169) | DIFF — tracks filled count |
| 296 | `switch (ckt->CKTintegrateMethod) {` (nipred.c:40) | `if (method !== 'gear') {...} else {...}` (ni-pred.ts:172-208) | DIFF — if/else vs switch |
| 297 | `case TRAPEZOIDAL: {` (nipred.c:42) | `if (method !== 'gear')` (ni-pred.ts:172) | DIFF — ours also runs trap branch for bdf1 and bdf2 |
| 298 | `double dd0, dd1, a, b;` (nipred.c:43) | declared per-branch as `const` inline (ni-pred.ts various) | DIFF |
| 299 | `switch (ckt->CKTorder) {` (nipred.c:44) | `if (order <= 1) ... else {...}` (ni-pred.ts:173-204) | DIFF — if/else; also order<=1 covers 0 |
| 300 | `case 1:` (nipred.c:46) | `if (order <= 1)` (ni-pred.ts:173) | DIFF — ngspice ==1; ours <=1 |
| 301 | (no history-depth guard) | `if (filled < 2) return false;` (ni-pred.ts:176) | DIFF — defensive guard; early exit |
| 302 | (deltaOld[1] not cached) | `const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : deltaOld[0];` (ni-pred.ts:177) | DIFF — hoists and guards >0; ngspice reads raw inside loop |
| 303 | (deltaOld[0] not cached) | `const dOld0 = deltaOld[0];` (ni-pred.ts:178) | DIFF — hoisted |
| 304 | `for (i = 0; i <= size; i++) {` (nipred.c:47) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:179) | DIFF — ngspice inclusive to size; ours exclusive to nodeCount |
| 305 | (CKTsols read inline x2) | `const s0 = history.getNodeVoltage(i, 0);` (ni-pred.ts:180) | DIFF — explicit accessor call; cached local |
| 306 | (same) | `const s1 = history.getNodeVoltage(i, 1);` (ni-pred.ts:181) | DIFF — cached local |
| 307 | `dd0 = (ckt->CKTsols[0][i] - ckt->CKTsols[1][i]) / ckt->CKTdeltaOld[1];` (nipred.c:48-49) | `const dd0 = (s0 - s1) / dOld1;` (ni-pred.ts:182) | DIFF — uses cached locals and guarded dOld1 |
| 308 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = ckt->CKTsols[0][i] + ckt->CKTdeltaOld[0] * dd0;` (nipred.c:50-51) | `out[i] = s0 + dOld0 * dd0;` (ni-pred.ts:183) | DIFF — ngspice writes BOTH CKTpred[] AND CKTrhs[]; ours writes only out[]. Also re-reads CKTsols[0][i] instead of caching |
| 309 | `}` end loop (nipred.c:52) | `}` (ni-pred.ts:184) | MATCH |
| 310 | `break;` (nipred.c:53) | `return true;` (ni-pred.ts:185) | DIFF — ngspice continues; ours returns |
| 311 | `case 2:` (nipred.c:55) | `else {` (ni-pred.ts:186) | DIFF — ngspice ==2 only; ours matches any order != order<=1 (i.e. any order>=2) |
| 312 | (no history-depth guard) | `if (filled < 3) return false;` (ni-pred.ts:189) | DIFF — defensive guard |
| 313 | (deltaOld[0] not cached) | `const dOld0 = deltaOld[0];` (ni-pred.ts:190) | DIFF — hoisted |
| 314 | (deltaOld[1] not cached) | `const dOld1 = deltaOld[1] > 0 ? deltaOld[1] : dOld0;` (ni-pred.ts:191) | DIFF — hoisted + >0 guard |
| 315 | (deltaOld[2] not cached) | `const dOld2 = deltaOld[2] > 0 ? deltaOld[2] : dOld1;` (ni-pred.ts:192) | DIFF — hoisted + >0 guard cascading to dOld1 |
| 316 | `b = - ckt->CKTdeltaOld[0] / (2*ckt->CKTdeltaOld[1]);` (nipred.c:57) — inside loop | `const b = -dOld0 / (2.0 * dOld1);` (ni-pred.ts:193) — outside loop | DIFF — ngspice recomputes b per i; ours hoists once |
| 317 | `a = 1 - b;` (nipred.c:58) — inside loop | `const a = 1.0 - b;` (ni-pred.ts:194) — outside loop | DIFF — hoisted |
| 318 | `for (i = 0; i <= size; i++) {` (nipred.c:56) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:195) | DIFF — bounds |
| 319 | (CKTsols reads inline) | `const s0 = history.getNodeVoltage(i, 0);` (ni-pred.ts:196) | DIFF — cached |
| 320 | (same) | `const s1 = history.getNodeVoltage(i, 1);` (ni-pred.ts:197) | DIFF — cached |
| 321 | (same) | `const s2 = history.getNodeVoltage(i, 2);` (ni-pred.ts:198) | DIFF — cached |
| 322 | `dd0 = (ckt->CKTsols[0][i] - ckt->CKTsols[1][i]) / ckt->CKTdeltaOld[1];` (nipred.c:59-60) | `const dd0 = (s0 - s1) / dOld1;` (ni-pred.ts:199) | DIFF — cached locals & guarded dOld1 |
| 323 | `dd1 = (ckt->CKTsols[1][i] - ckt->CKTsols[2][i]) / ckt->CKTdeltaOld[2];` (nipred.c:61-62) | `const dd1 = (s1 - s2) / dOld2;` (ni-pred.ts:200) | DIFF — ours reuses cached s1; ngspice re-reads CKTsols[1][i] |
| 324 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = ckt->CKTsols[0][i] + (b * dd1 + a * dd0) * ckt->CKTdeltaOld[0];` (nipred.c:63-65) | `out[i] = s0 + (b * dd1 + a * dd0) * dOld0;` (ni-pred.ts:201) | DIFF — ngspice writes CKTpred AND CKTrhs AND re-reads CKTsols[0][i]; ours writes out[i] and reuses cached s0 |
| 325 | `}` end loop (nipred.c:66) | `}` (ni-pred.ts:202) | MATCH |
| 326 | `break;` (nipred.c:67) | `return true;` (ni-pred.ts:203) | DIFF |
| 327 | `default: return(E_ORDER);` (nipred.c:69-70) | absent — order>=3 would silently take the order-2 branch | DIFF — missing E_ORDER path |
| 328 | `}` end inner switch (nipred.c:71) | `}` (ni-pred.ts:204) | MATCH |
| 329 | `}` end TRAPEZOIDAL block (nipred.c:72) | `}` end else-if (ni-pred.ts:205) | MATCH |
| 330 | `break;` end TRAPEZOIDAL case (nipred.c:73) | implicit (end of if (method !== 'gear')) | MATCH |
| 331 | `case GEAR:` (nipred.c:75) | `else { return _predictVoltagesGear(history, order, agp, out, filled); }` (ni-pred.ts:205-208) | DIFF — helper extracted; also returns directly |
| 332 | `node = ckt->CKTnodes;` (nipred.c:76) | absent in _predictVoltagesGear (ni-pred.ts:215) | DIFF — dead walk eliminated |
| 333 | (no filled guard) | `if (filled < order + 1) return false;` (ni-pred.ts:222) | DIFF — defensive guard |
| 334 | (nodeCount not cached) | `const nodeCount = out.length;` (ni-pred.ts:223) | DIFF |
| 335 | `switch (ckt->CKTorder) {` (nipred.c:77) | `switch (order) {` (ni-pred.ts:225) | MATCH |
| 336 | `case 1:` (nipred.c:79) | `case 1:` (ni-pred.ts:226) | MATCH |
| 337 | `for (i = 0; i <= size; i++) {` (nipred.c:80) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:227) | DIFF — bounds |
| 338 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = ckt->CKTagp[0]*ckt->CKTsols[0][i] + ckt->CKTagp[1]*ckt->CKTsols[1][i];` (nipred.c:81-83) | `out[i] = agp[0] * history.getNodeVoltage(i, 0) + agp[1] * history.getNodeVoltage(i, 1);` (ni-pred.ts:228-229) | DIFF — ngspice writes CKTpred AND CKTrhs; ours writes only out. Also ours goes through history.getNodeVoltage() accessor |
| 339 | `node = node->next;` (nipred.c:84) | absent | DIFF — dead walk removed |
| 340 | `}` end loop (nipred.c:85) | `}` (ni-pred.ts:230) | MATCH |
| 341 | `break;` (nipred.c:86) | `return true;` (ni-pred.ts:231) | DIFF |
| 342 | `case 2:` (nipred.c:87) | `case 2:` (ni-pred.ts:232) | MATCH |
| 343 | `for (i = 0; i <= size; i++) {` (nipred.c:88) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:233) | DIFF |
| 344 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = agp[0]*sols[0][i] + agp[1]*sols[1][i] + agp[2]*sols[2][i];` (nipred.c:89-92) | `out[i] = agp[0]*getNodeVoltage(i,0) + agp[1]*getNodeVoltage(i,1) + agp[2]*getNodeVoltage(i,2);` (ni-pred.ts:234-236) | DIFF — dual write + accessor |
| 345 | `node = node->next;` (nipred.c:93) | absent | DIFF |
| 346 | `}` (nipred.c:94) | `}` (ni-pred.ts:237) | MATCH |
| 347 | `break;` (nipred.c:95) | `return true;` (ni-pred.ts:238) | DIFF |
| 348 | `case 3:` (nipred.c:96) | `case 3:` (ni-pred.ts:239) | MATCH |
| 349 | `for (i = 0; i <= size; i++) {` (nipred.c:97) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:240) | DIFF |
| 350 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = sum_{j=0..3} agp[j]*sols[j][i];` (nipred.c:98-102) | `out[i] = agp[0]*g(i,0) + agp[1]*g(i,1) + agp[2]*g(i,2) + agp[3]*g(i,3);` (ni-pred.ts:241-244) | DIFF — dual write + accessor |
| 351 | `}` (nipred.c:103) | `}` (ni-pred.ts:245) | MATCH |
| 352 | `break;` (nipred.c:104) | `return true;` (ni-pred.ts:246) | DIFF |
| 353 | `case 4:` (nipred.c:105) | `case 4:` (ni-pred.ts:247) | MATCH |
| 354 | `for (i = 0; i <= size; i++) {` (nipred.c:106) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:248) | DIFF |
| 355 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = sum_{j=0..4} agp[j]*sols[j][i];` (nipred.c:107-112) | `out[i] = agp[0]*g(i,0) + ... + agp[4]*g(i,4);` (ni-pred.ts:249-253) | DIFF |
| 356 | `}` (nipred.c:113) | `}` (ni-pred.ts:254) | MATCH |
| 357 | `break;` (nipred.c:114) | `return true;` (ni-pred.ts:255) | DIFF |
| 358 | `case 5:` (nipred.c:115) | `case 5:` (ni-pred.ts:256) | MATCH |
| 359 | `for (i = 0; i <= size; i++) {` (nipred.c:116) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:257) | DIFF |
| 360 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = sum_{j=0..5} agp[j]*sols[j][i];` (nipred.c:117-123) | `out[i] = agp[0]*g(i,0) + ... + agp[5]*g(i,5);` (ni-pred.ts:258-263) | DIFF |
| 361 | `}` (nipred.c:124) | `}` (ni-pred.ts:264) | MATCH |
| 362 | `break;` (nipred.c:125) | `return true;` (ni-pred.ts:265) | DIFF |
| 363 | `case 6:` (nipred.c:126) | `case 6:` combined with `default:` (ni-pred.ts:266-267) | DIFF — ngspice default returns E_ORDER; ours falls through to order-6 body |
| 364 | `for (i = 0; i <= size; i++) {` (nipred.c:127) | `for (let i = 0; i < nodeCount; i++) {` (ni-pred.ts:268) | DIFF |
| 365 | `ckt->CKTpred[i] = ckt->CKTrhs[i] = sum_{j=0..6} agp[j]*sols[j][i];` (nipred.c:128-135) | `out[i] = agp[0]*g(i,0) + ... + agp[6]*g(i,6);` (ni-pred.ts:269-275) | DIFF |
| 366 | `}` (nipred.c:136) | `}` (ni-pred.ts:276) | MATCH |
| 367 | `break;` (nipred.c:137) | `return true;` (ni-pred.ts:277) | DIFF |
| 368 | `default: return(E_ORDER);` (nipred.c:138-139) | collapsed into case 6 (ni-pred.ts:266-267) | DIFF — ngspice errors; ours silently uses order-6 formula |
| 369 | `}` end inner switch (nipred.c:140) | `}` (ni-pred.ts:278) | MATCH |
| 370 | `break;` end GEAR (nipred.c:141) | implicit | MATCH |
| 371 | `default: return(E_METHOD);` (nipred.c:143-144) | absent — else branch unconditionally runs GEAR | DIFF |
| 372 | `}` end method switch (nipred.c:145) | `}` (ni-pred.ts:208) | MATCH |
| 373 | `return(OK);` (nipred.c:147) | each branch returns boolean individually | DIFF |
| 374 | `#else int Dummy_Symbol; #endif` (nipred.c:150-152) | absent | DIFF |

## 4. LTE factor tables

Note: The LTE factor tables are NOT in `integration.ts` or `ni-pred.ts`. They live in `src/solver/analog/ckt-terr.ts` (lines 37-47). Mapped here per task requirement, with the caveat that this is outside the declared scope of the two mapped files.

| # | ngspice LTE table (trdefs.h / geardefs.h) | our TS (ckt-terr.ts) | Status |
|---|-------------------|--------|--------|
| 375 | trapezoidal LTE trapCoeff[0] = 0.5 (order=1) | `const TRAP_LTE_FACTOR_0 = 0.5;` (ckt-terr.ts:37) | MATCH (value) |
| 376 | trapezoidal LTE trapCoeff[1] = 1/12 (order=2) | `const TRAP_LTE_FACTOR_1 = 1 / 12;` (ckt-terr.ts:38) | MATCH (value) |
| 377 | trapezoidal LTE trapCoeff[2..6] (ngspice higher-order slots, unused in trap) | absent — TRAP only stores orders 1 and 2 (ckt-terr.ts:37-38) | DIFF — missing higher-order entries |
| 378 | gear LTE gearCoeff[0] = 0.5 (BDF-1) | `const GEAR_LTE_FACTOR_0 = 0.5;` (ckt-terr.ts:45); also `GEAR_LTE_FACTORS[0] = 0.5` (ckt-terr.ts:47) | MATCH (value) — duplicated in scalar and array form |
| 379 | gear LTE gearCoeff[1] = 2/9 (BDF-2) | `const GEAR_LTE_FACTOR_1 = 2 / 9;` (ckt-terr.ts:46); `GEAR_LTE_FACTORS[1] = 2/9` (ckt-terr.ts:47) | MATCH (value) |
| 380 | gear LTE gearCoeff[2] = 3/22 (order=3) | `GEAR_LTE_FACTORS[2] = 3 / 22` (ckt-terr.ts:47) | MATCH (value) |
| 381 | gear LTE gearCoeff[3] = 12/125 (order=4) | `GEAR_LTE_FACTORS[3] = 12 / 125` (ckt-terr.ts:47) | MATCH (value) |
| 382 | gear LTE gearCoeff[4] = 10/137 (order=5) | `GEAR_LTE_FACTORS[4] = 10 / 137` (ckt-terr.ts:47) | MATCH (value) |
| 383 | gear LTE gearCoeff[5] = 20/343 (order=6) | `GEAR_LTE_FACTORS[5] = 20 / 343` (ckt-terr.ts:47) | MATCH (value) |
| 384 | n/a — ngspice has no duplicated scalar copy of coefficients | duplicated scalars `GEAR_LTE_FACTOR_0`, `GEAR_LTE_FACTOR_1` AND array `GEAR_LTE_FACTORS` (ckt-terr.ts:45-47) | DIFF — structural duplication with no ngspice analog |
| 385 | n/a — LTE table is OUTSIDE integration.ts + ni-pred.ts per task scope | (none in integration.ts or ni-pred.ts) | DIFF — task scope files do not carry LTE tables; lives in ckt-terr.ts |

## Summary statistics

| Section | Rows | MATCH | DIFF |
|---------|-----:|------:|-----:|
| 1. NIcomCof vs computeNIcomCof + solveGearVandermonde + computeIntegrationCoefficients | 121 | 40 | 81 |
| 2. NIintegrate vs integrateCapacitor + integrateInductor | 98 | 9 | 89 |
| 3a. NIcomCof PREDICTOR vs computeAgp + _computeAgpGear | 68 | 15 | 53 |
| 3b. NIpred vs predictVoltages + _predictVoltagesGear | 87 | 19 | 68 |
| 4. LTE factor tables (ckt-terr.ts — out of strict scope) | 11 | 8 | 3 |
| **TOTAL** | **385** | **91** | **294** |

Row IDs run 1..385 contiguously (no gaps).

## Notable findings that should be addressed in follow-up work

1. **Row 110**: `computeIntegrationCoefficients` returns `ag1 = -ag0` for trapezoidal order 2, which differs from ngspice (`ag[1] = xmu/(1-xmu)`, not `-ag[0]`). This helper is used for snapshot capture (see comment at integration.ts:468-469) — any code that reads its `ag1` for reconstruction will disagree with what `computeNIcomCof` actually stored at integration.ts:435.

2. **Row 145**: `integrateCapacitor` / `integrateInductor` trapezoidal order-2 uses `ccap = ag[0]*(q0-q1) - ccapPrev` with fixed coefficient `-1` on ccapPrev, whereas ngspice uses `ccap = -ag[1]*ccapPrev + ag[0]*(q0-q1)` where `ag[1] = xmu/(1-xmu)`. These agree ONLY for xmu==0.5. Since our `xmu` defaults to 0.5 in the function signature (integration.ts:31, 92) they coincide in practice, but any non-0.5 override silently produces wrong ccap.

3. **Row 214**: `ceq` formula `ccap - geq*vNow` differs from ngspice `ccap - ag[0]*q0` whenever the relationship `vNow == q0/C` does not hold — e.g. first step after a DC-OP seed where vNow is set but q0 history is not yet aligned, or any nonlinear-capacitance case.

4. **Rows 242-250**: `_computeAgpGear` builds a DIFFERENT matrix than ngspice (factorial-divided Taylor vs raw Vandermonde). Specifically ngspice `mat[j][i] = (arg/delta)^j` (no factorial), ours `mat[i][j] = t^j / j!`. This yields a different (transposed) linear system; the result coefficients will only coincide if the two systems are mathematically equivalent after transposition with factorial scaling — which is NOT the case for a general solve. Since this path is dead code for our engine per the comment at ni-pred.ts:16-19, runtime impact is zero, but the file claims "exact ngspice parity" which this violates.

5. **Rows 91-105, 112-120**: the BDF-2 closed-form branch in `computeNIcomCof` AND its duplicate in `computeIntegrationCoefficients` hard-codes `r1 = 1` assuming `deltaOld[0] == dt`. In ngspice, `CKTdeltaOld[0]` is rotated in `setDeltaOldCurrent` to equal `CKTdelta` at precisely this call-site, so this assumption is conventionally safe — but it is undocumented and would silently produce wrong coefficients if the caller ever invokes these functions before rotating deltaOld.

6. **Row 21 / Row 88 / Row 90 / Row 149 / Row 171 / Row 180 / Row 223 / Row 327 / Row 368 / Row 371**: our code silently accepts invalid orders / unknown methods that ngspice rejects with E_ORDER/E_METHOD. Invalid input paths are undefined behaviour rather than explicit errors.

7. **Dual-write pattern** (rows 308, 324, 338, 344, 350, 355, 360, 365): ngspice NIpred writes both `CKTpred[i]` AND `CKTrhs[i]`, effectively seeding the NR starting point to the predicted voltage. Ours writes only `out[]`. Whether this is a diff depends on how `out[]` is consumed downstream by our NR loop as initial guess.
