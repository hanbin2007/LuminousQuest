import { z } from 'zod';

import { sessionSchema } from './schema';

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
