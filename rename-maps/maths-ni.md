# Rename map — maths-ni (Newton-Raphson, integration, convergence)

ngspice identifier → digiTS identifier, for the `maths-ni` port unit
(niaciter.c, nicomcof.c, niconv.c, niinit.c, niinteg.c, niiter.c).

> Note: the pre-created stub for this unit was **absent** on disk when the
> applier ran (`rename-maps/` did not exist). The file is recreated here so the
> mappings used during this unit stay documented. Per `TASK.md` §7 the verifier
> does **not** consume this map (it re-derives equivalence independently), so a
> recreated-rather-than-edited stub cannot produce a false `APPLIED`.

## niinteg.c::NIintegrate → ni-integrate.ts `niIntegrate`

`#h001` is a trailing-whitespace-only change inside the TRAP order-1/order-2
expressions; our TS already matches v41 arithmetic operand-for-operand, so the
TRAP portion is a zero-line delta. The GEAR branch is rewritten to mirror the
v41 case fall-through accumulation order (niinteg.c:43-64): `ccap=0`, then add
highest-order term first (`ag[order]*state[order]`) down to `ag[1]*state1` then
`ag[0]*state0` last.

| ngspice | digiTS |
|---|---|
| `ckt->CKTstate0[ccap]` | `ccap` (returned) |
| `ckt->CKTstate1[ccap]` | `ccapPrev` |
| `ckt->CKTstate0[qcap]` | `q0` |
| `ckt->CKTstate1[qcap]` | `q1` |
| `ckt->CKTstate2[qcap]` … `ckt->CKTstate6[qcap]` | `qHistory[0]` … `qHistory[4]` |
| `ckt->CKTag[0]` | `ag[0]` |
| `ckt->CKTag[1]` | `ag[1]` |
| `ckt->CKTag[k]` (k=2..6) | `ag[k]` |
| `ckt->CKTintegrateMethod` (TRAPEZOIDAL) | `method === "trapezoidal"` |
| `ckt->CKTintegrateMethod` (GEAR) | `method === "gear"` |
| `ckt->CKTorder` | `order` |
| TRAP `default: return(E_ORDER)` (niinteg.c:36-39) | `else { throw new Error(...E_ORDER) }` (TRAP `order!=1&&order!=2`) |
| GEAR `default: return(E_ORDER)` (niinteg.c:66-67) | `if (order < 1 \|\| order > 6) throw new Error(...E_ORDER)` |
| `return(E_METHOD)` (niinteg.c:75) | `else { throw new Error(...E_METHOD) }` (method neither trap nor gear) |

## Identifiers referenced in the escalated groups (for cross-hunk consistency)

These groups are ESCALATED (see `ESCALATIONS.md` ESC-002…ESC-006); the mappings
below are recorded for consistency, not as evidence of an apply.

| ngspice | digiTS | unit |
|---|---|---|
| `ckt->CKTrhs` / `CKTrhsOld` (DC/tran ping-pong) | `ctx.rhs` / `ctx.rhsOld` (newton-raphson.ts) | niiter |
| `ckt->CKTrhs` / `CKTirhs` (AC, complex) | `rhsRe` / `rhsIm` (ac-analysis.ts) | niaciter |
| solution buffers (AC) | `solRe` / `solIm` (ac-analysis.ts) | niaciter |
| `ckt->CKTxmu` | `xmu` (computeNIcomCof param) | nicomcof |
| `ckt->CKTag[]` | `ag` (Float64Array) | nicomcof |
| `ckt->CKTdelta` | `dt` | nicomcof |
| `ckt->CKTdeltaOld[i]` | `deltaOld[i]` | nicomcof |
| `SMPnewMatrix(&ckt->CKTmatrix, …)` | `solver._initStructure()` (ckt-context.ts) | niinit |
| `NIconvTest` (standalone fn) | inlined STEP-H scan in `newtonRaphson` | niconv |
| `ckt->CKTtroubleNode` | `ctx.troubleNode` (ckt-context.ts) | niconv |
| `ckt->CKTtroubleElt` | _no counterpart_ | niconv |
| `ft_ngdebug` | _no counterpart_ | niconv |
| `msgcount` (file-static) | _no counterpart_ | niiter |
| `NIresetwarnmsg()` | _no counterpart_ | niiter |
| `OldCKTstate0` | `oldState0` / `ctx.dcopOldState0` | niiter |
| `ckt->CKTnoncon` | `ctx.noncon` | niiter |
| `ckt->CKTmode` | `ctx.cktMode` | niiter |
