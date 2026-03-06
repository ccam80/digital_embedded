# Phase 6: Core Integration

**Depends on**: Phases 1–5 (complete), Phase 5.5 (cross-cutting modifications)
**Blocks**: Phases 7, 8, 9, 10

## Overview

Wire all subsystems together into a working simulator. Connect the .dig parser to the component registry, bind the engine to the editor, implement subcircuit support (recursive loading, flattening, generics), build the test execution pipeline, and deliver the tutorial integration (HTML page, postMessage API, tutorial host).

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **Integration layer at `src/integration/`.** The editor-engine binding is cross-cutting — not editor logic, not engine logic, not the facade. It holds mapping tables and event plumbing. Browser-free (the renderer calls it, but it doesn't import Canvas2D).
- **Dig-loader is a standalone module.** `src/io/dig-loader.ts` is usable independently (editor "File → Open" calls it directly). The facade delegates to it.
- **Dynamic subcircuit registration.** When a subcircuit .dig is loaded, a new `ComponentDefinition` is registered in the registry. The `elementName` is the lookup key. All components (built-in and subcircuit) are accessed uniformly through the registry.
- **File resolver chain.** Subcircuit resolution order: embedded `.digb` definitions → local cache → HTTP fetch → filesystem. First match wins.
- **`.digb` for native saves.** Students save circuits (including bundled subcircuits) as `.digb` JSON files. `.dig` XML is import-only for Digital compatibility.
- **postMessage consolidated.** The full extended protocol (including `digital-set-input`, `digital-step`, `digital-read-output`, `digital-run-tests`, `digital-load-json`, `digital-load-memory`, `digital-set-base`, `digital-set-locked`) is implemented in this phase. Task 9.3.2 from the original plan is absorbed here.
- **Test executor uses `runToStable()`.** After setting inputs for each test vector, the executor runs until all outputs settle, not just a single `step()`.
- **External test vectors supported.** The facade's `runTests()` accepts an optional `testData` string parameter for instructor-provided test vectors.
- **Dark mode default.** The simulator HTML page defaults to dark mode (Phase 5.5 establishes the color scheme).
- **Speed control.** Text entry field with /10, /2, x2, x10 buttons on either side.
- **Wire coloring.** Matches Digital's semantic scheme adapted for dark background (Phase 5.5 color scheme).

## Reference Source

| What | Where |
|------|-------|
| Circuit compilation | `ref/Digital/src/main/java/de/neemann/digital/draw/model/` |
| Subcircuit handling | `ref/Digital/src/main/java/de/neemann/digital/draw/library/` |
| Generic resolution | `ref/Digital/src/main/java/de/neemann/digital/draw/library/ResolveGenerics.java` |
| Test execution | `ref/Digital/src/main/java/de/neemann/digital/testing/` |
| postMessage API | Original spec in `CLAUDE.md` |

---

## Wave 6.1: Subsystem Wiring

### Task 6.1.1 — .dig Loader

- **Description**: The "last mile" that takes a parsed .dig structure and produces a fully populated `Circuit` with real `CircuitElement` instances.

  Pipeline:
  ```
  .dig XML → dig-parser (Phase 4) → parsed DOM → dig-loader (THIS) → populated Circuit
  ```

  For each `visualElement` in the parsed .dig:
  1. Look up `elementName` in the `ComponentRegistry`
  2. Get the `ComponentDefinition` and its `attributeMap`
  3. Apply attribute mappings to convert XML attribute strings → `PropertyBag`
  4. Call `factory(props)` to create a `CircuitElement`
  5. Set position and rotation from .dig `pos` and `rotation` fields
  6. Add element to `Circuit`

  For each wire in the .dig:
  1. Create `Wire` objects from visual wire segment data (start/end coordinates)
  2. Add to `Circuit`

  Extract circuit metadata: name, description, test data from `Testcase` elements.

  Error handling:
  - Unknown `elementName` → throw (fail hard to surface missing registrations)
  - Missing required attributes → use defaults from `ComponentDefinition.propertyDefs`
  - Malformed attribute values → throw with component name and attribute in error message

  Also implements the `loadDig()` method for `SimulatorFacade` (delegates from facade to this module).

- **Files to create**:
  - `src/io/dig-loader.ts` — `loadDig(xml: string, registry: ComponentRegistry): Circuit`. Wires parser output to registry attribute mappings and factories. Also `loadDigFromParsed(parsed: DigDocument, registry: ComponentRegistry): Circuit` for pre-parsed input.

- **Files to modify**:
  - `src/headless/builder.ts` — Wire `loadDig()` facade method to call `dig-loader.ts`

- **Tests**:
  - `src/io/__tests__/dig-loader.test.ts::loadAndGate` — load `circuits/and-gate.dig`, verify circuit has correct number of elements (In x2, And x1, Out x1), correct types, correct wire count
  - `src/io/__tests__/dig-loader.test.ts::loadHalfAdder` — load `circuits/half-adder.dig`, verify element types and count, verify wire connectivity
  - `src/io/__tests__/dig-loader.test.ts::loadSrLatch` — load `circuits/sr-latch.dig`, verify element types and count
  - `src/io/__tests__/dig-loader.test.ts::attributeMapping` — load a .dig with `Inputs=3, Bits=8, wideShape=true`, verify the created element has `inputCount=3`, `bitWidth=8`, `wideShape=true`
  - `src/io/__tests__/dig-loader.test.ts::positionAndRotation` — verify loaded elements have correct grid positions and rotations from .dig data
  - `src/io/__tests__/dig-loader.test.ts::unknownElementThrows` — .dig with `elementName="Bogus"` throws with message containing "Bogus"
  - `src/io/__tests__/dig-loader.test.ts::missingAttributeUsesDefault` — .dig element without `Bits` attribute → element created with default bitWidth
  - `src/io/__tests__/dig-loader.test.ts::facadeIntegration` — `facade.loadDig(xmlString)` returns a valid `Circuit`

- **Acceptance criteria**:
  - All three checkpoint circuits load end-to-end
  - All elements have correct types, properties, positions
  - Wires are created with correct coordinates
  - Unknown elements throw immediately
  - Facade `loadDig()` delegates correctly
  - All tests pass

---

### Task 6.1.2 — Engine-Editor Binding

- **Description**: The integration layer connecting the compiled engine to the visual editor. Holds the `wireToNetId` mapping, coordinates redraws, and routes interactive input.

  ```typescript
  // src/integration/editor-binding.ts
  interface EditorBinding {
    bind(circuit: Circuit, engine: SimulationEngine, wireNetMap: Map<Wire, number>, pinNetMap: Map<string, number>): void;
    unbind(): void;

    getWireValue(wire: Wire): number;
    getPinValue(element: CircuitElement, pinLabel: string): number;

    setInput(element: CircuitElement, pinLabel: string, value: BitVector): void;

    readonly isBound: boolean;
    readonly engine: SimulationEngine | null;
  }
  ```

  Redraw coordination:
  - Engine `addChangeListener` detects RUNNING → start `requestAnimationFrame` loop
  - STOPPED/PAUSED → one final repaint, stop rAF loop
  - While paused: repaints on explicit user interaction only

  Interactive input flow:
  ```
  User clicks In component → editor hit-test → binding.setInput(element, pin, value)
    → binding looks up net ID → engine.setSignalValue(netId, value) → next step propagates
  ```

  Simulation toolbar controls:
  - Step (single propagation cycle)
  - Micro-step (single gate evaluation)
  - Run/Pause toggle
  - Stop/Reset
  - Speed control: text entry field with /10, /2, x2, x10 buttons

  Speed model: the "speed" value represents simulation steps per second. Default 1000. The rAF loop calls `engine.step()` N times per frame to match the target speed. At very high speeds, multiple steps per frame. At very low speeds (< 60 Hz), one step per N frames.

- **Files to create**:
  - `src/integration/editor-binding.ts` — `EditorBinding` interface and `createEditorBinding(): EditorBinding` factory
  - `src/integration/redraw-coordinator.ts` — rAF loop management, speed control logic
  - `src/integration/speed-control.ts` — speed value management, /10 /2 x2 x10 logic, text field parsing

- **Tests**:
  - `src/integration/__tests__/editor-binding.test.ts::bind` — bind circuit + engine, assert `isBound` is true
  - `src/integration/__tests__/editor-binding.test.ts::unbind` — unbind, assert `isBound` is false, engine is null
  - `src/integration/__tests__/editor-binding.test.ts::getWireValue` — bind with known wireNetMap, mock engine returns specific value for net ID, assert `getWireValue(wire)` returns that value
  - `src/integration/__tests__/editor-binding.test.ts::setInput` — call `setInput()`, verify `engine.setSignalValue()` called with correct net ID
  - `src/integration/__tests__/editor-binding.test.ts::unboundThrows` — calling `getWireValue()` when unbound throws
  - `src/integration/__tests__/speed-control.test.ts::defaultSpeed` — default speed is 1000
  - `src/integration/__tests__/speed-control.test.ts::multiply` — speed 1000 → x2 → 2000 → x10 → 20000
  - `src/integration/__tests__/speed-control.test.ts::divide` — speed 1000 → /2 → 500 → /10 → 50
  - `src/integration/__tests__/speed-control.test.ts::parseText` — "500" → 500, "1e6" → 1000000, "abc" → unchanged
  - `src/integration/__tests__/speed-control.test.ts::clampMin` — speed cannot go below 1
  - `src/integration/__tests__/speed-control.test.ts::clampMax` — speed cannot exceed 10000000

- **Acceptance criteria**:
  - Binding connects engine to editor via wire/pin net ID mappings
  - `getWireValue()` reads live signal values through the engine
  - `setInput()` drives input changes through the engine
  - Speed control supports /10, /2, x2, x10 and text entry
  - Speed clamped to [1, 10_000_000]
  - All tests pass

---

## Wave 6.2: Subcircuit Support

### Task 6.2.1 — Subcircuit Component Type

- **Description**: A `CircuitElement` representing a nested circuit. Renders as a chip (labeled rectangle with interface pins). Pins are derived dynamically from the subcircuit's `In`/`Out` components.

  Rendering shape modes:
  - DEFAULT: labeled rectangle with pin names
  - CUSTOM: SVG-based custom shape (from subcircuit definition)
  - DIL: DIP IC package appearance
  - LAYOUT: miniature rendering of subcircuit internals

  Dynamic registration: when a subcircuit .dig is loaded, register a new `ComponentDefinition` with:
  - `name`: subcircuit file name (e.g., "FullAdder")
  - `factory`: creates `SubcircuitElement` configured with the loaded definition
  - `executeFn`: no-op (subcircuits are flattened before simulation)
  - `pinLayout`: derived from subcircuit's In/Out components
  - `category`: ComponentCategory.SUBCIRCUIT

  The `SubcircuitElement` stores a reference to the loaded subcircuit's `Circuit` definition for rendering and flattening.

- **Files to create**:
  - `src/components/subcircuit/subcircuit.ts` — `SubcircuitElement` class, `SubcircuitDefinition` interface (holds loaded circuit + derived pin layout + shape type), `registerSubcircuit(registry, name, definition)` function
  - `src/components/subcircuit/pin-derivation.ts` — `deriveInterfacePins(circuit: Circuit): PinDeclaration[]` — walks a circuit's In/Out elements and produces pin declarations
  - `src/components/subcircuit/shape-renderer.ts` — rendering logic for DEFAULT, DIL, CUSTOM, LAYOUT shape modes

- **Tests**:
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::derivesPins` — create circuit with 2 In + 1 Out, derive pins, verify 2 input pins + 1 output pin with correct labels and bit widths
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::dynamicRegistration` — register subcircuit definition, verify registry lookup by name succeeds, typeId assigned
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::drawDefault` — render with DEFAULT shape, verify rectangle + pin labels drawn via mock RenderContext
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::drawDIL` — render with DIL shape, verify DIP package appearance
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::executeFnNoOp` — execute function does nothing (no state change)
  - `src/components/subcircuit/__tests__/subcircuit.test.ts::pinOrderMatchesInOut` — pins appear in the same order as In/Out components are declared in the subcircuit

- **Acceptance criteria**:
  - SubcircuitElement renders all four shape modes
  - Pin layout derived correctly from subcircuit's In/Out components
  - Dynamic registration works — subcircuits accessible from registry by name
  - executeFn is a no-op
  - All tests pass

---

### Task 6.2.2 — Recursive .dig Loading with File Resolver

- **Description**: When the loader encounters an `elementName` not in the built-in registry, load the corresponding .dig file as a subcircuit. Recursive — subcircuits may themselves reference subcircuits.

  File resolver interface:
  ```typescript
  interface FileResolver {
    resolve(name: string, relativeTo?: string): Promise<string>; // returns file content
  }
  ```

  Implementations:
  - `EmbeddedResolver` — checks `subcircuitDefinitions` from a `.digb` document
  - `CacheResolver` — checks already-loaded definitions (in-memory `Map<string, Circuit>`)
  - `HttpResolver` — fetches `${basePath}/${name}.dig` via HTTP
  - `NodeResolver` — reads from filesystem (for headless/Node.js)
  - `ChainResolver` — chains resolvers in order: embedded → cache → http → node. First match wins.

  Loading process:
  1. Loader encounters unknown `elementName` (not in built-in registry)
  2. Call `resolver.resolve(elementName)` to get .dig XML content
  3. Parse the .dig file
  4. Recursively load any subcircuits it references
  5. Register the subcircuit in the registry (dynamic registration from 6.2.1)
  6. Cache the loaded definition

  Safety:
  - Cycle detection: track loading stack, error if a circuit appears in its own ancestor chain
  - Depth limit: 30 (matching Digital)
  - Clear error messages: "Circular subcircuit reference: A → B → C → A"

  Cache invalidation: `clearSubcircuitCache()` clears all cached definitions. Used for checkpoint jumping.

- **Files to create**:
  - `src/io/file-resolver.ts` — `FileResolver` interface, `EmbeddedResolver`, `CacheResolver`, `HttpResolver`, `NodeResolver`, `ChainResolver`, `createDefaultResolver(basePath?: string): FileResolver`
  - `src/io/subcircuit-loader.ts` — `loadWithSubcircuits(xml: string, resolver: FileResolver, registry: ComponentRegistry): Promise<Circuit>`. Recursive loading logic with cycle detection and depth tracking.

- **Tests**:
  - `src/io/__tests__/file-resolver.test.ts::embeddedResolver` — resolve name present in embedded map → returns content
  - `src/io/__tests__/file-resolver.test.ts::embeddedMiss` — resolve name not in embedded map → throws/returns null
  - `src/io/__tests__/file-resolver.test.ts::cacheResolver` — resolve from pre-populated cache
  - `src/io/__tests__/file-resolver.test.ts::chainOrder` — chain [embedded, cache], name in cache but not embedded → cache returns it
  - `src/io/__tests__/subcircuit-loader.test.ts::recursiveLoad` — main .dig references sub .dig, resolver returns both, verify both loaded and registered
  - `src/io/__tests__/subcircuit-loader.test.ts::circularDetection` — A references B, B references A → throws with cycle message
  - `src/io/__tests__/subcircuit-loader.test.ts::depthLimit` — chain of 31 nested subcircuits → throws depth limit error
  - `src/io/__tests__/subcircuit-loader.test.ts::cacheReuse` — two instances of same subcircuit, resolver called only once (cached)
  - `src/io/__tests__/subcircuit-loader.test.ts::clearCache` — load subcircuit, clear cache, load again, resolver called twice

- **Acceptance criteria**:
  - Recursive subcircuit loading works to arbitrary depth (up to 30)
  - Cycle detection catches circular references
  - Resolver chain checks embedded → cache → http in order
  - Cache prevents redundant loads
  - Cache can be cleared for checkpoint jumping
  - All tests pass

---

### Task 6.2.3 — Subcircuit Engine Flattening

- **Description**: For simulation, subcircuits are inlined into the parent's `CompiledModel`. The compiler walks the circuit graph and replaces each subcircuit instance with its internal components.

  Flattening process:
  1. For each subcircuit element in the circuit, look up its loaded definition
  2. Deep-copy the subcircuit's internal components (avoid shared mutation)
  3. Add all internal components to the parent's component list with scoped naming (e.g., `"FullAdder_0.And_0"`, `"FullAdder_1.And_0"` for two instances)
  4. Wire subcircuit's `In` components to the parent net connected to that interface pin
  5. Wire subcircuit's `Out` components to the parent net connected to that interface pin
  6. Remove the subcircuit element itself (replaced by its internals)
  7. Recurse for nested subcircuits

  After flattening, the `CompiledModel` contains only leaf components. The engine's inner loop does not know subcircuits exist.

  Scoped naming ensures that multiple instances of the same subcircuit have distinct internal net names. The naming convention is `{parentInstanceName}.{childComponentName}`.

- **Files to create**:
  - `src/engine/flatten.ts` — `flattenCircuit(circuit: Circuit, registry: ComponentRegistry): Circuit` — returns a new Circuit with all subcircuits inlined. Recursive. Scoped naming.

- **Tests**:
  - `src/engine/__tests__/flatten.test.ts::singleSubcircuit` — circuit with one subcircuit instance, verify subcircuit element replaced by its internal components
  - `src/engine/__tests__/flatten.test.ts::twoInstances` — two instances of same subcircuit, verify scoped names are distinct (no collisions)
  - `src/engine/__tests__/flatten.test.ts::nestedSubcircuit` — subcircuit contains another subcircuit, verify full recursive flattening
  - `src/engine/__tests__/flatten.test.ts::pinWiring` — verify parent net connected to subcircuit's input pin is wired to the corresponding internal In component
  - `src/engine/__tests__/flatten.test.ts::noSubcircuitsUnchanged` — circuit with no subcircuits → returned circuit identical to input
  - `src/engine/__tests__/flatten.test.ts::preservesLeafComponents` — gates, flip-flops, etc. pass through unchanged

- **Acceptance criteria**:
  - Single-level subcircuit flattening works
  - Multi-instance scoped naming prevents collisions
  - Nested subcircuit flattening works recursively
  - Interface pin wiring is correct
  - Leaf components preserved unchanged
  - All tests pass

---

### Task 6.2.4 — Generic Circuit Resolution

- **Description**: When a .dig file has `isGeneric=true`, run HGS scripts to produce a concrete circuit. Port of Digital's `ResolveGenerics.java`.

  Resolution process:
  1. Deep-copy the generic circuit template (never modify the cached original)
  2. Create HGS execution context with:
     - `args`: parent component's properties (parameters passed to the generic circuit)
     - `this`: the element's own attributes
     - Utility functions: `addWire()`, `addComponent()`, `setCircuit()`, `global`, `settings`
  3. Run `GenericInitCode` scripts (circuit-level initialization)
  4. Run per-element `generic` attribute scripts (may modify element properties, add/remove elements)
  5. Return the concrete (non-generic) circuit

  Caching: resolved circuits cached by (generic name + parameter values). Same generic with same parameters returns cached result.

- **Files to create**:
  - `src/io/resolve-generics.ts` — `resolveGeneric(template: Circuit, args: PropertyBag, hgsContext: HgsContext): Circuit`
  - `src/io/generic-cache.ts` — `GenericCache` class — cache resolved circuits by parameter hash

- **Tests**:
  - `src/io/__tests__/resolve-generics.test.ts::resolveBasic` — generic circuit with `args.bits = 8`, script sets element bit widths → resolved circuit has 8-bit elements
  - `src/io/__tests__/resolve-generics.test.ts::addComponent` — generic script calls `addComponent()` → extra component appears in resolved circuit
  - `src/io/__tests__/resolve-generics.test.ts::cacheHit` — resolve same generic with same args twice, verify second call returns cached result (same object reference)
  - `src/io/__tests__/resolve-generics.test.ts::cacheMiss` — resolve same generic with different args, verify different results
  - `src/io/__tests__/resolve-generics.test.ts::templateUnmodified` — after resolution, original template circuit is unchanged
  - `src/io/__tests__/resolve-generics.test.ts::perElementScript` — element with `generic` attribute script modifies that element's properties

- **Acceptance criteria**:
  - Generic circuits resolve to concrete circuits via HGS scripts
  - `addWire()`, `addComponent()`, `setCircuit()` utility functions work in HGS context
  - Cache prevents redundant resolution
  - Template circuits are never modified (deep copy)
  - All tests pass

---

## Wave 6.3: Test Execution

### Task 6.3.1 — Truth Table Parser

- **Description**: Parse Digital's test vector syntax from strings embedded in `Testcase` components or provided externally.

  Supported syntax:
  - Signal name headers (first non-comment line)
  - Values: binary (`0`, `1`), hex (`0xFF`), decimal (`255`), don't-care (`X`), clock pulse (`C`), high-Z (`Z`)
  - `loop(N)` / `end loop` for repetition
  - `repeat(N)` shorthand for repeating a single row
  - `bits(N)` to set expected bit width
  - Comments: lines starting with `#`
  - Whitespace-separated columns

  Output:
  ```typescript
  interface ParsedTestData {
    inputNames: string[];
    outputNames: string[];
    vectors: ParsedVector[];
  }

  interface ParsedVector {
    inputs: Map<string, TestValue>;
    outputs: Map<string, TestValue>;
  }

  type TestValue =
    | { kind: 'value'; value: bigint }
    | { kind: 'dontCare' }
    | { kind: 'clock' }
    | { kind: 'highZ' };
  ```

  Reference: `ref/Digital/src/main/java/de/neemann/digital/testing/parser/`

- **Files to create**:
  - `src/testing/parser.ts` — `parseTestData(text: string): ParsedTestData`. Pure function, no side effects, no browser deps.

- **Tests**:
  - `src/testing/__tests__/parser.test.ts::simpleTable` — parse `"A B Y\n0 0 0\n0 1 1\n1 0 1\n1 1 1"`, verify 2 inputs (A, B), 1 output (Y), 4 vectors
  - `src/testing/__tests__/parser.test.ts::hexValues` — `0xFF` parsed as bigint 255
  - `src/testing/__tests__/parser.test.ts::dontCare` — `X` in output column parsed as `{ kind: 'dontCare' }`
  - `src/testing/__tests__/parser.test.ts::clockPulse` — `C` parsed as `{ kind: 'clock' }`
  - `src/testing/__tests__/parser.test.ts::highZ` — `Z` parsed as `{ kind: 'highZ' }`
  - `src/testing/__tests__/parser.test.ts::loopExpansion` — `loop(3)\n0 1\nend loop` → 3 identical vectors
  - `src/testing/__tests__/parser.test.ts::repeatExpansion` — `repeat(5) 1 0` → 5 identical vectors
  - `src/testing/__tests__/parser.test.ts::comments` — lines starting with `#` ignored
  - `src/testing/__tests__/parser.test.ts::emptyInput` — empty string throws descriptive error
  - `src/testing/__tests__/parser.test.ts::malformedRow` — row with wrong column count throws with line number in error

- **Acceptance criteria**:
  - All Digital test syntax features parsed correctly
  - Loop and repeat expand to correct number of vectors
  - All value types recognized
  - Clear errors for malformed input with line numbers
  - No browser dependencies
  - All tests pass

---

### Task 6.3.2 — Test Executor

- **Description**: Drive the simulation engine with parsed test vectors and compare outputs.

  For each vector row:
  1. Set all input signals via `facade.setInput(label, value)` (skip clock inputs)
  2. For clock inputs: toggle high → `runToStable()` → toggle low → `runToStable()`
  3. For non-clock: `runToStable()` to propagate
  4. Read all output signals via `facade.readOutput(label)`
  5. Compare against expected values:
     - `dontCare` → always pass
     - `highZ` → compare with HIGH_Z sentinel
     - `value` → exact match
  6. Record pass/fail

  Returns `TestResults` (defined in `src/headless/types.ts`).

- **Files to create**:
  - `src/testing/executor.ts` — `executeTests(facade: SimulatorFacade, engine: SimulationEngine, circuit: Circuit, testData: ParsedTestData): TestResults`

- **Tests**:
  - `src/testing/__tests__/executor.test.ts::allPass` — half-adder with correct truth table → all vectors pass
  - `src/testing/__tests__/executor.test.ts::someFail` — deliberate wrong expected value → that vector fails, others pass
  - `src/testing/__tests__/executor.test.ts::dontCareAlwaysPasses` — output expectation is `X` → passes regardless of actual value
  - `src/testing/__tests__/executor.test.ts::clockToggle` — test with clock pulse input → engine stepped twice (rising + falling edge)
  - `src/testing/__tests__/executor.test.ts::resultsStructure` — verify TestResults has correct `passed`, `failed`, `total` counts and `vectors` array length

- **Acceptance criteria**:
  - Test vectors execute correctly against the engine
  - Clock pulse toggling works
  - Don't-care comparison works
  - Results structure matches `TestResults` interface
  - All tests pass

---

### Task 6.3.3 — Test Results Display

- **Description**: Browser UI panel showing test execution results in a table.

  Features:
  - Table rows = test vectors, columns = signal names (inputs green, outputs green/red)
  - Cell coloring: green for pass, red for fail (shows expected vs actual on hover)
  - Summary bar: "12/15 passed" with counts
  - Failed row click → highlights which output mismatched
  - "Re-run" button re-executes tests
  - Panel follows established panel pattern from Phase 2

- **Files to create**:
  - `src/testing/results-ui.ts` — `TestResultsPanel` class. Renders into a DOM container. Takes `TestResults` as input.

- **Tests**:
  - `src/testing/__tests__/results-ui.test.ts::rendersTable` — create panel with 4-vector results, verify table has 4 data rows
  - `src/testing/__tests__/results-ui.test.ts::summaryText` — 3 pass, 1 fail → summary shows "3/4 passed"
  - `src/testing/__tests__/results-ui.test.ts::failedCellsMarked` — failed output cells have CSS class indicating failure
  - `src/testing/__tests__/results-ui.test.ts::allPassStyling` — all pass → summary has success styling
  - `src/testing/__tests__/results-ui.test.ts::emptyResults` — zero vectors → shows "No test vectors" message

- **Acceptance criteria**:
  - Results table renders correctly with all test data
  - Pass/fail coloring is clear
  - Summary bar shows correct counts
  - Re-run button triggers test execution
  - All tests pass

---

### Task 6.3.4 — Headless Test Runner

- **Description**: Integrate parser + executor into the `SimulatorFacade`. Supports both embedded test data (from `Testcase` components) and external test vectors (instructor-provided string).

  `runTests()` implementation:
  1. If `testData` string provided → use it
  2. Otherwise → find all `Testcase` components in the circuit, concatenate their test data
  3. Parse test data (6.3.1)
  4. Execute test vectors (6.3.2)
  5. Return `TestResults`

- **Files to modify**:
  - `src/headless/facade.ts` — Update `runTests` signature to accept optional `testData` parameter:
    ```typescript
    runTests(engine: SimulationEngine, circuit: Circuit, testData?: string): TestResults;
    ```
  - `src/headless/builder.ts` — Wire `runTests()` implementation

- **Files to create**:
  - `src/headless/test-runner.ts` — Implementation that wires parser and executor together

- **Tests**:
  - `src/headless/__tests__/test-runner.test.ts::embeddedTests` — circuit with Testcase component containing truth table → `runTests(engine, circuit)` returns correct results
  - `src/headless/__tests__/test-runner.test.ts::externalTests` — `runTests(engine, circuit, "A B Y\n0 0 0\n1 1 1")` uses provided test data instead of embedded
  - `src/headless/__tests__/test-runner.test.ts::noTestData` — circuit without Testcase, no external data → throws descriptive error
  - `src/headless/__tests__/test-runner.test.ts::endToEnd` — `facade.loadDig('circuits/half-adder.dig')` → compile → runTests → all vectors pass
  - `src/headless/__tests__/test-runner.test.ts::multipleTestcases` — circuit with 2 Testcase components → both sets of vectors executed

- **Acceptance criteria**:
  - Embedded test data extracted from Testcase components
  - External test data accepted and used when provided
  - Full end-to-end pipeline works (load → compile → test)
  - Runnable from Node.js without browser
  - All tests pass

---

### Task 6.3.5 — Test Results Export

- **Description**: Export test results to CSV format for grading and record-keeping.

  CSV columns: `Row, Status, Input1, Input2, ..., Expected_Output1, Actual_Output1, Expected_Output2, Actual_Output2, ...`

  Each row corresponds to one test vector. Status is "PASS" or "FAIL".

- **Files to create**:
  - `src/testing/export.ts` — `exportResultsCsv(results: TestResults, testData: ParsedTestData): string`

- **Tests**:
  - `src/testing/__tests__/export.test.ts::csvHeader` — verify header row contains correct column names
  - `src/testing/__tests__/export.test.ts::csvRows` — 3 vectors → 3 data rows (plus header)
  - `src/testing/__tests__/export.test.ts::passFailStatus` — PASS/FAIL in status column matches vector results
  - `src/testing/__tests__/export.test.ts::valuesCorrect` — input and output values appear in correct columns

- **Acceptance criteria**:
  - CSV output is well-formed (RFC 4180 compliant)
  - All test vector data present
  - No browser dependencies
  - All tests pass

---

### Task 6.3.6 — Circuit Comparison

- **Description**: Compare two circuits by running the same test vectors against both and diffing the results. Two modes:

  **Test-based comparison**: Instructor provides test vectors. Run against reference circuit and student circuit. Diff outputs row by row.

  **Exhaustive comparison**: No test vectors needed. If total input bit count ≤ 20, generate all 2^N input combinations from the reference circuit. Run both circuits on every combination. Report all disagreements.

  The comparison function auto-selects mode: if test vectors provided, use test-based; if not and input count ≤ 20, use exhaustive; otherwise error requesting test vectors.

  Output:
  ```typescript
  interface ComparisonResult {
    mode: 'test-based' | 'exhaustive';
    totalVectors: number;
    matchCount: number;
    mismatchCount: number;
    mismatches: ComparisonMismatch[];
  }

  interface ComparisonMismatch {
    vectorIndex: number;
    inputs: Record<string, number>;
    referenceOutputs: Record<string, number>;
    studentOutputs: Record<string, number>;
    differingSignals: string[];
  }
  ```

- **Files to create**:
  - `src/testing/comparison.ts` — `compareCircuits(facade: SimulatorFacade, referenceCircuit: Circuit, studentCircuit: Circuit, testData?: string): ComparisonResult`

- **Tests**:
  - `src/testing/__tests__/comparison.test.ts::identicalCircuits` — compare circuit to itself → zero mismatches
  - `src/testing/__tests__/comparison.test.ts::differentCircuits` — reference AND gate vs student OR gate → mismatches on specific input combos
  - `src/testing/__tests__/comparison.test.ts::exhaustiveMode` — no test data, 2 inputs → all 4 combinations tested, mode is 'exhaustive'
  - `src/testing/__tests__/comparison.test.ts::testBasedMode` — test data provided → uses provided vectors, mode is 'test-based'
  - `src/testing/__tests__/comparison.test.ts::tooManyInputs` — 21 input bits, no test data → throws requesting test vectors
  - `src/testing/__tests__/comparison.test.ts::mismatchDetails` — verify differingSignals lists only the outputs that disagree

- **Acceptance criteria**:
  - Both comparison modes work correctly
  - Auto-selection between modes works
  - Mismatch details include which signals differ
  - Clear error when exhaustive mode is infeasible and no test vectors provided
  - All tests pass

---

## Wave 6.4: Tutorial Integration

### Task 6.4.1 — Simulator HTML Page

- **Description**: The main HTML page that bootstraps the simulator application. Works standalone (direct URL) and embedded (in iframe).

  The page:
  - Loads the Vite-built JS bundle
  - Creates canvas, toolbar, palette panel (left), property panel (right)
  - Initializes component registry with all built-in components
  - Sets up FileResolver with HTTP base path
  - Listens for postMessage commands
  - Applies URL parameters

  URL parameters:
  - `base=path/` — HTTP base path for subcircuit file resolution (default: current directory)
  - `file=name.dig` — auto-load a circuit on startup
  - `dark=0` — override to light color scheme (default: dark)
  - `locked=1` — start in locked mode (interactive but not editable)
  - `panels=none` — hide all panels (presentation mode)

  Iframe detection: `window.self !== window.top`. In iframe mode:
  - Panels default to collapsed (can be re-shown)
  - No browser-level menu bar clutter
  - postMessage listener active

  Standalone mode:
  - Full UI with all panels visible by default
  - File → Open triggers file picker
  - File → Save downloads `.digb` file
  - File → Save with Subcircuits bundles all referenced subcircuits into `.digb`

- **Files to create**:
  - `simulator.html` — HTML shell with minimal markup, script tag loading the bundle
  - `src/main.ts` — Application entry point. Initializes registry, resolver, editor, binding. Parses URL params. Sets up postMessage listener.
  - `src/app/url-params.ts` — Parse and validate URL parameters
  - `src/app/app-init.ts` — Application initialization sequence (registry, resolver, editor, toolbar)

- **Tests**:
  - `src/app/__tests__/url-params.test.ts::parseBase` — `?base=checkpoint-1/` → `{ base: 'checkpoint-1/' }`
  - `src/app/__tests__/url-params.test.ts::parseFile` — `?file=cpu.dig` → `{ file: 'cpu.dig' }`
  - `src/app/__tests__/url-params.test.ts::parseDark` — `?dark=0` → `{ dark: false }`
  - `src/app/__tests__/url-params.test.ts::parseLocked` — `?locked=1` → `{ locked: true }`
  - `src/app/__tests__/url-params.test.ts::defaults` — no params → `{ base: './', dark: true, locked: false, panels: 'default' }`
  - `src/app/__tests__/url-params.test.ts::panelsNone` — `?panels=none` → `{ panels: 'none' }`

- **Acceptance criteria**:
  - Page loads and renders canvas with toolbar and panels
  - URL parameters parsed and applied correctly
  - Dark mode is the default
  - Works standalone (file picker, save)
  - Works in iframe (postMessage, collapsed panels)
  - File → Save with Subcircuits produces self-contained `.digb`
  - All tests pass

---

### Task 6.4.2 — postMessage API

- **Description**: Full postMessage wire protocol. Thin adapter translating messages to SimulatorFacade calls.

  **Parent → Simulator:**
  | Message | Facade call |
  |---------|-------------|
  | `{ type: 'digital-load-url', url }` | `fetch(url)` → `facade.loadDig(xml)` |
  | `{ type: 'digital-load-data', data }` | `facade.loadDig(atob(data))` |
  | `{ type: 'digital-load-json', data }` | `deserializeDigb(data)` → load circuit + subcircuits |
  | `{ type: 'digital-set-input', label, value }` | `facade.setInput(engine, label, value)` |
  | `{ type: 'digital-step' }` | `facade.step(engine)` |
  | `{ type: 'digital-run-tests', testData? }` | `facade.runTests(engine, circuit, testData)` |
  | `{ type: 'digital-read-output', label }` | `facade.readOutput(engine, label)` |
  | `{ type: 'digital-read-all-signals' }` | `facade.readAllSignals(engine)` |
  | `{ type: 'digital-set-base', basePath }` | Clear subcircuit cache, update resolver base path |
  | `{ type: 'digital-set-locked', locked }` | Enable/disable locked mode |
  | `{ type: 'digital-load-memory', label, data, format }` | Load hex/binary data into RAM/ROM component |

  **Simulator → Parent:**
  | Message | When |
  |---------|------|
  | `{ type: 'digital-ready' }` | Simulator initialized |
  | `{ type: 'digital-loaded' }` | Circuit loaded successfully |
  | `{ type: 'digital-error', error }` | Error occurred |
  | `{ type: 'digital-output', label, value }` | Response to `digital-read-output` |
  | `{ type: 'digital-signals', signals }` | Response to `digital-read-all-signals` |
  | `{ type: 'digital-test-results', results }` | Response to `digital-run-tests` |

  Error handling: all incoming messages wrapped in try/catch, errors sent as `digital-error`.

- **Files to create**:
  - `src/io/postmessage-adapter.ts` — `PostMessageAdapter` class. Constructor takes `SimulatorFacade`, `EditorBinding`, `FileResolver`. Registers `window.addEventListener('message', ...)`. Maps each message type to the appropriate facade/binding call.

- **Tests**:
  - `src/io/__tests__/postmessage-adapter.test.ts::loadUrl` — simulate `digital-load-url` message, verify facade.loadDig called, `digital-loaded` response sent
  - `src/io/__tests__/postmessage-adapter.test.ts::loadData` — simulate `digital-load-data` with base64 .dig, verify circuit loaded
  - `src/io/__tests__/postmessage-adapter.test.ts::loadJson` — simulate `digital-load-json` with .digb content, verify circuit + subcircuits loaded
  - `src/io/__tests__/postmessage-adapter.test.ts::setInput` — simulate `digital-set-input`, verify facade.setInput called with correct label and value
  - `src/io/__tests__/postmessage-adapter.test.ts::readOutput` — simulate `digital-read-output`, verify `digital-output` response sent with correct value
  - `src/io/__tests__/postmessage-adapter.test.ts::runTests` — simulate `digital-run-tests`, verify `digital-test-results` response contains TestResults
  - `src/io/__tests__/postmessage-adapter.test.ts::setBase` — simulate `digital-set-base`, verify resolver base path updated and cache cleared
  - `src/io/__tests__/postmessage-adapter.test.ts::errorHandling` — simulate message that causes an error, verify `digital-error` response sent
  - `src/io/__tests__/postmessage-adapter.test.ts::loadMemory` — simulate `digital-load-memory`, verify memory component data loaded
  - `src/io/__tests__/postmessage-adapter.test.ts::readyOnInit` — verify `digital-ready` sent when adapter is initialized

- **Acceptance criteria**:
  - All message types handled correctly
  - Responses sent for request-response messages
  - Errors wrapped and sent as `digital-error`
  - `digital-ready` sent on initialization
  - Checkpoint jumping (set-base) clears cache
  - All tests pass

---

### Task 6.4.3 — Tutorial Host Page

- **Description**: A reference tutorial host page demonstrating the iframe embedding model. Split-pane layout with dynamically loaded markdown content and embedded simulator.

  Layout:
  - Left pane: instruction content (rendered markdown)
  - Right pane: simulator iframe(s)
  - Top: checkpoint navigation (buttons/links for each checkpoint step)

  Features:
  - Loads instruction markdown per checkpoint from `{base}/instructions.md`
  - Renders markdown to HTML (use a lightweight markdown library, or pre-convert to HTML)
  - Multiple simulator iframes supported (each with independent `base` parameter)
  - Checkpoint navigation: clicking a checkpoint button sends `digital-set-base` + `digital-load-url` to the iframe(s)
  - URL params: `tutorial=name` selects tutorial directory, `step=N` selects checkpoint

  Directory structure expected by the host:
  ```
  tutorials/
    intro-to-logic/
      checkpoint-1/
        instructions.md
        and-gate.dig
      checkpoint-2/
        instructions.md
        half-adder.dig
        and-gate.dig        ← subcircuit
      checkpoint-3/
        instructions.md
        full-adder.dig
        half-adder.dig      ← subcircuit
  ```

- **Files to create**:
  - `tutorial.html` — HTML shell with split-pane layout, script tag
  - `src/tutorial/tutorial-host.ts` — Tutorial host logic: load markdown, manage iframes, checkpoint navigation
  - `src/tutorial/markdown-renderer.ts` — Simple markdown → HTML conversion (or import a small library like `marked`)

- **Tests**:
  - `src/tutorial/__tests__/tutorial-host.test.ts::parseParams` — `?tutorial=intro-to-logic&step=2` → correct tutorial and step values
  - `src/tutorial/__tests__/tutorial-host.test.ts::checkpointPath` — tutorial "intro-to-logic", step 2 → base path `tutorials/intro-to-logic/checkpoint-2/`
  - `src/tutorial/__tests__/tutorial-host.test.ts::iframeSetup` — verify iframe src includes correct `base` parameter

- **Acceptance criteria**:
  - Tutorial page loads and renders split-pane layout
  - Markdown instructions load per checkpoint
  - Simulator iframe receives correct `base` path
  - Checkpoint navigation updates both instruction content and simulator
  - Multiple iframes supported
  - URL params control tutorial selection and step
  - All tests pass
