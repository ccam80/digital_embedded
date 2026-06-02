export const meta = {
  name: 'v41-port-loop-parallel',
  description: 'Parallel-A driver for the ngspice v26->v41 port. Component units build + isomorphism-verify CONCURRENTLY in isolated git worktrees (MCP-free phases), then a SERIAL gate+merge stage rebases each branch onto the advancing v41-port HEAD, runs the single harness MCP gate one unit at a time, and ff-merges. Build/verify is the long pole and parallelises; the gate+merge is serialised because the harness MCP is a single repointable server. Decision-1 (driver-layer hunks: debug/C-data-format OUT, behavioral/mode-flag PORT-into-equivalent-method) is encoded as DRIVER_LAYER_RULE.',
  phases: [
    { title: 'Scout', detail: 'one agent reads ledger.json + gate-manifest.md -> ordered units; parallel-eligible component units (disjoint tsFile scopes) are the batch' },
    { title: 'Setup', detail: 'preflight: clean main src/, junction-safe sweep of stale .wt/*, ensure v41-port branch' },
    { title: 'BuildVerify', detail: 'PARALLEL: per unit, git worktree add (no MCP), recon-build, apply (<=3 rounds), isomorphism-only verify + per-group commit in the worktree — NO harness gate here' },
    { title: 'GateMerge', detail: 'SERIAL: per isomorphic unit, rebase wt onto current v41-port HEAD, compile-gate, repoint MCP + harness gate, ff-merge + ledger refresh on pass / preserve patch + escalate on fail, junction-safe teardown' },
  ],
}

/* args (all optional):
 *   { only: [unitName,...]        limit to these units
 *   , fromTier: number            skip tiers below this (engine=-1, tier0=0,...)
 *   , maxUnits: number            hard cap on units this run
 *   , maxGroupsPerAgent: number   chunk a unit's groups per applier/verifier
 *   , concurrency: number }       max units built concurrently (default min(8, build agents)) */
const A = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args && typeof args === 'object' ? args : {})
const ONLY = Array.isArray(A.only) ? A.only : null
const FROM_TIER = Number.isInteger(A.fromTier) ? A.fromTier : -1
const MAX_UNITS = (Number.isInteger(A.maxUnits) && A.maxUnits > 0) ? A.maxUnits : 9999
const BATCH = (Number.isInteger(A.maxGroupsPerAgent) && A.maxGroupsPerAgent > 0) ? A.maxGroupsPerAgent : 9999
const CONCURRENCY = (Number.isInteger(A.concurrency) && A.concurrency > 0) ? A.concurrency : 8

const DLL = 'ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll'
const BRANCH = 'v41-port'
const COMPILE_GATE = 'node_modules/.bin/vitest run src/solver/analog/__tests__/compile-analog-partition.test.ts src/solver/analog/__tests__/compiler.test.ts'

// ---------- schemas ----------
const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['units'],
  properties: {
    units: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['name', 'kind', 'tier', 'deferred', 'recons', 'groups', 'gateFixtures', 'gateKind'],
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['engine', 'device'] },
        tier: { type: 'integer' },
        deferred: { type: 'boolean' },
        deferReason: { type: 'string' },
        recons: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['id', 'spec', 'tsFiles', 'blocks'],
          properties: { id: { type: 'string' }, spec: { type: 'string' }, tsFiles: { type: 'array', items: { type: 'string' } }, blocks: { type: 'array', items: { type: 'string' } } } } },
        groups: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['functionGroup', 'tsFile', 'mappingNote', 'hunkIds'],
          properties: { functionGroup: { type: 'string' }, tsFile: { type: 'string' }, mappingNote: { type: 'string' }, hunkIds: { type: 'array', items: { type: 'string' } } } } },
        gateFixtures: { type: 'array', items: { type: 'string' } },
        gateKind: { type: 'string', enum: ['harness', 'self-compare', 'deferred'] },
      },
    } },
  },
}
const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['mainRoot', 'cleanMainSrc', 'note'],
  properties: { mainRoot: { type: ['string', 'null'] }, cleanMainSrc: { type: 'boolean' }, dirty: { type: 'array', items: { type: 'string' } }, swept: { type: 'string' }, note: { type: 'string' } },
}
const WT_CREATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['ok', 'worktreePath'], properties: { ok: { type: 'boolean' }, worktreePath: { type: ['string', 'null'] }, note: { type: 'string' } } }
const RECON_VERDICTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'verdict', 'note'],
    properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['MATCH', 'MISMATCH', 'ESCALATE'] }, note: { type: 'string' }, committed: { type: ['string', 'null'] }, progressEntries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, hunkHash: { type: 'string' }, ref: { type: 'string' } } } } } } } },
}
const GROUP_VERDICTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['functionGroup', 'verdict', 'note'],
    properties: { functionGroup: { type: 'string' }, verdict: { type: 'string', enum: ['MATCH', 'MISMATCH', 'ESCALATE'] }, note: { type: 'string' }, committed: { type: ['string', 'null'] }, progressEntries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, hunkHash: { type: 'string' }, ref: { type: 'string' } } } } } } } },
}
const GATEMERGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['unit', 'merged', 'gatePass', 'note'],
  properties: {
    unit: { type: 'string' }, merged: { type: 'boolean' }, gatePass: { type: ['boolean', 'null'] },
    rebaseClean: { type: 'boolean' }, mainSrcClean: { type: 'boolean' }, nodeModulesIntact: { type: 'boolean' },
    halt: { type: 'boolean' }, ledgerCommitted: { type: ['string', 'null'] }, escalationsRecorded: { type: ['string', 'null'] },
    firstDivergence: { type: ['string', 'null'] }, note: { type: 'string' },
  },
}

// ---------- helpers ----------
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
function groupBlock(groups, notes) {
  return groups.map((g, i) => `  ${i + 1}. functionGroup="${g.functionGroup}"  tsFile=${g.tsFile}\n       mapping: ${g.mappingNote}\n       hunks=[${g.hunkIds.join(', ')}]${notes && notes[g.functionGroup] ? `\n       PRIOR-REJECTION: ${notes[g.functionGroup]}` : ''}`).join('\n')
}
function fileScope(groups, unit) {
  return Array.from(new Set([...groups.map((g) => g.tsFile), `rename-maps/${unit.name}.md`])).join(', ')
}

// ---------- shared scope + driver-layer rules ----------
const STRUCTURAL_SCOPE = `FILE SCOPE & DIVERGENCE HANDLING.
(1) COMPILE-FORCED EXPANSION. Edit the named tsFiles (rooted at the worktree). You MAY ALSO edit a file NOT listed ONLY when an in-scope edit will not TYPE-CHECK / COMPILE without it (adding a field to an interface forces declaring + initialising it on the implementing class and at every construction site; adding a method forces its implementers). Make the MINIMAL conformance edit — the forced declaration / init only, NO new logic.
(2) CLOSING THE GAP TO ngspice IS THE RECON'S PURPOSE. The harness / self-compare gate is the correctness check on THIS recon's port. When it diverges, classify the fix:
  - IN-SCOPE divergence — the gate is red because YOUR port is INCOMPLETE or WRONG within the recon's tsFiles + the ngspice behavior the spec's acceptance criteria cover: FIX IT. Iterate the faithful ngspice port until it is source-isomorphic AND the gate is null. A divergence living in code the recon is responsible for IS the work — "pre-existing" / "legacy path" / "I didn't change that line" / "already documented" is NEVER a valid outcome; every un-ported divergence is pre-existing, and closing it is the entire reason the recon exists. If a spec acceptance criterion names a fixture or behavior (e.g. a waveform that must gate null), making it match ngspice is in-scope, not an escalation.
  - OUT-OF-SCOPE coupling — closing the gap REQUIRES editing a file outside the recon's tsFiles beyond a compile-forced conformance edit (a genuine cross-subsystem change needing sequencing): escalate THAT item, naming the exact file + the precise edit.
  - NEVER force the gate green by a NON-ISOMORPHIC fudge (a value that matches the number but not ngspice's WHERE/HOW — banned by "structural match, not semantic") or by editing an unrelated file. That, and only that, is what "never edit to make the gate pass" forbids; it does NOT license leaving an in-scope divergence unfixed.
(3) IMPLEMENT-THEN-ESCALATE: do EVERY in-scope and compile-forced edit you CAN, FIRST; only then escalate a GENUINE remaining OUT-OF-SCOPE blocker (name the file + the precise edit). A blocked unit leaves a MAXIMAL, usable patch in the worktree, never an empty one.`
const STRUCTURAL_SCOPE_CHECK = `FILE-SCOPE + DIVERGENCE CHECK. (a) The worktree \`git diff --name-only\` MAY include files beyond the named tsFiles ONLY when each is STRUCTURALLY FORCED (does not type-check / compile without it) AND the extra edit is MINIMAL conformance (a forced declaration / init, NOT new logic) — confirm by reading the diff; a file edited to add logic, or a non-isomorphic fudge to force the gate, is over-application -> MISMATCH (name it). (b) A gate divergence on a behavior the recon's spec / acceptance criteria cover means the port is INCOMPLETE or WRONG -> MISMATCH (send it back to be FIXED). It is NEVER closeable as "pre-existing" / "legacy" / "outside the changed lines" — those are banned verdicts; every un-ported divergence is pre-existing. Escalate a gate divergence ONLY when its faithful fix provably requires a file outside the recon's scope (name it). The compile + harness gates remain the correctness arbiters.`
// Decision-1 (user ruling 2026-06-02): driver-layer hunks are incorporate-or-accept, never blanket-escalate.
const DRIVER_LAYER_RULE = `DRIVER-LAYER HUNKS (analysis / job / setup C functions digiTS reimplements as TS methods — CKTop->solveDcOperatingPoint, DCop, CKTacLoad->per-element stampAc, TRANinit/CKTsetup->MNAEngine.init/_setup, etc.). Do NOT blanket-escalate these. Classify each hunk's CONTENT:
  - DEBUG output, or C-SPECIFIC DATA FORMATS (debugger externs, #include regions, pointer-style/whitespace cosmetics, XSPICE #ifdef blocks, file-header narrative): OUT — accept as divergence, do NOT port, note it and move on. These have no digiTS counterpart by design.
  - FLAG-SETTING / MODE-FLAG / behavioral config that digiTS's equivalent method DOES implement (e.g. dcop.c firstmode = (CKTmode&MODEUIC)|MODEDCOP|MODEINITJCT; parameter-setting in TRANsetParm/ACsetParm that changes solver behavior): PORT THE BEHAVIOR into the equivalent digiTS method (the hunk's tsFunction target). This is IN-SCOPE work, NOT an escalation — match the behavior, cite the ngspice line.
Escalate a driver-layer hunk ONLY when it is neither of the above (a genuine cross-group architecture change needing sequencing approval).`

function buildPreamble(WT, MAIN) {
  return `WORKTREE ISOLATION (build/verify phase — the harness MCP is NOT pointed here; do not call any harness_*/server_* tool in this phase).
- EDIT TARGET: the isolated worktree at ${WT}. EVERY src/** file you Read/Edit/Write and EVERY git command MUST be rooted there (absolute ${WT}/src/..., \`git -C ${WT} ...\`). NEVER touch ${MAIN}/src/**.
- READ-ONLY REFERENCES from MAIN (absent in the worktree): ngspice C source ${MAIN}/ref/ngspice/**, the recon specs / diffDocs under ${MAIN}/spec/v41-port/.
- LEDGER + PROGRESS: do NOT run build-ledger.mjs, do NOT edit ledger.json/.md, and do NOT edit or commit progress.json in the worktree. Commit ONLY src/** tsFiles. The serial GateMerge stage is the SINGLE writer of MAIN's progress.json (it records APPLIED after the merge) — this is precisely why worktree branches never rebase-conflict on progress.json.
- PRIOR KEPT WORK: if \`git -C ${WT} diff\` is NON-EMPTY when you start, a previous attempt's patch was resumed into this worktree at setup — it is prior implementation of THIS unit and is your STARTING POINT. Keep what is correct, complete what is missing, fix what is wrong; do NOT discard it and rebuild from scratch. The verifier re-derives isomorphism over the FINAL result regardless of origin, so correctness still gates.`
}
function gateClause(unit, WT, MAIN) {
  if (unit.gateKind === 'self-compare') {
    return `run the recon's reproducibility test(s) in the worktree — \`cd ${WT} && node_modules/.bin/vitest run ${unit.gateFixtures.join(' ')}\` — PASS only if EVERY test passes. The test IS the gate.`
  }
  return `call server_restart (the MCP is now pointed at ${WT}). For EACH fixture in [${unit.gateFixtures.join(', ')}]: (a) if the .dts does NOT yet exist under ${WT} (a from-scratch device class whose gate fixture is authored WITH its recon), author it now against the freshly-built class — use the MCP circuit tools (\`circuit_build\` a minimal but EXERCISING circuit: a DC bias that turns the device on, a transient ramp, and for an AC-capable device a small-signal sweep; ONLY the device-under-test plus lower-tier VERIFIED components; a DC path to ground), \`circuit_compile\` to confirm zero diagnostics, \`circuit_save\` to the fixture path under ${WT}, then \`git -C ${WT} add\` the .dts + \`git -C ${WT} commit -m "v41-port(${unit.name}): gate fixture"\` so the ff-merge carries it; (b) harness_start (dllPath ${MAIN}/${DLL}) -> harness_run (DC-OP + transient; harness_run_ac for *-ac) -> harness_first_divergence. PASS only if firstDivergence is null across ALL classes on ALL fixtures.`
}

// ---------- prompts ----------
function scoutPrompt() {
  return `You are the SCOUT for the ngspice v26->v41 PARALLEL port-loop. Read in full: spec/v41-port/gate-manifest.md and spec/v41-port/ledger.json.
LEDGER FIELDS: a hunk's digiTS target is its \`tsFunction\` (prose starting with a src/*.ts path); tsFunction:null is UNMAPPED (do not emit). Reconstruction items carry \`tsFiles\` (an ARRAY — often several files), \`spec\`, \`blocks\`.
Produce the ORDERED plan (engine tier -1 first, then device tiers 0..3 per gate-manifest.md). Per unit: name, kind, tier; deferred=true+deferReason for: parser card-reader/expression/model groups (except parser#recon/nodeAllocOrder which is APPLIED), any unit with an unmapped PENDING hunk, any unit with a specExists:false recon, manifest-deferred units (csw internalOnly; asrc — blocked on the shared expression-engine PORT #10/#19), and zero-PENDING-work units. EMIT the from-scratch device classes jfet2 / mes / mos3 — each has a specExists:true wholeClass recon and a now-RUNNABLE harness gate whose .dts the GateMerge stage authors against the freshly-built class (gate-manifest.md, 2026-06-03); they are NO LONGER deferred. (mos3's hunks are mapped in planning/mos3-decisions.json; if you still find an unmapped PENDING mos3 hunk, that classification has not landed — defer mos3 and say so.)
MUST-EMIT: a unit is PORTABLE if it has >=1 PENDING OR STALE reconstruction (specExists:true) OR >=1 emittable mapped group (>=1 PENDING OR STALE hunk).
- recons: each PENDING OR STALE reconstruction (specExists:true) — id, spec, tsFiles, blocks[]. Copy the ledger's \`tsFiles\` ARRAY VERBATIM AND IN FULL; the machine-derived ledger is authoritative — do NOT narrow it based on spec prose. A STALE recon was APPLIED then baseline-invalidated; emit it for a CHEAP RE-VERIFY (re-confirm the existing code is still bijective to v41 -> re-record APPLIED), NOT a re-port.
- groups: every functionGroup whose hunks are ALL mapped, >=1 PENDING OR STALE, source order; include groups blocked only by THIS unit's recons; exclude groups blocked by another unit's recon.
- gateFixtures + gateKind from gate-manifest.md VERBATIM.
Edit nothing. Return ONLY the structured plan.`
}
function setupPrompt() {
  return `Ensure the git working tree is on a \`${BRANCH}\` branch. If it exists, switch to it; else create it from HEAD. NEVER run on main. Do NOT stash/reset/checkout-discard/delete; if dirty in a blocking way, STOP and report. Report branch + HEAD short-hash.`
}
function preflightPrompt() {
  return `PREFLIGHT for the parallel port-loop. Do all, then return structured:
1. mainRoot = \`git rev-parse --show-toplevel\`.
2. CLEAN-MAIN GATE: \`git status --porcelain -- src/\`. Any uncommitted src/ change => cleanMainSrc=false + list in \`dirty\` (the loop cannot run). Else true.
3. STALE-WORKTREE SWEEP: for each \`.wt/*\`: a \`<path>/node_modules\` that is a SYMLINK/junction is a leftover — remove the LINK ONLY via Node (\`node -e "const fs=require('fs'),p=process.argv[1];try{const s=fs.lstatSync(p);if(s.isSymbolicLink())fs.rmSync(p);else fs.rmSync(p,{recursive:true,force:true});}catch(e){}" "<path>/node_modules"\`; a REAL local dir there is just a vitest .vite cache, safe to fs.rmSync recursively — NEVER \`cmd /c rmdir\`/\`rm -rf\`). Then \`git worktree remove --force <path>\`, \`git branch -D wt/*\`, \`git worktree prune\`, remove a stale \`.mcp-active-tree\`. Summarize in \`swept\`.
Edit no source.`
}

function worktreeCreatePrompt(unit, MAIN) {
  const wt = `${MAIN}/.wt/${unit.name}`
  return `WORKTREE-CREATE for unit "${unit.name}" (parallel build phase — NO MCP repoint here; the gate stage repoints later). Work in MAIN ${MAIN}. NEVER use \`cmd /c\` (it silently no-ops here).
1. If a stale \`wt/${unit.name}\` branch or \`.wt/${unit.name}\` worktree exists, remove it (link-safe via Node as in preflight; \`git worktree remove --force\`; \`git branch -D\`; \`git worktree prune\` — ignore not-found).
2. \`git worktree add .wt/${unit.name} -b wt/${unit.name} ${BRANCH}\` — branch from current ${BRANCH} HEAD, at \`${wt}\` (INSIDE main, so node resolves node_modules upward — NO junction is created).
2b. RESUME FROM KEPT PATCH: if \`${MAIN}/.wt-failed/${unit.name}.diff\` exists, test \`git -C ${wt} apply --check "${MAIN}/.wt-failed/${unit.name}.diff"\`. If it applies cleanly, run \`git -C ${wt} apply "${MAIN}/.wt-failed/${unit.name}.diff"\` — this restores a prior attempt's kept implementation so the builder COMPLETES/FIXES it instead of rebuilding from scratch (much cheaper, reuses the prior token spend). If --check FAILS (the patch is stale vs current ${BRANCH} HEAD), do NOT force it: skip the apply and a clean rebuild proceeds. Either way continue; state resumedFromPatch true/false in the note.
3. VERIFY upward resolution: \`cd ${wt} && node -e "require.resolve('typescript')"\` must succeed. If not, return ok=false.
Do NOT write .mcp-active-tree and do NOT call server_restart in this phase. Return ok + worktreePath.`
}
function reconBuildPrompt(unit, WT, MAIN) {
  const list = unit.recons.map((r) => `  - ${r.id}: spec ${r.spec}; tsFiles [${r.tsFiles.join(', ')}]; blocks [${r.blocks.join(', ')}]`).join('\n')
  return `${buildPreamble(WT, MAIN)}

You are the RECONSTRUCTION BUILDER for unit "${unit.name}". Contract: ${MAIN}/spec/v41-port/TASK.md. Build ALL recons in order (each rebuilds the v26 baseline so its blocked v41 hunks then apply as deltas). Specs read from ${MAIN}/<spec>; tsFiles edited at ${WT}/<tsFile>:
${list}
SPEC-PRESENCE HARD GATE (per recon, first): read ${MAIN}/<spec>; if absent, ESCALATE "missing-spec" and build nothing for it.
${STRUCTURAL_SCOPE}
${DRIVER_LAYER_RULE}
Match ngspice exactly (SPICE-correct; no pragmatic shortcuts). Write NOTHING to progress.json and DO NOT commit (the isomorphism verifier records + commits).`
}
function applierPrompt(unit, groups, round, notes, WT, MAIN) {
  return `${buildPreamble(WT, MAIN)}

You are the APPLIER for unit "${unit.name}". Contract: ${MAIN}/spec/v41-port/TASK.md. Port these functionGroups IN ORDER (tsFile paths repo-relative — edit at ${WT}/<tsFile>):
${groupBlock(groups, notes)}
Named files for these groups: ${fileScope(groups, unit)} (rooted at ${WT}).
${STRUCTURAL_SCOPE}
${DRIVER_LAYER_RULE}
Per hunk: read it from ${MAIN}/<diffDoc>, read the v41 ngspice fn from ${MAIN}/ref/ngspice/, read our TS at ${WT}/<tsFile>; pre-image check; APPLY (Edit ${WT}/<tsFile>) line-isomorphic to the ngspice hunk (modulo identifier rename + C<->TS syntax). Write NOTHING to progress.json and DO NOT commit.${round > 1 ? ` ROUND ${round}: groups carrying PRIOR-REJECTION were rejected last round — fix THAT divergence; do not resubmit the same edit.` : ''}`
}
function isoReconVerifyPrompt(unit, WT, MAIN) {
  const list = unit.recons.map((r) => `  - ${r.id}: spec ${r.spec}; tsFiles [${r.tsFiles.join(', ')}]`).join('\n')
  return `${buildPreamble(WT, MAIN)}

You are the RECON ISOMORPHISM VERIFIER for unit "${unit.name}", a SEPARATE CONTEXT from the builder. Contract: ${MAIN}/spec/v41-port/VERIFICATION.md §1a. PARALLEL phase — verify SOURCE ISOMORPHISM ONLY and commit; do NOT run any harness gate (the serial stage gates later).
${list}
SPEC-PRESENCE (per recon): read ${MAIN}/<spec>; absent -> MISMATCH "missing-spec".
APPLIED requires source isomorphic to the spec's ngspice baseline — re-derive independently from ${MAIN}/ref/ngspice (do NOT trust rename-maps).
EMPTY-DIFF / ALREADY-AT-v41: if \`git -C ${WT} diff --name-only\` is empty for a recon's tsFiles, do NOT auto-MISMATCH — Tier-2 check whether the EXISTING code is already bijectively isomorphic to the spec's v41 ngspice baseline. ALREADY-v41 (it matches) -> MATCH, committed=null, note "already at v41; v26 pre-image absent". GENUINELY ABSENT (the spec's required code is not present) -> MISMATCH "not implemented — edit did not land in ${WT}".
${STRUCTURAL_SCOPE_CHECK}
${DRIVER_LAYER_RULE}
Per recon: MATCH -> COMMIT ONLY that recon's tsFiles (\`git -C ${WT} add\` ONLY the tsFiles — NEVER progress.json, NEVER \`-A\`; message \`v41-port(${unit.name}): recon <id> isomorphic-APPLIED\`), return the commit hash in committed (null if ALREADY-v41 / no code change), AND return progressEntries=[{id:"<recon id>", hunkHash:"<this recon's hunkHash from ledger.json>", ref:"<spec path>"}]. Do NOT write progress.json — MAIN records it post-merge. MISMATCH/ESCALATE -> committed=null, progressEntries=[], precise note. Banned closing verdicts -> escalate. Return one result per recon id.`
}
function isoGroupVerifyPrompt(unit, groups, WT, MAIN) {
  return `${buildPreamble(WT, MAIN)}

You are the GROUP ISOMORPHISM VERIFIER for unit "${unit.name}", a SEPARATE CONTEXT from the applier. Contract: ${MAIN}/spec/v41-port/VERIFICATION.md. PARALLEL phase — isomorphism + commit only, NO harness gate. Verify EACH functionGroup independently:
${groupBlock(groups, null)}
EMPTY-DIFF / ALREADY-AT-v41: if a group's tsFile is unchanged, do NOT auto-MISMATCH — Tier-2 check whether the EXISTING method is already bijectively isomorphic to the fresh v41 ngspice fn. ALREADY-v41 -> MATCH, committed=null, note "already at v41; v26 pre-image absent". GENUINELY ABSENT -> MISMATCH "not implemented — edit did not land in ${WT}".
${STRUCTURAL_SCOPE_CHECK}
${DRIVER_LAYER_RULE}
Per group: Tier-1 each hunk's \`git -C ${WT} diff\` line-isomorphic to its ngspice hunk; Tier-2 the whole method bijective to the fresh v41 ngspice fn (re-derive identifiers independently).
- MATCH -> COMMIT that group separately (\`git -C ${WT} add\` ONLY its tsFile — NEVER progress.json, NEVER \`-A\`; message \`v41-port(${unit.name}/<functionGroup>): isomorphic-APPLIED [hunkIds]\`), return the commit hash in committed (null if ALREADY-v41 / no code change), AND progressEntries=[{id, hunkHash, ref:"<v41 file:line>"} for EVERY hunk in the group — each id = the hunk id, hunkHash = that hunk's hunkHash from ledger.json]. Do NOT write progress.json — MAIN records it post-merge.
- MISMATCH -> committed=null, progressEntries=[], precise note (ngspice file:line, our file:line, what differs).
- ESCALATE per §6/§6a (append ${MAIN}/spec/v41-port/ESCALATIONS.md), committed=null.
Banned closing verdicts -> escalate. Return one result per functionGroup.`
}

function gateMergeTeardownPrompt(unit, WT, MAIN, opts) {
  const entriesJson = JSON.stringify(opts.progressEntries || [])
  return `You are GATE+MERGE+TEARDOWN for unit "${unit.name}" — the SERIAL stage (you hold the single harness MCP and the v41-port merge lock for this unit). Worktree=${WT} Main=${MAIN}. isomorphic=${opts.isomorphic} committedAnything=${opts.committedAnything}. NEVER use \`cmd /c\`. Execute IN ORDER:
1. REBASE onto the advancing base: \`git -C ${WT} rebase ${BRANCH}\` (other units merged since this worktree branched). If it conflicts (two units touched the same file), \`git -C ${WT} rebase --abort\`, set rebaseClean=false, skip to step 6 (preserve+escalate "rebase conflict vs ${BRANCH}; needs manual sequencing"). Else rebaseClean=true.
${opts.isomorphic ? `2. COMPILE GATE: \`cd ${WT} && ${COMPILE_GATE}\`. FAIL -> merged=false, note "WT non-compiling post-rebase", skip to step 6.
3. HARNESS/SELF-COMPARE GATE: ${gateClause(unit, WT, MAIN)} A failure does NOT chase into other files (Decision: gate-fail -> escalate, never edit to pass). Classify a harness divergence (bit-identical matrix+RHS => load/accumulation order) for the fix-list. Set gatePass + firstDivergence.
4. (only if gatePass) MERGE + RECORD PROGRESS IN MAIN: \`git -C ${MAIN} merge --ff-only wt/${unit.name}\` (a clean ff after the rebase; a no-op "Already up to date" if the unit made no code commits — an already-at-v41 progress-only unit). If it reports a non-ff divergence, set merged=false + halt=true (concurrent advance — must not happen serially); otherwise merged=true. THEN write the APPLIED records to MAIN's progress.json — the worktrees never touch it, so MAIN is the SINGLE writer and progress.json never rebase-conflicts: for EACH entry in this list — ${entriesJson} — add or update ${MAIN}/spec/v41-port/progress.json keyed by the entry's \`id\`, MATCHING the JSON shape of the existing entries already in that file (set state "APPLIED", the entry's hunkHash, its ref, and a short verifierNotes such as "parallel iso-verify + gate clean on [${unit.gateFixtures.join(', ')}]"). THEN regenerate the ledger: \`node ${MAIN}/spec/v41-port/build-ledger.mjs\` then \`--check\` (must print OK); \`git -C ${MAIN} add -f spec/v41-port/progress.json spec/v41-port/ledger.json spec/v41-port/ledger.md\`; commit "v41-port(${unit.name}): progress + ledger — APPLIED ${(opts.progressEntries || []).length} item(s), gate clean" -> ledgerCommitted. Then \`git -C ${MAIN} commit --allow-empty -m "v41-port(${unit.name}): device complete — gate clean on [${unit.gateFixtures.join(', ')}]"\`.
5. (if gate FAILED) merged=false; the gate-fail is recorded as an escalation in step 6.` : `2.-5. (NOT isomorphic — skip compile/gate/merge/record; merged=false, gatePass=null.)`}
6. MAIN-SRC-CLEAN CHECK: \`git -C ${MAIN} status --porcelain -- src/\` must be EMPTY; if not, an edit leaked to MAIN -> \`git -C ${MAIN} diff -- src/ > ${MAIN}/.wt-failed/${unit.name}-MAINLEAK.diff\`, mainSrcClean=false + halt=true. Else mainSrcClean=true.
6b. KEPT-PATCH HYGIENE (feeds resume-from-patch): if the unit MERGED, remove any stale \`${MAIN}/.wt-failed/${unit.name}.diff\` (\`rm -f\`) — its work is now on ${BRANCH}, so a leftover patch would be wrongly resumed next run. If it did NOT merge, preserve the maximal kept work so the next run resumes from it: \`mkdir -p ${MAIN}/.wt-failed\` then \`git -C ${WT} diff ${BRANCH} -- src/ > ${MAIN}/.wt-failed/${unit.name}.diff\`.
6c. ESCALATION RECORDING (MAIN-side): for every escalation passed below + any gate failure, route by content — a NUMERICAL bug (firstDivergence / matrix cell / absDelta / step-iter / gate-fail on fixtures) -> append a new \`## FIX-NNN — <title> (blocks <source>)\` to ${MAIN}/spec/fix-list-phase-2-audit.md (read it, use the next FIX number, mirror existing entries, transcribe the note verbatim); anything else -> append to ${MAIN}/spec/v41-port/ESCALATIONS.md under \`## ${unit.name} (<date +%F>)\`. Then \`git -C ${MAIN} add -f spec/fix-list-phase-2-audit.md spec/v41-port/ESCALATIONS.md\` and commit "v41-port(${unit.name}): record escalation(s)" -> escalationsRecorded. Passed escalations: ${JSON.stringify(opts.escalations || [])}.
7. RELEASE + DESTROY: \`rm -f ${MAIN}/.mcp-active-tree\`, call server_restart (MCP returns to MAIN — do BEFORE removing the worktree). Record MAIN node_modules count. Classify \`${WT}/node_modules\` (\`node -e "const fs=require('fs'),p=process.argv[1];try{console.log(fs.lstatSync(p).isSymbolicLink()?'LINK':'real')}catch(e){console.log('absent')}" "${WT}/node_modules"\`): \`LINK\` -> remove the link only via Node (never rm -rf/cmd /c); \`real\` -> it is the worktree-LOCAL vitest \`.vite\` cache (NOT MAIN's node_modules at the parent ${MAIN}/node_modules), so do NOT halt — \`git worktree remove --force\` deletes it safely. Run \`git -C ${MAIN} worktree remove --force .wt/${unit.name}\`, then RE-CHECK MAIN node_modules count UNCHANGED (if dropped, nodeModulesIntact=false + halt=true — the only node_modules halt). \`git -C ${MAIN} branch -D wt/${unit.name}\`, \`git -C ${MAIN} worktree prune\`.
Return unit, merged, gatePass, rebaseClean, mainSrcClean, nodeModulesIntact, halt, ledgerCommitted, escalationsRecorded, firstDivergence, note.`
}

// ================= orchestration =================
phase('Scout')
const plan = await agent(scoutPrompt(), { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA })
let all = (plan?.units ?? [])
if (ONLY) all = all.filter((u) => ONLY.includes(u.name))
all = all.filter((u) => u.tier >= FROM_TIER)
const deferredUnits = all.filter((u) => u.deferred)
const units = all.filter((u) => !u.deferred).slice(0, MAX_UNITS)
log(`Plan: ${units.length} portable unit(s): ${units.map((u) => u.name).join(', ')}  | ${deferredUnits.length} deferred`)

phase('Setup')
const pre = await agent(preflightPrompt(), { label: 'preflight', phase: 'Setup', schema: PREFLIGHT_SCHEMA })
const MAIN = pre?.mainRoot
const deferredList = deferredUnits.map((u) => `${u.name}: ${u.deferReason || 'deferred'}`)
if (!MAIN) return { aborted: 'preflight: no mainRoot', completed: [], escalated: [], gateFailed: [], deferred: deferredList }
if (!pre.cleanMainSrc) return { aborted: 'main src/ not clean', dirty: pre.dirty || [], completed: [], escalated: [], gateFailed: [], deferred: deferredList }
log(`Preflight OK. MAIN=${MAIN}; swept: ${pre.swept || 'none'}`)
await agent(setupPrompt(), { label: 'setup-branch', phase: 'Setup' })

// ---- BuildVerify: PARALLEL, MCP-free (worktree-create -> recon-build -> apply rounds -> isomorphism verify+commit) ----
phase('BuildVerify')
async function buildVerifyUnit(unit) {
  const setup = await agent(worktreeCreatePrompt(unit, MAIN), { label: `wt-create:${unit.name}`, phase: 'BuildVerify', schema: WT_CREATE_SCHEMA })
  if (!setup?.ok || !setup.worktreePath) return { unit: unit.name, unitObj: unit, worktreePath: null, isomorphic: false, committedAnything: false, escalations: [{ source: unit.name, verdict: 'WT-CREATE-FAIL', note: setup?.note || 'no result' }] }
  const WT = setup.worktreePath
  let committedAnything = false, isomorphic = true
  const escalations = []
  const progressEntries = []
  // Reconstructions first (build -> isomorphism-verify + commit; harness gate deferred to the serial stage).
  if (unit.recons.length) {
    await agent(reconBuildPrompt(unit, WT, MAIN), { label: `recon-build:${unit.name}`, phase: 'BuildVerify' })
    const rv = await agent(isoReconVerifyPrompt(unit, WT, MAIN), { label: `recon-iso:${unit.name}`, phase: 'BuildVerify', schema: RECON_VERDICTS_SCHEMA })
    if ((rv?.results ?? []).some((r) => r.committed)) committedAnything = true
    ;(rv?.results ?? []).forEach((r) => { if (r.verdict === 'MATCH') (r.progressEntries || []).forEach((e) => progressEntries.push(e)) })
    const bad = (rv?.results ?? []).filter((r) => r.verdict !== 'MATCH')
    const missing = unit.recons.filter((r) => !(rv?.results ?? []).some((x) => x.id === r.id))
    if (bad.length || missing.length) {
      isomorphic = false
      bad.forEach((r) => escalations.push({ source: r.id, verdict: r.verdict, note: r.note || '' }))
      missing.forEach((r) => escalations.push({ source: r.id, verdict: 'NO-VERDICT', note: 'no recon verdict returned' }))
    }
  }
  // functionGroups: applier -> separate-context isomorphism verifier, <=3 rounds with PRIOR-REJECTION feedback, per-group commit.
  if (isomorphic) for (const batch of chunk(unit.groups, BATCH)) {
    let pending = batch.slice()
    const notes = {}
    for (let round = 1; round <= 3 && pending.length; round++) {
      await agent(applierPrompt(unit, pending, round, notes, WT, MAIN), { label: `apply:${unit.name}#r${round}(${pending.length})`, phase: 'BuildVerify' })
      const res = await agent(isoGroupVerifyPrompt(unit, pending, WT, MAIN), { label: `group-iso:${unit.name}#r${round}`, phase: 'BuildVerify', schema: GROUP_VERDICTS_SCHEMA })
      if ((res?.results ?? []).some((r) => r.committed)) committedAnything = true
      ;(res?.results ?? []).forEach((r) => { if (r.verdict === 'MATCH') (r.progressEntries || []).forEach((e) => progressEntries.push(e)) })
      const map = new Map((res?.results ?? []).map((r) => [r.functionGroup, r]))
      const next = []
      for (const g of pending) {
        const r = map.get(g.functionGroup)
        if (r?.verdict === 'MATCH') continue
        if (r?.verdict === 'ESCALATE') { escalations.push({ source: `${unit.name}/${g.functionGroup}`, verdict: 'ESCALATE', note: r.note || '' }); isomorphic = false; continue }
        notes[g.functionGroup] = r?.note || 'no verifier verdict returned'
        next.push(g)
      }
      pending = next
    }
    if (pending.length) { pending.forEach((g) => escalations.push({ source: `${unit.name}/${g.functionGroup}`, verdict: '3-ROUNDS-EXHAUSTED', note: notes[g.functionGroup] || 'unresolved' })); isomorphic = false }
  }
  return { unit: unit.name, unitObj: unit, worktreePath: WT, isomorphic, committedAnything, progressEntries, escalations }
}
const limited = chunk(units, CONCURRENCY)
const built = []
for (const wave of limited) {
  const waveResults = await parallel(wave.map((u) => () => buildVerifyUnit(u)))
  built.push(...waveResults.filter(Boolean))
}
const byName = new Map(units.map((u) => [u.name, u]))
log(`BuildVerify done: ${built.filter((b) => b.isomorphic).length}/${built.length} isomorphic`)

// ---- GateMerge: SERIAL, single MCP, rebase-onto-advancing-HEAD then gate+merge+teardown ----
phase('GateMerge')
const summary = { completed: [], deferred: deferredList.slice(), escalated: [], gateFailed: [], halted: null }
for (const b of built) {
  if (summary.halted) { summary.escalated.push(`${b.unit}: not gated — run halted earlier`); continue }
  const unit = byName.get(b.unit) || b.unitObj
  const r = await agent(gateMergeTeardownPrompt(unit, b.worktreePath, MAIN, { isomorphic: b.isomorphic, committedAnything: b.committedAnything, progressEntries: b.progressEntries, escalations: b.escalations }), { label: `gate-merge:${b.unit}`, phase: 'GateMerge', schema: GATEMERGE_SCHEMA })
  ;(b.escalations || []).forEach((e) => summary.escalated.push(`${e.source}: ${e.verdict} — ${e.note}`))
  if (r?.halt) { summary.halted = `${b.unit}: ${r.note}`; log(`HALT after ${b.unit}: ${r.note}`); continue }
  if (r?.merged && r?.gatePass) { summary.completed.push(b.unit); log(`DONE ${b.unit}`) }
  else if (r?.gatePass === false) { summary.gateFailed.push(`${b.unit}: ${r.firstDivergence ?? r.note}`); log(`GATE-FAIL ${b.unit}`) }
  else if (r?.rebaseClean === false) { summary.escalated.push(`${b.unit}: rebase conflict vs ${BRANCH} — needs sequencing`); log(`REBASE-CONFLICT ${b.unit}`) }
  else if (!b.isomorphic) { summary.escalated.push(`${b.unit}: not isomorphic — patch preserved in .wt-failed`); log(`NOT-ISO ${b.unit}`) }
}
return summary
