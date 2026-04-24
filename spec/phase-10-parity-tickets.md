# Phase 10 — PARITY Ticket Sink

**Purpose:** single destination for every per-NR-iteration divergence surfaced
by the Phase 10 acceptance suite
(`src/solver/analog/__tests__/ngspice-parity/*.test.ts`).

**Who writes tickets:** agents running Phase 10 waves. Agents write the
*discovery* block only (everything above "User disposition"). Agents never
fix the divergence and never write to `architectural-alignment.md`.

**Who dispositions tickets:** the user. The user fills in the **User disposition**
block, decides whether the ticket is PARITY (numerical fix in a Phase-10
remediation PR), ARCHITECTURAL (user adds to `architectural-alignment.md`),
or INVALID (false positive — e.g. test-design error).

**Who closes tickets:** the user fills in **Resolution commit** once the
remediation has landed or the architectural escalation is recorded.

---

## Ticket format

```markdown
## Ticket P10-<W>.<N> — <circuit>: <short description>

**Surfaced:** YYYY-MM-DD
**Wave:** <W> (<circuit name>)
**Test:** <file>::<describe>::<it>
**Status:** OPEN

**First-divergence iteration:**
- step_index: <N>
- attempt_index: <N>
- iter_index: <N>
- simTime: <seconds>
- cktMode: <decoded label from bitsToName, e.g. "MODEDCOP|MODEINITJCT">

**Diverged quantity:**
- field: <rhsOld[i] / state0[<label>][<slot>] / noncon / diagGmin / srcFact / initMode / order / delta / lteDt>
- ours: <IEEE-754 value, full precision>
- ngspice: <IEEE-754 value, full precision>
- absDelta: <value>

**Cited ngspice source:** <ref/ngspice/src/spicelib/.../file.c:LLL-LLL>
**digiTS file:** <src/.../file.ts:LLL-LLL>

**Hypothesis (implementer, one paragraph max):**
<what you think the cause is; facts only, no remediation proposal>

**User disposition (filled in after review):**
- [ ] PARITY (numerical — fix in a Phase-10 remediation PR)
- [ ] ARCHITECTURAL (user adds to architectural-alignment.md; cannot fix under Phase 10)
- [ ] INVALID (false positive — explain below)

**Disposition notes:** <user's reasoning / architectural-alignment.md item ID if escalated>

**Resolution commit:** <SHA> (or "escalated: <alignment-id>" or "invalid: <reason>")
```

---

## Ticket ID scheme

- `P10-1.N` — Wave 10.1 (resistive divider)
- `P10-2.N` — Wave 10.2 (diode + resistor)
- `P10-3.N` — Wave 10.3 (RC transient)
- `P10-4.N` — Wave 10.4 (BJT common-emitter)
- `P10-5.N` — Wave 10.5 (RLC oscillator)
- `P10-6.N` — Wave 10.6 (op-amp inverting)
- `P10-7.N` — Wave 10.7 (diode bridge)
- `P10-8.N` — Wave 10.8 (MOSFET inverter; D-8 canary for any CCAP_GS/CCAP_GD ticket)

`<N>` is zero-based within the wave. First ticket in Wave 10.4 is `P10-4.0`.

---

## Rules

1. **One ticket per distinct first-divergence iteration.** If a single test
   run surfaces 100 divergent iterations, file one ticket for the earliest
   (lowest step, then lowest iter). Later iterations are downstream
   cascades; they will disappear when the first is fixed.
2. **Ticket body never proposes a fix.** It describes what diverged.
   Remediation belongs in a separate PR the user approves.
3. **Tickets never disappear.** A closed ticket stays in this file with
   its resolution commit SHA. This file is the Phase 10 audit trail.
4. **Banned disposition language.** *mapping*, *tolerance*, *close
   enough*, *equivalent to*, *pre-existing*, *intentional divergence*,
   *citation divergence*, *partial* — per CLAUDE.md. Rejected at review.

---

## Open tickets

*(none yet — populated by Phase 10 wave runs)*

---

## Closed tickets

*(none yet)*
