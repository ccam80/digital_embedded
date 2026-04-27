# Spec Review: Batch 3 — Component Semiconductors A (Diodes, FETs, BJT)

## Verdict: needs-revision

Fifteen files reviewed: PB-DIO, PB-ZENER, PB-SCHOTTKY, PB-VARACTOR, PB-TUNNEL,
PB-NFET, PB-PFET, PB-NMOS, PB-PMOS, PB-NJFET, PB-PJFET, PB-FGNFET, PB-FGPFET,
PB-TRIODE, PB-BJT.

---

## Tally

| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical |     0      |         1         |   1   |
| major    |     5      |         3         |   8   |
| minor    |     3      |         2         |   5   |
| info     |     2      |         0         |   2   |

---

## Plan Coverage

The plan (§Wave plan, W3) specifies that every component listed in
`components/PB-*.md` receives a real `setup()` body replacing the W2 stub,
with the `setup-stamp-order.test.ts` row turning green as the gate. All 15
files in this batch provide that content. No planned task is missing.

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| PB-DIO — diode setup() port | yes | Complete with TSTALLOC table and acceptance criteria |
| PB-ZENER — zener setup() port | yes | Delegates to DIO body, correctly noted |
| PB-SCHOTTKY — schottky setup() port | yes | Same as above |
| PB-VARACTOR — varactor setup() port | yes | Same as above |
| PB-TUNNEL — tunnel diode 1× VCCS topology (plan resolved-decision) | yes | Composite forwards to VCCS |
| PB-NFET — NFET 1× SW composite | yes | Complete |
| PB-PFET — PFET 1× SW composite | yes | Complete |
| PB-NMOS — NMOS mos1 port | yes | Complete with 22-entry TSTALLOC |
| PB-PMOS — PMOS mos1 port | yes | Complete with 22-entry TSTALLOC |
| PB-NJFET — NJFET jfet port | yes | Complete with 15-entry TSTALLOC |
| PB-PJFET — PJFET jfet port | yes | Complete with 15-entry TSTALLOC |
| PB-FGNFET — floating-gate NFET composite | yes | Complete with 26-entry sequence |
| PB-FGPFET — floating-gate PFET composite | yes | Complete with 26-entry sequence |
| PB-TRIODE — triode 1× VCCS topology (plan resolved-decision) | yes | Composite forwards to VCCS |
| PB-BJT — BJT setup() port | yes | Complete with 23-entry TSTALLOC |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| FNJFET-M1 | major | PB-NJFET §Verification gate item 2 | States test file `src/components/semiconductors/__tests__/njfet.test.ts` which does not exist. The real file is `jfet.test.ts` (covers both NJFET and PJFET, confirmed by inspection). | Replace `njfet.test.ts` → `jfet.test.ts` |
| FPJFET-M1 | major | PB-PJFET §Verification gate item 2 | States test file `src/components/semiconductors/__tests__/pjfet.test.ts` which does not exist. The real file is `jfet.test.ts`. | Replace `pjfet.test.ts` → `jfet.test.ts` |
| FNFET-M1 | major | PB-NFET §Verification gate item 2 | States `src/components/switching/__tests__/switches.test.ts`. The NFET/PFET/FGNFET/FGPFET tests live in `fets.test.ts`, not `switches.test.ts`. File `switches.test.ts` exists but covers SW/SwitchDT only. | Replace `switches.test.ts` → `fets.test.ts` |
| FPFET-M1 | major | PB-PFET §Verification gate item 2 | Same wrong test file as FNFET-M1. | Replace `switches.test.ts` → `fets.test.ts` |
| FBJT-M1 | minor | PB-BJT §setup() body, comment on line allocating entries 19-21 | Comment reads `// Substrate stamps — bjtsetup.c:453 (entries 19-21, substNode=0)`. Line 453 of `bjtsetup.c` is only `BJTsubstSubstPtr` (entry 19); entries 20-21 are at lines 461-462 (after the lateral/vertical branch at lines 454-460). The comment implies all three are at line 453. | Replace `bjtsetup.c:453` → `bjtsetup.c:453,461-462` (or expand to `bjtsetup.c:453 (entry 19), :461-462 (entries 20-21)`) |

### Decision-Required Items

#### FSCHOTTKY-D1 — Missing dedicated test file in verification gate (major)

- **Location**: PB-SCHOTTKY §Verification gate item 2
- **Problem**: States `src/components/semiconductors/__tests__/schottky.test.ts` is GREEN. No such file exists. The `schottky.ts` component appears in `spice-model-overrides-prop.test.ts` only as a definition import (not a functional simulation test). This is different from the diode/zener/varactor situation where dedicated test files exist.
- **Why decision-required**: Two options exist and neither is obviously correct without knowing the existing test coverage level.
- **Options**:
  - **Option A — Create dedicated test file**: Update the spec to instruct the implementer to create `src/components/semiconductors/__tests__/schottky.test.ts` with simulation assertions (forward voltage, RS-conditional internal node, TSTALLOC ordering), matching the pattern of `diode.test.ts`.
    - Pros: Consistent with all other diode variants; provides real regression guard.
    - Cons: Increases implementer scope; requires deciding what assertions are sufficient.
  - **Option B — Redirect gate to existing test file**: Change the gate to `spice-model-overrides-prop.test.ts` and accept that Schottky has no stand-alone simulation test for this wave.
    - Pros: No new file needed; implementer scope stays minimal.
    - Cons: The existing file only checks param definitions, not simulation behavior; the verification gate becomes meaningless as a correctness check.

---

#### FTUNNEL-D1 — VCCS handle visibility for load() stamping is unspecified (major)

- **Location**: PB-TUNNEL §load() body
- **Problem**: The spec states the parent TunnelDiode load() stamps via `this._vccs._hPosCPos`, `this._vccs._hPosCNeg`, etc., accessing the sub-element's private `_h*` handle fields directly with the `_` prefix (TypeScript private-by-convention). The spec does not specify whether these handles are exposed via a getter, accessed directly, or whether TunnelDiode's load() is merged into the VCCS sub-element's load() override. The spec says: `"solver.stampElement(this._vccs._hPosCPos, +g)"` — but `_hPosCPos` is a private field on a class the implementer does not own.
- **Why decision-required**: Three distinct approaches exist and each has architectural implications.
- **Options**:
  - **Option A — Direct access (TypeScript convention)**: Keep the spec as written. In TypeScript the `_` prefix is convention only; cross-class access is legal at the type level. The implementer accesses `this._vccs._hPosCPos` directly.
    - Pros: Simple; no new API surface.
    - Cons: Violates encapsulation; if VCCS class later renames handles, TunnelDiode silently breaks.
  - **Option B — Expose handles via getter/accessor on VccsAnalogElement**: Add a spec note requiring `VccsAnalogElement` to expose its four handles via a `readonly` object (`get stamps(): { hPosCPos, hPosCNeg, hNegCPos, hNegCNeg }`).
    - Pros: Explicit API contract; encapsulation preserved.
    - Cons: Adds surface to VccsAnalogElement spec (PB-VCCS) that must be coordinated.
  - **Option C — Triode/Tunnel override the VCCS load() entirely**: Instead of the composite calling `stampElement` with raw handles, the composite provides its own load() that calls a protected/package method on VccsAnalogElement passing conductance values.
    - Pros: Clean abstraction; both Tunnel and Triode use same pattern.
    - Cons: Larger API change; most complex to specify.

---

#### FTRIODE-D1 — gds output-conductance stamps are conditionally unspecified (critical)

- **Location**: PB-TRIODE §load() body, lines describing `gds` output-conductance stamps
- **Problem**: The spec contains an IMPLEMENTER NOTE that is structurally a decision not yet made: `"IMPLEMENTER NOTE: if gds ≠ 0 requires stamps at (P,P) and (K,P), add two additional allocElement calls in setup() ... This is in addition to the 4 VCCS entries — total 6 handles for Triode."` The spec says "if gds ≠ 0" but the Koren formula always produces non-zero `gds` for any operating point where the plate current is non-zero — there is no gds=0 case in normal operation. The TSTALLOC entry count (4 vs 6) is therefore ambiguous. The `setup-stamp-order.test.ts` row for PB-TRIODE cannot be written without knowing the correct count.
- **Why decision-required**: The implementer cannot proceed without resolving this; the verification gate test (setup-stamp-order.test.ts row) will be wrong if the wrong count is chosen.
- **Options**:
  - **Option A — Always 6 handles (4 VCCS + 2 output-conductance)**: The spec requires the Triode setup() to unconditionally add `allocElement(P,P)` and `allocElement(K,P)` beyond the 4 VCCS entries. The setup-stamp-order test row asserts a 6-entry sequence. load() always uses all 6 handles.
    - Pros: Correct physics; gds is never zero in practice; unconditional allocation matches ngspice's always-allocate convention.
    - Cons: Breaks the "VCCS sub-element's setup() is the full setup" narrative; Triode's setup() becomes non-trivial.
  - **Option B — Always 4 handles (pure VCCS delegation)**: Accept that gds is folded into the Norton current term only (as a separate RHS-only stamp), requiring no additional matrix entries. The gds contribution is approximated as zero in the conductance matrix and absorbed entirely into `ieq`. This loses quadratic convergence for the output-conductance term.
    - Pros: Simpler; 4-handle TSTALLOC matches the pure VCCS spec.
    - Cons: Numerically incorrect; output conductance not in the Jacobian; convergence will degrade for Triode circuits.
  - **Option C — Triode overrides VccsAnalogElement and has its own TSTALLOC block**: Triode is no longer treated as a pure VCCS composite but as a standalone element with its own 6-entry setup() (P-G, P-K, K-G, K-K, P-P, K-P) matching a custom ngspice-equivalent TSTALLOC block.
    - Pros: Cleanest for both physics and spec clarity; setup-stamp-order test has an unambiguous 6-entry sequence.
    - Cons: Breaks the "1× VCCS topology" resolved-decision framing in plan.md; requires updating the plan.

---

#### FFGNFET-D1 — State-slot allocation order claim contradicts setup() body (major)

- **Location**: PB-FGNFET §State slots and §setup() body
- **Problem**: The "State slots" section says: `"Setup order: CAP setup runs first, then MOS setup (in subElements[] order sorted by ngspiceLoadOrder)."` However, the setup() body shows `this._fgNode = ctx.makeVolt(...)` first, then `this._cap.setup(ctx)`, then `this._mos.setup(ctx)`. The claim that "CAP runs first" is stated as a consequence of `ngspiceLoadOrder` sorting. But the spec does not state what `ngspiceLoadOrder` values CAP and MOS have, nor does it say whether the composite respects `ngspiceLoadOrder` for sub-elements or always runs CAP before MOS by construction. If the ngspiceLoadOrder values differ from what the spec implies, the state slot offsets will disagree between the code and the spec's sequence.
- **Why decision-required**: Two fixes are possible, each resolving the ambiguity differently.
- **Options**:
  - **Option A — State the explicit ngspiceLoadOrder values**: Add to the spec: `"CAP has ngspiceLoadOrder X, MOS has ngspiceLoadOrder Y, X < Y, so CAP setup() runs before MOS setup()."` The implementer can verify this matches the existing codebase.
    - Pros: Fully concrete; implementer can verify independently.
    - Cons: Requires the spec author to look up the actual values.
  - **Option B — Remove the ngspiceLoadOrder rationale and make the order explicit by construction**: The spec states that the composite's `setup()` always calls `this._cap.setup(ctx)` before `this._mos.setup(ctx)`, by explicit ordering in the setup() body (not sorted array). Remove the `subElements[]`-sorted-by-`ngspiceLoadOrder` claim entirely from the FGNFET spec.
    - Pros: Avoids a dependency on ngspiceLoadOrder values; setup() body already demonstrates this order.
    - Cons: May diverge from how other composites handle sub-element ordering.

---

#### FFGPFET-D1 — Same issue as FFGNFET-D1 (major)

- **Location**: PB-FGPFET §State slots
- **Problem**: Identical to FFGNFET-D1 — `"Setup order: CAP first, then MOS (by ngspiceLoadOrder)"` without specifying the ngspiceLoadOrder values. The setup() body is explicit, but the rationale is unverifiable.
- **Why decision-required**: Same reasoning as FFGNFET-D1.
- **Options**:
  - **Option A**: Same as FFGNFET-D1 Option A.
  - **Option B**: Same as FFGNFET-D1 Option B.

---

#### FNFET-D1 — SW sub-element `setControlVoltage` method is not in the SW spec contract (minor)

- **Location**: PB-NFET §load() body
- **Problem**: The load() body calls `this._sw.setControlVoltage(vCtrl)`, described as `"internal load-time setter"`. This method is not defined in PB-SW, not in the engine interface specs (00-engine.md, analog-types.ts), and not in any existing public interface. An implementer reading only PB-NFET cannot know whether this method already exists on `SwitchElement`, must be added as part of this task, or should be implemented differently.
- **Why decision-required**: There are meaningfully different implementation paths.
- **Options**:
  - **Option A — Add `setControlVoltage` to PB-SW spec**: The implementer of PB-NFET must also add this method to `SwitchElement`. The spec for PB-SW should be updated to include this method's signature and semantics.
    - Pros: Makes PB-NFET self-contained from the SW perspective.
    - Cons: Cross-file spec change; PB-SW has already been (or will be) reviewed separately.
  - **Option B — Note that NFET reads rhsOld directly**: Instead of `setControlVoltage`, the load() body reads `ctx.rhsOld[gateNode]` and `ctx.rhsOld[sourceNode]` directly and passes vCtrl to the switch's load via the existing SW load pathway (e.g., via a stored field or the same `rhsOld` mechanism SW uses). The SW's load() already reads a control voltage from somewhere — clarify whether that is via rhsOld lookup (which the NFET composite should set up) or via a separate setter.
    - Pros: No new API on SwitchElement.
    - Cons: Requires understanding SW's existing load() control-voltage mechanism, which is not quoted in the spec.

---

### Batch-Wide Findings

#### BATCH3-M1 — Missing `M` (multiplicity) instance-param treatment across all 15 files (minor)

The assignment brief flags "Forgetting `M` (multiplicity) instance-param treatment per the in-progress phase-instance-vs-model-param-partition work." None of the 15 files mentions `M` or multiplicity. For the diode variants (DIO, ZENER, SCHOTTKY, VARACTOR), ngspice's `diosetup.c` uses `here->DIOm` (multiplicity, default 1) in `dioload.c` to scale current and conductance stamps. The setup() bodies here are correct (no multiplicity in TSTALLOC allocation), but the absence of any mention means load()-side implementers have no guidance. For MOS and BJT the situation is the same — `MOS1m` and `BJTm` scale the load stamps but not the matrix allocation. This is a load() concern, not a setup() concern, but the spec's "load() body — value writes only" section for each file says only "port value-side from X line-for-line" without noting that multiplicity scaling must be preserved.

Severity classification: minor — setup() is unaffected; load() body implementers must consult ngspice source directly (which the spec already requires), but the omission means they might miss the M-scaling if they rely solely on the spec description.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH3-M1 | minor | All 15 files §load() body | No mention of multiplicity (`M` / `m` parameter) scaling in load() side | Add a bullet to each file's `load() body` section: `"Port the multiplicity scaling: all current and conductance stamps are multiplied by the instance M parameter (default 1.0), matching ngspice's *load.c usage of here->MOS1m / here->DIOm / here->BJTm / here->JFETm."` |

#### BATCH3-M2 — `mayCreateInternalNodes` missing from PB-FGNFET and PB-FGPFET `MnaModel` (info)

PB-FGNFET and PB-FGPFET both set `mayCreateInternalNodes: true` in the Factory cleanup section (correct — the composite allocates the floating-gate node via `ctx.makeVolt`). The info-level observation is that the spec does not distinguish whether `mayCreateInternalNodes: true` is set on the **composite's** MnaModel or only on the sub-element MnaModels. The engine-side usage of `mayCreateInternalNodes` (00-engine.md §A3.1) is for topology validators (detectVoltageSourceLoops, detectInductorLoops) — they need this flag on the model that gets registered in the compiler. For composites, that is the composite's MnaModel. The current spec text is unambiguous on this point (it says "Add `mayCreateInternalNodes: true`" under Factory cleanup which refers to the composite's model registration), so this is info only.

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| BATCH3-M2 | info | PB-FGNFET, PB-FGPFET §Factory cleanup | `mayCreateInternalNodes: true` is stated correctly for the composite model, but the relationship to sub-element model registration is not mentioned | No action required; flagged for implementer awareness |

---

## Summary Table — Per-File Verdict

| File | Verdict | Blocking findings |
|------|---------|-------------------|
| PB-DIO | ready | none |
| PB-ZENER | ready | none |
| PB-SCHOTTKY | needs-revision | FSCHOTTKY-D1 (missing/wrong test gate) |
| PB-VARACTOR | ready | none |
| PB-TUNNEL | needs-revision | FTUNNEL-D1 (handle access unspecified) |
| PB-NFET | needs-revision | FNFET-M1 (wrong test file), FNFET-D1 (setControlVoltage unspecified) |
| PB-PFET | needs-revision | FPFET-M1 (wrong test file) |
| PB-NMOS | ready | none |
| PB-PMOS | ready | none |
| PB-NJFET | needs-revision | FNJFET-M1 (wrong test file) |
| PB-PJFET | needs-revision | FPJFET-M1 (wrong test file) |
| PB-FGNFET | needs-revision | FFGNFET-D1 (state-slot order ambiguous) |
| PB-FGPFET | needs-revision | FFGPFET-D1 (state-slot order ambiguous) |
| PB-TRIODE | needs-revision | FTRIODE-D1 (gds stamp count unresolved — critical) |
| PB-BJT | ready (minor note) | FBJT-M1 is minor, does not block |

---

## Overall Batch Verdict: needs-revision

One critical item (FTRIODE-D1) blocks the PB-TRIODE implementer from writing a
correct `setup-stamp-order.test.ts` row. Six mechanical items (wrong test-file
paths) are straightforward fixes. Two major decision-required items
(FFGNFET-D1/FFGPFET-D1, FTUNNEL-D1) need authorial resolution before the
corresponding implementer agents start work. The nine files without blocking
findings (DIO, ZENER, VARACTOR, NMOS, PMOS, BJT, and the ready group) can
proceed to implementation immediately after the batch-wide BATCH3-M1 note is
addressed.
