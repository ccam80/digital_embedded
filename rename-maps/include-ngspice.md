# Rename map — `include-ngspice` (engine `CKTcircuit` context), ngspice → digiTS

`tsFile`: `src/solver/analog/ckt-context.ts`

Documentation only. The verifier re-derives equivalence independently; a wrong
row here cannot produce a false APPLIED. Kept accurate for cross-hunk
consistency.

## Identifiers

| ngspice (v41) | digiTS | Notes |
|---|---|---|
| `CKTcircuit` (struct) | `CKTCircuitContext` (class) | `ckt-context.ts`; the engine circuit context |
| `ckt->CKTepsmin` | `this.cktEpsmin` | `cktdefs.h:323`; minimum log-argument floor (diode/VDMOS sat-current), default `1e-28` (`cktinit.c:94`) |
| `ckt->CKTindverbosity` | `this.cktIndVerbosity` | `cktdefs.h:111`; inductive-coupling check control |
| `task->TSKepsmin` (`option epsmin`) | `params.epsmin` override | `cktdojob.c:110`; constructor + `refreshTolerances` hot-reload |
| `DEVnameHash` / `MODnameHash` | (no counterpart) | shell device/model symbol tables; not engine value state |
| `noise_input` (`GENinstance *`) | (no counterpart) | noise-analysis input source id; noise unimplemented (analysis-scope.md) |
