# Independent Holdout

This directory is reserved for the independent M1c holdout set.

- Never inspect holdout outcomes while editing prompts, aliases, schemas, or
  provider-specific instructions.
- Never copy a holdout answer or paraphrase into `eval/cases/`.
- Run holdout evaluation only at a declared checkpoint after prompt changes are
  frozen.
- Record the prompt version, config digest, provider/model, and run count with
  every result.
- A failed holdout informs the next iteration, but that same sample remains
  holdout and must not become a tuning example.

No holdout samples are committed in the synthetic seed.
