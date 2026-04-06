# Review Report: Wave B.1

**Scope:** Tasks WB1 (capacitor.ts) and WB2 (inductor.ts), commit range 47baf56..117641d
**Phase spec:** spec/state-pool-schema.md ss1.4, ss1.6, ss4.2, ss5.1 items 5-6
**Files changed:** spec/progress.md, src/components/passives/capacitor.ts, src/components/passives/inductor.ts

---

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 |
| Violations critical | 0 |
| Violations major | 2 |
| Violations minor | 1 |
| Gaps | 1 |
| Weak tests | 2 |
| Legacy references | 0 |

**Verdict: has-violations**

---

## Violations

### V1 --- Major

**File:** src/components/passives/inductor.ts, lines 165-169
**Rule violated:** Spec ss1.3 requires readonly isReactive: true as a literal-type discriminant. Code Hygiene rule prohibits type widenings that violate the declared interface contract.
**Evidence:**

    readonly isNonlinear: boolean = false;
    readonly isReactive: boolean = true;
    readonly stateSize: number = INDUCTOR_SCHEMA.size;
    stateBaseOffset: number = -1;

The explicit : boolean annotation on isReactive widens the literal type true to boolean. Spec ss1.3 states: "The readonly isReactive: true discriminant property is REQUIRED --- it is what makes ReactiveAnalogElement a discriminated union member of AnalogElementCore and allows narrowing. Do not omit it." Annotating : boolean defeats the discriminant: TypeScript cannot narrow on element.isReactive === true when the property type is boolean. The capacitor (WB1) correctly infers the literal type by writing readonly isReactive = true with no annotation (capacitor.ts line 160). The inductor retains pre-migration explicit type annotations on all four of the above fields, making WB2 non-compliant with the interface spec the wave was supposed to demonstrate.

**Severity: major**

---

### V2 --- Major

**File:** src/components/passives/inductor.ts, lines 233-248 (getLteEstimate)
**Rule violated:** Spec ss5.1 item 6 --- "no behavior change"; rules.md Completeness --- agents must not resolve spec conflicts unilaterally; they must flag conflicts to the orchestrator.

**Evidence (removed code):**

    const iPrevPrev = this.s0[this.base + SLOT_I_PREV_PREV];
    const deltaI = Math.abs(iPrev - iPrevPrev);
    const fluxRef = this.L * Math.max(Math.abs(iPrev), Math.abs(iPrevPrev));
    return {
      truncationError: (dt / 12) * deltaI,
      toleranceReference: fluxRef,
    };

**Evidence (replacement code introduced by this commit):**

    const fluxRef = this.L * Math.abs(iPrev);
    return {
      truncationError: (dt / 12) * Math.abs(iPrev),
      toleranceReference: fluxRef,
    };

Spec ss5.1 item 6 states explicitly: "Listed as clean today, so no behavior change; adopting the schema locks in the contract." The two-point delta LTE estimate (|iPrev - iPrevPrev|) was replaced with a single-point magnitude estimate (|iPrev|). These are algorithmically different: the two-point delta correctly approaches zero as the inductor reaches DC steady state (where current is constant), allowing the engine to accept larger timesteps. The single-point formula is always non-zero when current flows, causing unnecessary timestep rejections at steady state and wasting simulation time. The spec ss4.2 prescription of [...L_COMPANION_SLOTS, V_PREV] as the fourth slot prescribes only the slot layout, not a change to the LTE computation. The progress note in spec/progress.md acknowledges the change without flagging it as a spec deviation or seeking orchestrator approval, which violates the rule that agents must flag conflicts rather than resolving them unilaterally.

**Severity: major**

---

### V3 --- Minor

**File:** src/components/passives/inductor.ts, line 163
**Rule violated:** Code Hygiene --- "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."
**Evidence:**

    pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns

This comment describes the calling convention of the infrastructure, not the semantics of the field. It documents a mechanism ("Object.assign after factory returns") rather than explaining something complex about the field itself. The capacitor migration (WB1) correctly removed this same comment --- capacitor.ts line 157 now reads pinNodeIds!: readonly number[]; with no trailing comment. The inductor retains it unchanged from the pre-migration file.

**Severity: minor**

---

## Gaps

### G1 --- Unauthorized behavioral change not escalated

**Spec requirement:** ss5.1 item 6 --- "no behavior change."
**What was found:** The LTE estimate for inductors was algorithmically degraded from a two-point delta to a single-point magnitude (see V2). The wave completion report submitted to the orchestrator ("WB2: complete --- inductor.ts adopts INDUCTOR_SCHEMA via L_COMPANION_SLOTS + V_PREV (4 total). 28/28 tests") does not mention this behavioral change. The spec rules state agents must flag conflicts to the orchestrator rather than resolving them unilaterally. The change was made silently, documented only in the progress.md notes, and presented to the orchestrator as a clean completion. The orchestrator cannot make an informed acceptance decision without knowing a behavioral regression was introduced alongside the schema migration.
**File:** src/components/passives/inductor.ts lines 233-248; spec/progress.md WB2 notes.

---

## Weak Tests

### WT1

**Test path:** src/components/passives/__tests__/inductor.test.ts::Inductor::statePool::getLteEstimate returns non-zero truncationError after stampCompanion with non-zero branch current
**What is wrong:** The assertion expect(lte.truncationError).toBeGreaterThan(0) is a weak lower-bound check. It does not pin the exact value of truncationError, so it passes regardless of whether the old two-point formula or the new single-point formula is used. The test cannot detect the behavioral regression introduced in V2. With the known inputs (dt=1e-4, first call iNow=0.5, second call iNow=0.6), the single-point formula produces (1e-4/12)*0.6 = 5e-6 and the two-point formula produces (1e-4/12)*|0.6-0.5| = 8.33e-7. The test should assert the expected exact value with toBeCloseTo.
**Evidence:**

    expect(lte.truncationError).toBeGreaterThan(0);

---

### WT2

**Test path:** src/components/passives/__tests__/capacitor.test.ts::Capacitor::statePool::getLteEstimate returns non-zero truncationError after stampCompanion
**What is wrong:** The assertion expect(lte.truncationError).toBeGreaterThanOrEqual(0) is trivially true --- it accepts zero, which would be returned by a completely broken LTE implementation. With known inputs (C=1e-6, v=5V, dt=1e-6, method="bdf1"), after one stampCompanion call I_PREV = (C/h)*v = 1.0*5 = 5A and I_PREV_PREV = 0, so deltaI = 5 and truncationError = (dt/12)*5 ~= 4.167e-7. The test should assert this exact value with toBeCloseTo.
**Evidence:**

    expect(lte.truncationError).toBeGreaterThanOrEqual(0);

---

## Legacy References

None found.

---

## Additional Notes

**WB1 (capacitor.ts) verdict: clean.** The capacitor migration matches the ss1.4 spec example precisely. CAPACITOR_SCHEMA is declared at module scope with [...CAP_COMPANION_SLOTS, I_PREV, I_PREV_PREV, V_PREV_PREV] (6 slots). All class field annotations use inferred literal types (no : boolean or : number widenings). initState correctly calls applyInitialValues. No behavioral changes. No historical-provenance comments. The old slot-comment block was replaced by the schema declaration. This task is fully spec-compliant.

**WB2 (inductor.ts) verdict: has-violations.** The schema declaration and slot layout are correct per ss4.2: [...L_COMPANION_SLOTS, V_PREV] at module scope, size=4. initState calls applyInitialValues. The two violations are: (V1) explicit : boolean / : number type annotations widening the literal types required by the ReactiveAnalogElement discriminated union; (V2) unauthorized LTE algorithm degradation from two-point delta to single-point magnitude, silently introduced without orchestrator approval and in direct conflict with the "no behavior change" mandate in ss5.1 item 6.
