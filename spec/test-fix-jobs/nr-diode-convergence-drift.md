# nr-diode-convergence-drift

## Problem statement

Three tests on the diode model report large-magnitude drift between
expected analytical values and digiTS's solver output:

| Test file | `it(...)` name | Reported actual | Bar |
|---|---|---|---|
| `src\solver\analog\__tests__\mna-end-to-end.test.ts` | `diode_shockley_equation_consistency` | 0.0135 | < 0.001 (relative current error) |
| `src\solver\analog\__tests__\newton-raphson.test.ts` | `diode_circuit_converges` | 5.005 | < 0.75 (Vd in V — should be ~0.68V) |
| `src\solver\analog\__tests__\newton-raphson.test.ts` | `diode_reverse_bias` | 0.005 | < 1e-11 (reverse current in A) |

These magnitudes are far past the few-ULP scale. A 5.005V drop on a
forward-biased diode (expected ~0.68V) is a structural failure: the diode
is essentially open under NR or the wrong stamp is applied. A 0.005A
reverse current on a 1kΩ-isolated diode is `5V * 1kΩ → 5mA`, i.e. the
forward-biased Norton conductance is being applied in reverse — also
structural. A 1.35% relative error on the Shockley current-vs-voltage
consistency check (`(Vs−Vd)/R == Is·(exp(Vd/Vt)−1)`) at the operating
point is consistent with the diode's GMIN injection being missing or
applied in the wrong direction.

## Sites

- Tests:
  - `mna-end-to-end.test.ts:566-600` (`diode_shockley_equation_consistency`)
  - `newton-raphson.test.ts:246-259` (`diode_circuit_converges`)
  - `newton-raphson.test.ts:265-277` (`diode_reverse_bias`)
- Production:
  - `src\components\semiconductors\diode.ts` — `createDiodeElement`,
    `computeDiodeIV`, `dioTemp`.
  - `src\solver\analog\newton-raphson.ts` — `newtonRaphson`, `pnjlim`.
  - `src\solver\analog\dc-operating-point.ts` — DC-OP ladder.
- Tests use the **production** factory (`createDiodeElement`) via
  `newton-raphson.test.ts:37-41` and the wrapper helpers in
  `mna-end-to-end.test.ts:76-80`. Distinct from
  `dc-operating-point.test.ts` whose test-only `makeDiode` is the subject
  of `dc-op-strategy-direct-vs-gmin.md`.

## Verified ngspice citations

- **DIOload three-region IV** (`ref/ngspice/src/spicelib/devices/dio/dioload.c:245-265`):
  - Forward (`vd >= -3*vte`): `evd = exp(vd/vte); cdb = csat*(evd-1); gdb = csat*evd/vte`.
  - Reverse cubic (`-tBV <= vd < -3*vte`):
    `arg = 3*vte/(vd*CONSTe); arg = arg*arg*arg; cdb = -csat*(1+arg); gdb = csat*3*arg/vd`.
  - Breakdown (`vd < -tBV`): `evrev = exp(-(tBV+vd)/vtebrk); cdb = -csat*evrev; gdb = csat*evrev/vtebrk`.
- **GMIN injection inside dioload** (`dioload.c:290-314`):
  - Forward: `gd = gd + ckt->CKTgmin; cd = cd + ckt->CKTgmin*vd`.
  - Reverse: same shape.
- **pnjlim** (`devsup.c:DEVpnjlim`): three-region (forward, reverse, cold)
  voltage limiter; sets `Check=1` when limiting fires (so the device's
  `noncon++` bumps).
- **noncon bump** (`dioload.c:411-414`): `if (Check==1) ckt->CKTnoncon++`.
- **MODEINITJCT seed** (`dioload.c:130-138`):
  `vd = DIOtVcrit` (or 0 if `DIOoff`, or `DIOinitCond` under
  `MODETRANOP|MODEUIC`).
- **MODEINITFIX bypass** (`dioload.c:137-138`): `vd = 0` if
  `MODEINITFIX` and `DIOoff`.
- **Predictor mode** (`dioload.c:140-152`): `state0[vd] = state1[vd]`,
  `vd = DEVpred(...)`.

These citations were verified by direct read of `dioload.c` in this session.

## Investigation

Before running the harness, the test failure magnitudes themselves narrow
the diagnosis:

### `diode_circuit_converges` returning Vd ≈ 5.005V

The circuit is 5V → 1kΩ → diode → ground. Expected `Vd ≈ 0.68V`,
`Id ≈ 4.3mA`. The reported `Vd ≈ 5.005V` means the diode is open
(zero conductance) — the entire 5V drops across the diode. Possible
structural causes:

1. **Pool-state initial-VBE seed not applied**. The `DIODE_SCHEMA`
   (`diode.ts:81-86`) declares `VD: { kind: "zero" }` — initial guess is
   0. Under `MODEINITJCT`, `diode.ts:559-562` should override to
   `vd = tVcrit`. If `MODEINITJCT` is never set on first call, the seed
   is never applied. ngspice ALWAYS enters the first NIiter call with
   `MODEINITJCT` (cktop.c:35: `ckt->CKTmode = firstmode` where
   `firstmode == MODEDCOP|MODEINITJCT`).
2. **`createDiodeElement.setup` is not called or `_pinNodes` is wrong**.
   If `_posPrimeNode` ends up as -1 or a wrong node, `vdRaw` reads junk and
   the conductance vector is 0.
3. **NR loop returns "converged" with the initial all-zero voltage solve**.
   The harness reports `converged === true` but `Vd ≈ 5.005V` — meaning
   the loop is NOT iterating against the diode. This is consistent with
   the `nrResult.iterations < 20` upper bound passing because iterations
   is 1.

Diagnose by reading `ctx.nrResult.iterations` and inspecting
`ctx.cktMode` at NR entry.

### `diode_reverse_bias` returning 0.005A reverse current

Circuit: -5V → 1kΩ → diode → ground. Expected `|I| < 1e-11A`. Reported
0.005A means the diode is conducting forward at full bias even when
reverse-biased, i.e. the diode is being treated as a 1kΩ wire in reverse
or the NR converged to the forward-bias operating point (sign error in
the linearization).

The reverse cubic region (`dioload.c:251-258`) has the wrong sign for
`gdb` if implemented from the formula instead of from the source: the
ngspice `gdb = csat*3*arg/vd` where `vd < 0`, so `gdb < 0`? No — `arg < 0`
also (cube of `3*vte/(vd*e)` where `vd < 0` is negative; cube is
negative), so `csat*3*(negative)/(negative) > 0`. Production
`computeDiodeIV` (`diode.ts:354-368`) needs verification against this.

### `diode_shockley_equation_consistency` 0.0135 vs 0.001

`Vs=5V, R=10kΩ, Is=1e-14, n=1, Vt=0.02585`. At the operating point,
both `(Vs-Vd)/R` and `Is*(exp(Vd/(n*Vt))-1)` should agree to <0.1%. A
1.35% relative error means the operating point converged to a value
that's slightly off the curve — exactly the symptom of GMIN-injected
linearization where the diode reports `cd' = cd + GMIN*vd` and the
voltage-current pair `(Vd, Id_reported)` no longer satisfies the
Shockley equation by exactly `GMIN*Vd`.

For `Vd = 0.65V` and `GMIN = 1e-12`: `GMIN*Vd = 6.5e-13 A`. Test
expects `1.35% * Id = 1.35% * 4.3e-4 = 5.8e-6 A` of slack — the
GMIN bias is ~10 orders of magnitude smaller, so GMIN itself is not
the cause.

The 1.35% relative error pattern matches a **single iteration short of
true convergence**. If `newtonRaphson` returns `converged=true` after the
penultimate NR step (one iteration before the proper convergence test
fires), the operating point is off by the last NR correction. This
happens when the convergence gate is "noncon === 0 after iter 0" but a
nonlinear circuit needs a forced second iteration (per
`newton-raphson.test.ts:326-345`'s contract).

### Reproduction procedure

1. Run each failing test in isolation:
   ```
   npx vitest run src/solver/analog/__tests__/newton-raphson.test.ts -t diode_circuit_converges
   npx vitest run src/solver/analog/__tests__/newton-raphson.test.ts -t diode_reverse_bias
   npx vitest run src/solver/analog/__tests__/mna-end-to-end.test.ts -t diode_shockley_equation_consistency
   ```
2. Add temporary instrumentation:
   ```ts
   ctx.postIterationHook = (iter) => {
     console.log(`iter=${iter} cktMode=0x${ctx.cktMode.toString(16)} ` +
                 `vd=${ctx.rhsOld[junctionNode]} noncon=${ctx.noncon}`);
   };
   ```
3. The cktMode trajectory should be
   `MODEDCOP|MODEINITJCT → MODEINITFIX → MODEINITFLOAT → (converged at FLOAT)`.
   If it converges at INITJCT or INITFIX, the gating is wrong.
4. The vd trajectory should pass through `tVcrit ≈ 0.6V → ~0.65V → 0.68V`.
   If it diverges to large positive or stays at 0, the seeding is wrong.
5. Run the comparison harness on the same circuit using
   `ComparisonSession.createSelfCompare({ buildCircuit, analysis: "dcop" })`
   and a netlist version. The first divergent iteration in
   `assertIterationMatch` reveals which production line drifts from
   ngspice.

## Recommendation

**Category: `architecture-fix`.** Three large-magnitude divergences on
a textbook diode circuit, using the production factory, against the
ngspice DIOload citations above. None of the failures are at the
few-ULP scale; they are 1.35%, 0.005A on a reverse-biased diode, and 5V
on a forward-biased diode. None of the test bars are in violation of
ngspice's spec — they are reasonable engineering tolerances on a
working diode model.

The remediation is to drive the divergent production code line back to
ngspice. The exact line to fix depends on the harness output (Step 5
above). Likely candidates, in order of probability:

1. **NR convergence gating exits one iteration early** — see
   `newton-raphson.ts` for the `noncon === 0 && iter > 0` test ordering.
   ngspice (`niiter.c:963-967`) requires
   `ckt->CKTnoncon == 0 && iterno != 1` for the converged path; if
   digiTS's gate is `ckt.noncon === 0 && iter !== 0`, the off-by-one
   collapses on the first call.
2. **`MODEINITJCT` seed is not propagating to the diode** — check
   `ctx.cktMode` at NR entry. Either the DC-OP ladder is not setting
   the bit, or the diode's mode-check (`diode.ts:546-580`) is reading
   the wrong field.
3. **GMIN injection is missing from `computeDiodeIV` / load path** —
   check that `gd + GMIN` and `cd + GMIN*vd` lines (`diode.ts:677-678,
   691-692`) actually fire. If the IKF/IKR branches at
   `diode.ts:668-694` skip GMIN, that's a bug against `dioload.c:298-299`.

## Category

**`architecture-fix`** — three numerical divergences far past few-ULP
scale, against well-cited ngspice load semantics. CLAUDE.md banned-vocab
clause requires escalation when divergence is structural.

## Tensions / uncertainties

1. **The three failures may share a root cause, or be three independent
   bugs.** A single missing `MODEINITJCT` seed could explain all three
   (5.005V Vd, 0.005A reverse current, 1.35% Shockley drift) because all
   three start from the wrong initial voltage. A single off-by-one in the
   NR convergence gate could also explain all three. Both possibilities
   need investigation before splitting the fix.

   **`[ESCALATE: needs user decision on whether to file three separate
   bugs or one shared root-cause job.]`**

2. **`mna-end-to-end.test.ts` uses `compileUnified` and the full pipeline,
   while `newton-raphson.test.ts` uses a hand-built `makeSimpleCtx`.** If
   the failure reproduces in only one path, that's a `compileUnified`-vs-
   hand-built skew (likely `architecture-fix` against the compiler). If
   it reproduces in both, that's a model-level bug (also
   `architecture-fix` against the diode). The reproduction procedure
   distinguishes these.

3. **The production diode's `setParam` does not re-apply area scaling.**
   `diode.ts:421-424` performs area scaling once at construction:
   ```ts
   params.IS  *= params.AREA;
   if (params.RS > 0) params.RS /= params.AREA;
   params.CJO *= params.AREA;
   ```
   `setParam` (`diode.ts:852-857`) writes the new value into `params[key]`
   and calls `recomputeTemp()`, but the area scale is NOT re-applied.
   So `setParam("IS", value)` makes `params.IS = value` (unscaled), but
   the construction had `params.IS = ISinitial * AREA`. Subsequent loads
   produce the wrong saturation current. This is a latent bug in the
   `setParam` path and may surface when tests hot-load `IS` or `AREA`.

   **`[ESCALATE: this is a latent-bug fold-in candidate per
   feedback_no_latent_bugs in MEMORY. Either fix in this lane or file
   separately. The three failing tests above do NOT hot-load IS or AREA
   so this latent bug is not the cause; it's a related defect in the
   same blast radius.]`**

4. **Bit-exact vs engineering tolerance.** The three test bars (<0.001,
   <0.75, <1e-11) are NOT bit-exact — they're engineering tolerances. If
   the harness re-classification dictates that all numerical tests must
   be bit-exact, these tests' bars themselves become contracts that need
   tightening. Per CLAUDE.md banned-vocab the word "tolerance" cannot
   close a parity item, but these are not parity tests — they are
   sanity tests on the production diode in isolation.

   **`[ESCALATE: needs user clarification on whether unit-test bars on
   the diode (not parity assertions) are subject to the
   bit-exact-or-escalate rule, or only the parity-helpers comparator
   is.]`**
