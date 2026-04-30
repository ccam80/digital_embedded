# LED forward-drop and TEMP signal-read failures

## Category
`contract-update`

## Resolves (4 vitest tests)
All in `src/components/io/__tests__/led.test.ts`:

- `AnalogLED > red_led_forward_drop` (line 810) — `expected 0 to be greater than 1.65`
- `AnalogLED > blue_led_forward_drop` (line 823) — same shape
- `LED TEMP > vt_reflects_TEMP` (line 1092) — same shape (vf300/vf400 both 0)
- `LED TEMP > setParam_TEMP_recomputes` (line 1112) — same shape

## Sites
- Test: `src/components/io/__tests__/led.test.ts` lines 810, 823, 1092, 1112
- Fixture: `src/components/io/__tests__/led-fixture.ts` (`buildLedDcCircuit`)
- Source: `src/components/io/led.ts`
- Label-map construction: `src/compile/compile.ts` line 390-397

## Problem

Each failing test calls
`facade.readAllSignals(coordinator)["led:in"]`
and asserts the returned voltage is in a physical range. The actual return is
`undefined`, which JS coerces to `0` in the `>`/`<` comparison, producing
`expected 0 to be greater than 1.65`.

The label format the analog compiler emits is correct in theory:
`src/compile/compile.ts:392` does
`labelSignalMap.set(\`${label}:${p.pinLabel}\`, …)`
for every `(label, pins)` entry returned by the analog partition's
`labelPinNodes` map. The LED's pin (`src/components/io/led.ts:38-46`)
is declared with `label: "in"`, and the fixture
(`src/components/io/__tests__/led-fixture.ts:30-37`) sets
`props: { color, label: "led", … }`. So the *expected* registered key is
`"led:in"`.

## Verified actual label vs test-expected label

The pin label declared on the LED component is `"in"`
(`led.ts:38-46`, also asserted by the still-passing test
`LED > pinLayout > LED has 1 input pin labeled 'in'` at line 258).
The component label set in the fixture is `"led"`. The compiler's
`labelSignalMap` builder produces `"label:pinLabel"`, so the expected key
is `"led:in"`. There is no label-name drift in the production compiler.

The most likely reason the lookup returns `undefined` is one of:

1. The LED's pin does not appear in `compiledAnalog.labelPinNodes` because
   the analog partition's pin-collection logic excludes single-port elements
   whose other pin is hardwired to ground inside
   `createLedAnalogElementViaDiode` (it injects `["K", 0]` and remaps
   `"in" → "A"`, so the only externally-visible pin is `"A"` — not `"in"`).

2. The LED's `label` property does not propagate into the analog compiler's
   label map for analog-domain elements. The companion test
   `src/solver/analog/__tests__/behavioral-remaining.test.ts:136-145`
   uses an identical fixture and reads `["led:in"]`. If that test is
   currently passing, this hypothesis is wrong; if it's failing, both share
   one root cause.

The agent did not run a TypeScript probe inside this scope (creating
debug code outside `spec/test-fix-jobs/` is out of scope), so the
exact missing key is not yet identified. The fix-author for this spec
must dump `[...coordinator.compiled.labelSignalMap.keys()]` from inside
either `red_led_forward_drop` or a one-off probe and confirm the
*actual* registered key.

## Migration

Once the actual key is known, exactly one of these is the contract update:

- **If the registered key is `"led:A"`** (because the diode's internal
  pin remap surfaces only the diode anode label `"A"`):
  update the four tests to read `["led:A"]`. The label format is
  `componentLabel:pinLabel`, and the LED is fundamentally a diode whose
  externally-visible analog pin is `A` — the remap helper deliberately
  hides the LED's component-level pin label from the analog graph.

- **If the registered key is `"led"`** (single-pin bare-label fallback in
  `compile.ts:394-396`): update the four tests to read `["led"]`.

- **If no key starting with `"led"` exists at all**: the LED is not being
  added to `labelPinNodes`. That is not a fixture issue — it is a
  compiler bug in how analog partitions discover labels for elements
  whose factory remaps pins. Promote this item to `architecture-fix`
  and fix the partitioner to record the LED under its UI-facing
  `pinLabel` (`"in"`).

The fix-author MUST dump the keys before deciding. If branch (3) holds,
the spec must be re-categorized.

## Tensions / uncertainties

- The spec brief assumed the failure was a simple label rename
  (`led:in → led:anode`). The LED component's pin label has not changed
  (still `"in"`); the issue is whether the analog partition records the
  remapped pin under `"in"` or `"A"`.
- A neighbouring test in `src/solver/analog/__tests__/behavioral-remaining.test.ts:145`
  reads the same `["led:in"]` against the same fixture style. Its current
  pass/fail status is the canary: if it passes, something specific to
  the four failing tests is wrong; if it fails, the fix is shared.
- TEMP variants (`vt_reflects_TEMP`, `setParam_TEMP_recomputes`) are not
  TEMP-specific failures — they fail at the same `["led:in"]` lookup
  step before any temperature-dependent assertion runs. Fixing the label
  read fixes all four uniformly. There is no separate TEMP bug to
  resolve here.
