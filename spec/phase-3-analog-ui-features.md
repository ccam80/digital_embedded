# Phase 3: Analog UI Features

## Overview

Implement the analog-specific visualization and interaction features: continuous voltage coloring on wires, animated current flow dots, an analog oscilloscope with FFT and measurement cursors, probe tooltips showing V/I/P, power dissipation overlays, and live parameter sliders. These features activate when the analog engine is running and deregister when switching to digital mode. The KCL wire-current resolver — needed for current animation and tooltips — lives in the editor layer and derives per-wire-segment currents from component currents using Kirchhoff's Current Law.

## Type Aliases

> **`CompiledAnalogCircuit`** is the type alias for `ConcreteCompiledAnalogCircuit` from Phase 1 (`src/analog/mna-engine.ts`). It extends `CompiledCircuit` with fields: `elements: AnalogElement[]`, `nodeCount: number`, `elementCount: number`, `nodeMap: Map<string, number>` (component label → node index).

## Dependencies

- **Phase 2** (Tier 1 Components) must be complete: components produce correct voltages, currents, and power values via the `AnalogEngine` interface (`getNodeVoltage()`, `getElementCurrent()`, `getElementPower()`).
- **Phase 0** infrastructure: `WireSignalAccess` with `AnalogWireValue`, `WIRE_ANALOG` theme color, `setRawColor?()` on `RenderContext`.

## Wave structure and dependencies

```
Wave 3.1: Voltage Coloring + Range Tracker         (depends on Phase 2)
Wave 3.2: KCL Wire-Current Resolver + Current Dots  (depends on 3.1)
Wave 3.3: Analog Scope + FFT + Measurements          (depends on Phase 2 only)
Wave 3.4: Probe Tooltip + Power Dissipation Display  (depends on 3.1 + 3.2)
Wave 3.5: Live Parameter Sliders                     (depends on Phase 2 only)
```

Waves 3.3 and 3.5 can run in parallel with 3.1/3.2.

---

## Wave 3.1: Voltage Coloring + Range Tracker

### Task 3.1.1: Voltage Range Tracker

- **Description**: Implement a global voltage range tracker that scans all node voltages once per render frame and maintains the [min, max] voltage range for color mapping. Auto-scales by default; the user can override with a fixed range via a settings panel. The tracker is a lightweight object held by the editor binding, updated each frame before wire rendering.
- **Files to create**:
  - `src/editor/voltage-range.ts`:
    - `class VoltageRangeTracker`:
      - `update(engine: AnalogEngine, nodeCount: number): void` — scans all node voltages, updates `min` and `max`. Applies exponential smoothing with instant expansion: `smoothedMax = rawMax > prevMax ? rawMax : 0.95 * prevMax + 0.05 * rawMax` (and similarly: `smoothedMin = rawMin < prevMin ? rawMin : 0.95 * prevMin + 0.05 * rawMin`). Range expands instantly to accommodate new extremes, contracts slowly to avoid jitter.
      - `readonly min: number` — current lower bound (auto or user-set)
      - `readonly max: number` — current upper bound (auto or user-set)
      - `setFixedRange(min: number, max: number): void` — override auto-scaling with a user-set range
      - `clearFixedRange(): void` — return to auto-scaling
      - `readonly isAutoRange: boolean` — true when auto-scaling
      - `normalize(voltage: number): number` — maps voltage to [0, 1] range where 0V (ground) maps to 0.5 when range is symmetric. For asymmetric ranges, ground maps proportionally.
    - Handles edge cases: all nodes at same voltage (range = [v-0.1, v+0.1]), no nodes (range = [-5, 5] default), ground always included in range.
- **Tests**:
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::auto_range_tracks_min_max` — feed voltages [0, 3.3, 5.0, -2.0]; assert `min ≤ -2.0` and `max ≥ 5.0`
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::normalize_ground_at_midpoint` — symmetric range [-5, 5]; assert `normalize(0) === 0.5`, `normalize(5) === 1.0`, `normalize(-5) === 0.0`
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::fixed_range_overrides_auto` — set fixed range [0, 3.3]; feed voltages up to 12V; assert `max === 3.3` (not 12)
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::clear_fixed_returns_to_auto` — set fixed, clear, feed new voltages; assert range tracks them
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::smoothing_contracts_slowly` — range was [-10, 10], new frame has [-1, 1]; assert range hasn't snapped to [-1, 1] immediately (smoothing)
  - `src/editor/__tests__/voltage-range.test.ts::VoltageRange::expands_instantly` — range was [-1, 1], new frame has [-1, 10]; assert `max ≥ 10` immediately
- **Acceptance criteria**:
  - Auto-range tracks circuit voltages with smooth contraction and instant expansion
  - User-set fixed range overrides auto-scaling
  - `normalize()` maps ground to 0.5 for symmetric ranges
  - Edge cases (uniform voltage, no nodes) handled without NaN or division by zero

---

### Task 3.1.2: Voltage Gradient Wire Coloring

- **Description**: Extend the wire renderer to color analog wires on a continuous gradient based on node voltage. Uses `setRawColor(css)` on `RenderContext` to pass computed CSS color strings. The gradient endpoint colors are read from the active color scheme's theme (red for positive, gray for ground, green for negative — matching CircuitJS convention). The wire renderer reads the normalized voltage from the `VoltageRangeTracker` and interpolates.
- **Files to modify**:
  - `src/core/renderer-interface.ts`:
    - Add `WIRE_VOLTAGE_POS` (positive extreme, default red `#ff0000`), `WIRE_VOLTAGE_NEG` (negative extreme, default green `#00cc00`), `WIRE_VOLTAGE_GND` (ground, default gray `#808080`) to `ThemeColor`
    - Color values per scheme:
      - Default (dark): `WIRE_VOLTAGE_POS: '#ff4444'`, `WIRE_VOLTAGE_NEG: '#44cc44'`, `WIRE_VOLTAGE_GND: '#888888'`
      - Light: `WIRE_VOLTAGE_POS: '#cc0000'`, `WIRE_VOLTAGE_NEG: '#008800'`, `WIRE_VOLTAGE_GND: '#666666'`
      - High-contrast: `WIRE_VOLTAGE_POS: '#ff0000'`, `WIRE_VOLTAGE_NEG: '#00ff00'`, `WIRE_VOLTAGE_GND: '#ffffff'`
      - Monochrome: `WIRE_VOLTAGE_POS: '#ffffff'`, `WIRE_VOLTAGE_NEG: '#aaaaaa'`, `WIRE_VOLTAGE_GND: '#666666'`
  - `src/editor/wire-renderer.ts`:
    - In `render()`, check the wire value type. For digital values: call `ctx.setColor(this._colorForValue(value))` as before (returns `ThemeColor`). For analog values: compute the gradient CSS string via `interpolateColor()` and call `ctx.setRawColor(cssString)` — do NOT pass through `_colorForValue()`. The method `_colorForValue()` retains its `ThemeColor` return type; the analog gradient path bypasses it entirely.
    - The existing `WIRE_ANALOG` theme color is retained as the fallback for analog wires when voltage data is unavailable (e.g., before the first simulation step). Once voltage data is available, the gradient path supersedes it.
    - New method `_analogVoltageColor(voltage: number): string` — queries `VoltageRangeTracker.normalize(voltage)`, then interpolates between theme endpoint colors:
      - `normalized < 0.5`: interpolate `WIRE_VOLTAGE_NEG → WIRE_VOLTAGE_GND`
      - `normalized > 0.5`: interpolate `WIRE_VOLTAGE_GND → WIRE_VOLTAGE_POS`
      - `normalized === 0.5`: `WIRE_VOLTAGE_GND`
    - Wire line width for analog: 2px (thicker than digital 1px, thinner than bus 3px) to make gradient visible
  - `src/editor/wire-signal-access.ts`:
    - No changes needed — `AnalogWireValue { voltage: number }` already exists
- **Files to create**:
  - `src/editor/color-interpolation.ts`:
    - `interpolateColor(color1: string, color2: string, t: number): string` — linear RGB interpolation between two CSS hex colors, returns `rgb(r,g,b)` string. `t=0` returns color1, `t=1` returns color2.
    - `hexToRgb(hex: string): [number, number, number]` — parse `#rrggbb` to [r, g, b]
    - Used by wire renderer and power dissipation heat map (Task 3.4.2)
- **Tests**:
  - `src/editor/__tests__/color-interpolation.test.ts::ColorInterpolation::midpoint_of_red_and_green` — interpolate `#ff0000` and `#00ff00` at t=0.5; assert result is `rgb(128, 128, 0)` (yellow-ish). Rounding: use `Math.round()` for channel values. `interpolate('#ff0000', '#00ff00', 0.5)` → `'rgb(128, 128, 0)'`
  - `src/editor/__tests__/color-interpolation.test.ts::ColorInterpolation::t_zero_returns_first` — assert `interpolateColor(a, b, 0)` returns color matching `a`
  - `src/editor/__tests__/color-interpolation.test.ts::ColorInterpolation::t_one_returns_second` — assert `interpolateColor(a, b, 1)` returns color matching `b`
  - `src/editor/__tests__/wire-renderer.test.ts::AnalogVoltageColoring::positive_voltage_red` — mock wire at 5V in range [-5, 5]; assert `setRawColor` called with a reddish color (R channel > G channel)
  - `src/editor/__tests__/wire-renderer.test.ts::AnalogVoltageColoring::negative_voltage_green` — mock wire at -5V; assert greenish color (G > R)
  - `src/editor/__tests__/wire-renderer.test.ts::AnalogVoltageColoring::ground_voltage_gray` — mock wire at 0V; assert grayish color (R ≈ G ≈ B)
  - `src/editor/__tests__/wire-renderer.test.ts::AnalogVoltageColoring::digital_wires_unchanged` — digital wire value `{ raw: 1, width: 1 }`; assert `setColor("WIRE_HIGH")` called (not `setRawColor`)
- **Acceptance criteria**:
  - Analog wires display continuous voltage gradient (red → gray → green)
  - Ground wires are neutral gray
  - Digital wires are completely unaffected
  - Gradient endpoint colors come from theme (customizable via color scheme)
  - Color is recomputed each frame from live engine voltages

---

## Wave 3.2: KCL Wire-Current Resolver + Current Flow Animation

### Task 3.2.1: KCL Wire-Current Resolver

- **Description**: Implement the Kirchhoff's Current Law resolver that computes per-wire-segment currents from component currents. Given the engine's `getElementCurrent()` for each component and the circuit's wire topology (which wire segments connect which component pins), the resolver walks the topology graph and assigns a current magnitude and direction to every wire segment. This runs once per render frame in the editor layer.
- **Files to create**:
  - `src/editor/wire-current-resolver.ts`:
    - `class WireCurrentResolver`:
      - `resolve(engine: AnalogEngine, circuit: Circuit, compiled: CompiledAnalogCircuit): void` — computes currents for all wire segments. Algorithm:
        1. For each component, query `getElementCurrent(elementId)` to get the current flowing through it
        2. Build a graph of wire segments connected to each node
        3. For simple series paths (single wire between two component pins on different nodes): wire current = component current
        4. For branching junctions (node with >2 wire segments): use KCL — sum currents into the junction from known sources, assign the remainder to the unknown segment. When multiple unknowns exist, distribute proportionally (for visualization purposes, exactness matters less than plausibility)
        5. Store the result as `Map<Wire, { current: number, direction: [number, number] }>` where direction is a unit vector along the wire segment
      - `getWireCurrent(wire: Wire): { current: number, direction: [number, number] } | undefined`
      - `clear(): void` — reset all computed currents
    - The resolver handles:
      - Series connections (most common): trivial assignment
      - T-junctions (3-way): KCL with one unknown
      - Cross junctions (4-way): KCL — may have multiple unknowns; assign by splitting current using conductance values from the most recent NR Jacobian diagonal entries for the connected nodes. For each branch at a junction, the current fraction is proportional to the branch's conductance relative to the total conductance of all branches. If Jacobian data is unavailable (e.g., first frame), distribute equally.
      - Disconnected segments: current = 0
- **Tests**:
  - `src/editor/__tests__/wire-current-resolver.test.ts::KCLResolver::series_circuit_uniform_current` — 3 components in series (source → R1 → R2 → ground); mock all element currents = 5mA; resolve; assert all wire segments have current ≈ 5mA
  - `src/editor/__tests__/wire-current-resolver.test.ts::KCLResolver::parallel_branch_split` — source → junction → R1 (3mA) and R2 (7mA) → ground; resolve; assert wire from source to junction has 10mA, wire to R1 has 3mA, wire to R2 has 7mA
  - `src/editor/__tests__/wire-current-resolver.test.ts::KCLResolver::disconnected_wire_zero_current` — wire segment not connected to any component; assert current = 0
  - `src/editor/__tests__/wire-current-resolver.test.ts::KCLResolver::direction_follows_conventional_current` — current flows from positive to negative terminal; assert direction vector points accordingly
- **Acceptance criteria**:
  - Series wire segments show correct current magnitude
  - Branching junctions distribute current consistent with KCL
  - Runs in < 1ms for circuits with ≤ 200 wire segments
  - Direction vectors are consistent with conventional current flow

---

### Task 3.2.2: Current Flow Animation

- **Description**: Render animated dots moving along wires at speeds proportional to current magnitude. Dots are small filled circles drawn on the wire path. Position advances each render frame by `current * speedScale * dtFrame`. Dot spacing is constant; only speed varies. The animation loop runs via `requestAnimationFrame` when the analog engine is active.
- **Files to create**:
  - `src/editor/current-animation.ts`:
    - `class CurrentFlowAnimator`:
      - `constructor(resolver: WireCurrentResolver)`
      - `update(dtSeconds: number): void` — advance all dot positions by `current * speedScale * dt` along their wire paths. Dots wrap around when they reach the end of a segment.
      - `render(ctx: RenderContext, circuit: Circuit): void` — draw dots on all wire segments. Dot color: theme color `CURRENT_DOT` (default: yellow `#ffcc00`). Dot radius: 0.1 grid units (renders as ~2px at default zoom; specified in grid units for zoom-independence). Dot spacing: 20px (adjustable).
      - `setSpeedScale(scale: number): void` — linear multiplier applied directly to the dot velocity formula: `velocity = current × scale`. Default 1.0, range [0.01, 100]. The UI slider (if present) maps logarithmically: slider position 0→0.01, 0.5→1.0, 1.0→100.
      - `setEnabled(enabled: boolean): void` — toggle on/off (default: on in analog mode)
      - `readonly enabled: boolean`
    - Internal state: `Map<Wire, number[]>` — dot phase positions per wire (0.0–1.0 along wire length). Initialized with evenly spaced dots.
    - Dot direction matches current direction from resolver. When current reverses, dots reverse.
    - Zero current: dots freeze in place (no movement, still visible).
    - Very small current (|I| < 1µA): dots invisible to avoid visual noise. The threshold is a constructor parameter `minCurrentThreshold` defaulting to `1e-6`.
- **Files to modify**:
  - `src/core/renderer-interface.ts`:
    - Add `CURRENT_DOT` to `ThemeColor` (default: `#ffcc00` in dark scheme, `#cc9900` in light scheme)
  - `src/app/app-init.ts`:
    - In function `startAnalogRenderLoop()` (or add if absent). Add `CurrentFlowAnimator` instantiation on analog engine start, call `animator.update(dtFrame)` and `animator.render(ctx, circuit)` each requestAnimationFrame tick.
    - When switching to digital: disable and dispose animator.
- **Tests**:
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::dots_advance_proportional_to_current` — wire with 10mA, speedScale=1, dt=16ms; assert dot positions advanced by `0.01 * 1 * 0.016` units
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::dots_wrap_around` — dot at position 0.99, advance 0.05; assert wraps to 0.04
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::zero_current_freezes_dots` — wire with 0mA; update; assert dot positions unchanged
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::direction_reversal` — current changes from +5mA to -5mA; assert dots move in opposite direction
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::disabled_skips_render` — set enabled=false; call render; assert no draw calls
  - `src/editor/__tests__/current-animation.test.ts::CurrentAnimation::speed_scale_multiplies` — speedScale=10; assert dot advancement 10× faster
- **Acceptance criteria**:
  - Dots move along wires with speed proportional to current
  - Direction matches conventional current flow
  - Dots wrap smoothly at wire ends
  - Speed scale slider controls visual speed without affecting simulation
  - Animation activates only in analog mode, no overhead in digital mode
  - Zero-current wires have frozen dots

---

## Wave 3.3: Analog Scope + FFT + Measurements

### Task 3.3.1: Analog Scope Sample Buffer

- **Description**: Implement the sample buffer for the analog oscilloscope. Unlike the digital timing diagram which captures integer samples at uniform steps, the analog scope captures `Float64` voltage/current values at non-uniform time intervals (from the adaptive timestep controller). The buffer supports time-range queries, decimation for zoomed-out views, and min/max envelope computation.
- **Files to create**:
  - `src/runtime/analog-scope-buffer.ts`:
    - `class AnalogScopeBuffer`:
      - `constructor(maxSamples: number)` — ring buffer capacity (default 65536)
      - `push(time: number, value: number): void` — append a sample. Time must be monotonically increasing. When buffer is full, oldest samples are evicted.
      - `getSamplesInRange(tStart: number, tEnd: number): { time: Float64Array, value: Float64Array }` — returns all samples within [tStart, tEnd]. Uses a double-buffer layout: each sample is written at both index `i` and `i + capacity` in a `Float64Array` of length `2 × capacity`. This guarantees any contiguous slice of up to `capacity` samples is available as a zero-copy `Float64Array.subarray()` view, regardless of ring wrap position. Memory cost: 2× (e.g., 128KB for 8192-sample `Float64Array`). Write cost: two `Float64` stores per `push()`, negligible vs. NR iteration cost. Read cost: zero allocation — `getSamplesInRange()` returns a `subarray()` view.
      - `getEnvelope(tStart: number, tEnd: number, bucketCount: number): { time: Float64Array, min: Float64Array, max: Float64Array }` — for zoomed-out rendering: divides the time range into N buckets, returns min and max value per bucket. Used for the min/max envelope rendering.
      - `readonly sampleCount: number`
      - `readonly timeStart: number` — oldest sample time
      - `readonly timeEnd: number` — newest sample time
      - `clear(): void`
    - Internal storage: two `Float64Array` ring buffers (time and value), head/tail pointers. Binary search for time-range queries.
- **Tests**:
  - `src/runtime/__tests__/analog-scope-buffer.test.ts::ScopeBuffer::push_and_query_range` — push 100 samples at non-uniform times; query a sub-range; assert returned samples are within range and in order
  - `src/runtime/__tests__/analog-scope-buffer.test.ts::ScopeBuffer::ring_buffer_eviction` — push more than maxSamples; assert `sampleCount === maxSamples` and oldest samples are gone
  - `src/runtime/__tests__/analog-scope-buffer.test.ts::ScopeBuffer::envelope_computes_min_max` — push sine wave samples; get envelope with 10 buckets; assert each bucket's min ≤ actual min in range and max ≥ actual max
  - `src/runtime/__tests__/analog-scope-buffer.test.ts::ScopeBuffer::binary_search_correct` — push 1000 samples; query range [0.005, 0.006]; assert only samples in that range returned
  - `src/runtime/__tests__/analog-scope-buffer.test.ts::ScopeBuffer::empty_range_returns_empty` — query range with no samples; assert empty arrays returned
- **Acceptance criteria**:
  - Ring buffer handles non-uniform time intervals correctly
  - Time-range queries use binary search (O(log n) lookup)
  - Envelope decimation produces correct min/max per bucket
  - Zero allocation on range queries (subarray views). Push allocates zero (two direct stores).

---

### Task 3.3.2: Analog Scope Panel

- **Description**: Implement the analog oscilloscope panel as a new UI component that captures and displays continuous waveforms. Shares time-axis rendering utilities with the existing digital timing diagram but has its own sample storage (`AnalogScopeBuffer`), Y-axis with auto-ranging, and polyline rendering. Supports multiple channels (voltage and current traces). Integrates with the engine via `MeasurementObserver`. The analog scope panel renders to its own dedicated `HTMLCanvasElement` using `CanvasRenderingContext2D` directly, consistent with the existing digital timing diagram (`src/runtime/timing-diagram.ts`). The scope is a standalone runtime panel, not an overlay on the circuit editor canvas, so the engine-agnostic `RenderContext` abstraction does not apply.
- **Files to create**:
  - `src/runtime/analog-scope-panel.ts`:
    - `class AnalogScopePanel implements MeasurementObserver` (Registration: `AnalogEngine` must expose `addMeasurementObserver(obs: MeasurementObserver): void` and `removeMeasurementObserver(obs: MeasurementObserver): void`. These are added to the `AnalogEngine` interface in Phase 0's `engine-interface.ts`. The scope panel registers itself in its constructor and deregisters in `dispose()`):
      - `constructor(canvas: HTMLCanvasElement, engine: AnalogEngine)`
      - `addVoltageChannel(nodeId: number, label: string, color: string): void` — add a voltage trace
      - `addCurrentChannel(branchId: number, label: string, color: string): void` — add a current trace
      - `removeChannel(label: string): void`
      - `onStep(stepCount: number): void` — captures `engine.getNodeVoltage(nodeId)` or `engine.getBranchCurrent(branchId)` for each channel, pushes to that channel's `AnalogScopeBuffer` with `engine.simTime`
      - `onReset(): void` — clears all buffers
      - `render(): void` — draws all channels:
        - Background with grid lines
        - Time axis (bottom) with smart tick intervals, shared with digital timing diagram utilities
        - Y-axis (left) for voltage with auto-range + grid, (right) for current if dual-axis mode
        - Per-channel polyline: when zoomed in (< 1000 samples visible), draw point-to-point lines. When zoomed out (> 1000 samples visible), draw min/max envelope as a filled band.
        - Channel legend (top-right corner)
      - `setTimeRange(duration: number): void` — horizontal window width in seconds
      - `setYRange(channel: string, min: number, max: number): void` — manual Y-axis range
      - `setAutoYRange(channel: string): void` — return to auto-ranging
      - `zoom(factor: number): void` — zoom time axis
      - `pan(deltaSeconds: number): void` — scroll time axis
    - Y-axis auto-ranging: tracks min/max of visible samples with 10% padding. When user sets manual range, auto-range is disabled for that channel.
    - Grid lines: horizontal at voltage/current intervals (automatic based on range); vertical at time intervals. Grid interval selection: use the 1-2-5 sequence × 10^n, targeting 5–10 grid lines in the visible range. Algorithm: `interval = pow(10, floor(log10(range / 5)))`, then choose from {1, 2, 5} × interval to get closest to 7 lines.
    - Channel colors: cycle through a predefined palette (CSS hex): `['#4488ff', '#ff4444', '#44cc44', '#ff8800', '#aa44ff', '#44cccc', '#ff44aa', '#aaaa44']`.
  - `src/runtime/analog-scope-renderer.ts`:
    - `drawPolylineTrace(ctx: CanvasRenderingContext2D, samples: { time: Float64Array, value: Float64Array }, viewport: ScopeViewport, color: string): void` — draws a smooth polyline for the channel
    - `drawEnvelopeTrace(ctx: CanvasRenderingContext2D, envelope: { time: Float64Array, min: Float64Array, max: Float64Array }, viewport: ScopeViewport, color: string): void` — draws a filled min/max band
    - `drawYAxis(ctx: CanvasRenderingContext2D, range: [number, number], viewport: ScopeViewport, unit: string, side: 'left' | 'right'): void` — Y-axis with labels and grid
    - `ScopeViewport`: `{ x, y, width, height, tStart, tEnd, yMin, yMax }` — maps time/value to pixel coordinates
- **Tests**:
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::captures_voltage_on_step` — add voltage channel for node 3; mock engine returns 4.2V; call `onStep(1)`; assert buffer has 1 sample with value 4.2
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::multiple_channels_independent` — add voltage and current channels; call `onStep()`; assert each buffer has its own sample
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::reset_clears_buffers` — push samples, call `onReset()`; assert all buffers empty
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::auto_y_range_tracks_visible` — push samples from 0V to 5V; render; assert Y-axis range ≈ [-0.5, 5.5] (10% padding)
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::manual_y_range_overrides` — set Y range [0, 3.3]; push samples up to 5V; assert Y-axis still [0, 3.3]
  - `src/runtime/__tests__/analog-scope-panel.test.ts::AnalogScope::envelope_at_low_zoom` — push 10000 samples; zoom out to show all; assert renderer uses envelope (not polyline) when sample density > 1000 visible
- **Acceptance criteria**:
  - Captures voltage and current traces at every accepted timestep
  - Handles non-uniform time samples correctly (no interpolation artifacts)
  - Polyline rendering for zoomed-in views, envelope for zoomed-out
  - Y-axis auto-ranges per channel with 10% padding
  - Dual-axis mode (voltage left, current right) works
  - Zoom and pan controls work smoothly

---

### Task 3.3.3: FFT Spectrum View

- **Description**: Implement an FFT view that shows the magnitude spectrum of a selected scope channel. Uses a Cooley-Tukey radix-2 FFT built from scratch (~60 LOC total). The FFT panel is a toggle on the analog scope — when enabled, it replaces or splits the view to show frequency-domain data.
- **Files to create**:
  - `src/runtime/fft.ts`:
    - `fft(re: Float64Array, im: Float64Array): void` — in-place radix-2 Cooley-Tukey FFT. Input arrays must be power-of-2 length. Performs bit-reversal permutation then butterfly stages.
    - `hannWindow(samples: Float64Array): Float64Array` — applies Hann window: `w[n] = 0.5 - 0.5 * cos(2πn/N)`. Returns new array (does not mutate input).
    - `magnitudeSpectrum(re: Float64Array, im: Float64Array, sampleRate: number): { frequency: Float64Array, magnitude: Float64Array }` — computes `|X[k]| = sqrt(re[k]² + im[k]²)` for k = 0..N/2, returns frequency axis (0 to Nyquist) and magnitude in linear units.
    - `magnitudeToDb(magnitude: Float64Array, reference?: number): Float64Array` — converts to dB: `20 * log10(mag / ref)`. Default reference = max magnitude. Returns new array.
    - `nextPow2(n: number): number` — returns smallest power of 2 ≥ n.
  - `src/runtime/fft-renderer.ts`:
    - `drawSpectrum(ctx: CanvasRenderingContext2D, spectrum: { frequency: Float64Array, magnitude: Float64Array }, viewport: ScopeViewport, color: string, logFreq: boolean): void` — draws magnitude spectrum as a filled polyline. X-axis: frequency (linear or log scale). Y-axis: magnitude in dB.
    - `drawFrequencyAxis(ctx: CanvasRenderingContext2D, range: [number, number], viewport: ScopeViewport, logScale: boolean): void` — frequency labels (Hz, kHz, MHz)
- **Files to modify**:
  - `src/runtime/analog-scope-panel.ts`:
    - Add `setFftEnabled(enabled: boolean): void` — toggles FFT view
    - Add `setFftChannel(label: string): void` — selects which channel to analyze
    - When FFT enabled: take the most recent N samples (N = largest power of 2 ≤ buffer.sampleCount, max 8192. Computed as `floorPow2(n) = 1 << (31 - Math.clz32(n))`. Export `floorPow2` alongside the existing `nextPow2` utility.), resample to uniform spacing (linear interpolation since analog samples are non-uniform), apply Hann window, compute FFT, render spectrum in the bottom half of the scope panel (time-domain on top, frequency-domain on bottom)
    - Resampling: compute average sample rate from the time span, generate uniform samples via linear interpolation of the non-uniform buffer
- **Tests**:
  - `src/runtime/__tests__/fft.test.ts::FFT::single_sine_peak` — generate 1024 samples of 1kHz sine at 44.1kHz sample rate; FFT; assert peak magnitude at frequency bin closest to 1kHz, all other bins ≥ 40dB below peak
  - `src/runtime/__tests__/fft.test.ts::FFT::dc_offset_appears_at_bin_zero` — 1024 samples of constant 3.0; FFT; assert bin 0 has magnitude ≈ 3.0, all others ≈ 0
  - `src/runtime/__tests__/fft.test.ts::FFT::two_sines_two_peaks` — 1kHz + 3kHz at different amplitudes; assert two peaks at correct bins with correct relative magnitudes (within 3dB)
  - `src/runtime/__tests__/fft.test.ts::FFT::hann_window_reduces_leakage` — sine not aligned to bin center; compare windowed vs unwindowed; assert windowed sidelobes are ≥ 20dB below peak (vs ~13dB unwindowed)
  - `src/runtime/__tests__/fft.test.ts::FFT::next_pow2` — assert `nextPow2(1000) === 1024`, `nextPow2(1024) === 1024`, `nextPow2(1) === 1`
  - `src/runtime/__tests__/fft.test.ts::FFT::magnitude_to_db` — magnitude [1, 0.1, 0.01]; assert dB values [0, -20, -40] ± 0.1dB
- **Acceptance criteria**:
  - FFT correctly identifies frequency content of known test signals
  - Hann windowing reduces spectral leakage measurably
  - Non-uniform scope samples are resampled to uniform before FFT
  - Spectrum display shows frequency axis with correct labels
  - FFT runs in < 5ms for 8192-point transforms

---

### Task 3.3.4: Measurement Cursors

- **Description**: Add measurement cursors to the analog scope that let users read precise values from waveforms. Two vertical cursors (A and B) can be placed on the time axis. The scope displays ΔT, ΔV, frequency (1/ΔT), and computed statistics (RMS, peak-to-peak) between the cursors. Cursors are draggable and snap to the nearest sample.
- **Files to create**:
  - `src/runtime/scope-cursors.ts`:
    - `class ScopeCursors`:
      - `setCursorA(time: number): void` — place cursor A at the given time
      - `setCursorB(time: number): void` — place cursor B
      - `clearCursors(): void`
      - `getMeasurements(buffer: AnalogScopeBuffer): ScopeMeasurements | undefined` — returns measurements between cursors, or undefined if fewer than 2 cursors are set
    - `ScopeMeasurements`:
      - `deltaT: number` — time difference (B - A) in seconds
      - `frequency: number` — 1/|ΔT| in Hz
      - `deltaV: number` — value at B minus value at A
      - `rms: number` — RMS of samples between A and B: `sqrt(mean(v²))`
      - `peakToPeak: number` — max - min of samples between A and B
      - `mean: number` — arithmetic mean of samples between A and B
    - Cursor rendering: vertical line with time label at top, value readout where it crosses a trace
  - `src/runtime/scope-cursor-renderer.ts`:
    - `drawCursors(ctx: CanvasRenderingContext2D, cursors: ScopeCursors, viewport: ScopeViewport): void` — draws cursor lines, labels, and measurement readout panel
    - Measurement panel: semi-transparent overlay box showing ΔT, ΔV, freq, RMS, Vpp, mean with SI unit formatting (mV, µs, kHz, etc.). Note: `formatSI` is defined in `src/editor/si-format.ts` (Task 3.4.1). If Wave 3.3 and 3.4 run in parallel, the `formatSI` import in cursor tests must use a local stub until 3.4 completes, or waves 3.3 and 3.4 must run sequentially.
- **Tests**:
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::delta_t_correct` — cursor A at 1ms, B at 3ms; assert ΔT = 2ms, frequency = 500Hz
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::delta_v_correct` — buffer has V=2.0 at cursor A, V=4.5 at cursor B; assert ΔV = 2.5V
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::rms_of_sine` — buffer contains one full period of 5V peak sine; assert RMS ≈ 5/√2 ≈ 3.536V ± 0.1V
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::peak_to_peak` — buffer with values [-3, 0, 2, 5, 1]; assert Vpp = 8
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::single_cursor_returns_undefined` — only cursor A set; assert `getMeasurements()` returns undefined
  - `src/runtime/__tests__/scope-cursors.test.ts::Cursors::si_unit_formatting` — assert 0.001 formats as "1.00 ms", 1500 formats as "1.50 kHz", 0.0034 as "3.40 mV"
- **Acceptance criteria**:
  - Two cursors can be placed independently on the time axis
  - ΔT, ΔV, frequency, RMS, peak-to-peak, mean all computed correctly
  - RMS of a sine wave matches 1/√2 × peak within 3%
  - SI unit formatting produces readable strings (auto-selects prefix)
  - Measurement panel updates in real-time as cursors are dragged

---

## Wave 3.4: Probe Tooltip + Power Dissipation

### Task 3.4.1: Probe Tooltip

- **Description**: Implement hover tooltips that show instantaneous electrical values when the mouse hovers over wires or components in analog mode. Wire/pin hover shows voltage. Component body hover shows current and power. The tooltip appears after a 200ms delay and follows the mouse. Renders as a positioned `<div>` overlay above the canvas element (absolute positioning within the canvas container). Flip rule: if tooltip would extend beyond the canvas right edge by > 10px, position it to the left of the cursor; similarly for bottom edge.
- **Files to create**:
  - `src/editor/analog-tooltip.ts`:
    - `class AnalogTooltip`:
      - `constructor(engine: AnalogEngine, resolver: WireCurrentResolver, compiled: CompiledAnalogCircuit)`
      - `onMouseMove(x: number, y: number, hitTarget: HitResult | null): void` — starts 200ms timer when entering a wire or component, cancels when leaving
      - `render(ctx: RenderContext): void` — draws tooltip if active
      - `dispose(): void`
    - Tooltip content based on hit target:
      - **Wire**: `"3.42 V"` — node voltage from `engine.getNodeVoltage(nodeId)`
      - **Component body**: `"4.7 mA, 22 mW"` — current from `engine.getElementCurrent()`, power from `engine.getElementPower()`
      - **Component pin**: `"3.42 V"` — voltage at that pin's node
    - Value formatting: auto-select SI prefix (µV, mV, V, kV; µA, mA, A; µW, mW, W)
    - Tooltip style: semi-transparent dark background, white text, rounded corners, drop shadow
  - `src/editor/si-format.ts`:
    - `formatSI(value: number, unit: string, precision?: number): string` — formats a number with appropriate SI prefix. Precision rule: always 3 significant figures. Examples: `formatSI(0.001, "A") → "1.00 mA"`, `formatSI(0.0047, "A") → "4.70 mA"`, `formatSI(1e-14, "A") → "10.0 fA"`, `formatSI(2200, "Ω") → "2.20 kΩ"`, `formatSI(1e-6, "F") → "1.00 µF"`
    - Prefixes: f, p, n, µ, m, (none), k, M, G, T
    - Used throughout the analog UI (tooltips, scope axis labels, measurement cursors, power labels)
- **Tests**:
  - `src/editor/__tests__/si-format.test.ts::SIFormat::milliamps` — `formatSI(0.0047, "A")` → `"4.70 mA"`
  - `src/editor/__tests__/si-format.test.ts::SIFormat::kilohms` — `formatSI(2200, "Ω")` → `"2.20 kΩ"`
  - `src/editor/__tests__/si-format.test.ts::SIFormat::microfarads` — `formatSI(1e-6, "F")` → `"1.00 µF"`
  - `src/editor/__tests__/si-format.test.ts::SIFormat::zero` — `formatSI(0, "V")` → `"0.00 V"`
  - `src/editor/__tests__/si-format.test.ts::SIFormat::negative` — `formatSI(-3.3, "V")` → `"-3.30 V"`
  - `src/editor/__tests__/si-format.test.ts::SIFormat::very_small` — `formatSI(1e-14, "A")` → `"10.0 fA"`
  - `src/editor/__tests__/analog-tooltip.test.ts::Tooltip::wire_shows_voltage` — hover over wire connected to node at 3.3V; assert tooltip text contains `"3.30 V"`
  - `src/editor/__tests__/analog-tooltip.test.ts::Tooltip::component_shows_current_and_power` — hover over resistor with 5mA, 25mW; assert text contains `"5.00 mA"` and `"25.0 mW"`
  - `src/editor/__tests__/analog-tooltip.test.ts::Tooltip::delay_200ms` — use a fake timer (e.g., `vi.useFakeTimers()` / `jest.useFakeTimers()`). Mouse enters wire; advance by 100ms → assert tooltip not visible. Advance by another 150ms → assert tooltip visible.
  - `src/editor/__tests__/analog-tooltip.test.ts::Tooltip::disappears_on_leave` — mouse leaves wire; assert tooltip disappears immediately
- **Acceptance criteria**:
  - Wire hover shows voltage with SI prefix formatting
  - Component hover shows current and power
  - 200ms hover delay before tooltip appears
  - SI prefix formatting handles the full range from femto to tera
  - Tooltip positions correctly near mouse, flips to avoid canvas edges

---

### Task 3.4.2: Power Dissipation Display

- **Description**: Implement an optional overlay that shows power dissipation per component. Two modes: text labels ("47 mW" next to each component) and heat-map coloring (component body tinted yellow → orange → red by power). Off by default. Toggled via a toolbar button or View menu.
- **Files to create**:
  - `src/editor/power-overlay.ts`:
    - `class PowerOverlay`:
      - `constructor(engine: AnalogEngine, compiled: CompiledAnalogCircuit)`
      - `setMode(mode: 'off' | 'labels' | 'heatmap'): void`
      - `render(ctx: RenderContext, circuit: Circuit): void`:
        - `'labels'` mode: for each component, query `getElementPower(id)`, format with `formatSI(power, "W")`, draw text label offset from component center
        - `'heatmap'` mode: for each component, compute normalized power (0..1 relative to max power in circuit), interpolate color via a two-segment gradient: for normalized power t in [0, 0.5], interpolate yellow (`#ffff00`) → orange (`#ff8800`); for t in [0.5, 1.0], interpolate orange (`#ff8800`) → red (`#ff0000`). Use `interpolateColor()` twice with remapped t. Draw a semi-transparent filled rectangle over the component body.
      - `readonly mode: 'off' | 'labels' | 'heatmap'`
    - Max power tracking: the overlay tracks the maximum power across all components each frame for heat-map normalization. Uses smoothing similar to voltage range tracker (expand instantly, contract slowly).
- **Tests**:
  - `src/editor/__tests__/power-overlay.test.ts::PowerOverlay::labels_mode_draws_text` — set mode to 'labels'; mock 3 components with known powers; call render; assert `drawText` called 3 times with correct formatted values
  - `src/editor/__tests__/power-overlay.test.ts::PowerOverlay::heatmap_highest_power_is_red` — component with max power; assert fill color is reddish (R > G)
  - `src/editor/__tests__/power-overlay.test.ts::PowerOverlay::heatmap_lowest_power_is_yellow` — component with power = 0.001W when max circuit power = 10W (normalized t ≈ 0.0001); assert fill color is yellow (#ffff00 ± channel tolerance of 10)
  - `src/editor/__tests__/power-overlay.test.ts::PowerOverlay::off_mode_no_render` — mode='off'; call render; assert zero draw calls
  - `src/editor/__tests__/power-overlay.test.ts::PowerOverlay::zero_power_components_skipped_in_labels` — component with 0W power; assert no label drawn for it
- **Acceptance criteria**:
  - Labels mode shows formatted power next to each component
  - Heatmap mode tints components from yellow (cool) to red (hot)
  - Off mode adds zero rendering overhead
  - Zero-power components omitted from labels (no visual clutter)
  - Power values update each render frame from live engine data

---

## Wave 3.5: Live Parameter Sliders

### Task 3.5.1: Slider Panel

- **Description**: Implement a panel below the canvas that hosts live parameter sliders. The user right-clicks a component and selects "Add slider" to pin a component parameter (e.g., resistance, capacitance, voltage) to a slider. Dragging the slider modifies the component property in real-time, causing the engine to re-stamp and re-factor (numeric only — topology unchanged, so no symbolic re-analysis). Multiple sliders can be active simultaneously. Slider state is runtime-only (not persisted in the circuit file).
- **Files to create**:
  - `src/editor/slider-panel.ts`:
    - `class SliderPanel`:
      - `constructor(container: HTMLElement, engine: AnalogEngine, compiled: CompiledAnalogCircuit)`
      - `addSlider(elementId: number, propertyKey: string, label: string, currentValue: number, opts?: SliderOpts): void`:
        - `SliderOpts`: `{ min?: number, max?: number, logScale?: boolean }`
        - Default range: `[currentValue * 0.1, currentValue * 10]` for R/C/L (log scale), `[currentValue - 5, currentValue + 5]` for V/I (linear scale). If `currentValue === 0`, use `[1e-12, 1e-3]` as the fallback range (pF to mF for capacitors, pΩ to mΩ for resistors).
        - Creates a slider DOM element (HTML `<input type="range">`) with label, current value display, and unit
      - `removeSlider(elementId: number, propertyKey: string): void`
      - `removeAll(): void`
      - `onSliderChange(callback: (elementId: number, propertyKey: string, value: number) => void): void` — registers callback fired during drag
      - `dispose(): void` — removes all DOM elements
    - Log-scale slider: internally maps the slider's linear [0, 1] position to `min * (max/min)^position`. This gives even spacing across decades (e.g., 100Ω to 10kΩ with equal visual space per decade).
    - Value display: updates in real-time during drag, formatted with `formatSI()`
    - Slider styling: minimal, horizontal bar with thumb, label on left, value on right
  - `src/editor/slider-engine-bridge.ts`:
    - `class SliderEngineBridge`:
      - Connects `SliderPanel` to the `AnalogEngine`. When slider changes:
        1. Update the component's property in the circuit model
        2. Call the component's `AnalogElement` to update its internal parameter value
        3. The engine re-stamps and re-factors on the next step (numeric refactorization only — no `invalidateTopology()`)
      - For linear elements (R, C, L): updates the conductance/companion model value; re-factor is < 1ms
      - For nonlinear element model parameters: takes effect at next NR iteration (no re-stamp needed — the element reads its params during `stampNonlinear()`)
- **Files to modify**:
  - `src/app/app-init.ts` or equivalent:
    - Add "Add slider" to component right-click context menu (analog mode only)
    - Context menu shows slidable properties for the selected component. Slidable properties by component type: Resistor→resistance, Capacitor→capacitance, Inductor→inductance, DC Voltage Source→voltage, DC Current Source→current, AC Voltage Source→amplitude/frequency, Potentiometer→position. Other components: no slider unless they have a numeric property marked `slidable: true` in their `ComponentDefinition`.
    - Selected property creates a slider via `SliderPanel.addSlider()`
- **Tests**:
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::add_slider_creates_dom_element` — add slider; assert container has a new child element with range input
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::log_scale_midpoint` — log slider [100, 10000] at position 0.5; assert value ≈ 1000 (geometric midpoint)
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::linear_scale_midpoint` — linear slider [0, 10] at position 0.5; assert value = 5
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::callback_fires_on_change` — move slider; assert callback fired with correct elementId, propertyKey, new value
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::remove_slider_removes_dom` — add then remove; assert container has no children
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::multiple_sliders_independent` — add 3 sliders; move one; assert only that slider's callback fires
  - `src/editor/__tests__/slider-panel.test.ts::SliderPanel::value_display_formatted` — slider at 4700Ω; assert display shows `"4.70 kΩ"`
  - **Integration test** — `src/editor/__tests__/slider-panel.test.ts::Integration::slider_changes_resistance` — create circuit with resistor, add resistance slider, move to new value; step engine; assert node voltages changed consistent with new resistance value
- **Acceptance criteria**:
  - Sliders appear below canvas with label and live value display
  - Log scale gives even visual spacing across decades for R/C/L
  - Linear scale for voltage/current parameters
  - Property changes propagate to engine within one step
  - Numeric re-factorization only (no symbolic — fast for live interaction)
  - Multiple sliders work independently
  - Slider state is runtime-only — not saved with circuit
  - Right-click context menu shows "Add slider" only in analog mode
