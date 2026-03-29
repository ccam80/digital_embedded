# Review Report: Recheck — Serialization + SPICE Area (Waves 5, 6, 7 violations)

## Summary

- **Scope**: Post-fix recheck of all violations reported against Waves 5, 6, and 7
- **Tasks reviewed**: All items listed in the assignment checklist
- **Violations found**: 9
- **Gaps found**: 0
- **Weak tests found**: 26
- **Legacy references found**: 3
- **Verdict**: `has-violations`

---

## Violations

### V-1 — `transistorModels` parameter name survives in `src/compile/compile.ts`

- **File**: `src/compile/compile.ts`, lines 50 and 56
- **Rule violated**: Spec requirement — parameter must be named `subcircuitModels`, not `transistorModels`. The v2 spec (section "Rename TransistorModelRegistry to SubcircuitModelRegistry") requires all references to be renamed. The parameter name is part of the public API contract.
- **Evidence** (line 50): `@param transistorModels  Optional transistor model registry for analog BJT/MOSFET.`
- **Evidence** (line 56): `transistorModels?: SubcircuitModelRegistry,`
- **Severity**: major

### V-2 — `transistorModels` parameter name survives in `src/solver/analog/compiler.ts`

- **File**: `src/solver/analog/compiler.ts`, lines 95, 1049, and 1100
- **Rule violated**: Same as V-1 — `transistorModels` must be renamed to `subcircuitModels` everywhere.
- **Evidence** (line 95): `transistorModels: SubcircuitModelRegistry | undefined,`
- **Evidence** (line 1049): `transistorModels?: SubcircuitModelRegistry,`
- **Evidence** (line 1100): `resolveSubcircuitModels(partition, transistorModels, ...)`
- **Severity**: major

### V-3 — Stale JSDoc in `src/compile/compile.ts` describes old transistor-specific terminology

- **File**: `src/compile/compile.ts`, line 50
- **Rule violated**: Historical-provenance comment ban (rules.md: "No historical-provenance comments"). The JSDoc says "Optional transistor model registry for analog BJT/MOSFET" — this describes the old transistor-specific purpose. After renaming to SubcircuitModelRegistry the description is stale.
- **Evidence**: `@param transistorModels  Optional transistor model registry for analog BJT/MOSFET.`
- **Severity**: minor

### V-4 — Stale section comment in `src/io/__tests__/dts-model-roundtrip.test.ts` names old parameter

- **File**: `src/io/__tests__/dts-model-roundtrip.test.ts`, line 287
- **Rule violated**: Historical-provenance comment ban. The comment describes the old API parameter name as a historical label.
- **Evidence**: `// serializeCircuit with transistorModels parameter`
- The `describe` block immediately below (line 290) correctly uses `subcircuitModels`, making this comment stale provenance.
- **Severity**: minor

### V-5 — Hollow netlist in `spice-model-library.test.ts` helper function

- **File**: `src/solver/analog/__tests__/spice-model-library.test.ts`, lines 61–62
- **Rule violated**: The review assignment explicitly flags `internalNetCount: 0` with `netlist: elements.map(() => [])` as hollow netlists. The `addSubcktDefinition` helper always produces zero internal nodes and empty pin lists for every element, regardless of actual SUBCKT topology.
- **Evidence** (lines 61–62):
  - `internalNetCount: 0,`
  - `netlist: parsed.elements.map(() => []),`
- **Severity**: major

### V-6 — Hollow netlist in `src/solver/analog/transistor-models/cmos-gates.ts`

- **File**: `src/solver/analog/transistor-models/cmos-gates.ts`, line 37
- **Rule violated**: Same as V-5 but in production code. A CMOS gate has internal nets between PMOS and NMOS stages; `internalNetCount: 0` means the compiler allocates no internal nodes, making composite factory stamping impossible to implement correctly.
- **Evidence** (line 37): `internalNetCount: 0,`
- **Severity**: critical

### V-7 — "for now" comment in `src/io/dig-serializer.ts`

- **File**: `src/io/dig-serializer.ts`, line 156
- **Rule violated**: `reviewer.md` red-flag list explicitly includes "for now" as a banned phrase — signals deferred work.
- **Evidence**: `// Custom shapes are complex; preserve as empty for now`
- **Severity**: minor

### V-8 — Weak `toBeDefined()` on `bridge.compiledInner` in `analog-compiler.test.ts`

- **File**: `src/solver/analog/__tests__/analog-compiler.test.ts`, line 508
- **Rule violated**: Weak assertion. The spec "Weak test assertions" table lists `analog-compiler.test.ts` with 2 `toBeDefined()` guards to remove. This instance verifies only existence, not the compiled inner engine properties.
- **Evidence**: `expect(bridge.compiledInner).toBeDefined();`
- **Severity**: major

### V-9 — Redundant `not.toBeNull()` guard on `unified.analog` in `diag-rc-step.test.ts`

- **File**: `src/__tests__/diag-rc-step.test.ts`, line 54
- **Rule violated**: The spec "Weak test assertions" table explicitly lists `diag-rc-step.test.ts` `not.toBeNull` to fix. Line 55 has the correct exact check `expect(unified.analog!.elements.length).toBe(3)`, making line 54 a redundant weak guard that was supposed to be deleted.
- **Evidence**: `expect(unified.analog).not.toBeNull();`
- **Severity**: minor

---

## Gaps

None found.

---

## Weak Tests

### WT-1 — `behavioral-combinational.test.ts::Registration::mux_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts::Registration::mux_has_analog_factory`
- **Problem**: `toBeDefined()` on `models?.digital` and `mnaModels?.behavioral` not replaced with structural assertions. Line 349 adds `typeof factory === "function"` (partial fix) but lines 347–348 remain as weak guards.
- **Evidence**:
  - `expect(MuxDefinition.models?.digital).toBeDefined();` (line 347)
  - `expect(MuxDefinition.models?.mnaModels?.behavioral).toBeDefined();` (line 348)

### WT-2 — `behavioral-combinational.test.ts::Registration::demux_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts::Registration::demux_has_analog_factory`
- **Problem**: `toBeDefined()` guards not replaced.
- **Evidence**:
  - `expect(DemuxDefinition.models?.digital).toBeDefined();`
  - `expect(DemuxDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-3 — `behavioral-combinational.test.ts::Registration::decoder_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts::Registration::decoder_has_analog_factory`
- **Problem**: Same pattern — `toBeDefined()` guards remain.
- **Evidence**:
  - `expect(DecoderDefinition.models?.digital).toBeDefined();`
  - `expect(DecoderDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-4 — `behavioral-flipflop.test.ts::Registration::d_flipflop_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-flipflop.test.ts::Registration::d_flipflop_has_analog_factory`
- **Problem**: `toBeDefined()` on factory property before the `typeof === "function"` check — redundant weak guard not removed.
- **Evidence**: `expect(DDefinition.models?.mnaModels?.behavioral?.factory).toBeDefined();`

### WT-5 — `behavioral-flipflop.test.ts::Registration::d_flipflop_engine_type_is_both`

- **Path**: `src/solver/analog/__tests__/behavioral-flipflop.test.ts::Registration::d_flipflop_engine_type_is_both`
- **Problem**: `toBeDefined()` assertions not replaced with structural checks.
- **Evidence**:
  - `expect(DDefinition.models?.digital).toBeDefined();`
  - `expect(DDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-6 — `behavioral-flipflop.test.ts::Registration::d_flipflop_simulation_modes_include_digital_and_simplified`

- **Path**: `src/solver/analog/__tests__/behavioral-flipflop.test.ts::Registration::d_flipflop_simulation_modes_include_digital_and_simplified`
- **Problem**: `toBeDefined()` assertions not replaced.
- **Evidence**:
  - `expect(DDefinition.models?.digital).toBeDefined();`
  - `expect(DDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-7 — `behavioral-sequential.test.ts::Registration::counter_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::counter_has_analog_factory`
- **Problem**: `toBeDefined()` on `behavioral` not replaced with structural assertion.
- **Evidence**: `expect(CounterDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-8 — `behavioral-sequential.test.ts::Registration::counter_engine_type_is_both`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::counter_engine_type_is_both`
- **Problem**: `toBeDefined()` not replaced.
- **Evidence**:
  - `expect(CounterDefinition.models?.digital).toBeDefined();`
  - `expect(CounterDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-9 — `behavioral-sequential.test.ts::Registration::counter_simulation_modes_include_digital_and_simplified`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::counter_simulation_modes_include_digital_and_simplified`
- **Problem**: `toBeDefined()` not replaced.
- **Evidence**:
  - `expect(CounterDefinition.models?.digital).toBeDefined();`
  - `expect(CounterDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-10 — `behavioral-sequential.test.ts::Registration::counter_preset_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::counter_preset_has_analog_factory`
- **Problem**: `toBeDefined()` on `behavioral` remains.
- **Evidence**: `expect(CounterPresetDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-11 — `behavioral-sequential.test.ts::Registration::counter_preset_engine_type_is_both`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::counter_preset_engine_type_is_both`
- **Problem**: `toBeDefined()` not replaced.
- **Evidence**:
  - `expect(CounterPresetDefinition.models?.digital).toBeDefined();`
  - `expect(CounterPresetDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-12 — `behavioral-sequential.test.ts::Registration::register_has_analog_factory`

- **Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts::Registration::register_has_analog_factory`
- **Problem**: `toBeDefined()` on `behavioral` remains.
- **Evidence**: `expect(RegisterDefinition.models?.mnaModels?.behavioral).toBeDefined();`

### WT-13 — `pin-loading-menu.test.ts` — `not.toBeNull()` on `result.analog` (line 362)

- **Path**: `src/compile/__tests__/pin-loading-menu.test.ts`
- **Problem**: `not.toBeNull()` does not assert partition content. Line 363 already checks `result.analog!.elements.toHaveLength(1)`, making the null guard a redundant weak assertion not removed.
- **Evidence**: `expect(result.analog).not.toBeNull();`

### WT-14 — `spice-model-overrides-mcp.test.ts` — first `not.toBeNull()` pair (lines 124–125)

- **Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts`
- **Problem**: Spec lists 2 `not.toBeNull` pairs in this file to replace with "assert compiled structure". First pair remains. Verifies only that compilation succeeded, not element counts, voltages, or DC operating point values.
- **Evidence**:
  - `expect(compiledDefault).not.toBeNull();` (line 124)
  - `expect(compiledDefault!.analog).not.toBeNull();` (line 125)

### WT-15 — `spice-model-overrides-mcp.test.ts` — second `not.toBeNull()` pair (lines 145–146)

- **Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts`
- **Problem**: Second not-null pair not replaced.
- **Evidence**:
  - `expect(compiledOverridden).not.toBeNull();` (line 145)
  - `expect(compiledOverridden!.analog).not.toBeNull();` (line 146)

### WT-16 — `digital-pin-loading-mcp.test.ts` — `not.toBeNull()` + `toBeGreaterThan(0)` (lines 115, 123)

- **Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- **Problem**: Spec says "assert exact adapter counts and parameter values". For a deterministic 2-input And gate circuit the adapter count is a fixed number. `toBeGreaterThan(0)` accepts any non-zero count.
- **Evidence**:
  - `expect(compiled).not.toBeNull();` (line 115)
  - `expect(totalAdapters).toBeGreaterThan(0);` (line 123)

### WT-17 — `digital-pin-loading-mcp.test.ts` — `not.toBeNull()` pair (lines 162–163)

- **Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- **Problem**: Weak null guards not replaced with structural assertions on bridge count or adapter parameter values.
- **Evidence**:
  - `expect(compiled).not.toBeNull();` (line 162)
  - `expect(compiled!.analog).not.toBeNull();` (line 163)

### WT-18 — `digital-pin-loading-mcp.test.ts` — `not.toBeNull()` pair (lines 178–179)

- **Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- **Problem**: Same as WT-17.
- **Evidence**:
  - `expect(compiled).not.toBeNull();` (line 178)
  - `expect(compiled!.analog).not.toBeNull();` (line 179)

### WT-19 — `digital-pin-loading-mcp.test.ts` — `not.toBeNull()` pair (lines 194–195)

- **Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- **Problem**: Same as WT-17.
- **Evidence**:
  - `expect(compiled).not.toBeNull();` (line 194)
  - `expect(compiled!.analog).not.toBeNull();` (line 195)

### WT-20 — `dts-model-roundtrip.test.ts` — `toBeDefined()` on `namedParameterSets` (line 69)

- **Path**: `src/io/__tests__/dts-model-roundtrip.test.ts`
- **Problem**: Weak existence check; does not verify the contents of the deserialized parameter sets.
- **Evidence**: `expect(restored.metadata.namedParameterSets).toBeDefined();`

### WT-21 — `dts-model-roundtrip.test.ts` — `toBeDefined()` on model entries (lines 91, 96)

- **Path**: `src/io/__tests__/dts-model-roundtrip.test.ts`
- **Problem**: `toBeDefined()` on individual model entries does not verify param content; these were supposed to be replaced with specific value assertions.
- **Evidence**:
  - `expect(model4148).toBeDefined();` (line 91)
  - `expect(model2222).toBeDefined();` (line 96)

### WT-22 — `dts-model-roundtrip.test.ts` — `toBeDefined()` on `modelDefinitions` (lines 161, 203)

- **Path**: `src/io/__tests__/dts-model-roundtrip.test.ts`
- **Problem**: Weak existence checks on `restored.metadata.modelDefinitions` without verifying ports, elements, or netlist content.
- **Evidence**:
  - `expect(restored.metadata.modelDefinitions).toBeDefined();` (line 161)
  - `expect(restored.metadata.modelDefinitions).toBeDefined();` (line 203)

### WT-23 — `dts-model-roundtrip.test.ts` — `toBeDefined()` on `modelLibrary.get()` (line 280)

- **Path**: `src/io/__tests__/dts-model-roundtrip.test.ts`
- **Problem**: Existence guard redundant — line 281 checks `.type` so the `toBeDefined()` on line 280 adds nothing.
- **Evidence**: `expect(modelLibrary.get("1N4148")).toBeDefined();`

### WT-24 — `spice-model-library.test.ts` — multiple `toBeDefined()` weak guards (lines 81, 82, 110, 152, 153, 168, 249, 250, 324)

- **Path**: `src/solver/analog/__tests__/spice-model-library.test.ts`
- **Problem**: Nine `toBeDefined()` assertions used as weak existence guards. In most cases content is checked on following lines making these guards purely redundant; in some cases no content follow-up exists at all.
- **Evidence**:
  - `expect(sets).toBeDefined();` (line 81)
  - `expect(sets!["2N2222"]).toBeDefined();` (line 82)
  - `expect(sets["BC547"]).toBeDefined();` (line 110)
  - `expect(defs).toBeDefined();` (line 152)
  - `expect(defs!["MYBJT"]).toBeDefined();` (line 153)
  - `expect(registry.get("RDIV")).toBeDefined();` (line 168)
  - `expect(circuit.metadata.namedParameterSets!["2N2222"]).toBeDefined();` (line 249)
  - `expect(circuit.metadata.modelDefinitions!["RDIV"]).toBeDefined();` (line 250)
  - `expect(netlist).toBeDefined();` (line 324)

### WT-25 — `spice-subckt-dialog.test.ts` — `toBeDefined()` weak guards (lines 226, 291, 311, 312)

- **Path**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts`
- **Problem**: `toBeDefined()` existence checks not replaced with structural assertions. Lines 226 and 291 are followed by content checks making them redundant. Lines 311–312 have no content follow-up at all.
- **Evidence**:
  - `expect(stored).toBeDefined();` (line 226)
  - `expect(stored).toBeDefined();` (line 291)
  - `expect(defs).toBeDefined();` (line 311)
  - `expect(defs!["MYBJT"]).toBeDefined();` (line 312)

### WT-26 — `analog-compiler.test.ts` — `toBeDefined()` on `bridge.compiledInner` (line 508)

- **Path**: `src/solver/analog/__tests__/analog-compiler.test.ts`
- **Problem**: Existence-only check; does not verify any property of the compiled inner engine (element count, node count, matrix size).
- **Evidence**: `expect(bridge.compiledInner).toBeDefined();`

---

## Legacy References

### LR-1 — `transistorModels` parameter name in `src/compile/compile.ts`

- **File**: `src/compile/compile.ts`, lines 50 and 56
- **Stale reference**: `transistorModels` — the pre-rename parameter name that should be `subcircuitModels`.
- **Evidence**:
  - `@param transistorModels  Optional transistor model registry for analog BJT/MOSFET.` (line 50)
  - `transistorModels?: SubcircuitModelRegistry,` (line 56)

### LR-2 — `transistorModels` parameter name in `src/solver/analog/compiler.ts`

- **File**: `src/solver/analog/compiler.ts`, lines 95, 1049, 1100
- **Stale reference**: `transistorModels` — old name used as both parameter name and call-site argument.
- **Evidence**:
  - `transistorModels: SubcircuitModelRegistry | undefined,` (line 95)
  - `transistorModels?: SubcircuitModelRegistry,` (line 1049)
  - `resolveSubcircuitModels(partition, transistorModels, ...)` (line 1100)

### LR-3 — Section comment naming old API in `src/io/__tests__/dts-model-roundtrip.test.ts`

- **File**: `src/io/__tests__/dts-model-roundtrip.test.ts`, line 287
- **Stale reference**: Comment names the old `transistorModels` parameter by name.
- **Evidence**: `// serializeCircuit with transistorModels parameter`
