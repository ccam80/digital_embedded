# Task PB-LED

**digiTS file:** `src/components/io/led.ts`
**Reused class:** `DiodeAnalogElement` (the diode element produced by `createDiodeElement` in `src/components/semiconductors/diode.ts`)
**Reused PB:** `PB-DIO.md` (frozen — must be complete before PB-LED runs)
**ngspice setup anchor (inherited from PB-DIO):** `ref/ngspice/src/spicelib/devices/dio/diosetup.c:198-238`
**ngspice load anchor (inherited from PB-DIO):** `ref/ngspice/src/spicelib/devices/dio/dioload.c`

## Architectural framing

LED is a **single-port diode with cathode wired to ground**. Its analog model
is the existing `DiodeAnalogElement` (post-PB-DIO migration) — not a bespoke
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
4. A `getVisibleLit(): boolean` accessor that reads `VD` from the diode's
   state pool and compares to a per-color threshold. The accessor lives on
   an LED-side wrapper or is attached to the returned diode element by
   `Object.assign` in the LED factory adapter.

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

5 slots, inherited from `DIODE_SCHEMA` (resistive) or 7 slots from
`DIODE_CAP_SCHEMA` (capacitive). LED-side schemas (`LED_STATE_SCHEMA`,
`LED_CAP_STATE_SCHEMA`) are deleted. The diode chooses its schema
based on `(CJO > 0 || TT > 0)` exactly as it does today.

LED's `getVisibleLit()` reads slot index `SLOT_VD = 0` from the diode's
schema (constant defined in `src/components/semiconductors/diode.ts`).

## TSTALLOC sequence

Inherited from PB-DIO. With `RS = 0` (LED's choice), the 7 ngspice TSTALLOC
calls collapse per the PB-DIO "RS=0 collapse note" — entries (1)/(3)/(5)/(7)
all reduce to `(posNode, posNode)` and the `allocElement` Translate
mechanism returns the same handle for repeated coordinates. Entries (2)/(4)
reduce to `(0, posNode)` / `(posNode, 0)` (ground row/col, discarded).
Entry (6) is `(0, 0)` (also discarded).

The structurally-meaningful matrix entry is `(posNode, posNode)`. The
diode element still issues all 7 `allocElement` calls — `setup()` body is
identical to PB-DIO's. The `_hPosPos` handle is the only one whose
`stampElement` updates have effect.

## setup() body — alloc only

LED has no `setup()` of its own. The diode element's `setup()` runs
verbatim per PB-DIO §setup() body. The LED factory adapter (replacing
`createLedAnalogElement`) is:

```ts
function createLedAnalogElementViaDiode(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  getTime?: () => number,
): AnalogElementCore {
  // Inject K=0; remap "in" → "A".
  const remappedPinNodes = new Map<string, number>([
    ["A", pinNodes.get("in")!],
    ["K", 0],
  ]);

  // Delegate to the existing diode factory. Diode handles setup/load/state.
  const diodeElement = createDiodeElement(remappedPinNodes, props, getTime);

  // Attach LED-specific visible-lit accessor.
  const litThreshold = getLitThreshold(props.getModelParam<string>("color") ?? "red");
  Object.assign(diodeElement, {
    getVisibleLit(): boolean {
      // SLOT_VD = 0 in DIODE_SCHEMA / DIODE_CAP_SCHEMA.
      const vd = (diodeElement as PoolBackedAnalogElementCore).s0[
        (diodeElement as PoolBackedAnalogElementCore).stateBaseOffset + 0
      ];
      return vd > litThreshold;
    },
  });

  return diodeElement;
}
```

The factory adapter lives in `src/components/io/led.ts`. It does not
create or mutate matrix entries — that's the diode element's job.

## Lit-state threshold table

`getLitThreshold(color)` returns:

| Color | VD threshold (V) | Rationale |
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
accessed by `getLitThreshold`.

## load() body — value writes only

LED has no `load()` of its own. The diode element's `load()` runs verbatim
per PB-DIO §load() body.

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
  block above) and the `getLitThreshold` helper.
- **Rewrite** `LedDefinition.modelRegistry` so each color entry calls the
  diode factory with parameter overrides:

```ts
modelRegistry: {
  red:    { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 3.17e-19, N: 1.8, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5, color: "red" } },
  green:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 1e-21, N: 2.0, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5, color: "green" } },
  blue:   { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5, color: "blue" } },
  yellow: { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 1e-20, N: 1.9, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5, color: "yellow" } },
  white:  { kind: "inline", factory: createLedAnalogElementViaDiode, paramDefs: DIODE_PARAM_DEFS,
            params: { IS: 6.26e-24, N: 2.5, RS: 0, CJO: 0, TT: 0, BV: Infinity, IBV: 1e-3,
                      VJ: 1, M: 0.5, FC: 0.5, color: "white" } },
}
```

`color` is passed as a non-numerical model param consumed by the factory
adapter to look up the lit-state threshold. The diode element ignores
unrecognized keys via its existing `setParam` guard.

- `paramDefs: DIODE_PARAM_DEFS` replaces the deleted `LED_PARAM_DEFS`.
  `LED_PARAM_DEFS` and `LED_DEFAULTS` exports are deleted (verify no
  external consumers via Grep before deletion; if present, they get
  rerouted to `DIODE_PARAM_DEFS`).
- `defaultModel: "digital"` unchanged (digital model selection, separate
  axis from analog modelRegistry).
- `executeLed` (digital function) unchanged — operates on digital wiring
  table, not analog state.

## findBranchFor (if applicable)

Not applicable. Diode has no branch row; LED inherits this.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is
spec compliance only. DO NOT run tests; DO NOT use test results.

1. `createLedAnalogElement`, `LED_STATE_SCHEMA`, `LED_CAP_STATE_SCHEMA`,
   `LED_GMIN`, slot constants, and the embedded `getLteTimestep` attach
   block are deleted from `src/components/io/led.ts`.
2. `createLedAnalogElementViaDiode` factory adapter present, body matches
   the spec block line-for-line.
3. `LedDefinition.modelRegistry` rewritten per the spec block; all 5 color
   entries delegate to the diode factory with the listed parameter sets.
4. `getLitThreshold` helper and per-color VD-threshold table present.
5. The diode element returned by the adapter has a `getVisibleLit()`
   method attached via `Object.assign`.
6. PB-DIO compliance applies — diode element setup/load bodies are
   unchanged from PB-DIO. PB-LED introduces no diode-side mutations.
7. `executeLed` digital execution path unchanged.
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/
   intentional-divergence/citation-divergence/partial) used in any commit
   message or report.
