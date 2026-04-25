# SPICE `.SUBCKT` Import Pipeline — Implementation Plan

**Date:** 2026-04-25
**Alias:** This plan lives alongside (does not supersede) `spec/plan.md`, which is the in-progress Phase 3–10 ngspice-parity plan. Filenames must remain distinct.
**Triggering doc:** `spec/spice-import-pipeline-gaps.md` (the four-gap analysis surfaced during Phase 10 Wave 10.6).
**Authority:** All decisions below were taken by the author on 2026-04-25:
  - Match ngspice exactly. Line-for-line ports of `vcvsload.c`, `vccsload.c`, `cccsload.c`, `ccvsload.c`, including POLY. No invention.
  - Sibling `.lib` files supported via session-scoped model libraries (`circuit.metadata.models` is the existing scope).
  - Single shared headless apply helper in `src/app/spice-model-apply.ts`; the dialog becomes a thin wrapper.
  - Smoke-test macromodel is **OPAMP1** (Boyle macromodel — the ngspice-bundled `examples/Monte_Carlo/OpWien.sp:58-68` definition).
  - Round-trip parity smoke test gates the Wave 10.6 retry.

---

## Reader's orientation

Four pipeline gaps documented in `spec/spice-import-pipeline-gaps.md` resolve as a linear data-flow fix: parse → resolve models → carry inline `.MODEL`s → emit a real `.subckt` block on the ngspice side. The data drops at three named handoffs (`elementTypeId` switch, `subEl.modelRef` field divergence, `ELEMENT_SPECS` prefix table). The plan closes all four gaps plus three follow-on items (E/G/F/H controlled-source stamps line-for-line from ngspice, sibling-file `.lib` loading, and an OPAMP1 round-trip smoke test).

The plan adds 9 phases. Phase 0 removes legacy code that would otherwise water down planning agents' context; phases 1–7 build the replacement; phase 8 retries Wave 10.6 against the real OPAMP1 macromodel; phase 9 is the legacy reference audit.

---

## Goals

- A **published OPAMP1 `.subckt`** (the ngspice-bundled Boyle macromodel) parses, instantiates as a composite `MnaModel` whose internal transistors carry the `.MODEL` parameters declared inside the `.subckt`, and re-emits to ngspice as a syntactically equivalent `.subckt` block + `X` instance line that ngspice consumes bit-exact.
- The four documented gaps in `spec/spice-import-pipeline-gaps.md` are closed, with no symptomatic patches and no shims:
  - Parser recognises E/G/F/H linear forms **and** POLY(d) forms (line-for-line port of ngspice's controlled-source set/load functions).
  - `elementTypeId` mapping is driven by the parsed `.MODEL` device type, not by the prefix character.
  - Inline `.MODEL` cards from inside a `.SUBCKT` are carried through `MnaSubcircuitNetlist` and consumed by `compileSubcircuitToMnaModel` via `subEl.modelRef`.
  - Netlist generator emits `.subckt` definition blocks **and** `X<label>` instance lines for every host element backed by a `kind: "netlist"` model entry.
- A **single headless apply entrypoint** (`applySpiceSubcktImportFromText`) is the source of truth for both the GUI dialog and harness fixtures. The dialog calls it.
- **Sibling `.lib` files** load into the existing `circuit.metadata.models` session scope. A `.subckt` whose internal elements reference an external `.MODEL` resolves it from that scope.
- **OPAMP1 round-trip smoke test** asserts bit-exact DC-OP parity between digiTS and ngspice on a real macromodel. This test gates the Wave 10.6 retry.
- **Wave 10.6 retry** runs against the real OPAMP1 macromodel, not the behavioural `RealOpAmp` element. The F4c "self-compare only" carve-out for `real-opamp` is removed once that test is green.

## Non-Goals

- Behavioural-source (B-source) parsing or `.FUNC`/`.IF`/`.PARAM` arithmetic expressions inside a `.subckt`. Numeric `.PARAM` defaults stay supported via the existing pathway; expressions are not.
- Hierarchical `.subckt` nesting (a `.subckt` referencing another `.subckt` via an `X` line). The current MNA composite factory is one level deep; nesting is its own piece of work.
- BSIM / BSIM-SOI / HSPICE-extension `.MODEL` types beyond the ones already in the parser's `VALID_DEVICE_TYPES` set (NPN, PNP, NMOS, PMOS, NJFET, PJFET, D, TUNNEL).
- AC sweep parity for OPAMP1 — the smoke test asserts DC-OP and (separately, when transient parity is restored) timestep-aligned transient. Frequency-domain parity is out of scope.
- Sensitivity, noise, distortion analyses on imported subcircuits.
- The `RealOpAmp` element itself is **not removed** — the F4c carve-out is removed, but the behavioural element remains as a tutorial / quick-prototype convenience.

## Verification

- **Phase 0 done:** the dialog-only `elementTypeId(type: string)` switch is deleted. `netlist-generator.ts` no longer silently `continue`s on unknown prefixes (every skip path is an explicit diagnostic). `io/spice-model-builder.ts` is audited and either deleted (if redundant with `MnaSubcircuitNetlist`) or scoped to a non-overlapping responsibility documented in its file header. Build is red as expected.
- **Phase 1 done:** `parseSubcircuit` parses `E n+ n- nc+ nc- gain`, `E n+ n- POLY(d) c1+ c1- ... cd+ cd- coeff0 coeff1 ...`, and the matching `G/F/H` forms. `ParsedElement.type` includes `E | G | F | H`. `VALID_ELEMENT_PREFIXES` includes the four. Parser unit tests cover linear and POLY forms for all four types, with explicit coverage of the F/H "vname" current-sense reference. ngspice citations: `asrcpar.c`, `vcvspar.c`, `vccspar.c`, `cccspar.c`, `ccvspar.c`.
- **Phase 2 done:** `loadSpiceModelLibrary(text, scope)` exists and registers parsed `.MODEL` cards (and any top-level `.SUBCKT` definitions) into `circuit.metadata.models`. The dialog can attach a sibling-file uploader; the harness can load a sibling `.lib` from disk. Unit tests cover: load library, reference a `.MODEL` from a nested `.subckt`, unresolved-name produces a hard error (no silent fallback to `defaultModel`).
- **Phase 3 done:** `MnaSubcircuitNetlist.inlineModels: Record<modelName, ParsedModel>` is present and populated by `applySpiceSubcktImportFromText`. The dialog's apply path calls the helper. Unit tests cover: inline `.MODEL` survives parse → apply → `circuit.metadata.models[hostType][modelName].netlist.inlineModels[…]`.
- **Phase 4 done:** `compileSubcircuitToMnaModel` reads `subEl.modelRef`, resolves it against `netlist.inlineModels` first, then `circuit.metadata.models[subEl.typeId]`, then the registry's `modelRegistry`. The leaf factory's seeded `PropertyBag` carries the resolved params end-to-end. Q/M/J `typeId` selection is driven by the resolved `.MODEL` device type (`NPN→NpnBJT`, `PNP→PnpBJT`, `NMOS→NMOS`, `PMOS→PMOS`, etc.). Unresolved `modelRef` raises a hard diagnostic (`unresolved-model-ref`) — silent fall-back to `defaultModel` is gone.
- **Phase 5 done:** Targeted parity tests for the four controlled sources pass against ngspice DC-OP on small fixture circuits (one VCVS, one VCCS, one CCCS, one CCVS, plus one POLY case for each). Each `load()` is a line-for-line port of the corresponding `*load.c`, with `cite:` comments at every block. POLY evaluation matches ngspice to bit-exact precision on a representative quadratic case. CCCS/CCVS resolve their `vname` reference at compile time via the subcircuit's local namespace; an unresolved `vname` raises a hard diagnostic.
- **Phase 6 done:** `netlist-generator.ts` emits, for each unique `(typeId, modelName)` pair backed by a `kind: "netlist"` entry, one `.subckt <modelName> <ports>` block whose body lines are reconstructed from `netlist.elements` and `netlist.inlineModels`. For each host instance it emits `X<label> n1 n2 … <modelName>` using `pinNodeIds`. ngspice consumes the emitted deck without parse errors. Unit tests cover: round-trip an OPAMP1 deck through the generator and assert byte-for-byte (modulo whitespace) equivalence with the canonical file.
- **Phase 7 done:** New parity test `src/solver/analog/__tests__/ngspice-parity/opamp1-roundtrip.test.ts` loads the canonical OPAMP1 `.subckt` text, parses it, applies it to a `RealOpAmp` host element via the headless helper, runs digiTS DC-OP, emits the deck via the netlist generator, runs ngspice DC-OP, and asserts every node voltage matches bit-exact (using the existing `assertIterationMatch` infrastructure). Test must be green before Phase 8 begins.
- **Phase 8 done:** `opamp-inverting.test.ts` is rewritten to source its op-amp from the OPAMP1 `.subckt` import (not the behavioural `RealOpAmp`). Per-NR-iteration parity holds across all source-stepping sub-solves. The F4c "self-compare only" carve-out for `real-opamp` is removed from `spec/architectural-alignment.md` and from any test scaffolding that referenced it.
- **Phase 9 done:** Repo-wide search for the deleted identifiers (the old `elementTypeId` switch, dropped fields on `MnaSubcircuitNetlist`, the silent `continue` in `netlist-generator.ts`, the F4c carve-out language) returns zero hits outside `ref/ngspice/` and `spec/`. `npm test` (full suite) is green.

## Dependency Graph

```
Phase 0 (Dead Code Removal)                         ─── runs first, alone
  │
Phase 1 (Parser: E/G/F/H + POLY)                    ─── after 0
  │
  ├──→ Phase 2 (Sibling-file .lib loader)           ─── parallel after 1 ─┐
  ├──→ Phase 3 (Netlist data model + headless apply)─── parallel after 1 ─┤
  └──→ Phase 5 (Controlled-source MNA stamps)       ─── parallel after 1 ─┤
                                                                          │
Phase 4 (Compiler: modelRef resolution + polarity routing)                │
                                          ─── after 3 ──┐                 │
Phase 6 (Netlist generator: emit .subckt blocks)                          │
                                          ─── after 3 + 5 ────┐           │
                                                              │           │
Phase 7 (OPAMP1 round-trip parity smoke test)                 │           │
                          ─── after 1 + 2 + 4 + 5 + 6 ────────┴───────────┘
  │
Phase 8 (Wave 10.6 retry as real OPAMP1 parity)     ─── after 7
  │
Phase 9 (Legacy Reference Review)                   ─── runs last, after all
```

Phases 2, 3, and 5 are genuinely parallelisable after Phase 1 — they touch disjoint files (loader vs. data model+helper vs. component-internal load() implementations). Phase 4 only needs Phase 3. Phase 6 needs both Phase 3 (the data model it reads from) and Phase 5 (so it knows how to emit E/G/F/H lines for controlled sources inside a `.subckt`). Phase 7 is the integration gate.

---

## Phase 0: Dead Code Removal
**Depends on**: (none — runs first)

Remove all code, tests, imports, references, and helpers that will be replaced by phases 1–6. The build will break — that is expected and correct. Subsequent phases reconstruct each removed piece against the new architecture.

### Wave 0.1: Remove legacy mapping and dialog-coupled apply path
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Delete the `elementTypeId(type: string)` switch in the dialog. The replacement (driven by `.MODEL` deviceType lookup) lands in Phase 4; the helper that calls it lands in Phase 3. Remove the call site in the dialog's apply handler. The dialog will not compile after this — that is the intended state. | S | `src/app/spice-import-dialog.ts:324-338`, `src/app/spice-import-dialog.ts:131-169` |
| 0.1.2 | Delete the silent `continue` at `netlist-generator.ts:67` for host elements whose `typeId` is not in `ELEMENT_SPECS`. The replacement (subcircuit-aware emit) lands in Phase 6; in the meantime any unknown typeId must throw, so the next regression of the silent-drop class fails loudly. | S | `src/solver/analog/__tests__/harness/netlist-generator.ts` |
| 0.1.3 | Audit `src/io/spice-model-builder.ts`. It converts `ParsedSubcircuit → Circuit`, parallel to (not the same as) the `MnaSubcircuitNetlist` path. Determine whether it has any live consumer; if not, delete it and its test. If it has a live consumer, scope its file header to its surviving responsibility and add a `// note:` pointing at the new headless helper for the import path. **Banned outcome:** leaving it as-is on the assumption that a future phase will sort it out. | S | `src/io/spice-model-builder.ts`, `src/io/__tests__/spice-model-builder.test.ts` |
| 0.1.4 | In `compileSubcircuitToMnaModel`, delete the `subEl.params?.model as string` lookup at `compiler.ts:271`. This is the field-mismatch line — the dialog stores model name in `subEl.modelRef`. Replacement lands in Phase 4. | S | `src/solver/analog/compiler.ts:265-275` |
| 0.1.5 | Remove the F4c "real-opamp self-compare only" carve-out language from `spec/architectural-alignment.md` and any test scaffolding that referenced it. The replacement (real OPAMP1 parity) lands in Phase 8. | S | `spec/architectural-alignment.md`, any test files referencing F4c carve-out |

---

## Phase 1: Parser — E/G/F/H linear + POLY forms
**Depends on**: Phase 0

Extend `model-parser.ts` to recognise the four controlled-source element forms in linear and POLY shapes. Line-for-line citations to the corresponding ngspice `*par.c` files at every block.

### Wave 1.1: Type and prefix-set extension
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | Extend `ParsedElement.type` union to include `"E" \| "G" \| "F" \| "H"`. Add the four prefixes to `VALID_ELEMENT_PREFIXES`. | S | `src/solver/analog/model-parser.ts:42`, `src/solver/analog/model-parser.ts:349-351` |

### Wave 1.2: Linear element parsing
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Implement `parseElementLine` cases for `E` (VCVS, 4 nodes + gain) and `G` (VCCS, 4 nodes + transconductance). Cite `vcvspar.c` / `vccspar.c`. Add `controllingNodes` and `gain` (or `transconductance`) fields to `ParsedElement` (these are `E/G`-specific and may live under a discriminated union). | M | `src/solver/analog/model-parser.ts` |
| 1.2.2 | Implement `parseElementLine` cases for `F` (CCCS) and `H` (CCVS). Both reference a controlling voltage source by name (`vname`). The parser captures the `vname` token verbatim; cross-reference resolution happens at compile time (Phase 4 / Phase 5). Cite `cccspar.c` / `ccvspar.c`. | M | `src/solver/analog/model-parser.ts` |

### Wave 1.3: POLY(d) parsing
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.3.1 | Implement POLY(d) variant for E and G: `E n+ n- POLY(d) nc1+ nc1- ... ncd+ ncd- c0 c1 ...`. Capture `polyDimension`, `polyControllingPairs[]`, `polyCoefficients[]`. Cite `asrcpar.c` for the canonical POLY parse loop. | L | `src/solver/analog/model-parser.ts` |
| 1.3.2 | Implement POLY(d) variant for F and H: `F n+ n- POLY(d) vname1 vname2 ... vnamed c0 c1 ...`. Same cite. | L | `src/solver/analog/model-parser.ts` |
| 1.3.3 | Parser unit tests covering: linear E/G/F/H; POLY(1) E/G/F/H; POLY(2) E for representative quadratic; malformed POLY (missing dimension, wrong coefficient count) raises `ParseError` with line number. | M | `src/solver/analog/__tests__/model-parser-controlled.test.ts` (new) |

---

## Phase 2: Sibling-file `.lib` loader + session-scoped library resolution
**Depends on**: Phase 1
**Parallel with**: Phase 3, Phase 5

The existing `circuit.metadata.models[typeId][modelName]` is the session scope. This phase adds a way to populate it from a sibling library file (one that holds top-level `.MODEL` cards and/or `.SUBCKT` blocks), and adds a resolver that subcircuit compilation consults when a `modelRef` doesn't resolve inside the inline dictionary.

### Wave 2.1: Library loader
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | Implement `loadSpiceModelLibrary(text: string, circuit: Circuit, registry: ComponentRegistry): { added: string[]; errors: ParseError[] }`. Parses the text via `parseModelFile` and `parseSubcircuit` (extending the latter to cope with library-style streams that hold multiple `.SUBCKT…ENDS` blocks). Each parsed `.MODEL` is registered as an inline `ModelEntry` under the `typeId` matched from the deviceType (re-using the deviceType→typeId map from Phase 4 — coordinate). Each parsed `.SUBCKT` is registered as a `kind: "netlist"` entry (via the same `MnaSubcircuitNetlist` build path used by the dialog). | L | `src/app/spice-model-apply.ts` (or new file `src/app/spice-model-library.ts`) |
| 2.1.2 | Extend `parseSubcircuit` to support multi-`.SUBCKT` files. Currently it throws on nested `.SUBCKT` and treats the first one as the only one; library files commonly hold several. Add a sibling `parseSubcircuitFile(text)` that returns `ParsedSubcircuit[]` plus errors. Cite ngspice's `subckt.c` / `inpsubckt.c` for the multi-block parse loop. | M | `src/solver/analog/model-parser.ts` |

### Wave 2.2: Sibling-file uploader (GUI) and disk loader (harness)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | Add a "Load library file…" button to `spice-import-dialog.ts` that invokes `loadSpiceModelLibrary` against the active circuit. Show a per-file summary (N models added, M subcircuits added). | M | `src/app/spice-import-dialog.ts` |
| 2.2.2 | Add `loadSpiceModelLibraryFromPath(path: string, circuit, registry)` for the harness. Reads from disk (Node `fs.readFileSync`) and routes through `loadSpiceModelLibrary`. | S | new file under `src/solver/analog/__tests__/harness/` |

### Wave 2.3: Resolver and tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | In `compileSubcircuitToMnaModel`, when resolving `subEl.modelRef`: search inline dictionary → `circuit.metadata.models[subEl.typeId]` → `registry.modelRegistry`. Unresolved name raises `unresolved-model-ref` diagnostic. (Coordinates with Phase 4.) | M | `src/solver/analog/compiler.ts` |
| 2.3.2 | Tests: load a library that defines `.MODEL D1N914 D(...)`, import a subcircuit that references `D1N914`, assert the diode in the compiled subcircuit carries the library's `IS`/`N`/`RS` parameters end-to-end via `PropertyBag.getModelParam`. Test the unresolved-name hard-error path. | M | `src/app/__tests__/spice-model-library.test.ts` (new) |

---

## Phase 3: `MnaSubcircuitNetlist` data-model extension + headless apply helper
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 5

### Wave 3.1: Extend the netlist type
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Add `inlineModels?: Record<string, ParsedModel>` to `MnaSubcircuitNetlist` (keyed by uppercased model name). Update the JSDoc to spell out the resolution priority used by Phase 4. | S | `src/core/mna-subcircuit-netlist.ts` |
| 3.1.2 | Add `controllingNodes?: number[]` and `controllingSourceRef?: string` to `SubcircuitElement` (the latter for F/H `vname` cross-reference). Document that resolution is compile-time. | S | `src/core/mna-subcircuit-netlist.ts` |

### Wave 3.2: Headless apply helper
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.2.1 | Implement `applySpiceSubcktImportFromText(text: string, hostElement: CircuitElement, circuit: Circuit, registry: ComponentRegistry): { ok: true; subcktName: string } \| { ok: false; error: string }`. Internals: `parseSubcircuit` → build `MnaSubcircuitNetlist` (with `inlineModels` populated from `sc.models`, with `subEl.modelRef` populated from `el.modelName`, with controlling-node and `vname` capture for E/G/F/H) → call existing `applySpiceSubcktImportResult`. | L | `src/app/spice-model-apply.ts` |
| 3.2.2 | Refactor `spice-import-dialog.ts` apply handler to call `applySpiceSubcktImportFromText`. The dialog becomes a thin GUI wrapper — no per-element field copying, no `elementTypeId` switch. | M | `src/app/spice-import-dialog.ts` |
| 3.2.3 | Tests: import a `.subckt` whose body has `Q1 c b e QPMOD` and a `.MODEL QPMOD PNP(...)`; assert the resulting `MnaSubcircuitNetlist.inlineModels.QPMOD` exists with the parsed PNP params; assert the subcircuit element's `typeId` is `PnpBJT` (driven by deviceType lookup, validating the polarity-routing hookup). | M | `src/app/__tests__/spice-model-apply.test.ts` (extend) |

---

## Phase 4: Compiler — `modelRef` resolution + polarity routing
**Depends on**: Phase 3

### Wave 4.1: Polarity-driven typeId resolution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | Build `deviceTypeToTypeId(deviceType: string): string` from the registry — derive it by scanning all registered components and reading each `modelRegistry` entry's `.MODEL` device-type tag if present. Replaces the hardcoded prefix-character switch. The map is: `NPN→NpnBJT`, `PNP→PnpBJT`, `NMOS→NMOS`, `PMOS→PMOS`, `NJFET→NJFET`, `PJFET→PJFET`, `D→Diode`. Cite the ngspice device-type-to-implementation mapping in `dev.c`. | M | `src/core/registry.ts` (or new helper); used by `applySpiceSubcktImportFromText` |
| 4.1.2 | The headless helper (Phase 3.2.1) uses `deviceTypeToTypeId` to set `subEl.typeId` per-element, looking up the device type from the inline `.MODEL` (or library `.MODEL` via the Phase 2 resolver). For elements with no model (R/C/L/V/I) keep the prefix-driven typeId. For E/G/F/H drive typeId from the prefix (`E→Vcvs`, `G→Vccs`, `F→Cccs`, `H→Ccvs`). | M | `src/app/spice-model-apply.ts` |

### Wave 4.2: Compile-time `modelRef` resolution
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | In `compileSubcircuitToMnaModel`, replace the deleted `subEl.params?.model` lookup with the priority chain: `netlist.inlineModels[subEl.modelRef]` → `circuit.metadata.models[subEl.typeId][subEl.modelRef]` → `registry.get(subEl.typeId)?.modelRegistry?.[subEl.modelRef]` → `defaultModel`. Pass the resolved `ModelEntry`'s params through to the leaf factory's seed `PropertyBag` via `setModelParam`. Unresolved name → `unresolved-model-ref` diagnostic, factory returns null, element is skipped (consistent with existing skip semantics for missing models). | L | `src/solver/analog/compiler.ts:198-369` |
| 4.2.2 | Tests: subcircuit with one BJT referencing an inline `.MODEL`; assert the BJT's `IS`/`BF`/`NF` params land in the compiled element's `PropertyBag.getModelParam` reads. | M | `src/solver/analog/__tests__/subcircuit-modelref-resolve.test.ts` (new) |

### Wave 4.3: F/H controlling-source cross-reference
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.3.1 | When compiling a subcircuit, build a `vnameToBranchIndex: Map<string, number>` from the `V` elements inside the subcircuit. F and H elements look up their `controllingSourceRef` against this map at factory time and receive the resolved branch index. Unresolved `vname` raises `unresolved-controlling-source` diagnostic. Cite `cccssset.c` / `ccvssset.c` for the canonical cross-reference resolution. | L | `src/solver/analog/compiler.ts` |

---

## Phase 5: Controlled-source MNA stamps — line-for-line ports
**Depends on**: Phase 1
**Parallel with**: Phase 2, Phase 3

The four controlled-source components already exist as files (`src/components/active/{vcvs,vccs,cccs,ccvs}.ts`). This phase audits each against the corresponding ngspice `*load.c` and ports verbatim, including POLY evaluation. No invention. Every stamp block carries a `cite:` comment.

### Wave 5.1: Line-by-line load() ports (linear)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | Audit `vcvs.ts` `load()` against `vcvsload.c`. Branch row count, stamp pattern (`+1` / `-1` / `-gain` / `+gain` Jacobian entries), RHS contributions. Replace any divergence with verbatim port. | M | `src/components/active/vcvs.ts`, `ref/ngspice/src/spicelib/devices/vcvs/vcvsload.c` |
| 5.1.2 | Audit `vccs.ts` against `vccsload.c`. Pure conductance stamps, no branch row. | M | `src/components/active/vccs.ts`, `ref/ngspice/src/spicelib/devices/vccs/vccsload.c` |
| 5.1.3 | Audit `cccs.ts` against `cccsload.c`. Reads the controlling source's branch-row solution, stamps current. Branch index resolved by Phase 4.3. | M | `src/components/active/cccs.ts`, `ref/ngspice/src/spicelib/devices/cccs/cccsload.c` |
| 5.1.4 | Audit `ccvs.ts` against `ccvsload.c`. Has its own branch row plus reads the controlling source's branch row. | M | `src/components/active/ccvs.ts`, `ref/ngspice/src/spicelib/devices/ccvs/ccvsload.c` |

### Wave 5.2: POLY evaluation
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | Implement POLY(d) evaluation in each of the four stamps. The shape: at NR-iteration time, evaluate the polynomial from `polyCoefficients` over the controlling values (voltages or currents); the partial derivatives (Jacobian) are coefficient-multiplied and stamped. Cite `asrcload.c` for the canonical POLY load loop. | L | `src/components/active/{vcvs,vccs,cccs,ccvs}.ts` |
| 5.2.2 | Tests: one fixture per controlled-source × shape (linear, POLY(1), POLY(2)). DC-OP and a small transient compared bit-exact against ngspice using the existing parity harness. | L | `src/components/active/__tests__/controlled-source-parity.test.ts` (new), fixtures under `src/solver/analog/__tests__/ngspice-parity/fixtures/` |

### Wave 5.3: Registry wiring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.3.1 | Verify each of the four components is registered with a `modelRegistry` entry that the subcircuit compiler can resolve via `subEl.typeId = "Vcvs"` etc. If any of them is currently registered without a `modelRegistry` (some early-stage components are), add one with the correct `paramDefs` and a single inline entry. | S | `src/components/active/{vcvs,vccs,cccs,ccvs}.ts`, `src/components/register-all.ts` |

---

## Phase 6: Netlist generator — emit `.subckt` blocks for `kind: "netlist"` hosts
**Depends on**: Phase 3, Phase 5

### Wave 6.1: Subcircuit-aware emit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | Change the generator's signature from `(compiled, elementLabels, title)` to `(compiled, elementLabels, circuit, title?)` so it can resolve `circuit.metadata.models[hostTypeId][modelName].netlist` for each host instance. (Decision: pass the `Circuit` directly per the gap doc's preferred shape — simpler than building a map upstream.) | M | `src/solver/analog/__tests__/harness/netlist-generator.ts`, every call site |
| 6.1.2 | For each host element backed by a `kind: "netlist"` entry, accumulate `(modelName, MnaSubcircuitNetlist)` into a deduplicated map. After all instances are emitted, walk the map and emit one `.subckt <modelName> <port-labels>` block per entry. The body lines reconstruct each `subEl` via the same prefix-and-stamp logic the generator already applies to top-level elements (R/C/L/V/I/D/Q/M/J), plus the new E/G/F/H cases (line-for-line emit matching the parser's accepted forms). Inline `.MODEL` cards inside the netlist's `inlineModels` are emitted between the body lines and `.ends`. | L | `src/solver/analog/__tests__/harness/netlist-generator.ts` |
| 6.1.3 | For each host instance, emit `X<label> n1 n2 … <modelName>` using `pinNodeIds`. Pin/port ordering matches the host component's `pinLayout` 1-for-1. | M | same |

### Wave 6.2: Tests
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | Generator unit test: feed a compiled circuit with one `RealOpAmp` host whose model is the OPAMP1 netlist; assert the emitted text contains `.subckt OPAMP1 …`, the correct body (BJTs / Es / .MODELs), `.ends`, and `XU1 n1 n2 … OPAMP1` for the host. ngspice consumes the deck without parse errors (use the existing `ngspice-bridge` machinery). | M | `src/solver/analog/__tests__/harness/netlist-generator.test.ts` (extend) |

---

## Phase 7: OPAMP1 round-trip parity smoke test
**Depends on**: Phase 1, Phase 2, Phase 4, Phase 5, Phase 6

### Wave 7.1: Smoke test
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | Add fixture `src/solver/analog/__tests__/ngspice-parity/fixtures/opamp1.subckt` containing the canonical OPAMP1 macromodel (verbatim copy of `ref/ngspice/examples/Monte_Carlo/OpWien.sp:58-68`, with attribution comment). | S | new file |
| 7.1.2 | New test `opamp1-roundtrip.test.ts`: programmatically build a tiny circuit (a `RealOpAmp` host, two resistors for an inverter, ±15 V rails, 1 V DC input), call `applySpiceSubcktImportFromText` with the OPAMP1 text against the host, run digiTS DC-OP, run ngspice DC-OP via the bridge, assert per-NR-iteration `rhsOld[]` parity using `assertIterationMatch` (same gate as the rest of phase-10). The test exercises: parser (Gap 1 — E/G/F/H or pure BJT depending on OPAMP1 contents), polarity routing (Gap 2), inline `.MODEL` propagation (Gap 3), `.subckt` emit (Gap 4). | L | `src/solver/analog/__tests__/ngspice-parity/opamp1-roundtrip.test.ts` (new) |

---

## Phase 8: Wave 10.6 retry as real OPAMP1 parity
**Depends on**: Phase 7

### Wave 8.1: Switch the inverting amplifier to OPAMP1
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | Rewrite `opamp-inverting.test.ts` so the op-amp source is the imported OPAMP1 `.subckt`, not the behavioural `RealOpAmp`. Update the fixture `.dts` accordingly (host element's model property points to the imported subcircuit). | M | `src/solver/analog/__tests__/ngspice-parity/opamp-inverting.test.ts`, `src/solver/analog/__tests__/ngspice-parity/fixtures/opamp-inverting.dts` |
| 8.1.2 | Run the existing `assertIterationMatch` / `assertModeTransitionMatch` / `assertConvergenceFlowMatch` gates. If parity fails, the failure is in one of phases 1–6 — escalate per the regression policy in `CLAUDE.md`, do not patch the test. | M | same |

---

## Phase 9: Legacy Reference Review
**Depends on**: all previous phases

### Wave 9.1: Full legacy audit
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 9.1.1 | Repo-wide search for: the deleted `elementTypeId` switch (any remaining string-literal references), the silent `continue` in `netlist-generator.ts`, the old `subEl.params?.model` lookup, F4c "self-compare only" carve-out language, the `RealOpAmp` references in any test that should now use OPAMP1, and any `// TODO`/`// FIXME` comments referencing the four gaps. Zero hits outside `ref/ngspice/` and `spec/`. | M | (repo-wide) |
| 9.1.2 | Confirm `npm test` is green end-to-end. Confirm the OPAMP1 round-trip parity test is in the regular test path (not skipped, not gated behind a DLL flag the bridge tests use). | S | (repo-wide) |
