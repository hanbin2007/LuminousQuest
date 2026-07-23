import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';

const PretestPage = lazy(async () => {
  const module = await import('../features/pretest/PretestPage');
  return { default: module.PretestPage };
});
const TrainingPage = lazy(async () => {
  const module = await import('../features/training/TrainingPage');
  return { default: module.TrainingPage };
});
const TeacherPage = lazy(() => import('../features/teacher/TeacherPage'));
const ModelPage = lazy(() => import('../features/model/ModelPage'));

function ModelRoute() {
  return (
    <Suspense fallback={(
      <div className="stage-dark model-stage model-stage--on" aria-busy="true">
        <p className="route-loading__label">正在点亮舞台…</p>
      </div>
    )}>
      <ModelPage />
    </Suspense>
  );
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <p>404</p>
      <h1>这条学习路径不存在</h1>
      <span>地址可能已失效，返回前测可以继续当前会话。</span>
      <Link className="primary-button" to="/pretest">返回前测</Link>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate replace to="/pretest" />} />
        <Route path="pretest" element={<PretestPage />} />
        <Route path="pretest/builder" element={<PretestPage />} />
        <Route path="pretest/question/:questionId" element={<PretestPage />} />
        <Route path="pretest/drawing" element={<PretestPage />} />
        <Route path="pretest/diagnosis" element={<PretestPage />} />
        <Route path="training" element={<TrainingPage />} />
        <Route path="training/:caseId" element={<TrainingPage />} />
        <Route path="model" element={<ModelRoute />} />
        <Route path="teacher" element={<TeacherPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
