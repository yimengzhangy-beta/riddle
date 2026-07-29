# Riddle

Users sign up, solve riddles of varying difficulty, and can ask for hints. Claude judges
inexact guesses and writes the riddle bank.

- **frontend/** — React + TypeScript (Vite), hosted on AWS Amplify Hosting *(still the
  starter scaffold — the Riddle UI has not been built yet)*
- **backend/** — AWS CDK (TypeScript) defining Cognito + API Gateway (HTTP API, JWT
  authorizer) + Lambda + DynamoDB
- **.github/workflows/** — GitHub Actions auto-deploys the backend on push to `main`

AWS account: `136311627418` · Default region: `us-east-1` (change in `backend/bin/app.ts`
and the workflow if you prefer another). Stack name: `RiddleStack`. Every resource is
tagged `project=riddle`.

---

## 0. Prerequisites (one time, on your machine)

- Node.js 20+ (`node -v`)
- AWS CLI configured: `aws configure` (use an IAM user/SSO profile with admin rights for the initial setup)
- `npm install -g aws-cdk` (or use `npx cdk` everywhere)

## 1. The Anthropic API key secret

Riddle reads the key from `cofounder/anthropic-api-key` — the **same** Secrets Manager
secret as the co-founder app. The stack references it by name, so the value never passes
through CloudFormation. Nothing to do if that secret already exists.

To give Riddle its own key instead, create one and change `ANTHROPIC_SECRET_NAME` in
`backend/lib/app-stack.ts`:

```bash
aws secretsmanager create-secret \
  --name riddle/anthropic-api-key \
  --secret-string 'sk-ant-YOUR-KEY-HERE' \
  --region us-east-1
```

To rotate: `aws secretsmanager put-secret-value --secret-id <name> --secret-string '...'`.

## 2. Deploy the backend

```bash
cd backend
npm install
npx cdk bootstrap aws://136311627418/us-east-1   # one time per account/region
npx cdk deploy
```

The outputs print **ApiUrl**, **UserPoolId** and **UserPoolClientId**.
Test it: `curl <ApiUrl>/health`

## 3. Make yourself an admin

`POST /admin/generate` is gated on membership of the Cognito `admins` group, which the
stack creates. After signing a user up:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> --username you@example.com --group-name admins
```

Log in again afterwards — group membership is baked into the token at login.

## 4. Seed the riddle bank

```bash
./scripts/seed.sh <ApiUrl> <admin-email> <admin-password>
```

Generates 10 riddles per difficulty via `POST /admin/generate`, in batches of 5 so each
call stays inside API Gateway's 30-second integration timeout.

---

## The API

Everything except `/health`, `/signup` and `/login` requires
`Authorization: Bearer <idToken>`. The API Gateway **JWT authorizer** validates the token
against the Cognito user pool issuer, so an invalid or expired token never reaches the
Lambda.

Send the **ID token** from `/login`. The authorizer also accepts the access token — for
Cognito it matches either `aud` or `client_id` against the app client id — but only the ID
token carries the `email` and `cognito:groups` claims that the profile and the admin gate
read, so an access token cannot reach `/admin/generate`.

| Method | Path                    | Auth  | Purpose |
| ------ | ----------------------- | ----- | ------- |
| `GET`  | `/health`               | —     | Health check |
| `POST` | `/signup`               | —     | `{ email, password }` — creates and auto-confirms an account |
| `POST` | `/login`                | —     | `{ email, password }` → `{ idToken, accessToken, refreshToken }` |
| `GET`  | `/me`                   | JWT   | Profile, score, streak, hints used today |
| `GET`  | `/riddles/next?difficulty=easy` | JWT | An unseen riddle at that difficulty. Never includes the answer. |
| `POST` | `/riddles/{id}/guess`   | JWT   | `{ guess }` → `correct` / `close` / `wrong` |
| `POST` | `/riddles/{id}/hint`    | JWT   | Next unrevealed hint, max 3 per riddle |
| `POST` | `/admin/generate`       | JWT + `admins` | `{ count, difficulty, topic? }` — batch-generates riddles |

### Scoring

A solve is worth **easy 10 / medium 25 / hard 50**, minus **5 per hint** taken on that
riddle, floored at zero. The streak counts consecutive UTC days on which you solved at
least one riddle.

### How a guess is judged

The guess is normalised first — lowercased, stripped of accents and punctuation, leading
article removed. If that matches the answer, it is correct and **no model call is made**.
Only a non-exact guess costs one Claude call, which returns strict JSON
(`{ verdict, reason }`) deciding `correct` / `close` / `wrong`. If the model output cannot
be parsed twice in a row, the guess falls back to "not accepted" rather than failing the
request.

---

## Observability

Every request writes a structured JSON audit trail. All events of one request share
`requestId` — API Gateway's own — so the Lambda events and the access-log line join on it.

| Log group | Contents | Retention |
| --------- | -------- | --------- |
| `/aws/lambda/riddle-api` | `request` → `llm_call` / `db_write` / `guess_resolved` → `response` | 90 days |
| `/aws/apigateway/riddle-api-access` | one line per HTTP request, including the 401s the authorizer rejects before the Lambda runs | 90 days |

**No user content is ever logged** — no guess text, no riddle answers. Ids, enum values,
counts and timings only. See CLAUDE.md before adding an event.

Most guesses are settled by normalisation and make no model call, so they emit **no**
`llm_call` event; `guess_resolved.resolution` records which path was taken.

Six queries ship with the stack — CloudWatch → **Logs Insights** → *Saved queries*,
prefix `riddle/`:

| Query | Answers |
| ----- | ------- |
| per-user activity trail | everything one player did (paste their `sub`) |
| single-request story | every event of one request in order (paste a `requestId`) |
| latency by route | avg / p50 / p95 / max per route |
| llm-judged vs normalized guesses | how many guesses cost a Claude call |
| token spend by user | input/output tokens by user and purpose |
| rejected before the lambda | 401 / 403 / 429 from the access log |

## Layout

```
backend/src/
  handler.ts       routing + error → HTTP status mapping
  auth.ts          reads the JWT authorizer's verified claims; admin group gate
  routes/          parse and validate HTTP input, then delegate
  engine/          scoring, streaks, orchestration, batch generation
  llm/             the only place that knows Claude exists
  db/              the only place that talks to DynamoDB
  prompts/         personas + the strict JSON output contracts
```

`engine/scoring.ts` is pure — no IO, no model, no clock beyond what the caller passes in.

### DynamoDB single-table layout

| pk | sk | Contents |
| -- | -- | -------- |
| `RIDDLE#<id>` | `META` | text, answer, difficulty, topic, hints[3], timesServed, timesSolved |
| `USER#<id>` | `PROFILE` | score, streak, hintsUsedToday |
| `USER#<id>` | `ATTEMPT#<riddleId>` | guesses, hintsTaken, solved, points |
| `DAILY#<date>` | `META` | per-UTC-day activity counters |

Riddle rows also carry `gsi1pk = DIFF#<difficulty>` / `gsi1sk = RIDDLE#<id>` for the
`byDifficulty` GSI, so `GET /riddles/next` pages one difficulty without a table scan.

---

## 5. Deploy the frontend with Amplify Hosting

1. AWS Console → **Amplify** → *Create new app* → *GitHub* → authorize → pick your repo + `main` branch.
2. Amplify detects the monorepo — set **App root** to `frontend` (the included `amplify.yml` handles the build).
3. Add an environment variable: `VITE_API_URL` = your ApiUrl from step 2.
4. Deploy. You get a live `https://main.xxxx.amplifyapp.com` URL. Every push to `main` redeploys automatically.

## 6. Automate backend deploys via GitHub Actions (OIDC — no stored AWS keys)

One-time IAM setup so GitHub can assume a role in your account:

```bash
# a) Create the GitHub OIDC identity provider (skip if it already exists)
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

# b) Create the deploy role — first edit trust-policy.json below with your repo name
aws iam create-role --role-name GitHubActionsDeployRole \
  --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name GitHubActionsDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

`trust-policy.json` (replace `REPO_NAME` if you named the repo differently):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::136311627418:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:yimengzhang-beta/riddle:*" }
    }
  }]
}
```

> AdministratorAccess is the quick start; tighten it to CDK-specific permissions once things work.

After this, every push to `main` that touches `backend/` triggers `.github/workflows/deploy-backend.yml` and redeploys the API automatically.
