# UI Modernization Plan — digiTS

**Created:** 2026-03-15
**Revised:** 2026-03-15 (iteration 3 — adds Phases 6-8: surface hidden engine features)
**Status:** IMPLEMENTED — all 21 tasks complete (2026-03-15)
**Complexity:** HIGH (cross-cutting changes across CSS, DOM events, and interaction logic)

---

## RALPLAN-DR Summary

### Principles

1. **Zero regression on desktop** — Every mouse-based interaction must work identically after the migration. Desktop users must not notice any change except improvements.
2. **Progressive enhancement** — Touch and responsive capabilities are additive layers. The app must remain fully functional on desktop browsers that lack Pointer Events (graceful degradation).
3. **Minimal surface area per phase** — Each phase is independently shippable and testable. No phase depends on a future phase being complete to be usable.
4. **Engine-agnostic editor constraint preserved** — No simulation logic leaks into the UI layer. All touch/responsive work stays in editor/app-init/CSS.
5. **Iframe embedding preserved** — The postMessage API, locked mode, and palette restriction features must remain intact throughout all phases.

### Decision Drivers

1. **Touch support is blocking for university tablet deployment** — Students use iPads and Chromebooks in labs. Zero touch support means the app is unusable on those devices.
2. **Responsive layout is the highest-leverage single change** — A fixed 200px palette and 28px menubar make the app unusable below 768px, which covers all tablets in portrait mode.
3. **Interaction fidelity on canvas is the hardest problem** — Pinch-to-zoom, one-finger pan, component drag, and wire drawing must coexist without gesture conflicts.

### Viable Options

#### Option A: Pointer Events Migration (Recommended)

Migrate all `mouse*` events to `pointer*` events in a single coordinated phase, then layer touch-specific gestures (pinch, long-press) on top.

| Pros | Cons |
|------|------|
| Pointer Events are the W3C standard; unify mouse/touch/pen in one API | Requires touching every event handler across multiple files |
| `setPointerCapture` enables cross-element drag (palette-to-canvas) natively | Subtle behavioral differences from MouseEvent (e.g., no `mouseenter` bubbling equivalent) |
| One migration, not two (no separate touch event layer) | Must handle `touch-action` CSS to prevent browser gestures conflicting |
| Future-proof: stylus/pen support comes free | Must handle `pointercancel` to avoid stuck drag state |

#### Option B: Dual Mouse + Touch Event Layers

Keep existing `mouse*` events, add parallel `touch*` event handlers for mobile.

| Pros | Cons |
|------|------|
| Zero risk to existing desktop mouse handling | Double the event handler code; every interaction has two code paths |
| Can be done incrementally per interaction | `touchstart`/`touchmove` lack `setPointerCapture`; cross-element drag requires manual coordinate tracking |
| — | No pen/stylus support without a third layer |
| — | Long-term maintenance burden: every new interaction needs mouse + touch versions |

**Decision: Option A (Pointer Events Migration).** Option B is invalidated by the maintenance burden of dual code paths and the lack of `setPointerCapture` for the palette drag interaction, which is a confirmed requirement.

---

## Context

The digital logic circuit simulator is a vanilla TypeScript + Canvas2D application embedded in university course tutorial iframes. It currently has:

- **Zero touch support**: All interaction uses `mousedown`/`mousemove`/`mouseup`/`wheel`/`dblclick` events
- **Zero responsive layout**: Fixed 200px palette, 28px menubar, 22px status bar, no media queries
- **Tiny touch targets**: Menu items 28px, palette items ~27px, toolbar buttons ~20px (minimum for touch: 44px)
- **Desktop-only menus**: Hover-to-open cascading submenus (`mouseenter`/`mouseleave` on submenu items)
- **~750 lines of inline CSS** in `simulator.html` with no media queries

### Files in scope

**Phases 0-5 (Touch & Responsive):**

| File | Lines | Change type |
|------|-------|-------------|
| `simulator.html` | 903 | CSS overhaul (media queries, touch targets, transitions), inline script mouse event migration |
| `src/app/app-init.ts` | 2433 | Event handler migration (mouse -> pointer), gesture recognition |
| `src/editor/palette-ui.ts` | 447 | Touch drag initiation, pointer capture |
| `src/editor/viewport.ts` | ~146 | Pinch-to-zoom integration point |
| `src/editor/context-menu.ts` | ~120 | Dismiss handler migration, long-press trigger |
| `src/editor/hit-test.ts` | 239 | Touch-radius expansion for fat-finger tolerance |
| `src/runtime/timing-diagram.ts` | ~460 | Secondary mouse event migration (mousedown/move/up/leave) |

**Phases 6-8 (Feature Surfacing) — backend files already implemented, need UI wiring:**

| File | Purpose | Phase |
|------|---------|-------|
| `src/editor/color-scheme.ts` | Dark mode toggle, custom scheme dialog | 6.1, 8.3 |
| `src/export/svg.ts` | SVG export | 6.2 |
| `src/export/png.ts` | PNG export | 6.2 |
| `src/export/gif.ts` | Animated GIF export | 6.2 |
| `src/export/zip.ts` | ZIP archive export | 6.2 |
| `src/runtime/memory-editor.ts` | Hex editor for RAM/ROM/EEPROM | 6.3 |
| `src/editor/search.ts` | Component search (Ctrl+F) | 6.5 |
| `src/analysis/model-analyser.ts` | Truth table generation | 6.6 |
| `src/analysis/truth-table-ui.ts` | Editable truth table grid | 6.6 |
| `src/analysis/karnaugh-map.ts` | K-map visualization | 6.6 |
| `src/analysis/quine-mccluskey.ts` | Boolean expression minimization | 6.6 |
| `src/analysis/expression-gen.ts` | SOP/POS expression generation | 6.6 |
| `src/analysis/expression-editor.ts` | Expression input + parse + evaluate | 6.6 |
| `src/analysis/synthesis.ts` | Circuit synthesis from expressions | 6.6 |
| `src/core/engine-interface.ts` | microStep(), runToBreak(), setSnapshotBudget() | 7.1, 7.2, 8.4 |
| `src/editor/auto-power.ts` | Auto-connect VDD/GND supplies | 7.3 |
| `src/editor/locked-mode.ts` | Lock/unlock toggle | 7.6 |
| `src/editor/undo-redo.ts` | Undo/Redo stack (toolbar buttons) | 7.7 |
| `src/analysis/path-analysis.ts` | Critical path analysis | 8.1 |
| `src/analysis/state-transition.ts` | State transition table | 8.2 |
| `src/engine/oscillation.ts` | Oscillation detection limit | 8.5 |
| `src/app/url-params.ts` | Presentation mode (`panels=none`) | 8.6 |

### Out of scope

- `tutorial-viewer.html` — Uses only `onclick`/`.onclick` assignments on buttons (no mouse event listeners). These fire for both mouse and touch already. A responsive/touch pass for the tutorial viewer is a separate, lower-priority plan item.

---

## Work Objectives

1. Make the simulator fully usable on touch devices (iPad, Chromebook, Android tablets)
2. Make the layout responsive down to 768px (tablet portrait) with graceful handling at 600px
3. Preserve all existing desktop mouse interactions without regression
4. Maintain iframe embedding compatibility (postMessage API, locked mode)

---

## Guardrails

### Must Have
- All existing mouse interactions work identically after migration
- Touch targets >= 44px on touch devices (can use media query or pointer coarse detection)
- Pinch-to-zoom and one-finger pan on canvas
- Palette component drag-to-canvas on touch (per agreed design)
- Long-press context menu on touch
- Responsive layout at 768px breakpoint (palette collapsible, menu adapted)
- `touch-action: none` on canvas — applied conditionally (see Phase 1 accessibility note)
- iframe postMessage API preserved
- `pointercancel` handling to prevent stuck drag state
- Secondary pointer rejection during single-pointer interactions

### Must NOT Have
- Framework dependencies (React, Vue, etc.)
- Breaking changes to the postMessage API
- Simulation logic in editor/UI code
- Server-side rendering or build-time CSS processing requirements
- Changes to the Canvas2D rendering pipeline (element-renderer, canvas-renderer)

---

## Task Flow

```
Phase 0 (Audit)          — prerequisite for all phases
  |
Phase 1 (Foundation)     — pointer events migration
  |
Phase 2 (Canvas Gestures) — pinch-to-zoom, one-finger pan
  |
Phase 3 (Palette Touch Drag)
  |
Phase 5 (Polish & Accessibility)
  |
Phase 6 (High-Impact Feature Surfacing) — dark mode, export, memory editor, search, analysis
  |
Phase 7 (Editor Tools Surfacing) — microStep, run-to-break, auto-power, viewport, lock, undo/redo
  |
Phase 8 (Specialist Feature Surfacing) — critical path, state machines, custom colors, settings

Phase 4 (Responsive Layout):
  Tasks 4.1, 4.3 — CSS-only, can start after Phase 1
  Tasks 4.2, 4.4 — require Phase 3 (palette toggle needs pointer events; resize handles need pointer drag)
```

Phases 1-3 are sequential. Phase 4 CSS tasks (4.1, 4.3) can run in parallel with Phases 2-3. Phase 4 interaction tasks (4.2, 4.4) wait for Phase 3. Phase 5 depends on all prior phases. Phases 6-8 depend on Phase 4 (responsive layout must be in place so new UI elements inherit responsive behavior and 44px touch targets). Within Phases 6-8, tasks are independent and can be parallelized.

---

## Phase 0: Mouse Event Inventory & Migration Checklist

**Goal:** Create a complete, grep-verifiable inventory of every mouse event registration in the codebase. This is a prerequisite for all subsequent phases — no migration work begins until the full surface area is documented.

**Risk:** LOW — Pure audit, no code changes.

### Tasks

**0.1 Grep entire codebase for mouse event registrations; produce migration checklist**

Search patterns (all must be covered):
- `addEventListener` with `mouse*` or `click` or `dblclick`
- `.onmouse*` property assignments
- `MouseEvent` type annotations
- `mouseenter`/`mouseleave` in inline HTML scripts

Produce a checklist document at `.omc/plans/mouse-event-inventory.md` with columns: File, Line pattern (grep-verifiable string, not line number), Event type, Migration action (pointer equivalent / keep as-is / N/A), Phase assignment.

**Known sites from investigation (executor must verify completeness):**

| File | Pattern | Event(s) |
|------|---------|----------|
| `app-init.ts` | `canvas.addEventListener('mousedown'` | mousedown (x2: main handler + popup close) |
| `app-init.ts` | `canvas.addEventListener('mousemove'` | mousemove |
| `app-init.ts` | `canvas.addEventListener('mouseup'` | mouseup |
| `app-init.ts` | `canvas.addEventListener('dblclick'` | dblclick |
| `app-init.ts` | `canvas.addEventListener('contextmenu'` | contextmenu |
| `app-init.ts` | `sub.addEventListener('mouseenter'` | mouseenter (submenu open) |
| `app-init.ts` | `sub.addEventListener('mouseleave'` | mouseleave (submenu close) |
| `app-init.ts` | `document.addEventListener('mousedown', dismiss` | mousedown (wire context menu dismiss) |
| `app-init.ts` | `document.removeEventListener('mousedown', dismiss` | mousedown (cleanup) |
| `app-init.ts` | `function canvasToWorld(e: MouseEvent)` | MouseEvent type annotation |
| `app-init.ts` | `function canvasToScreen(e: MouseEvent)` | MouseEvent type annotation |
| `app-init.ts` | `} as MouseEvent)` | Synthetic MouseEvent cast (x2, box-select) |
| `simulator.html` | `document.addEventListener('mouseenter'` | mouseenter (submenu script) |
| `simulator.html` | `document.addEventListener('mouseleave'` | mouseleave (submenu script) |
| `timing-diagram.ts` | `canvas.addEventListener("mousedown"` | mousedown |
| `timing-diagram.ts` | `canvas.addEventListener("mousemove"` | mousemove |
| `timing-diagram.ts` | `canvas.addEventListener("mouseleave"` | mouseleave |
| `timing-diagram.ts` | `canvas.addEventListener("mouseup"` | mouseup |
| `timing-diagram.ts` | `_onMouseDown = (e: MouseEvent)` | MouseEvent type annotation (x5 handlers) |
| `context-menu.ts` | `document.addEventListener("click", dismiss` | click (dismiss handler) |
| `palette-ui.ts` | `item.addEventListener("click"` | click (component selection) |

Acceptance criteria:
- Checklist covers every file with mouse/click event listeners
- Each entry has a grep-verifiable pattern (not a line number)
- Each entry has a migration action and phase assignment
- Executor confirms zero false negatives by running the grep patterns

---

## Phase 1: Pointer Events Migration

**Goal:** Replace all `mouse*` event listeners with `pointer*` equivalents. Zero behavior change on desktop — this is a pure API migration.

**Risk:** MEDIUM — Large surface area across app-init.ts and timing-diagram.ts, but each handler maps 1:1.

### Tasks

**1.1 Add `touch-action` to canvas CSS — conditionally**

- File: `simulator.html`
- Add `touch-action: manipulation` to `#sim-canvas` as the default (allows native accessibility gestures like screen reader swipes and native zoom)
- Add a JS-applied upgrade: when the app initializes, set `canvas.style.touchAction = 'none'` to take full control of touch gestures on the canvas
- This preserves WCAG 2.1 AA compliance: if JS fails to load or a screen reader is active, native gestures still work on the canvas. The JS upgrade is the signal that the app's own gesture handling is ready.
- Acceptance: Canvas does not scroll or zoom when touched on mobile browser with JS loaded. Without JS, native touch gestures still work.

**1.2 Refactor `canvasToWorld`/`canvasToScreen` to accept a coordinate interface**

- File: `src/app/app-init.ts`
- Current signatures: `function canvasToWorld(e: MouseEvent): Point` and `function canvasToScreen(e: MouseEvent): Point`
- These functions only use `e.clientX` and `e.clientY`. Refactor to accept `{ clientX: number; clientY: number }` instead of `MouseEvent`.
- This eliminates the synthetic `as MouseEvent` casts at the box-select finalization (grep: `} as MouseEvent)`) where only `clientX`/`clientY` are constructed.
- After refactoring, the two cast sites become plain object literals — no `as` needed.
- Acceptance: Both functions accept `{ clientX: number; clientY: number }`. Zero `as MouseEvent` casts remain. All existing call sites compile and behave identically.

**1.3 Migrate canvas event handlers in app-init.ts**

- File: `src/app/app-init.ts`
- Replace `mousedown` -> `pointerdown`, `mousemove` -> `pointermove`, `mouseup` -> `pointerup` on canvas listeners
- Replace `MouseEvent` type annotations with `PointerEvent` on handler parameters
- Replace `(e: MouseEvent)` on the `contextmenu` listener with `(e: PointerEvent)` (contextmenu fires as PointerEvent when pointer events are in use)
- DO NOT add `setPointerCapture` yet — that is deferred to Phase 2/3 where drag disambiguation is established (calling it at pointerdown before knowing the gesture type would interfere with scroll and other gestures)
- Acceptance: All desktop mouse interactions (select, drag, pan, wire draw, box select) work identically. TypeScript compiles with zero `MouseEvent` references in canvas handlers.

**1.4 Migrate popup-close and wire-context-menu-dismiss handlers**

- File: `src/app/app-init.ts`
- Popup close handler (grep: `canvas.addEventListener('mousedown', () => {` — the second mousedown listener on canvas): migrate to `pointerdown`
- Wire context menu dismiss (grep: `document.addEventListener('mousedown', dismiss`): migrate to `pointerdown`
- Acceptance: Popup closes on canvas tap (touch). Wire context menu dismisses on tap outside (touch).

**1.5 Migrate submenu hover events**

- File: `src/app/app-init.ts` (grep: `sub.addEventListener('mouseenter'` and `sub.addEventListener('mouseleave'`)
- File: `simulator.html` (grep: `document.addEventListener('mouseenter'` and `document.addEventListener('mouseleave'` in inline script)
- Replace `mouseenter` -> `pointerenter`, `mouseleave` -> `pointerleave`
- Note: `pointerenter`/`pointerleave` do not bubble (same as mouseenter/mouseleave), so behavior is identical for mouse. On touch, these fire on tap which is acceptable for submenu opening.
- Acceptance: Submenus open on hover (desktop) and are not broken on touch.

**1.6 Migrate timing-diagram.ts mouse events**

- File: `src/runtime/timing-diagram.ts`
- Replace all five handlers: `_onMouseDown`, `_onMouseMove`, `_onMouseLeave`, `_onMouseUp`, `_onClick`
- Replace `MouseEvent` type annotations with `PointerEvent`
- Replace `addEventListener`/`removeEventListener` calls with pointer equivalents: `pointerdown`, `pointermove`, `pointerleave`, `pointerup` (keep `click` as-is — it fires for both mouse and touch)
- Acceptance: Timing diagram pan, cursor tracking, and click-to-jump work identically on desktop.

**1.7 Keep `wheel` and `dblclick` as-is**

- `wheel` event is already pointer-agnostic; no change needed.
- `dblclick` fires for both mouse and touch (after two rapid taps). Keep as `dblclick`.
- **Contingency:** If real-device testing reveals `dblclick` does not fire reliably on touch (especially with `touch-action: none`), add a fallback double-tap detector: track last `pointerup` timestamp + position; if second `pointerup` within 300ms and 20px, synthesize dblclick logic. This is a contingency, not a default implementation — verify on real devices first.
- Acceptance: Double-click opens property popup on desktop. Document whether it fires on touch during Phase 1 testing.

**1.8 Add `pointercancel` handler**

- File: `src/app/app-init.ts`
- Add `canvas.addEventListener('pointercancel', ...)` that resets drag state identically to `pointerup` — sets `dragMode = 'none'`, clears any in-progress wire drawing, clears box select state.
- `pointercancel` fires when the browser takes over a gesture (e.g., system notification, browser navigation gesture). Without handling it, drag state becomes stuck until the next pointerdown.
- File: `src/runtime/timing-diagram.ts` — add `pointercancel` handler that delegates to the existing mouseup/pointerup logic.
- Acceptance: After a `pointercancel` event, no drag state is stuck. Next interaction starts clean.

**1.9 Add secondary pointer rejection**

- File: `src/app/app-init.ts`
- In the `pointerdown` handler, track the active `pointerId` when a drag/interaction begins.
- In `pointermove` and `pointerup`, ignore events whose `pointerId` does not match the active pointer.
- This prevents multi-touch corruption of single-pointer drag state (e.g., user accidentally touches with second finger during a drag).
- Multi-touch gestures (pinch-to-zoom) are handled separately in Phase 2 with an explicit multi-pointer tracker.
- Acceptance: Touching canvas with a second finger during a drag does not corrupt drag state or cause jumps.

**1.10 Add `pointerType` branching infrastructure**

- File: `src/app/app-init.ts`
- In the `pointerdown` handler, store `e.pointerType` ('mouse' | 'touch' | 'pen')
- Export/expose this so Phase 2 and 3 can branch behavior
- Acceptance: `pointerType` is available to gesture recognition code

### Verification Strategy
- Manual test matrix: mouse click, drag, pan (middle-button), wire draw, box select, double-click, right-click context menu, wheel zoom, submenu hover, popup close, wire context menu dismiss
- All must behave identically to pre-migration
- Test on Chrome DevTools touch emulation to confirm no crashes
- Test timing diagram: pan, cursor tracking, click-to-jump
- Verify: second finger touch during drag causes no corruption
- Verify: no `MouseEvent` type annotations remain in migrated files (grep verification)

---

## Phase 2: Canvas Touch Gestures

**Goal:** Add pinch-to-zoom and one-finger pan on the canvas for touch input. Mouse behavior unchanged.

**Risk:** HIGH — Gesture disambiguation (pan vs. select-drag vs. wire-draw) is the core complexity.

### Tasks

**2.1 Implement multi-touch tracker**
- File: NEW `src/editor/touch-gestures.ts`
- Track active pointers (Map<pointerId, {x, y, startX, startY, startTime}>)
- Detect gesture states: IDLE, ONE_FINGER_WAIT, ONE_FINGER_PAN, TWO_FINGER_PINCH
- One-finger: if pointerType === 'touch' and no element/pin hit at touch point, enter pan mode after 5px movement threshold
- Two-finger: compute distance between two pointers; delta drives zoom via `viewport.zoomAt()` at midpoint
- Acceptance: Pinch-to-zoom works smoothly. One-finger pan works on empty canvas areas. One-finger on a component still selects/drags it.

**2.2 Integrate gesture tracker into app-init.ts pointerdown/move/up**
- File: `src/app/app-init.ts`
- In `pointerdown`: if `pointerType === 'touch'`, register pointer with gesture tracker
- In `pointermove`: if gesture tracker is in PINCH or PAN state, delegate to it instead of normal drag logic
- In `pointerup`/`pointercancel`: remove pointer from tracker, finalize gesture
- `setPointerCapture`: call ONLY after drag disambiguation completes (i.e., after the gesture tracker has determined the gesture type — not at `pointerdown` time). For ONE_FINGER_PAN and TWO_FINGER_PINCH, do NOT capture (allow browser to participate). For element drag / wire draw / box select, capture at the point disambiguation resolves.
- Acceptance: Mouse interactions completely unaffected. Touch pan and pinch work. Pointer capture is never set prematurely.

**2.3 Handle touch-specific hit test radius**
- File: `src/editor/hit-test.ts`
- `hitTestElements` currently uses bounding-box containment (no threshold). For touch, inflate bounding boxes by a configurable margin (e.g., 8px in world units). Accept an optional `margin` parameter.
- `hitTestPins` and `hitTestWires` use a `threshold` distance parameter. Accept a separate optional override for touch (e.g., double the default `HIT_THRESHOLD` of 0.5).
- `hitTestAll` passes both parameters through: `margin` for elements, `threshold` for pins/wires.
- In `app-init.ts`, pass larger values when `pointerType === 'touch'`.
- Acceptance: Fat-finger tapping on components and pins works reliably. Mouse hit testing is unchanged (no margin, same threshold).

### Verification Strategy
- Chrome DevTools touch emulation: two-finger pinch zoom, one-finger pan on empty area
- Verify: tap on component still selects (not pans)
- Verify: mouse interactions completely unchanged
- Verify: setPointerCapture is not called before gesture disambiguation
- Real-device gate: test on at least one physical iPad or Android tablet before merging

---

## Phase 3: Palette Touch Drag

**Goal:** Implement touch-and-drag from palette to canvas (per the agreed interaction design).

**Risk:** MEDIUM — The design is already specified in detail. Main risk is cross-element pointer capture behavior.

### Tasks

**3.1 Add pointer event handlers to palette items**
- File: `src/editor/palette-ui.ts`
- Current state: palette items use `click` event (grep: `item.addEventListener("click"`). This fires for both mouse and touch. The migration to `pointerdown` is needed specifically for drag initiation timing — `click` fires on release, but drag detection needs to begin at press time.
- Add `pointerdown` handler on `.palette-component-item` elements. Keep `click` as a fallback for mouse users who expect click-to-place behavior.
- On `pointerdown` with `pointerType === 'touch'`: record start position. Do NOT set `pointerCapture` yet.
- On `pointermove`: apply disambiguation logic:
  - Vertical >10px within 150ms = cancel, allow palette scroll (never captured)
  - Horizontal >10px OR hold >= 150ms = begin drag mode. NOW call `setPointerCapture` (after disambiguation, not at pointerdown)
- On `pointerup`: if in drag mode and over canvas, place component; otherwise cancel
- For `pointerType === 'mouse'`: keep existing click-to-place flow (immediate placement mode activation)
- Acceptance: Touch users can drag components from palette onto canvas. Mouse users still click-to-place. Palette vertical scrolling is not broken by the pointerdown listener.

**3.2 Implement drag ghost visual**
- File: `src/editor/palette-ui.ts` (or new `src/editor/palette-drag.ts`)
- On drag start: create floating ghost element (clone of palette item icon)
- Position ghost with 40px up / 20px right offset from finger
- When ghost is over canvas area: snap to grid, show drop shadow + scale(1.1)
- On cancel: animate ghost back to palette item position, then remove
- Dim original palette item to 30% opacity during drag
- Acceptance: Visual feedback matches the agreed design spec

**3.3 Integrate drop with placement system**
- File: `src/editor/palette-ui.ts`, `src/app/app-init.ts`
- On drop over canvas: convert screen position to world coordinates (using the refactored `canvasToWorld` that accepts `{ clientX, clientY }`), call existing placement logic to add the component at the snapped grid position
- Reuse `PlacementMode` or directly add to circuit + call `invalidateCompiled()`
- Acceptance: Dropped component appears at correct grid position, is selected, undo works

### Verification Strategy
- Touch emulation: drag from palette to canvas, verify placement
- Test disambiguation: vertical scroll in palette still works, horizontal drag initiates component drag
- Test cancel: release outside canvas, ghost animates back
- Test mouse: click-to-place still works unchanged
- Real-device gate: test on physical tablet before merging

---

## Phase 4: Responsive Layout

**Goal:** Make the layout work on tablet screens (768px+) with graceful handling down to 600px.

**Risk:** LOW-MEDIUM — CSS-only changes plus minor DOM toggling. No interaction logic changes.

**Dependencies:**
- Tasks 4.1 and 4.3 are CSS-only and can begin after Phase 1 (no interaction logic dependency).
- Task 4.2 (palette toggle) requires Phase 3 complete — the toggle button shares pointer event patterns with palette drag.
- Task 4.4 (resize handles) requires Phase 3 complete — drag handles use pointer events with capture.

### Tasks

**4.1 Add responsive breakpoints to simulator.html CSS** [Phase-1-independent]
- File: `simulator.html`
- Add `@media (max-width: 768px)` breakpoint:
  - Palette: collapse to 0px width, show toggle button (hamburger icon) in menubar
  - Menubar: increase height to 44px, increase touch targets on menu items to 44px
  - Status bar: increase to 32px height
  - Viewer panel: reduce default height to 180px
- Add `@media (max-width: 600px)` breakpoint:
  - Palette: overlay mode (position: absolute, z-index above canvas)
  - Menubar: consolidate to hamburger menu (single menu button opens drawer)
- Acceptance: At 768px, palette is hidden with toggle. At 600px, menu is a drawer. Canvas gets maximum space.

**4.2 Implement palette toggle** [Requires Phase 3]
- File: `src/app/app-init.ts` or new `src/editor/responsive.ts`
- Add a toggle button to the menubar (visible only at <= 768px via CSS)
- Toggle button shows/hides palette panel
- When shown on narrow screens, palette overlays canvas (position: absolute)
- Tap outside palette or on canvas dismisses it
- Acceptance: Palette can be opened/closed on narrow screens. Opening palette doesn't push canvas.

**4.3 Enlarge touch targets conditionally** [Phase-1-independent]
- File: `simulator.html`
- Use `@media (pointer: coarse)` to enlarge:
  - `.menu-item` padding to 44px height
  - `.menu-action` padding to 44px height
  - `.palette-component-item` padding to 44px height
  - Toolbar buttons to 44px minimum
- Acceptance: All interactive elements meet 44px minimum on touch devices

**4.4 Add panel resize handles** [Requires Phase 3]
- File: `simulator.html` (CSS), `src/app/app-init.ts` (drag logic)
- Add 6px resize handle between palette and canvas (visible as a subtle drag indicator)
- Add 6px resize handle between workspace and viewer panel
- Use pointer events for drag (consistent with Phase 1 migration), with `setPointerCapture` after drag disambiguation (consistent with Phase 2/3 pattern)
- Acceptance: User can drag to resize palette width and viewer panel height

### Verification Strategy
- Chrome DevTools responsive mode at 1024px, 768px, 600px
- Verify palette toggle works at 768px
- Verify menu drawer works at 600px
- Verify touch targets are >= 44px with `pointer: coarse`
- Verify canvas gets maximum space at each breakpoint

---

## Phase 5: Polish and Accessibility

**Goal:** CSS transitions, long-press context menu, ARIA roles, and keyboard navigation improvements.

**Risk:** LOW — Additive changes, no interaction model changes.

### Tasks

**5.1 Add CSS transitions**
- File: `simulator.html`
- Add transitions to: palette show/hide (slide), viewer panel open/close (slide), menu dropdown open (fade+slide), dialog overlays (fade)
- Use `prefers-reduced-motion: reduce` to disable transitions for accessibility
- Acceptance: Panel and menu animations are smooth. Reduced-motion users see instant transitions.

**5.2 Long-press context menu for touch**
- File: `src/app/app-init.ts`
- On `pointerdown` with `pointerType === 'touch'`: start 500ms timer
- If pointer doesn't move >10px within 500ms: show context menu at touch position
- Cancel timer on `pointermove` (>10px), `pointerup`, or `pointercancel`
- Reuse existing `contextmenu` handler / `buildMenuForElement` from context-menu.ts
- Acceptance: Long-press on element shows context menu on touch. Right-click still works on desktop.

**5.3 ARIA roles and keyboard navigation**
- File: `simulator.html`, `src/editor/palette-ui.ts`, `src/app/app-init.ts`
- Add `role="menubar"`, `role="menu"`, `role="menuitem"` to menu structure
- Add `role="tree"`, `role="treeitem"` to palette
- Add `tabindex` and arrow-key navigation to palette items
- Add focus trap to dialogs (test dialog, circuit picker)
- Add `aria-label` to canvas element
- Acceptance: Screen reader can navigate menus and palette. Tab key moves through interactive elements in logical order.

**5.4 Focus-visible ring styling**
- File: `simulator.html`
- Add `:focus-visible` styles to all interactive elements (buttons, menu items, palette items, inputs)
- Use `outline: 2px solid var(--accent); outline-offset: 2px`
- Acceptance: Keyboard focus is clearly visible. Mouse clicks do not show focus ring.

### Verification Strategy
- Manual test: all transitions play, respect `prefers-reduced-motion`
- Manual test: long-press on touch shows context menu
- Screen reader test (VoiceOver or NVDA): navigate menus, palette, dialogs
- Keyboard-only test: tab through all interactive elements

---

## Phase 6: High-Impact Feature Surfacing

**Goal:** Connect fully-implemented backend features to the UI. These are features users would expect to find — dark mode, export, memory editor, search, and the analysis suite.

**Risk:** MEDIUM — Each feature is self-contained, but the analysis suite has 6+ tools that need a coherent panel design. All new UI elements must inherit Phase 4 responsive behavior and Phase 1 pointer events.

**Dependencies:** Phase 4 (responsive layout) must be complete. New toolbar buttons need 44px touch targets from `@media (pointer: coarse)`. New menu items must work in the responsive hamburger menu at 600px. New dialogs must use mobile-friendly sizing.

### Tasks

**6.1 Dark mode toggle button**

- Backend: `src/editor/color-scheme.ts` — `ColorSchemeManager.setActive(name)` switches schemes; `getActiveName()` reads current; `onChange()` triggers re-render. Built-in schemes: `"default"` (dark), `"high-contrast"`, `"monochrome"`.
- Currently accessible only via URL parameter `dark=0` (parsed in `src/app/url-params.ts`, line: `const dark = darkRaw === null ? true : darkRaw !== '0'`).
- UI: Add a toggle button to the right side of the menubar (in `div.menubar-speed` area, after the timing/values buttons, separated by a divider). Icon: sun/moon glyph. Tooltip: "Toggle light/dark mode".
- File changes: `simulator.html` (add button DOM + CSS), `src/app/app-init.ts` (wire click handler to `colorSchemeManager.setActive(name === 'default' ? 'light' : 'default')` and toggle icon).
- Persist preference in `localStorage` key `"digital-color-scheme"`. On startup, read localStorage before URL param (URL param overrides localStorage if present).
- Acceptance: Button toggles between light and dark. Preference survives page reload. URL `dark=0` still overrides. Button meets 44px touch target on coarse pointer devices.

**6.2 Export menu (SVG/PNG/GIF/ZIP)**

- Backend files:
  - `src/export/svg.ts` — `exportSvg(circuit, options): string` returns SVG markup
  - `src/export/png.ts` — `exportPng(circuit, options): Promise<Blob>` returns PNG blob
  - `src/export/gif.ts` — `exportGif(circuit, engine, options): Promise<Blob>` returns animated GIF blob
  - `src/export/zip.ts` — `exportZip(circuit, subcircuits, dataFiles): Promise<Blob>` returns ZIP blob
- Currently: zero UI. No menu items, no buttons. Export functions exist but are never called from the app.
- UI: Add an "Export" submenu under the existing **File** menu (after "Save As...", before the format separator). Submenu items:
  - "Export as SVG..." — calls `exportSvg()`, creates `Blob`, triggers download via `URL.createObjectURL` + hidden `<a>` click
  - "Export as PNG..." — calls `exportPng()`, triggers download
  - "Export as PNG (2x)..." — calls `exportPng({ scale: 2 })`, triggers download
  - "Export as Animated GIF..." — calls `exportGif()` (requires running engine; gray out if engine is STOPPED), triggers download
  - "Export as ZIP..." — calls `exportZip()`, triggers download
- File changes: `simulator.html` (add submenu DOM under File dropdown), `src/app/app-init.ts` (wire click handlers, import export functions, implement download helper).
- Download helper: `function downloadBlob(blob: Blob, filename: string)` — create object URL, set `<a>.download`, click, revoke URL.
- Acceptance: Each export format downloads a valid file. GIF menu item is disabled when engine is STOPPED. Filenames use circuit name from metadata. Submenu works in responsive hamburger menu at 600px.

**6.3 Memory editor dialog**

- Backend: `src/runtime/memory-editor.ts` — `MemoryEditorDialog` class with `render(container)`, `enableLiveUpdate(engine)`, `disableLiveUpdate()`. Works with any `DataField` (RAM, ROM, EEPROM). Uses virtualized `HexGrid` for large memories.
- Currently: zero UI. The class exists but is never instantiated from the app.
- UI: Open the memory editor when the user double-clicks (or long-press on touch) a RAM/ROM/EEPROM component. Reuse the existing property popup mechanism but render a larger dialog panel.
- Dialog design: Modal overlay (same pattern as test dialog). Title: "{label}: {typeId} ({size} words x {width} bits)". Body: `MemoryEditorDialog.render(bodyElement)`. Footer: "Go to Address" input + "Close" button. If engine is running, auto-enable live update.
- File changes: `src/app/app-init.ts` (detect double-click on memory component by checking `typeId` in `["RAM", "EEPROM", "ROM", "RegisterFile"]`; instantiate `MemoryEditorDialog`; show modal). `simulator.html` (add modal overlay CSS if not already present — reuse test dialog pattern).
- Touch integration: Long-press (Phase 5) on a memory component should also open the editor. Add to the context menu: "Edit Memory..." item for memory components.
- Acceptance: Double-click on RAM opens hex editor. Values can be edited in-place. Live update highlights changed cells during simulation. Dialog is scrollable on mobile. Close button dismisses. Go-to-address navigates.

**6.4 ROM/RAM file loading — file picker for FILE properties**

- Backend: The component property system has a `FILE` property type. Currently in `src/app/app-init.ts`, property rendering falls through to a plain `TextInput` for FILE properties — users can only type a filename, not browse for one.
- UI: When rendering a FILE property in the property panel, add a "Browse..." button (styled as a small icon button) next to the text input. Clicking it opens a native file picker (`<input type="file" accept=".hex,.bin,.dat">`). On file selection, read the file content and set the property value.
- File changes: `src/app/app-init.ts` (in the property rendering switch/if block, add case for FILE type that renders input + button pair), `simulator.html` (CSS for the browse button).
- Acceptance: FILE properties show a browse button. Clicking opens native file picker. Selected file name appears in the text input. File content is loaded into the component's data field.

**6.5 Search dialog (Ctrl+F)**

- Backend: `src/editor/search.ts` — `CircuitSearch` class with `search(circuit, query): SearchResult[]` and `navigateTo(result, viewport)`. Matches labels, type names, and tunnel names (case-insensitive substring).
- Currently: zero UI. The search class is never instantiated from the app.
- UI: Ctrl+F (and a "Find..." item in the Edit menu) opens a search bar. Design: floating bar at top of canvas (similar to browser find bar). Text input + "Previous" / "Next" buttons + result count display + "Close" (Esc).
- Behavior: On each keystroke (debounced 150ms), call `circuitSearch.search(circuit, query)`. Display "{N} results" count. "Next" / "Previous" cycle through results, calling `navigateTo(result, viewport)` which centers the viewport on the matched element. Highlight the current result element with a temporary selection ring on canvas.
- File changes: `simulator.html` (search bar DOM + CSS — absolutely positioned over canvas container), `src/app/app-init.ts` (Ctrl+F keybinding, instantiate `CircuitSearch`, wire input events, wire navigation buttons).
- Touch: Search bar input must have adequate height (44px) on touch devices. Close button must be 44px.
- Acceptance: Ctrl+F opens search bar. Typing filters elements. Next/Previous navigate and center viewport. Esc closes. Works in responsive layout.

**6.6 Analysis suite panel**

- Backend: The `src/analysis/` directory contains a complete analysis toolkit with zero UI:
  - `model-analyser.ts` — `analyseCircuit(circuit, facade): TruthTable` — generates truth tables for combinational circuits (up to 20 input bits)
  - `truth-table-ui.ts` — `TruthTableTab` — renders editable truth table grid with clickable output cells (0/1/X cycling)
  - `karnaugh-map.ts` — `KarnaughMap` (data model) + `KarnaughMapTab` (UI controller) — 2-6 variable K-maps with Gray code ordering and implicant loop visualization
  - `quine-mccluskey.ts` — `minimize(table, outputIndex): MinimizationResult` — boolean expression minimization with prime implicants and minimal cover selection
  - `expression-gen.ts` — `generateSOP(table, outputIndex)` / `generatePOS(table, outputIndex)` — canonical sum-of-products and product-of-sums expression generation
  - `expression-editor.ts` — `ExpressionEditorTab` — text input for boolean expressions with parsing, validation, and truth table conversion
  - `synthesis.ts` — `synthesizeCircuit(expressions, inputNames, registry): Circuit` — generates a circuit from boolean expressions
- Currently: zero UI. None of these are connected to any menu, button, or dialog.
- UI: Add an **Analysis** top-level menu item to the menubar (between "Simulation" and the circuit-name input). Menu items:
  - "Analyse Circuit..." — opens the analysis dialog
  - "Synthesise Circuit..." — opens a dialog to enter expressions and generate a circuit
- Analysis dialog: Tabbed panel (reuse viewer-panel tab pattern). Tabs:
  - **Truth Table** — calls `analyseCircuit()`, renders via `TruthTableTab.render(container)`. Shows error if circuit has feedback loops or >20 input bits.
  - **K-Map** — renders `KarnaughMapTab` for the selected output column. Dropdown to select output variable.
  - **Expressions** — shows minimized expressions from `minimize()` and canonical forms from `generateSOP()`/`generatePOS()`. One row per output.
  - **Expression Editor** — renders `ExpressionEditorTab`. User types an expression; on valid parse, shows its truth table below. "Generate Circuit" button calls `synthesizeCircuit()` and loads the result.
- Dialog sizing: Modal overlay, 80% viewport width, max 900px. On mobile (<768px): full-width, 90vh height, scrollable tabs.
- File changes: `simulator.html` (add Analysis menu DOM + analysis dialog modal + tab CSS), `src/app/app-init.ts` (wire menu click handlers, instantiate analysis classes, manage dialog open/close/tab switching).
- Acceptance: "Analyse Circuit" generates and displays a truth table. K-Map tab shows the correct map for each output. Expressions tab shows minimized expressions. Expression editor parses input and can synthesize a circuit. Dialog works on mobile. All menu items work in responsive hamburger.

### Verification Strategy (Phase 6)
- Each feature has an independent acceptance test — can be verified in isolation.
- Test dark mode toggle: click toggles scheme, reload preserves preference, URL param overrides.
- Test exports: SVG opens in browser, PNG opens in image viewer, GIF animates, ZIP contains .dig file.
- Test memory editor: double-click RAM, edit a cell, verify value persists, verify live update during simulation.
- Test search: Ctrl+F, type a label, Next centers viewport on match.
- Test analysis: open with a simple 2-input AND gate circuit, verify truth table has 4 rows with correct outputs.
- Responsive: all new dialogs and menus work at 768px and 600px breakpoints.

---

## Phase 7: Editor Tools Surfacing

**Goal:** Expose medium-impact editor tools that are implemented but lack UI affordances — debugging controls, viewport tools, and edit toolbar buttons.

**Risk:** LOW — Each feature is a single button or menu item wiring to an existing API call. No complex dialog or panel design.

**Dependencies:** Phase 4 (responsive layout) for touch targets and hamburger menu compatibility.

### Tasks

**7.1 microStep debugger button**

- Backend: `SimulationEngine.microStep()` in `src/core/engine-interface.ts` — executes a single micro-step (one event from the priority queue). Returns void.
- Currently: accessible only programmatically. No button, no menu item.
- UI: Add a "Micro Step" button to the `div.menubar-speed` toolbar area, between the existing "Single step" (`btn-tb-step`) and "Stop" (`btn-tb-stop`) buttons. Icon: double-chevron-right or step-into glyph. Tooltip: "Micro step (single event)".
- Also add "Micro Step" as a menu item in the **Simulation** menu (after "Step", before "Run").
- On click: call `engine.microStep()`. After the step, trigger a re-render so component state changes are visible on canvas.
- Disabled state: gray out when engine state is STOPPED (no compiled circuit).
- File changes: `simulator.html` (add button DOM in toolbar, add menu item), `src/app/app-init.ts` (wire click handler).
- Acceptance: Button executes one micro-step. Canvas updates to reflect the new state. Button is disabled when no circuit is compiled.

**7.2 Run to Break button**

- Backend: `SimulationEngine.runToBreak()` in `src/core/engine-interface.ts` — runs the simulation until a Break component fires or the engine stops.
- Currently: accessible only programmatically. No button, no menu item.
- UI: Add a "Run to Break" menu item in the **Simulation** menu (after "Run", before "Stop"). Also add a toolbar button in `div.menubar-speed` area (after the run button). Icon: play-with-bar glyph. Tooltip: "Run to breakpoint".
- On click: call `engine.runToBreak()`. When the engine stops (break hit or manual stop), trigger re-render.
- Disabled state: gray out when engine state is STOPPED.
- File changes: `simulator.html` (add button + menu item), `src/app/app-init.ts` (wire handler).
- Acceptance: Button runs simulation until break. Engine stops at Break component. Button disabled when no circuit compiled.

**7.3 Auto-add power supplies menu item**

- Backend: `src/editor/auto-power.ts` — `autoConnectPower(circuit): EditCommand` returns an undoable command that adds VDD/GND components for all unconnected power pins. `findUnconnectedPowerPins(circuit)` scans for candidates.
- Currently: zero UI. The function exists but is never called.
- UI: Add "Auto-Connect Power Supplies" item to the **Edit** menu (after "Select All", before "Tests...").
- On click: call `autoConnectPower(circuit)`, push the returned `EditCommand` onto the `UndoRedoStack`. Show status bar message: "Added {N} power supplies" or "No unconnected power pins found".
- Disabled state: gray out when circuit is locked.
- File changes: `simulator.html` (add menu item), `src/app/app-init.ts` (wire handler, import `autoConnectPower`).
- Acceptance: Menu item adds VDD/GND elements for unconnected power pins. Undo reverses the operation. Status bar shows result count. Disabled in locked mode.

**7.4 Fit to Content button + shortcut**

- Backend: `src/editor/viewport.ts` — `Viewport.fitToContent(elements, canvasSize)` sets zoom and pan to show all elements with margin.
- Currently: the method exists but is never called from any UI affordance.
- UI: Add a toolbar button in `div.menubar-speed` area (after the timing/values buttons, near the dark mode toggle). Icon: expand-arrows or fit-to-screen glyph. Tooltip: "Fit to content (Ctrl+Shift+F)".
- Keyboard shortcut: Ctrl+Shift+F.
- Also add "Fit to Content" item in the **Edit** menu.
- On click: call `viewport.fitToContent(circuit.elements, { width: canvas.width, height: canvas.height })`, then trigger re-render.
- File changes: `simulator.html` (add button + menu item), `src/app/app-init.ts` (wire handler + keybinding).
- Acceptance: Button zooms/pans to show all elements. Ctrl+Shift+F does the same. Works correctly with empty circuits (resets to zoom=1).

**7.5 Zoom percentage display in status bar**

- Backend: `Viewport.zoom` is a public property (current zoom level, 0.1-10.0).
- Currently: zoom level is not displayed anywhere.
- UI: Add a zoom percentage indicator to the right side of the status bar (`#status-bar`), next to `#status-coords`. Format: "125%" (zoom * 100, rounded to nearest integer). Clickable: clicking opens a small dropdown with preset zoom levels (50%, 75%, 100%, 150%, 200%, "Fit").
- Update the display on every zoom change (wheel zoom, pinch zoom, fit-to-content).
- File changes: `simulator.html` (add span + dropdown CSS in status bar), `src/app/app-init.ts` (update zoom display after every viewport mutation, wire preset click handlers).
- Acceptance: Status bar shows current zoom percentage. Clicking presets changes zoom. Display updates on wheel/pinch zoom.

**7.6 Lock/unlock toggle button**

- Backend: `src/editor/locked-mode.ts` — `LockedModeGuard` with `setLocked(bool)`, `isLocked()`, `canEdit()`.
- Currently accessible only via URL parameter `locked=1`.
- UI: Add a toggle button to the right side of the menubar. Icon: padlock (closed when locked, open when unlocked). Tooltip: "Lock/unlock editing".
- Visual indicator: when locked, show a subtle banner or tint on the canvas border indicating locked state.
- File changes: `simulator.html` (add button DOM + locked-state CSS), `src/app/app-init.ts` (wire click handler to `lockedModeGuard.setLocked(!current)`, update icon).
- Acceptance: Button toggles locked state. Padlock icon changes. Editing operations are blocked when locked. Interactive components (In, Button, Switch, DipSwitch) remain usable when locked.

**7.7 Undo/Redo toolbar buttons**

- Backend: `src/editor/undo-redo.ts` — `UndoRedoStack` with `undo(): boolean`, `redo(): boolean`, `canUndo()`, `canRedo()`.
- Currently: only accessible via Ctrl+Z / Ctrl+Y keyboard shortcuts and Edit menu items (`btn-undo`, `btn-redo`). No toolbar buttons.
- UI: Add Undo and Redo toolbar buttons to the menubar, positioned after the Edit menu item (or in the `div.menubar-speed` area, before the simulation controls). Icons: curved-arrow-left (undo), curved-arrow-right (redo). Tooltips: "Undo (Ctrl+Z)", "Redo (Ctrl+Y)".
- Disabled state: gray out Undo when `!canUndo()`, gray out Redo when `!canRedo()`. Update disabled state after every push/undo/redo (hook into `afterMutate` callback or re-check after each operation).
- File changes: `simulator.html` (add button DOM + disabled styling), `src/app/app-init.ts` (wire click handlers, update disabled state).
- Acceptance: Buttons undo/redo operations. Disabled state correctly reflects stack emptiness. Touch targets are 44px on coarse pointer devices.

### Verification Strategy (Phase 7)
- Each button/menu item can be tested independently.
- Test microStep: compile a simple circuit, click micro-step, verify one event processed.
- Test run-to-break: circuit with a Break component, click run-to-break, verify engine stops at break.
- Test auto-power: circuit with 74xx component (has VDD/GND pins), menu item adds supplies, undo removes them.
- Test fit-to-content: place components far apart, click fit, verify all visible.
- Test zoom display: wheel-zoom, verify percentage updates.
- Test lock/unlock: toggle, verify editing blocked, verify interactive components still work.
- Test undo/redo buttons: perform edit, click undo button, verify reverted, click redo, verify restored.
- Responsive: all buttons visible and usable at 768px. At 600px, toolbar buttons should be in overflow menu or remain accessible.

---

## Phase 8: Specialist Feature Surfacing

**Goal:** Expose lower-priority specialist features that serve advanced users — critical path analysis, state machine tools, custom color schemes, and engine tuning settings.

**Risk:** LOW — Each feature is independent. The most complex is the state diagram editor (8.2), which can be deferred to a later iteration if needed.

**Dependencies:** Phase 4 (responsive layout). Phase 6 (analysis dialog provides the modal/tab pattern to reuse).

### Tasks

**8.1 Critical path analysis report**

- Backend: `src/analysis/path-analysis.ts` — `findCriticalPath(circuit, registry): CriticalPath` returns `{ pathLength: number, components: string[], gateCount: number }`.
- Currently: zero UI. The function is never called from the app.
- UI: Add a "Critical Path..." item to the **Analysis** menu (created in Phase 6.6). On click: call `findCriticalPath()`, display results in a modal dialog.
- Dialog content: "Critical Path Length: {N} ns", "Gate Count: {M}", and a list/table of components on the path in topological order. Optionally, highlight the critical path components on the canvas with a colored overlay (temporary, dismissed on dialog close).
- File changes: `simulator.html` (add menu item under Analysis, dialog markup if needed), `src/app/app-init.ts` (wire handler, import `findCriticalPath`, render results).
- Acceptance: Menu item computes and displays critical path. Path length and components are correct for a known test circuit. Dialog works on mobile.

**8.2 State machine analysis (state transition table)**

- Backend: `src/analysis/state-transition.ts` — `analyseStateTransitions(facade, circuit, stateVars, inputs, outputs): StateTransitionTable` enumerates all (state, input) combinations and records next-state + output values.
- Currently: zero UI. The function is never called.
- UI: Add "State Transition Table..." item to the **Analysis** menu. On click: identify flip-flop Q outputs as state variables, identify In/Out components, call `analyseStateTransitions()`, display results in a modal table.
- Table format: columns for current state variables, input variables, next state variables, output variables. One row per (state, input) combination.
- Stretch goal (can be deferred): graphical state diagram visualization using Canvas2D or SVG, showing states as nodes and transitions as labeled edges. This is a significant UI effort and can be a separate plan item.
- File changes: `simulator.html` (add menu item), `src/app/app-init.ts` (wire handler, detect flip-flops, call analysis, render table).
- Acceptance: Menu item produces a state transition table for a sequential circuit (e.g., simple counter). Table values are correct. Error shown if circuit has no flip-flops.

**8.3 Custom color scheme dialog**

- Backend: `src/editor/color-scheme.ts` — `ColorSchemeManager.createCustomScheme(name, colors)` registers a new scheme. `buildColorMap(base, overrides)` builds a full color map from partial overrides. `getSchemeNames()` lists all registered schemes. `THEME_COLORS` array enumerates all theme color keys.
- Currently: custom schemes can only be created programmatically. No UI.
- UI: Add "Color Scheme..." item to a **View** menu (new top-level menu between Edit and Insert). Dialog shows:
  - Dropdown to select active scheme from `getSchemeNames()`.
  - Color grid: one row per `ThemeColor`, showing current color swatch + color picker input.
  - "Save Custom..." button: prompts for scheme name, calls `createCustomScheme()`.
  - "Reset to Default" button.
- The **View** menu also hosts: "Dark Mode" (toggle, moved from toolbar for menu consistency — keep toolbar button as well), "IEEE / IEC Gate Style" (toggle, wired to `setGateShapeStyle()`), "Presentation Mode" (see 8.6).
- File changes: `simulator.html` (add View menu + dialog markup + color picker CSS), `src/app/app-init.ts` (wire dialog, import `THEME_COLORS`, `buildColorMap`).
- Acceptance: User can select built-in schemes. User can create a custom scheme with overridden colors. Custom scheme persists in the session. Gate style toggle switches between IEEE and IEC rendering.

**8.4 Snapshot memory budget setting**

- Backend: `SimulationEngine.setSnapshotBudget(bytes)` in `src/core/engine-interface.ts` — controls how much memory the engine allocates for state snapshots (used for undo-during-simulation and timing diagram history).
- Currently: only settable programmatically. No UI.
- UI: Add to a **Settings** dialog (opened from a gear icon in the menubar or from a "Settings..." item in the Edit or View menu). Setting: "Snapshot Memory Budget" — numeric input with unit dropdown (KB/MB). Default: show current value. Range: 1MB - 256MB.
- File changes: `simulator.html` (settings dialog markup), `src/app/app-init.ts` (wire dialog, call `engine.setSnapshotBudget()`).
- Acceptance: User can change snapshot budget. Value takes effect on next simulation start. Persisted in localStorage.

**8.5 Oscillation detection limit setting**

- Backend: `src/engine/oscillation.ts` — `OscillationDetector` constructor accepts a `limit` parameter (default: `DEFAULT_OSCILLATION_LIMIT = 1000`). This is the number of micro-step iterations before oscillation is declared in a feedback SCC.
- Currently: only configurable at construction time. No UI.
- UI: Add to the same **Settings** dialog as 8.4. Setting: "Oscillation Detection Limit" — numeric input. Default: 1000. Range: 100 - 100000. Tooltip: "Number of feedback iterations before oscillation is detected. Higher values allow more complex circuits to stabilize."
- On change: store in localStorage, apply on next circuit compile (the detector is created fresh each time).
- File changes: `simulator.html` (add to settings dialog), `src/app/app-init.ts` (wire input, persist to localStorage, pass to engine on compile).
- Acceptance: User can change oscillation limit. Value persists across page reloads. Higher limit allows circuits with long feedback settling to stabilize.

**8.6 Presentation mode toolbar button**

- Backend: `src/app/url-params.ts` — `panels: 'default' | 'none'` controls panel visibility. When `panels=none`, palette, property panel, and viewer are hidden.
- Currently: accessible via URL `panels=none` and apparently bound to F4 (undiscoverable).
- UI: Add a "Presentation Mode" button to the menubar (right side, near dark mode toggle). Icon: expand/projector glyph. Tooltip: "Presentation mode (F4)". Also add "Presentation Mode" item to the **View** menu.
- Behavior: toggle hides palette panel, property panel, status bar, and menubar (except a small floating "Exit Presentation" button in the corner). F4 key toggles. Esc exits presentation mode.
- File changes: `simulator.html` (add button + presentation-mode CSS that hides panels), `src/app/app-init.ts` (wire F4 handler, toggle class on `#app`).
- Acceptance: Button/F4 enters presentation mode. Canvas gets full viewport. Esc/F4/floating button exits. Works on touch devices (floating exit button is 44px).

### Verification Strategy (Phase 8)
- Test critical path: 3-gate chain circuit, verify path length = 3 * default_delay.
- Test state transition: simple 2-state counter, verify table has correct rows.
- Test custom colors: change WIRE color, verify canvas updates, create custom scheme, select it.
- Test settings: change snapshot budget, verify no crash. Change oscillation limit, verify stored.
- Test presentation mode: F4 toggles, panels hide, exit works via Esc and button.
- Responsive: all dialogs work at 768px and 600px.

---

## Cross-Phase Verification Gates

Each phase must pass these gates before merging:

### Automated regression
- All existing unit tests pass (`npm test`)
- TypeScript compiles with zero errors (`npx tsc --noEmit`)
- Zero `MouseEvent` type annotations remain in migrated files (grep check, added per phase)

### Desktop manual test matrix
- Click select, drag, pan (middle-button), wire draw, box select
- Double-click property popup
- Right-click context menu
- Wheel zoom
- Submenu hover open/close
- Timing diagram pan + click-to-jump

### Touch emulation gate (Chrome DevTools)
- Single tap selects component
- Single tap on empty area does not break state
- Two-finger pinch (Phase 2+)
- Second finger during drag does not corrupt state (Phase 1+)

### Real-device gate (Phase 2+ only)
- Test on at least one physical iPad or Android tablet before merging each phase
- Verify `dblclick` fires (or activate double-tap fallback if it does not)
- Verify `touch-action: none` does not break screen reader navigation
- Document results in PR description

### Rollback strategy
- Each phase is a separate branch/PR
- If a phase introduces regressions that cannot be resolved within one sprint, revert the entire phase PR
- Phase 0 inventory document is never reverted (pure documentation)

---

## Success Criteria

### Phases 0-5: Touch & Responsive

1. All existing desktop mouse interactions work identically (zero regression)
2. Pinch-to-zoom and one-finger pan work on touch devices
3. Components can be dragged from palette to canvas on touch
4. Layout is usable at 768px width (tablet portrait)
5. Touch targets are >= 44px on touch/coarse-pointer devices
6. Long-press opens context menu on touch
7. iframe postMessage API passes existing integration tests
8. No simulation logic introduced into editor/UI layer
9. No framework dependencies added
10. `pointercancel` resets drag state cleanly
11. Secondary pointer does not corrupt single-pointer interactions
12. Real-device testing completed for Phases 2-5

### Phase 6: High-Impact Features

13. Dark mode toggles via toolbar button; preference persists in localStorage
14. All four export formats (SVG, PNG, GIF, ZIP) produce valid downloadable files
15. Memory editor opens on double-click of RAM/ROM/EEPROM; values editable; live update works
16. Search (Ctrl+F) finds components by label/type and navigates viewport to results
17. Analysis dialog shows truth table, K-map, and minimized expressions for a combinational circuit
18. Expression editor parses input and can synthesize a circuit

### Phase 7: Editor Tools

19. microStep button processes one event and updates canvas
20. Run-to-Break button stops at Break components
21. Auto-Connect Power Supplies adds VDD/GND for unconnected power pins (undoable)
22. Fit to Content button centers viewport on all elements
23. Zoom percentage displayed in status bar and updates on every zoom change
24. Lock/unlock toggle works from toolbar button (not just URL param)
25. Undo/Redo toolbar buttons reflect stack state (disabled when empty)

### Phase 8: Specialist Features

26. Critical path analysis produces a report with correct delay and component list
27. State transition table enumerates all (state, input) combinations for sequential circuits
28. Custom color scheme can be created and applied in a single session
29. Snapshot budget and oscillation limit are user-configurable and persisted
30. Presentation mode is accessible via toolbar button and F4 key

### Cross-cutting

31. All new UI elements (buttons, menus, dialogs) work in responsive layout at 768px and 600px
32. All new toolbar buttons meet 44px touch targets on coarse pointer devices
33. All new menu items work in the responsive hamburger menu at 600px
34. All new dialogs are scrollable on mobile

---

## ADR: Pointer Events Migration

**Decision:** Migrate from Mouse Events to Pointer Events API for all canvas and UI interactions.

**Drivers:**
1. Touch support is a blocking requirement for university tablet deployment
2. Palette drag-to-canvas requires `setPointerCapture` which only exists on Pointer Events
3. Long-term maintainability — single event model vs. dual mouse+touch code paths

**Alternatives considered:**
- **Dual Mouse + Touch layers:** Rejected due to double code maintenance, no `setPointerCapture`, no pen support
- **Hammer.js / third-party gesture library:** Rejected due to no-framework constraint and bundle size concern for an iframe-embedded app

**Why chosen:** Pointer Events provide unified mouse/touch/pen handling with `setPointerCapture` for cross-element drag, which is specifically needed for the palette drag interaction. The 1:1 mapping from MouseEvent properties means the migration is mechanical for existing handlers.

**Consequences:**
- All event handler signatures change from `MouseEvent` to `PointerEvent` (TypeScript will catch misuses)
- Must add `touch-action: none` on canvas — applied conditionally via JS to preserve accessibility baseline
- Must handle `pointercancel` to prevent stuck drag state (new requirement vs. mouse-only)
- Must reject secondary pointers during single-pointer interactions
- Must test on real touch devices (not just emulation) before shipping each phase
- `setPointerCapture` must be deferred until after drag disambiguation, not called at `pointerdown` time

**Follow-ups:**
- Consider adding haptic feedback (navigator.vibrate) for component placement on touch
- Consider gesture tutorial/onboarding for first-time touch users
- Evaluate dirty-rect rendering optimization (P2 item) if low-end tablet performance is poor
- `tutorial-viewer.html` responsive/touch pass — separate plan item (currently only uses onclick, no mouse events)
- Phase 6-8 feature surfacing — surface implemented-but-hidden engine features (dark mode, export, memory editor, search, analysis suite, debugging controls, editor tools, settings)
- State diagram graphical editor (Phase 8.2 stretch goal) — Canvas2D/SVG state diagram visualization; separate plan item if pursued
- Settings persistence strategy — Phases 6-8 add multiple localStorage keys; consider a unified settings object with schema versioning
