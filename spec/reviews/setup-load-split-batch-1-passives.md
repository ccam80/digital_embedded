# Spec Review: Batch 1 — Component Passives (PB-CAP through PB-TLINE)

## Overall Batch Verdict: needs-revision

---

## 1. Summary Table

| File | Verdict | Critical | Major | Minor | Info |
|------|---------|----------|-------|-------|------|
| PB-CAP.md | ready | 0 | 0 | 0 | 0 |
| PB-IND.md | ready | 0 | 0 | 0 | 0 |
| PB-RES.md | ready | 0 | 0 | 0 | 0 |
| PB-POLCAP.md | needs-revision | 0 | 1 | 1 | 1 |
| PB-POT.md | needs-revision | 0 | 1 | 1 | 0 |
| PB-MEMR.md | needs-revision | 0 | 0 | 1 | 1 |
| PB-XFMR.md | needs-revision | 0 | 1 | 1 | 0 |
| PB-TAPXFMR.md | needs-revision | 0 | 0 | 1 | 1 |
| PB-CRYSTAL.md | needs-revision | 0 | 1 | 2 | 0 |
| PB-FUSE.md | needs-revision | 0 | 1 | 1 | 0 |
| PB-AFUSE.md | ready | 0 | 0 | 0 | 0 |
| PB-NTC.md | needs-revision | 0 | 0 | 1 | 0 |
| PB-LDR.md | needs-revision | 0 | 0 | 1 | 0 |
| PB-TLINE.md | needs-revision | 0 | 2 | 0 | 0 |

---

## 2. Per-File Findings

### PB-CAP.md: ready, 0 findings

### PB-IND.md: ready, 0 findings

### PB-RES.md: ready, 0 findings

---

### PB-POLCAP.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 1 | 0 | 1 |
| info     | 0 | 1 | 1 |

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FPOLCAP-M1 | minor | PB-POLCAP.md §Verification gate, item 2 | Reads "src/components/passives/__tests__/analog-fuse.test.ts and any polarized-cap test file are GREEN." The analog-fuse test file is unrelated to the polarized cap. The correct test file is `src/components/passives/__tests__/polarized-cap.test.ts` (verified to exist). | Replace `src/components/passives/__tests__/analog-fuse.test.ts and any polarized-cap test file` with `src/components/passives/__tests__/polarized-cap.test.ts` |

#### Decision-Required Items

##### FPOLCAP-D1 — Clamp diode TSTALLOC sequence not specified (major)
- **Location**: PB-POLCAP.md §TSTALLOC sequence, "Clamp DIO" section
- **Problem**: The spec states: "Clamp diode sub-element setup (diosetup.c pattern, anode=neg, cathode=pos). Refer to the `PB-DIO.md` spec for the exact DIO TSTALLOC sequence. The clamp diode sub-element's `setup()` allocates its own handles." The TSTALLOC table simply says "Clamp DIO — refer to PB-DIO.md" with no position numbers, no handle field names, and no row/col pairs listed inline. PB-DIO.md is not in this review batch (it is not a passives spec). An implementer following only PB-POLCAP.md (as the W3 agent is supposed to do — one file each) cannot determine the exact (row, col) pairs or the count of stamps the clamp diode contributes, nor where in the global insertion order they fall relative to entries 8 (last LEAK_NP) and 9 (first CAP_PP).
- **Why decision-required**: There are at least two plausible resolutions: (A) inline the DIO TSTALLOC sequence directly in PB-POLCAP.md (makes the spec self-contained per the one-file-per-agent rule); or (B) explicitly require the PB-POLCAP implementer to also read PB-DIO.md before implementing. Option B relaxes the "one file per agent" contract. Which is acceptable is a design decision.
- **Options**:
  - **Option A — Inline the DIO sequence**: Copy the diode TSTALLOC table (anode=negNode, cathode=posNode — 4 entries: PP, NN, PN, NP in diosetup.c order) into PB-POLCAP.md at position entries 5-8, renumbering subsequent entries accordingly. Add handle field names `_hDIO_PP`, `_hDIO_NN`, `_hDIO_PN`, `_hDIO_NP` and include them in the fields-to-add list and in the `setup()` body.
    - Pros: Fully self-contained; W3 agent can implement without reading a second file.
    - Cons: Content duplication with PB-DIO.md; if DIO sequence changes, two files need updating.
  - **Option B — Explicit cross-file dependency**: Add a sentence to the spec: "Before implementing PB-POLCAP, the implementer must also read PB-DIO.md for the clamp diode TSTALLOC sequence. Entries #N through #M of the global insertion order are the DIO stamps." Also add an explicit entry count so the CAP_PP numbering (#9 currently) can be adjusted if needed.
    - Pros: Avoids duplication.
    - Cons: Breaks the one-file-per-agent principle the plan intends; implementer must track two files; current spec numbers imply the DIO stamps are at positions implicit between 8 and 9 but this is not stated.

##### FPOLCAP-D2 — `pinNodeIds` access vs `pinNodes` parameter inconsistency (info)
- **Location**: PB-POLCAP.md §setup() body
- **Problem**: The `setup()` body uses `this.pinNodeIds[0]` and `this.pinNodeIds[1]` for posNode and negNode. Every other PB-* spec that accesses pin nodes in setup() uses `pinNodes.get("label")!` (the SetupContext-passed map), which is the same as the factory receives and which matches the ngspiceNodeMap keys. The POLCAP spec does not clarify whether `pinNodeIds` is a field pre-populated by the factory before setup() is called, or whether it should be accessed via `pinNodes.get("pos")!` in setup(). PB-RES, PB-CAP, and PB-IND all use `pinNodes.get()` in their `setup()` bodies.
- **Why decision-required**: Two conventions are in use across the batch. Whether POLCAP should use `pinNodes.get("pos")` / `pinNodes.get("neg")` (consistent with other specs) or `this.pinNodeIds[0]` / `this.pinNodeIds[1]` (consistent with the POLCAP setup body as written) is a design decision. The setup() method signature as defined in 00-engine.md does not include a `pinNodes` parameter — it is `setup(ctx: SetupContext): void` — so the implementer must know how pin nodes are accessible inside setup(), which is not stated in PB-POLCAP.md.
- **Options**:
  - **Option A — Standardize on `this.pinNodeIds[]`**: Keep POLCAP as written; add a note clarifying that `pinNodeIds` is populated by the factory before setup() is called, and that other specs' use of `pinNodes.get()` in setup() body pseudocode refers to the same values via the factory-set field.
    - Pros: Consistent with POLCAP as written; no spec change needed.
    - Cons: Inconsistent with PB-RES/CAP/IND body style.
  - **Option B — Standardize on `pinNodes.get()` with SetupContext carrying pinNodes**: Update PB-POLCAP to use `pinNodes.get("pos")!` and `pinNodes.get("neg")!`, consistent with PB-RES/CAP/IND. This requires verifying that SetupContext (or the element's setup() call convention) makes pin nodes accessible via the map.
    - Pros: Uniform style across all PB-* specs.
    - Cons: Requires clarifying (in 00-engine.md or a shared note) how pinNodes is accessible inside setup().

---

### PB-POT.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 0 | 0 |

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FPOT-D1 — Known pin-order mismatch left unresolved for implementer (major)
- **Location**: PB-POT.md §setup() body, "Pin order verification note"
- **Problem**: The spec states: "there is a label mismatch between the constructor comment and the actual ordering. The implementer must verify the actual pin index → node mapping in the current code before writing the setup body, and correct the field naming accordingly." W3 agents are explicitly forbidden from reading existing digiTS component source (plan.md: "W3 implementer agents are forbidden from reading existing digiTS component source"). The spec itself identifies a known inconsistency but defers its resolution to the implementer, who is then instructed to verify against code they are not allowed to read.
- **Why decision-required**: The spec must resolve the pin ordering before the implementer starts work, since the implementer cannot consult the source. Two options exist: pre-resolve the ordering in the spec itself (state definitively which pinNodeIds[] index maps to which pin), or relax the prohibition for this one file.
- **Options**:
  - **Option A — Pre-resolve in spec**: Determine the actual factory-time pin ordering (from `potentiometer.ts`) and state it definitively in the spec: "pinNodeIds[0]=n_A, pinNodeIds[1]=n_B, pinNodeIds[2]=n_W" or the correct alternative. Remove the "implementer must verify" instruction.
    - Pros: Spec is self-contained and actionable without reading source; implementer can proceed.
    - Cons: Requires one read of `potentiometer.ts` by the spec author to resolve.
  - **Option B — Relax prohibition for PB-POT only**: Add an explicit exception: "For PB-POT only, the implementer must read `potentiometer.ts` lines N-M to confirm pin index ordering before implementing setup()."
    - Pros: Honest about the ambiguity without guessing.
    - Cons: Breaks the one-file-per-agent isolation principle; exception may cascade.

##### FPOT-D2 — Verification gate references wrong test file (minor)
- **Location**: PB-POT.md §Verification gate, item 2
- **Problem**: States "Potentiometer test file is GREEN" without naming the file. No path is given. Every other PB-* spec in this batch names the exact test file path. An implementer or reviewer cannot verify this criterion without searching the codebase.
- **Why decision-required**: The correct path could be `src/components/passives/__tests__/potentiometer.test.ts` (if it exists) or there may be no dedicated test file. The spec author must check whether the file exists and either name it or note its absence.
- **Options**:
  - **Option A — Name the file**: Replace "Potentiometer test file is GREEN" with "src/components/passives/__tests__/potentiometer.test.ts is GREEN."
    - Pros: Concrete and verifiable.
    - Cons: If the file does not exist, a new test file must be created (which may be in scope for W3).
  - **Option B — Require test file creation**: State "Create `src/components/passives/__tests__/potentiometer.test.ts` with at least one assertion verifying the R_AW and R_WB stamp values; the file is GREEN as a gate."
    - Pros: Makes it clear this is a new deliverable.
    - Cons: More work for the implementer.

---

### PB-MEMR.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 1 | 1 |

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FMEMR-D1 — 01-pin-mapping.md contradiction not resolved for implementer (minor)
- **Location**: PB-MEMR.md §Pin mapping, "Implementation note"
- **Problem**: The spec says: "01-pin-mapping.md describes the memristor as '1× VCCS (state-dependent g)'. The actual implementation in memristor.ts is a direct conductance stamp... This is the correct pattern... The W3 implementer should use the actual code as the reference, not the 01-pin-mapping.md VCCS description." W3 agents are explicitly forbidden from reading existing digiTS component source. The spec resolves the contradiction by directing the implementer to consult source they cannot read.
- **Why decision-required**: The spec must either (A) remove the cross-reference to existing source and stand alone, or (B) fix the contradiction in 01-pin-mapping.md. The implementer needs a clear, actionable direction without a source-read.
- **Options**:
  - **Option A — Remove the implementation note, let the TSTALLOC table speak**: Delete the "Implementation note" paragraph. The spec already gives the correct RES TSTALLOC sequence; the VCCS description in 01-pin-mapping.md is a known error. Add a note to fix 01-pin-mapping.md separately.
    - Pros: Spec is self-contained; no source reference needed.
    - Cons: 01-pin-mapping.md remains inconsistent until fixed.
  - **Option B — Fix 01-pin-mapping.md first**: Update 01-pin-mapping.md to change the memristor entry from "1× VCCS" to "1× RES (state-dependent G)," then remove the note from PB-MEMR.md.
    - Pros: Both files consistent; no confusion for other agents.
    - Cons: Requires editing 01-pin-mapping.md, which is a separate spec file.

##### FMEMR-D2 — Ground-skip note cross-references PB-AFUSE without explaining the pattern (info)
- **Location**: PB-MEMR.md §TSTALLOC sequence, "Ground-node skip rule"
- **Problem**: States "This matches the pattern used in AnalogFuseElement.setup() (PB-AFUSE)." PB-AFUSE is a separate spec file; W3 agents receive one file each. The cross-reference is informational but the ground-skip pattern is immediately visible in the setup() body code block — the reference to PB-AFUSE adds nothing an implementer cannot see in the MEMR spec itself.
- **Why decision-required**: While this is low-impact, removing the cross-reference makes the spec more self-contained; keeping it adds cross-file coupling. Whether to remove or keep is a style decision.
- **Options**:
  - **Option A — Remove cross-reference**: Delete "(PB-AFUSE)" from the sentence. The setup() body code already illustrates the exact pattern.
    - Pros: Self-contained; no cross-file coupling.
    - Cons: Minimal information lost.
  - **Option B — Keep cross-reference**: Leave as-is; it is informational only and does not gate implementation.
    - Pros: Provides context for reviewers.
    - Cons: Creates soft coupling between spec files.

---

### PB-XFMR.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 1 | 0 | 1 |
| info     | 0 | 0 | 0 |

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FXFMR-M1 | minor | PB-XFMR.md §Factory cleanup, `setParam` routing | States `key.slice(3)` for keys starting with `L1.` and `L2.`. The prefix "L1." is 3 characters, so `slice(3)` produces the part after the dot, which is correct. However the spec uses `key.slice(3)` for both `L1.` and `L2.` — both prefixes are 3 characters — which is consistent and correct. The minor issue is that the spec does not address what happens with unrecognized keys (no fallback or error path described). This is a completeness gap, not a typo. | Add to the `setParam` routing list: "All other keys → throw or ignore (implementer must document which)." |

#### Decision-Required Items

##### FXFMR-D1 — `MutualInductorElement.setup()` signature inconsistency with `AnalogElementCore.setup(ctx)` (major)
- **Location**: PB-XFMR.md §New class `MutualInductorElement`, `setup()` method
- **Problem**: The spec defines `MutualInductorElement.setup(ctx: SetupContext, l1: InductorSubElement, l2: InductorSubElement): void` — a 3-parameter setup signature. The `AnalogElementCore.setup()` contract (00-engine.md §A3) declares `setup(ctx: SetupContext): void` — a single-parameter signature. The composite `AnalogTransformerElement.setup(ctx)` calls `this._mut.setup(ctx, this._l1, this._l2)`. If `MutualInductorElement` must implement `AnalogElementCore` (or `AnalogElement`), its `setup` signature cannot be `(ctx, l1, l2)` — TypeScript will reject it. If it does NOT implement `AnalogElementCore`, it is a plain helper class and not an `AnalogElement`, which changes how the composite registers it and how the engine calls it.
- **Why decision-required**: The implementer must decide whether `MutualInductorElement` implements `AnalogElementCore` with a conforming single-arg setup (requiring l1/l2 to be stored at construction time rather than passed at setup time), or is a plain helper class with a non-conforming signature. Both approaches work but require different code paths.
- **Options**:
  - **Option A — Store l1/l2 refs at construction time**: `MutualInductorElement` takes `l1: InductorSubElement` and `l2: InductorSubElement` in its constructor. Its `setup(ctx: SetupContext): void` reads `this._l1.branchIndex` and `this._l2.branchIndex` directly — conforming to the single-arg `AnalogElementCore` signature. The composite constructor calls `new MutualInductorElement(coupling, l1, l2)`.
    - Pros: Conforms to `AnalogElementCore.setup(ctx)` contract; no signature divergence.
    - Cons: l1/l2 must be constructed before MUT (already true in the composite); minor dependency ordering constraint.
  - **Option B — Plain helper class, not AnalogElementCore**: `MutualInductorElement` is not typed as `AnalogElementCore`; it is a private helper. The composite calls `this._mut.setup(ctx, this._l1, this._l2)` as an internal implementation detail. `MutualInductorElement` is not registered in the engine's element list — only the top-level `AnalogTransformerElement` is.
    - Pros: Flexible signature; clearer separation between "engine elements" and "internal helpers."
    - Cons: Spec must explicitly state it is not an `AnalogElement`; currently ambiguous.

---

### PB-TAPXFMR.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 1 | 1 |

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FTAPXFMR-D1 — Verification gate references ambiguous test file (minor)
- **Location**: PB-TAPXFMR.md §Verification gate, item 2
- **Problem**: States "`src/components/passives/__tests__/transformer.test.ts` (shared file) or dedicated tapped transformer test file is GREEN." The "or" makes the gate ambiguous. An implementer cannot know whether to use the shared file or create a dedicated one, and a reviewer cannot know which file to check. The parenthetical "(shared file)" suggests the intent is to reuse `transformer.test.ts`, but the disjunction leaves it open.
- **Why decision-required**: Whether to reuse `transformer.test.ts` or create a dedicated `tapped-transformer.test.ts` is a scope decision for the implementer.
- **Options**:
  - **Option A — Mandate shared file**: Replace with "src/components/passives/__tests__/transformer.test.ts is GREEN (add tapped-transformer test cases here)."
    - Pros: Single file; no proliferation of test files.
    - Cons: Shared file may grow unwieldy; transformer and tapped-transformer tests mixed.
  - **Option B — Mandate dedicated file**: Replace with "src/components/passives/__tests__/tapped-transformer.test.ts is GREEN (create this file)."
    - Pros: Clear separation.
    - Cons: New file creation in scope for W3 agent.

##### FTAPXFMR-D2 — `setParam` routing for `K12/K13/K23` does not specify how `updateDerivedParams` works (info)
- **Location**: PB-TAPXFMR.md §Factory cleanup, `setParam` routing
- **Problem**: States "K12, K13, K23 → respective MUT elements" and "primaryInductance, turnsRatio, couplingCoefficient → recompute all derived params and call `updateDerivedParams` on affected sub-elements." Neither `updateDerivedParams` nor its signature is defined anywhere in this spec or 00-engine.md. An implementer cannot implement this routing without knowing the method signature.
- **Why decision-required**: Whether `updateDerivedParams` is an existing method to call, a new method to create, or an inline recomputation is a design choice.
- **Options**:
  - **Option A — Specify `updateDerivedParams` signature inline**: Add a paragraph defining: `updateDerivedParams(): void` — recomputes L1/L2/L3 inductance values from `primaryInductance` and `turnsRatio`, and recomputes MUT coupling values from `couplingCoefficient`, then calls `this._l1.setParam("inductance", newL1)` etc.
    - Pros: Self-contained; implementer can act.
    - Cons: More spec text; may duplicate logic already in the existing code.
  - **Option B — Drop `updateDerivedParams` reference, specify each key explicitly**: Replace the compound `primaryInductance, turnsRatio, couplingCoefficient → recompute...` bullet with explicit entries for each key showing exactly which sub-element params it modifies.
    - Pros: Concrete; no undefined method names.
    - Cons: More verbose.

---

### PB-CRYSTAL.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 1 | 1 | 2 |
| info     | 0 | 0 | 0 |

#### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FCRYSTAL-M1 | minor | PB-CRYSTAL.md §Cs setup table, row 11 | Row 11 uses `bNode` as the variable name for `CAPnegNode` in the Cs sub-element table (rows 10-13). The spec defined `bNode = pinNodes.get("B")` at the top of the file, so this is correct — but the TSTALLOC table header for Cs says "(n2Node=pos, B=negNode)" using capital-B to mean the external terminal, while the table body uses `bNode` (lowercase). The `(b, b)` and `(b, negNode)` references in the Ls table use `b` for the branch row, making `bNode` and `b` visually confusable in the same spec. | In rows 11-13 of the Cs table, rename column heading `bNode` to `extBNode` (or use `pinNodes.get("B")` inline) to distinguish it from the branch row variable `b` used in rows 5-9. |

#### Decision-Required Items

##### FCRYSTAL-D1 — `findBranchFor` lookup label convention is unverified and implementer-gated (major)
- **Location**: PB-CRYSTAL.md §findBranchFor
- **Problem**: The spec states the `findBranchFor` name check uses `name !== this._label + "_Ls_branch"` and then concludes: "The label convention `_label + "_Ls_branch"` must match whatever `ctx.makeCur` uses — implementer should verify the exact name against the compiler's branch-name lookup convention." W3 agents are forbidden from reading digiTS source. The spec has left a known unresolved convention for the implementer to figure out at implementation time. This is not just a note — the entire `findBranchFor` implementation depends on it.
- **Why decision-required**: Two conventions are possible: (A) `_label + "_Ls_branch"` (concatenated with underscore) or (B) some other naming that `ctx.makeCur(label, suffix)` produces (e.g., `label + "#" + suffix` based on the `_makeNode` body in 00-engine.md §A4.2 which uses `${label}#${suffix}`). The spec leaves this open.
- **Options**:
  - **Option A — Pre-resolve using the 00-engine.md naming**: 00-engine.md §A4.2 shows `_makeNode` produces `${label}#${suffix}`. If `makeCur(this._label, "Ls_branch")` uses the same convention, the node name is `${this._label}#Ls_branch` — but `findBranch` takes a device *label*, not a node name. The guard in `findBranchFor` should check `name === this._label` (the device label), not a compound string. Align the spec with this: change the guard to `if (name !== this._label) return 0;` — matching the pattern in PB-IND's `findBranchFor`.
    - Pros: Consistent with IND findBranchFor; resolvable from 00-engine.md alone.
    - Cons: Requires dropping the compound label convention the spec currently describes.
  - **Option B — Require implementer to verify and document**: Keep the note but add a gate: "Before implementation, confirm the `ctx.findBranch(name)` lookup convention in 00-engine.md §A4.2 and update this guard to match. Document the resolved convention in the commit message."
    - Pros: Explicit gate; does not guess.
    - Cons: Still leaves it unresolved for the implementer.

##### FCRYSTAL-D2 — `allocStates(15)` slot layout claim does not add up (minor)
- **Location**: PB-CRYSTAL.md §State slots
- **Problem**: The spec claims 15 state slots derived from: "Ls (IND pattern — indsetup.c:78-79): contributes 4 slots (GEQ_L, IEQ_L, I_L, PHI_L) + 1 CCAP slot" (5), "Cs (CAP pattern): 4 slots + 1 CCAP slot" (5), "C0 (CAP pattern): 4 slots + 1 CCAP slot" (5). 5+5+5=15. But the actual `PB-CAP.md` spec says: "capsetup.c:102-103 — `*states += 2`" — 2 state slots per capacitor, not 5. Similarly `PB-IND.md` says `indsetup.c:78-79 — `*states += 2`" — 2 state slots per inductor. The CAP SCHEMA in the existing source has 5 slots (GEQ, IEQ, V, Q, CCAP), but the ngspice anchor allocates only 2. The 5-slot schema is a digiTS-internal decision. The spec mixes ngspice anchor slot counts with digiTS schema slot counts without clarifying which governs. The label "Ls (IND pattern — indsetup.c:78-79): contributes 4 slots" contradicts indsetup.c which says `*states += 2`.
- **Why decision-required**: The "15 slot" claim may be correct (if the crystal uses 15 digiTS-side state slots from its existing `CRYSTAL_SCHEMA`), but the derivation as written is wrong on its face. The spec must either (A) clarify that 15 is from the existing `CRYSTAL_SCHEMA` (not derived from ngspice), or (B) fix the per-reactive-element slot counts.
- **Options**:
  - **Option A — Ground the 15-slot claim in the existing CRYSTAL_SCHEMA**: Replace the per-component breakdown with: "15 state slots, matching the existing `CRYSTAL_SCHEMA` (see `src/components/passives/crystal.ts`). The schema's exact slot layout is already defined; allocate as a single block with `ctx.allocStates(15)`." Delete the incorrect IND/CAP derivation.
    - Pros: Correct; consistent with the setup body which just calls `allocStates(15)`.
    - Cons: Implementer cannot verify slot count without reading source (but source-read is banned).
  - **Option B — Fix the derivation**: State the correct breakdown: Ls uses `indsetup.c:78-79` → 2 ngspice state slots, but the digiTS IND schema uses more slots for companion model storage. Provide the actual per-element slot counts from the existing CRYSTAL_SCHEMA.
    - Pros: Accurate derivation.
    - Cons: More work; still may require reading source to get exact counts.

---

### PB-FUSE.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 0 | 0 |

#### Mechanical Fixes

None found.

#### Decision-Required Items

##### FFUSE-D1 — `this._res.current` is not a defined field on ResElement (major)
- **Location**: PB-FUSE.md §load() body, `accept()` body code block
- **Problem**: The `accept()` body uses `this._res.current` to get the current through the fuse resistor. No field named `current` is defined anywhere in the spec on `ResElement`. The spec does not define `ResElement` (it is described inline only as the RES sub-element). `this._res.conduct` is also used (as `= 1/R`). Neither `current` nor `conduct` are defined fields in the spec. An implementer cannot implement `accept()` without knowing how to get the current through the sub-element resistor.
- **Why decision-required**: Whether `current` is a field computed from `voltage / resistance`, obtained from the solver's RHS, or stored from the last `load()` call is an architectural decision. Multiple valid approaches exist.
- **Options**:
  - **Option A — Define `current` as a load()-updated field**: Add to the spec: "ResElement stores `current: number = 0` updated at the end of each `load()` call as `this.current = (rhsPos - rhsNeg) * G` or `= solver.getNodeVoltage(posNode) * G`." The spec must define the exact expression.
    - Pros: Self-contained; implementer has a complete recipe.
    - Cons: Must specify how node voltages are accessed in load() context.
  - **Option B — Drop `this._res.current`, use `ctx.rhs` directly**: Replace with an explicit expression reading node voltages from `LoadContext` (e.g., `const v = ctx.rhs[posNode] - ctx.rhs[negNode]; const i = v * this._res.conduct;`). This removes the need for a `current` field on ResElement.
    - Pros: No new field needed; directly uses available context.
    - Cons: Couples the accept() body to LoadContext field names.

##### FFUSE-D2 — `ResElement` class is not defined, only implied (minor)
- **Location**: PB-FUSE.md §setup() body
- **Problem**: The spec defines a `setup()` body for "ResElement.setup()" but never formally defines `ResElement` as a class: no class name, no class declaration, no file path, no fields-to-add list. The spec says the composite "carries `{ _res: ResElement }` as a direct ref" but does not say where `ResElement` is defined or whether it is a new class to create or an existing class to reuse. PB-RES.md specifies `AnalogResistorElement` in `src/components/passives/resistor.ts` as a full-featured registered element — but PB-FUSE's `ResElement` is a sub-element helper that uses `this.pinNodes.get("out1")!` (a different pin access pattern than any other spec).
- **Why decision-required**: Whether `ResElement` is (A) a new private helper class to define in `switching/fuse.ts`, (B) a reuse of `AnalogResistorElement` from `resistor.ts`, or (C) an inline implementation on `FuseElement` directly is a design decision.
- **Options**:
  - **Option A — Define ResElement as new private helper**: Add a class definition block to PB-FUSE.md similar to how PB-XFMR.md defines `InductorSubElement`: class name, file path, fields, constructor, and setup()/load() method signatures.
    - Pros: Spec is complete; implementer knows exactly what to create.
    - Cons: More spec text.
  - **Option B — Inline RES logic on FuseElement directly**: Remove the sub-element decomposition; implement setup() and load() directly on `FuseElement` using posNode/negNode from pinNodeIds.
    - Pros: Simpler; consistent with PB-AFUSE (which does not use a sub-element).
    - Cons: May not match the existing fuse implementation structure.

---

### PB-AFUSE.md: ready, 0 findings

---

### PB-NTC.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 0 | 0 |

#### Decision-Required Items

##### FNTC-D1 — `ctx.temp` access in load() is not part of LoadContext interface (minor)
- **Location**: PB-NTC.md §load() body
- **Problem**: States "when `selfHeating` is false, `temperature` is read directly from `ctx.temp` (the circuit ambient temperature from SetupContext) at each load call." `ctx.temp` is defined on `SetupContext` (00-engine.md §A2), not on `LoadContext`. The `load(ctx: LoadContext)` method receives a `LoadContext`, not a `SetupContext`. An implementer reading PB-NTC.md cannot determine how to access the ambient temperature in `load()` — whether it must be cached from the `SetupContext` during `setup()`, or whether `LoadContext` has its own `temp` field.
- **Why decision-required**: Whether `temp` is accessible on `LoadContext`, or must be cached in the element during `setup()`, is an interface decision that affects multiple components.
- **Options**:
  - **Option A — Cache `temp` during setup()**: Add to PB-NTC.md: "In `setup()`, cache `this._ambientTemp = ctx.temp`. In `load()`, use `this._ambientTemp` for the non-self-heating temperature." Add `private _ambientTemp: number = 300.15;` to fields.
    - Pros: No change to LoadContext needed; self-contained.
    - Cons: Cached value will not reflect runtime temperature changes (acceptable for ambient temp).
  - **Option B — Add `temp` to LoadContext**: Specify that `LoadContext` exposes `temp: number` (the same value as `SetupContext.temp`). Update 00-engine.md or the LoadContext definition accordingly.
    - Pros: Consistent with how SPICE elements read CKTtemp in load routines.
    - Cons: Requires modifying a shared interface; broader blast radius.

---

### PB-LDR.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 1 | 1 |
| info     | 0 | 0 | 0 |

#### Decision-Required Items

##### FLDR-D1 — `ngspiceNodeMap` placement contradiction: composite vs flat element (minor)
- **Location**: PB-LDR.md §Pin mapping
- **Problem**: The spec states: "LDR is a composite wrapping a single variable RES sub-element. The composite's own `ngspiceNodeMap` is undefined; only the RES sub-element carries the map above. However, because LDR is currently a single flat element (not a composite with an actual RES child), its setup() body acts as the RES setup directly." The spec then says `ngspiceNodeMap: { pos: "pos", neg: "neg" }` but contradicts itself about where this map lives (composite's ComponentDefinition has no map, but the flat element must have it). The Factory cleanup section says "Add `ngspiceNodeMap: { pos: "pos", neg: "neg" }` to the `behavioral` model registration and to `LDRDefinition`" — which contradicts the "composite's own ngspiceNodeMap is undefined" statement.
- **Why decision-required**: Whether LDR's `ngspiceNodeMap` goes on the `ComponentDefinition` / `LDRDefinition` directly (because it is a flat element) or stays undefined (because it is architecturally described as a composite) is a consistency decision.
- **Options**:
  - **Option A — Treat LDR as flat, add map to ComponentDefinition**: Remove the "composite wrapping" framing. State: "LDR is a single flat variable-resistance element. Add `ngspiceNodeMap: { pos: 'pos', neg: 'neg' }` to `LDRDefinition`." Consistent with the Factory cleanup section.
    - Pros: Consistent with Factory cleanup; matches NTC treatment.
    - Cons: Requires removing the "composite wrapping" architectural description.
  - **Option B — Treat LDR as composite, add map to sub-element**: Implement an actual `ResSubElement` inside LDR and give the sub-element the `ngspiceNodeMap`. Keep `ComponentDefinition.ngspiceNodeMap` undefined.
    - Pros: Consistent with the "composite wrapping" architectural description.
    - Cons: Inconsistent with Factory cleanup section; more implementation work; PB-NTC has the same tension.

---

### PB-TLINE.md

#### Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 2 | 2 |
| minor    | 0 | 0 | 0 |
| info     | 0 | 0 | 0 |

#### Decision-Required Items

##### FTLINE-D1 — Spec does not acknowledge the plan.md blocker (major)
- **Location**: PB-TLINE.md, overall document
- **Problem**: The plan.md §"Open blockers" states: "PB-TLINE — architectural divergence (gates only the W3 row for transmission line)" and "User decision required before PB-TLINE W3 row can land. Does NOT block W0/W1/W2 or any other W3 component." PB-TLINE.md does not reproduce this blocker prominently. The spec presents full setup() body, TSTALLOC sequence, factory cleanup, and a verification gate that includes "Prerequisite: Architectural divergence entry exists in `spec/architectural-alignment.md` before implementation begins" — but `spec/architectural-alignment.md` does not currently exist (verified by search). An implementer reading PB-TLINE.md sees a complete spec with a gate they cannot satisfy, but no indication that the W3 row is actively blocked pending user decision.
- **Why decision-required**: The spec must explicitly state at the top (not buried in a "Port Error" section mid-document) that this task is BLOCKED and must not be started until the user makes a decision per plan.md. The framing and placement of the blocker notice is a decision.
- **Options**:
  - **Option A — Add a prominent BLOCKED banner at the top**: Insert after the header:
    ```
    > **STATUS: BLOCKED — Do not implement.**
    > This W3 task is gated on a user decision documented in plan.md §"Open blockers / PB-TLINE".
    > The required `spec/architectural-alignment.md` entry does not yet exist.
    > Implementation must not begin until the user selects one of the three options (A/B/C)
    > from plan.md and adds the architectural-alignment entry.
    ```
    - Pros: Unambiguous; implementer cannot accidentally start work.
    - Cons: None.
  - **Option B — Remove the PB-TLINE.md spec entirely until unblocked**: Delete the file, leaving only the plan.md blocker record.
    - Pros: No risk of partial implementation.
    - Cons: Work already done in writing the spec is lost; harder to resume.

##### FTLINE-D2 — `setup()` body calls `ctx.makeCur()` but discards the result; delegates to sub-elements that also call `ctx.makeCur()` (major)
- **Location**: PB-TLINE.md §setup() body
- **Problem**: The `setup()` body code block contains:
  ```ts
  const brIdx = ctx.makeCur(this._label, `ibr${k}`);
  this._subElements[k].setup(ctx);  // delegates to sub-element's own setup()
  ```
  `brIdx` is assigned but never used (dead variable). The branch allocation is made in the composite loop and ALSO inside each sub-element's `setup(ctx)` (since `SegmentInductorElement` follows the PB-IND pattern which calls `ctx.makeCur` in its own setup). This means `ctx.makeCur` is called twice for each branch row: once in the composite loop (result discarded), and once inside the sub-element. The `makeCur` spec in 00-engine.md §A2 says it is "Idempotent: calling twice with the same (label, suffix) returns the same number" — so it will not double-allocate. But the composite-loop call is superfluous and misleading: either the composite allocates the branch rows (and sub-elements read them), or sub-elements allocate their own branch rows. The spec does not resolve which model is intended.
- **Why decision-required**: The composite-level `ctx.makeCur` call either (A) should be removed (sub-elements self-allocate), or (B) should be kept and the sub-element's setup() should use the pre-allocated brIdx instead of calling makeCur again. Which is the correct architectural model is a decision.
- **Options**:
  - **Option A — Sub-elements self-allocate (remove composite-level makeCur)**: Delete the `const brIdx = ctx.makeCur(...)` line from the composite loop. Each `SegmentInductorElement.setup(ctx)` calls `ctx.makeCur` itself (following the PB-IND pattern). The composite does not pre-allocate.
    - Pros: Consistent with PB-IND pattern; no dead code.
    - Cons: Composite cannot read brIdx until after sub-element setup() has run.
  - **Option B — Composite pre-allocates, sub-elements receive brIdx**: Pass `brIdx` to each sub-element's setup via a different mechanism (e.g., store it on the sub-element before calling setup(), or change the sub-element setup signature). This requires `SegmentInductorElement.setup()` not to call `ctx.makeCur` itself.
    - Pros: Composite controls allocation order explicitly.
    - Cons: Non-conforming sub-element setup signature; more complexity.

---

## 3. Batch-Wide Findings

### BATCH1-D1 — `pinNodes` accessibility inside `setup()` not specified (major)

**Affects:** PB-CAP.md, PB-IND.md, PB-RES.md, PB-MEMR.md, PB-NTC.md, PB-LDR.md, PB-CRYSTAL.md, PB-AFUSE.md (all files with `setup()` bodies)

**Problem:** Every spec `setup()` body accesses pin nodes using one of two patterns:
- `pinNodes.get("label")!` (PB-CAP, PB-IND, PB-RES, PB-CRYSTAL, PB-FUSE's ResElement body)
- `this.pinNodeIds[N]` (PB-MEMR, PB-NTC, PB-LDR, PB-AFUSE, PB-POLCAP)

The `setup(ctx: SetupContext)` signature as defined in `00-engine.md §A3` is `setup(ctx: SetupContext): void`. `SetupContext` (00-engine.md §A2) has no `pinNodes` field. `pinNodeIds` is an element instance field. An implementer using `pinNodes.get("label")!` in the setup() body must know that `pinNodes` is the element's own field, not something from ctx. This is never stated. PB-IND's setup() body uses `pinNodes.get("A")!` while its fields section refers to `AnalogInductorElement` — an implementer would assume `pinNodes` is a local variable from the factory scope that is not available inside the `setup()` method body.

The two patterns are inconsistent within the batch and neither is explained.

**Why decision-required:** Whether the spec should uniformly use `this.pinNodeIds[N]` or `pinNodes.get("label")!` (clarifying it is an instance field), or whether `SetupContext` should carry `pinNodes`, is a design decision that affects every PB-* file.

**Options:**
- **Option A — Standardize on `this.pinNodeIds[N]` everywhere**: Update all setup() body pseudocode to use `this.pinNodeIds[N]` with a comment mapping N to the label. Add a note (in a shared preamble or in 00-engine.md) that `pinNodeIds` is a factory-set instance field available in setup(). Affected files: PB-CAP, PB-IND, PB-RES, PB-CRYSTAL, PB-FUSE (ResElement body).
  - Pros: Consistent with how other TypeScript class methods access instance data; no changes to SetupContext.
  - Cons: Index-based access is less readable than label-based; requires mapping table for each component.
- **Option B — Standardize on `this.pinNodes.get("label")!` (instance field)**: Store the `pinNodes` map as an instance field `this.pinNodes` set in the factory/constructor. All setup() bodies use `this.pinNodes.get("label")!`. Update PB-MEMR, PB-NTC, PB-LDR, PB-AFUSE, PB-POLCAP to use this pattern.
  - Pros: Readable; consistent with label-based addressing across the spec.
  - Cons: Requires adding `pinNodes` as an instance field to each element class.
- **Option C — Add `pinNodes` to SetupContext**: Extend `SetupContext` to carry the calling element's `pinNodes: ReadonlyMap<string, number>`. Each `element.setup(ctx)` call would pass the element's pinNodes into an augmented ctx. Changes 00-engine.md.
  - Pros: Exactly consistent with how setup() bodies are written in PB-CAP/IND/RES.
  - Cons: Changes the shared SetupContext interface; ctx would carry element-specific data which is architecturally unusual.

---

### BATCH1-D2 — Ground-skip guard policy is inconsistent across the batch (minor)

**Affects:** PB-RES.md, PB-CAP.md, PB-IND.md (no guard), PB-MEMR.md (guard), PB-AFUSE.md (guard), PB-NTC.md (no guard), PB-LDR.md (no guard), PB-CRYSTAL.md (partial guard)

**Problem:** Some specs apply explicit ground-skip guards (`if (aNode !== 0)`) in their setup() body TSTALLOC calls; others do not. The policy for when to apply ground-skip guards in `allocElement` calls is never stated globally.

- PB-RES, PB-CAP: no ground-skip guards — `allocElement(posNode, posNode)` called unconditionally.
- PB-IND: no ground-skip guards.
- PB-NTC, PB-LDR: no ground-skip guards (identical to PB-RES).
- PB-MEMR: has ground-skip guards with `if (aNode !== 0)` / `if (bNode !== 0)`.
- PB-AFUSE: has ground-skip guards with `if (posNode !== 0)` / `if (negNode !== 0)`.
- PB-CRYSTAL: partial guards on Ls incidence entries and Cs/C0 entries; none on Rs entries.

The inconsistency is not explained. PB-MEMR says "allocElement does not automatically skip ground" — but then PB-RES and PB-CAP call allocElement without guards. Either (A) allocElement does skip ground automatically, making guards redundant, or (B) allocElement does NOT skip ground, making the RES/CAP/IND specs incorrect.

**Why decision-required:** Whether `solver.allocElement(0, x)` or `solver.allocElement(x, 0)` is safe (silently ignored or treated as an error) is an engine behavior question. The answer must be stated once and applied consistently.

**Options:**
- **Option A — allocElement silently skips ground entries**: Document in 00-engine.md or a shared preamble that `solver.allocElement(row, col)` is a no-op when `row === 0` or `col === 0`, returning `-1` or `0` as a sentinel. Remove ground-skip guards from PB-MEMR and PB-AFUSE (they are redundant). Ensure PB-CRYSTAL removes its partial guards.
  - Pros: Consistent; ground-skip logic in one place; simplifies all setup() bodies.
  - Cons: Requires engine change if allocElement does not currently skip ground.
- **Option B — allocElement does not skip ground; all specs must guard**: Add guards to PB-RES, PB-CAP, PB-IND, PB-NTC, PB-LDR setup() bodies. Document in each spec that every `allocElement` call with a potentially-ground node must be guarded. Standardize the guard pattern.
  - Pros: Explicit; each spec is self-contained.
  - Cons: Adds boilerplate to simple primitives like RES and CAP; PB-CRYSTAL's ground-skip rationale ("n1 and n2 are always non-zero after ctx.makeVolt") must be stated for each.
- **Option C — Guard only when a pin may realistically be ground**: State a rule: "Guard when the ngspice anchor's node might be ground in a valid circuit (e.g., shunt element to ground); omit guard when the node is structurally non-ground (e.g., series element between two non-ground pins)." Apply the rule consistently. Document the rule once and reference it per file.
  - Pros: Matches actual ngspice practice (trasetup.c guards shunt entries but not series entries).
  - Cons: Requires per-element judgment; may reintroduce inconsistency.

---

## 4. Overall Tally (batch-wide)

| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 1 | 8 | 9 |
| minor    | 2 | 10 | 12 |
| info     | 0 | 3 | 3 |

---

## 5. Plan Coverage

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| PB-CAP (W3 component row) | yes | Complete. |
| PB-IND (W3 component row) | yes | Complete. |
| PB-RES (W3 component row) | yes | Complete. |
| PB-POLCAP (W3 component row) | partial | Clamp diode TSTALLOC sequence not inlined — depends on PB-DIO.md. |
| PB-POT (W3 component row) | partial | Pin-order mismatch deferred to implementer who cannot read source. |
| PB-MEMR (W3 component row) | yes | Complete modulo minor inconsistency with 01-pin-mapping.md. |
| PB-XFMR (W3 component row) | partial | MutualInductorElement.setup() signature conflicts with AnalogElementCore contract. |
| PB-TAPXFMR (W3 component row) | yes | Complete modulo minor test file ambiguity. |
| PB-CRYSTAL (W3 component row) | partial | findBranchFor label convention unresolved; state slot derivation incorrect. |
| PB-FUSE (W3 component row) | partial | ResElement.current field undefined; ResElement class not defined. |
| PB-AFUSE (W3 component row) | yes | Complete. |
| PB-NTC (W3 component row) | partial | ctx.temp not available in load() context. |
| PB-LDR (W3 component row) | partial | ngspiceNodeMap placement contradicts composite framing. |
| PB-TLINE (W3 component row) | partial | Blocked per plan.md; spec does not display blocker prominently; setup() has dead makeCur variable. |
| W3 plan gate: setup-stamp-order.test.ts row green | yes (all files) | Every spec includes this gate. |
| W3 plan gate: component test file green | partial | PB-POT and PB-TAPXFMR gate is ambiguous; PB-TLINE is blocked. |

---

## 6. Overall Batch Verdict: needs-revision

The three cleanest specs (PB-CAP, PB-IND, PB-RES, PB-AFUSE) are ready for implementation. The remaining ten files have findings ranging from major (implementer-blocking) to minor. Key issues that must be resolved before W3 implementation agents are dispatched:

1. **BATCH1-D1** (major, batch-wide): The `pinNodes` access pattern inside `setup()` bodies is inconsistent and unexplained. An implementer following one spec will produce code that conflicts with another.
2. **BATCH1-D2** (minor, batch-wide): Ground-skip guard policy is undefined and inconsistently applied.
3. **FPOLCAP-D1** (major): Clamp diode TSTALLOC sequence is not inlined — violates the one-file-per-agent principle.
4. **FPOT-D1** (major): Pin-order mismatch deferred to implementer who cannot read source.
5. **FXFMR-D1** (major): MutualInductorElement.setup() signature conflicts with AnalogElementCore.setup(ctx).
6. **FCRYSTAL-D1** (major): findBranchFor label convention unresolved.
7. **FCRYSTAL-D2** (minor): State slot derivation contradicts ngspice anchor.
8. **FFUSE-D1** (major): `this._res.current` field is undefined.
9. **FNTC-D1** (minor): `ctx.temp` not available on LoadContext.
10. **FTLINE-D1** (major): Blocker from plan.md not prominently displayed in the spec.
11. **FTLINE-D2** (major): Dead `brIdx` variable in setup() body — double makeCur allocation.
