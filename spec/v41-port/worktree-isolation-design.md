# Port-loop worktree isolation — design requirements (2026-06-01)

**Why.** On 2026-06-01 an escalated (never-verified) `nodeAllocOrder` recon build was left
uncommitted in the *shared live working tree*. It had wired a fail-fast guard into the registry/
compile path; with the deck-pin table half-reconciled, the guard threw at registry build → the
circuit-simulator MCP died on startup (`-32000`). Root flaw: **the loop shares one working tree with
the live MCP and never cleans up a failed attempt.** The two-hop separation assumed "uncommitted =
inert"; that is false for any recon touching a hot path (compile, registry, load).

**Fix:** every port-loop unit builds in an isolated git worktree; the live tree is only ever
fast-forwarded by *verified* work.

## Requirements

1. **Spawn from the integration base.** Each unit's applier+verifier run in a fresh worktree spawned
   from the integration branch (today `v41-port`; per the 2026-06-01 decision, **make the integration
   base = `main`** so worktrees inherit all prior applied units). The base must already contain every
   previously-completed unit.

2. **Commit/push to the base on success — this is mandatory.** When a unit passes the merge-gate
   (below), its commits land on the integration base **before the next unit's worktree is spawned**,
   because worktrees are spawned from that base. A unit that completes but isn't pushed back would be
   invisible to the next worktree → re-work / divergence. (User directive, 2026-06-01.)

3. **Merge-gate — a worktree merges back ONLY if all hold:**
   - `tsc`/typecheck green,
   - the registry **builds** (the server boots; `register-all.ts` audits pass — no startup throw),
   - the unit's **harness gate** passes (`firstDivergence` null on its manifest fixtures).
   Anything short of all three → do NOT merge.

4. **On failure: capture, then destroy.** Capture the worktree's diff as a patch file
   (`spec/v41-port/failed/<unit>-<runid>.diff`, kilobytes–megabytes) plus the escalation report, then
   **delete the worktree.** Keep *patches*, never parked worktrees — 100 failures = 100 small patches
   (MBs), not 100 full checkouts (GBs). No filesystem bloat.

5. **Junction-safe teardown (hard-won hazard).** A naive `rm -rf` of a worktree has previously
   followed the `node_modules` *junction* and deleted the real `node_modules`, killing the MCP. The
   worktree must share `node_modules` safely (symlink/junction that is NOT recursively removed on
   teardown); teardown removes only the worktree's own tracked files. See the
   `reference_worktree_node_modules_hazard` note.

6. **Live MCP never reads an unverified tree.** The MCP/server runs against the integration base only.
   A failed build can never poison it because it lives in a throwaway worktree.

## Secondary guard (independent of isolation)
Fail-fast asserts that run on the compile/registry path should **warn, not throw** (a table-coverage
gap is a developer signal, not a reason to brick every compile). The hard self-consistency check that
runs once at registry build (`auditNgspiceLoadOrderTables`) may stay a throw — it can only be tripped
by developer-authored static-table edits, never by a user circuit, and failing loudly at startup is
the right place. (Applied 2026-06-01: `auditDeckPinOrderCoverage` → warn; `auditNgspiceLoadOrderTables`
left as a startup throw, data reconciled so it passes.)

Status: REQUIREMENTS — not yet implemented. The port-loop driver
(`workflows/v41-port-loop.workflow.mjs`) currently runs all units serially in the shared tree.

## Implementation constraint discovered (2026-06-01)

The naive design above has a blocker: **the harness MCP server's repo path is fixed at launch.**
`scripts/mcp-wrapper.mjs:38-42` spawns the server child with `cwd: process.cwd()`, and `server_restart`
just respawns in that same cwd — there is no env/arg/symlink to point it at a different checkout. So the
harness gate ALWAYS runs against the one tree Claude Code launched the MCP in. A unit built in a separate
worktree can't be gated there, and a non-compiling build merged to the base before gating would crash the
MCP on the next `server_restart` (exactly the 2026-06-01 failure). And the no-discard hook blocks in-place
revert (`git checkout <path>`, `git reset --hard`, `git stash`), so "build in main, revert on fail" is not
hook-compatible. **Conclusion: real isolation requires the MCP server's tree to be REPOINTABLE.**

Two viable architectures:

- **A — Repointable-MCP worktree isolation (the full fix).** Modify `mcp-wrapper.mjs` to read its child
  `cwd` from a mutable source (an env var or a `.mcp-active-tree` file it reads on each (re)spawn). The
  loop, per unit: `git worktree add` from the base (node_modules shared junction-safe), repoint the MCP at
  the worktree, `server_restart`, run applier/verifier/gate there; on PASS merge→base + repoint back; on
  FAIL capture diff + `git worktree remove` + repoint back. The base (and the human's live MCP) never sees
  an unverified tree. Cost: a wrapper change + worktree lifecycle + Windows junction handling + testing the
  repoint without breaking the live server.

- **B — Pre-restart compile-guard (lightweight interim, hook-compatible).** No worktrees. Before every
  `server_restart`/gate, the loop runs a fast compile/registry-build check (`vitest run` the load-order
  audit + a compile test, or `tsc --noEmit`). If it fails, the loop does NOT restart — it HALTS the run and
  reports (captures the diff), leaving cleanup to the human (per the hook rule). This does not auto-isolate
  failed edits, but it converts the silent MCP-bricking crash into a clean halt + diagnostic. Combined with
  the warn-not-throw guard (done), it removes the crash class cheaply while A is built.

Recommendation: ship B now (cheap, removes the crash class), build A deliberately as the real isolation.
