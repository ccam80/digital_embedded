# Analog UI Fixup Spec

Two concrete fixes for the analog simulation interface: speed control integration and slider panel wiring.

## Fix 1: Analog Speed Control

### Problem

The analog render loop in `app-init.ts` (line ~1636) runs at maximum CPU budget regardless of `SpeedControl`:

```typescript
while (performance.now() - stepStart < MAX_STEP_BUDGET_MS) {
  analogEngine.step();
}
```

The digital loop correctly uses `speedControl.speed * dt` (line 1578) to pace itself. Analog ignores it entirely — there's no way to slow down or single-step analog simulations.

### Design

The analog engine has adaptive internal timestep (controlled by `SimulationParams.maxTimeStep`), so "steps per second" doesn't map the same way as digital. Instead, speed control should regulate **simulation-time advancement per wall-clock second**.

**Approach: simulation-time budget per frame**

```
simTimeBudgetPerFrame = speedControl.speed * analogEngine.lastDt * dt
```

This doesn't work cleanly because `lastDt` is adaptive. Instead, use a **sim-time-per-second ratio** derived from the speed control:

| Speed Control Value | Analog Behavior |
|---|---|
| 1 | ~1 step per second (near single-step) |
| 1000 (default) | Normal — burn up to MAX_STEP_BUDGET_MS per frame |
| 10,000,000 (max) | Maximum — identical to current behavior |

**Concrete implementation:**

1. Add an `analogSpeedFactor` computed property or local variable:
   ```typescript
   // Fraction of the MAX_STEP_BUDGET_MS to actually use, scaled by speed
   const analogBudgetMs = MAX_STEP_BUDGET_MS * Math.min(1, speedControl.speed / 10000);
   ```

2. Replace the tight loop:
   ```typescript
   // In startAnalogRenderLoop tick():
   const analogBudgetMs = MAX_STEP_BUDGET_MS * Math.min(1, speedControl.speed / 10000);
   const stepStart = performance.now();
   let stepped = false;
   while (performance.now() - stepStart < analogBudgetMs) {
     analogEngine.step();
     stepped = true;
   }
   // At speed=1, budget = 0.0012ms ≈ 1 step per frame
   // At speed=1000 (default), budget = 1.2ms ≈ normal
   // At speed=10000+, budget = 12ms = full budget (current behavior)
   ```

3. For **single-step mode** (speed = 1), ensure exactly one `analogEngine.step()` call per frame, then skip the rest:
   ```typescript
   if (speedControl.speed <= 1) {
     analogEngine.step();
   } else {
     const analogBudgetMs = MAX_STEP_BUDGET_MS * Math.min(1, speedControl.speed / 10000);
     const stepStart = performance.now();
     while (performance.now() - stepStart < analogBudgetMs) {
       analogEngine.step();
     }
   }
   ```

### Files to Change

| File | Change |
|---|---|
| `src/app/app-init.ts` | Modify `startAnalogRenderLoop` tick function to use `speedControl.speed` for budget scaling |

### Verification

- At speed=1: scope/timing diagram advances visibly slowly (one adaptive step per frame)
- At speed=1000: normal operation, responsive UI
- At speed=10M: identical to current max-budget behavior
- Speed buttons (+/-) take immediate effect on analog simulation rate


## Fix 2: Slider Panel Wiring

### Problem

`SliderPanel` (313 lines) and `SliderEngineBridge` (87 lines) are fully implemented and tested, but never instantiated. No DOM container exists in `simulator.html`. Users cannot adjust R/L/C values during live analog simulation.

### Design

The slider panel should appear **below the canvas** when an analog simulation is running. Sliders are populated when the user selects an analog component with tunable properties (resistance, capacitance, inductance, voltage, etc.).

**Lifecycle:**

1. **On analog compile** (`startAnalogRenderLoop`): create `SliderPanel` + `SliderEngineBridge`
2. **On component selection** (SelectionModel change listener): populate sliders for the selected element's `FLOAT` properties
3. **On deselect / different selection**: clear and repopulate
4. **On simulation stop** (`stopAnalogRenderLoop`): dispose slider panel

### Concrete Implementation

#### Step 1: Add DOM container to `simulator.html`

```html
<!-- After the canvas container, before the status bar -->
<div id="slider-panel" class="slider-panel" style="display: none;"></div>
```

CSS (inline or in `<style>`):
```css
.slider-panel {
  background: var(--panel-bg);
  border-top: 1px solid var(--panel-border);
  padding: 4px 0;
  max-height: 120px;
  overflow-y: auto;
}
.slider-panel:empty { display: none; }
```

#### Step 2: Wire up in `app-init.ts`

In `startAnalogRenderLoop()`:
```typescript
// Create slider panel
const sliderContainer = document.getElementById('slider-panel');
if (sliderContainer) {
  sliderContainer.style.display = '';
  sliderPanel = new SliderPanel(sliderContainer);
  sliderBridge = new SliderEngineBridge(sliderPanel, analogEngine, analogCompiled);
}
```

In `stopAnalogRenderLoop()`:
```typescript
sliderPanel?.dispose();
sliderPanel = null;
sliderBridge = null;
const sliderContainer = document.getElementById('slider-panel');
if (sliderContainer) sliderContainer.style.display = 'none';
```

#### Step 3: Selection → slider population

Add to the selection change listener (already exists for property panel):
```typescript
// Inside the selection change handler, after property panel update:
if (sliderPanel && analogCompiled) {
  sliderPanel.removeAll();
  const selected = selectionModel.getSelectedElements();
  if (selected.length === 1) {
    const el = selected[0];
    const def = registry.get(el.typeName);
    if (def?.propertyDefs) {
      for (const propDef of def.propertyDefs) {
        if (propDef.type === PropertyType.FLOAT) {
          const currentVal = el.properties.getOrDefault<number>(propDef.key, propDef.defaultValue as number);
          const unit = PROPERTY_UNIT_MAP[propDef.key] ?? '';
          sliderPanel.addSlider(
            elementIndex,  // Need: map from circuit element → compiled element index
            propDef.key,
            propDef.label,
            currentVal,
            { unit, logScale: true },
          );
        }
      }
    }
  }
}
```

#### Step 4: Element index resolution

The `SliderEngineBridge` needs the compiled element index. `CompiledAnalogCircuit` currently provides `labelToNodeId` but not a label-to-element-index map. Two options:

**Option A (minimal):** Add a `labelToElementIndex: Map<string, number>` to `CompiledAnalogCircuit`. The analog compiler already knows this mapping during compilation.

**Option B (no interface change):** Use the element's `instanceId` and search the compiled elements array. Less clean but avoids touching the interface.

Recommend **Option A** — small, clean addition to the compilation output.

#### Property-to-unit mapping

```typescript
const PROPERTY_UNIT_MAP: Record<string, string> = {
  resistance: 'Ω',
  capacitance: 'F',
  inductance: 'H',
  voltage: 'V',
  current: 'A',
  frequency: 'Hz',
};
```

### Files to Change

| File | Change |
|---|---|
| `simulator.html` | Add `<div id="slider-panel">` |
| `src/app/app-init.ts` | Import SliderPanel/Bridge, instantiate on analog start, dispose on stop, populate on selection |
| `src/core/analog-engine-interface.ts` | Add `labelToElementIndex` to `CompiledAnalogCircuit` (Option A) |
| `src/analog/compiler.ts` | Populate `labelToElementIndex` during compilation |

### Verification

- Select resistor during analog sim → resistance slider appears with log-scale Ω display
- Select capacitor → capacitance slider appears (requires FLOAT fix — done)
- Drag slider → simulation responds in real-time (scope waveform changes)
- Deselect → sliders clear
- Stop simulation → slider panel hides
- Panel doesn't appear during digital-only simulation


## Dependencies

Fix 2 (sliders) depends on the FLOAT fix (already applied) for C/L property popups and slider population. Fix 1 (speed) is independent.

## Not In Scope

- Analog-specific speed display formatting (e.g. showing sim-time/s)
- Slider presets or saved slider configurations
- Keyboard shortcuts for analog speed
