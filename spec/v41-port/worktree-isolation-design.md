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

## IMPLEMENTED 2026-06-01 — Option A, src-only worktree (+ main bookkeeping)

Three repo-structure facts ruled out a self-contained worktree checkout: `spec/v41-port/` is gitignored
(only 6 force-tracked files), `build-ledger.mjs` resolves its inputs via `import.meta.url` (operates on the
tree it physically lives in), and `ref/ngspice` is a submodule (a worktree does not populate it). So the
chosen model isolates ONLY `src/` in the worktree; specs/diffDocs/`ref/ngspice`/DLL are read from MAIN, and
ledger bookkeeping (`build-ledger` + `ledger.json`/`.md`) runs in MAIN after a successful merge.

Foundation (committed `f3fc5d08`): `mcp-wrapper.mjs` reads `.mcp-active-tree` for the child cwd. Validated
end-to-end (repoint round-trip main→worktree→main proven; junction lifecycle safe, node_modules intact).

Driver (`workflows/v41-port-loop.workflow.mjs`, untracked tooling): per unit — `setupWorktreePrompt`
(`git worktree add` from `${BRANCH}` + junction node_modules + write `.mcp-active-tree` + `server_restart`);
the recon/applier/verifier/gate agents carry `wtPreamble` (edit `src/` ONLY under `${WT}`, read refs from
`${MAIN}`, MCP gates `${WT}`, commit src+progress.json in the worktree, no build-ledger); `teardownWorktreePrompt`
(compile-gate the worktree, ff-merge `wt/<unit>`→`${BRANCH}`, regenerate the ledger in MAIN, device-complete
marker, junction-safe destroy). The per-unit body is wrapped in try/finally so teardown always runs.

The four guards: (1) preflight CLEAN-MAIN gate — abort if main `src/` is dirty (merges need it); (2) verifier
EMPTY-DIFF catch — `git -C WT diff` empty ⇒ the edit leaked to MAIN ⇒ MISMATCH+retry; (3) teardown
MAIN-SRC-CLEAN check — a stray uncommitted `src/` change in MAIN ⇒ capture + HALT the run; (4) preflight
junction-safe STALE-WORKTREE SWEEP. Residual hazard: soft isolation (overlapping `src/` + absolute-path tools)
— detected, not hard-prevented; inherent to the workflow-agent model, same in any design.

Status: A2 VALIDATED end-to-end (2026-06-01). First live run (`maths-misc`/randnumb) exercised the full
pipeline — worktree setup → repoint → recon build → isomorphism + self-compare gate → ff-merge → ledger
refresh — and landed `maths-misc#recon/randnumb` APPLIED on `v41-port` (`e5ab98cc`). The orchestration works.

## INCIDENT + FIX (2026-06-01) — `cmd /c` no-ops in the agent shell → node_modules deletion

The first run's TEARDOWN destroyed the main `node_modules`. Root cause: the teardown removed the worktree's
node_modules junction with `cmd /c rmdir "<path>\node_modules"`, but **`cmd /c <cmd>` SILENTLY NO-OPS in the
workflow agent's bash shell** (it printed the interactive banner and returned without running the argument —
unlike my PowerShell smoke test, which is why the smoke test gave false confidence). The junction therefore
survived into `git -C MAIN worktree remove --force`, which traversed the LIVE junction and deleted real files
out of `MAIN/node_modules` (246 → 110). Recovery: the MCP server held `koffi.node` open (ngspice FFI), so
`npm ci` EPERM'd — `server_restart` took the MCP down (the respawn can't load the wiped `tsx`, so per
`mcp-wrapper.mjs` the wrapper shuts down on exit ≠ 120), releasing `koffi.node`; then `npm ci` restored it.
(`server_reset` would NOT have worked — it keeps the process alive, so the loaded koffi addon stays locked.)

THE FIX (hazard class eliminated): **no junction is ever created.** The worktree lives at `.wt/<unit>` INSIDE
the main checkout, so Node resolves `node_modules` by walking UP to `MAIN/node_modules` — the worktree needs
none of its own. With no junction: setup just `git worktree add` + verifies upward resolution
(`node -e "require.resolve('typescript')"`); teardown's `git worktree remove` has nothing to traverse; a
positive guard asserts `<WT>/node_modules` is `absent` (and halts if a real one appears) before removal +
re-checks the MAIN count is unchanged after. Every `cmd /c` is purged from the driver (banned — it no-ops
here); the only sanctioned link-removal is Node `fs` (lstat-guarded, link-only), used solely by the stale
sweep for legacy strays. Per-run recovery if it ever recurs: `server_restart` (NOT reset) → `npm ci` → `/mcp`
reconnect.

Next: re-run `maths-misc` is unnecessary (randnumb already landed); the next loop unit is `nodeset-ic` (its
harness input surface + fixtures are committed at `865aeb96`), now safe to run under the no-junction driver.
