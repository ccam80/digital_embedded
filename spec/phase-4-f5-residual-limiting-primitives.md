# Phase 4: F5 — Residual Limiting Primitives

## Overview

Three primitive-level fixes in the shared limiting helpers (`newton-raphson.ts`) and two call-site fixes in device `load()` bodies (`led.ts`, `bjt.ts`). This phase closes out what remained of F5 after Phase 2.5 landed D4 (pnjlim Gillespie branch), H1 (`limitingCollector` infrastructure), `LoadContext.cktFixLimit`, and Zener `tBV`.

Phase 4 depends on Phase 3 and gates the parallel device phases (5, 6, 7, 7.5). Every subsequent device-level port reads these primitives at their post-Phase-4 state — the `fetlim` coefficient change lands before MOSFET (Phase 6) and JFET (Phase 7) port work, and the LED limitingCollector push completes the diagnostic surface the harness phases (9, 10) walk.

**Targeted vitest:** `npx vitest run src/solver/analog/__tests__/newton-raphson-limiting.test.ts` (new in this phase), plus `src/solver/analog/__tests__/harness/stream-verification.test.ts` and `src/components/io/__tests__/led.test.ts`.

**Out of scope:** Changes to `pnjlim` itself (D4 Gillespie branch already landed), `cktFixLimit` gating (H1 already landed), Zener limiting (`tBV` already landed in Phase 2.5 W4.B.2), any device-level `load()` rework beyond the two targeted call sites below.

---

## Wave 4.1: Primitive fixes in `newton-raphson.ts`

### Task 4.1.1: `fetlim` `vtstlo` coefficient — ngspice Gillespie formula

- **Description**: Replace the `fetlim` `vtstlo` calculation with the ngspice Gillespie formula. The current implementation uses the spice3f formula `vtsthi/2 + 2` (retained from the pre-Phase-2.5 port); ngspice switched to `fabs(vold - vto) + 1` per Alan Gillespie's fix, cited in `devsup.c:102` and documented in `ngspice.texi:12002-12008`. The `vtsthi` coefficient at line 170 is unchanged (ngspice `devsup.c:101`).

  The `vtstlo` formula is structurally dominated by the `vtemp` (`vto + 0.5`) and `vtox` (`vto + 3.5`) outer clamps, so no end-to-end `fetlim(vnew, vold, vto)` input straddles both the old and new `vtstlo` thresholds while staying inside the `vnew <= vtemp` or `vnew >= vtox` gate. The formula itself must therefore be unit-testable directly. Extract `vtstlo` into an exported helper `_computeVtstlo(vold: number, vto: number): number` whose body is `Math.abs(vold - vto) + 1`, and rewrite `fetlim` to call it. The helper is exported for test access; it has no other callers.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — add `export function _computeVtstlo(vold: number, vto: number): number { return Math.abs(vold - vto) + 1; }` adjacent to `fetlim`. Replace `const vtstlo = vtsthi / 2 + 2;` at line 171 with `const vtstlo = _computeVtstlo(vold, vto);`. Update the `cite:` comment adjacent to the two coefficient lines to read `// cite: devsup.c:101-102`.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("_computeVtstlo")::it("matches ngspice Gillespie formula")` — `expect(_computeVtstlo(1.0, 1.5)).toBe(0.5 + 1)` (i.e. `1.5`), `expect(_computeVtstlo(5.0, 0.5)).toBe(5.5)`, `expect(_computeVtstlo(0.0, 0.0)).toBe(1.0)`, `expect(_computeVtstlo(-2.0, 0.5)).toBe(3.5)`. Exact numerical equality, not tolerance.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("_computeVtstlo")::it("rejects spice3f vtsthi/2+2 formula")` — at `vold=1.0, vto=1.5`, the spice3f formula yields `(|2*-0.5|+2)/2 + 2 = 3.5`; assert `_computeVtstlo(1.0, 1.5) !== 3.5` (explicitly guards against accidental revert).
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("fetlim")::it("preserves vtsthi as abs(2*(vold-vto))+2")` — no formula change; assert `fetlim(10.0, 5.0, 0.5) === 10.0` (ON, `vold >= vtox=4.0`, `delv=5.0 < vtsthi=11`, no clamp). Guards against accidental drift in the unchanged coefficient.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("fetlim")::it("routes through _computeVtstlo")` — spy/mock `_computeVtstlo` via vitest `vi.spyOn` on the module namespace, call `fetlim(0.9, 0.0, 0.5)` (OFF, `delv>0`, `vnew<=vtemp`), assert the spy was called exactly once with `(0.0, 0.5)`. Guards against future inline re-expansion of the formula that would bypass the helper.

- **Acceptance criteria**:
  - `grep -n "vtstlo = vtsthi" src/solver/analog/newton-raphson.ts` returns zero hits.
  - `grep -n "Math.abs(vold - vto) + 1" src/solver/analog/newton-raphson.ts` returns exactly one hit (inside `_computeVtstlo`).
  - The `// cite:` comment at the `vtstlo` line reads `devsup.c:102`.
  - New tests in `newton-raphson-limiting.test.ts` pass.

### Task 4.1.2: `limvds` parity audit + citation refresh

- **Description**: Audit `limvds` in `newton-raphson.ts:226-241` against `devsup.c:17-40`. The current implementation reads as a direct port (`vold >= 3.5` gate, `3*vold+2` upper clamp, `2` lower floor in high-Vds-decreasing, `4`/`-0.5` clamps in low-Vds). Confirm bit-identical against ngspice; no formula change expected. If the audit finds any numerical divergence (comparator, constant, or branch), STOP and escalate per governing principle §9. If bit-identical, refresh the comment citation above the function to cite the exact line range `devsup.c:17-40`.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — the docstring above `export function limvds(...)` currently cites `devsup.c` without a line range. Update to `devsup.c:17-40`. No code changes.

- **Tests**:
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("clamps high-Vds increasing to 3*vold+2")` — `limvds(vnew=50, vold=10) === 32` (`3*10+2`).
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("floors high-Vds decreasing below 3.5 at 2")` — `limvds(vnew=1.0, vold=5.0) === 2`.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("does not clamp high-Vds decreasing staying above 3.5")` — `limvds(vnew=4.0, vold=5.0) === 4.0`.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("clamps low-Vds increasing to 4")` — `limvds(vnew=10, vold=2) === 4`.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("clamps low-Vds decreasing to -0.5")` — `limvds(vnew=-10, vold=2) === -0.5`.
  - `src/solver/analog/__tests__/newton-raphson-limiting.test.ts::describe("limvds")::it("handles vold=3.5 boundary via >=")` — `limvds(vnew=4.0, vold=3.5)`: takes `vold >= 3.5` branch, `vnew > vold`, clamps to `Math.min(4.0, 3*3.5+2=12.5) = 4.0`. Asserts `=== 4.0`. Guards against accidental `>` instead of `>=` at the gate.

- **Acceptance criteria**:
  - `limvds` implementation unchanged (diff limited to docstring comment).
  - Docstring citation updated to `devsup.c:17-40`.
  - All six `limvds` tests pass.

### Task 4.1.3: `pnjlim` citation refresh (post-D4)

- **Description**: The `pnjlim` function already includes the D4 Gillespie negative-bias branch (lines 67-82 in `devsup.c`, landed in Phase 2.5). The docstring at `newton-raphson.ts:67` still cites `devsup.c:50-58`, which predates the Gillespie inclusion. The docstring at line 84 cites `devsup.c:50-84` — off-by-one, `DEVpnjlim`'s function declaration begins at `devsup.c:49` (`double` on its own line) and ends at line 84. Normalize both citations to `devsup.c:49-84`. Comment-only; no code changes.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — at the docstring for `pnjlim`, change `(devsup.c:50-58)` at line 67 to `(devsup.c:49-84)`. Change `(devsup.c:50-84)` at line 84 to `(devsup.c:49-84)`. Verify via post-edit grep that every `pnjlim`-adjacent citation reads `devsup.c:49-84` consistently.

- **Tests**:
  - No new tests — this is a comment-only change. Existing `pnjlim` tests under `src/solver/analog/__tests__/` continue to pass unchanged.

- **Acceptance criteria**:
  - `grep -n "devsup.c:50-58" src/solver/analog/newton-raphson.ts` returns zero hits.
  - `grep -n "devsup.c:50-84" src/solver/analog/newton-raphson.ts` returns zero hits.
  - `grep -n "devsup.c:49-84" src/solver/analog/newton-raphson.ts` returns at least two hits (both the top-of-function docstring and the port-verbatim comment above `_pnjlimResult`).

---

## Wave 4.2: Call-site fixes

### Task 4.2.1: LED `limitingCollector` push

- **Description**: The LED `load()` in `led.ts:249-263` already has the MODEINITJCT skip (`if (ctx.cktMode & MODEINITJCT) { ... pnjlimLimited = false; }`) and already increments `ctx.noncon.value` when pnjlim limits. What is missing is the `limitingCollector.push()` call — diode (`diode.ts:562-571`) and BJT L0 (`bjt.ts:875-894`) both push a `LimitingEvent` onto `ctx.limitingCollector` after the pnjlim-gated branch; LED does not. Add the push, modeled verbatim on the diode pattern, with `junction: "AK"` (anode-cathode). The push must fire in both branches (MODEINITJCT seed: `wasLimited: false, vBefore === vAfter === vdRaw`; pnjlim branch: `wasLimited: pnjlimLimited, vBefore: vdRaw, vAfter: vdLimited`). Push is gated on `if (ctx.limitingCollector)` matching every other call site in the codebase.

- **Files to modify**:
  - `src/components/io/led.ts` — inside `load()`, immediately after the `s0[base + SLOT_VD] = vdLimited;` line (line 265 in current file), add a `ctx.limitingCollector`-gated push block:
    ```
    if (ctx.limitingCollector) {
      ctx.limitingCollector.push({
        elementIndex: (this as any).elementIndex ?? -1,
        label: (this as any).label ?? "",
        junction: "AK",
        limitType: "pnjlim",
        vBefore: vdRaw,
        vAfter: vdLimited,
        wasLimited: pnjlimLimited,
      });
    }
    ```
    Reuse the `pnjlimLimited` closure variable (already declared at line 253 and 261).

- **Tests**:
  - `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("pushes AK pnjlim event on non-init NR iteration")` — construct an LED element, build a `LoadContext` with `limitingCollector: []` and non-MODEINITJCT mode, drive `rhsOld` so `vdRaw > vcrit + 2*nVt` to trigger pnjlim limiting, call `load(ctx)`. Assert `ctx.limitingCollector.length === 1`, `ctx.limitingCollector[0].junction === "AK"`, `ctx.limitingCollector[0].limitType === "pnjlim"`, `ctx.limitingCollector[0].wasLimited === true`, `ctx.limitingCollector[0].vBefore !== ctx.limitingCollector[0].vAfter`.
  - `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("pushes AK event with wasLimited=false under MODEINITJCT")` — same fixture with `ctx.cktMode = MODEINITJCT`, `vdRaw` forced to `vcrit`. Assert `ctx.limitingCollector.length === 1`, `ctx.limitingCollector[0].wasLimited === false`, `ctx.limitingCollector[0].vBefore === ctx.limitingCollector[0].vAfter` (both equal to the seed value, `vcrit` or `0` depending on OFF).
  - `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("does not push when ctx.limitingCollector is null")` — build `ctx` with `limitingCollector: null`, run `load(ctx)`. Assert no throw and no attempted array operation. (Passes by not throwing; verifies the guard.)
  - `src/components/io/__tests__/led.test.ts::describe("LED limitingCollector")::it("pushes wasLimited=false on non-init NR iteration when pnjlim does not limit")` — drive `rhsOld` with a small `vdRaw` step so `pnjlim` returns unchanged. Assert `ctx.limitingCollector[0].wasLimited === false`, `vBefore === vAfter`.

- **Acceptance criteria**:
  - `grep -n "limitingCollector" src/components/io/led.ts` returns at least one hit (the new push block).
  - The four new LED limitingCollector tests pass.
  - Existing LED tests (`led.test.ts`) continue to pass unchanged.

### Task 4.2.2: BJT L1 substrate `pnjlim` audit + L0-divergence comment

- **Description**: The BJT L1 `load()` at `bjt.ts:1317-1319` already calls `pnjlim(vsubRaw, s0[base + SLOT_VSUB], vt, tp.tSubVcrit)` and updates `vsubLimited`/`vsubLimFlag` — verifying this is present and argument-correct is the audit portion of this task; no code change expected for the call itself. The remaining work is a structural comment block on the BJT L0 path (`createBjtElement::load()` at `bjt.ts:856-869`) explaining that L0 deliberately has no substrate junction — substrate is an L1-only construct per the L0/L1 model-registry split (E1 APPROVED ACCEPT in `architectural-alignment.md`). The comment must name E1 and reference the existing L0 top-of-`load` comment at `bjt.ts:801-805` ("no caps, no transit time, no excess phase, no substrate, no terminal resistances"), so a reader arriving at the `icheckLimited = vbeLimFlag || vbcLimFlag;` line at `bjt.ts:870` (which reads as "missing `vsubLimFlag`") finds the structural rationale immediately.

  If the audit of lines 1317-1319 finds any of these conditions, STOP and escalate:
  - Argument 1 is not `vsubRaw`.
  - Argument 2 is not `s0[base + SLOT_VSUB]`.
  - Argument 3 is not `vt` (the local variable, which is `tp.vt` per Phase 5 Wave 5.0.2 precondition — but at Phase 4 it may still be `ctx.vt`; either is acceptable at this phase, Phase 5 will normalize).
  - Argument 4 is not `tp.tSubVcrit`.
  - The enclosing gate is not `(mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0`.

  **2026-04-24 clarification applied (spec authoring was stale).** Phase 3 Wave 3.2 (landed at commit `cce3cf3d`, verified PASS) removed `MODEINITPRED` from the L1 pnjlim skip mask per `bjtload.c:386-414` (pnjlim runs unconditionally on the MODEINITPRED-extrapolated `vsubRaw`). This spec was originally authored against the pre-Phase-3 mask that still included MODEINITPRED. The current code at `bjt.ts:1325` with gate `(MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)` (no MODEINITPRED) is the ngspice-correct state and is what Task 4.2.2 audits against — per CLAUDE.md "SPICE-Correct Implementations Only", ngspice is the authority, and the spec has been corrected here to match.

- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — at the end of the L0 `pnjlim` block (immediately after `icheckLimited = vbeLimFlag || vbcLimFlag;` at line 870), add a one-line structural comment:
    ```
    // L0 has no substrate junction — substrate is L1-only per the model-registry
    // split (architectural-alignment.md §E1 APPROVED ACCEPT). See also the
    // "no caps, no transit time, no excess phase, no substrate" L0 scope note at
    // the top of this load() body.
    ```
    No other changes to L0. No changes to L1 (the audit is pass-only).

- **Tests**:
  - No new numerical tests. The L1 substrate `pnjlim` call is already covered by existing BJT L1 tests under `src/components/semiconductors/__tests__/`. This task's verification is the grep/read audit and the comment insertion.
  - `src/components/semiconductors/__tests__/bjt-l0-scope-comment.test.ts::describe("BJT L0 scope documentation")::it("documents L0 substrate divergence after pnjlim block")` — a comment-presence vitest: reads `bjt.ts` as text, locates the L0 `load()` body (anchored on the L0 header comment at `bjt.ts:801-805`), and asserts that the substring `architectural-alignment.md §E1` appears between the `icheckLimited = vbeLimFlag || vbcLimFlag;` line and the `computeBjtOp(` call at line 897. Guards against future reshuffles that would drop the comment and re-introduce reader ambiguity at line 870.

- **Acceptance criteria**:
  - L1 substrate `pnjlim` call at `bjt.ts:1317-1319` unchanged (audit-only).
  - L0 `load()` body contains a structural comment citing `architectural-alignment.md §E1` immediately after `icheckLimited = vbeLimFlag || vbcLimFlag;`.
  - The new comment-presence test passes.
  - Existing BJT L0 and L1 tests under `src/components/semiconductors/__tests__/` continue to pass unchanged.

---

## Commit

One commit covers all five tasks:

```
Phase 4 — F5 residual limiting primitives (fetlim Gillespie + LED collector push + BJT L0 scope)
```
