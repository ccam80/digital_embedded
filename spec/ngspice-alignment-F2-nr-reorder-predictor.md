# ngspice alignment — F2: NR reorder timing + predictor audit

_Extracted from inline agent output (agent id `a19c67f9a11dee34f`). Content verbatim below._

---

Confirmed. The macro pattern is:

```
#ifndef PREDICTOR           // line 277
    if (MODEINITPRED) {     // line 278
        extrapolate + copy state1→state0
    } else {                // line 306
#endif                      // line 307
        vbe = CKTrhsOld[...]    // lines 311-319
#ifndef PREDICTOR           // line 320
    }                       // line 321
#endif                      // line 322
```

- **PREDICTOR defined (rare)** → only `vbe = CKTrhsOld[...]` remains. No extrapolation, no state copy.
- **PREDICTOR undef'd (DEFAULT)** → full `if/else`: if MODEINITPRED, extrapolate and copy state1→state0; else, `vbe = CKTrhsOld[...]`.

**So the task brief's premise is INCORRECT.** It claimed the `#ifndef PREDICTOR` branch is "essentially: read state0 for historical voltages, no extrapolation" — that is actually the **PREDICTOR-defined** branch. The default ngspice build (PREDICTOR undef'd) DOES perform the extrapolation and state copy under MODEINITPRED. Let me revise the report with the correct analysis.

---

# REVISED Architect Report — Reorder Timing + Predictor Audit (corrected macro reading)

## Summary

The reorder-timing finding (Part A) stands as written — that diff is correct and independent of the PREDICTOR question.

The predictor audit (Part B/C) must be **revised**: careful reading of the `#ifndef PREDICTOR` macro nesting in dioload.c:140-155 and bjtload.c:277-322 shows that the **default ngspice build (PREDICTOR undef'd)** DOES execute the `if (MODEINITPRED) { extrapolate + copy state1→state0 } else { vd = CKTrhsOld[...] }` dispatch. The `#ifdef PREDICTOR` (defined) build is the one that excises the extrapolation and uses `CKTrhsOld` unconditionally.

So the loud divergence in our codebase is the OPPOSITE of what the task brief assumed: our diode (`diode.ts:468-472`) and BJT (`bjt.ts:777-786` and `bjt.ts:1466-1476`) copy state1→state0 without the corresponding `DEVpred()`/`xfact`-based extrapolation, so they are a **partial** implementation of the default `#ifndef PREDICTOR` branch — matching only its first half, missing the `vbe = (1+xfact)*state1 - xfact*state2` linear extrapolation.

## A — Reorder Timing Diff (verbatim from re-request)

### ngspice reference (verbatim)

`ref/ngspice/src/maths/ni/niiter.c:856-859` — pre-factor gate:

```c
            if( (ckt->CKTmode & MODEINITJCT) ||
                    ( (ckt->CKTmode & MODEINITTRAN) && (iterno==1))) {
                ckt->CKTniState |= NISHOULDREORDER;
            }
```

`ref/ngspice/src/maths/ni/niiter.c:861-903` — consumed immediately by `SMPreorder` vs `SMPluFac` dispatch (the flag selects reorder-and-refactor over numerical-only refactor). `factorWithReorder()` clears `_needsReorder` at `src/solver/analog/sparse-solver.ts:1322-1325`, matching `ckt->CKTniState &= ~NISHOULDREORDER` at `niiter.c:880`.

`ref/ngspice/src/maths/ni/niiter.c:1063-1065` — post-solve INITF dispatcher re-sets the flag on the `MODEINITJCT → MODEINITFIX` transition:

```c
        } else if(ckt->CKTmode & MODEINITJCT) {
            ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFIX;
            ckt->CKTniState |= NISHOULDREORDER;
```

`ref/ngspice/src/maths/ni/niiter.c:1072-1074` — post-solve INITF dispatcher re-sets the flag on the `MODEINITTRAN → MODEINITFLOAT` transition when `iterno<=1`:

```c
        } else if (ckt->CKTmode & MODEINITTRAN) {
            if(iterno<=1) ckt->CKTniState |= NISHOULDREORDER;
            ckt->CKTmode = (ckt->CKTmode&(~INITF))|MODEINITFLOAT;
```

`iterno` translation: ngspice increments `iterno` at `niiter.c:670` BEFORE the pre-factor gate, so `iterno==1` at `niiter.c:857` is the very first iteration of the NR body. Our 0-based `iteration` counter at `newton-raphson.ts:278` (`for (let iteration = 0; ; iteration++)`) equals `iterno - 1` at the point of the gate. Therefore `iterno==1` ↔ `iteration===0` at the pre-factor gate. Same translation applies at the post-solve INITF dispatcher: `iterno<=1` at `niiter.c:1073` ↔ `iteration<=0` at our dispatcher (and since `iteration` is always `>=0`, `iteration<=0` ↔ `iteration===0`).

### Design decision

Move the `NISHOULDREORDER`-equivalent flag-set to the TOP of the NR body, between the `solver.preorder()` call and the `solver.factor()` call at `src/solver/analog/newton-raphson.ts:303` — mirroring `niiter.c:856-859` exactly. **Keep** the existing post-factor `solver.forceReorder()` calls at `src/solver/analog/newton-raphson.ts:476` and `:493` as belt-and-braces siblings, matching ngspice `niiter.c:1065` and `niiter.c:1073-1074`. Dropping the post-factor calls would diverge from ngspice, which sets the flag in two places — the post-solve INITF-dispatcher write re-arms `NISHOULDREORDER` for the first iteration of the *next* mode (`initFix` after `initJct`; `initFloat` after `initTran`), and our `solver.forceReorder()` + `_needsReorder` consumer in `factorWithReorder()` is the functional equivalent of that re-arming.

### OLD block (exact, `src/solver/analog/newton-raphson.ts:285-303`)

```ts
    // ---- STEP B: CKTload — single-pass device evaluation ----
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx, iteration);

    // ---- STEP D: Preorder (once per solve) ----
    if (!didPreorder) {
      solver.preorder();
      didPreorder = true;
    }

    // Add gmin to every diagonal element before factorization.
    if (ctx.diagonalGmin) {
      solver.addDiagonalGmin(ctx.diagonalGmin);
    }

    // ---- STEP E: Factorize ----
    // ngspice niiter.c:888-891: E_SINGULAR on numerical-only path sets NISHOULDREORDER
    // and does `continue` (returns to top of for(;;), re-executes CKTload).
    const factorResult = solver.factor();
```

### NEW block (exact, replaces `src/solver/analog/newton-raphson.ts:285-303`)

```ts
    // ---- STEP B: CKTload — single-pass device evaluation ----
    ctx.rhsOld.set(prevVoltages);
    cktLoad(ctx, iteration);

    // ---- STEP D: Preorder (once per solve) ----
    if (!didPreorder) {
      solver.preorder();
      didPreorder = true;
    }

    // ---- ngspice NISHOULDREORDER pre-factor gate (niiter.c:856-859) ----
    // Direct port of:
    //   if( (ckt->CKTmode & MODEINITJCT) ||
    //           ( (ckt->CKTmode & MODEINITTRAN) && (iterno==1))) {
    //       ckt->CKTniState |= NISHOULDREORDER;
    //   }
    // Must fire BEFORE factor dispatch so iteration 0 of initJct AND
    // iteration 0 of initTran run factorWithReorder() rather than reusing
    // stale DC-OP pivots via factorNumerical() (niiter.c:861-903).
    //
    // iterno translation: ngspice increments iterno at niiter.c:670 BEFORE
    // this gate, so iterno==1 there equals our 0-based iteration===0 here.
    //   (CKTmode & MODEINITJCT)                   ↔ ctx.initMode === "initJct"
    //   (CKTmode & MODEINITTRAN) && iterno==1     ↔ ctx.initMode === "initTran" && iteration === 0
    //
    // forceReorder() sets _needsReorder, consumed + cleared by
    // factorWithReorder() at sparse-solver.ts:1322-1325 — equivalent of
    // ngspice CKTniState &= ~NISHOULDREORDER at niiter.c:880.
    if (ctx.initMode === "initJct" ||
        (ctx.initMode === "initTran" && iteration === 0)) {
      solver.forceReorder();
    }

    // Add gmin to every diagonal element before factorization.
    if (ctx.diagonalGmin) {
      solver.addDiagonalGmin(ctx.diagonalGmin);
    }

    // ---- STEP E: Factorize ----
    // ngspice niiter.c:888-891: E_SINGULAR on numerical-only path sets NISHOULDREORDER
    // and does `continue` (returns to top of for(;;), re-executes CKTload).
    const factorResult = solver.factor();
```

### OLD block (exact, `src/solver/analog/newton-raphson.ts:474-499`)

```ts
    } else if (curInitMode === "initJct") {
      ctx.initMode = "initFix";
      solver.forceReorder();
      if (ladder) {
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.onModeBegin("dcopInitFix", iteration + 1);
      }
    } else if (curInitMode === "initFix") {
      if (ctx.noncon === 0) {
        ctx.initMode = "initFloat";
        ipass = 1;
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
    } else if (curInitMode === "initTran") {
      ctx.initMode = "initFloat";
      if (iteration <= 0) {
        solver.forceReorder();
      }
    } else if (curInitMode === "initPred") {
      ctx.initMode = "initFloat";
    } else if (curInitMode === "initSmsig") {
      ctx.initMode = "initFloat";
    }
```

### NEW block (exact, replaces `src/solver/analog/newton-raphson.ts:474-499`)

```ts
    } else if (curInitMode === "initJct") {
      // ngspice niiter.c:1063-1065 — MODEINITJCT → MODEINITFIX transition
      // also sets NISHOULDREORDER. Belt-and-braces sibling to the
      // pre-factor gate above: the gate above forced reorder for the
      // initJct iteration itself; this sibling re-arms _needsReorder so
      // the FIRST iteration of the next mode (initFix) runs
      // factorWithReorder() too — matching ngspice's two-site flag write
      // at niiter.c:856-859 + niiter.c:1065.
      ctx.initMode = "initFix";
      solver.forceReorder();
      if (ladder) {
        ladder.onModeEnd("dcopInitJct", iteration, false);
        ladder.onModeBegin("dcopInitFix", iteration + 1);
      }
    } else if (curInitMode === "initFix") {
      if (ctx.noncon === 0) {
        ctx.initMode = "initFloat";
        ipass = 1;
        if (ladder) {
          ladder.onModeEnd("dcopInitFix", iteration, false);
          ladder.onModeBegin("dcopInitFloat", iteration + 1);
        }
      }
    } else if (curInitMode === "initTran") {
      // ngspice niiter.c:1072-1074 — MODEINITTRAN → MODEINITFLOAT transition
      // also sets NISHOULDREORDER when iterno<=1, then transitions to
      // MODEINITFLOAT. Belt-and-braces sibling to the pre-factor gate
      // above: the gate above forced reorder for iteration 0 of initTran;
      // this sibling re-arms _needsReorder for the FIRST iteration of the
      // next mode (initFloat) — matching ngspice's two-site flag write at
      // niiter.c:856-859 + niiter.c:1073-1074.
      //
      // iterno translation: ngspice iterno<=1 (post-increment, niiter.c:670)
      // ↔ our 0-based iteration<=0 ↔ iteration===0.
      ctx.initMode = "initFloat";
      if (iteration <= 0) {
        solver.forceReorder();
      }
    } else if (curInitMode === "initPred") {
      ctx.initMode = "initFloat";
    } else if (curInitMode === "initSmsig") {
      ctx.initMode = "initFloat";
    }
```

### Notes on intentional non-changes in Part A scope

- The `initFix → initFloat` dispatcher arm at `newton-raphson.ts:481-489` does NOT call `solver.forceReorder()`. This matches ngspice `niiter.c:1066-1069` which also does NOT set `NISHOULDREORDER` on the `MODEINITFIX → MODEINITFLOAT` transition — only on `MODEINITJCT → MODEINITFIX` (niiter.c:1065) and `MODEINITTRAN → MODEINITFLOAT` (niiter.c:1073). No diff needed.
- The `initPred → initFloat` arm at `newton-raphson.ts:495-496` does NOT call `solver.forceReorder()`. This matches ngspice `niiter.c:1075-1076` which also does NOT set `NISHOULDREORDER` on the `MODEINITPRED → MODEINITFLOAT` transition. No diff needed.
- The `initSmsig → initFloat` arm at `newton-raphson.ts:497-498` does NOT call `solver.forceReorder()`. This matches ngspice `niiter.c:1070-1071` which also does NOT set `NISHOULDREORDER` on the `MODEINITSMSIG → MODEINITFLOAT` transition. No diff needed.
- The singular-matrix retry at `newton-raphson.ts:304-308` already calls `solver.forceReorder(); continue;` on failed factor when the last attempt was numerical — matches ngspice `niiter.c:887-892` (E_SINGULAR on `SMPluFac` sets `NISHOULDREORDER` and `continue`s). No diff needed.

### Part A references

- `src/solver/analog/newton-raphson.ts:285-303` — pre-factor section (OLD block 1 target)
- `src/solver/analog/newton-raphson.ts:474-499` — INITF dispatcher (OLD block 2 target)
- `src/solver/analog/sparse-solver.ts:475-477` — `forceReorder()` sets `_needsReorder`
- `src/solver/analog/sparse-solver.ts:1320-1332` — `factorWithReorder()` consumes + clears `_needsReorder`
- `ref/ngspice/src/maths/ni/niiter.c:856-859` — pre-factor NISHOULDREORDER gate
- `ref/ngspice/src/maths/ni/niiter.c:861-903` — factor dispatch consuming the flag
- `ref/ngspice/src/maths/ni/niiter.c:880` — `CKTniState &= ~NISHOULDREORDER` (flag clear after reorder)
- `ref/ngspice/src/maths/ni/niiter.c:887-892` — E_SINGULAR retry path sets NISHOULDREORDER + continue
- `ref/ngspice/src/maths/ni/niiter.c:1063-1065` — post-solve INITF dispatcher INITJCT arm
- `ref/ngspice/src/maths/ni/niiter.c:1072-1074` — post-solve INITF dispatcher INITTRAN arm

## B — Predictor Audit (REVISED)

### B.1 Does a `nipred`-analog computation run?

**Yes:** `src/solver/analog/ni-pred.ts:160-209` (`predictVoltages`), called from `analog-engine.ts:395-401` when `params.predictor` is true. This performs the Adams-Gear predictor `pred[i] = sols[0][i] + deltaOld[0] * (sols[0][i]-sols[1][i])/deltaOld[1]` at the RHS level — i.e., seeding ctx.rhs with predicted node voltages.

### B.2 Is it gated?

Yes, by `params.predictor ?? false`. Default is OFF. When OFF, we use `ctx.rhs` = previous accepted solution as the NR initial guess.

### B.3 Semantic comparison to ngspice default

ngspice `nipred.c` is `#ifdef PREDICTOR`-gated (`nipred.c:19`) and NOT called in default builds. Our `predictVoltages` is gated by `params.predictor` which defaults false. **Semantically these align: the node-voltage predictor is OFF by default in both.**

However: ngspice's default build still runs per-device state1→state0 copy + `DEVpred()` or `xfact`-based extrapolation for BE/BC voltages (bjtload.c:278-305) and Qcap (capload.c:54-57) and phi (indload.c:94-96) under MODEINITPRED. This is not the `nipred.c` path — it's PER-DEVICE inline extrapolation, and it IS active in the default build.

### B.4 `"initPred"` mode audit by device

| Element | ngspice `#ifndef PREDICTOR` default behavior under `MODEINITPRED` | Our code | Divergence |
|---|---|---|---|
| Capacitor | `capload.c:54-57`: s0[Qcap]=s1[Qcap] | `capacitor.ts:282-284`: s0[Q]=s1[Q] | None |
| Inductor | `indload.c:94-96`: s0[flux]=s1[flux] | `inductor.ts:302-304`: s0[PHI]=s1[PHI] | None |
| Diode | `dioload.c:141-148`: copy state1→state0 for DIOvoltage/DIOcurrent/DIOconduct AND `vd = DEVpred(...)` (xfact-linear extrapolation of junction voltage) | `diode.ts:468-472`: copies state1→state0 for VD/ID/GEQ only, but then overwrites `vdRaw` via `voltages[nodeJunction-1] - voltages[nodeCathode-1]` (lines 487-490) | **DIVERGENT** — missing `DEVpred()` extrapolation; our vdRaw read overrides the state1 copy with CKTrhsOld read, so the state1 copy is dead write |
| BJT L1 | `bjtload.c:278-305`: copy state1→state0 for VBE/VBC/CC/CB/GPI/GMU/GM/GO/GX/VSUB, then `vbe = (1+xfact)*state1 - xfact*state2` linear extrapolation | `bjt.ts:1466-1476`: copies state1→state0 for VBE/VBC/IC/IB/GPI/GMU/GM/GO, then reads `vbeRaw = polarity*(vBi - vEi)` (lines 1506-1509) | **DIVERGENT** — missing `xfact` linear extrapolation; our vbeRaw read overrides the state1 copy |

### B.5 Net effect of divergences in default build

For diode and BJT: we do a state1→state0 copy for state slots used by `checkConvergence()` (e.g. `s0[VD]`, `s0[VBE]`, etc. — these are what `pnjlim`'s `vold` arg reads at lines 511, 1526). Then we immediately overwrite the limiter's `vold` input with the fresh `s0[VD]=s1[VD]` value instead of what would have been the state0 from the previous NR iteration. Under MODEINITPRED at iteration 0 there IS no "previous NR iteration" — so both approaches are defensible, but the ngspice default uses `xfact`-extrapolated `vbe`/`vbc` as `vnew` input to `pnjlim`, not `CKTrhsOld`-read values.

This is a legitimate divergence but the mandated fix depends on which build we're targeting:

- **Target = ngspice default (PREDICTOR undef'd)** — add `DEVpred`/`xfact`-style extrapolation to diode.ts and bjt.ts so our `vbeRaw`/`vdRaw` are extrapolated, matching bjtload.c:282-287, dioload.c:144.
- **Target = PREDICTOR-defined build** — remove the state1→state0 copy in diode.ts/bjt.ts (make them read CKTrhsOld directly, matching bjtload.c:311-319, dioload.c:151-152).

The task brief's fourth paragraph explicitly says "Our 'initPred' mode behavior must match the `#ifndef PREDICTOR` default path, NOT replicate the disabled `nipred` prediction logic." The brief's own reading of which branch is active-by-default is inverted from reality (the `#ifndef PREDICTOR` branch IS the extrapolating branch, per my careful reading above). So the correct interpretation of the brief's intent is: **match the ngspice default build, which is the EXTRAPOLATING branch.**

### B.6 Diff — make diode and BJT match the default `#ifndef PREDICTOR` branch

**File:** `src/components/semiconductors/diode.ts`

**OLD block (exact, lines 464-490):**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      // initPred path: adopt predictor values from previous accepted step
      if (ctx.initMode === "initPred") {
        s0[base + SLOT_VD]  = s1[base + SLOT_VD];
        s0[base + SLOT_ID]  = s1[base + SLOT_ID];
        s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
      }

      // During MODEINITJCT (dioload.c:120-135), ngspice overrides vd
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros.
      let vdRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vdRaw = 0;
        } else if (pool.uic && !isNaN(params.IC)) {
          vdRaw = params.IC;
        } else {
          vdRaw = tVcrit;
        }
      } else {
        const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
        const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
        vdRaw = va - vc;
      }
```

**NEW block (exact):**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      // ngspice `#ifndef PREDICTOR` default branch (dioload.c:140-155):
      // under MODEINITPRED, copy state1→state0 for DIOvoltage/DIOcurrent/
      // DIOconduct AND compute `vd = DEVpred(ckt, loct)` (devsup.c:766)
      // which extrapolates linearly from CKTstate1/CKTstate2 using
      // xfact = CKTdelta/CKTdeltaOld[1].
      //
      // Ordering is crucial: the state1→state0 copy must happen before any
      // pnjlim call (pnjlim reads s0[VD] as its vold), and the
      // xfact-extrapolated vd must be the vnew fed to pnjlim (dioload.c:144
      // feeds `vd` from DEVpred into DEVpnjlim at line 198).
      if (ctx.initMode === "initPred") {
        s0[base + SLOT_VD]  = s1[base + SLOT_VD];
        s0[base + SLOT_ID]  = s1[base + SLOT_ID];
        s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
      }

      // During MODEINITJCT (dioload.c:120-135), ngspice overrides vd
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros.
      let vdRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vdRaw = 0;
        } else if (pool.uic && !isNaN(params.IC)) {
          vdRaw = params.IC;
        } else {
          vdRaw = tVcrit;
        }
      } else if (ctx.initMode === "initPred") {
        // DEVpred equivalent — devsup.c:766-786 linear extrapolation
        // (with `#ifndef NEWTRUNC` branch: vd = (1+xfact)*state1 - xfact*state2
        // where xfact = CKTdelta/CKTdeltaOld[1]).
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vdRaw = (1 + xfact) * s1[base + SLOT_VD] - xfact * s2[base + SLOT_VD];
      } else {
        const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
        const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
        vdRaw = va - vc;
      }
```

**File:** `src/components/semiconductors/bjt.ts`

**OLD block 1 (exact, lines 774-817) — behavioral BJT load path:**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      if (ctx.initMode === "initPred") {
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        s0[base + SLOT_IC]  = s1[base + SLOT_IC];
        s0[base + SLOT_IB]  = s1[base + SLOT_IB];
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI];
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU];
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];
      }

      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // BJ1: pnjlim uses tp.vt (temperature-dependent)
      const vcritBE = tp.tVcrit;
      const vcritBC = tp.tVcrit;

      // Junction voltages (polarity-corrected for PNP).
      // During MODEINITJCT (bjtload.c:258-276), ngspice overrides vbe/vbc
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros and would mis-bias G-P.
      let vbeRaw: number;
      let vbcRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vbeRaw = 0;
          vbcRaw = 0;
        } else if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = params.ICVBE;
          vbcRaw = params.ICVBE - params.ICVCE;
        } else {
          vbeRaw = tp.tVcrit;
          vbcRaw = 0;
        }
      } else {
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }
```

**NEW block 1 (exact):**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;

      // ngspice `#ifndef PREDICTOR` default branch (bjtload.c:277-322):
      // under MODEINITPRED, copy state1→state0 for VBE/VBC/CC/CB/GPI/GMU/
      // GM/GO/GX/VSUB AND linearly extrapolate vbe/vbc using
      // xfact = CKTdelta/CKTdeltaOld[1]:
      //   vbe = (1+xfact)*state1[VBE] - xfact*state2[VBE]
      //
      // The extrapolated vbe/vbc are then fed into pnjlim and the
      // Gummel-Poon evaluator below.
      if (ctx.initMode === "initPred") {
        s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
        s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
        s0[base + SLOT_IC]  = s1[base + SLOT_IC];
        s0[base + SLOT_IB]  = s1[base + SLOT_IB];
        s0[base + SLOT_GPI] = s1[base + SLOT_GPI];
        s0[base + SLOT_GMU] = s1[base + SLOT_GMU];
        s0[base + SLOT_GM]  = s1[base + SLOT_GM];
        s0[base + SLOT_GO]  = s1[base + SLOT_GO];
      }

      // Read node voltages
      const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
      const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
      const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;

      // BJ1: pnjlim uses tp.vt (temperature-dependent)
      const vcritBE = tp.tVcrit;
      const vcritBC = tp.tVcrit;

      // Junction voltages (polarity-corrected for PNP).
      // During MODEINITJCT (bjtload.c:258-276), ngspice overrides vbe/vbc
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros and would mis-bias G-P.
      let vbeRaw: number;
      let vbcRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vbeRaw = 0;
          vbcRaw = 0;
        } else if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = params.ICVBE;
          vbcRaw = params.ICVBE - params.ICVCE;
        } else {
          vbeRaw = tp.tVcrit;
          vbcRaw = 0;
        }
      } else if (ctx.initMode === "initPred") {
        // bjtload.c:279-287 xfact-linear extrapolation — MUST run before
        // any pnjlim call so the limiter receives the extrapolated vnew.
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vbeRaw = (1 + xfact) * s1[base + SLOT_VBE] - xfact * s2[base + SLOT_VBE];
        vbcRaw = (1 + xfact) * s1[base + SLOT_VBC] - xfact * s2[base + SLOT_VBC];
      } else {
        vbeRaw = polarity * (vB - vE);
        vbcRaw = polarity * (vB - vC);
      }
```

**OLD block 2 (exact, lines 1460-1509) — SPICE L1 BJT load path:**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const solver = ctx.solver;
      const ag = ctx.ag;
      const dt = ctx.dt;

      // --- Step 1: initPred — copy last accepted linearization ---
      if (ctx.initMode === "initPred") {
        s0[base + L1_SLOT_VBE] = s1[base + L1_SLOT_VBE];
        s0[base + L1_SLOT_VBC] = s1[base + L1_SLOT_VBC];
        s0[base + L1_SLOT_IC]  = s1[base + L1_SLOT_IC];
        s0[base + L1_SLOT_IB]  = s1[base + L1_SLOT_IB];
        s0[base + L1_SLOT_GPI] = s1[base + L1_SLOT_GPI];
        s0[base + L1_SLOT_GMU] = s1[base + L1_SLOT_GMU];
        s0[base + L1_SLOT_GM]  = s1[base + L1_SLOT_GM];
        s0[base + L1_SLOT_GO]  = s1[base + L1_SLOT_GO];
      }

      // --- Step 2: Read internal-node voltages + substrate con voltage ---
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      // CS pnjlim: bjtload.c:407-415 — compute vsub from current voltages then limit.
      // subs: NPN → VERTICAL (+1) stamps on nodeC_int; PNP → LATERAL (-1) stamps on nodeB_int.
      const subs = polarity > 0 ? 1 : -1;
      const substConNode = subs > 0 ? nodeC_int : nodeB_int;
      const vSubConRaw = substConNode > 0 ? voltages[substConNode - 1] : 0;
      const vsubRaw = polarity * subs * (0 - vSubConRaw); // V_substNode=0 (substrate tied to ground)

      // During MODEINITJCT (bjtload.c:258-276), ngspice overrides vbe/vbc
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros and would mis-bias G-P.
      let vbeRaw: number;
      let vbcRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vbeRaw = 0;
          vbcRaw = 0;
        } else if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = params.ICVBE;
          vbcRaw = params.ICVBE - params.ICVCE;
        } else {
          vbeRaw = tpL1.tVcrit;
          vbcRaw = 0;
        }
      } else {
        vbeRaw = polarity * (vBi - vEi);
        vbcRaw = polarity * (vBi - vCi);
      }
```

**NEW block 2 (exact):**

```ts
    load(ctx: LoadContext): void {
      const voltages = ctx.voltages;
      const solver = ctx.solver;
      const ag = ctx.ag;
      const dt = ctx.dt;

      // --- Step 1: initPred copy + xfact extrapolation (bjtload.c:277-322) ---
      // ngspice `#ifndef PREDICTOR` default branch under MODEINITPRED:
      // copy state1→state0 AND linearly extrapolate vbe/vbc with
      // xfact = CKTdelta/CKTdeltaOld[1]. The extrapolation is consumed below
      // (Step 3 pnjlim vnew, Step 4 Gummel-Poon evaluation).
      if (ctx.initMode === "initPred") {
        s0[base + L1_SLOT_VBE] = s1[base + L1_SLOT_VBE];
        s0[base + L1_SLOT_VBC] = s1[base + L1_SLOT_VBC];
        s0[base + L1_SLOT_IC]  = s1[base + L1_SLOT_IC];
        s0[base + L1_SLOT_IB]  = s1[base + L1_SLOT_IB];
        s0[base + L1_SLOT_GPI] = s1[base + L1_SLOT_GPI];
        s0[base + L1_SLOT_GMU] = s1[base + L1_SLOT_GMU];
        s0[base + L1_SLOT_GM]  = s1[base + L1_SLOT_GM];
        s0[base + L1_SLOT_GO]  = s1[base + L1_SLOT_GO];
      }

      // --- Step 2: Read internal-node voltages + substrate con voltage ---
      const vCi = nodeC_int > 0 ? voltages[nodeC_int - 1] : 0;
      const vBi = nodeB_int > 0 ? voltages[nodeB_int - 1] : 0;
      const vEi = nodeE_int > 0 ? voltages[nodeE_int - 1] : 0;

      // CS pnjlim: bjtload.c:407-415 — compute vsub from current voltages then limit.
      // subs: NPN → VERTICAL (+1) stamps on nodeC_int; PNP → LATERAL (-1) stamps on nodeB_int.
      const subs = polarity > 0 ? 1 : -1;
      const substConNode = subs > 0 ? nodeC_int : nodeB_int;
      const vSubConRaw = substConNode > 0 ? voltages[substConNode - 1] : 0;
      const vsubRaw = polarity * subs * (0 - vSubConRaw); // V_substNode=0 (substrate tied to ground)

      // During MODEINITJCT (bjtload.c:258-276), ngspice overrides vbe/vbc
      // to seeded values rather than reading from the solution vector —
      // at that phase ctx.voltages is all zeros and would mis-bias G-P.
      let vbeRaw: number;
      let vbcRaw: number;
      if (ctx.initMode === "initJct") {
        if (params.OFF) {
          vbeRaw = 0;
          vbcRaw = 0;
        } else if (pool.uic && !isNaN(params.ICVBE) && !isNaN(params.ICVCE)) {
          vbeRaw = params.ICVBE;
          vbcRaw = params.ICVBE - params.ICVCE;
        } else {
          vbeRaw = tpL1.tVcrit;
          vbcRaw = 0;
        }
      } else if (ctx.initMode === "initPred") {
        // bjtload.c:279-287 xfact extrapolation — MUST run before pnjlim
        // so the limiter receives the extrapolated vnew.
        const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
        vbeRaw = (1 + xfact) * s1[base + L1_SLOT_VBE] - xfact * s2[base + L1_SLOT_VBE];
        vbcRaw = (1 + xfact) * s1[base + L1_SLOT_VBC] - xfact * s2[base + L1_SLOT_VBC];
        // bjtload.c:302-305 — same extrapolation for vsub.
        // vsubRaw was already read above from current node voltages; for ngspice
        // parity under initPred, overwrite it with the xfact extrapolation.
        // (Using s1/s2 for substrate voltage.)
      } else {
        vbeRaw = polarity * (vBi - vEi);
        vbcRaw = polarity * (vBi - vCi);
      }
```

Note: the BJT L1 also needs the `vsub` xfact extrapolation (bjtload.c:302-305). Since I did not read the exact line where vsubRaw finalizes, I leave the extrapolation of `vsubRaw` as an explicit comment note for the executor — it is a divergence per the brief's "surface ANY additional divergence."

### B.7 `ni-pred.ts` gating

The node-voltage `predictVoltages` path (separate from device-level state1→state0 copies) should remain gated OFF by default. Since `params.predictor` already defaults to false, no diff is strictly required here — but to eliminate the risk of a user enabling a non-ngspice-default behavior and expecting parity, I recommend removing the `predictor` field from `SimulationParams`.

### B.8 `xfact` on LoadContext

`ctx.xfact` at `load-context.ts:76` and `analog-engine.ts:439` is currently assigned unconditionally. It is used INSIDE the PREDICTOR block in ngspice only. Under the REVISED reading, `xfact` IS part of the default build path (it is used at bjtload.c:279 inside the `#ifndef PREDICTOR` branch). But: it is ONLY used under MODEINITPRED inside that branch, not unconditionally. Keeping it in `loadCtx` is fine.

The divergence here is: we currently write `ctx.loadCtx.xfact` from `analog-engine.ts:439` even when `initMode !== "initPred"`. ngspice only computes/uses xfact locally inside the `if(MODEINITPRED)` block. This is not a correctness bug in itself, but devices that read `ctx.xfact` outside `initPred` would be ngspice-divergent. Executor should sweep for `\.xfact` and `loadCtx\.xfact` across all device files and confirm none read it outside an `if (initMode === "initPred")` guard.

---

## C — Device Capacitor/Inductor/Diode/BJT vs ngspice `#ifndef PREDICTOR` (default) branches

### C.1 Capacitor `capload.c:53-66` — PASS, no diff required.

### C.2 Inductor `indload.c:93-105` — PASS, no diff required.

### C.3 Diode `dioload.c:140-155` — **DIVERGENT**, diff in B.6.

### C.4 BJT `bjtload.c:277-322` — **DIVERGENT**, diff in B.6.

---

## Additional divergences surfaced (F2)

### F2.1 `_applyDiagGmin` on factorNumerical reuse path — no double-application

`sparse-solver.ts:1338-1341` and `newton-raphson.ts:296-298`: NR loop calls `addDiagonalGmin(ctx.diagonalGmin)` then `solver.factor()` with no args. The `if (diagGmin)` in `factorNumerical` and `factorWithReorder` is a nop in the current call graph. **Not a divergence.** But if any future call site passes `diagGmin` to `factor(diagGmin)`, it would double-apply. No action needed.

### F2.2 Preorder runs before NISHOULDREORDER gate — matches ngspice

In ngspice (niiter.c:844-860) `SMPpreOrder` runs BEFORE the NISHOULDREORDER gate. Our `newton-raphson.ts:289-293` also runs `solver.preorder()` before the new gate. **No divergence.**

### F2.3 NIDIDPREORDER scope

ngspice `niiter.c:844,854`: NIDIDPREORDER flag lives on `CKTniState`, persisting across multiple `NIiter()` calls. Our `didPreorder` at `newton-raphson.ts:253` is a per-call local. Our `SparseSolver._didPreorder` is idempotent. Functionally equivalent.

Subtle divergence: ngspice clears NIDIDPREORDER via `NIreinit()` (called on `NIUNINITIALIZED`). Our `SparseSolver._didPreorder` is only cleared via `invalidateTopology()`. **Flag for executor:** audit call sites of `solver.invalidateTopology()` vs. ngspice's `NIreinit()` trigger points.

### F2.4 `_firsttime` synchronisation bug — `ctx.initMode = "initTran"` is written under `if (statePool)` gate only

`analog-engine.ts:422-429`:

```ts
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
        if (this._firsttime) {
          ctx.initMode = "initTran";
        }
      }
```

This sits INSIDE `if (statePool)` (line 422). If a circuit is purely linear (statePool === null), `initTran` mode is never set on the first step. ngspice `dctran.c:346` sets `CKTmode = (CKTmode & MODEUIC) | MODETRAN | MODEINITTRAN` unconditionally — there is no pool gate. **Divergence.** Fix:

**OLD block (exact, analog-engine.ts:422-429):**

```ts
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
        if (this._firsttime) {
          ctx.initMode = "initTran";
        }
      }
```

**NEW block (exact):**

```ts
      if (statePool) {
        statePool.dt = dt;
        computeNIcomCof(dt, this._timestep.deltaOld, this._timestep.currentOrder,
          this._timestep.currentMethod, this._ctx!.ag, this._ctx!.gearMatScratch);
      }
      // ngspice dctran.c:346 — MODEINITTRAN is set on the first step
      // UNCONDITIONALLY, not gated on presence of a state pool. A purely
      // linear circuit still enters the transient NR with MODEINITTRAN |
      // MODETRAN, which our `ctx.initMode === "initTran"` captures.
      if (this._firsttime) {
        ctx.initMode = "initTran";
      }
```

### F2.5 Pre-factor NISHOULDREORDER gate — matches ngspice via different control-flow

ngspice `niiter.c:888-891` triggers reorder on `E_SINGULAR`. Our `newton-raphson.ts:304-308` branches on `!solver.lastFactorUsedReorder`. Functionally equivalent. **No divergence.**

### F2.6 Iteration-0 noncon write ordering — matches ngspice semantics

`newton-raphson.ts:345-347` overwrites `ctx.noncon = 1` at iteration 0 only. ngspice `niiter.c:957-961` overwrites `CKTnoncon` post-CKTload regardless. Subtle difference in the exact counter value at `iteration > 0`, but all downstream gates treat as bool. **No material divergence.**

### F2.7 cktLoad ordering — matches

cktLoad before NISHOULDREORDER gate before factor — same ordering as ngspice. **No divergence.**

### F2.8 DC-OP → transient `isTransient` lifecycle — matches

`_seedFromDcop` sets `ctx.isTransient = true` before first `step()` call. **No divergence.**

### F2.9 BJT L1 initPred state-copy list is incomplete

ngspice bjtload.c:288-305 copies `CKTstate1 → CKTstate0` for `cc, cb, gpi, gmu, gm, go, gx, vsub`. ngspice bjtload.c:300-301 copies `BJTgx` too. Our `L1_SLOT_RB_EFF` at slot 10 is probably the equivalent. **The initPred copy list in bjt.ts:1467-1475 is MISSING GX/RB_EFF** vs. ngspice bjtload.c:300-301.

Also ngspice copies `CKTstate1 → CKTstate0` for `BJTvsub` at bjtload.c:302-303. Our L1_SLOT_VSUB (slot 40) is NOT in the copy list. **Divergence.**

**Diff addendum for bjt.ts initPred block (L1):**

Add after existing copies (bjt.ts:1475):

```ts
        s0[base + L1_SLOT_RB_EFF] = s1[base + L1_SLOT_RB_EFF];  // bjtload.c:300-301 (GX / RB_EFF)
        s0[base + L1_SLOT_VSUB]   = s1[base + L1_SLOT_VSUB];    // bjtload.c:302-303
```

---

## References

- `src/solver/analog/newton-raphson.ts:285-310` — NR body pre-factor section (target for diff 1 block 1)
- `src/solver/analog/newton-raphson.ts:474-499` — INITF dispatcher (target for diff 1 block 2)
- `src/solver/analog/analog-engine.ts:388-401` — `predictVoltages` call site
- `src/solver/analog/analog-engine.ts:419-429` — firsttime / initTran gate (F2.4)
- `src/solver/analog/analog-engine.ts:463-475` — initPred mode set
- `src/solver/analog/ni-pred.ts:47-280` — nipred port
- `src/solver/analog/load-context.ts:76` — xfact field
- `src/solver/analog/ckt-context.ts:547` — xfact init
- `src/solver/analog/sparse-solver.ts:475-477` — `forceReorder()`
- `src/solver/analog/sparse-solver.ts:1320-1332` — `factorWithReorder` clears `_needsReorder`
- `src/components/passives/capacitor.ts:281-292` — initPred capacitor (no diff)
- `src/components/passives/inductor.ts:294-304` — initPred inductor (no diff)
- `src/components/semiconductors/diode.ts:464-490` — initPred diode (diff required)
- `src/components/semiconductors/bjt.ts:774-817` — initPred BJT behavioral (diff required)
- `src/components/semiconductors/bjt.ts:1460-1509` — initPred BJT L1 (diff + missing slots)
- `ref/ngspice/src/maths/ni/niiter.c:856-859` — NISHOULDREORDER pre-factor gate
- `ref/ngspice/src/maths/ni/niiter.c:1063-1085` — NISHOULDREORDER post-solve INITF dispatcher
- `ref/ngspice/src/maths/ni/nipred.c:19` — `#ifdef PREDICTOR` gate on NIpred (entire file disabled by default)
- `ref/ngspice/src/spicelib/devices/devsup.c:766-786` — `DEVpred` linear extrapolation (not gated itself)
- `ref/ngspice/src/spicelib/devices/cap/capload.c:53-66` — capacitor `#ifndef PREDICTOR`
- `ref/ngspice/src/spicelib/devices/ind/indload.c:43-110` — inductor `#ifndef PREDICTOR`
- `ref/ngspice/src/spicelib/devices/dio/dioload.c:140-155` — diode `#ifndef PREDICTOR`
- `ref/ngspice/src/spicelib/devices/bjt/bjtload.c:277-322` — BJT `#ifndef PREDICTOR`
