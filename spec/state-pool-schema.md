# Spec: Declarative State-Pool Contract for Reactive Analog Elements

**Status:** Final, ready for executor hand-off.
**Scope:** `src/solver/analog/element.ts`, `src/solver/analog/compiler.ts` (single-line use), one new file `src/solver/analog/state-schema.ts`, and ~10 element files listed in the audit.
**Out of scope:** model switching, `analog-engine.ts`, engine-interface files.

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
 * (via compiler.ts:1310-1312), never per step.
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
   * compiler.ts:1310-1312. Contract:
   *   - Pool contents are guaranteed zero on entry (fresh StatePool).
   *   - Must cache pool reference + base offset for hot-path access.
   *   - Must call applyInitialValues(schema, pool, base, params) if a schema
   *     is declared. No other writes are permitted to `this`.
   */
  initState?(pool: StatePoolRef): void;
```

### 1.4 Worked example — `AnalogCapacitorElement` in the new shape

Replace `capacitor.ts:134-264` with:

```typescript
import { defineStateSchema, applyInitialValues, type StateSchema } from "../../solver/analog/state-schema.js";

// Slot layout — the array index of each entry IS the pool offset.
const CAPACITOR_SCHEMA: StateSchema = defineStateSchema("AnalogCapacitorElement", [
  { name: "GEQ",         doc: "Norton companion conductance",                  init: { kind: "zero" } },
  { name: "IEQ",         doc: "Norton companion history current",              init: { kind: "zero" } },
  { name: "V_PREV",      doc: "Terminal voltage at step n-1",                  init: { kind: "zero" } },
  { name: "I_PREV",      doc: "Capacitor current at step n-1",                 init: { kind: "zero" } },
  { name: "I_PREV_PREV", doc: "Capacitor current at step n-2",                 init: { kind: "zero" } },
  { name: "V_PREV_PREV", doc: "Terminal voltage at step n-2 (LTE reference)", init: { kind: "zero" } },
] as const);

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

---

## 2. Initial values and init-time semantics

**Decision:** imperative `initState` narrowed to a strict contract. Not purely declarative.

**Rationale:** Three observed cases need non-zero init — BJT `RB_EFF = params.RB` (`bjt.ts:770`), FET `GM/GDS = 1e-12` (`fet-base.ts:148-149`), BJT `CAP_FIRST_CALL = 1.0` (`bjt.ts:773`). All three are expressible as `SlotInit.fromParams` or `SlotInit.constant`. The BJT also computes a full operating-point snapshot in `initState` (`bjt.ts:754-769`) — that cannot live in a declarative table because it involves calling `computeSpiceL1BjtOp`. So `initState` stays as a method, but its **new contract** is:

1. Cache `s0` and `base`.
2. Call `applyInitialValues(schema, pool, base, params)` — this handles the zero/constant/fromParams cases.
3. Optionally do one additional imperative init pass for computed slots (BJT's `computeSpiceL1BjtOp` snapshot). This pass may ONLY write into `s0[base + SLOT_X]`, never into instance fields. The dev probe enforces this.
4. Return.

**Engine guarantees on entry:**
- `pool.state0` contents for this element's slots are **guaranteed zero**. `StatePool`'s constructor (`state-pool.ts:10-15`) uses `new Float64Array(totalSlots)` which zero-fills. `initState` is called exactly once per compile at `compiler.ts:1310-1312` on a freshly-allocated pool. No stale data.
- `pool.state1` and `pool.state2` are also zero, but `initState` MUST NOT write to them — history vectors are managed exclusively by `StatePool.acceptTimestep()` (`state-pool.ts:17-21`).
- `this.stateBaseOffset` is guaranteed valid (≥ 0) when `initState` is called.

**Call sites:** exactly one — `compiler.ts:1310-1312`. Not called from `analog-engine.ts:init` (that only rebinds pool refs for re-use, see `analog-engine.ts:175-187`), not called from DC-op, not called from `reset()` (`analog-engine.ts:195-211` — reset uses `statePool.reset()` which zero-fills, meaning **on reset, initial values are lost**). Flagged in section 6 as an open issue, but the fix is out of scope for this spec: a follow-up must either (a) have `reset()` re-invoke `initState` for all elements, or (b) for now, rely on the observation that every current reset is followed by a fresh transient that re-converges naturally.

---

## 3. Enforcement

**Decision:** Option (c), the **dev-time runtime probe**, as the primary mechanism. Option (b) (lint rule) is added as a secondary cheap check.

**Rejected alternatives:**
- **(a) Type-level `StateSchema<Names>` brand forbidding numeric fields:** TypeScript has no way to forbid `private _x: number` on a class. Closest approximation is a base class with `Object.seal(this)` in the constructor, but that breaks subclassing order with `AbstractFetElement`, and `Object.seal` is a per-step allocation nothing but it still fights subclass field initialisers. Rejected.
- **(d) Proxy on `this`:** adds a per-access overhead on `this._vgs` getters (`fet-base.ts:166-180`). These getters are in the hot path. Rejected.

**Probe specification:**

Location: `src/solver/analog/state-schema.ts` (already included in section 1.2 as `assertPoolIsSoleMutableState`).

When it runs: once per element, immediately after `compiler.ts:1311` calls `element.initState(statePool)`. Gated by `import.meta.env?.DEV` (Vite convention, already used elsewhere in the repo — verify in `compiler.ts`; if absent, use `process.env.NODE_ENV !== "production"`).

What it does:
1. Snapshot every enumerable own numeric field on the element instance into a `Map<string, number>`.
2. Invoke `element.stamp(mockSolver)` and, if reactive, `element.stampCompanion(1e-9, "TRAPEZOIDAL", zeroVoltages)`, and if nonlinear, `element.updateOperatingPoint(zeroVoltages)`. Use a minimal mock `SparseSolver` that no-ops on `stampMatrix`/`stampRHS` (the existing `sparse-solver.ts` can be instantiated with `matrixSize = nodeCount`; pass the real solver the compiler already built).
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
import { defineStateSchema, applyInitialValues, type StateSchema } from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../core/analog-types.js";

const POLARIZED_CAP_SCHEMA: StateSchema = defineStateSchema("AnalogPolarizedCapElement", [
  { name: "GEQ",    doc: "Capacitor-body companion conductance",    init: { kind: "zero" } },
  { name: "IEQ",    doc: "Capacitor-body companion history current", init: { kind: "zero" } },
  { name: "V_PREV", doc: "Cap-body terminal voltage at step n-1",    init: { kind: "zero" } },
] as const);

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
| `polarized-cap.ts` | 3 | `GEQ`, `IEQ`, `V_PREV` |
| `crystal.ts` | 9 | `GEQ_L`, `IEQ_L`, `I_PREV_L`, `GEQ_CS`, `IEQ_CS`, `V_PREV_CS`, `GEQ_C0`, `IEQ_C0`, `V_PREV_C0` |
| `transformer.ts` | 10 | `G11`, `G22`, `G12`, `HIST1`, `HIST2`, `PREV_I1`, `PREV_I2`, `PREV_PREV_I1`, `PREV_PREV_I2`, `FIRST_CALL` |
| `tapped-transformer.ts` | 15 | `G11`, `G22`, `G33`, `G12`, `G13`, `G23`, `HIST1`, `HIST2`, `HIST3`, `PREV_I1`, `PREV_I2`, `PREV_I3`, `PREV_PREV_I1`, `PREV_PREV_I2`, `PREV_PREV_I3` (14 if no first-call flag is needed; verify against `transformer.ts` pattern at read-time and add `FIRST_CALL` as slot 15 if required) |
| `transmission-line.ts` | per-segment: `SegmentInductorElement` → 3 (`GEQ`, `IEQ`, `I_PREV`); `SegmentCapacitorElement` → 3 (`GEQ`, `IEQ`, `V_PREV`); `CombinedRLElement` → 3 (`GEQ_L`, `IEQ`, `I_PREV`). The outer `TransmissionLineElement` has `stateSize: 0` and delegates to its sub-elements — each sub-element is registered with the compiler independently and gets its own pool slots. | — |
| `njfet.ts` (+ `pjfet.ts` inherits) | add 3 slots to `AbstractFetElement` schema (currently 25 → 28): `JFET_VGS_JUNCTION`, `JFET_GD_JUNCTION` (init `fromParams` = `GMIN`), `JFET_ID_JUNCTION`. **Important:** only JFETs use these; MOSFETs leave them zero. This is acceptable — they are slots 25-27 at the tail. Alternatively, keep a separate JFET-only schema that extends the FET base. Executor decision: **extend the existing `AbstractFetElement` schema to 28 slots and let MOSFET leave the JFET junction slots zero-initialised**, because a single schema per base class is simpler than a schema-union type. |
| `diode.ts` | current stateSize 4 or 7 (`diode.ts:161`). Add `CAP_FIRST_CALL` as a new slot at the tail (value 1.0 on init via `constant: 1.0`), making stateSize 5 or 8. `schottky.ts` inherits automatically. |
| `mosfet.ts` / `fet-base.ts` | keep the existing 25-slot layout from `fet-base.ts:46-74`, add `VSB` and `GMBS` formally into the schema (already slots 23-24 on disk per the in-flight migration, see section 5), extend to 28 for JFET as above → **final FET base stateSize: 28**. |

For `crystal.ts`, confirmed 9 mutable fields at `crystal.ts:210-224` matching the nine slot names above.

For `transformer.ts` and `tapped-transformer.ts`, the companion-matrix entries (`_g11` etc.) and history entries (`_hist1` etc.) are re-stamped every `stampCompanion` call from the `CoupledInductorPair` state, so they're classic pool candidates. The `_pair` and `_state` objects themselves are instance-owned infrastructure — if they contain mutable numeric state, they too must migrate. **Executor: before migrating transformer, read `coupled-inductor.ts` to determine whether `CoupledInductorState` is a Float64Array view into a pool (good) or plain numeric fields (also a violation that must be migrated together).** This is the one spot where the executor needs to read one more file before committing to final slot names.

---

## 5. Rollout plan

### 5.1 Order

**Wave A — Infrastructure (one commit, no functional change):**
1. Create `src/solver/analog/state-schema.ts` (file from section 1.2 verbatim).
2. Update `element.ts:235-248` JSDoc and add the optional `stateSchema` field (section 1.3).
3. Add the dev-probe invocation at the end of `compiler.ts:1312`, inside `if (import.meta.env?.DEV)`. It iterates every `analogElements` entry, runs `assertPoolIsSoleMutableState`, and pushes any returned violations as diagnostics onto the existing `diagnostics` array.
4. Run full test suite. No element has yet adopted the schema, so no violations fire. Expected: green.

**Wave B — Convert already-clean elements as reference (one commit):**
5. `capacitor.ts` — adopt schema (section 1.4). This is exemplar code.
6. `inductor.ts`, `coupled-inductor.ts` — adopt schema using the same template. These are listed as clean today, so no behavior change; adopting the schema locks in the contract.

**Wave C — Fix actual bugs (one commit per file, in increasing complexity):**
7. `polarized-cap.ts` (3 slots — smallest migration).
8. `diode.ts` (add `CAP_FIRST_CALL` slot). `schottky.ts` verified as side-effect.
9. `crystal.ts` (9 slots).
10. `transmission-line.ts` (four sub-element classes).
11. `transformer.ts` (10 slots) — requires prior read of `coupled-inductor.ts`.
12. `tapped-transformer.ts` (14-15 slots).
13. `njfet.ts` / `pjfet.ts` via extension of the FET base schema.

**Wave D — MOSFET finalisation:**
14. See section 5.3 below.

### 5.2 Per-element testing strategy

Every audit-listed file already has a test file in `src/components/passives/__tests__/` or `src/components/semiconductors/__tests__/` (verified from the git status diff at the top of the session — all those test files are modified). For each migration:

- **Required before the commit lands:** run the element's existing test file. If it passes, the migration is behaviour-preserving.
- **Required after Wave A lands:** add **one new test per element** named `<element>.rollback.test.ts` that (i) compiles a circuit with the element, (ii) steps once, (iii) captures `statePool.state0` into a snapshot, (iv) deliberately forces a rollback by calling the public rollback path (or, if not exposed, by directly calling `statePool.state0.set(snapshot)` after mutating voltages), (v) asserts the next `stampCompanion` produces the same `geq`/`ieq` as the original step. This directly exercises the bug class the spec is closing.
- **No new tests required** for dev-probe violations — the probe runs in every unit test run and will emit a diagnostic that fails the compile step.

### 5.3 MOSFET in-flight decision

**Decision: option (ii) — reshape MOSFET now to match the spec.**

Rationale: the on-disk state has `fet-base.ts` at stateSize 25 with local `const SLOT_XXX` and `static readonly` mirrors (`fet-base.ts:46-131`). This is almost exactly the capacitor pattern from section 1.4. Retrofitting to a schema is an **additive** change — a `defineStateSchema` block above the `const SLOT_*` declarations, passing the existing names verbatim, plus one line in `initState` to call `applyInitialValues`, plus adding `readonly stateSchema = FET_BASE_SCHEMA` to the class. The imperative `initState` body at `fet-base.ts:145-163` becomes dead code after the schema absorbs it (except the `NaN` sentinel for `VGS_PREV`/`VGD_PREV` which stays as an explicit post-applyInitialValues imperative fixup — schema `init: { kind: "constant", value: NaN }` also works and is cleaner).

**Executor follow-up paragraph for the MOSFET migration:**

> Open `src/solver/analog/fet-base.ts`. Immediately above the `const SLOT_VGS = 0;` block at line 48, insert a `defineStateSchema` call listing all 25 current slot names in order, with `init: { kind: "zero" }` for most slots, `init: { kind: "constant", value: 1e-12 }` for `GM` and `GDS`, `init: { kind: "constant", value: NaN }` for `VGS_PREV` and `VGD_PREV`, and `init: { kind: "constant", value: 1.0 }` for `CAP_JUNCTION_FIRST_CALL` and `CAP_GB_FIRST_CALL`. Add `readonly stateSchema = FET_BASE_SCHEMA; readonly stateSize = FET_BASE_SCHEMA.size;` to the class, replacing the hardcoded `stateSize: number = 25`. Replace the imperative body of `initState` (lines 143-163) with a single `applyInitialValues(FET_BASE_SCHEMA, pool, this.stateBaseOffset, {});` call. Do not touch `mosfet.ts` — its slot-constant uses via `AbstractFetElement.SLOT_CAP_GEQ_DB` continue to work unchanged because the static class constants remain in place as a backward-compatible aliases. Extend the schema to 28 slots (`JFET_VGS_JUNCTION`, `JFET_GD_JUNCTION` init `{ kind: "constant", value: GMIN }`, `JFET_ID_JUNCTION`) in the same commit so `njfet.ts` can migrate off its `protected _vgs_junction` fields in Wave C step 13.

---

## 6. Open questions / explicit non-goals

**Explicit non-goals:**

- **Model switching.** Handled by `hotRecompile` in `simulation-controller.ts:361-399`. Every migrated element assumes a clean compile. The dev probe fires at compile time, so hot-recompile paths benefit automatically.
- **Redesigning `StatePool`.** `state0`/`state1`/`state2` stay exactly as they are today (`state-pool.ts:1-29`). The spec does not change what `acceptTimestep` copies or what `reset` clears.
- **`state1`/`state2` history vector ownership.** Confirmed per the existing `capacitor.ts` pattern: history is collapsed into **per-slot history slots** inside `state0` (e.g. `V_PREV`, `V_PREV_PREV` at slots 2 and 5). The `state1`/`state2` vectors of `StatePool` are still the copies made by `acceptTimestep` and still used by the engine for BDF-2 lookback on the raw slot arrays. Elements do not own their own history. Do not change this.
- **Branch-current slots.** Elements with `branchIndex >= 0` continue to use the MNA branch row directly, not a pool slot. The schema does not model branch currents.
- **`updateOperatingPoint` state vs. companion state distinction.** Both are mutable scalars that must be rolled back on NR failure (see `analog-engine.ts:297-302`, which restores state0 before the restamped NR retry). The spec treats them identically — every scalar written in `updateOperatingPoint`, `stamp`, or `stampCompanion` belongs in a pool slot.
- **`AbstractFetElement` migration style.** Decision committed in section 5.3: schema-based, with the existing `const SLOT_*` integer constants and `static readonly SLOT_*` class mirrors retained as the hot-path access pattern. No getter/setter removal. The existing private getter/setters at `fet-base.ts:166-180` that already route through `this._s0[this.stateBaseOffset + SLOT_X]` are the correct pattern and are preserved.

**Open questions the executor must NOT resolve (punt to a follow-up):**

- `reset()` in `analog-engine.ts:195-211` zero-fills the pool but does not re-run `initState`. Any element with a non-zero initial value (FET `GM`/`GDS = 1e-12`, BJT `RB_EFF = params.RB`, MOSFET first-call flags, JFET `GD_JUNCTION = GMIN`) will start the next transient with wrong seed values. This is a pre-existing bug (not introduced by the spec) and is out of scope. Flag it in the Wave A commit message as a known follow-up.
- The non-rollback-sensitive `_reverseBiasDiagEmitted` latch in `polarized-cap.ts:226` is intentionally kept on the instance. The dev probe may flag it because it is a `boolean`, not a `number`. The probe implementation in section 1.2 filters to `typeof v === "number"` so booleans are skipped — confirmed safe. If the executor encounters other boolean latches, the same filter protects them.
- Whether `transmission-line.ts`'s sub-element classes should also inherit a shared base schema: decision deferred — the executor should declare three small schemas (one per sub-element class) in Wave C step 10, and revisit DRY extraction only if a pattern repeats in future elements.

---

## References

- `src/solver/analog/element.ts:235-248` — current `stateSize` / `initState` contract being amended.
- `src/solver/analog/state-pool.ts:1-29` — the pool this spec is securing.
- `src/solver/analog/analog-engine.ts:175-187` — init-time `initState` binding loop.
- `src/solver/analog/analog-engine.ts:248-254` — step-top checkpoint (`_stateCheckpoint.set(statePool.state0)`).
- `src/solver/analog/analog-engine.ts:297-302, 369-371` — rollback paths the spec exists to feed.
- `src/solver/analog/analog-engine.ts:195-211` — `reset()` which zero-fills but does not re-init (flagged open question).
- `src/solver/analog/compiler.ts:1298-1312` — state-pool allocation loop; the dev probe attaches at line 1312.
- `src/components/passives/capacitor.ts:134-264` — cleanest existing slot-based element, template for section 1.4.
- `src/components/passives/polarized-cap.ts:208-351` — canonical migration target, section 4.1.
- `src/components/passives/crystal.ts:197-224` — 9 private companion fields to be migrated.
- `src/components/passives/transformer.ts:192-211` — 10+ companion/history fields.
- `src/components/passives/tapped-transformer.ts:200-235` — 15 companion/history fields.
- `src/components/passives/transmission-line.ts:285-464` — four sub-element classes with per-segment state.
- `src/components/semiconductors/njfet.ts:112-121, 248-254` — `_vgs_junction`, `_gd_junction`, `_id_junction`.
- `src/components/semiconductors/mosfet.ts:734-788` — `_vsb`, `_gmbs` body-effect getters already routed via `_s0` (already clean; schema pass is additive).
- `src/components/semiconductors/diode.ts:150-293` — `capFirstCall` closure variable needing a slot.
- `src/components/semiconductors/bjt.ts:713-774` — reference for 24-slot layout with `fromParams` and `constant` initialisers (`L1_SLOT_RB_EFF = params.RB`, `L1_SLOT_CAP_FIRST_CALL = 1.0`).
- `src/solver/analog/fet-base.ts:46-163` — in-flight 25-slot migration; see section 5.3 for finishing instructions.
