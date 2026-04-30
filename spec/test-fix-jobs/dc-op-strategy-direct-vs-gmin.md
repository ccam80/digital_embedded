# dc-op-strategy-direct-vs-gmin

## Problem statement

`src/solver/analog/__tests__/dc-operating-point.test.ts:390-407` (test name
`diode_circuit_direct`) constructs a 5V → 1kΩ → diode (Is=1e-14, N=1) → GND
circuit and asserts:

```ts
expect(ctx.dcopResult.method).toBe("direct");
```

The reported failure is `expected 'dynamic-gmin' to be 'direct'`. digiTS's
DC-OP ladder falls through from direct NR to dynamic-gmin on a circuit that
ngspice converges directly.

This means digiTS's direct-NR phase is reporting non-converged on a
well-conditioned single-diode circuit where ngspice (with the same diode
model and the same biasing) converges in ~3-5 iterations.

## Sites

- Failing test:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\dc-operating-point.test.ts:390-407`.
- Test-only inline diode (used by this test):
  `dc-operating-point.test.ts:90-142` (`makeDiode`).
- Production diode (NOT used by this test):
  `C:\local_working_projects\digital_in_browser\src\components\semiconductors\diode.ts`.
- Production ladder:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts`
  (`solveDcOperatingPoint` → `cktop` → `dynamicGmin`).
- Production NR:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts`.

## Verified ngspice citations

`ref/ngspice/src/spicelib/analysis/cktop.c:27-86` (full `CKTop`):

```c
ckt->CKTmode = firstmode;                              // line 35
if (!ckt->CKTnoOpIter)
    converged = NIiter(ckt, iterlim);                  // line 46 — direct attempt
else
    converged = 1;                                     // line 48 — opt-in skip-direct

if (converged != 0) {
    if (ckt->CKTnumGminSteps >= 1) {                   // line 56 — gmin gate
        if (ckt->CKTnumGminSteps == 1)
            converged = dynamic_gmin(ckt, ...);        // line 58
        else
            converged = spice3_gmin(ckt, ...);         // line 60
    }
    if (!converged) return (0);                        // line 62 — early-return on gmin success
    if (ckt->CKTnumSrcSteps >= 1) { ... }              // line 71 — src-step fallback
}
```

Direct path is taken when `NIiter(ckt, iterlim)` returns 0 (zero) on the
first call. ngspice's `NIiter` (niiter.c:610-1101) returns 0 when the
internal `CKTnoncon == 0 && iterno != 1` and the operating point passes
`MODEINITFLOAT` convergence (niiter.c:1058-1069).

For a 5V/1kΩ/Shockley-diode circuit (Vd ≈ 0.65-0.7V), ngspice's NR
trajectory:

1. Iter 1: enter `MODEINITJCT`. `dioload.c:135-136` seeds `vd = DIOtVcrit`
   (≈ 0.6V for Is=1e-14, n=1, T=300.15K).
2. Iter 2: mode advances to `MODEINITFIX` (niiter.c:1071-1073). `pnjlim`
   compresses any large step (`devsup.c:DEVpnjlim`).
3. Iter 3-5: mode advances to `MODEINITFLOAT`, currents converge under
   `dioconv.c:DIOconvTest`.

Convergence in 3-5 iterations from this seed is the standard ngspice
behaviour for this textbook circuit.

## Investigation

The test fixture's `makeDiode` (`dc-operating-point.test.ts:90-142`) is
NOT the production diode. Critical differences:

| Aspect | Production `createDiodeElement` (`diode.ts`) | Test `makeDiode` (test file) |
|---|---|---|
| `MODEINITJCT` seed | `vd = tVcrit` (diode.ts:559-562) — mirrors `dioload.c:135-136` | Reads `ctx.rhsOld[a]` → reads 0; computes `expv = exp(0/vt) = 1`, `id = 0`, `geq = Is/vt ≈ 4e-13` (test:108-127) |
| `pnjlim` | Yes (diode.ts:602) | No |
| GMIN injection | `gd + GMIN; cd + GMIN*vd` (diode.ts:677-678, 691-692) — mirrors `dioload.c:298-299` | No |
| `checkConvergence` | Current-prediction test (diode.ts:803-822) — mirrors `dioconv.c:DIOconvTest` | Voltage-delta only (test:128-137) |
| `noncon` bump on pnjlim | Yes (diode.ts:607) — mirrors `dioload.c:411-414` | No (no pnjlim) |

The test diode does NOT seed `vd = DIOtVcrit` under `MODEINITJCT`. It
reads `ctx.rhsOld[a]`, which is zero on the first NR call. With
`expv = 1`, `id = 0`, `geq = Is/vt ≈ 4e-13`, the diode contributes
essentially zero conductance and zero current to the matrix — leaving the
NR iteration to bootstrap from a useless initial guess. With no `pnjlim`,
the next iteration sees `vd ≈ 5V` (the supply pulls the anode) and
`expv = exp(5/0.0259) ≈ 5e+83` (or the `vMax` clamp at 40·vt·N saturates
it to `exp(40)`), producing a divergent step that NR cannot recover from
without the limiter.

The production NR loop reports non-converged, the strategy ladder falls
through to `dynamicGmin`, and the test's `expect(method).toBe("direct")`
fails.

This is **not a bug in the production NR loop or strategy ladder** — both
are ngspice-faithful per the cktop.c citation. It is a **test-fixture
divergence**: the test-only `makeDiode` is missing three ngspice-spec
behaviours (MODEINITJCT seed, pnjlim, GMIN injection, current-based
convergence test).

## Recommendation

**Category: `contract-update`.** The test fixture, not the production
code, is the divergent surface. Two clean fixes (Option A is preferred):

### Option A — Replace test-only diode with production factory

`dc-operating-point.test.ts:90-142` becomes:

```ts
import { createDiodeElement, DIODE_PARAM_DEFAULTS } from
  "../../../components/semiconductors/diode.js";
import { PropertyBag } from "../../../core/properties.js";

function makeDiode(
  nodeAnode: number,
  nodeCathode: number,
  Is: number,
  N: number,
): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS, IS: Is, N });
  return createDiodeElement(
    new Map([["A", nodeAnode], ["K", nodeCathode]]),
    props,
    () => 0,
  ) as AnalogElement;
}
```

This brings ngspice-faithful seeding, limiting, GMIN, and convergence
checking into every test using `makeDiode`. The `diode_circuit_direct`
test then passes because the production NR converges directly.

The other tests in `dc-operating-point.test.ts` that use this `makeDiode`
must be re-validated:

| Test | Expected behaviour after Option A |
|---|---|
| `simple_resistor_divider_direct` | Doesn't use diode — unchanged. |
| `diode_circuit_direct` | Now passes (direct NR converges). |
| `direct_success_emits_converged_info` | Doesn't use diode — unchanged. |
| `gmin_stepping_fallback` (200V/1Ω/diode) | The 200V/1Ω makes `Vd ≈ 0.85V` and `Id ≈ 199A`. Production diode with pnjlim may still converge directly, breaking the gmin coverage. May need to use `noOpIter=true` or a more pathological circuit (e.g. 1MV) to force gmin. |
| `source_stepping_fallback` | Same risk as above. |
| `dynamicGmin_initial_diagGmin_matches_ngspice` | Uses `makeGminDependentElement` (not `makeDiode`) — unchanged. |
| Tests using `makeGminDependentElement` / `makeSrcSteppingRequiredElement` | Unchanged — those have their own non-converging behaviour built in via the `ctx.gmin === 0` and `ctx.srcFact >= 1` blocking. |

### Option B — Make the test-only diode ngspice-compliant inline

Add `MODEINITJCT` seed, `pnjlim`, GMIN injection, and a current-based
`checkConvergence` to `dc-operating-point.test.ts:90-142`. This duplicates
production code in a test file — `composite-component-base.md:139-140`
flags this kind of pattern as anti-architectural. **Not recommended.**

## Category

**`contract-update`** — the test must be fixed, not the production code.

## Tensions / uncertainties

1. **`gmin_stepping_fallback` may regress under Option A.** That test
   relies on the test diode's failure to converge directly under extreme
   biasing. A spec-compliant diode might converge directly even at 200V/1Ω
   thanks to pnjlim's logarithmic compression. The downstream agent must
   re-run the suite after Option A and decide whether to bump that test's
   driving voltage or set `params.noOpIter = true` to force the gmin path.

   **`[ESCALATE: needs user decision on whether `gmin_stepping_fallback`
   and `source_stepping_fallback` should pivot to `params.noOpIter=true`
   instead of relying on circuit pathology to force fallback.]`**

2. **All five "fallback-coverage" tests in `dc-operating-point.test.ts`
   build on the test-only diode.** Migrating the file to the production
   diode is correct architecturally but expands the blast radius beyond
   the single failing `diode_circuit_direct` test. The clean cut is to do
   the whole file in one PR; the unclean cut is to fix only
   `diode_circuit_direct` and leave the other four tests on the
   non-spec-compliant fixture (which means they're still passing for the
   wrong reason).

   **`[ESCALATE: needs user decision on full-file migration vs targeted
   fix.]`**

3. **`makeDiode` is exported test-locally — no other test files import
   it.** Verified by grep. So the migration is contained to one file.

4. **The production diode uses `defaultModel: "spice"`** (diode.ts:1026)
   so a `PropertyBag.replaceModelParams({...DIODE_PARAM_DEFAULTS, IS, N})`
   is sufficient — no model-key dispatch needed (the factory in Option A
   accepts the partition directly).
