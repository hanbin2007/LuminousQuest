import { ChevronLeft, SkipForward } from 'lucide-react';
import { useId } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import { EquationToolbar } from './EquationToolbar';

type Question = PretestConfig['questions'][number];

interface QuestionCardProps {
  question: Question;
  dimensionLabel: string;
  answer?: string;
  busy?: boolean;
  questionIndex?: number;
  questionTotal?: number;
  onAnswerChange: (value: string) => void;
  onPrevious?: () => void;
  onSkip?: () => void;
  onSubmit: (value: string) => void;
}

export function QuestionCard({
  question,
  dimensionLabel,
  answer = '',
  busy = false,
  questionIndex = 1,
  questionTotal = 1,
  onAnswerChange,
  onPrevious,
  onSkip,
  onSubmit,
}: QuestionCardProps) {
  const textareaId = useId();
  const isChoice = question.type === 'choice';
  const counter = `${String(questionIndex).padStart(2, '0')} / ${String(questionTotal).padStart(2, '0')}`;

  return (
    <article className={`question-card ds-frame ds-frame--paper${question.group ? ' question-card--has-context' : ''}`}>
      <header className="question-card__meta">
        <span className="question-card__counter">{counter}</span>
        <span className="question-card__tag">
          <span>{isChoice ? '选择题' : '简答题'}</span>
          <span aria-hidden="true"> · </span>
          <span>{dimensionLabel}</span>
          <span aria-hidden="true">维度</span>
        </span>
      </header>
      {question.group ? (
        <section className="exam-question-context" aria-label={question.group.title}>
          <div>
            <span className="exam-question-context__badge">{question.group.title}</span>
            <p>{question.group.stimulus}</p>
          </div>
          <img
            src={`/${question.group.figure}`}
            alt={`${question.group.title}装置图`}
          />
        </section>
      ) : null}
      <h2>{question.prompt}</h2>
      {isChoice ? (
        <fieldset className="choice-list">
          <legend className="visually-hidden">选择一个答案</legend>
          {question.options.map((option) => (
            <label key={option.id} className="choice-option ds-control">
              <input
                type="radio"
                name={question.id}
                value={option.id}
                checked={answer === option.id}
                onChange={(event) => onAnswerChange(event.target.value)}
                aria-label={`${option.id}. ${option.text}`}
              />
              <span className="choice-option__key">{option.id}</span>
              <span>{option.text}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="text-answer">
          <EquationToolbar textareaId={textareaId} value={answer} onChange={onAnswerChange} />
          <textarea
            id={textareaId}
            aria-label="简答作答"
            value={answer}
            onChange={(event) => onAnswerChange(event.target.value)}
            rows={9}
            placeholder="在此写出电极反应式与你的分析…"
          />
        </div>
      )}
      <footer className="question-card__actions">
        <button
          aria-label="上一题"
          className="question-previous"
          disabled={!onPrevious || busy}
          onClick={onPrevious}
          title="上一题"
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        {onSkip ? (
          <button
            className="question-skip ds-control"
            disabled={busy}
            onClick={onSkip}
            type="button"
          >
            <SkipForward aria-hidden="true" />
            跳过
          </button>
        ) : null}
        <button
          aria-label="提交作答"
          className="primary-button question-submit"
          disabled={busy || answer.trim().length === 0}
          onClick={() => onSubmit(answer)}
          type="button"
        >
          {busy ? '正在提取' : questionIndex === questionTotal ? '完成作答' : '下一题'}
        </button>
      </footer>
    </article>
  );
}
