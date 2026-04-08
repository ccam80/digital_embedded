# Comparison Harness — Open Issues

Post-mortem from initial smoke test session on buckbjt circuit.
Infrastructure is connected end-to-end. ngspice topology, node names, device state
extraction all working. Remaining issues are in the query/comparison layer and ergonomics.

## P0 — Produces Wrong Results

### 1. Step alignment is by array index, not by time

`compareSnapshots()` and all query methods (`getStepEnd`, `getIterations`, `traceComponent`) pair step N from our engine with step N from ngspice. These are at completely different simulation times (our step 0 is t=1ns, ngspice step 0 is t=0). Every comparison is meaningless until steps are aligned by `simTime`.

**Fix:** Time-based alignment in ComparisonSession — for each our step, find the ngspice step at the nearest `simTime` (or bracket-interpolate). The aligned ngspice step index should be used in all query methods.

### 2. Node labels are UUIDs when `labelPinNodes` is empty

`captureTopology` strategy 3 (element pin reverse-map) produces labels like `cfdbe996-...:p0/221259ba-...:p1`. This fires when `labelPinNodes` is empty, which it is for circuits loaded via the facade. Element states now have human labels (Q1, R1, etc.) via `buildElementLabelMap`, but node labels still use UUIDs in the reverse-map fallback.

**Fix:** Strategy 3 should use `buildElementLabelMap` to get human names, producing labels like `Q1:p0/R1:p1`. Better: populate `labelPinNodes` during compilation so strategy 1 always fires.

### 3. Matrix data not captured from ngspice

The callback passes node voltages, pre-solve RHS, and device state — but not the assembled G matrix (`CKTmatrix`). Our side captures matrix non-zeros via `solver.getCSCNonZeros()`. For stamp-level debugging ("did our BJT stamp the right gpi into the right matrix position?"), we need the ngspice matrix.

**Fix:** Extend the C callback to serialize `CKTmatrix` sparse entries after `CKTload` but before `SMPsolve`. The pre-solve RHS is already captured; the matrix is the remaining half of Gx=b.

## P1 — Ergonomic Pain Points

### 4. Session is not reusable — must construct/init/run for every query

The smoke test creates 3 separate `ComparisonSession` instances and runs the same transient 3 times to answer 3 different questions. `init()` recompiles the circuit, `runTransient()` re-runs both engines.

**Fix:** `init()` + `runTransient()` should be idempotent or the session should cache results. A single `const session = await ComparisonSession.create(opts)` factory that does init+run would eliminate the ceremony.

### 5. DLL path resolution uses `__dirname` which breaks under vitest

`ComparisonSession` uses `resolve(__dirname, "../../../../..")` to find the project root. Under vitest, `__dirname` resolves to the source file's directory, so the relative depth must be exactly right. The smoke test had to use `process.cwd()` instead.

**Fix:** Resolve paths relative to `process.cwd()` (always the project root in test runners), not `__dirname`. The `dtsPath` and `cirPath` options already work relative to cwd. The DLL default path should too.

### 6. No filtering/projection on query results — caller does all the work

To find "CCAP slots in BJT junctions", the caller must manually iterate `Object.entries(stepEnd.components)` and filter slot names by string prefix. This should be a first-class query: `session.getComponentSlots("Q1", ["CCAP_*", "Q_*"], { step: 0 })`.

**Fix:** Add slot-level filtering to `traceComponent` and `getStepEnd`. Support glob patterns for slot names.

### 7. No formatting on ComparedValue — manual `.toExponential()` everywhere

Every output line requires `cv.ours.toExponential(4)`. `toExponential` is JS number formatting — the consumer shouldn't need to call it.

**Fix:** Add `ComparedValue.format(precision?)` or `formatCV(cv)` helper. Add `session.printStepEnd(stepIndex)`, `session.printTrace("Q1")` convenience methods.

### 8. Component type not available on query results

To find "all BJTs", the caller checks `if ("VBE" in slots)` — inferring type from slot names. `getStepEnd` doesn't expose device type.

**Fix:** Add `deviceType` to component entries. Add `session.getComponentsByType("bjt")` and `session.traceDeviceType("bjt")`.

### 9. No way to query "mismatches only"

Every query returns all data; caller filters for `!cv.withinTol`.

**Fix:** Add `session.getDivergences(stepIndex?)` → only out-of-tolerance values. Add `onlyMismatches` option to query methods.

### 10. `traceComponent` requires knowing the label in advance

No discovery API to find component labels by type.

**Fix:** `session.listComponents()` → `[{ label: "Q1", type: "bjt" }, ...]`.

## P2 — Missing Infrastructure

### 11. No DC OP per-iteration capture timing

The DC OP that runs during `facade.compile()` completes before the capture hook is installed. `ComparisonSession.runDcOp()` re-runs DC OP with the hook, which works but wastes the compile-time result.

**Fix:** Either expose a `compileDry()` that skips DC OP, or accept the re-run (current behavior is functional, just wasteful).

### 12. ngspice device node indices not populated

The topology callback doesn't populate per-device node indices (which nodes a device connects to). The `nodeIndices` field on `NgspiceDeviceInfo` is always empty.

**Fix:** Either populate in C using per-device-type knowledge, or match devices to nodes by name pattern (e.g. "q1" connects to nodes "q1_c", "q1_b", "q1_e" — already parseable by node-mapping.ts).

### 13. No JSON export of session results

For agent consumption and caching, `session.toJSON()` that produces a self-contained report would be valuable.