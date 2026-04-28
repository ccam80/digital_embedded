# LoadContext State Getter Fix — ngspice-Identical State Access

## Background

ngspice exposes the per-iteration state ring through preprocessor macros, not cached pointers:

```c
/* ref/ngspice/src/include/ngspice/cktdefs.h:82-89 */
#define CKTstate0 CKTstates[0]
#define CKTstate1 CKTstates[1]
#define CKTstate2 CKTstates[2]
#define CKTstate3 CKTstates[3]
...
```

Every device-side reference like `ckt->CKTstate0[here->QcapOffset]` expands to `ckt->CKTstates[0][here->QcapOffset]` and is re-resolved on every access. The ring rotation in `dctran.c:719-723`:

```c
temp = ckt->CKTstates[ckt->CKTmaxOrder+1];
for(i=ckt->CKTmaxOrder; i>=0; i--)
    ckt->CKTstates[i+1] = ckt->CKTstates[i];
ckt->CKTstates[0] = temp;
```

…cannot leave any cached snapshot stale because **no snapshot exists** — `CKTstate0` is a macro, not a field.

digiTS deviates from this. `LoadContext.state0` and `LoadContext.state1` are plain `Float64Array` fields (`src/solver/analog/load-context.ts:132-135`), assigned **once** at init from the StatePool's getters (`src/solver/analog/ckt-context.ts:703-704`). After `StatePool.rotateStateVectors()` swaps the ring, the LoadContext fields still point at the pre-rotation arrays. Models that read state through `ctx.state0` / `ctx.state1` see stale data.

This was previously masked by `LoadContext.refreshStatePointers()`, called from `analog-engine.ts` after every rotation. That call has been removed because it is a kludge with no ngspice analog. The architectural fix is to remove the snapshot entirely and resolve `state0` / `state1` through getters that read the live `StatePool.states[]` array, matching ngspice's macro indirection exactly.

## Goal

Make `LoadContext.state0` and `LoadContext.state1` (and `state2` / `state3` where required for higher-order integration) **live references** that re-resolve through `StatePool.states[]` on every access, eliminating the stale-snapshot bug at the source. Performance must be neutral or positive for all existing call sites.

## Non-goals

- No change to StatePool's existing `state0`/`state1` getters (already correct).
- No change to ngspice C source (read-only reference).
- No change to per-element state slot layouts or `stateBaseOffset` assignment.
- No introduction of new model types or new lifecycle hooks.

## Architectural Reference

| ngspice | digiTS (target) |
|---|---|
| `CKTstates[]` array | `StatePool.states[]` (already exists, already rotated correctly by `rotateStateVectors()`) |
| `#define CKTstate0 CKTstates[0]` (macro, live) | `get state0()` on a `LoadContext` impl class returning `this._statePool.states[0]` |
| Device-function-local register promotion of `ckt->CKTstates[0]` | Per-`load()` hoist `const s0 = ctx.state0;` at the top of the function |
| (no refresh step exists) | (no refresh step) |

## Access-pattern taxonomy in current code

Three patterns exist. Only one is broken; the spec must preserve the other two unchanged.

- **Pattern P (correct, hoisted live):** `const s0 = pool.states[0];` at top of `load()`, where `pool` is a closure-captured StatePool reference. Used by capacitor, inductor, crystal, polarized-cap, transformer, tapped-transformer, transmission-line, BJT, MOSFET, NJFET, PJFET, diode, comparator, analog-switch. **No change.**
- **Pattern G (correct, per-access getter through closure):** `_pool.state0[base]` per access, where `_pool` is a closure-captured StatePool. Used by schmitt-trigger only (3 sites). Functionally correct because StatePool's `state0` getter is live. Optional hoist for performance parity.
- **Pattern X (broken):** read through `ctx.state0` / `ctx.state1` from the LoadContext snapshot. Used by timer-555 (raw access) and fgnfet/fgpfet (hoisted from the stale field). After the fix, all three become correct without changing call-site syntax.

## Required changes

### Tier 1 — Architectural fix (mandatory)

1. **`src/solver/analog/load-context.ts`** — change `state0` and `state1` from plain `Float64Array` fields to `readonly` properties. Add `state2` and `state3` properties for second-order integration. Cite `cktdefs.h:82-85` in the doc comment so future readers see the ngspice anchor.

2. **`src/solver/analog/ckt-context.ts`** — refactor `loadCtx` from a plain object literal into a class instance (proposed name: `LoadCtxImpl`). The class holds a private `_statePool: StatePool` reference passed at construction. Implement four getters:

   ```ts
   get state0(): Float64Array { return this._statePool.states[0]; }
   get state1(): Float64Array { return this._statePool.states[1]; }
   get state2(): Float64Array { return this._statePool.states[2]; }
   get state3(): Float64Array { return this._statePool.states[3]; }
   ```

   All other LoadContext fields stay as plain mutable fields (`cktMode`, `solver`, `rhs`, `rhsOld`, `time`, `dt`, etc.) — they are mutated in place each NR iteration and do not have the rotation problem.

   Delete the placeholder `state0: new Float64Array(0), state1: new Float64Array(0)` lines (currently 609-610). Delete the post-init snapshot assignments `this.loadCtx.state0 = this.statePool.state0;` and the matching `state1` line (currently 703-704).

3. **`src/solver/analog/__tests__/test-helpers.ts`** — delete `ctx.loadCtx.state0 = statePool.state0;` and the `state1` line (currently 856-857). With the getter-based `loadCtx`, `state0` / `state1` resolve through `statePool` automatically.

### Tier 2 — Models that read through the (formerly) stale path

After Tier 1, all three of these models become correct without any source change. Tier 2 only adds the conventional ngspice-style hoist where a model currently does raw `ctx.stateN[...]` per access.

4. **`src/components/active/timer-555.ts`** — at the top of `load()`, hoist:

   ```ts
   const s0 = ctx.state0;
   const s1 = ctx.state1;
   ```

   Replace `ctx.state1[this._stateBase_latch]` (line 622) with `s1[this._stateBase_latch]`. Replace `ctx.state0[this._stateBase_latch] = q ? 1.0 : 0.0;` (line 630) with `s0[this._stateBase_latch] = …`.

5. **`src/components/switching/fgnfet.ts`** — existing hoist at lines 360-361 and 520-521 is correct after Tier 1. **Address the latent bug at line 522**: `const s2 = ctx.state1;  // order-2 Gear/TRAP uses state2; default to state1 for order-1`. Replace with `const s2 = ctx.state2;` (now live via the new getter). Remove the placeholder comment.

6. **`src/components/switching/fgpfet.ts`** — same as fgnfet. Lines 363-364 and 526-527 stay; line 528 (`const s2 = ctx.state1;`) becomes `const s2 = ctx.state2;`.

### Tier 3 — Dead-code cleanup

The following `this.sN = poolRef.stateN` instance-field captures are confirmed dead writes — set in `initState`/`setup` but never read anywhere in the codebase. They survive across rotations and add noise to any future state-flow audit. Delete the assignment lines and the field declarations on the element class.

| File | Assignment lines | Notes |
|---|---|---|
| `src/components/active/analog-switch.ts` | 424-425 | Delete `this.s0..s7` field declarations on the element. |
| `src/components/active/adc.ts` | 422-423 | **Entire state-pool wiring in this file is dead** — adc.ts has zero state reads. Drop `s0..s7` declarations. |
| `src/components/active/dac.ts` | 380-381 | Same as adc.ts — zero state reads. |
| `src/components/active/comparator.ts` | 275-276, 434-435 | Two captures (composite has two sub-models). Both dead. |
| `src/components/active/schmitt-trigger.ts` | 202-203 | Also delete the `s0..s7` placeholders at 190-197. |
| `src/components/active/timer-555.ts` | 546-549 | Delete field declarations. |
| `src/components/semiconductors/bjt.ts` | 655-656, 1300-1301 | Delete the `as Float64Array<ArrayBufferLike>` casts and field declarations. Note: the `s0`/`s1`/`s2`/`s3` used inside `load()` are local consts hoisted from `pool.states[i]` — not the same identifiers as the dead `this.sN` fields. |

### Tier 4 — Schmitt-trigger hoist (optional, performance only)

7. **`src/components/active/schmitt-trigger.ts`** — replace per-access `_schmittPool.state0[_schmittBase]` (lines 219, 228) with a hoisted `const s0 = _schmittPool.states[0];` at the top of `load()`, then `s0[_schmittBase]` at the call sites. Functionally identical. Saves one getter call per access. Line 205 is in `initState` (one-shot) and may stay as-is.

## Performance Analysis

| Scenario | Per state access | Per `load()` entry |
|---|---|---|
| Today (broken): `ctx.state0[i]` direct | 1 prop load + 1 array index | 0 |
| Naive fix: getter, no hoist | 1 getter call + 1 array index | 0 |
| **Spec target: getter + hoist** | **1 array index only** | 1 getter call (~10 ns) |

For any element with more than ~2 state reads per `load()`, the spec target is **strictly faster** than today's code, because today's `ctx.state0[i]` already does a property load on each access. The spec collapses that to one getter call per `load()` entry. This mirrors what the C compiler does for ngspice device functions: `ckt->CKTstates[0]` is register-promoted for the duration of one function call.

## Verification

- **Tier 1 + Tier 2**: state-pool unit tests (`src/solver/analog/__tests__/state-pool.test.ts`) — should still pass. Add a new test that asserts `ctx.state0` is live across `statePool.rotateStateVectors()` (i.e. equals `statePool.states[0]` both before and after rotation, and the references differ).
- **Tier 2 #4 (timer-555)**: targeted timer-555 tests, including the SR-latch transient that previously exposed the staleness.
- **Tier 2 #5/#6 (fgnfet/fgpfet)**: targeted fgnfet/fgpfet tests under order-2 integration to confirm the `s2` path now hits live `state2`.
- **Tier 3**: full type-check + targeted tests on each affected element. Dead-code removal must not change behavior.
- **Cross-cutting**: BJT/MOSFET/diode targeted tests as smoke for the rotation rework, since they exercise the deepest state ring.

## Out of scope

- ngspice's order-2 Gear coefficient handling and predictor — orthogonal.
- TrashCan / sparse-solver insertion-order issue — handled separately.
- TSTALLOC ordering canonicalization (PB-TIMER555) — handled separately.

## Citations

- ngspice macros: `ref/ngspice/src/include/ngspice/cktdefs.h:82-89`
- ngspice rotation: `ref/ngspice/src/spicelib/analysis/dctran.c:719-723`
- digiTS bug site (interface): `src/solver/analog/load-context.ts:132-135`
- digiTS bug site (snapshot): `src/solver/analog/ckt-context.ts:703-704`
- digiTS bug site (test mirror): `src/solver/analog/__tests__/test-helpers.ts:856-857`
- digiTS broken consumer: `src/components/active/timer-555.ts:622, 630`
- digiTS broken consumers: `src/components/switching/fgnfet.ts:360-361, 520-522`, `src/components/switching/fgpfet.ts:363-364, 526-528`
