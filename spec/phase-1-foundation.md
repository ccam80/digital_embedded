# Phase 1: Foundation & Type System

**Depends on**: Phase 0 (complete)
**Blocks**: Phases 2, 3, 4, 5 (all parallel after this phase)
**CHECKPOINT**: Author review required after completion. See `spec/author_instructions.md` § Checkpoint 1.

## Binding Architectural Decisions

**Read `spec/shared-decisions.md` before implementing any task.** It defines six cross-cutting contracts that all code in this phase must follow:

1. **CircuitElement has no simulation logic.** No `execute()` method. Flat standalone functions are the simulation path.
2. **Engine owns the signal array.** All consumers read through `getSignalRaw(netId)` or `getSignalValue(netId)`.
3. **Visual model and executable model are separate.** `Circuit` is visual. `CompiledModel` is executable. The compiler bridges them.
4. **One registry, one registration shape.** `ComponentDefinition` bundles factory + flat function + attribute mappings + auto-assigned type ID.
5. **PropertyBag is the universal property format.** `.dig` attribute mappings convert XML → PropertyBag. Components only see PropertyBag.
6. **Pins are visual-only.** No simulation state on Pin. The compiler assigns net IDs.

> **Note**: The component template in `spec/author_instructions.md` shows `execute()` on CircuitElement. This is superseded by Decision 1 in `spec/shared-decisions.md` — the author approved this change. CircuitElement has `draw()` but NOT `execute()`. Simulation logic lives in standalone flat functions registered in the ComponentDefinition.

## Reference Source

All type designs should be informed by the Java source at `ref/Digital/`. Initialize the submodule if needed: `git submodule update --init`.

Key Java files to study per task are listed below. Read to understand semantics, then write idiomatic TypeScript — not a line-by-line translation. See `spec/author_instructions.md` for the TS idiom guide.

---

## Wave 1.1: Project Infrastructure

### Task 1.1.1 — TypeScript Project Setup
**Complexity**: M
**Key outputs**: `package.json`, `tsconfig.json`, `vite.config.ts`, directory structure, ESLint config, `.gitignore`

Create the project scaffold:

1. **package.json**:
   - Name: `digital-sim` (or similar)
   - Type: `"module"`
   - Dependencies: `zod` (runtime schema validation at serialization boundaries)
   - Dev dependencies: `typescript`, `vite`, `vitest`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`
   - Scripts: `dev`, `build`, `test`, `lint`, `typecheck` (`tsc --noEmit`)

2. **tsconfig.json**:
   - Strict mode: `"strict": true`
   - Target: `"ES2022"` (for top-level await, `SharedArrayBuffer`, `Atomics`)
   - Module: `"ESNext"` with `"moduleResolution": "bundler"`
   - `"noUnusedLocals": true`, `"noUnusedParameters": true`
   - Path aliases: `@/` → `src/`

3. **vite.config.ts**:
   - Entry: `src/main.ts`
   - Output: static files (no server)
   - Configure for `SharedArrayBuffer` support (COOP/COEP headers in dev server)

4. **Directory structure**:
   ```
   src/
     core/           — types, interfaces, errors
     editor/         — canvas, interaction, UI
     engine/         — simulation engines, compiler
     components/     — all ~110 component types
     io/             — .dig parser, JSON save/load, attribute mapping
     hgs/            — HGS scripting interpreter
     testing/        — test framework
     analysis/       — circuit analysis, synthesis
     fsm/            — FSM editor
     test-utils/     — mock contexts for testing
   ```

5. **ESLint**: TypeScript-aware config. Enforce `no-explicit-any` (warning level), `consistent-type-imports`.

6. **.gitignore**: `node_modules/`, `dist/`, `.vite/`, `*.tsbuildinfo`

7. Create a minimal `src/main.ts` placeholder so the build works.

**Verification**: `npm install && npm run typecheck && npm run build` all succeed.

---

### Task 1.1.2 — Test Infrastructure
**Complexity**: M
**Key outputs**: `vitest.config.ts`, `src/test-utils/mock-render-context.ts`, `src/test-utils/mock-engine.ts`

1. **vitest.config.ts**:
   - Use Vite's built-in test support
   - Path aliases matching tsconfig
   - Coverage reporting (optional, not required for Phase 1)

2. **Mock RenderContext** (`src/test-utils/mock-render-context.ts`):
   - Implements the `RenderContext` interface (from task 1.3.3)
   - Records all draw calls (lines, rects, text, arcs, paths) into an array
   - Allows assertions like "drew a line from (0,0) to (10,10)" in tests
   - Tracks style state (color, lineWidth, font)

3. **Mock Engine** (`src/test-utils/mock-engine.ts`):
   - Implements the engine interface (from task 1.3.2)
   - Tracks signal state in a plain `Uint32Array`
   - Allows tests to set/get signal values without a real simulation loop
   - Records method calls for assertion

4. Create a simple smoke test to verify the test infrastructure works.

**Dependency**: This task depends on tasks 1.3.2 and 1.3.3 for the interfaces to mock. Implement the mocks after those interfaces exist, or define minimal placeholder interfaces first and refine when the real interfaces land.

**Verification**: `npm test` runs and passes.

---

## Wave 1.2: Core Type System

### Task 1.2.1 — Signal Value Types
**Complexity**: M
**Key output**: `src/core/signal.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/ObservableValue.java`, `ref/Digital/src/main/java/de/neemann/digital/core/IntFormat.java`

1. **`Bit` enum**: `ZERO`, `ONE`, `HIGH_Z`, `UNDEFINED`

2. **`BitVector` class** (OOP API for UI):
   - Arbitrary-width multi-bit signal (1–64 bits)
   - Stores value as `bigint` or dual `number` fields (design choice — pick whichever is cleaner)
   - Per-bit HIGH_Z and UNDEFINED tracking (separate mask)
   - Arithmetic: add, subtract, and, or, xor, not, shift
   - Comparison: equals, with don't-care for UNDEFINED bits
   - Number conversion: `toNumber()`, `toBigInt()`
   - Display: `toString(radix)` with configurable format (bin, hex, dec, signed dec)
   - `static from(raw: number, width: number): BitVector` — convert from flat representation
   - `toRaw(): number` — convert to flat representation

3. **Flat signal representation** (for engine hot path):
   - Signal state stored in `Uint32Array` indexed by net ID
   - For signals ≤ 32 bits: one slot per net (value bits)
   - For signals > 32 bits: multiple consecutive slots
   - HIGH_Z represented as a separate parallel array or bit-packed (design choice — document rationale)
   - Conversion functions: `bitVectorToRaw(bv: BitVector): number` and `rawToBitVector(raw: number, width: number): BitVector`

4. **Unit tests**: round-trip conversion between BitVector and raw, arithmetic correctness, display formatting, edge cases (0-width, 64-bit, all HIGH_Z, all UNDEFINED).

---

### Task 1.2.2 — Pin System
**Complexity**: M
**Key output**: `src/core/pin.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/element/PinDescription.java`, `ref/Digital/src/main/java/de/neemann/digital/core/element/PinInfo.java`, `ref/Digital/src/main/java/de/neemann/digital/draw/elements/Pin.java`

1. **`PinDirection` enum**: `INPUT`, `OUTPUT`, `BIDIRECTIONAL`

2. **`Pin` interface** (visual/declarative only — per Decision 6):
   ```typescript
   interface Pin {
     direction: PinDirection;
     position: Point;        // relative to component origin
     label: string;
     bitWidth: number;
     isNegated: boolean;     // draw inversion bubble
     isClock: boolean;       // draw clock triangle
   }
   ```

3. **`PinDeclaration`** — the static template for a pin (used in ComponentDefinition):
   ```typescript
   interface PinDeclaration {
     direction: PinDirection;
     label: string;
     defaultBitWidth: number;
     position: Point;         // default position relative to component
     isNegatable: boolean;    // can this pin have an inversion bubble?
     isClockCapable: boolean; // can this pin be marked as clock?
   }
   ```

4. **`InverterConfig`**: per-pin inversion configuration stored in .dig files. A list of which pins have their inversion bubble active.

5. **N/S/E/W layout helpers**: functions to compute pin positions for standard component orientations (north, south, east, west face placement).

6. **`Point` type** (if not already defined): `{ x: number; y: number }`.

7. **No simulation state on Pin.** No `netId`, no `signalValue`. See Decision 6.

8. **Unit tests**: pin creation, position calculation for rotated components, InverterConfig application.

---

### Task 1.2.3 — Component Property System
**Complexity**: M
**Key output**: `src/core/properties.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/element/Keys.java`, `ref/Digital/src/main/java/de/neemann/digital/core/element/ElementAttributes.java`

1. **`PropertyType` enum**: `INT`, `STRING`, `ENUM`, `BOOLEAN`, `BIT_WIDTH`, `HEX_DATA`, `COLOR`, `LONG`, `FILE`, `ROTATION`, `INTFORMAT`

2. **`PropertyDefinition`**:
   ```typescript
   interface PropertyDefinition {
     key: string;            // "bitWidth", "label", "inputCount"
     type: PropertyType;
     label: string;          // display name for property panel
     defaultValue: PropertyValue;
     description?: string;
     enumValues?: string[];  // valid values if type is ENUM
     min?: number;           // for INT/BIT_WIDTH
     max?: number;
   }
   ```

3. **`PropertyBag`**: a validated `Map<string, PropertyValue>` with:
   - `get<T>(key: string): T` — typed access
   - `set(key: string, value: PropertyValue)` — validated write
   - `has(key: string): boolean`
   - `clone(): PropertyBag` — deep copy for undo/redo
   - `entries()` — iteration

4. **`PropertyValue` type**: `number | string | boolean | bigint | number[]` (union of valid value types)

5. **Zod schemas**: validation schemas for serialization boundaries (JSON load). Not for internal use — only at the point where external data enters the system.

6. **Unit tests**: PropertyBag CRUD, type validation, clone independence, Zod schema validation pass/fail.

---

## Wave 1.3: Interface Contracts

### Task 1.3.1 — CircuitElement Interface
**Complexity**: L
**Key output**: `src/core/element.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/element/Element.java`, `ref/Digital/src/main/java/de/neemann/digital/draw/elements/VisualElement.java`

**IMPORTANT**: Per Decision 1, CircuitElement has **no `execute()` method**. Simulation logic is in standalone flat functions.

1. **`CircuitElement` interface**:
   ```typescript
   interface CircuitElement {
     // Identity
     readonly typeId: string;         // "And", "FlipflopD", etc.
     readonly instanceId: string;     // unique per instance in a circuit

     // Visual
     position: Point;
     rotation: Rotation;              // 0, 90, 180, 270
     mirror: boolean;

     // Pins
     getPins(): readonly Pin[];

     // Properties
     getProperties(): PropertyBag;

     // Rendering (engine-agnostic — uses RenderContext, not Canvas2D)
     draw(ctx: RenderContext): void;
     getBoundingBox(): Rect;

     // Serialization
     serialize(): SerializedElement;

     // Help
     getHelpText(): string;

     // HGS attribute access (map-like for generic resolution)
     getAttribute(name: string): PropertyValue | undefined;
   }
   ```

2. **`Rotation` type**: `0 | 1 | 2 | 3` (quarter turns, matching Digital's rotation model)

3. **`Rect` type**: `{ x: number; y: number; width: number; height: number }`

4. **`SerializedElement`**: the shape of a serialized element (for JSON save/load). Type, properties, position, rotation, mirror.

5. **Engine-agnostic constraint**: The interface must work with any simulation backend. No references to specific engine types, signal arrays, or execution models. A future analog engine should be able to use the same `CircuitElement` for rendering and property editing — only the flat simulation functions would differ.

6. **Unit tests**: verify a mock element can be created, drawn, serialized/deserialized, queried for pins and properties.

---

### Task 1.3.2 — Engine Interface
**Complexity**: L
**Key output**: `src/core/engine-interface.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/Model.java`

1. **`SimulationEngine` interface** (pluggable simulation contract):
   ```typescript
   interface SimulationEngine {
     // Lifecycle
     init(circuit: CompiledCircuit): void;
     reset(): void;
     dispose(): void;

     // Execution
     step(): void;           // full propagation cycle
     microStep(): void;      // advance one gate (event-driven mode)
     runToBreak(): void;     // run until Break component fires

     // Continuous run
     start(): void;          // begin continuous simulation
     stop(): void;           // pause continuous simulation

     // State
     getState(): EngineState;

     // Signal access (Decision 2)
     getSignalRaw(netId: number): number;           // non-allocating, for rendering
     getSignalValue(netId: number): BitVector;       // allocating, for UI panels
     setSignalValue(netId: number, value: BitVector): void;  // for interactive inputs

     // Observation
     addChangeListener(listener: EngineChangeListener): void;
     removeChangeListener(listener: EngineChangeListener): void;
   }
   ```

2. **`EngineState` enum**: `STOPPED`, `RUNNING`, `PAUSED`, `ERROR`

3. **`EngineChangeListener`**: callback for state changes (for UI updates)

4. **`CompiledCircuit`**: the input to `init()` — produced by the compiler (Phase 3). Define as an opaque interface here; Phase 3 implements it.

5. **Web Worker compatibility**:
   - No DOM references in this interface
   - Signal state backed by `SharedArrayBuffer`-compatible typed arrays
   - Control via message-passable commands
   - Define `EngineMessage` types for Worker communication: `{ type: 'step' }`, `{ type: 'start' }`, `{ type: 'stop' }`, `{ type: 'setSignal', netId, value }`, etc.

6. **Unit tests**: verify mock engine implements the interface correctly, state transitions are valid.

---

### Task 1.3.3 — Renderer Interface
**Complexity**: L
**Key output**: `src/core/renderer-interface.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/draw/graphics/Graphic.java`, `ref/Digital/src/main/java/de/neemann/digital/draw/graphics/Style.java`

1. **`RenderContext` interface** (drawing context abstraction):
   ```typescript
   interface RenderContext {
     // Primitives
     drawLine(x1: number, y1: number, x2: number, y2: number): void;
     drawRect(x: number, y: number, width: number, height: number, filled: boolean): void;
     drawCircle(cx: number, cy: number, radius: number, filled: boolean): void;
     drawArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): void;
     drawPolygon(points: readonly Point[], filled: boolean): void;
     drawPath(path: PathData): void;
     drawText(text: string, x: number, y: number, anchor: TextAnchor): void;

     // Transform stack
     save(): void;
     restore(): void;
     translate(dx: number, dy: number): void;
     rotate(angle: number): void;
     scale(sx: number, sy: number): void;

     // Style
     setColor(color: ThemeColor): void;
     setLineWidth(width: number): void;
     setFont(font: FontSpec): void;
     setLineDash(pattern: number[]): void;
   }
   ```

2. **`ThemeColor`**: semantic color names (not raw hex). E.g., `WIRE`, `WIRE_HIGH`, `WIRE_LOW`, `WIRE_Z`, `WIRE_UNDEFINED`, `COMPONENT`, `COMPONENT_FILL`, `PIN`, `TEXT`, `GRID`, `BACKGROUND`, `SELECTION`. The color scheme maps these to actual colors.

3. **`ColorScheme` interface**: maps `ThemeColor` → CSS color string. Built-in schemes: default, high contrast, monochrome. Switchable at runtime.

4. **`FontSpec`**: `{ family: string; size: number; weight?: 'normal' | 'bold'; style?: 'normal' | 'italic' }`

5. **`TextAnchor`**: `{ horizontal: 'left' | 'center' | 'right'; vertical: 'top' | 'middle' | 'bottom' }`

6. **`PathData`**: a path description type (moveTo, lineTo, curveTo, closePath operations).

7. **Coordinate types**: `Point` (`{ x, y }`), `Rect` (`{ x, y, width, height }`), `Transform` (2D affine matrix).

8. **Unit tests**: verify all method signatures are callable, ThemeColor enum is complete, ColorScheme can be constructed.

---

### Task 1.3.4 — Circuit Model and Component Registry
**Complexity**: L
**Key output**: `src/core/circuit.ts`, `src/core/registry.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/draw/elements/Circuit.java`, `ref/Digital/src/main/java/de/neemann/digital/draw/library/ElementLibrary.java`

**IMPORTANT**: Per Decision 3, this is the **visual model only**. No simulation state.

1. **`Circuit` class** (visual model):
   ```typescript
   class Circuit {
     elements: CircuitElement[];
     wires: Wire[];
     metadata: CircuitMetadata;

     addElement(element: CircuitElement): void;
     removeElement(element: CircuitElement): void;
     addWire(wire: Wire): void;
     removeWire(wire: Wire): void;
     getElementsAt(point: Point): CircuitElement[];
   }
   ```

2. **`Wire` class** (visual wire segments):
   - Start point, end point (grid coordinates)
   - No `netId` — the compiler assigns that (Decision 3)
   - No signal value

3. **`Net` class** (visual net — connected pins):
   - A set of pins that are electrically connected (determined by wire tracing)
   - No signal value, no net ID
   - Built by the compiler or a visual net-tracer for the editor

4. **`CircuitMetadata`**: name, description, test data references, measurement ordering, `isGeneric` flag.

5. **`ComponentRegistry`** (`src/core/registry.ts`):
   ```typescript
   class ComponentRegistry {
     register(def: ComponentDefinition): void;
     get(name: string): ComponentDefinition | undefined;
     getAll(): ComponentDefinition[];
     getByCategory(category: ComponentCategory): ComponentDefinition[];
   }
   ```

6. **`ComponentDefinition`** (per Decision 4):
   ```typescript
   interface ComponentDefinition {
     name: string;
     typeId: number;                    // auto-assigned by register()
     factory: (props: PropertyBag) => CircuitElement;
     executeFn: ExecuteFunction;
     pinLayout: PinDeclaration[];
     propertyDefs: PropertyDefinition[];
     attributeMap: AttributeMapping[];
     category: ComponentCategory;
     helpText: string;
   }
   ```

7. **`ExecuteFunction` type**: `(index: number, state: Uint32Array, layout: ComponentLayout) => void`

8. **`ComponentLayout`**: the engine's wiring info for a component instance (input/output offsets into the state array). Defined here as a type; Phase 3 implements the actual layout computation.

9. **`ComponentCategory` enum**: `LOGIC`, `IO`, `FLIP_FLOPS`, `MEMORY`, `ARITHMETIC`, `WIRING`, `SWITCHING`, `PLD`, `MISC`, `GRAPHICS`, `TERMINAL`, `74XX`

10. **`AttributeMapping`** (per Decision 5):
    ```typescript
    interface AttributeMapping {
      xmlName: string;
      propertyKey: string;
      convert: (xmlValue: string) => PropertyValue;
    }
    ```

11. **Unit tests**: registry CRUD, auto-assigned type IDs increment, lookup by name, lookup by category, circuit element add/remove.

---

### Task 1.3.5 — Error Type Taxonomy
**Complexity**: M
**Key output**: `src/core/errors.ts`
**Java reference**: `ref/Digital/src/main/java/de/neemann/digital/core/NodeException.java`, `ref/Digital/src/main/java/de/neemann/digital/core/element/PinException.java`, `ref/Digital/src/main/java/de/neemann/digital/draw/model/Net.java` (BurnException)

1. **`SimulationError`** (base class):
   ```typescript
   class SimulationError extends Error {
     readonly componentId?: string;
     readonly netId?: number;
   }
   ```

2. **Specific error types** (all extend `SimulationError`):
   - `BurnException` — shorted outputs / conflicting drivers on a net
   - `BacktrackException` — switching network initialization failure
   - `BitsException` — bit-width mismatch between connected pins
   - `NodeException` — component evaluation error
   - `PinException` — unconnected/misconfigured pin

3. Each error carries **context** for user-facing diagnostics: which component, which net, what the expected vs actual state was.

4. **Unit tests**: each error type can be constructed, has the correct name, carries context fields, is an instance of both its own type and `SimulationError`.

---

## Verification Criteria (Phase 1)

All of these must pass before the author review checkpoint:

- `npm run typecheck` (`tsc --noEmit`) passes with zero errors
- `npm test` (Vitest) runs and all tests pass
- `npm run build` (Vite) produces static output in `dist/`
- Mock RenderContext records draw calls correctly
- Mock engine implements the full SimulationEngine interface
- `BitVector` ↔ `Uint32Array` raw conversion round-trips correctly
- All error types are well-formed and extend `SimulationError`
- No simulation state on `CircuitElement`, `Pin`, `Wire`, or `Net`
- ComponentRegistry auto-assigns type IDs
- All types are exported and importable from their respective modules
