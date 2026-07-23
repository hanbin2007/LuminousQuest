import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileJson,
  History,
  ListChecks,
  Upload,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { StudentSession } from '../../../shared/session/schema';
import { useAppContext } from '../../app/AppContext';
import { ClassRadar } from './ClassRadar';
import {
  buildClassSummary,
  buildTeacherStudentReport,
  importClassSessionFiles,
  MAX_CLASS_SESSION_FILES,
  MAX_CLASS_SESSION_FILE_BYTES,
  readClassSessionFileBatch,
  type AcceptedClassSession,
  type RejectedClassSession,
} from './teacher-data';

type TeacherView = 'student' | 'class';

const statusLabels = {
  scored: '已判定',
  unassessed: '未测到',
  'needs-review': '待复核',
  hit: '命中',
  'hit-with-help': '辅助后命中',
  partial: '部分命中',
  miss: '未命中',
  unanswered: '未作答',
} as const;

const agentVerdictLabels = {
  hit: '命中',
  partial: '部分命中',
  miss: '未命中',
  inconclusive: '无法判定',
} as const;

function uniqueSessions(sessions: readonly StudentSession[]) {
  const byId = new Map<string, StudentSession>();
  sessions.forEach((session) => {
    if (!byId.has(session.id)) byId.set(session.id, session);
  });
  return [...byId.values()];
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function HighlightedAnswer({
  text,
  evidence,
}: {
  text: string;
  evidence: readonly { quote: string; start: number; end: number }[];
}) {
  const ranges = evidence
    .map((item) => ({
      start: Math.max(0, Math.min(text.length, item.start)),
      end: Math.max(0, Math.min(text.length, item.end)),
    }))
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<Array<{ start: number; end: number }>>((merged, item) => {
      const previous = merged.at(-1);
      if (!previous || item.start > previous.end) return [...merged, item];
      previous.end = Math.max(previous.end, item.end);
      return merged;
    }, []);
  if (ranges.length === 0) return <p className="teacher-answer-text">{text}</p>;
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor) fragments.push(text.slice(cursor, range.start));
    fragments.push(
      <mark data-start={range.start} data-end={range.end} key={`${range.start}-${range.end}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) fragments.push(text.slice(cursor));
  return <p className="teacher-answer-text">{fragments}</p>;
}

function StudentEvidence({ session }: { session: StudentSession }) {
  const { config } = useAppContext();
  const report = useMemo(() => buildTeacherStudentReport(session, config), [config, session]);

  return (
    <div className="teacher-student-view">
      <section className="teacher-section" aria-labelledby="teacher-evidence-title">
        <header className="teacher-section__heading">
          <div>
            <span>AC3 · 分数可溯源</span>
            <h2 id="teacher-evidence-title">诊断证据链</h2>
          </div>
          <p>{report.rubricVersion} · {report.evidence.filter((item) => item.status === 'scored').length} 项已判定</p>
        </header>
        <div className="teacher-evidence-table" role="table" aria-label="量表证据链">
          <div className="teacher-evidence-table__header" role="row">
            <span role="columnheader">节点</span>
            <span role="columnheader">判定 / 分数</span>
            <span role="columnheader">量表规则</span>
            <span role="columnheader">证据</span>
          </div>
          {report.evidence.map((item) => (
            <details
              className={`teacher-evidence-row teacher-evidence-row--${item.dimensionId}`}
              data-status={item.outcome ?? item.status}
              key={item.nodeId}
              open={item.nodeId === 'P4' || item.status === 'needs-review'}
            >
              <summary>
                <span className="teacher-node-id">{item.nodeId}<small>{item.dimensionLabel}</small></span>
                <button
                  aria-controls={`teacher-evidence-detail-${item.nodeId}`}
                  aria-label={`${item.nodeId} 分数，${statusLabels[item.outcome ?? item.status]}${item.earned === null ? '' : `，${item.earned} / ${item.possible}`}`}
                  className="teacher-status teacher-score-entry"
                  onClick={(event) => {
                    event.preventDefault();
                    const details = event.currentTarget.closest('details');
                    if (details) details.open = true;
                    document.getElementById(`teacher-evidence-detail-${item.nodeId}`)?.focus();
                  }}
                  type="button"
                >
                  <span>{statusLabels[item.outcome ?? item.status]}</span>
                  {item.earned === null ? null : <small>{item.earned} / {item.possible}</small>}
                </button>
                <span>{item.ruleId ?? '尚无判分规则'}</span>
                <span>{item.evidenceQuotes.length > 0 ? `${item.evidenceQuotes.length} 条原文` : '无原文证据'}</span>
              </summary>
              <div
                className="teacher-evidence-detail"
                id={`teacher-evidence-detail-${item.nodeId}`}
                tabIndex={-1}
              >
                <div>
                  <h3>{item.rubricId} · {item.rubricVersion}</h3>
                  <p>{item.ruleDescription ?? '尚未形成自动判定。'}</p>
                  <dl>
                    <dt>量表条目</dt>
                    <dd>{item.rubricRequirements.map((requirement) =>
                      `${requirement.id} ${requirement.description}`).join('；')}</dd>
                    <dt>判分引擎</dt>
                    <dd>{item.engine ? `${item.engine.id} · ${item.engine.version}` : '未进入规则判定'}</dd>
                  </dl>
                </div>
                <div className="teacher-original-answer">
                  <h3>学生原文</h3>
                  {item.originalAnswer ? (
                    <>
                      <HighlightedAnswer text={item.originalAnswer} evidence={item.evidence} />
                      {item.evidence.length > 0 ? (
                        <ul className="teacher-evidence-ranges" aria-label={`${item.nodeId} 证据区间`}>
                          {item.evidence.map((evidence) => (
                            <li key={`${evidence.start}-${evidence.end}-${evidence.quote}`}>
                              [{evidence.start}, {evidence.end}) {evidence.quote}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : <p>本节点未测到，不能视为错误。</p>}
                  {item.misconceptionIds.length > 0 ? (
                    <p>闭集误区：{item.misconceptionIds.join('、')}</p>
                  ) : null}
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="teacher-section" aria-labelledby="teacher-training-title">
        <header className="teacher-section__heading">
          <div>
            <span>案例与迁移</span>
            <h2 id="teacher-training-title">训练过程记录</h2>
          </div>
          <History aria-hidden="true" />
        </header>
        {report.trainingRecords.length > 0 ? (
          <div className="teacher-data-table" role="table" aria-label="训练过程记录">
            <div role="row">
              <span role="columnheader">时间</span><span role="columnheader">案例</span>
              <span role="columnheader">节点</span><span role="columnheader">结果</span>
              <span role="columnheader">脚手架</span>
            </div>
            {report.trainingRecords.map((item) => (
              <div role="row" key={`${item.sequence}-${item.nodeId}`}>
                <span role="cell">{displayTime(item.occurredAt)}</span>
                <span role="cell">{item.caseTitle}</span>
                <span role="cell" className="teacher-node-id">{item.nodeId}</span>
                <span role="cell">{statusLabels[item.outcome]}</span>
                <span role="cell">{item.assistance.kind === 'none' ? '无' : `${item.assistance.kind} · ${item.assistance.rounds}`}</span>
              </div>
            ))}
          </div>
        ) : <p className="teacher-empty">暂无训练记录。</p>}
      </section>

      <section className="teacher-section teacher-agent-audit" aria-labelledby="teacher-agent-audit-title">
        <header className="teacher-section__heading">
          <div>
            <span>驾驶轨 / 记录轨</span>
            <h2 id="teacher-agent-audit-title">Agent 判断与分歧审计</h2>
            <p className="teacher-agent-audit__disclosure">量表记录以判分引擎为准</p>
          </div>
          <History aria-hidden="true" />
        </header>
        {report.agentAudit.judgments.length > 0 || report.agentAudit.divergences.length > 0 ? (
          <ol className="teacher-agent-audit__list">
            {report.agentAudit.judgments.map((item) => (
              <li data-kind="judgment" key={item.eventId}>
                <span className="teacher-node-id">{item.nodeId}</span>
                <div>
                  <strong>Agent {agentVerdictLabels[item.verdict]}</strong>
                  <p>{item.rationale}</p>
                  <small>{item.caseTitle} · 回合 {item.turnId}</small>
                </div>
                <time dateTime={item.occurredAt}>{displayTime(item.occurredAt)}</time>
              </li>
            ))}
            {report.agentAudit.divergences.map((item) => (
              <li
                data-kind="divergence"
                data-unresolved={item.unresolved || undefined}
                key={item.eventId}
              >
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>
                    Agent {agentVerdictLabels[item.agentVerdict]} · 判分引擎 {
                      agentVerdictLabels[item.shadowVerdict]
                    }
                  </strong>
                  <p>{item.status === 'detected' ? '检测到双轨分歧' : '双轨分歧已解决'}</p>
                  <small>{item.nodeId} · {item.comparisonPolicyVersion}</small>
                </div>
                <time dateTime={item.occurredAt}>{displayTime(item.occurredAt)}</time>
              </li>
            ))}
          </ol>
        ) : <p className="teacher-empty">本会话暂无 Agent 判断或分歧记录。</p>}
      </section>

      <div className="teacher-two-column">
        <section className="teacher-section" aria-labelledby="teacher-scaffold-title">
          <header className="teacher-section__heading">
            <div><span>辅助强度变化</span><h2 id="teacher-scaffold-title">脚手架轨迹</h2></div>
            <ListChecks aria-hidden="true" />
          </header>
          {report.scaffoldTrajectory.length > 0 ? (
            <ol className="teacher-timeline">
              {report.scaffoldTrajectory.map((item) => (
                <li key={item.sequence}>
                  <span>{item.nodeId}</span>
                  <div><strong>{item.level}</strong><p>{item.detail}</p></div>
                  <time dateTime={item.occurredAt}>{displayTime(item.occurredAt)}</time>
                </li>
              ))}
            </ol>
          ) : <p className="teacher-empty">本会话未使用脚手架。</p>}
        </section>

        <section className="teacher-section teacher-review-section" aria-labelledby="teacher-review-title">
          <header className="teacher-section__heading">
            <div><span>人工判定入口</span><h2 id="teacher-review-title">待复核清单</h2></div>
            <span className="teacher-review-section__status">
              {report.agentAudit.unresolvedCount > 0 ? (
                <span
                  aria-label={`${report.agentAudit.unresolvedCount} 条 Agent 分歧待复核`}
                  className="teacher-review-dot"
                  role="status"
                >
                  <i aria-hidden="true" />
                  {report.agentAudit.unresolvedCount}
                </span>
              ) : null}
              <ClipboardCheck aria-hidden="true" />
            </span>
          </header>
          {report.needsReview.length > 0 ? (
            <ul className="teacher-review-list">
              {report.needsReview.map((item) => (
                <li key={item.sequence}>
                  <AlertTriangle aria-hidden="true" />
                  {item.kind === 'divergence' ? (
                    <div>
                      <strong>{item.nodeId} · 双轨分歧</strong>
                      <p>{item.reason}</p>
                      <mark>
                        Agent {agentVerdictLabels[item.agentVerdict]} · 判分引擎 {
                          agentVerdictLabels[item.shadowVerdict]
                        }
                      </mark>
                    </div>
                  ) : (
                    <div>
                      <strong>{item.nodeId} · {item.rubricId}</strong>
                      <p>{item.reason}</p>
                      <mark>{item.originalAnswer}</mark>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="teacher-empty teacher-empty--ok"><CheckCircle2 aria-hidden="true" />当前没有待复核项目。</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ClassSummary({
  sessions,
  rejected,
  onImport,
}: {
  sessions: readonly StudentSession[];
  rejected: readonly RejectedClassSession[];
  onImport: (files: FileList) => Promise<void>;
}) {
  const { config } = useAppContext();
  const input = useRef<HTMLInputElement>(null);
  const [topN, setTopN] = useState(5);
  const summary = useMemo(() => buildClassSummary(sessions, config, topN), [config, sessions, topN]);

  return (
    <div className="teacher-class-view">
      <section className="class-import-band" aria-labelledby="class-import-title">
        <div>
          <span>AC6 · 纯前端聚合</span>
          <h2 id="class-import-title">批量导入会话</h2>
          <p>最多 {MAX_CLASS_SESSION_FILES} 份、每份最大 {Math.floor(MAX_CLASS_SESSION_FILE_BYTES / 1024)} KiB；同一匿名编号只取最新会话。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => input.current?.click()}>
          <Upload aria-hidden="true" />选择多份 JSON
        </button>
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          multiple
          accept="application/json,.json"
          aria-label="批量导入班级会话 JSON"
          onChange={async (event) => {
            if (event.target.files?.length) await onImport(event.target.files);
            event.target.value = '';
          }}
        />
      </section>
      {rejected.length > 0 ? (
        <div className="class-import-messages" role="status">
          {rejected.map((item) => (
            <p key={`${item.name}-${item.code}`}><AlertTriangle aria-hidden="true" />{item.name}：{item.message}</p>
          ))}
        </div>
      ) : null}

      <section className="teacher-section" aria-labelledby="class-overview-title">
        <header className="teacher-section__heading">
          <div><span>{summary.rubricVersion}</span><h2 id="class-overview-title">班级三维分布</h2></div>
          <strong>{summary.sessionCount} 名学生参与汇总</strong>
        </header>
        <div className="class-overview-grid">
          <ClassRadar dimensions={summary.dimensions} />
          <div className="class-dimension-stats" aria-label="班级维度统计">
            {summary.dimensions.map((item) => (
              <div className={`class-dimension-stat class-dimension-stat--${item.dimensionId}`} key={item.dimensionId}>
                <span>{item.label}</span>
                <strong>{item.mean === null ? '未测' : `${Math.round(item.mean * 100)}%`}</strong>
                <small>四分位 {item.quartileLow === null ? '—' : Math.round(item.quartileLow * 100)}–{item.quartileHigh === null ? '—' : Math.round(item.quartileHigh * 100)}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="teacher-two-column teacher-two-column--class">
        <section className="teacher-section" aria-labelledby="node-error-title">
          <header className="teacher-section__heading">
            <div><span>partial + miss / 已测学生</span><h2 id="node-error-title">节点错误率</h2></div>
            <FileJson aria-hidden="true" />
          </header>
          <div className="node-error-bars">
            {summary.nodeErrorRates.map((item) => (
              <div className={`node-error-bar node-error-bar--${item.dimensionId}`} data-testid={`node-error-${item.nodeId}`} key={item.nodeId}>
                <span className="teacher-node-id">{item.nodeId}</span>
                <div><i style={{ width: `${Math.round(item.rate * 100)}%` }} /></div>
                <strong>{Math.round(item.rate * 100)}%</strong>
                <small>{item.errorCount}/{item.assessedCount}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="teacher-section" aria-labelledby="misconception-title">
          <header className="teacher-section__heading">
            <div><span>按学生去重计数</span><h2 id="misconception-title">高频误区 Top {topN}</h2></div>
            <label>显示<select value={topN} onChange={(event) => setTopN(Number(event.target.value))}><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option></select></label>
          </header>
          {summary.misconceptions.length > 0 ? (
            <ol className="misconception-ranking">
              {summary.misconceptions.map((item) => (
                <li key={item.id}>
                  <strong>{item.id}</strong><p>{item.statement}</p><span>{item.count} 人</span>
                </li>
              ))}
            </ol>
          ) : <p className="teacher-empty">已导入会话尚未持久化闭集误区 ID。</p>}
        </section>
      </div>

      <section className="teacher-section" aria-labelledby="class-roster-title">
        <header className="teacher-section__heading">
          <div><span>不采集姓名</span><h2 id="class-roster-title">匿名编号</h2></div>
          <Users aria-hidden="true" />
        </header>
        <div className="anonymous-roster">
          {summary.anonymousStudentIds.map((id) => <span key={id}>{id}</span>)}
        </div>
      </section>
    </div>
  );
}

export default function TeacherPage() {
  const { config, session, historicalSessions } = useAppContext();
  const [view, setView] = useState<TeacherView>('student');
  const [imported, setImported] = useState<AcceptedClassSession[]>([]);
  const [rejected, setRejected] = useState<RejectedClassSession[]>([]);
  const baseSessions = useMemo(
    () => uniqueSessions([session, ...historicalSessions].filter((item) => item.events.length > 0)),
    [historicalSessions, session],
  );
  const classSessions = useMemo(
    () => uniqueSessions([...baseSessions, ...imported.map((item) => item.session)]),
    [baseSessions, imported],
  );
  const studentSessions = useMemo(
    () => uniqueSessions([session, ...historicalSessions, ...imported.map((item) => item.session)]),
    [historicalSessions, imported, session],
  );
  const [selectedSessionId, setSelectedSessionId] = useState(session.id);
  const selectedSession = studentSessions.find((item) => item.id === selectedSessionId) ?? session;

  useEffect(() => {
    if (!studentSessions.some((item) => item.id === selectedSessionId)) setSelectedSessionId(session.id);
  }, [selectedSessionId, session.id, studentSessions]);

  return (
    <main className="page-content teacher-page">
      <header className="page-heading teacher-page-heading">
        <div><span>班级证据</span><h1>教师视图</h1></div>
        <div className="teacher-view-tabs" role="tablist" aria-label="教师视图范围">
          <button aria-selected={view === 'student'} onClick={() => setView('student')} role="tab" type="button">单生证据</button>
          <button aria-selected={view === 'class'} onClick={() => setView('class')} role="tab" type="button">班级汇总</button>
        </div>
      </header>

      {view === 'student' ? (
        <>
          <div className="teacher-student-selector">
            <label htmlFor="teacher-student-session">匿名学生</label>
            <select id="teacher-student-session" value={selectedSession.id} onChange={(event) => setSelectedSessionId(event.target.value)}>
              {studentSessions.map((item) => <option key={item.id} value={item.id}>{item.anonymousStudentId} · {item.updatedAt.slice(0, 10)}</option>)}
            </select>
            <span>{selectedSession.anonymousStudentId}</span>
          </div>
          <StudentEvidence session={selectedSession} />
        </>
      ) : (
        <ClassSummary
          sessions={classSessions}
          rejected={rejected}
          onImport={async (files) => {
            const batch = await readClassSessionFileBatch([...files]);
            const result = importClassSessionFiles(batch.files, config, classSessions);
            setImported((current) => [...current, ...result.accepted]);
            setRejected([...batch.rejected, ...result.rejected]);
          }}
        />
      )}
    </main>
  );
}
