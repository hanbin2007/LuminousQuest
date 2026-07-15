# M1c Evaluation Harness

For the 12 text-assessment nodes, the harness calls `runAssessmentExtraction`,
the internal function used by `POST /api/assessment/extract`, then sends the
validated extraction through the same deterministic rubric workflow used by
the route. It loads the production `structured-assessment` prompt, closed-set
schema, provider abstraction, and configuration digest. Eval requests use
temperature `0.1` by default. P3/P6/P7 cases call the production deterministic
equation workflow, so the golden set covers all 15 nodes without routing
equations through an LLM.

## Modes

- `pnpm eval:mock`: deterministic golden provider, no API key, default three
  runs per case. This validates the harness, production extraction path, rubric
  path, metrics, report, and metamorphic assertions.
- `pnpm eval:live`: configured real provider. Every provider response, including
  retry responses, is recorded under `eval/recordings/` for later replay.
- `pnpm eval:replay`: reads those recordings and passes each response back
  through the current production schema, citation validator, and scoring path.

Set `LQ_EVAL_PROVIDER` and `LQ_EVAL_MODEL` to override the live/replay target.
Supported live keys are `DEEPSEEK_API_KEY`, `TONGYI_API_KEY`, and
`ZHIPU_API_KEY`. Token prices are intentionally not hard-coded; set them in
`eval/config.json` when a cost estimate is required. Reports always include raw
input/output token totals.

Useful overrides:

```sh
pnpm eval:mock -- --runs 5
pnpm eval:live -- --provider tongyi --model qwen-plus
pnpm eval:replay -- --recordings /path/to/eval-recordings
```

Generated recordings and `latest-*.md` reports are local artifacts and are
ignored by Git.

## Metric Semantics

- Node macro accuracy is the unweighted mean of exact score-outcome accuracy
  across answer-extraction nodes.
- The severe false-mastery numerator counts marked cases for which any repeated
  base run returns `hit`; its denominator is the number of marked cases, never
  the number of runs.
- Citation hallucination includes rejected `citation-mismatch` and
  `normalization-insufficient` attempts, even if a retry later succeeds.
- Schema failure counts final `invalid-json`, `schema-invalid`, or
  `schema-definition` fallbacks.
- Consistency is the dominant canonical extraction-and-score signature divided
  by runs for each case, macro-averaged across cases.
- Metamorphic invariance compares each generated variant's score with the base
  case's modal score. It is independent from golden accuracy.

Coverage gates apply to all 15 nodes and every configured misconception. The
report keeps equation-engine observations in the same confusion matrix, but
they contribute zero provider tokens and cannot create citation/schema errors.
