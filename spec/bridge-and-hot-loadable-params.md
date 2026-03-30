# Combined Spec: Bridge Architecture + Hot-Loadable Model Params

## Overview

This spec combines two review findings from the unified-model-params implementation into one implementation plan:

1. **Bridge architecture rewrite** — replace the Norton-equivalent bridge adapters with ideal voltage source bridges, separate loading from domain transition, implement per-net loading decisions via domain injection, and fix all three `digitalPinLoading` modes.

2. **Hot-loadable model params** — make `setParam` required on `AnalogElementCore`, ensure every component factory implements the mutable-params-object pattern, and integrate bridge adapters into the same hot-loading path.

These combine with the remaining unified-model-params waves (component sweep, runtime features, verification) into four implementation waves.

### Design Principles

**A bridge is a domain transition, not loading.** The bridge output is an ideal voltage source (enforces vOH/vOL). The bridge input is a threshold sense (reads voltage, compares to vIH/vIL). Loading (rOut, cOut, rIn, cIn) is separate — regular R/C stamps added only when loading is enabled.

**Loading a digital net creates an analog domain presence.** When `digitalPinLoading === "all"` or a per-net override says `"loaded"`, the net's `domains` set gains `"analog"`. This makes it a boundary. Normal boundary bridge logic handles the rest. `partition.ts` is unchanged.

**Three modes:**

| Mode | Which nets get bridges | Loading (rOut, cOut, rIn, cIn) |
|------|----------------------|-------------------------------|
| `"none"` | Real boundaries only | Zeroed (rIn=∞, cIn=0, cOut=0; rOut not stamped) |
| `"cross-domain"` | Real boundaries only | Full values from pin electrical spec |
| `"all"` | All digital nets (domain injection → all become boundaries) | Full values |

Per-net overrides:
- `"loaded"` on a non-boundary net → injects `"analog"` into that net's domains, adds full loading
- `"ideal"` on a boundary net → keeps the bridge (domain transition), zeroes loading params

**`setParam` is required on `AnalogElementCore`.** Every factory — component factories, bridge adapters, subcircuit composites — must implement `setParam(key, value)`. TypeScript enforces this at compile time.

---

## Wave 1: Bridge Architecture Rewrite

**Task ordering constraints:**
- Tasks 1.1 and 1.2 modify the same file (`digital-pin-model.ts`) — run sequentially, same agent.
- Tasks 1.5 and 1.6 modify the same function (`compileAnalogPartition` in `compiler.ts`) — run sequentially, same agent. 1.5 (guard + ground) before 1.6 (bridge element creation).
- Task 1.3 depends on 1.1 + 1.2 (adapter wraps rewritten pin models).
- Task 1.7 depends on 1.6 (coordinator uses compiler-created bridge elements).
- Task 1.8 depends on all other Wave 1 tasks.
- Tasks 1.4 is independent of 1.1–1.3 and can run in parallel with them.

**`isReactive` resolution:** Bridge adapters implement `isReactive` as a getter, not a static field. It returns `this._loaded && this._pinModel.capacitance > 0`. When unloaded, `isReactive === false` and `stampCompanion` is a no-op. This avoids the conflict between Tasks 1.1/1.2 (conditional stamping) and 1.3 (static field declaration).

### Task 1.1: Rewrite DigitalOutputPinModel to ideal voltage source

- **Description**: Replace the Norton equivalent stamp (conductance + current source) with an ideal voltage source branch equation. Add drive/Hi-Z mode switching via the branch equation. Add inline loading stamps (rOut, cOut) that are only active when loading is enabled.
- **Files to modify**:
  - `src/solver/analog/digital-pin-model.ts` — rewrite `DigitalOutputPinModel`:
    - Constructor accepts `ResolvedPinElectrical` spec + a `loaded: boolean` flag
    - `init(nodeId, branchIdx)` — stores both node ID and branch index (branch variable now used)
    - `stamp(solver)` — MNA index convention: `nodeIdx = nodeId - 1` (0-based into solver), `branchIdx` is the absolute branch row/col in the augmented matrix (= `totalNodeCount + assignedBranchOffset`). The `SparseSolver.stamp(row, col, value)` and `stampRHS(row, value)` methods use these indices directly.
      - **Drive mode**: `solver.stamp(branchIdx, nodeIdx, 1)` (branch eq: V_node coefficient), `solver.stamp(nodeIdx, branchIdx, 1)` (KCL: branch current), `solver.stampRHS(branchIdx, V_target)` (branch eq RHS). If loaded, also `solver.stamp(nodeIdx, nodeIdx, 1/rOut)` (output impedance).
      - **Hi-Z mode**: `solver.stamp(branchIdx, branchIdx, 1)`, `solver.stampRHS(branchIdx, 0)` (I=0). `solver.stamp(nodeIdx, branchIdx, 1)` (KCL, but I=0 so no effect). If loaded, `solver.stamp(nodeIdx, nodeIdx, 1/rHiZ)`.
      - **Sparsity pre-allocation**: both `(branchIdx, nodeIdx)` and `(branchIdx, branchIdx)` entries must be allocated in the sparsity pattern at construction time. Drive mode sets `(branchIdx, branchIdx) = 0`, Hi-Z sets `(branchIdx, nodeIdx) = 0`. Only values change on mode switch, not structure.
    - `stampCompanion(solver, dt, method)` — only stamp cOut companion when loaded (`cOut > 0`)
    - `setParam(key, value)` — mutates the internal params object (same pattern as BJT)
    - Remove `stampNonlinear` — the ideal source is linear (V_target changes are handled by re-stamp)
  - `src/solver/analog/integration.ts` — no changes (companion model helpers reused as-is)
- **Tests** (`src/solver/analog/__tests__/digital-pin-model.test.ts` — new file):
  - `drive mode stamps branch equation` — verify `A[branchRow][nodeCol] === 1` and `z[branchRow] === vOH`
  - `hi-z mode stamps I=0` — verify `A[branchRow][branchCol] === 1` and `z[branchRow] === 0`
  - `setLogicLevel toggles target voltage` — set high → `z[branchRow] === vOH`, set low → `z[branchRow] === vOL`
  - `loaded mode stamps rOut conductance` — verify `A[nodeRow][nodeRow]` includes `1/rOut`
  - `unloaded mode does not stamp rOut` — verify `A[nodeRow][nodeRow]` does NOT include `1/rOut`
  - `setParam("rOut", 50) updates conductance on next stamp` — verify new value used
  - `setParam("vOH", 5.0) updates target voltage` — verify `z[branchRow] === 5.0` after re-stamp
- **Acceptance criteria**:
  - `DigitalOutputPinModel.stamp()` uses branch equation (not Norton conductance + current source)
  - `branchIndex` is no longer `-1` — every output bridge uses one branch variable
  - `setParam` mutates all 9 pin-electrical params (rOut, cOut, rIn, cIn, vOH, vOL, vIH, vIL, rHiZ)
  - All 7 tests pass

### Task 1.2: Rewrite DigitalInputPinModel to sense-only + inline loading

- **Description**: Remove the conductance stamp from the default path. Input threshold detection (`readLogicLevel`) is always available. Loading stamps (rIn, cIn) are only active when `loaded === true`.
- **Files to modify**:
  - `src/solver/analog/digital-pin-model.ts` — rewrite `DigitalInputPinModel`:
    - Constructor accepts `ResolvedPinElectrical` spec + `loaded: boolean` flag
    - `stamp(solver)` — if loaded, stamp `1/rIn` on node diagonal. If not loaded, no-op.
    - `stampCompanion(solver, dt, method)` — if loaded and `cIn > 0`, stamp companion. Otherwise no-op.
    - `readLogicLevel(voltage)` — unchanged (threshold detection always available)
    - `setParam(key, value)` — mutates the internal params object
    - `branchIndex` remains `-1` (no branch variable needed — input is passive)
- **Tests** (`src/solver/analog/__tests__/digital-pin-model.test.ts` — same file as 1.1):
  - `loaded input stamps rIn conductance` — verify `A[nodeRow][nodeRow]` includes `1/rIn`
  - `unloaded input stamps nothing` — verify `A[nodeRow][nodeRow] === 0`
  - `readLogicLevel thresholds correctly` — voltage > vIH → true, < vIL → false, between → undefined
  - `setParam("rIn", 1e6) takes effect on next stamp` — verify new conductance
- **Acceptance criteria**:
  - Unloaded `DigitalInputPinModel.stamp()` produces zero matrix entries
  - Loaded stamps `1/rIn` on diagonal only
  - `readLogicLevel` works regardless of loaded flag
  - All 4 tests pass

### Task 1.3: Rewrite BridgeOutputAdapter and BridgeInputAdapter

- **Description**: Update the adapter classes to use the rewritten pin models. `BridgeOutputAdapter` now uses a branch variable (ideal voltage source). `BridgeInputAdapter` has no MNA stamp when unloaded.
- **Files to modify**:
  - `src/solver/analog/bridge-adapter.ts`:
    - `BridgeOutputAdapter`:
      - `branchIndex` — set from constructor (no longer hardcoded `-1`)
      - `isNonlinear: false` (ideal source is linear; logic level changes are handled via re-stamp by coordinator, not via NR iteration)
      - `isReactive` — true only when loaded and cOut > 0
      - Remove `stampNonlinear()` — the coordinator calls `stamp()` after updating logic level
      - `stamp(solver)` delegates to `DigitalOutputPinModel.stamp()`
      - `stampCompanion()` delegates, only active when loaded
      - `getPinCurrents()` — reads branch current from solution vector (branch variable gives current directly)
      - `setParam(key, value)` — delegates to pin model
    - `BridgeInputAdapter`:
      - `branchIndex: -1` (unchanged — no branch variable)
      - `isNonlinear: false`
      - `isReactive` — true only when loaded and cIn > 0
      - `stamp(solver)` delegates, no-op when unloaded
      - `stampCompanion()` delegates, no-op when unloaded
      - `setParam(key, value)` — delegates to pin model
    - `makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded)` — updated signature, passes `loaded` and `branchIdx` through
    - `makeBridgeInputAdapter(spec, nodeId, loaded)` — updated signature, passes `loaded`
  - `src/solver/analog/compiled-analog-circuit.ts` — if `BridgeOutputAdapter.branchIndex` is no longer always -1, ensure the compiled circuit accounts for bridge branch variables in `branchCount`
- **Tests** (`src/solver/analog/__tests__/bridge-adapter.test.ts` — rewrite):
  - `output adapter stamps ideal voltage source at vOL` — verify branch equation entries
  - `output adapter setLogicLevel(true) drives vOH` — verify RHS update
  - `output adapter hi-z stamps I=0` — verify branch equation switch
  - `loaded output adapter stamps rOut + cOut companion` — verify diagonal entry + companion
  - `unloaded output adapter does not stamp rOut` — verify no diagonal conductance
  - `input adapter unloaded stamps nothing` — verify zero entries
  - `input adapter loaded stamps rIn` — verify diagonal conductance
  - `input adapter readLogicLevel thresholds` — verify threshold detection
  - `setParam("rOut", 50) hot-updates output adapter` — verify new conductance after re-stamp
  - `setParam("vIH", 2.5) hot-updates input threshold` — verify readLogicLevel uses new value
- **Acceptance criteria**:
  - `BridgeOutputAdapter.branchIndex >= 0` for all output bridges
  - `BridgeOutputAdapter.isNonlinear === false`
  - `BridgeInputAdapter` produces zero matrix entries when unloaded
  - `setParam` works on both adapter types for all 9 pin-electrical params
  - All 10 tests pass

### Task 1.4: Domain injection for "all" mode + per-net overrides

- **Description**: Add a step in `compile.ts` between connectivity extraction (step 3) and partitioning (step 4) that injects `"analog"` into the `domains` set of digital-only groups when loading is enabled.
- **Files to modify**:
  - `src/compile/compile.ts` — add `applyLoadingDecisions()` call between steps 3 and 4:
    ```
    // Step 3b: Apply loading decisions — inject "analog" into loaded nets
    applyLoadingDecisions(groups, digitalPinLoading, perNetLoadingOverrides);
    ```
  - `src/compile/extract-connectivity.ts` — add exported function:
    ```typescript
    export function applyLoadingDecisions(
      groups: ConnectivityGroup[],
      digitalPinLoading: "cross-domain" | "all" | "none",
      perNetOverrides: ReadonlyMap<number, "loaded" | "ideal">,
    ): void
    ```
    Logic:
    - For each group where `domains` contains `"digital"` but not `"analog"`:
      - Check per-net override first: if `"loaded"` → add `"analog"` to domains
      - Else check circuit-level: if `digitalPinLoading === "all"` → add `"analog"` to domains
    - For boundary groups (already have both domains):
      - Check per-net override: if `"ideal"` → set a `loadingMode` flag on the group (used later by bridge creation to zero loading)
    - Groups with `"analog"` injected also need `bitWidth` preserved from the digital domain
  - `src/compile/types.ts` — add optional `loadingMode?: "loaded" | "ideal"` field to `ConnectivityGroup` (consumed by bridge adapter creation to decide loaded vs unloaded)
- **Tests** (`src/compile/__tests__/loading-decisions.test.ts` — new file):
  - `"all" mode injects analog into digital-only group` — group starts `{"digital"}`, after call → `{"digital", "analog"}`
  - `"cross-domain" mode does not inject analog` — group stays `{"digital"}`
  - `"none" mode does not inject analog` — group stays `{"digital"}`
  - `per-net "loaded" override injects analog in "cross-domain" mode` — override wins
  - `per-net "loaded" override injects analog in "none" mode` — override wins
  - `per-net "ideal" override on boundary sets loadingMode` — group has both domains, `loadingMode === "ideal"`
  - `per-net "ideal" override on digital-only group is no-op` — can't make a non-boundary "ideal"
- **Acceptance criteria**:
  - `partition.ts` is NOT modified
  - `applyLoadingDecisions` is the ONLY function that mutates `group.domains`
  - All 7 tests pass

### Task 1.5: Analog partition guard fix + ground synthesis

- **Description**: Fix the `compile.ts` guard that skips analog compilation when there are no analog components. Add ground synthesis in `compileAnalogPartition` for partitions that have loaded nets but no Ground component.
- **Files to modify**:
  - `src/compile/compile.ts` — change the analog compilation guard (line ~175):
    ```typescript
    // OLD:
    const hasAnalog = analogPartition.components.length > 0;
    // NEW:
    const hasAnalog = analogPartition.components.length > 0 ||
                      analogPartition.groups.length > 0;
    ```
  - `src/solver/analog/compiler.ts` — in `compileAnalogPartition`, after `buildAnalogNodeMapFromPartition`:
    - If `partition.components` has no Ground element BUT `partition.groups.length > 0`:
      - Synthesize a virtual ground node: `buildAnalogNodeMapFromPartition` already assigns node 0 when it finds a Ground group. For bridge-only partitions with no Ground component, force node 0 to exist by injecting a synthetic ground group (groupId=-1, domains={"analog"}) into the node map builder, or by unconditionally reserving node 0.
      - Suppress the `"no-ground"` diagnostic (it's expected for bridge-only partitions)
      - `compileAnalogPartition` already receives `outerCircuit?: Circuit` as a parameter. Use `outerCircuit.elements.some(el => el.typeId === "Ground")` to locate a physical ground position. If found, ensure the analog ground node maps to the same wire position. If no physical ground exists anywhere, the virtual ground is at node 0 with no spatial position.
- **Tests** (`src/compile/__tests__/compile-bridge-guard.test.ts` — new file):
  - `pure-digital circuit in "all" mode compiles analog partition` — `compiledAnalog !== null`
  - `pure-digital circuit in "all" mode has bridge adapters` — `bridges.length > 0`
  - `pure-digital circuit in "all" mode has no "no-ground" diagnostic` — zero diagnostics with code `"no-ground"`
  - `pure-digital circuit in "cross-domain" mode skips analog` — `compiledAnalog === null` (no boundary nets)
  - `analog partition with bridge groups but no components assigns node 0` — `nodeCount >= 1`
- **Acceptance criteria**:
  - `compileUnified()` returns non-null `analog` for pure-digital circuits in `"all"` mode
  - No `"no-ground"` error for bridge-only analog partitions
  - All 5 tests pass

### Task 1.6: Integrate bridge MNA elements into analog compiler

- **Description**: The analog compiler currently allocates `elementBridgeAdapters` (compiler.ts:1095) but never populates it. After the main element loop, iterate bridge stubs and create `BridgeOutputAdapter`/`BridgeInputAdapter` MNA elements. These elements participate in the MNA matrix solve.
- **Files to modify**:
  - `src/solver/analog/compiler.ts` — in `compileAnalogPartition`, after the main element loop (after line ~1268):
    - For each `BridgeStub` in `partition.bridgeStubs`:
      - Resolve the group's MNA node ID from `groupToNodeId`
      - Determine loading mode: check `group.loadingMode` (from Task 1.4). Default is `"loaded"` for `"cross-domain"`/`"all"` modes, `"ideal"` for `"none"` mode.
      - Resolve `ResolvedPinElectrical` for each pin in the boundary group using `resolvePinElectrical()`
      - For each digital output pin in the group:
        - Allocate a branch index (`branchCount++`)
        - Create `BridgeOutputAdapter` via `makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded)`
        - Add to `analogElements` array
        - Store in a new `bridgeAdaptersByGroupId: Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>` keyed by `boundaryGroupId` (NOT element index — bridge stubs have no element index)
      - For each digital input pin in the group:
        - Create `BridgeInputAdapter` via `makeBridgeInputAdapter(spec, nodeId, loaded)`
        - Add to `analogElements` array
        - Store in `bridgeAdaptersByGroupId`
    - Update `branchCount` and `totalNodeCount` to account for bridge branch variables
    - Expose `bridgeAdaptersByGroupId` on `ConcreteCompiledAnalogCircuit` (new public field) so the coordinator can look up adapters by boundary group ID
  - `src/solver/analog/compiled-analog-circuit.ts` — ensure `ConcreteCompiledAnalogCircuit` constructor accounts for bridge elements in the element list and bridge adapters in the `elementBridgeAdapters` map
- **Tests** (`src/solver/analog/__tests__/bridge-compilation.test.ts` — new file):
  - `boundary group produces output + input bridge adapters` — compile a mixed circuit, verify `elementBridgeAdapters` map is populated
  - `bridge output adapter has branch index >= 0` — verify branch variable allocated
  - `bridge adapters participate in MNA solve` — compile + step → verify analog node voltage at bridge matches vOH/vOL
  - `"none" mode bridge adapters are unloaded` — verify output adapter does not stamp rOut, input adapter stamps nothing
  - `"cross-domain" mode bridge adapters are loaded` — verify rOut/rIn conductance stamped
  - `per-net "ideal" override on boundary produces unloaded adapters` — verify zero loading
  - `bridge output in hi-z mode stamps I=0` — set Hi-Z, verify branch current is zero
- **Acceptance criteria**:
  - `elementBridgeAdapters` map is populated for every bridge stub
  - Bridge output adapters have `branchIndex >= 0`
  - Bridge adapters appear in the compiled analog circuit's `elements` array
  - `"none"` mode bridge adapters stamp zero loading
  - All 7 tests pass

### Task 1.7: Update coordinator bridge logic

- **Description**: The coordinator currently handles bridge logic inline by reading/writing raw voltages via `analog.getNodeVoltage()` and `digital.getSignalRaw()`. Update to use the bridge MNA elements created by the compiler.
- **Files to modify**:
  - `src/solver/coordinator.ts`:
    - **Wiring**: The coordinator currently iterates `compiled.bridges` (an array of `BridgeAdapter` descriptors with `boundaryGroupId`, `digitalNetId`, `analogNodeId`, `direction`). After Wave 1, the compiled analog circuit exposes `bridgeAdaptersByGroupId: Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>`. The coordinator resolves MNA bridge elements by looking up `compiledAnalog.bridgeAdaptersByGroupId.get(bridge.boundaryGroupId)` for each `BridgeAdapter` descriptor. Store these resolved references at construction time in a parallel array alongside `_bridges`.
    - `_stepMixed()` (line ~178) — replace the inline voltage read/write logic:
      - Analog→digital: for each analog-to-digital bridge, read voltage via `analog.getNodeVoltage(bridge.analogNodeId)`, call `inputAdapter.readLogicLevel(voltage)` → write bit to digital engine
      - Digital→analog: for each digital-to-analog bridge, read digital signal via `digital.getSignalRaw(bridge.digitalNetId)`, call `outputAdapter.setLogicLevel(high)` → analog engine picks up new V_target on next stamp
    - Delete `_thresholdVoltage()` (line ~568) — threshold logic is now in `BridgeInputAdapter.readLogicLevel()`
    - `setComponentProperty()` (line ~508) — update the bridge adapter routing to use `bridgeAdaptersByGroupId` instead of the empty `elementBridgeAdapters`. Pin-electrical params (e.g. `"A.rOut"`) route to the adapter's `setParam`.
  - `src/solver/coordinator-types.ts` — if the coordinator interface exposes bridge-related types, update signatures
- **Tests** (`src/solver/__tests__/coordinator-bridge.test.ts` — new file):
  - `digital output drives analog node via bridge adapter` — digital step sets output high → analog node voltage ≈ vOH
  - `analog voltage thresholds to digital via bridge input` — set analog node voltage > vIH → digital reads 1
  - `setParam("rOut") on bridge adapter updates loading` — change rOut via coordinator → verify new conductance in analog solve
  - `hi-z output stops driving analog node` — set Hi-Z → analog node voltage determined by other elements (not driven)
- **Acceptance criteria**:
  - `_thresholdVoltage()` private method deleted from coordinator
  - Coordinator's `stepMixedSignal` delegates to bridge adapter methods
  - `setComponentProperty` routes pin-electrical params to bridge adapters
  - All 4 tests pass

### Task 1.8: Rewrite bridge tests encoding wrong behavior

- **Description**: The existing `digital-pin-loading.test.ts`, `pin-loading-menu.test.ts`, and `digital-bridge-path.test.ts` encode wrong assumptions about bridge behavior. Rewrite to match the new architecture.
- **Files to modify**:
  - `src/solver/analog/__tests__/digital-pin-loading.test.ts` — rewrite all assertions:
    - Remove tests that assert component partition reclassification
    - Tests asserting bridge counts should assert per-net bridges (not per-component)
    - "none mode" tests should verify bridges exist at real boundaries with zero loading (not `rIn=Infinity` which was never implemented)
    - "all mode" tests should verify bridges on ALL digital nets (not just dual-model components)
    - Fix tests that pass `digitalPinLoading: "all"` for all three modes (copy-paste bug in current tests)
  - `src/compile/__tests__/pin-loading-menu.test.ts` — rewrite assertions about partition membership. Components never change partition based on loading mode.
  - `src/solver/analog/__tests__/bridge-adapter.test.ts` — already being rewritten in Task 1.3; ensure the rewritten tests cover the ideal voltage source behavior (no separate digital-bridge-path file exists)
  - `src/headless/__tests__/digital-pin-loading-mcp.test.ts` — update MCP surface tests to match new behavior
- **Tests**: all existing tests in these files rewritten with correct assertions
- **Acceptance criteria**:
  - Zero test assertions that check component partition reclassification based on loading mode
  - Zero references to Norton equivalent in bridge test assertions
  - "none" mode tests verify: bridges at real boundaries, zero loading (rIn=∞ input stamps nothing, cIn=0, cOut=0)
  - "all" mode tests verify: bridges on every digital net, full loading
  - "cross-domain" tests verify: bridges at real boundaries only, full loading
  - All rewritten tests pass

**POST-WAVE CHECK:** `npm run test:q` — all tests pass. Verification:
- Bridge adapters use ideal voltage source (branch equation), not Norton equivalent
- All three `digitalPinLoading` modes produce correct bridge counts
- `_thresholdVoltage` deleted from coordinator
- `elementBridgeAdapters` (old empty map) replaced by `bridgeAdaptersByGroupId` (populated)

**Three-surface rule (CLAUDE.md):** Bridge behavior is user-facing. Wave 1 headless unit tests cover the headless surface. Additionally:
- MCP surface: add tests to `src/headless/__tests__/digital-pin-loading-mcp.test.ts` verifying bridge counts and loading behavior across all three modes via the facade API
- E2E surface: add tests to `e2e/gui/` verifying that `digitalPinLoading` mode changes produce visible simulation differences (voltage at loaded vs unloaded pins)

**Mid-simulation hot-load test:** At least one test must verify hot-loading during a running simulation: compile → start stepping → call `setParam("vOH", 5.0)` on a bridge output adapter mid-step → verify the analog node voltage changes on the next step. This confirms setParam works during live simulation, not just static stamp verification.

---

## Wave 2: Component Sweep + Hot-Loadable setParam

**Task ordering: Tasks 2.2–2.9 (component migration) run FIRST, in parallel. Task 2.10 (make setParam required) runs LAST, after all factories implement it.** Reversing this order breaks the build — the interface change makes every factory without setParam a type error.

### Task 2.2: Remaining semiconductors (12 files)

- **Description**: Migrate remaining semiconductor component files to use `modelRegistry` + `defineModelParams()` + the mutable-params-object `setParam` pattern. Each factory builds a `p` object from `props.getModelParam()` calls, reads from `p` in `stamp()`, and implements `setParam(key, value) { if (key in p) p[key] = value; }`.
- **Files to modify**:
  - `src/components/semiconductors/diode.ts`
  - `src/components/semiconductors/mosfet.ts`
  - `src/components/semiconductors/njfet.ts`
  - `src/components/semiconductors/pjfet.ts`
  - `src/components/semiconductors/zener.ts`
  - `src/components/semiconductors/schottky.ts`
  - `src/components/semiconductors/tunnel-diode.ts`
  - `src/components/semiconductors/scr.ts`
  - `src/components/semiconductors/diac.ts`
  - `src/components/semiconductors/triac.ts`
  - `src/components/semiconductors/triode.ts`
  - `src/components/semiconductors/varactor.ts`
- **Pattern**: Reference `src/components/semiconductors/bjt.ts` as the template. Each file:
  1. Add `defineModelParams()` call with all params (derive from factory's existing param reads)
  2. Add `modelRegistry` to component definition with `"behavioral"` entry
  3. Factory builds mutable `p` object: `const p = { IS: props.getModelParam<number>("IS"), ... }`
  4. `stamp()` reads from `p` (not from captured locals or `props.get()`)
  5. `setParam(key, value) { if (key in p) (p as Record<string, number>)[key] = value; }`
- **Tests**: Existing tests for each component must continue to pass. For each component, verify `setParam` exists on the compiled element.
- **Acceptance criteria**:
  - All 12 files have `modelRegistry` with at least one `"behavioral"` entry
  - All 12 factories implement `setParam`
  - `grep -rn "setParam" src/components/semiconductors/` returns one hit per factory function (12+ hits)
  - All existing semiconductor tests pass

### Task 2.3: Passives (11 files)

- **Description**: Same migration pattern for passive components. The resistor already has derived-value `setParam` (Pattern 1: raw param → derived value in closure, setParam recomputes derivation). Other passives follow Pattern 2 (direct-read mutable object) unless they pre-compute a derived value.
- **Files to modify**:
  - `src/components/passives/resistor.ts` — already has `setParam`; add `modelRegistry` + `defineModelParams()`
  - `src/components/passives/analog-fuse.ts`
  - `src/components/passives/capacitor.ts`
  - `src/components/passives/inductor.ts`
  - `src/components/passives/crystal.ts`
  - `src/components/passives/memristor.ts`
  - `src/components/passives/polarized-cap.ts`
  - `src/components/passives/potentiometer.ts`
  - `src/components/passives/tapped-transformer.ts`
  - `src/components/passives/transformer.ts`
  - `src/components/passives/transmission-line.ts`
- **Acceptance criteria**:
  - All 11 files have `modelRegistry`
  - All 11 factories implement `setParam`
  - All existing passive tests pass

### Task 2.4: Gates (7 files)

- **Description**: Migrate gate component files. Each gate retains `models.digital` for the event-driven engine. The `modelRegistry` contains a `"cmos"` entry with `kind: "netlist"` (netlist data absorbed from deleted `transistor-models/cmos-gates.ts`). Remove `subcircuitRefs` and `simulationModel` attribute maps.
- **Files to modify**:
  - `src/components/gates/and.ts`
  - `src/components/gates/or.ts`
  - `src/components/gates/nand.ts`
  - `src/components/gates/nor.ts`
  - `src/components/gates/xor.ts`
  - `src/components/gates/xnor.ts`
  - `src/components/gates/not.ts`
- **Acceptance criteria**:
  - All 7 files have `modelRegistry` with at least `"cmos"` entry
  - All 7 files retain `models.digital`
  - Zero references to `subcircuitRefs` in gate files
  - Zero references to `simulationModel` attribute maps in gate files
  - All existing gate tests pass

### Task 2.5: Flip-flops (7 files)

- **Description**: Same pattern as gates. `d.ts` absorbs CMOS D-flipflop netlist from deleted `transistor-models/cmos-flipflop.ts`.
- **Files to modify**:
  - `src/components/flipflops/d.ts`
  - `src/components/flipflops/d-async.ts`
  - `src/components/flipflops/jk.ts`
  - `src/components/flipflops/jk-async.ts`
  - `src/components/flipflops/rs.ts`
  - `src/components/flipflops/rs-async.ts`
  - `src/components/flipflops/t.ts`
- **Acceptance criteria**:
  - All 7 files have `modelRegistry`
  - `d.ts` has `"cmos"` entry with `kind: "netlist"`
  - All existing flip-flop tests pass

### Task 2.6: Active components (14 files)

- **Description**: Migrate active component files. Each gets `modelRegistry` with `"behavioral"` entry + `setParam`.
- **Files to modify**:
  - `src/components/active/adc.ts`
  - `src/components/active/analog-switch.ts`
  - `src/components/active/cccs.ts`
  - `src/components/active/ccvs.ts`
  - `src/components/active/comparator.ts`
  - `src/components/active/dac.ts`
  - `src/components/active/opamp.ts`
  - `src/components/active/optocoupler.ts`
  - `src/components/active/ota.ts`
  - `src/components/active/real-opamp.ts`
  - `src/components/active/schmitt-trigger.ts`
  - `src/components/active/timer-555.ts`
  - `src/components/active/vccs.ts`
  - `src/components/active/vcvs.ts`
- **Acceptance criteria**:
  - All 14 files have `modelRegistry` + `setParam`
  - All existing active component tests pass

### Task 2.7: Sources + sensors (7 files)

- **Description**: Migrate source and sensor files.
- **Files to modify**:
  - `src/components/sources/ac-voltage-source.ts`
  - `src/components/sources/current-source.ts`
  - `src/components/sources/dc-voltage-source.ts`
  - `src/components/sources/variable-rail.ts`
  - `src/components/sensors/ldr.ts`
  - `src/components/sensors/ntc-thermistor.ts`
  - `src/components/sensors/spark-gap.ts`
- **Acceptance criteria**:
  - All 7 files have `modelRegistry` + `setParam`
  - All existing tests pass

### Task 2.8: IO + memory (all .ts files in `src/components/io/` and `src/components/memory/`)

- **Description**: Migrate all IO and memory component files. There are ~25 files in `src/components/io/` and ~10 in `src/components/memory/` (not just the 10 listed in the old spec). The implementer must `ls src/components/io/*.ts src/components/memory/*.ts` and migrate EVERY non-test .ts file.
- **Files to modify**: every `.ts` file in `src/components/io/` and `src/components/memory/` that defines a component. Key files include but are NOT limited to:
  - `src/components/io/button-led.ts`, `clock.ts`, `ground.ts`, `led.ts`, `probe.ts`, `seven-seg-hex.ts`, `seven-seg.ts`
  - `src/components/memory/counter-preset.ts`, `counter.ts`, `register.ts`
  - Plus all other component files in those directories (analog-clock, bargraph, bit-indicator, button, dip-switch, in, out, port, rgb-led, rotary-encoder, speaker, stepper-motor, terminal, toggle-switch, vdd, etc.)
- **Acceptance criteria**:
  - `ls src/components/io/*.ts | grep -v __tests__ | wc -l` equals the count of files with `modelRegistry`
  - `ls src/components/memory/*.ts | grep -v __tests__ | wc -l` equals the count of files with `modelRegistry`
  - All existing tests pass

### Task 2.9: Switching + wiring (all .ts files in `src/components/switching/` and `src/components/wiring/`)

- **Description**: Migrate all switching and wiring component files. There are ~10 files in `src/components/switching/` and ~15 in `src/components/wiring/` (not just 12). The implementer must enumerate and migrate ALL.
- **Files to modify**: every `.ts` file in `src/components/switching/` and `src/components/wiring/` that defines a component. Key files include but are NOT limited to:
  - `src/components/switching/fuse.ts`, `relay-dt.ts`, `relay.ts`, `switch-dt.ts`, `switch.ts`
  - `src/components/wiring/bus-splitter.ts`, `decoder.ts`, `demux.ts`, `driver-inv.ts`, `driver.ts`, `mux.ts`, `splitter.ts`
  - Plus all other component files in those directories
- **Acceptance criteria**:
  - `ls src/components/switching/*.ts | grep -v __tests__ | wc -l` equals the count of files with `modelRegistry`
  - `ls src/components/wiring/*.ts | grep -v __tests__ | wc -l` equals the count of files with `modelRegistry`
  - All existing tests pass

### Task 2.10: Make `setParam` required on `AnalogElementCore`

- **Description**: Now that all factories implement `setParam` (Tasks 2.2–2.9), change the interface from optional to required. Add no-op to subcircuit composite elements.
- **Depends on**: Tasks 2.2–2.9 ALL complete. This task MUST be last in Wave 2.
- **Files to modify**:
  - `src/core/analog-types.ts` — line 122: change `setParam?(key: string, value: number): void` to `setParam(key: string, value: number): void`
  - `src/solver/analog/compiler.ts` — in `compileSubcircuitToMnaModel`, the composite element returned (line ~238) must implement `setParam`. Add: `setParam(_key: string, _value: number): void {}` (no-op — subcircuit composites don't have direct params)
- **Tests** (`src/core/__tests__/analog-types-setparam.test.ts` — new file):
  - `AnalogElementCore requires setParam` — TypeScript compilation test: an object literal missing `setParam` fails type check
  - `subcircuit composite element has setParam` — compile a subcircuit-backed model, verify `element.setParam` is a function
- **Acceptance criteria**:
  - `grep -n "setParam?" src/core/analog-types.ts` returns zero hits
  - `grep -n "setParam" src/core/analog-types.ts` returns exactly one hit (the required declaration)
  - `npm run test:q` passes (all factories already implement setParam — no type errors)

**POST-WAVE CHECK:** `npm run test:q` — full test suite must pass. Zero test failures. Verification:
- For each directory in `src/components/*/`: count of non-test .ts files equals count of files containing `modelRegistry`
- `grep -rn "setParam?" src/core/analog-types.ts` returns zero hits

---

## Wave 3: Runtime Features

**Note: Several Wave 3 tasks extend EXISTING partial implementations.** `circuit.metadata.models`, `modelParamDeltas` (DTS schema), `model-switch-command.ts`, and the model dropdown already exist in the codebase. `spice-model-apply.ts` has stub functions that throw `"pending reimplementation"`. These tasks complete/rewrite the existing code to use the new `modelRegistry` + `defineModelParams()` system from Wave 2. Implementers must read the existing code before starting — do not create duplicates.

### Task 3.1: Rewrite runtime model registry to use ModelEntry (T15)

- **Description**: `circuit.metadata.models` already exists on `CircuitMetadata` (`Record<string, Record<string, ModelEntry>>`). Rewrite `spice-model-apply.ts` to replace the `"pending reimplementation"` stubs with working code that creates `ModelEntry` objects from parsed `.MODEL`/`.SUBCKT` input and stores them in `circuit.metadata.models`.
- **Files to modify**:
  - `src/app/spice-model-apply.ts` — replace the two throwing stubs (`applySpiceImportResult`, `applySpiceSubcktImportResult`) with implementations that:
    - `.MODEL`: copy `factory` + `paramDefs` from the component's `modelRegistry["behavioral"]` entry, use parsed values as `params`
    - `.SUBCKT`: create `kind: "netlist"` entry with derived `paramDefs`
    - Store result in `circuit.metadata.models[componentType][modelName]`
- **Tests**: Headless API (create model entry, verify in registry), MCP tool (import via tool, verify), E2E (import dialog flow)
- **Acceptance criteria**:
  - `grep -rn "pending reimplementation" src/app/spice-model-apply.ts` returns zero hits
  - `.MODEL` imports produce `kind: "inline"` entries with factory from component's default
  - `.SUBCKT` imports produce `kind: "netlist"` entries
  - All three test surfaces pass

### Task 3.2: Migrate delta serialization to model param partition (T16)

- **Description**: `modelParamDeltas` already exists in the DTS schema. Rewrite the serializer/deserializer to use `PropertyBag.getModelParam()` / `replaceModelParams()` instead of the old `_spiceModelOverrides` path. Remove `namedParameterSets`, `modelDefinitions`, and `subcircuitBindings` from the DTS schema and serialization code.
- **Files to modify**:
  - `src/io/dts-schema.ts` — remove `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` fields from `DtsDocument`
  - `src/io/dts-serializer.ts` — serialize per-element model param deltas via `getModelParam()` comparison against `ModelEntry.params`; remove `namedParameterSets`/`modelDefinitions` serialization
  - `src/io/dts-deserializer.ts` — apply deltas via `replaceModelParams()` then overlay; CRASH (throw) if old-format fields `namedParameterSets`, `modelDefinitions`, or `subcircuitBindings` are present in the document
- **Tests**: Round-trip: save with overrides → load → same params. Crash test: old-format fields throw.
- **Acceptance criteria**:
  - `grep -rn "namedParameterSets" src/io/` returns zero hits
  - `grep -rn "modelDefinitions" src/io/` returns zero hits (as a serialized field — type references in migration code are acceptable)
  - `grep -rn "subcircuitBindings" src/io/` returns zero hits
  - Old-format documents throw on deserialize

### Task 3.3: Wire ModelSwitchCommand to new model system (T17)

- **Description**: `model-switch-command.ts` already exists. Update it to use `replaceModelParams()` from the new PropertyBag partition instead of writing `_spiceModelOverrides`. Wire the property panel dropdown to trigger it.
- **Files to modify**:
  - `src/editor/model-switch-command.ts` — update to use `replaceModelParams(newModelEntry.params)` in `execute()` and `replaceModelParams(oldParamSnapshot)` in `undo()`
  - `src/editor/property-panel.ts` — trigger `ModelSwitchCommand` from model dropdown change
- **Tests**: Unit test (execute/undo/redo preserves params), E2E (switch, undo, verify panel)
- **Acceptance criteria**:
  - `grep -rn "_spiceModelOverrides" src/editor/model-switch-command.ts` returns zero hits
  - Undo/redo round-trips model params correctly

### Task 3.4: Unified import dialog (T18)

- **Description**: Consolidate `.MODEL` and `.SUBCKT` import into a single dialog with auto-detect. `spice-subckt-dialog.ts` has already been deleted — this task adds `.SUBCKT` auto-detect to the existing `spice-import-dialog.ts`.
- **Files to modify**:
  - `src/app/spice-import-dialog.ts` — add auto-detect: if input starts with `.SUBCKT` → parse as subcircuit, else → parse as `.MODEL`. Single "Import Model..." button.
  - `src/app/canvas-popup.ts` — single "Import Model" button replacing any old split buttons
- **Tests**: Headless (auto-detect both formats), MCP (import via tool), E2E (dialog flow)
- **Acceptance criteria**:
  - Single dialog handles both `.MODEL` and `.SUBCKT` formats
  - `grep -rn "spice-subckt-dialog" src/` returns zero hits

### Task 3.5: Model dropdown from modelRegistry (T19)

- **Description**: The property panel model dropdown partially exists. Rewrite to read from `modelRegistry` keys + `"digital"` (if `models.digital` exists) + runtime entries from `circuit.metadata.models`.
- **Files to modify**:
  - `src/editor/property-panel.ts` — dropdown source: `Object.keys(def.modelRegistry)` + `"digital"` check + `circuit.metadata.models[el.typeId]` keys. Remove old `availableModels()` calls.
  - `src/app/canvas-popup.ts` — wire dropdown selection to `ModelSwitchCommand`
- **Tests**: Headless (dropdown lists correct entries), E2E (dropdown shows expected entries after import)
- **Acceptance criteria**:
  - `grep -rn "availableModels" src/editor/property-panel.ts` returns zero hits
  - Dropdown shows static + runtime model entries
  - Selection triggers `ModelSwitchCommand`

**POST-WAVE CHECK:** `npm run test:q` — all pass. E2E: import `.MODEL` → save → reload → verify params persist. `grep -rn "pending reimplementation" src/` returns zero hits.

---

## Wave 4: Verification + Test Audit

### Task 4.1: Zero-occurrence verification (T20)

- **Description**: Run grep for every symbol in the unified-model-params verification conditions list. Zero hits required.
- **Verification protocol**:
  ```
  For each symbol below, run: grep -rn "SYMBOL" src/ e2e/ scripts/
  Zero hits required unless noted.
  ```
  - `_spiceModelOverrides` — zero
  - `_modelParams` — zero
  - `_spiceModelName` — zero
  - `namedParameterSets` — zero (Wave 3 Task 3.2 removes from DTS schema; verify no references remain anywhere)
  - `modelDefinitions` — zero (Wave 3 Task 3.2 removes from DTS schema; verify no references remain anywhere)
  - `subcircuitBindings` — zero
  - `simulationModel` (as a property key string) — zero
  - `SubcircuitModelRegistry` — zero
  - `ModelLibrary` (import or reference) — zero
  - `DeviceType` (outside `src/solver/analog/model-parser.ts`) — zero
  - `models.mnaModels` — zero
  - `ComponentDefinition.subcircuitRefs` — zero
  - `getActiveModelKey` — zero
  - `availableModels` (function name from registry) — zero (live in `src/headless/netlist.ts` and `netlist-types.ts` — Wave 3 Task 3.5 must replace with `Object.keys(modelRegistry)` before this check passes)
  - `modelKeyToDomain` — zero
  - `model-param-meta` (import path) — zero
  - `model-library` (import path) — zero (live in `src/app/spice-model-library-dialog.ts` — Wave 3 must remove ModelLibrary usage; the dialog uses `circuit.metadata.models` directly)
  - `subcircuit-model-registry` (import path) — zero
  - `default-models` (import path) — zero
  - `transistor-expansion` (import path) — zero
  - `transistor-models` (import path) — zero
  - `spice-subckt-dialog` (import path) — zero
- **Additional verification (bridge architecture)**:
  - `grep -rn "Norton" src/solver/analog/bridge-adapter.ts` — zero hits
  - `grep -rn "Norton" src/solver/analog/digital-pin-model.ts` — zero hits
  - `grep -rn "isNonlinear.*true" src/solver/analog/bridge-adapter.ts` — zero hits (bridge is linear)
  - `grep -rn "branchIndex.*=.*-1" src/solver/analog/bridge-adapter.ts` — zero hits for BridgeOutputAdapter (it uses a branch variable). BridgeInputAdapter still has `branchIndex = -1` (no branch).
  - `grep -rn "setParam?" src/core/analog-types.ts` — zero hits (setParam is required)
  - `grep -rn "stampNonlinear" src/solver/analog/bridge-adapter.ts` — zero hits (bridge is linear, no NR re-stamp)
  - `grep -rn "_thresholdVoltage" src/solver/coordinator.ts` — zero hits (threshold logic moved to BridgeInputAdapter)
- **Behavioral verification (anti-cheat — these verify INTENT, not just PRESENCE)**:
  - **setParam actually works (not a no-op):**
    - For EVERY component factory that has `paramDefs.length > 0`: compile with default params → call `setParam(firstParamKey, differentValue)` → re-stamp → verify at least one matrix entry changed. A no-op setParam fails this.
    - Count: `grep -rn "setParam(" src/components/ --include="*.ts" | grep -v test | grep -v "\.d\.ts"` hit count MUST equal `grep -rn "factory(" src/components/ --include="*.ts" | grep -v test | grep -v "\.d\.ts"` hit count (one setParam per factory).
  - **Factories read from mutable object, not captured locals:**
    - For BJT, diode, mosfet (spot-check 3 semiconductors): compile → `setParam("BF"|"IS"|"VTO", newValue)` → step simulation → verify output voltage/current changed. If stamp() reads captured locals instead of the mutable params object, the output is unchanged.
  - **Bridge output is truly an ideal voltage source:**
    - `grep -rn "stampRHS" src/solver/analog/digital-pin-model.ts` — count hits. An ideal V source stamps RHS on the BRANCH row only (`z[branchRow] = V_target`). A Norton stamps RHS on the NODE row (`z[nodeRow] = V*G`). Verify all `stampRHS` calls use the branch index, not the node index.
    - Compile a bridge → read branch current from solution vector → verify `I_branch` is defined (branch variable exists and carries current). Norton has no branch variable.
  - **modelRegistry is not empty:**
    - For EVERY component file in `src/components/`: `modelRegistry` object has at least one key with a non-null `factory` property. Verify: count of `grep -rn "factory:" src/components/ --include="*.ts" | grep -v test` ≥ 80.
  - **Domain injection works for per-net overrides (not just "all" mode):**
    - Test: circuit in `"cross-domain"` mode with one per-net `"loaded"` override on a digital-only net → that net gains `"analog"` in its domains → bridge created for that net → analog partition compiled for it. This is covered by Task 1.4 test 4 but call it out here as a mandatory verification.
  - **Ground synthesis produces a solvable matrix:**
    - Test: pure-digital circuit in `"all"` mode → compile → step analog engine → all node voltages are finite (not NaN). If ground synthesis is fake (diagnostic suppressed but no real ground), the MNA solve produces NaN.
  - **Unloaded bridge input stamps ZERO matrix entries:**
    - Test: create `BridgeInputAdapter` with `loaded: false` → call `stamp(solver)` → verify solver received exactly zero `stamp()` calls and zero `stampRHS()` calls. Not "stamps rIn=∞" (which is 1/∞ = 0 conductance, still a call) — literally zero calls.
  - **Test fixture deduplication is real (not name-dodge):**
    - `grep -rn "extends AbstractCircuitElement" src/ --include="*.test.ts" | wc -l` — must be ≤ 5 (allow a few genuinely test-specific subclasses like ControlledSource tests). Was 40+ before cleanup.
- **Acceptance criteria**:
  - Every grep above returns the specified count
  - Every behavioral test above passes
  - Any remaining references or failures are bugs — fix before closing

### Task 4.2: Test audit cleanup — broken imports

- **Description**: Fix 4 test files importing from deleted `model-defaults.ts`. These are currently broken.
- **Files to fix**:
  - `src/headless/__tests__/spice-model-overrides-mcp.test.ts` — imports `BJT_NPN_DEFAULTS` from deleted `model-defaults.js`
  - `src/components/semiconductors/__tests__/mosfet.test.ts` — imports `MOSFET_NMOS_DEFAULTS` from deleted `model-defaults.js`
  - `src/solver/analog/__tests__/spice-model-overrides.test.ts` — imports `BJT_NPN_DEFAULTS, TUNNEL_DIODE_DEFAULTS, DIODE_DEFAULTS, SCHOTTKY_DEFAULTS, ZENER_DEFAULTS` from deleted `model-defaults.js`
  - `src/solver/analog/__tests__/spice-import-dialog.test.ts` — imports `BJT_NPN_DEFAULTS` from deleted `model-defaults.js`
- **Action**: Update imports to use `defineModelParams()` exports from the migrated component files (Wave 2) or from `src/test-fixtures/model-fixtures.ts`
- **Acceptance criteria**:
  - `grep -rn "model-defaults" src/` returns zero hits
  - All 4 test files compile and pass

### Task 4.3: Test audit cleanup — centralize shared fixtures

- **Description**: The audit found 56 inline stub element classes and 40+ inline registry builders (~1,100 lines of duplicated boilerplate) across 35 test files. Centralize the high-value patterns.
- **Files to create**:
  - `src/test-fixtures/test-element.ts` — shared `TestElement extends AbstractCircuitElement` with configurable type, pins, and properties. Replaces ~40 identical inline class definitions.
  - `src/test-fixtures/registry-builders.ts` — shared `buildDigitalRegistry()`, `buildMixedRegistry()`, `buildAnalogRegistry()` functions with configurable component lists. Replaces ~40 inline `buildRegistry`/`makeRegistry` functions (~600 lines).
  - `src/test-fixtures/execute-stubs.ts` — shared noop execute functions: `noopExecFn`, `executePassThrough`, `executeAnd2`. Replaces redefinitions across many files.
  - `src/test-fixtures/subcircuit-elements.ts` — shared `TestLeafElement` + `TestSubcircuitElement` pair for flatten tests. Replaces 3 duplicate pairs.
- **Files to modify**: All 35 test files identified in the audit. Each file:
  1. Remove inline `TestElement`/`StubElement`/`MockElement` class definition
  2. Import shared `TestElement` from `src/test-fixtures/test-element.ts`
  3. Remove inline `buildRegistry`/`makeRegistry` function
  4. Import shared builder from `src/test-fixtures/registry-builders.ts`
  5. Remove inline noop execute functions
  6. Import from `src/test-fixtures/execute-stubs.ts`
- **Acceptance criteria**:
  - `src/test-fixtures/` contains at least 4 shared fixture files
  - `grep -rn "class TestElement extends" src/ --include="*.test.ts"` returns zero hits (all definitions moved to fixtures)
  - `grep -rn "class StubElement extends" src/ --include="*.test.ts"` returns zero hits
  - `grep -rn "class MockElement extends" src/ --include="*.test.ts"` returns zero hits (except where the mock has genuinely test-specific behavior)
  - `npm run test:q` passes with zero failures

### Task 4.4: E2E test updates (T21)

- **Description**: Update E2E tests across all three surfaces for the new architecture.
- **Tests to update/add**:
  - Unified import dialog (headless + MCP + E2E)
  - Model dropdown with runtime entries (E2E)
  - Model switch in property panel (E2E)
  - Delta serialization round-trip (headless + MCP + E2E)
  - Bridge behavior in all three modes (headless + MCP + E2E)
  - Hot-loading pin electrical params via setParam (headless)
  - Hot-loading model params via setParam (headless)
- **Acceptance criteria**:
  - Every user-facing feature tested across headless API, MCP tool, and E2E surfaces
  - All E2E tests pass

**POST-WAVE CHECK:** `npm run test:q` — zero failures. Full E2E suite passes. All grep verification conditions satisfied.
