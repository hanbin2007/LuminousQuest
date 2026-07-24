import type { AppRuntime } from '../runtime/api';

export type AgentActivityState = 'running' | 'complete' | 'warning' | 'error';
export type AgentActivityRole = 'user' | 'agent' | 'system';

export interface AgentActivityMessage {
  id: string;
  runId: string;
  role: AgentActivityRole;
  title: string;
  body: string;
  meta?: string;
  state: AgentActivityState;
  occurredAt: number;
}

export interface AgentActivityRun {
  role: AgentActivityRole;
  title: string;
  body: string;
  target: string;
  summary?: string;
}

export interface AgentActivityResult {
  role?: AgentActivityRole;
  title: string;
  body: string;
  meta?: string;
  state?: Exclude<AgentActivityState, 'running'>;
}

export interface AgentActivityActions {
  begin: (run: AgentActivityRun) => string;
  progress: (runId: string, result: AgentActivityResult) => void;
  complete: (runId: string, result: AgentActivityResult) => void;
  fail: (runId: string, error: unknown) => void;
}

let activitySequence = 0;

function sourceLabel(source?: string) {
  if (source === 'provider') return '实时模型';
  if (source === 'development-cache') return '开发缓存';
  if (source === 'demo-recording') return '演示回放';
  if (source === 'fallback') return '安全回退';
  if (source === 'preset') return '规则预设';
  return null;
}

function nextRunId() {
  activitySequence += 1;
  return `agent-run-${Date.now()}-${activitySequence}`;
}

function failureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '请求未完成，请稍后重试。';
}

function finishMeta(startedAt: number, source?: string, model?: string) {
  const duration = Math.max(0, Date.now() - startedAt);
  return [
    sourceLabel(source),
    model,
    duration >= 1000 ? `${(duration / 1000).toFixed(1)} 秒` : `${duration} 毫秒`,
  ].filter(Boolean).join(' · ');
}

function answerPreview(answer: string, maximumLength = 72) {
  const normalized = answer.replace(/\s+/g, ' ').trim();
  if (!normalized) return '空白内容';
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength)}…`
    : normalized;
}

function beginWaitingFeedback(
  activity: AgentActivityActions,
  runId: string,
  steps: Array<{ afterMs: number; title: string; body: string; role?: AgentActivityRole }>,
) {
  const timers = steps.map((step) => setTimeout(() => {
    const seconds = step.afterMs / 1000;
    activity.progress(runId, {
      role: step.role ?? 'agent',
      title: step.title,
      body: step.body,
      meta: `已等待 ${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)} 秒`,
    });
  }, step.afterMs));
  return () => timers.forEach((timer) => clearTimeout(timer));
}

export function createAgentActivityRuntime(
  runtime: AppRuntime,
  activity: AgentActivityActions,
): AppRuntime {
  return {
    ...runtime,

    async assessChoice(input) {
      const startedAt = Date.now();
      const runId = activity.begin({
        role: 'system',
        title: '规则评测',
        body: '正在核对选项并更新诊断。',
        target: `题目 ${input.questionId}`,
        summary: `选择：${input.optionId}`,
      });
      activity.progress(runId, {
        role: 'system',
        title: '正在发起规则核对',
        body: '正在匹配选项与评分规则。',
      });
      const stopWaiting = beginWaitingFeedback(activity, runId, [{
        afterMs: 1200,
        role: 'system',
        title: '规则引擎仍在处理',
        body: '提交已保留，正在等待核对结果。',
      }]);
      try {
        const result = await runtime.assessChoice(input);
        activity.complete(runId, {
          role: 'system',
          title: '选项核对完成',
          body: '结果已写入当前学习记录，本次无需调用 Agent。',
          meta: finishMeta(startedAt),
        });
        return result;
      } catch (error) {
        activity.fail(runId, error);
        throw error;
      } finally {
        stopWaiting();
      }
    },

    async extractAssessment(input) {
      const startedAt = Date.now();
      const runId = activity.begin({
        role: 'agent',
        title: '评测 Agent',
        body: '正在读取作答、提取证据并匹配知识节点。',
        target: input.caseId ? `${input.caseId} · 案例分析` : `题目 ${input.questionId}`,
        summary: `${input.targetNodeIds.length} 个目标节点 · ${input.studentAnswer.length} 字符 · “${answerPreview(input.studentAnswer)}”`,
      });
      activity.progress(runId, {
        title: '正在发起评测请求',
        body: '作答已进入分析流程，完成后会自动追加结果。',
        meta: `目标节点：${input.targetNodeIds.join('、')}`,
      });
      const stopWaiting = beginWaitingFeedback(activity, runId, [
        {
          afterMs: 900,
          title: '正在提取作答证据',
          body: 'Agent 正在识别学生原话中的关键事实与因果关系。',
        },
        {
          afterMs: 2500,
          title: '等待结构化结果',
          body: '正在等待模型返回可校验的知识节点判断。',
        },
        {
          afterMs: 6000,
          title: '仍在分析',
          body: '当前作答已安全保留，请勿重复提交；结果返回后会自动同步。',
        },
        {
          afterMs: 12000,
          title: '上游响应较慢',
          body: '评测仍在继续；若达到超时上限，会显示明确的重试提示。',
          role: 'system',
        },
      ]);
      try {
        const result = await runtime.extractAssessment(input);
        const resultSource = result.source;
        const resultModel = result.model;
        const scoredCount = result.assessmentSummary?.scoredCount ?? 0;
        const needsReviewCount = result.assessmentSummary?.needsReviewCount ?? 0;
        if (scoredCount > 0 && needsReviewCount > 0) {
          activity.complete(runId, {
            title: '部分判分已完成',
            body: `已判分 ${scoredCount} 项，${needsReviewCount} 项转教师复核。`,
            meta: finishMeta(startedAt, resultSource, resultModel),
            state: 'warning',
          });
        } else if (result.status === 'needs-review' || needsReviewCount > 0) {
          activity.complete(runId, {
            title: '已转交教师复核',
            body: needsReviewCount > 0
              ? `${needsReviewCount} 项均未通过自动校验，当前作答已完整保留。`
              : 'Agent 未能可靠提取证据，当前作答已完整保留。',
            meta: finishMeta(startedAt, resultSource, resultModel),
            state: 'warning',
          });
        } else if (result.status === 'deterministic' || result.status === 'already-recorded') {
          activity.complete(runId, {
            role: 'system',
            title: result.status === 'already-recorded' ? '已复用评测结果' : '规则路径完成',
            body: result.status === 'already-recorded'
              ? '检测到同一提交，已读取已有结果，未重复调用 Agent。'
              : '该作答由确定性规则完成评测，无需调用 Agent。',
            meta: finishMeta(startedAt, resultSource, resultModel),
          });
        } else {
          const nodeCount = input.targetNodeIds.length;
          activity.complete(runId, {
            title: '评测 Agent 已返回',
            body: `已完成 ${nodeCount} 个知识节点的证据抽取，诊断结果已更新。`,
            meta: finishMeta(startedAt, resultSource, resultModel),
          });
        }
        return result;
      } catch (error) {
        activity.fail(runId, error);
        throw error;
      } finally {
        stopWaiting();
      }
    },

    async assessEquation(input) {
      const startedAt = Date.now();
      const runId = activity.begin({
        role: 'system',
        title: '方程式引擎',
        body: '正在解析反应式并核对守恒关系。',
        target: `${input.caseId} · ${input.equationSetId}`,
        summary: `方程式：“${answerPreview(input.equation)}”`,
      });
      activity.progress(runId, {
        role: 'system',
        title: '正在解析方程式',
        body: '依次检查语法、配平、电子与反应方向。',
      });
      const stopWaiting = beginWaitingFeedback(activity, runId, [{
        afterMs: 1200,
        role: 'system',
        title: '方程式引擎仍在处理',
        body: '提交已保留，正在等待完整核对结果。',
      }]);
      try {
        const result = await runtime.assessEquation(input);
        activity.complete(runId, {
          role: 'system',
          title: '方程式核对完成',
          body: '语法、配平与反应方向已由规则引擎完成检查。',
          meta: finishMeta(startedAt),
        });
        return result;
      } catch (error) {
        activity.fail(runId, error);
        throw error;
      } finally {
        stopWaiting();
      }
    },

    async tutorTurn(input) {
      const startedAt = Date.now();
      const runId = activity.begin({
        role: 'agent',
        title: '导师 Agent',
        body: '正在结合本轮作答与诊断记录组织追问。',
        target: `知识节点 ${input.nodeId}`,
        summary: `${input.studentAnswer.length} 字符 · “${answerPreview(input.studentAnswer)}”`,
      });
      activity.progress(runId, {
        title: '正在发起导师请求',
        body: '正在读取本轮诊断与此前的辅导轮次。',
      });
      const stopWaiting = beginWaitingFeedback(activity, runId, [
        {
          afterMs: 900,
          title: '正在回看诊断证据',
          body: '导师 Agent 正在定位最值得追问的思考断点。',
        },
        {
          afterMs: 2500,
          title: '正在组织追问',
          body: '正在生成不直接泄露答案、但能推动下一步思考的提示。',
        },
        {
          afterMs: 6000,
          title: '仍在等待导师回复',
          body: '当前轮次已保留，回复返回后会自动显示在这里。',
        },
      ]);
      try {
        const result = await runtime.tutorTurn(input);
        const meta = finishMeta(startedAt, result.source);
        if (result.status === 'respond') {
          activity.complete(runId, {
            title: '导师 Agent',
            body: `回复：${result.turn.content}`,
            meta,
            state: result.degraded ? 'warning' : 'complete',
          });
        } else if (result.status === 'advance') {
          activity.complete(runId, {
            title: '导师 Agent',
            body: `回复：${result.content}`,
            meta,
            state: result.degraded ? 'warning' : 'complete',
          });
        } else {
          activity.complete(runId, {
            role: 'system',
            title: '当前无需追加提示',
            body: '诊断规则判断本节点暂不需要继续追问。',
            meta,
          });
        }
        return result;
      } catch (error) {
        activity.fail(runId, error);
        throw error;
      } finally {
        stopWaiting();
      }
    },

    async reviewDrawing(imageData) {
      const startedAt = Date.now();
      const runId = activity.begin({
        role: 'agent',
        title: '视觉 Agent',
        body: '正在查看手绘中的电子路径、离子路径与方向标注。',
        target: '手绘通用模型',
        summary: `PNG 图像 · 约 ${Math.max(1, Math.round(imageData.length * 0.75 / 1024))} KB`,
      });
      activity.progress(runId, {
        title: '正在发起视觉点评',
        body: '画布已进入图像分析流程。',
      });
      const stopWaiting = beginWaitingFeedback(activity, runId, [
        {
          afterMs: 900,
          title: '正在识别图中结构',
          body: '视觉 Agent 正在定位电极、回路与方向标注。',
        },
        {
          afterMs: 3000,
          title: '正在整理点评',
          body: '正在把图像观察转换为简洁、可执行的修改建议。',
        },
        {
          afterMs: 7000,
          title: '仍在等待视觉结果',
          body: '图像已保留，点评返回后会自动追加。',
        },
      ]);
      try {
        const feedback = await runtime.reviewDrawing(imageData);
        activity.complete(runId, {
          title: '视觉 Agent',
          body: `点评：${feedback}`,
          meta: finishMeta(startedAt),
        });
        return feedback;
      } catch (error) {
        activity.fail(runId, error);
        throw error;
      } finally {
        stopWaiting();
      }
    },
  };
}

export function createAgentActivityRunId() {
  return nextRunId();
}

export function agentActivityFailureMessage(error: unknown) {
  return failureMessage(error);
}
