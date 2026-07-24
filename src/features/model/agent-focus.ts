import type { StudentSession } from '../../../shared/session';

/**
 * Agent 的 focus_node 是非权威聚焦提示:只驱动镜头/呼吸引导,永不改变灯态。
 * 从事件流纯派生最近一次聚焦,携带 sequence 供消费方做「新提示才应用」判断,
 * 学生手动点选可随时覆盖,直到下一条 agent 聚焦出现。
 */
export interface AgentFocusHint {
  nodeId: string;
  sequence: number;
}

export function latestAgentFocus(session: StudentSession): AgentFocusHint | null {
  let hint: AgentFocusHint | null = null;
  for (const event of session.events) {
    if (event.kind !== 'agent.turn.completed') continue;
    if (hint && event.sequence <= hint.sequence) continue;
    for (const action of event.orderedActions) {
      if (action.name === 'focus_node') {
        hint = { nodeId: action.arguments.nodeId, sequence: event.sequence };
      }
      if (action.name === 'focus_cognitive_node') {
        hint = { nodeId: action.arguments.nodeId, sequence: event.sequence };
      }
    }
  }
  return hint;
}
