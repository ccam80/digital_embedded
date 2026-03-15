# Mouse Event Inventory Audit

Generated: 2026-03-15
Scope: `src/` (all `.ts`, `.html`) + `simulator.html`

---

## Summary

| Phase | File(s) | Mouse event count | Migration action |
|-------|---------|-------------------|-----------------|
| 1A | `src/app/app-init.ts` | 11 mouse events + 5 type annotations + 2 casts | `mouse*→pointer*`, change type annotations |
| 1B | `src/runtime/timing-diagram.ts` | 5 addEventListener + 5 removeEventListener + 5 type annotations | `mouse*→pointer*`, change type annotations |
| 1B | `src/runtime/data-table.ts` | 1 addEventListener + 1 removeEventListener + 1 cast + 1 type annotation | `contextmenu→contextmenu` (keep), change cast/annotation |
| 1C | `simulator.html` inline script | 3 mouse events | `mouseenter/mouseleave→pointerenter/pointerleave` |
| test | `src/runtime/__tests__/timing-diagram.test.ts` | 3 `new MouseEvent()` | update to `PointerEvent` or keep if testing mouse specifically |
| keep | `src/editor/context-menu.ts` | 1 click dismiss | keep as-is (click is pointer-agnostic) |
| keep | `src/editor/palette-ui.ts` | 1 click handler | keep as-is |

---

## Detailed Inventory

### Phase 1A — `src/app/app-init.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 464 | `function canvasToWorld(e: MouseEvent): Point` | type annotation | Change to `PointerEvent` |
| 470 | `function canvasToScreen(e: MouseEvent): Point` | type annotation | Change to `PointerEvent` |
| 499 | `canvas.addEventListener('mousedown', (e: MouseEvent)` | `mousedown` | `→ pointerdown`, change type annotation |
| 651 | `canvas.addEventListener('mousemove', (e: MouseEvent)` | `mousemove` | `→ pointermove`, change type annotation |
| 745 | `canvas.addEventListener('mouseup', (_e: MouseEvent)` | `mouseup` | `→ pointerup`, change type annotation |
| 756 | `} as MouseEvent)` | cast | Change to `as PointerEvent` (box-select path) |
| 760 | `} as MouseEvent)` | cast | Change to `as PointerEvent` (box-select path) |
| 875 | `canvas.addEventListener('dblclick', (e: MouseEvent)` | `dblclick` | keep `dblclick` (no pointer equivalent), change type annotation to `MouseEvent` → keep |
| 930 | `canvas.addEventListener('mousedown', ()` | `mousedown` (dismiss) | `→ pointerdown` |
| 1434 | `canvas.addEventListener('contextmenu', (e: MouseEvent)` | `contextmenu` | keep `contextmenu` (no pointer equivalent), keep type annotation |
| 1487 | `const dismiss = (ev: MouseEvent) =>` | type annotation on dismiss fn | Change to `PointerEvent` |
| 1490 | `document.removeEventListener('mousedown', dismiss)` | `mousedown` remove | `→ pointerdown` |
| 1493 | `setTimeout(() => document.addEventListener('mousedown', dismiss), 0)` | `mousedown` add | `→ pointerdown` |
| 1634 | `sub.addEventListener('mouseenter', () =>` | `mouseenter` | `→ pointerenter` |
| 1635 | `sub.addEventListener('mouseleave', () =>` | `mouseleave` | `→ pointerleave` |

---

### Phase 1B — `src/runtime/timing-diagram.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 402 | `private _onMouseDown = (e: MouseEvent): void` | type annotation | Change to `PointerEvent` |
| 408 | `private _onMouseMove = (e: MouseEvent): void` | type annotation | Change to `PointerEvent` |
| 423 | `private _onMouseLeave = (_e: MouseEvent): void` | type annotation | Change to `PointerEvent` (or `_e: PointerEvent`) |
| 428 | `private _onMouseUp = (_e: MouseEvent): void` | type annotation | Change to `PointerEvent` |
| 432 | `private _onClick = (e: MouseEvent): void` | type annotation | keep `MouseEvent` (click is mouse/pointer-agnostic) |
| 447 | `canvas.addEventListener("mousedown", this._onMouseDown)` | `mousedown` | `→ pointerdown` |
| 448 | `canvas.addEventListener("mousemove", this._onMouseMove)` | `mousemove` | `→ pointermove` |
| 449 | `canvas.addEventListener("mouseleave", this._onMouseLeave)` | `mouseleave` | `→ pointerleave` |
| 450 | `canvas.addEventListener("mouseup", this._onMouseUp)` | `mouseup` | `→ pointerup` |
| 451 | `canvas.addEventListener("click", this._onClick)` | `click` | keep as-is |
| 456 | `canvas.removeEventListener("mousedown", this._onMouseDown)` | `mousedown` remove | `→ pointerdown` |
| 457 | `canvas.removeEventListener("mousemove", this._onMouseMove)` | `mousemove` remove | `→ pointermove` |
| 458 | `canvas.removeEventListener("mouseleave", this._onMouseLeave)` | `mouseleave` remove | `→ pointerleave` |
| 459 | `canvas.removeEventListener("mouseup", this._onMouseUp)` | `mouseup` remove | `→ pointerup` |
| 460 | `canvas.removeEventListener("click", this._onClick)` | `click` remove | keep as-is |

---

### Phase 1B — `src/runtime/data-table.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 305 | `tr.addEventListener("contextmenu", (e) =>` | `contextmenu` | keep `contextmenu` (no pointer equivalent) |
| 307 | `this._showRadixMenu(e as MouseEvent, row)` | cast | Change to `as PointerEvent` (or widen to `Event`) |
| 316 | `private _showRadixMenu(e: MouseEvent, row: SignalRow)` | type annotation | Change to `PointerEvent` (or `Event`) |
| 356 | `document.removeEventListener("click", dismiss)` | `click` remove | keep as-is |
| 358 | `document.addEventListener("click", dismiss)` | `click` add | keep as-is |

---

### Phase 1C — `simulator.html` inline script

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 859 | `item.addEventListener('mouseenter', () =>` | `mouseenter` | `→ pointerenter` |
| 871 | `document.addEventListener('click', (e) =>` | `click` | keep as-is |
| 878 | `document.addEventListener('mouseenter', (e) =>` | `mouseenter` (delegated, capture) | `→ pointerenter` |
| 889 | `document.addEventListener('mouseleave', (e) =>` | `mouseleave` (delegated, capture) | `→ pointerleave` |

---

### Tests — `src/runtime/__tests__/timing-diagram.test.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 417 | `new MouseEvent("mousemove", { bubbles: true })` | `mousemove` | Change to `new PointerEvent("pointermove", ...)` after Phase 1B |
| 438 | `new MouseEvent("mousemove", { bubbles: true })` | `mousemove` | Change to `new PointerEvent("pointermove", ...)` after Phase 1B |
| 443 | `new MouseEvent("mouseleave", { bubbles: false })` | `mouseleave` | Change to `new PointerEvent("pointerleave", ...)` after Phase 1B |

---

### Keep as-is — `src/editor/context-menu.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 180 | `document.addEventListener("click", dismiss, { once: true })` | `click` | keep as-is |
| 195 | `document.removeEventListener("click", this._dismissHandler)` | `click` remove | keep as-is |
| 244 | `item.addEventListener("click", (e) =>` | `click` | keep as-is |

---

### Keep as-is — `src/editor/palette-ui.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 215 | `item.addEventListener("click", () =>` | `click` | keep as-is |

---

### Keep as-is — `src/runtime/value-dialog.ts`

| Line | Grep pattern | Event type | Migration action |
|------|-------------|------------|-----------------|
| 238 | `document.addEventListener("click", this._outsideClickHandler)` | `click` | keep as-is |
| 247 | `document.removeEventListener("click", this._outsideClickHandler)` | `click` remove | keep as-is |

---

## No `.onmouse*` Property Assignments Found

Search for `\.onmouse[a-z]+ =` across `src/` returned no matches.

---

## Migration Notes

1. **`dblclick`** — no pointer equivalent exists; keep as `dblclick` with `MouseEvent` type annotation.
2. **`contextmenu`** — no pointer equivalent; keep as `contextmenu` with `MouseEvent` or `Event` annotation.
3. **`click`** — pointer-event-agnostic; fires for both mouse and touch/stylus via pointer pipeline; keep as-is everywhere.
4. **`mouseenter`/`mouseleave` in `simulator.html`** — delegated with capture flag (`true`); when migrating to `pointerenter`/`pointerleave`, verify capture semantics are preserved.
5. **`as MouseEvent` casts at lines 756/760** — these construct partial event-like objects for `canvasToWorld`; the cast target type should follow the parameter type of `canvasToWorld`.
6. **Test files** — update `new MouseEvent(...)` constructors after the corresponding production event names are migrated.
