# Spec Review: Phase 01- Pin Mapping Registry

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 1 | 2 | 3 |
| minor    | 1 | 2 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage

This spec is a reference document (not a task spec with numbered tasks), which the plan explicitly describes as such:
> "`01-pin-mapping.md`- `ngspiceNodeMap` registry and per-component pin label maps."

The plan lists no separately-numbered tasks for this file. Its role is as a shared reference consumed by W2 (engine restructure) and W3 (per-component setup() bodies). Coverage is assessed against what the plan says this file must provide.

| Plan requirement | In Spec? | Notes |
|---|---|---|
| `ngspiceNodeMap` field on `ComponentDefinition` | yes | ssMechanism, `src/core/registry.ts` |
| `ngspiceNodeMap` field on `MnaModel` | yes/partial | ssMechanism; file path is wrong- see D1 |
| Per-component pin-label maps for all primitive components | yes | All five primitive categories present |
| Per-composite decomposition rules for sub-element maps | yes | Six composite tables present |
| Verification: `pin-map-coverage.test.ts` added | yes | ssVerification describes the test |
| Verification: `setup-stamp-order.test.ts` implicitly verifies maps | yes/partial | ssVerification has wrong section cross-ref- see M1 |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | ssVerification, first sentence: "A1.7's `setup-stamp-order.test.ts` (per `00-engine.md` ssA9)" | The leading "A1.7's" is wrong. A1.7 defines `_getInsertionOrder()`. `setup-stamp-order.test.ts` is created in ssA9. The parenthetical correctly cites ssA9, making the sentence self-contradictory. | Replace "A1.7's `setup-stamp-order.test.ts` (per `00-engine.md` ssA9)" → "A9's `setup-stamp-order.test.ts` (per `00-engine.md` ssA9)" |

---

### Decision-Required Items

#### D1- Wrong primary file path for `MnaModel` (major)

- **Location**: ssMechanism, subsection "`src/solver/analog/types.ts` (or wherever `MnaModel` lives)- `MnaModel`"
- **Problem**: The spec states: "### `src/solver/analog/types.ts` (or wherever `MnaModel` lives)- `MnaModel`". The actual file is `src/compile/types.ts` (confirmed by grepping for `interface MnaModel`- found only at `src/compile/types.ts:136`). The parenthetical hedge `(or wherever MnaModel lives)` partially covers this, but an implementer reading the spec will look in `src/solver/analog/types.ts` first, find nothing, and have to search- defeating the purpose of the spec.
- **Why decision-required**: Two plausible paths: leave the hedge and rely on the implementer searching, or update the primary path. Both are valid but only the author can decide which level of accuracy is intended for W3 implementers who are forbidden from reading existing source.
- **Options**:
  - **Option A- Correct the path**: Replace `src/solver/analog/types.ts` with `src/compile/types.ts` in the subsection heading, remove the hedge parenthetical.
    - Pros: Precise; implementer goes directly to the right file.
    - Cons: If `MnaModel` moves as part of A3/A6 restructuring, the spec needs updating again.
  - **Option B- Keep hedge, add actual path as note**: Change to: "`src/compile/types.ts` (current location; may move to `src/solver/analog/types.ts` as part of A3 restructure if desired)- `MnaModel`"
    - Pros: Gives current location AND documents intent; agent is not left searching.
    - Cons: Slightly verbose; may create confusion if the restructure doesn't happen.
  - **Option C- Keep hedge only**: Leave as-is; rely on implementers using Grep when the file is not found at the primary path.
    - Pros: No spec change required.
    - Cons: W3 agents are spec-forbidden from reading existing source per `plan.md` ss"Wave-by-wave reading guide". They would have no safe way to locate the file.

---

#### D2- `"ctrl"` value absent from `pin-map-coverage.test.ts` allowlist (major)

- **Location**: ssVerification, requirement 3: the allowlist of valid `ngspiceNodeMap` values; ssSwitching- composites table, NFET/PFET row.
- **Problem**: The spec defines two NFET/PFET rows in the "Switching- composites" table:
  - NFET: `{ G: "ctrl", D: "pos", S: "neg" }` (control-pin not in SW anchor- handled in load() body)
  - PFET: `{ G: "ctrl", D: "pos", S: "neg" }`

  The value `"ctrl"` does not appear in the ssVerification allowlist: `"pos"`, `"neg"`, `"drain"`, `"gate"`, `"source"`, `"bulk"`, `"col"`, `"base"`, `"emit"`, `"posNode1"`, `"negNode1"`, `"posNode2"`, `"negNode2"`, `"contPos"`, `"contNeg"`.

  If implemented as written, `pin-map-coverage.test.ts` requirement 3 would fail for every NFET and PFET instance, because `"ctrl"` is not in the allowlist.
- **Why decision-required**: Two ways to fix this, but only the author can decide whether `"ctrl"` is the correct vocabulary for a SW-backed composite's control pin, or whether the map entry should be removed entirely (since the spec note says "control-pin not in SW anchor- handled in load() body").
- **Options**:
  - **Option A- Add `"ctrl"` to the allowlist**: Add `"ctrl"` to the ssVerification allowlist enumeration.
    - Pros: Consistent; test passes as written; NFET/PFET maps stay as-is.
    - Cons: `"ctrl"` is not a native ngspice SW node-suffix (SW uses `pos`/`neg` only); the allowlist's claimed source ("from the anchor's `*setup.c`") becomes inaccurate for this entry.
  - **Option B- Remove G from NFET/PFET ngspiceNodeMap**: Change maps to `{ D: "pos", S: "neg" }`, dropping the `G: "ctrl"` entry. Add a note that `G` (gate/ctrl) is not mapped because it drives the SW threshold via `setParam`, not via a matrix node.
    - Pros: Map values stay within allowlist; accurately reflects that G drives a parameter, not a matrix row.
    - Cons: The map is then incomplete with respect to the component's full pin set; implementers working from the spec alone must infer that G is handled separately.
  - **Option C- Mark NFET/PFET as composite with no top-level map**: Move NFET/PFET from the "Switching- composites" table's `ngspiceNodeMap` column to a "no map; see `components/PB-NFET.md`" reference, analogous to how active composites are handled.
    - Pros: Avoids allowlist pollution; keeps the per-component spec as the authority.
    - Cons: Requires updating the switching table format; increases per-component spec burden.

---

#### D3- MOSFET `ngspiceNodeMap` values use JFET-style full-word names, not MOS1 C-field suffix convention (minor)

- **Location**: ssSemiconductors- primitive, NMOSFET and PMOSFET rows.
- **Problem**: The spec says the NMOSFET map is `{ G: "gate", S: "source", D: "drain" }` with bulk as internal `pinNodes.get("S")`. The ssVerification requirement 3 states these values must match "known ngspice-node-suffix string from the anchor's `*setup.c`". The anchor is `mos1/mos1set.c`. In that file the node fields are `MOS1dNode`, `MOS1gNode`, `MOS1sNode`, `MOS1bNode` (confirmed in `mos1defs.h:27-30`). Stripping `MOS1` prefix and `Node` suffix gives `d`, `g`, `s`, `b`- single-letter suffixes. The spec values `"gate"`, `"drain"`, `"source"` are the JFET-style long names (`JFETgateNode`, `JFETdrainNode`, `JFETsourceNode` per `jfetdefs.h:30-31`), not the MOS1 names.

  The ssVerification allowlist lists both `"gate"`, `"drain"`, `"source"` (JFET convention) and these are what the spec uses for MOS. The allowlist does not include `"d"`, `"g"`, `"s"`, `"b"` (MOS1 convention). So the allowlist is internally consistent with the map values- the issue is the claim that the allowlist entries come from "the anchor's `*setup.c`", which is inaccurate for MOS: the MOS1 anchor uses single-letter suffixes, not the full-word names the spec maps.
- **Why decision-required**: The spec defines the allowlist. The vocabulary is self-referential (JFET names applied to MOSFET). Whether this matters depends on whether `pin-map-coverage.test.ts` actually strips the C prefix/suffix to compare, or uses the allowlist as a closed set. If it's a closed set (as the spec implies), no test fails. If it parses C-file field names, the MOS entries would fail.
- **Options**:
  - **Option A- Accept the current vocabulary (JFET-style for MOS too) and clarify the test description**: Change requirement 3's wording from "matches a known ngspice-node-suffix string from the anchor's `*setup.c`" to "matches an entry from the following allowlist" (removing the false claim about derivation from `*setup.c`).
    - Pros: No map values change; test behaviour unchanged; removes inaccurate provenance claim.
    - Cons: The allowlist's semantic meaning ("what ngspice calls this node") diverges from MOS1 C-field names, reducing its value as a parity cross-check.
  - **Option B- Use MOS-accurate suffixes in the map and add them to the allowlist**: Change NMOSFET/PMOSFET maps to `{ G: "g", S: "s", D: "d" }` (matching `MOS1gNode`→`g`, etc.) and add `"d"`, `"g"`, `"s"`, `"b"` to the allowlist.
    - Pros: Allowlist claim becomes accurate for both JFET and MOS; consistent with stated derivation from `*setup.c`.
    - Cons: Inconsistent naming style between JFET (`"gate"`) and MOS (`"g"`); PB-MOS spec bodies will use single letters that are less readable than full words.

---

#### D4- `MnaModel.hasBranchRow` for CCCS is unspecified (minor)

- **Location**: ssControlled sources- primitive, CCCS row; Note on sense pins.
- **Problem**: The spec note says: "digiTS pins `sense+` / `sense-` are wired via the netlist generator to a virtual zero-volt VSRC whose label is the `senseSourceLabel` setParam. setup() ignores the sense pins and calls `ctx.findBranch(senseSourceLabel)` to get the controlling branch."

  The `MnaModel.hasBranchRow: boolean` field (defined in `00-engine.md` ssA3.1) is described as "True for models that allocate a branch row in setup() (VSRC, IND, VCVS, CCVS)". CCCS is listed in the "primitive" table, but its actual behaviour is: the sense VSRC is a separate element (virtual, produced by the netlist generator). The CCCS element's own `setup()` calls `ctx.findBranch` but does NOT call `ctx.makeCur`- it has no branch row of its own. So `hasBranchRow` for CCCS should be `false`.

  But this is not stated anywhere in the spec, and the virtual sense VSRC's `hasBranchRow` status is also not specified. An implementer implementing CCCS from this spec alone would be uncertain.
- **Why decision-required**: The virtual sense VSRC is a netlist-generator artifact. Whether it registers as its own `MnaModel` with `hasBranchRow: true`, or whether it's transparently handled, affects how CCCS is categorised in the `_findBranch` dispatch table.
- **Options**:
  - **Option A- Explicitly state `hasBranchRow: false` for CCCS in the table**: Add a "hasBranchRow" column note to the CCCS row, or add a parenthetical in the note: "CCCS model itself: `hasBranchRow: false`; the virtual sense VSRC is a separate element with its own `hasBranchRow: true`."
    - Pros: Removes implementer ambiguity; consistent with the note's description.
    - Cons: Requires adding a new column or expanding the note.
  - **Option B- Delegate to `components/PB-CCCS.md`**: Add to the CCCS note: "Full `hasBranchRow` specification and virtual-VSRC wiring details are in `components/PB-CCCS.md`."
    - Pros: Keeps this file as a pin-map registry, not a full component spec.
    - Cons: PB-CCCS.md must then be authoritative on this point; cross-reference coupling increases.

---

## Notes on Spot-Checked Pin Labels (Special Focus items)

### Resistor (`resistor.ts`)- PASS
Source `buildResistorPinDeclarations()` declares `"A"` and `"B"`. Spec map `{ A: "pos", B: "neg" }` keys match exactly.

### OpAmp (`opamp.ts`)- PASS
Source `buildOpAmpPinDeclarations()` declares `"in-"`, `"in+"`, `"out"`. Spec lists OpAmp pin labels as `in-`, `in+`, `out`. Match confirmed.

### Transformer (`transformer.ts`)- PASS
Source `buildTransformerPinDeclarations()` declares `"P1"`, `"P2"`, `"S1"`, `"S2"`. Spec sub-element map uses `L1.ngspiceNodeMap = { P1: "pos", P2: "neg" }` and `L2.ngspiceNodeMap = { S1: "pos", S2: "neg" }`. Keys match source pin labels.

### TappedTransformer (`tapped-transformer.ts`)- PASS
Source declares `"P1"`, `"P2"`, `"S1"`, `"CT"`, and (continuing from offset 155) `"S2"`. Spec sub-element maps use `L1: { P1: "pos", P2: "neg" }`, `L2: { S1: "pos", CT: "neg" }`, `L3: { CT: "pos", S2: "neg" }`. Keys match source declarations.

### VCCS (`vccs.ts`)- PASS
Source declares `"ctrl+"`, `"ctrl-"`, `"out+"`, `"out-"`. Spec map `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }` keys match. Values match ngspice `vccsdefs.h` fields `VCCSposNode`, `VCCSnegNode`, `VCCScontPosNode`, `VCCScontNegNode`.

### CCCS (`cccs.ts`)- PASS (map keys only)
Source declares `"sense+"`, `"sense-"`, `"out+"`, `"out-"`. Spec map only maps `out+` and `out-`- intentional per the sense-pin note. Map keys `"out+"` and `"out-"` are valid pin labels.

### OTA (`ota.ts`)- PASS
Source declares `"V+"`, `"V-"`, `"Iabc"`, `"OUT+"`, `"OUT"`. Spec active-composites table lists `V+`, `V-`, `Iabc`, `OUT+`, `OUT`. Exact match including the asymmetric `OUT` (not `OUT-`).

### ngspice anchor orderings checked:

| Anchor | TSTALLOC sequence | Spec value claims |
|---|---|---|
| `res/ressetup.c:46-49` | `(posNode,posNode)`, `(negNode,negNode)`, `(posNode,negNode)`, `(negNode,posNode)` | `{ A: "pos", B: "neg" }` → correctly maps to pos/neg |
| `vccs/vccsset.c:43-46` | `(posNode,contPosNode)`, `(posNode,contNegNode)`, `(negNode,contPosNode)`, `(negNode,contNegNode)` | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`- correct |
| `cccs/cccsset.c:49-50` | `(posNode,contBranch)`, `(negNode,contBranch)` | Spec maps only `out+`/`out-` to pos/neg; contBranch resolved via `findBranch`- consistent |
| `vcvs/vcvsset.c:53-58` | pos/neg/branch/contPos/contNeg | `{ "out+": "pos", "out-": "neg", "ctrl+": "contPos", "ctrl-": "contNeg" }`- correct |
| `ccvs/ccvsset.c:58-62` | pos/neg/branch/contBranch | Spec maps `out+`/`out-` only; contBranch via findBranch- consistent |
| `bjt/bjtsetup.c:435-453` (bjtdefs.h:26-28) | BJTcolNode, BJTbaseNode, BJTemitNode | `{ B: "base", C: "col", E: "emit" }`- correct (col, base, emit match field suffixes) |
| `sw/swsetup.c:59-62` | SWposNode, SWnegNode | `{ A1: "pos", B1: "neg" }`- correct |
| `mos1/mos1set.c:186-207` (mos1defs.h:27-30) | MOS1dNode(d), MOS1gNode(g), MOS1sNode(s), MOS1bNode(b) | `{ G: "gate", S: "source", D: "drain" }`- values use JFET-style long names, not MOS1 d/g/s/b- see D3 |
| `jfet/jfetset.c:166-180` (jfetdefs.h:29-31) | JFETdrainNode, JFETgateNode, JFETsourceNode | `{ G: "gate", S: "source", D: "drain" }`- correct (drain, gate, source match field suffixes) |

### Info item

#### I1- `MnaModel` field description states "see `00-engine.md` ssA3.1" without an inline interface fragment (info)

- **Location**: ssMechanism, `MnaModel` subsection: "Same field shape- see `00-engine.md` ssA3.1."
- **Problem**: This is a forward reference without duplication, which is correct practice. However, `00-engine.md` ssA3.1 shows the full `MnaModel` interface including fields that ARE NOT yet present in `src/compile/types.ts` (the current file has `factory`, `getInternalNodeCount`, `getInternalNodeLabels`, `branchCount`- all of which are being replaced/extended by A3.1). The spec correctly treats ssA3.1 as the post-migration interface. The reference is accurate as written. No fix needed, flagging for awareness.
- **Observation**: This is purely informational.
