# dc-op-parity-divergence

## Problem statement

Four ngspice-parity tests assert bit-exact (`absDelta === 0`) per-NR-iteration
agreement between the digiTS engine and ngspice. They currently fail at the
matrix/voltage level somewhere inside the DCOP NR loop. Each test invokes
`assertIterationMatch(...)` from
`src/solver/analog/__tests__/ngspice-parity/parity-helpers.ts` over every
captured (step, attempt, iteration) triple, plus
`assertModeTransitionMatch(...)` and `assertConvergenceFlowMatch(...)`.

The four affected tests (verbatim names, no J/K renumbering):

| Test file (absolute path) | `it(...)` name | Surface checked |
|---|---|---|
| `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ngspice-parity\bjt-common-emitter.test.ts` | `dc_op_match` | `voltages`, matrix, state0, mode ladder, noncon |
| `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ngspice-parity\mosfet-inverter.test.ts` | `dc_op_match` | (same) |
| `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ngspice-parity\rc-transient.test.ts` | `transient_per_step_match` | (same, per timestep) |
| `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\ngspice-parity\rlc-oscillator.test.ts` | `transient_oscillation_match` | (same, per timestep) |

(The fifth parity test, `diode-resistor.test.ts:dc_op_pnjlim_match`, is not
in this lane — it currently passes or fails inside the diode-specific drift
documented in `nr-diode-convergence-drift.md`.)

The bar is verbatim from `parity-helpers.ts:38-42`:

> All numeric comparisons are bit-exact (`absDelta === 0`). Tolerances are
> not allowed — see CLAUDE.md "ngspice Parity Vocabulary" §banned.

So any non-zero `absDelta` on any field reported per-iteration (voltages,
preSolveRhs, ag[0..1], state0/1/2 device slots, matrix entries, noncon,
diagGmin, srcFact, delta, order, initMode) is a hard failure.

## Sites

- Production (engine):
  `C:\local_working_projects\digital_in_browser\src\solver\analog\dc-operating-point.ts`
  (DC-OP ladder; cktop.c-equivalent),
  `C:\local_working_projects\digital_in_browser\src\solver\analog\newton-raphson.ts`
  (NIiter-equivalent NR loop),
  `C:\local_working_projects\digital_in_browser\src\solver\analog\ckt-load.ts`
  (CKTload-equivalent), and per-device `load()` bodies under
  `src\components\semiconductors\*.ts` and `src\components\passives\*.ts`.
- Test infrastructure:
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\harness\comparison-session.ts`
  (paired-session driver),
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\harness\capture.ts`
  (per-iteration snapshot recorder),
  `C:\local_working_projects\digital_in_browser\src\solver\analog\__tests__\harness\ngspice-bridge.ts`
  (FFI to `ref/ngspice/visualc-shared/x64/Release/bin/spice.dll` — built from
  the instrumented `ref/ngspice/src/maths/ni/niiter.c`).

## Investigation procedure (reproducible by a downstream agent)

The harness howto referenced in `CLAUDE.md` ("See `docs/ngspice-harness-howto.md`
for setup and usage.") **does not exist** at that path — verified:

```
C:\local_working_projects\digital_in_browser\docs\          (no ngspice-harness-howto.md)
C:\local_working_projects\digital_in_browser\**\ngspice-harness*.md  (no matches)
```

This is a documentation gap and is escalated below. The procedure that follows
is reverse-engineered from `comparison-session.ts:340-602` and is sufficient
to reproduce the divergence point.

### Step 1 — Verify the DLL is present

The harness skips comparison when the ngspice DLL is missing:

```ts
// parity-helpers.ts:6-13
export const DLL_PATH = "C:/local_working_projects/digital_in_browser/ref/ngspice/visualc-shared/x64/Release/bin/spice.dll";
function dllAvailable(): boolean { try { accessSync(DLL_PATH); ... } }
export const describeIfDll = dllAvailable() ? describe : describe.skip;
```

Confirm the DLL exists or build it (build instructions: out of scope for this
spec — escalated).

### Step 2 — Run the failing test in isolation

```bash
npx vitest run src/solver/analog/__tests__/ngspice-parity/bjt-common-emitter.test.ts
```

The first `assertIterationMatch` failure prints `step=<si> iter=<ii> <field>:
ours=<v1> ngspice=<v2> absDelta=<d>` (parity-helpers.ts:55-205). That message
identifies the (step, iter, field) of the divergence.

### Step 3 — Inspect the full per-iteration record

The harness exposes `ComparisonSession.getIterations(stepIndex)` returning
`IterationReport[]`. Add a one-shot debug block to the test file (do not commit):

```ts
const reports = session.getIterations(0);
console.log(JSON.stringify(reports[firstFailingIter], null, 2));
```

This dumps both engines' nodes, branches, matrix diffs, and per-element
slot diffs for that iteration. The first divergent field — when ordered by
`assertIterationMatch`'s sequence (matrixSize → rhsBufSize → prevVoltages →
preSolveRhs → voltages → ag → device states → limits → mode/order → matrix) —
is the root cause site.

### Step 4 — Map the failing field back to ngspice

| First divergent field | ngspice site to read | digiTS site to read |
|---|---|---|
| `prevVoltages[i]` (rhsOld) | `niiter.c:1095-1097` (post-iter rhs↔rhsOld swap) | `newton-raphson.ts` swap | 
| `preSolveRhs[i]` | per-device `load()` RHS stamp | per-device `load()` `stampRHS(...)` |
| `voltages[i]` | `niiter.c:933` `SMPsolve(...)` | `sparse-solver.ts:solve(...)` |
| `state0[<dev>][<slot>]` | per-device `*load.c` (e.g. dioload.c, bjtload.c) | per-device `load()` `s0[base + SLOT_*] = ...` |
| `matrix[r,c]` | per-device `*load.c` matrix-stamp block | per-device `load()` `solver.stampElement(...)` |
| `ag[0]` / `ag[1]` | `cktdelt.c` and integration setup | `analog-engine.ts` integration coefficient writes |
| `diagGmin` | `cktop.c:164,207-211,295-301` | `dc-operating-point.ts:dynamicGmin/spice3Gmin` |
| `srcFact` | `cktop.c:385,475,514,596` | `dc-operating-point.ts:scaleAllSources` |

For every divergence the read order is: **first** the device load function in
`ref/ngspice/src/spicelib/devices/<dev>/<dev>load.c`, **then** the digiTS
counterpart. Follow that order verbatim — `CLAUDE.md` "ngspice Comparison
Harness — First Tool for Numerical Issues" mandates it.

## Verified ngspice citations

- **NR loop convergence dispatch**:
  `C:\local_working_projects\digital_in_browser\ref\ngspice\src\maths\ni\niiter.c:610-1101`.
  Read in full. Note the rhs/rhsOld swap at line 1095-1097 happens AFTER the
  per-iter instrumentation callback (line 972-1025), so the harness's
  `prevVoltages` is rhsOld at iteration K, voltages is rhs at iteration K
  (post-solve, pre-swap).

- **DC-OP ladder (direct → gmin → src)**:
  `C:\local_working_projects\digital_in_browser\ref\ngspice\src\spicelib\analysis\cktop.c:27-86`.
  `dynamic_gmin` body at 133-269; `spice3_gmin` at 285-356; `gillespie_src`
  at 369-569; `spice3_src` at 583-628.

- **Diode load (DIOload)**:
  `C:\local_working_projects\digital_in_browser\ref\ngspice\src\spicelib\devices\dio\dioload.c:21-445`.
  Three regions at 245-265 (forward / reverse-cubic / breakdown), GMIN
  injection at 290-314, RHS stamp at 429-431, matrix stamp at 435-441.

These citations were verified by direct read of the listed files in this
session.

## Recommendation

The four divergences are (high-confidence) **`architecture-fix`**, not
`few-ULP`. Reasoning:

1. The harness's bar is `absDelta === 0` (parity-helpers.ts:38-42, banning
   tolerance words at the closing-verdict level per `CLAUDE.md`). A few-ULP
   FP-ordering drift on a single matrix entry would surface as `absDelta` in
   the 1e-15 to 1e-12 range; the parity tests have been failing at scales
   visible to the developer (otherwise `dc_op_match` and `transient_*_match`
   would have been triaged separately from `nr-diode-convergence-drift`).

2. The `transient_oscillation_match` and `transient_per_step_match` tests
   loop over many timesteps. A genuine few-ULP drift would never accumulate
   into a per-step mismatch unless the engines were taking different
   trajectories — i.e., a structural divergence (different limiting, different
   GMIN injection, different stamp ordering, different state-slot semantics).

3. `assertIterationMatch` orders fields so the **earliest** divergence
   surfaces. If the failure is in `voltages` and not in `prevVoltages` or
   `preSolveRhs`, the divergence is downstream of LU and indicates an LU
   ordering difference (architectural) rather than a stamp difference.

   If the failure is in `preSolveRhs`, it indicates a load-time arithmetic
   difference — that is where the FP-ordering case is plausible, but only if
   the divergence is in the 1e-16 ULP band on a single slot.

The exact category cannot be cemented without running Step 2-3 above. The
shape of the answer is one of:

- **`architecture-fix`** — different code path taken (different limiter
  fired, missing GMIN injection at a load site, different LU pivot order,
  different mode bit set when the iteration began). Fix the production code
  to mirror the cited ngspice site.

- **`few-ULP`** — single matrix slot or RHS slot off by 1-2 ULP because the
  digiTS load() accumulates contributions in a different order than the
  ngspice load function. Fix by reordering the digiTS additions to match
  the ngspice statement order.

In **either** case the test does not change — the bar is `absDelta === 0`
and the production code must meet it.

## Category

**`architecture-fix`** (preliminary; confirmation requires Step 2-3 of
the investigation procedure).

## Tensions / uncertainties

1. **`docs/ngspice-harness-howto.md` is missing.** `CLAUDE.md` cites this
   document as the entry point for any numerical-discrepancy investigation,
   yet it does not exist in the tree. Until it is written, every downstream
   agent that hits a parity divergence must reverse-engineer the harness from
   `comparison-session.ts`, which costs context and risks divergent
   interpretations.

   **`[ESCALATE: docs/ngspice-harness-howto.md is missing — needs to be
   authored before this lane lands.]`**

2. **Build of the instrumented ngspice DLL is undocumented.** The DLL is
   referenced at the absolute path `ref/ngspice/visualc-shared/x64/Release/bin/spice.dll`.
   The instrumentation hooks live in `ref/ngspice/src/maths/ni/niiter.c` and
   `ref/ngspice/src/spicelib/analysis/cktop.c`. There is no Makefile
   wrapper or `npm` script in the repo for rebuilding it after edits.

   **`[ESCALATE: instrumented-ngspice rebuild procedure needs documentation
   in docs/ngspice-harness-howto.md when that file is authored.]`**

3. **`comparison-session.ts:_assertMatrixStructuralParity()` is referenced
   but private.** The harness asserts structural parity (matrix dimension,
   row/col labels) AFTER the run completes, separately from
   `assertIterationMatch`. If the structural assertion fires first, the
   per-iteration check never gets to run, and the failure looks like a
   structural disagreement rather than a numerical one.

   **`[ESCALATE: confirm whether the four failing tests are blocked at the
   structural-parity assertion or at the per-iteration assertion. The
   investigation procedure above only walks the per-iteration path.]`**

4. **Bit-exact across two LU implementations is a high bar.** ngspice uses
   the Sparse 1.3 library (`ref/ngspice/src/maths/sparse/`); digiTS has
   its own sparse solver in `src/solver/analog/sparse-solver.ts`. Even with
   identical input matrices the LU output can differ at the last ULP if pivot
   order differs. The harness's bar is `absDelta === 0`; if the production
   LU and ngspice LU genuinely diverge at the last ULP, that is a structural
   difference (different pivoting strategy) that belongs in
   `spec/architectural-alignment.md`, not in this lane.

   **`[ESCALATE: needs user decision on whether the LU pivot order in
   `sparse-solver.ts` must mirror Sparse 1.3 exactly. If yes, that is a
   separate architectural job. If no, the parity bar in
   `parity-helpers.ts:38-42` will need an architectural-alignment entry
   — which is a user action per CLAUDE.md.]`**
