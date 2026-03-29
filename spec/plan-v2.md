# Implementation Plan — Model System Unification v2

## Spec
`spec/model-unification-v2.md`

## Execution Model

Waves 1, 2, 3, 5, and 7 are **parallel** — they run concurrently after Wave 0 completes. Wave 4 depends on 2 + 3. Wave 6 depends on 5.

**Important for executing agents:** During parallel waves, other agents are making changes to the same codebase simultaneously. Expect unrelated test failures from other agents' in-progress work. **Run only targeted tests for your own changes** (e.g., `npx vitest run src/core/__tests__/pin.test.ts`). Do NOT run the full test suite — the coordinator runs `npm run test:q` between full waves to verify integration.

**Coordinator checkpoints:**
- After Wave 0: `npm run test:q` (must pass — foundational types)
- After Waves 1+2+3+5+7 all complete: `npm run test:q` + `npx playwright test` (full suite)
- After Wave 4: `npm run test:q` (compiler rewrite)
- After Wave 6: `npm run test:q` + `npx playwright test` (final)

## Wave Dependency Graph

```
Wave 0 (sequential, solo)
  ├→ Wave 1 (parallel)  ──────────────────────┐
  ├→ Wave 2 (parallel)  ──────────────────┐   │
  ├→ Wave 3 (parallel)  ──────────────┐   │   │
  ├→ Wave 5 (parallel)  ──────────┐   │   │   │
  └→ Wave 7 (parallel)            │   │   │   │
                                   │   │   │   │
                         coordinator checkpoint
                                   │   │   │   │
                                   │   ├───┘   │
                                   │   v       │
                                   │  Wave 4 ──┘
                                   │   │
                                   v   v
                                  Wave 6
                                    │
                              final checkpoint
```

## Wave 0: Foundation Types (sequential, must complete first)

**Risk:** Low — additive type changes only, no logic changes
**Targeted tests:** `npx vitest run src/core/__tests__/registry.test.ts src/compile/__tests__/compile-integration.test.ts`

### W0.1 (S): `MnaSubcircuitNetlist` type
- Create `src/core/mna-subcircuit-netlist.ts`
- Define `MnaSubcircuitNetlist` and `SubcircuitElement` interfaces per spec
- Export from `src/core/mna-subcircuit-netlist.ts`

### W0.2 (S): `PinDeclaration.kind` required field
- In `src/core/pin.ts`, add `kind: "signal" | "power"` to `PinDeclaration` (required, not optional)
- TypeScript will flag every existing declaration missing `kind` — that's intentional, fixed in Wave 2

### W0.3 (S): `MnaModel` updates in `src/core/registry.ts`
- `factory` becomes required (remove `?`)
- Delete `subcircuitModel` field
- Replace `requiresBranchRow?: boolean` with `branchCount?: number`
- Add `subcircuitRefs?: Record<string, string>` to `ComponentDefinition`

### W0.4 (S): `CircuitMetadata` updates
- In `src/core/circuit.ts`, add `subcircuitBindings?: Record<string, string>` to `CircuitMetadata`

### W0.5 (S): `DiagnosticCode` addition
- In `src/compile/types.ts`, add `| 'unresolved-model-ref'` to the `DiagnosticCode` union

---

## Wave 1: Registry Rename + Code Health (parallel with 2, 3, 5, 7)

**Risk:** Low — mechanical renames and deletes
**Targeted tests:** `npx vitest run src/solver/analog/__tests__/transistor-expansion.test.ts src/solver/analog/__tests__/darlington.test.ts src/solver/analog/__tests__/cmos-gates.test.ts`
**Expect failures from:** Wave 2 (pin kind), Wave 3 (CMOS migration) — ignore, run only your targeted tests

### W1.1 (M): Rename `TransistorModelRegistry` → `SubcircuitModelRegistry`
- Rename file `src/solver/analog/transistor-model-registry.ts` → `subcircuit-model-registry.ts`
- Rename class `TransistorModelRegistry` → `SubcircuitModelRegistry`
- Rename `registerAllCmosGateModels()` → `registerBuiltinSubcircuitModels()`
- Update all imports and references (24 files per codebase grep)

### W1.2 (S): Code health — delete shims and dead code
- Delete `src/editor/wire-merge.ts`, update consumers to import from `@/core/wire-utils`
- Delete `src/editor/pin-voltage-access.ts`, update consumers to import from `../core/pin-voltage-access.js`
- Delete `AnalogScopePanel` alias in `src/runtime/analog-scope-panel.ts:746`, update consumers to `ScopePanel`
- Delete `parseSplittingPattern` in `src/components/wiring/splitter.ts:103`, fix any callers
- Delete `show()` overload in `src/editor/context-menu.ts:96`, update callers to `showItems()`
- Delete DeviceType re-export in `src/solver/analog/model-parser.ts:14-17`, update consumers to import from `core/analog-types.ts`
- Remove `it.skip` from `src/fixtures/__tests__/shape-audit.test.ts:150` and `src/fixtures/__tests__/fixture-audit.test.ts:225`

---

## Wave 2: Pin System + Digital Compiler (parallel with 1, 3, 5, 7)

**Risk:** Medium — touches every component declaration
**Targeted tests:** `npx vitest run src/core/__tests__/pin.test.ts src/solver/digital/__tests__/ src/components/gates/__tests__/`
**Expect failures from:** Wave 1 (renames), Wave 3 (CMOS model changes) — ignore, run only your targeted tests

### W2.1 (L): Add `kind: "signal"` to all existing PinDeclarations
- Every component file with `PinDeclaration` arrays: add `kind: "signal"` to each entry
- This is mechanical — the TypeScript compiler will flag every missing declaration after W0.2

### W2.2 (M): Gate + D-FF `getPins()` adds power pins
- 8 gate files (`and.ts`, `or.ts`, `nand.ts`, `nor.ts`, `xor.ts`, `xnor.ts`, `not.ts`, + buffer if exists) + `src/components/flipflops/d.ts`
- When active model key is in `subcircuitRefs`, append VDD and GND pins with `kind: "power"`
- Positions are per-component, hardcoded based on each component's body geometry
- Update `src/components/gates/gate-shared.ts` if shared helpers are useful

### W2.3 (M): Digital compiler filters power pins
- In `src/solver/digital/compiler.ts`, pin-to-slot matching: filter on `pinDecl.kind === "signal"`
- Wires connected to power pins in digital mode are silently ignored
- Test: compile a gate with power pins in digital mode → schema pin count unchanged

---

## Wave 3: CMOS Model Migration (parallel with 1, 2, 5, 7)

**Risk:** Medium — changes model representation
**Targeted tests:** `npx vitest run src/solver/analog/__tests__/cmos-gates.test.ts src/solver/analog/__tests__/cmos-flipflop.test.ts src/solver/analog/__tests__/darlington.test.ts`
**Expect failures from:** Wave 1 (registry rename) — ignore, run only your targeted tests

### W3.1 (M): Migrate `cmos-gates.ts` to produce `MnaSubcircuitNetlist`
- `src/solver/analog/transistor-models/cmos-gates.ts` currently returns `Circuit` objects
- Rewrite each gate builder to produce `MnaSubcircuitNetlist` (ports + elements + netlist arrays)
- Each transistor element gets a `modelRef` (e.g., `"NMOS_DEFAULT"`, `"PMOS_DEFAULT"`)
- Register default `.MODEL` parameter sets in `namedParameterSets`

### W3.2 (M): Migrate `cmos-flipflop.ts` and `darlington.ts`
- Same conversion: `Circuit` objects → `MnaSubcircuitNetlist`
- `darlington.ts` produces Darlington pair netlists with BJT model refs

### W3.3 (M): Update component declarations
- All gate files + D-FF: replace `cmos: { subcircuitModel: "CmosAnd2" }` with nothing in `mnaModels`, add `subcircuitRefs: { cmos: "CmosAnd2" }` on `ComponentDefinition`
- Remove all `subcircuitModel` references from component files

---

## Wave 4: Compiler Rewrite (after 2 + 3 complete)

**Risk:** High — core compiler changes
**Targeted tests:** `npx vitest run src/solver/analog/__tests__/analog-compiler.test.ts src/solver/analog/__tests__/compile-analog-partition.test.ts src/solver/analog/__tests__/transistor-expansion.test.ts`
**Prerequisite:** Waves 2 and 3 must be complete and passing. Coordinator runs full test suite before starting this wave.

### W4.1 (L): `resolveSubcircuitModels` post-partition step
- Implement `resolveSubcircuitModels()` per spec: iterate partition components, resolve `subcircuitRefs` + `subcircuitBindings`, replace `pc.model` with compiled `MnaModel`
- Implement `compileSubcircuitToMnaModel()`: 5-layer parameter resolution, composite `AnalogElementCore` factory
- Wire into `compileAnalogPartition()` between partitioning and Pass A

### W4.2 (M): Remove `expand` route
- Delete `kind: 'expand'` from `ComponentRoute`
- Remove the `expand` case from Pass A and Pass B switch statements
- Remove `expandTransistorModel()` calls from the compiler (logic moves into composite factory)

### W4.3 (M): Remove implicit VDD/GND
- Delete `vddNodeId` / `vddBranchIdx` lazy allocation
- Delete `makeVddSource()` and its invocation
- Delete circuit-wide VDD voltage from logic family
- VDD/GND now flow through regular pin nodes

### W4.4 (M): Pass A branch allocation update
- Read `branchCount` from `MnaModel` (default 0) instead of `requiresBranchRow`
- Allocate that many sequential branch indices per component
- Factory receives base index, owns `branchCount` sequential indices

### W4.5 (M): Update compiler tests
- All existing expansion tests rewritten for composite factory path
- New test: two gates at different VDD voltages → different output levels
- New test: unresolved `modelRef` → `unresolved-model-ref` diagnostic
- New test: `subcircuitBindings` override merges with static `subcircuitRefs`

---

## Wave 5: Serialization (parallel with 1, 2, 3, 7)

**Risk:** Medium — format changes
**Targeted tests:** `npx vitest run src/io/__tests__/dts-model-roundtrip.test.ts src/io/__tests__/dts-schema.test.ts`
**Expect failures from:** Wave 1 (registry rename), Wave 3 (model type changes) — ignore, run only your targeted tests

### W5.1 (M): DTS schema + serializer/deserializer
- `src/io/dts-schema.ts`: `modelDefinitions` validates as `MnaSubcircuitNetlist` (not `DtsCircuit`)
- `src/io/dts-serializer.ts`: serialize `SubcircuitModelRegistry` → `modelDefinitions`, `ModelLibrary` → `namedParameterSets`, `CircuitMetadata.subcircuitBindings` → `subcircuitBindings`
- `src/io/dts-deserializer.ts`: deserialize and populate registry + library + metadata

### W5.3 (M): Round-trip tests
- Save circuit with imported models → load → verify registry and library populated
- Save circuit with `subcircuitBindings` → load → verify bindings restored

---

## Wave 6: SPICE Apply + Model Library Dialog (after 5 completes)

**Risk:** Medium — UI + function signature changes
**Targeted tests:** `npx vitest run src/solver/analog/__tests__/spice-import-dialog.test.ts src/solver/analog/__tests__/spice-subckt-dialog.test.ts src/solver/analog/__tests__/spice-model-library.test.ts`
**Prerequisite:** Wave 5 must be complete (serialization format finalized).

### W6.1 (M): `applySpiceImportResult` + `applySpiceSubcktImportResult` signature change
- Add `circuit: Circuit` parameter to both functions in `src/app/spice-model-apply.ts`
- `applySpiceImportResult`: write to `circuit.metadata.namedParameterSets` (library-level) AND keep `_spiceModelOverrides` on element (per-instance). Both coexist.
- `applySpiceSubcktImportResult`: write to `circuit.metadata.modelDefinitions`
- Update call sites: `src/app/menu-toolbar.ts:382`, `src/app/menu-toolbar.ts:407` (pass circuit from enclosing scope)
- Update all test call sites

### W6.2 (M): SPICE import context menu move
- Move SPICE import wiring from `src/app/menu-toolbar.ts` to `src/app/canvas-popup.ts` per v1 spec

### W6.3 (M): Model library dialog updates
- `src/app/spice-model-library-dialog.ts`: subcircuit tab shows `MnaSubcircuitNetlist` format
- Add "Assign to component type" action: writes to `circuit.metadata.subcircuitBindings`
- Unresolved model refs highlighted in subcircuit list

---

## Wave 7: v1 Outstanding Test Fixes (parallel with 1, 2, 3, 5)

**Risk:** Low — test-only changes
**Targeted tests:** Run each file individually after fixing it
**Expect failures from:** All other parallel waves — ignore, run only the specific test file you're fixing

### W7.1 (M): Weak test assertions — replace with specific values
- 26 instances across 9 files (see spec "Weak test assertions" table)
- For each: run the test, capture the current correct output, replace weak assertion with exact value
- Files: `digital-pin-loading-mcp.test.ts`, `spice-model-overrides-mcp.test.ts`, `behavioral-combinational.test.ts`, `behavioral-flipflop.test.ts`, `behavioral-sequential.test.ts`, `pin-loading-menu.test.ts`, `analog-compiler.test.ts`, `diag-rc-step.test.ts`, SPICE test files

### W7.2 (M): Missing three-surface tests
- E2E test for pin loading menu affecting simulation behavior
- MCP test for `circuit_describe` reflecting named models
- MCP surface test for SPICE import: parsed `.MODEL` → patch → compile round-trip

---

## Verification Measures

1. `npm run test:q` — all unit/integration tests pass
2. `npx playwright test` — all E2E tests pass
3. `grep -r "subcircuitModel" src/` returns zero hits (after Wave 3 + 4)
4. `grep -r "requiresBranchRow" src/` returns zero hits (after Wave 4)
5. `grep -r "TransistorModelRegistry" src/` returns zero hits (after Wave 1)
6. `grep -r "makeVddSource" src/` returns zero hits (after Wave 4)
7. `grep -r "expandTransistorModel" src/` in compiler returns zero hits (after Wave 4)
8. No `DtsCircuit` references in `modelDefinitions` schema (after Wave 5)
