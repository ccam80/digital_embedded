# LED pnjlim limitingCollector event push contract

## Category
`contract-update`

## Resolves
- 1 fix: `pushes AK pnjlim event on non-init NR iteration`
- 1 deletion: NONE — see the verdict below; the second test the brief said
  to delete is actually consistent with our production code, so neither it
  nor the production code is the divergence. Read on.

## Sites
- Test: `src/components/io/__tests__/led.test.ts` lines 968-1010 (and
  the two sibling tests at 1012-1039)
- Production load(): `src/components/semiconductors/diode.ts` lines
  534-619 (the LED is a re-pinned diode via
  `createLedAnalogElementViaDiode` in `src/components/io/led.ts:164-175`)

## Verified ngspice citation

`ref/ngspice/src/spicelib/devices/dio/dioload.c`:

- Lines 125-138: vd-seed dispatch — MODEINITSMSIG (line 127),
  MODEINITTRAN (128-129), MODEINITJCT (130-136 — including the OFF and
  Vcrit sub-cases), MODEINITFIX (137-138).
- Lines 139-205: the `else { … }` block for normal-NR iterations
  (any mode bit not in {SMSIG, TRAN, JCT, FIX-and-OFF}).
  - Lines 183-195: breakdown branch — `DEVpnjlim` called in reflected
    domain, `Check` updated by `&Check` parameter.
  - Lines 196-204: standard branch — `DEVpnjlim(vd, state0[DIOvoltage],
    vte, DIOtVcrit, &Check)`.

`DEVpnjlim` is called *only* inside the `else` block at lines 139+ —
it is **not** invoked under MODEINITJCT, MODEINITSMSIG, MODEINITTRAN,
or MODEINITFIX&OFF. In those modes vd is seeded directly (state0,
state1, IC, 0, or tVcrit) and the loader falls through to current/
conductance computation without limiting.

Our production code mirrors this:
`src/components/semiconductors/diode.ts:587`
`if (mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) {`
`  vdLimited = vdRaw; pnjlimLimited = false; }`

(Note: MODEINITFIX&&OFF lacks an explicit guard but reaches the same
result — vdRaw is already 0 when the seed branch ran.)

The `CKTnoncon++` site is `dioload.c:413` and is conditional on
`Check==1` (set by DEVpnjlim only when limiting actually occurred).
Our equivalent: `diode.ts:607` increments `ctx.noncon.value` only when
`pnjlimLimited === true`, matching the contract.

## Per-test verdict

Verified against actual run output (`npx vitest run … -t "limitingCollector"`)
on the current tree:

| Test | Line | Status |
|------|------|--------|
| `pushes AK pnjlim event on non-init NR iteration` | 968 | **FAILS** at line 983 (`expect(collector[0].wasLimited).toBe(true)` got false) |
| `pushes AK event with wasLimited=false under MODEINITJCT` | 989 | passes |
| `does not push when ctx.limitingCollector is null` | 1012 | passes |
| `pushes wasLimited=false on non-init NR iteration when pnjlim does not limit` | 1022 | passes |

**Disagreement with the spec brief.**
The brief said the MODEINITJCT test should be DELETED because
"ngspice does NOT push under MODEINITJCT". That is correct as a
statement about ngspice, BUT our production code intentionally pushes
a `LimitingEvent` under MODEINITJCT with `wasLimited=false` (see
`diode.ts:609-619` — the push site is unconditional on mode, only
gated by `ctx.limitingCollector != null`). The push under MODEINITJCT
is a project-specific contract for the limiting-event collector
(visualisation/debugging surface), not a parity claim against
ngspice. The corresponding test at line 989 PASSES on the current
tree. Removing it would unilaterally erase a working production
contract that the limiting collector relies on for the MODEINITJCT
seed phase.

If the spec author wants to change the contract so the push is also
gated on mode, that's an architectural change to the LimitingEvent
collector — not a test-fix-job item.

**Per-test action:**

- `pushes AK pnjlim event on non-init NR iteration` (line 968) — KEEP, FIX FIXTURE.
  Fixture bug: the test allocates `voltages = new Float64Array(1)` (length 1)
  and writes `voltages[0] = 5.0`, but the LED's anode is mapped to
  internal node id 1 (the `["in", 1]` entry passed to the factory in
  `makeLedCoreWithPool`). At `diode.ts:577-579` the loader reads
  `voltages[nodeJunction]` where `nodeJunction = _posPrimeNode = anode = 1`.
  `voltages[1]` is out of bounds for a length-1 Float64Array, returning
  `undefined`. JS coerces it through arithmetic to `NaN`, so
  `vdRaw = NaN`. `pnjlim(NaN, 0, …)` does not enter its forward-limit
  branch (NaN-vs-vcrit is `false`), returns `{value: NaN, limited: false}`,
  and the push fires with `wasLimited: false` — failing the
  `wasLimited === true` assertion.

  Fix: change the fixture to allocate `new Float64Array(2)` and write
  `voltages[1] = 5.0` (anode node) and `voltages[0] = 0` (ground/cathode).
  After that vdRaw = 5 - 0 = 5, vcrit ≈ 1.82, |vnew - vold| = 5 > 2*nVt
  ≈ 0.093, pnjlim limits, `wasLimited === true`. The test then exercises
  the production contract its name describes.

- `pushes AK event with wasLimited=false under MODEINITJCT` (line 989) — KEEP AS-IS.
  Currently passes; documents the project-specific MODEINITJCT push
  contract.

- `does not push when ctx.limitingCollector is null` (line 1012) — KEEP AS-IS.
  Currently passes.

- `pushes wasLimited=false on non-init NR iteration when pnjlim does not limit`
  (line 1022) — KEEP AS-IS. Currently passes; the small-bias case
  (vdRaw = 0.5 V, below vcrit) does enter pnjlim but its forward branch
  is not taken, and the cathode hardwired to node 0 is correctly
  read from `voltages[0]`.

## Tensions / uncertainties

- The brief's instruction to DELETE the MODEINITJCT push test conflicts
  with the production contract that the test currently documents and
  that the production code currently fulfils. The spec author should
  either:
  (a) confirm the project's intent is to keep the MODEINITJCT push
      (in which case my recommendation stands), or
  (b) confirm the project intends to align with ngspice and stop
      pushing under MODEINITJCT — in which case both `diode.ts:609`
      needs an `if (!isInitMode)` guard *and* the test must be
      deleted.
  This is an escalation: I cannot make that call alone.
- The fixture bug in test 1 is independent of the MODEINITJCT
  question and should be fixed regardless of (a) or (b) above.
