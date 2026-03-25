export { UnionFind } from "./union-find.js";
export { compileUnified } from "./compile.js";
export { resolveModelAssignments, extractConnectivityGroups } from "./extract-connectivity.js";
export type { ModelAssignment } from "./extract-connectivity.js";

export type {
  ResolvedGroupPin,
  ConnectivityGroup,
  PartitionedComponent,
  BridgeDescriptor,
  BridgeStub,
  SolverPartition,
  BridgeAdapter,
  SignalAddress,
  SignalValue,
  CompiledCircuitUnified,
  CompiledDigitalDomain,
  CompiledAnalogDomain,
  Diagnostic,
  Wire,
  CircuitElement,
  ComponentDefinition,
  DigitalModel,
  AnalogModel,
  PinElectricalSpec,
  CrossEngineBoundary,
} from "./types.js";
