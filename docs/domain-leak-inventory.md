# Domain Leak Inventory — Digital Assumptions in Mixed-Mode Interfaces

Audit date: 2026-04-02

The netlist data model was designed for digital circuits and has **no domain concept**. Every pin unconditionally carries `pinDirection` and `bitWidth`, every net carries `inferredWidth`. These are meaningless for analog but always populated with digital defaults. Partial fixes have been applied to component-level pin summaries in `formatNetlist` and `formatComponentDefinition`, but the net-level output, all diagnostics, builder validation, and several tool paths remain unfixed.

## Root Cause

`NetPin` and `PinDescriptor` have no domain discriminator. Every formatter must independently re-derive "is this analog?" from the model registry, which is fragile and incomplete. The structural fix is to add a `domain` field to `NetPin`/`PinDescriptor`, populated from the component's **active model** (not available models — most components have both digital and analog models) in `makeNetPin`, then use it everywhere to suppress digital-specific formatting and diagnostics for analog pins/nets.

**Critical:** Domain must be determined from the active/selected model, not from `availableModels`. A component with both `"digital"` and `"behavioral"` models is digital when running in digital mode and analog when running in analog mode. Checking `availableModels.includes("analog")` is wrong — it must check which model is actually in use for the current compilation.

## Findings

### 1. `formatNetlist` — Net-level pins always show `[N-bit, DIRECTION]`

- **File:** `scripts/mcp/formatters.ts:72`
- **What it says:** `R1:A [1-bit, INPUT]` for every pin on every net
- **Why it's wrong:** Analog terminals aren't directional or bit-sized. Component-level summary was fixed to show `[terminal]` for analog-only components, but the net section was not.
- **Who sees it:** Agent via MCP (`circuit_netlist`)

### 2. `formatNetlist` — Net header shows `N-bit` for analog nets

- **File:** `scripts/mcp/formatters.ts:69`
- **What it says:** `Net #3 [1-bit, 2 pins]:`
- **Why it's wrong:** Analog nets carrying continuous voltage/current don't have a "bit width."
- **Fix:** Omit the width entirely for analog-domain nets. Net-level code currently has no domain info per pin — requires the structural fix (domain field on `NetPin`) or a component lookup per pin via `componentLabel`.
- **Who sees it:** Agent via MCP (`circuit_netlist`)

### 3. `formatDiagnostics` — Pin annotations always show `[N-bit, DIRECTION]`

- **File:** `scripts/mcp/formatters.ts:20`
- **What it says:** `-> Pins: R1:A [1-bit, INPUT], R1:B [1-bit, OUTPUT]`
- **Why it's wrong:** Any diagnostic involving analog pins shows nonsensical bit-width and direction metadata. No analog-awareness check exists.
- **Who sees it:** Agent via MCP (multiple tools)

### 4. `formatComponentDefinition` — Analog pins show `[terminal, INPUT]`

- **File:** `scripts/mcp/formatters.ts:144`
- **What it says:** `A [terminal, INPUT]`, `B [terminal, OUTPUT]`
- **Why it's wrong:** The "terminal" correctly replaces bit-width, but `pin.direction` is still appended. A resistor's terminals are not directional. Should just be `[terminal]`.
- **Who sees it:** Agent via MCP (`circuit_describe`)

### 5. `netlist.ts` — `multi-driver-no-tristate` fires for analog nets

- **File:** `src/headless/netlist.ts:329`
- **What it says:** `WARNING multi-driver-no-tristate: Net 5 has 2 output drivers...`
- **Why it's wrong:** Analog nodes naturally have multiple connections summing currents. This warning is pure noise for analog nets.
- **Fix:** Suppress when all pins on the net belong to analog-domain components. Multi-domain nets (analog + digital pins) are analog — the digital portion is behind a bridge.
- **Who sees it:** Agent via MCP (`circuit_netlist`, `circuit_validate`, `circuit_patch`, `circuit_build`)

### 6. `netlist.ts` — `unconnected-input` fires for analog terminals

- **File:** `src/headless/netlist.ts:311`
- **What it says:** `WARNING unconnected-input: Unconnected input pin "A" on component "R1" (Resistor)`
- **Why it's wrong:** A floating resistor terminal is not an "unconnected input pin" — it's an open terminal.
- **Fix:** For analog components, change message to "Component pin floating" (no direction language, no "connect to signal source" suggestion).
- **Who sees it:** Agent via MCP (`circuit_netlist`, `circuit_validate`, `circuit_patch`, `circuit_build`)

### 7. `netlist.ts` — Width-mismatch diagnostic uses `[N-bit]` for analog pins

- **File:** `src/headless/netlist.ts:271`
- **What it says:** `ERROR width-mismatch: Bit-width mismatch: R1:A [1-bit] <-> gate:out [8-bit]`
- **Why it's wrong:** Analog pins are always 1-bit (the only valid value). When an analog pin connects to a multi-bit digital bus, the real issue is a domain boundary, not a width mismatch.
- **Fix:** Change message to "Analog pin connected to multi-bit digital bus — split bus before it joins analog nets." Suppress width-mismatch entirely when both sides are analog (both will be 1-bit).
- **Who sees it:** Agent via MCP (all diagnostic-surfacing tools)

### 8. `netlist.ts` — `makeNetPin` always populates `pinDirection` and `declaredWidth`

- **File:** `src/headless/netlist.ts:228`
- **What it says:** Every `NetPin` struct carries `pinDirection: "INPUT"` and `declaredWidth: 1` for analog terminals.
- **Why it's wrong:** This is the data layer root cause. Because NetPin always carries these fields with digital-default values, every downstream consumer emits nonsense for analog unless it special-cases.
- **Who sees it:** All downstream consumers (formatters, diagnostics, type consumers)

### 9. `netlist-types.ts` — `NetPin.pinDirection` and `NetPin.declaredWidth` are unconditional

- **File:** `src/headless/netlist-types.ts:60-66`
- **What it says:** These fields are mandatory on every `NetPin`.
- **Why it's wrong:** Typed consumers are forced to handle meaningless fields for analog. Should be optional or carry a domain discriminator.
- **Who sees it:** Developers consuming the types, indirectly all tool users

### 10. `netlist-types.ts` — `PinDescriptor.direction` and `PinDescriptor.bitWidth` are unconditional

- **File:** `src/headless/netlist-types.ts:100-103`
- **What it says:** Every `PinDescriptor` has `direction` and `bitWidth`.
- **Why it's wrong:** A `PinDescriptor` for a resistor terminal says `direction: "INPUT", bitWidth: 1`. The type gives no signal that these fields are meaningless for analog.
- **Who sees it:** Developers and all consumers of `ComponentDescriptor.pins`

### 11. `netlist-types.ts` — `NetDescriptor.inferredWidth` is digital-only concept

- **File:** `src/headless/netlist-types.ts:39-41`
- **What it says:** Every net has an `inferredWidth`.
- **Why it's wrong:** For analog nets, always 1 (the meaningless default). The null case means "pins disagree on width" but for mixed-signal nets the disagreement is a domain mismatch, not a width mismatch.
- **Who sees it:** Developers and all consumers of `NetDescriptor`

### 12. `builder.ts` — `connect()` validates bit width for analog connections

- **File:** `src/headless/builder.ts:280`
- **What it says:** `Bit width mismatch on connection "R1:A" [1-bit] -> "bus:out" [8-bit]`
- **Why it's wrong:** Direction validation was fixed to skip for analog, but bit-width validation was not. Connecting an analog terminal to a multi-bit digital bus throws a misleading error.
- **Who sees it:** Agent via MCP (`circuit_build`, `circuit_patch` connect ops)

### 13. `circuit-tools.ts` — `circuit_describe_file` always shows `[N-bit]` and `inputs/outputs`

- **File:** `scripts/mcp/circuit-tools.ts:274`
- **What it says:** `Pins: 2 (1 inputs, 1 outputs)` with `A [1-bit]` and `B [1-bit]`
- **Why it's wrong:** For .dig files containing analog components, pins are partitioned into "inputs" and "outputs" with bit-width annotations. A resistor subcircuit would show `1 inputs, 1 outputs` which is nonsense.
- **Who sees it:** Agent via MCP (`circuit_describe_file`)

### 14. `circuit-tools.ts` — `circuit_list` arrow notation for analog pins

- **File:** `scripts/mcp/circuit-tools.ts:361`
- **What it says:** `Resistor (A↓ B↑)`
- **Why it's wrong:** Directional arrows on passive two-terminal device pins imply signal flow that doesn't exist. No analog-awareness in this code path.
- **Who sees it:** Agent via MCP (`circuit_list` with `include_pins=true`)

### 15. `circuit-tools.ts` — `circuit_test` driver analysis uses digital direction semantics

- **File:** `scripts/mcp/circuit-tools.ts:729`
- **What it says:** Traces failing output drivers by walking INPUT/OUTPUT pin directions.
- **Why it's wrong:** Analog components in the driver chain would be misidentified — their "INPUT" terminal might actually be the driving node depending on circuit topology. Driver-chain tracing is a digital-only debugging aid (one-hop: "output X is wrong → what feeds it?" by walking INPUT/OUTPUT directions). For analog there's no directional signal flow to trace.
- **Fix:** Skip driver analysis entirely when the circuit contains analog components, or limit it to the digital portion of mixed circuits.
- **Who sees it:** Agent via MCP (`circuit_test` on failing vectors)

### 16. `postmessage-adapter.ts` — `sim-test` only recognizes In/Out/Clock/Port

- **File:** `src/io/postmessage-adapter.ts:462`
- **What it says:** Only `In`, `Clock`, `Port`, and `Out` components are recognized as test-vector signals.
- **Why it's wrong:** Analog voltage sources and probes with labels are not recognized, causing "Test signals not found in circuit" errors. The error message says "Make sure your In/Out components have labels" — purely digital framing.
- **Fix:** For mixed/analog circuits, also recognize analog source typeIds as test inputs and probe typeIds as test outputs so the column partition works. The flow is: set analog node values through the engine, sim for a time, then read node signals from the engine. Enumerate the relevant analog typeIds from the component registry.
- **Investigation needed:** The entire `runTests` pipeline is likely insufficient for analog signals — the test vector format assumes discrete digital values, and the execution model (step + compare) doesn't account for transient settling, voltage tolerances, or continuous-domain assertions. Needs deeper investigation into what an analog/mixed test process would actually look like before implementing.
- **Who sees it:** Parent frame via postMessage (`sim-test`)

### 17. `netlist-types.ts` — Doc comment uses digital-only example

- **File:** `src/headless/netlist-types.ts:7-8`
- **What it says:** `If the netlist shows sysreg:ADD [1-bit], the edit is { op: 'set', target: 'ADD', props: { Bits: 16 } }`
- **Why it's wrong:** Sets a digital-only mental model for anyone reading the types. Minor.
- **Who sees it:** Developers reading the types

### 18. `circuit_describe_file` description frames pin discovery as digital-only

- **File:** `scripts/mcp/circuit-tools.ts:250-253`
- **What it says:** `"Lightweight scan of a .dig file to extract its external pin interface (In/Out components with labels, bit widths, and directions)"`
- **Why it's wrong:** Frames the tool as discovering only `In`/`Out` components with `bit widths` and `directions`. An analog subcircuit with voltage source/probe terminals would not be discovered. The scanner (`dig-pin-scanner.ts:49`) literally only looks for `In` and `Out` XML elements.
- **Fix:** Update description to honestly state the limitation: "Scans for digital In/Out pin interfaces. Does not discover analog source/probe terminals — use `circuit_load` + `circuit_netlist` for full analog interface discovery." Extending the scanner to find analog interface components is a separate, larger task.
- **Who sees it:** Agent via MCP (`circuit_describe_file`)

### 19. `circuit_describe_file` empty-result message assumes digital framing

- **File:** `scripts/mcp/circuit-tools.ts:266-269`
- **What it says:** `No In/Out pins found in "${filePath}". The file may be a top-level circuit (not a subcircuit) or contain no I/O components.`
- **Why it's wrong:** An analog circuit with voltage sources and probes (but no `In`/`Out` elements) would get this message, implying the circuit has no interface when it actually does, just not a digital one.
- **Fix:** Change message to: `No digital In/Out pins found in "${filePath}". If this is an analog circuit, use circuit_load + circuit_netlist to discover source/probe terminals.`
- **Who sees it:** Agent via MCP (`circuit_describe_file`)

### 20. `circuit_test` description says "Digital test format"

- **File:** `scripts/mcp/circuit-tools.ts:641, 650`
- **What it says:** `"Compile the circuit and run test vectors. If testData is provided, it is used as the test vector source (Digital test format)."` and `"Optional test vector string in Digital test format."`
- **Why it's wrong:** "Digital test format" is the name of the upstream tool this project forked from, not a description of the format being digital-only. But agents reading this will reasonably conclude test vectors are only for digital circuits.
- **Who sees it:** Agent via MCP (`circuit_test`)

### 21. `circuit_patch` examples are exclusively digital

- **File:** `scripts/mcp/circuit-tools.ts:404-410`
- **What it says:** `"{op:'set', target:'gate1', props:{bitWidth:16}}"`, `"{op:'add', spec:{id:'g2',type:'And'}, connect:{A:'in1:out'}}"` etc.
- **Why it's wrong:** Every example uses digital component types (`And`) and digital properties (`bitWidth`). An agent working with an analog circuit gets no hint of how to patch analog components (e.g. `{op:'set', target:'R1', props:{resistance:10000}}`).
- **Who sees it:** Agent via MCP (`circuit_patch`)

### 22. `circuit_compile` output only suggests digital-style tools

- **File:** `scripts/mcp/circuit-tools.ts:612`
- **What it says:** `"Engine stored. Use circuit_step, circuit_set_input, circuit_read_output for interactive simulation."`
- **Why it's wrong:** For analog/mixed circuits, the more useful next steps are `circuit_dc_op` and `circuit_ac_sweep`. The guidance points exclusively toward digital-style step-by-step simulation.
- **Fix:** After compile, check `coordinator.supportsDcOp()` / `coordinator.supportsAcSweep()` (both return `this._analog !== null`). When true, append analog tool suggestions: "For analog analysis: circuit_dc_op, circuit_ac_sweep."
- **Who sees it:** Agent via MCP (`circuit_compile`)

### 23. `circuit_list` category examples are all digital

- **File:** `scripts/mcp/circuit-tools.ts:323`
- **What it says:** `'Optional category filter, e.g. "LOGIC", "IO", "MEMORY", "WIRING"'`
- **Why it's wrong:** No analog category examples (e.g. `"ANALOG"`, `"PASSIVE"`) are shown. An agent discovering the component palette would not know analog components exist from this description.
- **Who sees it:** Agent via MCP (`circuit_list`)

### 24. `formatComponentDefinition` scaling-pin detection only probes `bitWidth`

- **File:** `scripts/mcp/formatters.ts:119-136`
- **What it says:** Tests whether pins scale with `bitWidth` by instantiating at `bitWidth=16` and checking `pin.bitWidth === testWidth`.
- **Why it's wrong:** Meaningless for analog components (which don't have a `bitWidth` property). Analog component definitions never get any scaling annotation, even if they have equivalent scaling behavior for analog parameters.
- **Who sees it:** Agent via MCP (`circuit_describe`)

### 25. `setInput` / `readOutput` method names use digital framing

- **File:** `src/headless/default-facade.ts:162, 176`
- **What it says:** Method names `setInput` and `readOutput`.
- **Why it's wrong:** For analog circuits, you set a voltage on a source or read a voltage at a probe node. The names carry digital directionality that doesn't map to analog. The implementation correctly handles both domains, but the interface name misleads.
- **Who sees it:** Developers consuming the facade interface; indirectly all tool/postMessage users (the MCP tool names `circuit_set_input` / `circuit_read_output` mirror these)
- **Breaking change:** Yes — facade method + MCP tool name + postMessage wire protocol (`sim-set-input` / `sim-read-output`)
- **Fix:** Rename to `setSignal`/`readSignal` across all three surfaces: facade methods, MCP tools (`circuit_set_signal`/`circuit_read_signal`), and postMessage (`sim-set-signal`/`sim-read-signal`). Hard cut — old names are removed, not aliased.

### 26. `step()` JSDoc only describes digital behavior

- **File:** `src/headless/default-facade.ts:119-123`
- **What it says:** `"For digital circuits, clocks are advanced before the step by default."`
- **Why it's wrong:** Gives no guidance on what `step()` means in the analog context (advances the transient solver by a timestep). Missing analog documentation.
- **Who sees it:** Developers reading the facade

### 27. `runTests` error frames analog test limitation as inherent impossibility

- **File:** `src/headless/default-facade.ts:243-245`
- **What it says:** `"Test execution requires a digital engine. Analog-only circuits cannot run test vectors."`
- **Why it's wrong:** Presents a current limitation as an inherent constraint. Should say "Test vectors are not yet supported for analog-only circuits" to avoid implying it's fundamentally impossible.
- **Who sees it:** Agent via MCP (`circuit_test`), developers

### 28. `runTests` input detection only checks `In`/`Clock`/`Port`

- **File:** `src/headless/default-facade.ts:215-219`
- **What it says:** `if (el.typeId === 'In' || el.typeId === 'Clock' || el.typeId === 'Port')`
- **Why it's wrong:** Analog voltage sources with labels are excluded from the input-count heuristic. Could cause the header parser to mispartition input/output columns when a mixed circuit has both digital In components and analog sources.
- **Fix:** Same approach as #16 — also recognize analog source typeIds as inputs for the column partition heuristic. Enumerate the relevant analog typeIds from the component registry.
- **Investigation needed:** Same as #16 — the `runTests` pipeline is likely insufficient for analog signals. The column partition fix is straightforward, but the underlying test execution model needs rethinking for analog/mixed circuits.
- **Who sees it:** Agent via MCP (`circuit_test` on mixed circuits)

### 29. `validatePinConnection` uses over-broad analog detection heuristic

- **File:** `src/headless/builder.ts:851-854`
- **What it says:** `const srcHasAnalog = srcDef?.modelRegistry != null && Object.keys(srcDef.modelRegistry).length > 0;`
- **Why it's wrong:** The heuristic is semantically opaque — `modelRegistry` entries are in fact always analog/MNA models (keys like `"behavioral"`, `"analog"`), so the check is correct in practice. But it reads as "has any model" rather than "has analog model," and would break if a digital-only entry were ever added to `modelRegistry`. Should use an explicit check like `availableModels.includes('analog') || availableModels.includes('behavioral')` or a helper that mirrors the formatter logic.
- **Who sees it:** Developers; indirectly agents (validation behavior)

### 30. Non-convergence error advises about "cross-coupled latches"

- **File:** `src/io/postmessage-adapter.ts:502-506`
- **What it says:** `"Circuit has a feedback loop that could not settle. Check your wiring -- a cross-coupled latch needs exactly two feedback paths."`
- **Why it's wrong:** Fires for any oscillation/non-convergence, including analog circuits. An analog RC circuit that doesn't converge gets advice about "cross-coupled latches" — purely digital-logic framing.
- **Fix:** For analog/mixed circuits, change message to "Circuit did not converge within iteration limit." Keep the digital-specific "cross-coupled latch" wording only for pure-digital circuits.
- **Who sees it:** Parent frame via postMessage (`sim-test`)

### 31. Wire protocol names `sim-set-input` / `sim-read-output` carry digital directionality

- **File:** `src/io/postmessage-adapter.ts:239, 246`
- **What it says:** Message types `sim-set-input` and `sim-read-output`.
- **Why it's wrong:** Same issue as #25 at the wire protocol level. For analog circuits, any node can be observed and sources aren't necessarily "inputs."
- **Who sees it:** Parent frame via postMessage
- **Breaking change:** Yes — wire protocol contract shared with parent frame
- **Fix:** Part of #25 rename. New wire protocol names: `sim-set-signal` / `sim-read-signal`. Hard cut — old names are removed, not aliased.

### 32. `testEquivalence` silently returns vacuous "equivalent" for analog circuits

- **File:** `src/headless/equivalence.ts:42-49`
- **What it says:** Only discovers `In`/`Clock`/`Out` components. If none found, tests 1 combination and reports "equivalent."
- **Why it's wrong:** Two completely different analog circuits with zero `In`/`Out` components would silently be declared equivalent. Should throw or return an explicit error when both circuits have zero discovered I/O.
- **Who sees it:** Agent via MCP (`circuit_test_equivalence`)

### 33. `connect()` JSDoc promises output→input validation as universal

- **File:** `src/headless/facade.ts:56`
- **What it says:** `"Validates pin labels exist, directions are compatible (output->input or bidirectional), and bit widths match."`
- **Why it's wrong:** For analog connections, direction validation is correctly skipped, but the interface contract still promises output→input validation as universal behavior. Misleads anyone reading the interface.
- **Who sees it:** Developers consuming the `SimulatorFacade` interface

### 34. `setInput` / `readOutput` JSDoc claims type checking that doesn't exist

- **File:** `src/headless/facade.ts:133-143`
- **What it says:** `"Drive an input pin to a specific value"`, `"@throws FacadeError if label not found or is not an input component"` / `"Read the current value of an output pin"`, `"@throws FacadeError if label not found or is not an output component"`
- **Why it's wrong:** The implementation does NOT validate that the label belongs to an "input" or "output" component — it reads/writes any labeled signal. The JSDoc promises a constraint that doesn't exist and reinforces digital directionality.
- **Who sees it:** Developers consuming the `SimulatorFacade` interface

### 35. `formatNetlist` checks `availableModels` instead of active model

- **File:** `scripts/mcp/formatters.ts:36-38, 57-59`
- **What it says:** `isAnalogOnly` is derived from `comp.availableModels.includes("analog") && !comp.availableModels.includes("digital")`. The model tag shows `[mixed]` when both models are available.
- **Why it's wrong:** Most components have both digital and analog models. Checking available models instead of the active model means: (1) `isAnalogOnly` is almost never true (only for components with no digital model at all), so most analog components still show `[N-bit, DIRECTION]` pin formatting; (2) the `[mixed]` tag describes capability, not current state — a component running in digital mode shows `[mixed]` which is misleading. Must check `comp.activeModel` instead.
- **Who sees it:** Agent via MCP (`circuit_netlist`)

### 36. `runToStable` is a digital-only concept used as universal "reach steady state"

- **File:** `src/headless/default-facade.ts:143-160` (definition), `src/headless/facade.ts` (interface)
- **What it does:** Loops `step()` taking signal snapshots before/after each step, stops when all signals are identical by exact Float64 equality.
- **Why it's wrong:** This is a digital combinational propagation settler — it makes sense for logic gates rippling to a fixed point. For analog, each `step()` advances simulated time via the transient solver. Consecutive steps produce different voltages because the circuit is integrating through time (e.g., an RC circuit charging: 4.2V → 4.6V → 4.8V...). It will either never converge (voltages keep changing as the circuit approaches steady state) or converge accidentally on a floating-point coincidence. The UI simulation path never uses `runToStable` — it uses `step()` / `stepToTime()`, which is the correct mixed-mode coordination.
- **Callers:** `src/testing/executor.ts`, `src/testing/comparison.ts`, `src/testing/run-all.ts`, `src/headless/equivalence.ts`, `src/headless/builder.ts`, `src/analysis/model-analyser.ts`, `scripts/verify-fixes.ts` — 7 production callers, all using it as "set stuff then find steady state."
- **Fix:** For mixed/analog circuits, replace all `runToStable` calls with `stepToTime(currentTime + settleTime)` — the same coordination path the UI uses. `stepToTime` already handles mixed-mode bridge sync per step. For pure-digital circuits, `runToStable` remains correct. The `SimulatorFacade` interface should expose a single settling method that picks the right strategy based on whether analog is present.

## Investigation: Analog/Mixed Test Execution (#16, #28)

### Current Pipeline Limitations

The test pipeline has 5 coupled digital assumptions:
1. **Parser** (`src/testing/parser.ts:21-25`) — `TestValue` is `bigint` only, no float support
2. **Executor** (`src/testing/executor.ts:143-165`) — uses `runToStable` (digital fixed-point iteration), not time-based settling
3. **Comparator** (`src/testing/executor.ts:189-194`) — exact equality, no tolerance
4. **Label whitelist** (`src/solver/analog/compiler.ts:925`) — `labelToNodeId` only includes `["In", "Out", "Probe", "in", "out", "probe", "Port"]`, excluding all analog source types
5. **Facade guard** (`src/headless/default-facade.ts:243-245`) — hard-rejects analog-only circuits from test execution

### Analog Test Signal Types

| Role | TypeIds | Notes |
|------|---------|-------|
| Test inputs | `DcVoltageSource`, `AcVoltageSource`, `CurrentSource`, `VariableRail` | All labelable, all have `modelRegistry.behavioral` |
| Test outputs | `Probe`, `Out` (when in analog partition), any labeled analog component | `Probe` is already in the label whitelist |

### MVP Approach (~200 lines, 4 files)

1. **Expand label whitelist** — `src/solver/analog/compiler.ts:925`: add source typeIds to `labelTypesPartition`. Trivial, high impact — makes analog sources addressable by label.
2. **Add float TestValue** — `src/testing/parser.ts`: add `{ kind: 'float'; value: number; tolerance?: number }` variant. Detect decimal points in `parseTestValue`. Add `@tolerance` and `@settle` pragma parsing.
3. **Time-based settling** — `src/testing/executor.ts`: detect analog engine, use `coordinator.stepToTime(settleTime)` instead of `runToStable()`. Approximate comparison for float values.
4. **Remove hard guard** — `src/headless/default-facade.ts:243-245`: replace with analog-aware path selection.

### Known MVP Limitation

`writeByLabel` sets node voltage directly, bypassing MNA source stamps. For sources with internal impedance (`VariableRail`), this gives incorrect results. Proper fix needs a `setSourceValue(label, voltage)` API that routes through `setComponentProperty` — defer to second iteration.

### Not Covered by MVP (Full Redesign Territory)

- Time-series test vectors (multiple readings at different sim times per test)
- Transient waveform matching (expected voltage trajectory over time)
- AC analysis test vectors (frequency response assertions)
- Per-row time advancement
- Current measurement assertions

## Proposed Structural Fix

Add a `domain` field to `NetPin` and `PinDescriptor`:

```typescript
// netlist-types.ts
export interface NetPin {
  // ... existing fields ...
  readonly domain: 'digital' | 'analog';
}

export interface PinDescriptor {
  // ... existing fields ...
  readonly domain: 'digital' | 'analog';
}
```

Populate from the component's **active model** in `makeNetPin` — not from `availableModels` or `modelRegistry` keys. The active model is already tracked on `ComponentDescriptor.activeModel`. Then all formatters, diagnostics, and validation logic can branch on `domain` cleanly instead of re-deriving analog status at every call site.

**Net domain:** A net's domain is determined by its pins. If any pin on a net is analog, the net is analog (the digital portion is behind a bridge).
