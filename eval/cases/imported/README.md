# Imported Candidates

`pnpm eval:import-candidates` converts M1b files from
`recordings/eval-candidates/` into local `*.pending.json` cases here. The
importer recalculates the failure category with current citation rules and
replaces stale config, prompt, schema, and threshold provenance.

Pending files are ignored by Git and excluded from harness runs. A human must
audit residual personal information, fill `expectedExtraction`,
`expectedScore`, `annotator`, and misconception labels, change
`annotationStatus` to `labeled`, then move the case to `../human/`.
