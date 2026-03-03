/**
 * Engine interface — pluggable simulation contract.
 *
 * The editor and renderer always call through this interface. The concrete
 * implementation may run on the main thread or in a Web Worker backed by
 * SharedArrayBuffer. No editor or renderer code imports a concrete engine.
 *
 * BitVector and CompiledCircuit are placeholder types here. Task 1.2.1
 * will define BitVector fully. Task 3.2.1 will define CompiledCircuit fully.
 * These placeholders exist so mock-engine.ts compiles before those tasks land.
 */

export interface BitVector {
  readonly width: number;
  readonly value: bigint;
  toNumber(): number;
  toBigInt(): bigint;
  toString(radix?: number): string;
}

export interface CompiledCircuit {
  readonly netCount: number;
  readonly componentCount: number;
}

export type EngineState = "STOPPED" | "RUNNING" | "PAUSED" | "ERROR";

export type EngineChangeListener = (state: EngineState) => void;

export type EngineMessage =
  | { type: "step" }
  | { type: "microStep" }
  | { type: "runToBreak" }
  | { type: "start" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "dispose" }
  | { type: "setSignal"; netId: number; value: number };

export interface SimulationEngine {
  init(circuit: CompiledCircuit): void;
  reset(): void;
  dispose(): void;

  step(): void;
  microStep(): void;
  runToBreak(): void;

  start(): void;
  stop(): void;

  getState(): EngineState;

  getSignalRaw(netId: number): number;
  getSignalValue(netId: number): BitVector;
  setSignalValue(netId: number, value: BitVector): void;

  addChangeListener(listener: EngineChangeListener): void;
  removeChangeListener(listener: EngineChangeListener): void;
}
