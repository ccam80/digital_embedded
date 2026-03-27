# Review Report: MCP Server Refinement — Waves 1, 2, 3, 5

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 4 waves (mixed-mode awareness, interactive simulation, batch discovery, attribute map) |
| Violations | 3 (1 critical, 1 major, 1 minor) |
| Gaps | 1 |
| Weak tests | 0 |
| Legacy references | 0 |
| Verdict | **has-violations** |

## Violations

### V1 — CRITICAL: `circuit_ac_sweep` passes incomplete params to `coordinator.acAnalysis()`

- **File**: `scripts/mcp/simulation-tools.ts`, line 281
- **Rule violated**: Type safety / correctness
- **Evidence**:
  ```ts
  const result = coordinator.acAnalysis({ fStart, fStop, numPoints: points });
  ```
  The `AcParams` interface (defined in `src/solver/analog/ac-analysis.ts` lines 40-53) requires six fields:
  ```ts
  interface AcParams {
    type: "lin" | "dec" | "oct";
    numPoints: number;
    fStart: number;
    fStop: number;
    sourceLabel: string;
    outputNodes: string[];
  }
  ```
  The MCP tool only supplies `{ fStart, fStop, numPoints }` — omitting **three required fields**: `type`, `sourceLabel`, and `outputNodes`. When this tool is called on an analog circuit, the analog engine at `src/solver/analog/analog-engine.ts:445` will iterate `params.outputNodes` (undefined), causing a runtime crash. The tool's Zod input schema also does not expose `sourceLabel`, `outputNodes`, or `type` to the caller, so even if the TypeScript compiled (which it may not — this needs verification), the agent has no way to provide the missing parameters.
- **Severity**: CRITICAL

### V2 — MAJOR: `circuit_test` leaks compiled engines (no dispose)

- **File**: `scripts/mcp/circuit-tools.ts`, lines 664-665
- **Rule violated**: Engine lifecycle / resource management
- **Evidence**:
  ```ts
  const engine = facade.compile(circuit);
  const results = facade.runTests(engine, circuit, resolvedData);
  ```
  `facade.compile()` creates a fresh `DefaultSimulationCoordinator` (which allocates typed arrays, solver state, etc.). The returned coordinator is used for test execution but is never stored in `session.storeEngine()` and never has `dispose()` called on it. Every `circuit_test` invocation leaks one engine's worth of memory. By contrast, `circuit_compile` (line 596-597) correctly calls `session.storeEngine(handle, coordinator)`, which disposes any previous engine before storing the new one. Additionally, `facade.compile()` internally sets `facade._coordinator` and `facade._circuit` as side effects (lines 101-111 of `default-facade.ts`), so calling `circuit_test` on handle A will silently overwrite the facade's internal coordinator even if handle B was previously compiled via `circuit_compile`. This could cause subtle bugs if the facade's internal state is later used.
- **Severity**: MAJOR

### V3 — MINOR: `netlist.ts` inlines `availableModels()` logic instead of calling the utility

- **File**: `src/headless/netlist.ts`, line 392
- **Rule violated**: Code hygiene (DRY)
- **Evidence**:
  ```ts
  const models = def.models ? Object.keys(def.models) : [];
  ```
  Meanwhile `formatters.ts` line 82 correctly uses:
  ```ts
  const models = availableModels(def);
  ```
  The `availableModels()` utility in `src/core/registry.ts:256` implements the identical logic `def.models ? Object.keys(def.models) : []`. The netlist file already imports from `registry.js` (indirectly via types) but does not import or use the utility function. If `availableModels()` ever gains filtering or ordering logic, the netlist output will diverge from the formatter output.
- **Severity**: MINOR

## Gaps

### G1: `circuit_ac_sweep` input schema missing required AC analysis parameters

- **Spec requirement**: The AC sweep tool should expose the full parameter set needed to run AC analysis.
- **What was actually found**: The Zod input schema in `simulation-tools.ts` lines 265-272 only exposes `handle`, `fStart`, `fStop`, and `points`. It does not expose `type` (sweep type: lin/dec/oct), `sourceLabel` (which AC source to excite), or `outputNodes` (which nodes to measure). Without these, the tool cannot function for any real circuit. An agent calling this tool has no way to specify which source to excite or which outputs to measure.
- **File**: `scripts/mcp/simulation-tools.ts`

## Weak Tests

None found. (No test files were identified as part of the wave deliverables for the reviewed scope.)

## Legacy References

None found.

## Additional Observations

### Engine lifecycle — `storeEngine` dispose pattern is correct

`SessionState.storeEngine()` (tool-helpers.ts line 89-93) correctly disposes the previous engine before storing a new one. The `ensureEngine()` helper in simulation-tools.ts (line 37-48) correctly uses `session.engines.has()` and `session.storeEngine()`. The lifecycle is sound for all simulation tools — the gap is only in `circuit_test`.

### SignalValue handling in simulation tools is correct

`formatSignalValue()` (simulation-tools.ts lines 19-25) correctly discriminates on `sv.type === "digital"` vs analog, accessing `sv.value` for digital and `sv.voltage`/`sv.current` for analog. `circuit_set_input` (lines 132-136) correctly constructs the appropriate discriminated union variant based on `addr.domain`. This is type-safe.

### Batch describe handles mixed found/not-found correctly

`circuit_describe` (circuit-tools.ts lines 182-238) correctly separates found and not-found results, returns an error response only when ALL types are not found, and appends a "Not found" section when some types are missing from a batch request. This is well-designed.

### `circuit_list` include_pins reads pinLayout directly from definitions

The `include_pins` path (circuit-tools.ts lines 357-367) reads `def.pinLayout` which is populated during `register()`. It does not need to call `registry.get()` — it already has the definitions from `registry.getAll()`. This is correct.

### Auto-compile in simulation tools is consistent

All six simulation tools (`circuit_step`, `circuit_set_input`, `circuit_read_output`, `circuit_read_all_signals`, `circuit_dc_op`, `circuit_ac_sweep`) call `ensureEngine()` at the top, which auto-compiles if needed and stores the engine. This is consistent.

### Netlist model info population

`netlist.ts` line 392-394 reads `def.models` keys and the `defaultModel` attribute. The `activeModel` field is only set when the attribute exists. The `formatNetlist` in formatters.ts lines 50-53 correctly renders domain tags (`[digital]`, `[analog]`, `[mixed]`) based on `comp.availableModels`. This is functionally correct.
