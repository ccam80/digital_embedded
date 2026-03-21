# Analog UI Integration Plan

**Date:** 2026-03-18
**Scope:** Wire the existing analog engine backend into the simulator UI
**Estimated Complexity:** MEDIUM (5 tasks across ~6 files, no new renderers needed)

## Context

The analog simulation engine is fully implemented (MNA solver, AC analysis, Monte Carlo, scope panel, Bode plot renderer) but has zero UI wiring. The palette shows no analog components, the Insert menu is digital-only, the viewer panel only renders digital timing diagrams, and AC analysis has no way to be invoked from the UI.

## Work Objectives

1. Analog components appear in the sidebar palette and Insert menu when in analog mode
2. The viewer panel renders analog scope traces (not just digital timing diagrams)
3. AC Analysis is accessible from the Analysis menu with a configuration dialog
4. Components with `engineType: "both"` appear in both modes (not filtered out)

## Guardrails

**Must Have:**
- All existing digital functionality unchanged
- All existing tests continue passing
- Engine-agnostic editor constraint preserved (no simulation logic in editor/canvas code)
- Same "Add to Viewer" right-click workflow for analog signals

**Must NOT Have:**
- New rendering engines (AnalogScopePanel and BodePlotRenderer already exist)
- Framework dependencies (vanilla DOM only)
- Monte Carlo UI (stub menu item is acceptable, full dialog is out of scope)

---

## Task Flow

```
Task 1 (engine filter fix) ----\
Task 2 (palette categories)  ---+--> Task 4 (unified viewer panel)
Task 3 (insert menu rebuild) --/          |
                                          v
                                   Task 5 (AC analysis dialog)
```

Tasks 1-3 are independent and can be done in parallel.
Task 4 depends on mode toggle working correctly (Tasks 1-3).
Task 5 depends on Task 4 (reuses the viewer panel pattern for Bode plot display).

---

## Task 1: Fix engine type filter for "both" components

**File:** `src/editor/palette.ts`

**Change:** In `_applyEngineTypeFilter` (line 171-173), update the filter predicate to also match `engineType: "both"`:

```
// Current:
return defs.filter((d) => (d.engineType ?? "digital") === this._engineTypeFilter);

// Target:
return defs.filter((d) => {
  const et = d.engineType ?? "digital";
  return et === this._engineTypeFilter || et === "both";
});
```

**Acceptance Criteria:**
- Components registered with `engineType: "both"` (switches, gates used in mixed circuits) appear in both digital and analog palette modes
- Components with `engineType: "digital"` do NOT appear in analog mode
- Components with `engineType: "analog"` do NOT appear in digital mode
- Existing digital-only palette behavior unchanged when filter is null

---

## Task 2: Add analog categories to palette

**File:** `src/editor/palette.ts`

**Changes:**

1. Add analog entries to `CATEGORY_LABELS` (after line 40):
   ```
   [ComponentCategory.PASSIVES]: "Passives",
   [ComponentCategory.SEMICONDUCTORS]: "Semiconductors",
   [ComponentCategory.SOURCES]: "Sources",
   [ComponentCategory.ACTIVE]: "Active",
   ```

2. Add analog categories to `ALL_CATEGORIES` array (insert before SUBCIRCUIT, which should remain last):
   ```
   ComponentCategory.PASSIVES,
   ComponentCategory.SEMICONDUCTORS,
   ComponentCategory.SOURCES,
   ComponentCategory.ACTIVE,
   ```

3. Add default analog palette components to `PALETTE_DEFAULT_COMPONENTS`:
   ```
   [ComponentCategory.SOURCES, ["DcVoltageSource", "AcVoltageSource", "CurrentSource", "Ground"]],
   [ComponentCategory.PASSIVES, ["Resistor", "Capacitor", "Inductor", "Potentiometer"]],
   [ComponentCategory.SEMICONDUCTORS, ["Diode", "NPN", "PNP", "NMOS", "PMOS"]],
   [ComponentCategory.ACTIVE, ["OpAmp", "Comparator"]],
   ```
   Note: Verify exact type names against the registry before implementation. Use `ComponentRegistry.getByCategory()` to confirm.

**Acceptance Criteria:**
- When circuit mode is "analog", palette sidebar shows Passives, Semiconductors, Sources, Active categories with components
- When circuit mode is "digital", analog categories are empty (filtered by engine type) and do not appear
- Category display order is logical: Sources, Passives, Semiconductors, Active (among the analog ones)

---

## Task 3: Rebuild Insert menu on mode toggle

**File:** `src/app/app-init.ts`

**Changes:**

1. Add analog category labels to the `categoryLabels` object (line 261-274):
   ```
   PASSIVES: "Passives",
   SEMICONDUCTORS: "Semiconductors",
   SOURCES: "Sources",
   ACTIVE: "Active",
   ```

2. Extract the Insert menu build logic (lines 259-301) into a named function `buildInsertMenu(dropdown: HTMLElement, palette: ComponentPalette)` that:
   - Clears the dropdown's children
   - Rebuilds from the current registry, filtered by engine type
   - Uses `palette.getEngineTypeFilter()` to filter `reg.getByCategory()` results (or reuse `_applyEngineTypeFilter` logic)

3. In the circuit mode toggle handler (line 3091-3099), after `paletteUI.render()`, call the new `buildInsertMenu()` to rebuild the Insert menu.

**Acceptance Criteria:**
- Insert menu shows only digital categories when in digital mode
- Insert menu shows analog categories (and "both" components) when in analog mode
- Toggling mode immediately updates the Insert menu without page reload
- All existing Insert menu click handlers (placement start, menu close) still work

---

## Task 4: Unified viewer panel (Traces)

**Files:** `src/app/app-init.ts`, `simulator.html`

**Changes to `simulator.html`:**

1. Rename the "Timing" tab label (line 1928):
   ```html
   <!-- Before: -->
   <button class="viewer-tab active" data-viewer="timing">Timing</button>
   <!-- After: -->
   <button class="viewer-tab active" data-viewer="timing">Traces</button>
   ```

**Changes to `src/app/app-init.ts`:**

1. Add import for `AnalogScopePanel` (near line 68 where TimingDiagramPanel is imported):
   ```ts
   import { AnalogScopePanel } from '../runtime/analog-scope-panel.js';
   ```

2. Add a variable alongside `activeTimingPanel` (line 1552):
   ```ts
   let activeScopePanel: AnalogScopePanel | null = null;
   ```

3. Update `disposeViewers()` (line 1607) to also dispose the scope panel:
   ```ts
   if (activeScopePanel) {
     engine.removeMeasurementObserver(activeScopePanel);
     activeScopePanel.dispose();
     activeScopePanel = null;
   }
   ```

4. Update `rebuildViewers()` (line 1621) to branch on circuit mode:
   ```ts
   if (circuit.metadata.engineType === 'analog') {
     // Use AnalogScopePanel for analog circuits
     if (viewerTimingCanvas) {
       // ... size canvas same as existing code ...
       activeScopePanel = new AnalogScopePanel(viewerTimingCanvas, engine as any);
       // Add channels to scope panel
       for (const s of watchedSignals) {
         activeScopePanel.addChannel(s.name, s.netId);
       }
       engine.addMeasurementObserver(activeScopePanel);
     }
   } else {
     // Existing TimingDiagramPanel code (unchanged)
     ...
   }
   ```
   Note: The exact AnalogScopePanel API (addChannel signature, constructor args) must be verified against `src/runtime/analog-scope-panel.ts` during implementation. The scope panel takes an `AnalogEngine` not the generic `Engine` -- the executor must check if the engine interface needs a conditional cast or if AnalogScopePanel can accept the interface type.

5. The `addWireToViewer()` function (line 1656) should work as-is since it calls `rebuildViewers()` which now branches on mode.

**Acceptance Criteria:**
- Tab label reads "Traces" instead of "Timing"
- In digital mode: viewer panel renders TimingDiagramPanel exactly as before
- In analog mode: viewer panel renders AnalogScopePanel with voltage/current traces
- Right-click "Add to Viewer" on wires works in both modes
- Closing and reopening the viewer panel works in both modes
- Switching circuit mode disposes the active panel and rebuilds with the correct renderer

---

## Task 5: AC Analysis dialog

**File:** `src/app/app-init.ts`

**Changes:**

1. Add imports:
   ```ts
   import type { AcParams, AcResult } from '../analog/ac-analysis.js';
   import { BodePlotRenderer } from '../runtime/bode-plot.js';
   ```

2. Add a new function `openAcAnalysisDialog()` near the existing `openAnalysisDialog()` (line 3115). The dialog should:
   - Only be available when `circuit.metadata.engineType === 'analog'`
   - Show a form with fields:
     - Sweep type: dropdown (lin / dec / oct) -- default "dec"
     - Start frequency: number input (default 1 Hz)
     - Stop frequency: number input (default 1 MHz)
     - Number of points: number input (default 100)
     - Source label: text input (label of the AC source component)
     - Output node(s): text input (comma-separated labels)
   - On "Run": call `engine.acAnalysis(params)` with constructed AcParams
   - On success: render the result using `BodePlotRenderer` onto a canvas within the dialog
   - On error: show error message in the dialog
   - Follow the same overlay/dialog DOM pattern used by `openAnalysisDialog()` (lines 3115-3130)

3. Add a menu item. Find the Analysis menu section in the HTML or app-init wiring and add:
   - "AC Sweep..." menu item that calls `openAcAnalysisDialog()`
   - Gray out / hide when not in analog mode
   - Optional: "Monte Carlo..." stub menu item (shows "Coming soon" or is grayed out)

4. Wire the menu item click handler alongside the existing analysis menu handlers (near line 3428).

**Acceptance Criteria:**
- "AC Sweep..." appears in the Analysis menu when in analog mode
- "AC Sweep..." is hidden or disabled when in digital mode
- Dialog opens with sensible defaults for all fields
- Running AC analysis on a valid analog circuit produces a Bode plot in the dialog
- Error cases (no source found, not compiled, digital mode) show clear error messages
- Dialog can be closed and reopened without leaking DOM nodes
- Bode plot shows both magnitude (dB) and phase (degrees) panels

---

## Success Criteria

1. A user can toggle to analog mode and see analog components in both the palette sidebar and Insert menu
2. Components with `engineType: "both"` appear in both modes
3. A user can place analog components, compile, run, and view analog traces in the viewer panel
4. A user can run AC analysis from the menu and see a Bode plot
5. All existing digital functionality is unchanged
6. All existing tests pass
