# Eval Case Format

JSON files may contain one case object or an array of case objects. Files are
loaded recursively. IDs must be unique across `eval/cases/`.

A labeled case uses this shape:

```json
{
  "version": "eval-case.v2",
  "evaluationPath": "structured-assessment",
  "annotationStatus": "labeled",
  "id": "unique-id",
  "questionRef": { "caseId": "zinc-copper", "nodeId": "P4" },
  "studentAnswer": "raw answer, unchanged",
  "expectedExtraction": {
    "anchors": [],
    "response": "substantive",
    "terminology": "model",
    "syllabus": "within",
    "contradiction": false,
    "typo": "none",
    "errorIds": ["P4-M1"],
    "slots": [
      { "id": "electron-from", "value": "Cu", "evidenceQuote": "铜极" }
    ],
    "evidenceQuotes": ["电子由铜极流向锌极。"]
  },
  "expectedScore": "miss",
  "annotator": "annotator-id",
  "reviewer": "independent-reviewer-id",
  "reviewStatus": "reviewed",
  "adjudicationVersion": "adjudication-table.v1.1",
  "rationale": {
    "rubricRefs": ["p4-miss"],
    "adjudicationRefs": ["§1"],
    "text": "The reversed direction meets P4-M1 and the frozen miss rule."
  },
  "expectedDisagreement": false,
  "metamorphicReview": {
    "reviewer": "independent-reviewer-id",
    "status": "approved",
    "variants": {
      "paraphrase": { "status": "approved", "rationale": "Meaning preserved." },
      "noise": { "status": "approved", "rationale": "Irrelevant suffix only." },
      "rename-person": { "status": "approved", "rationale": "Referent only." }
    }
  },
  "rubricVersion": "rubrics.v1.1",
  "source": "synthetic",
  "misconceptionIds": ["P4-M1"],
  "tags": ["misconception"],
  "seriousMisjudgmentOpportunity": true,
  "runs": 3
}
```

`runs` is optional and defaults to `eval/config.json`. `source` is exactly one
of `synthetic`, `human`, or `exam`. Every evidence quote must be an exact
substring of `studentAnswer`; each slot quote must directly express its value.
The reviewer must differ from the annotator. Every rationale cites frozen
rubric and adjudication identifiers. `expectedDisagreement` is fixed to `false`:
an engine disagreement is measured, never waived or used to rewrite truth.

For P3/P6/P7, set `evaluationPath` to `equation`, add `equationSetId` inside
`questionRef`, and use one expected slot with `id: "equation"`. Negative cases
carry specific expected `errorIds`; the harness compares them with diagnostics
emitted by the production equation engine. Equation whitespace and
person-renaming no-ops are signed `not-applicable` and excluded from the
metamorphic denominator.
