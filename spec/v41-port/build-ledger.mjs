#!/usr/bin/env node
/*
 * build-ledger.mjs - Phase 0 hunk enumerator for the ngspice v26->v41 port.
 *
 * Enumerates EVERY git-diff hunk in the diff archives under
 *   spec/ngspice-v41-model-diffs/   and   spec/ngspice-v41-engine-diffs/
 * and composes the port ledger. The item count is derived here, by a machine,
 * so it cannot be undercounted by an agent. Total enumeration is the property
 * that makes the port loop bulletproof: every hunk is a ledger item.
 *
 * ledger.json is fully MACHINE-DERIVED. Agents never hand-edit it. It is
 * composed from three version-controlled source inputs plus prior loop state:
 *   1. the diff docs              - the hunks themselves
 *   2. splits.json                - sub-splits of partially-portable hunks
 *   3. planning/<dev>-decisions.json - per-device Phase-0 classifications
 *                                  + v26-baseline reconstruction items
 *   4. progress.json              - loop progress (APPLIED / ESCALATED / ...)
 * ledger.json holds NO native state - it is a pure function of those four
 * inputs and can be regenerated at any time.
 *
 * Modes:
 *   node build-ledger.mjs                  generate / refresh ledger.json + .md
 *   node build-ledger.mjs --check          verify item count, exit 1 on drift
 *   node build-ledger.mjs --skeleton <dev> write planning/<dev>-decisions.json
 *                                          skeleton (one stanza per file/item)
 *   node build-ledger.mjs --extract <dev>  back-fill planning/<dev>-decisions
 *                                          .json from the current ledger.json
 *
 * <dev> is a diff-doc base name, e.g. "cap", "bjt", "maths-ni".
 */

import {
  readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIFF_DIRS = [
  'spec/ngspice-v41-model-diffs',
  'spec/ngspice-v41-engine-diffs',
];
const LEDGER_JSON = join(HERE, 'ledger.json');
const LEDGER_MD = join(HERE, 'ledger.md');
const SPLITS_JSON = join(HERE, 'splits.json');
const PLANNING_DIR = join(HERE, 'planning');
const PROGRESS_JSON = join(HERE, 'progress.json');
const FROZEN_CONSTRUCTS_JSON = join(PLANNING_DIR, 'frozen-constructs.json');

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const CLASSIFICATIONS = ['PORT', 'NO-COUNTERPART', 'REVIEW-CLASS'];

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const DECISIONS_HELP =
  'Planning overlay applied by build-ledger.mjs. Per file: classification ' +
  '(PORT|NO-COUNTERPART|REVIEW-CLASS), tsFile, planningNote. Per item: state ' +
  '(PENDING|NO-COUNTERPART only - planning never sets APPLIED/ESCALATED), ' +
  'tsFunction, functionGroup (optional override), rationale (required iff ' +
  'state=NO-COUNTERPART). The optional `reconstruction` section declares ' +
  'v26-baseline reconstruction items (id must contain "#recon/"); each needs ' +
  'spec, blocks (>=1 hunk id), tsFile, tsFunction. Edit THIS file, never ' +
  'ledger.json; then re-run build-ledger.mjs.';

/* Count +/- lines in a hunk body (array of {mdLine, text}). */
function bodyStats(body) {
  let added = 0, removed = 0;
  for (const { text } of body) {
    if (text.startsWith('+') && !text.startsWith('+++')) added++;
    else if (text.startsWith('-') && !text.startsWith('---')) removed++;
  }
  return { added, removed };
}

/* Lines inside the single ```diff fence under "## Full diff", each tagged
 * with its 1-based line number in the .md file. */
function extractDiffBody(mdText, docPath) {
  const lines = mdText.split(/\r?\n/);
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```diff')) { fenceStart = i; break; }
  }
  if (fenceStart === -1) return [];
  let fenceEnd = -1;
  for (let i = fenceStart + 1; i < lines.length; i++) {
    if (lines[i] === '```') { fenceEnd = i; break; }
  }
  if (fenceEnd === -1) throw new Error(`${docPath}: unterminated \`\`\`diff fence`);
  const body = [];
  for (let i = fenceStart + 1; i < fenceEnd; i++) {
    body.push({ text: lines[i], mdLine: i + 1 });
  }
  return body;
}

/* Parse one diff doc into { files:[], items:[] }. Items carry `_body`
 * (array of {mdLine,text}) until enumerate() finalizes hash + stats. */
function parseDoc(docRelPath) {
  const docAbs = join(ROOT, docRelPath);
  const docName = basename(docRelPath, '.md');
  const body = extractDiffBody(readFileSync(docAbs, 'utf8'), docRelPath);

  const files = [];
  const items = [];
  let curFile = null;
  let curHunk = null;
  let hunkIndex = 0;

  const closeHunk = (endMdLine) => {
    if (!curHunk) return;
    curHunk.docLineRange[1] = endMdLine;
    items.push(curHunk);
    curHunk = null;
  };

  for (let idx = 0; idx < body.length; idx++) {
    const { text, mdLine } = body[idx];

    if (text.startsWith('diff --git ')) {
      closeHunk(body[idx - 1]?.mdLine ?? mdLine);
      const m = text.match(/^diff --git a\/(.+) b\/(.+)$/);
      const ngspiceFile = m ? m[2] : text.slice(11);
      curFile = { ngspiceFile, fileBase: basename(ngspiceFile), status: 'modified' };
      files.push(curFile);
      hunkIndex = 0;
      continue;
    }
    if (!curFile) continue;
    if (text.startsWith('deleted file mode')) { curFile.status = 'deleted'; continue; }
    if (text.startsWith('new file mode')) { curFile.status = 'added'; continue; }
    if (text.startsWith('rename from ') || text.startsWith('rename to ')) {
      curFile.status = 'renamed'; continue;
    }

    const hm = text.match(HUNK_RE);
    if (hm) {
      closeHunk(body[idx - 1]?.mdLine ?? mdLine);
      hunkIndex += 1;
      const oldStart = +hm[1], oldLen = hm[2] === undefined ? 1 : +hm[2];
      const newStart = +hm[3], newLen = hm[4] === undefined ? 1 : +hm[4];
      const context = hm[5].trim();
      curHunk = {
        id: `${docName}/${curFile.fileBase}#h${String(hunkIndex).padStart(3, '0')}`,
        diffDoc: docRelPath,
        ngspiceFile: curFile.ngspiceFile,
        fileStatus: curFile.status,
        hunkIndex,
        hunkHeader: text,
        oldStart, oldLen, newStart, newLen,
        enclosingContext: context,
        functionGroup: `${docName}/${curFile.fileBase}::${context || `@${oldStart}`}`,
        isSubItem: false,
        parentHunk: null,
        addedLines: 0,
        removedLines: 0,
        docLineRange: [mdLine, mdLine],
        hunkHash: null,
        // ---- single-field state machine ----
        //  PENDING        awaiting application
        //  NO-COUNTERPART set by a decisions overlay (planning); frozen
        //  APPLIED        set by the verifier; carried by content-hash merge
        //  ESCALATED      blocks the job; carried by content-hash merge
        //  STALE          was APPLIED/ESCALATED but the hunk/spec hash drifted;
        //                 build-derived in applyProgress (never set by an
        //                 overlay/progress entry); needs re-verify, not re-port;
        //                 blocks the job like ESCALATED
        state: 'PENDING',
        tsFunction: null,           // from the decisions overlay
        attempts: 0,
        verifierNotes: [],
        rationale: null,            // from the decisions overlay (NO-COUNTERPART)
        escalation: null,           // loop state; required when ESCALATED
        _body: [{ mdLine, text }],  // dropped after finalize
      };
      continue;
    }

    if (curHunk) {
      curHunk._body.push({ mdLine, text });
      curHunk.docLineRange[1] = mdLine;
    }
  }
  closeHunk(body[body.length - 1]?.mdLine ?? 0);

  const fileMap = new Map();
  for (const f of files) {
    if (!fileMap.has(f.ngspiceFile)) {
      fileMap.set(f.ngspiceFile, {
        diffDoc: docRelPath,
        ngspiceFile: f.ngspiceFile,
        status: f.status,
        hunks: 0,
        classification: null,   // from the decisions overlay
        tsFile: null,           // from the decisions overlay
        planningNote: null,     // from the decisions overlay
      });
    }
  }
  return { files: [...fileMap.values()], items };
}

/* Expand split hunks into sub-items. Hard-errors unless the sub-ranges
 * exactly tile the parent hunk's docLineRange. */
function applySplits(items, splits) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const hid of Object.keys(splits)) {
    if (!byId.has(hid)) {
      throw new Error(`splits.json: hunk id "${hid}" matches no enumerated hunk`);
    }
  }
  const out = [];
  for (const it of items) {
    const spec = splits[it.id];
    if (!spec) { out.push(it); continue; }
    const subs = spec.subItems;
    if (!Array.isArray(subs) || subs.length < 2) {
      throw new Error(`splits.json: "${it.id}" needs >= 2 subItems`);
    }
    const sorted = [...subs].sort((a, b) => a.docLineRange[0] - b.docLineRange[0]);
    const [P0, P1] = it.docLineRange;
    if (sorted[0].docLineRange[0] !== P0) {
      throw new Error(`splits.json: "${it.id}" first sub-range must start at parent line ${P0}`);
    }
    if (sorted[sorted.length - 1].docLineRange[1] !== P1) {
      throw new Error(`splits.json: "${it.id}" last sub-range must end at parent line ${P1}`);
    }
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].docLineRange[0] !== sorted[k - 1].docLineRange[1] + 1) {
        throw new Error(`splits.json: "${it.id}" sub-ranges must tile with no gap or overlap (sub ${k - 1} -> ${k})`);
      }
    }
    const seenSuffix = new Set();
    for (const sub of sorted) {
      if (!sub.suffix || seenSuffix.has(sub.suffix)) {
        throw new Error(`splits.json: "${it.id}" sub-items need unique non-empty suffixes`);
      }
      seenSuffix.add(sub.suffix);
      const [s0, s1] = sub.docLineRange;
      const slice = it._body.filter((e) => e.mdLine >= s0 && e.mdLine <= s1);
      if (slice.length === 0) {
        throw new Error(`splits.json: "${it.id}" sub "${sub.suffix}" range [${s0},${s1}] covers no lines`);
      }
      out.push({
        ...it,
        id: `${it.id}${sub.suffix}`,
        isSubItem: true,
        parentHunk: it.id,
        docLineRange: [s0, s1],
        _body: slice,
      });
    }
  }
  return out;
}

function discoverDocs() {
  const docs = [];
  for (const dir of DIFF_DIRS) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (name.endsWith('.md') && name !== 'README.md') docs.push(`${dir}/${name}`);
    }
  }
  return docs;
}

/* Enumerate diffs + apply splits + finalize hash/stats. No decisions, no
 * loop-state merge - the raw structural ledger. */
function enumerate() {
  const allFiles = [];
  const parsedItems = [];
  for (const doc of discoverDocs()) {
    const { files, items } = parseDoc(doc);
    allFiles.push(...files);
    parsedItems.push(...items);
  }
  const parentHunkCount = parsedItems.length;

  const splitsFile = existsSync(SPLITS_JSON)
    ? JSON.parse(readFileSync(SPLITS_JSON, 'utf8'))
    : { splits: {} };
  const items = applySplits(parsedItems, splitsFile.splits ?? {});

  for (const it of items) {
    const { added, removed } = bodyStats(it._body);
    it.addedLines = added;
    it.removedLines = removed;
    it.hunkHash = sha(it._body.map((e) => e.text).join('\n'));
    delete it._body;
  }
  const fileByName = new Map(allFiles.map((f) => [f.ngspiceFile, f]));
  for (const it of items) fileByName.get(it.ngspiceFile).hunks++;

  return { files: allFiles, items, parentHunkCount };
}

/* Read every planning/*-decisions.json into { files:Map, items:Map, recon:Map }. */
function loadDecisions() {
  const files = new Map(), items = new Map(), recon = new Map();
  const docs = [];
  if (!existsSync(PLANNING_DIR)) return { files, items, recon, docs };
  for (const name of readdirSync(PLANNING_DIR).sort()) {
    if (!name.endsWith('-decisions.json')) continue;
    docs.push(name);
    const d = JSON.parse(readFileSync(join(PLANNING_DIR, name), 'utf8'));
    for (const [k, v] of Object.entries(d.files ?? {})) files.set(k, { ...v, _src: name });
    for (const [k, v] of Object.entries(d.items ?? {})) items.set(k, { ...v, _src: name });
    for (const [k, v] of Object.entries(d.reconstruction ?? {})) {
      recon.set(k, { ...v, _src: name, _diffDoc: d.diffDoc });
    }
  }
  return { files, items, recon, docs };
}

/* Turn declared reconstruction entries (the decisions-overlay `reconstruction`
 * section) into ledger items. A reconstruction item is a v26-baseline gap:
 * digiTS never ported the v26 function the v41 hunks build on, so it must be
 * reconstructed to faithful v26 parity before those hunks can apply. It is not
 * a diff hunk - it has kind:"reconstruction", no docLineRange, and a `spec`
 * pointer. Its hash is taken over the spec text, so a post-APPLIED spec edit
 * goes stale exactly as a post-APPLIED hunk edit does. */
function buildReconstructionItems(reconMap) {
  const out = [];
  for (const [id, r] of reconMap) {
    if (!id.includes('#recon/')) {
      throw new Error(`${r._src}: reconstruction id "${id}" must contain "#recon/"`);
    }
    if (!r.spec || !String(r.spec).trim()) {
      throw new Error(`${r._src}: reconstruction "${id}" needs a spec path`);
    }
    if (!Array.isArray(r.blocks) || r.blocks.length === 0) {
      throw new Error(`${r._src}: reconstruction "${id}" needs a non-empty blocks list`);
    }
    if (r.state !== undefined && r.state !== null && r.state !== 'PENDING') {
      throw new Error(`${r._src}: reconstruction "${id}" state must be PENDING (planning never sets APPLIED/ESCALATED)`);
    }
    const specAbs = join(ROOT, r.spec);
    const specText = existsSync(specAbs) ? readFileSync(specAbs, 'utf8') : '';
    out.push({
      id,
      kind: 'reconstruction',
      diffDoc: r._diffDoc ?? null,
      ngspiceFile: null,
      ngspiceBaseline: r.ngspiceBaseline ?? [],
      fileStatus: null,
      hunkIndex: 0,
      hunkHeader: null,
      functionGroup: r.functionGroup ?? id,
      isSubItem: false,
      parentHunk: null,
      blockedBy: null,
      addedLines: 0,
      removedLines: 0,
      docLineRange: null,
      title: r.title ?? null,
      spec: r.spec,
      specExists: specText !== '',
      // A recon may edit several production files; the overlay declares `tsFiles` (array).
      // `tsFile` is kept as the primary (tsFiles[0]) for the md table + --extract back-compat;
      // the port-loop driver's file-scope guard reads the `tsFiles` array.
      tsFile: r.tsFile ?? (Array.isArray(r.tsFiles) ? (r.tsFiles[0] ?? null) : null),
      tsFiles: Array.isArray(r.tsFiles) ? r.tsFiles : (r.tsFile ? [r.tsFile] : []),
      tsFunction: r.tsFunction ?? null,
      blocks: r.blocks,
      hunkHash: sha(`reconstruction:${id}:${specText}`),
      state: 'PENDING',
      attempts: 0,
      verifierNotes: [],
      rationale: null,
      escalation: null,
    });
  }
  return out;
}

/* Apply the planning decisions overlay onto enumerated items/files.
 * Validates every key and value; planning may only set state PENDING or
 * NO-COUNTERPART. */
function applyDecisions(items, files, decisions) {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const fileByName = new Map(files.map((f) => [f.ngspiceFile, f]));

  for (const [id, d] of decisions.items) {
    const it = itemById.get(id);
    if (!it) throw new Error(`${d._src}: item id "${id}" matches no ledger item`);
    if (d.state !== undefined && d.state !== null
        && d.state !== 'PENDING' && d.state !== 'NO-COUNTERPART') {
      throw new Error(`${d._src}: item "${id}" state must be PENDING or NO-COUNTERPART (planning never sets APPLIED/ESCALATED)`);
    }
    if (d.state === 'NO-COUNTERPART' && !(d.rationale && String(d.rationale).trim())) {
      throw new Error(`${d._src}: item "${id}" is NO-COUNTERPART but has no rationale`);
    }
    if (d.state) it.state = d.state;
    if (d.tsFunction !== undefined) it.tsFunction = d.tsFunction;
    if (d.functionGroup !== undefined && d.functionGroup !== null) it.functionGroup = d.functionGroup;
    if (d.rationale !== undefined) it.rationale = d.rationale;
  }
  for (const [name, d] of decisions.files) {
    const f = fileByName.get(name);
    if (!f) throw new Error(`${d._src}: file "${name}" matches no diffed ngspice file`);
    if (d.classification !== undefined && d.classification !== null
        && !CLASSIFICATIONS.includes(d.classification)) {
      throw new Error(`${d._src}: file "${name}" classification "${d.classification}" invalid`);
    }
    if (d.classification !== undefined) f.classification = d.classification;
    if (d.tsFile !== undefined) f.tsFile = d.tsFile;
    if (d.planningNote !== undefined) f.planningNote = d.planningNote;
  }
}

/* Read the loop-progress overlay (progress.json) into a Map. */
function loadProgress() {
  const items = new Map();
  if (!existsSync(PROGRESS_JSON)) return items;
  const p = JSON.parse(readFileSync(PROGRESS_JSON, 'utf8'));
  for (const [k, v] of Object.entries(p.items ?? {})) items.set(k, v);
  return items;
}

/* Apply loop progress onto items. The loop's verifier records APPLIED here;
 * the applier/verifier record ESCALATED and attempts here. ledger.json is
 * never hand-edited. An entry carries the `hunkHash` it was recorded against.
 *
 * STALE HANDLING. If the recorded hunkHash no longer matches the item's
 * current hash, the underlying diff hunk or reconstruction spec has drifted
 * since the entry was recorded. A recorded APPLIED/ESCALATED entry is NOT
 * silently reverted to raw PENDING (the old behavior — it made a re-verified
 * item indistinguishable from a never-started one, so the loop re-PORTED it
 * from scratch; this is the hole that re-ran vsrc 4x). Instead the item is set
 * to STALE: previously decided, basis drifted, needs a CHEAP RE-VERIFY — confirm
 * the current code still matches current v41 and re-record APPLIED with the
 * fresh hash, or, if it no longer matches, let it fall to a real port. STALE
 * carries the prior verifierNotes/escalation and the state it drifted from, and
 * is reported BY NAME (never a silent count). A drifted bare entry (no
 * APPLIED/ESCALATED — only attempts/notes on a still-PENDING item) has nothing
 * worth preserving and is dropped as before. */
function applyProgress(items, progress) {
  const byId = new Map(items.map((i) => [i.id, i]));
  let applied = 0;
  const staleItems = [];
  for (const [id, p] of progress) {
    const it = byId.get(id);
    if (!it) throw new Error(`progress.json: item id "${id}" matches no ledger item`);
    if (it.state === 'NO-COUNTERPART') {
      throw new Error(`progress.json: item "${id}" is NO-COUNTERPART (planning-frozen); the loop must not touch it`);
    }
    if (p.state !== undefined && p.state !== null
        && !['PENDING', 'APPLIED', 'ESCALATED'].includes(p.state)) {
      throw new Error(`progress.json: item "${id}" state "${p.state}" invalid (PENDING|APPLIED|ESCALATED)`);
    }
    if (p.hunkHash && p.hunkHash !== it.hunkHash) {
      // Drift. A recorded decision (APPLIED/ESCALATED) becomes STALE so it is
      // re-verified, not silently re-ported. A bare PENDING entry is dropped.
      if (p.state === 'APPLIED' || p.state === 'ESCALATED') {
        it.state = 'STALE';
        it.staleFrom = p.state;
        it.staleHash = p.hunkHash;
        if (p.verifierNotes !== undefined) it.verifierNotes = p.verifierNotes;
        if (p.escalation !== undefined) it.escalation = p.escalation;
        staleItems.push({ id, from: p.state });
      }
      continue;
    }
    if (p.state) it.state = p.state;
    if (p.attempts !== undefined) it.attempts = p.attempts;
    if (p.verifierNotes !== undefined) it.verifierNotes = p.verifierNotes;
    if (p.escalation !== undefined) it.escalation = p.escalation;
    if (it.state === 'ESCALATED' && !it.escalation) {
      throw new Error(`progress.json: item "${id}" is ESCALATED but has no escalation detail`);
    }
    applied++;
  }
  return { applied, staleItems };
}

function build() {
  const { files, items, parentHunkCount } = enumerate();
  for (const it of items) { it.kind = 'hunk'; it.blockedBy = null; }
  const decisions = loadDecisions();
  applyDecisions(items, files, decisions);

  const reconItems = buildReconstructionItems(decisions.recon);
  const hunkIds = new Set(items.map((i) => i.id));
  for (const r of reconItems) {
    if (hunkIds.has(r.id)) {
      throw new Error(`reconstruction id "${r.id}" collides with a hunk id`);
    }
  }
  const allItems = [...items, ...reconItems];
  const byId = new Map(allItems.map((i) => [i.id, i]));
  // Wire blockedBy: every hunk a reconstruction item names in `blocks` is
  // blocked until that item is APPLIED. The loop must not apply a blocked hunk.
  for (const r of reconItems) {
    for (const hid of r.blocks) {
      const h = byId.get(hid);
      if (!h) throw new Error(`reconstruction "${r.id}": blocks id "${hid}" matches no ledger item`);
      if (h.kind !== 'hunk') throw new Error(`reconstruction "${r.id}": blocks id "${hid}" is not a hunk`);
      h.blockedBy = r.id;
    }
  }

  const progress = applyProgress(allItems, loadProgress());

  return {
    meta: {
      generated: new Date().toISOString(),
      base: '032b1c32 (ngspice master @ 2015-03-08, version-string 26)',
      target: 'ngspice-41 tag (2275fb85d)',
      diffDocs: discoverDocs().length,
      ngspiceFiles: files.length,
      parentHunks: parentHunkCount,
      totalItems: allItems.length,
      subItems: allItems.filter((i) => i.isSubItem).length,
      reconstructionItems: reconItems.length,
      decisionsOverlays: decisions.docs.length,
      totalAdded: allItems.reduce((n, i) => n + i.addedLines, 0),
      totalRemoved: allItems.reduce((n, i) => n + i.removedLines, 0),
      progressEntriesApplied: progress.applied,
      progressEntriesStale: progress.staleItems.length,
      staleItems: progress.staleItems,
    },
    files,
    items: allItems,
  };
}

function renderMd(ledger) {
  const byDoc = new Map();
  for (const it of ledger.items) {
    if (!byDoc.has(it.diffDoc)) byDoc.set(it.diffDoc, []);
    byDoc.get(it.diffDoc).push(it);
  }
  const tally = (pred) => ledger.items.filter(pred).length;
  let md = `# v41 port ledger - coverage summary

Generated: ${ledger.meta.generated}
Base: ${ledger.meta.base}
Target: ${ledger.meta.target}

- Diff docs: **${ledger.meta.diffDocs}**
- ngspice files touched: **${ledger.meta.ngspiceFiles}**
- Parent hunks enumerated: **${ledger.meta.parentHunks}**
- v26-baseline reconstruction items: **${ledger.meta.reconstructionItems}**
- Ledger items (hunks + sub-items + reconstruction): **${ledger.meta.totalItems}** (${ledger.meta.subItems} sub-items, ${ledger.meta.reconstructionItems} reconstruction)
- Planning decisions overlays applied: **${ledger.meta.decisionsOverlays}**
- Lines: +${ledger.meta.totalAdded} / -${ledger.meta.totalRemoved}

ledger.json is machine-derived: diffs + splits.json + planning/*-decisions.json,
with loop progress carried by content-hash merge. Do not hand-edit it.

## State tally

| State | Count |
|---|---|
| PENDING        | ${tally((i) => i.state === 'PENDING')} |
| APPLIED        | ${tally((i) => i.state === 'APPLIED')} |
| ESCALATED      | ${tally((i) => i.state === 'ESCALATED')} |
| STALE          | ${tally((i) => i.state === 'STALE')} |
| NO-COUNTERPART | ${tally((i) => i.state === 'NO-COUNTERPART')} |

A ralph **run** ends at PENDING = 0. The **job** is done only when every item
is APPLIED or NO-COUNTERPART (no PENDING, no ESCALATED, no STALE). A STALE item
was APPLIED/ESCALATED but its diff hunk or recon spec drifted; it needs a cheap
re-verify (re-confirm vs current v41 → re-record APPLIED with the fresh hash),
never a full re-port.

## Per-doc item counts

| Diff doc | ngspice files | Items |
|---|---|---|
`;
  for (const [doc, items] of byDoc) {
    const nf = new Set(items.map((i) => i.ngspiceFile)).size;
    md += `| ${doc} | ${nf} | ${items.length} |\n`;
  }
  md += `\n## Per-file item counts\n\n`;
  md += `| ngspice file | status | items | classification | tsFile |\n|---|---|---|---|---|\n`;
  for (const f of ledger.files) {
    md += `| ${f.ngspiceFile} | ${f.status} | ${f.hunks} | ${f.classification ?? '_TBD_'} | ${f.tsFile ?? '_TBD_'} |\n`;
  }
  return md;
}

/* --skeleton <dev>: write a planning/<dev>-decisions.json skeleton, one
 * stanza per file and item, preserving any values already filled in. */
function writeSkeleton(device) {
  const { files, items } = enumerate();
  const devItems = items.filter((i) => basename(i.diffDoc, '.md') === device);
  if (devItems.length === 0) throw new Error(`--skeleton: no diff doc named "${device}.md"`);
  const diffDoc = devItems[0].diffDoc;
  const devFiles = files.filter((f) => f.diffDoc === diffDoc);
  const path = join(PLANNING_DIR, `${device}-decisions.json`);
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { files: {}, items: {} };

  const out = {
    device, diffDoc, _help: DECISIONS_HELP,
    files: {}, items: {}, reconstruction: prior.reconstruction ?? {},
  };
  for (const f of devFiles) {
    out.files[f.ngspiceFile] = prior.files?.[f.ngspiceFile]
      ?? { classification: null, tsFile: null, planningNote: null };
  }
  for (const it of devItems) {
    out.items[it.id] = prior.items?.[it.id]
      ?? { state: 'PENDING', tsFunction: null, functionGroup: it.functionGroup, rationale: null };
  }
  mkdirSync(PLANNING_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${path}: ${devFiles.length} files, ${devItems.length} items`);
}

/* --extract <dev>: back-fill planning/<dev>-decisions.json from the planning
 * fields already present in the current ledger.json (one-off migration of a
 * device classified before the decisions overlay existed). */
function extractDecisions(device) {
  if (!existsSync(LEDGER_JSON)) throw new Error('--extract: ledger.json missing');
  const ledger = JSON.parse(readFileSync(LEDGER_JSON, 'utf8'));
  const devItems = ledger.items.filter((i) => basename(i.diffDoc, '.md') === device);
  if (devItems.length === 0) throw new Error(`--extract: no items for device "${device}"`);
  const diffDoc = devItems[0].diffDoc;
  const devFiles = ledger.files.filter((f) => f.diffDoc === diffDoc);

  const out = {
    device, diffDoc, _help: DECISIONS_HELP,
    files: {}, items: {}, reconstruction: {},
  };
  for (const it of ledger.items.filter((i) => i.kind === 'reconstruction'
      && basename(i.diffDoc ?? '', '.md') === device)) {
    out.reconstruction[it.id] = {
      title: it.title, spec: it.spec, ngspiceBaseline: it.ngspiceBaseline,
      tsFile: it.tsFile, tsFiles: it.tsFiles ?? (it.tsFile ? [it.tsFile] : []), tsFunction: it.tsFunction,
      functionGroup: it.functionGroup, blocks: it.blocks, state: 'PENDING',
    };
  }
  for (const f of devFiles) {
    out.files[f.ngspiceFile] = {
      classification: f.classification,
      tsFile: f.tsFile,
      planningNote: f.planningNote,
    };
  }
  for (const it of devItems) {
    const e = {
      state: it.state === 'NO-COUNTERPART' ? 'NO-COUNTERPART' : 'PENDING',
      tsFunction: it.tsFunction,
      functionGroup: it.functionGroup,
      rationale: null,
    };
    if (it.state === 'NO-COUNTERPART') e.rationale = it.rationale;
    out.items[it.id] = e;
  }
  mkdirSync(PLANNING_DIR, { recursive: true });
  const path = join(PLANNING_DIR, `${device}-decisions.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`Extracted ${path}: ${devFiles.length} files, ${devItems.length} items`);
}

/* ---- Frozen-construct backstop ----
 * A construct-class the project has ruled NO-COUNTERPART must never be silently
 * re-escalated by sitting workable-PENDING in the ledger (the hole that let
 * TRNOISE re-escalate 4x). frozen-constructs.json declares the ruled classes;
 * this checks that NO workable-PENDING hunk's ADDED/changed diff lines match a
 * frozen token. It DETECTS + FAILS LOUDLY only -- it never writes a ruling.
 *
 * WORKABLE-PENDING (the set the loop would actually attempt this run): an item
 * that is state PENDING, has a mapped tsFunction (a src/*.ts path the scout can
 * extract as a workable group), and is NOT blocked by an unbuilt reconstruction
 * (blockedBy null, or the blocking recon is APPLIED). A NO-COUNTERPART item, an
 * unmapped item (tsFunction null), or a recon-blocked item is NOT workable and
 * is not checked -- only a hunk the loop would feed an applier can leak. */

// A C-preprocessor directive line (the diff sign is char 0). A removed/added
// `#ifdef XSPICE` / `#include "..."` guard is scaffolding the hunk moves or
// strips, NOT a behavioral construct an applier must reproduce in TS — matching
// it is the false-positive class (a portable hunk that merely un-guards a member
// sits next to an `#ifdef XSPICE` line). Excluded from the token scan.
const CPP_DIRECTIVE_RE = /^[+\-]\s*#\s*(if|ifdef|ifndef|else|elif|endif|include|define|undef|pragma)\b/;
const squash = (s) => s.replace(/\s+/g, '');

/* A token matches a hunk only when it is the hunk's NEW v41 content — the lines
 * an applier would have to reproduce in TS. Precisely: the token appears on an
 * ADDED ('+') line that is (a) not a C-preprocessor directive and (b) not a
 * pure reformat/rename of a pre-existing line (the same token-bearing body also
 * present on a '-' line — e.g. `IFerrorf (`->`IFerrorf(` whitespace, which adds
 * no new construct). This is the "ADDED/changed diff lines, not surrounding
 * context" rule the backstop requires; a frozen token sitting only in unchanged
 * context (a `case TRNOISE:` label) or on a stripped `#ifdef` does NOT match.
 * Re-derived from the diff doc + the item's docLineRange so a split sub-item is
 * sliced to its own range; reuses extractDiffBody (the same fence reader the
 * enumerator uses) rather than duplicating the parse. */
function tokensInHunkAdditions(item, tokens, docBodyCache) {
  if (item.kind !== 'hunk' || !item.diffDoc || !Array.isArray(item.docLineRange)) return null;
  let body = docBodyCache.get(item.diffDoc);
  if (!body) {
    const docAbs = join(ROOT, item.diffDoc);
    body = extractDiffBody(readFileSync(docAbs, 'utf8'), item.diffDoc);
    docBodyCache.set(item.diffDoc, body);
  }
  const [s, e] = item.docLineRange;
  const added = [], removedSquashed = [];
  for (const { text, mdLine } of body) {
    if (mdLine < s || mdLine > e) continue;
    if (text.startsWith('+') && !text.startsWith('+++')) added.push(text);
    else if (text.startsWith('-') && !text.startsWith('---')) removedSquashed.push(squash(text.slice(1)));
  }
  for (const line of added) {
    if (CPP_DIRECTIVE_RE.test(line)) continue;
    const bodySquashed = squash(line.slice(1));
    for (const tk of tokens) {
      if (!line.includes(tk)) continue;
      // reformat/rename of a pre-existing line carrying the same token -> not new content
      if (removedSquashed.includes(bodySquashed)) continue;
      return tk;
    }
  }
  return null;
}

function loadFrozenConstructs() {
  if (!existsSync(FROZEN_CONSTRUCTS_JSON)) {
    throw new Error(`frozen-constructs.json missing at ${FROZEN_CONSTRUCTS_JSON}`);
  }
  const f = JSON.parse(readFileSync(FROZEN_CONSTRUCTS_JSON, 'utf8'));
  const constructs = Array.isArray(f.constructs) ? f.constructs : [];
  for (const c of constructs) {
    if (!c.id) throw new Error('frozen-constructs.json: a construct has no id');
    const tokens = c.match?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new Error(`frozen-constructs.json: construct "${c.id}" has no match.tokens`);
    }
  }
  return constructs;
}

/* Units the scout NEVER feeds an applier (frozen engine-phase re-plan #8/#61):
 * the SPICE-deck card readers + expression engine of the parser. Their hunks
 * still carry a mapped tsFunction + PENDING state in the ledger, so they read as
 * "workable" structurally, but the loop's scout holds the whole parser unit back
 * (the only emitted parser work is `parser#recon/nodeAllocOrder` + its 4 blocked
 * compiler.ts hunks). A unit the loop will not attempt cannot silently
 * re-escalate, so it is out of the backstop's workable set. This list mirrors
 * the scout's frozen-defer rule in v41-port-loop.workflow.mjs; keep them in sync. */
const LOOP_DEFERRED_UNITS = new Set(['parser']);

/* Returns the list of leaks: { hunkId, unit, constructId, token }. Empty = clean.
 * `onlyUnits` (optional Set) restricts the scan to those units — used by the
 * port-loop driver preflight to check just the units it is about to port. */
function detectFrozenLeaks(ledger, constructs, onlyUnits = null) {
  const byId = new Map(ledger.items.map((i) => [i.id, i]));
  const reconState = (id) => byId.get(id)?.state ?? null;
  const unitOf = (it) => basename(it.diffDoc, '.md');
  const isWorkablePending = (it) => {
    if (it.kind !== 'hunk') return false;
    if (it.state !== 'PENDING') return false;
    // mapped tsFunction: a src/*.ts path the scout can extract as a workable group
    if (!it.tsFunction || !/src\/[^\s]+\.ts/.test(String(it.tsFunction))) return false;
    // not blocked by an unbuilt reconstruction
    if (it.blockedBy && reconState(it.blockedBy) !== 'APPLIED') return false;
    // not a unit the loop holds back wholesale (cannot re-escalate if never attempted)
    if (LOOP_DEFERRED_UNITS.has(unitOf(it))) return false;
    if (onlyUnits && !onlyUnits.has(unitOf(it))) return false;
    return true;
  };
  const docBodyCache = new Map();
  const leaks = [];
  for (const it of ledger.items) {
    if (!isWorkablePending(it)) continue;
    for (const c of constructs) {
      const token = tokensInHunkAdditions(it, c.match.tokens, docBodyCache);
      if (token) {
        leaks.push({ hunkId: it.id, unit: unitOf(it), constructId: c.id, token });
        break; // one construct per hunk is enough to fail
      }
    }
  }
  return leaks;
}

/* Build the ledger and assert no frozen-construct leak. Returns the leak list
 * (caller decides exit code) and prints each leak. Reused by --check (global)
 * and the port-loop driver preflight (which shells out to
 * `build-ledger.mjs --check-frozen <unit...>` scoped to the units it ports). */
function checkFrozenLeaks(ledger, onlyUnits = null) {
  const constructs = loadFrozenConstructs();
  const leaks = detectFrozenLeaks(ledger, constructs, onlyUnits);
  for (const lk of leaks) {
    console.error(`FROZEN-CONSTRUCT LEAK: ${lk.hunkId} in ${lk.unit} is workable-PENDING but matches frozen construct ${lk.constructId} (token "${lk.token}") — write its NO-COUNTERPART ruling into the overlay (or split it) before any loop run.`);
  }
  return leaks;
}

// ---- main ----
const args = process.argv.slice(2);
if (args[0] === '--skeleton') {
  if (!args[1]) { console.error('--skeleton needs a device name'); process.exit(1); }
  writeSkeleton(args[1]);
} else if (args[0] === '--extract') {
  if (!args[1]) { console.error('--extract needs a device name'); process.exit(1); }
  extractDecisions(args[1]);
} else if (args[0] === '--check-frozen') {
  // Frozen-leak check ONLY, optionally scoped to named units (the port-loop
  // driver preflight shells out to this for the units it is about to port).
  // No item-count drift check; no ledger write. Exits nonzero on any leak.
  const onlyUnits = args.slice(1).length ? new Set(args.slice(1)) : null;
  const ledger = build();
  const leaks = checkFrozenLeaks(ledger, onlyUnits);
  const scope = onlyUnits ? ` in [${[...onlyUnits].join(', ')}]` : '';
  console.log(leaks.length
    ? `FAIL: ${leaks.length} frozen-construct leak(s)${scope}`
    : `OK: no frozen-construct leaks${scope}`);
  process.exit(leaks.length ? 1 : 0);
} else if (args.includes('--check')) {
  if (!existsSync(LEDGER_JSON)) { console.error('ledger.json missing'); process.exit(1); }
  const onDisk = JSON.parse(readFileSync(LEDGER_JSON, 'utf8'));
  const ledger = build();
  const drift = onDisk.meta.totalItems !== ledger.meta.totalItems;
  if (drift) {
    console.log(`DRIFT: on-disk ${onDisk.meta.totalItems} items, recomputed ${ledger.meta.totalItems}`);
  }
  // Frozen-construct backstop: a ruled NO-COUNTERPART construct must never sit
  // workable-PENDING (the hole that let TRNOISE re-escalate 4x). Fails --check.
  const leaks = checkFrozenLeaks(ledger);
  if (!drift && leaks.length === 0) {
    console.log(`OK: ${ledger.meta.totalItems} items`);
  } else if (leaks.length) {
    console.log(`FAIL: ${leaks.length} frozen-construct leak(s)${drift ? ' + item-count drift' : ''}`);
  }
  process.exit((drift || leaks.length) ? 1 : 0);
} else {
  const ledger = build();
  writeFileSync(LEDGER_JSON, JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(LEDGER_MD, renderMd(ledger));
  console.log('Wrote ledger.json + ledger.md');
  console.log(`  ${ledger.meta.parentHunks} parent hunks -> ${ledger.meta.totalItems} items (${ledger.meta.subItems} sub-items) across ${ledger.meta.ngspiceFiles} files`);
  console.log(`  decisions overlays: ${ledger.meta.decisionsOverlays}; progress entries: ${ledger.meta.progressEntriesApplied} applied, ${ledger.meta.progressEntriesStale} STALE (need re-verify, not re-port)`);
  if (ledger.meta.staleItems.length) {
    console.log('  STALE items (was-verified, basis drifted — re-verify these, do NOT re-port):');
    for (const s of ledger.meta.staleItems) console.log(`    - ${s.id} (was ${s.from})`);
  }
}
