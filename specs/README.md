# Specs — filing convention

**Repo root** holds only: `PROJECT_KNOWLEDGE.md`, specs for the **active workstream**
(currently the Sweet Spot family — engine, §4c, tier B/C, ops), and specs that are
**approved-or-proposed but unbuilt** (currently `WNBA_PREGAME_AGENT_SPEC.md`).

- **`specs/shipped/`** — implemented specs, kept as reference for how live behavior was
  designed. Status headers inside these files are frozen at pre-ship wording ("awaiting
  approval") — the filing location is the status. `PROJECT_KNOWLEDGE.md` describes what
  actually shipped; when they disagree, project knowledge wins.
- **`specs/rejected/`** — ruled out or superseded. These carry a do-not-revisit signal
  (e.g., VULNERABILITY replaced by the MC engine; trajectory research killed at
  +0.0003 AUC). Do not rebuild anything here without a genuinely new mechanism.
- **`research/`** — findings, backtest results, test plans, fixture harnesses, session
  summaries, and the betting log. New research artifacts use a `YYYY-MM-DD_` prefix.

**Lifecycle:** spec is written at root → approved → built → moved to `specs/shipped/`
in the shipping session (or `specs/rejected/` if the line dies). When a spec ships,
its durable content migrates to `PROJECT_KNOWLEDGE.md` at the next doc refresh.
