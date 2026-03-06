# Phase 4: .dig Parser, File I/O & HGS

**Depends on**: Phase 1 (complete)
**Parallel with**: Phases 2, 3, 5
**Blocks**: Phase 6 (Core Integration)

## Overview

Parse Digital's .dig XML format, load circuits into the visual model, implement the HGS scripting language for parameterized circuits, and provide native JSON save/load. The .dig parser is the primary import path — every existing Digital circuit file must load correctly. HGS enables generic/parameterized circuits where component properties and even circuit structure are computed at load time.

## Binding Decisions

All decisions from `spec/shared-decisions.md` apply. Additionally:

- **XStream reference resolution.** Digital's .dig files use XStream's internal reference syntax (`<rotation reference="../../../../visualElement[3]/..."/>`). The parser resolves these by XPath-like traversal of the DOM. This ensures 100% compatibility with all .dig files.
- **Fail hard on unknown elements.** During development, the parser throws on unrecognized `elementName` values. This surfaces missing component registrations immediately. Can be relaxed to warn-and-skip in a future release for forward compatibility.
- **HGS uses `bigint` for numeric values.** Full Java `Long` (64-bit signed integer) parity. Circuit parameters like ROM addresses and data widths can exceed 2^53.
- **HGS evaluator is async.** `loadHex()` and `loadFile()` require file I/O, which is async in the browser. The entire HGS evaluate chain uses `async/await`. Since HGS runs at circuit load time (not during simulation), the async overhead is invisible.
- **`loadHex()` and `loadFile()` are fully implemented**, not stubbed. In the browser, files come from a pre-loaded file map (populated via `<input type="file">` or drag-and-drop). In Node.js, files are read from the filesystem. Both paths are async.
- **`@xmldom/xmldom` is a runtime dependency** for Node.js headless XML parsing. In the browser, native `DOMParser` is used.

## Reference Source

| What | Where |
|------|-------|
| .dig XML structure | Any `.dig` file + `ref/Digital/src/main/java/de/neemann/digital/draw/elements/` |
| XStream annotations | `ref/Digital/src/main/java/de/neemann/digital/core/element/ElementAttributes.java` |
| Attribute keys & defaults | `ref/Digital/src/main/java/de/neemann/digital/core/element/Keys.java` |
| Circuit loading | `ref/Digital/src/main/java/de/neemann/digital/draw/model/ModelCreator.java` |
| Element library | `ref/Digital/src/main/java/de/neemann/digital/draw/library/ElementLibrary.java` |
| HGS interpreter | `ref/Digital/src/main/java/de/neemann/digital/hdl/hgs/` |
| Generic resolution | `ref/Digital/src/main/java/de/neemann/digital/draw/library/ResolveGenerics.java` |
| Hex importers | `ref/Digital/src/main/java/de/neemann/digital/core/memory/importer/` |
| DataField serialization | `ref/Digital/src/main/java/de/neemann/digital/core/memory/DataField.java` |

---

## Wave 4.1: .dig XML Parser

### Task 4.1.1 — .dig XML Schema Types

- **Description**: Define TypeScript types for the complete .dig XML parse tree. These represent the raw deserialized XML structure before attribute mapping converts them to `PropertyBag` entries.

  The .dig format has these top-level sections:
  - `<version>` — integer (0, 1, or 2)
  - `<attributes>` — circuit-level key-value entries (romContent, Width, Height, Description, isGeneric)
  - `<visualElements>` — array of elements, each with `elementName`, `elementAttributes`, `pos`
  - `<wires>` — array of wires, each with `p1` and `p2` endpoints
  - `<measurementOrdering>` — optional ordered list of signal names for measurement display

  Attribute value types from the XML:
  - `<string>` → `string`
  - `<int>` → `number`
  - `<long>` → `bigint`
  - `<boolean>` → `boolean`
  - `<rotation rotation="N"/>` → `0 | 1 | 2 | 3`
  - `<awt-color>` with `<red>/<green>/<blue>/<alpha>` → `{ r: number; g: number; b: number; a: number }`
  - `<testData><dataString>` → `string`
  - `<inverterConfig>` → `string[]` (list of input names to invert)
  - `<romList>` → ROM data structure
  - `<data>` → `string` (comma-separated hex with run-length encoding)
  - `<value v="N" z="bool"/>` → `{ value: bigint; highZ: boolean }`
  - Enum types (intFormat, direction, barrelShifterMode, etc.) → `string`

- **Files to create**:
  - `src/io/dig-schema.ts`:
    - `DigCircuit` — root parse tree type: `{ version: number; attributes: DigEntry[]; visualElements: DigVisualElement[]; wires: DigWire[]; measurementOrdering?: string[] }`
    - `DigVisualElement` — `{ elementName: string; elementAttributes: DigEntry[]; pos: { x: number; y: number } }`
    - `DigWire` — `{ p1: { x: number; y: number }; p2: { x: number; y: number } }`
    - `DigEntry` — `{ key: string; value: DigValue }`
    - `DigValue` — discriminated union of all attribute value types: `{ type: 'string'; value: string } | { type: 'int'; value: number } | { type: 'long'; value: bigint } | { type: 'boolean'; value: boolean } | { type: 'rotation'; value: 0|1|2|3 } | { type: 'color'; value: { r: number; g: number; b: number; a: number } } | { type: 'testData'; value: string } | { type: 'inverterConfig'; value: string[] } | { type: 'data'; value: string } | { type: 'inValue'; value: { value: bigint; highZ: boolean } } | { type: 'romList'; value: RomListData } | { type: 'enum'; xmlTag: string; value: string }`
    - `RomListData` — ROM manager data structure (detailed based on reference analysis)

- **Tests**:
  - `src/io/__tests__/dig-schema.test.ts::DigSchema::typesAreExhaustive` — verify DigValue discriminated union covers all known XML attribute types by checking type guards for each variant
  - `src/io/__tests__/dig-schema.test.ts::DigSchema::entryStructure` — construct DigEntry values of each type, verify fields accessible with correct types

- **Acceptance criteria**:
  - All .dig attribute value types represented in the type system
  - Discriminated union enables exhaustive `switch` on `type` field
  - All tests pass

---

### Task 4.1.2 — .dig XML Parser

- **Description**: Parse .dig XML into the strongly-typed `DigCircuit` parse tree. Uses browser `DOMParser` or `@xmldom/xmldom` (Node.js). Handles:

  1. **XML to DOM**: Parse XML string to DOM tree.
  2. **Version extraction**: Read `<version>` element.
  3. **Version migration**: Version 0→1 doubles all coordinate values. Version 1→2 updates ROM manager format from `<romList>` to `<romList>` with `ROMManagerFile` structure.
  4. **XStream reference resolution**: When an element has a `reference` attribute (e.g., `<rotation reference="../../../../visualElement[3]/elementAttributes/entry/rotation"/>`), resolve the XPath-like path relative to the current element's position in the DOM tree to find the actual value.
  5. **Attribute value parsing**: For each `<entry>` in `<elementAttributes>`, identify the value element's tag name and parse accordingly: `<string>` → string, `<int>` → number, `<long>` → bigint, `<boolean>` → boolean, `<rotation>` → extract `rotation` attribute, `<awt-color>` → extract r/g/b/a children, `<testData>` → extract `<dataString>` text, `<inverterConfig>` → collect child `<string>` elements, `<data>` → text content, `<value>` → extract `v` and `z` attributes.
  6. **Element extraction**: Walk `<visualElements>`, build `DigVisualElement[]`.
  7. **Wire extraction**: Walk `<wires>`, build `DigWire[]`.
  8. **Measurement ordering**: Extract `<measurementOrdering>` if present.

  Unknown attribute value types (unrecognized XML tag names within entries) are preserved as `{ type: 'enum'; xmlTag: string; value: string }` — this future-proofs against new attribute types added by Digital.

- **Files to create**:
  - `src/io/dig-parser.ts`:
    - `parseDigXml(xml: string): DigCircuit` — main entry point
    - `resolveXStreamReference(refPath: string, contextElement: Element, rootElement: Element): Element` — resolve XStream reference paths
    - `parseAttributeValue(element: Element, rootElement: Element): DigValue` — dispatch on tag name to parse typed value
    - `migrateVersion(circuit: DigCircuit): DigCircuit` — apply version upgrades (0→1→2)
  - `src/io/dom-parser.ts`:
    - `createDomParser(): { parse(xml: string): Document }` — factory that returns browser `DOMParser` or `@xmldom/xmldom` based on environment detection

- **Tests**:
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesAndGateCircuit` — parse `circuits/and-gate.dig`, verify: 5 visual elements (2 In, 1 And, 1 Out, 1 Testcase), 5 wires, version 2, And has `wideShape: true`, In[0] has `Label: "A"`
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesHalfAdder` — parse `circuits/half-adder.dig`, verify: 7 visual elements, 12 wires, XOr and And gates both have `wideShape: true`
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesSrLatch` — parse `circuits/sr-latch.dig`, verify: 6 visual elements (2 In, 2 NOr, 2 Out), feedback wires present
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesTestData` — parse and-gate.dig, verify Testcase element has testData attribute with dataString containing "A B Y"
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesRotation` — parse mux.dig (has rotation attributes), verify Not element has rotation value 3
  - `src/io/__tests__/dig-parser.test.ts::DigParser::resolvesXStreamReference` — parse mux.dig, verify the second Not element (which uses XStream reference to first Not's rotation) resolves to rotation 3
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesInputCount` — parse mux.dig, verify And gates have `Inputs: 3`
  - `src/io/__tests__/dig-parser.test.ts::DigParser::parsesColor` — parse a .dig file with `<awt-color>` (e.g., TafficLight3.dig), verify color has r/g/b/a values
  - `src/io/__tests__/dig-parser.test.ts::DigParser::migratesVersion0` — construct version 0 XML with pos (100,100), parse, verify coordinates doubled to (200,200)
  - `src/io/__tests__/dig-parser.test.ts::DigParser::handlesEmptyCircuit` — parse minimal `<circuit><version>2</version><attributes/><visualElements/><wires/></circuit>`, verify empty arrays
  - `src/io/__tests__/dig-parser.test.ts::DigParser::domParserNodeJs` — verify `createDomParser()` returns a working parser in Node.js environment (uses @xmldom/xmldom)

- **Acceptance criteria**:
  - All three example circuits (`and-gate.dig`, `half-adder.dig`, `sr-latch.dig`) parse correctly
  - XStream reference resolution works for shared rotation values
  - Version migration works for versions 0, 1, and 2
  - All attribute value types parsed correctly
  - Works in both browser (DOMParser) and Node.js (@xmldom/xmldom)
  - All tests pass

---

## Wave 4.2: Attribute Mapping & Circuit Construction

### Task 4.2.1 — Attribute Mapping Framework

- **Description**: Mechanism for converting .dig XML attribute entries into `PropertyBag` entries. Each component type registers `AttributeMapping[]` in its `ComponentDefinition`. The framework provides reusable converter functions for common patterns.

  The attribute mapping pipeline (from Decision 5):
  ```
  DigEntry[] → AttributeMapping[].convert() → PropertyBag → factory(props) → CircuitElement
  ```

  Reusable converters handle Digital's standard attribute patterns:

  | XML attribute | Converter | Output PropertyBag key (typical) |
  |---|---|---|
  | `Bits` (int) | `intConverter('Bits', 'bitWidth')` | `bitWidth: number` |
  | `Inputs` (int) | `intConverter('Inputs', 'inputCount')` | `inputCount: number` |
  | `Value` (long) | `bigintConverter('Value', 'value')` | `value: bigint` |
  | `Default` (long) | `bigintConverter('Default', 'defaultValue')` | `defaultValue: bigint` |
  | `Label` (string) | `stringConverter('Label', 'label')` | `label: string` |
  | `Description` (string) | `stringConverter('Description', 'description')` | `description: string` |
  | `rotation` (rotation) | `rotationConverter()` | `rotation: Rotation` |
  | `wideShape` (boolean) | `boolConverter('wideShape', 'wideShape')` | `wideShape: boolean` |
  | `inverterConfig` | `inverterConfigConverter()` | `inverterConfig: string[]` |
  | `Color` (awt-color) | `colorConverter()` | `color: { r, g, b, a }` |
  | `Testdata` (testData) | `testDataConverter()` | `testData: string` |
  | `Data` (data) | `dataFieldConverter()` | `data: string` (raw comma-separated hex) |
  | `InDefault` (inValue) | `inValueConverter()` | `inDefault: { value: bigint; highZ: boolean }` |
  | `Frequency` (int) | `intConverter('Frequency', 'frequency')` | `frequency: number` |
  | `Signed` (boolean) | `boolConverter('Signed', 'signed')` | `signed: boolean` |
  | `Selector Bits` (int) | `intConverter('Selector Bits', 'selectorBits')` | `selectorBits: number` |
  | `Input Splitting` (string) | `stringConverter('Input Splitting', 'inputSplitting')` | `inputSplitting: string` |
  | `Output Splitting` (string) | `stringConverter('Output Splitting', 'outputSplitting')` | `outputSplitting: string` |

  Unmapped attributes (present in the XML but with no registered mapping) are preserved in a `_unmapped: Map<string, DigValue>` field on the PropertyBag. This prevents data loss on round-trip and helps debugging.

- **Files to create**:
  - `src/io/attribute-map.ts`:
    - `applyAttributeMappings(entries: DigEntry[], mappings: AttributeMapping[]): PropertyBag` — run all mappings, collect unmapped entries
    - Converter factory functions:
      - `stringConverter(xmlName: string, propKey: string): AttributeMapping`
      - `intConverter(xmlName: string, propKey: string): AttributeMapping`
      - `bigintConverter(xmlName: string, propKey: string): AttributeMapping`
      - `boolConverter(xmlName: string, propKey: string): AttributeMapping`
      - `rotationConverter(): AttributeMapping`
      - `inverterConfigConverter(): AttributeMapping`
      - `colorConverter(): AttributeMapping`
      - `testDataConverter(): AttributeMapping`
      - `dataFieldConverter(): AttributeMapping`
      - `inValueConverter(): AttributeMapping`
      - `enumConverter(xmlName: string, propKey: string): AttributeMapping`

- **Tests**:
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::stringConversion` — DigEntry with key "Label", value "A" → PropertyBag has `label: "A"`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::intConversion` — DigEntry with key "Bits", value 8 → PropertyBag has `bitWidth: 8`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::bigintConversion` — DigEntry with key "Value", value 0xFFFFFFFFn → PropertyBag has `value: 0xFFFFFFFFn`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::boolConversion` — DigEntry with key "wideShape", value true → PropertyBag has `wideShape: true`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::rotationConversion` — rotation value 3 → PropertyBag has `rotation: Rotation.CCW_270`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::inverterConfigConversion` — inverterConfig ["A", "B"] → PropertyBag has `inverterConfig: ["A", "B"]`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::colorConversion` — awt-color {r:255,g:0,b:0,a:255} → PropertyBag has `color: {r:255,g:0,b:0,a:255}`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::unmappedPreserved` — entry with no matching mapping → preserved in `_unmapped`
  - `src/io/__tests__/attribute-map.test.ts::AttributeMap::missingAttributeUsesDefault` — no "Bits" entry in XML → PropertyBag omits `bitWidth` (factory uses its own default)

- **Acceptance criteria**:
  - All converter types work correctly
  - Unmapped attributes preserved (no data loss)
  - Missing attributes are omitted (not defaulted — component factory handles defaults)
  - All tests pass

---

### Task 4.2.2 — Circuit Construction from Parsed XML

- **Description**: Transform a `DigCircuit` parse tree into a visual `Circuit` model. For each `DigVisualElement`: look up `elementName` in the `ComponentRegistry`, apply registered `AttributeMapping[]` to produce `PropertyBag`, call `factory(props)` to create `CircuitElement`, position at `pos`. For each `DigWire`: create `Wire` with `p1` and `p2` endpoints. Attach circuit-level metadata (Description, measurement ordering).

  **Unknown element handling**: If `elementName` is not in the registry, throw `DigParserError` with the element name and position. This catches missing component registrations during development.

  **InverterConfig handling**: When an element has `inverterConfig`, the specified input pins get their `isNegated` flag set to `true`. This must happen after the element is created (since pin declarations come from the factory).

  **Rotation handling**: The element's `rotation` property affects pin positions. Pin world-space positions are computed from the element's position + rotation + pin declaration relative positions. This uses the `rotatePoint` and `transformPins` utilities from Phase 1.

- **Files to create**:
  - `src/io/dig-loader.ts`:
    - `loadDigCircuit(parsed: DigCircuit, registry: ComponentRegistry): Circuit` — main entry point
    - `createElementFromDig(ve: DigVisualElement, registry: ComponentRegistry): CircuitElement` — look up, map attributes, create element
    - `applyInverterConfig(element: CircuitElement, config: string[]): void` — set `isNegated` on matching input pins
    - `createWireFromDig(dw: DigWire): Wire` — create Wire from parsed endpoints
    - `extractCircuitMetadata(parsed: DigCircuit): CircuitMetadata` — extract Description, measurement ordering from circuit-level attributes

- **Tests**:
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsAndGate` — parse and-gate.dig, load into Circuit, verify: 5 elements created, 5 wires created, In elements have correct labels ("A", "B"), And element has `wideShape: true` in properties
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::elementsPositionedCorrectly` — load and-gate.dig, verify In "A" at (200,200), And at (300,200)
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::wiresCreatedCorrectly` — load and-gate.dig, verify 5 wires with correct p1/p2 coordinates
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::unknownElementThrows` — DigCircuit with elementName "FutureComponent" not in registry → throws `DigParserError` with descriptive message containing "FutureComponent"
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::inverterConfigApplied` — element with inverterConfig ["A"], verify pin "A" has `isNegated: true`
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::rotationApplied` — element with rotation 1 (90°), verify element's rotation property set correctly
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::testDataExtracted` — load and-gate.dig, verify Testcase element has testData in properties
  - `src/io/__tests__/dig-loader.test.ts::DigLoader::circuitMetadataExtracted` — circuit with Description attribute, verify metadata.description set

- **Acceptance criteria**:
  - and-gate.dig, half-adder.dig, sr-latch.dig all load into valid Circuit objects
  - Elements positioned correctly from XML coordinates
  - InverterConfig correctly negates specified pins
  - Rotation applied to elements
  - Unknown elements throw with descriptive error
  - All tests pass

---

## Wave 4.3: HGS Interpreter

### Task 4.3.1 — HGS Tokenizer

- **Description**: Port Digital's `hdl/hgs/Tokenizer.java`. Lexical analysis of HGS source code into tokens. The tokenizer handles:

  **Token types:**
  - Literals: `NUMBER` (int/long, including hex `0xFF`), `STRING` (double-quoted with escapes `\\`, `\n`, `\r`, `\t`, `\"`), `TRUE`, `FALSE`
  - Identifiers: `IDENT` (alphanumeric + underscore)
  - Operators: `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `~`, `<`, `<=`, `>`, `>=`, `=` (equality/assignment), `!=`, `<<`, `>>>`, `:=` (declaration)
  - Delimiters: `(`, `)`, `{`, `}`, `[`, `]`, `.`, `:`, `;`, `,`
  - Keywords: `if`, `else`, `for`, `while`, `func`, `repeat`, `until`, `return`, `export`
  - Template: `CODEEND` (`?>` or `?}`)
  - Comments: `//` to end of line (skipped)

  The tokenizer tracks line numbers for error reporting.

- **Files to create**:
  - `src/hgs/tokenizer.ts`:
    - `TokenType` enum with all token types
    - `Token` type: `{ type: TokenType; value: string | bigint | number; line: number }`
    - `Tokenizer` class:
      - `constructor(source: string)`
      - `next(): Token` — consume and return next token
      - `peek(): Token` — look ahead without consuming
      - `expect(type: TokenType): Token` — consume and verify type, throw `ParserError` if mismatch
      - `getLine(): number` — current line number

- **Tests**:
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::identifiers` — `"foo bar_1"` → IDENT("foo"), IDENT("bar_1")
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::numbers` — `"42 0xFF 3.14"` → NUMBER(42), NUMBER(255), NUMBER(3.14)
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::strings` — `'"hello\\nworld"'` → STRING("hello\nworld")
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::operators` — `":= = != << >>>"` → DECLARE, EQUAL, NOTEQUAL, SHIFTLEFT, SHIFTRIGHT
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::keywords` — `"if else for while func return export"` → IF, ELSE, FOR, WHILE, FUNC, RETURN, EXPORT
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::templateDelimiter` — `"x := 1; ?>"` → IDENT, DECLARE, NUMBER, SEMICOLON, CODEEND
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::skipsComments` — `"a // comment\nb"` → IDENT("a"), IDENT("b")
  - `src/hgs/__tests__/tokenizer.test.ts::Tokenizer::tracksLineNumbers` — multi-line input, verify tokens have correct line numbers

- **Acceptance criteria**:
  - All Digital HGS token types recognized
  - Hex literals parsed correctly (0xFF → 255)
  - String escape sequences handled
  - Line numbers tracked for error reporting
  - All tests pass

---

### Task 4.3.2 — HGS Parser

- **Description**: Port Digital's `hdl/hgs/Parser.java`. Recursive descent parser producing an AST. The grammar supports:

  **Expressions** (with operator precedence, lowest to highest):
  1. `||` (logical OR)
  2. `^` (XOR)
  3. `&&` (logical AND), `&` (bitwise AND)
  4. `=`, `!=` (equality — in expression context, `=` is equality comparison)
  5. `<`, `<=`, `>`, `>=` (comparison)
  6. `<<`, `>>>` (shift)
  7. `+`, `-` (additive)
  8. `*`, `/`, `%` (multiplicative)
  9. Unary: `-`, `~`, `!` (negation, bitwise NOT, logical NOT)
  10. Postfix: `[index]`, `(args)`, `.field`
  11. Primary: literals, identifiers, `[array]`, `{struct}`, `func`

  **Statements:**
  - Declaration: `name := expr;` — declares new variable
  - Assignment: `name = expr;` — updates existing variable (in statement context, `=` is assignment)
  - Increment/decrement: `name++`, `name--`
  - Block: `{ stmts... }`
  - `if (cond) stmt [else stmt]`
  - `for (init; cond; inc) stmt`
  - `while (cond) stmt`
  - `repeat stmt until cond;`
  - `func name(args...) stmt` — function declaration
  - `return expr;`
  - `export name := expr;` — declare in root scope
  - `= expr;` — output/print expression value (template mode)

  **Template mode:** Text outside `<? ... ?>` is output literally. Code inside `<? ... ?>` is executed. `<? = expr; ?>` prints expression value.

  The parser wraps AST nodes with line number tracking for error messages.

- **Files to create**:
  - `src/hgs/parser.ts`:
    - `parse(source: string): Statement` — parse full HGS program
    - `parseTemplate(source: string): Statement` — parse template mode (text + `<? ?>` blocks)
  - `src/hgs/ast.ts`:
    - Expression node types: `LiteralExpr`, `IdentExpr`, `BinaryExpr`, `UnaryExpr`, `ArrayLiteralExpr`, `StructLiteralExpr`, `FuncExpr`, `IndexExpr`, `CallExpr`, `FieldExpr`
    - Statement node types: `DeclareStmt`, `AssignStmt`, `IncrementStmt`, `BlockStmt`, `IfStmt`, `ForStmt`, `WhileStmt`, `RepeatUntilStmt`, `FuncDeclStmt`, `ReturnStmt`, `ExportStmt`, `OutputStmt`, `ExprStmt`
    - `ASTNode` base with `line: number` for error tracking

- **Tests**:
  - `src/hgs/__tests__/parser.test.ts::Parser::declaration` — `"x := 5;"` → DeclareStmt with name "x", value LiteralExpr(5)
  - `src/hgs/__tests__/parser.test.ts::Parser::assignment` — `"x = 5;"` → AssignStmt with name "x", value LiteralExpr(5)
  - `src/hgs/__tests__/parser.test.ts::Parser::binaryExpression` — `"1 + 2 * 3"` → BinaryExpr(+, 1, BinaryExpr(*, 2, 3)) — correct precedence
  - `src/hgs/__tests__/parser.test.ts::Parser::ifElse` — `"if (x = 1) y := 2; else y := 3;"` → IfStmt with condition, consequent, alternate
  - `src/hgs/__tests__/parser.test.ts::Parser::forLoop` — `"for (i := 0; i < 10; i++) x = i;"` → ForStmt
  - `src/hgs/__tests__/parser.test.ts::Parser::functionDecl` — `"func add(a, b) return a + b;"` → FuncDeclStmt
  - `src/hgs/__tests__/parser.test.ts::Parser::arrayLiteral` — `"[1, 2, 3]"` → ArrayLiteralExpr with 3 elements
  - `src/hgs/__tests__/parser.test.ts::Parser::structLiteral` — `"{width: 8, depth: 256}"` → StructLiteralExpr
  - `src/hgs/__tests__/parser.test.ts::Parser::fieldAccess` — `"this.Bits"` → FieldExpr on IdentExpr("this")
  - `src/hgs/__tests__/parser.test.ts::Parser::chainedAccess` — `"obj.field[0](arg)"` → CallExpr(IndexExpr(FieldExpr(...)))
  - `src/hgs/__tests__/parser.test.ts::Parser::templateMode` — `"text <? x := 1; = x; ?> more"` → outputs "text", executes code, outputs " more"
  - `src/hgs/__tests__/parser.test.ts::Parser::syntaxErrorReportsLine` — invalid syntax, verify error includes line number

- **Acceptance criteria**:
  - All HGS language constructs parse correctly
  - Operator precedence matches Digital's implementation
  - Template mode works (`<? ?>` delimiters)
  - Parse errors include line numbers
  - All tests pass

---

### Task 4.3.3 — HGS Evaluator & Runtime

- **Description**: Port Digital's `Context.java`, `Value.java`, `Expression.java`, `Statement.java`. The evaluator walks the AST and executes it. All evaluation is **async** (`async/await`) to support `loadHex()` and `loadFile()` file I/O.

  **Context (scope chain):**
  - Hierarchical parent-child scope
  - `declareVar(name, value)` — new variable in current scope
  - `setVar(name, value)` — update existing variable (walks parent chain)
  - `getVar(name)` — lookup (walks parent chain to root)
  - `exportVar(name, value)` — declare in root scope (for `export` keyword)
  - `print(str)` — append to output buffer (for template mode)
  - `rootPath` — base directory for file resolution

  **Type system (using bigint):**
  - `bigint` — integer values (all HGS `Long` operations)
  - `number` — floating-point values (HGS `Double`)
  - `string` — text
  - `boolean` — true/false
  - `HGSArray` — dynamic arrays (backed by `any[]`)
  - `HGSMap` — struct/maps (backed by `Map<string, any>`)
  - `HGSFunction` — first-class functions with closures

  **Type coercion:**
  - Arithmetic: if either operand is `number`, promote to number; otherwise use bigint
  - Bitwise: bigint only
  - Logical (`&&`, `||`): convert to boolean (0n/0/false = false, everything else = true)
  - String `+`: if either operand is string, concatenate
  - Comparison: works on bigint, number, and string

  **Built-in functions (~25):**
  - Math: `ceil`, `floor`, `round`, `abs`, `min`, `max`, `random`
  - Type: `int` (→ bigint), `float` (→ number)
  - Bit: `bitsNeededFor` (minimum bits to represent unsigned value)
  - String: `splitString`, `identifier`, `startsWith`
  - I/O: `print`, `println`, `printf`, `format`, `output`, `log`
  - Control: `panic` (throw error), `isPresent` (try-evaluate, return boolean)
  - Data: `sizeOf` (array length)
  - File: `loadHex(filename, dataBits, bigEndian?)`, `loadFile(filename)` — **async**, see task 4.3.5

  **Return mechanism:** `return` throws a `ReturnValue` sentinel (caught by function call handler). Preserves Java implementation pattern.

- **Files to create**:
  - `src/hgs/context.ts`:
    - `HGSContext` class with scope chain, variable management, output buffer, root path
    - `createRootContext(fileResolver: FileResolver): HGSContext` — root context with all built-in functions registered
  - `src/hgs/value.ts`:
    - `HGSValue` type union: `bigint | number | string | boolean | HGSArray | HGSMap | HGSFunction | null`
    - `toBigint(v: HGSValue): bigint`, `toNumber(v: HGSValue): number`, `toBool(v: HGSValue): boolean`, `toString(v: HGSValue): string`
    - `HGSArray` class: `get(i)`, `set(i, v)`, `add(v)`, `size()`
    - `HGSMap` class: `get(key)`, `set(key, v)`, `has(key)`
    - `HGSFunction` class: wraps function definition + captured context
  - `src/hgs/evaluator.ts`:
    - `evaluate(node: ASTNode, ctx: HGSContext): Promise<HGSValue>` — async recursive evaluator
    - `evaluateExpr(expr: Expression, ctx: HGSContext): Promise<HGSValue>`
    - `executeStmt(stmt: Statement, ctx: HGSContext): Promise<void>`
  - `src/hgs/builtins.ts`:
    - All ~25 built-in functions as `HGSFunction` instances
    - `registerBuiltins(ctx: HGSContext): void`

- **Tests**:
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::arithmetic` — `"x := 3 + 4 * 2;"` → x = 11n (bigint)
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::bitwiseOps` — `"x := 0xFF & 0x0F;"` → x = 15n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::stringConcat` — `"x := \"hello\" + 42;"` → x = "hello42"
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::ifElse` — `"x := 0; if (1 = 1) x = 1; else x = 2;"` → x = 1n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::forLoop` — `"sum := 0; for (i := 0; i < 5; i++) sum = sum + i;"` → sum = 10n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::whileLoop` — `"x := 10; while (x > 0) x = x - 1;"` → x = 0n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::functionDeclAndCall` — `"func add(a, b) return a + b; x := add(3, 4);"` → x = 7n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::closures` — function captures parent scope variable, verify closure works
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::arrays` — `"a := [1, 2, 3]; x := a[1];"` → x = 2n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::structs` — `"m := {width: 8}; x := m.width;"` → x = 8n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::structFieldAssign` — `"m := {width: 8}; m.width = 16; x := m.width;"` → x = 16n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::bitsNeededFor` — `"x := bitsNeededFor(255);"` → x = 8n
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::exportToRoot` — `"export x := 42;"` → variable "x" accessible in root context
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::templateOutput` — template `"Width is <? = 8; ?> bits"` → output "Width is 8 bits"
  - `src/hgs/__tests__/evaluator.test.ts::Evaluator::runtimeErrorHasLine` — division by zero on line 3, verify error message includes "line 3"

- **Acceptance criteria**:
  - All HGS language features evaluate correctly
  - bigint used for all integer operations
  - Scope chain and closures work
  - Built-in functions produce correct results
  - Template mode produces correct output
  - Errors include line numbers
  - All evaluation is async
  - All tests pass

---

### Task 4.3.4 — HGS Reference System

- **Description**: Port Digital's `refs/` subpackage. References are l-value abstractions — they represent assignable locations in the HGS runtime (variables, array elements, struct fields). References compose for chained access like `obj.field[index]`.

  **Reference types:**
  - `ReferenceToVar(name)` — reads/writes a variable in the context
  - `ReferenceToArray(parent, indexExpr)` — indexed access on an array
  - `ReferenceToStruct(parent, fieldName)` — field access on a map/struct
  - `ReferenceToFunc(parent, args)` — function call (for chained calls)

  References are used by the parser whenever the left side of an assignment or declaration is parsed. A simple `x = 5` produces `ReferenceToVar("x").set(ctx, 5)`. A complex `obj.data[i] = 5` produces `ReferenceToArray(ReferenceToStruct(ReferenceToVar("obj"), "data"), i).set(ctx, 5)`.

- **Files to create**:
  - `src/hgs/refs.ts`:
    - `Reference` interface: `{ get(ctx: HGSContext): Promise<HGSValue>; set(ctx: HGSContext, value: HGSValue): Promise<void>; declare(ctx: HGSContext, value: HGSValue): Promise<void> }`
    - `ReferenceToVar` class
    - `ReferenceToArray` class (wraps parent Reference + index Expression)
    - `ReferenceToStruct` class (wraps parent Reference + field name)
    - `ReferenceToFunc` class (wraps parent Reference + argument Expressions)

- **Tests**:
  - `src/hgs/__tests__/refs.test.ts::Reference::varReadWrite` — declare "x" = 5, ReferenceToVar("x").get() → 5, .set(10), .get() → 10
  - `src/hgs/__tests__/refs.test.ts::Reference::arrayAccess` — array [10, 20, 30], ReferenceToArray(var, 1).get() → 20, .set(99), .get() → 99
  - `src/hgs/__tests__/refs.test.ts::Reference::structAccess` — struct {a: 1}, ReferenceToStruct(var, "a").get() → 1, .set(2), .get() → 2
  - `src/hgs/__tests__/refs.test.ts::Reference::chainedAccess` — `obj.data[0]` → ReferenceToArray(ReferenceToStruct(ReferenceToVar("obj"), "data"), 0) — verify read and write

- **Acceptance criteria**:
  - All reference types support get, set, declare
  - Chained references compose correctly
  - All references are async
  - All tests pass

---

### Task 4.3.5 — File I/O: loadHex and loadFile

- **Description**: Implement `loadHex()` and `loadFile()` HGS built-in functions with environment-aware file resolution.

  **`loadHex(filename, dataBits, bigEndian?)`:**
  1. Resolve filename via the `FileResolver` (see below)
  2. Auto-detect format:
     - If content starts with `v2.0 raw` → Logisim raw hex format (comma/space-separated hex values, supports `count*value` run-length encoding)
     - If content starts with `:` → Intel HEX format (standard `:LLAAAATT...CC` lines)
     - Otherwise → raw binary
  3. Parse into `DataField` (array of bigint values, one per address)
  4. Return `DataField` to HGS as an `HGSArray`

  **`loadFile(filename)`:** Resolve filename, return file contents as string.

  **`FileResolver` interface:**
  ```typescript
  interface FileResolver {
    resolve(filename: string, rootPath: string): Promise<Uint8Array>;
  }
  ```

  Two implementations:
  - `NodeFileResolver` — uses `fs.readFile()` with path resolution relative to rootPath
  - `BrowserFileResolver` — looks up filename in a pre-loaded `Map<string, Uint8Array>` (populated by `<input type="file">`, drag-and-drop, or `fetch()`). Throws descriptive error if file not found, suggesting the user load the file.

  **DataField parsing (also used for `Data` attribute in .dig files):**
  - Comma-separated hex values: `"0,1,2,ff,100"` → `[0n, 1n, 2n, 255n, 256n]`
  - Run-length encoding: `"4*0,ff"` → `[0n, 0n, 0n, 0n, 255n]`
  - Intel HEX record parsing: address records, data records, extended address records
  - Raw binary: byte-at-a-time, packed into dataBits-wide words (with endianness)

- **Files to create**:
  - `src/hgs/file-resolver.ts`:
    - `FileResolver` interface
    - `NodeFileResolver` class
    - `BrowserFileResolver` class with `addFile(name: string, data: Uint8Array)` for pre-loading
  - `src/io/data-field.ts`:
    - `DataField` class: `{ data: bigint[]; getWord(addr: number): bigint; setWord(addr: number, val: bigint): void; size(): number; trim(): DataField }`
    - `parseDataFieldString(s: string): DataField` — parse comma-separated hex with RLE
    - `serializeDataField(df: DataField): string` — serialize back to comma-separated hex with RLE
  - `src/io/hex-import.ts`:
    - `importHex(data: Uint8Array, dataBits: number, bigEndian: boolean): DataField` — auto-detect format and parse
    - `parseLogisimHex(text: string): DataField` — `v2.0 raw` format
    - `parseIntelHex(text: string, dataBits: number, bigEndian: boolean): DataField` — Intel HEX format
    - `parseBinaryFile(data: Uint8Array, dataBits: number, bigEndian: boolean): DataField` — raw binary

- **Tests**:
  - `src/io/__tests__/data-field.test.ts::DataField::parseSimple` — `"0,1,2,ff"` → [0n, 1n, 2n, 255n]
  - `src/io/__tests__/data-field.test.ts::DataField::parseRunLength` — `"4*0,ff"` → [0n, 0n, 0n, 0n, 255n]
  - `src/io/__tests__/data-field.test.ts::DataField::serializeRoundTrip` — parse → serialize → parse produces same data
  - `src/io/__tests__/data-field.test.ts::DataField::trimTrailingZeros` — `[1n, 2n, 0n, 0n]` trimmed → size 2
  - `src/io/__tests__/hex-import.test.ts::HexImport::logisimFormat` — `"v2.0 raw\n0 1 2 3 ff"` → [0n, 1n, 2n, 3n, 255n]
  - `src/io/__tests__/hex-import.test.ts::HexImport::logisimRunLength` — `"v2.0 raw\n4*0 ff"` → [0n, 0n, 0n, 0n, 255n]
  - `src/io/__tests__/hex-import.test.ts::HexImport::intelHexBasic` — valid Intel HEX record, verify correct bytes extracted at correct addresses
  - `src/io/__tests__/hex-import.test.ts::HexImport::intelHexExtendedAddress` — Intel HEX with extended address record (type 04), verify 32-bit address handling
  - `src/io/__tests__/hex-import.test.ts::HexImport::binaryFile8bit` — 4 bytes [0x01, 0x02, 0x03, 0x04] with dataBits=8 → [1n, 2n, 3n, 4n]
  - `src/io/__tests__/hex-import.test.ts::HexImport::binaryFile16bitLE` — 4 bytes with dataBits=16, little-endian → [0x0201n, 0x0403n]
  - `src/io/__tests__/hex-import.test.ts::HexImport::binaryFile16bitBE` — 4 bytes with dataBits=16, big-endian → [0x0102n, 0x0304n]
  - `src/io/__tests__/hex-import.test.ts::HexImport::autoDetectsFormat` — importHex auto-detects Logisim vs Intel HEX vs binary
  - `src/hgs/__tests__/file-resolver.test.ts::BrowserFileResolver::findsPreloadedFile` — add file "rom.hex", resolve("rom.hex") returns data
  - `src/hgs/__tests__/file-resolver.test.ts::BrowserFileResolver::throwsOnMissing` — resolve("missing.hex") throws descriptive error

- **Acceptance criteria**:
  - Logisim raw hex format parsed correctly (with run-length encoding)
  - Intel HEX format parsed correctly (with extended address records)
  - Raw binary format parsed correctly (with endianness)
  - DataField serialization is round-trip stable
  - Browser file resolver uses pre-loaded map
  - Node.js file resolver reads from filesystem
  - loadHex() HGS built-in works end-to-end
  - All tests pass

---

### Task 4.3.6 — HGS Test Suite

- **Description**: Comprehensive test suite porting Digital's `ParserTest.java`. Tests cover the full HGS language: variables, control flow, functions, closures, recursion, arrays, maps, template mode, built-in functions, and error cases. Ensures behavioral parity with the Java implementation.

- **Files to create**:
  - `src/hgs/__tests__/hgs-parity.test.ts` — parity tests ported from `ParserTest.java`:
    - `::Parity::variables` — `:=` declaration, `=` assignment, scope
    - `::Parity::controlFlow` — if/else, for, while, repeat/until
    - `::Parity::functions` — declaration, calls, return values
    - `::Parity::closures` — function captures parent scope, modifies captured var
    - `::Parity::recursion` — factorial function, Fibonacci
    - `::Parity::arrays` — creation, access, push, iteration
    - `::Parity::maps` — creation, field access, field assignment
    - `::Parity::templateMode` — mixed text and code output
    - `::Parity::builtins` — bitsNeededFor, ceil, floor, round, min, max, abs, sizeOf, splitString, format
    - `::Parity::errorCases` — undefined variable, type error, division by zero, index out of bounds

- **Acceptance criteria**:
  - All tests ported from Digital's `ParserTest.java` pass
  - Behavioral parity with Java implementation confirmed
  - Error messages include source location
  - All tests pass

---

## Wave 4.4: Native Save/Load Format

### Task 4.4.1 — JSON Save

- **Description**: Serialize a `Circuit` to JSON. The native save format preserves the visual model: elements with their type names, properties, positions, rotations; wires with endpoints; circuit metadata (name, description, test data, measurement ordering). Format version field for future migration. Stable key ordering for diff-friendly output.

  The JSON format directly serializes `PropertyBag` values — no attribute mapping needed (that's only for .dig import). `bigint` values are serialized as strings with a `"_bigint:"` prefix to survive JSON round-trip (JSON has no native bigint).

- **Files to create**:
  - `src/io/save.ts`:
    - `serializeCircuit(circuit: Circuit): string` — produce JSON string with sorted keys
    - `SAVE_FORMAT_VERSION = 1`
  - `src/io/save-schema.ts`:
    - `SavedCircuit` type: `{ version: number; metadata: SavedMetadata; elements: SavedElement[]; wires: SavedWire[] }`
    - `SavedElement`: `{ typeName: string; properties: Record<string, unknown>; position: { x: number; y: number }; rotation?: number }`
    - `SavedWire`: `{ p1: { x: number; y: number }; p2: { x: number; y: number } }`

- **Tests**:
  - `src/io/__tests__/save.test.ts::Save::serializesSimpleCircuit` — circuit with 2 elements and 1 wire, verify valid JSON output, verify version field present
  - `src/io/__tests__/save.test.ts::Save::stableKeyOrdering` — serialize same circuit twice, verify identical output (deterministic)
  - `src/io/__tests__/save.test.ts::Save::preservesBigint` — element with bigint property value, verify serialized as `"_bigint:42"` string
  - `src/io/__tests__/save.test.ts::Save::includesMetadata` — circuit with description and measurement ordering, verify present in output

- **Acceptance criteria**:
  - Circuit serializes to valid JSON
  - Stable/deterministic output (sorted keys)
  - bigint values survive round-trip via string encoding
  - All tests pass

---

### Task 4.4.2 — JSON Load

- **Description**: Deserialize JSON back to `Circuit`. Validates structure with Zod schema. Handles format version checking and future migration. Restores `PropertyBag` values, creates elements via registry factory, reconstructs wires.

  bigint values are detected by the `"_bigint:"` prefix and converted back to native bigint.

- **Files to create**:
  - `src/io/load.ts`:
    - `deserializeCircuit(json: string, registry: ComponentRegistry): Circuit` — parse, validate, construct
    - `SavedCircuitSchema` — Zod schema for validation
    - `migrateSavedCircuit(saved: SavedCircuit): SavedCircuit` — version migration (currently no-op for v1)

- **Tests**:
  - `src/io/__tests__/load.test.ts::Load::roundTrip` — create circuit → serialize → deserialize → verify elements, wires, properties match
  - `src/io/__tests__/load.test.ts::Load::validatesSchema` — invalid JSON structure → throws with Zod validation error
  - `src/io/__tests__/load.test.ts::Load::restoresBigint` — `"_bigint:42"` in JSON → bigint 42n in PropertyBag
  - `src/io/__tests__/load.test.ts::Load::unknownVersionThrows` — version 99 → throws with descriptive error
  - `src/io/__tests__/load.test.ts::Load::unknownComponentThrows` — element with typeName not in registry → throws

- **Acceptance criteria**:
  - Save → load round-trip preserves all circuit data
  - Zod validation catches malformed input
  - bigint restoration works
  - Version checking works
  - All tests pass

---

### Task 4.4.3 — Headless .dig Loading (SimulatorFacade Loader Module)

- **Description**: Implement the `loader` module for the SimulatorFacade (composed architecture from Phase 2). `loadDig(pathOrXml)` parses .dig XML and produces a `Circuit`.

  In Node.js: if the argument starts with `<`, parse as XML directly. Otherwise, treat as a file path and read via `fs.readFile()`. Uses `@xmldom/xmldom` for DOM parsing.

  In the browser: if the argument starts with `<`, parse as XML using native `DOMParser`. Otherwise, treat as a URL and `fetch()` it.

  The loader chains: XML string → `parseDigXml()` (4.1.2) → `DigCircuit` → `loadDigCircuit()` (4.2.2) → `Circuit`.

- **Files to create**:
  - `src/headless/loader.ts`:
    - `SimulationLoader` class:
      - `constructor(registry: ComponentRegistry)`
      - `loadDig(pathOrXml: string): Promise<Circuit>` — async to support fetch/readFile
      - `loadJson(json: string): Circuit` — synchronous JSON load

- **Tests**:
  - `src/headless/__tests__/loader.test.ts::Loader::loadsDigFromXml` — pass and-gate.dig XML string, verify Circuit with correct elements
  - `src/headless/__tests__/loader.test.ts::Loader::loadsDigFromFile` — pass path to and-gate.dig file (Node.js), verify Circuit loads
  - `src/headless/__tests__/loader.test.ts::Loader::detectsXmlVsPath` — XML string (starts with `<`) vs file path, verify correct code path taken
  - `src/headless/__tests__/loader.test.ts::Loader::loadsJsonRoundTrip` — save circuit to JSON, load via `loadJson()`, verify match

- **Acceptance criteria**:
  - .dig XML strings load correctly
  - .dig files load correctly from filesystem (Node.js)
  - JSON load works
  - Environment detection (browser vs Node.js) works
  - All tests pass

---

## Wave 4.5: Generic Circuit Resolution

### Task 4.5.1 — HGS Generic Circuit Resolution

- **Description**: Port Digital's `ResolveGenerics.java`. When a circuit has `isGeneric: true`, its `GenericInitCode` and `GenericCode` elements contain HGS scripts that parameterize the circuit at load time.

  Resolution pipeline:
  1. Find `GenericInitCode` elements (with `enabled: true` — disabled ones are alternative parameter sets). Execute their HGS code to produce an `args` context with parameter declarations.
  2. For each element with a `generic` attribute: create an HGS context with `args` (from step 1) and `this` (the element's current attributes). Execute the HGS code, which may modify `this.*` attributes (e.g., `this.Inputs = args.inputs`).
  3. For `GenericCode` elements: execute HGS code with `args`, `this`, and circuit-building functions (`addComponent(typeName, x, y)`, `addWire(x1, y1, x2, y2)`). The code programmatically generates circuit structure.
  4. Produce a resolved (non-generic) circuit with all parameters baked in.

  Results should be cached by argument hash for performance (same generic circuit instantiated multiple times with same args reuses the result).

- **Files to create**:
  - `src/io/resolve-generics.ts`:
    - `resolveGenericCircuit(circuit: Circuit, args: Map<string, HGSValue>, registry: ComponentRegistry, fileResolver: FileResolver): Promise<Circuit>` — resolve a generic circuit with given arguments
    - `isGenericCircuit(circuit: Circuit): boolean` — check if circuit has `isGeneric: true`
    - `GenericResolutionCache` class: caches resolved circuits by argument hash

- **Files to modify**:
  - `src/io/dig-loader.ts` — after loading a circuit, check if it's generic. If so, resolve it. Note: for subcircuits (Phase 6), the parent circuit provides the `args`.

- **Tests**:
  - `src/io/__tests__/resolve-generics.test.ts::Generic::resolvesInitCode` — circuit with `GenericInitCode` declaring `inputs := 8`, verify args context has `inputs = 8n`
  - `src/io/__tests__/resolve-generics.test.ts::Generic::modifiesComponentAttributes` — And gate with `this.Inputs = args.inputs`, verify And's inputCount property set to 8
  - `src/io/__tests__/resolve-generics.test.ts::Generic::generatesCircuitStructure` — GenericCode with `addComponent("In", 0, 0)`, verify new In element added to circuit
  - `src/io/__tests__/resolve-generics.test.ts::Generic::disabledInitCodeIgnored` — GenericInitCode with `enabled: false`, verify its code not executed
  - `src/io/__tests__/resolve-generics.test.ts::Generic::cachesResults` — resolve same generic circuit twice with same args, verify second call returns cached result (same reference)
  - `src/io/__tests__/resolve-generics.test.ts::Generic::genAndExample` — load `ref/Digital/src/main/dig/generic/modify/genAnd.dig`, resolve with default args, verify correct number of inputs on And gate

- **Acceptance criteria**:
  - GenericInitCode parameter declaration works
  - Component attribute modification via `this.*` works
  - Circuit structure generation via `addComponent`/`addWire` works
  - Disabled init code blocks ignored
  - Caching works
  - Real generic .dig files from the reference resolve correctly
  - All tests pass
