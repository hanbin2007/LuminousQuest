# Eval Recordings

Live mode writes one local `eval-recording.v1` file per case, variant, and run.
Each file keeps the ordered provider responses so schema/citation retries can be
replayed exactly. JSON recordings are ignored by Git and may contain model
echoes of student text; audit them before any distribution.

Holdout mode is excluded from this store. Its provider responses stay in memory
for aggregate metrics and are discarded when the process exits.

The M1c.1 shared-temperature/config-digest change invalidates prior request
hashes. No JSON recordings were present in this worktree at migration time;
the next live run must create a fresh set before replay is considered valid.
