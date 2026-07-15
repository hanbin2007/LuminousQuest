# Eval Reports

Each CLI mode writes `latest-<mode>.md` here. Generated latest reports are
ignored by Git. Reports contain configured gates, per-node accuracy, the
five-way case-vote confusion matrix, ground-truth-miss safety denominator,
expected/attempted/exact extraction counts, score/output consistency,
unobserved serious cases, applicable-only metamorphic invariance, coverage,
latency, tokens, and estimated cost when pricing is configured. Mock reports are
headed `自洽性检查,非质量门禁`; holdout reports omit all case-level rows.
