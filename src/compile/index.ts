export { UnionFind } from "./union-find.js";
export { compileUnified } from "./compile.js";
export { resolveModelAssignments, extractConnectivityGroups } from "./extract-connectivity.js";
export type { ModelAssignment } from "./extract-connectivity.js";

export type { SimulationCoordinator } from "../solver/coordinator-types.js";
export { DefaultSimulationCoordinator } from "../solver/coordinator.js";

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
  MnaModel,
  PinElectricalSpec,
} from "./types.js";
