# Test-Fix Jobs — remaining work after burst-4 dispatch

**Test results after dispatch (uncommitted on working tree):**
- vitest: **6533 passed, 115 failed** (was 191) — **-76 failures**
- playwright: timed out at 600s wall clock; placement-sweep cluster all
  timing out at 30s each. Likely cascade from a single startup error
  (see CRITICAL below). E2E re-run blocked until that's fixed.

**Status legend:**
- `[CRITICAL]` — blocking many tests; fix first
- `[BLOCKED]` — needs user direction
- `[OPEN]` — not yet attempted

---

## §C — Critical blockers (fix first)

### C1 — `register-all.ts` still imports deleted `tunnel-diode.js` `[CRITICAL]`

**Failure pattern:**
```
Failed to load url ./semiconductors/tunnel-diode.js (resolved id: ./semiconductors/tunnel-diode.js) in C:/local_working_projects/digital_in_browser/src/components/register-all.ts. Does the file exist?  (x2)
```

**Sites:**
- `src/editor/__tests__/wire-current-resolver.test.ts` (2 tests)

**Likely also breaking:** the entire Playwright placement-sweep cluster
(150+ tests timing out at 30s) — the app fails to boot when the registry
import throws.

**Fix:** Remove the `tunnel-diode` import and registry registration from
`src/components/register-all.ts`. The component was deleted (per git
status: `D src/components/semiconductors/tunnel-diode.ts`,
`D src/components/semiconductors/__tests__/tunnel-diode.test.ts`) but the
registry still references it.

Also check / remove other tunnel-diode references:
- UI palette (icons, palette JSON)
- `.dig` file references in fixtures/circuits
- Documentation

**Resolves:** 2 vitest tests directly, plus the entire Playwright
placement-sweep cascade (~150 tests) once the app can boot.

---

## §J — Test-migration jobs (test bugs; rewrite to current contract)

### J7c — PB-IND golden re-record `[OPEN]`

**Site:** `src/solver/analog/__tests__/setup-stamp-order.test.ts` PB-IND
TSTALLOC sequence test.

**Verdict:** ALIGNED with ngspice (`indsetup.c:96-100` — 5 stamps; digiTS at
`inductor.ts:239-243` matches). Plain golden re-record needed.

**Action:** Run the test, capture actual emission via
`solver._getInsertionOrder()`, overwrite the golden literal. Cannot be done
without running tests, so the agent dispatch round skipped it.

---

### J7a / J7b — golden re-records after L1 BJT switch `[OPEN]`

**Sites:** `src/solver/analog/__tests__/setup-stamp-order.test.ts` PB-BJT
and PB-SCR golden literals.

The factory switches landed (J7a test, J7b production). The golden literals
were left intact; the tests will fail with sequence-mismatch and the user
re-records against the actual L1 emission.

**Expected emission lengths:**
- PB-BJT: 20 entries (`bjtsetup.c:435-464` minus 3 substrate stamps when subst=0)
- PB-SCR: 40 entries (2 × 20 substrate-dropped L1 stamps)

---

### J12 — `behavioral-sequential` outputs read 0 (digital wiring not driven) `[BLOCKED — needs decision]`

**Failure pattern:** `expected +0 to be 5/3/85/165` (×6)

**Site:** `src/solver/analog/__tests__/behavioral-sequential.test.ts` —
`counts_on_clock_edges`, `clear_resets_to_zero`, `output_voltages_match_logic`,
`latches_all_bits`, `holds_value_across_timesteps`, `sequential_pin_loading_propagates`

**Root cause:** Tests bypass the facade entirely (hand-rolled `makeNullSolver`,
direct element construction, no `compileAnalogPartition` or facade anywhere).
Migration to `DefaultSimulatorFacade` blocked because:
1. No JSON counter/register fixture exists in repo, and the spec prohibits
   fabricating one without authorization.
2. Several tests assert on internal element state (`element.count`,
   `element.storedValue`, direct `allocElement` call tracking) not exposed
   through the facade's public API (`readSignal`, `step`, etc.).

**User decision required:** (a) authorize fabricating a counter/register
JSON spec + accept loss of internal-state coverage; or (b) keep the tests
direct-stamp but rewrite under the new contract; or (c) move these tests
to `headless/__tests__/` and assert against facade signal reads only.

---

## §K — Production / architecture jobs

### K4 — Real-opamp voltage-limited NR `[BLOCKED — needs scope decision]`

**Status:** Dispatch agent hit STOP condition. `real-opamp.ts` has **no
pool-backed state infrastructure**:

- `_stateBase: -1` declared in element literal but never allocated
- No `poolBacked: true`, no `stateSize`, no `stateSchema` on the element
- All state (`vInt`, `vIntPrev`, `_vOutPrev`, `aEff`, `geq_int`,
  `outputSaturated`, etc.) lives in **closure variables**
- `accept()` writes to closure assignments (e.g. `vIntPrev = vInt`,
  `_vOutPrev = readNode(ctx.rhs, nOut)`), no `pool.state0` access anywhere
- `ctx.noncon` is a plain `number`, not `{value: number}` — increment is
  `ctx.noncon++`, NOT `ctx.noncon.value++` as originally specified

**User decision required:**

- **Option 1 — Add full pool-backing as part of K4:** Add `poolBacked: true`,
  `stateSize`, `stateSchema`, allocate in `setup()`, migrate all closure
  state to pool slots, then add `SLOT_VINT_PREV`. Architecturally correct
  per diode pattern but larger blast radius than the original K4 spec.
- **Option 2 — Implement K4 against the existing closure pattern:** The
  `vIntPrev` closure variable already tracks the previous accepted `vInt`,
  and `accept()` already advances it. The `railLim` call in `load()` would
  use `vIntPrev` directly. This stays inside the K4 spec scope as written
  ("adapt to its existing pattern").
- **Option 3 — Defer K4:** Resolve pool-backing question separately first.

**Dispatch-spec carryover (re-usable when unblocked):**

The `railLim` helper text is canonical and ready to add to
`newton-raphson.ts`:

```ts
/**
 * Voltage limiter for behavioral amplifier rail clamps. Algorithmic peer of
 * DEVpnjlim (devsup.c:50-84) and DEVlimvds (devsup.c:20-40), but shaped for
 * hard rail clamping rather than junction log-compression or FET vds magic
 * constants. NOT a literal port of any single ngspice function — the rail-clamp
 * topology has no first-class ngspice analog. The algorithmic pattern (limit,
 * set icheck, bump CKTnoncon) IS the canonical NR-convergence discipline used
 * by every nonlinear ngspice device.
 */
export function railLim(
  vnew: number,
  vold: number,
  vRailPos: number,
  vRailNeg: number,
): { vnew: number; limited: boolean } {
  if (vnew > vRailPos && vold < vRailPos) {
    return { vnew: (vRailPos + vold) / 2, limited: true };
  }
  if (vnew < vRailNeg && vold > vRailNeg) {
    return { vnew: (vRailNeg + vold) / 2, limited: true };
  }
  return { vnew, limited: false };
}
```

**Resolves:** 10 tests (all 10 real-opamp failures).

---

### K11-B — Move topology validation post-`setup()` `[BLOCKED — excluded from dispatch by user]`

**Verdict:** Production architectural bug. `compiler.ts:912-932` runs
topology validation BEFORE setup; the validator at `compiler.ts:1437-1448`
reads `element.branchIndex` which is `-1` until `setup()` runs.
Same defect silently disables `detectVoltageSourceLoops` and
`detectInductorLoops`.

**User decision (resolved):** Option B1 — move validation post-setup.

**Implementation paths:**
- **Path A** — pull validation forward into the engine: add a post-setup
  hook in `analog-engine.ts:_setup()` that calls the validator with the
  populated `branchIndex` values, then routes diagnostics to the same
  collector the compiler uses. **(Recommended — smaller blast radius.)**
- **Path B** — push setup into the compiler: have `compileAnalogPartition`
  drive `setupAll` immediately after building `topologyInfo`, then run
  validation on the post-setup state.

**Sites:** Production: `src/solver/analog/compiler.ts:912-932, 1437-1448, 1557`.
Tests: `src/solver/analog/__tests__/competing-voltage-constraints.test.ts:129`.

**ngspice citations (verbatim — for "no pre-flight" framing):**
- `cktinit.c:24-135` — pure struct allocation, no topology inspection
- `cktsetup.c:31-131` — per-device matrix-pointer registration, no
  cross-device validation
- `cktsoachk.c:35-53` — runs only post-convergence
- `spfactor.c:260-262` — singularity detected inside elimination loop
- `niiter.c:885-904` — E_SINGULAR retry → forceReorder + continue;
  if reorder also fails: `"singular matrix: check nodes %s and %s\n"`

**Side benefit:** Once K11-B lands, `detectVoltageSourceLoops` and
`detectInductorLoops` start working too.

**Resolves:** 1 test directly (`competing-voltage-constraints`). Latent
fixes for `detectVoltageSourceLoops`/`detectInductorLoops`.

---

## §E — Numerical / parity escalations (NOT test fixes)

Per CLAUDE.md ngspice-parity vocabulary rules, every item below is a
candidate for `spec/architectural-alignment.md` (architectural divergence)
or `spec/fix-list-phase-2-audit.md` (numerical bug). **Agents do not
edit `architectural-alignment.md`** — escalate to user with the cited
ngspice file, the digiTS file, and the divergent quantities.

### E3 — `harness/comparison-session.ts` matrix-entry divergences (×10)

All ten tests fail with `Matrix-entry value divergence at step=0
attempt=0 iter=0`. These are the canonical ngspice-parity comparison
tests (buckbjt_load_dcop, transient: CCAP/PNP/inductor, DC-OP match,
transient_rectification_match, dc_op_pnjlim_match, dump+compare structure).

**Action:** This is the **first tool** per CLAUDE.md's "ngspice
comparison harness" rule. Run the harness, identify the iteration where
values first diverge, and report the exact (row, col, ours, ngspice)
quartet. Escalate with that quartet.

---

### E4 — Bit-exact misses with absDelta ~10^-21

- `parity-helpers.ts` — `transient_match` (absDelta=4.4e-21)
- `parity-helpers.ts` — `transient_oscillation_match` (absDelta=1.6e-24)

**Root cause:** Floating-point operation ordering between digiTS and
ngspice differs at the ULP level. Per CLAUDE.md banned-vocab rules, this
is an **architectural escalation** ("intentional divergence" is banned;
items go in `architectural-alignment.md`).

**Action:** Escalate. The user decides whether to accept FP-ordering
divergence or chase the per-summation-order match.

---

### E6 — diode_circuit_direct strategy mismatch

`dc-operating-point.test.ts` — `diode_circuit_direct`
(`expected 'dynamic-gmin' to be 'direct'`)

**Root cause:** Production now falls back to dynamic-gmin where ngspice
takes the direct path on the same diode circuit. Architectural —
escalate after E1/E2 land (they likely affect the strategy decision).

---

### E7 residual — convergence-regression / state-pool

- `convergence-regression.test.ts` — `half-wave rectifier converges`,
  `statePool state0 has non-zero values after DC OP`,
  `statePool state1 is updated after accepted transient step`,
  `reset restores initial values in statePool`,
  `diode circuit runs 100 transient steps without error` (5 tests;
  likely cascade from K3/K1/J19).

Re-evaluate after burst-4 fixes settle.

---

### E8 — Misc numerical / convergence / stamp-shape

| Test | Failure | Likely lane |
|---|---|---|
| `rlc-lte-path.test.ts` — RC step / RL step exponential matches | 5 vs ≤3.22, 1 vs ≤0.64 | E1 (LTE rooted) |
| `behavioral-combinational/-gate.test.ts` — pin_loading | false-true (3×) | likely §J12 family |
| `tapped-transformer.test.ts` — `center_tap_voltage_is_half`, `full_wave_rectifier`, `symmetric_halves` | 1.5e+300 / ERROR / 0 | numerical instability — E |
| `transformer.test.ts` — `voltage_ratio`, `power_conservation`, `analogFactory creates element with correct branch indices` | 5.7e+20 / 4.8e+193 / -1 vs 5 | numerical instability + branchIndex==-1 contract change |
| `transmission-line.test.ts` — `step input arrives at port 2`, `matched load no reflection`, `lossy line < lossless`, `unterminated line voltage rises`, `N=50 delay more accurate than N=5` | false-true / ERROR / 0 | numerical (E) |
| `jfet.test.ts` — `emits_stamps_when_conducting` (5e-11 vs >1e-5) | numerical, jfet model | E |
| `analog-fuse.test.ts` (recently modified, may have new test cases) | — | check after baseline |
| `potentiometer.test.ts` — `wiper=0.5 G_top=G_bottom=1/5000 bit-exact` (0.0002 vs 0.0004) | 2× factor; production stamp pair-counting | K (production) |
| `capacitor.test.ts` — `capacitor_load_transient_parity` (1 vs -0.0080) | numerical / K3 family |
| `inductor.test.ts` — `inductor_load_transient_parity` (NaN vs 9.98e-7) | K3 family |
| `ac-voltage-source.test.ts` — `rc_lowpass` | numerical (E1) |

---

## §P — Playwright (browser) failures

### P1 — CMOS-mode gate timeouts (×6)

Tests: `And/Or/NAnd/NOr/XOr/XNOr works in cmos mode` in
`gui/component-sweep.spec.ts:766` — all hit the 30s test timeout.

**Likely cause:** CMOS mode compilation triggers a new convergence path
(BJT-rooted) that hangs or runs orders of magnitude slower than the
digital fallback. NOT a test fix — production fix once underlying analog
regressions land.

---

### P2 — `master-circuit-assembly.spec.ts` (×3)

- `Master 1: digital logic` — timeout at line 46
- `Master 2: analog — switched divider, RC, opamp, BJT` — status bar error
- `Master 3: mixed-signal — DAC, RC, comparator, counter` — `toBeLessThan` fail

These are the highest-leverage E2E tests. Likely surface K-class issues in
combination. Run after the analog production fixes land.

---

### P3 — `hotload-params-e2e.spec.ts` BF param drift

Test: `changing BF on BJT via primary param row changes output voltage`
— observed 0.09577 vs expected 0.09577 with 1e-7 precision; off by 2.8e-6.

**Likely cause:** Numerical drift, related to E1/E2 family. Escalate.

---

### P4 — `analog-bjt-convergence.spec.ts` (×2)

- `compile and step — no convergence error, supply rail is 10V` — 0 vs 0.0208
- `step to 5ms — output voltage evolves and trace captures transient` — `not.toBeCloseTo` failure

**Likely cause:** Same BJT-rooted regression as the unit failures.

---

### P5 — `component-sweep.spec.ts` ADC bits=4 (×1)

`ADC at bits=4: set property and compile` — status bar shows error.
Possibly K-family ADC compile path.

---

## Open user gates

| Gate | Job | Question |
|---|---|---|
| 1 | §J12 | Authorize counter/register JSON fixture (a), keep direct-stamp under new contract (b), or move to facade-only assertions (c) |
| 2 | §K4 | Add full pool-backing to real-opamp (Option 1), use existing closure pattern (Option 2), or defer (Option 3) |
| 3 | §K11-B | Path A (validation in engine setup hook — recommended) or Path B (compiler drives setupAll) |

---

## Next steps

1. **Run vitest** to measure post-dispatch reduction.
2. **Re-record** PB-BJT, PB-SCR, PB-IND goldens (J7a/J7b/J7c) from actual emission.
3. **Resolve K4 scope** — pick Option 1/2/3 above.
4. **Resolve J12** — pick gate option.
5. **Authorize K11-B** path.
6. **Escalation lane:** run §E3 harness comparison sessions and produce
   `(row, col, ours, ngspice)` quartets for E3, E4, E6, E7 residual, E8.
7. **Playwright** (P1–P5) re-run after analog production fixes land.
