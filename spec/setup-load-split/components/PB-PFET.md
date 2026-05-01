# Task PB-PFET

**digiTS file:** `src/components/switching/pfet.ts`
**ngspice setup anchor:** `ref/ngspice/src/spicelib/devices/sw/swsetup.c:47-62` (applied once- single SW sub-element)
**ngspice load anchor:** `ref/ngspice/src/spicelib/devices/sw/swload.c`

## Pin mapping (from 01-pin-mapping.md)

PFET is a composite that decomposes to a single SW sub-element. The composite has no `ngspiceNodeMap` of its own.

SW sub-element pin map: `{ G: "ctrl", D: "pos", S: "neg" }`

| digiTS composite pin | SW sub-element role | ngspice node variable |
|---|---|---|
| `D` (Drain) | `SWposNode` | `SWposNode` |
| `S` (Source) | `SWnegNode` | `SWnegNode` |
| `G` (Gate) | control input- NOT a switch pin node | inverted control polarity set via setParam at load time |

The gate pin `G` is not wired into the SW MNA stamp. PFET differs from NFET only in the control polarity: the switch turns ON when `V(S) - V(G) > |Vth|` (i.e., `V(G) - V(S) < -|Vth|`). This inversion is applied at load time by negating the control voltage before the threshold comparison, not by changing the SW setup structure.

## Internal nodes

none- the SW sub-element has no internal nodes.

## Branch rows

none- SW stamps conductance only.

## State slots

2- allocated by the SW sub-element (`SW_NUM_STATES = 2`, swsetup.c:47-48).

## TSTALLOC sequence (line-for-line port)

Single SW sub-element (swsetup.c:59-62). Identical to PB-NFET- the structural allocation is the same; only load-time polarity differs:

| Position | ngspice pair | digiTS pair | handle field name |
|---|---|---|---|
| 1 | `(SWposNode, SWposNode)` | `(drainNode, drainNode)` | `sw._hPP` |
| 2 | `(SWposNode, SWnegNode)` | `(drainNode, sourceNode)` | `sw._hPN` |
| 3 | `(SWnegNode, SWposNode)` | `(sourceNode, drainNode)` | `sw._hNP` |
| 4 | `(SWnegNode, SWnegNode)` | `(sourceNode, sourceNode)` | `sw._hNN` |

where `drainNode = pinNodes.get("D")` and `sourceNode = pinNodes.get("S")`.

## setup() body- alloc only

```typescript
setup(ctx: SetupContext): void {
  // PFET composite forwards directly to its single SW sub-element.
  // SW sub-element uses D as posNode, S as negNode.
  // Inverted polarity is a load-time concern only- setup is identical to NFET.
  this._sw.setup(ctx);
}
```

The SW sub-element's setup() body is identical to PB-SW with `posNode = pinNodes.get("D")` and `negNode = pinNodes.get("S")`.

## load() body- value writes only

Implementer ports value-side from `swload.c` line-for-line, stamping through cached handles. No allocElement calls.

PFET inverts the control voltage before threshold comparison. When `V(S) - V(G) > |Vth|` (equivalently `V(G) - V(S) < -|Vth|`) the switch turns ON:

```typescript
load(ctx: LoadContext): void {
  // Inverted control: PFET turns ON when source is higher than gate by |Vth|
  // Negate vCtrl so the same SW threshold logic applies
  const vCtrl = ctx.rhsOld[sourceNode] - ctx.rhsOld[gateNode];  // inverted
  this._sw.setCtrlVoltage(vCtrl);  // Defined in PB-SW ss"setCtrlVoltage(v)- for composite use only"
  this._sw.load(ctx);  // stamps g_now onto D/S nodes
}
```

## findBranchFor (not applicable)

SW has no branch row.

## Factory cleanup

- Drop `internalNodeIds`, `branchIdx` from factory signature.
- Drop `branchCount`, `getInternalNodeCount` from MnaModel registration.
- Composite has no `ngspiceNodeMap` (sub-element carries its own: `{ D: "pos", S: "neg" }`).
- No `findBranchFor` callback.
- Composite carries `{ _sw: SwitchElement }` as a direct ref.

## Verification gate

Per CLAUDE.md "Test Policy During W3 Setup-Load-Split", verification is spec compliance only. DO NOT run tests; DO NOT use test results.

1. `setup()` body in the implementation file matches the "setup() body- alloc only" listing in this PB line-for-line.
2. TSTALLOC sequence in `setup()` matches the order in the cited ngspice anchor file (see top of this PB, e.g. `ressetup.c:46-49`).
3. Factory cleanup applied per the "Factory cleanup" section above.
4. `ngspiceNodeMap` registered per the "Pin mapping" section above (or omitted for composites where the spec says so).
5. `load()` writes through cached handles only- zero `solver.allocElement(...)` calls inside `load()`, `accept()`, or any non-`setup()` method.
6. `mayCreateInternalNodes` flag set per spec.
7. `findBranchFor` callback present where spec says (V-output sources, IND, etc.).
8. No banned closing verdicts (mapping/tolerance/equivalent-to/pre-existing/intentional-divergence/citation-divergence/partial) used in any commit message or report.
