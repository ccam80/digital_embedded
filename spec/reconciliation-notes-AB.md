# Layer 2 Verification Notes — Groups A & B

**Date:** 2026-04-21
**Scope:** 8 items (A-1..A-4, B-1..B-4)
**Source:** `spec/fix-list-phase-2-audit.md`
**Protocol:** `spec/reconciliation-task.md` §Layer 2

## Per-item verdicts

### A-1. Remove `Math.min(expArg, 80)` clamps from njfet.ts
- **L1 tag:** PARITY
- **Verification grep result:** `Math\.min\([^)]*80\)` in `njfet.ts` → 0 hits. Broader `Math\.min\(` in `njfet.ts` → 0 hits (no residual clamps of any form).
- **DONE?:** YES
- **Cited ngspice source:** `ref/ngspice/src/spicelib/devices/jfet/jfetload.c:256, 267` — `evgs = exp(vgs/vt_temp); ggs = csat*evgs/vt_temp + ckt->CKTgmin; cg = csat*(evgs-1) + ckt->CKTgmin*vgs;` (and the `vgd` branch at 267–269). No `MIN(...,80)` wrapper on either junction's exp argument. The `vgs < -3*vt_temp` / `vgd < -3*vt_temp` branches (250–254, 261–265) are the reverse-bias cubic expansion, not a clamp.
- **Current file state:** Lines 287–290, 305–308, 323–327, and the forward-bias arm at 366–388 all read `const expArg = this._vgs_junction / vt_n; Math.exp(expArg)` (or `this._vgs_junction / vt_n` passed directly). No clamp on the argument in any of the four MODEINITSMSIG / MODEINITTRAN / MODEINITJCT / default dispatch arms.
- **I1 violation check:** No `save*`/`restore*` pairs, no silent `try { } catch { }`, no "spurious" / "suppress" gate, no `@ts-expect-error`, no comment banned-vocabulary around the change site. The MODEINITJCT arm notes that `primeJunctions()` already set `_vgs_junction`, which is legitimate state handoff, not suppression.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Removal matches `jfetload.c:256, 267` exactly — plain `exp()` on the normalized voltage in every dispatch branch. L1 PARITY tag is upheld; nothing in the surrounding code encodes a divergence that the clamp removal only papered over.

### A-2. Remove `Math.min(expArg, 80)` clamps from pjfet.ts
- **L1 tag:** PARITY
- **Verification grep result:** `Math\.min\([^)]*80\)` in `pjfet.ts` → 0 hits. Broader `Math\.min\(` in `pjfet.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** same as A-1 — `jfetload.c:256, 267`. ngspice does not distinguish p-channel and n-channel at the exp-arg level; polarity inversion is applied to the raw vgs/vgd before entering the Shockley form.
- **Current file state:** Lines 140–143, 158–161, 176–180, 239–242 all read `const expArg = this._vgs_junction / vt_n; Math.exp(expArg)`. P-channel inversion is handled at vGraw / vDraw / vGSraw (lines 193–194, 220), not by wrapping the exp argument.
- **I1 violation check:** No suppression patterns. Polarity inversion is explicit and documented (`// Vsg`, `// Vsd`), not a hidden sign flip.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Clamp removal in all four dispatch arms matches ngspice bit-for-bit; p-channel polarity is handled pre-Shockley, leaving the exp call structurally identical to `jfetload.c:256, 267`. L1 PARITY tag stands.

### A-3. Remove historical-provenance comment at bjt.ts:55
- **L1 tag:** OBSOLETE
- **Verification grep result:** `VT import removed` in `bjt.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** N/A (pure comment cleanup; Required field is "delete entirely").
- **Current file state:** `bjt.ts:55` now reads `/** Minimum conductance for numerical stability. */` — the historical-provenance comment has been replaced by a GMIN doc-comment for the adjacent `const GMIN = 1e-12;` declaration. The stale `// BJ1: VT import removed — all code now uses tp.vt (temperature-dependent thermal voltage)` line is gone.
- **I1 violation check:** No residual banned vocabulary ("fallback"/"legacy"/"pre-existing"/"previously") around this declaration. The new doc-comment describes current semantics only.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Comment-only hygiene fix. The Required action (delete the line) is done and the surrounding code documents present behavior cleanly. L1 tagged OBSOLETE on the grounds that the general I2 citation-audit policy also would have caught it; the item can remain closed either way — the work it described has happened.

### A-4. Remove banned word "fallback" from bjt.ts:1516
- **L1 tag:** OBSOLETE
- **Verification grep result:** `fallback` in `bjt.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** `bjtload.c:258-276` (MODEINITJCT dispatch) — the comment describes the three branches (OFF, UIC, else-vcrit) that live in the MODEINITJCT block.
- **Current file state:** `bjt.ts:1523` reads `// bjtload.c:258-276: MODEINITJCT dispatch — OFF branch, UIC branch, and the else (vcrit) branch.` exactly matching the Required replacement text. Additional `bjtload.c:258-276` citations appear at 801, 831, 1539 describing related pnjlim-skip behavior, none of which mention "fallback".
- **I1 violation check:** No other banned words in the surrounding block. The comment now uses concrete branch names ("OFF branch", "UIC branch", "else (vcrit) branch") rather than vague provenance framing.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Word-level banned-vocabulary fix applied exactly as specified; the dispatch structure it describes (OFF → UIC → vcrit) accurately mirrors `bjtload.c:258-276` and the code immediately below (lines 1524–1533) implements that same three-branch structure. L1 OBSOLETE stands — the item described a comment hygiene task that has been completed.

### B-1. Extract `_takePreFactorSnapshotIfEnabled()` helper and move snapshot AFTER `_applyDiagGmin`
- **L1 tag:** BLOCKER → B3
- **Verification grep result:** `_takePreFactorSnapshotIfEnabled` in `sparse-solver.ts` → 3 hits (definition at 784, call sites at 1604 and 1623). `_preFactorMatrix\s*=` → 2 hits (at 765 for disable-reset and 797 inside the helper itself); none inside the `factor()` body.
- **DONE?:** YES
- **Cited ngspice source:** N/A (digiTS diagnostic, per item's own note).
- **Current file state:** Helper defined at `sparse-solver.ts:784-798` and called from `factorWithReorder` (line 1604) and `factorNumerical` (line 1623), in both cases AFTER `_applyDiagGmin(diagGmin)` (lines 1603, 1622). The doc-comment at 777–783 explicitly states the invariant: "Called from factorWithReorder / factorNumerical IMMEDIATELY AFTER _applyDiagGmin so the snapshot reflects the matrix that is actually about to be factored".
- **I1 violation check:** No silent catches, no save/restore, no suppression. The `if (!this._capturePreFactorMatrix) return;` guard is a feature-flag short-circuit for a diagnostic, not a suppression of a divergence.
- **Verdict:** OBSOLETE-BY-B3
- **Rationale:** Code is real and correct; the snapshot now reflects the factored matrix (A + gmin·I). However, L1 routed this to Track A B3 ("Gmin stamped outside factor, not passed to factor routine"). When B3 lands, Gmin becomes a parameter of the factor routine itself rather than a diagonal mutation stamped outside, so the snapshot-vs-gmin ordering hazard dissolves by construction. The current helper remains correct after B3 (snapshotting what will be factored is still the right contract), so the code is not dead-on-arrival — but the surgical fix described in B-1 is subsumed by the B3 structural change. Keeping as covered-by-B3 per the L1 routing.

### B-2. Fix misleading comment at sparse-solver.ts:1490-1495
- **L1 tag:** OBSOLETE
- **Verification grep result:** `Do NOT demand reorder` in `sparse-solver.ts` → 0 hits.
- **DONE?:** YES
- **Cited ngspice source:** `spfactor.c:218-226` (column-relative partial-pivot guard) — cited inline in the corrected comment at 1475–1482.
- **Current file state:** Lines 1486–1494 contain two return sites (relative-threshold and absolute-threshold), both returning `{ success: false, needsReorder: true }`. The surrounding comments at 1475–1482 and 1491–1492 accurately describe the `needsReorder: true` return; the comment at 1491–1492 for the absolute-threshold branch explicitly says "demand reorder just as the relative-threshold path does". No lingering "Do NOT demand reorder" text anywhere in the file.
- **I1 violation check:** No banned vocabulary ("legacy"/"pre-existing"/"previously"/"workaround") around the corrected comment. Citation to `spfactor.c:218-226` is present and describable from the cited ngspice source.
- **Verdict:** ACTUALLY-COMPLETE
- **Rationale:** Comment-only correction applied exactly as specified; both pivot-guard paths are now documented to match their actual `needsReorder: true` return. L1 OBSOLETE framing routed this under I2 citation-hygiene; the standalone fix happens to already match what I2 would demand. Item closes cleanly either way.

### B-3. Migrate sparse-solver.test.ts `rawCtx` literal
- **L1 tag:** BLOCKER → C2
- **Verification grep result:** `iteration\s*:\s*0` in `sparse-solver.test.ts` → 0 hits. `cktMode\s*:` in `sparse-solver.test.ts` → 1 hit (line 460: `cktMode: MODEDCOP | MODEINITFLOAT`).
- **DONE?:** YES
- **Cited ngspice source:** N/A (test-literal shape; item cites C2 legacy-field removal).
- **Current file state:** `sparse-solver.test.ts:457-474` constructs `rawCtx: LoadContext` with `cktMode: MODEDCOP | MODEINITFLOAT` at line 460. The six legacy fields (`iteration`, `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`) are absent. Other fields present (`dt`, `method`, `order`, `deltaOld`, `ag`, `srcFact`, `noncon`, `limitingCollector`, `xfact`, `gmin`, `uic`, `reltol`, `iabstol`) match the current LoadContext surface.
- **I1 violation check:** The literal still carries `uic: false` which duplicates `(cktMode & MODEUIC) !== 0` — this is exactly the `pool.uic` / field-level UIC duplication Track A A2 will delete. Its presence in the test literal is not an I1 suppression (no hand-computed expected, no silent catch), but is a direct instance of the A2 surface area that gets swept out when A2 lands.
- **Verdict:** OBSOLETE-BY-C2
- **Rationale:** Migration replaced the six legacy boolean fields with a proper `cktMode` bitfield exactly as C2's scope demands. The code is correct under the current LoadContext surface. When C2 lands (direct MODEINIT* bit writes) and A2 lands (pool.uic deletion → `ctx.uic` field also dies on the LoadContext side if carried along), the `uic: false` line will disappear from this literal. Per L1 routing, the surgical "migrate this specific literal" task does not survive as independent work — C2 is the umbrella. Covered-by-C2.

### B-4. Strengthen sparse-solver weak tests (WT-001, WT-002, WT-003)
- **L1 tag:** BLOCKER → B1 + B2
- **Verification grep result:** `needsReorder.*toBe(true)` in `sparse-solver.test.ts` → 1 hit at line 755 in the `returns failure when pivot becomes near-zero` test (WT-001). Cross-checks: `singularRow` in the same file → hits at 107–108 (a types smoke-test) and at 678 (`expect(result.singularRow).toBe(1);` inside the WT-002 `detects singular matrix` test). The misleading "_needsReorder starts false" comment of WT-003 is gone; line 816 now reads `// First factor: _needsReorder starts true (allocElement sets it).`
- **DONE?:** YES
- **Cited ngspice source:** N/A (test-strengthening item; concrete expected values come from Track A B1/B2 rewrites).
- **Current file state:**
  - WT-001 (lines 732–756): appends `expect(r2.needsReorder).toBe(true)` after `expect(r2.success).toBe(false)`.
  - WT-002 (lines 666–679): appends `expect(result.singularRow).toBe(1)`. `singularRow = 1` is computed from the 2×2 singular matrix used on lines 669–672 (`[[1,1],[1,1]]`, RHS `[1,1]`) — the zero pivot surfaces on row index 1 after the first elimination step. This is the hand-computed expected value flagged in the item's phrasing ("compute from the 2×2 singular matrix"), which is acceptable because the matrix is 2×2 and the row index is structurally determined by the algorithm, not by reference to ngspice output.
  - WT-003 (lines 805–834): comment at line 816 corrected to "First factor: _needsReorder starts true (allocElement sets it)."
- **I1 violation check:** The `singularRow: 1` value is hand-computed from a 2×2 zero-pivot matrix. Per CLAUDE.md/I1, hand-computed expected values are a suppression vector at the test layer. The item itself explicitly calls for this hand computation ("compute from the 2×2 singular matrix"), and Track A B1/B2's own scope will supply the concrete pivot-threshold and reorder-state expected values. No other I1 patterns (no silent catch, no `@ts-expect-error`, no banned vocabulary) in the three test bodies.
- **Verdict:** OBSOLETE-BY-B1
- **Rationale:** All three assertions described in the Required field are in place (needsReorder check at 755, singularRow at 678, comment correction at 816). The hand-computed `singularRow: 1` matches what B1's rewritten `_numericLUReusePivots` (absolute threshold, not column-relative) will also produce for this 2×2 — but per L1 routing, the concrete expected values are defined by B1/B2 and this per-test surgical task does not survive as independent work. Covered-by-B1 (B2 would also touch the comment at 816 via its `_hasPivotOrder` / `_needsReorder` split).

## Summary counts
- ACTUALLY-COMPLETE: 4 (A-1, A-2, A-3, A-4)
- OBSOLETE-BY-TRACK-A: 4
  - B-1 → B3
  - B-2 → ACTUALLY-COMPLETE (item itself was OBSOLETE-tagged by L1, not BLOCKER; comment is correct; keeping as standalone-complete since it doesn't require B1/B2/B3 to land to be done)
  - B-3 → C2
  - B-4 → B1 (+B2 for the comment)
- PAPERED-RE-OPEN: 0
- OPEN (never done): 0
- Total: 8

**Correction to the summary above:** B-2 was L1-tagged OBSOLETE (comment-only hygiene) and the comment is correct as of today. It does not depend on B1/B2/B3 landing and is not dead-on-arrival. It is ACTUALLY-COMPLETE. Revised counts:

- ACTUALLY-COMPLETE: 5 (A-1, A-2, A-3, A-4, B-2)
- OBSOLETE-BY-TRACK-A: 3 (B-1 → B3, B-3 → C2, B-4 → B1)
- PAPERED-RE-OPEN: 0
- OPEN (never done): 0
- Total: 8

## Flags for user review

- **B-4 `singularRow: 1` is a hand-computed expected value.** The item itself instructs the executor to "compute from the 2×2 singular matrix", and I1 policy treats hand-computed test expected values as a suppression vector. The row index is structurally determined (2×2, degenerate column, single elimination step) and B1's rewritten pivot routine will produce the same value for this input, so it is not encoding a divergence. Flagging because if the user reads I1 strictly, any hand-computed test expected that survives A1/B1/B2 execution is meant to be migrated to the ngspice comparison harness rather than kept. The other two assertions added by B-4 (`needsReorder.toBe(true)` and the comment correction) are unambiguously correct.

- **B-1 snapshot helper remains correct after B3, but the surgical fix as specified in B-1 is subsumed.** The helper currently lives outside the factor routine and is called from the two public factorization methods. When B3 lands and Gmin is passed through the factor routine itself, the snapshot-vs-gmin ordering is enforced by the factor routine's internal structure; the helper becomes partly redundant or relocates. Not dead-on-arrival (the snapshot contract is still wanted), but no further independent work remains on this item.

- **No items where ngspice-source verification could not be performed.** A-1/A-2 cite `jfetload.c:256, 267` (verified on disk — plain `exp()` with no clamp). A-3/A-4 are comment-only with `bjtload.c:258-276` used only as the description target (verified via the code structure at bjt.ts:1522–1533 which implements the three-branch dispatch). B-1/B-2/B-3/B-4 do not cite ngspice at the per-item level (they are either diagnostic infrastructure or test-layer work).
