import type { ComponentType } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  type LucideProps,
} from 'lucide-react';

import copperImage from '../../../assets/components/copper@2x.png';
import electrodeImage from '../../../assets/components/electrode-carbon@2x.png';
import insulatedWireImage from '../../../assets/components/insulated-wire@2x.png';
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
  'insulated-link': { image: insulatedWireImage },
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

/**
 * 工作台真实比例几何(与 assets/STYLE.md §7 同源:16px=1cm@2x,显示≈@1x×1.25)。
 * anchor 为连线端点在组件盒内的相对位置(电极夹持点在顶端,烧杯在杯口下方)。
 */
export interface BenchGeometry {
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

const defaultGeometry: BenchGeometry = { width: 96, height: 96, anchorX: 0.5, anchorY: 0.5 };

const electrodeGeometry: BenchGeometry = { width: 36, height: 168, anchorX: 0.5, anchorY: 0.05 };
const wireGeometry: BenchGeometry = { width: 150, height: 70, anchorX: 0.5, anchorY: 0.5 };
/** 池子刻意放大(可容两根电极并留间距),仍保持与电极的真实比例关系。 */
const beakerGeometry: BenchGeometry = { width: 210, height: 260, anchorX: 0.5, anchorY: 0.35 };
const markerGeometry: BenchGeometry = { width: 56, height: 36, anchorX: 0.5, anchorY: 0.5 };

export const benchGeometryByComponent: Record<string, BenchGeometry> = {
  'site-a': electrodeGeometry,
  'site-b': electrodeGeometry,
  'electron-link': wireGeometry,
  'insulated-link': wireGeometry,
  'ion-medium': beakerGeometry,
  'sucrose-solution': beakerGeometry,
  container: beakerGeometry,
  'electron-arrow': markerGeometry,
  'cation-arrow': markerGeometry,
  'anion-arrow': markerGeometry,
};

export function benchGeometryFor(componentId: string): BenchGeometry {
  return benchGeometryByComponent[componentId] ?? defaultGeometry;
}
