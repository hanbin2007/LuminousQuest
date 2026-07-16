import type { PretestConfig } from '../../../shared/config/schemas';
import {
  previewBuilderConnectivity,
  type BuilderGraph,
} from '../../../shared/scoring/topology';

type BuilderConfig = PretestConfig['builder'];

export function previewCircuitClosure(graph: BuilderGraph, config: BuilderConfig) {
  return previewBuilderConnectivity(graph, config);
}
