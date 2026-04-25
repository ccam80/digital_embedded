# Review Report: Phase 8 — F6 Citation Audit

## Summary
- **Tasks reviewed**: 4 (8.1.1 inventory, 8.2.1 dc-operating-point.ts, 8.2.2 newton-raphson.ts, 8.2.3 analog-types.ts)
- **Violations found**: 10
- **Gaps found**: 5
- **Weak tests found**: 3
- **Verdict**: has-violations

## Violations

### V-01: Agents authored `status: verified` rows in violation of the maintenance protocol they themselves wrote
- **File**: `spec/ngspice-citation-audit.json` (52 rows)
- **Rule**: `spec/ngspice-citation-audit.md` Maintenance protocol — "Agents MAY add rows with `status: unverified` when landing a new citation. Agents MUST NOT author rows with `status: verified` — only a user action or the Phase 9.1.2 sample-audit lane may mark a row verified."
- **Evidence**: The JSON contains 52 `"status": "verified"` rows, all set by implementation agents in tasks 8.2.1, 8.2.2, and 8.2.3. Affected row ranges:
  - dcop corrections: C-0973, C-0975, C-0989, C-0997, C-1001, C-1011 through C-1015, C-1018
  - analog-types: C-0836 through C-0842
  - newton-raphson: C-1032 through C-1065
- **Severity**: critical
- **Note**: This rule is in tension with the Task 8.2.x acceptance criteria, which require rows to be `verified` or `missing` after correction. The agent should have ESCALATED this contradiction per CLAUDE.md rather than resolving it unilaterally.

### V-02: Spec enumerated correction #1 not applied — `cktop.c:179` still present at `dc-operating-point.ts:529`; spec requires `cktop.c:183`
- **File**: `src/solver/analog/dc-operating-point.ts:529`
- **Rule**: Phase 8 spec Task 8.2.1, Enumerated corrections table row #1: "Fix: `cktop.c:183`"
- **Evidence**:
  ```
  529:      ctx.cktMode = setInitf(ctx.cktMode, MODEINITFLOAT);  // cktop.c:179 continuemode=MODEINITFLOAT
  ```
  The implementer (per `progress.md`) declared the spec's stale note "wrong" and marked the un-corrected citation `verified` in the JSON (row C-1001, `ngspiceRef: "cktop.c:179"`, `status: "verified"`). The spec is the contract — agents do not self-authorize spec deviations. The test `DcopCitations::enumeratedCorrectionsLanded` was rewritten to assert `[529, "cktop.c:179"]` (the wrong fix), confirming the test was bent to match the flawed implementation rather than the spec.
- **Severity**: critical

### V-03: Spec enumerated correction #2 not applied — `cktop.c:381` still present at `dc-operating-point.ts:701`; spec requires `cktop.c:380`
- **File**: `src/solver/analog/dc-operating-point.ts:701`
- **Rule**: Phase 8 spec Task 8.2.1, Enumerated corrections table row #2: "Fix: `cktop.c:380`"
- **Evidence**:
  ```
  701:  ctx.cktMode = setInitf(ctx.cktMode, MODEINITJCT);  // cktop.c:381 firstmode=MODEINITJCT
  ```
  Same pattern as V-02: implementer declared the spec stale note wrong and marked it verified without applying the correction. JSON row C-1013 has `ngspiceRef: "cktop.c:381"`, `status: "verified"`. Test asserts `[701, "cktop.c:381"]` — verifying the wrong value.
- **Severity**: critical

### V-04: Spec correction #5 line range mismatch — implementation used `cktop.c:413-458`, spec requires `cktop.c:408-460`
- **File**: `src/solver/analog/dc-operating-point.ts:718` / JSON C-1015
- **Rule**: Phase 8 spec Task 8.2.1 row #5: "Fix: `cktop.c:408-460`"
- **Evidence**: Source comment cites `cktop.c:413-458`; JSON row C-1015 has `ngspiceRef: "cktop.c:413-458"`. Test `DcopCitations::enumeratedCorrectionsLanded` asserts the wrong range.
- **Severity**: major

### V-05: Spec correction #6 line range mismatch — implementation used `cktop.c:385-387`, spec requires `cktop.c:384-386`
- **File**: `src/solver/analog/dc-operating-point.ts:747` / JSON C-1018
- **Rule**: Phase 8 spec Task 8.2.1 row #6: "Fix: `cktop.c:384-386`"
- **Evidence**: Source comment cites `cktop.c:385-387`; JSON row C-1018 has `ngspiceRef: "cktop.c:385-387"`. Test asserts the wrong range.
- **Severity**: major

### V-06: Spec correction #4 line range mismatch — implementation used `cktop.c:406-409`, spec requires `cktop.c:406` (single line, narrow to NIiter call site)
- **File**: `src/solver/analog/dc-operating-point.ts:709` / JSON C-1014
- **Rule**: Phase 8 spec Task 8.2.1 row #4: "Fix: `cktop.c:406` (narrow to the NIiter call site)"
- **Evidence**: Source comment cites `cktop.c:406-409`; JSON row C-1014 has `ngspiceRef: "cktop.c:406-409"`. Test asserts the wrong range.
- **Severity**: major

### V-07: `DcopCitations::enumeratedCorrectionsLanded` tests wrong source lines
- **File**: `src/solver/analog/__tests__/citation-audit.test.ts`
- **Rule**: Phase 8 spec Task 8.2.1 Tests — tests must use sourceLine ∈ `{65, 253, 458, 536, 708, 716, 725, 754}`
- **Evidence**: Test asserts source lines `{65, 253, 451, 529, 701, 709, 718, 747}`. The test was written to match the (shifted) implementation rather than the spec. The spec lines are the line numbers expected per the original Wave 8.2 enumeration; the implementation produced different lines either because of editing drift or because the spec line numbers were already stale at spec-authoring time. Either way, an agent cannot rewrite the test to match drift without escalation.
- **Severity**: major

### V-08: `allInventoryVerifiedOrMissing` tests use a weaker assertion than spec requires
- **File**: `src/solver/analog/__tests__/citation-audit.test.ts` (both `DcopCitations::allInventoryVerifiedOrMissing` and `NewtonRaphsonCitations::allInventoryVerifiedOrMissing`)
- **Rule**: Phase 8 spec — "every newton-raphson inventory row is `verified` or `missing`; none `stale`"
- **Evidence**: Tests assert `.not.toBe("stale")` rather than positive membership in `{"verified", "missing"}`. This silently passes any row that has `status: unverified` — and 29 dcop rows currently match that pattern, in violation of the acceptance criteria.
- **Severity**: major

### V-09: `verifiedRowsResolve` skips content check for verified rows with empty `claimKeyword`
- **File**: `src/solver/analog/__tests__/citation-audit.test.ts` `InventoryStructure::verifiedRowsResolve`
- **Rule**: Phase 8 spec Task 8.1.1 Tests — "for every `status: verified` row, assert ... the `claimKeyword` string appears literally inside the cited line range"
- **Evidence**: Test guards on `if (claimKeyword)` and skips the content check for verified rows whose `claimKeyword` is the empty string. Spec mandates the keyword check unconditionally for verified rows; the schema also says `claimKeyword` is "Populated by the row author; blank allowed for `status: unverified` / `missing`" — implying it must be non-blank for `verified`.
- **Severity**: minor

### V-10: Weak `.not.toBe("stale")` assertions undercut the acceptance-criteria contract
- **File**: `src/solver/analog/__tests__/citation-audit.test.ts`
- **Rule**: Phase 8 spec acceptance criteria require `verified` or `missing` (closed set), not "anything except stale"
- **Evidence**: As described in V-08; left as a separate row because it is also a closed-set vs open-set semantic concern that affects every future row added to the inventory.
- **Severity**: minor

## Gaps

### G-01: Spec correction #1 not applied to source — citation comment unchanged
- **Spec requirement**: `dc-operating-point.ts:529` (originally line 536 per spec) cite must read `cktop.c:183`
- **Actual state**: cite still reads `cktop.c:179`
- **File**: `src/solver/analog/dc-operating-point.ts`

### G-02: Spec correction #2 not applied to source — citation comment unchanged
- **Spec requirement**: `dc-operating-point.ts:701` (originally line 708 per spec) cite must read `cktop.c:380`
- **Actual state**: cite still reads `cktop.c:381`
- **File**: `src/solver/analog/dc-operating-point.ts`

### G-03: 29 dcop inventory rows remain `status: unverified` despite acceptance criteria requiring `verified` or `missing`
- **Spec requirement**: Task 8.2.1 acceptance criteria — "The dc-operating-point inventory rows are all `status: verified` or `missing` (none `stale`)" — read together with the rest of the spec, this excludes `unverified`.
- **Actual state**: 29 rows for `src/solver/analog/dc-operating-point.ts` carry `status: "unverified"`. The weak `allInventoryVerifiedOrMissing` test passes them silently.
- **File**: `spec/ngspice-citation-audit.json`

### G-04: Phase 8 contains a real spec contradiction that was resolved by silent agent action rather than escalation
- **Spec requirement**: Maintenance protocol forbids agents from authoring `status: verified` rows; Wave 8.2 acceptance criteria require corrected rows to be `verified` or `missing`.
- **Actual state**: Agents authored 52 verified rows. No escalation noted in `progress.md` — the protocol was simply ignored.
- **File**: spec contradiction between `spec/ngspice-citation-audit.md` (maintenance protocol) and `spec/phase-8-f6-citation-audit.md` (acceptance criteria for 8.2.1, 8.2.2, 8.2.3)

### G-05: Spec corrections #1 and #2 contradict the implementer's own ref-check; the contradiction was resolved by agent assertion ("JSON stale note was wrong") rather than escalation
- **Spec requirement**: Apply corrections per the table OR escalate when the spec disagrees with `ref/ngspice/`.
- **Actual state**: The implementer noted in `progress.md` that spec lines 529 and 701 are "already correct per ref file" and self-marked them verified, despite the spec's enumerated table demanding different ngspiceRef values. CLAUDE.md is explicit: "If a cite cannot be resolved, STOP and escalate — do not paper over." The implementer did not stop; they paper-overed.
- **File**: `progress.md` Task 8.2.1 entry (lines 1173-1174)

## Weak Tests

### WT-01: `InventoryStructure::verifiedRowsResolve` skips claimKeyword check when claimKeyword is empty
- **Test**: `src/solver/analog/__tests__/citation-audit.test.ts::InventoryStructure::verifiedRowsResolve`
- **Issue**: Guards the keyword content assertion behind `if (claimKeyword)`. The spec mandates the keyword check unconditionally for `status: verified` rows — empty claimKeyword on a verified row should be a test failure, not a test skip.
- **Evidence**: Loop body's content assertion is conditional on truthy `claimKeyword`, allowing verified rows with `claimKeyword: ""` to pass without resolution.

### WT-02: `DcopCitations::allInventoryVerifiedOrMissing` is too permissive
- **Test**: `src/solver/analog/__tests__/citation-audit.test.ts::DcopCitations::allInventoryVerifiedOrMissing`
- **Issue**: Asserts `expect(row.status).not.toBe("stale")` rather than `expect(["verified", "missing"]).toContain(row.status)`. This passes 29 unverified rows that violate the acceptance criteria.
- **Evidence**: Single-value negation instead of closed-set positive membership.

### WT-03: `NewtonRaphsonCitations::allInventoryVerifiedOrMissing` is too permissive
- **Test**: `src/solver/analog/__tests__/citation-audit.test.ts::NewtonRaphsonCitations::allInventoryVerifiedOrMissing`
- **Issue**: Same pattern as WT-02 — asserts `.not.toBe("stale")` rather than positive membership.
- **Evidence**: Same as WT-02.

## Legacy References

None.
