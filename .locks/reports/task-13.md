Deleted `cac.statePool.analysisMode = "tran";` at former line 1193 in `_seedFromDcop`.
Deleted the `refreshElementRefs(...)` call and its preceding "defensive resync" comment block (7 lines).
`_seedFromDcop` now contains exactly the 3-statement port of dctran.c:346-350: cktMode assignment, ag[0]/ag[1] zero, states[1].set(states[0]).
