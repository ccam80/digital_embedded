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

**Open orphan question (separate from wire-up):** `TutorialHost`
(`src/app/tutorial/tutorial-host.ts:100`) and its helpers (`setupCheckpointNavigation`,
`parseUrlParams`, `buildCheckpointPath`, `buildInstructionsUrl`, `buildIframeSrc`,
`CheckpointConfig`) are imported **only by `tutorial-host.test.ts`** — not by any HTML page
(the tutorial pages use inline scripts) nor by `app-init.ts`. This looks like an alternate
tutorial-host implementation superseded by `TutorialRunner`. Decide: delete as a dead
alternate, or wire it to a tutorial page. (Tracked here, not yet actioned.)
