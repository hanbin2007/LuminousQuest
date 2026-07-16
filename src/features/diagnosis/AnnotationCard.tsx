export type AnnotationStatus = 'hit' | 'partial' | 'miss' | 'unassessed' | 'needs-review';

const statusLabels: Record<AnnotationStatus, string> = {
  hit: '达到要求',
  partial: '部分达到',
  miss: '需要加强',
  unassessed: '未测到',
  'needs-review': '已作答，待教师复核',
};

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
        <span className="annotation-card__status">{statusLabels[status]}</span>
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
