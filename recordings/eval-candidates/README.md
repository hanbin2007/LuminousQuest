# Eval Candidate Handling

Eval candidates retain the complete redacted student answer so M1c can build a useful golden set. Files are local-only working data, not publication-ready artifacts.

Before any candidate or derived dataset is shared outside the local machine, a human reviewer must inspect the full payload for residual personal information, remove unnecessary context, and approve the distribution copy. `distribution.requiresHumanAudit` is a gate, not a claim that automated redaction is complete.
