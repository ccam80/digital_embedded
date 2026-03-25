# Review Report: Phase 2 -- Migrate Component Definitions

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | P2-1 through P2-7 (all Phase 2 tasks) |
| Violations critical | 5 |
| Violations major | 4 |
| Violations minor | 5 |
| Gaps | 4 |
| Weak tests | 6 |
| Legacy references | 11 |
| Verdict | **has-violations** |

---

## Violations

### V-01 -- CRITICAL: Codebase does not compile -- 906 TypeScript errors across 239 files

**Files**: 239 source files  
**Rule violated**: Completeness -- never mark work as deferred. Phase 2 Step 7 acceptance
criterion not met -- Vitest passes only because esbuild transpilation skips type checking.  
**Severity**: critical

npx tsc --noEmit reports 906 type errors across 239 files. Tests pass only because Vitest
uses esbuild which does not perform type checking. The codebase is in a broken compilation
state. Selected errors confirmed by running tsc:

    src/components/graphics/graphic-card.ts(448,3): error TS2353:
      Object literal may only specify known properties,
      and 'executeFn' does not exist in type 'ComponentDefinition'.
    src/components/graphics/led-matrix.ts(271,3): error TS2353: same
    src/components/graphics/vga.ts(399,3): error TS2353: same
    src/components/misc/rectangle.ts(199,3): error TS2353: same
    src/components/misc/testcase.ts(261,3): error TS2353: same
    src/components/misc/text.ts(150,3): error TS2353: same
    src/app/app-init.ts(409,19): error TS2339:
      Property 'simulationModes' does not exist on type 'ComponentDefinition'.
    src/app/app-init.ts(1559,15): error TS2339: same
    src/analog/__tests__/lrcxor-fixture.test.ts(191,85): error TS2339:
      Property 'executeFn' does not exist on type 'ComponentDefinition'.

Plus hundreds of errors related to allNodeIds and getPinCurrents missing from AnalogElement
implementations across test and source files.

---

### V-02 -- CRITICAL: Flat fields (executeFn, inputSchema, outputSchema, defaultDelay) remain
on ComponentDefinition objects in production component files -- P2-1 incomplete

**Files**: src/components/pld/pull-up.ts:197, src/components/pld/pull-down.ts:195,
src/components/pld/diode.ts:565,583,601, src/components/graphics/graphic-card.ts:448,
src/components/graphics/led-matrix.ts:271, src/components/graphics/vga.ts:399,
src/components/misc/rectangle.ts:199, src/components/misc/testcase.ts:261,
src/components/misc/text.ts:150, src/components/terminal/terminal.ts:300,
src/components/terminal/keyboard.ts:282  
**Rule violated**: Phase 2 Step 1 -- mechanically rewrite each definition to use models bag.
Phase 2 Step 3 -- remove flat fields from ComponentDefinition interface.  
**Severity**: critical

These production component definitions still use flat top-level executeFn (and inputSchema,
outputSchema, defaultDelay) instead of the models.digital bag. TypeScript confirms these as
TS2353 errors. P2-1 migration is incomplete.

Evidence from src/components/pld/pull-up.ts lines 193-208:

    export const PullUpDefinition: ComponentDefinition = {
      name: "PullUp",
      typeId: -1,
      factory: pullUpFactory,
      executeFn: executePullUp,    // flat -- not migrated to models.digital
      inputSchema: [],             // flat -- not migrated
      outputSchema: ["out"],       // flat -- not migrated
      defaultDelay: 0,             // flat -- not migrated
    };

Evidence from src/components/pld/diode.ts lines 561-577 (PldDiodeDefinition):

    executeFn: executeDiode,        // flat -- not migrated
    inputSchema: ["out1","out2"],   // flat -- not migrated
    outputSchema: [],               // flat -- not migrated
    defaultDelay: 0,                // flat -- not migrated

---

### V-03 -- CRITICAL: def.simulationModes read as flat field on ComponentDefinition
in app-init.ts and property-panel.ts

**File**: src/app/app-init.ts:409,1559 and src/editor/property-panel.ts:163  
**Rule violated**: Phase 2 Step 3 -- remove flat fields from ComponentDefinition interface.
Consumer migration incomplete.  
**Severity**: critical

app-init.ts accesses def.simulationModes at two call sites; property-panel.ts at one.
simulationModes is not part of the new ComponentDefinition interface (confirmed by reading
src/core/registry.ts lines 210-239). TypeScript flags the app-init accesses as TS2339.
At runtime the access returns undefined, breaking simulation mode dropdown behaviour.

TypeScript errors:
    src/app/app-init.ts(409,19): error TS2339:
      Property 'simulationModes' does not exist on type 'ComponentDefinition'.
    src/app/app-init.ts(1559,15): error TS2339: same

Evidence from src/app/app-init.ts:
    line 409:  if (def.simulationModes && def.simulationModes.length > 1) {
    line 1559: if (def.simulationModes && def.simulationModes.length > 1) {

Evidence from src/editor/property-panel.ts:
    line 163:  const modes = def.simulationModes;

---

### V-04 -- CRITICAL: def.pinElectricalOverrides and def.pinElectrical read as flat fields
in property-panel.ts

**File**: src/editor/property-panel.ts:260,261  
**Rule violated**: Phase 2 Step 3 -- consumer migration for removed flat fields.  
**Severity**: critical

property-panel.ts reads def.pinElectricalOverrides and def.pinElectrical as flat fields on
ComponentDefinition. The analog compiler already reads these correctly from
def.models?.analog?.pinElectricalOverrides (compiler.ts:864-865). The property panel was
not updated. At runtime both accesses return undefined, discarding all per-component and
per-pin electrical overrides in the property panel UI.

Evidence from src/editor/property-panel.ts:
    line 260: const pinOverride = def.pinElectricalOverrides?.[pinLabel];
              // flat field -- undefined at runtime after Phase 2 migration
    line 261: const resolved = resolvePinElectrical(family, pinOverride, def.pinElectrical);
              // flat field -- undefined at runtime after Phase 2 migration

---

### V-05 -- CRITICAL: spec/progress.md Phase 2 Summary documents deliberate deferred work
and deprecated exports

**File**: spec/progress.md (Phase 2 Summary section)  
**Rule violated**: Completeness -- never mark work as deferred. Code hygiene -- no
backwards compatibility shims.  
**Severity**: critical

The Phase 2 Summary in spec/progress.md contains:

    - Flat fields retained as @deprecated on ComponentDefinition for test backwards compat
    - _ensureModels shim retained -- test code creates ~105 inline definitions with flat fields
    - noOpAnalogExecuteFn retained as @deprecated export (1 test file still imports it)
    - expandTransistorModel still reads flat def.transistorModel (consumer update deferred)

Each entry is an admission of a rule violation: @deprecated fields for backwards compat,
shim retention, deprecated wrapper export, and explicitly deferred work.
Per the rules: a note that explains why a rule was bent is proof the agent knowingly broke
the rule. The progress summary is a permanent record of intentional rule-breaking even
though the items were subsequently cleaned up in the final commit.

---

### V-06 -- MAJOR: progress.md records _ensureModels shim retention as a decision,
but shim is actually gone

**File**: spec/progress.md Phase 2 Summary  
**Rule violated**: Code hygiene -- no backwards compatibility shims. Documentation accuracy.  
**Severity**: major

progress.md states: "_ensureModels shim retained -- test code creates ~105 inline definitions
with flat fields."
Searching the entire src/ tree finds zero occurrences of _ensureModels. The shim was removed
but the note was not updated, creating inaccurate implementation history for the next agent.

---

### V-07 -- MAJOR: progress.md records noOpAnalogExecuteFn as @deprecated export
but it is actually gone

**File**: spec/progress.md Phase 2 Summary  
**Rule violated**: Code hygiene -- no backwards compatibility shims. Documentation accuracy.  
**Severity**: major

progress.md states: "noOpAnalogExecuteFn retained as @deprecated export (1 test file still
imports it)."
Searching src/ finds no occurrences of noOpAnalogExecuteFn. The progress note records a
planned rule violation that was corrected but the note was not updated.

---

### V-08 -- MAJOR: src/fixtures/__tests__/orphan-debug.test.ts -- Temporary diagnostic test comment

**File**: src/fixtures/__tests__/orphan-debug.test.ts:1  
**Rule violated**: Code hygiene -- "temporary" is an explicitly named red-flag word.  
**Severity**: major

File begins with:
    /**
     * Temporary diagnostic test -- dumps pin positions and orphan wire endpoints
     * for specific failing fixtures to identify which component pins are misplaced.
     */

This test file exists for debugging and was not cleaned up. The word "Temporary" in a
comment is explicitly listed as a red flag per the reviewer posture.

---

### V-09 -- MAJOR: src/io/dts-schema.ts and src/io/dts-deserializer.ts -- legacy compat comments

**Files**: src/io/dts-schema.ts:103, src/io/dts-deserializer.ts:153  
**Rule violated**: Code hygiene -- no historical-provenance comments.
Backwards-compatibility language is banned.  
**Severity**: major

src/io/dts-schema.ts:103:
    Accepts both format dts (current) and format digb (legacy compat).

src/io/dts-deserializer.ts:153:
    Accepts both format dts (current) and format digb (legacy compat).

---

### V-10 -- MINOR: src/io/dig-serializer.ts:156 -- for now comment with placeholder implementation

**File**: src/io/dig-serializer.ts:156  
**Rule violated**: Code hygiene -- "for now" is a named red-flag phrase.
Completeness -- work deferred.  
**Severity**: minor

    // Custom shapes are complex; preserve as empty for now
    return `<string>[customShape]</string>`;

"for now" is a red-flag phrase per the reviewer posture. The return value is also a silent
data-loss placeholder for custom shape serialization.

---

### V-11 -- MINOR: src/analog/compiler.ts:1-8 -- file comment describes architecture
using removed engineType framing

**File**: src/analog/compiler.ts:1-8  
**Rule violated**: Code hygiene -- historical-provenance comment ban.  
**Severity**: minor

The file-level JSDoc says "Transforms a visual Circuit with engineType: analog" and
lists step 1 as "Verify circuit.metadata.engineType === analog". The engineType field on
ComponentDefinition was removed in Phase 2. While circuit.metadata.engineType is a separate
concern not yet removed, the comment conflates the two, leaving stale architecture description.

---

### V-12 -- MINOR: src/analog/__tests__/analog-compiler.test.ts:5,8 -- file comment
references removed architecture

**File**: src/analog/__tests__/analog-compiler.test.ts:5,8  
**Rule violated**: Code hygiene -- historical-provenance comment ban.  
**Severity**: minor

    - Analog compiler accepts engineType "both" components with analogFactory
    - simulationMode property handling: behavioral (default), digital stub, transistor stub

engineType "both" on ComponentDefinition was removed in Phase 2.
simulationModes was removed from ComponentDefinition.

---

### V-13 -- MINOR: src/analog/__tests__/behavioral-remaining.test.ts:393 -- JSDoc references
removed engineType "both" concept

**File**: src/analog/__tests__/behavioral-remaining.test.ts:393  
**Rule violated**: Code hygiene -- historical-provenance comment ban.  
**Severity**: minor

    All 12 components from task 6.1.4 must have engineType "both" and analogFactory.

engineType "both" is a removed concept. The actual assertions correctly use
models?.digital and models?.analog.

---

### V-14 -- MINOR: src/engine/__tests__/mixed-partition.test.ts:1-10 -- header block
references engineType on component definitions

**File**: src/engine/__tests__/mixed-partition.test.ts:1-10  
**Rule violated**: Code hygiene -- historical-provenance comment ban.  
**Severity**: minor

    Component engine types used in tests:
      - "Resistor"        -> engineType: "analog"
      - "DcVoltageSource" -> engineType: "analog"
      - "Ground"          -> engineType: "both"
      - "And"             -> engineType: "both"
      - "Add"             -> engineType: undefined (defaults to "digital")

This describes engineType tags on component definitions -- a removed concept.
The same stale framing repeats in inline comments at lines 53, 63, 71, 79, 87, 95.

---

## Gaps

### G-01: P2-1 incomplete -- PLD, graphics, misc, and terminal component definitions
not migrated to models bag

**Spec requirement**: Phase 2, Step 1 -- Mechanically rewrite each definition:
move executeFn to models.digital.executeFn, analogFactory to models.analog.factory, etc.  
**What was found**: The following production files were not migrated
(TypeScript confirms TS2353 errors for graphics/misc entries):
- src/components/pld/pull-up.ts -- flat executeFn, inputSchema, outputSchema, defaultDelay
- src/components/pld/pull-down.ts -- flat executeFn
- src/components/pld/diode.ts -- three definitions with flat executeFn, inputSchema,
  outputSchema, defaultDelay
- src/components/graphics/graphic-card.ts -- flat executeFn (TS2353 confirmed)
- src/components/graphics/led-matrix.ts -- flat executeFn (TS2353 confirmed)
- src/components/graphics/vga.ts -- flat executeFn (TS2353 confirmed)
- src/components/misc/rectangle.ts -- flat executeFn (TS2353 confirmed)
- src/components/misc/testcase.ts -- flat executeFn (TS2353 confirmed)
- src/components/misc/text.ts -- flat executeFn (TS2353 confirmed)
- src/components/terminal/terminal.ts -- flat executeFn
- src/components/terminal/keyboard.ts -- flat executeFn
**File path**: Multiple (listed above)

---

### G-02: simulationModes consumer migration incomplete in app-init.ts and property-panel.ts

**Spec requirement**: Phase 2, Step 3 -- remove flat fields from ComponentDefinition interface.
Entails updating all consumers, not only the type definition.  
**What was found**: src/app/app-init.ts:409,1559 and src/editor/property-panel.ts:163
read def.simulationModes. The field does not exist on ComponentDefinition.
TypeScript flags the app-init.ts accesses.  
**File path**: src/app/app-init.ts, src/editor/property-panel.ts

---

### G-03: pinElectricalOverrides and pinElectrical consumer migration incomplete
in property-panel.ts

**Spec requirement**: Phase 2, Step 3 -- consumer migration for removed flat fields.  
**What was found**: src/editor/property-panel.ts:260-261 reads def.pinElectricalOverrides
and def.pinElectrical as flat fields. The analog compiler reads these correctly from
def.models?.analog?.pinElectricalOverrides (compiler.ts:864-865).
The property panel was overlooked during migration.  
**File path**: src/editor/property-panel.ts:260,261

---

### G-04: Phase 2 completion declared with 906 outstanding TypeScript type errors
-- P2-7 acceptance criterion not met

**Spec requirement**: Phase 2, Step 7 -- Run full test suite.
A passing type-checked build is implied by the spec intent.  
**What was found**: npx tsc --noEmit produces 906 errors across 239 files.
Vitest passes only because esbuild skips type checking.
The spec acceptance criterion is not satisfied.  
**File path**: Codebase-wide

---

## Weak Tests

### WT-01: src/components/passives/__tests__/capacitor.test.ts
-- stale test name; trivially weak assertion

**Test**: capacitor.test.ts::definition::CapacitorDefinition engineType is analog  
**Problem**: Test name references engineType (removed concept).
Assertion is toBeDefined() -- verifies only existence, not behaviour.  
**Evidence**:
    it("CapacitorDefinition engineType is 'analog'", () => {
      expect(CapacitorDefinition.models?.analog).toBeDefined();
    });

---

### WT-02: src/components/passives/__tests__/inductor.test.ts
-- stale test name; trivially weak assertion

**Test**: inductor.test.ts::definition::InductorDefinition engineType is analog  
**Problem**: Stale test name referencing engineType; trivially weak toBeDefined().  
**Evidence**:
    it("InductorDefinition engineType is 'analog'", () => {
      expect(InductorDefinition.models?.analog).toBeDefined();
    });

---

### WT-03: src/components/io/__tests__/analog-clock.test.ts
-- simulationModes_includes_logical assertion trivially weak

**Test**: analog-clock.test.ts::simulationModes_includes_logical
-- logical clock behavior preserved  
**Problem**: Test name promises to verify simulationModes includes logical.
Actual assertion only checks digital model is defined -- does not test the described behaviour.  
**Evidence**:
    it("simulationModes_includes_logical -- logical clock behavior preserved", () => {
      expect(ClockDefinition.models.digital).toBeDefined();
    });

---

### WT-04: src/core/__tests__/registry.test.ts:505,519
-- test creates definitions with removed engineType field

**Test**: registry.test.ts::alias must not shadow a later canonical name  
**Problem**: Test spreads engineType: "analog" as const onto a ComponentDefinition.
engineType was removed from ComponentDefinition in Phase 2.
The stale field is tolerated only by TypeScript spread excess-property bypass.  
**Evidence**:
    const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };

---

### WT-05: src/analog/__tests__/behavioral-remaining.test.ts
::Registration::all_both_components_have_analog_factory -- JSDoc describes removed concept

**Test**: behavioral-remaining.test.ts::Registration::all_both_components_have_analog_factory  
**Problem**: JSDoc says must have engineType both and analogFactory -- both removed concepts.
Assertions are correct but test documentation misleads.  
**Evidence**:
    All 12 components from task 6.1.4 must have engineType "both" and analogFactory.

---

### WT-06: Multiple passives test files
-- trivial toBeDefined() assertions for engineType checks

**Tests**: potentiometer.test.ts, crystal.test.ts, polarized-cap.test.ts,
transformer.test.ts, tapped-transformer.test.ts, transmission-line.test.ts, analog-fuse.test.ts  
**Problem**: All have stale names referencing engineType with trivially weak toBeDefined()
assertions that confirm only model existence, not behaviour.  
**Evidence** (representative, potentiometer.test.ts):
    it("PotentiometerDefinition engineType is 'analog'", () => {
      expect(PotentiometerDefinition.models?.analog).toBeDefined();
    });

---

## Legacy References

### LR-01: src/core/__tests__/registry.test.ts:505

    const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };

engineType on ComponentDefinition was removed in Phase 2.

---

### LR-02: src/core/__tests__/registry.test.ts:519

    const analogDiode = { ...makeDefinition("Diode"), engineType: "analog" as const };

---

### LR-03: src/analog/__tests__/analog-compiler.test.ts:5

    - Analog compiler accepts engineType "both" components with analogFactory

---

### LR-04: src/analog/__tests__/analog-compiler.test.ts:130

    Build a registry with a Ground, a "both"-engineType AND gate, and a digital-only gate.

---

### LR-05: src/analog/__tests__/behavioral-remaining.test.ts:393

    All 12 components from task 6.1.4 must have engineType "both" and analogFactory.

---

### LR-06: src/engine/__tests__/mixed-partition.test.ts:5-10

    - "Resistor"  -> engineType: "analog"
    - "DcVoltageSource" -> engineType: "analog"
    - "Ground"    -> engineType: "both"
    - "And"       -> engineType: "both"
    - "Add"       -> engineType: undefined (defaults to "digital")

---

### LR-07: src/engine/__tests__/mixed-partition.test.ts:53,63,71,79,87,95

Inline comments: "Add is digital-only (no engineType -> defaults to digital)",
"AnalogResistor is engineType: analog", and similar stale references.

---

### LR-08: src/components/gates/__tests__/analog-gates.test.ts:6-9

    Each gate type has engineType === "both"
    simulationModes includes logical and analog-pins for each gate

---

### LR-09: src/components/io/__tests__/analog-clock.test.ts:135,140

    it("engineType_is_both -- clock appears in both digital and analog palettes", ...
    it("simulationModes_includes_logical -- logical clock behavior preserved", ...

---

### LR-10: src/io/dts-schema.ts:103

    Accepts both format dts (current) and format digb (legacy compat).

---

### LR-11: src/io/dts-deserializer.ts:153

    Accepts both format dts (current) and format digb (legacy compat).

---

## Spec Deviation Assessment

The review assignment asked to evaluate whether three spec deviations are justified.

**Deviation 1** -- Remove noOpAnalogExecuteFn but progress says retained as @deprecated:
noOpAnalogExecuteFn is not present anywhere in src/. It was ultimately removed.
However progress.md records it as a deliberate @deprecated retention decision -- a
documented intent to break the rules. The fact it was cleaned up does not excuse the plan.
The note is stale and misleading.
Verdict: Not justified. Spec was eventually met but the documented deviation intent itself
violates rules.

**Deviation 2** -- Remove flat fields from ComponentDefinition interface but retained as @deprecated:
The ComponentDefinition interface in registry.ts does NOT contain the old flat fields --
they have been removed from the type. However production component files (pld/, graphics/,
misc/, terminal/) still place the removed flat fields in their definition objects, causing
906 TypeScript errors. The interface was cleaned but migration of individual component
files is incomplete.
Verdict: Not justified. Genuine incomplete spec implementation with breaking TypeScript errors.

**Deviation 3** -- Remove registry shimming from Phase 1 but _ensureModels retained:
_ensureModels does not appear anywhere in src/. It was removed. The progress.md summary
claims it was retained -- this note is inaccurate.
Verdict: Spec is met. Progress documentation is wrong.
