import { z } from 'zod';

/** Bounded OpenAI Responses contract. */
export const responsesRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    input: z.union([z.string().max(100000), z.array(z.unknown()).max(128)]),
    instructions: z.string().max(100000).optional(),
    stream: z.boolean().default(false),
    max_output_tokens: z.number().int().positive().max(4096).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    tools: z.array(z.unknown()).max(32).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    text: z.unknown().optional(),
    reasoning: z.unknown().optional(),
    truncation: z.enum(['auto', 'disabled']).optional(),
    previous_response_id: z.string().max(128).optional(),
    store: z.boolean().optional(),
    user: z.string().max(256).optional(),
    metadata: z.record(z.string().max(64), z.string().max(512)).optional()
  })
  .strict();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
