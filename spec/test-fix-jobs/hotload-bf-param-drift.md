# hotload-bf-param-drift

## Problem statement

The Playwright test `e2e/gui/hotload-params-e2e.spec.ts:103` (test name
`changing BF on BJT via primary param row changes output voltage`) fails
with:

```
Error: Expected 0.09577162816207974 to be close to 0.0957744513
       (err=0.000002823137920257568, limit=9.577445129999999e-8)
```

This is a relative drift of `2.82e-6 / 0.0958 ≈ 2.95e-5` (≈ 30 parts per
million), against a stated bar of `rtol=1e-6, atol=1e-9`
(`hotload-params-e2e.spec.ts:21`). The reference value
`9.57744513e-02` is the published ngspice result for this circuit at
BF=100 (per `console.log` annotation at line 167).

The test then continues to Phase B (BF=10 hot-loaded), expects
`Vc(BF=10) = 7.63368375V`, which it would also drift on if the BF write
path is the root cause.

## Sites

- Test:
  `C:\local_working_projects\digital_in_browser\e2e\gui\hotload-params-e2e.spec.ts:103-181`.
- Production BJT setParam:
  `C:\local_working_projects\digital_in_browser\src\components\semiconductors\bjt.ts:2079-2084`
  (Spice L1 path):
  ```ts
  setParam(key: string, value: number): void {
    if (key in params) {
      params[key] = value;
      tp = makeTp();
    }
  },
  ```
- BJT temperature/topology computer:
  `bjt.ts:521-535` (`computeBjtTempParams` invocation packaged as
  `makeTp`).
- BJT load path uses the recomputed `tp` plus per-iteration `params.AREA`
  multiplications (`bjt.ts:1323-1335`):
  ```ts
  const csat = tp.tSatCur * params.AREA;
  ...
  ```

## Verified ngspice citations

The Phase A reference value `0.0957744513V` corresponds to the published
ngspice DC-OP solution for the test circuit (Vcc=12V, Rc=10kΩ, Rb=100kΩ,
Vb=5V, NPN with default model BF=100, IS=1e-14). The relevant ngspice
load function:

- `ref/ngspice/src/spicelib/devices/bjt/bjtload.c` — `BJTload`. The
  reference set of stamps and convTest is documented in
  `niiter.c:373-404` (BJT branch of `ni_convTestAll`). BJT model
  parameters are `BJTbetaF` (BF), `BJTbetaR` (BR), `BJTsatCur` (IS),
  etc.
- `ref/ngspice/src/spicelib/devices/bjt/bjttemp.c` — temperature
  scaling. Recomputed when temperature or model params change.
- `ref/ngspice/src/spicelib/devices/bjt/bjtmpar.c` — model parameter
  setter. Sets `BJTbetaFGiven` and stores the new value; subsequent
  `BJTtemp` regenerates per-instance temperature-scaled values.

## Investigation

The 30 ppm drift is far above few-ULP for a 0.0958V value (one ULP at
that magnitude is ~1e-17). The drift is consistent with one of:

1. **BF setParam path is correct, but the published reference is from a
   slightly different ngspice version** — the test's reference value was
   captured against a specific ngspice build. If the digiTS
   implementation is bit-faithful to the current ref/ngspice, but the
   reference was captured against an older one, this is a test-fixture
   drift.
2. **BF setParam path correctly stores the new BF, but the engine's
   captured load() does not see the new value because it was cached
   somewhere upstream.**
3. **The test's BJT model includes a parameter that BF setParam does not
   recompute** — e.g., excess-phase factor or a BR-derived quantity that
   the makeTp closure does not refresh.

### Step 1 — Confirm by running headless equivalent

Build a headless test in `src/solver/analog/__tests__/` that:

```ts
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

const facade = new DefaultSimulatorFacade();
// build circuit programmatically (Vcc 12V, Rc 10k, NpnBJT IS=1e-14, Vb 5V, Rb 100k)
const coordinator = facade.compile(circuit);
const dcop = coordinator.dcOperatingPoint();
const vcA = readNodeVoltage(dcop, "Q1.C");
// Expect 0.0957744513
expect(vcA).toBeCloseTo(0.0957744513, 7);
```

If this also drifts to `0.09577162816...`, the issue is purely
numerical/engine, not Playwright UI plumbing — the e2e bar is the
correct bar but the engine is the source.

If the headless passes, the drift is introduced somewhere between
`compile()` and the Playwright UI layer (postMessage adapter,
property bag round-trip, hot-load handler, etc.).

### Step 2 — Inspect setParam coverage

If headless reproduces, repeat with hot-loading:

```ts
// Phase A
let vc = readNodeVoltage(dcop, "Q1.C");                  // expect 0.0957744513

// Phase B — hot-load BF
const bjt = engine.elements.find(e => e.label === "Q1");
bjt.setParam!("BF", 10);
const dcop2 = coordinator.dcOperatingPoint();
const vc2 = readNodeVoltage(dcop2, "Q1.C");              // expect 7.63368375
```

If Phase A drifts in headless but Phase B is exactly 7.63368375, the
hot-load path is correct and the static path is the bug. If Phase A
matches but Phase B drifts, hot-load is the bug.

### Step 3 — Compare against ngspice harness

Run `ComparisonSession` on the same circuit with `runDcOp()`. Read
`session.getStepEnd(0).nodes["Q1.C"]`. The
`ComparedValue.absDelta` is the bit-exact divergence. If `absDelta === 0`
on Q1.C, then digiTS matches ngspice and the test reference value
itself is wrong (`contract-update`). If `absDelta !== 0`, digiTS
diverges from ngspice and the production code needs a fix
(`architecture-fix`).

### Likely cause analysis

`bjt.ts:2079-2084` (the L1 setParam) is correct in shape — it stores the
new value and recomputes `tp`. `tp` is the closure-scoped temperature
struct; `load()` reads `tp.tSatCur`, `tp.tBetaF` (named per
`computeBjtTempParams`), and `params.AREA` separately. If `tp.tBetaF` is
correctly updated by `makeTp()` after `setParam("BF", ...)`, the load
sees the new value next call.

**But:** the L1 path scales by `params.AREA` separately at load time
(`bjt.ts:1327-1335` reads `params.AREA` directly, not via `tp`). The L1
class is therefore robust to `setParam("AREA", ...)` because both the
temperature recompute and the per-call scaling happen on the new
`params.AREA` value. Same applies to BF — `tp.tBetaF` is `BF * <some
temperature factor>`, and the load uses `tp.tBetaF` directly.

So the BJT L1 setParam path looks correct. The 30 ppm drift on Phase A
(BF=100, the default — no hot-load involved at the time of the
reference comparison) means the issue is not in `setParam` at all
during Phase A. **Phase A's failure happens on the original
construction-time BF=100, not after hot-load.**

This collapses the diagnosis: the 30 ppm drift is in the engine's BJT
load() output for a fresh circuit with default BF=100. That's the same
class of issue as `dc-op-parity-divergence.md`'s `dc_op_match` failures
on `bjt-common-emitter`. The Playwright test is a downstream symptom of
the same root cause (or a closely related one).

If headless / harness comparison shows Q1.C at exactly 0.0957744513 in
digiTS, then the engine is bit-faithful and the e2e plumbing is the
source.

## Recommendation

**Category: pending Step 3 verdict** — the same drift pattern visible
in this Playwright test is the per-iteration drift surface called out by
`dc_op_match` on `bjt-common-emitter` in
`dc-op-parity-divergence.md`. The likely outcomes:

- If `ComparisonSession` shows Q1.C bit-exact between digiTS and
  ngspice, **`contract-update`**: the test's expected value comes from
  an outdated ngspice run. Update to the current digiTS = ngspice value
  (recomputed by running both sides on the same circuit).

- If `ComparisonSession` shows divergence on Q1.C at digiTS-side, this
  is **`architecture-fix`** with the same root cause as
  `dc-op-parity-divergence.md`'s BJT entry. The fix lands in the BJT
  load function, not in the Playwright surface.

- If headless passes (digiTS gives 0.0957744513) but Playwright drifts,
  the drift is in postMessage / property-bag plumbing between the
  Playwright DOM and the engine. **`architecture-fix`** against the
  postMessage adapter (`src/io/postmessage-adapter.ts`) or the property
  popup write path.

## Category

**`architecture-fix`** (preliminary) with **`contract-update`** branch
if the published reference is wrong against current ngspice.

## Tensions / uncertainties

1. **Reference value provenance is not in the test.** The Playwright
   comment at line 167 says "ngspice ref: 9.57744513e-02" but does not
   cite which ngspice version, which model defaults, or which run produced
   it. If the reference was captured before any of digiTS's recent BJT
   adjustments (excess-phase, area scaling, IKF/IKR knee, etc.), it may
   simply be stale.

   **`[ESCALATE: needs user clarification on whether to refresh the
   reference value by running ngspice on the test circuit, OR to fix
   digiTS so it matches the existing reference.]`**

2. **Phase B reference (`7.63368375V`) cannot be verified without
   running the test fully.** If Phase A's failure mode is also Phase B's
   failure mode, both references may need refresh; if only Phase A is
   wrong, the hot-load path is independently sound. The headless
   reproduction in Step 1-2 distinguishes these.

3. **The latent BJT setParam shape risk.** `bjt.ts:2079-2084` calls
   `makeTp()` which invokes `computeBjtTempParams` over the full param
   bag. If a future param is added to the BJT and `computeBjtTempParams`
   does NOT consume it (so `tp` is stale on that param), `setParam` on
   that param would silently no-op the temp recompute. This is not the
   root cause of the present drift, but it is a related shape-risk.

4. **Pool slot flush — not the issue here.** The BJT's pool slots
   (`BJT_L1_SCHEMA` slots VBE, VBC, CC, CB, ...) are written by `load()`
   on every iteration and not seeded from `params` during normal
   operation. Hot-loading BF does NOT need to flush pool slots; the
   next NR iteration overwrites them.

   But: `applyInitialValues` (used in `initState()`) is keyed off
   `params.polarity` (BJT_L1_SCHEMA:1029 `compute: (_p) => _p["polarity"]
   === 1 ? 0.6 : -0.6`). After `setParam("BF", ...)` is called on a
   pre-compiled BJT, `initState` is not re-invoked, so the schema's
   `fromParams` initial values are not re-applied. This is correct
   behaviour: the initial-VBE seed is for cold-start NR, not for
   hot-load. No fix needed here.

5. **Other Playwright tests in the same family.** `pin-loading-mode`
   tests (suites 3 & 4 in the same file) use `setSpiceParameter('BF', …)`
   indirectly via the property popup. If they also drift, the diagnosis
   is shared. If they pass, the BF write path through the popup is
   correct and the issue is the BJT itself at construction time.

   **`[ESCALATE: confirm whether the Phase A drift reproduces in the
   other Playwright BJT tests (master-circuit-assembly.spec.ts:343 also
   does `setSpiceParameter('Q1', 'BF', 50)`).]`**
