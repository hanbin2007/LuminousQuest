import type { ComponentType } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  type LucideProps,
} from 'lucide-react';

import copperImage from '../../../assets/components/copper@2x.png';
import electrodeImage from '../../../assets/components/electrode-carbon@2x.png';
import zincImage from '../../../assets/components/electrode-zinc@2x.png';
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

/** 电极材料绑定 → 位图(NOBOOK 式真实感:换材料即换外观;未收录回退碳棒)。 */
const materialImages: Record<string, string> = {
  Zn: zincImage,
  Cu: copperImage,
  C: electrodeImage,
};

export function electrodeImageFor(materialId?: string) {
  return (materialId && materialImages[materialId]) || electrodeImage;
}
