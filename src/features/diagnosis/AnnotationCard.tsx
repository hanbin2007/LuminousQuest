export type AnnotationStatus = 'hit' | 'partial' | 'miss' | 'unassessed';

interface AnnotationCardProps {
  dimensionLabel: string;
  nodeId: string;
  rubricId: string;
  status: AnnotationStatus;
  correct: string;
  incorrect: string;
  next: string;
  quote?: string;
  fullQuote?: string;
}

export function AnnotationCard({
  dimensionLabel,
  nodeId,
  rubricId,
  status,
  correct,
  incorrect,
  next,
  quote,
  fullQuote,
}: AnnotationCardProps) {
  return (
    <article className="annotation-card" data-status={status} data-testid={`annotation-${nodeId}`}>
      <header>
        <span>{dimensionLabel}</span>
        <strong>{nodeId}</strong>
        <span>{rubricId}</span>
      </header>
      {quote ? <p className="annotation-card__quote">学生原文：<mark>{quote}</mark></p> : null}
      {fullQuote ? (
        <details className="annotation-card__full-quote">
          <summary>查看完整作答原文</summary>
          <pre>{fullQuote}</pre>
        </details>
      ) : null}
      <dl>
        <div>
          <dt>答对了什么</dt>
          <dd>{correct}</dd>
        </div>
        <div className="annotation-card__incorrect">
          <dt>错在哪里</dt>
          <dd>{incorrect}</dd>
        </div>
        <div className="annotation-card__next">
          <dt>下一步想什么</dt>
          <dd>{next}</dd>
        </div>
      </dl>
    </article>
  );
}
