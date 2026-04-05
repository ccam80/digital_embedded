# Analog State Pool (CKTstate0) & Write-Back Removal

## Status: Spec — not yet implemented

## Problem

### 1. Non-standard solution vector write-back

10 device types write limited voltages back into the NR solution vector (`voltages[]`)
during `updateOperatingPoint()`. No SPICE variant does this — they save limited
voltages to a separate device state array (CKTstate0) and leave the solution vector
untouched.

**Devices that write back (the bug):**

| Device | File | Lines | Junctions |
|--------|------|-------|-----------|
| Diode | `src/components/semiconductors/diode.ts` | 207-209 | nodeJunction |
| Zener | `src/components/semiconductors/zener.ts` | 130-132 | nodeAnode |
| BJT simple | `src/components/semiconductors/bjt.ts` | 496-503 | nodeB, nodeC |
| BJT SPICE L1 | `src/components/semiconductors/bjt.ts` | 838-844 | nodeB_int, nodeC_int |
| LED | `src/components/io/led.ts` | 191-193 | nodeAnode |
| SCR | `src/components/semiconductors/scr.ts` | 243-248 | nodeA, nodeG |
| Triac | `src/components/semiconductors/triac.ts` | 246-251 | nodeMT2, nodeG |
| Tunnel Diode | `src/components/semiconductors/tunnel-diode.ts` | 210-212 | nodeAnode |
| Varactor | `src/components/semiconductors/varactor.ts` | 163-165 | nodeAnode |
| Test helper | `src/solver/analog/__tests__/test-helpers.ts` | 317-319 | nodeAnode |

**Devices already correct (no write-back):**

| Device | File | State storage |
|--------|------|---------------|
| MOSFET | `src/solver/analog/fet-base.ts:178-201` | `this._vgs`, `this._vds` |
| JFET N/P | inherits `AbstractFetElement` | same |
| Diac | `src/components/semiconductors/diac.ts:170-173` | local var, no write-back |

### 2. Three-part bug mechanism

**Convergence check contamination** (`newton-raphson.ts:315-332`):
After `updateOperatingPoints`, `voltages[i]` at device nodes contains write-back-modified
values. The convergence delta is `|limited_new - limited_old|` instead of the correct
`|raw_new - raw_old|`.

**Cross-device coupling**: When BJT writes back to `nodeB`, any other device sharing
that node reads the modified value. In SPICE, devices are independent — they each read
from `CKTrhsOld` (unmodified) and save to their own CKTstate0 slots.

**Damping/line-search contamination** (`newton-raphson.ts:278-311`): Node damping and
line search operate on `voltages[]` before write-back (correct), but
`prevIterMaxChange` records the post-write-back delta from the previous iteration.

### 3. Broken rollback

`analog-engine.ts:181` saves `this._prevVoltages` before each step, and restores on NR
failure at line 212. But this only restores the MNA solution vector — it does NOT
restore per-element state (`vd`, `geq`, `ieq`, `vbe`, `vbc`, etc.). After a failed NR
+ rollback, elements retain corrupted linearization state from the failed iteration.

## SPICE Reference Architecture

In SPICE3f5/ngspice:

- **CKTrhs / CKTrhsOld**: NR solution vectors. Never modified by device code.
  Convergence check compares these.
- **CKTstate0**: Per-device state array. Each device has allocated slots. Devices save
  limited junction voltages here. Next iteration, devices read `vold` from CKTstate0
  (not from CKTrhs).
- **CKTstate1..CKTstate7**: History vectors for multi-step integration methods.

Device load functions:
1. Read `vnew` from `CKTrhsOld` (raw previous NR solution)
2. Read `vold` from `CKTstate0` (previous limited voltage)
3. Apply `pnjlim(vnew, vold, ...)` → `vlim`
4. Stamp MNA matrix at `vlim` operating point
5. Save `vlim` to `CKTstate0`
6. **Never write to CKTrhs or CKTrhsOld**

## Design: Shared Float64Array State Pool

### StatePool class

New file: `src/solver/analog/state-pool.ts`

```typescript
export class StatePool {
  /** state0: current operating point state. */
  readonly state0: Float64Array;
  /** state1: previous accepted timestep (for trapezoidal/BDF-2). */
  readonly state1: Float64Array;
  /** state2: two timesteps ago (for BDF-2 only). */
  readonly state2: Float64Array;
  readonly totalSlots: number;

  constructor(totalSlots: number);

  /** Snapshot state0 for NR failure rollback. Returns a deep copy. */
  checkpoint(simTime: number): StateCheckpoint;

  /** Restore state0 from a checkpoint (copies data back). */
  rollback(cp: StateCheckpoint): void;

  /** Copy history after accepted timestep: state2.set(state1); state1.set(state0). */
  acceptTimestep(): void;

  /** Zero all vectors. */
  reset(): void;
}

export interface StateCheckpoint {
  /** Deep copy of state0 at checkpoint time (via `new Float64Array(pool.state0)`). */
  readonly state0: Float64Array;
  readonly simTime: number;
}
```

### Three state vectors

| Vector | SPICE equiv | Contents | Updated when |
|--------|-------------|----------|--------------|
| `state0` | CKTstate0 | Current: limited Vj, geq, ieq, gm, gds, ids, companion coeffs | Every NR iteration |
| `state1` | CKTstate1 | Previous accepted timestep's state0 | After `acceptTimestep()` |
| `state2` | CKTstate2 | Two timesteps ago | After `acceptTimestep()` (BDF-2 only) |

Why not state3-7: our highest-order method is BDF-2, needing only 2 history points.

### Slot allocation

Happens at compile time in `src/solver/analog/compiler.ts`, during the element
construction loop (~line 1169). Each element declares a `stateSize`. The compiler
accumulates a running offset.

```typescript
let stateOffset = 0;
for (const element of analogElements) {
  element.stateBaseOffset = stateOffset;
  stateOffset += element.stateSize;
}
const statePool = new StatePool(stateOffset);
for (const element of analogElements) {
  if (element.initState) element.initState(statePool);
}
```

### Per-device slot layouts

**Diode** (stateSize: 7 with capacitance, 4 without):

| Offset | Name | Purpose |
|--------|------|---------|
| 0 | VD | Limited junction voltage (vold for pnjlim) |
| 1 | GEQ | Linearized conductance |
| 2 | IEQ | Norton current offset |
| 3 | ID | Cached junction current |
| 4 | CAP_GEQ | Capacitance companion conductance |
| 5 | CAP_IEQ | Capacitance companion current |
| 6 | VD_PREV | Previous terminal voltage (cap history) |

**BJT simple** (stateSize: 10):

| Offset | Name |
|--------|------|
| 0 | VBE |
| 1 | VBC |
| 2 | GPI (input conductance) |
| 3 | GMU (feedback conductance) |
| 4 | GM (transconductance) |
| 5 | GO (output conductance) |
| 6 | IC (collector current) |
| 7 | IB (base current) |
| 8 | IC_NORTON |
| 9 | IB_NORTON |

**BJT SPICE L1** (stateSize: 12): same + rbEff, ieNorton.

**MOSFET/JFET** (stateSize: 12 — shared by MOSFET, JFET-N, JFET-P via `AbstractFetElement`):

| Offset | Name |
|--------|------|
| 0 | VGS |
| 1 | VDS |
| 2 | GM |
| 3 | GDS |
| 4 | IDS |
| 5 | SWAPPED (0.0 or 1.0) |
| 6 | CAP_GEQ_GS |
| 7 | CAP_IEQ_GS |
| 8 | CAP_GEQ_GD |
| 9 | CAP_IEQ_GD |
| 10 | VGS_PREV |
| 11 | VGD_PREV |

**SCR/Triac** (stateSize: 9):

| Offset | Name |
|--------|------|
| 0 | VAK |
| 1 | VGK |
| 2 | GEQ |
| 3 | IEQ |
| 4 | G_GATE_GEQ |
| 5 | G_GATE_IEQ |
| 6 | LATCHED (0.0 or 1.0) |
| 7 | IAK |
| 8 | IGK |

**Capacitor** (stateSize: 3):

| Offset | Name | Purpose |
|--------|------|---------|
| 0 | GEQ | Companion conductance |
| 1 | IEQ | Companion Norton current |
| 2 | V_PREV | Previous terminal voltage (`vA - vB`) |

**Inductor** (stateSize: 3):

| Offset | Name | Purpose |
|--------|------|---------|
| 0 | GEQ | Companion conductance |
| 1 | IEQ | Companion Norton current |
| 2 | I_PREV | Previous branch current (`voltages[branchIndex]`) |

### Modified AnalogElement interface

Added to `src/solver/analog/element.ts` and `src/core/analog-types.ts`:

```typescript
interface AnalogElementCore {
  // ... existing ...

  /** Float64 slots required in the state pool. 0 = no state. */
  readonly stateSize: number;

  /** Base offset into pool, assigned by compiler. -1 if stateSize === 0. */
  stateBaseOffset: number;

  /** Bind to state pool after allocation. Called once by compiler. */
  initState?(pool: StatePool): void;
}
```

`updateOperatingPoint` signature changes: `voltages: Float64Array` →
`voltages: Readonly<Float64Array>`. Compile-time enforcement that devices cannot
write back. The `mna-assembler.ts` call-site signature remains `Float64Array`
(mutable) — TypeScript upcasts to `Readonly<Float64Array>` at the call boundary.
NR damping and line-search in `newton-raphson.ts` continue to write to `voltages[]`
legitimately; only device `updateOperatingPoint` implementations are narrowed.

`initState` is called once per `compile()` invocation and must be idempotent — it
re-initialises pool slots from defaults (e.g. `GMIN`). On `setParam`-triggered
recompilation, the compiler creates a fresh `StatePool` and calls `initState` on
each element again.

### Checkpoint/rollback integration

See Phase 6 for the authoritative pseudocode.

### DC operating point integration

- Before DC solve: `statePool.reset()` zeros everything
- After DC convergence: `statePool.state1.set(statePool.state0)` and
  `statePool.state2.set(statePool.state0)` — initialize history for first transient step

### Performance

| Circuit | Elements | Avg slots | Pool (3 vectors) | Checkpoint cost |
|---------|----------|-----------|-------------------|-----------------|
| Small | 10 | 8 | 1.9 KB | ~100 ns |
| Medium | 100 | 8 | 19.2 KB | ~1 µs |
| Large | 1000 | 8 | 192 KB | ~10 µs |

Negligible vs. matrix factorization (~10-100 µs per NR iteration for 100 elements).

## Migration Plan

### Phase 1: Infrastructure (non-breaking)

- **NEW** `src/solver/analog/state-pool.ts`
- Add `stateSize`, `stateBaseOffset`, `initState` to AnalogElement/AnalogElementCore
- Add `statePool` field to `CompiledAnalogCircuit`
- Add allocation loop to compiler
- All existing elements get `stateSize: 0` by default → fully backward compatible

### Phase 2: Migrate Diode (prototype)

Replace closure variables with pool access:

```typescript
// Slot constants
const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;
let s0: Float64Array;
let base: number;

const element = {
  stateSize: hasCapacitance ? 7 : 4,
  stateBaseOffset: -1,

  initState(pool: StatePool): void {
    s0 = pool.state0;
    base = this.stateBaseOffset;
    s0[base + SLOT_GEQ] = GMIN;
  },

  updateOperatingPoint(voltages: Readonly<Float64Array>): void {
    // Read from voltages (read-only)
    const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
    const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
    const vdRaw = va - vc;
    const vdOld = s0[base + SLOT_VD]; // read vold from pool

    const vdLimited = pnjlim(vdRaw, vdOld, nVt, vcrit);

    // Save to pool — NO voltages[] write-back
    s0[base + SLOT_VD] = vdLimited;
    // compute geq, ieq at vdLimited...
    s0[base + SLOT_GEQ] = geq;
    s0[base + SLOT_IEQ] = ieq;
    s0[base + SLOT_ID] = id;
  },

  stampNonlinear(solver: SparseSolver): void {
    // Read from pool instead of closure vars
    const geq = s0[base + SLOT_GEQ];
    const ieq = s0[base + SLOT_IEQ];
    // stamp as before...
  },
};
```

### Phase 3: Migrate remaining PN-junction devices

Same pattern as diode. Each removes its `voltages[...] = ...` write-back lines.
Varactor uses the same 7-slot layout as Diode (see slot table above).

| Device | stateSize |
|--------|-----------|
| Zener | 4 |
| LED | 4 |
| Tunnel Diode | 4 |
| Varactor | 7 (same layout as Diode with capacitance) |
| BJT simple | 10 |
| BJT SPICE L1 | 12 |
| SCR | 9 |
| Triac | 9 |
| Test helper | 4 |

**Note on Diac:** Diac has no write-back (correct) but stores state in closure
variables (`_v`, `_geq`, `_ieq`). It is excluded from this phase because its
state is recomputed from scratch each `updateOperatingPoint` call — rollback of
the solution vector is sufficient. If future analysis shows Diac state is
load-bearing across NR iterations, add it to the pool then.

### Phase 4: Migrate MOSFET/JFET

`AbstractFetElement` uses instance fields. Use getter/setter pairs for zero-change
subclass migration:

```typescript
class AbstractFetElement {
  private _s0!: Float64Array;
  static readonly SLOT_VGS = 0;
  // ...

  initState(pool: StatePool): void {
    this._s0 = pool.state0;
  }

  protected get _vgs(): number { return this._s0[this.stateBaseOffset + 0]; }
  protected set _vgs(v: number) { this._s0[this.stateBaseOffset + 0] = v; }
  // ... etc for _vds, _gm, _gds, _ids, _swapped
  protected get _swapped(): boolean { return this._s0[this.stateBaseOffset + 5] !== 0; }
  protected set _swapped(v: boolean) { this._s0[this.stateBaseOffset + 5] = v ? 1.0 : 0.0; }
}
```

Subclass code (MOSFET, JFET) that reads `this._vgs` works unchanged.

### Phase 5: Migrate reactive passives

Capacitor, inductor — replace `geq`, `ieq`, `vPrev`/`iPrev` instance fields with
pool slots. stateSize = 3 each.

Methods to update in each element:
- `stampCompanion` — read/write pool slots instead of instance fields
- `stamp` / `stampNonlinear` — read `geq`/`ieq` from pool
- `getLteEstimate` — read `geq` and `vPrev`/`iPrev` from pool (currently reads
  `this.geq`, `this.vPrev`/`this.iPrev`)

### Phase 6: Wire up checkpoint/rollback in engine

- Modify `analog-engine.ts` `step()` — see updated pseudocode below
- Add `statePool.reset()` to `reset()`
- Initialize `state1`/`state2` after DC convergence
- DC source-stepping: each source-step sub-solve calls `updateOperatingPoints`
  which writes to `state0`. On source-step NR failure, the DC solver already
  retries with a smaller ramp factor. No checkpoint/rollback needed here —
  `state0` values from a failed source-step are overwritten on the next attempt
  because the full NR loop re-initialises operating points from voltages.

**Updated step() pseudocode** (matches actual engine structure):

```
step():
  checkpoint = statePool.checkpoint(simTime)
  prevVoltages.set(voltages)

  stamp companions (reads state1 for history)
  NR solve → result

  if !converged:
    while retryDt >= minTimeStep:
      voltages.set(prevVoltages)        // restore solution vector
      statePool.rollback(checkpoint)     // restore state0 only (state1/state2 untouched)
      re-stamp companions with retryDt   // ← must re-stamp each retry (matches existing code)
      NR solve → result
      if converged: break
      retryDt /= 2

  if LTE rejects:
    voltages.set(prevVoltages)
    statePool.rollback(checkpoint)       // restore state0 (state1/state2 are from
                                         // the previous accepted timestep — correct as-is)
    retry with smaller dt

  on acceptance:
    statePool.acceptTimestep()  // state2.set(state1); state1.set(state0)
    simTime += dt
```

**Key:** `rollback()` restores `state0` only. `state1`/`state2` represent accepted
history and are only modified by `acceptTimestep()`. Both NR retry and LTE rejection
use the same `rollback()` — this is correct because `state1`/`state2` are never
modified during a timestep attempt.

## Verification Gates

Each phase has grep checks and small smoke tests for the coordinator to run.
The goal: confirm complete execution with no intermediate-state bridges, no
`// TODO` shims, no dual-path code where old and new patterns coexist.

### Phase 1 gate: Infrastructure

```bash
# state-pool.ts exists
test -f src/solver/analog/state-pool.ts

# Interface additions present
grep -c 'stateSize' src/core/analog-types.ts        # ≥ 1
grep -c 'stateBaseOffset' src/core/analog-types.ts   # ≥ 1
grep -c 'initState' src/core/analog-types.ts         # ≥ 1

# Compiler allocation loop present
grep -c 'stateBaseOffset' src/solver/analog/compiler.ts  # ≥ 1
grep -c 'StatePool' src/solver/analog/compiler.ts        # ≥ 1

# statePool on CompiledAnalogCircuit
grep -c 'statePool' src/solver/analog/compiler.ts        # ≥ 1
```

**Smoke test:** `StatePool` unit test — `checkpoint()` returns a copy,
`rollback()` restores values, `acceptTimestep()` shifts history,
`reset()` zeros all vectors.

### Phase 2 gate: Diode prototype

```bash
# Write-back removed from diode
grep -c 'voltages\[nodeJunction' src/components/semiconductors/diode.ts  # 0 (was 1)

# Pool access present
grep -c 'stateSize' src/components/semiconductors/diode.ts   # ≥ 1
grep -c 'initState' src/components/semiconductors/diode.ts   # ≥ 1
grep -c 's0\[base' src/components/semiconductors/diode.ts    # ≥ 4 (VD, GEQ, IEQ, ID)

# No bridge code — no closure vars for state that moved to pool
# (vd, geq, ieq, id should not be declared as let/var in diode factory)
grep -cE 'let (vd|geq|ieq) =' src/components/semiconductors/diode.ts  # 0
```

**Smoke test:** Call `updateOperatingPoint(voltages)` on a diode element.
Assert: `voltages` array is unchanged after call. Assert: `statePool.state0[base + SLOT_VD]`
contains the limited voltage.

### Phase 3 gate: Remaining PN-junction devices

```bash
# Write-back lines: ZERO across all migrated device files
for f in \
  src/components/semiconductors/zener.ts \
  src/components/semiconductors/bjt.ts \
  src/components/io/led.ts \
  src/components/semiconductors/scr.ts \
  src/components/semiconductors/triac.ts \
  src/components/semiconductors/tunnel-diode.ts \
  src/components/semiconductors/varactor.ts \
  src/solver/analog/__tests__/test-helpers.ts; do
  count=$(grep -c 'voltages\[.*\] =' "$f" 2>/dev/null || echo 0)
  echo "$f: $count write-backs (expect 0)"
done

# Total write-back count across ALL updateOperatingPoint bodies: 0
# (grep entire src/ to catch any we missed)
grep -rn 'voltages\[.*\] =' src/ --include='*.ts' | grep -v '__tests__' | grep -v 'node_modules'
# Expected: only newton-raphson.ts damping/line-search lines (legitimate writes)

# Each migrated file has stateSize
for f in zener.ts bjt.ts led.ts scr.ts triac.ts tunnel-diode.ts varactor.ts; do
  grep -c 'stateSize' "src/components/semiconductors/$f"  # ≥ 1 each
done

# No TODO/deprecated/legacy markers
grep -rn 'TODO.*write.back\|deprecated.*voltage\|legacy.*state' src/components/ --include='*.ts'
# Expected: 0 matches
```

**Smoke test per device:** `updateOperatingPoint(voltages)` → assert voltages unchanged.

### Phase 4 gate: MOSFET/JFET

```bash
# Getter/setter pairs present in AbstractFetElement
grep -c 'get _vgs' src/solver/analog/fet-base.ts     # ≥ 1
grep -c 'set _vgs' src/solver/analog/fet-base.ts     # ≥ 1
grep -c 'get _swapped' src/solver/analog/fet-base.ts # ≥ 1
grep -c 'set _swapped' src/solver/analog/fet-base.ts # ≥ 1
grep -c 'initState' src/solver/analog/fet-base.ts    # ≥ 1

# No plain instance field declarations for migrated state
grep -cE 'protected _vgs: number|protected _vds: number|protected _gm: number' \
  src/solver/analog/fet-base.ts  # 0 (replaced by getters)

# stateSize declared
grep -c 'stateSize' src/solver/analog/fet-base.ts    # ≥ 1
```

**Smoke test:** MOSFET `updateOperatingPoint` → voltages unchanged.
Pool `state0[base + SLOT_SWAPPED]` reflects correct swap state.

### Phase 5 gate: Reactive passives

```bash
# Pool access in capacitor and inductor
grep -c 's0\[' src/components/passives/capacitor.ts  # ≥ 3 (GEQ, IEQ, V_PREV)
grep -c 's0\[' src/components/passives/inductor.ts   # ≥ 3 (GEQ, IEQ, I_PREV)

# No instance field declarations for migrated state
grep -cE 'this\.(geq|ieq|vPrev|iPrev)\b' src/components/passives/capacitor.ts  # 0
grep -cE 'this\.(geq|ieq|vPrev|iPrev)\b' src/components/passives/inductor.ts   # 0

# getLteEstimate reads from pool, not instance fields
grep -c 'getLteEstimate' src/components/passives/capacitor.ts  # ≥ 1
grep -c 'getLteEstimate' src/components/passives/inductor.ts   # ≥ 1
```

**Smoke test:** Capacitor `stampCompanion` + `getLteEstimate` read/write pool slots.
Inductor slot 2 contains branch current (not terminal voltage).

### Phase 6 gate: Engine integration

```bash
# checkpoint/rollback in engine step()
grep -c 'checkpoint' src/solver/analog/analog-engine.ts   # ≥ 2 (create + rollback)
grep -c 'rollback' src/solver/analog/analog-engine.ts     # ≥ 1
grep -c 'acceptTimestep' src/solver/analog/analog-engine.ts  # ≥ 1

# statePool.reset() in engine reset
grep -c 'statePool.reset\|statePool\.reset' src/solver/analog/analog-engine.ts  # ≥ 1

# DC init: state1/state2 initialised from state0
grep -c 'state1\.set\|state2\.set' src/solver/analog/analog-engine.ts  # ≥ 2

# Old broken rollback pattern removed (only voltages restore, no state restore)
# The old pattern was: this._voltages.set(this._prevVoltages) with NO statePool.rollback
# Now both must appear together
grep -A1 '_voltages.set.*_prevVoltages' src/solver/analog/analog-engine.ts
# Expected: each occurrence followed by statePool.rollback within 2 lines
```

**Smoke test:** Run a circuit that previously relied on write-back convergence
(e.g. half-wave rectifier with diode). Confirm convergence within NR iteration
limit. Trigger an NR failure + retry path and confirm rollback restores state0.

### Global post-migration check

```bash
# ZERO write-back lines in any updateOperatingPoint (excluding test files)
grep -rn 'voltages\[.*\]\s*=' src/ --include='*.ts' \
  | grep -v 'newton-raphson' \
  | grep -v 'analog-engine' \
  | grep -v '__tests__' \
  | grep -v 'node_modules'
# Expected: 0 matches (only NR damping/line-search and engine restore are legitimate)

# No TODO/bridge/shim markers from migration
grep -rnE 'TODO.*pool|TODO.*write.?back|deprecated|legacy.*state|FIXME.*migrat' \
  src/ --include='*.ts'
# Expected: 0 matches

# All tests pass
npm run test:q
```

## Test Strategy

### Unit tests: `src/solver/analog/__tests__/state-pool.test.ts`

- `StatePool.checkpoint()` returns a deep copy (modify state0 after checkpoint,
  values in checkpoint are unchanged)
- `StatePool.rollback()` restores state0 from checkpoint
- `StatePool.acceptTimestep()` copies state0→state1→state2 in correct order
- `StatePool.reset()` zeros all three vectors
- Allocation: elements with `stateSize: 0` get `stateBaseOffset: -1`, elements
  with `stateSize: N` get contiguous non-overlapping offsets

### Unit tests: per-device write-back elimination

For each migrated device (diode, zener, LED, tunnel-diode, varactor, BJT simple,
BJT SPICE L1, SCR, triac, MOSFET, JFET-N, JFET-P, capacitor, inductor):

- Call `updateOperatingPoint(voltages)` → assert `voltages` is unchanged (deep equal
  to a snapshot taken before the call)
- Assert pool `state0` contains expected limited values at the correct offsets

### Integration tests: convergence regression

- Half-wave rectifier (diode): converges within iteration limit, output matches
  expected DC bias point
- Common-emitter BJT amplifier: converges, operating point matches hand calculation
- RC circuit: transient step response matches analytical solution
- Circuit with NR retry path: confirm `rollback()` is called and state0 is restored

### MCP surface test

- Build + compile an analog circuit via MCP tools, run `circuit_dc_op`,
  verify output node voltages match expected values

### E2E test

- Load an analog circuit in browser, run simulation, verify signal output
  matches expected waveform (at least one Playwright test exercising the
  pool-backed simulation path)

## Estimated Scope

| Category | Files | Net LOC |
|----------|-------|---------|
| New (state-pool.ts) | 1 | +60 |
| Interface changes | 3 | +15 |
| Compiler/engine | 3 | +40 |
| Device migrations (10 devices) | 10 | -50 (remove write-back, replace closures) |
| MOSFET/JFET migration | 2 | +30 (getter/setters) |
| Reactive passives | 2 | +10 |
| Tests | 5 | +80 |
| **Total** | ~26 | ~+185 |

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Convergence regression (more NR iterations) | Medium | Raw NR deltas are larger than write-back-modified ones. Existing node damping + line search should compensate. May need to widen element-specific tolerances from `2*nVt` to `4*nVt`. |
| Non-convergence on previously-working circuits | Medium-High | Run full test suite. The fix is to improve the NR loop, not re-introduce write-back. |
| Element-specific convergence too strict | Low | Widen `checkConvergence` tolerances if needed. |
| Cross-device coupling changes operating points | Low | More correct behavior. Validate against SPICE reference. |
