import { z } from 'zod';

import { sessionSchema, type StudentSession } from './schema';

export const sessionCommandEnvelopeSchema = z
  .object({
    expectedSequence: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(128),
  })
  .strict();

export const sessionSyncRequestSchema = sessionCommandEnvelopeSchema
  .extend({ session: sessionSchema })
  .strict();

export type SessionCommandEnvelope = z.infer<typeof sessionCommandEnvelopeSchema>;
export type SessionSyncRequest = z.infer<typeof sessionSyncRequestSchema>;

export function sessionServerSequence(session: StudentSession) {
  let sequence = session.serverSequence ?? 0;
  for (const event of session.events) {
    if (event.command) {
      sequence = Math.max(sequence, event.command.resultingSequence);
    }
    if (event.kind === 'session.command.executed') {
      sequence = Math.max(sequence, event.resultingSequence);
    }
  }
  return sequence;
}
