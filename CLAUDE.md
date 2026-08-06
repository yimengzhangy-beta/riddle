# Riddle — working notes

A riddle game: Cognito + API Gateway (HTTP API, JWT authorizer) + Lambda + DynamoDB,
with Claude judging inexact guesses and writing the riddle bank. See README.md for the
API surface, the scoring rules and the deploy steps. This file is the house rules.

## Audit logging

Every request writes a structured JSON trail to CloudWatch. `backend/src/log.ts` is the
only module that formats these events; nothing else should call `console.*`.

### HARD RULE: never log user content

No guess text. No riddle text. No answers. No hints. No prompts, no model completions,
no DynamoDB item bodies. **Ids, enum values, counts and timings only.**

This is not a style preference — the log group is a 90-day store that a wider set of
people can read than can read the table, and a leaked answer there devalues the riddle
bank permanently.

What this rules out in practice:

- Passing a value from a request body, a riddle row, or a model reply into any log call.
- Logging a caught error's `message` when the error came from a parser, an AWS SDK
  client, or the Anthropic SDK — those messages quote the input that broke them.
  `extractJson` in `llm/client.ts` deliberately drops V8's `JSON.parse` message for
  exactly this reason. Log `err.name` plus `stackFrames(err)`; the frames carry no data.
- `console.log(event)` or `console.error(err)` anywhere in `backend/src`.

An error message written as a literal in this codebase is fine to log — the rule is
about *interpolated* values. When in doubt, log an id and look the record up.

### The events

All events of one request share `requestId`, which is API Gateway's own request id, so
the Lambda events and the access-log line for the same call join on it. Every event also
carries `userId` (the JWT `sub`, null when unauthenticated) and `route` (the matched
template, e.g. `/riddles/{id}/guess`).

| event | when | payload beyond the shared ids |
| ----- | ---- | ----------------------------- |
| `request` | handler entry, before routing | `method`, `riddleId` |
| `llm_call` | each Anthropic call | `purpose` (`guess_judgment` \| `riddle_generation`), `model`, `attempt`, `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `ok`, `stopReason` |
| `db_write` | each DynamoDB write | `op`, `pk`, `sk`, `counters[]`, `written` — **the key only, never the item** |
| `guess_resolved` | end of a guess | `riddleId`, `resolution`, `verdict`, `solved`, `guessNumber`, `hintsTaken` |
| `response` | handler exit | `status`, `durationMs` |
| `error` | operational failure | `where`, `name`, `message` (literal), `frames` |

**Most guesses produce no `llm_call` at all.** The normalisation fast path in
`engine/scoring.ts` settles an exact match without a model call, so the absence of the
event is the signal — that is why `guess_resolved` carries an explicit `resolution` of
`normalized`, `llm_judged` or `llm_unavailable`, rather than leaving it to be inferred.
The ratio between them is the shape of the Anthropic bill.

Adding an event: put the emitter in `log.ts` with a typed field list, so the no-content
rule is enforced by the signature rather than by the caller remembering it.

### Where it lands

| group | contents | retention |
| ----- | -------- | --------- |
| `/aws/lambda/riddle-demo-api` | the events above | 90 days |
| `/aws/apigateway/riddle-demo-api-access` | one line per HTTP request, including the ones the Lambda never sees | 90 days |

The access log exists because a rejected JWT is a 401 from the authorizer — no Lambda
invocation, no `request` event, and previously no trace at all. Both groups are declared
in `lib/app-stack.ts`; the function name is pinned to `riddle-demo-api` so the log group name
is stable across replacements.

Six saved queries ship with the stack (CloudWatch → Logs Insights → Saved queries,
prefix `riddle-demo/`): per-user activity trail, single-request story, latency by route,
llm-judged vs normalized guesses, token spend by user, and rejected before the lambda.

## Layout rules

- `db/` is the only place that talks to DynamoDB; `llm/` is the only place that knows
  Claude exists; `routes/` parse and validate input and never touch either.
- `engine/scoring.ts` stays pure — no IO, no clock beyond what the caller passes in.
- Errors thrown by the engine map to HTTP status in `handler.ts` and nowhere else.
