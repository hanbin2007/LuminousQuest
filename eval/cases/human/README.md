# Human Golden Cases

This directory intentionally contains no human sample yet. Add reviewed cases
using the labeled format in `../README.md`, with `source: "human"` and the raw
answer preserved in `studentAnswer`.

Before committing a case:

1. Remove names, contact details, school/class identifiers, addresses, and
   student numbers that are not required for the scientific judgment.
2. Have the named annotator fill every expected slot and score against the
   pinned `rubricVersion`.
3. Mark serious full-wrong opportunities explicitly; do not infer them later
   from the model output.
4. Run `pnpm eval:mock` to validate schema, references, citations, and coverage.
