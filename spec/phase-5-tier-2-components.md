# Phase 5: Tier 2 Components

## Overview

Implement 30 extended analog components: passive variants, additional source waveforms, expression-driven controlled sources, JFETs with a shared FET base class, thyristor-family devices, coupled-inductor transformers, lossy transmission lines, sensors, exotic semiconductors, analog switches, and Schmitt triggers. Extend the expression parser with runtime variable bindings (`V()`, `I()`, `time`) and symbolic differentiation for Jacobian computation in controlled sources.

## Dependencies

- **Phase 1** (MNA Engine Core) must be complete: `SparseSolver`, `AnalogElement` interface, `MNAAssembler`, `newtonRaphson()`, `pnjlim()`, `fetlim()`, companion model infrastructure, `TimestepController`, `HistoryStore`, `MNAEngine`
- **Phase 2** (Tier 1 Components) must be complete: resistor, capacitor, inductor, diode, BJT NPN/PNP, N-MOSFET/P-MOSFET (Level 2), op-amp, DC/AC voltage source, current source, ground, switches, probe, `.MODEL` parser, expression parser, `engineType: "both"` support
- **Phase 4a** (DigitalPinModel, DigitalOutputPinModel — required by Tasks 5.8.1, 5.8.2)
- **Phase 4c** (expandTransistorModel — required by Task 5.7.7)

## Wave structure and dependencies

```
Wave 5.1: Passive Extensions                          [Phase 2 passives]
Wave 5.2: Source Waveforms + Expression Enhancements   [Phase 2 AC source + expr parser]
Wave 5.3: Expression-Driven Controlled Sources         [depends on 5.2]
Wave 5.4: Shared FET Base Class + JFETs                [Phase 2 MOSFETs]
Wave 5.5: Thyristors + Exotic Semiconductors           [Phase 2 BJTs + diode]
Wave 5.6: Coupled Inductors + Transformers             [Phase 1 inductor companion]
Wave 5.7: Transmission Line + Sensors + Exotic         [Phase 2 passives]
Wave 5.8: Analog Switch + Schmitt Trigger              [Phase 2]
```

Waves 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 5.8 have no mutual dependencies and can run in parallel. Wave 5.3 depends on 5.2 (expression enhancements).

---

## Wave 5.1: Passive Extensions

### Task 5.1.1: Polarized Capacitor

- **Description**: Implement a polarized electrolytic capacitor that extends Phase 2's capacitor with polarity enforcement, ESR (equivalent series resistance), and leakage current. Uses the same companion model as the standard capacitor for the reactive portion. Adds a series resistance element for ESR and a parallel high-resistance leakage path. Emits a diagnostic when reverse-biased beyond a threshold voltage.
- **Files to create**:
  - `src/components/passives/polarized-cap.ts`:
    - `class PolarizedCapElement implements AnalogElement`:
      - Wraps Phase 2's capacitor companion model
      - Adds series ESR stamp: conductance `1/ESR` between the capacitor's internal node and the positive terminal
      - Adds parallel leakage: conductance `1/R_leak` across the capacitor
      - In `stampNonlinear()`: check polarity — if `V_anode < V_cathode - V_reverse_max`, emit `reverse-biased-cap` diagnostic
      - `readonly isNonlinear: true` (for polarity check)
      - `readonly isReactive: true` (capacitor companion)
    - `PolarizedCapDefinition: ComponentDefinition` with `engineType: "analog"`, category `PASSIVES`
    - Properties: `capacitance` (F), `esr` (Ω, default 0.1), `leakageCurrent` (A, default 1µA → R_leak = V_rated/I_leak), `voltageRating` (V, default 25), `reverseMax` (V, default 1.0)
    - Symbol: two parallel plates, one curved (negative), with polarity marker
- **Tests**:
  - `src/components/passives/__tests__/polarized-cap.test.ts::PolarizedCap::dc_behaves_as_open_with_leakage` — DC source across polarized cap; solve DC OP; assert current ≈ V/R_leak (small leakage only)
  - `src/components/passives/__tests__/polarized-cap.test.ts::PolarizedCap::esr_adds_series_resistance` — step voltage across cap; measure initial current spike; assert peak current ≈ V_step/ESR (ESR dominates at t=0)
  - `src/components/passives/__tests__/polarized-cap.test.ts::PolarizedCap::charges_with_rc_time_constant` — 10µF + 1kΩ series; step 5V; assert voltage reaches 63% of 5V at t ≈ RC = 10ms ± 10%
  - `src/components/passives/__tests__/polarized-cap.test.ts::PolarizedCap::reverse_bias_emits_diagnostic` — apply -5V (reverse); assert `reverse-biased-cap` diagnostic emitted
  - `src/components/passives/__tests__/polarized-cap.test.ts::PolarizedCap::forward_bias_no_diagnostic` — apply +5V; assert no polarity diagnostic
- **Acceptance criteria**:
  - Charges/discharges identically to standard capacitor for same capacitance value
  - ESR produces measurable voltage drop under transient current
  - Leakage current flows in DC steady state
  - Reverse-bias diagnostic fires when threshold exceeded

---

### Task 5.1.2: Quartz Crystal

- **Description**: Implement a quartz crystal using the Butterworth-Van Dyke equivalent circuit model: a series RLC branch (motional arm: R_s, L_s, C_s) in parallel with a shunt capacitance C_0 (electrode capacitance). This produces a series resonant frequency f_s = 1/(2π√(L_s·C_s)) and a parallel resonant frequency f_p slightly above f_s. The crystal is a composite of existing Phase 1 elements (resistor + inductor + capacitor) assembled internally.
- **Files to create**:
  - `src/components/passives/crystal.ts`:
    - `class CrystalElement implements AnalogElement`:
      - Internal sub-elements: `ResistorElement` (R_s), `InductorElement` (L_s), `CapacitorElement` (C_s), `CapacitorElement` (C_0)
      - `stamp()`: stamps R_s, L_s, C_s in series between terminals, C_0 in parallel
      - Allocates 2 internal nodes (junction between R_s and L_s, junction between L_s and C_s) and 1 branch variable (for L_s)
      - `isReactive: true` (inductors and capacitors)
      - `isNonlinear: false` (all linear elements)
    - `CrystalDefinition: ComponentDefinition` with `engineType: "analog"`, category `PASSIVES`
    - Properties: `frequency` (Hz, default 32768 for watch crystal), `qualityFactor` (Q, default 50000), `motionalCapacitance` (C_s in F, default 12.5fF), `shuntCapacitance` (C_0 in F, default 3pF)
    - Derived: L_s = 1/(4π²·f²·C_s), R_s = 2π·f·L_s/Q
    - Symbol: rectangular box between two parallel plates
- **Tests**:
  - `src/components/passives/__tests__/crystal.test.ts::Crystal::series_resonance_frequency` — drive crystal with AC sweep (using controlled source); measure impedance minimum; assert minimum at f ≈ f_s = 1/(2π√(L_s·C_s)) ± 1%
  - `src/components/passives/__tests__/crystal.test.ts::Crystal::parallel_resonance_above_series` — find impedance maximum; assert f_p > f_s
  - `src/components/passives/__tests__/crystal.test.ts::Crystal::dc_blocks` — DC source across crystal; assert current ≈ 0 (capacitors block DC)
  - `src/components/passives/__tests__/crystal.test.ts::Crystal::quality_factor_affects_bandwidth` — compare Q=1000 vs Q=50000 crystal; assert higher Q has narrower resonance peak
  - `src/components/passives/__tests__/crystal.test.ts::Crystal::derived_parameters_consistent` — assert L_s = 1/(4π²·f²·C_s) and R_s = 2π·f·L_s/Q for default parameters
- **Acceptance criteria**:
  - Series resonance at specified frequency within 1%
  - Parallel resonance slightly above series resonance
  - Q factor controls bandwidth of resonance
  - DC blocking behavior (series capacitor)

---

### Task 5.1.3: Analog Fuse

- **Description**: Implement a fuse as a variable-resistance element with thermal modeling. The fuse has a cold resistance R_cold when intact and transitions to R_blown (very high) when the accumulated I²t energy exceeds the fuse rating. The transition uses a thermal state variable that integrates I²t over time. The existing digital fuse component gets `engineType: "both"` with this analog factory.
- **Files to create**:
  - `src/components/passives/analog-fuse.ts`:
    - `class AnalogFuseElement implements AnalogElement`:
      - State: `_thermalEnergy: number` (accumulated I²t in A²·s), `_blown: boolean`
      - `stamp()`: stamps conductance `1/R_current` between terminals
      - `stampNonlinear()`: compute current from terminal voltage difference and current resistance; update thermal model. When `_thermalEnergy > i2tRating`, set `_blown = true` and switch to `R_blown`.
      - `isNonlinear: true` (resistance depends on thermal state)
      - The fuse implements `updateState(dt, voltages)` to integrate thermal energy: `_thermalEnergy += I² × dt`. It does NOT implement `stampCompanion()` — the fuse has no reactive companion model. The engine calls `updateState()` each accepted timestep.
    - Properties: `rCold` (Ω, default 0.01), `rBlown` (Ω, default 1e9), `currentRating` (A, default 1.0), `i2tRating` (A²·s, default 1.0), `blowTime` (s at rated current, derived: i2tRating / currentRating²)
- **Files to modify**:
  - `src/components/switching/fuse.ts` — set `engineType: "both"`, add `analogFactory`, add `simulationModes: ['digital', 'behavioral']`
- **Tests**:
  - `src/components/passives/__tests__/analog-fuse.test.ts::Fuse::low_current_stays_intact` — 0.5A through 1A-rated fuse for 10s; assert resistance remains R_cold
  - `src/components/passives/__tests__/analog-fuse.test.ts::Fuse::overcurrent_blows_fuse` — 3A through 1A-rated fuse; run transient; assert fuse blows at t ≈ i2tRating/I² = 1/9 ≈ 0.11s ± 20%
  - `src/components/passives/__tests__/analog-fuse.test.ts::Fuse::blown_fuse_open_circuit` — after blowing, assert current ≈ 0 (R_blown >> R_load)
  - `src/components/passives/__tests__/analog-fuse.test.ts::Fuse::resistance_transition_smooth` — assert no discontinuous resistance jump that would prevent NR convergence (smooth tanh transition over small energy range near threshold)
  - `src/components/passives/__tests__/analog-fuse.test.ts::Fuse::blown_emits_diagnostic` — drive 2× rated current for sufficient time to blow fuse; assert `fuse-blown` diagnostic is emitted with info severity
- **Acceptance criteria**:
  - Fuse stays intact below rated current indefinitely
  - I²t accumulation correctly tracks energy
  - Blown fuse is effectively open circuit
  - NR converges through the blow transition (smooth resistance change)

---

## Wave 5.2: Source Waveforms + Expression Enhancements

### Task 5.2.1: Expression Parser Enhancements

- **Description**: Extend Phase 2's arithmetic expression parser with runtime variable bindings for circuit quantities, and add symbolic differentiation of the AST for Jacobian computation in expression-driven controlled sources. New built-in functions: `V(label)` returns node voltage, `I(label)` returns element current. New variables: `time` (simulation time in seconds), `freq` (frequency for AC analysis). New function: `random()` for noise. Add `differentiate(expr, variable)` that produces a new AST representing the symbolic derivative.
- **Files to modify**:
  - `src/analog/expression-parser.ts` (Phase 2's parser):
    - Add `V` and `I` as recognized function names in the parser. `V(label)` parses to an AST node `{ type: 'circuit-voltage', label: string }`. `I(label)` parses to `{ type: 'circuit-current', label: string }`.
    - Add `time`, `freq` as recognized variable names → AST node `{ type: 'builtin-var', name: 'time' | 'freq' }`
    - Add `random()` function → AST node `{ type: 'builtin-func', name: 'random' }`
- **Files to create**:
  - `src/analog/expression-differentiate.ts`:
    - `differentiate(expr: ExprNode, variable: string): ExprNode` — symbolic differentiation of the expression AST with respect to a named variable (typically a `V(label)` or `I(label)` reference). Rules:
      - `d/dx(constant) = 0`
      - `d/dx(x) = 1`, `d/dx(y) = 0` for y ≠ x
      - `d/dx(f + g) = f' + g'`
      - `d/dx(f * g) = f'*g + f*g'`
      - `d/dx(f / g) = (f'*g - f*g') / g²`
      - `d/dx(f ^ n) = n * f^(n-1) * f'` (generalized power rule)
      - `d/dx(sin(f)) = cos(f) * f'`
      - `d/dx(cos(f)) = -sin(f) * f'`
      - `d/dx(exp(f)) = exp(f) * f'`
      - `d/dx(ln(f)) = f' / f`
      - `d/dx(sqrt(f)) = f' / (2*sqrt(f))`
      - `d/dx(abs(f)) = sign(f) * f'`
    - `simplify(expr: ExprNode): ExprNode` — basic algebraic simplification (fold constants, eliminate `+0`, `*1`, `*0`, `^1`, `^0`). Keeps derivative output clean.
  - `src/analog/expression-evaluate.ts`:
    - `ExpressionContext` interface:
      - `getNodeVoltage(label: string): number` — resolves `V(label)` at runtime
      - `getBranchCurrent(label: string): number` — resolves `I(label)` at runtime
      - `time: number` — current simulation time
      - `freq?: number` — frequency for AC analysis
    - `evaluate(expr: ExprNode, ctx: ExpressionContext): number` — evaluates an expression AST given a runtime context
    - `compileExpression(expr: ExprNode): (ctx: ExpressionContext) => number` — compiles an AST to a closure for repeated evaluation (avoids tree walk overhead on hot path)
- **Tests**:
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::constant_is_zero` — `d/dx(5) = 0`
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::variable_is_one` — `d/dx(x) = 1`
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::product_rule` — `d/dx(x*sin(x)) = sin(x) + x*cos(x)`; evaluate at x=π/4; assert ≈ sin(π/4) + (π/4)*cos(π/4)
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::chain_rule` — `d/dx(sin(x²)) = 2x*cos(x²)`; evaluate at x=1; assert ≈ 2*cos(1)
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::quotient_rule` — `d/dx(x/(1+x)) = 1/(1+x)²`; evaluate at x=2; assert ≈ 1/9
  - `src/analog/__tests__/expression-differentiate.test.ts::Differentiate::power_rule` — `d/dx(x^3) = 3x²`; evaluate at x=2; assert = 12
  - `src/analog/__tests__/expression-differentiate.test.ts::Simplify::zero_plus_x` — simplify `0 + x` → `x`
  - `src/analog/__tests__/expression-differentiate.test.ts::Simplify::x_times_zero` — simplify `x * 0` → `0`
  - `src/analog/__tests__/expression-differentiate.test.ts::Simplify::x_to_power_one` — simplify `x^1` → `x`
  - `src/analog/__tests__/expression-evaluate.test.ts::Evaluate::v_function_resolves` — parse `V(R1) * 2`; evaluate with context returning 3.3V for R1; assert result = 6.6
  - `src/analog/__tests__/expression-evaluate.test.ts::Evaluate::i_function_resolves` — parse `I(R1)`; evaluate with context returning 5mA; assert result = 0.005
  - `src/analog/__tests__/expression-evaluate.test.ts::Evaluate::time_variable` — parse `sin(2*pi*1000*time)`; evaluate at time=0.00025; assert ≈ sin(π/2) = 1.0
  - `src/analog/__tests__/expression-evaluate.test.ts::Evaluate::compiled_matches_interpreted` — compile expression; evaluate both ways; assert identical results
- **Acceptance criteria**:
  - `V(label)` and `I(label)` parse correctly and resolve at runtime
  - Symbolic differentiation produces correct derivatives for all supported operations
  - Simplification eliminates trivial terms (`+0`, `*1`, `*0`)
  - Compiled expressions produce identical results to interpreted evaluation
  - `time` variable binds to simulation time

---

### Task 5.2.2: Additional Waveform Modes

- **Description**: Extend Phase 2's AC voltage source with four additional waveform modes: frequency sweep (chirp), amplitude modulation (AM), frequency modulation (FM), and white noise. These are added as new cases in the existing `waveformFunction()` dispatcher, not separate components.
- **Files to modify**:
  - `src/components/sources/ac-voltage.ts` (Phase 2):
    - Add waveform modes to the `waveform` property enum: `'sweep'`, `'am'`, `'fm'`, `'noise'`
    - `'sweep'`: `V(t) = A * sin(2π * f(t) * t)` where `f(t)` interpolates from `freqStart` to `freqEnd` over `sweepDuration`. Linear: `f(t) = f_start + (f_end - f_start) * t / T`. Log: `f(t) = f_start * (f_end/f_start)^(t/T)`.
    - `'am'`: `V(t) = (1 + modulationDepth * sin(2π * modulationFreq * t)) * A * sin(2π * freq * t)`
    - `'fm'`: `V(t) = A * sin(2π * freq * t + modulationIndex * sin(2π * modulationFreq * t))`
    - `'noise'`: `V(t) = A * gaussian_random()` — white noise with amplitude A. Uses Box-Muller transform for Gaussian distribution. Registers breakpoints at each timestep to force the timestep controller to not skip over rapid changes.
    - New properties: `freqStart` (Hz), `freqEnd` (Hz), `sweepDuration` (s), `sweepMode` ('linear' | 'log'), `modulationFreq` (Hz), `modulationDepth` (0-1 for AM), `modulationIndex` (radians for FM)
- **Tests**:
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::Sweep::frequency_increases_over_time` — sweep 100Hz→10kHz over 1s; sample at t=0 (expect ~100Hz period) and t=0.9s (expect ~10kHz period); assert period matches expected frequency ± 10%
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::AM::modulation_envelope` — AM with depth=1.0, carrier=1kHz, mod=100Hz; sample over one modulation period; assert envelope varies from 0 to 2A
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::AM::zero_depth_is_pure_carrier` — depth=0; assert output = A*sin(2π*f*t) (pure carrier)
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::FM::deviation_proportional_to_index` — FM with index=5; assert instantaneous frequency deviates by ±index*modulationFreq from carrier
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::Noise::gaussian_distribution` — generate 10000 noise samples; assert mean ≈ 0 (within 5% of amplitude) and std dev ≈ A (Box-Muller produces standard Gaussian with σ=1, so `A × gaussian()` has std dev = A)
  - `src/components/sources/__tests__/ac-voltage-extended.test.ts::Noise::no_correlation` — compute autocorrelation of noise at lag 1; assert |R(1)| < 0.1 (uncorrelated)
- **Acceptance criteria**:
  - Sweep produces monotonically changing frequency over sweep duration
  - AM modulation depth of 1.0 produces full envelope (0 to 2A)
  - FM modulation index controls peak frequency deviation
  - Noise output has approximately Gaussian distribution with zero mean
  - All new modes work within the existing AC source framework (no new component types)

---

### Task 5.2.3: Variable Rail Source

- **Description**: Implement a user-adjustable DC voltage source designed for live parameter slider integration (Phase 3). Unlike the fixed DC source, the Variable Rail has explicit min/max range properties and is optimized for slider control: changing its voltage only requires numeric re-factorization (no topology change). Intended use: adjustable power supply rails for experimenting with operating points.
- **Files to create**:
  - `src/components/sources/variable-rail.ts`:
    - `class VariableRailElement implements AnalogElement`:
      - Same MNA stamp as DC voltage source (voltage source branch)
      - `setVoltage(v: number): void` — updates the source voltage. Note: `setVoltage()` is called by the engine's `updateParameter()` method (from Phase 1) when the slider panel (Phase 3) changes the rail voltage. Phase 3 is not a dependency — the element works standalone; slider integration is handled by whoever instantiates the slider.
      - `isNonlinear: false`
      - `isReactive: false`
    - `VariableRailDefinition: ComponentDefinition` with `engineType: "analog"`, category `SOURCES`
    - Properties: `voltage` (V, default 5.0), `minVoltage` (V, default 0), `maxVoltage` (V, default 30), `resistance` (Ω, default 0.01 — internal resistance)
    - Symbol: circle with ± and slider icon
- **Tests**:
  - `src/components/sources/__tests__/variable-rail.test.ts::VariableRail::dc_output_matches_voltage` — set voltage=12V; solve DC OP; assert output node voltage = 12V ± 0.01V
  - `src/components/sources/__tests__/variable-rail.test.ts::VariableRail::voltage_change_updates_output` — set 5V, solve, then change to 10V, re-solve; assert new output = 10V
  - `src/components/sources/__tests__/variable-rail.test.ts::VariableRail::internal_resistance_limits_current` — 12V rail with R_int=0.1Ω into 1Ω load; assert output voltage = 12 * 1/(1+0.1) ≈ 10.9V
- **Acceptance criteria**:
  - Output voltage matches property value under no-load conditions
  - Voltage changes propagate within one engine step (numeric re-factor only)
  - Internal resistance models source impedance

---

### Task 5.2.4: Analog Clock Factory

- **Description**: Give the existing digital `Clock` component an `analogFactory` so it appears in the analog palette. In analog mode, the clock generates a square wave using the AC voltage source's square waveform with the clock's frequency property, outputting between 0V and the circuit's logic family VDD. Register breakpoints at each transition edge for clean timestep handling.
- **Files to modify**:
  - `src/components/io/clock.ts`:
    - Add `analogFactory` that creates an analog square wave source element with `V_low = 0`, `V_high = logicFamily.vdd`, frequency from the clock's `frequency` property
    - Set `engineType: "both"`, `simulationModes: ['digital', 'behavioral']`
    - The analog element registers breakpoints at each rising and falling edge via `engine.addBreakpoint()`
- **Tests**:
  - `src/components/io/__tests__/analog-clock.test.ts::AnalogClock::outputs_vdd_and_zero` — analog clock with CMOS 3.3V; run transient for 2 periods; assert voltage alternates between 0V and 3.3V
  - `src/components/io/__tests__/analog-clock.test.ts::AnalogClock::frequency_matches_property` — clock freq=1kHz; measure period from zero-crossings; assert period ≈ 1ms
  - `src/components/io/__tests__/analog-clock.test.ts::AnalogClock::registers_breakpoints` — assert `addBreakpoint()` called at each transition time
  - `src/components/io/__tests__/analog-clock.test.ts::AnalogClock::digital_mode_unchanged` — in digital circuit, clock works exactly as before (no regression)
- **Acceptance criteria**:
  - Clock appears in both digital and analog palettes
  - Analog output swings between 0V and VDD
  - Breakpoints ensure timestep controller lands on transitions
  - No regression to digital clock behavior

---

## Wave 5.3: Expression-Driven Controlled Sources

### Task 5.3.1: Controlled Source Infrastructure

- **Description**: Implement the base class for expression-driven controlled sources. All four types (VCVS, VCCS, CCVS, CCCS) share: an expression defining the output quantity as a function of a control quantity, symbolic differentiation for the Jacobian, and a common stamping pattern. The base handles expression compilation, context binding, and derivative evaluation. Subclasses differ only in what they stamp (voltage source vs current source) and what variables the expression can reference (voltage vs current).
- **Files to create**:
  - `src/analog/controlled-source-base.ts`:
    - `abstract class ControlledSourceElement implements AnalogElement`:
      - `constructor(expression: ExprNode, derivative: ExprNode, controlLabel: string, controlType: 'voltage' | 'current')`
      - `_compiledExpr: (ctx: ExpressionContext) => number` — compiled transfer function
      - `_compiledDeriv: (ctx: ExpressionContext) => number` — compiled derivative for Jacobian
      - `_context: ExpressionContext` — bound to solver's current voltages/currents at runtime
      - `stampNonlinear(solver)`:
        1. Build context from current solution (node voltages, branch currents)
        2. Evaluate expression → output value
        3. Evaluate derivative → Jacobian contribution
        4. Call abstract `stampOutput(solver, value, derivative)` — subclass stamps voltage or current
      - `abstract stampOutput(solver, value, derivative): void`
      - `isNonlinear: true` (expression can be nonlinear)
      - `isReactive: false` (no companion model — reactive controlled sources would need separate treatment)
    - `buildControlledSourceContext(compiled: CompiledAnalogCircuit, engine: AnalogEngine): ExpressionContext` — factory that creates a context bound to live engine state
- **Tests**:
  - `src/analog/__tests__/controlled-source-base.test.ts::Base::linear_expression_evaluates` — expression `2 * V(ctrl)`; mock V(ctrl)=1.5; assert output = 3.0
  - `src/analog/__tests__/controlled-source-base.test.ts::Base::derivative_correct_for_linear` — expression `2 * V(ctrl)`; derivative w.r.t. V(ctrl) = 2; assert derivative evaluates to 2.0
  - `src/analog/__tests__/controlled-source-base.test.ts::Base::nonlinear_expression_evaluates` — expression `0.01 * V(ctrl)^2`; V(ctrl)=3; assert output = 0.09
  - `src/analog/__tests__/controlled-source-base.test.ts::Base::nonlinear_derivative` — expression `0.01 * V(ctrl)^2`; derivative = `0.02 * V(ctrl)`; at V(ctrl)=3 assert derivative = 0.06
  - `src/analog/__tests__/controlled-source-base.test.ts::Base::context_binds_to_engine` — build context from mock engine; set node voltage; assert V(label) resolves correctly
- **Acceptance criteria**:
  - Expression and derivative are compiled once at construction, evaluated per NR iteration
  - Context binds V() and I() to live solver state
  - Linear expressions produce exact derivatives
  - Nonlinear expressions produce correct derivatives via symbolic differentiation

---

### Task 5.3.2: VCVS + VCCS

- **Description**: Implement voltage-controlled voltage source (VCVS) and voltage-controlled current source (VCCS). Both use a voltage-referenced expression: the transfer function takes `V(control_label)` as input. VCVS stamps a dependent voltage source at the output; VCCS stamps a dependent current source.
- **Files to create**:
  - `src/components/active/vcvs.ts`:
    - `class VCVSElement extends ControlledSourceElement`:
      - Output: voltage source (branch variable in MNA)
      - `stamp()`: stamps the voltage source branch (1s in the branch equation rows)
      - `stampOutput(solver, value, deriv)`: sets the branch equation RHS to `value` and stamps `-deriv` conductance between control node and branch equation for the Jacobian
    - `VCVSDefinition: ComponentDefinition` with `engineType: "analog"`, category `ACTIVE`
    - Properties: `expression` (STRING, default `"V(ctrl)"` — unity gain), `gain` (FLOAT, default 1.0 — shortcut for linear case: expression becomes `gain * V(ctrl)`)
    - Pins: `ctrl+`, `ctrl-` (control voltage sense), `out+`, `out-` (output)
  - `src/components/active/vccs.ts`:
    - `class VCCSElement extends ControlledSourceElement`:
      - Output: current source (no branch variable — Norton stamp)
      - `stampOutput(solver, value, deriv)`: stamps current `value` into output node RHS, stamps conductance `deriv` between control node and output node for Jacobian
    - `VCCSDefinition: ComponentDefinition` with `engineType: "analog"`, category `ACTIVE`
    - Properties: `expression` (STRING, default `"V(ctrl)"` — unity transconductance), `transconductance` (FLOAT, default 0.001 S — shortcut for linear)
    - Pins: `ctrl+`, `ctrl-`, `out+`, `out-`
- **Tests**:
  - `src/components/active/__tests__/vcvs.test.ts::VCVS::unity_gain_buffer` — VCVS with gain=1; control driven by 3.3V source; assert output = 3.3V ± 0.01V
  - `src/components/active/__tests__/vcvs.test.ts::VCVS::gain_of_10` — gain=10, control=0.5V; assert output = 5.0V
  - `src/components/active/__tests__/vcvs.test.ts::VCVS::nonlinear_expression` — expression `0.5 * V(ctrl)^2`; control=2V; assert output = 2.0V; NR converges in ≤ 10 iterations
  - `src/components/active/__tests__/vcvs.test.ts::VCVS::output_drives_load` — 10V output through 1kΩ load; assert current = 10mA
  - `src/components/active/__tests__/vccs.test.ts::VCCS::linear_transconductance` — gm=0.01 S, control=1V; assert output current = 10mA into 100Ω load (V_load = 1V)
  - `src/components/active/__tests__/vccs.test.ts::VCCS::zero_control_zero_output` — control=0V; assert output current = 0
  - `src/components/active/__tests__/vccs.test.ts::VCCS::nonlinear_square_law` — expression `0.001 * V(ctrl)^2`; control=3V; assert current = 9mA
- **Acceptance criteria**:
  - VCVS output voltage tracks expression of control voltage
  - VCCS output current tracks expression of control voltage
  - Linear shortcut (`gain` / `transconductance` property) matches expression-based result
  - Nonlinear expressions converge via NR with symbolic Jacobian
  - Output drives resistive loads correctly

---

### Task 5.3.3: CCVS + CCCS

- **Description**: Implement current-controlled voltage source (CCVS) and current-controlled current source (CCCS). Both sense current through a specified element and produce an output proportional to (or a function of) that current. Current sensing requires a zero-volt voltage source in series with the sensed branch to create a branch variable whose value is the sensed current.
- **Files to create**:
  - `src/components/active/ccvs.ts`:
    - `class CCVSElement extends ControlledSourceElement`:
      - Control: current through a referenced element (`controlType: 'current'`)
      - The CCVS/CCCS stamps a 0V voltage source in series with the control port. This creates a dedicated branch variable `branchIdx_sense`. The branch current is the sensed current. The expression context binds `I(sense)` to `solver.getBranchCurrent(branchIdx_sense)`. The `controlLabel` string in the base class maps to `branchIdx_sense` via the compiler's branch-index table: `compiled.branchMap.get(controlLabel)` returns the branch index.
      - `stampOutput()`: stamps a dependent voltage source at the output whose value is `expression(I_sense)`
    - `CCVSDefinition: ComponentDefinition` with `engineType: "analog"`, category `ACTIVE`
    - Properties: `expression` (STRING, default `"I(sense)"`), `transresistance` (FLOAT, default 1000 Ω — shortcut)
    - Pins: `sense+`, `sense-` (current sense port — zero-volt source inserted here), `out+`, `out-`
  - `src/components/active/cccs.ts`:
    - `class CCCSElement extends ControlledSourceElement`:
      - Same current sensing as CCVS
      - `stampOutput()`: stamps a dependent current source at output
    - `CCCSDefinition: ComponentDefinition` with `engineType: "analog"`, category `ACTIVE`
    - Properties: `expression` (STRING, default `"I(sense)"`), `currentGain` (FLOAT, default 1.0)
    - Pins: `sense+`, `sense-`, `out+`, `out-`
- **Tests**:
  - `src/components/active/__tests__/ccvs.test.ts::CCVS::transresistance_1k` — 1mA through sense port; rm=1000Ω; assert output voltage = 1V
  - `src/components/active/__tests__/ccvs.test.ts::CCVS::zero_current_zero_output` — no current through sense; assert output = 0V
  - `src/components/active/__tests__/ccvs.test.ts::CCVS::sense_port_zero_voltage_drop` — assert voltage across sense port ≈ 0V (ideal current sensor)
  - `src/components/active/__tests__/cccs.test.ts::CCCS::current_mirror_gain_1` — 5mA through sense; gain=1; assert output current = 5mA
  - `src/components/active/__tests__/cccs.test.ts::CCCS::current_gain_10` — 1mA sense; gain=10; assert output = 10mA
  - `src/components/active/__tests__/cccs.test.ts::CCCS::nonlinear_expression` — expression `0.1 * I(sense)^2`; 10mA sense; assert output = 10µA
- **Acceptance criteria**:
  - Current sensing port has zero voltage drop (ideal ammeter)
  - CCVS output voltage tracks expression of sensed current
  - CCCS output current tracks expression of sensed current
  - NR converges for both linear and nonlinear transfer functions
  - Current-sense branch variable correctly represents the measured current

---

## Wave 5.4: Shared FET Base Class + JFETs

### Task 5.4.1: AbstractFetElement Base Class

- **Description**: Introduce an `AbstractFetElement` base class that factors out the shared structure between MOSFETs (Phase 2) and JFETs (this wave). The base manages 3 terminals (gate, drain, source), provides the NR stamping skeleton, delegates I-V computation and voltage limiting to abstract methods, and handles junction/gate capacitance companion models. Refactor Phase 2's N-MOSFET and P-MOSFET to extend this base. No behavioral change — pure refactoring.
- **Files to create**:
  - `src/analog/fet-base.ts`:
    - `abstract class AbstractFetElement implements AnalogElement`:
      - `readonly gateNode: number`, `readonly drainNode: number`, `readonly sourceNode: number`
      - `readonly isNonlinear: true`
      - `readonly isReactive: true` (junction/gate capacitances)
      - `stamp(solver)`: stamps the linear portion (gate resistance if any, DC bias path)
      - `stampNonlinear(solver)`:
        1. Read V_GS, V_DS from current solution
        2. Call `abstract limitVoltages(vgs, vds): { vgs, vds }` — device-specific voltage limiting
        3. Call `abstract computeIds(vgs, vds): number` — drain-source current
        4. Call `abstract computeGm(vgs, vds): number` — transconductance ∂I_DS/∂V_GS
        5. Call `abstract computeGds(vgs, vds): number` — output conductance ∂I_DS/∂V_DS
        6. Stamp Norton equivalent: conductance matrix entries for gm and gds, current source for I_DS - gm*V_GS - gds*V_DS
      - `updateCompanion(dt, method, voltages)`:
        1. Call `abstract computeCapacitances(vgs, vds): FetCapacitances` — returns { Cgs, Cgd, Cds, Cgb? }
        2. Stamp companion models for each capacitance (reuses Phase 1's capacitor companion coefficients)
      - `abstract polaritySign: 1 | -1` — +1 for N-channel, -1 for P-channel (allows shared code with sign flip)
    - `FetCapacitances` interface: `{ cgs: number, cgd: number, cds?: number, cgb?: number }`
- **Files to modify**:
  - `src/components/semiconductors/nmos.ts` (Phase 2) — refactor `NMosfetElement` to `extends AbstractFetElement`, move I-V equations into `computeIds()`, `computeGm()`, `computeGds()`, move capacitance model into `computeCapacitances()`, voltage limiting into `limitVoltages()`. Set `polaritySign = 1`.
  - `src/components/semiconductors/pmos.ts` (Phase 2) — same refactor, `polaritySign = -1`
- **Tests**:
  - `src/analog/__tests__/fet-base.test.ts::Refactor::nmos_dc_unchanged` — same NMOS test circuit as Phase 2; assert identical DC operating point after refactor
  - `src/analog/__tests__/fet-base.test.ts::Refactor::pmos_dc_unchanged` — same for PMOS
  - `src/analog/__tests__/fet-base.test.ts::Refactor::nmos_transient_unchanged` — same transient test; assert identical waveform
  - `src/analog/__tests__/fet-base.test.ts::Refactor::stamp_pattern_correct` — mock solver; call stampNonlinear on NMOS; verify gm and gds conductance entries stamped at correct matrix positions
- **Acceptance criteria**:
  - All existing MOSFET tests pass unchanged (zero behavioral regression)
  - `AbstractFetElement` is importable and extensible
  - MOSFET I-V equations, capacitance models, and voltage limiting are delegated to overridable methods
  - Shared stamping code is not duplicated between N and P variants

---

### Task 5.4.2: N-JFET + P-JFET

- **Description**: Implement N-channel and P-channel JFETs extending `AbstractFetElement`. The JFET uses the Shichman-Hodges model: three operating regions (cutoff, linear, saturation) controlled by V_GS relative to pinch-off voltage V_P. Unlike MOSFETs, JFETs have a gate-source pn junction that conducts when forward-biased, producing gate current. Voltage limiting uses `pnjlim` on the gate junction.
- **Files to create**:
  - `src/components/semiconductors/njfet.ts`:
    - `class NJfetElement extends AbstractFetElement`:
      - `polaritySign = 1`
      - `computeIds(vgs, vds)`: Shichman-Hodges I-V:
        - Cutoff (V_GS ≤ V_P): I_DS = 0
        - Linear (0 < V_DS < V_GS - V_P): I_DS = β·[(V_GS - V_P)·V_DS - V_DS²/2]·(1 + λ·V_DS)
        - Saturation (V_DS ≥ V_GS - V_P): I_DS = β/2·(V_GS - V_P)²·(1 + λ·V_DS) — note: for V_GS=0 this equals β/2·V_P² numerically, but the general formula must use `(V_GS - V_P)`
      - `computeGm(vgs, vds)`: ∂I_DS/∂V_GS for each region
      - `computeGds(vgs, vds)`: ∂I_DS/∂V_DS for each region
      - `limitVoltages(vgs, vds)`: apply `pnjlim` to V_GS (gate junction), `fetlim`-style clamp on V_DS
      - `computeCapacitances(vgs, vds)`: junction capacitances from model params (CGS, CGD with voltage-dependent depletion)
      - Gate junction: stamps Shockley diode equation for gate-source junction (reverse-biased normally, forward current when V_GS > 0)
    - `NJfetDefinition: ComponentDefinition` with `engineType: "analog"`, category `SEMICONDUCTORS`
    - `.MODEL` parameters: VTO (-2V default), BETA (1e-4 A/V²), LAMBDA (0), IS (1e-14 A), RD (0), RS (0), CGS (0), CGD (0), PB (1V), FC (0.5), KF (0), AF (1)
    - Symbol: standard JFET symbol (arrow into channel for N-type)
  - `src/components/semiconductors/pjfet.ts`:
    - `class PJfetElement extends AbstractFetElement`:
      - `polaritySign = -1`
      - Same equations with polarity inversion
    - Symbol: arrow out of channel for P-type
- **Tests**:
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::cutoff_zero_current` — V_GS < V_P (e.g., V_GS = -3V with V_P = -2V); assert I_DS ≈ 0
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::saturation_current` — V_GS = 0V, V_DS = 5V, V_P = -2V, β = 1e-4; assert I_DS ≈ β/2·(V_GS - V_P)²·(1+λ·5) = β/2·(-(-2))²·1 = 0.2mA
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::linear_region` — V_GS = 0V, V_DS = 0.5V; assert I_DS follows linear equation
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::output_characteristics` — sweep V_DS from 0 to 10V at V_GS = 0, -0.5, -1.0; assert family of curves with pinch-off visible
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::gate_forward_current` — V_GS = +0.7V (forward biased); assert measurable gate current from junction diode
  - `src/components/semiconductors/__tests__/jfet.test.ts::NJFET::lambda_channel_length_modulation` — λ = 0.01; assert I_DS increases slightly with V_DS in saturation (non-flat curves)
  - `src/components/semiconductors/__tests__/jfet.test.ts::PJFET::polarity_inverted` — P-JFET with positive V_P; negative V_DS; assert current flows source to drain
  - `src/components/semiconductors/__tests__/jfet.test.ts::NR::converges_within_10_iterations` — typical bias point; assert NR convergence ≤ 10 iterations
  - `src/components/semiconductors/__tests__/jfet.test.ts::Registration::njfet_registered` — assert `registry.get('NJFET')` exists with `engineType: "analog"`, category `SEMICONDUCTORS`
- **Acceptance criteria**:
  - Three operating regions produce correct I-V characteristics
  - Gate junction conducts when forward biased
  - Channel-length modulation (λ) produces non-zero output conductance
  - All 12 SPICE JFET model parameters are supported
  - NR converges reliably with voltage limiting
  - P-JFET is the polarity-inverted dual of N-JFET

---

## Wave 5.5: Thyristors + Exotic Semiconductors

### Task 5.5.1: SCR (Silicon Controlled Rectifier)

- **Description**: Implement the SCR as a standalone `AnalogElement` with a two-transistor model (internal PNP + NPN with regenerative feedback). The SCR blocks in both directions until the gate current triggers it into forward conduction. Once triggered, it latches on until the anode current drops below the holding current. The model uses an alpha-dependent formulation: as the sum of the two transistors' current gains (α₁ + α₂) approaches 1, the device switches from blocking to conducting (regenerative latch-up).
- **Files to create**:
  - `src/components/semiconductors/scr.ts`:
    - `class SCRElement implements AnalogElement`:
      - Terminals: anode (A), cathode (K), gate (G)
      - Internal state: `_latched: boolean`
      - I-V model:
        - Forward blocking (V_AK > 0, not latched): `I = I_S × (exp(V_AK/(N×V_T)) - 1) / (1 - α₁ - α₂)` — small leakage current. Both α₁ and α₂ are clamped to ≤ 0.95 to prevent division-by-zero.
        - Forward conduction (latched): low-resistance path, V_AK ≈ V_on (typ. 1-2V), modeled as diode in series with R_on
        - Reverse blocking: same as reverse-biased diode
      - Current gain model: `α₂ = 1 - (1 - α₂₀) × exp(-I_G / I_ref)` where `α₂₀ = 0.3` (default off-state gain) and `I_ref = 1mA` (gate current scale factor). `α₁` is fixed at `0.5` (default). Both are clamped to ≤ 0.95 to prevent division-by-zero in the blocking-state formula.
      - Triggering: when `α₁ + α₂ > 0.95`, the SCR transitions to the on-state (low-resistance path, `R_on = 0.01Ω` default). The on-state persists until anode current drops below `I_hold` (default 1mA).
      - Unlatching: when I_AK < I_H (holding current), device returns to blocking
      - `stampNonlinear(solver)`: evaluates I-V based on latched state and current voltages/currents; stamps Norton equivalent
      - `isNonlinear: true`, `isReactive: false`
    - Properties: `vOn` (V, default 1.5), `iGT` (A, default 200µA), `iH` (A, default 5mA), `rOn` (Ω, default 0.01), `vBreakover` (V, default 100), `iS` (A, default 1e-12), `alpha1` (default 0.5), `alpha2_0` (default 0.3), `i_ref` (A, default 1e-3), `n` (default 1)
    - Symbol: standard SCR (triangle with bar and gate)
- **Tests**:
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::blocks_without_gate` — V_AK = 50V, I_G = 0; assert I_AK ≈ leakage only (µA range)
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::triggers_with_gate_current` — V_AK = 50V; inject I_G > I_GT; assert device latches and I_AK = (50 - V_on) / R_load
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::holds_after_gate_removed` — trigger, then remove gate current; assert SCR stays conducting (latched)
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::turns_off_below_holding_current` — reduce V_AK until I_AK < I_H; assert SCR returns to blocking state
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::blocks_reverse` — V_AK = -50V; assert I_AK ≈ -I_S (reverse leakage)
  - `src/components/semiconductors/__tests__/scr.test.ts::SCR::breakover_voltage` — increase V_AK beyond V_breakover without gate; assert device triggers (breakover mode)
- **Acceptance criteria**:
  - Blocks forward and reverse without gate trigger
  - Gate current above I_GT triggers conduction
  - Latches on after trigger (stays conducting with gate removed)
  - Turns off when anode current drops below holding current
  - Breakover voltage triggers without gate current

---

### Task 5.5.2: Triac

- **Description**: Implement the triac as a bidirectional thyristor — effectively two anti-parallel SCRs sharing a gate. The triac conducts in both directions when triggered and latches until current crosses zero. Uses the same alpha-dependent model as the SCR but symmetric for both V_MT1-MT2 polarities.
- **Files to create**:
  - `src/components/semiconductors/triac.ts`:
    - `class TriacElement implements AnalogElement`:
      - Terminals: MT1, MT2, gate
      - Model: two internal SCR-like paths (MT2→MT1 and MT1→MT2), each with independent latch state
      - `stampNonlinear()`: evaluate which path is active based on V_MT2-MT1 polarity, apply SCR equations for that path
      - Triggering: gate current in either polarity triggers the corresponding SCR path
      - `isNonlinear: true`, `isReactive: false`
    - Properties: same as SCR (`vOn`, `iGT`, `iH`, `rOn`) — apply symmetrically
    - Symbol: two anti-parallel SCR symbols merged
- **Tests**:
  - `src/components/semiconductors/__tests__/triac.test.ts::Triac::conducts_positive_when_triggered` — positive V, gate pulse; assert conduction
  - `src/components/semiconductors/__tests__/triac.test.ts::Triac::conducts_negative_when_triggered` — negative V, gate pulse; assert conduction in reverse
  - `src/components/semiconductors/__tests__/triac.test.ts::Triac::turns_off_at_zero_crossing` — AC source through triac; trigger once; assert current magnitude drops below `I_hold` (default 10mA) within one timestep of the voltage zero-crossing. Test uses a 60Hz AC source with 100Ω resistive load.
  - `src/components/semiconductors/__tests__/triac.test.ts::Triac::phase_control` — trigger at 90° phase of AC sine; assert output is chopped sine starting at 90°
- **Acceptance criteria**:
  - Conducts in both directions when triggered
  - Turns off at current zero-crossing
  - Phase-angle triggering produces correct chopped waveform

---

### Task 5.5.3: Diac

- **Description**: Implement the diac as a bidirectional trigger diode. Blocks in both directions until voltage exceeds breakover voltage V_BO, then conducts with negative resistance (voltage drops to V_hold). Symmetric device — no gate terminal.
- **Files to create**:
  - `src/components/semiconductors/diac.ts`:
    - `class DiacElement implements AnalogElement`:
      - 2 terminals
      - I-V: blocks both ways until |V| > V_BO, then snaps to low resistance (V drops to V_hold ≈ V_BO - ΔV)
      - Model: piecewise — blocking region (high R) + conducting region (low R with offset voltage)
      - Smooth transition using tanh for NR convergence
      - `isNonlinear: true`, `isReactive: false`
    - Properties: `vBreakover` (V, default 32), `vHold` (V, default 28), `rOn` (Ω, default 10), `rOff` (Ω, default 1e7), `iH` (A, default 1mA)
    - `DiacDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_SEMICONDUCTOR'`, properties: `breakoverVoltage` (default 30V), `breakbackVoltage` (default 25V), `onResistance` (default 5Ω)
- **Tests**:
  - `src/components/semiconductors/__tests__/diac.test.ts::Diac::blocks_below_breakover` — |V| = 20V; assert I ≈ V/R_off (µA range)
  - `src/components/semiconductors/__tests__/diac.test.ts::Diac::conducts_above_breakover` — |V| = 40V; assert significant current flow
  - `src/components/semiconductors/__tests__/diac.test.ts::Diac::symmetric` — same |V| positive and negative; assert |I| approximately equal
  - `src/components/semiconductors/__tests__/diac.test.ts::Diac::triggers_triac` — diac + triac circuit; assert diac triggers triac at breakover voltage (integration test)
- **Acceptance criteria**:
  - Blocks below breakover voltage
  - Conducts above breakover with negative resistance snap
  - Symmetric I-V characteristic
  - Smooth transition for reliable NR convergence

---

### Task 5.5.4: Varactor Diode

- **Description**: Implement the varactor (variable capacitance diode) as a diode optimized for its voltage-dependent junction capacitance. The primary purpose is the C-V characteristic, not the I-V. Uses Phase 2's diode junction capacitance model (CJO, VJ, M parameters) as the dominant behavior. The varactor is always reverse-biased in normal operation; forward conduction is modeled but not the intended use case.
- **Files to create**:
  - `src/components/semiconductors/varactor.ts`:
    - `class VaractorElement implements AnalogElement`:
      - Extends or wraps Phase 2's diode element with emphasis on junction capacitance
      - `computeCapacitance(vReverse: number): number` — C_j(V) = CJO / (1 + V_R/VJ)^M (standard depletion capacitance formula)
      - `stampNonlinear()`: stamps diode I-V (same as Phase 2 diode)
      - `updateCompanion()`: stamps voltage-dependent capacitance companion model. Capacitance value depends on reverse voltage — recomputed each timestep.
      - `isNonlinear: true`, `isReactive: true`
    - Properties: `cjo` (F, default 20pF), `vj` (V, default 0.7), `m` (default 0.5), `iS` (A, default 1e-14)
    - `.MODEL` support: type `'D'` with varactor-specific defaults
- **Tests**:
  - `src/components/semiconductors/__tests__/varactor.test.ts::Varactor::capacitance_decreases_with_reverse_bias` — measure effective capacitance at V_R=0, 1V, 5V, 10V; assert C decreases monotonically
  - `src/components/semiconductors/__tests__/varactor.test.ts::Varactor::cjo_at_zero_bias` — V_R=0; assert C ≈ CJO
  - `src/components/semiconductors/__tests__/varactor.test.ts::Varactor::cv_formula_correct` — at V_R=2V, VJ=0.7, M=0.5; assert C = CJO / sqrt(1 + 2/0.7) ≈ CJO / 1.97
  - `src/components/semiconductors/__tests__/varactor.test.ts::Varactor::vco_circuit` — varactor in LC tank circuit; vary bias voltage; assert resonant frequency changes (f = 1/(2π√(LC(V))))
- **Acceptance criteria**:
  - Junction capacitance follows C_j = CJO/(1 + V_R/VJ)^M
  - Capacitance decreases with increasing reverse bias
  - Functions correctly in LC oscillator (frequency tuning)

---

### Task 5.5.5: Tunnel Diode

- **Description**: Implement the tunnel diode with its characteristic N-shaped I-V curve: a peak current at V_p, a valley current at V_v, and a region of negative differential resistance between them. Beyond the valley, normal diode forward conduction resumes. The negative resistance region requires careful NR handling — voltage limiting must prevent jumps across the NDR region.
- **Files to create**:
  - `src/components/semiconductors/tunnel-diode.ts`:
    - `class TunnelDiodeElement implements AnalogElement`:
      - I-V model (piecewise smooth):
        - Tunnel current: `I_t(V) = I_p · (V/V_p) · exp(1 - V/V_p)` (peak at V_p)
        - Excess current: `I_x(V) = I_v · exp((V - V_v) / V_x)` (exponential rise past valley)
        - Thermal current: standard Shockley diode
        - Total: `I(V) = I_t(V) + I_x(V) + I_thermal(V)`
      - `stampNonlinear()`: linearize I-V at operating point; stamp Norton equivalent. In the NDR region (V_p < V < V_v), conductance is negative.
      - Voltage limiting: clamp voltage step to 0.1V per NR iteration when in or near the NDR region to prevent oscillation between the peak and valley.
      - `isNonlinear: true`, `isReactive: false` (tunnel diode capacitance can be added later)
    - Properties: `ip` (A, peak current, default 5mA), `vp` (V, peak voltage, default 0.08), `iv` (A, valley current, default 0.5mA), `vv` (V, valley voltage, default 0.5)
- **Tests**:
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::peak_current_at_vp` — bias at V_p; assert I ≈ I_p
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::valley_current_at_vv` — bias at V_v; assert I ≈ I_v
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::negative_resistance_region` — bias at (V_p + V_v)/2; assert dI/dV < 0 (negative conductance)
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::i_v_curve_shape` — sweep V from 0 to 1V in 10mV steps; assert peak at V_p, valley at V_v, and monotonic rise beyond V_v
  - `src/components/semiconductors/__tests__/tunnel-diode.test.ts::TunnelDiode::nr_converges_in_ndr_region` — bias point in NDR region; assert NR converges within 15 iterations
- **Acceptance criteria**:
  - N-shaped I-V curve with correct peak and valley
  - Negative differential resistance between V_p and V_v
  - NR converges reliably even in NDR region
  - Standard forward conduction beyond the valley

---

## Wave 5.6: Coupled Inductors + Transformers

### Task 5.6.1: Coupled Inductor Infrastructure

- **Description**: Implement the mutual inductance coupling model for pairs of inductors. Two inductors L₁ and L₂ with coupling coefficient k produce mutual inductance M = k·√(L₁·L₂). The companion model for coupled inductors extends Phase 1's single-inductor companion with cross-coupling terms: each inductor's companion equation includes a term from the other inductor's branch current history.
- **Files to create**:
  - `src/analog/coupled-inductor.ts`:
    - `class CoupledInductorPair`:
      - Constructor: `(l1: number, l2: number, k: number)` — L₁ (H), L₂ (H), coupling coefficient (0 ≤ k ≤ 1)
      - `readonly m: number` — mutual inductance M = k·√(L₁·L₂)
      - `stampCompanion(solver, branch1, branch2, nodes1, nodes2, dt, method, state)`:
        - For trapezoidal: each inductor stamps its own companion plus cross-terms:
          - Branch 1 equation: `V₁ = (2L₁/h)·I₁ + (2M/h)·I₂ + history₁`
          - Branch 2 equation: `V₂ = (2M/h)·I₁ + (2L₂/h)·I₂ + history₂`
        - For BDF-1: coefficients `L/h` and `M/h`
        - For BDF-2: coefficients `3L/2h` and `3M/2h`
      - `updateState(dt, method, i1, i2, v1, v2, state)`: update history values for next timestep
    - `CoupledInductorState`: `{ prevI1, prevI2, prevV1, prevV2, prevPrevI1?, prevPrevI2?, prevPrevV1?: number, prevPrevV2?: number }` — state for BDF-2 needs 2 history levels; `prevPrevV1` and `prevPrevV2` are required for BDF-2 companion model computation
- **Tests**:
  - `src/analog/__tests__/coupled-inductor.test.ts::Coupling::mutual_inductance_formula` — L₁=1mH, L₂=4mH, k=0.95; assert M = 0.95·√(0.001·0.004) = 1.9mH
  - `src/analog/__tests__/coupled-inductor.test.ts::Coupling::unity_coupling_transfers_energy` — k=1.0; step current through L₁; assert voltage appears across L₂ proportional to turns ratio √(L₂/L₁)
  - `src/analog/__tests__/coupled-inductor.test.ts::Coupling::zero_coupling_independent` — k=0; step current through L₁; assert no voltage across L₂
  - `src/analog/__tests__/coupled-inductor.test.ts::Coupling::trapezoidal_companion_coefficients` — verify stamp produces correct matrix entries for 2L₁/h, 2M/h cross-terms
  - `src/analog/__tests__/coupled-inductor.test.ts::Coupling::bdf2_companion_coefficients` — verify 3L/(2h) and 3M/(2h) coefficients
- **Acceptance criteria**:
  - M = k·√(L₁·L₂) computed correctly
  - Cross-coupling terms appear in companion model stamps
  - Zero coupling (k=0) produces independent inductors
  - Unity coupling (k=1) produces ideal transformer behavior
  - All three integration methods (BDF-1, trapezoidal, BDF-2) produce correct coefficients

---

### Task 5.6.2: Transformer Component

- **Description**: Implement a two-winding transformer using the coupled inductor infrastructure. The transformer is a user-friendly wrapper: the user specifies turns ratio N, primary inductance L_p, and coupling coefficient k. The component creates two coupled inductors internally and presents them as a 4-terminal device (primary+, primary-, secondary+, secondary-).
- **Files to create**:
  - `src/components/passives/transformer.ts`:
    - `class TransformerElement implements AnalogElement`:
      - Internal: `CoupledInductorPair` with L₁ = L_p, L₂ = L_p·N², k
      - 4 terminals + 2 branch variables (one per winding)
      - `stamp()`: stamps both inductor branches
      - `updateCompanion()`: delegates to `CoupledInductorPair.stampCompanion()`
      - `isNonlinear: false`, `isReactive: true`
    - `TransformerDefinition: ComponentDefinition` with `engineType: "analog"`, category `PASSIVES`
    - Properties: `turnsRatio` (N, default 1:1 = 1.0), `primaryInductance` (H, default 10mH), `couplingCoefficient` (k, default 0.99), `primaryResistance` (Ω, default 1.0), `secondaryResistance` (Ω, default 1.0)
    - Derived: L_secondary = L_primary · N²
    - Symbol: two coils with core lines between them
- **Tests**:
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::voltage_ratio` — N=10:1 step-down; 120V AC primary; assert secondary peak ≈ 12V. Coupling tolerance: assert output peak voltage = N × V_in_peak × k ± 2% for k=0.99, N=10, V_in=1.2V_peak: output ≈ 11.88V ± 0.24V.
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::current_ratio_inverse` — 1A primary into resistive secondary load; assert secondary current ≈ N × primary current
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::power_conservation` — assert P_primary ≈ P_secondary for k ≈ 1 (within 5%)
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::leakage_with_low_k` — k=0.8; assert secondary voltage < ideal (leakage inductance absorbs voltage)
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::dc_blocks` — DC source on primary; assert no DC current in secondary (inductors block DC in steady state)
  - `src/components/passives/__tests__/transformer.test.ts::Transformer::winding_resistance_drops_voltage` — R_pri = 10Ω, 1A; assert primary voltage drop ≈ 10V
- **Acceptance criteria**:
  - Voltage ratio matches turns ratio for k ≈ 1
  - Current ratio is inverse of voltage ratio (power conservation)
  - Leakage (k < 1) reduces energy transfer
  - Winding resistance models ohmic losses
  - DC isolation (no DC transfer between windings)

---

### Task 5.6.3: Tapped Transformer

- **Description**: Implement a 3-winding transformer (primary + two secondary halves with center tap) using an NxN coupling matrix generalization of the coupled inductor pair. The center tap provides a midpoint voltage reference commonly used in full-wave rectifier circuits and split power supplies.
- **Files to create**:
  - `src/components/passives/tapped-transformer.ts`:
    - `class TappedTransformerElement implements AnalogElement`:
      - 5 distinct external pins: primary+ (p1), primary- (p2), sec1+ (s1), center-tap (ct), sec2- (s2). Internally, center-tap is the junction between the two secondary halves. The '6 terminals' count refers to the 3 windings × 2 terminals each, but center-tap is shared (it serves as both sec1- and sec2+), yielding 5 physical pins.
      - 3 branch variables (one per winding)
      - Internal: 3x3 coupling matrix with L₁ (primary), L₂ (secondary half 1), L₃ (secondary half 2)
      - Coupling: M₁₂ = k·√(L₁·L₂), M₁₃ = k·√(L₁·L₃), M₂₃ = k·√(L₂·L₃)
      - L₂ = L₃ = L₁·(N/2)² for symmetric center-tapped secondary with turns ratio N
      - `updateCompanion()`: stamps 3x3 companion matrix with all cross-coupling terms
      - `isNonlinear: false`, `isReactive: true`
    - Properties: `turnsRatio` (N total secondary / primary, default 2.0), `primaryInductance` (H), `couplingCoefficient` (k), `primaryResistance` (Ω), `secondaryResistance` (Ω per half)
    - `TappedTransformerDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_PASSIVE'`, properties: `primaryInductance` (default 1), `turnsRatio1` (default 5), `turnsRatio2` (default 5), `couplingCoefficient` (default 0.99)
- **Tests**:
  - `src/components/passives/__tests__/tapped-transformer.test.ts::Tapped::center_tap_voltage_is_half` — N=2 (1:1 per half); 10V AC primary; assert center tap to each end ≈ 10V, end-to-end ≈ 20V
  - `src/components/passives/__tests__/tapped-transformer.test.ts::Tapped::full_wave_rectifier` — tapped transformer + 2 diodes + filter cap; assert DC output ≈ V_peak_secondary - V_diode
  - `src/components/passives/__tests__/tapped-transformer.test.ts::Tapped::symmetric_halves` — assert secondary half voltages are equal in magnitude, opposite in phase relative to center tap
- **Acceptance criteria**:
  - Center tap provides a voltage midpoint
  - Each secondary half produces correct voltage ratio
  - 3x3 coupling matrix stamps correctly
  - Works in full-wave rectifier circuit

---

## Wave 5.7: Transmission Line + Sensors + Exotic

### Task 5.7.1: Lossy Transmission Line (Lumped RLCG)

- **Description**: Implement a transmission line as N lumped RLCG segments. Each segment consists of series resistance R_seg and inductance L_seg, followed by shunt conductance G_seg and capacitance C_seg to ground. The user specifies high-level parameters (characteristic impedance Z₀, propagation delay τ, loss per unit length, number of segments N), and the component derives per-unit-length RLCG values. The component dynamically creates N internal nodes and 4N sub-elements.
- **Files to create**:
  - `src/components/passives/transmission-line.ts`:
    - `class TransmissionLineElement implements AnalogElement`:
      - User properties: `z0` (Ω, default 50), `delay` (s, default 1e-9), `loss` (dB/m, default 0), `length` (m, default 1), `segments` (N, default 10)
      - Derived per-segment: `L_seg = Z₀·τ/(N·length)`, `C_seg = τ/(Z₀·N·length)`, `R_seg = loss_linear·Z₀·length/N`, `G_seg = loss_linear/(Z₀·N·length)` where `loss_linear` converts from dB/m
      - Internal: N-1 internal nodes between segments, N resistor stamps, N inductor companion stamps, N capacitor companion stamps, N conductance stamps
      - `stamp()`: stamp all R and G conductances
      - `updateCompanion()`: stamp all L and C companion models
      - `isNonlinear: false`, `isReactive: true`
      - Allocates N branch variables for the N inductor companions
      - The `TransmissionLineDefinition` implements `getInternalNodeCount(props): number` returning `(props.segments - 1) × 2` (each internal segment boundary has two nodes: series and shunt). The compiler calls this before matrix allocation to determine the total node count. The `analogFactory` receives node IDs for all internal nodes (passed as part of `nodeIds` array, after the external pin nodes).
    - Properties: `impedance` (Ω, default 50), `delay` (s, default 1ns), `lossPerMeter` (dB/m, default 0), `length` (m, default 1.0), `segments` (INT, default 10, min 2, max 100)
- **Tests**:
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::propagation_delay` — step input on port 1; measure arrival time at port 2; assert delay ≈ τ ± 20% (lumped model approximation)
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::characteristic_impedance` — terminate with Z₀; assert no reflection (matched load — output voltage = input/2 for voltage step)
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::open_circuit_reflection` — unterminated line; assert reflected wave doubles voltage at open end
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::loss_attenuates_signal` — lossy line (loss=1 dB/m, 1m); assert output < input by approximately 1dB
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::more_segments_more_accurate` — compare N=5 vs N=50 delay; assert N=50 is closer to ideal τ
  - `src/components/passives/__tests__/transmission-line.test.ts::TLine::lossless_case` — loss=0; assert R_seg and G_seg are zero; no signal attenuation
  - `src/components/passives/__tests__/transmission-line.test.ts::TransmissionLine::low_segments_warning` — set segments=3; assert `transmission-line-low-segments` diagnostic is emitted with warning severity
- **Acceptance criteria**:
  - Propagation delay approximates specified τ (improves with more segments)
  - Matched termination produces no reflection
  - Open/short termination produces correct reflection
  - Loss attenuates signal proportionally
  - Lossless case (R=0, G=0) works correctly

---

### Task 5.7.2: NTC Thermistor

- **Description**: Implement a negative temperature coefficient thermistor as a temperature-dependent resistor. Resistance decreases exponentially with temperature. Temperature can be fixed (component property), driven by an external input, or self-heated (power dissipation raises temperature via a thermal model).
- **Files to create**:
  - `src/components/sensors/ntc-thermistor.ts`:
    - `class NTCThermistorElement implements AnalogElement`:
      - R(T) = R₀ · exp(B · (1/T - 1/T₀)) — B-parameter model
      - For Steinhart-Hart: 1/T = A + B·ln(R) + C·(ln(R))³ — configurable via 3 coefficients
      - Self-heating thermal model (optional):
        - dT/dt = (P_dissipated - (T - T_ambient) / R_thermal) / C_thermal
        - Where P = V²/R is power dissipated, R_thermal is thermal resistance to ambient, C_thermal is thermal mass
        - Integrates temperature using the same timestep as the circuit
      - `stampNonlinear()`: compute R(T) at current temperature, stamp conductance 1/R(T)
      - `updateCompanion()`: if self-heating enabled, integrate thermal ODE
      - `isNonlinear: true` (resistance depends on temperature which depends on voltage)
      - `isReactive: true` if self-heating enabled
    - Properties: `r0` (Ω at T₀, default 10kΩ), `beta` (K, default 3950), `t0` (K, default 298.15 = 25°C), `temperature` (K, default 298.15 — fixed temp if self-heating disabled), `selfHeating` (BOOL, default false), `thermalResistance` (K/W, default 50), `thermalCapacitance` (J/K, default 0.01)
    - `NTCThermistorDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_PASSIVE'`, properties: `r0` (default 10000), `beta` (default 3950), `t0` (default 298.15)
    - Steinhart-Hart coefficients are optional alternative to B-parameter model. Properties: `shA?: number`, `shB?: number`, `shC?: number`. If all three are provided, use Steinhart-Hart formula instead of B-parameter. Test: `NTC::steinhart_hart_mode` — set shA=1.1e-3, shB=2.4e-4, shC=7.5e-8; assert resistance at 25°C matches 1/(A+B×ln(R)+C×(ln(R))³) ± 1%.
- **Tests**:
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts::NTC::resistance_at_t0_equals_r0` — T = T₀; assert R = R₀
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts::NTC::resistance_decreases_with_temperature` — T₀=298K, T=348K (75°C); assert R < R₀ (NTC)
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts::NTC::beta_model_formula` — R₀=10k, B=3950, T=350K; assert R = 10000·exp(3950·(1/350 - 1/298.15)) ≈ 1.84kΩ
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts::NTC::self_heating_increases_temperature` — 1V across 100Ω NTC (P=10mW); run transient with self-heating; assert temperature rises from ambient
  - `src/components/sensors/__tests__/ntc-thermistor.test.ts::NTC::thermal_equilibrium` — self-heating; run to steady state; assert T = T_ambient + P·R_thermal
- **Acceptance criteria**:
  - Resistance follows B-parameter model at fixed temperature
  - Self-heating thermal model reaches correct equilibrium temperature
  - NTC behavior: resistance decreases with temperature

---

### Task 5.7.3: LDR (Light Dependent Resistor)

- **Description**: Implement a light-dependent resistor whose resistance varies with illumination level. The light level is a component property (adjustable via slider).
- **Files to create**:
  - `src/components/sensors/ldr.ts`:
    - `class LDRElement implements AnalogElement`:
      - R(lux) = R_dark · (lux / lux_ref)^(-γ) — power law
      - `stampNonlinear()`: stamps conductance 1/R(lux) at current light level
      - `isNonlinear: true` (resistance depends on property, which can change via slider)
      - `isReactive: false`
    - Properties: `rDark` (Ω, default 1MΩ — resistance in darkness), `rLight` (Ω, default 100 — resistance at reference lux), `luxRef` (lux, default 1000), `gamma` (exponent, default 0.7), `lux` (current light level, default 500 — slider-adjustable)
    - `LDRDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_PASSIVE'`, properties: `rDark` (default 1e6), `luxRef` (default 100), `gamma` (default 0.7)
    - At `lux=0`, the LDR uses its dark resistance directly: `R = rDark`. The power-law formula `R(lux) = rDark × (lux/luxRef)^(-gamma)` is used only for `lux > 0`.
- **Tests**:
  - `src/components/sensors/__tests__/ldr.test.ts::LDR::dark_resistance` — lux=0; assert R = R_dark (not power-law formula)
  - `src/components/sensors/__tests__/ldr.test.ts::LDR::bright_resistance` — lux=1000 (reference); assert R ≈ R_light
  - `src/components/sensors/__tests__/ldr.test.ts::LDR::power_law_correct` — lux=100; assert R = R_dark·(100/lux_ref)^(-γ)
  - `src/components/sensors/__tests__/ldr.test.ts::LDR::slider_changes_resistance` — change lux via property; re-solve; assert new current consistent with new R
- **Acceptance criteria**:
  - Resistance follows power-law relationship with illumination
  - Full range from R_dark to R_light
  - Slider-adjustable light level

---

### Task 5.7.4: Spark Gap

- **Description**: Implement a spark gap as a voltage-triggered variable resistance with hysteresis. Blocks until voltage exceeds breakdown, then conducts with low resistance until current drops below holding threshold.
- **Files to create**:
  - `src/components/sensors/spark-gap.ts`:
    - `class SparkGapElement implements AnalogElement`:
      - State: `_conducting: boolean`
      - I-V: if not conducting and |V| > V_breakdown, switch to conducting. If conducting and |I| < I_hold, switch to blocking.
      - Conducting: R = R_on (typ. 1-10Ω)
      - Blocking: R = R_off (typ. 1GΩ+)
      - Smooth tanh transition for NR convergence
      - `isNonlinear: true`, `isReactive: false`
    - Properties: `vBreakdown` (V, default 1000), `rOn` (Ω, default 5), `rOff` (Ω, default 1e10), `iHold` (A, default 10mA)
    - `SparkGapDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_PASSIVE'`, properties: `breakdownVoltage` (default 1000V), `holdVoltage` (default 20V), `onResistance` (default 1Ω)
- **Tests**:
  - `src/components/sensors/__tests__/spark-gap.test.ts::SparkGap::blocks_below_breakdown` — 500V across gap; assert I ≈ 500/R_off (nA range)
  - `src/components/sensors/__tests__/spark-gap.test.ts::SparkGap::conducts_above_breakdown` — 1500V; assert gap fires and current flows
  - `src/components/sensors/__tests__/spark-gap.test.ts::SparkGap::holds_until_current_drops` — fire gap; reduce source voltage; assert gap stays conducting while I > I_hold
  - `src/components/sensors/__tests__/spark-gap.test.ts::SparkGap::extinguishes_below_holding` — reduce until I < I_hold; assert returns to blocking
- **Acceptance criteria**:
  - Fires at breakdown voltage
  - Hysteresis: stays conducting until current drops below holding
  - Smooth resistance transition for NR

---

### Task 5.7.5: Memristor

- **Description**: Implement a memristor using the Joglekar window function model. The memristor's resistance depends on an internal state variable w (normalized, 0 to 1) representing the boundary between doped and undoped regions. The state evolves with current: dw/dt = µ_v · R_on / D² · i(t) · f(w), where f(w) is the window function that enforces 0 ≤ w ≤ 1. The resistance is R(w) = R_on · w + R_off · (1 - w).
- **Files to create**:
  - `src/components/passives/memristor.ts`:
    - `class MemristorElement implements AnalogElement`:
      - State: `_w: number` (0 to 1, initial default 0.5)
      - R(w) = R_on · w + R_off · (1 - w)
      - dw/dt = µ_v · R_on / D² · i · f_p(w) where f_p(w) = 1 - (2w - 1)^(2p) (Joglekar window, p = order)
      - `stampNonlinear()`: stamps conductance 1/R(w). The memristor stamps its state-dependent conductance `G(w) = w × (R_ON⁻¹ - R_OFF⁻¹) + R_OFF⁻¹` in `stamp()`.
      - The memristor implements `updateState(dt, voltages)` to integrate state variable: `w_new = w + dw/dt × dt`, clamped to [0, 1]. It does NOT implement `stampCompanion()` — the memristor's conductance is a function of state `w`, not a companion model. The engine calls `updateState()` each accepted timestep.
      - `isNonlinear: true`
    - Properties: `rOn` (Ω, default 100), `rOff` (Ω, default 100kΩ), `initialState` (w₀, default 0.5), `mobility` (µ_v in m²/(V·s), default 1e-14), `deviceLength` (D in m, default 10e-9), `windowOrder` (p, default 1)
    - `MemristorDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_PASSIVE'`, properties: `rOn` (default 100), `rOff` (default 16000), `mu` (default 1e-14), `d` (default 10e-9)
- **Tests**:
  - `src/components/passives/__tests__/memristor.test.ts::Memristor::initial_resistance` — w=0.5; assert R = (R_on + R_off)/2 = 50.05kΩ
  - `src/components/passives/__tests__/memristor.test.ts::Memristor::positive_current_decreases_resistance` — apply positive voltage; run transient; assert w increases (more doped region) → R decreases
  - `src/components/passives/__tests__/memristor.test.ts::Memristor::negative_current_increases_resistance` — negative voltage; assert w decreases → R increases
  - `src/components/passives/__tests__/memristor.test.ts::Memristor::pinched_hysteresis_loop` — apply AC sine; plot I vs V; assert pinched hysteresis loop (figure-8 shape): I(V) is different for increasing vs decreasing V
  - `src/components/passives/__tests__/memristor.test.ts::Memristor::window_function_bounds_state` — large positive current for long time; assert w never exceeds 1.0; large negative; assert w never goes below 0.0
- **Acceptance criteria**:
  - Resistance depends on charge history (not just voltage)
  - Positive current decreases resistance; negative increases it
  - Window function prevents state saturation (w stays in [0, 1])
  - Pinched hysteresis I-V loop under AC excitation
  - State integrates correctly with adaptive timestep

---

### Task 5.7.6: Triode (Vacuum Tube)

- **Description**: Implement a triode vacuum tube using the Koren model, which is the standard for guitar amplifier simulation. The triode has three terminals: plate (anode), grid, cathode. The plate current depends on both plate voltage and grid voltage with a mu-dependent transfer characteristic.
- **Files to create**:
  - `src/components/semiconductors/triode.ts`:
    - `class TriodeElement implements AnalogElement`:
      - Koren model: `E₁ = V_PK/K_P · ln(1 + exp(K_P·(1/µ + V_GK/sqrt(K_VB + V_PK²))))`, `I_P = (E₁/K_G1)^EX` when E₁ > 0, else 0
      - Grid current: `I_G = I_GK · (exp(V_GK/V_CT) - 1)` when grid is driven positive
      - `stampNonlinear()`: linearize I_P(V_GK, V_PK) at operating point; stamp gm and gp conductances plus current source
      - Voltage limiting: clamp V_GK step to prevent exponential overflow
      - `isNonlinear: true`, `isReactive: false` (interelectrode capacitances can be added as external caps)
    - Properties: `mu` (amplification factor, default 100), `kp` (Koren K_P, default 600), `kvb` (K_VB, default 300), `kg1` (K_G1, default 1060), `ex` (exponent, default 1.4), `rp` (plate resistance, default 62.5kΩ), `cgp` (grid-plate capacitance, default 1.7pF — informational, stamped as external)
    - `.MODEL` support with standard 12AX7 defaults
    - `TriodeDefinition: ComponentDefinition` — `engineType: 'analog'`, `category: 'ANALOG_ACTIVE'`, properties: `mu` (default 100), `kG1` (default 1060), `kP` (default 600), `kVB` (default 300), `ex` (default 1.5), `rGI` (default 2000)
- **Tests**:
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::plate_current_increases_with_vpk` — V_GK = 0; sweep V_PK from 0 to 300V; assert I_P increases monotonically
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::grid_controls_plate_current` — V_PK = 200V; sweep V_GK from -4V to 0V; assert I_P increases as grid becomes less negative
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::cutoff_at_negative_grid` — V_GK = -10V (well below cutoff); assert I_P ≈ 0
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::amplification_factor` — small-signal: assert voltage gain ≈ µ·R_L/(rp + R_L) for a common-cathode amplifier
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::grid_current_when_positive` — V_GK = +1V; assert measurable grid current
  - `src/components/semiconductors/__tests__/triode.test.ts::Triode::nr_converges` — typical operating point (V_PK=200V, V_GK=-2V); assert NR converges ≤ 10 iterations
- **Acceptance criteria**:
  - Koren model produces realistic plate characteristic curves
  - Grid voltage controls plate current with correct mu
  - Cutoff region (I_P = 0) at sufficiently negative grid
  - Grid current when grid driven positive
  - Standard 12AX7 defaults match published tube data

---

### Task 5.7.7: NPN/PNP Darlington (Subcircuit Expansion)

- **Description**: Register NPN and PNP Darlington transistor pairs as subcircuit expansions using Phase 4c's transistor expansion infrastructure. Each Darlington is two BJTs with the emitter of the first connected to the base of the second, plus an optional base-emitter resistor on the output transistor for turn-off speed.
- **Files to create**:
  - `src/analog/transistor-models/darlington.ts`:
    - `createNpnDarlington(registry: ComponentRegistry): Circuit` — two NPN BJTs: Q1 collector → shared collector terminal, Q1 emitter → Q2 base, Q2 collector → shared collector terminal, Q2 emitter → emitter terminal, base terminal → Q1 base. Optional R_BE (10kΩ) across Q2 B-E.
    - `createPnpDarlington(registry: ComponentRegistry): Circuit` — same topology with PNP BJTs
    - `registerDarlingtonModels(registry: ComponentRegistry): void` — registers subcircuits and creates ComponentDefinitions for 'DarlingtonNPN' and 'DarlingtonPNP' with `transistorModel` set, `engineType: "analog"`, category `SEMICONDUCTORS`, `simulationModes: ['transistor']`
    - Interface pins: B (base), C (collector), E (emitter) — same as single BJT
- **Tests**:
  - `src/analog/__tests__/darlington.test.ts::NPN::high_current_gain` — measure β_total; assert β ≈ β₁·β₂ (e.g., 100·100 = 10000)
  - `src/analog/__tests__/darlington.test.ts::NPN::vbe_doubled` — assert V_BE_total ≈ 2·V_BE_single ≈ 1.2-1.4V
  - `src/analog/__tests__/darlington.test.ts::NPN::emitter_follower` — Darlington as emitter follower; assert V_out ≈ V_in - 2·V_BE
  - `src/analog/__tests__/darlington.test.ts::PNP::polarity_inverted` — PNP Darlington; assert current flows in opposite direction
  - `src/analog/__tests__/darlington.test.ts::Registration::npn_darlington_registered` — assert registry has 'DarlingtonNPN' with `transistorModel` set
- **Acceptance criteria**:
  - Current gain is approximately β₁·β₂
  - V_BE is approximately twice a single transistor's V_BE
  - Uses Phase 4c's expansion infrastructure (not a standalone element)
  - Both NPN and PNP variants registered

---

## Wave 5.8: Analog Switch + Schmitt Trigger

### Task 5.8.1: Analog Switch (SPST + SPDT)

- **Description**: Implement analog switches as voltage-controlled variable resistances. Unlike digital switches (binary on/off), analog switches have a control voltage that smoothly transitions resistance from R_on to R_off using a tanh function for NR-friendly behavior. The SPST has one signal path; the SPDT has a common terminal and two alternate paths (one closes as the other opens).
- **Files to create**:
  - `src/components/active/analog-switch.ts`:
    - `class AnalogSwitchElement implements AnalogElement`:
      - Control voltage V_ctrl; threshold V_th (default VDD/2)
      - R(V_ctrl) = R_off - (R_off - R_on) · 0.5 · (1 + tanh(k · (V_ctrl - V_th))) — smooth transition
      - k controls transition sharpness (default 20/V — transitions over ~0.2V range)
      - `stampNonlinear()`: compute R from V_ctrl; stamp conductance 1/R between signal terminals
      - `isNonlinear: true`, `isReactive: false`
    - `class AnalogSwitchSPDTElement implements AnalogElement`:
      - Same control, two signal paths: COM-NO and COM-NC
      - R_NO(V_ctrl) uses same tanh function (closes when V_ctrl > V_th)
      - R_NC(V_ctrl) uses inverted function (opens when V_ctrl > V_th)
      - `stampNonlinear()`: stamps both paths
    - Properties: `rOn` (Ω, default 10), `rOff` (Ω, default 1e9), `threshold` (V, default 1.65 = VDD/2 for CMOS 3.3V), `transitionSharpness` (1/V, default 20)
    - Pins — SPST: `ctrl`, `in`, `out`. SPDT: `ctrl`, `com`, `no`, `nc`
- **Tests**:
  - `src/components/active/__tests__/analog-switch.test.ts::SPST::on_resistance` — V_ctrl = 3.3V (well above threshold); assert R ≈ R_on
  - `src/components/active/__tests__/analog-switch.test.ts::SPST::off_resistance` — V_ctrl = 0V; assert R ≈ R_off (effectively open)
  - `src/components/active/__tests__/analog-switch.test.ts::SPST::smooth_transition` — sweep V_ctrl from 0 to 3.3V; assert R changes smoothly (no discontinuity)
  - `src/components/active/__tests__/analog-switch.test.ts::SPST::signal_passes_when_on` — 1V signal, switch on; assert output ≈ 1V · R_load/(R_load + R_on)
  - `src/components/active/__tests__/analog-switch.test.ts::SPDT::break_before_make` — during transition, assert COM-NO and COM-NC are never both fully on simultaneously (both have elevated resistance at threshold)
  - `src/components/active/__tests__/analog-switch.test.ts::SPDT::no_and_nc_complementary` — V_ctrl high: NO closed, NC open. V_ctrl low: NO open, NC closed.
  - `src/components/active/__tests__/analog-switch.test.ts::SPST::nr_converges_during_transition` — V_ctrl at threshold; assert NR converges ≤ 10 iterations
- **Acceptance criteria**:
  - Smooth R(V_ctrl) characteristic for reliable NR convergence
  - R_on and R_off match specifications when fully switched
  - SPDT provides complementary switching
  - No abrupt resistance discontinuity at any control voltage

---

### Task 5.8.2: Schmitt Trigger (Inverting + Non-Inverting)

- **Description**: Implement Schmitt trigger components with hysteresis. The output switches between V_OH and V_OL based on input voltage crossing V_TH (upper threshold, rising) and V_TL (lower threshold, falling). The hysteresis band prevents oscillation on noisy or slowly-changing inputs. Uses Phase 4a's `DigitalOutputPinModel` for the output stage and `DigitalInputPinModel` for the input — but with modified thresholds implementing the hysteresis.
- **Files to create**:
  - `src/components/active/schmitt-trigger.ts`:
    - `class SchmittTriggerElement implements AnalogElement`:
      - State: `_outputHigh: boolean` — current output state (needed for hysteresis)
      - Thresholds: V_TH (rising threshold), V_TL (falling threshold), V_TH > V_TL
      - Logic:
        - If `_outputHigh` and V_in < V_TL → switch low
        - If `!_outputHigh` and V_in > V_TH → switch high
        - Otherwise → hold current state
      - For non-inverting: output follows input sense (high input → high output)
      - For inverting: output opposes input sense (high input → low output)
      - Output uses `DigitalOutputPinModel` for realistic drive (R_out + C_out + voltage level)
      - Input uses `DigitalInputPinModel` for loading
      - `stampNonlinear()`: read input voltage, apply hysteresis logic, set output pin level
      - `isNonlinear: true`, `isReactive: true` (pin capacitances)
    - `SchmittInvertingDefinition`, `SchmittNonInvertingDefinition`: separate ComponentDefinitions
    - Properties: `vTH` (V, default 2.0), `vTL` (V, default 1.0), `vOH` (V, default 3.3), `vOL` (V, default 0.0), `rOut` (Ω, default 50)
    - Hysteresis width = V_TH - V_TL; center = (V_TH + V_TL) / 2
- **Tests**:
  - `src/components/active/__tests__/schmitt-trigger.test.ts::Inverting::switches_low_on_rising_threshold` — input ramps up; assert output goes LOW when V_in crosses V_TH
  - `src/components/active/__tests__/schmitt-trigger.test.ts::Inverting::switches_high_on_falling_threshold` — input ramps down; assert output goes HIGH when V_in crosses V_TL
  - `src/components/active/__tests__/schmitt-trigger.test.ts::Inverting::hysteresis_prevents_oscillation` — input hovers between V_TL and V_TH; assert output does not toggle
  - `src/components/active/__tests__/schmitt-trigger.test.ts::NonInverting::output_follows_input_sense` — input > V_TH → output HIGH; input < V_TL → output LOW
  - `src/components/active/__tests__/schmitt-trigger.test.ts::Hysteresis::noisy_sine_clean_square` — Sine wave: 1kHz, amplitude = 2V (spanning both thresholds). Noise: Gaussian, std dev = 0.1V (within hysteresis band). Simulate 5 complete periods (5ms). Assert exactly 10 output transitions (2 per period, no glitches).
  - `src/components/active/__tests__/schmitt-trigger.test.ts::Transfer::plot_matches_hysteresis_loop` — sweep input up then down; assert transfer characteristic shows rectangular hysteresis loop
- **Acceptance criteria**:
  - Upper and lower thresholds produce hysteresis (different switching points for rising vs falling)
  - Output levels match V_OH and V_OL specifications
  - Inverting and non-inverting variants produce opposite output sense
  - Hysteresis prevents spurious transitions on noisy inputs
  - Uses pin model for realistic output drive characteristics

---

## Compiler Pipeline

The analog compiler (`src/analog/compiler.ts`) pipeline:

1. **Node mapping** — assign MNA node indices to circuit pins (Phase 1)
2. **Ground detection** — verify ground element exists (Phase 1)
3. **Model resolution** — resolve `.MODEL` references to parameter sets (Phase 2)
4. **Logic family resolution** — resolve pin electrical specs from circuit metadata (Phase 4a)
5. **Transistor expansion** — expand components with `simulationMode: 'transistor'` into MOSFET subcircuits (Phase 4c)
6. **Bridge detection** — identify cross-engine boundaries and insert bridge adapters (Phase 4b)
7. **Element instantiation** — call `analogFactory` for each component, create `AnalogElement` instances (Phase 1/2/4a)
8. **Topology validation** — check for floating nodes, missing ground, voltage source loops (Phase 1/2)

Each phase modifies a specific pipeline stage. Later phases must not alter earlier stages' behavior.

---

## Diagnostic Codes Added

| Code | Severity | Meaning |
|------|----------|---------|
| `reverse-biased-cap` | warning | Polarized capacitor reverse-biased beyond rated threshold |
| `fuse-blown` | info | Fuse has blown due to I²t energy exceeding rating |
| `ndr-convergence-assist` | info | Tunnel diode NR iteration using tightened voltage limiting in NDR region |
| `transmission-line-low-segments` | warning | Transmission line segment count too low for accurate delay modeling (N < 5) |

## Key Files Summary

| File | Purpose |
|------|---------|
| `src/analog/expression-differentiate.ts` | Symbolic differentiation of expression AST |
| `src/analog/expression-evaluate.ts` | Expression evaluation with circuit variable binding |
| `src/analog/controlled-source-base.ts` | Base class for expression-driven controlled sources |
| `src/analog/fet-base.ts` | `AbstractFetElement` shared base for MOSFETs and JFETs |
| `src/analog/coupled-inductor.ts` | Mutual inductance coupling model for transformer windings |
| `src/analog/transistor-models/darlington.ts` | NPN/PNP Darlington subcircuit definitions |
| `src/components/passives/polarized-cap.ts` | Polarized electrolytic capacitor with ESR and leakage |
| `src/components/passives/crystal.ts` | Quartz crystal (Butterworth-Van Dyke model) |
| `src/components/passives/analog-fuse.ts` | Fuse with I²t thermal model |
| `src/components/passives/transformer.ts` | Two-winding transformer |
| `src/components/passives/tapped-transformer.ts` | Center-tapped transformer (3 windings) |
| `src/components/passives/transmission-line.ts` | Lossy RLCG lumped transmission line |
| `src/components/passives/memristor.ts` | Memristor (Joglekar model) |
| `src/components/sources/variable-rail.ts` | Adjustable DC source with slider integration |
| `src/components/semiconductors/njfet.ts` | N-channel JFET (Shichman-Hodges model) |
| `src/components/semiconductors/pjfet.ts` | P-channel JFET |
| `src/components/semiconductors/scr.ts` | Silicon controlled rectifier |
| `src/components/semiconductors/triac.ts` | Bidirectional thyristor |
| `src/components/semiconductors/diac.ts` | Bidirectional trigger diode |
| `src/components/semiconductors/varactor.ts` | Variable capacitance diode |
| `src/components/semiconductors/tunnel-diode.ts` | Tunnel diode with NDR region |
| `src/components/semiconductors/triode.ts` | Vacuum tube triode (Koren model) |
| `src/components/active/vcvs.ts` | Voltage-controlled voltage source |
| `src/components/active/vccs.ts` | Voltage-controlled current source |
| `src/components/active/ccvs.ts` | Current-controlled voltage source |
| `src/components/active/cccs.ts` | Current-controlled current source |
| `src/components/active/analog-switch.ts` | Analog switch SPST + SPDT |
| `src/components/active/schmitt-trigger.ts` | Schmitt trigger (inverting + non-inverting) |
| `src/components/sensors/ntc-thermistor.ts` | NTC thermistor with B-parameter model |
| `src/components/sensors/ldr.ts` | Light dependent resistor |
| `src/components/sensors/spark-gap.ts` | Spark gap with breakdown and hysteresis |
