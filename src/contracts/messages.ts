import { z } from 'zod';

// Agentic clients (coding CLIs, IDE agents) send large toolsets and long
// histories on every request; these bounds sit well above real payloads while
// Fastify's 1MB bodyLimit remains the actual size guard.
const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(1000000), z.array(z.unknown()).max(256)])
});

const systemSchema = z.union([z.string().max(1000000), z.array(z.unknown()).max(256)]);

/**
 * Bounded Anthropic Messages contract. `max_tokens` is required upstream.
 * Known fields are validated tightly; anything else passes through so real
 * Anthropic/OpenAI-compatible clients keep working (see chat.ts for the
 * rationale). Provider routing stays with OmniRoute.
 */
export const messagesRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(anthropicMessageSchema).min(1).max(1024),
    max_tokens: z.number().int().positive().max(1048576),
    system: systemSchema.optional(),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().max(500).optional(),
    stop_sequences: z.array(z.string().max(256)).max(8).optional(),
    tools: z.array(z.unknown()).max(512).optional(),
    tool_choice: z.unknown().optional(),
    metadata: z.object({ user_id: z.string().max(256).optional() }).strict().optional()
  })
  .passthrough();

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

/** Token counting takes the same shape without generation controls. */
export const countTokensRequestSchema = z
  .object({
    model: z.string().min(1).max(128),
    messages: z.array(anthropicMessageSchema).min(1).max(1024),
    system: systemSchema.optional(),
    tools: z.array(z.unknown()).max(512).optional(),
    tool_choice: z.unknown().optional()
  })
  .passthrough();

export type CountTokensRequest = z.infer<typeof countTokensRequestSchema>;
