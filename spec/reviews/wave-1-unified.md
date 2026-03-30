# Review Report: Wave 1 -- Unified Model System (T1 + T2)

## Summary

- **Tasks reviewed**: 2 (T1: Add new types, T2: Delete all old infrastructure)
- **Violations**: 18
- **Gaps**: 3
- **Weak tests**: 0
- **Legacy references**: 11
- **Verdict**: has-violations

---

## Violations

### V1 -- CRITICAL

**File**: `src/app/canvas-popup.ts:68`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `availableModels(def).length > 1`
`availableModels()` is listed in the T2 deletion table. It has no definition anywhere in `src/`. The progress report claims this import was removed from `canvas-popup.ts`. The call site remains. This file cannot compile.

---

### V2 -- CRITICAL

**File**: `src/app/canvas-popup.ts:72-73`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `getActiveModelKey(elementHit, def)` and `modelKeyToDomain(activeKey, def)`
Both `getActiveModelKey()` and `modelKeyToDomain()` are in the T2 deletion table. Neither has a definition anywhere in `src/`. The progress report claims these imports were removed from `canvas-popup.ts`. The call sites remain.

---

### V3 -- CRITICAL

**File**: `src/app/canvas-popup.ts:108-110`
**Rule**: Code Hygiene -- No references to deleted fields.
**Evidence**: `def.subcircuitRefs !== undefined` and `def.models?.mnaModels`
`subcircuitRefs` and `models.mnaModels` are both in the T2 deletion table. `ComponentDefinition` no longer declares `subcircuitRefs`; `ComponentModels` no longer has `mnaModels`.

---

### V4 -- CRITICAL

**File**: `src/app/menu-toolbar.ts:168`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `return modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna';`
Both `getActiveModelKey()` and `modelKeyToDomain()` are deleted functions with no definition in `src/`. The progress report claims these imports were removed from `menu-toolbar.ts`. They were not.

---

### V5 -- CRITICAL

**File**: `src/app/menu-toolbar.ts:383`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `return modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna';`
Second call site of the same deleted functions in `menu-toolbar.ts`.

---

### V6 -- CRITICAL

**File**: `src/compile/extract-connectivity.ts:79`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `modelKey = getActiveModelKey(el, def);`
`getActiveModelKey()` is in the T2 deletion table. The progress report claims the import was removed from `extract-connectivity.ts`. The call site remains. The function has no definition in `src/`.

---

### V7 -- CRITICAL

**File**: `src/compile/extract-connectivity.ts:97`
**Rule**: Code Hygiene -- No references to deleted fields.
**Evidence**: `model = def.models.mnaModels?.[modelKey] ?? null;`
`models.mnaModels` is in the T2 deletion table. `ComponentModels` no longer has this field.

---

### V8 -- CRITICAL

**File**: `src/compile/partition.ts:163`
**Rule**: Code Hygiene -- No references to deleted fields.
**Evidence**: `const isDualModel = def.models?.mnaModels !== undefined && Object.keys(def.models.mnaModels).length > 0;`
`models.mnaModels` is a deleted field per the T2 deletion table.

---

### V9 -- CRITICAL

**File**: `src/compile/partition.ts:199`
**Rule**: Code Hygiene -- No calls to deleted functions.
**Evidence**: `const domain = modelKeyToDomain(ma.modelKey, def);`
`modelKeyToDomain()` is in the T2 deletion table. The progress report claims the import was removed from `partition.ts`. The call site remains. The function has no definition in `src/`.

---

### V10 -- CRITICAL

**File**: `src/compile/compile.ts:56`
**Rule**: Code Hygiene -- No references to deleted types.
**Evidence**: `subcircuitModels?: SubcircuitModelRegistry,`
`SubcircuitModelRegistry` is in the T2 deletion table (entire `subcircuit-model-registry.ts` deleted). The progress report claims the import was removed from `compile.ts`. The parameter declaration and its type remain.

---

### V11 -- CRITICAL

**File**: `src/app/spice-model-apply.ts:29-35, 55-61`
**Rule**: Code Hygiene -- No references to deleted fields or types.
**Evidence**: `circuit.metadata.namedParameterSets`, `set('_spiceModelOverrides', ...)`, `set('_spiceModelName', ...)`, `modelRegistry: SubcircuitModelRegistry`, `circuit.metadata.modelDefinitions`, `set('simulationModel', ...)`
`namedParameterSets`, `modelDefinitions`, `_spiceModelOverrides`, `_spiceModelName`, and `SubcircuitModelRegistry` are all in the T2 deletion table. The progress report states the `SubcircuitModelRegistry` import and a comment were removed. Five deleted concepts remain as live production code.

---

### V12 -- CRITICAL

**File**: `src/app/spice-model-library-dialog.ts:44-45, 109, 153, 194-195, 231, 233-235, 313, 327, 364, 427-433`
**Rule**: Code Hygiene -- No references to deleted fields or types.
**Evidence**: `circuit.metadata.namedParameterSets`, `circuit.metadata.modelDefinitions`, `const modelRegistry: SubcircuitModelRegistry = getTransistorModels()`, `circuit.metadata.subcircuitBindings`
`namedParameterSets`, `modelDefinitions`, `subcircuitBindings`, and `SubcircuitModelRegistry` are all in the T2 deletion table. The progress report claims these imports were removed. All four deleted concepts remain as live production code throughout this file.

---

### V13 -- CRITICAL

**File**: `src/headless/default-facade.ts:106`
**Rule**: Code Hygiene -- No calls to functions from deleted infrastructure.
**Evidence**: `const unified = compileUnified(circuit, this._registry, getTransistorModels());`
`getTransistorModels()` was defined in `default-models.ts`, which is in the T2 deletion table. The progress report claims the `getTransistorModels` import was removed from `default-facade.ts`. The call site remains.

---

### V14 -- CRITICAL

**File**: `src/core/analog-types.ts:155`
**Rule**: T2 deletion table -- `DeviceType` union must be deleted from `analog-types.ts` and moved to `model-parser.ts` as parser-internal.
**Evidence**: `export type DeviceType = "NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "D" | "TUNNEL";`
The spec states: Delete `DeviceType` union from `src/core/analog-types.ts` and move to `src/solver/analog/model-parser.ts` as parser-internal. The type remains as a public export in `analog-types.ts` and was not moved.

---

### V15 -- CRITICAL

**File**: `src/solver/analog/__tests__/transistor-expansion.test.ts:27-28`
**Rule**: Completeness -- T2 required deletion of all test files for deleted infrastructure.
**Evidence**: `import { SubcircuitModelRegistry } from "../subcircuit-model-registry.js";` and `import { registerAnalogFactory } from "../transistor-expansion.js";`
This file imports from two deleted files. The T2 deletion table explicitly lists it for deletion under "All test files for deleted infrastructure". The file was not deleted. It will throw module-not-found errors at import time.

---

### V16 -- CRITICAL

**File**: `src/solver/analog/__tests__/model-binding.test.ts:10-13`
**Rule**: Completeness -- T2 required deletion of all test files for deleted infrastructure.
**Evidence**: `import { ModelLibrary, validateModel } from "../model-library.js";` and `import { DIODE_DEFAULTS } from "../model-defaults.ts";`
This file imports from two deleted files (`model-library.ts`, `model-defaults.ts`). It was not deleted. It will throw module-not-found errors at import time.

---

### V17 -- CRITICAL

**File**: `src/io/__tests__/spice-pipeline-integration.test.ts:21`
**Rule**: Code Hygiene -- No imports from deleted files.
**Evidence**: `import { SubcircuitModelRegistry } from "../../solver/analog/subcircuit-model-registry.js";`
`subcircuit-model-registry.ts` was deleted in T2. This test file (created in Wave 10) was not updated to remove the import. The import will throw module-not-found at runtime.

---

### V18 -- MAJOR

**File**: `src/compile/extract-connectivity.ts:40`
**Rule**: Code Hygiene -- No references to deleted types.
**Evidence**: `model: import('../core/registry.js').DigitalModel | import('../core/registry.js').MnaModel | null;`
`MnaModel` was removed from `registry.ts` during the Wave 5 restructure and is not part of the T1 new types. This inline type import references a non-existent type.

---

## Gaps

### G1

**Spec requirement**: T2 deletion table explicitly lists `src/solver/analog/__tests__/transistor-expansion.test.ts` for deletion under "All test files for deleted infrastructure".
**What was found**: File still exists and imports from two deleted modules.
**File**: `src/solver/analog/__tests__/transistor-expansion.test.ts`

---

### G2

**Spec requirement**: T2 requires deletion of all test files importing from deleted infrastructure. `model-binding.test.ts` imports from `model-library.ts` and `model-defaults.ts` (both deleted). The spec states: "After completing all listed deletions, run grep -r for every symbol in the verification conditions list. Delete any remaining references found."
**What was found**: `src/solver/analog/__tests__/model-binding.test.ts` still exists and imports from two deleted files.
**File**: `src/solver/analog/__tests__/model-binding.test.ts`

---

### G3

**Spec requirement**: T2 deletion table -- `DeviceType` union: delete from `src/core/analog-types.ts`, move to `src/solver/analog/model-parser.ts` as parser-internal.
**What was found**: `DeviceType` remains as a public export in `src/core/analog-types.ts`. No parser-internal version was created in `model-parser.ts`.
**File**: `src/core/analog-types.ts:155`

---

## Weak Tests

None found. The test assertions in `model-params.test.ts` and `property-bag-partition.test.ts` test concrete values, correct ranks, exact error messages, and behavioural isolation between partitions. No trivially-true assertions, no skips, no xfails.

---

## Legacy References

### L1

**File**: `src/compile/extract-connectivity.ts:48`
**Evidence**: JSDoc describes old `simulationModel` resolution: `modelKey = el.props.simulationModel ?? def.defaultModel ?? firstKey(def.models)`
Historical-provenance comment explaining old resolution logic.

---

### L2

**File**: `src/compile/extract-connectivity.ts:76`
**Evidence**: `// Delegate to getActiveModelKey -- throws on invalid simulationModel prop values.`
Comment describes delegation to a deleted function. Dead documentation for deleted code.

---

### L3

**File**: `src/compile/extract-connectivity.ts:81`
**Evidence**: `// Invalid simulationModel property -- record a diagnostic and continue with neutral`
Comment refers to the deleted `simulationModel` property as the active routing mechanism.

---

### L4

**File**: `src/compile/extract-connectivity.ts:115`
**Evidence**: `The canonical registry.modelKeyToDomain() returns "mna", which is incompatible`
JSDoc in local `modelKeyToDomain` references the deleted canonical function by name. Historical-provenance comment.

---

### L5

**File**: `src/app/spice-model-apply.ts:42`
**Evidence**: `Compiled netlist -- registered in SubcircuitModelRegistry and stored in circuit.metadata.modelDefinitions.`
JSDoc referencing deleted type `SubcircuitModelRegistry` and deleted field `modelDefinitions`.

---

### L6

**File**: `src/app/spice-model-apply.ts:48-50`
**Evidence**: JSDoc: "1. Register the netlist in the provided SubcircuitModelRegistry. 2. Write the MnaSubcircuitNetlist to circuit.metadata.modelDefinitions. 3. Set simulationModel on the instance."
JSDoc describing operations on three deleted concepts. These accompany live production code that also uses those deleted concepts (V11).

---

### L7

**File**: `src/app/spice-model-library-dialog.ts:9-10`
**Evidence**: "Named parameter sets -> circuit.metadata.namedParameterSets" / "Subcircuit definitions -> circuit.metadata.modelDefinitions"
JSDoc referencing deleted metadata fields as storage destinations.

---

### L8

**File**: `src/solver/analog/compiler.ts:116`
**Evidence**: `with that name was found in modelDefinitions or the SubcircuitModelRegistry.`
Error message string referencing deleted concepts `modelDefinitions` and `SubcircuitModelRegistry`. Stale reference baked into a runtime error message.

---

### L9

**File**: `src/solver/analog/compiler.ts:1535`
**Evidence**: `One instance of the component (same type and props, minus simulationModel`
JSDoc referencing the deleted `simulationModel` property.

---

### L10

**File**: `src/solver/analog/compiler.ts:1569`
**Evidence**: `if (key === "simulationModel" || key === "_pinElectrical") continue;`
Live production code filtering out the deleted `simulationModel` property key during property iteration. This is both a legacy reference and a backwards-compatibility shim for a property the spec requires to be fully deleted. Both are banned by the rules.

---

### L11

**File**: `src/compile/__tests__/extract-connectivity.test.ts:199`
**Evidence**: `// First key of { digital, mnaModels } is "digital"`
Comment describes the old `mnaModels` field structure. Historical-provenance comment.

---