# Spec: Declarative State-Pool Contract for Reactive Analog Elements

**Status:** Final, ready for executor hand-off.
**Scope:** `src/solver/analog/element.ts`, `src/solver/analog/compiler.ts` (single-line use), one new file `src/solver/analog/state-schema.ts`, and ~10 element files listed in the audit.
**Out of scope:** model switching, `analog-engine.ts`, engine-interface files.

---

## 0. Pre-flight gate — MOSFET `stateBaseOffset=-1` regression (blocks Wave A)

**Status: OPEN. Wave A MUST NOT land until this regression is root-caused and fixed.**

### Symptom

`stateBaseOffset=-1` reaches `fet-base.ts:166` (the `get _vgs` accessor) with an undefined pool reference, producing `TypeError: Cannot read properties of undefined`. Reproduces in the Phase C CMOS AND recompile path.

**Warning:** the user-facing "unconnected pin" error is a misleading friendly-error translation of the raw TypeError — NOT an actual connectivity diagnostic. Investigators must look at the raw TypeError, not the friendly message.

### Owner pointers

- `src/solver/analog/fet-base.ts:166` — `get _vgs` accessor dereferences `this._s0[this.stateBaseOffset + SLOT_VGS]`; when `_s0` is undefined (pool never bound) or `stateBaseOffset` is still `-1`, this throws.
- `src/components/semiconductors/mosfet.ts:758` — `updateOperatingPoint` calls through to `_vgs` (first use at line 775).
- **Hypothesis to investigate:** MOSFET elements emitted by the CMOS AND subcircuit netlist flattening are not getting `initState`/`stateBaseOffset` assigned before the first NR pass in `solveDcOperatingPoint`. Related files in git status (may indicate where the regression was introduced): `src/compile/compiler.ts`, `src/solver/analog/compiled-analog-circuit.ts`, `src/solver/analog/compiler.ts`.

### Why this blocks Wave A

Wave A changes (engine `initState` dedup at `analog-engine.ts:186`, `reset()` re-init loop, first-step probe) touch the same `initState` / pool-binding subsystem. Landing Wave A atop this regression would compound or mask the failure.

### Cross-reference

Once resolved, the first-step probe from Amendment C would catch this entire class of bug (uninitialized pool handle reaching an accessor), making future regressions loud instead of silent.

---

## 1. The contract shape

### 1.1 Decision summary

After reading `element.ts:235-248`, `state-pool.ts:1-29`, `capacitor.ts:130-264`, `bjt.ts:713-774`, and `fet-base.ts:45-163`, the shape that satisfies every constraint (hot-path zero-overhead, declarative initial values, grouping, type-safe slot access, first-call flags) is:

> **A frozen array of `SlotDescriptor` records, declared as `const` at module scope. `stateSize` is derived from the array length via a helper. Runtime access is through integer constants that the executor declares alongside the array — the compile-time equality between `SLOT_XXX = 0, 1, 2, …` and the index in the descriptor is enforced by a single `assertSchema()` call at element-class-construction time (dev-only) and by a type-level index brand.**

This is deliberately a thin layer on top of the existing `const SLOT_X = N; stateSize: N` idiom in `capacitor.ts`. The only things it adds are:

1. A co-located **initial-value table** so `initState` becomes a 1-line generic helper.
2. A **slot-name table** so the runtime probe (section 3) can report violations in human terms.
3. A **typed index brand** (`SlotIndex<'GEQ'>`) that prevents cross-element slot mixups at compile time.
4. An **init hook per slot** for the rare cases where the initial value depends on `params` (e.g. `RB_EFF = params.RB`, `GD_JUNCTION = GMIN`).

**What is NOT added:** no map lookups, no string keys at runtime, no per-call dispatch, no base class for reactive elements (optional mixin instead), no schema registry. Slot reads remain `this.s0[this.base + SLOT_GEQ]` — byte-identical to today's `capacitor.ts`.

**Explicit-defaults rule:** Every slot MUST declare an explicit `init` kind. Zero-initialized slots use `{ kind: 'zero' }` — there is no implicit default. The `SlotDescriptor.init` field is non-optional precisely to enforce this. A slot omitting `init` is a compile error on the `SlotDescriptor` type.

### 1.2 The interface — `src/solver/analog/state-schema.ts` (new file)

```typescript
/**
 * Declarative state-pool schema for reactive / NR-linearising analog elements.
 *
 * PURPOSE: make it syntactically impossible to own mutable float state outside
 * the StatePool, so analog-engine.ts checkpoint / rollback (see
 * analog-engine.ts:248-254, 297-302, 369-371) correctly restores the element
 * on NR-failure and LTE-rejection retries.
 *
 * HOT PATH: nothing in this module runs during step(). The schema is consulted
 * once at initState() time (via applyInitialValues) and once at dev-probe time
 * (via assertPoolIsSoleMutableState). All runtime slot access is a direct
 * `pool[base + CONST]` read — identical to capacitor.ts:180-230 today.
 */
import type { StatePoolRef } from "../../core/analog-types.js";

/** How a slot is initialised. */
export type SlotInit =
  | { kind: "zero" }
  | { kind: "constant"; value: number }
  | { kind: "fromParams"; compute: (params: Readonly<Record<string, number>>) => number };

/** One entry in a reactive element's state schema. */
export interface SlotDescriptor {
  /** UPPER_SNAKE identifier. Must be unique within a schema. */
  readonly name: string;
  /** Human-readable one-liner used in diagnostics. */
  readonly doc: string;
  /** Initial value policy; applied by applyInitialValues(). */
  readonly init: SlotInit;
}

/**
 * Frozen schema — the single source of truth for an element's state layout.
 * The array index of each descriptor IS the slot offset: descriptors[3] lives
 * at pool.state0[stateBaseOffset + 3].
 */
export interface StateSchema<Names extends string = string> {
  /** Element kind for diagnostics (e.g. "AnalogCapacitorElement"). */
  readonly owner: string;
  readonly slots: readonly SlotDescriptor[];
  /** Total slot count — equals slots.length. Used as `stateSize`. */
  readonly size: number;
  /** name → index, built at schema construction. Dev-only; not touched per-step. */
  readonly indexOf: ReadonlyMap<Names, number>;
}

/**
 * Build a frozen schema. MUST be called at module scope, not inside a factory.
 * Throws on duplicate names so typos surface at import time, not at simulate time.
 */
export function defineStateSchema<const S extends readonly SlotDescriptor[]>(
  owner: string,
  slots: S,
): StateSchema<S[number]["name"]> {
  const indexOf = new Map<string, number>();
  for (let i = 0; i < slots.length; i++) {
    const n = slots[i].name;
    if (indexOf.has(n)) {
      throw new Error(`defineStateSchema(${owner}): duplicate slot name "${n}"`);
    }
    indexOf.set(n, i);
  }
  return Object.freeze({
    owner,
    slots: Object.freeze(slots.slice()) as readonly SlotDescriptor[],
    size: slots.length,
    indexOf: indexOf as ReadonlyMap<S[number]["name"], number>,
  });
}

/**
 * Apply `SlotInit` entries to the backing Float64Array starting at `base`.
 * Called exactly once per element from its initState(). Runs at compile time
 * (via compiler.ts:1332), never per step.
 *
 * `params` is the element's resolved param record, used by `fromParams` slots.
 * Pass an empty object if the element has no param-dependent initial values.
 */
export function applyInitialValues(
  schema: StateSchema,
  pool: StatePoolRef,
  base: number,
  params: Readonly<Record<string, number>>,
): void {
  const s0 = pool.state0;
  for (let i = 0; i < schema.slots.length; i++) {
    const init = schema.slots[i].init;
    switch (init.kind) {
      case "zero":
        s0[base + i] = 0;
        break;
      case "constant":
        s0[base + i] = init.value;
        break;
      case "fromParams":
        s0[base + i] = init.compute(params);
        break;
    }
  }
}

/**
 * Runtime probe — see section 3 of the spec. Gated on import.meta.env?.DEV.
 * Returns a violation list; caller emits the diagnostic.
 */
export interface SchemaViolation {
  owner: string;
  field: string;
  before: unknown;
  after: unknown;
}

export function assertPoolIsSoleMutableState(
  owner: string,
  element: object,
  run: () => void,
): SchemaViolation[] {
  const before = snapshotOwnFields(element);
  run();
  const after = snapshotOwnFields(element);
  const violations: SchemaViolation[] = [];
  for (const [k, v] of before) {
    if (typeof v !== "number" && !(v instanceof Float64Array)) continue;
    const a = after.get(k);
    if (typeof v === "number" && v !== a && !(Number.isNaN(v) && Number.isNaN(a as number))) {
      violations.push({ owner, field: k, before: v, after: a });
    }
    // Float64Array instance identity is fine; contents changing inside s0 is legal
    // because s0 IS the pool. We only flag *other* Float64Arrays mutating.
  }
  return violations;
}

function snapshotOwnFields(obj: object): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const key of Object.keys(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "number") out.set(key, v);
    // Skip arrays/objects — schema violations are scalar drift.
  }
  return out;
}
```

### 1.3 Amendment to `AnalogElement` in `src/solver/analog/element.ts`

Replace the `stateSize` / `initState` JSDoc at `element.ts:235-248` with:

```typescript
  /**
   * Float64 slots required in the state pool. 0 = no state.
   *
   * For elements with a declared StateSchema (see state-schema.ts), this MUST
   * equal `schema.size`. For elements with `stateSize > 0` but no schema
   * (trivial pool usage), the element still owns its slots but forfeits
   * dev-time enforcement. New reactive elements MUST declare a schema.
   */
  readonly stateSize: number;

  /**
   * Optional schema declaring this element's slot layout. When present, the
   * dev-time probe enforces that all mutable scalar state lives inside the
   * pool rather than on the element instance.
   */
  readonly stateSchema?: import("./state-schema.js").StateSchema;

  /** Base offset into pool, assigned by compiler. -1 if stateSize === 0. */
  stateBaseOffset: number;

  /**
   * Bind to state pool after allocation. Called once by the compiler at
   * compiler.ts:1332. Contract:
   *   - Pool contents are guaranteed zero on entry (fresh StatePool).
   *   - Must cache pool reference + base offset for hot-path access.
   *   - Must call applyInitialValues(schema, pool, base, params) if a schema
   *     is declared. No other writes are permitted to `this`.
   */
  initState?(pool: StatePoolRef): void;
```

**`ReactiveAnalogElement` sub-interface** — also add to `src/core/analog-types.ts` immediately after the closing `}` of `AnalogElementCore` (which ends at `analog-types.ts:196`):

```typescript
/**
 * Sub-interface for reactive elements that declare a full StateSchema.
 * Every element with `isReactive: true` MUST implement this interface —
 * it makes `stateSchema` non-optional via the subtype, so the dev probe
 * can enforce pool-backed state without a runtime null check.
 *
 * The `readonly isReactive: true` discriminant narrows the union at
 * call sites; TypeScript uses it to select this interface over the base.
 */
export interface ReactiveAnalogElement extends AnalogElementCore {
  readonly isReactive: true;
  readonly stateSchema: StateSchema;
}
```

The `readonly isReactive: true` discriminant property is REQUIRED — it is what makes `ReactiveAnalogElement` a discriminated union member of `AnalogElementCore` and allows narrowing. Do not omit it.

### 1.4 Worked example — `AnalogCapacitorElement` in the new shape

Replace `capacitor.ts:134-264` with:

```typescript
import {
  defineStateSchema,
  applyInitialValues,
  CAP_COMPANION_SLOTS,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// Slot layout — the array index of each entry IS the pool offset.
// First 3 slots come from the shared CAP_COMPANION_SLOTS fragment (§1.6);
// the trailing 3 BDF-2 history slots are capacitor-specific.
const CAPACITOR_SCHEMA: StateSchema = defineStateSchema("AnalogCapacitorElement", [
  ...CAP_COMPANION_SLOTS,
  { name: "I_PREV",      doc: "Capacitor current at step n-1",                init: { kind: "zero" } },
  { name: "I_PREV_PREV", doc: "Capacitor current at step n-2",                init: { kind: "zero" } },
  { name: "V_PREV_PREV", doc: "Terminal voltage at step n-2 (LTE reference)", init: { kind: "zero" } },
]);

const SLOT_GEQ         = 0;
const SLOT_IEQ         = 1;
const SLOT_V_PREV      = 2;
const SLOT_I_PREV      = 3;
const SLOT_I_PREV_PREV = 4;
const SLOT_V_PREV_PREV = 5;

class AnalogCapacitorElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];
  readonly branchIndex = -1;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;
  stateBaseOffset = -1;

  private C: number;
  private s0!: Float64Array;
  private base!: number;

  constructor(capacitance: number) { this.C = capacitance; }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.state0;
    this.base = this.stateBaseOffset;
    applyInitialValues(CAPACITOR_SCHEMA, pool, this.base, {});
  }

  setParam(key: string, value: number): void {
    if (key === "capacitance") this.C = value;
  }

  // stamp / stampCompanion / getLteEstimate / getPinCurrents are UNCHANGED
  // from capacitor.ts:177-263 — they already read/write through
  // this.s0[this.base + SLOT_XXX], which is the hot-path contract.
}
```

Compile-verify: `stateSize === CAPACITOR_SCHEMA.size === 6` is identical to `capacitor.ts:155`'s current `stateSize: number = 6`. Zero hot-path delta. The added cost is one `applyInitialValues` call per element per compile (compiler runs this once).

### 1.5 Grouped / multi-subsystem elements

A single flat schema handles all observed cases. Reading `bjt.ts:713-738` (stateSize 24, 12 DC-op slots + 12 cap slots + first-call flag) and `fet-base.ts:46-74` (stateSize 25, mixed DC + junction + gate-bulk + body-effect): both are linear arrays already, just with comment section dividers. The spec is: **use comment dividers inside the `defineStateSchema` array and prefix slot names with a group tag (`CAP_`, `DCOP_`, `OP_`)**. No nested schema. No schema-of-schemas. The transformer's "3×3 companion matrix" becomes nine named slots `G11…G33` plus history slots `HIST1…HIST3` plus `PREV_I1…PREV_I3` — 15 total. Spell them out.

### 1.6 Shared companion-slot fragments

Seven elements across `src/components/passives/` share a 3-slot companion pattern (`GEQ`, `IEQ`, plus one history slot). Rather than duplicate the descriptor array seven times — risking inconsistent names, docs, or init kinds — the spec ships two reusable `SlotDescriptor[]` fragments in `state-schema.ts` and composes them via array spread inside each `defineStateSchema` call.

**Rationale:** the alternative — one `CAP_COMPANION_SCHEMA` per element — was rejected because (a) declaring seven near-identical `defineStateSchema` calls is the drift vector §3's dev probe cannot detect, and (b) `bjt.ts`/`fet-base.ts` already prove the "flat array" shape scales to 25 slots, so spreading a 3-slot fragment into a flat array is a natural extension of the same pattern. Fragments are **not** schemas — they are bare descriptor arrays — so there is no nested-schema machinery introduced.

**Fragment definitions — append to `src/solver/analog/state-schema.ts` (same file as §1.2):**

```typescript
/**
 * Shared companion-slot fragments.
 *
 * Spread these into the array passed to defineStateSchema() for elements
 * whose companion model is a conductance + history-current pair plus one
 * previous-value slot. The fragment is NOT a schema — the calling element's
 * defineStateSchema() owns the resulting schema identity.
 *
 * Hot-path cost: zero. Array spread happens once at module load; the
 * descriptors in the final frozen schema are indistinguishable from
 * hand-written ones.
 */
export const CAP_COMPANION_SLOTS: readonly SlotDescriptor[] = Object.freeze([
  { name: "GEQ",    doc: "Capacitor companion conductance",      init: { kind: "zero" } },
  { name: "IEQ",    doc: "Capacitor companion history current",  init: { kind: "zero" } },
  { name: "V_PREV", doc: "Terminal voltage at step n-1",         init: { kind: "zero" } },
]);

export const L_COMPANION_SLOTS: readonly SlotDescriptor[] = Object.freeze([
  { name: "GEQ",    doc: "Inductor companion conductance",       init: { kind: "zero" } },
  { name: "IEQ",    doc: "Inductor companion history current",   init: { kind: "zero" } },
  { name: "I_PREV", doc: "Branch current at step n-1",           init: { kind: "zero" } },
]);

/**
 * Rename every slot in `fragment` by appending `suffix`. Used by elements
 * that host multiple instances of the same companion fragment in a single
 * schema — the motivating case is `crystal.ts`, which has three branches
 * (series L, series C, parallel C) each carrying its own GEQ/IEQ/history.
 *
 * Returns a fresh frozen array; does not mutate `fragment`. Called at
 * module-schema-construction time only; not on any hot path.
 */
export function suffixed(
  fragment: readonly SlotDescriptor[],
  suffix: string,
): readonly SlotDescriptor[] {
  return Object.freeze(
    fragment.map((s) => ({ ...s, name: `${s.name}${suffix}` })),
  );
}
```

**Fragment usage map (normative — executors use these verbatim):**

| Element | Composition | Slots |
|---|---|---|
| `polarized-cap.ts` | `[...CAP_COMPANION_SLOTS]` | 3 |
| `capacitor.ts` | `[...CAP_COMPANION_SLOTS, I_PREV, I_PREV_PREV, V_PREV_PREV]` | 6 |
| `inductor.ts` | `[...L_COMPANION_SLOTS, V_PREV]` | 4 |
| `SegmentCapacitorElement` (transmission-line.ts) | `[...CAP_COMPANION_SLOTS]` | 3 |
| `SegmentInductorElement` (transmission-line.ts) | `[...L_COMPANION_SLOTS]` | 3 |
| `CombinedRLElement` (transmission-line.ts) | `[...L_COMPANION_SLOTS]` — **rename `geqL`/`ieq`/`iPrev` instance fields to reference `SLOT_GEQ`/`SLOT_IEQ`/`SLOT_I_PREV`** (drop the `_L` disambiguation suffix; the class only has one inductor branch so no collision) | 3 |
| `crystal.ts` | `[...suffixed(L_COMPANION_SLOTS, "_L"), ...suffixed(CAP_COMPANION_SLOTS, "_CS"), ...suffixed(CAP_COMPANION_SLOTS, "_C0")]` | 9 |

Non-fragment elements (transformer, tapped-transformer, BJT, FET, diode, zener, LED, SCR, triac, tunnel-diode, varactor) carry element-specific slot layouts and do not use these fragments.

**Extension-slot inline declarations** (for `capacitor.ts` and `inductor.ts` trailing slots) go directly in the array, not as a separate fragment — three bespoke slots per element is below the duplication-pain threshold and keeps the per-element schema self-documenting.

**Drift-prevention invariant:** any future reactive element whose companion model is "conductance + history current + one previous value" MUST spread the matching fragment rather than redeclare. Enforced by reviewer-only; no runtime check.

---

## 2. Initial values and init-time semantics

**Decision:** imperative `initState` narrowed to a strict contract. Not purely declarative.

**Rationale:** Three observed cases need non-zero init — BJT `RB_EFF = params.RB` (`bjt.ts:770`), FET `GM/GDS = 1e-12` (`fet-base.ts:148-149`), BJT `CAP_FIRST_CALL = 1.0` (`bjt.ts:773`). All three are expressible as `SlotInit.fromParams` or `SlotInit.constant`. The BJT also computes a full operating-point snapshot in `initState` (`bjt.ts:754-769`) — that cannot live in a declarative table because it involves calling `computeSpiceL1BjtOp`. So `initState` stays as a method, but its **new contract** is:

1. Cache `s0` and `base`.
2. Call `applyInitialValues(schema, pool, base, params)` — this handles the zero/constant/fromParams cases.
3. Optionally do one additional imperative init pass for computed slots (BJT's `computeSpiceL1BjtOp` snapshot). This pass may ONLY write into `s0[base + SLOT_X]`, never into instance fields. The dev probe enforces this.
4. Return.

**Engine guarantees on entry:**
- `pool.state0` contents for this element's slots are **guaranteed zero**. `StatePool`'s constructor (`state-pool.ts:10-15`) uses `new Float64Array(totalSlots)` which zero-fills. `initState` is called exactly once per compile at `compiler.ts:1332` on a freshly-allocated pool. No stale data.
- `pool.state1` and `pool.state2` are also zero, but `initState` MUST NOT write to them — history vectors are managed exclusively by `StatePool.acceptTimestep()` (`state-pool.ts:17-21`).
- `this.stateBaseOffset` is guaranteed valid (≥ 0) when `initState` is called.

**Call sites:** two currently, but Wave A reduces this to one:
1. `compiler.ts:1332` — the primary call site, inside the state-pool allocation loop at `compiler.ts:1319-1334`, called once per element on a freshly-allocated pool.
2. `analog-engine.ts:186` — a redundant call inside `MNAEngine.init()`'s element loop (`analog-engine.ts:175-188`). Wave A task: delete this call. Deleting it requires promoting `elements` from a local destructured `const` (at `analog-engine.ts:173`) to an instance field `this._elements`, so the first-step probe (Amendment C) can iterate it later.

Not called from DC-op. Not called from `reset()` (`analog-engine.ts:195-211` — reset uses `statePool.reset()` which zero-fills, meaning **on reset, initial values are lost**). The `reset()` re-init gap is addressed as a concrete Wave A task — see §5.1 Wave A item 4b. After Wave A, `compiler.ts:1332` is the sole call site.

---

## 3. Enforcement

**Decision:** Option (c), the **dev-time runtime probe**, as the primary mechanism. Option (b) (lint rule) is added as a secondary cheap check.

**Rejected alternatives:**
- **(a) Type-level `StateSchema<Names>` brand forbidding numeric fields:** TypeScript has no way to forbid `private _x: number` on a class. Closest approximation is a base class with `Object.seal(this)` in the constructor, but that breaks subclassing order with `AbstractFetElement`, and `Object.seal` is a per-step allocation nothing but it still fights subclass field initialisers. Rejected.
- **(d) Proxy on `this`:** adds a per-access overhead on `this._vgs` getters (`fet-base.ts:166-180`). These getters are in the hot path. Rejected.

**Probe specification:**

Location: `src/solver/analog/state-schema.ts` (already included in section 1.2 as `assertPoolIsSoleMutableState`).

The probe signature is `assertPoolIsSoleMutableState(owner, element, run: () => void): SchemaViolation[]` exactly as declared in §1.2. The `run` callback invokes the element's real step methods using the real solver that the engine already has at first step time.

When it runs: **not at compile time**. Probe invocation is moved to the first `MNAEngine.step()` call, controlled by a one-shot `_devProbeRan` boolean flag on the engine. This avoids two compile-time problems: (a) the real solver is not yet built when `compiler.ts:1332` runs, so a mock solver would be needed — and nonlinear elements throw on zero voltages at compile time; (b) closure-based elements (e.g. diode — `capFirstCall` is a closure variable, invisible to `Object.keys`) cannot be introspected via `Object.keys` at compile time. By deferring to first `step()`, the real solver is available and the element has already been called at least once. Gated by `import.meta.env?.DEV` (Vite convention, already used elsewhere in the repo — if absent, use `process.env.NODE_ENV !== "production"`).

**`Object.keys` limitation:** `Object.keys`/enumerable own properties cannot see closure-captured variables. Factory/closure-based elements like `diode.ts` store state in closure variables (`capFirstCall`) that are invisible to the probe. Amendment E2 migrates `capFirstCall` into a pool slot (slot 7 when capacitive), where it IS visible via the pool and IS subject to rollback — this is the correct fix.

What the `run` callback does (the caller supplies this):
1. Snapshot every enumerable own numeric field on the element instance into a `Map<string, number>`.
2. Invoke `run()` — which calls `element.stamp(realSolver)` and, if reactive, `element.stampCompanion(dt, method, voltages)`, and if nonlinear, `element.updateOperatingPoint(voltages)`. The real solver and real voltages from the engine are passed through.
3. Re-snapshot. Any numeric field that changed but is not `stateBaseOffset` (which the compiler mutates legitimately) is a violation.
4. Emit a compiler diagnostic with code `reactive-state-outside-pool`, severity `error`, referencing the field name and element owner.

**Error message template:**

```
reactive-state-outside-pool: <owner>.<field> changed during stamp/stampCompanion
but is not declared in the element's StateSchema. Mutable numeric state MUST
live in pool.state0 so the engine can roll it back on NR-failure and LTE-
rejection retries (see analog-engine.ts:297-302, 369-371). Move <field> into
a schema slot and access it via this.s0[this.base + SLOT_<FIELD>].
```

**Lint rule (secondary):** add a grep-style assertion in `src/components/**/*.ts` CI check (can live in `scripts/check-reactive-state.ts`, out of scope for executor but mention it):
```
forbid pattern:  /private\s+_\w+\s*:\s*number\s*=/
on files matching:  src/components/(passives|semiconductors)/*.ts
EXCEPT when the containing class does NOT implement AnalogElement/AnalogElementCore
```
This catches the bug class at PR time without running the simulator. Keep as advisory.

**Hot-path cost: zero.** The probe runs inside `if (import.meta.env?.DEV) { ... }` at the end of `compiler.ts` compile, so production bundles strip it via Vite tree-shaking. No per-step cost, no per-NR-iteration cost.

---

## 4. Per-element migration template

### 4.1 Before / after — `polarized-cap.ts`

**Before** (`polarized-cap.ts:208-351`, violations at lines 221-223):
```typescript
export class AnalogPolarizedCapElement implements AnalogElement {
  // ... physical params ...
  private geq: number = 0;        // VIOLATION — outside pool
  private ieq: number = 0;        // VIOLATION — outside pool
  private vPrev: number = 0;      // VIOLATION — outside pool
  // ...
  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    // ... reads/writes this.geq, this.ieq, this.vPrev ...
    this.geq = capacitorConductance(this.C, dt, method);
    this.ieq = capacitorHistoryCurrent(this.C, dt, method, vNow, this.vPrev, iNow);
    this.vPrev = vNow;
  }
}
```

**After:**
```typescript
import {
  defineStateSchema,
  applyInitialValues,
  CAP_COMPANION_SLOTS,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// Schema spread from the shared CAP_COMPANION_SLOTS fragment (§1.6).
// Slot docs are the fragment's generic wording; if `polarized-cap.ts`
// needs a more specific doc per slot, clone the fragment inline instead
// of modifying the shared constant.
const POLARIZED_CAP_SCHEMA: StateSchema = defineStateSchema("AnalogPolarizedCapElement", [
  ...CAP_COMPANION_SLOTS,
]);

const SLOT_GEQ    = 0;
const SLOT_IEQ    = 1;
const SLOT_V_PREV = 2;

export class AnalogPolarizedCapElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex = -1;
  readonly isNonlinear = true;
  readonly isReactive = true;

  readonly stateSchema = POLARIZED_CAP_SCHEMA;
  readonly stateSize = POLARIZED_CAP_SCHEMA.size;
  stateBaseOffset = -1;

  private C: number;
  private G_esr: number;
  private G_leak: number;
  private reverseMax: number;
  private s0!: Float64Array;
  private base!: number;

  // _reverseBiasDiagEmitted is a dev-facing one-shot latch, NOT rollback-sensitive
  // state. Retained on instance. Note it in the schema comment.
  private readonly _emitDiagnostic: (diag: Diagnostic) => void;
  private _reverseBiasDiagEmitted = false;

  constructor(
    pinNodeIds: number[],
    capacitance: number,
    esr: number,
    rLeak: number,
    reverseMax: number,
    emitDiagnostic?: (diag: Diagnostic) => void,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.C = capacitance;
    this.G_esr = 1 / Math.max(esr, MIN_RESISTANCE);
    this.G_leak = 1 / Math.max(rLeak, MIN_RESISTANCE);
    this.reverseMax = reverseMax;
    this._emitDiagnostic = emitDiagnostic ?? (() => {});
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.state0;
    this.base = this.stateBaseOffset;
    applyInitialValues(POLARIZED_CAP_SCHEMA, pool, this.base, {});
  }

  stamp(solver: SparseSolver): void {
    const nPos = this.pinNodeIds[0];
    const nNeg = this.pinNodeIds[1];
    const nCap = this.pinNodeIds[2];
    const geq = this.s0[this.base + SLOT_GEQ];   // was: this.geq
    const ieq = this.s0[this.base + SLOT_IEQ];   // was: this.ieq

    // ESR and leakage blocks UNCHANGED (polarized-cap.ts:258-268)
    stampG(solver, nPos, nPos, this.G_esr);
    stampG(solver, nPos, nCap, -this.G_esr);
    stampG(solver, nCap, nPos, -this.G_esr);
    stampG(solver, nCap, nCap, this.G_esr);
    stampG(solver, nCap, nCap, this.G_leak);
    stampG(solver, nCap, nNeg, -this.G_leak);
    stampG(solver, nNeg, nCap, -this.G_leak);
    stampG(solver, nNeg, nNeg, this.G_leak);

    // Capacitor companion — reads from pool slots instead of instance fields
    stampG(solver, nCap, nCap, geq);
    stampG(solver, nCap, nNeg, -geq);
    stampG(solver, nNeg, nCap, -geq);
    stampG(solver, nNeg, nNeg, geq);
    stampRHS(solver, nCap, -ieq);
    stampRHS(solver, nNeg, ieq);
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const nCap = this.pinNodeIds[2];
    const nNeg = this.pinNodeIds[1];
    const vCapNode = nCap > 0 ? voltages[nCap - 1] : 0;
    const vNeg = nNeg > 0 ? voltages[nNeg - 1] : 0;
    const vNow = vCapNode - vNeg;

    const geq = this.s0[this.base + SLOT_GEQ];
    const ieq = this.s0[this.base + SLOT_IEQ];
    const vPrev = this.s0[this.base + SLOT_V_PREV];
    const iNow = geq * vNow + ieq;

    this.s0[this.base + SLOT_GEQ]    = capacitorConductance(this.C, dt, method);
    this.s0[this.base + SLOT_IEQ]    = capacitorHistoryCurrent(this.C, dt, method, vNow, vPrev, iNow);
    this.s0[this.base + SLOT_V_PREV] = vNow;
  }

  // updateOperatingPoint, getPinCurrents, updatePhysicalParams, setParam — UNCHANGED
  // (polarized-cap.ts:286-333). Note: updatePhysicalParams still mutates C, G_esr,
  // G_leak, reverseMax on the instance — these are IMMUTABLE physical parameters,
  // not rollback-sensitive state, and are changed only via setParam (hot-patch
  // path), never inside stamp/stampCompanion. The dev probe will not flag them
  // because stamp/stampCompanion do not write them.
}
```

Diff summary: 3 instance fields removed, `stateSize = 3`, schema declared, `initState` added, 9 call sites in `stamp`/`stampCompanion` rerouted through `this.s0[this.base + SLOT_X]`. Physical parameters (`C`, `G_esr`, `G_leak`, `reverseMax`) stay on the instance — they are not mutated inside stamp-chain methods, only via `setParam`, so they are not rollback-sensitive.

### 4.2 Per-file slot catalogue

Final slot names and `stateSize` for every audit-listed file. Executor: use these verbatim.

| File | stateSize | Slot names (in order) |
|---|---|---|
| `polarized-cap.ts` | 3 | `GEQ`, `IEQ`, `V_PREV` — declared via `[...CAP_COMPANION_SLOTS]` (see §1.6) |
| `crystal.ts` | 9 | `GEQ_L`, `IEQ_L`, `I_PREV_L`, `GEQ_CS`, `IEQ_CS`, `V_PREV_CS`, `GEQ_C0`, `IEQ_C0`, `V_PREV_C0` — declared via `[...suffixed(L_COMPANION_SLOTS, "_L"), ...suffixed(CAP_COMPANION_SLOTS, "_CS"), ...suffixed(CAP_COMPANION_SLOTS, "_C0")]` (see §1.6) |
| `transformer.ts` | 13 | `G11`, `G22`, `G12`, `HIST1`, `HIST2`, `PREV_I1`, `PREV_I2`, `PREV_PREV_I1`, `PREV_PREV_I2`, `PREV_V1`, `PREV_V2`, `PREV_PREV_V1`, `PREV_PREV_V2` — 5 companion + 4 current history + 4 voltage history. Note: `FIRST_CALL` was a prior fictional entry; no such field exists on `AnalogLinearTransformerElement`. The 4 voltage history slots (`PREV_V1/V2`, `PREV_PREV_V1/V2`) come from `CoupledInductorState.prevV1/V2/prevPrevV1/V2` and must be flattened into the transformer's own pool. Migration: delete `private _state: CoupledInductorState`; eliminate `_pair.updateState()` call at `transformer.ts:349`; `CoupledInductorPair` class stays (pure-param, no mutable state) but transformer inlines BDF-2 math directly, matching what `AnalogTappedTransformerElement` already does. |
| `tapped-transformer.ts` | 12 | `G11`, `G22`, `G33`, `G12`, `G13`, `G23`, `HIST1`, `HIST2`, `HIST3`, `PREV_I1`, `PREV_I2`, `PREV_I3` — 9 companion + 3 current history. Note: `PREV_PREV_I1/2/3` do NOT exist in `tapped-transformer.ts:215-235` source; there are no `_prevPrevI` fields. Do not add them. |
| `transmission-line.ts` | **Add pool infrastructure from scratch** — none of these sub-elements have `stateSize`, `stateBaseOffset`, or `initState` today; the compiler's `element.stateSize ?? 0` fallback silently gives them zero pool allocation. Violator fields (all instance-owned, no pool): `SegmentInductorElement` (~lines 294-296): `geq`, `ieq`, `iPrev`; `SegmentCapacitorElement` (~lines 357-359): `geq`, `ieq`, `vPrev`; `CombinedRLElement` (~lines 413-415): `geqL`, `ieq`, `iPrev`. `AnalogPolarizedCapElement` (~lines 221-223): `geq`, `ieq`, `vPrev` — same situation. All three sub-element schemas use the fragments from §1.6: `SegmentInductorElement` → 3 slots, `[...L_COMPANION_SLOTS]`; `SegmentCapacitorElement` → 3 slots, `[...CAP_COMPANION_SLOTS]`; `CombinedRLElement` → 3 slots, `[...L_COMPANION_SLOTS]` with instance fields `geqL`/`ieq`/`iPrev` renamed to reference `SLOT_GEQ`/`SLOT_IEQ`/`SLOT_I_PREV` (the `_L` disambiguation is dropped because the class has only one inductor branch). The outer `TransmissionLineElement` has `stateSize: 0` and delegates to its sub-elements — each sub-element is registered with the compiler independently and gets its own pool slots. Suggest one commit per sub-element class for reviewability. | — |
| `njfet.ts` (+ `pjfet.ts` inherits) | **Base-plus-extension composition.** `AbstractFetElement` keeps its 25-slot base schema unchanged. `AnalogJfetElement` (base for `njfet`/`pjfet`) declares a 3-slot **extension schema**: `VGS_JUNCTION` (zero), `GD_JUNCTION` (`{ kind: "constant", value: GMIN }`), `ID_JUNCTION` (zero). Total JFET instance slots: 28 (base 25 + extension 3). MOSFET instances stay at 25 slots — no unused tail slots. Schema composition at declaration: `defineStateSchema(owner, [...BASE_SLOTS, ...JFET_EXTENSION_SLOTS])` — no `defineStateSchema` signature change needed. Migrate `_vgs_junction`, `_gd_junction`, `_id_junction` from `njfet.ts:118-120` into extension schema slots. |
| `diode.ts` | current stateSize `hasCapacitance ? 7 : 4` at `diode.ts:161`. Slots 0-3 (always): `SLOT_VD, SLOT_GEQ, SLOT_IEQ, SLOT_ID`. Slots 4-6 (capacitive): `SLOT_CAP_GEQ, SLOT_CAP_IEQ, SLOT_VD_PREV`. Add slot 7 `SLOT_CAP_FIRST_CALL` (capacitive only), seeded to 1.0 in `initState` at `diode.ts:167` (exact line) matching BJT convention. New stateSize: 4 (resistive) or **8** (capacitive). `schottky.ts` inherits automatically. The closure variable `capFirstCall` at `diode.ts:155` is replaced by pool slot 7; this makes it visible to the `Object.keys`-based probe. |
| `mosfet.ts` / `fet-base.ts` | Keep the existing 25-slot layout from `fet-base.ts:46-74`. Schema pass is additive — declare `FET_BASE_SCHEMA` with all 25 slots, MOSFET instances stay at 25. |

For `crystal.ts`, confirmed 9 mutable fields at `crystal.ts:210-224` matching the nine slot names above.

For `transformer.ts` and `tapped-transformer.ts`, the companion-matrix entries (`_g11` etc.) and history entries (`_hist1` etc.) are re-stamped every `stampCompanion` call from the `CoupledInductorPair` state, so they're classic pool candidates. **Resolved:** `CoupledInductorPair` at `src/solver/analog/coupled-inductor.ts:145-268` holds only `readonly l1, l2, k, m` — no mutable numeric state. `CoupledInductorState` at `coupled-inductor.ts:29-38` is a plain interface with 8 mutable number fields (`prevI1, prevI2, prevV1, prevV2, prevPrevI1, prevPrevI2, prevPrevV1, prevPrevV2`), instantiated by `transformer.ts:204` as `private _state: CoupledInductorState`. Those 8 fields are the "4 current history + 4 voltage history" slots in the transformer's 13-slot count. Migration: delete `_state` from the transformer, replace each `this._state.prevX` read with `this.s0[this.base + SLOT_PREV_X]`, and delete the `_pair.updateState()` call at `transformer.ts:349` — replace with direct writes to the 8 history slots followed by an inline slot-shift (`PREV_PREV_I1 ← PREV_I1`, `PREV_I1 ← i1Now`, etc.) inside the accepted-timestep branch. After migration, `CoupledInductorState`, `CoupledInductorPair.updateState`, and `CoupledInductorPair.createState` become dead code — delete them in the same commit.

---

## 5. Rollout plan

### 5.1 Order

**Wave A — Infrastructure (one commit, no functional change):**
1. Create `src/solver/analog/state-schema.ts` containing the full file from §1.2 (types + `defineStateSchema` + `applyInitialValues` + `assertPoolIsSoleMutableState`) **and** the shared fragments from §1.6 (`CAP_COMPANION_SLOTS`, `L_COMPANION_SLOTS`, `suffixed`). All exports live in this one file — no separate fragments module.
2. Update `element.ts:235-248` JSDoc and add the optional `stateSchema` field (section 1.3).
3. Wire up the dev-probe: add a one-shot `_devProbeRan` flag to `MNAEngine`. On first `step()` call (when `_devProbeRan` is false), iterate `this._elements`, call `assertPoolIsSoleMutableState(owner, element, run)` for each element with `stateSize > 0`, and push any returned violations as diagnostics. Set `_devProbeRan = true` after the pass. Gated by `import.meta.env?.DEV`.
4. **Delete the redundant `initState` call at `analog-engine.ts:186`** (inside `MNAEngine.init()`'s element loop). Promote `elements` from a local destructured `const` to an instance field `this._elements` so the first-step probe (Amendment C) can iterate it. After this, `compiler.ts:1332` is the sole `initState` call site.
4b. **Fix `reset()` re-init gap:** after `cac.statePool.reset()` at `analog-engine.ts:203`, iterate `this._elements` and call `el.initState?.(cac.statePool)` for every element with `stateSize > 0`. This restores non-zero initial values (FET `GM/GDS = 1e-12`, BJT `RB_EFF = params.RB`, first-call flags) after reset, preventing NaN-sentinel and first-call regressions on re-run.
5. Run full test suite. No element has yet adopted the schema, so no violations fire. Expected: green.

**Wave B — Convert already-clean elements as reference (one commit):**
5. `capacitor.ts` — adopt schema (section 1.4). This is exemplar code.
6. `inductor.ts` — adopt schema using the same template. Listed as clean today, so no behavior change; adopting the schema locks in the contract.

**Note on `src/solver/analog/coupled-inductor.ts`:** this file is a *helper module*, not an `AnalogElement`. It exports `CoupledInductorPair` (a pure-param class with only `readonly` fields `l1, l2, k, m` — verified `coupled-inductor.ts:146-159`, no mutable numeric state, stateless) and the `CoupledInductorState` interface (a plain data holder with 8 mutable number fields: `prevI1, prevI2, prevV1, prevV2, prevPrevI1, prevPrevI2, prevPrevV1, prevPrevV2`, at `coupled-inductor.ts:29-38`). It has no `stateSize`, no `initState`, and is not registered with the compiler — therefore **no schema to adopt** in Wave B. The violation surface is `transformer.ts`, which holds a `private _state: CoupledInductorState` instance field (`transformer.ts:204`). Migration happens entirely in `transformer.ts` during Wave C step 11 — the 8 interface fields become 8 pool slots on the transformer, and `_state`/`_pair.updateState()`/`_pair.createState()` are deleted from the call site. After Wave C, `CoupledInductorState` and the `updateState`/`createState` methods on `CoupledInductorPair` become dead code — delete them in the same commit; `CoupledInductorPair.stampCompanion()` stays but its `state` parameter type becomes `Readonly<{...}>` if any other caller uses it, otherwise the whole pair helper can be inlined into transformer (deferred as cleanup — not required for pool compliance).

**Wave C — Fix actual bugs (one commit per file, in increasing complexity):**
7. `polarized-cap.ts` (**add pool infrastructure from scratch** — 3 slots, violator fields `geq`/`ieq`/`vPrev` at lines 221-223 have no pool backing today; `AnalogPolarizedCapElement` at `polarized-cap.ts:208` has no `stateSize`/`stateBaseOffset`/`initState`).
8. `diode.ts` (add `SLOT_CAP_FIRST_CALL` as slot 7 for capacitive path, stateSize 4→8; replace closure var `capFirstCall` at `diode.ts:155` with pool slot; `initState` at `diode.ts:167` seeds slot 7 to 1.0). `schottky.ts` verified as side-effect.
9. `crystal.ts` (9 slots).
10. `transmission-line.ts` (**add pool infrastructure from scratch** on four sub-element classes — none have `stateSize`/`stateBaseOffset`/`initState` today; suggest one commit per sub-element: `SegmentInductorElement`, `SegmentCapacitorElement`, `CombinedRLElement`, then outer `TransmissionLineElement` stateSize:0 pass).
11. `transformer.ts` (13 slots: 5 companion + 4 current history + 4 voltage history) — delete `_state: CoupledInductorState`, eliminate `_pair.updateState()`, inline BDF-2 math. See §4.2 for full slot list.
12. `tapped-transformer.ts` (12 slots: 9 companion + 3 current history; no `PREV_PREV_I` fields).
13. `njfet.ts` / `pjfet.ts` via extension of the FET base schema.

**Wave D — MOSFET finalisation:**
14. See section 5.3 below.

**Wave E — Retrofit `stateSchema` declarations onto all pool-compliant reactive elements:**

All retrofitted elements become `ReactiveAnalogElement` (Amendment D). Every slot must declare explicit `init` kind — no implicit zero (Amendment L).

15. `capacitor.ts` — 6 slots, all `{ kind: "zero" }`: `GEQ`, `IEQ`, `V_PREV`, `I_PREV`, `I_PREV_PREV`, `V_PREV_PREV`.
16. `inductor.ts` — 4 slots, all `{ kind: "zero" }`: `GEQ`, `IEQ`, `I_PREV`, `V_PREV` (verify against source).
17. `bjt.ts` simple factory `createBjtElement` — 10 slots. See Wave E BJT entry below.
18. `bjt.ts` L1 factory `createSpiceL1BjtElement` — 24 slots. See Wave E BJT entry below.
19. `fet-base.ts` — 25 slots per §5.3: `VGS_PREV`/`VGD_PREV` as `{ kind: "constant", value: NaN }`, first-call flags as `{ kind: "constant", value: 1.0 }`, `GM`/`GDS` floors as `{ kind: "constant", value: 1e-12 }`, all others `{ kind: "zero" }`.
20. `diode.ts` — 4 or 8 slots per Amendment E2 (see §4.2).
21. `zener.ts`, `tunnel-diode.ts`, `varactor.ts`, `scr.ts`, `triac.ts` — add `stateSchema` declarations matching their existing pool slot layouts.

**Wave E — BJT entry (Amendments K and M):**

- Reference: `bjt.ts:713-774` for the 24-slot L1 layout. `L1_SLOT_RB_EFF = 10` (at `bjt.ts:724`), `L1_SLOT_CAP_FIRST_CALL = 23` (at `bjt.ts:738`). `git diff HEAD src/components/semiconductors/bjt.ts` is empty — BJT is fully committed as Wave 3.2 and pool-compliant at the probe level.

- **Warm-start seeds (Amendment M):** Both factories need warm-start seeds for BJT junction voltages to avoid NR convergence stall from zero cutoff start:
  - `SLOT_VBE` / `L1_SLOT_VBE` (slot 0 in both factories): seed to `+0.6V` for NPN, `-0.6V` for PNP. In declarative stateSchema form: `{ kind: "fromParams", compute: (params) => params.polarity === 1 ? 0.6 : -0.6 }`.
  - `SLOT_VBC` / `L1_SLOT_VBC` (slot 1 in both factories): `{ kind: "zero" }` (explicit).
  - **Polarity param key:** verified from `bjt.ts:376-377` (`createBjtElement`) — the first argument is `polarity: 1 | -1` (NPN = 1, PNP = -1). Both `createBjtElement` and `createSpiceL1BjtElement` use the same `polarity` argument at `bjt.ts:651`. The `params` record inside each factory does not include polarity — it is a closure argument. The `fromParams` compute function must reference the closure `polarity` variable directly: `{ kind: "fromParams", compute: (_params) => polarity === 1 ? 0.6 : -0.6 }`.

### 5.2 Per-element testing strategy

Every audit-listed file already has a test file in `src/components/passives/__tests__/` or `src/components/semiconductors/__tests__/` (verified from the git status diff at the top of the session — all those test files are modified). For each migration:

- **Required before the commit lands:** run the element's existing test file. If it passes, the migration is behaviour-preserving.
- **Required after Wave A lands:** add **one new test per element** named `<element>.rollback.test.ts` that (i) compiles a circuit with the element, (ii) steps once, (iii) captures `statePool.state0` into a snapshot, (iv) deliberately forces a rollback by calling the public rollback path (or, if not exposed, by directly calling `statePool.state0.set(snapshot)` after mutating voltages), (v) asserts the next `stampCompanion` produces the same `geq`/`ieq` as the original step. This directly exercises the bug class the spec is closing.
- **No new tests required** for dev-probe violations — the probe runs in every unit test run and will emit a diagnostic that fails the compile step.

### 5.3 MOSFET in-flight decision

**Decision: option (ii) — reshape MOSFET now to match the spec.**

Rationale: the on-disk state has `fet-base.ts` at stateSize 25 with local `const SLOT_XXX` and `static readonly` class mirrors (`fet-base.ts:46-131`). The local constants match the capacitor pattern from section 1.4 almost exactly — retrofitting them to a schema is a small additive change (a `defineStateSchema` block above the constants, one line in `initState`, plus `readonly stateSchema = FET_BASE_SCHEMA` on the class). The only non-additive piece is removing the 25 `static readonly SLOT_*` class mirrors at `fet-base.ts:107-131`, which `mosfet.ts` currently uses via `AbstractFetElement.SLOT_*`. Per project rules (no backward-compatibility shims), those mirrors are deleted; the module-scope constants are exported from `fet-base.ts` and imported by name into `mosfet.ts`. The imperative `initState` body at `fet-base.ts:145-163` becomes dead code after the schema absorbs it (the `NaN` sentinel for `VGS_PREV`/`VGD_PREV` is expressed as `init: { kind: "constant", value: NaN }`, which is cleaner than a post-applyInitialValues imperative fixup).

**Executor follow-up paragraph for the MOSFET migration:**

> Open `src/solver/analog/fet-base.ts`. Add `export` to every `const SLOT_*` declaration in the block at lines 48-74 (all 25 constants). Immediately above that block, insert a `defineStateSchema` call named `FET_BASE_SCHEMA` listing all 25 current slot names in order, with `init: { kind: "zero" }` for most slots, `init: { kind: "constant", value: 1e-12 }` for `GM` and `GDS`, `init: { kind: "constant", value: NaN }` for `VGS_PREV` and `VGD_PREV`, and `init: { kind: "constant", value: 1.0 }` for `CAP_JUNCTION_FIRST_CALL` and `CAP_GB_FIRST_CALL`. Add `readonly stateSchema = FET_BASE_SCHEMA; readonly stateSize = FET_BASE_SCHEMA.size;` to the `AbstractFetElement` class, replacing the hardcoded `stateSize: number = 25`. Replace the imperative body of `initState` (lines 143-163) with a single `applyInitialValues(FET_BASE_SCHEMA, pool, this.stateBaseOffset, {});` call.
>
> **Delete all 25 `static readonly SLOT_*` class mirrors on `AbstractFetElement` (`fet-base.ts:107-131`).** No backward-compatible aliases. Then open `src/components/semiconductors/mosfet.ts` and rewrite every `AbstractFetElement.SLOT_*` reference to use the imported module-scope constant directly. Verified call sites to update: lines 734, 735, 737, 738 (private `_vsb`/`_gmbs` getter/setter pairs), and lines 856, 857, 874, 875, 886, 887, 923, 924, 926, 927, 928, 930, 931, 932, 934, 935, 936, 937, 938, 948, 949, 951, 952, 958, 959, 961, 962, 967, 968, 970, 971 (capacitor companion block inside `updateCompanion`). Add the necessary named imports at the top of `mosfet.ts`: `import { SLOT_VSB, SLOT_GMBS, SLOT_CAP_GEQ_GB, SLOT_CAP_IEQ_GB, SLOT_CAP_GEQ_DB, SLOT_CAP_IEQ_DB, SLOT_CAP_GEQ_SB, SLOT_CAP_IEQ_SB, SLOT_CAP_JUNCTION_FIRST_CALL, SLOT_CAP_GB_FIRST_CALL, SLOT_VDB_PREV, SLOT_VSB_PREV, SLOT_VGB_PREV } from "../../solver/analog/fet-base.js";` (the 13 constants actually referenced by `mosfet.ts`; do not import the other 12). Run `npm run test:q` and `npm run lint` to confirm no remaining `AbstractFetElement.SLOT` references and no unused-import warnings.
>
> MOSFET instances stay at 25 slots. In Wave C step 13, `AnalogJfetElement` declares a separate 3-slot extension schema (`VGS_JUNCTION`, `GD_JUNCTION`, `ID_JUNCTION`) and its total stateSize is 28 (base 25 + extension 3 composed via `[...BASE_SLOTS, ...JFET_EXTENSION_SLOTS]`).

---

## 6. Open questions / explicit non-goals

### 6.1 Non-violations — carved-out elements

The following elements were audited and are NOT pool violators, despite holding instance-level `_prev*` or state-like fields:

**`digital-pin-model.ts` — `DigitalOutputPinModel` and `DigitalInputPinModel`:**
- `DigitalOutputPinModel` (line 46): fields `_prevVoltage` and `_prevCurrent` at lines **62-63**. Written only in `updateCompanion`, which runs on the accepted-timestep path — never during NR/LTE retry attempts. Pool exemption valid.
- `DigitalInputPinModel` (line 267): fields `_prevVoltage` and `_prevCurrent` at lines **274-275**. Same pattern — written only in `updateCompanion`. Pool exemption valid.
- **Action item:** add a comment block at the field declaration sites (lines 62-63 and 274-275) explaining the exemption so future maintainers don't silently break it.

**Behavioral flipflop classes** (`behavioral-flipflop.ts`, `behavioral-flipflop/{d-async,jk,jk-async,rs,rs-async,t}.ts`, `behavioral-sequential.ts`):
- Fields: `_prevClockVoltage`, `_latchedQ` (in `behavioral-flipflop.ts:56, 67`), `_count` (in `behavioral-sequential.ts:64`), `_storedValue` (in `behavioral-sequential.ts:255`). All written only in `updateCompanion`, which is post-accept event detection. Never written during NR iteration. Correctly carved out.
- **Action item:** add comment-block justifications at each field declaration site so the exemption is self-documenting.

**See also (separate defect, NOT in this spec's scope):** `updateCompanion` on behavioral flipflop elements appears to not be dispatched by the engine — `updateState` is a no-op and no `el.updateCompanion?.(...)` call exists in `analog-engine.ts`. This is a pre-existing defect tracked separately from state-pool-schema.

**Explicit non-goals:**

- **Model switching.** Handled by `hotRecompile` in `simulation-controller.ts:361-399`. Every migrated element assumes a clean compile. The dev probe fires at compile time, so hot-recompile paths benefit automatically.
- **Redesigning `StatePool`.** `state0`/`state1`/`state2` stay exactly as they are today (`state-pool.ts:1-29`). The spec does not change what `acceptTimestep` copies or what `reset` clears.
- **`state1`/`state2` history vector ownership.** Confirmed per the existing `capacitor.ts` pattern: history is collapsed into **per-slot history slots** inside `state0` (e.g. `V_PREV`, `V_PREV_PREV` at slots 2 and 5). The `state1`/`state2` vectors of `StatePool` are still the copies made by `acceptTimestep` and still used by the engine for BDF-2 lookback on the raw slot arrays. Elements do not own their own history. Do not change this.
- **Branch-current slots.** Elements with `branchIndex >= 0` continue to use the MNA branch row directly, not a pool slot. The schema does not model branch currents.
- **`updateOperatingPoint` state vs. companion state distinction.** Both are mutable scalars that must be rolled back on NR failure (see `analog-engine.ts:297-302`, which restores state0 before the restamped NR retry). The spec treats them identically — every scalar written in `updateOperatingPoint`, `stamp`, or `stampCompanion` belongs in a pool slot.
- **`AbstractFetElement` migration style.** Decision committed in section 5.3: schema-based, with the module-scope `const SLOT_*` integer constants in `fet-base.ts` exported and imported by name into `mosfet.ts`. The 25 `static readonly SLOT_*` class mirrors at `fet-base.ts:107-131` are **deleted** (no backward-compatibility shims). The private getter/setters at `fet-base.ts:166-180` that route through `this._s0[this.stateBaseOffset + SLOT_X]` are the correct hot-path pattern and are preserved — they continue to reference the (now module-scope exported) local constants directly. MOSFET stays at 25 slots; JFET adds a 3-slot extension schema for total 28 (Amendment I).

**Open questions the executor must NOT resolve (punt to a follow-up):**

- ~~`reset()` in `analog-engine.ts:195-211` zero-fills the pool but does not re-run `initState`.~~ **Promoted to Wave A task 4b** — see §5.1.
- The non-rollback-sensitive `_reverseBiasDiagEmitted` latch in `polarized-cap.ts:226` is intentionally kept on the instance. The dev probe may flag it because it is a `boolean`, not a `number`. The probe implementation in section 1.2 filters to `typeof v === "number"` so booleans are skipped — confirmed safe. If the executor encounters other boolean latches, the same filter protects them.
- ~~Whether `transmission-line.ts`'s sub-element classes should also inherit a shared base schema~~ **Resolved:** §1.6 introduces `CAP_COMPANION_SLOTS` / `L_COMPANION_SLOTS` / `suffixed()` as first-class migration artefacts. All three `transmission-line.ts` sub-elements, `polarized-cap.ts`, `capacitor.ts`, `inductor.ts`, and `crystal.ts` compose their schemas via these fragments. No deferred DRY debt.

---

## References

- `src/solver/analog/element.ts:235-248` — current `stateSize` / `initState` contract being amended.
- `src/solver/analog/state-pool.ts:1-29` — the pool this spec is securing.
- `src/solver/analog/analog-engine.ts:175-187` — init-time `initState` binding loop.
- `src/solver/analog/analog-engine.ts:248-254` — step-top checkpoint (`_stateCheckpoint.set(statePool.state0)`).
- `src/solver/analog/analog-engine.ts:297-302, 369-371` — rollback paths the spec exists to feed.
- `src/solver/analog/analog-engine.ts:195-211` — `reset()` which zero-fills but does not re-init (flagged open question).
- `src/solver/analog/compiler.ts:1319-1334` — state-pool allocation loop; `initState` call is at line 1332. The dev probe attaches via first-step engine flag (Amendment C).
- `src/components/passives/capacitor.ts:134-264` — cleanest existing slot-based element, template for section 1.4.
- `src/components/passives/polarized-cap.ts:208-351` — canonical migration target, section 4.1.
- `src/components/passives/crystal.ts:197-224` — 9 private companion fields to be migrated.
- `src/components/passives/transformer.ts:200-211` — 5 companion fields (`_g11, _g22, _g12, _hist1, _hist2`) plus `_state: CoupledInductorState` (holds 4 current + 4 voltage history = 8 more) → 13 total pool slots.
- `src/components/passives/tapped-transformer.ts:215-235` — 9 companion fields (`_g11/_g22/_g33/_g12/_g13/_g23/_hist1/_hist2/_hist3`) + 3 current history (`_prevI1/_prevI2/_prevI3`) = 12 total pool slots.
- `src/components/passives/transmission-line.ts:285-464` — four sub-element classes with per-segment state.
- `src/components/semiconductors/njfet.ts:112-121, 248-254` — `_vgs_junction`, `_gd_junction`, `_id_junction`.
- `src/components/semiconductors/mosfet.ts` — schema pass is additive; existing 25-slot layout stays unchanged.
- `src/components/semiconductors/diode.ts:150-293` — `capFirstCall` closure variable needing a slot.
- `src/components/semiconductors/bjt.ts:713-774` — reference for 24-slot layout with `fromParams` and `constant` initialisers (`L1_SLOT_RB_EFF = params.RB`, `L1_SLOT_CAP_FIRST_CALL = 1.0`).
- `src/solver/analog/fet-base.ts:46-163` — in-flight 25-slot migration; see section 5.3 for finishing instructions.
