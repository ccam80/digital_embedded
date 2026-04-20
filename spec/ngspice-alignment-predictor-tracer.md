# ngspice alignment — PREDICTOR tracer (authoritative verdict)

_Extracted from inline agent output (agent id `acce6a350ba9d4402`). Content verbatim below._

---

## 1. Definition & Default Status

| Where | Evidence |
|---|---|
| `configure.ac:81-82` | `AC_ARG_ENABLE([predictor], ...)` — opt-in flag `--enable-predictor` |
| `configure.ac:806-808` | `if test "x$enable_predictor" = xyes; then AC_DEFINE([PREDICTOR], ...)` — only defined if flag explicitly passed |
| `#define PREDICTOR` anywhere in `src/` | **No matches** — never hardcoded |
| `#undef PREDICTOR` anywhere in `src/` | **No matches** |

`PREDICTOR` is defined **only** when `./configure --enable-predictor` is passed. The default build does **not** define it. There is no `config.h.in` override.

---

## 2. Per-File Branch Table

| File:line | Directive | Block contents | Defined? | Undefined? |
|---|---|---|---|---|
| `maths/ni/nipred.c:19` | `#ifdef PREDICTOR` | Entire body of `NIpred()` — node-voltage predictor using CKTsols[] ring buffer | INCLUDED | excluded (stub `int Dummy_Symbol`) |
| `maths/ni/nireinit.c:25` | `#ifdef PREDICTOR` | Local variable `int i` declaration | included | excluded |
| `maths/ni/nireinit.c:36` | `#ifdef PREDICTOR` | Allocate `CKTpred[size+1]` and 8× `CKTsols[i][size+1]` arrays | INCLUDED | excluded (arrays never allocated) |
| `maths/ni/nicomcof.c:129` | `#ifdef PREDICTOR` | Compute Adams-Bashford (trap) and Gear predictor coefficient arrays `CKTagp[]` | INCLUDED | excluded (coefficients never computed) |
| `spicelib/analysis/dctran.c:750` | `#ifdef PREDICTOR` | Call `NIpred(ckt)` after `NIcomCof`, before first NR iteration of each timestep | INCLUDED | excluded (`NIpred` never called) |
| `spicelib/analysis/dcpss.c:1356` | `#ifdef PREDICTOR` | Same `NIpred(ckt)` call in PSS analysis loop | INCLUDED | excluded |
| `spicelib/devices/cktaccept.c:26` | `#ifdef PREDICTOR` | Declare `double *temp; int size` | included | excluded |
| `spicelib/devices/cktaccept.c:39` | `#ifdef PREDICTOR` | Rotate `CKTsols[]` ring buffer and copy `CKTrhs` into `CKTsols[0]` on accepted timestep | INCLUDED | excluded (ring buffer never updated) |
| `frontend/misccoms.c:248` | `#ifdef PREDICTOR` | Enable-predictor status message in `.options` output | included | excluded |
| **Device load files — `#ifndef PREDICTOR` blocks (MODEINITPRED branch):** | | | | |
| `devices/dio/dioload.c:140` | `#ifndef PREDICTOR` | `MODEINITPRED`: copy state1→state0 voltages/currents, call `DEVpred()` for `vd` | EXCLUDED | INCLUDED |
| `devices/dio/dioload.c:153` | `#ifndef PREDICTOR` | Closing `}` of the MODEINITPRED else branch | EXCLUDED | INCLUDED |
| `devices/bjt/bjtload.c:126` | `#ifndef PREDICTOR` | Declare `double xfact` | EXCLUDED | INCLUDED |
| `devices/bjt/bjtload.c:277` | `#ifndef PREDICTOR` | `MODEINITPRED`: `xfact=delta/deltaOld[1]`, copy state1→state0 for vbe/vbc/cc/cb/gpi/gmu/gm/go/gx/vsub; extrapolate `vbe=(1+xfact)*state1-xfact*state2` | EXCLUDED | INCLUDED |
| `devices/bjt/bjtload.c:320` | `#ifndef PREDICTOR` | Closing `}` of BJT MODEINITPRED branch | EXCLUDED | INCLUDED |
| `devices/jfet/jfetload.c:69` | `#ifndef PREDICTOR` | Declare `double xfact` | EXCLUDED | INCLUDED |
| `devices/jfet/jfetload.c:124` | `#ifndef PREDICTOR` | `MODEINITPRED`: `xfact`, copy state1→state0 for vgs/vgd/cg/cd/cgd/gm/gds/ggs/ggd; extrapolate `vgs=(1+xfact)*state1-xfact*state2` | EXCLUDED | INCLUDED |
| `devices/jfet/jfetload.c:162` | `#ifndef PREDICTOR` | Closing `}` of JFET MODEINITPRED branch | EXCLUDED | INCLUDED |
| `devices/mos1/mos1load.c:72` | `#ifndef PREDICTOR` | Declare `double xfact = 0.0` | EXCLUDED | INCLUDED |
| `devices/mos1/mos1load.c:205` | `#ifndef PREDICTOR` | `MODEINITPRED\|MODEINITTRAN`: `xfact`, copy state1→state0 for vbs/vgs/vds/vbd; extrapolate all three voltages `(1+xfact)*state1-xfact*state2` | EXCLUDED | INCLUDED |
| `devices/mos1/mos1load.c:240` | `#ifndef PREDICTOR` | Closing `}` | EXCLUDED | INCLUDED |
| `devices/mos1/mos1load.c:827` | `#ifndef PREDICTOR` | `MODEINITPRED\|MODEINITTRAN`: extrapolate charge states qgs/qgd/qgb using same `xfact` formula | EXCLUDED | INCLUDED |
| `devices/mos1/mos1load.c:853` | `#ifndef PREDICTOR` | Closing `}` | EXCLUDED | INCLUDED |
| `devices/cap/capload.c:53` | `#ifndef PREDICTOR` | `MODEINITPRED`: copy `state1[CAPqcap]→state0[CAPqcap]` (bcopy state1→state0) | EXCLUDED | INCLUDED |
| `devices/cap/capload.c:64` | `#ifndef PREDICTOR` | Closing `}` | EXCLUDED | INCLUDED |
| `devices/ind/indload.c:93` | `#ifndef PREDICTOR` | `MODEINITPRED`: copy `state1[INDflux]→state0[INDflux]` (bcopy state1→state0) | EXCLUDED | INCLUDED |
| `devices/ind/indload.c:103` | `#ifndef PREDICTOR` | Closing `}` | EXCLUDED | INCLUDED |
| `devices/vbic/vbicload.c:56` | `#ifndef PREDICTOR` | Declare `double xfact` | EXCLUDED | INCLUDED |
| `devices/vbic/vbicload.c:404` | `#ifndef PREDICTOR` | `MODEINITPRED`: `xfact`, extrapolate all 9 junction voltages (Vbei, Vbex, Vbci, Vbcx, Vbep, Vrci, Vrbi, Vrbp, Vbcp) via `(1+xfact)*state1-xfact*state2` | EXCLUDED | INCLUDED |
| `devices/vbic/vbicload.c:553` | `#ifndef PREDICTOR` | Closing `}` | EXCLUDED | INCLUDED |

---

## 3. Net Semantic Difference

**Does `NIpred()` run?**
- PREDICTOR **defined**: `NIpred()` is called in `dctran.c:751` once per timestep, after `NIcomCof()` and before the first NR iteration. It writes extrapolated node voltages into `CKTrhs[]` and `CKTpred[]` based on `CKTsols[]` history.
- PREDICTOR **undefined**: `NIpred()` contains only `int Dummy_Symbol` — the function body is absent. The call in `dctran.c:750-752` is inside `#ifdef PREDICTOR` and therefore never emitted. `NIpred()` does not run.

**What happens under `MODEINITPRED` in device load functions?**

- PREDICTOR **undefined** (default): the `#ifndef PREDICTOR` blocks are **active**. When `CKTmode & MODEINITPRED`:
  - Nonlinear devices (bjt, jfet, mos1, vbic): copy prior state (`state1→state0`) for all saved quantities, then form a linearly extrapolated voltage using `xfact = CKTdelta/CKTdeltaOld[1]`: `v_pred = (1+xfact)*state1 - xfact*state2`.
  - Passive reactive devices (cap, ind): copy `state1→state0` for the charge/flux state slot only (no extrapolation formula — just a straight bcopy).
  - Diode: calls `DEVpred(ckt, DIOvoltage)` (a helper that does the same extrapolation pattern), and copies state1→state0 for current and conductance slots.

- PREDICTOR **defined**: the `#ifndef PREDICTOR` blocks are **excluded**. Under `MODEINITPRED`, devices fall through to the ordinary `else` branch — they read `CKTrhsOld` node voltages directly, with no extrapolation and no state copy.

**Is there any state1→state0 bcopy under `MODEINITPRED`?**
- PREDICTOR **undefined**: YES — in every device load file listed above (`cap`, `ind`, `bjt`, `jfet`, `mos1`, `vbic`, `dio`). The copy `*(CKTstate0 + slot) = *(CKTstate1 + slot)` precedes the extrapolation.
- PREDICTOR **defined**: NO — the entire `MODEINITPRED` branch including the copy is inside `#ifndef PREDICTOR` and is excised.

**Is there any `xfact`-based linear extrapolation `(1+xfact)*state1 - xfact*state2`?**
- PREDICTOR **undefined**: YES — in `bjt/bjtload.c:279-305`, `jfet/jfetload.c:126-148`, `mos1/mos1load.c:210-225` and `827-836`, `vbic/vbicload.c:406-424`, and via `DEVpred()` in `dio/dioload.c:144`. All gated by `#ifndef PREDICTOR`.
- PREDICTOR **defined**: NO — `xfact` is declared inside `#ifndef PREDICTOR` and these blocks are not compiled in. Instead, `NIpred()` supplies the full-circuit node-voltage prediction via `CKTsols[]` before the load step begins, so devices never need to do per-device extrapolation.

---

## 4. Final Verdict

In the default ngspice build, `PREDICTOR` is **UNDEFINED**, which means per-device `MODEINITPRED` handling uses per-element `xfact`-based linear extrapolation (`(1+xfact)*state1 - xfact*state2`) with a state1→state0 copy, while the global `NIpred()` node-voltage predictor, the `CKTsols[]` ring buffer, and the `CKTpred[]` array are all compiled out and never execute.
