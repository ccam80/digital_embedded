# Wire-It-Up List

Features that are **built and tested but never connected to the production app**. Each
surfaced as "test-only exports" in `scripts/dead-code-analysis.ts` — exported symbols
whose only cross-file importers are tests, because no production code path reaches them.

These are NOT dead code to delete: the implementations exist, are unit-tested, and were
clearly intended to ship. They just lack the final wiring into the app entry points.

Verification method for each entry: searched all of `src/**` (excluding the feature's own
directory and `__tests__`) plus the HTML entry points for any production reference, and
checked `git log -S` for whether a wiring import ever existed.

---

## 1. i18n — internationalization / UI translation

**Status:** completely dormant. Zero production references, ever.

**What exists**
- `src/i18n/index.ts` (174 lines): locale-aware string lookup — dot-path keys
  (`menu.file.open`), `{param}` interpolation, fallback chain (active locale → English →
  the key itself), `setLocale()` / `getLocale()` / `onLocaleChange()` callbacks, in-memory
  locale cache. Locale JSON loaded via Vite dynamic `import('./locales/{locale}.json')`.
- `src/i18n/locales/`: `en.json`, `de.json` (German), `zh.json` (Chinese) — ~4 KB each.
  English covers the entire UI surface (menus, toolbar, every component name, all dialogs,
  errors, status messages, property labels, keyboard, analysis, library).
- Tests: `i18n.test.ts`, `i18n-full.test.ts`, `translations.test.ts`.

**Evidence of non-wiring**
- Analyzer flags every export test-only.
- Grep: only `index.ts` + its 3 test files reference any i18n symbol.
- `git log -S "from './i18n'"` over `src/`: zero production import in history.
- UI still hard-codes English (e.g. `menu-toolbar.ts` builds literal labels).

**Wire-up task**
1. Call `initializeI18n()` at app startup (`app-init.ts` / `main.ts`).
2. Add a language selector — the Settings dialog locale data already has a `dialogs.settings.language`
   key, so this was the plan. Wire it to `setLocale()`.
3. Route UI strings through `i18n('...')` instead of literals — menus (`menu-toolbar.ts`),
   dialogs, component-palette labels, error/status messages. (Largest part; touches every
   string site.)
4. Subscribe to `onLocaleChange()` to re-render labels on locale switch.

---

## 2. FSM — finite-state-machine editor

**Status:** unwired at the app layer. No menu, dialog, or HTML entry opens it.

**What exists**
- `src/fsm/editor.ts` (`FSMEditor`) — UI controller for editing state machines.
- `src/fsm/state-dialog.ts`, `transition-dialog.ts` — its editing dialogs.
- `src/fsm/fsm-renderer.ts`, `fsm-hit-test.ts` — drawing + interaction.
- `src/fsm/circuit-gen.ts` (`fsmToCircuit`) — generates a logic circuit from an FSM.
- `src/fsm/fsm-import.ts` (`importDigitalFSM`) — imports an FSM from a digital circuit.
- `src/fsm/optimizer.ts`, `fsm-serializer.ts`, `auto-layout.ts`, `state-encoding.ts`,
  `table-creator.ts`, `model.ts` — supporting logic.
- Tests across most of the above.

**Evidence of non-wiring**
- Grep for `fsm` / `FSM` across `src/app/**/*.ts`: **no matches** — `app-init.ts`,
  `analysis-dialogs.ts`, `menu-toolbar.ts` never reference it.
- No FSM HTML entry page (only `app/tutorial/*.html` + root `index.html` exist).
- `en.json` has `analysis.stateTransition = "State Transition"`, suggesting an Analysis-menu
  entry was intended — but it's not built.

**Wire-up task**
1. Add an entry point — most naturally an Analysis/Tools menu item (sibling to the Karnaugh
   map tab in `analysis-dialogs.ts`) that opens `FSMEditor`.
2. Host surface decision: dedicated panel/canvas vs. dialog. Instantiate `FSMEditor`,
   connect `fsm-renderer` + the state/transition dialogs.
3. Connect `fsmToCircuit` output back into the main editor (place the generated circuit),
   and expose `importDigitalFSM` for the reverse direction.

---

## 3. Generic (parameterized) circuit resolution

**Status:** built and fully tested, but the load pipeline never invokes it.

**What exists**
- `src/io/resolve-generics.ts` — a port of Digital's `ResolveGenerics.java`. For a circuit
  with `isGeneric: true`, executes its `GenericInitCode`/`GenericCode` HGS scripts to
  parameterize the circuit at load (bake in widths, counts, generated structure).
  Exports `isGenericCircuit`, `resolveGenericCircuit`, `GenericResolutionCache`.
- `src/io/generic-cache.ts` — `GenericCache`, `computeGenericCacheKey` (caches resolved
  circuits by argument hash).

**Evidence of non-wiring**
- Analyzer flags every export orphan (test-only); confirmed no static/dynamic/HTML importer.
- The load path actively **skips** generic elements instead of resolving them:
  `dig-loader.ts:94` — "Skip unregistered elements gracefully (e.g. GenericInitCode …)".
  So generic circuits load with their parameterization silently dropped.

**Wire-up task**
1. In the `.dig` load pipeline (`loadDigCircuit` / `subcircuit-loader`), detect
   `isGenericCircuit(circuit)` and route through `resolveGenericCircuit(...)` before/at
   instantiation, backed by `GenericResolutionCache`.
2. Thread generic args from a parent subcircuit instantiation down to resolution.

---

## 4. Delete stored subcircuit (UI)

**Status:** the data layer exists; no UI calls it.

`src/io/subcircuit-store.ts` exports `storeSubcircuit` / `loadAllSubcircuits` (both wired) and
`deleteSubcircuit` (orphan — no caller). Wire a "delete stored subcircuit" affordance (e.g. in
the subcircuit menu / `canvas-subcircuit.ts`) to `deleteSubcircuit`, so the store supports
removal, not just add/load.

---

## 5. SPICE import flow (disconnected — needs repair, not deletion)

**Status:** the building blocks exist and are tested, but **nothing wires them** — the SPICE
*import-and-apply* flow is non-functional. Distinct from the wired SPICE *model library*
browser (`openSpiceModelLibraryDialog`, reached from `menu-toolbar.ts`), which only lists
`.MODEL`/`.SUBCKT` entries and does not import.

**What exists (all orphan / dead — zero production callers):**
- `src/app/spice-import-dialog.ts` → `openSpiceImportDialog` (the paste/upload + preview
  dialog; parses `.MODEL` → `SpiceImportResult` or `.SUBCKT` → `SpiceSubcktImportResult`).
- `src/app/spice-model-apply.ts` → `applySpiceImportResult`, `applySpiceSubcktImportResult`
  (apply a parsed result onto a component / circuit).
- `src/io/spice-model-builder.ts` → `buildSpiceSubcircuit` (build a `Circuit` from a parsed
  `.SUBCKT`, mapping R/L/C/V/I/Q/M/D/J prefixes to digiTS typeIds).

**Evidence:** none of the above appear in `menu-toolbar.ts`, `postmessage-adapter.ts`, the MCP
server, or `headless/*`. The intended flow is even documented in `registry.ts:394-402` (UI
dialog → `applySpiceImportResult`; SUBCKT body → `spice-model-builder`) — but the trigger that
opens `openSpiceImportDialog` was never wired.

**Repair task** (do NOT delete these — they are the fix): wire a "Import SPICE model / SUBCKT"
entry (component context menu for `.MODEL`-onto-component; a palette/import action for
`.SUBCKT`-as-subcircuit) → `openSpiceImportDialog` → `applySpiceImportResult` /
`applySpiceSubcktImportResult` (+ `buildSpiceSubcircuit`). Confirm against the e2e specs
`spice-import-flows` / `spice-model-panel`.

---

## Verified already-wired — NOT on this list

Investigated and excluded because production already reaches them; their "test-only" analyzer
flags are false positives:

- **karnaugh-map** — wired via `KarnaughMapTab` (`analysis-dialogs.ts:123`,
  `new KarnaughMapTab(ttModel)`). The flagged `KarnaughMap` class is its internal pure-data
  model (`new KarnaughMap(numVars)` at `karnaugh-map.ts:325`); the export exists so the test
  can exercise the model in isolation (same pattern as the `*_SCHEMA` slot-resolution seams).
- **tutorial** — feature is wired: `TutorialRunner` / `TutorialBar` / `TutorialShelf` are
  instantiated in `app-init.ts` (embedded runner), and standalone `app/tutorial/index.html`,
  `view.html`, `edit.html` pages provide the browse/edit surfaces.

**Resolved — `TutorialHost` deleted (not wired up).** `TutorialHost`
(`src/app/tutorial/tutorial-host.ts`) and its helpers implemented an abandoned
*checkpoint-folder* tutorial model (`?tutorial=X&step=N` → fetch
`tutorials/{name}/checkpoint-{N}/instructions.md` beside a simulator iframe, with
"Checkpoint N" buttons). It was confirmed dead — not merely unwired — on functional grounds:

- no HTML page instantiated it (only its test did); the host page it needed never existed;
- zero `tutorials/**/checkpoint-*/instructions.md` content exists in the repo;
- its only real dependency, `renderMarkdown`, stays alive via the live `TutorialShelf`;
- the live manifest-driven path (`TutorialRunner`/`Bar`/`Shelf` + browse/view/edit pages)
  provides the full tutorial feature, including markdown instructions and step navigation.

Removed: `tutorial-host.ts` (whole file), its test, and the dead `TutorialHostMessage` /
`TutorialIframeMessage` types in `types.ts`. Verified by `tsc --noEmit` (clean) + the
remaining tutorial tests (green).
