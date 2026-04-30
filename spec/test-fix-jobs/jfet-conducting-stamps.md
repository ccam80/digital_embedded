# JFET conducting stamps — `emits_stamps_when_conducting`

## Problem

`src/components/semiconductors/__tests__/jfet.test.ts::PJFET > emits_stamps_when_conducting`
fails with `expected 5.1e-11 to be greater than 1e-5` for the drain-source
off-diagonal stamp `_hDPSP` (= -gds - gm).

The magnitude 5.1e-11 ≈ 50 × CKTgmin (1e-12) corresponds to the **junction
leakage / GMIN-only conductance** that ngspice stamps in the JFET cutoff
region (jfetload.c:284-287, `cdrain = 0; gm = 0; gds = 0;` and the matrix
stamp `_hDPSP = -(gds + gm) = 0`, i.e. only the parasitic / Gillespie
negative-bias term remains). The test expects a saturation-region stamp on
the order of 2e-4 S (gm-dominated).

## Sites

- Test fixture: `src/components/semiconductors/__tests__/jfet.test.ts:184-281`
- Production: `src/components/semiconductors/pjfet.ts::createPJfetElement`
  (lines 370-738, `load()` method)
- Production helper: `src/solver/analog/newton-raphson.ts::pnjlim` (lines
  100-144) and `::fetlim` (lines 185-229)

## Verified ngspice citations

### Bias-region selection — `ref/ngspice/src/spicelib/devices/jfet/jfetload.c`

Lines 274-348 (Sydney University JFET model). With `vds >= 0` (normal mode):

```
276            if (vds >= 0) {
277                vgst = vgs - vto;
281                if (vgst <= 0) {
282                    /* normal mode, cutoff region */
285                    cdrain = 0;
286                    gm = 0;
287                    gds = 0;
288                } else {
289                    betap = beta*(1 + model->JFETlModulation*vds);
291                    if (vgst >= vds) {
293                        /* normal mode, linear region */
299                        ...
301                    } else {
305                        /* normal mode, saturation region */
307                        cpart=vgst*vgst*(model->JFETb+Bfac);
308                        cdrain = betap*cpart;
309                        gds = ...
310                    }
311                }
312            } else { /* inverse mode */ ... }
```

So: cutoff iff `vgs <= vto`; saturation iff `vgst > 0 && vgst < vds`; linear
iff `vgst > 0 && vgst >= vds`. (For PJFET the polarity flip `JFETtype = PJF
= -1` is applied at jfetload.c:154-161 before this dispatch, so `vgs` and
`vto` here are post-polarity quantities.)

### Limiting order — `ref/ngspice/src/spicelib/devices/jfet/jfetload.c:211-242`

```
211                ichk1=1;
217                vgs = DEVpnjlim(vgs, ..., here->JFETvcrit, &icheck);
223                vgd = DEVpnjlim(vgd, ..., here->JFETvcrit, &ichk1);
232                vgs = DEVfetlim(vgs, ..., here->JFETtThreshold);
238                vgd = DEVfetlim(vgd, ..., here->JFETtThreshold);
```

`DEVpnjlim` clamps the gate-junction PN forward bias near `vcrit ≈
vt·log(vt/(√2·csat)) ≈ 0.78 V` for silicon. `DEVfetlim` then re-applies the
gate-threshold three-zone limiter over the result.

### Critical voltage `vcrit` — `ref/ngspice/src/spicelib/devices/jfet/jfettemp.c`

Per `pjfet.ts::computePjfetTempParams` (line 228, ported verbatim from
jfettemp.c):

```
const vcrit = vt * Math.log(vt / (CONSTroot2 * tSatCur));
```

For IS=1e-14, vt=0.02585: `vcrit = 0.02585 * log(0.02585/(√2 * 1e-14)) ≈
0.78 V`.

### VTO default — `ref/ngspice/src/spicelib/devices/jfet/jfetmpar.c` and `jfetdef.h`

Verified: ngspice's NJF/PJF model `JFETthreshold` defaults to `-2.0 V`
(NJF). `pjfet.ts:68` uses `VTO: 2.0` in `PJFET_PARAM_DEFAULTS`; the
polarity literal `-1` at `pjfet.ts:252` performs the type flip on `vgs`/`vgd`,
so the test's `VTO=2.0` is the parameter as supplied, not the post-flip
threshold. This matches ngspice convention.

## Investigation — why the test sees cutoff

The test fixture (jfet.test.ts:185-280) drives the load loop manually:

```
voltages[0] = 0; voltages[1] = 2; // V(G)
voltages[2] = 0;                  // V(D)
voltages[3] = 5;                  // V(S)

for (let i = 0; i < 50; i++) {
  element.load(makeDcOpCtx(voltages, 4, sharedSolver));
}
```

The same `voltages` buffer is fed as `rhsOld` to every iteration. Per the
PJFET production load() (pjfet.ts:462-468):

```
const vgsRaw = polarity * (vG - vSP) = -1 * (2 - 5) = 3;
const vgdRaw = polarity * (vG - vDP) = -1 * (2 - 0) = -2;
```

Per pjfet.ts:475-481 (matching jfetload.c:217-242), `pnjlim` then `fetlim`
are applied each iteration. Tracing iteration 1 (s0[VGS]=0 from
initState):

- `pnjlim(vnew=3, vold=0, vt=0.02585, vcrit=0.78)`:
  - `vnew > vcrit && |vnew - vold| > 2*vt` is true.
  - `vold > 0` is false → branch `vnew = vt * log(vnew/vt) = 0.02585 *
    log(3/0.02585) ≈ 0.123 V` (newton-raphson.ts:114).
- `pnjlim(vnew=-2, vold=0, ...)`: Gillespie negative-bias arm → `vold > 0`
  false → `arg = 2*0 - 1 = -1`; `vnew(-2) < arg(-1)` → clamp `vnew = -1`.
- `fetlim(vnew=0.123, vold=0, vto=2)`: OFF branch (`vold=0 < vto=2`),
  delv=0.123 < vtstlo=3 → unchanged.
- `fetlim(vnew=-1, vold=0, vto=2)`: OFF branch, delv=-1 → unchanged.

So after iteration 1: vgs ≈ 0.123, vgd = -1. With `vgst = vgs - vto = 0.123
- 2 = -1.877 ≤ 0` → **cutoff**, cdrain = gm = gds = 0.

Subsequent iterations grow vgs by `vt * log(...)` per call (pnjlim's
forward-limit branch with `vold > 0`). With vt ≈ 0.026, each step adds at
most ~vt·(2 + log(...)) ≈ 0.16 V. The pnjlim forward limiter is a
gate-junction PN clamp engineered to converge `vgs` toward the diode
forward voltage (~0.78 V), not toward the JFET threshold (`vto = 2 V`).
After 50 iterations vgs sits near vcrit ≈ 0.78 V, well below `vto = 2`, so
`vgst ≤ 0` and the device remains in cutoff.

The test's expected 2e-4 S transconductance assumes the device sits in
saturation with `vgst = vgs - vto = 3 - 2 = 1 V`. But that requires
`vgs = 3 V`, which the limiting machinery — both ngspice's and ours —
will never produce from a static rhsOld with `vgsOld = 0` because pnjlim
treats the gate junction independently from the channel and clamps at the
junction forward voltage.

In a real circuit the gate node voltage is a network unknown; KCL pulls it
to whatever value is consistent with the source-resistance / current-source
loading. Across NR convergence the limited `vgs` walks up through repeated
pnjlim/fetlim invocations as `rhsOld` *itself* updates. The test bypasses
this entirely by feeding the same `voltages` buffer to every iteration —
`rhsOld` never changes, so vgs cannot exceed the pnjlim-imposed asymptote
of ~vcrit.

The bug is therefore in the **fixture**: it asserts a saturation-region
stamp without ever giving the limiter a chance to hand vgs back. It is not
a production-code defect — the production code is matching jfetload.c
line-by-line.

## Category

**`contract-update`** — fixture problem, not a numerical or architectural
defect.

## Resolution shape

The fixture must drive the device into saturation through a path the
limiter accepts. Two acceptable shapes:

1. **Iterate `rhsOld` per NR step** — after each `load()`, update the
   `voltages` buffer to reflect a self-consistent next iterate. This is
   what a real NR loop does. The contract assertion target then becomes
   a converged-state stamp readout, not a single-iteration snapshot.

2. **Seed `pool.state0[SLOT_VGS] = 3`, `state0[SLOT_VGD] = -2` directly**
   before the first `load()` call, bypassing pnjlim's growth phase. With
   `vgsOld = 3` and `vgsRaw = 3`, `delvgs = 0 < 2*vt` → pnjlim no-ops.
   `fetlim(vgs=3, vgsOld=3, vto=2)`: ON branch (vold=3 ≥ vto=2),
   `vold(3) < vtox(5.5)` so near-threshold zone; `delv=0` → no clamp.
   Device enters saturation on the first load. This is the surgical fix.

   The state-schema initial values (pjfet.ts:133-145, all `kind: "zero"`)
   would need a per-test override; either pass an initial-values map to
   `applyInitialValues()` in a test helper, or write into `pool.state0`
   directly after `core.initState(pool)`.

Either approach keeps the production code untouched.

## Resolves

1 vitest test (`PJFET > emits_stamps_when_conducting`).

## Tensions / uncertainties

- The companion `NR > converges_within_10_iterations` test (jfet.test.ts:287-340)
  drives an N-channel JFET through `runDcOp` and successfully reaches
  saturation (vDrain ≈ 6 V, |iD| ∈ (1e-5, 1e-3)). That confirms production
  pnjlim/fetlim **does** allow saturation when run inside a real NR loop
  with self-updating `rhsOld`. So the production code is correct under
  the contract it was ported against.

- A possible alternative shape would be to delete the test entirely on the
  grounds that "stamp emission while conducting" is already covered by the
  `runDcOp`-driven NR test. That collapses two coverage targets into one
  and may be unacceptable to whoever wrote the original test; the fixture
  fix above keeps the explicit-stamp coverage.

- The escalation gate from `CLAUDE.md` (banned closing-verdict vocabulary)
  does not apply here: the divergence is **fixture vs. production**, not
  digiTS vs. ngspice. Both engines produce the same cutoff result for the
  fixture's input pattern; the fixture's expected value is wrong. This is
  reported as a fixture-correction job, with no architectural-alignment
  entry needed.
