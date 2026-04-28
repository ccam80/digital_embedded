# `isReactive` / `isNonlinear` Removal — Edit Inventory

**Goal:** Delete `isReactive` and `isNonlinear` boolean fields from `AnalogElementCore` and every implementer. Replace runtime checks with method-presence checks (`typeof el.getLteTimestep === "function"` for the LTE gate; drop `isNonlinear` entirely since its only live consumer is blame-tracking, which can iterate all elements unconditionally).

**Scope (raw):** 597 occurrences across 143 `.ts` files in `src/`, plus 1 file in `scripts/` and 1 reference in `spec/progress.md` (historical log only — no code change).

**Aligned with:** ngspice's `DEVtrunc` function-pointer presence test in `CKTtrunc` (`ckttrunc.c`). ngspice has no equivalent of `isNonlinear`.

---

## 1. Core type / interface definitions (DELETE fields)

These are the source-of-truth declarations. Removing them flips ~140 downstream files into compile errors that the rest of this inventory addresses.

| File | Lines | Action |
|------|-------|--------|
| `src/solver/analog/element.ts` | 168–174, 176–182, 260–262, 273 | Delete `isNonlinear` and `isReactive` from `AnalogElementCore`. Delete `ReactiveAnalogElementCore` (and `ReactiveAnalogElement` type alias) — its only structural addition over `PoolBackedAnalogElementCore` is `isReactive: true`. Update all `ReactiveAnalogElement` consumers to use `PoolBackedAnalogElement`. |
| `src/core/analog-types.ts` | 298, 306 | Delete `isNonlinear` / `isReactive` from the duplicate `AnalogElementCore` definition here (this file is re-exported by solver/analog). |

---

## 2. Engine consumers (REWRITE behavior)

These are the only places that **read** the flags at runtime. Every other file just declares them.

| File | Lines | Current behavior | Replacement |
|------|-------|------------------|-------------|
| `src/solver/analog/timestep.ts` | 396–408, 670–688 | Two LTE loops gate on `if (!el.isReactive) continue;` then check `typeof el.getLteTimestep === "function"`. | Drop the `isReactive` gate; keep only the `typeof` check. Functionally identical. |
| `src/solver/analog/newton-raphson.ts` | 614 | Blame-tracking skips linear elements. | Drop the `if (!el.isNonlinear) continue;` line. Iterate all elements; blame still resolves to the largest-delta element. Diagnostic-only path, no numerical effect. |
| `src/solver/analog/ckt-context.ts` | 284–293, 529–533 | Precomputes four element-subset arrays: `nonlinearElements`, `reactiveElements`, `elementsWithLte`, `elementsWithAcceptStep`. | **Delete all four fields and their `.filter()` assignments.** All four are dead. `nonlinearElements` / `reactiveElements`: no engine consumer (only `ckt-context.test.ts`). `elementsWithLte`: dead — `timestep.ts:396, 670` iterates the full `elements` array and gates inline. `elementsWithAcceptStep`: dead — engine accept dispatch iterates the full element list. The two surviving precomputed lists (`_poolBackedElements` for state-pool init, `elementsWithConvergence` for `newton-raphson.ts:537–569`) stay. |
| `src/solver/analog/compiler.ts` | 313–314, 326–327 | Composite wrapper aggregates `anyNonlinear` / `anyReactive` from sub-elements and stamps them onto the wrapper core. | Delete both lines and the corresponding fields in the constructed `core` object literal. |
| `src/solver/analog/compiler.ts` | 1250 | `typeHint: element.branchIndex !== -1 ? element.isReactive ? "inductor" : "voltage" : "other"` — uses `isReactive` to distinguish inductor branches from VSRC branches in the partition topology blob. | Replace with `typeof element.getLteTimestep === "function" ? "inductor" : "voltage"` (inductors implement LTE, voltage sources don't). **Verify:** any other reactive branch element (mutual inductor) gets the correct hint. |
| `src/solver/analog/bridge-adapter.ts` | 43, 47, 58, 88, 168, 169, 180, 205 | Two adapter classes declare `isNonlinear: false` (literal) and `isReactive` as a getter that returns `true` only when a child capacitor is present. | Delete both fields/getters. Delete the comments referencing them. Bridge adapters' LTE behavior must come from whether their child elements implement `getLteTimestep` — confirm the composite-loading path already handles this. |
| `src/solver/analog/controlled-source-base.ts` | 95–96 | `readonly isNonlinear = true as const; readonly isReactive = false as const;` | Delete both lines. |

---

## 3. Component element declarations (DELETE field initializers)

Every component factory declares these two fields — usually two lines each (`readonly isNonlinear = ...; readonly isReactive = ...;` or as object-literal entries). Pure mechanical deletion. **75 files.**

### 3a. Passives (15)
- `src/components/passives/resistor.ts` — 156–157
- `src/components/passives/capacitor.ts` — 174–175
- `src/components/passives/inductor.ts` (4 occurrences — multiple element classes)
- `src/components/passives/polarized-cap.ts` (4)
- `src/components/passives/potentiometer.ts` (2)
- `src/components/passives/transformer.ts` (4)
- `src/components/passives/tapped-transformer.ts` (4)
- `src/components/passives/transmission-line.ts` (22 — multiple internal sub-elements)
- `src/components/passives/crystal.ts` (4)
- `src/components/passives/memristor.ts` (2)
- `src/components/passives/analog-fuse.ts` (2)

### 3b. Semiconductors (12)
- `src/components/semiconductors/diode.ts` (2)
- `src/components/semiconductors/zener.ts` (2)
- `src/components/semiconductors/tunnel-diode.ts` (2)
- `src/components/semiconductors/bjt.ts` (4)
- `src/components/semiconductors/mosfet.ts` (2)
- `src/components/semiconductors/njfet.ts` (2)
- `src/components/semiconductors/pjfet.ts` (2)
- `src/components/semiconductors/triac.ts` (2)
- `src/components/semiconductors/triode.ts` (2)
- `src/components/semiconductors/diac.ts` (2)
- `src/components/semiconductors/scr.ts` (2)

### 3c. Switching / FETs (10)
- `src/components/switching/switch.ts` (2)
- `src/components/switching/switch-dt.ts` (2)
- `src/components/switching/relay.ts` (2)
- `src/components/switching/relay-dt.ts` (2)
- `src/components/switching/nfet.ts` (4)
- `src/components/switching/pfet.ts` (2)
- `src/components/switching/fgnfet.ts` (6)
- `src/components/switching/fgpfet.ts` (6)
- `src/components/switching/trans-gate.ts` (2)

### 3d. Active / mixed-signal (10)
- `src/components/active/opamp.ts` (2)
- `src/components/active/real-opamp.ts` (2)
- `src/components/active/ota.ts` (2)
- `src/components/active/comparator.ts` (4)
- `src/components/active/schmitt-trigger.ts` (2)
- `src/components/active/timer-555.ts` (2)
- `src/components/active/optocoupler.ts` (2)
- `src/components/active/analog-switch.ts` (4)
- `src/components/active/adc.ts` (2)
- `src/components/active/dac.ts` (2)

### 3e. Sources (4)
- `src/components/sources/dc-voltage-source.ts` (2)
- `src/components/sources/ac-voltage-source.ts` (2)
- `src/components/sources/current-source.ts` (2)
- `src/components/sources/variable-rail.ts` (2)

### 3f. Sensors (3)
- `src/components/sensors/ldr.ts` (2)
- `src/components/sensors/ntc-thermistor.ts` (4)
- `src/components/sensors/spark-gap.ts` (2)

### 3g. IO (4)
- `src/components/io/led.ts` (2)
- `src/components/io/clock.ts` (2)
- `src/components/io/probe.ts` (2)
- `src/components/io/ground.ts` (2)

### 3h. Behavioral (solver/analog) (8)
- `src/solver/analog/behavioral-gate.ts` (2)
- `src/solver/analog/behavioral-combinational.ts` (6 — three element classes)
- `src/solver/analog/behavioral-sequential.ts` (9 — three element classes)
- `src/solver/analog/behavioral-flipflop.ts` (4)
- `src/solver/analog/behavioral-flipflop/d-async.ts` (2)
- `src/solver/analog/behavioral-flipflop/jk.ts` (4)
- `src/solver/analog/behavioral-flipflop/jk-async.ts` (2)
- `src/solver/analog/behavioral-flipflop/rs.ts` (4)
- `src/solver/analog/behavioral-flipflop/rs-async.ts` (2)
- `src/solver/analog/behavioral-flipflop/t.ts` (4)
- `src/solver/analog/behavioral-remaining.ts` (16 — multiple element classes; mix of `readonly` and object-literal forms; 4 of the 16 are object-literal entries that must come out of the literal)

---

## 4. Test infrastructure / fixture builders (DELETE field stubs; remove asserts)

These files construct synthetic elements for tests. Every stub must drop the two fields.

| File | Lines / Count | Notes |
|------|---------------|-------|
| `src/solver/analog/__tests__/test-helpers.ts` | 19 occurrences (e.g. 122, 182, 242, 323, 446, 568, 697; type imports at 29; `ReactiveAnalogElement` casts at 761, 1017, 1019) | Most-used fixture builder. Delete the fields from every `make*` helper return and remove `ReactiveAnalogElement` type imports (replace with `PoolBackedAnalogElement`). |
| `src/test-fixtures/registry-builders.ts` | 64–65 | Delete two field initializers. |
| `src/test-fixtures/model-fixtures.ts` | 18–19 | Delete two field initializers. |
| `src/solver/analog/__tests__/harness/types.ts` | 146–147 | The capture-blob type carries `isNonlinear: boolean; isReactive: boolean;`. Delete both. |
| `src/solver/analog/__tests__/harness/capture.ts` | 168–169 | Capture serializer copies `el.isNonlinear` / `el.isReactive`. Delete both lines. |
| `src/solver/analog/__tests__/harness/ngspice-bridge.ts` | 895 | One synthetic element literal — strip the two fields. |
| `src/solver/analog/__tests__/harness/netlist-generator.test.ts` | 74 | One synthetic element literal — strip the two fields. |
| `src/solver/analog/__tests__/harness/slice.test.ts` | 34–36 | Three test-blob entries that include the fields. Strip from each (and from any matching expected-shape assertions in the same file). |

---

## 5. Test files (DELETE asserts; UPDATE expected shapes)

These files assert on the flags or set them on test stubs. **~55 files.** Most are ≤4 occurrences and mechanical (delete property from object literal, delete `expect(el.isReactive).toBe(...)` line). A few have meaningful assertions that prove the flag was correctly propagated — those tests become obsolete with the field gone.

### 5a. Tests that ONLY assert on the flags (DELETE the affected `it(...)` blocks)

| File | Lines / Count | Notes |
|------|---------------|-------|
| `src/solver/analog/__tests__/ckt-context.test.ts` | 13 occurrences (51–53 comments, 141–142, 204–215) | The whole "precomputed lists" describe block tests `nonlinearElements` / `reactiveElements`. **Delete the entire block** — the precomputed lists are gone. |
| `src/solver/analog/__tests__/element-interface.test.ts` | 12 occurrences | Validates that elements expose the two boolean fields. **Delete or rewrite** — the contract has changed. |
| `src/solver/analog/__tests__/behavioral-gate.test.ts` | 387, 388, 436, 437, 447, 458, 469 | Asserts `expect(el.isReactive/isNonlinear).toBe(...)`. Delete each `expect`. If a test exists *only* to verify these flags, delete the `it(...)`. |
| `src/solver/analog/__tests__/behavioral-combinational.test.ts` | 375, 376, 387, 388, 399, 400 | Same pattern. |
| `src/solver/analog/__tests__/behavioral-sequential.test.ts` | 413, 414, 432, 433 | Same pattern. |
| `src/solver/analog/__tests__/behavioral-remaining.test.ts` | 4 occurrences | Same pattern. |
| `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` | 40, 55 | `expect(children[0].isReactive).toBe(true)`. Replace with assertion on `getLteTimestep` presence, or delete if redundant with other coverage. |
| `src/core/__tests__/analog-types-setparam.test.ts` | 4 occurrences | Synthetic element literals that include the fields. |
| `src/solver/analog/__tests__/timestep.test.ts` | 45, 57 | Sets `isReactive: true` on a fixture; LTE loop gate is now method-based, so the fixture only needs `getLteTimestep`. Drop the field; verify `getLteTimestep` is present. |
| `src/solver/analog/__tests__/rc-ac-transient.test.ts` | 431, 435 | `compiled.elements.filter(e => e.isReactive)` to count reactive elements. Replace filter predicate with `typeof e.getLteTimestep === "function"` or delete if assertion is redundant. |

### 5b. Tests that include the fields in element-shape stubs (mechanical strip — no assertion change)

These set `isNonlinear: false, isReactive: false` (or similar) when constructing minimal stub elements for unrelated test purposes. Each occurrence is a property to remove from an object literal.

- `src/solver/analog/__tests__/analog-engine.test.ts` (2)
- `src/solver/analog/__tests__/ac-analysis.test.ts` (6)
- `src/solver/analog/__tests__/compiler.test.ts` (6)
- `src/solver/analog/__tests__/compile-analog-partition.test.ts` (5)
- `src/solver/analog/__tests__/dc-operating-point.test.ts` (6)
- `src/solver/analog/__tests__/dcop-init-jct.test.ts` (3)
- `src/solver/analog/__tests__/digital-pin-loading.test.ts` (4)
- `src/solver/analog/__tests__/spice-import-dialog.test.ts` (7)
- `src/solver/analog/__tests__/convergence-regression.test.ts` (4)
- `src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts` (1)
- `src/compile/__tests__/compile.test.ts` (4)
- `src/compile/__tests__/compile-integration.test.ts` (6)
- `src/compile/__tests__/coordinator.test.ts` (3)
- `src/compile/__tests__/pin-loading-menu.test.ts` (2)
- `src/solver/__tests__/coordinator-capability.test.ts` (3)
- `src/solver/__tests__/coordinator-clock.test.ts` (2)
- `src/solver/__tests__/coordinator-speed-control.test.ts` (2)
- `src/editor/__tests__/wire-current-resolver.test.ts` (2)

### 5c. Component-level tests (mechanical strip)

Most assert on the component's reported flags or include them in shape comparisons. Same mechanical strip; in a few cases delete an `it("declares isReactive === true")` block.

- `src/components/io/__tests__/led.test.ts` (7)
- `src/components/io/__tests__/probe.test.ts` (2)
- `src/components/io/__tests__/analog-clock.test.ts` (2)
- `src/components/passives/__tests__/resistor.test.ts` (4)
- `src/components/passives/__tests__/capacitor.test.ts` (7)
- `src/components/passives/__tests__/inductor.test.ts` (7) — explicit "is_reactive_true" / "declares isReactive === true" tests; delete those blocks.
- `src/components/passives/__tests__/polarized-cap.test.ts` (9)
- `src/components/passives/__tests__/transformer.test.ts` (5)
- `src/components/passives/__tests__/transmission-line.test.ts` (10)
- `src/components/passives/__tests__/crystal.test.ts` (10)
- `src/components/passives/__tests__/memristor.test.ts` (3)
- `src/components/passives/__tests__/analog-fuse.test.ts` (4)
- `src/components/semiconductors/__tests__/diode.test.ts` (15)
- `src/components/semiconductors/__tests__/zener.test.ts` (7)
- `src/components/semiconductors/__tests__/tunnel-diode.test.ts` (7)
- `src/components/semiconductors/__tests__/bjt.test.ts` (17)
- `src/components/semiconductors/__tests__/mosfet.test.ts` (13)
- `src/components/semiconductors/__tests__/jfet.test.ts` (9)
- `src/components/semiconductors/__tests__/scr.test.ts` (9)
- `src/components/semiconductors/__tests__/triac.test.ts` (3)
- `src/components/semiconductors/__tests__/triode.test.ts` (3)
- `src/components/active/__tests__/opamp.test.ts` (2)
- `src/components/active/__tests__/real-opamp.test.ts` (12)
- `src/components/active/__tests__/comparator.test.ts` (1)
- `src/components/active/__tests__/timer-555.test.ts` (4)
- `src/components/active/__tests__/optocoupler.test.ts` (1)
- `src/components/active/__tests__/analog-switch.test.ts` (8)
- `src/components/active/__tests__/adc.test.ts` (1)
- `src/components/active/__tests__/dac.test.ts` (1)
- `src/components/sources/__tests__/dc-voltage-source.test.ts` (2)
- `src/components/sources/__tests__/current-source.test.ts` (2)
- `src/components/sources/__tests__/ground.test.ts` (2)
- `src/components/sources/__tests__/variable-rail.test.ts` (5)
- `src/components/sensors/__tests__/ldr.test.ts` (2)
- `src/components/sensors/__tests__/ntc-thermistor.test.ts` (1)
- `src/components/sensors/__tests__/spark-gap.test.ts` (2)

---

## 6. Scripts (UPDATE)

| File | Lines | Action |
|------|-------|--------|
| `scripts/mcp/harness-tools.ts` | 180–181, 321–322, 634–635 | Three places copy `el.isNonlinear` and `el.isReactive` into harness-export blobs. Delete both fields from each blob. **Caution:** if the blob shape is consumed by an external harness JSON consumer (ngspice comparison, recorded fixtures), check whether dropping the fields breaks downstream parsers. May need a coordinated update of any captured `.json` fixtures under `src/solver/analog/__tests__/harness/fixtures/` (verify before commit). |

---

## 6b. `mayCreateInternalNodes` — fully dead, delete in same pass

**Field summary:** Optional `boolean` on `ModelEntry` (registry) and `ComponentDefinition` (compile types). Documented as "used by `detectVoltageSourceLoops` and `detectInductorLoops` to size worst-case topology." That documentation is **incorrect** — both detection functions in `src/solver/analog/compiler.ts:483, 530` take `topologyInfo` (a `{nodeIds, isBranch, typeHint}` shape) and never consult the registry entry. The field is set in 47 places, read by zero engine code, and asserted in 2 tests that only check that the field equals `true`.

**Why include in this pass:** same blast radius pattern (boolean metadata field, set on every component, never gating runtime behavior), and the same `tsc --noEmit` pass that finds remaining `isReactive`/`isNonlinear` references will surface these. Bundling avoids a second sweep.

### Type-def deletions (2 files)

| File | Lines | Action |
|------|-------|--------|
| `src/core/registry.ts` | 109–112 | Delete `mayCreateInternalNodes?: boolean;` from `ModelEntry` and its 3-line JSDoc. |
| `src/compile/types.ts` | 142–146 | Delete `mayCreateInternalNodes?: boolean;` from `ComponentDefinition` and its JSDoc. |

### Component declaration deletions (~20 files, 47 occurrences)

Each is a single line in a `ModelEntry` object literal. Pure mechanical deletion.

- `src/components/semiconductors/diode.ts` (1 — line 1094)
- `src/components/semiconductors/zener.ts` (1 — line 670)
- `src/components/semiconductors/varactor.ts` (1 — line 220)
- `src/components/semiconductors/schottky.ts` (1 — line 224)
- `src/components/semiconductors/bjt.ts` (12 — lines 2351–2466)
- `src/components/semiconductors/mosfet.ts` (12 — lines 1995–2114)
- `src/components/semiconductors/njfet.ts` (1 — line 1043)
- `src/components/semiconductors/pjfet.ts` (1 — line 1004)
- `src/components/passives/inductor.ts` (1 — line 471)
- `src/components/switching/relay.ts` (1 — line 583)
- `src/components/switching/relay-dt.ts` (1 — line 456)
- `src/components/switching/fgnfet.ts` (1 — line 1038)
- `src/components/switching/fgpfet.ts` (1 — line 981)
- `src/components/active/opamp.ts` (1 — line 354)
- `src/components/active/timer-555.ts` (2 — lines 818, 825)
- `src/components/active/optocoupler.ts` (1 — line 606)
- `src/components/active/adc.ts` (4 — lines 593, 601, 609, 617)
- `src/components/active/dac.ts` (2 — lines 551, 559)
- `src/components/active/analog-switch.ts` (2 — lines 705, 737)
- `src/components/wiring/driver-inv.ts` (1 — line 239)

### Test deletions (2 files)

| File | Lines | Action |
|------|-------|--------|
| `src/components/semiconductors/__tests__/varactor.test.ts` | 148–152 (whole `it("mayCreateInternalNodes_true")` block) | Delete the entire `it(...)` — it tests only the field's presence, which will no longer exist. |
| `src/components/active/__tests__/optocoupler.test.ts` | 103–107 (whole `it("modelRegistry behavioral entry has mayCreateInternalNodes=true")` block) | Same — delete the `it(...)`. |

### Documentation (NO CODE CHANGE)

The `spec/setup-load-split/` and `spec/progress.md` references (~85 markdown files) are spec/historical and should be left as-is for archival accuracy. If desired, append a follow-on `progress.md` entry recording the removal alongside the `isReactive`/`isNonlinear` removal.

### Risk callouts (mayCreateInternalNodes-specific)

1. **Are external tools using it?** — Grep `**/*.json` and `scripts/**` for the literal string. Quick check: only the 2 test files and the 2 type-defs read it; no JSON consumers found. Low risk.
2. **Was it intended for future use?** — The JSDoc claims it sizes worst-case topology for the loop detectors. If we later want this optimization, the right move is to reintroduce it as a *consumed* field with the actual call site, not preserve a dead declaration. Removing now and re-adding later is cheaper than maintaining 47 unused declarations.

### Updated edit-count summary

| Category | Files | Approx LOC delta |
|----------|-------|------------------|
| (existing §1–§6) | ~148 | −530 |
| `mayCreateInternalNodes` type defs (§6b) | 2 | −10 |
| `mayCreateInternalNodes` component decls (§6b) | 20 | −47 |
| `mayCreateInternalNodes` tests (§6b) | 2 | −10 |
| **Total** | **~170** | **~−597 LOC** |

---

## 6c. Other dead / borderline-dead fields surfaced by the audit

Auditing the remaining fields on `AnalogElement`, `PoolBackedAnalogElementCore`, `ModelEntry`, `MnaModel`, `ModelEmissionSpec`, and `CktContext` for production consumers.

### Definite dead — include in this pass

#### A. `AnalogElement.refreshSubElementRefs?`
**Status:** Zero implementations, zero callers anywhere in the codebase.

| File | Lines | Action |
|------|-------|--------|
| `src/solver/analog/element.ts` | 238–241 | Delete the optional method declaration from `PoolBackedAnalogElementCore`. |

Grep evidence: `refreshSubElementRefs` matches in exactly one location — its own declaration. No `.refreshSubElementRefs(` call sites; no element factory implements it. The 8-arg signature (`s0..s7`) suggests it was added speculatively for state-pool resize handling that was never wired up.

#### B. `ModelEmissionSpec.modelCardPrefix`
**Status:** Only consumed by test-harness code (`src/solver/analog/__tests__/harness/netlist-generator.ts:263`). Production has zero consumers, and the JSDoc itself admits it: *"not used by any component in this cleanup; see ngspice-netlist-generator-architecture.md §3.7a."*

| File | Lines | Action |
|------|-------|--------|
| `src/core/registry.ts` | 76–85 | Delete `ModelEmissionSpec.modelCardPrefix` (and JSDoc). If `ModelEmissionSpec` becomes empty, delete the interface entirely and remove the `spice?: ModelEmissionSpec` field on both `ModelEntry` variants (lines 107–108, 122–123). |
| `src/solver/analog/__tests__/harness/netlist-generator.ts` | 263 | Delete the `modelCardPrefix` consumer line. |
| Test fixtures referencing `spice: { modelCardPrefix: ... }` | grep before deleting | Verify zero non-harness consumers. |

**Caveat:** `spice?: ModelEmissionSpec` is an extension point; deleting `modelCardPrefix` may be enough without removing the wrapper if other emission overrides are anticipated. Recommend deleting just `modelCardPrefix` and leaving `ModelEmissionSpec` as an empty (or near-empty) struct only if there are pending fields to add.

#### D. `PoolBackedAnalogElementCore.poolBacked: true` discriminator
**Status:** Same redundancy pattern as `isReactive` — a boolean that duplicates a structural method's presence.

**Current shape:**
```ts
// element.ts:233
export interface PoolBackedAnalogElementCore extends AnalogElementCore {
  readonly poolBacked: true;          // ← discriminator
  readonly stateSize: number;
  stateBaseOffset: number;
  readonly stateSchema: StateSchema;
  initState(pool: StatePoolRef): void;
  ...
}

// element.ts:275–278
export function isPoolBacked(el: AnalogElement): el is PoolBackedAnalogElement {
  return (el as any).poolBacked === true;
}
```

Every `isPoolBacked(el)` call site (`analog-engine.ts:193, 263, 815, 924`, `ckt-context.ts:793`, `harness/capture.ts:196`, `test-helpers.ts:755, 762, 814`) immediately uses the narrowed element to call `initState`, read `stateSchema`, or read `stateBaseOffset`. The boolean adds nothing the method-presence check doesn't already enforce.

**Behavioral wrappers are the most flagrant case:** their `*_COMPOSITE_SCHEMA` is literally empty (`defineStateSchema("BehavioralCombinationalComposite", [])`, line 32 of `behavioral-combinational.ts`). The wrapper carries zero state of its own — `poolBacked: true` exists purely so the engine's pool-init pass calls the wrapper's `initState()`, which then forwards offsets to children. But the same redundancy applies to every leaf pool-backed element (capacitor, diode, BJT, etc.) — they all carry both the boolean AND `initState`.

**Replacement:** Use the method-presence test as the runtime discriminator and drop the boolean.

```ts
// new isPoolBacked
export function isPoolBacked(el: AnalogElementCore): el is PoolBackedAnalogElementCore {
  return typeof (el as any).initState === "function";
}
```

**Files (~50):**

| Bucket | Action |
|--------|--------|
| `solver/analog/element.ts:233` | Delete `readonly poolBacked: true;` from `PoolBackedAnalogElementCore`. |
| `solver/analog/element.ts:275–278` | Rewrite `isPoolBacked` to test `initState` presence. |
| Behavioral wrappers (10 occurrences across `behavioral-gate.ts:86`, `behavioral-combinational.ts:84/240/383`, `behavioral-sequential.ts:86/281/546`, `behavioral-flipflop.ts:102`, `behavioral-flipflop/{d,jk,jk-async,rs,rs-async,t}-async.ts`, `behavioral-remaining.ts:89/236/388`) | Delete `readonly poolBacked = true as const;` |
| `bridge-adapter.ts:61, 183` | Delete the two declarations. |
| Pool-backed leaf components (~30 across passives, semiconductors, switching, active, IO) | Delete `poolBacked: true as const,` from each factory's element literal or class body. Files: `capacitor.ts:173`, `inductor.ts:189`, `polarized-cap.ts:270`, `crystal.ts:255`, `transmission-line.ts:339/454/565/683`, `transformer.ts:235`, `tapped-transformer.ts:227`, `diode.ts:536`, `bjt.ts:578/1217`, `mosfet.ts:854`, `pjfet.ts:300`, `njfet.ts:322`, `tunnel-diode.ts:277`, `zener.ts:232`, `timer-555.ts:382`, `schmitt-trigger.ts:186`, `analog-switch.ts:291/408`, `comparator.ts:259/418`, `adc.ts:408`, `dac.ts:366`, `led.ts:240` |
| `test-helpers.ts:327` | Delete one fixture entry. |

Risk: zero. The `isPoolBacked` rewrite preserves runtime semantics exactly (every current `poolBacked: true` element also has `initState`; no non-pool-backed element has it).

### Borderline — propose deletion, but flag for user decision

#### C. `AnalogElement.allNodeIds` + `AnalogElement.internalNodeLabels` + `ModelEntry.getInternalNodeLabels`
**Status:** Test-harness consumers only.

- `allNodeIds` is **set** in 14 production files (transmission-line, transformer, polarized-cap, potentiometer, crystal, analog-fuse, tapped-transformer, bridge-adapter, plus mosfet test fixtures), but **read** only by `src/solver/analog/__tests__/harness/capture.ts:113`. No engine code reads it.
- `internalNodeLabels` is **set** in `bridge-adapter.ts:80, 197` (always to `[]`) and **read** only by `harness/capture.ts:111`.
- `getInternalNodeLabels` is **defined** on the `ModelEntry` type and implemented in `transmission-line.ts:1027` and the compiler's inline composite path (`compiler.ts:362`). It is **read** only by the harness capture path (which populates `internalNodeLabels` from it).

The whole triplet exists to give the test harness pretty labels like `Q1:B'` for internal nodes during ngspice comparison. None of it affects compiled circuit behavior.

**Decision required:**

- **Drop all three** — saves ~25 LOC across 14 component files. Harness test output loses internal-node labels (becomes generic `internal[3]` or similar). Acceptable if those labels aren't load-bearing for any `architectural-alignment.md` checks.
- **Keep all three** — unchanged.
- **Move to harness-only path** — relocate `internalNodeLabels` from `AnalogElement` onto a harness-side structure that the capture path computes itself. This is the cleanest architectural option but requires the harness to re-derive the labels, which may not be feasible without the model's metadata.

Recommend **drop all three** unless the harness diagnostic labels are referenced in fixture-comparison scripts or `architectural-alignment.md`. Caller list to verify before deletion:
- `bridge-adapter.ts:79–80, 196–197` (clears both fields)
- `transmission-line.ts:260, 299, 358, 473, 585, 705, 1027` (sets/declares)
- `transformer.ts:282`, `tapped-transformer.ts:310`, `crystal.ts:296`, `analog-fuse.ts:136`, `polarized-cap.ts:324`, `potentiometer.ts:187` (sets `allNodeIds`)
- `compiler.ts:362` (inline composite `getInternalNodeLabels` for behavioral wrappers)

If kept, leave them for a separate pass — they're not in the same conceptual cluster as `isReactive`/`isNonlinear`/`mayCreateInternalNodes`.

### Confirmed alive — leave in place

These were checked and have real production consumers:

| Field | Confirmed consumer |
|-------|-------------------|
| `AnalogElement.nextBreakpoint?` | `clock.ts:348`, `ac-voltage-source.ts:886` (called from getBreakpoints / acceptStep) |
| `AnalogElement.acceptStep?` | engine accept-loop (`elementsWithAcceptStep`) |
| `AnalogElement.checkConvergence?` | `newton-raphson.ts:537–569` via `elementsWithConvergence` |
| `AnalogElement.getLteTimestep?` | `timestep.ts:400, 681` (the survivor of §2 after `isReactive` removal) |
| `AnalogElement.elementIndex?` | `triac.ts:304, 313`, `scr.ts:286` for LimitingEvent attribution |
| `AnalogElement.label?` | Diagnostic.involvedElements descriptions |
| `PoolBackedAnalogElementCore.s4..s7` | 7 production files (bjt, mosfet, timer-555, adc, dac, analog-switch, schmitt-trigger, comparator) |
| `PoolBackedAnalogElementCore.stateSchema` | state-pool inspection / debugger |
| `PoolBackedAnalogElementCore.stateSize` | state-pool allocation |
| `PoolBackedAnalogElementCore.initState` | `ckt-context.ts:705` allocateStateBuffers |
| `ModelEntry.branchCount?` | engine setup |
| `ModelEntry.getInternalNodeCount?` | engine setup |
| `ModelEntry.ngspiceNodeMap?` | netlist generator (production path) |
| `MnaModel.findBranchFor?` | lazy-branch resolver (production path) |
| `CktContext._poolBackedElements` | `ckt-context.ts:705` (state-pool init loop) |
| `CktContext.elementsWithConvergence` | `newton-raphson.ts:537–569` |
| `CktContext.elementsWithLte` | filter declared but check engine consumer carefully — *ackpath only*; if dead, add to §2 (verify). |
| `CktContext.elementsWithAcceptStep` | engine accept loop (verify) |

> **Follow-up:** I noticed `elementsWithLte` and `elementsWithAcceptStep` are declared and populated in `ckt-context.ts:531–533`, but I did not enumerate their consumers. Worth a 30-second grep before assuming live — if either is dead, it joins `nonlinearElements` / `reactiveElements` for removal in §2.

### Updated edit-count summary

| Category | Files | Approx LOC delta |
|----------|-------|------------------|
| (existing §1–§6b) | ~170 | −597 |
| `refreshSubElementRefs?` (§6c-A) | 1 | −4 |
| `modelCardPrefix` (§6c-B) | 2 (+ fixtures) | −12 |
| `allNodeIds` + `internalNodeLabels` + `getInternalNodeLabels` (§6c-C, optional) | ~16 | −40 |
| **Total (incl. §6c-C)** | **~188** | **~−653 LOC** |
| **Total (excl. §6c-C)** | **~173** | **~−613 LOC** |

---

## 7. Documentation (NO CODE CHANGE)

| File | Lines | Action |
|------|-------|--------|
| `spec/progress.md` | 174, 194, 195, 367, 373, 417, 439 | Historical task log entries describing W2/W2.5/3.B3 work that established these fields. **Leave as-is** — historical record. Optionally append a follow-on entry recording this removal. |

---

## 8. Type-removal cascade

After deleting `isReactive: true` from `ReactiveAnalogElementCore`, the structural type collapses into `PoolBackedAnalogElementCore`. Either:

- **Option A1:** Delete `ReactiveAnalogElementCore` and `ReactiveAnalogElement`. Update every import (`test-helpers.ts:29`, `compiler.ts` if it imports it, plus ~3 other call sites) to use `PoolBackedAnalogElement` directly.
- **Option A2:** Keep `ReactiveAnalogElement` as a structural alias (`= PoolBackedAnalogElement`) for readability — noop at the type level. Slightly hides the change.

Recommend **A1** to avoid leaving a vestigial alias.

---

## Edit count summary

| Category | Files | Approx LOC delta |
|----------|-------|------------------|
| Type/interface defs (§1) | 2 | −20 |
| Engine consumers (§2) | 7 | −15 (rewrites, not just deletions) |
| Component declarations (§3) | 75 | −180 |
| Test infra/fixtures (§4) | 8 | −60 |
| Test files (§5) | 55 | −250 (incl. some deleted `it(...)` blocks) |
| Scripts (§6) | 1 | −6 |
| **Total** | **~148** | **~−530 LOC** |

---

## Risk callouts

1. **`compiler.ts:1250` (typeHint inductor vs voltage)** is the only non-mechanical engine edit. Verify: `inductor.ts`, `tapped-transformer.ts`, `transformer.ts`, `crystal.ts`, `transmission-line.ts` all implement `getLteTimestep`. Voltage sources (`dc-voltage-source.ts`, `ac-voltage-source.ts`, `variable-rail.ts`) must NOT implement it. Confirm before merging.
2. **`bridge-adapter.ts`** — the `isReactive` getter currently returns `true` only when a child capacitor is present. After removal, callers that need this distinction must either iterate the children to find one with `getLteTimestep`, or the wrapper must forward the call. Verify the LTE loop's behavior on bridge adapters before/after.
3. **`harness-tools.ts` capture serialization** — if any persisted fixture JSON file under `src/solver/analog/__tests__/harness/` has `isNonlinear`/`isReactive` keys, downstream parity tools may need a coordinated update. Grep `**/*.json` for the keys before deleting from the writer.
4. **Composite wrapper (compiler.ts:313–327)** — composite wrappers currently aggregate child reactivity. After removal, the composite's `getLteTimestep` (if any) must drive its inclusion in the LTE loop. Verify composites that wrap reactive children either define `getLteTimestep` themselves or expose children individually to the engine.

---

## Suggested execution order

1. Add `getLteTimestep` to all elements that need it (audit-only — should already be the case for everything currently `isReactive: true`).
2. Rewrite the 7 engine consumer files (§2) — this is where behavior changes.
3. Delete the type-level field declarations (§1, §8).
4. Run `npx tsc --noEmit`. The compiler will list every remaining offender — work through §3, §4, §5 mechanically. Most will be one-line property deletions.
5. Run targeted tests (`npm run test:q`) per the `targeted_tests_only` rule; full-suite verification last.
6. Have verifier confirm: no production references to `isReactive`/`isNonlinear`/`reactiveElements`/`nonlinearElements`/`ReactiveAnalogElement` remain.
