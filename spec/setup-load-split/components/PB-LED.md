# Task PB-LED

**digiTS file:** `src/components/io/led.ts`
**Reused class:** `DiodeAnalogElement` (the diode element produced by `createDiodeElement` in `src/components/semiconductors/diode.ts`)
**Reused PB:** `PB-DIO.md` (frozen- must be complete before PB-LED runs)
**ngspice setup anchor (inherited from PB-DIO):** `ref/ngspice/src/spicelib/devices/dio/diosetup.c:198-238`
**ngspice load anchor (inherited from PB-DIO):** `ref/ngspice/src/spicelib/devices/dio/dioload.c`

## Architectural framing

LED is a **single-port diode with cathode wired to ground**. Its analog model
is the existing `DiodeAnalogElement` (post-PB-DIO migration)- not a bespoke
factory. PB-LED.md does NOT introduce a new analog element class. It
specifies:

1. Deletion of `createLedAnalogElement` and the LED-specific state schemas
   (`LED_STATE_SCHEMA`, `LED_CAP_STATE_SCHEMA`).
2. Replacement of the five color `modelRegistry` entries with calls to
   `createDiodeElement` with per-color parameter overrides.
3. A pin-relabel adapter that exposes user-facing pin label `"in"` while
   passing `{A: <anode-node>, K: 0}` to the diode factory. Node 0 is the
   MNA ground; the diode's K-side stamps fall on row/column 0 and are
   discarded by the solver, leaving only the structurally-meaningful
   `(anode, anode)` entry plus internal-node entries when RS > 0 (LED
   sets RS = 0, so no internal node is created).
4. An `isLit(signals: PinVoltageAccess | undefined): boolean` accessor on
   `LedElement` (the UI-facing component class) that reads the `"in"` pin
   voltage via `PinVoltageAccess.getPinVoltage("in")` and compares it to a
   per-color threshold. Cathode is wired to ground (node 0) by the adapter,
   so the `"in"` pin voltage is exactly the diode's forward voltage `Vd`.
   The accessor lives on `LedElement` and is invoked from `LedElement.draw`
   to render lit-state visuals; the analog adapter is engine-agnostic and
   does not attach any state-pool readers to the returned diode element.

## Pin mapping

LED's user-facing `ComponentDefinition` keeps its single pin:

| digiTS pin label (user-facing) | direction | bitWidth |
|---|---|---|
| `in` | INPUT | 1 |

The analog factory adapter remaps to the diode's pin contract:

| Pin in pinNodes (LED side) | Diode side (after remap) | ngspice variable |
|---|---|---|
| `pinNodes.get("in")` | `A` (anode) | `DIOposNode` |
| (none) | `K` = 0 (ground, injected by adapter) | `DIOnegNode` |

`ngspiceNodeMap` on `LedDefinition`: `{ in: "pos" }` (matches the diode's
`pos` slot for the anode side; the `neg`/cathode slot is implicit ground).

## Internal nodes

None. LED sets the diode's `RS = 0` for every color; per `diosetup.c:204-206`,
the diode collapses `posPrimeNode = posNode` and creates no internal node.

## Branch rows

None.

## State slots

4 slots, inherited from `DIODE_SCHEMA` (resistive) or 7 slots from
`DIODE_CAP_SCHEMA` (capacitive). LED-side schemas (`LED_STATE_SCHEMA`,
`LED_CAP_STATE_SCHEMA`) are deleted. The diode chooses its schema
based on `(CJO > 0 || TT > 0)` exactly as it does today.

LED has no need to reach into the diode's state pool. Lit-state is computed
from the `"in"` pin voltage via `PinVoltageAccess`, not from `SLOT_VD`.

## TSTALLOC sequence

Inherited from PB-DIO. With `RS = 0` (LED's choice), the 7 ngspice TSTALLOC
calls collapse per the PB-DIO "RS=0 collapse note"- entries (1)/(3)/(5)/(7)
all reduce to `(posNode, posNode)` and the `allocElement` Translate
mechanism returns the same handle for repeated coordinates. Entries (2)/(4)
reduce to `(0, posNode)` / `(posNode, 0)` (ground row/col, discarded).
Entry (6) is `(0, 0)` (also discarded).

The structurally-meaningful matrix entry is `(posNode, posNode)`. The
diode element still issues all 7 `allocElement` calls- `setup()` body is
identical to PB-DIO's. The `_hPosPos` handle is the only one whose
`stampElement` updates have effect.

## setup() body- alloc only

LED has no `setup()` of its own. The diode element's `setup()` runs
verbatim per PB-DIO sssetup() body. The LED factory adapter (replacing
`createLedAnalogElement`) is a pure pin remap:

```ts
function createLedAnalogElementViaDiode(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime?: () => number,
): AnalogElementCore {
  // Inject K=0 (cathode → ground); remap "in" → "A".
  const remappedPinNodes = new Map<string, number>([
    ["A", pinNodes.get("in")!],
    ["K", 0],
  ]);
  return createDiodeElement(remappedPinNodes, props, getTime);
}
```

The factory adapter lives in `src/components/io/led.ts`. It does not
create or mutate matrix entries, attach accessors, or read solver state-
that's the diode element's job. Lit-state is the UI's concern and is
computed by `LedElement.isLit(signals)` from `PinVoltageAccess`, not from
the analog element.

## Lit-state threshold table

`getLitThreshold(color)` returns:

| Color | Vd threshold (V) | Rationale |
|---|---|---|
| red | 1.6 | Typical red LED forward-voltage threshold |
| yellow | 1.9 | Typical yellow LED forward-voltage threshold |
| green | 2.1 | Typical green LED forward-voltage threshold |
| blue | 2.6 | Typical blue LED forward-voltage threshold |
| white | 2.6 | Same Vf as blue (white LEDs are blue + phosphor) |

These are illumination-perception thresholds, not turn-on knee voltages. A
color-specific table avoids false-negative "off" reads on blue/white LEDs
biased at red-LED-on voltages.

The table lives in `led.ts` as a `const Record<string, number>` and is
accessed by the exported `getLitThreshold(color)` helper, which is called
from `LedElement.isLit`. The `color` is read from the regular property bag
(`PropertyType.COLOR` definition), not from analog model params.

## load() body- value writes only

LED has no `load()` of its own. The diode element's `load()` runs verbatim
per PB-DIO ssload() body.

## Factory cleanup

In `src/components/io/led.ts`:

- **Delete** `createLedAnalogElement` (factory function).
- **Delete** `LED_STATE_SCHEMA` and `LED_CAP_STATE_SCHEMA`.
- **Delete** `LED_GMIN`, `recomputeLedTp`, `ledTp` closure variables, and the
  in-element `getLteTimestep` attach block.
- **Delete** the slot constants `SLOT_VD`, `SLOT_GEQ`, `SLOT_IEQ`, `SLOT_ID`,
  `SLOT_Q`, `SLOT_CCAP` (LED-side copies). The diode-side constants in
  `diode.ts` are the single source of truth.
- **Add** `createLedAnalogElementViaDiode` factory adapter (per setup body
  block above) and the exported `getLitThreshold` helper.
- **Add** `LedElement.isLit(signals)` accessor that reads the `"in"` pin
  voltage via `PinVoltageAccess` and compares it to `getLitThreshold(color)`.
- **Rewrite** `LedDefinition.modelRegistry` so each color entry calls the
  diode factory with parameter overrides:

```ts
modelRegistry: {
  red:    { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 3.17e-19, N: 1.8, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5 } },
  green:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 1e-21, N: 2.0, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5 } },
  blue:   { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5 } },
  yellow: { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 1e-20, N: 1.9, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5 } },
  white:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5 } },
}
```

`color` is NOT in the model-param surface- it's a regular property
(`PropertyType.COLOR`) on `LedDefinition.propertyDefs`, read via
`PropertyBag.getOrDefault("color", "red")` from `LedElement` and consumed
exclusively by `isLit`.

- `paramDefs: DIODE_PARAM_DEFS` replaces the deleted `LED_PARAM_DEFS`.
  `LED_PARAM_DEFS` and `LED_DEFAULTS` exports are deleted; external
  consumers are rerouted to `DIODE_PARAM_DEFS` / `DIODE_PARAM_DEFAULTS`.
- `defaultModel: "digital"` unchanged (digital model selection, separate
  axis from analog modelRegistry).
- `executeLed` (digital function) unchanged- operates on digital wiring
  table, not analog state.

## findBranchFor (if applicable)

Not applicable. Diode has no branch row; LED inherits this.

## Verification gate

1. `createLedAnalogElement`, `LED_STATE_SCHEMA`, `LED_CAP_STATE_SCHEMA`,
   `LED_GMIN`, slot constants, and the embedded `getLteTimestep` attach
   block are deleted from `src/components/io/led.ts`.
2. `createLedAnalogElementViaDiode` factory adapter present and is a pure
   pin remap (no `Object.assign`, no accessor attachment, no state-pool
   reads). Body matches the spec block line-for-line.
3. `LedDefinition.modelRegistry` rewritten per the spec block; all 5 color
   entries delegate to the diode factory with the listed parameter sets
   (no `color` key in `params`).
4. Exported `getLitThreshold(color: string): number` helper and per-color
   Vd-threshold table present.
5. `LedElement.isLit(signals: PinVoltageAccess | undefined): boolean`
   accessor present, reads `"in"` pin voltage and compares to
   `getLitThreshold(this.color)`. `LedElement.draw(ctx, signals?)` uses the
   accessor.
6. `LED_PARAM_DEFS` and `LED_DEFAULTS` re-export shims are deleted.
   External consumers (tests) import `DIODE_PARAM_DEFS` /
   `DIODE_PARAM_DEFAULTS` directly.
7. PB-DIO compliance applies- diode element setup/load bodies are
   unchanged from PB-DIO. PB-LED introduces no diode-side mutations.
8. `executeLed` digital execution path unchanged.
9. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/
   intentional-divergence/citation-divergence/partial) used in any commit
   message or report.
