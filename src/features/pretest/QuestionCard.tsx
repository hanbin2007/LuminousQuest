import { useId } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import { EquationToolbar } from './EquationToolbar';

type Question = PretestConfig['questions'][number];

interface QuestionCardProps {
  question: Question;
  dimensionLabel: string;
  answer?: string;
  busy?: boolean;
  onAnswerChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function QuestionCard({
  question,
  dimensionLabel,
  answer = '',
  busy = false,
  onAnswerChange,
  onSubmit,
}: QuestionCardProps) {
  const textareaId = useId();
  const isChoice = question.type === 'choice';

  return (
    <article className="question-card">
      {question.group ? (
        <section className="exam-question-context" aria-label={question.group.title}>
          <span className="exam-question-context__badge">{question.group.title}</span>
          <p>{question.group.stimulus}</p>
          <img
            src={`/${question.group.figure}`}
            alt={`${question.group.title}装置图`}
          />
        </section>
      ) : null}
      <header>
        <span>{isChoice ? '选择题' : '简答题'}</span>
        <span>{dimensionLabel}</span>
      </header>
      <h2>{question.prompt}</h2>
      {isChoice ? (
        <fieldset className="choice-list">
          <legend className="visually-hidden">选择一个答案</legend>
          {question.options.map((option) => (
            <label key={option.id} className="choice-option">
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
          />
        </div>
      )}
      <button
        className="primary-button question-submit"
        disabled={busy || answer.trim().length === 0}
        onClick={() => onSubmit(answer)}
        type="button"
      >
        {busy ? '正在提取' : '提交作答'}
      </button>
    </article>
  );
}
