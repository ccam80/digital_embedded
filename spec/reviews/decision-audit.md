# Decision Audit: Unified Model System Spec

## Result: All 25 decisions PRESENT. Zero MISSING. Zero INCONSISTENT. No internal contradictions.

| # | Decision | Verdict |
|---|----------|---------|
| 1 | ModelEntry always carries paramDefs | PRESENT |
| 2 | No `factory: null` sentinel | PRESENT |
| 3 | ModelEntry.params owns defaults | PRESENT |
| 4 | PropertyBag explicitly partitioned | PRESENT |
| 5 | Serialization saves deltas only | PRESENT |
| 6 | ModelSwitchCommand (single command) | PRESENT |
| 7 | Digital models stay OUT of ModelEntry | PRESENT |
| 8 | Factories never serialized | PRESENT |
| 9 | Runtime and serialized forms | PRESENT |
| 10 | No old-format migration | PRESENT |
| 11 | .MODEL inherits paramDefs; .SUBCKT derives | PRESENT |
| 12 | defineModelParams() return type | PRESENT |
| 13 | AnalogFactory named type, 5 params | PRESENT |
| 14 | Cut the poison first | PRESENT |
| 15 | T3+T4 same agent | PRESENT |
| 16 | 80 component files | PRESENT |
| 17 | CMOS netlists absorbed | PRESENT |
| 18 | Entire old infrastructure deleted | PRESENT |
| 19 | Test fixture rule | PRESENT |
| 20 | Three-surface testing for Wave 4 | PRESENT |
| 21 | NJFET/PJFET in SPICE_TYPE_TO_COMPONENT | PRESENT |
| 22 | hasDigitalModel() retained | PRESENT |
| 23 | Verification conditions expanded | PRESENT |
| 24 | T2 deletion table with caller inventory | PRESENT |
| 25 | PropertyBag partition API signatures | PRESENT |

## Minor Observation

`ModelEntry.params` is typed as `Record<string, number>` while `replaceModelParams()` accepts `Record<string, PropertyValue>`. This is not a contradiction (number is a subtype of PropertyValue) but is a type-level asymmetry implementers should be aware of.
