# Review Report: Waves 0-3 Pre-Wave 4 Compliance

**Spec:** spec/model-unification-v2.md
**Plan:** spec/plan-v2.md
**Scope:** Wave 0 (Foundation Types), Wave 1 (Registry Rename + Code Health), Wave 2 (Pin System + Digital Compiler), Wave 3 (CMOS Model Migration)

---

## Summary

| Category | Count |
|----------|-------|
| Tasks reviewed | 10 (W0.1-W0.5, W1.1-W1.2, W2.1-W2.3, W3.1-W3.3) |
| Violations | 12 |
| Gaps | 6 |
| Weak tests | 2 |
| Legacy references | 14 |
| Verdict | **has-violations** |

---

## Violations

### V-01 — major
**File:** `src/core/registry.ts:181-202`
**Rule:** spec lines 77-88 — factory is required; subcircuitModel is gone from MnaModel interface
**Evidence:** `factory` is correctly required (no `?`). `subcircuitModel` is not declared on the `MnaModel` interface — correct at the type level. However the field persists through untyped property access in component files (V-02/V-03) and the compiler (V-05/V-06) where TypeScript cannot enforce the removal.
**Severity:** major

---

### V-02 — critical
**File:** `src/components/gates/and.ts:164-166`
**Rule:** spec line 87 "subcircuitModel is gone"; plan W3.3 "replace `cmos: { subcircuitModel }` with nothing in mnaModels"
**Evidence:** The `cmos` entry in `mnaModels` at line 164 retains `subcircuitModel: "CmosAnd2"`. Per spec W3.3 the `cmos` key should not appear in `mnaModels` at all. The component has `subcircuitRefs: { cmos: "CmosAnd2" }` at the definition root (correct addition, line 150) but also retains the old `subcircuitModel` field in `mnaModels.cmos` (must be deleted). Both exist simultaneously.
**Severity:** critical

---

### V-03 — critical
**File:** `src/components/gates/nand.ts:165`, `nor.ts:181`, `not.ts:264`, `or.ts:175`, `xnor.ts:181`, `xor.ts:173`
**Rule:** plan W3.3 "Remove all subcircuitModel references from component files"
**Evidence:** Every gate file retains `subcircuitModel: "CmosXxx"` in `mnaModels.cmos`. Same pattern as V-02. Six additional files.
**Severity:** critical

---

### V-04 — critical
**File:** `src/components/flipflops/d.ts:296`
**Rule:** plan W3.3 "Remove all subcircuitModel references from component files"
**Evidence:** `subcircuitModel: "CmosDFlipflop"` remains in `mnaModels.cmos` on the D flip-flop.
**Severity:** critical

---

### V-05 — critical
**File:** `src/solver/analog/compiler.ts:55`
**Rule:** plan W4.2 "Delete `kind: expand` from ComponentRoute"; Wave 3 must remove subcircuitModel from component declarations first
**Evidence:** The union type still contains `| { kind: 'expand'; model: MnaModel; subcircuitModel: string }`. The `expand` kind is actively fed by subcircuitModel reads at lines 79-80.
**Severity:** critical

---

### V-06 — critical
**File:** `src/solver/analog/compiler.ts:79-80`
**Rule:** spec lines 245-246 "The compiler loop only ever sees `{ kind: stamp | bridge | skip }`"
**Evidence:** `resolveComponentRoute` checks `mnaModel.subcircuitModel !== undefined` and returns `{ kind: 'expand', ... }`. This is the v1 path that v2 replaces entirely. It persists because W3.3 was not completed.
**Severity:** critical

---

### V-07 — critical
**File:** `src/solver/analog/compiler.ts:111-136, 582-583, 602-603, 646, 664, 977-978, 1055-1064, 1397-1404`
**Rule:** plan W4.3 "Delete makeVddSource() and its invocation; delete vddNodeId/vddBranchIdx lazy allocation"
**Evidence:** `makeVddSource()`, `vddNodeId`, and `vddBranchIdx` all remain fully active. The implicit VDD rail injection at lines 1397-1404 is still present. Cannot be removed until Wave 3 CMOS migration makes VDD a regular user-wired pin.
**Severity:** critical

---

### V-08 — critical
**File:** `src/solver/analog/transistor-models/cmos-gates.ts:141`
**Rule:** plan W3.1 "cmos-gates.ts currently returns Circuit objects; rewrite each gate builder to produce MnaSubcircuitNetlist"
**Evidence:** `createCmosInverter` (and all other gate builders) has return type `Circuit`. The file constructs `Circuit`, `Wire`, and fake `CircuitElement` objects with pixel coordinates. The migration to `MnaSubcircuitNetlist` was not performed.
**Severity:** critical

---

### V-09 — critical
**File:** `src/solver/analog/transistor-expansion.ts:153`
**Rule:** spec lines 87-88 "subcircuitModel is gone"
**Evidence:** Live read at line 153: `componentDef.models?.mnaModels?.cmos?.subcircuitModel`. Lines 159, 163-164, 167 also reference the field in error messages. File header comment (line 4) describes `subcircuitModel` as the operative mechanism.
**Severity:** critical

---

### V-10 — major
**File:** `src/core/__tests__/registry.test.ts:692-694`
**Rule:** rules.md bans references to removed fields; this test asserts removed fields as expected MnaModel keys
**Evidence:** The test constructs `Array<keyof MnaModel>` containing `"subcircuitModel"` and `"requiresBranchRow"` — both removed per spec. The test only asserts `not.toContain("pinElectrical")` and passes vacuously while encoding stale field names as legitimate keys.
**Severity:** major

---

### V-11 — major
**File:** `src/core/circuit.ts:181-186`
**Rule:** spec lines 403-429 "modelDefinitions stores MnaSubcircuitNetlist objects"
**Evidence:** `CircuitMetadata.modelDefinitions` is typed as `Record<string, { ports: string[]; elementCount: number }>` — the v1 stub shape. The inline comment "Serialized element count — informational only; the full Circuit is in SubcircuitModelRegistry." is a historical-provenance comment confirming v1 code was not migrated. The spec requires ports, params?, elements, internalNetCount, and netlist arrays.
**Severity:** major

---

### V-12 — minor
**File:** `src/app/menu-toolbar.ts:391, 397`
**Rule:** spec lines 87-88 "subcircuitModel is gone"
**Evidence:** Line 391 comment: "for components with a subcircuitModel in their MNA model". Line 397 live check: `if (mnaModel.subcircuitModel !== undefined) { hasSubcircuitModel = true; break; }`. Live runtime dependency on the deleted field.
**Severity:** minor

---

## Gaps

### G-01
**Spec requirement:** W3.1 — cmos-gates.ts rewritten to produce MnaSubcircuitNetlist (topology + modelRef on each transistor, no Circuit objects)
**What was found:** cmos-gates.ts still produces Circuit objects with Wire coordinates and fake CircuitElement objects
**File:** `src/solver/analog/transistor-models/cmos-gates.ts`

---

### G-02
**Spec requirement:** W3.2 — cmos-flipflop.ts and darlington.ts migrated from Circuit objects to MnaSubcircuitNetlist
**What was found:** Not migrated; transistor-expansion.ts still reads Circuit-based registry, confirming the Circuit-object path remains in use
**File:** `src/solver/analog/transistor-models/cmos-flipflop.ts`, `darlington.ts`

---

### G-03
**Spec requirement:** W3.3 — "Replace `cmos: { subcircuitModel: 'CmosAnd2' }` with nothing in mnaModels" (plan W3.3 exact wording)
**What was found:** All 8 gate files and d.ts still have subcircuitModel in mnaModels.cmos. subcircuitRefs was added at the definition root (partial credit) but mnaModels.cmos.subcircuitModel was not removed.
**File:** `src/components/gates/and.ts`, `nand.ts`, `nor.ts`, `not.ts`, `or.ts`, `xor.ts`, `xnor.ts`, `src/components/flipflops/d.ts`

---

### G-04
**Spec requirement:** W0.3 — requiresBranchRow replaced by branchCount throughout, including tests
**What was found:** MnaModel in registry.ts correctly has `branchCount`. However registry test at line 693 still lists `requiresBranchRow` as a valid MnaModel key, indicating the replacement was not propagated through tests.
**File:** `src/core/__tests__/registry.test.ts:693`

---

### G-05
**Spec requirement:** `CircuitMetadata.modelDefinitions` stores MnaSubcircuitNetlist shape (ports, params?, elements, internalNetCount, netlist)
**What was found:** modelDefinitions uses old v1 shape `{ ports: string[]; elementCount: number }` — a stub, not the full compiled netlist
**File:** `src/core/circuit.ts:181-186`

---

### G-06
**Spec requirement:** W1.2 — Remove `it.skip` from `shape-audit.test.ts:150` and `fixture-audit.test.ts:225`
**What was found:** Grep returned empty for `it.skip` in both files, suggesting the skips may already be removed. This W1.2 item is not recorded as complete in progress.md for this spec version. Flagged for explicit verification.
**File:** `src/fixtures/__tests__/shape-audit.test.ts`, `src/fixtures/__tests__/fixture-audit.test.ts`

---

## Weak Tests

### WT-01
**Test path:** `src/core/__tests__/registry.test.ts` — "MnaModel interface does not include pinElectrical fields" (~line 692)
**Problem:** Constructs `Array<keyof MnaModel>` listing `"subcircuitModel"` and `"requiresBranchRow"` as expected keys. Both removed per spec. Test only asserts `not.toContain("pinElectrical")` — passes vacuously while encoding stale field names as legitimate keys.
**Evidence:** `const mnaKeys` includes `"subcircuitModel"` and `"requiresBranchRow"`; `expect(mnaKeys).not.toContain("pinElectrical")`

---

### WT-02
**Test path:** `src/core/__tests__/registry.test.ts` — same test block
**Problem:** Does not assert that `branchCount` IS present (replacement for `requiresBranchRow`). Does not assert `subcircuitModel` is NOT a valid key. Only checks absence of one unrelated field.
**Evidence:** Same block as WT-01.

---

## Legacy References

### LR-01
**File:** `src/solver/analog/transistor-expansion.ts:4`
**Evidence:** File header: "expandTransistorModel() takes a ComponentDefinition whose subcircuitModel" — references deleted field

### LR-02
**File:** `src/solver/analog/transistor-expansion.ts:50`
**Evidence:** "@param componentDef - The ComponentDefinition with subcircuitModel set" — JSDoc referencing deleted field

### LR-03
**File:** `src/solver/analog/transistor-expansion.ts:153`
**Evidence:** `componentDef.models?.mnaModels?.cmos?.subcircuitModel` — live read of deleted field

### LR-04
**File:** `src/solver/analog/transistor-expansion.ts:159`
**Evidence:** Error message: "has simulationModel 'transistor' but no subcircuitModel defined" — references deleted field

### LR-05
**File:** `src/solver/analog/transistor-expansion.ts:163-164`
**Evidence:** Error message: "has no models.mnaModels.cmos.subcircuitModel field. Set models.mnaModels.cmos.subcircuitModel" — references deleted field

### LR-06
**File:** `src/solver/analog/transistor-expansion.ts:167`
**Evidence:** Suggested fix text: "Add mnaModels: { cmos: { subcircuitModel: 'CmosXxx' } }" — references deleted field

### LR-07
**File:** `src/app/spice-subckt-dialog.ts:4`
**Evidence:** "Triggered from right-click context menu on components with a subcircuitModel" — comment referencing deleted field

### LR-08
**File:** `src/app/menu-toolbar.ts:391`
**Evidence:** "for components with a subcircuitModel in their MNA model" — comment referencing deleted field

### LR-09
**File:** `src/app/menu-toolbar.ts:397`
**Evidence:** `if (mnaModel.subcircuitModel !== undefined)` — live runtime check of deleted field

### LR-10
**File:** `src/solver/analog/compiler.ts:55`
**Evidence:** `| { kind: 'expand'; model: MnaModel; subcircuitModel: string }` — deleted field in union type

### LR-11
**File:** `src/solver/analog/compiler.ts:79-80`
**Evidence:** `if (mnaModel.subcircuitModel !== undefined) { return { kind: 'expand', ... } }` — routing on deleted field

### LR-12
**File:** `src/core/circuit.ts:183-184`
**Evidence:** "Serialized element count — informational only; the full Circuit is in SubcircuitModelRegistry." — historical-provenance comment describing old architecture

### LR-13
**File:** `src/io/spice-model-builder.ts:317`
**Evidence:** `props.push(["subcircuitModel", el.modelName])` — writes deleted field into property bag

### LR-14
**File:** `src/core/__tests__/registry.test.ts:693`
**Evidence:** String literals `"subcircuitModel"` and `"requiresBranchRow"` listed as expected MnaModel keys

---

## Per-Wave Verdicts

### Wave 0: Foundation Types — PARTIAL PASS

- W0.1 MnaSubcircuitNetlist type: **PASS** — `src/core/mna-subcircuit-netlist.ts` exists with all fields matching spec.
- W0.2 PinDeclaration.kind required: **PASS** — `kind: "signal" | "power"` present and required in `src/core/pin.ts:44`.
- W0.3 MnaModel updates: **PARTIAL** — `factory` required (correct), `branchCount` present (correct), `subcircuitRefs` on `ComponentDefinition` present (correct). Registry test still references removed fields (V-10, G-04).
- W0.4 CircuitMetadata.subcircuitBindings: **PASS** — present at `circuit.ts:188`.
- W0.5 DiagnosticCode addition: **PASS** — `unresolved-model-ref` present in `src/compile/types.ts:38`.

`CircuitMetadata.modelDefinitions` uses the old v1 shape (G-05, V-11) — not assigned to Wave 0 but will block Wave 5.

---

### Wave 1: Registry Rename + Code Health — PARTIAL PASS

- W1.1 Rename TransistorModelRegistry: **PASS** — `subcircuit-model-registry.ts` exists; zero hits for `TransistorModelRegistry` in `src/`; `registerBuiltinSubcircuitModels` used in `default-models.ts`.
- W1.2 Code health deletions: **PARTIAL** — `wire-merge.ts` and `pin-voltage-access.ts` deleted (zero grep hits). `model-parser.ts` does not re-export `DeviceType`. `it.skip` removals unconfirmed (G-06). `AnalogScopePanel` alias, `parseSplittingPattern`, and `show()` overload not individually verified.

---

### Wave 2: Pin System + Digital Compiler — PARTIAL PASS

- W2.1 `kind: "signal"` on all PinDeclarations: **PARTIAL** — Gate files use `standardGatePinLayout()` which internally hardcodes `kind: "signal"` in pin.ts, so signal pins are covered indirectly. D-FF has explicit `kind: "signal"` on static pins. No explicit per-file `kind:` in gate declaration arrays.
- W2.2 Gate `getPins()` adds power pins when model is cmos: **PARTIAL** — `d.ts` correctly adds `kind: "power"` VDD/GND pins conditionally. No `kind: "power"` found in `and.ts` grep results, suggesting gate files do not yet add power pins.
- W2.3 Digital compiler filters power pins: **PASS** — `compiler.ts` lines 357, 368, 388 filter `ref.kind === "power"`.

---

### Wave 3: CMOS Model Migration — FAIL

- W3.1 Migrate `cmos-gates.ts` to `MnaSubcircuitNetlist`: **FAIL** — still produces `Circuit` objects.
- W3.2 Migrate `cmos-flipflop.ts` and `darlington.ts`: **FAIL** — not migrated.
- W3.3 Update component declarations: **FAIL** — all 8 gate files and d.ts retain `subcircuitModel` in `mnaModels.cmos`.

Wave 3 is completely incomplete. The CMOS migration was not performed. The partial work (adding `subcircuitRefs` to component definitions) is a necessary addition but insufficient — the old `subcircuitModel` path was not torn down.

---

## Wave 4 Readiness Assessment

**Wave 4 CANNOT proceed.** The blockers are:

1. `cmos-gates.ts`, `cmos-flipflop.ts`, `darlington.ts` still return `Circuit` objects. The `MnaSubcircuitNetlist` format that Wave 4 `compileSubcircuitToMnaModel()` will consume does not exist.
2. All component declarations still use `subcircuitModel` in `mnaModels`. Wave 4 `resolveSubcircuitModels` reads `subcircuitRefs` on `ComponentDefinition`. The compiler still routes through `expand` → `expandTransistorModel`, bypassing the Wave 4 path entirely.
3. `makeVddSource` / `vddNodeId` / VDD injection cannot be removed (Wave 4 W4.3) until VDD is a regular user-wired pin — requires Wave 3 model migration first.
4. The `expand` route in `ComponentRoute` cannot be deleted (Wave 4 W4.2) until no component has `subcircuitModel` on its MnaModel.
