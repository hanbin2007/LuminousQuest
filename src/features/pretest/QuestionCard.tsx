import { useEffect, useId, useRef, useState } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import { EquationToolbar } from './EquationToolbar';

type Question = PretestConfig['questions'][number];

interface QuestionCardProps {
  question: Question;
  answer?: string;
  busy?: boolean;
  onAnswerChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

function tokenDuration(name: string) {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith('ms') ? amount : value.endsWith('s') ? amount * 1000 : 0;
}

export function QuestionCard({
  question,
  answer = '',
  busy = false,
  onAnswerChange,
  onSubmit,
}: QuestionCardProps) {
  const textareaId = useId();
  const [submittedCorrect, setSubmittedCorrect] = useState(false);
  const [feedbackPending, setFeedbackPending] = useState(false);
  const feedbackTimer = useRef<number | null>(null);
  const isChoice = question.type === 'choice';
  const isJudgment = isChoice && question.options.length === 2;

  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
  }, []);

  return (
    <article className={`question-card${submittedCorrect ? ' question-card--correct' : ''}`}>
      <header>
        <span>{isJudgment ? '判断题' : isChoice ? '选择题' : '简答题'}</span>
        <span>{question.dimensionId === 'principle' ? '原理' : '能量'}</span>
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
        disabled={busy || feedbackPending || answer.trim().length === 0}
        onClick={() => {
          const correct = isChoice && question.options.find((option) => option.id === answer)?.correct === true;
          setSubmittedCorrect(correct);
          if (correct) {
            setFeedbackPending(true);
            const duration = tokenDuration('--delay-eflow-answer') + tokenDuration('--dur-eflow-answer');
            if (duration > 0) {
              feedbackTimer.current = window.setTimeout(() => {
                feedbackTimer.current = null;
                onSubmit(answer);
              }, duration);
              return;
            }
          }
          onSubmit(answer);
        }}
        type="button"
      >
        {busy ? '正在提取' : '提交作答'}
      </button>
    </article>
  );
}
