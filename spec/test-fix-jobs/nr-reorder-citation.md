# NR reorder E_SINGULAR retry citation drift

## Problem

`src/solver/analog/__tests__/phase-3-nr-reorder.test.ts`, in
`describe("Task 3.1.2 — non-top-of-loop forceReorder citations")`, asserts
that the file `newton-raphson.ts` contains the literal string
`"niiter.c:888-891"` within 10 lines preceding the E_SINGULAR retry's
`solver.forceReorder()` call. The assertion currently evaluates
`expect(foundCitation).toBe(true)` to `false` because the production file's
nearest citation literal in that window is `"niiter.c:881-902"` (block-level)
— `:888-891` does not appear at all.

This is a hard-coded citation-string contract between test and production. No
behaviour, signature, or stamp depends on it. Either the test's literal is
stale (was authored against an earlier draft of the production comment) or
the production comment drifted away from a previously-asserted literal. Both
are cite-string drift, not algorithmic divergence.

## Sites

### Test
- `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts:246-277` —
  `it("cites niiter.c:888-891 at the E_SINGULAR retry", ...)`.
- The test's search window: 10 lines preceding any `solver.forceReorder()`
  call whose preceding 10-line context includes `lastFactorWalkedReorder`
  or `!factorResult` (lines 263–264). This is the E_SINGULAR retry block,
  not the loop-top gate.

### Production
- `src/solver/analog/newton-raphson.ts:434-447` — the E_SINGULAR retry
  block. The relevant lines:

  ```ts
  // H2 (Phase 2.5 W2.2) — mirror niiter.c:881-902 in full.
  //
  // The else arm of `if (NISHOULDREORDER)` calls SMPluFac (the reuse
  // path) and on `error == E_SINGULAR` sets NISHOULDREORDER and
  // `continue`s. ...
  if (errorCode === spSINGULAR && !solver.lastFactorWalkedReorder) {
    solver.forceReorder();
    continue;
  }
  ```

  The block-level citation is `niiter.c:881-902` (line 434). The narrower
  `niiter.c:883-884` cite for `SMPluFac` is at line 431. Neither matches
  the test's hard-coded `niiter.c:888-891`.

- The earlier loop-top citation reference in production includes a different
  anchor, `niiter.c:856-859` (line 410), which `Task 3.1.1`'s sibling test
  asserts on and which currently passes — confirming the citation
  infrastructure works; only the E_SINGULAR retry literal is out of sync.

## Verified ngspice citation

Opened `ref/ngspice/src/maths/ni/niiter.c` and read the SMPluFac + E_SINGULAR
retry block at lines 883–905 verbatim:

```c
            } else {
                startTime = SPfrontEnd->IFseconds();
                error=SMPluFac(ckt->CKTmatrix,ckt->CKTpivotAbsTol,
                               ckt->CKTdiagGmin);
                ckt->CKTstat->STATdecompTime +=
                    SPfrontEnd->IFseconds() - startTime;
                if(error) {
                    if( error == E_SINGULAR ) {
                        ckt->CKTniState |= NISHOULDREORDER;
                        DEBUGMSG(" forced reordering....\n");
                        continue;
                    }
                    /*CKTload(ckt);*/
                    /*SMPprint(ckt->CKTmatrix,stdout);*/
                    /* seems to be singular - pass the bad news up */
                    ckt->CKTstat->STATnumIter += iterno;
#ifdef STEPDEBUG
                    printf("lufac returned error \n");
#endif
                    FREE(OldCKTstate0);
                    return(error);
                }
            }
```

Mapped lines:

| ngspice line | content |
|---|---|
| 884 | `startTime = SPfrontEnd->IFseconds();` |
| 885 | `error=SMPluFac(ckt->CKTmatrix,ckt->CKTpivotAbsTol,` |
| 886 | `               ckt->CKTdiagGmin);` |
| 887 | `ckt->CKTstat->STATdecompTime +=` |
| 888 | `    SPfrontEnd->IFseconds() - startTime;` |
| 889 | `if(error) {` |
| 890 | `    if( error == E_SINGULAR ) {` |
| 891 | `        ckt->CKTniState \|= NISHOULDREORDER;` |
| 892 | `        DEBUGMSG(" forced reordering....\n");` |
| 893 | `        continue;` |
| 894 | `    }` |

The actual E_SINGULAR retry that production mirrors is **`niiter.c:889-894`**
(the outer `if(error)` opens at 889 and the retry's closing `}` is at 894),
or more narrowly **`niiter.c:890-894`** (the inner `if (error == E_SINGULAR)`
block that sets `NISHOULDREORDER` and `continue`s).

The test's asserted literal `niiter.c:888-891` covers:
- Line 888: a timing-accumulator carry (`SPfrontEnd->IFseconds() - startTime`)
- Line 889: outer `if(error) {`
- Line 890: inner `if (error == E_SINGULAR) {`
- Line 891: `NISHOULDREORDER` set

So `:888-891` is *almost* the right window — it captures the lead-in to the
retry but stops before the `continue` at line 893 that is the actual
behavioural mirror in production. The most defensible literal is
**`niiter.c:889-894`** (full retry block, outer if to closing brace), or
**`niiter.c:890-894`** if the timing accumulator is excluded.

## Fix

The test's hard-coded literal is the source of truth (it is what the
assertion measures). The cleanest resolution is to align production's
in-source citation with what the test asserts, since:

1. The test is a citation-hygiene check — its purpose is to detect drift.
   Updating the test to match whatever production currently says would
   defeat the test's purpose.
2. Production's existing citation `niiter.c:881-902` is correct (block-level)
   but coarse. Adding the narrower retry-block citation makes the comment
   more useful, not less.
3. The narrow citation should be `niiter.c:889-894` — the actual range of
   the outer `if(error)` block that contains the E_SINGULAR retry. This is
   strictly more accurate than the test's current `:888-891`.

However, if we change production to `:889-894` we break the test (which
asserts `:888-891`). Two clean options:

### Option 1 — update test to match the most-accurate ngspice range

Edit `phase-3-nr-reorder.test.ts:246`: change the test name and the
hard-coded search literal from `niiter.c:888-891` to `niiter.c:889-894`.
Add the narrow citation `// ngspice niiter.c:889-894 — E_SINGULAR retry`
to `newton-raphson.ts` immediately above line 445 (the
`if (errorCode === spSINGULAR ...)` line) so the literal sits within the
test's 10-line search window.

### Option 2 — update test to match the literal already-implied by production

Production currently writes `niiter.c:881-902` (block-level) and
`niiter.c:883-884` (SMPluFac call). If the original brief simply meant "the
test's hard-coded literal drifted", we adopt the production literal:
change the test to assert `niiter.c:881-902`, which already exists at
newton-raphson.ts:434 and falls within the test's 10-line search window
(434 → 446 is 12 lines, slightly outside; we'd also need to either widen
the search window in the test from 10 to 15 lines or move the comment
closer).

**Recommended: Option 1.** It strengthens the citation (narrower range,
points at the actual `continue`-bearing block) and matches what the next
human reader needs in order to verify the mirror. It is two coordinated edits
(one test literal, one production comment line) but stays a pure
documentation/assertion-string change.

## Category

`contract-update` — both the test literal and the production comment are
strings used solely to assert citation hygiene. No solver behaviour, no
numerical output, no public API surface changes.

## Resolves

- `phase-3-nr-reorder.test.ts > Task 3.1.2 — non-top-of-loop forceReorder
  citations > cites niiter.c:888-891 at the E_SINGULAR retry`

1 vitest test.

(The sibling `rejects a stale niiter.c:474-499 citation anywhere in NR path`
already passes — production contains no `:474-499` literal — and is
unaffected.)

## Tensions / uncertainties

1. **The test's existing literal `:888-891` is defensibly close.** Lines
   888–891 in niiter.c are: timing carry, outer `if(error)`, inner
   `if(E_SINGULAR)`, `NISHOULDREORDER` set. That genuinely is "where the
   E_SINGULAR retry begins". The strongest argument for changing it is that
   the `continue` at line 893 is the actual control-flow mirror, and the
   test's range stops one line short. This is a doc-quality call, not a
   correctness call.

2. **Option 1 vs Option 2.** A reasonable user might prefer Option 2 (keep
   the test literal stable, update production's coarser citation to match)
   on the grounds that "tests are immovable, code is malleable." That works
   too, but requires either widening the test's 10-line search window or
   moving the `niiter.c:888-891` comment from where production might
   naturally place it (next to the SMPluFac call at line 431, where ngspice
   line 883-884 is the more accurate cite) into the 10-line window
   immediately preceding line 446. Option 1 is structurally cleaner.

3. **The test searches for *any* `solver.forceReorder()` call within 10
   lines of `lastFactorWalkedReorder` or `!factorResult`.** Newton-raphson
   only has one such call (line 446). If a future refactor introduces a
   second forceReorder site under that condition, the search will need to
   become more specific. Out of scope for this fix.

4. **No phantom citation risk.** Both the existing production literal
   (`niiter.c:881-902`) and the proposed updated literal (`niiter.c:889-894`)
   point at real, hand-verified ranges in `ref/ngspice/src/maths/ni/niiter.c`
   (file confirmed present; lines 883–905 quoted verbatim above). This fix
   is not at risk of falling under the "phantom ngspice citations" rule —
   the ngspice line numbers cited here are read directly from the file in
   the repo.
