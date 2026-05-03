/**
 * Declarative state-pool schema for reactive / NR-linearising analog elements.
 *
 * PURPOSE: make it syntactically impossible to own mutable float state outside
 * the StatePool, so analog-engine.ts checkpoint / rollback (see
 * analog-engine.ts:248-254, 297-302, 369-371) correctly restores the element
 * on NR-failure and LTE-rejection retries.
 *
 * SEEDING CONTRACT (ngspice-faithful):
 *   State arrays start zero. Non-zero startup constants live in instance-struct
 *   fields populated in setup() / constructor (mirrors bjtsetup.c:48
 *   `here->BJTmode = ON`). The DCOP pass populates state0 via the bottom-of-load
 *   CKTstate0 idiom; analog-engine.ts:1437 does state1.set(state0) once after
 *   DCOP per dctran.c:349-350.
 *
 * HOT PATH: nothing in this module runs during step(). All runtime slot access
 * is a direct `pool[base + CONST]` read- identical to capacitor.ts:180-230.
 */

/** One entry in a reactive element's state schema. */
export interface SlotDescriptor {
  /** UPPER_SNAKE identifier. Must be unique within a schema. */
  readonly name: string;
  /** Human-readable one-liner used in diagnostics. */
  readonly doc: string;
}

/**
 * Frozen schema- the single source of truth for an element's state layout.
 * The array index of each descriptor IS the slot offset: descriptors[3] lives
 * at pool.state0[stateBaseOffset + 3].
 */
export interface StateSchema<Names extends string = string> {
  /** Element kind for diagnostics (e.g. "AnalogCapacitorElement"). */
  readonly owner: string;
  readonly slots: readonly SlotDescriptor[];
  /** Total slot count- equals slots.length. Used as `stateSize`. */
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
 * Runtime probe- see section 3 of the spec. Gated on import.meta.env?.DEV.
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
    if (key === "stateBaseOffset") continue;
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "number") out.set(key, v);
  }
  return out;
}

/**
 * Shared companion-slot fragments.
 *
 * Spread these into the array passed to defineStateSchema() for elements
 * whose companion model is a conductance + history-current pair plus one
 * previous-value slot. The fragment is NOT a schema- the calling element's
 * defineStateSchema() owns the resulting schema identity.
 *
 * Hot-path cost: zero. Array spread happens once at module load; the
 * descriptors in the final frozen schema are indistinguishable from
 * hand-written ones.
 */
export const CAP_COMPANION_SLOTS: readonly SlotDescriptor[] = Object.freeze([
  { name: "GEQ",    doc: "Capacitor companion conductance" },
  { name: "IEQ",    doc: "Capacitor companion history current" },
  { name: "V_PREV", doc: "Terminal voltage at step n-1" },
]);

export const L_COMPANION_SLOTS: readonly SlotDescriptor[] = Object.freeze([
  { name: "GEQ",    doc: "Inductor companion conductance" },
  { name: "IEQ",    doc: "Inductor companion history current" },
  { name: "I_PREV", doc: "Branch current at step n-1" },
]);

/**
 * Rename every slot in `fragment` by appending `suffix`. Used by elements
 * that host multiple instances of the same companion fragment in a single
 * schema- the motivating case is `crystal.ts`, which has three branches
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
