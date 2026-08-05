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
      proposed data model.
- [x] **Phase 1** — Standalone `parse_demo.py` → `out.json`. **← awaiting your review.**
      Verified against the one real demo. Notes:
      - Installed + pinned: `demoparser2==0.41.4`, `awpy==2.0.2` (API introspected,
        not guessed; re-introspect before bumping).
      - The sample demo is **de_inferno**, not Mirage. Doesn't affect parsing, but
        the Phase 2 coordinate work will start on whatever map(s) we have demos for.
      - demoparser2's header does not expose tickrate; we assume 64 (CS2 standard)
        and flag `tickrate_assumed: true` rather than invent a value.
      - The sample recording is truncated on the final round (22 freeze-ends, 21
        official ends) → parser keeps 21 complete rounds, reports 12–9, and emits a
        `warnings[]` entry that the real score is likely one higher (13–9).
      - `bomb_planted.site` is a numeric entity id, not 'A'/'B'; site letter is a
        Phase 2 job (derive from plant coordinates + awpy map data).
- [x] **Phase 2** — Offline viewer (coordinate transform). **← awaiting your review.**
      React + TS + Vite + Tailwind + Canvas 2D. Notes:
      - **Coordinate transform verified.** Ported awpy's exact formula
        (`awpy.plot.utils.game_to_pixel_axis`): `px=(x-pos_x)/scale`,
        `py=(pos_y-y)/scale` on a 1024 radar. Constants for de_inferno
        (`pos_x=-2087, pos_y=3870, scale=4.9`) come from the CS2 game overview
        file (SteamDatabase/GameTracking-CS2), not memory.
      - **Debug overlay proves alignment**: demo-derived spawns land on the
        overview's official spawn anchors, and all 21 rounds' bomb plants cluster
        on the official A/B sites. Toggle it with the "debug overlay" button.
      - **Radar bitmaps + calibration for the whole active-duty pool** are bundled
        in `frontend/public/maps/` (mirage, inferno, nuke, overpass, ancient,
        anubis, dust2, train, vertigo). Both the 1024² radar PNGs and the
        `pos_x/pos_y/scale` come from the CS2 game depot via
        `MurkyYT/cs2-map-icons` (awpy's own CDN awpycs.com is blocked here). If a
        map JSON/PNG is missing, the viewer falls back to a calibrated grid.
      - **Verified for de_inferno** (the demo we have) via the debug overlay:
        spawns/plants land on the real radar's spawns/sites. Other maps use the
        identical transform + same-source constants; verify each with its own
        demo when available.
      - **Multi-level maps (nuke/vertigo/train)** currently render the UPPER radar
        only; lower-level radar + `lower_level_max_units` switching is a TODO.
      - Viewer loads any `out.json` via a drop-zone; a local sample can be
        bundled with `make sample` (gitignored, not committed).
      - Colours players by team (A=ochre/started-T, B=blue/started-CT), view
        cones from yaw, kill ✕ markers, utility blooms, bomb marker, scrub bar
        with event notches, round rail, live scoreboard.
      - **Pages preview** (`.github/workflows/pages.yml`) deploys the static
        viewer to GitHub Pages. One-time manual step: repo Settings → Pages →
        Source "GitHub Actions" (the workflow token cannot enable Pages itself).
- [ ] Phase 3 — Backend (upload, queue, worker, persistence, accounts)
- [~] **Phase 4** — AI analysis layer. **Standalone prototype built ahead of the
      backend** (client wanted to hand the analysis to real users before Phase 3).
      **← awaiting your review.** Notes:
      - `scripts/analyze_demo.py out.json --team A|B [--dry-run]` — same standalone
        shape as `parse_demo.py`: no web, no DB, no queue. Reads only the derived
        `out.json` (never the .dem).
      - **Team-selectable** (`--team A|B`): players analyse their own team. All
        rates are computed from that team's point of view. Verified A and B
        perspectives mirror (B's T rounds = A's CT rounds, opening-duel wins sum to
        rounds, etc.).
      - **Feature layer** (`app/features/match_features.py`): aggregates the parsed
        events into a compact team-scoped JSON (~1.6k tokens for the sample; the
        brief's 4-6k ceiling is enforced by a test). Emits side split, buy-type
        outcomes, opening-duel rate, trade kills, multikills, per-player stats,
        utility usage, and a compact per-round list. **Side-per-round is derived
        from data** (score delta + `winner_side`), not from assumed MR12/overtime
        switch rules — robust to any format. `FEATURE_VERSION` guards the schema.
      - **Patterns computed in Python, not the model** (brief: pattern-finding is in
        SQL/pandas, not the LLM). `_compute_patterns` emits a `patterns` block:
        `recurring_utility` (same player throwing the same grenade type to ~the same
        spot across many rounds — bucketed by a coarse coordinate grid), the team's
        `opening_dependency` (round win% when it won vs lost the opening duel), and
        `repeat_first_deaths`. The model only narrates these; it never finds them.
      - **Versioned prompt file** `app/analysis/prompts/coach_v2.md` (a file, per the
        brief — not a string in code). v2 leads with the detected patterns, writes in
        the requested **language** (RU/EN — CS terms kept in English), and supports a
        **question mode**: a non-empty user question is answered directly and
        grounded in the data instead of the full write-up. `PROMPT_VERSION` recorded
        on every call; system prompt is cached (language/question live in the user
        turn, so caching is preserved). `--lang` and `--question` on the CLI; the
        viewer's panel has a language toggle + an optional question box.
      - **Anthropic client** (`app/analysis/client.py`): key + model from env
        (`ANTHROPIC_API_KEY`, `ANALYSIS_MODEL_ID`, default
        `claude-haiku-4-5-20251001`); prompt caching on the system block; output
        hard-capped by `ANALYSIS_MAX_OUTPUT_TOKENS`; returns a `Usage` record
        (in/out/cached tokens + `cost_usd` from the env price config) ready for the
        `llm_usage` ledger; handles `stop_reason == "refusal"`. Import-safe with no
        key and no `anthropic` installed, so `--dry-run` always works.
      - **`--dry-run`** (the default when no key is present) prints the exact system
        prompt + features JSON the model would receive and makes **no** API call —
        so the model input is auditable before spending anything. A real call is
        only made when `ANTHROPIC_API_KEY` is set (loaded from a gitignored `.env`).
      - Tests in `tests/test_match_features.py` (feature correctness + real-demo
        invariants). No live API call is made in tests.
      - **Thin test server + viewer button** (so the client can try analysis "through
        the site" before the real backend). `app/main.py` is a minimal FastAPI app
        with ONE working feature: `POST /api/analyze` runs the feature layer + the
        Anthropic call **server-side** (key from the gitignored `.env`, never in the
        public bundle) and returns text + cost; `GET /api/health` reports whether a
        key is present. The viewer's **"✨ AI analysis"** button (`AnalysisPanel.tsx`)
        POSTs the parsed demo (minus the position blob) + chosen team and renders
        real loading / error / result states. Run it with
        `uvicorn app.main:app --port 8000`; the frontend targets it via `VITE_API_URL`
        (default `http://localhost:8000`). This is NOT the full Phase 3 backend — no
        upload/queue/DB/accounts — just an honest slice to exercise the analysis end
        to end. On the static Pages build there is no server, so the button reports
        that a live analysis needs the backend running.
      - Verified end to end against a real key: request reaches Anthropic and the
        pipeline is correct; the only thing pending is credits on the client's
        account (a live call currently returns a clean 402 "add credits" message,
        surfaced in the button's error state).
- [ ] Phase 5 — Payments & access control
- [ ] Phase 6 — Deploy (nginx, TLS, backups, runbook)
