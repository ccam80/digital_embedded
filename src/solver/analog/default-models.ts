import { SubcircuitModelRegistry } from './subcircuit-model-registry.js';
import { registerBuiltinSubcircuitModels } from './transistor-models/cmos-gates.js';
import { registerCmosDFlipflop } from './transistor-models/cmos-flipflop.js';
import { registerDarlingtonModels } from './transistor-models/darlington.js';

let _subcircuitModels: SubcircuitModelRegistry | null = null;

export function getTransistorModels(): SubcircuitModelRegistry {
  if (!_subcircuitModels) {
    _subcircuitModels = new SubcircuitModelRegistry();
    registerBuiltinSubcircuitModels(_subcircuitModels);
    registerCmosDFlipflop(_subcircuitModels);
    registerDarlingtonModels(_subcircuitModels);
  }
  return _subcircuitModels;
}
