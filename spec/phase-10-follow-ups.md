# Phase 10 Follow-Ups — deferred tasks gated on engine stability

**Status:** living document. Items accumulate as earlier phases spec work that requires a stable engine (i.e., post-Phase-10 bit-exact acceptance) to be meaningful.

**Rule:** nothing here runs until Phase 10 closes. Running parity tests or detailed device-level numerical tests against an engine with known-broken upstream paths produces confounded failures, which is the exact pattern the user has flagged as burning the project historically.

**Authority:** items added here are either (a) the natural consequence of a spec author realising that a test or audit would be premature at their phase, or (b) a user action flagged during spec authoring. Agents may add items under (a); user approval is required to close or remove any item.

---

## §JFET — deferred from Phase 7 (F5ext)

Phase 7 landed the NR convergence machinery (cghat/cdhat compute, NOBYPASS bypass, full MODEINITPRED state-copy, primeJunctions deletion, shared fetlim helper, noncon-gate comment fix) as a smoke-only delivery. The following tests are deferred until post-Phase-10, when the engine is stable enough that failures are signal rather than noise.

- **J-D-1: MODEINITPRED 9-slot state1→state0 copy completeness.** Seed `s1[base + SLOT_{VGS,VGD,CG,CD,CGD,GM,GDS,GGS,GGD}]` with nine distinct sentinel values; call `load()` with `ctx.cktMode = MODEINITPRED | MODETRAN`. Assert `s0[base + SLOT_X] === s1[base + SLOT_X]` for each of the nine slots.
- **J-D-2: cghat/cdhat extrapolation numerical output.** Seed state0 at a known DC-OP (via the ngspice comparison harness — no hand-computed expected values). Advance `ctx.rhsOld` by a known `delvgs`/`delvgd`. Call `load()`. Assert the computed `cghat`/`cdhat` match ngspice's extrapolation at the same seeded state, sampled via the harness on the same circuit.
- **J-D-3: Noncon gate triggers (three axes).** (a) `icheckLimited=true` alone ⇒ `ctx.noncon.value++`. (b) `icheckLimited=false`, cg diverged such that `|cghat-cg| >= reltol*max + iabstol` ⇒ bump. (c) `icheckLimited=false`, cd diverged such that `|cdhat-cd| > reltol*max + iabstol` ⇒ bump. Confirms the `>=` vs. `>` ngspice asymmetry.
- **J-D-4: NOBYPASS bypass block (four axes).** (a) `ctx.bypass=false` ⇒ bypass never fires. (b) `ctx.bypass=true` + MODEINITPRED ⇒ bypass suppressed. (c) `ctx.bypass=true`, tolerances satisfied ⇒ bypass fires; compute block skipped (sentinel slot unchanged); stamps still emitted; noncon still runs. (d) `ctx.bypass=true`, one tolerance just exceeds ⇒ bypass does not fire.
- **J-D-5: JFET common-source harness parity.** Small NJFET common-source circuit via ngspice comparison harness. Per-NR-iteration `rhsOld[]` IEEE-754 bit-exact vs. ngspice. Covers the general iteration path (limiting + cghat/cdhat + Sydney drain current + stamp block).
- **J-D-6: JFET transient NIintegrate parity.** NJFET with non-zero CGS/CGD driven by a pulse source. Per accepted timestep, `dt`/`order`/`method` match; per-step NR iteration count matches; `state0[SLOT_QGS]`, `state0[SLOT_CQGS]`, `state0[SLOT_QGD]`, `state0[SLOT_CQGD]` match exactly at every NR iteration.
- **J-D-7: PJFET stamp-sign parity.** Same acceptance as J-D-5 but with a PJFET common-source circuit. Verifies the polarity-literal port replicates the `-1` polarity bit-exactly against ngspice's `JFETtype = PJF = -1`.

**Trigger to activate §JFET:** Phase 10 Wave 10.2 has closed for all MOSFET + BJT + diode circuits and a JFET circuit has been added to the acceptance matrix. If Phase 10's original 8-circuit matrix omits JFET (Appendix A in `spec/plan.md`), the user decides whether to (i) add a JFET circuit to Phase 10 or (ii) run these tests as a Phase 10.3 post-acceptance addendum.

---

## §I2.1 cleanup — user action flagged during Phase 7 spec authoring (2026-04-24)

Phase 7 spec authoring surfaced that `architectural-alignment.md §I2.1` mischaracterises `diode.ts SLOT_CCAP` and `inductor.ts SLOT_CCAP` as "cross-timestep NIintegrate externalisations — values ngspice keeps implicit inside its own NIintegrate routine." This framing is factually wrong. Verification (recorded here so the user does not need to re-derive it):

- `diodefs.h:158` defines `#define DIOcapCurrent DIOstate+4` — a direct CKTstate offset, addressable by every diode method.
- `dioload.c:363` writes `*(ckt->CKTstate0 + here->DIOcapCurrent) = capd;` — direct state-slot write, not internalised in NIintegrate.
- `dioload.c:400-401` copies `CKTstate0+DIOcapCurrent` into `CKTstate1+DIOcapCurrent` under MODEINITTRAN — direct state copy, same pattern as every other device.
- `inddefs.h` defines `#define INDflux INDstate` — direct offset; `indload.c:95-108` reads and writes it directly.
- `jfetdefs.h:164, 166` defines `JFETcqgs = JFETstate+10`, `JFETcqgd = JFETstate+12` — same pattern.

These slots are **bit-exact mirrors** of ngspice CKTstate offsets, not externalisations. The I2.1 framing appears to have been an agent self-cover: justifying why slots survived the A1 sweep by inventing a category ("ngspice keeps implicit, we materialise") that does not correspond to the ngspice source.

**User actions (post-Phase-7, not agent-authorable per §0 of `architectural-alignment.md`):**

1. **Rewrite `architectural-alignment.md §I2.1`.** Strike the "externalisation" language. Replace with: "digiTS pool slots that directly mirror ngspice `CKTstate[<offset>]` entries via an addressable offset constant in the matching `<dev>defs.h`. These are not invented; they are ngspice state and participate in the harness comparison like any other state slot."
2. **Recorded slot list updates** (under the rewritten §I2.1):
   - `diode.ts SLOT_CCAP` (currently position 6 in `DIODE_SCHEMA`) mirrors `DIOcapCurrent = DIOstate+4`.
   - `inductor.ts SLOT_CCAP` mirrors `INDflux = INDstate`.
   - `njfet.ts SLOT_CQGS` mirrors `JFETcqgs = JFETstate+10`.
   - `njfet.ts SLOT_CQGD` mirrors `JFETcqgd = JFETstate+12`.
   - `pjfet.ts SLOT_CQGS`, `pjfet.ts SLOT_CQGD` — same mapping as NJFET.
3. **Harness `device-mappings.ts` updates.** `src/solver/analog/__tests__/harness/device-mappings.ts` currently leaves these slots unmapped (treated as "not directly comparable" per the now-wrong I2.1 framing). Add explicit mappings:
   - diode: `SLOT_CCAP` → `DIOcapCurrent` (offset 4 within DIOstate)
   - inductor: `SLOT_CCAP` → `INDflux` (offset 0 within INDstate)
   - NJFET and PJFET: `SLOT_CQGS` → `JFETcqgs` (offset 10), `SLOT_CQGD` → `JFETcqgd` (offset 12)
   - The harness comparison will then cover these slots. If the comparison fails, that is a genuine numerical bug, not a papered-over architectural divergence.
4. **Audit for other mis-filed I2.1 entries.** Any additional pool slot that is (a) listed under I2.1 or (b) unmapped in `device-mappings.ts` with a justification mentioning "NIintegrate internal" or "externalisation" — re-check against the corresponding `<dev>defs.h`. If it maps to an addressable CKTstate offset, it joins the corrected §I2.1 list; if it genuinely does not, the slot is suspect and may require A1-style excision.

**Trigger to activate §I2.1 cleanup:** Phase 10 closes and the user schedules the architectural-alignment doc cleanup. The actions above do not block Phase 10 acceptance tests — the existing unmapped-slot treatment in `device-mappings.ts` is conservative (harness treats unmapped slots as "skip") and will not produce false negatives. Cleanup restores the mapped-slot checks that §I2.1's wrong framing had disabled.

---

## Adding items to this file

- Any spec author deferring a test or audit to post-Phase-10 adds it here under a new `§<topic>` section.
- Each item names: what to test or do, how to trigger it, and what the expected outcome is.
- No item here is a ticket — these are scoped work packages the user or a future agent picks up once Phase 10 is green.
- Items are removed only after the user confirms they have landed (or been superseded by a later-landed change).
