# CLAUDE.md — CS2 Demo Viewer + AI Analysis

This is the handover document. It is kept current as decisions change. Anyone
maintaining this project should be able to read it and understand the shape of
the system, the constraints it lives under, and how to run, test, and deploy it.

---

## 1. What this is

Competitive CS2 players upload their FACEIT match demo (`.dem`), pay, and get:

1. **A 2D viewer** — top-down radar replay: player positions, movement, kills,
   utility, scrubbable round by round.
2. **An AI written analysis** — plain-language breakdown of the match.
3. **Access gated behind payment** (credits, not an unlimited subscription).

Audience: FACEIT level 5–10 players, 16–30, who already use Leetify and CS Demo
Manager and will judge us against them in ten seconds.

---

## 2. Hard constraints (do not violate)

1. **Single VPS.** Hostinger KVM 2: 2 vCPU, 8 GB RAM, 100 GB NVMe, Ubuntu.
   Everything runs under one `docker compose up`. No Kubernetes, no managed
   cloud, no serverless. If a design needs more than this box, say so.
2. **Uploaded demos are deleted after parsing.** They are 200–400 MB each. Only
   derived data is kept. **Disk is the first thing that will kill this box.**
3. **Every third-party account belongs to the client.** Payment provider,
   Anthropic key, hosting. Every secret comes from env vars. Never hardcode a
   key, never assume a personal account, never sign anything up.
4. **Costs scale with users.** Every LLM call and every parse job is traceable
   to a user and countable. "What does one demo cost us?" must be answerable
   from the database at any time.
5. **No feature nobody asked for.** Missing something? List it and ask.

---

## 3. Stack

| Layer     | Choice |
|-----------|--------|
| Backend   | Python 3.12, FastAPI, **plain SQLAlchemy 2.x** (see note) + Pydantic |
| DB        | PostgreSQL 16 (self-hosted in compose) |
| Queue     | Redis + **RQ** worker process |
| Parser    | `demoparser2` / `awpy` — API verified against installed version, never guessed |
| Frontend  | React + TypeScript + Vite, **Canvas 2D** for the viewer |
| Styling   | Tailwind + a custom token layer |
| Payments  | Merchant-of-record (Lemon Squeezy or Paddle), hosted checkout, behind a thin interface |
| Deploy    | docker compose, nginx reverse proxy, Let's Encrypt via certbot |

**Note — SQLAlchemy over SQLModel (recommendation, needs your sign-off):** the
brief allows either. I recommend plain SQLAlchemy 2.x with separate Pydantic
schemas for the API boundary. SQLModel blurs the ORM model and the API schema
into one class, which is convenient until it isn't — its rough edges around
relationships and migrations cost more debugging time than the boilerplate it
saves. Explicit separation is easier to reason about at 2am. **Not final until
you agree.**

---

## 4. Data model (PROPOSED — Phase 0 deliverable, awaiting review)

Design principles:
- **Positions are a binary blob per round, never one row per tick.** 64 tick ×
  40 min × 10 players is millions of rows; we downsample to 8 ticks/sec and pack
  each round into one `bytea`.
- **Events go in normal, queryable tables** (kills, utility, bomb, buys), because
  the AI feature layer and the pattern-finding SQL query them.
- **Cost is a first-class citizen.** A per-user LLM usage ledger and a credit
  ledger make "what did this demo cost" and "how many credits does this user
  have" direct SQL queries.
- **Credits and payments are append-only ledgers**, so double-granting a payment
  is detectable and auditable rather than a silent balance overwrite.

### Entities

```
users
  id                uuid pk
  email             text unique not null
  password_hash     text            -- argon2; auth method TBD (see open questions)
  created_at        timestamptz
  updated_at        timestamptz

# --- Credits: append-only ledger. Balance = SUM(delta). ----------------------
credit_ledger
  id                uuid pk
  user_id           uuid fk users
  delta             int not null        -- +N on purchase, -1 on job consumption
  reason            text not null       -- 'purchase' | 'consume' | 'refund' | 'adjust'
  order_id          uuid fk orders null -- set when reason='purchase'/'refund'
  demo_id           uuid fk demos null  -- set when reason='consume'
  created_at        timestamptz
  # Invariant: a user's balance may never go negative. Enforced at job creation.

# --- The upload + parse job lifecycle, plus the parsed match summary ----------
# One row per uploaded file. The .dem itself is deleted after parsing;
# this row and its children are the derived data that remains.
demos
  id                uuid pk
  user_id           uuid fk users
  original_filename text
  file_size_bytes   bigint
  sha256            text                -- upload dedupe / integrity
  source            text                -- 'faceit_pov' | 'server' | 'unknown'
  status            text not null       -- see status enum below
  failure_reason    text null           -- USER-READABLE on failure
  map_name          text null           -- e.g. 'de_mirage'
  tickrate          int null            -- source demo tickrate (e.g. 64)
  team_a_score      int null
  team_b_score      int null
  match_started_at  timestamptz null    -- from demo, if available
  duration_seconds  int null
  uploaded_at       timestamptz
  parsed_at         timestamptz null
  file_deleted_at   timestamptz null    -- when the .dem was removed from disk
  created_at        timestamptz

  # status enum: uploaded -> queued -> parsing -> parsed
  #              -> analyzing -> complete
  #              (failed at any step, with failure_reason)

# --- Match-scoped players (10 per match; a steam id, not our user) ------------
players
  id                uuid pk
  demo_id           uuid fk demos
  steam_id          text
  name              text
  starting_side     text                -- 'T' | 'CT'
  team_label        text                -- 'A' | 'B'
  # final per-match stat summary (kills/deaths/adr/...) kept as columns for
  # cheap display; detailed per-round stats derive from events.
  kills             int
  deaths            int
  assists           int
  adr               numeric

rounds
  id                uuid pk
  demo_id           uuid fk demos
  round_number      int                 -- in-game number of the REAL round
  phase             text                -- 'live' (warmup/knife excluded, see parser rules)
  winner_side       text                -- 'T' | 'CT'
  end_reason        text                -- 'bomb_exploded'|'defused'|'time'|'t_elim'|'ct_elim'
  t_score_after     int
  ct_score_after    int
  t_buy_type        text                -- 'eco'|'force'|'full'|'pistol'
  ct_buy_type       text
  start_tick        int
  end_tick          int

# --- The compact binary position blob: ONE row per round --------------------
round_positions
  round_id          uuid pk fk rounds
  tps               int not null        -- ticks/sec sampled (8)
  frame_count       int not null
  player_order      jsonb               -- [player_id,...] mapping columns to slots
  format_version    int not null        -- bump when the packing layout changes
  data              bytea not null      -- packed frames; layout documented in parser/
  # Layout (format_version=1), per frame, per player slot:
  #   int16 x, int16 y, int16 z, uint16 yaw, uint8 health, uint8 flags
  #   flags bit0=alive. Absent players zero-filled + alive=0.

# --- Events: normal tables (queried by the feature layer & pattern SQL) ------
kills
  id                uuid pk
  round_id          uuid fk rounds
  tick              int
  attacker_id       uuid fk players null   -- null = suicide/world
  victim_id         uuid fk players
  assister_id       uuid fk players null
  weapon            text
  headshot          bool
  is_opening_duel   bool                    -- first kill of the round
  is_trade          bool                    -- traded a teammate's death within window
  attacker_x        int; attacker_y int
  victim_x          int;   victim_y   int

utility_events
  id                uuid pk
  round_id          uuid fk rounds
  tick              int
  player_id         uuid fk players
  kind              text                    -- 'he'|'flash'|'smoke'|'molotov'|'decoy'
  thrown_x int; thrown_y int
  detonate_x int null; detonate_y int null
  enemies_affected  int null                -- e.g. players flashed
  effect_value      numeric null            -- e.g. total blind duration (s)

bomb_events
  id                uuid pk
  round_id          uuid fk rounds
  tick              int
  player_id         uuid fk players null
  kind              text                    -- 'planted'|'defused'|'exploded'|'dropped'|'pickup'
  site              text null               -- 'A'|'B'

buys
  id                uuid pk
  round_id          uuid fk rounds
  player_id         uuid fk players
  item              text
  cost              int

# --- AI feature layer: the aggregated JSON that IS the model input -----------
# Storing it makes analysis retryable without re-parsing, and makes the exact
# model input auditable.
match_features
  demo_id           uuid pk fk demos
  feature_version   int not null            -- bump when the feature schema changes
  features          jsonb not null          -- ~4-6k tokens: per-round + per-match
  approx_tokens     int
  computed_at       timestamptz

# --- AI analysis output (a separate, retryable step) ------------------------
analyses
  id                uuid pk
  demo_id           uuid fk demos
  status            text                    -- 'pending'|'running'|'complete'|'failed'
  model_id          text                    -- resolved model, e.g. claude-haiku-4-5-20251001
  prompt_version    text                    -- version of the versioned prompt file used
  analysis_text     text null
  failure_reason    text null
  attempt_count     int default 0
  created_at        timestamptz
  completed_at      timestamptz null

# --- Per-user, per-job LLM cost ledger: countable, joinable to the user ------
llm_usage
  id                uuid pk
  user_id           uuid fk users
  demo_id           uuid fk demos
  analysis_id       uuid fk analyses null
  model_id          text
  input_tokens      int
  output_tokens     int
  cached_input_tokens int default 0
  cost_usd          numeric                 -- computed at write time from env price config
  created_at        timestamptz
  # "What does one demo cost us?" =
  #   SELECT demo_id, SUM(cost_usd) FROM llm_usage GROUP BY demo_id;

# --- Payments: idempotent webhook store + orders that grant credits ---------
payment_events
  id                uuid pk
  provider          text                    -- 'lemonsqueezy'|'paddle'
  provider_event_id text not null           -- UNIQUE(provider, provider_event_id)
  event_type        text
  signature_valid   bool
  raw_payload       jsonb
  received_at       timestamptz
  processed_at      timestamptz null
  processing_result text null               -- 'granted'|'refunded'|'duplicate'|'ignored'|'error'
  # UNIQUE(provider, provider_event_id) is how we make webhook delivery
  # idempotent: a second delivery of the same event is a no-op.

orders
  id                uuid pk
  user_id           uuid fk users
  provider          text
  provider_order_id text
  status            text                    -- 'paid'|'refunded'|'failed'|'cancelled'
  credits_granted   int
  amount            numeric
  currency          text
  created_at        timestamptz
```

### Lifecycle mapping (payments)

| Provider event    | Effect on access |
|-------------------|------------------|
| Payment succeeded | `orders` row (paid) + `credit_ledger` (+N) |
| Refund            | `orders` -> refunded + `credit_ledger` (−N reversal) |
| Failed renewal    | No credits granted (credit model = one-off packs) |
| Chargeback/cancel | `credit_ledger` (−N) if credits were granted |
| Duplicate webhook | `payment_events` UNIQUE hit → no-op |

Entitlement check on **every** job creation, server-side: `SUM(credit_ledger.delta) > 0`.
Never trust the frontend.

### Open questions on the data model (need your call)

1. **Auth method** — email + password (argon2), magic link, or OAuth (Steam)?
   Steam login is natural for this audience but adds a dependency. Affects the
   `users` table. My default if you don't say: email + password.
2. **`demos` holds match summary directly** (fewer joins) rather than a separate
   1:1 `matches` table. I think this is easier to debug; flagging in case you
   want match data isolated.
3. **Separate event tables vs one polymorphic `events` table** — I chose
   separate tables (kills/utility/bomb/buys) because each has a different shape
   and the feature SQL is clearer. Costs a few more tables. OK?

---

## 5. Folder structure (target)

```
.
├── CLAUDE.md                 # this file — the handover doc
├── docker-compose.yml        # single-box deployment
├── Makefile                  # make up / test / lint
├── .env.example              # every secret documented; real .env is gitignored
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI app
│   │   ├── config.py         # env -> typed settings
│   │   ├── db.py             # engine/session
│   │   ├── models/           # SQLAlchemy models
│   │   ├── schemas/          # Pydantic API schemas
│   │   ├── api/              # routers (upload, jobs, analysis, payments, auth)
│   │   ├── workers/          # RQ worker + job functions
│   │   ├── parser/           # demoparser2/awpy wrappers + position packing
│   │   ├── features/         # per-round/per-match feature computation
│   │   ├── analysis/         # Anthropic client
│   │   │   └── prompts/      # versioned prompt files (NOT strings in code)
│   │   ├── payments/         # thin provider interface + implementations
│   │   └── core/             # cost accounting, entitlements, security
│   ├── scripts/
│   │   └── parse_demo.py     # Phase 1 standalone CLI
│   ├── alembic/              # migrations
│   ├── tests/
│   ├── pyproject.toml
│   └── Dockerfile
├── frontend/
│   ├── src/
│   ├── package.json
│   └── Dockerfile
├── nginx/                    # reverse proxy config (Phase 6)
└── docs/
    └── RUNBOOK.md            # Phase 6 — written for someone who is not the author
```

---

## 6. Commands

```
make up      # start the stack (Phase 0: Postgres + Redis)
make down    # stop it
make logs    # tail logs
make test    # run tests (real once backend exists)
make lint    # ruff + mypy (backend), eslint (frontend)
```

Phase 1 (standalone parse, no web/db/queue):

```
python scripts/parse_demo.py <path.dem> > out.json
```

---

## 7. Cross-cutting rules (carried from the brief)

- **Parser:** verify the installed `demoparser2`/`awpy` API by introspection
  before writing parser code. Never guess field names. Validate against the one
  real `.dem` provided. Exclude warmup/knife; handle overtime, restarts,
  different round-end reasons, noisy POV demos, and corrupt/truncated files
  (fail cleanly with a user-readable reason).
- **Coordinates:** get `pos_x`, `pos_y`, `scale` from awpy map data, not
  remembered constants. Build a debug overlay to verify alignment per map.
  Mirage end-to-end first, then the rest of the active duty pool.
- **AI:** never send raw ticks. Parser computes features → aggregate to a
  ~4–6k-token JSON → model narrates. Pattern-finding is in SQL/pandas, not the
  model. Prompt caching on the system prompt. Log tokens in/out per job. Hard
  cap output tokens. Prompt is a versioned file. Analysis is a separate
  retryable step from parsing.
- **Payments:** verify webhook signatures, reject bad ones. Idempotent via
  stored provider event id. Handle the full lifecycle. Credits, not unlimited
  subscription. Server-side entitlement checks. Tests using provider fixtures.
- **Design:** dark UI earned with a considered palette (not `#0a0a0a` + one
  accent). Three type roles incl. tabular figures for all numbers. The viewer is
  the signature element; chrome recedes. Token plan + self-critique before
  building components. Real loading/empty/error states; error copy says what
  happened and what to do.
- **Way of working:** one phase at a time, stop at each gate. Verify external
  APIs instead of guessing. No silent scope additions. Comments explain *why*.
  Tests for anything that costs money or loses data (parsing, entitlements,
  webhooks).

---

## 8. Phase status

- [x] **Phase 0** — Agreement: this file, `docker-compose.yml`, `Makefile`,
      proposed data model. **← awaiting your review.**
- [ ] Phase 1 — Standalone `parse_demo.py` → `out.json`
- [ ] Phase 2 — Offline viewer (coordinate transform)
- [ ] Phase 3 — Backend (upload, queue, worker, persistence, accounts)
- [ ] Phase 4 — AI analysis layer
- [ ] Phase 5 — Payments & access control
- [ ] Phase 6 — Deploy (nginx, TLS, backups, runbook)
