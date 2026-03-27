# Review Report: Wave 0 — MCP Server Modularization

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 1 (MCP server split from 1369-line monolith into 6 modules) |
| Violations | 2 |
| Gaps | 1 |
| Weak tests | 0 (no new tests in scope) |
| Legacy references | 0 |
| Verdict | **has-violations** |

## Files Reviewed

### Created
- `scripts/mcp/tool-helpers.ts` (83 lines)
- `scripts/mcp/formatters.ts` (124 lines)
- `scripts/mcp/circuit-tools.ts` (829 lines)
- `scripts/mcp/tutorial-tools.ts` (341 lines)
- `src/headless/equivalence.ts` (106 lines)

### Modified
- `scripts/circuit-mcp-server.ts` (reduced from 1368 to 63 lines)

## Violations

### V1 — Dead code: `wrapTool` exported but never used

- **File**: `scripts/mcp/tool-helpers.ts`, lines 12-40
- **Rule violated**: Code Hygiene — "All replaced or edited code is removed entirely. Scorched earth."
- **Severity**: minor
- **Evidence**: `wrapTool` is defined and exported but zero files import it:
  ```typescript
  export function wrapTool<TArgs>(
    errorPrefix: string,
    fn: (args: TArgs) => string | Promise<string>,
  ): (args: TArgs) => McpResponse | Promise<McpResponse> {
  ```
  Along with the supporting types `McpContent` and `McpResponse` on lines 13-14. This appears to be infrastructure written in anticipation of future refactoring (wrapping each tool handler to reduce boilerplate), but it was never actually applied. None of the 15 tool registrations use it — they all do their own try/catch with manual MCP response construction, identical to the original monolith.

### V2 — `equivalence.ts` not exported from headless barrel

- **File**: `src/headless/index.ts`
- **Rule violated**: Completeness — module is created in the headless package but not integrated into its public API surface
- **Severity**: minor
- **Evidence**: `src/headless/equivalence.ts` exports `testEquivalence` and `EquivalenceResult`, but `src/headless/index.ts` has no re-export for either symbol. The only consumer (`scripts/mcp/circuit-tools.ts`) imports via the direct path `../../src/headless/equivalence.js`, which works but bypasses the barrel pattern used by all other headless exports. If any future consumer imports from `src/headless/index.js`, `testEquivalence` will not be available.

## Gaps

### G1 — Behavioral difference in equivalence "too many bits" error path

- **Spec requirement**: Extract equivalence logic into `src/headless/equivalence.ts` as a pure function with no behavioral changes.
- **What was found**: The original monolith (line ~1270) returned an `isError` MCP response directly when `totalBits > limit`:
  ```typescript
  return {
    content: [{ type: "text" as const,
      text: `Total input bits (${totalBits}) exceeds limit (${limit}). ...` }],
    isError: true,
  };
  ```
  The extracted `testEquivalence()` function (equivalence.ts line 54-59) instead throws an Error:
  ```typescript
  throw new Error(
    `Total input bits (${totalBits}) exceeds limit (${limit}). ` +
      `Exhaustive equivalence testing is impractical. Use test vectors instead.`,
  );
  ```
  This throw is caught by the `circuit_test_equivalence` tool handler's catch block (circuit-tools.ts line 816-826), which wraps it into an `isError` MCP response with prefix `"Equivalence test error: "`. So the user sees: `"Equivalence test error: Total input bits (X) exceeds limit (Y). ..."` instead of the original `"Total input bits (X) exceeds limit (Y). ..."`.
- **Impact**: The error message text seen by MCP clients gains a `"Equivalence test error: "` prefix that was not present in the original. This is a minor behavioral difference in error formatting but does not affect correctness.
- **File**: `src/headless/equivalence.ts` line 54, `scripts/mcp/circuit-tools.ts` line 816

## Weak Tests

None found. No new test files were created as part of this modularization.

## Legacy References

None found. No comments containing "workaround", "temporary", "for now", "legacy", "backwards compatible", "previously", "migrated from", "replaced", "fallback", or "shim" were found in any of the new files.

## Detailed Behavioral Comparison

The following critical logic sections were compared line-by-line against the original monolith (`git show HEAD~1:scripts/circuit-mcp-server.ts`):

### circuit_patch subcircuit auto-registration
The on-demand `.dig` subcircuit loading logic (circuit-tools.ts lines 377-398) is functionally identical to the original (monolith lines ~545-570). The only difference is `makeNodeResolver(sourceDir)` replacing `new NodeResolver(sourceDir + "/", ...)` — `makeNodeResolver` constructs the identical object.

### tutorial_create multi-step flow
The full 5-step tutorial creation flow (tutorial-tools.ts lines 160-339) is functionally identical to the original (monolith lines ~1060-1200). Key verifications:
- Manifest validation with early error return: identical
- Goal circuit build + session storage: `session.store(goalCircuit)` replaces `nextHandle()` + `circuits.set()` — equivalent
- Test vector verification against goal circuit: identical
- Start circuit build and save: identical
- Palette resolution: identical
- `tutorials/index.json` upsert: `resolve("tutorials/index.json")` replaces `resolvePath("tutorials/index.json")` — both are `path.resolve`, equivalent
- Warning output: identical

### SessionState thread safety
`SessionState` (tool-helpers.ts lines 58-83) uses a simple `Map` and incrementing counter, identical to the original module-level `circuits` Map and `handleCounter`. Since the MCP server is single-threaded (Node.js event loop), there are no thread safety concerns. The state is correctly scoped to a single session instance shared across all tools.

### MCP response shape preservation
All 15 tool registrations produce `{ content: [{ type: "text", text: ... }], isError?: true }` responses identical to the original. The `isError: true as const` vs `isError: true` difference is a TypeScript type narrowing detail with no runtime effect.

### Import path integrity
All imports resolve correctly:
- `scripts/mcp/*.ts` files use `../../src/...` relative paths to reach source modules
- `scripts/circuit-mcp-server.ts` uses `./mcp/...` relative paths to reach the new modules
- `src/headless/equivalence.ts` uses `../core/...` and `./...` relative paths consistent with other headless modules
