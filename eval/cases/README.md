# Eval Case Format

JSON files may contain one case object or an array of case objects. Files are
loaded recursively. IDs must be unique across `eval/cases/`.

A labeled case uses this shape:

```json
{
  "version": "eval-case.v1",
  "evaluationPath": "structured-assessment",
  "annotationStatus": "labeled",
  "id": "unique-id",
  "questionRef": { "caseId": "zinc-copper", "nodeId": "P4" },
  "studentAnswer": "raw answer, unchanged",
  "expectedExtraction": {
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

For P3/P6/P7, set `evaluationPath` to `equation`, add `equationSetId` inside
`questionRef`, and use one expected slot with `id: "equation"`. Those cases are
scored by the production equation engine rather than an LLM provider.
