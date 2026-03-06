# Fix Spec — Post-Review Remediation

Generated from full-codebase review (Phases 1–11). All items below are confirmed violations, defects, or gaps that need fixing.

## Scope

This spec covers:
- Mechanical cleanup (comment/import removal)
- Functional defects (wrong behavior)
- API signature corrections
- Integration wiring (engine ↔ editor)
- Rendering/coordinate bugs observed during manual testing

---

## Priority 1 — Functional Defects

### F1: `executeAdd` hardcodes `bitWidth=1`
- **File**: `src/components/arithmetic/add.ts:205-206`
- **Problem**: `executeAdd` always calls `makeExecuteAdd(1)` regardless of the component's actual `bitWidth`. Any Add component with bitWidth > 1 silently produces wrong outputs.
- **Fix**: The registered `executeFn` must read the component's `bitWidth` property and call `makeExecuteAdd(bitWidth)` with the correct value. Check all other arithmetic components (Sub, Mul, Div) for the same pattern.

### F2: `synthesizeD` if/else arms identical
- **File**: `src/fsm/circuit-gen.ts:96-101`
- **Problem**: Both branches of the `shouldMinimize` conditional call `minimize()`. The unminimized code path is missing.
- **Fix**: When `shouldMinimize === false`, use the raw truth table expressions directly without calling `minimize()`.

### F3: `synthesizeJK` ignores `minimize` parameter
- **File**: `src/fsm/circuit-gen.ts:134`
- **Problem**: `_shouldMinimize` parameter is prefixed with underscore and never used.
- **Fix**: Apply minimization to the JK synthesis expressions when `shouldMinimize === true`. Follow the same pattern as the corrected `synthesizeD`.

### F4: `addState` called with old positional boolean signature
- **Files**: `src/fsm/editor.ts:244`, `src/fsm/__tests__/fsm-renderer.test.ts:66-67`, `src/fsm/__tests__/fsm-hit-test.test.ts:19,29`, `src/fsm/__tests__/auto-layout.test.ts:19-22`
- **Problem**: `addState(fsm, name, {x,y}, isInitial)` passes a boolean as 4th arg; current signature expects `options?: { outputs?, isInitial?, radius? }`.
- **Fix**: Change all call sites to `addState(fsm, name, {x,y}, { isInitial })`.

### F5: `isPresent` HGS builtin has wrong semantics
- **File**: `src/hgs/builtins.ts:247-255`
- **Problem**: HGS `isPresent` should be a try-evaluate control-flow primitive (lazy evaluation). Current implementation eagerly evaluates args and returns true if non-null — which means evaluation errors propagate before the function body is reached, defeating its purpose.
- **Fix**: Implement lazy evaluation for `isPresent`. The evaluator must catch evaluation errors on the argument and return `false` if evaluation fails, `true` if it succeeds. This requires changes in the evaluator's function-call logic to special-case `isPresent` with try/catch around argument evaluation.

---

## Priority 2 — API Signature Fixes

### A1: `exportZip` takes raw strings instead of `Circuit`
- **File**: `src/export/zip.ts:31-36`
- **Spec requires**: `exportZip(circuit: Circuit, subcircuits: Map<string, string>, dataFiles?: Map<string, ArrayBuffer>): Promise<Blob>`
- **Current**: `exportZip(mainCircuitXml: string, mainFileName: string, subcircuits, dataFiles)`
- **Fix**: Change signature to accept `Circuit`, serialize internally. Update all callers.

### A2: `EditorBinding.bind()` missing `circuit` parameter
- **File**: `src/integration/editor-binding.ts`
- **Spec requires**: First parameter should be `circuit: Circuit`
- **Fix**: Add `circuit: Circuit` as first parameter to the `bind()` method signature and implementation. Update all callers.

### A3: `locale-loader.ts` feature flag pattern — eliminate
- **File**: `src/i18n/locale-loader.ts:11-14,34-45`
- **Problem**: Mutable `localeModules` registry forks between dynamic-import (test) and fetch (browser) at runtime. This is a banned feature flag pattern.
- **Fix**: Remove `locale-loader.ts` entirely. The i18n system was originally specced as a pass-through stub (Phase 5.5). Since Phase 9 added the full i18n system, simplify to a single code path: static import of locale JSON files bundled by Vite, no runtime `fetch`, no `registerLocaleModule`. If the full i18n system from Phase 9 is desired, it should use a single consistent loading mechanism (Vite dynamic `import()` for both test and browser).

---

## Priority 3 — Spec Alignment

### S1: Update spec for `analyseSequential`
- **File**: `spec/phase-8-analysis-synthesis.md`
- **Current implementation**: `analyseSequential(facade: SequentialAnalysisFacade, stateVars, inputs, outputs)` — caller provides signal specs explicitly.
- **Spec says**: `analyseSequential(facade: SimulatorFacade, circuit: Circuit)` — auto-detects from Circuit.
- **Decision**: Update spec to match implementation. The explicit API is cleaner and more testable.

---

## Priority 4 — Gut `src/main.ts`

### G1: Reduce main.ts to minimal placeholder
- **File**: `src/main.ts` (currently 670 lines)
- **Problem**: Spec says "minimal placeholder so the build works". Current file is a full interactive app with scope creep from Phase 1.
- **Fix**: The app init logic is properly factored into `src/app/app-init.ts`. Reduce `main.ts` to:
  ```typescript
  import { initApp } from './app/app-init.js';
  initApp();
  ```
  All current functionality in main.ts should either already exist in the proper modules (editor, app-init) or be moved there. The TODO stubs for Step/Run/Stop should be replaced with real engine wiring (see Integration section below).

---

## Priority 5 — Rendering Bugs (Confirmed Root Causes)

### R1: `drawPath()` never fills — all IEEE gate shapes are hollow

- **Root cause**: `CanvasRenderer.drawPath()` at `src/editor/canvas-renderer.ts:81-88` unconditionally calls `this._ctx.stroke()`. It never calls `fill()`. The `RenderContext` interface at `src/core/renderer-interface.ts:77` defines `drawPath(path: PathData): void` with no `filled` parameter.
- **Impact**: Every IEEE/US gate shape (AND, OR, NAND, NOR, XOR, XNOR, NOT) uses a two-pass draw pattern: (1) set `COMPONENT_FILL` color + `drawPath` (intended fill), (2) set `COMPONENT` color + `drawPath` (intended stroke). Since `drawPath` always strokes, the gate body is never filled. On light backgrounds the fill-color stroke is nearly invisible; at small zoom levels gates appear as empty outlines or boxes.
- **Affected files**: `src/editor/canvas-renderer.ts:81-88`, `src/export/svg-render-context.ts:287-292`, all IEEE-shape methods in `src/components/gates/{and,or,nand,nor,xor,xnor,not}.ts`
- **Fix**:
  1. Add `filled?: boolean` parameter to `RenderContext.drawPath()` interface at `src/core/renderer-interface.ts:77`
  2. Update `CanvasRenderer.drawPath()` at `src/editor/canvas-renderer.ts:81-88`:
     ```typescript
     drawPath(path: PathData, filled?: boolean): void {
       this._ctx.beginPath();
       for (const op of path.operations) { this._applyPathOperation(op); }
       if (filled) { this._ctx.fill(); } else { this._ctx.stroke(); }
     }
     ```
  3. Update `SvgRenderContext.drawPath()` at `src/export/svg-render-context.ts:287-292` similarly
  4. Update all IEEE gate `draw()` methods: pass `true` for the fill pass, `false` (or omit) for the stroke pass. Files: `and.ts:179`, `or.ts:167-193`, `nand.ts:174-193`, `nor.ts:174-202`, `xor.ts:167-223`, `xnor.ts:174-230`, `not.ts:137-147`

### R2: Double translation — every component renders at 2x its grid position

- **Root cause**: `ElementRenderer.render()` at `src/editor/element-renderer.ts:61-62` translates the canvas to `(element.position.x, element.position.y)` before calling `element.draw(ctx)`. But every component's `draw()` method ALSO calls `ctx.translate(x, y)` with the same position. Both sides apply the position transform.
- **Impact**: All components render at double their intended grid coordinates. A component at grid `(4, 6)` renders at `(8, 12)`.
- **Affected files**: `src/editor/element-renderer.ts:61-62` and every `draw()` method across `src/components/**` (~80+ files)
- **Fix**: Remove `ctx.translate(this.position.x, this.position.y)` from every component's `draw()` method. Keep the `ElementRenderer`'s pre-translate (it also handles rotation/mirror which must be applied at the element's position). Components should draw at `(0, 0)` in local space.
- **Verification**: Place a component at grid `(4, 6)` — it should render with its origin at that grid position, not at `(8, 12)`.

### R3: DPR transform not re-established per frame + box-select misposition

- **Root cause**: `renderFrame()` at `src/main.ts:64-76` does not re-apply the DPR base transform at the start of each frame. It relies on the transform left over from `resizeCanvas()`. While the coordinate math for world-space rendering is self-consistent, the box-select overlay at `main.ts:128-133` draws `fillRect`/`strokeRect` in CSS pixel values against a DPR-scaled context — placing the selection box at the wrong position on HiDPI displays. Additionally, `#sim-canvas` in `simulator.html:129-135` has CSS `width:100%; height:100%` which fights with the JS-set inline `style.width`/`style.height`.
- **Fix**:
  1. At the start of `renderFrame()`, re-establish the DPR base transform:
     ```typescript
     const dpr = window.devicePixelRatio || 1;
     ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
     ```
  2. Remove the CSS `width: 100%; height: 100%` rule from `#sim-canvas` in `simulator.html:129-135` — let `resizeCanvas()` control sizing exclusively via inline style
  3. For the box-select overlay (lines 128-133), ensure coordinates are in CSS pixels and the DPR transform is active (which it will be after fix 1)

---

## Priority 6 — Engine ↔ Editor Integration Wiring

### I1: Wire simulation engine to UI

**Effort**: ~120 lines of code. All engine and binding infrastructure is fully implemented and correct. The missing work is glue code.

**Files to modify**:

| File | Change |
|------|--------|
| `src/engine/compiled-circuit.ts:128-156` | Add `pinNetMap: Map<string, number>` field |
| `src/engine/compiler.ts:697-763` | Populate `pinNetMap` in step 13, pass to constructor |
| `src/main.ts` | All wiring below |

**Module-scope state** (add after `const ctx = initApp()`):
```typescript
import { DigitalEngine } from './engine/digital-engine.js';
import { compileCircuit } from './engine/compiler.js';
import { createEditorBinding } from './integration/editor-binding.js';
import { EngineState } from './core/engine-interface.js';
import { BitVector } from './core/signal.js';

const engine = new DigitalEngine('level');
const binding = createEditorBinding();
let compiledDirty = true;
```

**`compileAndBind()` function**:
```typescript
function compileAndBind(): boolean {
  if (binding.isBound) {
    engine.stop(); binding.unbind(); engine.dispose();
  }
  try {
    const compiled = compileCircuit(ctx.circuit, ctx.registry);
    engine.init(compiled);
    binding.bind(engine, compiled.wireToNetId, compiled.pinNetMap);
    compiledDirty = false;
    return true;
  } catch (err) {
    console.error('Compilation failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
```

**`pinNetMap` construction** (in `src/engine/compiler.ts`, after `labelToNetId` is built ~line 714):
```typescript
const pinNetMap = new Map<string, number>();
for (let i = 0; i < componentCount; i++) {
  const el = elements[i]!;
  const refs = allPinRefs[i]!;
  for (let j = 0; j < refs.length; j++) {
    const netId = slotToNetId(slotOf(i, j));
    const pin = refs[j]!.pin;
    pinNetMap.set(`${el.instanceId}:${pin.label}`, netId);
  }
}
```

**Button wiring** (replace stubs at `main.ts:459-472`):
```typescript
document.getElementById('btn-step')?.addEventListener('click', () => {
  if (compiledDirty && !compileAndBind()) return;
  if (engine.getState() === EngineState.RUNNING) engine.stop();
  engine.step();
  scheduleRender();
});

document.getElementById('btn-run')?.addEventListener('click', () => {
  if (compiledDirty && !compileAndBind()) return;
  if (engine.getState() === EngineState.RUNNING) return;
  engine.start();
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
  if (!binding.isBound) return;
  engine.stop();
  scheduleRender();
});
```

**Live wire coloring** (in `renderFrame`, update `wireRenderer.render()` call):
```typescript
wireRenderer.render(
  cr, circuit.wires, selection.getSelectedWires(),
  binding.isBound ? wireSignalAccessAdapter : undefined,
);
```

Where `wireSignalAccessAdapter` implements `WireSignalAccess` by delegating to `binding.getWireValue(wire)` and resolving bit width from compiled circuit's `netWidths`.

**Interactive In-component clicks** (in mousedown handler, before selection logic):
```typescript
if (binding.isBound && elementHit.typeId === 'In') {
  const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
  const current = binding.getPinValue(elementHit, 'out');
  const newVal = bitWidth === 1 ? (current === 0 ? 1 : 0) : ((current + 1) & ((1 << bitWidth) - 1));
  binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
  if (engine.getState() !== EngineState.RUNNING) engine.step();
  scheduleRender();
  return;
}
```

**Circuit edit invalidation** — call `invalidateCompiled()` after every circuit mutation (placement, wire completion, delete, undo/redo, file load):
```typescript
function invalidateCompiled(): void {
  compiledDirty = true;
  if (engine.getState() === EngineState.RUNNING) engine.stop();
  if (binding.isBound) binding.unbind();
  scheduleRender();
}
```

**References for implementation**:
- `src/engine/compiler.ts:117-120` — `compileCircuit()` signature
- `src/engine/digital-engine.ts:193-226` — constructor and `init()`
- `src/integration/editor-binding.ts:30-34` — `bind(engine, wireNetMap, pinNetMap)` signature
- `src/integration/editor-binding.ts:105-131` — `pinNetMap` key format: `"${instanceId}:${pinLabel}"`
- `src/editor/wire-signal-access.ts:11-20` — `WireSignalAccess` interface
- `src/editor/wire-renderer.ts:31-54` — `render()` accepts optional `signalAccess`
- `src/components/io/in.ts:43-50` — pin label is `"out"`, direction OUTPUT

---

## Priority 7 — Mechanical Cleanup

All items below are subtractive (remove only, no behavior change).

### M1: Remove TODO comments
- `src/main.ts:460,465,470` — 3 `// TODO:` lines
- (Note: these lines are removed as part of G1 gut, but if main.ts gut is deferred, remove them independently)

### M2: Remove "For now" comment
- `src/hgs/builtins.ts:250-254` — remove the comment block (the semantic fix is F5 above)

### M3: Remove phased-delivery provenance comment
- `src/io/subcircuit-loader.ts:45-48` — remove JSDoc block about "until the full SubcircuitElement from task 6.2.1 is available"

### M4: Remove 103-line deliberation comment
- `src/testing/parser.ts:741-844` — remove the entire agent deliberation transcript

### M5: Remove "backward-compatible" comment
- `src/testing/run-all.ts:34` — remove the "backward-compatible behavior" comment

### M6: Remove 33 Java reference comments
- All `* Java reference: de.neemann.digital.*` and `* Ported from de.neemann.digital.*` JSDoc lines across `src/`
- Files include: `src/analysis/model-analyser.ts:14`, `src/analysis/substitute-library.ts:19`, `src/headless/runner.ts:10`, `src/core/errors.ts:172`, `src/core/engine-interface.ts:12,69,90`, `src/testing/executor.ts:11`, `src/testing/comparison.ts:15`, `src/engine/bus-resolution.ts:23`, `src/engine/compiler.ts:16`, `src/engine/digital-engine.ts:19`, `src/engine/clock.ts:19-20`, `src/engine/flatten.ts:21`, `src/engine/micro-step.ts:13`, `src/engine/oscillation.ts:10`, `src/engine/timing-wheel.ts:15`, `src/components/basic/function.ts:7`, `src/components/io/midi.ts:4`, `src/runtime/data-table.ts:11`, `src/runtime/timing-diagram.ts:19`, `src/runtime/waveform-data.ts:8`, `src/engine/run-to-break.ts:8`, and more (see `spec/reviews/phase-11.md` for complete list)
- Also remove the justification at `src/__tests__/legacy-audit.test.ts:54`

### M7: Fix `require()` in ESM — dom-parser
- `src/io/dom-parser.ts:29-31` — replace `require("@xmldom/xmldom")` + `eslint-disable` with `await import("@xmldom/xmldom")` or static ESM import

### M8: Fix `require()` in ESM — builder test
- `src/headless/__tests__/builder.test.ts:34` — replace `require('../../core/properties.js')` with ESM `import`

### M9: Remove legacy audit test justification
- `src/__tests__/legacy-audit.test.ts:54` — remove comment that says `Java reference` comments are "legitimate"
- Update the test's assertions to treat these as violations (or remove the test if M6 eliminates all matches)

---

## Verification

After all fixes:
1. `npm run typecheck` — zero errors
2. `npm test` — all tests pass
3. Manual test: load a .dig circuit, verify IEEE gate shapes are filled (not hollow outlines)
4. Manual test: verify components render at correct grid positions (not doubled)
5. Manual test: on HiDPI display, verify mouse coordinates map correctly (click on a component, it gets selected; box-select draws under cursor)
6. Manual test: Step button compiles circuit and advances one propagation cycle; wire colors update
7. Manual test: Run button starts continuous simulation; Stop button halts it
8. Manual test: clicking an In component toggles its value and propagates

---

## Items NOT in This Spec

- **N2 (engine-interface.ts extra APIs)**: Keep as-is — all 5 APIs are actively used across 15 files
- **N3 (resolveDigReference name)**: Keep — name is more accurate than spec, function works correctly
- **N5 (run-to-break element.type)**: Already fixed — code uses `element.typeId` (reviewer was wrong)
- **N6 (i18n full system)**: Keep — user decision to leave the full locale system in place
- **N14 (Phase 4 missing tasks)**: Completed by implementation agent — 200 new tests (refs, data-field, hex-import, tokenizer, parser, parity), all passing. Total suite: 4454 tests
- **N15 (Timing diagram cursor)**: Completed by implementation agent (6 tests, all passing)
- **Phase 8 Part 2 review**: Still unreviewed (waves 8.2-8.3)
