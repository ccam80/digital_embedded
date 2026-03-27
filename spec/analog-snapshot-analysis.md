# Analog Engine Snapshot Analysis

**Date**: 2026-03-26
**Status**: Analysis complete, decision pending
**Depends on**: Phase 5b (complete)

---

## 1. Problem Statement

`saveSnapshot()` / `restoreSnapshot()` on `SimulationCoordinator` delegate to the digital engine only. For analog-only or mixed circuits, analog state is silently lost — `saveSnapshot()` returns a dummy ID and `restoreSnapshot()` is a no-op.

The sole consumer is `TimingDiagramPanel.jumpToTime()` (click a point on the waveform to restore engine state to that moment). This feature works for digital circuits but silently does nothing for analog circuits.

Two options exist: implement analog snapshots properly, or replace the feature with data-replay (display-only cursor scrubbing from recorded waveform samples).

---

## 2. What State Defines an Analog Snapshot

### 2.1 MNAEngine direct fields (`src/solver/analog/analog-engine.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `_voltages` | `Float64Array(matrixSize)` | MNA solution vector (node voltages + branch currents) |
| `_prevVoltages` | `Float64Array(matrixSize)` | Previous-step solution for rollback |
| `_simTime` | `number` | Current simulation time in seconds |
| `_lastDt` | `number` | Last accepted timestep |
| `_stepCount` | `number` | Accepted step counter |
| `_engineState` | `EngineState` | Lifecycle state (RUNNING/PAUSED/etc.) |

### 2.2 HistoryStore (`src/solver/analog/integration.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `_a` | `Float64Array(elementCount)` | History slot A |
| `_b` | `Float64Array(elementCount)` | History slot B |
| `_slotIsA` | `Uint8Array(elementCount)` | Per-element current-slot flag |

### 2.3 TimestepController (`src/solver/analog/timestep.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `currentDt` | `number` | Current timestep |
| `currentMethod` | `IntegrationMethod` | Active integration method (bdf1/trapezoidal/bdf2) |
| `_breakpoints` | `number[]` | Sorted breakpoint queue |
| `_acceptedSteps` | `number` | Startup state machine counter |
| `_signHistory` | `Array<number[]>` | Per-reactive-element sign buffers for ringing detection |
| `_stableOnBdf2` | `number` | Consecutive stable steps on BDF-2 |

### 2.4 Element internal state

Each `AnalogElement` instance holds closure-captured mutable state. The pattern varies per element type:

| Element Type | Mutable State | Count |
|---|---|---|
| AnalogCapacitorElement (class) | `geq`, `ieq`, `vPrev`, `vPrevPrev` | 4 numbers |
| AnalogInductorElement (class) | `geq`, `ieq`, `iPrev`, `iPrevPrev`, `vPrev` | 5 numbers |
| BJT (closure) | `vbe`, `vbc`, `op` (8-field struct: vbe, vbc, ic, ib, gm, go, gpi, gmu) | 10 numbers |
| Diode (closure) | `vd`, `geq`, `ieq`, `id`, `vdPrev` | 5 numbers |
| Varactor (closure) | `_vd`, `_geq`, `_ieq`, `_id`, `_capGeq`, `_capIeq`, `_vdPrev`, `_capFirstCall` | 8 values |
| MOSFET (closure) | junction voltages, conductances, currents | ~10-12 numbers |
| Crystal (class) | `geqL`, `ieqL`, `vPrevL`, `geqCs`, `ieqCs`, `vPrevCs`, `geqC0`, `ieqC0`, `vPrevC0` | 9 numbers |
| Memristor (closure) | `w` (internal state), geq, ieq | ~3-4 numbers |
| Analog Fuse (closure) | `_thermalEnergy`, resistance state | ~2-3 numbers |
| Timer 555 (closure) | `_flipflopQ`, `_vOH`, `_vOL` | 3 values |
| SCR/Triac/Diac (closure) | junction voltages + conductances | ~4-8 numbers each |
| Triode/JFET (closure) | operating point state | ~6-10 numbers each |

Conservatively, each element holds 4-12 mutable numbers (32-96 bytes at Float64).

### 2.5 Bridge state (mixed circuits only)

The `DefaultSimulationCoordinator` maintains per-bridge runtime state:

| Field | Type | Per-bridge |
|-------|------|------------|
| `innerEngine` | `DigitalEngine` | Already has snapshot support |
| `prevInputBits` | `boolean[]` | One per input adapter |
| `prevOutputBits` | `boolean[]` | One per output adapter |
| `prevInputVoltages` | `number[]` | One per input adapter |
| `indeterminateCount` | `number[]` | One per input adapter |
| `oscillatingCount` | `number[]` | One per input adapter |

Plus `TopLevelBridgeState[]` with `prevBit` per top-level bridge.

---

## 3. Snapshot Size

### 3.1 Reference circuit: 20 nodes, 10 elements

Assume matrixSize = 21 (20 nodes + 1 inductor branch).

| Component | Size (bytes) |
|---|---|
| `_voltages` | 21 x 8 = 168 |
| `_prevVoltages` | 21 x 8 = 168 |
| `_simTime` + `_lastDt` + `_stepCount` | 24 |
| `_engineState` | 4 |
| HistoryStore `_a` | 10 x 8 = 80 |
| HistoryStore `_b` | 10 x 8 = 80 |
| HistoryStore `_slotIsA` | 10 x 1 = 10 |
| TimestepController scalars | ~48 |
| TimestepController `_signHistory` | ~120 |
| Element internal state | ~640 (10 elements x ~8 numbers x 8 bytes) |
| **Total per snapshot** | **~1,342 bytes** |

### 3.2 Larger circuit: 100 nodes, 50 elements

| Component | Size (bytes) |
|---|---|
| Voltages (2 arrays) | 2 x 110 x 8 = 1,760 |
| History (2 arrays + flags) | 2 x 50 x 8 + 50 = 850 |
| Element state | 50 x 64 = 3,200 |
| Controller + scalars | ~200 |
| **Total per snapshot** | **~6,010 bytes** |

### 3.3 Ring buffer sizing

| Circuit | Per snapshot | 100 snapshots | 500 snapshots |
|---------|------------|---------------|---------------|
| 20 nodes, 10 elements | ~1.3 KB | ~130 KB | ~650 KB |
| 100 nodes, 50 elements | ~6 KB | ~600 KB | ~3 MB |

Comparable to digital engine snapshots. A 1 MB default budget is appropriate for typical circuits.

### 3.4 Comparison to digital snapshots

The digital `EngineSnapshot` stores `values` (Uint32Array), `highZs` (Uint32Array), `undefinedFlags` (Uint8Array), and `stepCount`. For a 200-net circuit: ~1,804 bytes. Analog snapshots are the same order of magnitude.

---

## 4. Snapshot Frequency

Snapshots do not need to be saved at every solver step. The analog solver's adaptive timestep can produce thousands of steps per millisecond of sim-time, but snapshots are only useful at the granularity of user-visible events.

Appropriate snapshot frequencies:

- **Per render frame** (~60 Hz wall-clock): One snapshot per `requestAnimationFrame` callback, after all stepping for that frame is complete. This gives ~60 snapshots per wall-second regardless of solver step rate.
- **Per speed multiple**: Snapshot every N simulation-time units, where N is derived from the speed setting and display resolution. For a timing diagram showing 10ms of sim-time across 1000 pixels, one snapshot per 10µs of sim-time provides full pixel-level scrub resolution.

At 60 snapshots/wall-second with a 6 KB snapshot, memory accumulation is ~360 KB/wall-second. A 3 MB budget provides ~8 seconds of scrub history for a 100-node circuit — sufficient for interactive use.

This means throttling is not a real concern. The snapshot rate is determined by the render loop or a configurable multiple of speed, not by the solver step rate.

---

## 5. Parameter Changes and Cache Invalidation

When a user changes a component parameter at runtime (e.g., resistance via slider panel), the snapshot buffer becomes invalid — stored snapshots contain state computed with the old parameter value. Restoring one would create an inconsistent state (old voltages, new resistance).

The correct behavior is: **parameter changes flush the snapshot buffer and invalidate the cache.** This is the same semantics as clearing an undo stack after an irreversible operation. The `setComponentProperty()` coordinator method (added in Phase 5b, P5b-7) is the natural hook for triggering the flush.

Implementation: `setComponentProperty()` calls `clearSnapshots()` on all engines after applying the parameter change.

---

## 6. Finite-Difference Scheme Handling After Restore

BDF-2 and trapezoidal integration methods depend on prior timestep history (v(n-1), v(n-2)). After restoring a snapshot, the history is also restored — the `HistoryStore` arrays capture exactly this data.

However, if a snapshot was saved during the BDF-1 startup phase (steps 1-2 of a simulation), the integration method state machine (`_acceptedSteps` counter) is also restored, so the solver correctly resumes in BDF-1 mode and transitions to higher-order methods as it normally would.

For additional robustness, the preceding samples can be loaded alongside the snapshot to pre-populate any finite-difference scheme history. The `_prevVoltages` array (captured in every snapshot) provides the v(n-1) data, and the `HistoryStore` slots provide companion model history. This means restoring a snapshot and immediately stepping forward produces numerically correct results without any special warm-up phase.

---

## 7. Implementation Work

### 7.1 Files requiring changes

| File | Change | Estimated Lines |
|------|--------|----------------|
| `src/solver/analog/element.ts` | Add `saveState()` / `restoreState()` to `AnalogElement` interface | ~20 |
| `src/solver/analog/analog-engine.ts` | Add snapshot ring buffer, `saveSnapshot()`, `restoreSnapshot()`, `getSnapshotCount()`, `clearSnapshots()`, element state serialization | ~100-120 |
| `src/solver/analog/integration.ts` | Add `save()` / `restore()` to `HistoryStore` | ~20 |
| `src/solver/analog/timestep.ts` | Add `save()` / `restore()` to `TimestepController` | ~30 |
| `src/solver/coordinator.ts` | Extend snapshot to include analog state + bridge state | ~40-60 |
| `src/core/analog-engine-interface.ts` | Add snapshot methods to `AnalogEngine` interface | ~10 |
| ~40 analog element implementations | Implement `saveState()` / `restoreState()` per element | ~4-8 lines each, ~200 total |
| Tests | Round-trip correctness per element type, budget enforcement, coordinator composite | ~100-150 |

**Total: ~520-610 lines production code, ~100-150 lines test code, ~45 files touched.**

### 7.2 Element factory modifications (dominant cost)

The ~40 element factories use two patterns:

**Class-based** (capacitor, inductor, crystal): Straightforward — expose private fields via `saveState()` returning a typed array, `restoreState()` copying back.

**Closure-based** (BJT, diode, MOSFET, JFET, SCR, varactor, etc.): The closure must capture save/restore functions that serialize the closed-over `let` variables. Example pattern:

```typescript
// In BJT factory
let vbe = 0, vbc = 0;
let op = { vbe: 0, vbc: 0, ic: 0, ib: 0, gm: 0, go: 0, gpi: 0, gmu: 0 };

return {
  // ... existing stamp/update methods ...
  saveState(): Float64Array {
    return Float64Array.of(vbe, vbc, op.vbe, op.vbc, op.ic, op.ib, op.gm, op.go, op.gpi, op.gmu);
  },
  restoreState(buf: Float64Array): void {
    vbe = buf[0]; vbc = buf[1];
    op = { vbe: buf[2], vbc: buf[3], ic: buf[4], ib: buf[5], gm: buf[6], go: buf[7], gpi: buf[8], gmu: buf[9] };
  },
};
```

This is ~4-8 lines per element but must be done correctly for every factory. A missed variable produces subtle snapshot corruption.

### 7.3 API surface

Mirror `DigitalEngine`'s pattern:

```typescript
saveSnapshot(): SnapshotId;
restoreSnapshot(id: SnapshotId): void;
getSnapshotCount(): number;
clearSnapshots(): void;
setSnapshotBudget(bytes: number): void;
```

---

## 8. Runtime Costs

### 8.1 Memory

See section 3. At render-frame snapshot frequency (~60/s), memory accumulation is ~360 KB/wall-second for a 100-node circuit. A 1-3 MB budget provides 3-8 seconds of scrub history.

### 8.2 Save cost

- `_voltages.slice()` and `_prevVoltages.slice()`: flat memcpy of typed arrays — sub-microsecond.
- `HistoryStore.save()`: two `Float64Array.slice()` + one `Uint8Array.slice()` — sub-microsecond.
- `TimestepController.save()`: copy ~6 scalars + clone sign history array — sub-microsecond.
- Element state walk: 50 elements, each returning ~8 numbers as `Float64Array` — ~5-20 µs.
- **Total save: ~10-30 µs.** Negligible vs. a single NR iteration (~100-500 µs) and insignificant at 60 Hz render rate.

### 8.3 Restore cost

Same cost as save. No re-stamping needed — `step()` calls `beginAssembly()` which rebuilds the MNA matrix from scratch on the next step.

### 8.4 Integration method interaction

After restoring a snapshot, the `TimestepController`'s `currentMethod`, `_acceptedSteps`, and `_signHistory` are all restored. The `HistoryStore` provides prior-step data for BDF-2. No special handling is needed — the next `step()` sees consistent history and proceeds correctly.

---

## 9. Complications and Risks

### 9.1 Element state via closures (HIGH RISK)

~30 of the ~40 element factories use closure-captured `let` variables. These are invisible to external code — there is no getter or setter. Each factory must be modified to add `saveState()`/`restoreState()`. A single missed variable produces a subtle, hard-to-detect bug where snapshot restore appears to work but leaves one element in a stale state, causing incorrect simulation after restore.

**Mitigation**: Mandate a round-trip correctness test per element type that saves, steps 10 times, restores, steps 10 times again, and asserts voltage/current equivalence within floating-point tolerance.

### 9.2 Mixed-circuit composite snapshots (MODERATE RISK)

For mixed circuits, the coordinator must atomically snapshot:
1. Digital engine state
2. Analog engine state (new)
3. Each bridge `innerEngine` state (digital, already supported)
4. All bridge state arrays (prevInputBits, prevOutputBits, prevInputVoltages, etc.)
5. TopLevelBridgeState array

If any sub-snapshot fails, the composite is invalid. The coordinator returns a composite `SnapshotId` that maps to all sub-snapshots.

### 9.3 `stamp()` does NOT mutate element state (VALIDATED)

`stamp()` and `stampNonlinear()` read element state and write to the solver matrix. They do not modify element state. `updateOperatingPoint()` and `stampCompanion()` do modify element state — both are captured by the closure variables included in the snapshot.

### 9.4 Newton-Raphson convergence state (NOT NEEDED)

NR iteration state (iteration count, convergence trace, residual) is transient within a single `step()` call. It is not persisted across steps and does not need to be snapshotted.

---

## 10. Comparison: Full Snapshots vs. Data Replay

| Aspect | Full Analog Snapshots | Data Replay (Option C) |
|---|---|---|
| Files changed | ~45 | 2-3 |
| New production lines | ~600 | ~100 |
| New test lines | ~150 | ~50 |
| Risk | High (40 element factories) | Low |
| Memory/snapshot | ~1.3-6 KB (full state) | ~160-800 bytes (displayed signals only) |
| Save cost/call | ~10-30 µs | ~1-5 µs |
| Capability: view past values | Yes | Yes |
| Capability: rewind and resume simulation | Yes | No |
| Capability: measure any signal at past time | Yes (full state available) | No (only pre-recorded signals) |

Data replay is 6-10x simpler and lower risk. Full snapshots add rewind-and-resume plus the ability to query any signal (not just pre-recorded ones) at any past time point.

---

## 11. Acceptance Criteria

1. **Round-trip correctness**: Save at step N, advance 10 steps, restore, advance 10 steps again. All node voltages and element currents match the first run within < 1e-12 relative error. Must pass for circuits containing every element type.

2. **Memory budget enforcement**: With a 100 KB budget and 2 KB snapshots, storing 51 snapshots evicts the oldest. `getSnapshotCount()` never exceeds `floor(budget / snapshotSize)`.

3. **Coordinator composite snapshot**: For a mixed digital+analog circuit with bridge instances, `saveSnapshot()` followed by `restoreSnapshot()` restores all sub-engines atomically.

4. **Parameter change invalidation**: Calling `setComponentProperty()` flushes the snapshot buffer. `getSnapshotCount()` returns 0 after flush.

5. **Performance**: `saveSnapshot()` completes in < 100 µs for a 100-node, 50-element circuit.

6. **Integration method correctness**: Restore to a BDF-1 startup point, step forward — the method transitions to higher-order correctly without numerical artifacts.

7. **All existing tests pass** (minus pre-existing submodule failures).

---

## 12. Open Questions

- [ ] Is rewind-and-resume simulation a requirement, or is display-only scrubbing sufficient? This determines whether the 600-line implementation is justified vs. the 100-line data-replay approach.
- [ ] Should `saveState()` / `restoreState()` be mandatory on `AnalogElement`, or optional with a fallback (e.g., elements without snapshot support cause the entire snapshot to be skipped for that element)?
- [ ] Should `saveSnapshot()` be forbidden when the engine is in ERROR state?
- [ ] Should mixed-circuit composite snapshots (digital + analog + bridges) be in scope for the first iteration, or should analog-only circuits come first?
