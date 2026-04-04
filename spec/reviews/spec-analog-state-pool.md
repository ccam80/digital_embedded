# Spec Review: Analog State Pool (CKTstate0) & Write-Back Removal

## Verdict: needs-revision

---

## Plan Coverage

This is a standalone spec with no associated plan.md phase. Reviewed on its own merits against the problem statement, design, migration plan, test strategy, and risk assessment it contains.

| Spec Section | Present? | Notes |
|---|---|---|
| Problem description: write-back bug | yes | 10 devices listed with file/line references |
| Problem description: convergence contamination | yes | NR delta contamination described |
| Problem description: broken rollback | yes | Missing element-state restore described |
| SPICE reference architecture | yes | CKTrhs/CKTstate0 model described |
| StatePool class design | yes | API shown with class body |
| Per-device slot layouts | partial | Capacitor/inductor slot layout diverges from actual implementation — see Consistency Issues |
| AnalogElement interface change | yes | stateSize, stateBaseOffset, initState additions described |
| Compiler allocation loop | yes | Code snippet provided with location reference |
| Checkpoint/rollback integration | yes | Pseudocode for engine step() shown |
| DC operating point integration | yes | reset() and state1/state2 init described |
| Migration phases 1–6 | yes | All six phases present |
| Risk assessment | yes | Four risks identified |
| Test strategy | no | No tests described in any phase — see Completeness Gaps |
| Estimated scope | yes | File/LOC table present |

---

## Internal Consistency Issues

### 1. Capacitor slot layout contradicts actual capacitor implementation

**Spec section "Per-device slot layouts — Capacitor / Inductor"** states stateSize = 3 with slots: GEQ (0), IEQ (1), V_PREV (2).

The actual `src/components/passives/capacitor.ts` capacitor is a class (`CapacitorElement`) using instance fields `geq`, `ieq`, `vPrev`. Its `stampCompanion` uses `iNow = geq * vNow + ieq` — it reads current from the full Norton equivalent, not a saved `iPrev`. This is architecturally different from the inductor, which saves `iPrev` (branch current) not `vPrev`.

The inductor (`src/components/passives/inductor.ts`) uses `geq`, `ieq`, `iPrev` (not `vPrev`). The spec slot layout names V_PREV for both capacitor and inductor, but the inductor actually needs I_PREV (branch current from `voltages[branchIndex]`). An implementer following the spec's slot name will store the wrong quantity for the inductor.

**What a concrete version would say:** Inductor slot 2 should be named I_PREV (previous branch current, `voltages[branchIndex]`), not V_PREV. The capacitor slot 2 is correctly V_PREV. Additionally, the capacitor's `stampCompanion` relies on both `geq` and `ieq` from the previous step to compute `iNow`; migrating to the pool requires that `iNow = s0[base+GEQ] * vNow + s0[base+IEQ]` be explicitly noted, otherwise the first-call initialisation behaviour (geq=0, ieq=0 → iNow=0) is silently broken.

### 2. `Readonly<Float64Array>` signature change conflicts with `checkConvergence` and `stampCompanion` interfaces

**Spec section "Modified AnalogElement interface"** says: "`updateOperatingPoint` signature changes: `voltages: Float64Array` → `voltages: Readonly<Float64Array>`."

The existing `AnalogElement` interface in `src/solver/analog/element.ts` and `src/core/analog-types.ts` declares:
- `checkConvergence?(voltages: Float64Array, prevVoltages: Float64Array): boolean`
- `stampCompanion?(dt: number, method: IntegrationMethod, voltages: Float64Array): void`
- `updateState?(dt: number, voltages: Float64Array): void`
- `getPinCurrents(voltages: Float64Array): number[]`

`mna-assembler.ts` calls `updateOperatingPoints(elements, voltages)` where `voltages: Float64Array` (mutable) is passed. In TypeScript, `Float64Array` is assignable to `Readonly<Float64Array>` but the reverse is not. If only `updateOperatingPoint` is narrowed, devices that pass the same local reference for both read and write won't get a compile error at the call-site — they'll get it at the implementation site, which is the intended effect.

However, the spec says nothing about whether `mna-assembler.ts:updateOperatingPoints` also needs its signature updated from `voltages: Float64Array` to `Readonly<Float64Array>`. If the assembler still passes a mutable `Float64Array` to a method expecting `Readonly<Float64Array>`, TypeScript will accept it silently (upcast). The write-back lines inside devices will produce compile errors only if `voltages` inside those implementations is typed `Readonly<Float64Array>`. This is achievable, but the spec must be explicit that the assembler's call-site signature does NOT change (it remains mutable), so the type narrowing is solely at the implementation level.

The spec leaves this ambiguous, which could lead an implementer to also narrow the assembler signature, breaking the valid mutable use in the assembler itself (line search, damping in `newton-raphson.ts` writes to `voltages[i]`).

### 3. Phase 4 getter/setter migration for MOSFET adds `_swapped` but spec slot table omits it from the getter/setter list

**Spec section "Phase 4: Migrate MOSFET/JFET"** shows getter/setter pairs for `_vgs`, `_vds`, `_gm`, `_gds`, `_ids`. The MOSFET slot table (stateSize: 12) includes slot 5 as SWAPPED. The actual `fet-base.ts:updateOperatingPoint` sets `this._swapped = limited.swapped ?? false`. The spec's getter/setter code snippet does not include `_swapped`, so an implementer following the snippet will leave `_swapped` as a plain instance field and miss migrating it to the pool, leaving state-pool rollback incomplete for the swap flag.

### 4. Phase 6 pseudocode for engine step() does not match actual `analog-engine.ts` step() structure

**Spec section "Checkpoint/rollback integration"** shows a pseudocode `step()` that:
1. Checkpoint state pool
2. Stamp companions (reads state1 for history)
3. NR solve
4. On failure: loop retryDt halving with rollback

The actual `src/solver/analog/analog-engine.ts step()` stamps companions from `this._voltages` before NR, and on NR failure loops with `this._voltages.set(this._prevVoltages)` before re-stamping. The spec pseudocode says "stamp companions (reads state1 for history)" at the top level, implying companions are stamped once before the retry loop. But the actual code re-stamps companions in each retry iteration inside the loop. The spec does not address this discrepancy. An implementer who follows the pseudocode literally will stamp companions once before the retry loop and not re-stamp on retry, diverging from the existing (correct) behaviour.

Additionally, the spec says "Restore state0 from a checkpoint" at the rollback point. But `statePool.rollback(checkpoint)` restores `state0` — the current iteration state. The `state1` history (previous accepted timestep) must NOT be restored on NR retry (only on LTE rejection after a failed timestep). The spec's pseudocode applies the same `rollback()` to both NR retry and LTE rejection, but the semantics differ: NR retry should restore `state0` to the start of the current timestep but leave `state1`/`state2` untouched. The spec does not distinguish these two cases in `StateCheckpoint`/`rollback` semantics.

---

## Completeness Gaps

### 1. No tests are described anywhere in the spec

The spec has zero test tasks. No test files are listed, no assertion descriptions are provided, no acceptance criteria name specific observable outcomes. The spec says "5 test files, +80 LOC" in the estimated scope table but never describes what those files test or what they assert.

CLAUDE.md requires the Three-Surface Testing Rule for every user-facing feature:
1. Headless API test (`src/**/__tests__/*.test.ts`)
2. MCP tool test (via MCP server tool handlers)
3. E2E / UI test (`e2e/**/*.spec.ts`)

The spec names none of these. There is no test file for `state-pool.ts` itself (unit tests for `checkpoint`, `rollback`, `acceptTimestep`, `reset`). There is no description of what assertions should confirm write-back elimination (e.g., "after `updateOperatingPoint`, `voltages[nodeAnode-1]` is unchanged"). There is no description of convergence regression tests. There are no MCP-surface or E2E-surface tests mentioned.

A reviewer cannot verify the implementation is correct without test criteria.

### 2. Phase 3 "migrate remaining PN-junction devices" has no per-device acceptance criteria

**Spec section "Phase 3"** lists 9 devices in a table and says "Same pattern as diode. Each removes its `voltages[...] = ...` write-back lines." This is the entire specification for migrating 9 devices. No per-device slot layout is given for Zener, LED, Tunnel Diode (though Diode is 4 slots, and these are claimed as 4 too). The Varactor is listed as stateSize 7 but no slot table is provided — only the Diode's 7-slot table is shown. An implementer does not know which 3 extra slots apply to Varactor (the Diode slots 4–6 are CAP_GEQ, CAP_IEQ, VD_PREV which is capacitance-specific — does Varactor share this layout exactly?).

### 3. Phase 5 "migrate reactive passives" lacks slot layout justification for inductor

**Spec section "Phase 5"** says stateSize = 3 for capacitor and inductor, both sharing "GEQ (0), IEQ (1), V_PREV (2)". As noted in Consistency Issues above, the inductor saves `iPrev` (branch current index), not `vPrev`. No slot layout table exists for the inductor. Phase 5 is described in one sentence.

### 4. No acceptance criteria for the StatePool class itself (Phase 1)

**Phase 1** says: create `src/solver/analog/state-pool.ts`, add fields to interfaces, add allocation loop to compiler. No acceptance criterion is given. An implementer has no way to know when Phase 1 is complete. Specifically:
- What should `checkpoint()` and `rollback()` assert in tests?
- What should the compiler do if `stateSize` is missing on an element (should it throw, default to 0, or warn)?
- What is the expected `state0` content after `reset()`?

### 5. No description of how `initState` interacts with hot-reload / `setParam`

CLAUDE.md memory note states: "All model params must be hot-loadable via setParam, system requirement." The spec introduces `initState(pool: StatePool)` called once at compile time. If a param change (e.g. capacitance value change) causes recompilation, `initState` will be called again on a new pool. The spec does not state whether `initState` is idempotent, whether it re-initialises `s0[base + SLOT_GEQ]` to GMIN on each call, or whether re-calling on a non-zeroed pool is safe. This is an interaction the spec should address.

---

## Concreteness Issues

### 1. "Devices already correct" claim for Diac is accurate but misleading

**Spec section "Problem — Devices already correct"** lists Diac as using "local var, no write-back" and references `src/components/semiconductors/diac.ts:170-173`. Verified: `diac.ts updateOperatingPoint` at line 169–174 reads `voltages` into local vars `vA`, `vB` and computes `_v = vA - vB; recompute(_v)` with no write-back. This is correct.

However, the spec says "local var, no write-back" as the state storage mechanism, citing diac.ts lines 170-173. Those lines are the `updateOperatingPoint` body, not "state storage." The Diac's actual state is `_v`, `_geq`, `_ieq` closure variables defined earlier in the file. The description "local var" is imprecise — they are closure-captured mutable variables, not local. An implementer may not realise the Diac also needs pool migration for its `_v`, `_geq`, `_ieq` state to benefit from rollback. The spec never lists Diac in the migration phases, leaving its state non-rollback-capable after the migration.

### 2. Phase 2 code example: `base = this.stateBaseOffset` inside `initState` — ambiguous `this` binding

**Spec section "Phase 2"** shows:

```typescript
initState(pool: StatePool): void {
  s0 = pool.state0;
  base = this.stateBaseOffset;
  s0[base + SLOT_GEQ] = GMIN;
},
```

The element is constructed as an object literal `const element = { ... }`. In the snippet, `this.stateBaseOffset` inside `initState` assumes that `initState` is called as a method on the element object (so `this` refers to the element). The compiler snippet shows `if (element.initState) element.initState(statePool)` — this calls it as a method, so `this` will be the element. This is correct, but the spec does not state this requirement explicitly. An implementer who calls `element.initState.call(statePool)` or `initState(statePool)` as a standalone function would get the wrong `this`. The spec should state: "initState must be called as a method on the element object (`element.initState(pool)`) to ensure correct `this` binding."

### 3. `StateCheckpoint` interface exposes `state0: Float64Array` — ownership semantics unspecified

The spec defines:

```typescript
export interface StateCheckpoint {
  readonly state0: Float64Array;
  readonly simTime: number;
}
```

And `checkpoint(simTime)` is specified to "Snapshot state0 for NR failure rollback." It is not stated whether `state0` in the checkpoint is a copy (new Float64Array) or a reference to the live pool's `state0`. If it is a reference, `rollback` does nothing useful — `state0` would already contain the values from the ongoing iteration. The spec must explicitly state that `checkpoint` copies the array (i.e., `new Float64Array(this.state0)`).

### 4. `acceptTimestep()` description is ambiguous about direction

The spec says: "Rotate history after accepted timestep: state2 ← state1 ← state0."

This is a copy direction description. It means after acceptance, state1 becomes a copy of state0, and state2 becomes a copy of the old state1. But the spec does not say whether these are copy operations (`state1.set(state0)`) or reference swaps. For performance, reference swaps (pointer rotation) are preferred; for correctness with Float64Array, copy is required unless the arrays are swapped. The spec says "Rotate history" which implies swap, but writes "state2 ← state1 ← state0" which implies copy-into. This ambiguity will produce different implementations.

### 5. Convergence contamination description references line numbers that are off

**Spec section "Problem — Convergence check contamination"** says: "After `updateOperatingPoints`, `voltages[i]` at device nodes contains write-back-modified values. The convergence delta is `|limited_new - limited_old|` instead of the correct `|raw_new - raw_old|`."

It references `newton-raphson.ts:315-332`. Verified: the convergence check loop is at lines 322–332 in the actual file (the loop starts at line 322 with `for (let i = 0; i < matrixSize; i++)`). The `updateOperatingPoints` call is at line 315. The spec line range 315–332 is approximately correct and describes the contamination accurately. This is a minor imprecision but the overall bug description is verified as correct.

### 6. Spec states analog-engine.ts line 181 saves `_prevVoltages` and line 212 restores on NR failure

Verified: line 181 is `this._prevVoltages.set(this._voltages)` — correct. Line 212 is `this._voltages.set(this._prevVoltages)` inside the NR retry loop — correct. These line number claims are accurate at time of writing.

---

## Implementability Concerns

### 1. Phase 3 is not self-contained — Varactor slot layout must be inferred

Phase 3 asks an implementer to migrate Varactor (stateSize: 7) but provides no slot layout table for it. The Diode has a 7-slot layout (with capacitance), but Varactor is a voltage-controlled capacitor with different physics. An implementer must infer whether Varactor reuses the Diode's 7-slot layout exactly. The spec does not state this. If the layouts differ, an implementer will silently implement the wrong layout.

### 2. Phase 4 is underspecified for JFET

Phase 4 says "MOSFET/JFET — `AbstractFetElement` uses instance fields." The MOSFET slot table (stateSize: 12) includes capacitance slots (CAP_GEQ_GS, CAP_IEQ_GS, CAP_GEQ_GD, CAP_IEQ_GD, VGS_PREV, VGD_PREV). JFET may or may not use all the same cap slots depending on whether the JFET model includes gate capacitances. The spec does not state whether JFET's stateSize is also 12 or a subset. An implementer must read the JFET source to determine this.

### 3. The spec does not state what happens to elements with `stateSize: 0` during `initState` call

Phase 1 says all existing elements get `stateSize: 0` as a default for backward compatibility. The compiler snippet calls `if (element.initState) element.initState(statePool)` only when `initState` is present. But the interface definition adds `initState?` as optional. The spec should explicitly state: elements with `stateSize === 0` do not implement `initState` and no `stateBaseOffset` assignment is needed (or that `stateBaseOffset` remains -1). This is implied but not stated.

### 4. Phase 6 integration with DC operating point is underspecified for the source-stepping path

**Spec section "DC operating point integration"** says: "Before DC solve: `statePool.reset()` zeros everything. After DC convergence: `statePool.state1.set(statePool.state0)` and `statePool.state2.set(statePool.state0)`."

The actual `src/solver/analog/dc-operating-point.ts` runs source-stepping with multiple NR solves (factor ramps from 0 to 1). Each of those NR sub-solves calls `updateOperatingPoints`, which will now write into `state0`. If NR fails at some source-step and the DC solver retries, it needs to rollback `state0` to the start of that source-step. The spec does not address whether `checkpoint/rollback` should be used during DC source-stepping, or whether `state0` contamination during a failed source-step iteration is acceptable. This is a real edge case that an implementer will encounter.

### 5. Test strategy entirely absent — blocks verification

As noted in Completeness Gaps §1, there are no tests. The rules.md states "Failing tests are the best signal" and "Tests ALWAYS assert desired behaviour." An implementation of 6 phases across 26 files with zero test specifications cannot be verified. An implementer has no passing/failing signal to work toward. The Three-Surface Testing Rule from CLAUDE.md is not addressed at all.

Specifically absent:
- No unit test for `StatePool.checkpoint()` / `rollback()` / `acceptTimestep()` — e.g. "after `rollback`, `state0[0]` equals the value at checkpoint time, not the value modified during NR"
- No regression test asserting write-back lines are gone — e.g. "diode `updateOperatingPoint` with a starting `voltages` array: after the call, every element of `voltages` is unchanged"
- No convergence regression test — e.g. "half-wave rectifier circuit converges within 50 NR iterations per step with the new pool path"
- No MCP surface test — e.g. simulate a rectifier via MCP tool and verify output voltage matches expected value
- No E2E test — no Playwright spec verifying analog simulation with pool-backed devices produces correct browser output

### 6. Phase 2 prototype does not address the `getLteEstimate` method for capacitor

Phase 2 migrates the Diode. Phase 5 migrates the Capacitor. The Capacitor's `getLteEstimate` (for adaptive timestepping) reads `this.geq` and `this.vPrev` to compute truncation error. After Phase 5 migration, these must be read from the pool. The spec does not mention that `getLteEstimate` needs updating as part of Phase 5, nor does it describe the pool-read pattern for that method. An implementer who only migrates `stampCompanion` and `stamp` will leave `getLteEstimate` reading stale instance fields.

---

## Summary of Verified Facts

The following spec claims were verified against the codebase:

- Write-back in `diode.ts` at lines 207–209: confirmed (lines 207–209, `voltages[nodeJunction - 1] = vc + vdLimited`)
- Write-back in `zener.ts` at lines 130–132: confirmed (lines 130–131)
- Write-back in `bjt.ts` simple at lines 496–503: confirmed (lines 496–503)
- Write-back in `bjt.ts` SPICE L1 at lines 838–844: confirmed (lines 838–843)
- Write-back in `led.ts` at lines 191–193: confirmed (line 192)
- Write-back in `scr.ts` at lines 243–248: confirmed (lines 243–248)
- Write-back in `triac.ts` at lines 246–251: confirmed (lines 247, 250)
- Write-back in `tunnel-diode.ts` at lines 210–212: confirmed (line 211)
- Write-back in `varactor.ts` at lines 163–165: confirmed (line 164)
- Write-back in test-helpers.ts at lines 317–319: confirmed (line 318)
- Diac has no write-back: confirmed
- MOSFET/JFET (`fet-base.ts`) uses instance fields `_vgs`, `_vds`, no write-back: confirmed
- `analog-engine.ts` line 181 saves `_prevVoltages`: confirmed
- `analog-engine.ts` line 212 restores voltages on NR retry: confirmed (line 212)
- Broken rollback (element state not restored): confirmed — no state restore in NR retry path
- `state-pool.ts` does not yet exist: confirmed (file absent)
- `AnalogElementCore` does not yet have `stateSize`, `stateBaseOffset`, `initState`: confirmed
- `ConcreteCompiledAnalogCircuit` does not yet have a `statePool` field: confirmed
- Capacitor stores state as instance fields `geq`, `ieq`, `vPrev`: confirmed
- Inductor stores state as instance fields `geq`, `ieq`, `iPrev`: confirmed (not `vPrev` — spec slot name is wrong)
