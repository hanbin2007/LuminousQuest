import type { ComponentType } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  type LucideProps,
} from 'lucide-react';

import electrodeImage from '../../../assets/components/electrode-carbon@2x.png';
import electrolyteImage from '../../../assets/components/beaker-electrolyte@2x.png';
import sucroseImage from '../../../assets/components/sucrose-beaker@2x.png';
import wireImage from '../../../assets/components/wire@2x.png';

export interface ComponentPresentation {
  functionalLabel: string;
  image?: string;
  Icon?: ComponentType<LucideProps>;
}

export const componentPresentation: Record<string, ComponentPresentation> = {
  'site-a': { functionalLabel: '失电子场所', image: electrodeImage },
  'electron-link': { functionalLabel: '电子导体', image: wireImage },
  'ion-medium': { functionalLabel: '离子导体', image: electrolyteImage },
  'site-b': { functionalLabel: '得电子场所', image: electrodeImage },
  container: { functionalLabel: '容器', image: electrolyteImage },
  'electron-arrow': { functionalLabel: '电子方向箭头', Icon: ArrowRight },
  'cation-arrow': { functionalLabel: '阳离子方向箭头', Icon: ArrowUpRight },
  'anion-arrow': { functionalLabel: '阴离子方向箭头', Icon: ArrowDownLeft },
  'sucrose-solution': { functionalLabel: '蔗糖水', image: sucroseImage },
  'insulated-link': { functionalLabel: '绝缘连接件', image: wireImage },
};

export function presentationFor(componentId: string, fallbackLabel: string) {
  return componentPresentation[componentId] ?? { functionalLabel: fallbackLabel };
}
