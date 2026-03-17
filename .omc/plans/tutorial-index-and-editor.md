# Plan: Tutorial Index Page, Editor, and Index Registry

**Date:** 2026-03-16
**Complexity:** MEDIUM
**Scope:** 6 new files, 1 modified file

---

## Context

The tutorial system has a viewer (`tutorial-viewer.html`), manifest types (`src/tutorial/types.ts`), presets (`src/tutorial/presets.ts`), validation (`src/tutorial/validate.ts`), and an MCP tool (`tutorial_create`) that builds tutorial packages. Two tutorials exist (`sr-to-flipflop`, `mcu-build`).

What is missing:

1. **No index page** -- there is no way to browse available tutorials. You must know the manifest URL and type it into `tutorial-viewer.html?manifest=...`.
2. **No central registry** -- no `tutorials/index.json` that lists all tutorials. `tutorial_create` writes individual tutorial directories but does not register them anywhere.
3. **No tutorial editor** -- authoring requires manually writing JSON manifests. There is no GUI for creating/editing steps, selecting presets, writing test vectors, or previewing.

## Work Objectives

1. Create `tutorials/index.json` -- a central registry of all tutorials with metadata for display.
2. Create `tutorials.html` -- a self-contained browse/index page that fetches `tutorials/index.json` and renders tutorial cards with filtering.
3. Create a shared tutorial bundle (`src/tutorial/tutorial-bundle.ts`) -- exports presets, validation helpers, and type info for use by the editor HTML page.
4. Add a Vite build entry point for the bundle so it produces a loadable JS module.
5. Create `tutorial-editor.html` -- a full-featured tutorial authoring UI that imports the shared bundle.
6. Update `tutorial_create` in `scripts/circuit-mcp-server.ts` to upsert `tutorials/index.json` after writing a tutorial package.

## Guardrails

### Must Have
- `tutorials/index.json` is the single source of truth for the index page
- `tutorial_create` updates `index.json` atomically (read-modify-write)
- Editor uses the shared bundle for presets and validation (no duplication)
- Editor supports two modes: **library mode** (editing an existing manifest) and **locked mode** (creating from a template with restricted fields)
- All pages work when served via `python -m http.server` or Vite dev server
- Index page works as self-contained inline JS (no build step required)

### Must NOT Have
- No Node.js runtime dependency for any HTML page (everything runs in-browser)
- No changes to `tutorial-viewer.html` (that cleanup is a separate task)
- No changes to the `TutorialManifest` or `TutorialStep` type definitions
- No server-side save from the editor (export as JSON download; `tutorial_create` remains the build tool)

---

## Task Flow

```
[1] tutorials/index.json schema + seed data
 |
 v
[2] tutorials.html (index page)          [3] src/tutorial/tutorial-bundle.ts + vite entry
 |                                              |
 v                                              v
[4] tutorial-editor.html (imports bundle from [3])
 |
 v
[5] Update tutorial_create to upsert index.json
 |
 v
[6] Manual verification round
```

Tasks 2 and 3 are independent and can run in parallel. Task 4 depends on 3. Task 5 depends on 1.

---

## Detailed TODOs

### Task 1: Create `tutorials/index.json` schema and seed file

**File:** `tutorials/index.json`

Define the index as an array of tutorial summary objects. Each entry contains metadata extracted from the manifest (not a copy of the full manifest -- just what the index page needs for cards and filtering).

```json
{
  "tutorials": [
    {
      "id": "sr-to-flipflop",
      "title": "From SR Latch to D Flip-Flop",
      "description": "Build sequential logic from first principles...",
      "difficulty": "intermediate",
      "estimatedMinutes": 30,
      "stepCount": 3,
      "tags": ["sequential", "latches", "flip-flops", "nand"],
      "author": null,
      "manifestPath": "tutorials/sr-to-flipflop/manifest.json"
    },
    {
      "id": "mcu-build",
      "title": "Building a Microcontroller",
      "description": "Construct an MCU from first principles...",
      "difficulty": "advanced",
      "estimatedMinutes": null,
      "stepCount": 8,
      "tags": [],
      "author": null,
      "manifestPath": "tutorials/mcu-build/manifest.json"
    }
  ]
}
```

**Acceptance criteria:**
- File exists at `tutorials/index.json`
- Contains entries for both existing tutorials with correct metadata (extracted from their `manifest.json` files)
- Schema matches the structure above (id, title, description, difficulty, estimatedMinutes, stepCount, tags, author, manifestPath)

---

### Task 2: Create `tutorials.html` (index/browse page)

**File:** `tutorials.html` (project root, alongside `simulator.html` and `tutorial-viewer.html`)

A self-contained HTML page with inline CSS and JS (no build step). Fetches `tutorials/index.json` and renders:

- **Header:** "Digital Tutorials" title
- **Filter bar:** difficulty filter buttons (All / Beginner / Intermediate / Advanced), optional tag filter pills
- **Tutorial cards:** each card shows title, description (truncated), difficulty badge, estimated time, step count, tags. Clicking a card navigates to `tutorial-viewer.html?manifest=<manifestPath>`.
- **Empty state:** message when no tutorials match filters
- **Error state:** message when index.json fails to load

Styling should match the dark theme of `simulator.html` and `tutorial-viewer.html` (dark background, light text, accent blue `#0066cc`).

**Acceptance criteria:**
- Page loads and displays tutorial cards from `tutorials/index.json`
- Difficulty filter works (shows only matching tutorials)
- Card click navigates to `tutorial-viewer.html?manifest=...`
- Responsive layout (cards wrap on narrow screens)
- Graceful error when `tutorials/index.json` is missing or malformed

---

### Task 3: Create tutorial shared bundle

**Files:**
- `src/tutorial/tutorial-bundle.ts` -- barrel export of browser-safe tutorial utilities
- `vite.config.ts` -- add a second build entry (or a separate Vite config) for the tutorial bundle

`tutorial-bundle.ts` exports:
- `PALETTE_PRESETS` and `resolvePaletteSpec` from `./presets.ts`
- `listPresets` from `./presets.ts`
- All type guards from `./types.ts` (`isTutorialManifest`, `isTutorialStep`, `isTutorialHint`, etc.)
- `isUrlSafeId` from `./types.ts`
- `ValidationMode`, `PaletteSpec` type re-exports (for documentation; erased at runtime)

The Vite build should produce `dist/tutorial-bundle.js` as a library (UMD or ESM) that the editor HTML can load via `<script type="module">`.

**Implementation approach:** Add a `lib` build config to `vite.config.ts` using Vite's library mode, or add a second entry point to `rollupOptions.input`. The output should be an ES module that the editor page loads with `<script type="module" src="/dist/tutorial-bundle.js">` (or directly via Vite dev server as `/src/tutorial/tutorial-bundle.ts`).

Simplest approach: during dev, the editor page loads `/src/tutorial/tutorial-bundle.ts` directly (Vite handles TS transpilation). For production, it loads the built bundle. This matches how `simulator.html` already loads `/src/main.ts`.

**Acceptance criteria:**
- `src/tutorial/tutorial-bundle.ts` exists and re-exports presets, type guards, and resolver
- Importing the bundle in a `<script type="module">` works in the Vite dev server
- No circular dependency issues
- No DOM/Node.js dependencies in the bundle (pure logic only)

---

### Task 4: Create `tutorial-editor.html`

**File:** `tutorial-editor.html` (project root)

A tutorial authoring page that imports the shared bundle from Task 3. Uses `<script type="module" src="/src/tutorial/tutorial-bundle.ts">` for dev (same pattern as `simulator.html`).

#### Layout

Three-panel layout:
1. **Left panel: Step list** -- ordered list of steps, add/remove/reorder buttons, click to select
2. **Center panel: Step editor** -- form fields for the selected step
3. **Right panel: Preview** -- live preview of how the step will look in the viewer (rendered markdown, palette summary)

Plus a top bar with: tutorial-level fields (id, title, description, difficulty, tags), Import/Export buttons.

#### Two Modes

**Library mode** (default):
- Full editing of all manifest fields
- All steps are fully editable
- Used by tutorial authors creating new tutorials or editing existing ones
- Activated by default or via `?mode=library`

**Locked mode:**
- Tutorial-level fields (id, title, description) are read-only
- Only specific step fields are editable (defined by a `lockedFields` query param or manifest annotation)
- Used when embedding the editor for students to fill in specific parts (e.g., writing test vectors for a pre-defined circuit)
- Activated via `?mode=locked` or `?mode=locked&editable=testData,instructions`
- Locked fields show a lock icon and are visually distinct (grayed border)

#### Step Editor Fields

For each step, the editor shows:
- **id** (text input, auto-generated from title if blank)
- **title** (text input)
- **mode** (select: guided / explore)
- **instructions** (markdown textarea with live preview)
- **palette** (preset dropdown populated from `PALETTE_PRESETS`, with add/remove component chips)
- **startCircuit** (select: null / carry-forward / file path input)
- **goalCircuit** (file path input or inline JSON editor)
- **validation** (select: test-vectors / equivalence / compile-only / manual)
- **testData** (textarea, shown when validation is test-vectors, with syntax highlighting for the header line)
- **hints** (ordered list of hint editors, each with label + markdown content + optional highlight labels)
- **lockedComponents** (tag input for component labels)
- **highlight** (tag input for component labels)

#### Key Behaviors

- **Import:** File picker that reads a `manifest.json` and populates all fields. Also supports `?manifest=URL` query param to load on startup.
- **Export:** Downloads the current state as `manifest.json` (the same format `tutorial_create` expects). Does NOT write files or call `tutorial_create` -- the user takes the exported JSON and passes it to `tutorial_create` via the MCP tool.
- **Validation:** On export (and on-demand via a "Validate" button), runs the type guards and structural checks from the shared bundle. Displays errors inline next to the offending fields. Note: full validation (component type checking) requires the registry, which is not available in the editor. The bundle-level validation covers structure, preset names, and test data syntax.
- **Palette preview:** When a preset is selected, shows the resolved component list below the dropdown (from `resolvePaletteSpec`).
- **Auto-save:** Stores the current editor state in `localStorage` keyed by tutorial ID, with a "Restore unsaved work?" prompt on load.

#### What the Editor Does NOT Do

- Does not build .dig files (that is `tutorial_create`'s job)
- Does not run test vectors (that requires the simulation engine)
- Does not communicate with `simulator.html` via postMessage
- Does not save to the filesystem (browser security prevents it; export = download)

**Acceptance criteria:**
- Page loads and shows the three-panel layout
- Can create a new tutorial from scratch (all fields)
- Can import an existing `manifest.json` and edit it
- Export produces valid JSON matching the `TutorialManifest` schema
- Palette dropdown is populated from `PALETTE_PRESETS` (via the shared bundle)
- Locked mode disables the correct fields
- Validation errors display inline
- `localStorage` auto-save works

---

### Task 5: Update `tutorial_create` to upsert `tutorials/index.json`

**File:** `scripts/circuit-mcp-server.ts` (modify the `tutorial_create` handler)

After writing `manifest.json` and all `.dig` files, the handler should:

1. Resolve the path to `tutorials/index.json` (relative to the project root, not `outputDir`)
2. Read the existing index file (or start with `{ "tutorials": [] }` if it does not exist)
3. Build an index entry from the manifest:
   ```ts
   {
     id: manifest.id,
     title: manifest.title,
     description: manifest.description,
     difficulty: manifest.difficulty,
     estimatedMinutes: manifest.estimatedMinutes ?? null,
     stepCount: manifest.steps.length,
     tags: manifest.tags ?? [],
     author: manifest.author ?? null,
     manifestPath: `${outputDir}/manifest.json`
   }
   ```
4. Upsert: if an entry with the same `id` already exists, replace it. Otherwise, append.
5. Write the updated index file back.
6. Log the upsert action in the tool output.

**Acceptance criteria:**
- Running `tutorial_create` for a new tutorial adds it to `tutorials/index.json`
- Running `tutorial_create` for an existing tutorial ID updates the existing entry
- The index file is valid JSON after the operation
- If `tutorials/index.json` does not exist, it is created
- The `manifestPath` field uses the same `outputDir` value passed to the tool

---

### Task 6: Manual verification

Verify the full workflow end-to-end:

1. Serve the project (`npm run dev` or `python -m http.server`)
2. Open `tutorials.html` -- should show 2 tutorial cards
3. Click a card -- should navigate to `tutorial-viewer.html` with the correct manifest
4. Open `tutorial-editor.html` -- should show empty editor
5. Import `tutorials/sr-to-flipflop/manifest.json` -- all fields should populate
6. Edit a step title, export -- downloaded JSON should have the change
7. Open `tutorial-editor.html?mode=locked` -- tutorial-level fields should be disabled
8. Run `tutorial_create` with a test manifest -- `tutorials/index.json` should be updated
9. Refresh `tutorials.html` -- new tutorial card should appear

**Acceptance criteria:**
- All 9 verification steps pass
- No console errors in any page
- Pages render correctly in the dark theme

---

## Success Criteria

1. A user can browse all tutorials from `tutorials.html` without knowing manifest paths
2. A user can create or edit a tutorial manifest in `tutorial-editor.html` and export valid JSON
3. The editor uses the shared TS bundle for presets and validation (zero logic duplication)
4. `tutorial_create` automatically keeps `tutorials/index.json` in sync
5. Locked mode restricts editing to designated fields only
6. All pages match the existing dark theme
