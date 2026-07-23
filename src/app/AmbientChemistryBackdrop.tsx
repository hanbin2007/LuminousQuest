import { lazy, Suspense, useMemo } from 'react';

import { useReducedMotion } from './useReducedMotion';

const AmbientChemistryScene = lazy(() =>
  import('./AmbientChemistryScene').then((module) => ({
    default: module.AmbientChemistryScene,
  })));

function webglAvailable(): boolean {
  if (
    typeof document === 'undefined'
    || (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))
  ) {
    return false;
  }

  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!context) return false;
    (context as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function AmbientChemistryBackdrop() {
  const hasWebgl = useMemo(webglAvailable, []);
  const reducedMotion = useReducedMotion();

  return (
    <div className="ambient-chemistry" aria-hidden="true">
      {hasWebgl ? (
        <Suspense fallback={null}>
          <AmbientChemistryScene reducedMotion={reducedMotion} />
        </Suspense>
      ) : null}
    </div>
  );
}
