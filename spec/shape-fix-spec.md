# Shape Fix Specification

Complete specification for fixing all component shape, dimension, and pin position
mismatches between the TypeScript port and Java Digital reference.

**Diagnostic baseline** (2026-03-11):
- 1109 dimension mismatches across 6 component types
- 12 pin position mismatches (Mul only)
- 135 orphan wire endpoints across 24 fixtures
- 38 disconnected tunnels across 10 fixtures
- 612 fixture-audit tests (578 pass, 34 fail)
- 139 shape-audit tests (137 pass, 2 fail)

---

## Coordinate System Reference

Java Digital uses pixel coordinates internally:
- `SIZE = 20` pixels = 1 grid unit
- `SIZE2 = 10` pixels = 0.5 grid units
- Y-axis points down
- All `.dig` XML coordinates are in pixels
- **Conversion: divide pixel coords by 20 to get grid units**

---

## Fix 1: Tunnel Bbox Oversized

**Impact**: 960 dimension mismatches, 4 orphan wires

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/TunnelShape.java`

- `HEIGHT = SIZE2 - 2 = 8px = 0.4 grid`
- `WIDTH = round(8 * sqrt(3)) = 14px = 0.7 grid`
- Polygon vertices: `(0,0)`, `(14, 8)`, `(14, -8)` — right-pointing triangle with apex at origin
- Pin: single pin at `(0, 0)`
- Label: drawn at `(WIDTH + SIZE2/2, 0)` = `(0.95, 0)` grid, left-center aligned
- Fill: stroke only at static time; wire-color fill only when 1-bit runtime value available

### Current TS

Source: `src/components/wiring/tunnel.ts`

- `COMP_WIDTH = 2`, `COMP_HEIGHT = 1` — bbox is 2×1 (oversized)
- Triangle vertices correct: `(0,0)`, `(0.7, 0.4)`, `(0.7, -0.4)`
- Fills with `COMPONENT_FILL` always (wrong — should be stroke-only at draw time)
- Label offset: `ARROW_W + 0.15 = 0.85` grid (should be 0.95)
- Bbox origin y: `-0.5` (should be `-0.4`)

### Changes Required

In `src/components/wiring/tunnel.ts`:

1. **`getBoundingBox()`** (lines ~103-110): Change bbox to `{width: 1.0, height: 0.8}`,
   origin y offset to `-0.4` instead of `-COMP_HEIGHT/2`.

2. **`draw()`** (lines ~118-126): Remove `COMPONENT_FILL` fill of the triangle.
   Only stroke the outline with `COMPONENT` color. (Runtime wire-color fill is a
   future feature requiring simulation state access.)

3. **Label x offset** (lines ~144/152): Change from `ARROW_W + 0.15` (0.85) to
   `ARROW_W + 0.25` (0.95) to match Java's `WIDTH + SIZE2/2`.

**Effort**: Trivial (~5 lines changed)

---

## Fix 2: Const — Remove Body Rect, Text Only

**Impact**: 95 dimension mismatches

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/ConstShape.java`

- **No body rectangle at all** — entirely text-based
- Pin: single OUTPUT at `(0, 0)`
- Drawing (line 54-57): text at `(-3, 0)` pixels = `(-0.15, 0)` grid,
  `RIGHTCENTER` alignment (text extends leftward from near the pin), `Style.NORMAL`
- Text content: the formatted constant value

### Current TS

Source: `src/components/io/const.ts`

- Draws a 2×2 filled+stroked rectangle (lines ~109-113) — **fabricated, not in Java**
- Text positioned at center of the 2×2 box (line ~117)
- Text style: bold, size 0.9 (should be NORMAL, not bold)
- Bbox: 2×2 (should be ~1.5×0.6 covering text extent)

### Changes Required

In `src/components/io/const.ts`:

1. **`draw()`**: Delete the `drawRect` calls (fill and stroke). Draw only the
   formatted value text at `(-0.15, 0)` with `{horizontal: "right", vertical: "middle"}`
   alignment, normal weight (not bold).

2. **`getBoundingBox()`**: Change from 2×2 to approximately
   `{x: pos.x - 1.5, y: pos.y - 0.3, width: 1.5, height: 0.6}`. The exact width
   depends on the value string but 1.5 is a reasonable constant for hit-testing.

**Effort**: Small (~15 lines)

---

## Fix 3: Probe — Remove Body Rect, Text Only

**Impact**: 23 dimension mismatches, 2 orphan wires

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/ProbeShape.java`

- **No body rectangle, no circle, no symbol** — entirely text-based
- Pin: single INPUT at `(0, 0)`
- Drawing (lines 66-78):
  - With label: label at `(0.1, -0.2)` grid LEFTBOTTOM, value at `(0.1, 0.2)` grid LEFTTOP
  - Without label: value at `(0.1, -0.05)` grid LEFTCENTER
  - Style: `NORMAL` for both
  - Value text shows `"?"` until simulation provides a value

### Current TS

Source: `src/components/io/probe.ts`

- Draws 2×2 filled+stroked rectangle (lines ~120-126) — **fabricated**
- Draws oscilloscope circle+dot symbol (lines ~129-131) — **fabricated**
- Label positioned at center-top of 2×2 box (lines ~133-139) — wrong position
- Value text not drawn at all — missing entirely
- Bbox: 2×2 (should be ~1.5×0.6)

### Changes Required

In `src/components/io/probe.ts`:

1. **`draw()`**: Delete `drawRect` and `drawCircle` calls entirely. Replace with:
   - If label present: draw label at `(0.1, -0.2)` LEFTBOTTOM, draw `"?"` at `(0.1, 0.2)` LEFTTOP
   - If no label: draw `"?"` at `(0.1, -0.05)` LEFTCENTER
   - Both using NORMAL style

2. **`getBoundingBox()`**: Change from 2×2 to approximately
   `{x: pos.x, y: pos.y - 0.3, width: 1.5, height: 0.6}`.

**Effort**: Small (~20 lines)

---

## Fix 4: Mul — Wrong Pin Layout

**Impact**: 12 pin position mismatches, 8 orphan wires

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/core/arithmetic/Mul.java`

- 2 inputs (a, b), 1 output (mul)
- Uses GenericShape (no custom shape in ShapeFactory)
- GenericShape width = 3 (default), sequential pin placement:
  - `symmetric = true` (1 output), `offs = floor(2/2) = 1`
  - `even = true` (2 inputs), so `correct = 1` for input i >= n/2
  - Input a: `(0, 0)`, Input b: `(0, 2)` (correct=1 applied to b)
  - Output mul: `(3, 1)` (x=width, y=0+offs)

### Current TS

Source: `src/components/arithmetic/mul.ts`

- Width = 4 (wrong, should be 3)
- Uses `layoutPinsOnFace` (centered distribution) instead of GenericShape sequential
- Input a: `(0, 1)` — wrong (should be `(0, 0)`)
- Input b: `(0, 3)` — wrong (should be `(0, 2)`)
- Output mul: `(4, 1)` — wrong (should be `(3, 1)`)

### Changes Required

In `src/components/arithmetic/mul.ts`:

1. Change `COMP_WIDTH` from 4 to 3.

2. Replace pin declarations: switch from `layoutPinsOnFace` to `standardGatePinLayout`
   (same pattern as Add, Sub, Comparator). Pin declarations become:
   ```
   inputs: ["a", "b"], output: "mul", width: 3
   ```
   This will use GenericShape-compatible sequential placement with symmetric offset.

3. Update `getBoundingBox()` width to match.

4. Update `draw()` body rect width if hardcoded.

**Effort**: Small (~10 lines)

---

## Fix 5: Mux flipSelPos Not Wired

**Impact**: 6 orphan wires, 1 disconnected tunnel

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/MuxerShape.java:51`

Selector pin position: `(SIZE, flip ? 0 : inputCount * SIZE)` = `(1, flip ? 0 : inputCount)` grid.
When `flipSelPos=true`, sel pin moves from bottom to top of the mux body.

### Current TS

Source: `src/components/wiring/mux.ts`

- Attribute mapping for `flipSelPos` exists (line ~224-233) and is parsed into props
- But `buildMuxPinDeclarations()` (line ~49) always places sel at `(1, inputCount)`,
  ignoring flip entirely

### Changes Required

In `src/components/wiring/mux.ts`:

1. Add `flipSelPos` parameter to `buildMuxPinDeclarations()` signature (same pattern
   as `buildDemuxPinDeclarations` in `demux.ts` which already handles this correctly).

2. Change sel pin position from `{x: 1, y: muxInputCount}` to
   `{x: 1, y: flipSelPos ? 0 : muxInputCount}`.

3. Pass `flipSelPos` from constructor into the pin builder.

**Effort**: Trivial (~3 lines)

---

## Fix 6: Driver invertDriverOutput Not Supported

**Impact**: 2 orphan wires

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/DriverShape.java:66-69`

When `INVERT_DRIVER_OUTPUT` is true, the output pin moves from `(SIZE, 0)` = `(1, 0)`
to `(SIZE*2, 0)` = `(2, 0)` to make room for the inversion bubble at the output.

### Current TS

Source: `src/components/wiring/driver.ts`

- No attribute mapping for `invertDriverOutput`
- Output pin always at `(1, 0)` regardless of inversion
- The shape audit reference (`getJavaPinPositions` in shape-audit.test.ts) already
  has this property wired, so the diagnostic correctly expects `(2, 0)` when inverted

### Changes Required

In `src/components/wiring/driver.ts`:

1. Add attribute mapping: `{xmlName: "invertDriverOutput", propertyKey: "invertDriverOutput", convert: v => v === "true"}`

2. Add property definition for `invertDriverOutput` (boolean, default false).

3. In `buildDriverPinDeclarations()` (or equivalent), change output pin x from `1`
   to `invertOut ? 2 : 1`.

4. In constructor, extract `invertDriverOutput` from props and pass to pin builder.

**Effort**: Trivial (~5 lines)

---

## Fix 7: Gate Shapes — IEEE/IEC Decoupling + Inversion Bubble

**Impact**: 31 dimension mismatches, 5 orphan wires, visual correctness for all gates

### Problem Summary

Two independent issues conflated in the TS code:

1. **IEEE vs IEC selection**: Java has a global app setting (`Settings.IEEE_SHAPES`)
   that selects between IEEE (curved American shapes) and IEC (rectangular boxes with
   text symbols like "&", "≥1", "=1"). The `wideShape` per-element attribute only
   controls narrow (3 grid) vs wide (4 grid) within the selected style. TS incorrectly
   maps `wideShape=false` → IEC and `wideShape=true` → IEEE.

2. **Missing output inversion bubbles**: NAnd, NOr, XNOr should have an output circle
   (radius 0.45 grid) and the output pin shifted +1 grid unit. This is missing entirely.
   The bbox also needs +1 width for inverted gates.

### Java IEEE Polygon Coordinates (Grid Units, 2-Input Baseline)

All IEEE shapes use GenericShape.createPins() for pin positioning (same as IEC).
The visual difference is the body shape only.

#### AND (IEEEAndShape.java)

Narrow (wideShape=false): Flat left edge at x≈0.05, top at y=-0.5, bottom at y=2.5.
Straight top/bottom from x=0.05 to x=1.5, then two cubic bezier curves forming a
D-shape bulging right to x≈3.0:

```
Vertices (grid):
  (1.5, 2.5) → (0.05, 2.5) → (0.05, -0.5) → (1.5, -0.5)
  Bezier: cp1=(2.0, -0.5) cp2=(3.0, 0) end=(2.95, 1.0)
  Bezier: cp1=(2.95, 2.0) cp2=(2.0, 2.5) end=(1.5, 2.5)
```

Wide (wideShape=true): Same structure, transition at x=2.5, curves to x≈4.0:

```
Vertices (grid):
  (2.5, 2.5) → (0.05, 2.5) → (0.05, -0.5) → (2.5, -0.5)
  Bezier: cp1=(3.0, -0.5) cp2=(4.0, 0) end=(3.95, 1.0)
  Bezier: cp1=(3.95, 2.0) cp2=(3.0, 2.5) end=(2.5, 2.5)
```

#### OR (IEEEOrShape.java)

Narrow: Concave back (left) edge, pointed front meeting at x=3.0:

```
Vertices (grid):
  Start (0.5, 2.5) → line (0.0, 2.5)
  Back bezier: cp1=(0.5, 2.0) cp2=(0.5, 0) end=(0.0, -0.5)
  Line to (0.5, -0.5)
  Front bezier: cp1=(1.0, -0.5) cp2=(2.0, 0) end=(3.0, 1.0)
  Front bezier: cp1=(2.0, 2.0) cp2=(1.0, 2.5) end=(0.5, 2.5)
```

Input wire stubs needed (back edge is concave, pins don't touch body):
- Top/bottom inputs: 0.2 grid stub from (0,y) rightward
- Center input (odd count): 0.35 grid stub

Wide: Transition at x=1.5, front curves to x=4.0. Back curve control points at
(0.5, 1.7) and (0.5, 0.3).

#### XOR (IEEEXOrShape.java)

Same curvature as OR but body shifted right by 0.5 grid (SIZE2). Plus a second
open-stroke back curve at the original OR position creating the XOR double-line mark.

Narrow body back at x≈0.55, front at x=3.0.
Extra back curve (open stroke): `(0.0, 2.5)` → bezier `(0.5, 2.0)(0.5, 0)(0.0, -0.5)`.

Input wire stubs are longer (0.7 grid top/bottom, 0.85 grid center) to bridge
the double-back gap.

Wide: Body back at x≈0.5-1.5, front at x=4.0.

#### NOT (IEEENotShape.java)

Special — implements Shape directly, not IEEEGenericShape. Single input, single output.

Narrow triangle: `(0.05, -0.6)` → `(0.95, 0)` → `(0.05, 0.6)`. Closed.
Bubble: center `(1.5, 0)`, radius `0.45`.
Pins: input `(0, 0)`, output `(2.0, 0)`.

Wide triangle: `(0.05, -1.1)` → `(1.95, 0)` → `(0.05, 1.1)`. Closed.
Bubble: center `(2.5, 0)`, radius `0.45`.
Pins: input `(0, 0)`, output `(3.0, 0)`.

### Inversion Bubble Spec (IEEEGenericShape.java:76-84)

For 2-input inverted gates: circle center at `(pos + 0.5, outputY)` grid,
radius `0.45` grid, where:
- `pos = 3` narrow, `pos = 4` wide (body right edge in grid units)
- `outputY = offs` = `floor(inputCount/2)` for symmetric (1 output)
- Output pin x = `(pos + 1)` grid (past the bubble)

| Gate | Narrow bubble center | Wide bubble center | Narrow out pin | Wide out pin |
|------|---------------------|--------------------|---------------|-------------|
| NAnd | (3.5, 1.0) | (4.5, 1.0) | (4.0, 1.0) | (5.0, 1.0) |
| NOr  | (3.5, 1.0) | (4.5, 1.0) | (4.0, 1.0) | (5.0, 1.0) |
| XNOr | (3.5, 1.0) | (4.5, 1.0) | (4.0, 1.0) | (5.0, 1.0) |

### Bbox Spec

| Gate | Narrow bbox (grid) | Wide bbox (grid) |
|------|--------------------|------------------|
| And  | x:[0, 3], y:[-0.5, 2.5] = 3×3 | x:[0, 4], y:[-0.5, 2.5] = 4×3 |
| NAnd | x:[0, 4], y:[-0.5, 2.5] = **4×3** | x:[0, 5], y:[-0.5, 2.5] = **5×3** |
| Or   | x:[0, 3], y:[-0.5, 2.5] = 3×3 | x:[0, 4], y:[-0.5, 2.5] = 4×3 |
| NOr  | x:[0, 4], y:[-0.5, 2.5] = **4×3** | x:[0, 5], y:[-0.5, 2.5] = **5×3** |
| XOr  | x:[0, 3], y:[-0.5, 2.5] = 3×3 | x:[0, 4], y:[-0.5, 2.5] = 4×3 |
| XNOr | x:[0, 4], y:[-0.5, 2.5] = **4×3** | x:[0, 5], y:[-0.5, 2.5] = **5×3** |
| Not  | x:[0, 2], y:[-0.6, 0.6] = **2×1.2** | x:[0, 3], y:[-1.1, 1.1] = **3×2.2** |

### Changes Required

#### All gate files: `src/components/gates/{and,nand,or,nor,xor,xnor,not}.ts`

1. **Default to IEEE shapes**: In `draw()`, render IEEE (curved) shape by default.
   Render IEC (box) only when `wideShape=false` AND a future `ieeeShapes=false`
   global setting is added. For now, always render IEEE. The `wideShape` flag controls
   narrow (3) vs wide (4) width only.

2. **AND**: Replace the single-bezier egg shape in `_drawIEEE()` with the correct
   flat-left + two-bezier D-shape polygon (vertices above).

3. **OR**: Currently missing IEEE shape entirely (only has IEC box). Add concave
   back edge + pointed front using the polygon vertices above. Add input wire stubs
   (0.2 grid for top/bottom, 0.35 for center).

4. **XOR**: Currently missing IEEE shape. Same as OR but shifted right 0.5, plus
   extra open-stroke back curve. Longer wire stubs (0.7/0.85 grid).

5. **NOT**: Fix triangle vertices to match Java (currently too small). Fix bubble
   radius from 0.3 to 0.45, center from 1.3 to 1.5 (narrow). Fix output pin x
   from 1.0 to 2.0 (narrow) — this is the main orphan wire cause.

#### Shared inversion handling

6. **Output inversion bubble**: Add to NAnd, NOr, XNOr draw methods. Draw circle at
   `(bodyWidth + 0.5, outputY)` radius 0.45 grid. This can be a shared helper.

7. **Output pin shift**: Ensure inverted gates place output pin at `width + 1`
   instead of `width`. Check `standardGatePinLayout` in `src/core/pin.ts` — the
   `invert` parameter should already handle this but verify each gate passes it.

#### Bbox: `src/core/pin.ts` or individual gate `getBoundingBox()`

8. **`getBoundingBox()`**: For inverted gates (NAnd, NOr, XNOr, Not), bbox width
   must include the bubble: add +1 grid unit. For Not, also fix height
   (1.2 narrow, 2.2 wide).

**Effort**: Medium-Large. Each gate needs polygon rewrite. Shared inversion helper
reduces duplication. ~200 lines total across all gate files.

---

## Fix 8: BusSplitter — Full Rewrite

**Impact**: 17 orphan wires

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/core/wiring/BusSplitter.java`,
`ref/Digital/src/main/java/de/neemann/digital/draw/shapes/BusSplitterShape.java`

BusSplitter is a **fundamentally different component** from Splitter. It is a
bidirectional bus splitter with Output Enable control.

Java declares: 1 input (`OE`, 1-bit), N+1 outputs (all bidirectional):
- `outputs[0]` = common bus `D` (multi-bit, bidirectional) at `(0, 0)`
- `outputs[1..bits]` = individual bit lines `D0..D(n-1)` (1-bit each, bidirectional)
  at `(1, i * spreading)` grid

Pin layout (BusSplitterShape.java:47-53):

| Pin | Grid Position | Direction | Width |
|-----|--------------|-----------|-------|
| D (common bus) | `(0, 0)` | OUTPUT (bidirectional) | `bits` |
| OE (control) | `(0, 1)` | INPUT | 1 |
| D0 | `(1, 0)` | OUTPUT (bidirectional) | 1 |
| D1 | `(1, 1*spreading)` | OUTPUT (bidirectional) | 1 |
| ... | ... | ... | ... |
| D(n-1) | `(1, (n-1)*spreading)` | OUTPUT (bidirectional) | 1 |

Total pins for default 8-bit: `1 (OE) + 1 (D) + 8 (D0-D7) = 10`

Length calculation: `(max(inputs.size() + 1, outputs.size() - 1) - 1) * spreading * SIZE + 2`

### Current TS

Source: `src/components/wiring/bus-splitter.ts`

- Treats BusSplitter as a visual variant of Splitter — **completely wrong semantics**
- No OE pin
- Uses "input splitting"/"output splitting" properties from Splitter (wrong)
- For default 8-bit: creates ~4 pins instead of 10
- No bidirectional pin support

### Changes Required

In `src/components/wiring/bus-splitter.ts`:

1. **Complete rewrite of pin declarations**: Remove the Splitter-style split parsing.
   Declare pins as:
   - D (common bus) at `(0, 0)`, direction OUTPUT, width = `bits`
   - OE at `(0, 1)`, direction INPUT, width = 1
   - D0..D(n-1) at `(1, i * spreading)`, direction OUTPUT, width = 1 each

2. **Property definitions**: Use `Bits` (integer, default 8) and `spreading` (integer,
   default 1) — NOT the "input splitting"/"output splitting" strings.

3. **Attribute mappings**: Map `Bits` → `bits`, `spreading` → `spreading`.

4. **Execute function**: Route common bus to individual bits based on OE.
   When OE=1, D is driven by concatenation of D0..Dn. When OE=0, outputs are high-Z.
   Note: full bidirectional support requires high-Z propagation infrastructure.
   For initial fix, implement unidirectional (common → individual) with OE gate.

5. **getBoundingBox()**: Width = 1, height = `max(2, (bits-1) * spreading + 1)`.

6. **draw()**: Draw vertical spine on left, horizontal stubs to right for each bit.
   Label "BS" or component name centered.

**Effort**: High (full rewrite ~100 lines, may need bidirectional pin infrastructure)

---

## Fix 9: CUSTOM Shape — Parse and Render

**Impact**: 48 orphan wires (ALU_complete alone), affects all CUSTOM subcircuits

### Current State

- `shapeType: "CUSTOM"` is recognized in metadata parsing (`dig-loader.ts:335-336`)
- `drawCustomShape()` in `shape-renderer.ts:201-210` is a stub → `drawDefaultShape()`
- The `customShape` XML element is **never parsed**
- `CircuitMetadata` has no field for custom shape data
- Pin positions for CUSTOM mode use `buildDefaultPositions()` (all inputs left, all
  outputs right) — ignoring the explicit custom pin positions in the XML

### Java Reference

Source: `ref/Digital/src/main/java/de/neemann/digital/draw/shapes/custom/CustomShapeDescription.java`,
`ref/Digital/src/main/java/de/neemann/digital/draw/shapes/custom/CustomShape.java`

#### XML Structure

```xml
<entry>
  <string>customShape</string>
  <shape>
    <pins>
      <entry>
        <string>PinName</string>       <!-- must match In/Out label -->
        <pin>
          <pos x="0" y="0"/>            <!-- pixel coords, ÷20 for grid -->
          <showLabel>true</showLabel>
        </pin>
      </entry>
      <!-- ... -->
    </pins>
    <drawables>
      <poly>
        <poly path="M 0,-30 L 80,10 ..." evenOdd="false"/>
        <thickness>4</thickness>
        <filled>true</filled>
        <color><red>255</red><green>255</green><blue>180</blue><alpha>200</alpha></color>
      </poly>
      <line>
        <p1 x="..." y="..."/><p2 x="..." y="..."/>
        <thickness>...</thickness><color>...</color>
      </line>
      <circle>
        <p1 x="..." y="..."/><p2 x="..." y="..."/>  <!-- bounding box corners -->
        <thickness>...</thickness><filled>true/false</filled><color>...</color>
      </circle>
      <text>
        <p1 x="..." y="..."/><p2 x="..." y="..."/>  <!-- anchor + baseline dir -->
        <text>string</text>
        <orientation>LEFTCENTER</orientation>
        <size>20</size><color>...</color>
      </text>
    </drawables>
  </shape>
</entry>
```

#### Pin Name Mapping

CustomShape.java:49-55 maps pins by name: each `In`/`Out` component label in the
subcircuit must match a `<pins>` entry key. Pins are looked up by name, not by order.

#### Rendering Pipeline

1. Iterate all drawables, call draw for each (poly → path, line → line, etc.)
2. Draw label if present
3. For each pin with `showLabel=true`, draw pin name offset ±0.2 grid from pin position

#### Polygon SVG Path

The `<poly path="...">` uses SVG path syntax. Commands: M (moveTo), L (lineTo),
C (cubic bezier), Q (quadratic bezier), Z (closePath). Java's `PolygonParser` handles
these. All coordinates in the path are pixel units (÷20 for grid).

### Changes Required

#### A. Data Model

Add to `src/core/circuit.ts` or new file:

```typescript
interface CustomShapeData {
  pins: Map<string, { pos: { x: number; y: number }; showLabel: boolean }>;
  drawables: CustomDrawable[];
  label?: { pos: { x: number; y: number }; orientation: string; size: number };
}

type CustomDrawable =
  | { type: "poly"; path: string; evenOdd: boolean; thickness: number;
      filled: boolean; color: { r: number; g: number; b: number; a: number } }
  | { type: "line"; p1: Point; p2: Point; thickness: number; color: RGBA }
  | { type: "circle"; p1: Point; p2: Point; thickness: number;
      filled: boolean; color: RGBA }
  | { type: "text"; pos: Point; text: string; orientation: string;
      size: number; color: RGBA };
```

Add `customShape?: CustomShapeData` field to `CircuitMetadata` interface.

#### B. XML Parsing — `src/io/dig-loader.ts`

In `extractCircuitMetadata()`, add handler for `customShape` key:
- Parse `<shape>` → `<pins>` → iterate `<entry>` elements
- Parse `<shape>` → `<drawables>` → iterate `<poly>`, `<line>`, `<circle>`, `<text>`
- **All pixel coordinates ÷ 20** at parse time to store in grid units

#### C. SVG Path Parser

New utility (~200 lines) to parse SVG path strings into abstract `RenderContext`
operations (moveTo, lineTo, curveTo, closePath). This must be engine-agnostic
(no `Path2D` — that ties to Canvas2D, violating the architectural constraint).

The `RenderContext` already has `drawPath()` with `PathOperation[]` — use that.

#### D. Pin Position Override — `src/components/subcircuit/subcircuit.ts`

In `SubcircuitElement` constructor, when `effectiveShapeMode === "CUSTOM"` and
`definition.circuit.metadata.customShape` exists:
- Skip `buildDefaultPositions()` / `buildPositionedPinDeclarations()`
- Look up each interface pin by name from `customShape.pins`
- Use the custom position (already in grid units after parse-time conversion)
- Width/height derived from custom shape bounding box (max extents of all drawables)

#### E. Rendering — `src/components/subcircuit/shape-renderer.ts`

Replace `drawCustomShape()` stub with real implementation:
1. For each drawable:
   - `poly`: parse SVG path string, build `PathOperation[]`, call `ctx.drawPath()`
   - `line`: `ctx.drawLine(p1.x, p1.y, p2.x, p2.y)`
   - `circle`: compute center and radii from bounding box, call `ctx.drawCircle()` or `ctx.drawArc()`
   - `text`: `ctx.drawText()` at position with orientation mapping
2. Set colors from drawable's RGBA (need color conversion to RenderContext format)
3. Set line width from `thickness / 20` (pixel thickness → grid thickness)
4. Draw pin labels where `showLabel === true`, offset ±0.2 grid from pin position

#### F. Bbox — `src/components/subcircuit/subcircuit.ts`

When CUSTOM shape data present, compute bbox from the union of all drawable extents
(parse the path to find min/max x/y) rather than using chipWidth/chipHeight.

### ALU Example Verification

ALU_complete.dig custom shape has 8 pins:
- A at (0,0), Op at (0,20), B at (0,80), Ci at (0,100) — left side inputs
- Y at (80,20), Zero at (80,40), Neg at (80,60), Carry at (80,80) — right side outputs

In grid units (÷20): A(0,0), Op(0,1), B(0,4), Ci(0,5), Y(4,1), Zero(4,2), Neg(4,3), Carry(4,4).

The polygon `M 0,-30 L 80,10 L 80,90 L 0,130 L 0,60 L 30,50 L 0,40 Z` in grid units:
`M 0,-1.5 L 4,0.5 L 4,4.5 L 0,6.5 L 0,3 L 1.5,2.5 L 0,2 Z` — classic ALU trapezoid
with a notch at the carry-in.

**Effort**: Large (~300 lines: data model + XML parsing + SVG path parser + rendering)

---

## Fix 10: Subcircuit LAYOUT — Reassess After Other Fixes

**Impact**: ~24 orphan wires, ~30 disconnected tunnels

### Investigation Result

The `distribute()` algorithm in TS (`subcircuit.ts:285-298`) **matches Java exactly**
for the standard case:
- `delta = floor((length + 2) / (n + 1))`
- `span = delta * (n - 1)`
- `start = floor((length - span) / 2)`

The n=1 and n=2 edge cases also match.

### Remaining Discrepancy: LAYOUT_SHAPE_DELTA

Java supports per-pin custom spacing via `posDeltas` (LayoutShape.java:224-229).
When all pins on a face have `LAYOUT_SHAPE_DELTA > 0`, Java uses custom spacing
instead of even distribution. TS has no equivalent — it always uses even distribution.

This is rarely used in practice and may not affect any current fixtures.

### Root Cause of Remaining Orphans

Most LAYOUT subcircuit orphans are likely **cascading effects** from inner component
bugs (Mul width=4 instead of 3, BusSplitter wrong pin count, etc.). When a subcircuit
contains a wrongly-sized inner component, the subcircuit's derived interface pin
positions shift, causing wires in the parent circuit to miss.

### Plan

1. Implement Fixes 1-9 first.
2. Re-run diagnostics (`fixture-audit.test.ts` + `shape-audit.test.ts`).
3. Count remaining LAYOUT orphans/tunnels.
4. If significant count remains, investigate individual cases to determine if
   `LAYOUT_SHAPE_DELTA` parsing is needed.

**Effort**: Deferred

---

## Implementation Priority Summary

| Order | Fix | Files | Effort | Fixes (dim/pin/orphan/tunnel) |
|-------|-----|-------|--------|-------------------------------|
| 1 | Tunnel bbox | tunnel.ts | Trivial | 960 / 0 / 4 / 0 |
| 2 | Const text-only | const.ts | Small | 95 / 0 / 0 / 0 |
| 3 | Probe text-only | probe.ts | Small | 23 / 0 / 2 / 0 |
| 4 | Mul pin layout | mul.ts | Small | 0 / 12 / 8 / 0 |
| 5 | Mux flipSelPos | mux.ts | Trivial | 0 / 0 / 6 / 1 |
| 6 | Driver invertOut | driver.ts | Trivial | 0 / 0 / 2 / 0 |
| 7 | Gate shapes | gates/*.ts, pin.ts | Med-Large | 31 / 0 / 5 / 0 |
| 8 | BusSplitter | bus-splitter.ts | High | 0 / 0 / 17 / 0 |
| 9 | CUSTOM shape | dig-loader, subcircuit, shape-renderer | Large | 0 / 0 / 48 / 0 |
| 10 | LAYOUT reassess | subcircuit.ts | Deferred | 0 / 0 / ~24 / ~30 |

**Fixes 1-6**: Quick wins, ~50 lines total, fixes 1078 dim + 12 pin + 22 orphans + 1 tunnel.
**Fix 7**: Gate visual overhaul, ~200 lines.
**Fix 8-9**: Heavy lifts, ~400 lines combined.
**Fix 10**: Measure after other fixes.
