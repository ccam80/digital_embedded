# Phase 9: Export & Application Features

**Depends on**: Phase 6
**Parallel with**: Phases 7, 8

## Overview

Circuit image export (SVG, PNG, animated GIF), ZIP archive bundling, localization framework, translation files, and the 74xx IC library. The postMessage adapter (originally planned as 9.3.2) has been consolidated into Phase 6 task 6.4.2.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **GIF only for animation export.** No WebM. GIF is universally embeddable in slides and course websites.
- **i18n pass-through introduced in Phase 5.5.** All UI code from Phase 2 onwards already calls `i18n()`. This phase replaces the pass-through with locale-aware lookup and adds translation data.
- **Languages: English, Chinese, German.** Translations deferred to end of Phase 9 (lowest priority within the phase).
- **All ~60 74xx ICs included.** Copied from `ref/Digital/src/main/dig/74xx/` and bundled with the app.
- **SVGRenderContext validates the RenderContext abstraction.** This is the first non-Canvas2D implementation of RenderContext. If the abstraction leaks Canvas2D specifics, fix the abstraction.
- **fflate for ZIP encoding.** ~8KB gzipped, fast, well-maintained.

## Reference Source

| What | Where |
|------|-------|
| SVG export | `ref/Digital/src/main/java/de/neemann/digital/draw/graphics/GraphicSVG.java` |
| Translation files | `ref/Digital/src/main/resources/lang/` |
| 74xx library | `ref/Digital/src/main/dig/74xx/` |

---

## Wave 9.1: Circuit Export

### Task 9.1.1 — SVG Export

- **Description**: Render the circuit to SVG via an `SVGRenderContext` that implements the same `RenderContext` interface as the Canvas2D renderer. This is the payoff of the rendering abstraction.

  Features:
  - Full circuit rendering to SVG elements (paths, text, rects, etc.)
  - LaTeX-compatible text option (render labels using LaTeX math notation)
  - Settings dialog: scale, margins, text format (plain vs LaTeX), background inclusion
  - Optional live-state mode: wire colors reflect current signal values (for "snapshot" export)
  - Optional schematic-only mode: all wires in default color (for documentation)

  `SVGRenderContext` implements `RenderContext`:
  - `moveTo/lineTo/arc/etc.` → SVG `<path>` elements
  - `fillRect/strokeRect` → SVG `<rect>` elements
  - `fillText` → SVG `<text>` elements (or LaTeX-escaped equivalents)
  - `save/restore` → SVG `<g>` element nesting with transform attributes
  - Color scheme → SVG fill/stroke attributes

- **Files to create**:
  - `src/export/svg-render-context.ts` — `SVGRenderContext` implementing `RenderContext`. Builds an SVG DOM or string.
  - `src/export/svg.ts` — `exportSvg(circuit: Circuit, options?: SvgExportOptions): string`. Options: scale, margins, textFormat ('plain' | 'latex'), background, liveState.

- **Tests**:
  - `src/export/__tests__/svg.test.ts::basicCircuit` — export AND gate circuit → valid SVG string containing `<svg>`, `<path>`, `<text>` elements
  - `src/export/__tests__/svg.test.ts::validXml` — exported SVG parses as valid XML
  - `src/export/__tests__/svg.test.ts::latexText` — LaTeX mode → text elements contain LaTeX notation (e.g., `$\overline{A}$`)
  - `src/export/__tests__/svg.test.ts::scaleOption` — scale=2 → SVG viewBox dimensions doubled
  - `src/export/__tests__/svg.test.ts::noBackground` — background=false → no background rect element
  - `src/export/__tests__/svg-render-context.test.ts::pathMapping` — RenderContext path calls produce correct SVG `d` attribute
  - `src/export/__tests__/svg-render-context.test.ts::colorMapping` — theme colors map to correct SVG fill/stroke values

- **Acceptance criteria**:
  - SVGRenderContext implements full RenderContext interface
  - Exported SVG is valid XML
  - All circuit elements render (gates, wires, labels, pins)
  - LaTeX text mode works
  - Export options (scale, margins, background) work
  - All tests pass

---

### Task 9.1.2 — PNG Export

- **Description**: Render circuit to PNG image using Canvas2D `toDataURL()`.

  Features:
  - Resolution options: 1x (screen resolution), 2x, 4x
  - Creates an offscreen canvas at the selected resolution
  - Renders the circuit using the existing Canvas2D RenderContext
  - Exports via `canvas.toBlob()` or `canvas.toDataURL()`
  - Download triggered via programmatic `<a>` click

- **Files to create**:
  - `src/export/png.ts` — `exportPng(circuit: Circuit, options?: PngExportOptions): Promise<Blob>`. Options: scale (1, 2, 4), background.

- **Tests**:
  - `src/export/__tests__/png.test.ts::producesBlob` — export returns a Blob with type `image/png`
  - `src/export/__tests__/png.test.ts::scale2x` — scale=2 → canvas dimensions are 2x the circuit bounds
  - `src/export/__tests__/png.test.ts::scale4x` — scale=4 → canvas dimensions are 4x

- **Acceptance criteria**:
  - PNG export produces valid image
  - Resolution options work
  - All tests pass

---

### Task 9.1.3 — Animated GIF Export

- **Description**: Record simulation steps as frames and encode as animated GIF.

  Process:
  1. User configures: number of steps, frame delay, resolution
  2. For each step: run engine step, render circuit to offscreen canvas, capture frame data
  3. Encode frames into GIF using a GIF encoder library
  4. Download the GIF file

  GIF encoder: use `gif.js` (Web Worker-based, ~50KB) or a modern lightweight alternative. Bundled by Vite, no CDN dependency.

- **Files to create**:
  - `src/export/gif.ts` — `exportGif(circuit: Circuit, engine: SimulationEngine, options?: GifExportOptions): Promise<Blob>`. Options: steps, frameDelay (ms), scale.

- **Files to modify**:
  - `package.json` — Add GIF encoder dependency

- **Tests**:
  - `src/export/__tests__/gif.test.ts::producesBlob` — export returns a Blob with type `image/gif`
  - `src/export/__tests__/gif.test.ts::correctFrameCount` — 10 steps → GIF has 10 frames
  - `src/export/__tests__/gif.test.ts::frameDelay` — 100ms delay → encoded in GIF frame metadata

- **Acceptance criteria**:
  - GIF export produces valid animated GIF
  - Correct number of frames
  - Frame delay configurable
  - All tests pass

---

### Task 9.1.4 — ZIP Archive Export

- **Description**: Bundle the main circuit file + all referenced subcircuit .dig files + hex data files into a ZIP archive. Preserves .dig format for Digital compatibility.

  Uses `fflate` for ZIP creation (~8KB gzipped).

  Process:
  1. Collect main circuit .dig XML
  2. Recursively collect all referenced subcircuit .dig files
  3. Collect any hex/binary data files referenced by memory components
  4. Create ZIP with directory structure preserved
  5. Download the ZIP

- **Files to create**:
  - `src/export/zip.ts` — `exportZip(circuit: Circuit, subcircuits: Map<string, string>, dataFiles?: Map<string, ArrayBuffer>): Promise<Blob>`

- **Files to modify**:
  - `package.json` — Add `fflate` dependency

- **Tests**:
  - `src/export/__tests__/zip.test.ts::createsZip` — export returns a Blob with type `application/zip`
  - `src/export/__tests__/zip.test.ts::containsMainCircuit` — ZIP contains main .dig file
  - `src/export/__tests__/zip.test.ts::containsSubcircuits` — ZIP contains subcircuit .dig files
  - `src/export/__tests__/zip.test.ts::containsDataFiles` — ZIP contains hex data files
  - `src/export/__tests__/zip.test.ts::roundTrip` — create ZIP, extract, verify file contents match originals

- **Acceptance criteria**:
  - ZIP contains all circuit files
  - Files extractable and loadable
  - All tests pass

---

## Wave 9.2: Localization

### Task 9.2.1 — i18n Framework (Full Implementation)

- **Description**: Replace the Phase 5.5 pass-through `i18n()` with a full locale-aware implementation. All UI strings already call `i18n()` — this task adds the lookup logic and locale switching.

  Features:
  - Locale data loaded from JSON files (`src/i18n/locales/{locale}.json`)
  - `i18n(key, params?)` → looks up key in active locale map, falls back to English
  - Parameter interpolation: `i18n('errors.notFound', { name: 'foo' })` → "Component 'foo' not found"
  - `setLocale(locale)` → switches active locale, triggers re-render
  - `getLocale()` → returns current locale string
  - Locale change event for UI re-rendering

  Key structure: dot-separated hierarchy matching UI structure:
  - `menu.file.open`, `menu.file.save`, `menu.edit.undo`
  - `toolbar.step`, `toolbar.run`, `toolbar.stop`
  - `components.gates.and`, `components.gates.or`
  - `errors.unknownComponent`, `errors.cyclicReference`

- **Files to modify**:
  - `src/i18n/index.ts` — Replace pass-through implementation with locale-aware lookup. Add `onLocaleChange(callback)` event registration.

- **Files to create**:
  - `src/i18n/locales/en.json` — English strings (primary, complete)
  - `src/i18n/locale-loader.ts` — `loadLocale(locale: string): Promise<Record<string, string>>` — loads JSON locale file

- **Tests**:
  - `src/i18n/__tests__/i18n-full.test.ts::lookupKey` — `i18n('menu.file.open')` with English locale → "Open"
  - `src/i18n/__tests__/i18n-full.test.ts::paramInterpolation` — `i18n('errors.notFound', { name: 'foo' })` → "Component 'foo' not found"
  - `src/i18n/__tests__/i18n-full.test.ts::fallbackToEnglish` — switch to German, key missing in German → falls back to English string
  - `src/i18n/__tests__/i18n-full.test.ts::missingKeyReturnsKey` — key not in any locale → returns the key itself (graceful degradation)
  - `src/i18n/__tests__/i18n-full.test.ts::localeChangeEvent` — register callback, `setLocale('de')` → callback fired
  - `src/i18n/__tests__/i18n-full.test.ts::switchLocale` — set locale to German, verify German strings returned

- **Acceptance criteria**:
  - Full locale-aware lookup working
  - Parameter interpolation working
  - Fallback chain: active locale → English → key
  - Locale change events fire
  - All tests pass

---

### Task 9.2.2 — Translation Files

- **Description**: Port Digital's translations for English (complete), Chinese (simplified), and German. Map Digital's `lang_XX.xml` keys to our i18n key structure.

  Source: `ref/Digital/src/main/resources/lang/lang_en.xml`, `lang_zh.xml`, `lang_de.xml`

  Process:
  1. Extract all translatable strings from Digital's XML files
  2. Map to our key hierarchy
  3. Fill in translations for UI elements not present in Digital (our additions)

- **Files to create**:
  - `src/i18n/locales/zh.json` — Simplified Chinese translations
  - `src/i18n/locales/de.json` — German translations

- **Tests**:
  - `src/i18n/__tests__/translations.test.ts::allKeysPresent` — every key in `en.json` exists in `zh.json` and `de.json` (or is explicitly marked as English-only)
  - `src/i18n/__tests__/translations.test.ts::noEmptyValues` — no empty string values in any locale file
  - `src/i18n/__tests__/translations.test.ts::paramPlaceholders` — keys with `{param}` in English have `{param}` in translations too

- **Acceptance criteria**:
  - Chinese and German translations cover all UI strings
  - No missing keys (fallback to English is acceptable for rare edge cases)
  - Parameter placeholders preserved
  - All tests pass

---

## Wave 9.3: 74xx Library

### Task 9.3.1 — 74xx IC Library

- **Description**: Bundle Digital's 74xx series IC subcircuit files with the app. Register in component palette under "74xx" category.

  Process:
  1. Copy all .dig files from `ref/Digital/src/main/dig/74xx/` to `lib/74xx/`
  2. Create a library manifest listing all available ICs with name and description
  3. Register a component palette category "74xx" that loads and displays available ICs
  4. Each 74xx IC is a subcircuit — uses the subcircuit loading and rendering from Phase 6

  The ICs are loaded on demand (not all at startup). When the user expands the "74xx" category in the palette, the manifest is shown. When they place a 74xx IC, the .dig file is loaded via the file resolver.

- **Files to create**:
  - `lib/74xx/*.dig` — Copied from reference (all ~60 files)
  - `src/components/library-74xx.ts` — Library manifest: `{ name: string, description: string, file: string }[]`. Registration function to add "74xx" category to palette.

- **Tests**:
  - `src/components/__tests__/library-74xx.test.ts::manifestComplete` — manifest has entries for all .dig files in lib/74xx/
  - `src/components/__tests__/library-74xx.test.ts::loadRepresentative` — load 7400 (quad NAND), verify 4 NAND gates in subcircuit
  - `src/components/__tests__/library-74xx.test.ts::load7474` — load 7474 (dual D flip-flop), verify correct pin layout
  - `src/components/__tests__/library-74xx.test.ts::allLoadable` — iterate manifest, verify each .dig file parses without error

- **Acceptance criteria**:
  - All ~60 74xx .dig files bundled
  - Manifest lists all ICs with descriptions
  - Representative ICs load and simulate correctly
  - "74xx" category appears in component palette
  - All tests pass
