# ADR-008: Protocol surface expansion on a single upstream pipeline

- Status: Accepted
- Date: 2026-07-28
- Supersedes: none
- Related: ADR-001 (system boundaries), ADR-005 (runtime envelope), ADR-007 (tenant isolation and readiness)

## Context

The gateway only exposed `/v1/chat/completions`. Codex-style and Claude-style
clients also need the OpenAI Responses surface and the Anthropic Messages
surface, including token counting. Adding them by copying the chat handler
would have duplicated the parts that carry the safety properties: idempotency
claims, budget reservation, per-tenant concurrency, stream idle timeouts, and
audit. Duplicated safety logic drifts, and drift here is silent.

Budget was also settled with the pre-request estimate, so recorded usage was
never the usage that actually happened.

## Decision

1. `src/http/pipeline.ts` owns the upstream request lifecycle exactly once.
   Protocol routes are thin adapters that authenticate, validate their own
   contract, resolve model policy, and hand a fully-decided `UpstreamCall` to
   the executor.
2. Three routes join the exact-match allowlist: `POST /v1/responses`
   (`responses:write`), `POST /v1/messages` and `POST /v1/messages/count_tokens`
   (`messages:write`). There is still no catch-all passthrough.
3. Errors are rendered in the dialect the caller asked for. Anthropic callers
   receive `{"type":"error","error":{"type":...}}`; everyone else keeps the
   existing envelope. The trace id and retryable flag are present in both.
4. `src/http/usage.ts` reconciles the reported usage from the response body or
   from streamed events, and settlement uses that value. The estimate is only a
   fallback when upstream reports nothing. Streaming chat requests force
   `stream_options.include_usage`, and Anthropic input and output counts are
   summed because they arrive in different events.
5. Request contracts stay `strict()` at the top level. Unknown fields are
   rejected rather than forwarded, so a caller cannot smuggle provider switches
   past the policy layer.

   **Amended 2026-08-15.** Contracts are `passthrough()` at the top level
   instead. The fields the policy layer reads (model, messages, stream, bounds)
   are still validated tightly, but unrecognised top-level fields are forwarded
   to OmniRoute rather than rejected. Strict schemas broke the promised OpenAI
   compatibility for real clients: CLIs and IDEs send standard fields such as
   `logprobs`, `reasoning_effort`, and `service_tier`, and every such request
   failed with `400 Request body failed schema validation`. Provider routing
   belongs to OmniRoute (ADR-001), so a forwarded field cannot bypass this
   gateway's policy — model, scope, budget, and concurrency are still decided
   here.

## Consequences

- One place to audit for the safety properties, and one place to change them.
- Recorded usage now reflects real consumption, which makes the daily budget a
  meaningful control instead of an estimate ledger.
- Reported usage can exceed the reservation. That overrun is recorded honestly
  and is absorbed by the next reservation for the same day rather than being
  clamped into a false number.
- Token counting consumes one budget unit and a tenant slot. It is upstream
  work, so it is not exempt from the envelope.
- Adding a future surface (`/v1beta`, embeddings, files) means writing an
  adapter, not another copy of the pipeline.
