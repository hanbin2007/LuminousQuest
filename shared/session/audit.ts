import type { SessionEvent } from './schema';

export function isAuditOnlyEvent(event: SessionEvent) {
  return event.kind === 'agent.judgment.recorded'
    || event.kind === 'agent.divergence.changed'
    || event.kind === 'assessment.audit.completed'
    || event.kind === 'assessment.divergence.changed';
}
