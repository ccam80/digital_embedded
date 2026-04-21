D-14: inductor.test.ts already has `expect(stamps.length).toBe(5)` at line 180 and the correct comment at lines 176-179 describing the unconditional -req branch diagonal stamp per indload.c:119-123.
Verification: `toBe(4)` → 0 hits, `toBe(5)` → 1 hit in the stamps_branch_equation test body. No edit required.
