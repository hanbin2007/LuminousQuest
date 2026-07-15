# Independent Holdout

This directory is reserved for the independent M1c holdout set.

Holdout JSON must live under `cases/` and every file must appear in the
read-only `manifest.json` with its exact SHA-256. Normal corpus loading rejects
this path; only `pnpm eval:holdout` may load it. The loader verifies the hashes,
rejects undeclared files, and rejects train/holdout duplicates by both case ID
and normalized question/answer content.

- Never inspect holdout outcomes while editing prompts, aliases, schemas, or
  provider-specific instructions.
- Never copy a holdout answer or paraphrase into `eval/cases/`.
- Run holdout evaluation only at a declared checkpoint after prompt changes are
  frozen.
- Record the prompt version, config digest, provider/model, and run count with
  every result.
- A failed holdout informs the next iteration, but that same sample remains
  holdout and must not become a tuning example.

Holdout reports contain aggregate metrics only. No holdout samples are currently
declared; the empty manifest is intentional and keeps M1c open.
