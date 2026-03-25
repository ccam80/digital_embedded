/**
 * Shared lazily-built TransistorModelRegistry with all known models.
 *
 * Provides a single getTransistorModels() entry point used by both
 * DefaultSimulatorFacade and SimulationRunner.
 */
import { TransistorModelRegistry } from './transistor-model-registry.js';
import { registerAllCmosGateModels } from './transistor-models/cmos-gates.js';
import { registerCmosDFlipflop } from './transistor-models/cmos-flipflop.js';
import { registerDarlingtonModels } from './transistor-models/darlington.js';

let _transistorModels: TransistorModelRegistry | null = null;

export function getTransistorModels(): TransistorModelRegistry {
  if (!_transistorModels) {
    _transistorModels = new TransistorModelRegistry();
    registerAllCmosGateModels(_transistorModels);
    registerCmosDFlipflop(_transistorModels);
    registerDarlingtonModels(_transistorModels);
  }
  return _transistorModels;
}
