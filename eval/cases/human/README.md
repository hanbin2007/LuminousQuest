# Human Golden Cases

This directory intentionally contains no human sample yet. Add reviewed cases
using the labeled format in `../README.md`, with `source: "human"` and the raw
answer preserved in `studentAnswer`.

Before committing a case:

1. Remove names, contact details, school/class identifiers, addresses, and
   student numbers that are not required for the scientific judgment.
2. Have the named annotator fill every expected slot and score against the
   pinned `rubricVersion`.
3. Have a different reviewer record rubric/adjudication references, approve
   metamorphic applicability, and leave `expectedDisagreement: false`.
4. Mark serious full-wrong opportunities explicitly as auxiliary audit data;
   the safety denominator is still derived from every ground-truth miss.
5. Run `pnpm eval:mock` to validate schema, references, citations, and coverage.
