/**
 * Behavioral analog factories for JK, RS, T, D, and async flip-flop variants.
 *
 * This file is a thin re-export from the behavioral-flipflop/ directory.
 * See individual files for implementation details.
 *
 * Pin node-ID ordering follows each component's pin declarations:
 *
 *   JK:       nodeIds[0]=J,   nodeIds[1]=C,   nodeIds[2]=K,   nodeIds[3]=Q, nodeIds[4]=~Q
 *   RS:       nodeIds[0]=S,   nodeIds[1]=C,   nodeIds[2]=R,   nodeIds[3]=Q, nodeIds[4]=~Q
 *   T (enable): nodeIds[0]=T, nodeIds[1]=C,                   nodeIds[2]=Q, nodeIds[3]=~Q
 *   T (no-enable): nodeIds[0]=C,                              nodeIds[1]=Q, nodeIds[2]=~Q
 *   JK-Async: nodeIds[0]=Set, nodeIds[1]=J,   nodeIds[2]=C,   nodeIds[3]=K, nodeIds[4]=Clr, nodeIds[5]=Q, nodeIds[6]=~Q
 *   RS-Async (latch): nodeIds[0]=S, nodeIds[1]=R,             nodeIds[2]=Q, nodeIds[3]=~Q
 *   D-Async:  nodeIds[0]=Set, nodeIds[1]=D,   nodeIds[2]=C,   nodeIds[3]=Clr, nodeIds[4]=Q, nodeIds[5]=~Q
 */

export {
  BehavioralJKFlipflopElement,
  makeJKFlipflopAnalogFactory,
  BehavioralJKAsyncFlipflopElement,
  makeJKAsyncFlipflopAnalogFactory,
  BehavioralRSFlipflopElement,
  makeRSFlipflopAnalogFactory,
  BehavioralRSAsyncLatchElement,
  makeRSAsyncLatchAnalogFactory,
  BehavioralTFlipflopElement,
  makeTFlipflopAnalogFactory,
  BehavioralDAsyncFlipflopElement,
  makeDAsyncFlipflopAnalogFactory,
} from "./behavioral-flipflop/index.js";
