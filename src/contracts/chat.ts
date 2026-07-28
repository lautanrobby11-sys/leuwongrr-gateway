import { z } from 'zod';

export const chatRequestSchema = z.object({
  model: z.string().min(1).max(128),
  messages: z.array(z.object({ role:z.enum(['system','user','assistant','tool']), content:z.union([z.string().max(100000),z.array(z.unknown()).max(32)]) })).min(1).max(128),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().max(4096).optional(),
  tools: z.array(z.unknown()).max(32).optional()
}).strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;
