# Phase 6: Tier 3 Components + Polish

## Overview

Extend the remaining digital components with behavioral analog factories (using Phase 4a's pin electrical model), add specialty analog components (555 timer, real op-amp, OTA, comparator, optocoupler, ADC, DAC), implement AC small-signal analysis, add CTZ URL import for CircuitJS circuit sharing, and provide a Monte Carlo / parameter sweep interface for batch simulation.

## Dependencies

- **Phase 4a** (Digital-Analog Interface) must be complete: `BehavioralGateElement`, `BehavioralFlipflopElement`, `DigitalPinModel`, `LogicFamilyConfig`, `simulationMode` property, analog compiler behavioral support
- **Phase 4b** (Two-Engine Bridge) must be complete (required for mixed-signal compilation in Tasks 6.1.x)
- **Phase 2** (Tier 1 Components) must be complete: all Tier 1 analog elements, expression parser, `.MODEL` infrastructure
- **Phase 5** (Tier 2 Components) must be complete (required for controlled sources in Task 6.2.2 and semiconductor models in Tasks 6.2.x)

## Wave structure and dependencies

```
Wave 6.1: Digital-in-Analog Behavioral Extensions    [Phase 4a]
Wave 6.2: Specialty Analog Components                [Phase 2 + Phase 5]
Wave 6.3: ADC + DAC Converters                       [Phase 4a + Phase 2]
Wave 6.4: AC Small-Signal Analysis                   [Phase 1 + Phase 2]
Wave 6.5: CTZ URL Import                             [Phase 2 components]
Wave 6.6: Monte Carlo / Parameter Sweep              [Phase 1 engine]
```

Waves 6.1, 6.2, 6.3 can run in parallel. Wave 6.4 depends on Wave 6.2 (the `opamp_gain_bandwidth` test in Task 6.4.1 requires the real op-amp from Task 6.2.2). Execute Wave 6.2 before Wave 6.4. Waves 6.5 and 6.6 are independent of each other and of 6.1–6.3.

---

## Wave 6.1: Digital-in-Analog Behavioral Extensions

### Task 6.1.1: Behavioral Factories for Remaining Flip-Flops

- **Description**: Add `analogFactory` to JK, RS, and T flip-flops using the same `BehavioralFlipflopElement` pattern from Phase 4a's D flip-flop. Each flip-flop wraps its logic in `updateCompanion()` (edge detection once per accepted timestep, not per NR iteration) and uses `DigitalInputPinModel` / `DigitalOutputPinModel` for electrical interface.
- **Files to modify**:
  - `src/components/flipflops/jk.ts` — add `analogFactory: makeJKFlipflopAnalogFactory()`, `engineType: "both"`, `simulationModes: ['digital', 'behavioral']`
  - `src/components/flipflops/rs.ts` — add `analogFactory: makeRSFlipflopAnalogFactory()`, same
  - `src/components/flipflops/t.ts` — add `analogFactory: makeTFlipflopAnalogFactory()`, same
  - `src/components/flipflops/jk-async.ts`, `src/components/flipflops/rs-async.ts`, `src/components/flipflops/d-async.ts` — add analog factories for async variants (same pattern, with async set/reset inputs)
- **Files to create**:
  - `src/analog/behavioral-flipflop-variants.ts`:
    - `makeJKFlipflopAnalogFactory()`: edge-triggered JK logic — on rising clock: if J=1, K=0 → Q=1; if J=0, K=1 → Q=0; if J=1, K=1 → toggle Q; if J=0, K=0 → hold
    - `makeRSFlipflopAnalogFactory()`: edge-triggered RS — on rising clock: if S=1, R=0 → Q=1; if S=0, R=1 → Q=0; if S=1, R=1 → undefined (hold previous, emit diagnostic)
    - `makeTFlipflopAnalogFactory()`: edge-triggered T — on rising clock: if T=1 → toggle Q; if T=0 → hold
    - Each factory produces a `BehavioralFlipflopElement` subclass with the appropriate logic in `updateCompanion()`
- **Tests**:
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::JK::toggle_when_both_high` — J=1, K=1, rising clock; assert Q toggles
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::JK::set_when_j_high` — J=1, K=0, rising clock; assert Q=1
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::JK::reset_when_k_high` — J=0, K=1, rising clock; assert Q=0
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::RS::set_and_reset` — S=1→Q=1; R=1→Q=0
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::RS::both_high_holds` — S=1, R=1; assert Q holds previous value and diagnostic emitted
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::T::toggles_on_t_high` — T=1, clock edge; assert Q toggles each edge
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::Registration::all_flipflops_have_analog_factory` — assert JK, RS, T, and async variants all have `analogFactory` defined
  - `src/analog/__tests__/behavioral-flipflop-variants.test.ts::RS_FF::both_set_emits_diagnostic` — set S=HIGH, R=HIGH; assert `rs-flipflop-both-set` diagnostic emitted with warning severity
- **Acceptance criteria**:
  - All 6 flip-flop variants have working analog factories
  - Edge detection only in `updateCompanion()` (not per NR iteration)
  - Logic matches digital-mode behavior exactly
  - All existing digital flip-flop tests pass unchanged

---

### Task 6.1.2: Behavioral Factories for Counters and Registers

- **Description**: Add behavioral analog factories to edge-triggered sequential components: counters (up, down, up/down, preset) and registers (parallel load). These use `BehavioralFlipflopElement`-style edge detection with multi-bit output via multiple `DigitalOutputPinModel` instances (one per bit).
- **Files to create**:
  - `src/analog/behavioral-sequential.ts`:
    - `makeBehavioralCounterAnalogFactory()`: N-bit counter with clock, clear, direction inputs. On rising clock edge: increment/decrement count. Each output bit gets its own `DigitalOutputPinModel`. Count stored as internal integer state.
    - `makeBehavioralRegisterAnalogFactory()`: N-bit register with clock and data inputs. On rising clock edge: latch all data inputs to outputs.
- **Files to modify**:
  - `src/components/memory/counter.ts` — add `analogFactory`, `engineType: "both"`
  - `src/components/memory/counter-preset.ts` — same
  - `src/components/memory/register.ts` — same
- **Tests**:
  - `src/analog/__tests__/behavioral-sequential.test.ts::Counter::counts_on_clock_edges` — 4-bit counter; apply 5 clock edges; assert output bits represent binary 5
  - `src/analog/__tests__/behavioral-sequential.test.ts::Counter::clear_resets_to_zero` — count to 3, assert clear; assert output = 0
  - `src/analog/__tests__/behavioral-sequential.test.ts::Counter::output_voltages_match_logic` — assert each output bit is either V_OH or V_OL (not intermediate)
  - `src/analog/__tests__/behavioral-sequential.test.ts::Register::latches_all_bits` — 8-bit register; set data inputs to 0xA5; clock edge; assert outputs match
- **Acceptance criteria**:
  - Multi-bit outputs use individual pin models (one per bit)
  - Count/register state matches digital-mode behavior
  - Outputs produce correct analog voltage levels (V_OH/V_OL)
  - Edge detection only in `updateCompanion()`

---

### Task 6.1.3: Behavioral Factories for Mux, Demux, Decoder

- **Description**: Add behavioral analog factories to combinational multi-bit components: multiplexer, demultiplexer, and decoder. These are combinational (no edge detection) — evaluated in `stampNonlinear()` every NR iteration. Each is a truth-table lookup indexed by selector bits, producing output voltage levels.
- **Files to modify**:
  - `src/components/wiring/mux.ts` — add `analogFactory`, `engineType: "both"`
  - `src/components/wiring/demux.ts` — same
  - `src/components/wiring/decoder.ts` — same
- **Files to create**:
  - `src/analog/behavioral-combinational.ts`:
    - `makeBehavioralMuxAnalogFactory(selectorBits: number)`: reads selector inputs via threshold, selects corresponding data input, drives output via pin model
    - `makeBehavioralDemuxAnalogFactory(selectorBits: number)`: routes single input to one of 2^N outputs based on selector
    - `makeBehavioralDecoderAnalogFactory(selectorBits: number)`: activates one of 2^N outputs based on binary input
- **Tests**:
  - `src/analog/__tests__/behavioral-combinational.test.ts::Mux::selects_correct_input` — 4:1 mux; selector=2; assert output = data input 2's voltage
  - `src/analog/__tests__/behavioral-combinational.test.ts::Demux::routes_to_correct_output` — 1:4 demux; selector=3; assert only output 3 is active
  - `src/analog/__tests__/behavioral-combinational.test.ts::Decoder::one_hot_output` — 2-bit decoder; input=01; assert output 1 = V_OH, all others = V_OL
- **Acceptance criteria**:
  - Selector bits read via threshold detection
  - Correct input/output routing for all selector values
  - Evaluated combinationally (every NR iteration)

---

### Task 6.1.4: Behavioral Factories for Remaining Digital Components

- **Description**: Sweep through all remaining digital components that don't yet have `analogFactory` and add behavioral analog factories where appropriate. Components that are purely digital-only (e.g., text rectangles, test cases) are skipped.
- **Files to modify**:

Components receiving `analogFactory` in this task:

| File | Analog model |
|------|-------------|
| `src/components/wiring/driver.ts` | Buffer: `DigitalOutputPinModel` drives output |
| `src/components/wiring/driver-inv.ts` | Inverting buffer: `DigitalOutputPinModel` with inverted output |
| `src/components/wiring/splitter.ts` | Pass-through: each bit gets independent `DigitalInputPinModel` → `DigitalOutputPinModel` |
| `src/components/wiring/bus-splitter.ts` | Same as splitter |
| `src/components/io/led.ts` | Forward-biased diode model (IS, N from LED parameters) |
| `src/components/io/seven-seg.ts` | 7 parallel LED diode models (skip if file does not exist) |
| `src/components/io/seven-seg-hex.ts` | Same as seven-seg (skip if file does not exist) |
| `src/components/switching/relay.ts` | Coil: inductor (L from property, default 100mH) + DC resistance (default 100Ω). Contact: variable resistance (R_on=0.01Ω, R_off=10MΩ). Threshold: coil current > I_pull (default 20mA) closes contact |
| `src/components/switching/relay-dt.ts` | Same as relay with DPDT contact configuration |
| `src/components/switching/switch.ts` | Variable resistance (R_on=0.01Ω, R_off=10MΩ) |
| `src/components/switching/switch-dt.ts` | DPDT variable resistance |
| `src/components/io/button-led.ts` | Combined: switch (variable resistance) + LED (forward-biased diode) |

If `seven-seg.ts` or `seven-seg-hex.ts` do not exist in `src/components/io/`, skip them — do not create new component files in this task.

Components explicitly excluded (no `analogFactory`):
`tunnel.ts`, `button.ts`, `dip-switch.ts`, `text-rectangle.ts`, `testcase.ts`, `sim-control.ts`, `probe.ts` (already done in Phase 2), `clock.ts` (done in Phase 5 Task 5.2.4).

- **Tests**:
  - `src/analog/__tests__/behavioral-remaining.test.ts::Driver::tri_state_high` — enable=1, input=1; assert output ≈ V_OH
  - `src/analog/__tests__/behavioral-remaining.test.ts::Driver::tri_state_hiz` — enable=0; assert output pin in Hi-Z mode (R_HiZ to ground)
  - `src/analog/__tests__/behavioral-remaining.test.ts::LED::forward_current_lights` — 3.3V through 330Ω to LED; assert forward current ≈ (3.3 - V_f) / 330
  - `src/analog/__tests__/behavioral-remaining.test.ts::SevenSeg::digit_display` — drive segments for digit "7"; assert segments a, b, c at V_OH, others at V_OL
  - `src/analog/__tests__/behavioral-remaining.test.ts::Relay::coil_energizes_contact` — drive coil above threshold; assert contact switches from R_off to R_on
  - `src/analog/__tests__/behavioral-remaining.test.ts::Registration::all_both_components_have_analog_factory` — iterate all components with `engineType: "both"`; assert each has `analogFactory` defined
- **Acceptance criteria**:
  - All 12 components in the table above have `analogFactory` registered and passing a basic DC OP smoke test
  - Tri-state outputs correctly use Hi-Z pin model
  - LED analog model matches Phase 2's diode (forward voltage drop)
  - Relay coil modeled as inductor, contact as variable resistance
  - No regression to any digital-mode behavior

---

## Wave 6.2: Specialty Analog Components

### Task 6.2.1: 555 Timer IC

- **Description**: Implement the 555 timer as a behavioral analog component. The 555 contains: two comparators (threshold at 2/3 VCC, trigger at 1/3 VCC), an SR flip-flop, a discharge transistor, and an output stage. Rather than expanding to transistor-level internals, this uses a behavioral model that captures the IC's external behavior with correct threshold voltages and output drive. The 555 is the single most-used analog IC in education.
- **Files to create**:
  - `src/components/active/timer-555.ts`:
    - `class Timer555Element implements AnalogElement`:
      - Pins: VCC, GND, TRIGGER, THRESHOLD, CONTROL, RESET, DISCHARGE, OUTPUT (8 pins)
      - Internal state: `_flipflopQ: boolean` — SR flip-flop output
      - Comparator 1: V_THRESHOLD > V_CONTROL (default 2/3 VCC) → reset flip-flop
      - Comparator 2: V_TRIGGER < 1/2 V_CONTROL (default 1/3 VCC) → set flip-flop
      - When Q=0 (reset): OUTPUT = V_OL, DISCHARGE transistor ON (R_sat to GND)
      - When Q=1 (set): OUTPUT = V_OH (VCC - V_drop), DISCHARGE transistor OFF (Hi-Z)
      - RESET pin: active low, overrides flip-flop
      - CONTROL pin: externally adjustable threshold (default 2/3 VCC via internal voltage divider)
      - Output stage: `DigitalOutputPinModel` with R_out ≈ 10Ω (555 has strong output drive)
      - `stampNonlinear()`: evaluate comparators, update flip-flop state, set output and discharge pin levels
      - Internal voltage divider: 3 × 5kΩ resistors from VCC to GND, setting 1/3 and 2/3 reference voltages. The CONTROL pin connects to the 2/3 node, allowing external override.
      - `isNonlinear: true`
      - The 555 timer implements `updateState(dt, voltages)` for internal state tracking (comparator latch state, timing). It does NOT implement `stampCompanion()` — pin capacitances are not modeled in this phase.
    - Properties: `vDrop` (V, output drop from VCC, default 1.5V for bipolar 555, 0.1V for CMOS 555), `rDischarge` (Ω, discharge transistor saturation resistance, default 10), `variant` ('bipolar' | 'cmos', default 'bipolar')
- **Tests**:
  - `src/components/active/__tests__/timer-555.test.ts::Astable::oscillates_at_correct_frequency` — standard astable circuit (R1=1kΩ, R2=10kΩ, C=10µF); f ≈ 1.44/((R1+2R2)·C) = 6.55Hz; run transient for 5 periods; assert frequency within 10%
  - `src/components/active/__tests__/timer-555.test.ts::Astable::duty_cycle` — same circuit; assert duty cycle ≈ (R1+R2)/(R1+2R2) = 11/21 ≈ 52%
  - `src/components/active/__tests__/timer-555.test.ts::Monostable::pulse_width` — trigger pulse; R=100kΩ, C=1µF; assert output pulse width ≈ 1.1·R·C = 110ms ± 10%
  - `src/components/active/__tests__/timer-555.test.ts::Monostable::retrigger_ignored_during_pulse` — trigger again during output pulse; assert no extension (standard 555 is non-retriggerable)
  - `src/components/active/__tests__/timer-555.test.ts::Reset::forces_output_low` — assert RESET pin low forces output low regardless of other inputs
  - `src/components/active/__tests__/timer-555.test.ts::Control::external_voltage_changes_thresholds` — apply 2V to CONTROL pin (overriding 2/3 VCC); assert thresholds shift accordingly
  - `src/components/active/__tests__/timer-555.test.ts::Discharge::saturates_when_output_low` — when output low, assert DISCHARGE pin ≈ GND (R_sat to ground)
  - `src/components/active/__tests__/timer-555.test.ts::Timer555::internal_divider_voltages` — CONTROL pin floating (unconnected). Assert threshold voltage ≈ 2/3 × VCC ± 1% and trigger voltage ≈ 1/3 × VCC ± 1%
- **Acceptance criteria**:
  - Astable oscillation frequency matches 555 formula within 10% (the 10% tolerance accounts for timestep quantization in the transient simulation — the 555's comparator transitions are not aligned to timestep boundaries; tighter tolerance of 1% is achievable with smaller max timestep)
  - Monostable pulse width matches 1.1·R·C formula within 10%
  - RESET overrides all other inputs
  - CONTROL pin adjusts internal thresholds
  - Discharge transistor correctly sinks current when output is low
  - Both bipolar and CMOS variants modeled (different V_drop)

---

### Task 6.2.2: Real Op-Amp (Composite Model)

- **Description**: Implement a realistic op-amp model that goes beyond Phase 2's ideal op-amp. The real op-amp includes: finite open-loop gain (A_OL), finite bandwidth (GBW product), input offset voltage, input bias current, output current limiting, slew rate, and rail-to-rail output saturation. Modeled as a VCVS with a single-pole frequency response (first-order rolloff).
- **Files to create**:
  - `src/components/active/real-opamp.ts`:
    - `class RealOpAmpElement implements AnalogElement`:
      - Input stage: differential input with bias current (two current sources, I_bias each, into inverting and non-inverting inputs) + input resistance R_in (typ. 2MΩ for bipolar, 1TΩ for FET-input)
      - Gain stage: VCVS with gain A_OL, single-pole rolloff at f_p = GBW/A_OL. Implemented as a companion-model integrator: V_internal follows V_diff · A_OL with time constant τ = 1/(2π·f_p). This naturally produces the correct frequency response and slew rate.
      - Slew rate: clamp dV_internal/dt to ±SR (V/µs). When slew-limiting, the integrator's current is clamped.
      - Output stage: voltage follower from V_internal with output resistance R_out (typ. 75Ω) and current limiting (|I_out| < I_max, typ. 25mA). Output clamps to V_supply± - V_sat (rail saturation).
      - Input offset: V_os added to differential input
      - `stampNonlinear()`: stamps input bias currents, evaluates gain stage with slew limiting, stamps output
      - `updateCompanion()`: integrates gain stage (single-pole model is a capacitor companion)
      - `isNonlinear: true` (slew limiting, output clamp)
      - `isReactive: true` (gain stage integrator)
    - Properties: `aol` (open-loop gain, default 100000 = 100dB), `gbw` (Hz, default 1e6), `slewRate` (V/µs, default 0.5), `vos` (input offset, V, default 1e-3), `iBias` (input bias current, A, default 80e-9), `rIn` (input resistance, Ω, default 2e6), `rOut` (output resistance, Ω, default 75), `iMax` (output current limit, A, default 25e-3), `vSatPos` (positive rail saturation drop, V, default 1.5), `vSatNeg` (negative rail saturation drop, V, default 1.5)
    - `.MODEL` support for standard op-amps (741, LM358, TL072, OPA2134)
- **Tests**:
  - `src/components/active/__tests__/real-opamp.test.ts::DCGain::inverting_amplifier_gain` — R1=1kΩ, R2=10kΩ; assert gain ≈ -10 (within 0.1% due to finite A_OL)
  - `src/components/active/__tests__/real-opamp.test.ts::DCGain::output_saturates_at_rails` — gain=100, V_in=0.5V → V_out would be 50V but clamps to V_supply - V_sat
  - `src/components/active/__tests__/real-opamp.test.ts::Bandwidth::unity_gain_frequency` — measure -3dB point of unity-gain buffer; assert ≈ GBW
  - `src/components/active/__tests__/real-opamp.test.ts::Bandwidth::gain_bandwidth_product` — gain=10 amplifier; assert -3dB at ≈ GBW/10
  - `src/components/active/__tests__/real-opamp.test.ts::SlewRate::large_signal_step` — step input of 5V on unity-gain buffer; assert output ramp rate ≈ SR V/µs
  - `src/components/active/__tests__/real-opamp.test.ts::SlewRate::small_signal_not_slew_limited` — 10mV step; assert rise time determined by bandwidth, not slew rate
  - `src/components/active/__tests__/real-opamp.test.ts::Offset::output_offset_with_gain` — V_in=0, gain=1000; assert V_out ≈ V_os × 1000
  - `src/components/active/__tests__/real-opamp.test.ts::CurrentLimit::output_current_clamped` — 1kΩ load at V_supply; assert I_out ≤ I_max
  - `src/components/active/__tests__/real-opamp.test.ts::RealOpAmp::load_741_model` — load `.MODEL 741 OPA(A=200000, GBW=1e6, SR=0.5e6, Vos=1e-3)`. Assert open-loop gain = 200000 and GBW = 1MHz in AC sweep
- **Acceptance criteria**:
  - Inverting/non-inverting amplifier gains match ideal within A_OL tolerance
  - Bandwidth rolls off at 20dB/decade with correct GBW product
  - Slew rate limits large-signal rise time
  - Output saturates at supply rails minus V_sat
  - Input offset produces measurable output error with gain
  - Output current limiting protects against short circuits

---

### Task 6.2.3: OTA (Operational Transconductance Amplifier)

- **Description**: Implement an OTA — a voltage-in, current-out amplifier whose transconductance (gm) is controlled by a bias current. The OTA is the building block of many analog filter designs (e.g., state-variable filters, VCAs). Output is a current source proportional to differential input voltage: I_out = gm · (V+ - V-), where gm is proportional to I_bias.
- **Files to create**:
  - `src/components/active/ota.ts`:
    - `class OTAElement implements AnalogElement`:
      - I_out = gm · V_diff, where gm = min(I_bias / (2 × V_T), gmMax) for bipolar OTA (V_T = 26mV). `gmMax` (default 0.01 S) is a hard saturation clamp that models the physical gm limitation at high bias currents. When `I_bias` is low, gm follows the formula; at high `I_bias`, gm saturates at `gmMax`.
      - Input linearization: for large V_diff, I_out = I_bias · tanh(V_diff / (2·V_T)) — limits output to ±I_bias
      - `stampNonlinear()`: stamp current source at output based on V_diff
      - Pins: V+, V-, Iabc (bias current input), OUT+, OUT-
      - `isNonlinear: true`, `isReactive: false`
    - Properties: `gmMax` (S, maximum transconductance, default 0.01), `vt` (thermal voltage, V, default 0.026)
- **Tests**:
  - `src/components/active/__tests__/ota.test.ts::OTA::linear_region` — small V_diff (1mV); assert I_out ≈ gm · 1mV
  - `src/components/active/__tests__/ota.test.ts::OTA::tanh_limiting` — large V_diff (1V); assert I_out ≈ ±I_bias (saturated)
  - `src/components/active/__tests__/ota.test.ts::OTA::gm_proportional_to_ibias` — double I_bias; assert gm doubles
  - `src/components/active/__tests__/ota.test.ts::OTA::vca_circuit` — OTA as voltage-controlled amplifier; vary I_bias via control voltage; assert gain changes
- **Acceptance criteria**:
  - Linear for small signals: I_out = gm · V_diff
  - Saturates at ±I_bias for large signals
  - gm controllable via bias current input
  - Works in filter and VCA configurations

---

### Task 6.2.4: Comparator

- **Description**: Implement an analog comparator — similar to an op-amp but optimized for switching speed with open-collector/open-drain output and no linear region. Output is either V_OH (pulled up externally) or V_OL (saturated low) depending on whether V+ > V- or not. Features fast response (no slew rate compensation), optional hysteresis, and rail-to-rail input range.
- **Files to create**:
  - `src/components/active/comparator.ts`:
    - `class ComparatorElement implements AnalogElement`:
      - Output logic: if V+ > V- + V_hyst/2 → output LOW (open collector sinks); if V+ < V- - V_hyst/2 → output HIGH (open collector off = pulled up by external R)
      - For non-inverting output type: invert the sense
      - Open-collector output: stamps R_sat to ground when active, R_off when inactive
      - `stampNonlinear()`: evaluate comparison with hysteresis, stamp output
      - `isNonlinear: true`, `isReactive: false`
    - Properties: `hysteresis` (V, default 0 — no built-in hysteresis), `vos` (offset, V, default 0.001), `rSat` (Ω, default 50), `outputType` ('open-collector' | 'push-pull', default 'open-collector'), `responseTime` (s, default 1e-6 — propagation delay modeled as single-pole filter on output)
- **Tests**:
  - `src/components/active/__tests__/comparator.test.ts::Comparator::output_high_when_vp_greater` — V+ = 2V, V- = 1V; assert output sinks current (open collector active)
  - `src/components/active/__tests__/comparator.test.ts::Comparator::output_low_when_vm_greater` — V+ = 1V, V- = 2V; assert output high-impedance (pulled up)
  - `src/components/active/__tests__/comparator.test.ts::Comparator::hysteresis_prevents_chatter` — 10mV hysteresis; input oscillates ±5mV around threshold; assert output does not toggle
  - `src/components/active/__tests__/comparator.test.ts::Comparator::zero_crossing_detector` — V- = 0V; sweep V+ through 0; assert output transitions cleanly
  - `src/components/active/__tests__/comparator.test.ts::Comparator::response_time` — step input; assert output transition completes within specified response time
- **Acceptance criteria**:
  - Output switches cleanly based on input comparison
  - Open-collector output requires external pull-up for high state
  - Hysteresis prevents output chatter on noisy inputs
  - Response time models propagation delay

---

### Task 6.2.5: Optocoupler

- **Description**: Implement an optocoupler (opto-isolator) as a compound component: an LED on the input side and a phototransistor on the output side, with galvanic isolation (no electrical connection between input and output). The current transfer ratio (CTR) relates output collector current to input LED current: I_C = CTR · I_LED.
- **Files to create**:
  - `src/components/active/optocoupler.ts`:
    - `class OptocouplerElement implements AnalogElement`:
      - Input side: LED model (forward voltage + series resistance) — uses Phase 2's diode
      - Output side: phototransistor modeled as a current-controlled current source (CCCS). The control current is the LED current (sensed internally, no physical current-sense branch needed since the LED is internal). Output I_C = CTR · I_LED.
      - Galvanic isolation: input and output sides share NO common node. The coupling is purely via the CTR transfer function.
      - `stampNonlinear()`: evaluate LED current from input voltage, compute phototransistor current = CTR · I_LED, stamp as current source on output side
      - 4 pins: anode, cathode (input LED), collector, emitter (output phototransistor)
      - `isNonlinear: true` (LED is nonlinear), `isReactive: false`
    - Properties: `ctr` (current transfer ratio, default 1.0 = 100%), `vForward` (LED forward voltage, V, default 1.2), `rLed` (LED series R, Ω, default 10), `vce_sat` (phototransistor saturation voltage, V, default 0.3), `bandwidth` (Hz, default 50000)
- **Tests**:
  - `src/components/active/__tests__/optocoupler.test.ts::Optocoupler::current_transfer` — 10mA LED current, CTR=1.0; assert I_C ≈ 10mA
  - `src/components/active/__tests__/optocoupler.test.ts::Optocoupler::galvanic_isolation` — I_LED = 10mA (forward current), CTR = 1.0 (default); assert I_collector ≈ 10mA ± 10% regardless of output-side ground potential (tested at 0V and 100V offset)
  - `src/components/active/__tests__/optocoupler.test.ts::Optocoupler::led_forward_voltage` — assert input requires > V_forward to conduct
  - `src/components/active/__tests__/optocoupler.test.ts::Optocoupler::zero_input_zero_output` — no LED current; assert I_C ≈ 0
  - `src/components/active/__tests__/optocoupler.test.ts::Optocoupler::ctr_scaling` — CTR=0.5; 20mA LED; assert I_C ≈ 10mA
- **Acceptance criteria**:
  - Current transfer ratio correctly relates output to input current
  - Galvanic isolation: no shared nodes between input and output
  - LED forward voltage characteristic on input
  - Zero input current produces zero output current

---

## Wave 6.3: ADC + DAC Converters

### Task 6.3.1: DAC (Digital-to-Analog Converter)

- **Description**: Implement an N-bit DAC that converts a digital input code to an analog output voltage. The digital inputs use `DigitalInputPinModel` (threshold detection) to read logic levels. The analog output is a voltage source whose value is V_ref · (digital_code / 2^N). Supports both unipolar (0 to V_ref) and bipolar (-V_ref to +V_ref) modes.
- **Files to create**:
  - `src/components/active/dac.ts`:
    - `class DACElement implements AnalogElement`:
      - N digital input pins (DigitalInputPinModel) + V_ref input + analog output (voltage source)
      - `stampNonlinear()`: read all input pins via threshold → N-bit code; compute output voltage = V_ref · code / 2^N; stamp voltage source at output
      - Output drive: R_out (typ. 1kΩ for current output DAC, or buffered with op-amp model)
      - `isNonlinear: true` (threshold detection), `isReactive: true` (pin capacitances)
    - Properties: `bits` (N, default 8), `vRef` (V, default 5.0), `mode` ('unipolar' | 'bipolar', default 'unipolar'), `rOut` (Ω, default 100), `settlingTime` (s, default 1e-6)
    - Pins: D0..D(N-1) (digital inputs), VREF, OUT, GND
- **Tests**:
  - `src/components/active/__tests__/dac.test.ts::DAC::full_scale` — all inputs HIGH; assert V_out ≈ V_ref · (2^N - 1) / 2^N
  - `src/components/active/__tests__/dac.test.ts::DAC::zero_code` — all inputs LOW; assert V_out ≈ 0V
  - `src/components/active/__tests__/dac.test.ts::DAC::midscale` — MSB=1, rest=0; assert V_out ≈ V_ref / 2
  - `src/components/active/__tests__/dac.test.ts::DAC::monotonic_ramp` — increment code from 0 to 255; assert V_out increases monotonically
  - `src/components/active/__tests__/dac.test.ts::DAC::lsb_step_size` — assert voltage change per LSB ≈ V_ref / 2^N
- **Acceptance criteria**:
  - Output voltage linearly proportional to digital input code
  - Full-scale output approaches V_ref
  - Monotonic (every code step increases or decreases voltage)
  - LSB step size matches V_ref / 2^N

---

### Task 6.3.2: ADC (Analog-to-Digital Converter)

- **Description**: Implement an N-bit ADC that converts an analog input voltage to a digital output code. Uses successive approximation (SAR) behavioral model: on each clock edge, the ADC samples the input and produces an N-bit output code after a conversion delay. The digital outputs use `DigitalOutputPinModel` to drive logic levels.
- **Files to create**:
  - `src/components/active/adc.ts`:
    - `class ADCElement implements AnalogElement`:
      - Analog input pin: uses `DigitalInputPinModel` for realistic input loading (R_in, C_in from logic family), but the ADC reads the raw analog node voltage (not the thresholded logic level) for SAR conversion. The `DigitalInputPinModel` provides loading effects only; the ADC element accesses the node voltage directly via `voltages[vinNodeId]` in its `stamp()` method. Clock input + N digital output pins.
      - `updateCompanion()`: on rising clock edge: sample V_in, compute code = floor(V_in / V_ref × 2^N), clamp to [0, 2^N-1], update output pins
      - Output pins set after conversion delay (modeled as N clock cycles for SAR, or instant for flash-type behavioral model)
      - `isNonlinear: true`, `isReactive: true`
    - Properties: `bits` (N, default 8), `vRef` (V, default 5.0), `mode` ('unipolar' | 'bipolar', default 'unipolar'), `conversionType` ('instant' | 'sar', default 'instant')
    - Pins: VIN, CLK, D0..D(N-1), VREF, GND, EOC (end of conversion)
- **Tests**:
  - `src/components/active/__tests__/adc.test.ts::ADC::midscale_input` — V_in = V_ref/2; clock edge; assert output code = 128 (for 8-bit)
  - `src/components/active/__tests__/adc.test.ts::ADC::full_scale` — V_in = V_ref - 1 LSB; assert code = 255
  - `src/components/active/__tests__/adc.test.ts::ADC::zero_input` — V_in = 0; assert code = 0
  - `src/components/active/__tests__/adc.test.ts::ADC::ramp_test` — sweep V_in from 0 to V_ref; assert output codes increase monotonically
  - `src/components/active/__tests__/adc.test.ts::ADC::eoc_pulses_after_conversion` — assert EOC pin goes high after conversion completes
- **Note**: Task 6.4.1 implements `MNAEngine.acAnalysis(params: AcParams): AcResult` as the public method on the `AnalogEngine` interface, replacing the Phase 1 stub. The method delegates to the `AcAnalysis` class internally.
- **Acceptance criteria**:
  - Output code linearly proportional to input voltage
  - Correct quantization (floor to nearest code)
  - Monotonic conversion
  - EOC signal indicates conversion complete
  - Samples only on clock edge (not continuously)

---

## Wave 6.4: AC Small-Signal Analysis

### Task 6.4.1: AC Analysis Engine

- **Description**: Implement AC small-signal analysis. Given a DC operating point (from `dcOperatingPoint()`), linearize all nonlinear elements at their operating points, then sweep frequency to compute the complex transfer function. The result is magnitude and phase vs frequency for specified output nodes relative to a specified AC source. This is the standard SPICE `.AC` analysis.
- **Files to create**:
  - `src/analog/ac-analysis.ts`:
    - `class AcAnalysis`:
      - `constructor(engine: MNAEngine, compiled: CompiledAnalogCircuit)`
      - `run(params: AcParams): AcResult`:
        1. Solve DC operating point (if not already solved)
        2. AC analysis uses the `stampAc(solver, omega)` method on `AnalogElement` (defined in Phase 1). After DC operating point converges:
           1. Build a `ComplexSparseSolver` of the same size as the real solver.
           2. For each frequency point ω = 2πf: clear the complex matrix, call `element.stampAc(complexSolver, omega)` on every element.
              - Resistors stamp real conductance (same as DC).
              - Capacitors stamp `jωC` as imaginary admittance.
              - Inductors stamp `1/(jωL)` admittance.
              - Nonlinear elements (diodes, BJTs, MOSFETs, op-amps) stamp their small-signal conductances (gm, gds, gπ) as real values — these are the Jacobian entries from the last NR iteration, which elements store internally after DC OP convergence.
           3. Inject AC source: stamp `1+0j` at the source node.
           4. Solve the complex system for node voltages at each frequency.
    - `AcParams` interface:
      - `type: 'lin' | 'dec' | 'oct'` — frequency sweep type (linear, decades, octaves)
      - `numPoints: number` — points per sweep unit
      - `fStart: number` — start frequency (Hz)
      - `fStop: number` — stop frequency (Hz)
      - `sourceLabel: string` — label of the AC voltage source (provides the excitation)
      - `outputNodes: string[]` — labels of nodes to measure
    - `AcResult` interface:
      - `frequencies: Float64Array` — frequency points
      - `magnitude: Map<string, Float64Array>` — |H(f)| per output node in dB
      - `phase: Map<string, Float64Array>` — ∠H(f) per output node in degrees
      - `real: Map<string, Float64Array>` — Re{H(f)} per output node
      - `imag: Map<string, Float64Array>` — Im{H(f)} per output node
  - `src/analog/complex-sparse-solver.ts`:
    - `class ComplexSparseSolver`:
      - Same API as `SparseSolver` but operates on complex values
      - `stamp(row, col, real, imag)` — add complex value to matrix
      - `solve(xRe, xIm)` — solve complex system
      - Implementation: native `ComplexSparseSolver` with complex LU factorization. Uses the same COO→CSC→AMD→symbolic→numeric pipeline as the real `SparseSolver` (Phase 1), but with complex arithmetic. Matrix size is N×N (not 2N×2N). File: `src/analog/complex-sparse-solver.ts`. Reuses the AMD ordering and symbolic factorization from the real solver's sparsity pattern — only the numeric phase differs.
- **Tests**:
  - `src/analog/__tests__/ac-analysis.test.ts::AC::rc_lowpass_rolloff` — R=1kΩ, C=1µF; sweep 1Hz to 100kHz; assert -3dB point at f_c = 1/(2π·RC) ≈ 159Hz ± 5%
  - `src/analog/__tests__/ac-analysis.test.ts::AC::rc_lowpass_slope` — above f_c, assert magnitude rolls off at -20dB/decade ± 2dB
  - `src/analog/__tests__/ac-analysis.test.ts::AC::rc_lowpass_phase` — at f_c, assert phase ≈ -45° ± 5°
  - `src/analog/__tests__/ac-analysis.test.ts::AC::rlc_bandpass_resonance` — series RLC; assert peak gain at f_0 = 1/(2π·√(LC))
  - `src/analog/__tests__/ac-analysis.test.ts::AC::opamp_gain_bandwidth` — inverting amplifier with real op-amp (requires Task 6.2.2); assert gain-bandwidth product matches op-amp GBW spec
  - `src/analog/__tests__/ac-analysis.test.ts::AC::no_source_emits_diagnostic` — run AC analysis on circuit with no AC source. Assert `ac-no-source` diagnostic with error severity
  - `src/analog/__tests__/ac-analysis.test.ts::AC::decade_sweep_points` — type='dec', numPoints=10, 1Hz to 1MHz; assert 60 frequency points (6 decades × 10)
  - `src/analog/__tests__/ac-analysis.test.ts::AC::linear_sweep_points` — type='lin', numPoints=100, 0 to 1kHz; assert 100 equally-spaced points
- **Acceptance criteria**:
  - RC lowpass -3dB point matches 1/(2πRC) within 5%
  - Magnitude slope matches theoretical -20dB/decade (first order) or -40dB/decade (second order)
  - Phase response correct at critical frequencies
  - Decade and linear sweep modes produce correct frequency spacing
  - Complex matrix solve produces correct transfer function

---

### Task 6.4.2: Bode Plot Renderer

- **Description**: Implement a Bode plot renderer that displays AC analysis results as magnitude and phase plots. Integrates with the analog scope panel (Phase 3) as an alternative view mode, or as a standalone plot panel.
- **Files to create**:
  - `src/runtime/bode-plot.ts`:
    - `class BodePlotRenderer`:
      - `render(ctx: CanvasRenderingContext2D, result: AcResult, viewport: BodeViewport)`:
        - Top plot: magnitude in dB vs log frequency
        - Bottom plot: phase in degrees vs log frequency (same frequency axis)
        - Grid lines at standard dB intervals (0, -3, -20, -40, -60) and phase angles (0°, -45°, -90°, -180°, -270°)
        - Multiple traces (one per output node) with different colors
        - Frequency axis: log scale with labels (1Hz, 10Hz, 100Hz, ..., 1MHz, etc.)
      - `BodeViewport`: `{ x, y, width, height, fMin, fMax, magMin, magMax, phaseMin, phaseMax }`
      - Cursor support: vertical line at selected frequency shows exact dB and phase values
      - Markers: automatic detection and labeling of -3dB point, unity gain crossing, phase margin
- **Tests**:
  - `src/runtime/__tests__/bode-plot.test.ts::Bode::renders_magnitude_trace` — provide AcResult with known data; call render with a mock canvas wrapper that records `moveTo`/`lineTo`/`stroke` calls; assert the mock received `lineTo` calls for magnitude trace data points (one per frequency point). The `BodePlotRenderer` uses native `CanvasRenderingContext2D` methods (`moveTo`, `lineTo`, `beginPath`, `stroke`), not custom abstractions.
  - `src/runtime/__tests__/bode-plot.test.ts::Bode::frequency_axis_log_scale` — assert grid lines at decade intervals (1, 10, 100, 1k, 10k, ...)
  - `src/runtime/__tests__/bode-plot.test.ts::Bode::phase_axis_degrees` — assert grid lines at 0°, -90°, -180°, -270°
  - `src/runtime/__tests__/bode-plot.test.ts::Bode::auto_detect_3db_point` — lowpass filter result; assert -3dB marker placed at correct frequency
- **Acceptance criteria**:
  - Magnitude and phase plots rendered on shared frequency axis
  - Log frequency scale with correct decade labels
  - Multiple output traces with distinct colors
  - Automatic -3dB point detection

---

## Wave 6.5: CTZ URL Import

### Task 6.5.1: CTZ URL Parser

- **Description**: Implement a parser for CircuitJS's compressed URL format (CTZ). CircuitJS encodes circuits as URL fragments containing compressed text. The format encodes component types, positions, properties, and connections in a compact line-based text format. Parsing this provides read-only import of CircuitJS circuits into digiTS.
- **Files to create**:
  - `src/io/ctz-parser.ts`:
    - `parseCtzUrl(url: string): Circuit`:
      1. Extract the fragment from the URL (after `#`)
      2. Base64-decode the fragment
      3. Decompress using the browser-native `DecompressionStream` API:
         ```typescript
         const ds = new DecompressionStream('deflate');
         const reader = new Blob([compressed]).stream().pipeThrough(ds).getReader();
         // collect chunks into Uint8Array
         ```
         No runtime dependency required. For the test environment (Node.js/Jest), use a `node:zlib`-based polyfill in `src/test-utils/decompress-polyfill.ts`:
         ```typescript
         import { inflateSync } from 'node:zlib';
         globalThis.DecompressionStream ??= /* polyfill class using inflateSync */;
         ```
      4. Parse the text format: each line is a component with type code, coordinates, and properties
      5. Map CircuitJS component type codes to digiTS component types
      6. Create `Circuit` with `Element` instances, compute wire connectivity
    - `CTZ_TYPE_MAP: Record<string, string>` — maps CircuitJS type codes (e.g., `'r'` for resistor, `'c'` for capacitor, `'l'` for inductor, `'d'` for diode, `'t'` for transistor) to digiTS registry type names
    - Type mapping coverage: all Tier 1 and Tier 2 components that have CircuitJS equivalents (~40 types)
    - For unsupported types: emit diagnostic and substitute a placeholder component
  - `src/io/ctz-format.ts`:
    - `CtzComponent` interface: `{ type: string, x1, y1, x2, y2, flags: number, properties: Record<string, string> }`
    - `parseCtzText(text: string): CtzComponent[]` — parses the decompressed text into structured component records
    - `mapCtzToCircuit(components: CtzComponent[], registry: ComponentRegistry): Circuit` — converts CTZ components to digiTS circuit elements with wire inference
- **Files to modify**:
  - `src/io/load.ts` — add CTZ URL detection (check for CircuitJS URL patterns) and route to `parseCtzUrl()`
  - `src/app/app-init.ts` — add "Import from CircuitJS URL" menu item. Import CTZ files via file picker (`.ctz` extension added to the file input accept list). No URL pasting.
- **Tests**:
  - `src/io/__tests__/ctz-parser.test.ts::CTZ::parses_simple_rc_circuit` — encode a known RC circuit in CTZ format; parse; assert circuit has 1 resistor, 1 capacitor, 1 voltage source, 1 ground, correctly connected
  - `src/io/__tests__/ctz-parser.test.ts::CTZ::maps_component_types` — assert 'r' maps to 'Resistor', 'c' to 'Capacitor', 'l' to 'Inductor', 'd' to 'Diode'
  - `src/io/__tests__/ctz-parser.test.ts::CTZ::handles_unknown_type` — include an unrecognized type code; assert diagnostic code is `unsupported-ctz-component` with info severity, and the component label is included in the diagnostic message; assert placeholder created
  - `src/io/__tests__/ctz-parser.test.ts::CTZ::decompresses_url` — real CTZ URL fragment; assert decompresses to valid text
  - `src/io/__tests__/ctz-parser.test.ts::CTZ::preserves_component_values` — resistor with value 4.7kΩ in CTZ; assert parsed resistance = 4700
- **Acceptance criteria**:
  - CTZ files can be imported via file picker (`.ctz` extension)
  - Component type mapping covers all Tier 1 and Tier 2 components
  - Unknown components produce diagnostic rather than crash
  - Wire connectivity correctly inferred from coordinate-based CTZ format
  - Component property values preserved (resistance, capacitance, etc.)

---

## Wave 6.6: Monte Carlo / Parameter Sweep

### Task 6.6.1: Parameter Variation Engine

- **Description**: Implement a batch simulation interface for Monte Carlo analysis and parameter sweeps. The engine runs multiple simulations with varied component parameters and collects statistics on output quantities. This is the foundation for tolerance analysis ("how does this circuit perform with 5% resistors?").
- **Files to create**:
  - `src/analog/monte-carlo.ts`:
    - `class MonteCarloRunner`:
      - `configure(config: MonteCarloConfig): void`
      - `run(): AsyncGenerator<TrialResult, MonteCarloResult>` — yields a `TrialResult` after each trial, allowing the caller to:
        - Update a progress bar (trial N of M)
        - Check for cancellation (`runner.cancel()`)
        - Accumulate results incrementally
        The final return value is the complete `MonteCarloResult` with statistics.

        Usage:
        ```typescript
        const runner = new MonteCarloRunner(config);
        for await (const trial of runner.run()) {
          updateProgress(trial.index, config.trials);
        }
        // runner.result contains final statistics
        ```
      - For each trial:
        1. Clone via serialize→deserialize round-trip: `deserialize(serialize(circuit))`. This produces a deep copy with independent component instances.
        2. Apply parameter variations (Gaussian or uniform distribution around nominal)
        3. Compile and run the analysis (DC OP, transient, or AC)
        4. Record specified output quantities
        5. Yield `TrialResult` with trial index and output values
      - After all trials: compute statistics (mean, std dev, min, max, histogram)
    - `MonteCarloConfig`:
      - `trials: number` (default 100)
      - `variations: ParameterVariation[]` — list of component parameters to vary
      - `analysis: 'dc' | 'transient' | 'ac'` — which analysis to run
      - `outputs: OutputSpec[]` — what to measure (node voltage, element current, etc.)
      - `analysisParams?: AcParams | TransientParams` — analysis-specific parameters. Type definition: `interface TransientParams { tStart: number; tStop: number; maxDt?: number; }` — defines the time span and optional max timestep for transient analysis. Defined in `src/analog/mna-engine.ts` alongside the engine.
    - `OutputSpec` type definition: `interface OutputSpec { type: 'voltage' | 'current'; node?: string; element?: string; label: string; }` — specifies what to measure. For `type: 'voltage'`: measure node voltage by `node` label. For `type: 'current'`: measure element current by `element` label.
    - `ParameterVariation`:
      - `componentLabel: string` — which component
      - `property: string` — which property (e.g., 'resistance')
      - `distribution: 'gaussian' | 'uniform'` — variation type
      - `tolerance: number` — ±percentage (e.g., 0.05 for 5%)
    - `MonteCarloResult`:
      - `trials: number`
      - `outputs: Map<string, OutputStatistics>`
      - `rawData: Map<string, Float64Array>` — per-trial values for each output
    - `OutputStatistics`: `{ mean, stdDev, min, max, percentile5, percentile95, histogram: HistogramBin[] }`
  - `src/analog/parameter-sweep.ts`:
    - `class ParameterSweepRunner`:
      - `configure(config: SweepConfig): void`
      - `run(): SweepResult` — runs simulation at each parameter value
    - `SweepConfig`:
      - `componentLabel: string`
      - `property: string`
      - `start: number`, `stop: number`, `steps: number`
      - `scale: 'linear' | 'log'`
      - `analysis: 'dc' | 'transient' | 'ac'`
      - `outputs: OutputSpec[]`
    - `SweepResult`:
      - `parameterValues: Float64Array`
      - `outputs: Map<string, Float64Array>` — output value at each parameter step
- **Tests**:
  - `src/analog/__tests__/monte-carlo.test.ts::MonteCarlo::gaussian_distribution` — 1kΩ resistor with 5% tolerance, 1000 trials; assert resistance values are normally distributed (mean ≈ 1000, std ≈ 50)
  - `src/analog/__tests__/monte-carlo.test.ts::MonteCarlo::output_statistics` — voltage divider with 5% resistors; 100 trials; assert output voltage mean ≈ nominal, std dev > 0
  - `src/analog/__tests__/monte-carlo.test.ts::MonteCarlo::reproducible_with_seed` — run twice with same seed; assert identical results
  - `src/analog/__tests__/monte-carlo.test.ts::Sweep::linear_sweep` — sweep R from 1kΩ to 10kΩ in 10 steps; assert 10 output values, monotonically changing
  - `src/analog/__tests__/monte-carlo.test.ts::Sweep::log_sweep` — sweep C from 1pF to 1µF; assert logarithmically spaced values
  - `src/analog/__tests__/monte-carlo.test.ts::Sweep::ac_sweep_at_each_value` — sweep R in RC filter; run AC analysis at each R; assert -3dB point shifts
- **Acceptance criteria**:
  - Monte Carlo runs N independent trials with randomized parameters
  - Gaussian and uniform distributions produce correct parameter spreads
  - Statistics (mean, std dev, percentiles) computed correctly
  - Parameter sweep steps through values linearly or logarithmically
  - Both DC and AC analyses supported as inner analysis
  - Reproducible results with seeded RNG

---

## Diagnostic Codes Added

| Code | Severity | Meaning |
|------|----------|---------|
| `rs-flipflop-both-set` | warning | RS flip-flop S and R inputs both active simultaneously |
| `unsupported-ctz-component` | info | CircuitJS component type has no digiTS equivalent |
| `ac-no-source` | error | AC analysis specified but no AC source found in circuit |
| `ac-linearization-failed` | error | Could not linearize nonlinear element at DC operating point |
| `monte-carlo-trial-failed` | warning | Individual Monte Carlo trial failed to converge |

## Key Files Summary

| File | Purpose |
|------|---------|
| `src/analog/behavioral-flipflop-variants.ts` | JK, RS, T flip-flop behavioral analog factories |
| `src/analog/behavioral-sequential.ts` | Counter, register, shift register behavioral factories |
| `src/analog/behavioral-combinational.ts` | Mux, demux, decoder behavioral factories |
| `src/components/active/timer-555.ts` | 555 timer IC behavioral model |
| `src/components/active/real-opamp.ts` | Real op-amp with finite GBW, slew rate, offsets |
| `src/components/active/ota.ts` | Operational transconductance amplifier |
| `src/components/active/comparator.ts` | Analog comparator with hysteresis |
| `src/components/active/optocoupler.ts` | Optocoupler (LED + phototransistor) |
| `src/components/active/dac.ts` | N-bit digital-to-analog converter |
| `src/components/active/adc.ts` | N-bit analog-to-digital converter |
| `src/analog/ac-analysis.ts` | AC small-signal analysis engine |
| `src/analog/complex-sparse-solver.ts` | Complex sparse solver for AC analysis (native complex LU, N×N) |
| `src/test-utils/decompress-polyfill.ts` | Node.js/Jest polyfill for `DecompressionStream` using `node:zlib` |
| `src/runtime/bode-plot.ts` | Bode plot renderer (magnitude + phase) |
| `src/io/ctz-parser.ts` | CircuitJS CTZ URL import parser |
| `src/io/ctz-format.ts` | CTZ text format parser and component mapping |
| `src/analog/monte-carlo.ts` | Monte Carlo batch simulation runner |
| `src/analog/parameter-sweep.ts` | Parameter sweep runner |
