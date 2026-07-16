# M1c Evaluation Harness

For the 12 text-assessment nodes, the harness calls `runAssessmentExtraction`,
the internal function used by `POST /api/assessment/extract`, then sends the
validated extraction through the same deterministic rubric workflow used by
the route. It loads the production `structured-assessment` prompt, closed-set
schema, provider abstraction, and configuration digest. Both the production
route and eval read extraction temperature `0.1` from
`config/scaffold-policy.json`; eval has no private override. P3/P6/P7 cases call the production deterministic
equation workflow, so the golden set covers all 15 nodes without routing
equations through an LLM.

## Modes

- `pnpm eval:mock`: deterministic golden provider, no API key, default three
  runs per case. This is explicitly a self-consistency check, never a quality
  gate, and validates the harness, production extraction path, rubric path,
  metrics, diagnostics, report, and applicable metamorphic assertions.
- `pnpm eval:live`: starts with the configured five-case closed-set pilot.
  After inspecting its closed-set compliance, use
  `pnpm eval:live -- --live-stage full` for the formal run. Every provider response, including
  retry responses, is recorded under `eval/recordings/` for later replay.
- `pnpm eval:replay`: reads those recordings and passes each response back
  through the current production schema, citation validator, and scoring path.
- `pnpm eval:holdout`: loads only hash-manifested `eval/holdout/cases/`, rejects
  train/holdout ID or content duplicates, runs the live provider, and suppresses
  all case identifiers from the report. Provider responses remain memory-only;
  holdout runs never write replayable recordings.

Set `LQ_EVAL_PROVIDER` and `LQ_EVAL_MODEL` to override the live/replay target.
Supported live keys are `DEEPSEEK_API_KEY`, `TONGYI_API_KEY`, and
`ZHIPU_API_KEY`. Token prices are intentionally not hard-coded; set them in
`eval/config.json` when a cost estimate is required. Reports always include raw
input/output token totals.

Useful overrides:

```sh
pnpm eval:mock -- --runs 5
pnpm eval:live -- --provider tongyi --model qwen-plus
pnpm eval:live -- --live-stage full
pnpm eval:replay -- --recordings /path/to/eval-recordings
```

Generated recordings and `latest-*.md` reports are local artifacts and are
ignored by Git.

## Metric Semantics

- Accuracy, the confusion matrix, and node macro accuracy use one majority-vote
  `predictedScore` per case, so repeated runs are not treated as independent
  samples.
- Severe false mastery is `confusion[ground-truth miss][predicted hit]` divided
  by every observed ground-truth-miss case. The manual serious flag is auxiliary
  metadata only; unobserved flagged cases are reported separately.
- Extraction reports expected/attempted/exact counts together. Failed
  extraction is non-exact, and a zero observation denominator fails its gate.
- Citation hallucination includes rejected `citation-mismatch` and
  `normalization-insufficient` attempts, even if a retry later succeeds.
- Schema failure counts final `invalid-json`, `schema-invalid`, or
  `schema-definition` fallbacks.
- Score consistency is the proportion of cases whose repeated
  `predictedScore` values are all identical and is a quality gate. Exact output
  consistency is reported beside it but is not substituted for score
  consistency. Formal replay/live runs require at least three base runs per case.
- Metamorphic invariance compares each generated variant's score with the base
  case's modal score. It is independent from golden accuracy.

Coverage gates are hard-coded at 150 total cases, 5 cases per eligible node,
and 3 asserted diagnostics per configured misconception; `eval/config.json`
cannot lower them. The current corpus is explicitly `seed`, so M1c remains open.
Coverage applies to all 15 nodes and every configured misconception. The
report keeps equation-engine observations in the same confusion matrix, but
they contribute zero provider tokens and cannot create citation/schema errors.
