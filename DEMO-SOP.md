# Riddle × AWS Monetization — Demo Runbook

End-to-end SOP for demoing the monetization journey, written from an actual run
on 2026-07-27/28. Every command here was executed; every gotcha listed was hit
for real.

**App:** Riddle · **appId** `0c07accf-9932-4c68-a048-7564bea6a505` · account
`136311627418` · us-east-1 · endpoint `https://us-east-1.monetization.aws.dev`

---

## 0. Pre-flight — do this the night before

Not optional. Four of these will visibly break the demo if skipped.

| # | Check | Command / fix |
|---|---|---|
| 0.1 | **Archive the two `ZZ Budget` test plans** | They are PUBLISHED and *will* render on `/pricing` mid-demo. See §0a. |
| 0.2 | **You are at the 5-plan cap** | 5/5 published. Creating a 6th fails with `ServiceQuotaExceededException`. Archive before creating. |
| 0.3 | AWS creds resolve | `aws sts get-caller-identity` → account `136311627418` |
| 0.4 | Backend builds | `cd backend && npx tsc --noEmit` |
| 0.5 | Frontend builds + tests | `cd frontend && npm run build && npm test` (expect 16/16) |
| 0.6 | Runtime config resolves | `/plans` returns 200 — see §0b |
| 0.7 | Dev servers up | Vite `:5173`, console `:5178` |
| 0.8 | A clean demo player exists | Sign up a fresh Cognito user (§0c) |

### 0a. Archive the test plans

```bash
A=0c07accf-9932-4c68-a048-7564bea6a505
S=~/.claude/skills/monetize/scripts/sigv4-request.sh
for P in ddc4e954-f242-4e34-82cc-b2f1a3a8bdee 9d8d7d80-2481-43f3-a010-c768051abc80; do
  bash $S POST "/apps/$A/plans/$P/archive" '{}' us-east-1
done
```

⚠️ **This strands their subscribers** (see G-2). Both hold only throwaway test
users, so it's safe here — but never do this to a plan with real customers.

Afterwards `/pricing` shows exactly **Free / Pro / Unlimited**.

### 0b. Verify the runtime actually works

```bash
curl -s https://2i0nj4km7i.execute-api.us-east-1.amazonaws.com/plans | head -c 200
```

Expect JSON with 3 plans. A **500** here means `MONETIZATION_ENDPOINT` or the IAM
policy regressed — see G-5 and G-6. Do not start the demo on a 500.

### 0c. A clean demo player

Existing test logins (password `TestPass123`):

| Email | State |
|---|---|
| `monetize-smoke-7581@example.com` | on ZZ Budget v4 — **don't use**, plan is being archived |
| `monetize-guess-11974@example.com` | no subscription → auto-Free. **Good starting point.** |

Or create a fresh one live — it's a nice beat in the demo:

```bash
API=https://2i0nj4km7i.execute-api.us-east-1.amazonaws.com
curl -s -X POST "$API/signup" -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"TestPass123"}'
```

### 0d. Start the servers

```bash
cd frontend && npm run dev            # :5173
cd backend  && npx @aws-monetization/sdk console   # :5178
```

The console needs `MONETIZATION_ENDPOINT` exported first:
`set -a && . ./.env.monetization && set +a`

---

## The journey — 10 acts

### Act 1 — Front door / onboarding

`/monetize ~/projects/second-app`

The skill greets, states the six phases, and **stops for your go-ahead**. It
silently detects: existing monetization components, AWS credentials, and whether
the AWS MCP Server is connected.

> **Talking point:** it pauses before doing anything. Nothing is created, and
> pricing is only ever a *suggestion* — the developer sets the price.

### Act 2 — Analyze

Reads the codebase and produces two things: a resource inventory and a list of
billable actions. For Riddle it found:

| Action | Type | Route | Why |
|---|---|---|---|
| `submit_guess` | consumable | `POST /riddles/{id}/guess` | Claude judge — the real cost |
| `take_hint` | consumable | `POST /riddles/{id}/hint` | near-free, high value |
| `serve_riddle` | consumable | `GET /riddles/next` | the play unit |
| `hard_difficulty` | capability | `?difficulty=hard` | tier differentiator |

**Gate:** it verifies a stable per-user identity exists. Riddle passes — `sub`
from the Cognito JWT authorizer (`backend/src/auth.ts:43`).

> **Talking point:** `POST /admin/generate` is expensive but is *not* billable —
> users never invoke it. Cost alone doesn't decide the pricing page.

### Act 3 — Cost estimation

Live AWS Price List API rates + Anthropic pricing for `claude-sonnet-4-6`
($3/$15 per MTok).

```
submit_guess   $0.00224   ← 98% of it is the Claude judge
serve_riddle   $0.0000080
take_hint      $0.0000067
per active user / month: $0.2019
fixed baseline: $0.40/mo
```

> **Talking point:** the exact-match fast path in `engine/scoring.ts` removes
> ~30% of judge calls. Margin swings 87% → 77% on that ratio alone.

### Act 4 — Recommendation + approval ⏸️

The single gate. Presents tiers **and every assumption**, and will not proceed
without explicit approval.

| Tier | Price | Riddles | Guesses | Hints | Margin |
|---|---|---|---|---|---|
| Free | $0 | 10 | 30 | 5 | — |
| Pro | $4.99 | 120 | 400 | 80 | 82.0% |
| Unlimited | $9.99 | 500 | 850 | 200 | 80.9% |

**The good beat:** per-tier margin is 82%, but *blended* is 63.6% because free
users cost $0.067/mo each. Fix isn't raising prices — it's making the free tier
**exact-match only** (no Claude). Cost per free user drops **211×** to $0.00032,
blended margin → **81.6%**, and it's a better upgrade pitch than a quota wall.

### Act 5 — Configure

Creates metrics then plans (order matters — a `USAGE_BASED` price binds by
`metricId`). 5 metrics, 3 plans, all PUBLISHED.

⚠️ **G-1** applies here: the batch script silently drops `capabilityMode`.

### Act 6 — Seller registration

```bash
POST /apps/{appId}/payment  → 201 {registrationUrl, expiresAt}
GET  /apps/{appId}/payment  → 200 {status: PENDING|ACTIVE|FAILED}
```

Open the URL, complete Stripe onboarding with the test values (§ Stripe test
data), status → **ACTIVE**. Funds only settle when ACTIVE.

⚠️ **The URL expires in 5 minutes** (G-3). Re-POST for a fresh one — it updates
the same registration, it does not create a second merchant.

### Act 7 — Code injection

Additive only. Backend gets a `billing/` module (peer of `llm/` and `db/`,
matching the repo's house rules); frontend gets `/pricing`, `/subscription`,
and a post-checkout activation page.

Key wiring: entitlement gate **before** the paid work, metering **after** it
lands, `flushBilling()` before the Lambda returns.

> **Talking point:** the free-tier judging gate reuses the app's *existing*
> `llm_unavailable` fallback path — a conditional, not a rewrite. And a new
> `judge_not_entitled` resolution value makes the upgrade wall measurable in
> their existing CloudWatch saved query.

### Act 8 — Deploy + verify

```bash
cd backend && npx cdk deploy --require-approval never
curl -s $API/plans          # 200 + 3 plans
```

⚠️ Two things bite here: **Node 22 → 24** (G-4) and the **IAM resource** (G-5).

### Act 9 — Live behaviour (the money shot)

Sign up a player, then show the gate working on the **deployed** API:

```bash
GET /riddles/next?difficulty=easy   → 200, riddle served
GET /riddles/next?difficulty=hard   → 403 CAPABILITY_NOT_INCLUDED + upgradeUrl
POST /riddles/{id}/guess "hairbrush" → "Not an exact match. Upgrade to have
                                        Claude judge near-misses."
POST /riddles/{id}/hint             → 200
```

Then prove the cost model in CloudWatch: that guess produced
`resolution: judge_not_entitled` and **zero `llm_call` events**. The free tier
genuinely never calls Claude.

### Act 10 — UI, checkout, upgrade, downgrade

1. **`/pricing`** — 3 live plans from `listPlans()`, current plan marked.
2. **`/subscription`** — sign in, see plan + usage meters + estimated charges.
3. **Upgrade** — click Pro → hosted checkout → card `4242 4242 4242 4242` →
   activation page polls → lands back on `/pricing` with Pro active.
4. **Downgrade** — click Free from a paid plan → **no checkout**; shows
   *"Your plan update will apply on {date}"* and appears as `pendingChange`.
5. **Console** — `npx @aws-monetization/sdk console` → :5178 → subscribers per
   tier, revenue, usage by metric.

Revenue after one Pro subscription: `totalRevenue $4.99`.

---

## Gotchas — every one of these was hit for real

### G-1 · The batch script drops `capabilityMode` 🔴
`configure-plans.sh` builds `planDefinition` from only name/currency/
description/prices. `capabilityMode` and `capabilities` are **silently
discarded** — the API never sees them. The Free tier then grants *everything*,
including the capability you're selling.
**Fix:** create such plans with a direct `sigv4-request.sh` call, and **always
verify after publishing**.

### G-2 · Archiving a plan strands its subscribers 🔴
Contradicts the docs ("safe to archive a plan that has live subscribers").
In practice any later plan change fails:
`ValidationException: Plan is not PUBLISHED: {oldPlanId}`.
**Never archive a plan real customers are on.**

### G-3 · Seller onboarding URL expires in 5 minutes
Re-POST `/apps/{appId}/payment` for a fresh link. Same merchant, no duplicate.
Once ACTIVE, the response returns `registrationUrl: null`.

### G-4 · SDK requires Node ≥ 24
Lambda was pinned `NODEJS_22_X`. Bump to `NODEJS_24_X` — this **replaces the
function**, so do it before demo day, not during.

### G-5 · IAM must be `Resource: "*"` 🔴
The documented app-scoped ARN **does not work**. Every narrowing attempt
(`app/{id}`, `app/{id}/*`, account-wide, any `arn:aws:monetization:…`) returns
`AccessDeniedException`, while IAM's own simulator reports them as *allowed*.
Least privilege survives on **actions**; the resource must be `*`.

### G-6 · `MONETIZATION_ENDPOINT` must be set explicitly 🔴
The SDK's built-in default host **does not resolve**. Phase 5 signs against
`https://us-east-1.monetization.aws.dev`. Unset → every runtime call fails DNS,
with a perfectly clean build.

### G-7 · `includedQuantity` blocks, it does not bill 🟠
With a $10/unit overage price configured, a user past quota is **denied**, not
charged. **This affects the pricing story:** Pro's "400 guesses then $0.01 each"
earns no overage — users just stop at 400. Know this before someone asks.

### G-8 · Quota reset on upgrade depends on the wall-clock hour 🟠
Usage counting is aligned to the **anchor's hour bucket**. Upgrade inside the
same hour → usage carries. Upgrade after the hour turns → resets to 0.
Confirmed on three users, once as a stated prediction.

### G-9 · `BUDGET_EXCEEDED` returns `metrics: null` 🟠
A quota denial returns `{currentUsage, quotaLimit, remaining}`; a budget denial
returns nothing. The UI cannot explain why the user was blocked.
Repro: `upgradetest-01`.

### G-10 · Zero flat fee + chargeable usage → `500 InternalFailure` 🟠
Any plan with `FLAT_FEE: 0` (or none) *plus* a non-zero `unitAmount` fails at
`createCheckoutSession`. Independent of seller registration and `budgetLimit`.
**Workaround:** give it a non-zero base fee.

### G-11 · Checkout sessions are reused per `(userId, planId)`
While a pending session exists, `createCheckoutSession` returns the **existing**
one and silently ignores a new `returnUrl`. You cannot fix a bad redirect by
retrying — use a different user or wait out the 24h expiry.

### G-12 · `COUNT` metrics ignore `quantity`
`putEvent(quantity: '7')` counts as **1**. All Riddle metrics are `COUNT`.
Drive counters with N discrete calls.

### G-13 · Aggregation takes ~7s
Don't check entitlement immediately after metering. Poll until the counter
lands; budget ~15s.

### G-14 · `APP_BASE_URL` defaults to localhost 🟠
Deployed Lambda still has `http://localhost:5173`. Real players would be
redirected to their own machine after paying.
**Fix:** `APP_BASE_URL=https://<amplify-url> npx cdk deploy`

### G-15 · Two parallel user populations
The app meters by Cognito `sub`. Any synthetic userId used via the SDK is
invisible to the UI. To demo the subscription page, drive the **Cognito user**,
not a test id.

### G-16 · Budget limits are absent from the UI spec
Phase 6's acceptance criteria are entirely quota/usage driven — `budgetLimit`
appears nowhere. A budget plan built to spec shows the user quota meters while
the cap that will actually cut them off is invisible. *We added a spend meter;
it is not in the skill.*

### G-17 · Amplify needs an SPA rewrite
`/pricing` uses real paths. Without a `/<*>` → `/index.html` (200) rewrite, a
refresh 404s. Also set `VITE_API_URL` as an Amplify build env var.

---

## Stripe test data

| Field | Value |
|---|---|
| Card | `4242 4242 4242 4242`, any future expiry, any CVC/ZIP |
| Phone / OTP | `000 000 0000` / `0` |
| DOB | `01 / 01 / 1901` |
| SSN | `000-00-0000` |
| Address line 1 | `address_full_match` (instant pass) |
| Routing / account | `110000000` / `123456789` |
| ID document | choose "Use test document" |

---

## Reference IDs

| | |
|---|---|
| appId | `0c07accf-9932-4c68-a048-7564bea6a505` |
| API | `https://2i0nj4km7i.execute-api.us-east-1.amazonaws.com` |
| Free / Pro / Unlimited | `d9f6372d…` / `94ffd774…` / `9fd3c011…` |
| Metrics | `serve_riddle 9950c846…` · `submit_guess 8ba8f24d…` · `take_hint e4a80d4b…` · `judge_guess e1bf1c33…` · `serve_hard_riddle a074fb10…` |
| Stripe connected account | `acct_1TxzAMD5cZTXhLyv` |

---

## If something breaks mid-demo

| Symptom | Cause | Recovery |
|---|---|---|
| `/plans` → 500 | endpoint or IAM (G-5/G-6) | check `.env.monetization`, redeploy |
| Everything DENY | user has no plan, or enforcement on | `MONETIZATION_ENFORCE=false` reopens routes |
| Page shows "no subscription" | using a synthetic userId (G-15) | sign in as a Cognito user |
| Checkout redirect lands nowhere | `APP_BASE_URL` (G-14) | expected locally; call it out |
| Can't create a plan | 5-plan cap | archive one first |
| Usage looks wrong right after metering | aggregation lag (G-13) | wait ~7–15s |
