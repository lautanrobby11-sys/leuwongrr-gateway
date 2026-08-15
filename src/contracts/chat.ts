import { z } from 'zod';

const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string().max(100000), z.array(z.unknown()).max(32), z.null()]),
  name: z.string().max(128).optional(),
  tool_calls: z.array(z.unknown()).max(32).optional(),
  tool_call_id: z.string().max(256).optional()
});

/**
 * Bounded OpenAI chat contract. The fields the policy layer reads are validated
 * tightly; anything else passes through so standard OpenAI clients (CLIs, IDEs,
 * SDKs) keep working. A strict top-level schema rejected common fields such as
 * `logprobs`, `reasoning_effort`, and `service_tier`, which broke the promised
 * OpenAI compatibility for every real client. Provider routing stays with
 * OmniRoute (ADR-001), so a passthrough field cannot bypass this gateway's
 * policy: model, scope, budget, and concurrency are all decided here.
 */
export const chatRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(messageSchema).min(1).max(128),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    max_tokens: z.number().int().positive().max(4096).optional(),
    max_completion_tokens: z.number().int().positive().max(4096).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.literal(1).optional(),
    stop: z.union([z.string().max(256), z.array(z.string().max(256)).max(4)]).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
    user: z.string().max(256).optional(),
    response_format: z.unknown().optional(),
    tools: z.array(z.unknown()).max(32).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional()
  })
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
