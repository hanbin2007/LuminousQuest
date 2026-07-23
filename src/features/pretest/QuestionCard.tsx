import { ArrowRight, ChevronLeft, SkipForward } from 'lucide-react';
import { useId } from 'react';

import type { PretestConfig } from '../../../shared/config/schemas';
import { EquationToolbar } from './EquationToolbar';
import {
  hasVisibleAnswer,
  joinFillAnswer,
  originalExamDisplayAnswer,
  originalExamFillKind,
  originalExamPrompt,
  originalExamTitle,
  splitFillAnswer,
} from './exam-flow';

type Question = PretestConfig['questions'][number];

interface GroupProgressItem {
  id: string;
  label: string;
  answered: boolean;
  current: boolean;
}

interface QuestionCardProps {
  question: Question;
  dimensionLabel: string;
  answer?: string;
  busy?: boolean;
  questionIndex?: number;
  questionTotal?: number;
  groupProgress?: GroupProgressItem[];
  onAnswerChange: (value: string) => void;
  onGroupNavigate?: (questionId: string) => void;
  onPrevious?: () => void;
  onSkip?: () => void;
  onSubmit: (value: string) => void;
}

function OriginalExamFill({
  questionId,
  answer,
  onChange,
}: {
  questionId: string;
  answer: string;
  onChange: (value: string) => void;
}) {
  const kind = originalExamFillKind(questionId);
  if (!kind) return null;
  const displayAnswer = originalExamDisplayAnswer(questionId, answer);

  if (kind === 'ratio') {
    return (
      <label className="exam-fill exam-fill--ratio">
        <span>K : O₂</span>
        <span className="exam-fill__control ds-control">
          <input
            aria-label="K 与 O₂ 的物质的量之比"
            autoComplete="off"
            inputMode="text"
            maxLength={7}
            onChange={(event) => onChange(event.target.value)}
            placeholder="例如 1:1"
            value={displayAnswer}
          />
        </span>
      </label>
    );
  }

  if (kind === 'substance') {
    const isMaterial = questionId === 'pretest-exam4-material';
    return (
      <label className="exam-fill exam-fill--substance">
        <span>{isMaterial ? '电极材料' : '失电子物质'}</span>
        <span className="exam-fill__control ds-control">
          <input
            aria-label={isMaterial ? 'b 电极的电极材料' : 'b 电极实际失电子的物质'}
            autoComplete="off"
            inputMode="text"
            maxLength={32}
            onChange={(event) => onChange(event.target.value)}
            placeholder="物质名称或化学式"
            value={displayAnswer}
          />
        </span>
      </label>
    );
  }

  if (kind === 'amount') {
    return (
      <label className="exam-fill exam-fill--ratio">
        <span>n(e⁻)</span>
        <span className="exam-fill__control ds-control">
          <input
            aria-label="a 电极流入电子的物质的量"
            autoComplete="off"
            inputMode="decimal"
            maxLength={16}
            onChange={(event) => onChange(event.target.value)}
            placeholder="mmol"
            value={displayAnswer}
          />
        </span>
        <span>mmol</span>
      </label>
    );
  }

  const [first, second] = splitFillAnswer(displayAnswer);
  const isPolarity = kind === 'polarity';

  return (
    <div className="exam-fill-pair">
      <label className="exam-fill">
        <span>{isPolarity ? 'a 极' : '电子从'}</span>
        <span className="exam-fill__control ds-control">
          <input
            aria-label={isPolarity ? '电极 a 的极性' : '电子流出电极'}
            autoComplete="off"
            maxLength={isPolarity ? 2 : 1}
            onChange={(event) => onChange(joinFillAnswer(event.target.value, second))}
            placeholder={isPolarity ? '正 / 负' : 'a / b'}
            value={first}
          />
        </span>
      </label>
      <ArrowRight aria-hidden="true" />
      <label className="exam-fill">
        <span>{isPolarity ? 'b 极' : '流向'}</span>
        <span className="exam-fill__control ds-control">
          <input
            aria-label={isPolarity ? '电极 b 的极性' : '电子流入电极'}
            autoComplete="off"
            maxLength={isPolarity ? 2 : 1}
            onChange={(event) => onChange(joinFillAnswer(first, event.target.value))}
            placeholder={isPolarity ? '正 / 负' : 'a / b'}
            value={second}
          />
        </span>
      </label>
    </div>
  );
}

export function QuestionCard({
  question,
  dimensionLabel,
  answer = '',
  busy = false,
  questionIndex = 1,
  questionTotal = 1,
  groupProgress,
  onAnswerChange,
  onGroupNavigate,
  onPrevious,
  onSkip,
  onSubmit,
}: QuestionCardProps) {
  const textareaId = useId();
  const isChoice = question.type === 'choice';
  const fillKind = isChoice ? originalExamFillKind(question.id) : null;
  const activeGroupIndex = groupProgress?.findIndex((item) => item.current) ?? -1;
  const counter = groupProgress
    ? `${String(activeGroupIndex + 1).padStart(2, '0')} / ${String(groupProgress.length).padStart(2, '0')}`
    : `${String(questionIndex).padStart(2, '0')} / ${String(questionTotal).padStart(2, '0')}`;
  const typeLabel = fillKind ? '填空题' : isChoice ? '选择题' : '简答题';
  const prompt = originalExamPrompt(question.id) ?? question.prompt;
  const canSubmit = hasVisibleAnswer(answer);

  return (
    <article
      className={`question-card ds-frame ds-frame--paper${question.group ? ' question-card--has-context' : ''}`}
      data-glass-material="frosted"
      role="article"
    >
      {question.group ? (
        <section className="exam-question-context" aria-label={question.group.title}>
          <div className="exam-question-context__copy">
            <span className="exam-question-context__badge">{question.group.title}</span>
            <h2>{originalExamTitle(question.group.id) ?? question.group.title}</h2>
            <p>{question.group.stimulus.replace(/^【高考真题】/, '')}</p>
          </div>
          <img
            src={`/${question.group.figure}`}
            alt={`${question.group.title}装置图`}
          />
          {groupProgress ? (
            <ol className="exam-question-progress" aria-label="大题小题进度">
              {groupProgress.map((item) => (
                <li
                  key={item.id}
                  aria-current={item.current ? 'step' : undefined}
                  data-answered={item.answered || undefined}
                >
                  <button
                    aria-label={`${item.label}，${item.answered ? '已作答' : '未作答'}`}
                    disabled={busy}
                    onClick={() => onGroupNavigate?.(item.id)}
                    type="button"
                  >
                    <span>{item.label}</span>
                    <small>{item.current ? '当前' : item.answered ? '已答' : '未答'}</small>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
      <section className="question-card__answer-panel">
        <header className="question-card__meta">
          <span className="question-card__counter">{counter}</span>
          <span className="question-card__tag">
            <span>{typeLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>{dimensionLabel}</span>
            <span aria-hidden="true">维度</span>
          </span>
        </header>
        <div className="question-card__question" key={question.id}>
          <h2>{prompt}</h2>
          {fillKind ? (
            <OriginalExamFill
              answer={answer}
              onChange={onAnswerChange}
              questionId={question.id}
            />
          ) : isChoice ? (
            <fieldset className="choice-list">
              <legend className="visually-hidden">选择一个答案</legend>
              {question.options.map((option) => (
                <label
                  key={option.id}
                  className="choice-option ds-control"
                >
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
              <div className="text-answer__surface ds-control">
                <textarea
                  id={textareaId}
                  aria-label="简答作答"
                  value={answer}
                  onChange={(event) => onAnswerChange(event.target.value)}
                  rows={9}
                  placeholder="写下你的判断与理由…"
                />
              </div>
            </div>
          )}
        </div>
        <footer className="question-card__actions">
          <button
            aria-label="上一题"
            className="question-previous ds-control"
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
            className="question-submit ds-control"
            disabled={busy || !canSubmit}
            onClick={() => onSubmit(answer)}
            type="button"
          >
            {busy
              ? '正在提取'
              : groupProgress && activeGroupIndex === groupProgress.length - 1
                ? '完成大题'
                : questionIndex === questionTotal
                  ? '完成作答'
                  : '下一题'}
          </button>
        </footer>
      </section>
    </article>
  );
}
