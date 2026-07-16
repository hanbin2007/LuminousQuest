import type { ComponentType } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  type LucideProps,
} from 'lucide-react';

import electrodeImage from '../../../assets/components/electrode-carbon@2x.png';
import emptyBeakerImage from '../../../assets/components/beaker-empty@2x.png';
import electrolyteImage from '../../../assets/components/beaker-electrolyte@2x.png';
import sucroseImage from '../../../assets/components/sucrose-beaker@2x.png';
import wireImage from '../../../assets/components/wire@2x.png';

export interface ComponentPresentation {
  image?: string;
  Icon?: ComponentType<LucideProps>;
}

export const componentPresentation: Record<string, ComponentPresentation> = {
  'site-a': { image: electrodeImage },
  'electron-link': { image: wireImage },
  'ion-medium': { image: electrolyteImage },
  'site-b': { image: electrodeImage },
  container: { image: emptyBeakerImage },
  'electron-arrow': { Icon: ArrowRight },
  'cation-arrow': { Icon: ArrowUpRight },
  'anion-arrow': { Icon: ArrowDownLeft },
  'sucrose-solution': { image: sucroseImage },
  'insulated-link': { image: wireImage },
};

export function presentationFor(componentId: string) {
  return componentPresentation[componentId] ?? {};
}
