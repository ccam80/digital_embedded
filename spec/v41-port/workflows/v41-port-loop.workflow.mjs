export const meta = {
  name: 'v41-port-loop',
  description: 'Drive the ngspice v26->v41 port to completion: engine-first, then devices in bootstrap-tier order (gate-manifest.md). The batch unit is the UNIT (device / engine subsystem): one applier ports ALL its workable functionGroups in one context (source order), one separate-context verifier checks them all and commits per APPLIED group (<=3 MISMATCH rounds, TASK.md/VERIFICATION.md), then a device harness gate (firstDivergence null on the manifest fixtures). Serial on a v41-port branch; escalations + gate-failures are set aside and surface at the end. ledger.json is machine-derived (never hand-edited); loop state goes to progress.json.',
  phases: [
    { title: 'Scout', detail: 'one agent reads ledger.json + gate-manifest.md -> ordered work units (engine first, then tier 0..3) with recons, workable functionGroups, gate fixtures' },
    { title: 'Setup', detail: 'preflight: require a clean main src/ (worktree merges need it), junction-safe sweep of stale worktrees, then ensure a v41-port branch (never main); no stash/discard' },
    { title: 'Port', detail: 'serial per unit, each in an isolated git worktree the harness MCP is repointed at: recon build->verify(harness@wt), applier->verifier batch (<=3 rounds, per-group commits in wt), device harness gate@wt; on pass compile-gate + ff-merge wt->main + ledger refresh in main; on fail capture+destroy (main untouched); failures set aside' },
  ],
}

/* The script has no filesystem access; a scout agent reads the ledger + manifest
 * and returns the ordered plan. args (all optional):
 *   { only: [unitName,...]        limit to these units (e.g. ["vsrc"])
 *   , fromTier: number            skip tiers below this (engine = -1, tier0 = 0, ...)
 *   , maxUnits: number            hard cap on units this run (re-invoke for more)
 *   , maxGroupsPerAgent: number } chunk a unit's groups into batches this big per
 *                                 applier/verifier (default = whole unit) */
// The Workflow tool delivers `args` as a JSON-encoded STRING, not an object
// (verified via args-probe: typeof args === 'string'). Normalize to an object
// so the knobs below read correctly whether args arrives as a string or object.
const A = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return {} } })()
  : (args && typeof args === 'object' ? args : {})
const ONLY = Array.isArray(A.only) ? A.only : null
const FROM_TIER = Number.isInteger(A.fromTier) ? A.fromTier : -1
const MAX_UNITS = (Number.isInteger(A.maxUnits) && A.maxUnits > 0) ? A.maxUnits : 9999
const BATCH = (Number.isInteger(A.maxGroupsPerAgent) && A.maxGroupsPerAgent > 0) ? A.maxGroupsPerAgent : 9999

const DLL = 'ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll'
const BRANCH = 'v41-port'

const SCOUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'kind', 'tier', 'deferred', 'recons', 'groups', 'gateFixtures', 'gateKind'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['engine', 'device'] },
          tier: { type: 'integer', description: 'engine = -1, tier0 = 0, ... tier3 = 3' },
          deferred: { type: 'boolean' },
          deferReason: { type: 'string' },
          recons: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'spec', 'tsFiles', 'blocks'],
              properties: { id: { type: 'string' }, spec: { type: 'string' }, tsFiles: { type: 'array', items: { type: 'string' } }, blocks: { type: 'array', items: { type: 'string' } } },
            },
          },
          groups: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['functionGroup', 'tsFile', 'mappingNote', 'hunkIds'],
              properties: {
                functionGroup: { type: 'string' },
                tsFile: { type: 'string', description: 'the src/*.ts path extracted from the hunks\' tsFunction field' },
                mappingNote: { type: 'string', description: 'the full tsFunction prose for the group (ngspice-symbol -> digiTS-symbol mapping guidance)' },
                hunkIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          gateFixtures: { type: 'array', items: { type: 'string' }, description: 'repo-relative gate fixture paths from gate-manifest.md: .dts fixtures for a harness gate; the reproducibility TEST .ts path(s) for a self-compare gate' },
          gateKind: { type: 'string', enum: ['harness', 'self-compare', 'deferred'] },
        },
      },
    },
  },
}

// Per-unit recon verifier returns one verdict per recon item.
const RECON_VERDICTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'verdict', 'note'],
        properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['MATCH', 'MISMATCH', 'ESCALATE'] }, note: { type: 'string' }, committed: { type: ['string', 'null'] } },
      },
    },
  },
}

// Per-unit (batched) verifier returns one verdict per functionGroup in the batch.
const GROUP_VERDICTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['functionGroup', 'verdict', 'note'],
        properties: { functionGroup: { type: 'string' }, verdict: { type: 'string', enum: ['MATCH', 'MISMATCH', 'ESCALATE'] }, note: { type: 'string' }, committed: { type: ['string', 'null'] } },
      },
    },
  },
}

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pass', 'detail'],
  properties: {
    pass: { type: 'boolean' },
    detail: { type: 'string' },
    firstDivergence: { type: ['string', 'null'], description: 'null when clean; else the harness firstDivergence summary (step/iter/node/absDelta)' },
  },
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
function groupBlock(groups, notes) {
  return groups.map((g, i) => `  ${i + 1}. functionGroup="${g.functionGroup}"  tsFile=${g.tsFile}\n       mapping: ${g.mappingNote}\n       hunks=[${g.hunkIds.join(', ')}]${notes && notes[g.functionGroup] ? `\n       PRIOR-REJECTION: ${notes[g.functionGroup]}` : ''}`).join('\n')
}
function fileScope(groups, unit) {
  const files = Array.from(new Set([...groups.map((g) => g.tsFile), `rename-maps/${unit.name}.md`]))
  return files.join(', ')
}

function scoutPrompt() {
  return `You are the SCOUT for the ngspice v26->v41 port-loop driver. Read in full:
- spec/v41-port/gate-manifest.md  (bootstrap TIER ORDER, engine-first, per-device GATE FIXTURES, deferred set)
- spec/v41-port/ledger.json       (machine-derived items)

LEDGER FIELDS THAT MATTER:
- A hunk item's digiTS target is its \`tsFunction\` field — PROSE beginning with a \`src/*.ts\` path then a mapping note (e.g. "src/components/semiconductors/diode.ts — DIODE_PARAM_DEFS.instance ... The IFparm DIOpTable rows map to instance-param entries"). Extract the path as the group's tsFile; pass the FULL prose as mappingNote. There is NO files[].tsFile for hunks.
- A hunk with \`tsFunction: null\` (or no extractable src path) is UNMAPPED — it has no digiTS counterpart authored. Do NOT emit it as a workable group.
- Reconstruction items (kind:"reconstruction") carry their own \`tsFiles\` (an ARRAY — often SEVERAL files), \`spec\`, and \`blocks\` fields.

Produce the ORDERED work plan (ENGINE-FIRST, then device tiers 0->3 exactly as gate-manifest.md lays out). Per unit:
- name, kind ('engine'|'device'), tier (engine=-1, tier0=0,...tier3=3).
- deferred=true + deferReason for ALL of:
    * parser — its SPICE-deck card-readers, model-card parser, and B-source grammar are all NO-COUNTERPART in the ledger now (digiTS has no text-deck reader), so they are never emitted regardless. Do NOT blanket-defer parser. Its only live items are recons: parser#recon/nodeAllocOrder (APPLIED) and expr-engine#recon/numericalDeltas (APPLIED; may be STALE -> cheap re-verify). Let the generic rules emit only any STALE recon for a cheap re-verify (compiler.ts / expression-engine files); there are no portable parser card-reader groups to hold back.    * any other unit where >0 of its PENDING hunks are unmapped — defer it and name the count in deferReason (planning gap to escalate).
    * ANY unit with a PENDING reconstruction whose \`specExists\` is false — defer the WHOLE unit (its recon-blocked hunks cannot be built), deferReason "recon spec missing: <id>". A reconstruction is NEVER buildable from inference/planning docs; if the spec file is absent the unit waits for a spec-author pass. Do NOT emit a spec-less recon as buildable.
    * manifest-deferred units (nodeset-ic/tf no input surface). (csw is placeable with gate fixture csw-gate.dts; asrc/jfet2/mes are in-scope BUILD jobs emitted via MUST-EMIT for their wholeClass recon — jfet2/mes already built + gate-verified bit-exact, asrc built from asrc-wholeClass.md by the recon-builder. NONE of these is deferred.)
    * units with zero PENDING work (cap, ind -> "complete; re-gates after vsrc").
- MUST-EMIT: a unit is PORTABLE (enumerate it; neither skip nor defer) if it has >=1 PENDING reconstruction with \`specExists:true\` OR >=1 emittable mapped group — EVEN IF the rest of the unit is NO-COUNTERPART/APPLIED. e.g. include-ngspice (247 NC + 3 APPLIED + the lone PENDING \`include-ngspice#recon/epsmin\`) IS portable: emit it for the recon. NEVER skip an engine unit as "mostly done / mostly NC" while a PENDING specExists:true recon remains.
- recons: each PENDING OR STALE reconstruction item for this unit WITH \`specExists:true\` — id, spec path, tsFiles, blocks[]. (A STALE recon was APPLIED but its spec/diff hash drifted — emit it for a CHEAP RE-VERIFY per VERIFICATION.md §7, NOT a re-port; the builder/verifier confirm it still matches current v41 and re-record APPLIED with the fresh hash.) Copy the ledger's \`tsFiles\` ARRAY VERBATIM AND IN FULL (every entry, ledger order). The machine-derived ledger is AUTHORITATIVE for the file set: do NOT narrow it to a single "main" / "rebuild-target" file and do NOT drop entries based on the spec's prose. A spec may call one file the "single rebuild target" while its own preconditions require editing several more (LoadContext fields, a deck emitter, a sibling source) — emit ALL ledger tsFiles regardless. Under-emitting tsFiles forces the builder to escalate the instant the spec needs a file outside the emitted scope (this is exactly the \`vsrc#recon/waveformModel\` EMPTY-DIFF failure: ledger had 5 tsFiles, scout emitted 1). Driver builds recons before groups. (Units with any specExists:false recon are deferred per above; never emit those.)
- groups: every functionGroup whose hunks are ALL mapped (tsFunction has a src path) with >=1 PENDING OR STALE item, source order (a STALE hunk is re-verified, not re-ported — VERIFICATION.md §7). INCLUDE groups blocked only by THIS unit's recons. EXCLUDE groups blocked by ANOTHER unit's unfinished recon, all-NC/all-APPLIED groups, and any group containing an unmapped hunk (instead defer the unit per above). Per group: functionGroup, tsFile (extracted), mappingNote (the tsFunction prose), hunkIds (PENDING, source order).
- gateFixtures + gateKind from gate-manifest.md, VERBATIM (copy the exact strings in the manifest's gateFixtures=[...]). For a HARNESS unit, gateFixtures are .dts paths. For a SELF-COMPARE recon (e.g. \`maths-misc#recon/randnumb\` — validated by seeded reproducibility, NOT a divergence circuit), set gateKind='self-compare' and gateFixtures = the manifest's reproducibility TEST target, which MAY carry a vitest name filter scoping it to the recon's OWN tests (e.g. \`src/solver/analog/__tests__/monte-carlo.test.ts -t SeededRng\` — the loop runs \`vitest run <that>\` in the worktree, so the filter rides through). Emit it exactly as written. Do NOT defer such a recon for "no input surface" — its self-compare test IS its input surface.

Edit nothing. Return ONLY the structured plan.`
}

function setupPrompt() {
  return `Ensure the git working tree is on a \`${BRANCH}\` branch for the port loop. If \`${BRANCH}\` exists, switch to it; else create it from the current HEAD. NEVER run the loop on the default branch (main). Do NOT stash, reset, checkout-discard, or delete anything — other work may be in the tree; if the tree is dirty in a way that blocks the branch switch, STOP and report rather than discarding. Report the branch name and HEAD short-hash.`
}

// ===== Worktree isolation (A2) =====
// Each unit is built + gated in an isolated git worktree that the harness MCP is
// repointed at via .mcp-active-tree (read by scripts/mcp-wrapper.mjs on each
// (re)spawn). On PASS the worktree branch fast-forward-merges to ${BRANCH} in
// MAIN and the ledger is regenerated there; on FAIL the worktree is captured +
// destroyed and MAIN is never touched. Only src/ is isolated; the gitignored
// spec dir, the ref/ngspice submodule, and the DLL are read from MAIN.
const COMPILE_GATE = 'node_modules/.bin/vitest run src/solver/analog/__tests__/compile-analog-partition.test.ts src/solver/analog/__tests__/compiler.test.ts'

// Scope rule shared by builders (recon + applier) and verifiers. Three pillars:
// (1) compile-forced expansion is allowed (type-check necessity only); (2) closing
// the gap to ngspice is the recon's PURPOSE — an in-scope gate divergence is FIXED,
// never deferred as "pre-existing"; only out-of-scope couplings escalate, and a
// non-isomorphic fudge / unrelated-file edit is the one thing banned; (3) implement-
// then-escalate, so a blocked unit leaves a maximal patch, not an empty worktree.
const STRUCTURAL_SCOPE = `FILE SCOPE & DIVERGENCE HANDLING.
(1) COMPILE-FORCED EXPANSION. Edit the named tsFiles (rooted at the worktree). You MAY ALSO edit a file NOT listed ONLY when an in-scope edit will not TYPE-CHECK / COMPILE without it (adding a field to an interface forces declaring + initialising it on the implementing class and at every construction site; adding a method forces its implementers). Make the MINIMAL conformance edit — the forced declaration / init only, NO new logic.
(2) CLOSING THE GAP TO ngspice IS THE RECON'S PURPOSE. The harness / self-compare gate is the correctness check on THIS recon's port. When it diverges, classify the fix:
  - IN-SCOPE divergence — the gate is red because YOUR port is INCOMPLETE or WRONG within the recon's tsFiles + the ngspice behavior the spec's acceptance criteria cover: FIX IT. Iterate the faithful ngspice port until it is source-isomorphic AND the gate is null. A divergence living in code the recon is responsible for IS the work — "pre-existing" / "legacy path" / "I didn't change that line" / "already documented" is NEVER a valid outcome; every un-ported divergence is pre-existing, and closing it is the entire reason the recon exists. If a spec acceptance criterion names a fixture or behavior (e.g. a waveform that must gate null), making it match ngspice is in-scope, not an escalation.
  - OUT-OF-SCOPE coupling — closing the gap REQUIRES editing a file outside the recon's tsFiles beyond a compile-forced conformance edit (a genuine cross-subsystem change needing sequencing): escalate THAT item, naming the exact file + the precise edit.
  - NEVER force the gate green by a NON-ISOMORPHIC fudge (a value that matches the number but not ngspice's WHERE/HOW — banned by "structural match, not semantic") or by editing an unrelated file. That, and only that, is what "never edit to make the gate pass" forbids; it does NOT license leaving an in-scope divergence unfixed.
(3) IMPLEMENT-THEN-ESCALATE: do EVERY in-scope and compile-forced edit you CAN, FIRST; only then escalate a GENUINE remaining OUT-OF-SCOPE blocker (name the file + the precise edit). A blocked unit leaves a MAXIMAL, usable patch in the worktree, never an empty one.`
const STRUCTURAL_SCOPE_CHECK = `FILE-SCOPE + DIVERGENCE CHECK. (a) The worktree \`git diff --name-only\` MAY include files beyond the named tsFiles ONLY when each is STRUCTURALLY FORCED (does not type-check / compile without it) AND the extra edit is MINIMAL conformance (a forced declaration / init, NOT new logic) — confirm by reading the diff; a file edited to add logic, or a non-isomorphic fudge to force the gate, is over-application -> MISMATCH (name it). (b) A gate divergence on a behavior the recon's spec / acceptance criteria cover means the port is INCOMPLETE or WRONG -> MISMATCH (send it back to be FIXED). It is NEVER closeable as "pre-existing" / "legacy" / "outside the changed lines" — those are banned verdicts; every un-ported divergence is pre-existing. Escalate a gate divergence ONLY when its faithful fix provably requires a file outside the recon's scope (name it). The compile + harness gates remain the correctness arbiters.`

// The gate clause used by both the recon-verifier and the device gate. A
// 'harness' unit gates on per-iteration ngspice divergence; a 'self-compare'
// unit (e.g. maths-misc#recon/randnumb) has no divergence circuit and gates on
// its own reproducibility test(s) run in the worktree (gateFixtures = test paths).
function gateClause(unit, WT, MAIN) {
  if (unit.gateKind === 'self-compare') {
    return `run the recon's reproducibility / self-compare test(s) in the worktree — \`cd ${WT} && node_modules/.bin/vitest run ${unit.gateFixtures.join(' ')}\` — PASS only if EVERY test passes (e.g. randnumb's seeded-stream reproducibility + the polar-Box-Muller assertions). There is no ngspice divergence circuit for this recon; the test IS the gate.`
  }
  return `call server_restart (reloads the worktree build into the MCP, which is pointed at ${WT}), then on EACH fixture [${unit.gateFixtures.join(', ')}]: harness_start (dllPath ${MAIN}/${DLL}) -> harness_run (DC-OP + transient; harness_run_ac for *-ac) -> harness_first_divergence. PASS only if firstDivergence is null across ALL classes on ALL fixtures.`
}

function wtPreamble(WT, MAIN) {
  return `WORKTREE ISOLATION — every path rule below is mandatory.
- EDIT TARGET: the isolated worktree at ${WT}. EVERY src/** file you Read/Edit/Write and EVERY git command MUST be rooted there — use ABSOLUTE paths like ${WT}/src/... and run git as \`git -C ${WT} ...\`. NEVER create/edit/Read-then-edit any path under the MAIN checkout ${MAIN}/src/** — an edit there escapes isolation and poisons the live server. If you are about to touch ${MAIN}/src, STOP.
- READ-ONLY REFERENCES (read from MAIN — the worktree does NOT contain them): the ngspice C source ${MAIN}/ref/ngspice/** and the DLL ${MAIN}/${DLL} (submodule + binary), plus the port contracts / recon specs / diffDocs under ${MAIN}/spec/v41-port/ (gitignored, absent from the checkout). Read those at their ${MAIN}/... paths.
- The harness MCP is ALREADY pointed at ${WT} (the server runs from there): harness_start/run/first_divergence gate THIS worktree's build. Always pass dllPath ${MAIN}/${DLL}.
- LEDGER: do NOT run build-ledger.mjs and do NOT edit ledger.json / ledger.md — a post-merge MAIN pass regenerates them. You MAY edit ${WT}/spec/v41-port/progress.json (it IS in the worktree) to record APPLIED, and commit it together with src on this worktree's branch.
- PRIOR KEPT WORK: if \`git -C ${WT} diff\` is NON-EMPTY when you start, a previous attempt's patch was resumed into this worktree at setup — it is prior implementation of THIS unit and is your STARTING POINT. Keep what is correct, complete what is missing, fix what is wrong; do NOT discard it and rebuild from scratch. The verifier re-derives isomorphism over the FINAL result regardless of origin, so correctness still gates.`
}

const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['mainRoot', 'cleanMainSrc', 'frozenLeak', 'note'],
  properties: { mainRoot: { type: ['string', 'null'] }, cleanMainSrc: { type: 'boolean' }, dirty: { type: 'array', items: { type: 'string' } }, swept: { type: 'string' }, frozenLeak: { type: 'boolean', description: 'true when build-ledger.mjs --check-frozen reported a FROZEN-CONSTRUCT LEAK in the units about to be ported' }, frozenLeakDetail: { type: ['string', 'null'], description: 'verbatim FROZEN-CONSTRUCT LEAK line(s) when frozenLeak=true' }, note: { type: 'string' } },
}
const WT_SETUP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'worktreePath', 'note'],
  properties: { ok: { type: 'boolean' }, worktreePath: { type: ['string', 'null'] }, note: { type: 'string' } },
}
const WT_TEARDOWN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ok', 'merged', 'note'],
  properties: { ok: { type: 'boolean' }, merged: { type: 'boolean' }, mainSrcClean: { type: 'boolean' }, halt: { type: 'boolean' }, nodeModulesIntact: { type: 'boolean' }, ledgerCommitted: { type: ['string', 'null'] }, escalationsRecorded: { type: ['string', 'null'] }, note: { type: 'string' } },
}

function preflightPrompt(portUnitNames) {
  const unitArgs = (portUnitNames || []).join(' ')
  return `You are the PREFLIGHT for the v41 port-loop worktree isolation. Do ALL of, then return the structured result:
1. mainRoot = the absolute repository root of the main checkout (\`git rev-parse --show-toplevel\`).
2. CLEAN-MAIN GATE: run \`git status --porcelain -- src/\`. If ANY src/ path shows uncommitted (modified/added/untracked) changes, set cleanMainSrc=false and list them in \`dirty\` — the loop CANNOT run (worktree merges require a clean main src/; the user must commit or stash first). Otherwise cleanMainSrc=true.
3. FROZEN-CONSTRUCT GATE: run \`node spec/v41-port/build-ledger.mjs --check-frozen ${unitArgs}\` (the units this run will port). This rebuilds the ledger in memory and asserts that NO workable-PENDING hunk in those units matches a construct-class the project ruled NO-COUNTERPART in spec/v41-port/planning/frozen-constructs.json (the guard that stops a ruled construct — TRNOISE/TRRANDOM noise-state, newcompat compat-mode, RFSPICE/XSPICE/LTRA, SPfrontEnd warnings, the CKT task/job machinery — from silently re-escalating). If it exits NONZERO and prints \`FROZEN-CONSTRUCT LEAK: ...\`, set frozenLeak=true and copy the leak line(s) VERBATIM into frozenLeakDetail — the loop MUST NOT port a unit with a leak (the construct needs its NO-COUNTERPART ruling written into the device's planning/<dev>-decisions.json overlay, or the hunk split, before any run). If it exits 0 (\`OK: no frozen-construct leaks\`), set frozenLeak=false. Do NOT edit any overlay or split anything yourself — only DETECT and report.
4. STALE-WORKTREE SWEEP (a prior run may have crashed mid-teardown): for each existing \`.wt/*\` directory: the loop NEVER places a real node_modules inside a worktree (node resolves node_modules from MAIN by walking up — see setup), so a \`<path>/node_modules\` that exists is a LEFTOVER junction. Remove the LINK ONLY, lstat-guarded, via Node — do NOT use \`cmd /c rmdir\` (it SILENTLY NO-OPS in this shell), and NEVER \`rm -rf\`/\`rmdir /s\` (which follows the junction and deletes the REAL node_modules): \`node -e "const fs=require('fs'),p=process.argv[1];try{const s=fs.lstatSync(p);if(s.isSymbolicLink())fs.rmSync(p);else fs.rmdirSync(p);}catch(e){}" "<path>/node_modules"\`. Confirm the main node_modules entry count is unchanged after. THEN \`git worktree remove --force <path>\`. Then \`git worktree prune\`, delete stale \`wt/*\` branches (\`git branch -D\`), and remove a stale \`.mcp-active-tree\` if present. Summarize in \`swept\`.
Edit no source.`
}

function setupWorktreePrompt(unit, MAIN) {
  const wt = `${MAIN}/.wt/${unit.name}`
  return `You are WORKTREE-SETUP for unit "${unit.name}". Work in the MAIN checkout ${MAIN}.
NEVER use \`cmd /c\` — it SILENTLY NO-OPS in this shell (it once let a live node_modules junction survive into \`git worktree remove\`, which then deleted the real node_modules). NO node_modules junction is created here (see step 3). Execute in order:
1. If a stale \`wt/${unit.name}\` branch or \`.wt/${unit.name}\` worktree exists, remove it: should a leftover \`.wt/${unit.name}/node_modules\` junction exist, remove the LINK ONLY via Node (\`node -e "const fs=require('fs'),p=process.argv[1];try{const s=fs.lstatSync(p);if(s.isSymbolicLink())fs.rmSync(p);else fs.rmdirSync(p);}catch(e){}" ".wt/${unit.name}/node_modules"\` — NEVER \`rm -rf\`/\`rmdir /s\`/\`cmd /c\`), then \`git worktree remove --force .wt/${unit.name}\`, \`git branch -D wt/${unit.name}\`, \`git worktree prune\` (ignore not-found errors).
2. \`git worktree add .wt/${unit.name} -b wt/${unit.name} ${BRANCH}\` — branch the worktree from the current ${BRANCH} HEAD. It lives at \`${wt}\`, INSIDE the main checkout.
2b. RESUME FROM KEPT PATCH: if \`${MAIN}/.wt-failed/${unit.name}.diff\` exists, test \`git -C ${wt} apply --check "${MAIN}/.wt-failed/${unit.name}.diff"\`. If it applies cleanly, run \`git -C ${wt} apply "${MAIN}/.wt-failed/${unit.name}.diff"\` to restore a prior attempt's kept implementation so the builder COMPLETES/FIXES it instead of rebuilding from scratch (reuses the prior token spend). If --check FAILS (the patch is stale vs current ${BRANCH} HEAD), do NOT force it: skip the apply and a clean rebuild proceeds. State resumedFromPatch true/false in note.
3. NO node_modules junction. Because \`${wt}\` is inside ${MAIN}, Node resolves \`node_modules\` by walking UP to \`${MAIN}/node_modules\` — the worktree needs none of its own, and creating a junction is exactly what caused the documented node_modules-deletion hazard. VERIFY upward resolution: \`cd ${wt} && node -e "require.resolve('typescript')"\` must succeed (resolves into ${MAIN}/node_modules). If it does NOT, return ok=false.
4. Point the harness MCP at the worktree: write the absolute path \`${wt}\` to \`${MAIN}/.mcp-active-tree\` with NO trailing newline and NO BOM (\`printf '%s' "${wt}" > "${MAIN}/.mcp-active-tree"\`). Then call the server_restart MCP tool.
5. On success return ok=true, worktreePath="${wt}". If ANY step fails, UNDO partial state (the worktree, the branch, and .mcp-active-tree) and return ok=false with the failure in note.`
}

function teardownWorktreePrompt(unit, WT, MAIN, opts) {
  return `You are WORKTREE-TEARDOWN for unit "${unit.name}". Worktree=${WT}  Main=${MAIN}  merge=${opts.merge}  complete=${opts.complete}. Execute the numbered steps IN ORDER. NEVER use \`cmd /c\` — it SILENTLY NO-OPS in this shell (that is what previously let a live node_modules junction survive into \`git worktree remove\`, deleting the real node_modules). The worktree has NO node_modules junction (setup creates none — Node resolves node_modules from MAIN by walking up), so \`git worktree remove\` is safe and there is nothing to "junction-safe remove" — step 5 only GUARDS against an unexpected one.
${opts.merge
  ? `1. COMPILE GATE (the worktree build must compile before it can merge): \`cd ${WT} && ${COMPILE_GATE}\`. If it FAILS: set merged=false, skip step 2, note "WT non-compiling — matched work NOT merged, will re-run", and go to step 3.
2. MERGE: \`git -C ${MAIN} merge --ff-only wt/${unit.name}\` (fast-forward ${BRANCH} to the worktree commits). If NOT a clean fast-forward, set merged=false + halt=true + note (${BRANCH} advanced concurrently — must not happen in a serial loop). On success merged=true.`
  : `1.-2. (no matched work committed in the worktree — skip compile gate + merge; merged=false.)`}
3. MAIN-SRC-CLEAN CHECK: \`git -C ${MAIN} status --porcelain -- src/\`. After a clean merge this is EMPTY. If it shows ANY uncommitted src/ change, an applier leaked an edit into the MAIN checkout — capture it: \`git -C ${MAIN} diff -- src/ > ${MAIN}/.wt-failed/${unit.name}-MAINLEAK.diff\` (mkdir .wt-failed first), set mainSrcClean=false + halt=true. Else mainSrcClean=true.
3b. KEPT-PATCH HYGIENE (feeds resume-from-patch): if the unit MERGED, \`rm -f ${MAIN}/.wt-failed/${unit.name}.diff\` — its work is now on ${BRANCH}, so a leftover patch would be wrongly resumed next run. If it did NOT merge and \`git -C ${WT} status --porcelain -- src/\` is non-empty, preserve the MAXIMAL src patch (the work the builder did before a genuine blocker) so the next run resumes from it: \`mkdir -p ${MAIN}/.wt-failed\` then \`git -C ${WT} diff -- src/ > ${MAIN}/.wt-failed/${unit.name}.diff\`. Always run this before step 5 destroys the worktree.
${opts.merge
  ? `4. (only if merged=true) Regenerate the ledger IN MAIN: \`node ${MAIN}/spec/v41-port/build-ledger.mjs\` then \`node ${MAIN}/spec/v41-port/build-ledger.mjs --check\` (must print OK). Then \`git -C ${MAIN} add spec/v41-port/ledger.json spec/v41-port/ledger.md\` and \`git -C ${MAIN} commit -m "v41-port(${unit.name}): ledger refresh post-merge"\`; return its hash in ledgerCommitted.${opts.complete ? ` Then \`git -C ${MAIN} commit --allow-empty -m "v41-port(${unit.name}): device complete — harness firstDivergence null on [${unit.gateFixtures.join(', ')}]"\`.` : ''}`
  : `4. (not merged) The maximal src patch was already preserved by step 3b (\`.wt-failed/${unit.name}.diff\`) for resume-from-patch next run; nothing further to capture.`}
4e. ESCALATION RECORDING (MAIN-side — mandatory; the worktree verifier CANNOT write MAIN's escalation sinks under the isolation rule, so this is the ONLY place they become durable. The run summary alone is not a record.). ${(opts.escalations && opts.escalations.length)
  ? `This unit produced ${opts.escalations.length} escalation(s):
${opts.escalations.map((e, i) => `  [${i + 1}] source=${e.source} | verdict=${e.verdict}\n      note: ${e.note}`).join('\n')}
ROUTE EACH by its content:
  - A NUMERICAL bug (the note mentions firstDivergence, a matrix/Jacobian cell, absDelta, a step/iter, a bit-exact gap, OR it is a GATE-FAIL on fixtures) -> append a NEW entry to ${MAIN}/spec/fix-list-phase-2-audit.md. Read that file first; find the highest existing \`## FIX-NNN\` and use the next number. Format the entry like the existing FIX-001/FIX-002 (heading \`## FIX-NNN — <one-line title> (blocks <source>)\`, then **Surfaced by** / **digiTS** / **ngspice** / **Evidence** (transcribe the note VERBATIM here) / **Decision needed (user)** sections). If an entry already names this source as blocked, UPDATE it instead of duplicating.
  - ANYTHING ELSE (missing-spec, file-scope/over-application, unmapped-hunks, 3-rounds-exhausted, architectural-divergence) -> append to ${MAIN}/spec/v41-port/ESCALATIONS.md (create it with an \`# Escalations\` title if absent), under a \`## ${unit.name} (<today>)\` heading (get today via \`date +%F\`): a bullet per escalation with source, verdict, and the full note.
Then COMMIT IN MAIN (explicit paths, never \`-A\`): \`git -C ${MAIN} add -f spec/fix-list-phase-2-audit.md spec/v41-port/ESCALATIONS.md\` (only those you touched) then \`git -C ${MAIN} commit -m "v41-port(${unit.name}): record ${opts.escalations.length} escalation(s)"\`; return its hash in escalationsRecorded.`
  : `This unit produced no escalations — set escalationsRecorded=null and skip to step 5.`}
5. RELEASE then DESTROY: \`rm -f ${MAIN}/.mcp-active-tree\`, then call the server_restart MCP tool (the MCP returns to MAIN — do this BEFORE removing the worktree dir, since the server's cwd is the worktree and a live cwd cannot be removed). SAFETY GUARD before any removal: \`node -e "const fs=require('fs'),p=process.argv[1];try{console.log(fs.lstatSync(p).isSymbolicLink()?'LINK':'real')}catch(e){console.log('absent')}" "${WT}/node_modules"\` MUST print \`absent\` (setup creates no junction). If \`LINK\` (a junction — should never happen; setup creates none), remove the LINK ONLY via Node (\`fs.rmSync\`/\`fs.rmdirSync\` on the link — NEVER \`rm -rf\`/\`rmdir /s\`/\`cmd /c\`) first, then proceed. If \`real\`, DO NOT halt — it is the WORKTREE-LOCAL node_modules the compile gate created (vitest writes a \`node_modules/.vite\` cache relative to the worktree cwd). It is NOT MAIN's node_modules: that lives at the different parent path \`${MAIN}/node_modules\`, and the \`LINK\` branch above already excludes a junction, so \`git worktree remove --force\` safely deletes this local dir with the worktree. Proceed. (The genuine node_modules safety is the MAIN-count re-check below — a real local \`.vite\` cache is benign; only a junction or a dropped MAIN count is the hazard.) Record the MAIN node_modules entry count, run \`git -C ${MAIN} worktree remove --force .wt/${unit.name}\`, then RE-CHECK the MAIN node_modules count is UNCHANGED (if it dropped, set nodeModulesIntact=false + halt=true). Then \`git -C ${MAIN} branch -D wt/${unit.name}\`, \`git -C ${MAIN} worktree prune\`.
Return ok, merged, mainSrcClean, halt, nodeModulesIntact, ledgerCommitted, escalationsRecorded, note.`
}

function reconBuildPrompt(unit, WT, MAIN) {
  const list = unit.recons.map((r) => `  - ${r.id}: spec ${r.spec}; tsFiles [${r.tsFiles.join(', ')}]; blocks [${r.blocks.join(', ')}]`).join('\n')
  return `${wtPreamble(WT, MAIN)}

You are the RECONSTRUCTION BUILDER for unit "${unit.name}" (v41 port). Contract: ${MAIN}/spec/v41-port/TASK.md (reconstruction items are built from their spec in a pre-phase, not by the diff loop). Build ALL of this unit's reconstruction items, in the order listed (each rebuilds v26 baseline so the v41 hunks it blocks then apply as ordinary deltas). spec/tsFiles/blocks paths below are repo-relative — specs read from ${MAIN}/<spec>, tsFiles edited at ${WT}/<tsFile>:
${list}
SPEC-PRESENCE HARD GATE (do FIRST, per recon): Read the recon's spec file at ${MAIN}/<spec>. If it does NOT exist on disk, ESCALATE that recon immediately as "missing-spec" and build NOTHING for it — do NOT reconstruct from the ledger title, planning docs, or inference. Building a reconstruction without its spec is a forbidden contract violation.
${STRUCTURAL_SCOPE}
Edits are rooted at ${WT}; the named tsFiles are those listed per recon above. Match ngspice exactly (SPICE-correct; no pragmatic shortcuts). Write NOTHING to progress.json and DO NOT commit (the verifier records APPLIED + commits). Build all recons you can; escalate only a recon with a genuine remaining blocker, per rule (2).`
}

function reconVerifyPrompt(unit, WT, MAIN) {
  const list = unit.recons.map((r) => `  - ${r.id}: spec ${r.spec}; tsFiles [${r.tsFiles.join(', ')}]`).join('\n')
  return `${wtPreamble(WT, MAIN)}

You are the RECONSTRUCTION VERIFIER for unit "${unit.name}", a SEPARATE CONTEXT from the builder. Contract: ${MAIN}/spec/v41-port/VERIFICATION.md §1a. Verify EACH recon independently (specs read from ${MAIN}/<spec>):
${list}
SPEC-PRESENCE HARD GATE (do FIRST, per recon): Read the recon's spec file at ${MAIN}/<spec>. If it does NOT exist on disk, the recon CANNOT be APPLIED — return MISMATCH/ESCALATE "missing-spec"; a recon built without a governing spec is a contract violation and must never be accepted, regardless of how plausible the source looks.
APPLIED requires (a) source isomorphic to the spec's ngspice baseline (re-derive independently from ${MAIN}/ref/ngspice; do NOT trust rename-maps) AND (b) GATE clean: ${gateClause(unit, WT, MAIN)}
EMPTY-DIFF CATCH: run \`git -C ${WT} diff --name-only\`. If it is EMPTY for a recon's tsFiles, the builder's edit did NOT land in the worktree (likely edited ${MAIN} by mistake) -> MISMATCH that recon, note "edit did not land in ${WT}; re-apply rooted at the worktree".
${STRUCTURAL_SCOPE_CHECK} (Named scope = the union of the recons' tsFiles; run the check as \`git -C ${WT} diff --name-only\`.)
Per recon: MATCH -> edit ${WT}/spec/v41-port/progress.json to APPLIED, then COMMIT in the worktree (\`git -C ${WT} add\` ONLY that recon's tsFiles + spec/v41-port/progress.json; message \`v41-port(${unit.name}): recon <id> APPLIED\`); return its hash in committed. Do NOT run build-ledger.mjs and do NOT add ledger.json/ledger.md — the post-merge MAIN pass regenerates them. MISMATCH -> leave PENDING + precise note. Non-null firstDivergence may NOT be waved through (banned: settled-solver/pre-existing/tolerance) — classify + escalate to ${MAIN}/spec/fix-list-phase-2-audit.md with evidence. Return one result per recon id.`
}

function applierPrompt(unit, groups, round, notes, WT, MAIN) {
  return `${wtPreamble(WT, MAIN)}

You are the APPLIER for the v41 port, unit "${unit.name}". Contract: ${MAIN}/spec/v41-port/TASK.md (read it). Port the following functionGroups, IN THIS ORDER (work them as one coherent device pass — later hunks may assume earlier ones landed). tsFile paths below are repo-relative — edit them at ${WT}/<tsFile>:
${groupBlock(groups, notes)}
${STRUCTURAL_SCOPE}
The named files for these groups (rooted at ${WT}): ${fileScope(groups, unit)}. A cross-group change that is structurally forced (won't compile otherwise) is allowed per rule (1); a change that is NOT compile-forced (shared-infra logic, another device's behavior) -> ESCALATE that group (TASK.md §8) after applying everything else, per rule (2).
Per hunk: read it from its diffDoc at ${MAIN}/<diffDoc> at docLineRange; read the v41 ngspice fn from ${MAIN}/ref/ngspice/ for context; read our TS at ${WT}/<tsFile>; pre-image check (§6); APPLY (Edit ${WT}/<tsFile>) so our git diff is line-isomorphic to the ngspice hunk (modulo identifier rename + C<->TS syntax only). APPLY or ESCALATE per group — nothing else. Write NOTHING to progress.json and DO NOT commit (leave PENDING; the verifier records + commits). Maintain the rename-map at ${MAIN}/spec/v41-port/rename-maps/${unit.name}.md (a gitignored scratch note — writing it in MAIN is fine; it is not source and is never merged).${round > 1 ? ` ROUND ${round}: groups carrying a PRIOR-REJECTION were rejected by the verifier last round — fix THAT specific divergence in ${WT}; do not resubmit the same edit.` : ''}`
}

function verifyPrompt(unit, groups, WT, MAIN) {
  return `${wtPreamble(WT, MAIN)}

You are the VERIFIER for unit "${unit.name}", a SEPARATE CONTEXT from the applier (no self-approval). Contract: ${MAIN}/spec/v41-port/VERIFICATION.md. Verify EACH of these functionGroups independently (tsFile paths repo-relative — the applier's edits are at ${WT}/<tsFile>):
${groupBlock(groups, null)}
EMPTY-DIFF CATCH (do first): run \`git -C ${WT} diff --name-only\`. If a group's tsFile shows NO change here, the applier's edit did NOT land in the worktree (likely edited ${MAIN} by mistake) -> MISMATCH that group, note "edit did not land in ${WT}; re-apply rooted at the worktree".
${STRUCTURAL_SCOPE_CHECK} (Named scope = {${fileScope(groups, unit)}}; run the check as \`git -C ${WT} diff --name-only\`. A non-forced stray file -> MISMATCH the group(s) responsible, naming it.)
Per group: Tier 1 — each hunk's git diff (\`git -C ${WT} diff\`) is line-isomorphic to its ngspice hunk (zero-delta only if every +/- line is an allowed difference). Tier 2 — the whole method is a bijective construct match to the fresh v41 ngspice fn at ${MAIN}/ref/ngspice/. Re-derive identifier correspondence independently (do NOT consume rename-maps).
- MATCH -> edit ${WT}/spec/v41-port/progress.json to APPLIED for EVERY hunk in that group (hunkHash + one-line v41 file:line evidence; read the hunk + ngspice from ${MAIN}), then COMMIT EACH matched group separately in the worktree: \`git -C ${WT} add\` ONLY that group's tsFile + spec/v41-port/progress.json; message \`v41-port(${unit.name}/<functionGroup>): APPLIED [hunkIds]\`. Return the hash in committed. NEVER \`git add -A\`. Do NOT run build-ledger.mjs and do NOT add ledger.json/ledger.md — the post-merge MAIN pass regenerates them.
- MISMATCH -> leave PENDING, precise note (ngspice file:line, our file:line, what differs), committed=null.
- ESCALATE per §6/§6a (also append ${MAIN}/spec/v41-port/ESCALATIONS.md), committed=null.
Banned closing verdicts (equivalent/tolerance/pre-existing/partial) -> escalate. Do NOT run the device harness gate here. Return one result per functionGroup.`
}

function deviceGatePrompt(unit, WT, MAIN) {
  return `${wtPreamble(WT, MAIN)}

You are the DEVICE-COMPLETION GATE for "${unit.name}" (gateKind=${unit.gateKind}). Every functionGroup + recon for it is APPLIED + committed in the worktree ${WT}. Per ${MAIN}/spec/v41-port/VERIFICATION.md §1a: ${gateClause(unit, WT, MAIN)} A failure BLOCKS completion — do not wave it through (banned: settled-solver/pre-existing/tolerance). For a harness divergence, classify it (bit-identical matrix+RHS => load/compiler accumulation order) and escalate to ${MAIN}/spec/fix-list-phase-2-audit.md with evidence (step, iter, node, absDelta, matrix_diff); for a self-compare test failure, report the failing test + assertion. Dispose any harness sessions when done. Do NOT commit anything here (the teardown writes the device-complete marker in MAIN after the merge). Return pass + detail (+ firstDivergence if any).`
}

// ---- Phase Scout ----
phase('Scout')
const plan = await agent(scoutPrompt(), { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA })
let all = (plan?.units ?? [])
if (ONLY) all = all.filter((u) => ONLY.includes(u.name))
all = all.filter((u) => u.tier >= FROM_TIER)
const deferredUnits = all.filter((u) => u.deferred)
// MAX_UNITS counts PORTABLE units only — deferred units are skipped, not consumed by the cap.
const units = all.filter((u) => !u.deferred).slice(0, MAX_UNITS)
log(`Plan: ${units.length} portable unit(s): ${units.map((u) => u.name).join(' -> ')}  | ${deferredUnits.length} deferred (held back)`)

// ---- Phase Setup (preflight clean-main gate + stale-worktree sweep, then branch) ----
phase('Setup')
const pre = await agent(preflightPrompt(units.map((u) => u.name)), { label: 'preflight', phase: 'Setup', schema: PREFLIGHT_SCHEMA })
const MAIN = pre?.mainRoot
const deferredList = deferredUnits.map((u) => `${u.name}: ${u.deferReason || 'deferred'}`)
if (!MAIN) { log('ABORT: preflight returned no mainRoot'); return { aborted: 'preflight: no mainRoot', completed: [], escalated: [], gateFailed: [], deferred: deferredList } }
if (!pre.cleanMainSrc) { log(`ABORT: main src/ is dirty — commit/stash first: ${(pre.dirty || []).join(', ')}`); return { aborted: 'main src/ not clean (worktree merges require it)', dirty: pre.dirty || [], completed: [], escalated: [], gateFailed: [], deferred: deferredList } }
if (pre.frozenLeak) { log(`ABORT: frozen-construct leak in the units to port — write the NO-COUNTERPART ruling (or split the hunk) before any run:\n${pre.frozenLeakDetail || '(see preflight note)'}`); return { aborted: 'frozen-construct leak (a ruled NO-COUNTERPART construct is workable-PENDING)', frozenLeakDetail: pre.frozenLeakDetail || null, completed: [], escalated: [], gateFailed: [], deferred: deferredList } }
log(`Preflight OK. MAIN=${MAIN}; frozen-leak check clean; swept: ${pre.swept || 'none'}`)
const branchInfo = await agent(setupPrompt(), { label: 'setup-branch', phase: 'Setup' })
log(`Branch: ${branchInfo}`)

// ---- Phase Port (serial; each unit isolated in its own git worktree the MCP is repointed at) ----
phase('Port')
const summary = { completed: [], deferred: [], escalated: [], gateFailed: [], halted: null }
deferredUnits.forEach((u) => summary.deferred.push(`${u.name}: ${u.deferReason || 'deferred'}`))

for (const unit of units) {
  if (summary.halted) break
  if (unit.deferred) { summary.deferred.push(`${unit.name}: ${unit.deferReason || 'deferred'}`); log(`SKIP ${unit.name} — ${unit.deferReason || 'deferred'}`); continue }
  log(`=== ${unit.name} (tier ${unit.tier}) — ${unit.recons.length} recon(s), ${unit.groups.length} group(s) ===`)

  // Isolate this unit in its own worktree; repoint the MCP at it.
  const setup = await agent(setupWorktreePrompt(unit, MAIN), { label: `wt-setup:${unit.name}`, phase: 'Port', schema: WT_SETUP_SCHEMA })
  if (!setup?.ok || !setup.worktreePath) { summary.escalated.push(`${unit.name}: worktree setup failed — ${setup?.note || 'no result'}`); log(`WT-SETUP FAIL ${unit.name}`); continue }
  const WT = setup.worktreePath
  let committedAnything = false, unitHadEscalation = false, complete = false
  const unitEscalations = []  // {source, verdict, note} — recorded MAIN-side by teardown (the only durable sink)

  try {
    // 1. Reconstructions first (built + verified IN the worktree, gated via MCP@WT).
    if (unit.recons.length) {
      await agent(reconBuildPrompt(unit, WT, MAIN), { label: `recon-build:${unit.name}`, phase: 'Port' })
      const rv = await agent(reconVerifyPrompt(unit, WT, MAIN), { label: `recon-verify:${unit.name}`, phase: 'Port', schema: RECON_VERDICTS_SCHEMA })
      if ((rv?.results ?? []).some((r) => r.committed)) committedAnything = true
      const bad = (rv?.results ?? []).filter((r) => r.verdict !== 'MATCH')
      const missing = unit.recons.filter((r) => !(rv?.results ?? []).some((x) => x.id === r.id))
      if (bad.length || missing.length) {
        bad.forEach((r) => { summary.escalated.push(`${r.id}: ${r.verdict} — ${r.note}`); unitEscalations.push({ source: r.id, verdict: r.verdict, note: r.note || '' }) })
        missing.forEach((r) => { summary.escalated.push(`${r.id}: no verifier verdict returned`); unitEscalations.push({ source: r.id, verdict: 'NO-VERDICT', note: 'no verifier verdict returned' }) })
        unitHadEscalation = true
        log(`BLOCKED ${unit.name}: recon(s) not APPLIED — unit set aside`)
        continue
      }
    }

    // 2. functionGroups: applier -> separate-context verifier, <=3 rounds, per-group commit in WT.
    for (const batch of chunk(unit.groups, BATCH)) {
      let pending = batch.slice()
      const notes = {}
      for (let round = 1; round <= 3 && pending.length; round++) {
        await agent(applierPrompt(unit, pending, round, notes, WT, MAIN), { label: `apply:${unit.name}#r${round}(${pending.length})`, phase: 'Port' })
        const res = await agent(verifyPrompt(unit, pending, WT, MAIN), { label: `verify:${unit.name}#r${round}(${pending.length})`, phase: 'Port', schema: GROUP_VERDICTS_SCHEMA })
        if ((res?.results ?? []).some((r) => r.committed)) committedAnything = true
        const byName = new Map((res?.results ?? []).map((r) => [r.functionGroup, r]))
        const next = []
        for (const g of pending) {
          const r = byName.get(g.functionGroup)
          if (r?.verdict === 'MATCH') continue
          if (r?.verdict === 'ESCALATE') { summary.escalated.push(`${unit.name}/${g.functionGroup}: ESCALATE — ${r.note}`); unitEscalations.push({ source: `${unit.name}/${g.functionGroup}`, verdict: 'ESCALATE', note: r.note || '' }); unitHadEscalation = true; continue }
          notes[g.functionGroup] = r?.note || 'no verifier verdict returned'
          next.push(g)
        }
        pending = next
      }
      if (pending.length) { pending.forEach((g) => { summary.escalated.push(`${unit.name}/${g.functionGroup}: 3 rounds exhausted — ${notes[g.functionGroup] || 'unresolved'}`); unitEscalations.push({ source: `${unit.name}/${g.functionGroup}`, verdict: '3-ROUNDS-EXHAUSTED', note: notes[g.functionGroup] || 'unresolved' }) }); unitHadEscalation = true }
    }

    // 3. Device-completion harness gate — only if every group APPLIED this unit (gated via MCP@WT).
    if (unitHadEscalation) { log(`${unit.name}: incomplete (escalations) — gate skipped, will re-run`); continue }
    if ((unit.gateKind === 'harness' || unit.gateKind === 'self-compare') && unit.gateFixtures.length) {
      const g = await agent(deviceGatePrompt(unit, WT, MAIN), { label: `gate:${unit.name}`, phase: 'Port', schema: GATE_SCHEMA })
      if (!g?.pass) { summary.gateFailed.push(`${unit.name}: ${g?.detail} (firstDivergence ${g?.firstDivergence})`); unitEscalations.push({ source: `${unit.name} device gate`, verdict: 'GATE-FAIL', note: `${g?.detail || ''} (firstDivergence ${typeof g?.firstDivergence === 'string' ? g.firstDivergence : JSON.stringify(g?.firstDivergence)})` }); log(`GATE FAIL ${unit.name}`); continue }
    } else {
      log(`${unit.name}: gateKind=${unit.gateKind} — source-verified only, no gate this run`)
    }
    complete = true
  } finally {
    // Teardown ALWAYS runs (incl. the continue paths above, which leave complete=false).
    // merge=committedAnything: it compile-gates the worktree, ff-merges WT->MAIN, regenerates
    // the ledger + writes the device-complete marker (if complete), checks for a main-src leak,
    // and junction-safe destroys the worktree. On no committed work it just destroys.
    const td = await agent(teardownWorktreePrompt(unit, WT, MAIN, { merge: committedAnything, complete, escalations: unitEscalations }), { label: `wt-teardown:${unit.name}`, phase: 'Port', schema: WT_TEARDOWN_SCHEMA })
    if (td?.halt) { summary.halted = `${unit.name}: ${td.note}`; log(`HALT after ${unit.name}: ${td.note}`) }
    else if (td && td.nodeModulesIntact === false) { summary.halted = `${unit.name}: node_modules integrity check FAILED — ${td.note}`; log(`HALT after ${unit.name}: node_modules`) }
    else if (td?.mainSrcClean === false) { summary.halted = `${unit.name}: main src/ leak detected — ${td.note}`; log(`HALT after ${unit.name}: main-src leak`) }
  }

  if (complete && !summary.halted) { summary.completed.push(unit.name); log(`DONE ${unit.name}`) }
}

return summary
