import { useMemo, useRef, useState } from 'react';
import {
  BREAK,
  CONFLICT,
  NONE,
  SAME,
  type AdoptedVersion,
  type DocModel,
  type Edge,
  type PaginateError,
  type PaginateResult,
} from './core/types';
import { findConflicts, parseDoc } from './core/model';
import { paginate } from './core/paginate';
import { buildAdoptedExport, buildExport } from './core/export';
import { SAMPLE_JSON, randomDoc } from './core/sample';
import { VirtualList } from './components/VirtualList';

type FreshResult =
  | { status: 'ok'; result: PaginateResult; elapsedMs: number }
  | { status: 'error'; error: PaginateError; elapsedMs: number };

interface StaleTag {
  stale: boolean;
}

const ROW_H = 34;

function snapshotModel(model: DocModel): DocModel {
  // 深拷贝块数组：采纳快照必须定格采纳时刻的边界标记，
  // 之后的边界编辑不得回写已采纳版本；编辑本身也不得改动旧状态。
  return { ...model, blocks: model.blocks.map((b) => ({ ...b })) };
}

function errorText(error: PaginateError): string {
  if (error.kind === 'conflict') {
    return `存在 ${error.conflicts.length} 处冲突边界（强制分页与同页同置），已在左侧标红，禁止计算`;
  }
  return `无解：${error.reason}`;
}

export default function App() {
  const [model, setModel] = useState<DocModel | null>(null);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<AdoptedVersion | null>(null);
  const [fresh, setFresh] = useState<(FreshResult & StaleTag) | null>(null);
  const [computing, setComputing] = useState(false);
  const [locateIndex, setLocateIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<DocModel | null>(null);
  modelRef.current = model;

  const conflicts = useMemo(() => (model ? findConflicts(model) : []), [model]);

  const loadRaw = (raw: unknown, source: string) => {
    const parsed = parseDoc(raw);
    if (!parsed.ok) {
      // 非法导入只提示原因：当前文档、计算结果与已采纳版本全部保留。
      setImportError(`导入失败（${source}）：${parsed.error.message}。当前文档与已采纳版本已保留。`);
      return;
    }
    setModel(parsed.model);
    setFresh(null);
    setAdopted(null);
    setImportError(null);
    setNotice(null);
    setLocateIndex(null);
  };

  const onImportText = () => {
    let json: unknown;
    try {
      json = JSON.parse(importText);
    } catch (e) {
      setImportError(`导入失败（JSON 文本）：${(e as Error).message}。当前文档与已采纳版本已保留。`);
      return;
    }
    loadRaw(json, 'JSON 文本');
  };

  const onFile = async (file: File) => {
    // 先完成读取与解析，成功后才替换工作台；任何失败都不影响现有状态。
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      loadRaw(json, `文件 ${file.name}`);
    } catch (e) {
      setImportError(`导入失败（文件 ${file.name}）：${(e as Error).message}。当前文档与已采纳版本已保留。`);
    }
  };

  const setEdge = (i: number, edge: Edge) => {
    if (!model) return;
    const next = snapshotModel(model);
    next.blocks[i].edge = edge;
    setModel(next);
    setFresh((f) => (f ? { ...f, stale: true } : null));
    setNotice(null);
  };

  /** 两个标记独立勾选：同置即为 CONFLICT。 */
  const toggleMark = (i: number, mark: typeof BREAK | typeof SAME) => {
    if (!model) return;
    const cur = model.blocks[i].edge;
    const hasBreak = cur === BREAK || cur === CONFLICT;
    const hasSame = cur === SAME || cur === CONFLICT;
    const nb = mark === BREAK ? !hasBreak : hasBreak;
    const ns = mark === SAME ? !hasSame : hasSame;
    const nextEdge: Edge = nb && ns ? CONFLICT : nb ? BREAK : ns ? SAME : NONE;
    setEdge(i, nextEdge);
  };

  const runCompute = () => {
    if (!model) return;
    const target = model;
    setComputing(true);
    // 让按钮状态先渲染，再同步执行 O(n) DP（大夹具下原生仍为毫秒级）。
    // 捕获本次点击时的文档，避免编辑后旧任务回写结果。
    window.setTimeout(() => {
      const t0 = performance.now();
      let out: FreshResult;
      try {
        const r = paginate(target);
        const elapsedMs = performance.now() - t0;
        out = r.ok
          ? { status: 'ok', result: r.result, elapsedMs }
          : { status: 'error', error: r.error, elapsedMs };
      } catch (e) {
        out = {
          status: 'error',
          elapsedMs: performance.now() - t0,
          error: { kind: 'unsat', reason: `计算异常：${(e as Error).message}`, start: 0, end: target.blocks.length },
        };
      }
      setFresh((cur) => {
        // 若计算期间文档又被导入替换，则丢弃本次结果。
        if (!modelRef.current || modelRef.current !== target) return cur;
        return { ...out, stale: false };
      });
      setComputing(false);
    }, 20);
  };

  const adopt = () => {
    if (!model || !fresh || fresh.status !== 'ok' || fresh.stale) return;
    const stamp = new Date().toISOString();
    setAdopted({ model: snapshotModel(model), result: fresh.result, adoptedAt: stamp });
    setNotice('已采纳当前分页。可下载与画面一致的 JSON。');
  };

  const download = (which: 'current' | 'adopted') => {
    if (!model) return;
    let content: string;
    let filename: string;
    if (which === 'adopted') {
      if (!adopted) return;
      content = JSON.stringify(buildAdoptedExport(adopted), null, 2);
      filename = `pagination-adopted-${Date.now()}.json`;
    } else {
      if (!fresh || fresh.status !== 'ok' || fresh.stale) return;
      const stamp = new Date().toISOString();
      content = JSON.stringify(buildExport(model, fresh.result, stamp), null, 2);
      filename = `pagination-${Date.now()}.json`;
    }
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadSample = () => {
    try {
      loadRaw(JSON.parse(SAMPLE_JSON), '内置示例');
      setImportText(SAMPLE_JSON);
    } catch {
      /* 示例本身合法，不会发生 */
    }
  };

  const loadBig = () => {
    const big = randomDoc(200_000, 1000, (Date.now() >>> 0) | 1);
    setModel(big);
    setFresh(null);
    setAdopted(null);
    setImportError(null);
    setNotice('已载入 200000 块随机大夹具（可行边界），用于四秒性能验收。');
  };

  // 当前块下标 -> 页号（仅在最新成功结果且未脏时有效）。
  const pageOfBlock = useMemo(() => {
    if (!model || !fresh || fresh.status !== 'ok' || fresh.stale) return null;
    const map = new Int32Array(model.blocks.length).fill(-1);
    fresh.result.pages.forEach((p, idx) => {
      for (let k = p.start; k < p.end; k++) map[k] = idx + 1;
    });
    return map;
  }, [model, fresh]);

  return (
    <div className="app">
      <header>
        <h1>精确分页排版台</h1>
        <span className="sub">印前安全操作卡 · 纯前端 · 数据不出本机</span>
      </header>

      <section className="import">
        <div className="row">
          <textarea
            placeholder='粘贴 JSON：{ "pageHeight": 300, "blocks": [ { "id": 1, "height": 100 } ] }'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={3}
          />
          </div>
          <div className="row btns">
            <button onClick={onImportText}>导入文本</button>
            <button onClick={() => fileRef.current?.click()}>选择文件…</button>
            <button onClick={loadSample}>内置示例</button>
            <button onClick={loadBig}>20 万块大夹具</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = '';
              }}
            />
          </div>
          {importError && <div className="banner error">{importError}</div>}
        </section>

      {model && (
        <section className="workbench">
          <div className="toolbar">
            <div className="docmeta">
              页容量 <b>{model.pageHeight}</b> · 共 <b>{model.blocks.length}</b> 块
              {conflicts.length > 0 && <span className="tag conflict-tag">冲突 {conflicts.length} 处</span>}
              {fresh?.stale && <span className="tag stale-tag">结果已过期：边界被修改，请重新计算</span>}
              {adopted && <span className="tag adopted-tag">已采纳 {adopted.result.pages.length} 页版本</span>}
            </div>
            <div className="btns">
              <button
                className="primary"
                disabled={computing || conflicts.length > 0}
                onClick={runCompute}
                title={conflicts.length > 0 ? '存在冲突边界，禁止计算' : '运行 O(n) 精确分页'}
              >
                {computing ? '计算中…' : '运行精确分页'}
              </button>
              <button
                disabled={!(fresh && fresh.status === 'ok' && !fresh.stale)}
                onClick={adopt}
              >
                采纳结果
              </button>
              <button
                disabled={!(fresh && fresh.status === 'ok' && !fresh.stale)}
                onClick={() => download('current')}
              >
                下载当前结果
              </button>
              <button className="accent" disabled={!adopted} onClick={() => download('adopted')}>
                下载已采纳版本
              </button>
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="banner error">
              冲突边界（强制分页 + 同页 同置）：
              {conflicts.slice(0, 8).map((i) => (
                <button key={i} className="chip" onClick={() => setLocateIndex(i)}>
                  块 {i + 1} 后
                </button>
              ))}
              {conflicts.length > 8 && <span>…等 {conflicts.length} 处</span>}
            </div>
          )}

          <div className="panes">
            <div className="pane">
              <h2>块与边界</h2>
              <div className="listheader grid-row">
                <span>#</span>
                <span>id</span>
                <span>高度</span>
                <span>与后块边界</span>
                <span>页</span>
              </div>
              <VirtualList
                items={model.blocks}
                rowHeight={ROW_H}
                height={520}
                scrollToIndex={locateIndex}
                renderRow={(b, i) => (
                  <div
                    className={`grid-row vrow-inner ${b.edge === CONFLICT ? 'row-conflict' : ''} ${
                      b.edge === BREAK ? 'row-break' : ''
                    } ${b.edge === SAME ? 'row-same' : ''}`}
                  >
                    <span>{i + 1}</span>
                    <span className="ellipsis" title={String(b.id)}>{String(b.id)}</span>
                    <span>{b.height}</span>
                    <span>
                      {i < model.blocks.length - 1 ? (
                        <span className="marks">
                          <label
                            className={`mark ${b.edge === BREAK || b.edge === CONFLICT ? 'on break' : ''}`}
                            title="强制分页：两侧不得同页"
                          >
                            <input
                              type="checkbox"
                              checked={b.edge === BREAK || b.edge === CONFLICT}
                              onChange={() => toggleMark(i, BREAK)}
                            />
                            分页
                          </label>
                          <label
                            className={`mark ${b.edge === SAME || b.edge === CONFLICT ? 'on same' : ''}`}
                            title="与后项同页：两侧必须同页"
                          >
                            <input
                              type="checkbox"
                              checked={b.edge === SAME || b.edge === CONFLICT}
                              onChange={() => toggleMark(i, SAME)}
                            />
                            同页
                          </label>
                          {b.edge === CONFLICT && <span className="conflict-flag">冲突</span>}
                        </span>
                      ) : (
                        <em className="muted">末块</em>
                      )}
                    </span>
                    <span>{pageOfBlock ? pageOfBlock[i] || '' : ''}</span>
                  </div>
                )}
              />
            </div>

            <div className="pane">
              <h2>分页结果</h2>
              <ResultPanel
                model={model}
                fresh={fresh}
                computing={computing}
                notice={notice}
                adopted={adopted}
              />
            </div>
          </div>
        </section>
      )}

      {!model && (
        <section className="empty">
          <p>尚未导入文档。粘贴 JSON 或选择文件开始；非法导入不会影响当前文档。</p>
        </section>
      )}
    </div>
  );
}

function ResultPanel({
  model,
  fresh,
  computing,
  notice,
  adopted,
}: {
  model: DocModel;
  fresh: (FreshResult & StaleTag) | null;
  computing: boolean;
  notice: string | null;
  adopted: AdoptedVersion | null;
}) {
  if (computing) {
    return <div className="placeholder">正在计算最优分页…</div>;
  }
  if (!fresh) {
    return <div className="placeholder">点击「运行精确分页」后在此显示页数、代价与每页范围。</div>;
  }
  if (fresh.status === 'error') {
    return (
      <div className="banner error big">
        {errorText(fresh.error)}
        {fresh.error.kind === 'unsat' && (
          <div className="muted">
            涉及块 {fresh.error.start + 1}–{fresh.error.end}。修正边界后可立即重新计算。
          </div>
        )}
        <div className="muted">（耗时 {fresh.elapsedMs.toFixed(1)} ms）</div>
      </div>
    );
  }

  const { result, elapsedMs, stale } = fresh;
  return (
    <div>
      <div className={`summary ${stale ? 'stale' : ''}`}>
        <div><span className="k">页数</span><b>{result.pages.length}</b></div>
        <div><span className="k">代价 Σ剩余²</span><b>{result.cost}</b></div>
        <div>
          <span className="k">范围</span>
          <b>
            首页 块 {result.pages[0].start + 1}–{result.pages[0].end}（id{' '}
            {String(model.blocks[result.pages[0].start].id)}）… 末页 块{' '}
            {result.pages[result.pages.length - 1].start + 1}–
            {result.pages[result.pages.length - 1].end}（id{' '}
            {String(model.blocks[model.blocks.length - 1].id)}），覆盖全部 {model.blocks.length} 块
          </b>
        </div>
        <div><span className="k">耗时</span><b>{elapsedMs.toFixed(2)} ms</b>{elapsedMs > 4000 && <span className="warn">超 4 秒</span>}</div>
      </div>
      {stale && <div className="banner warn">边界已修改，以上为旧结果；请重新运行。</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {adopted && !stale && (
        <div className="muted small">
          已采纳版本：{adopted.result.pages.length} 页 · 代价 {adopted.result.cost} · {adopted.adoptedAt}
        </div>
      )}
      <VirtualList
        items={result.pages}
        rowHeight={58}
        height={360}
        renderRow={(p, idx) => (
          <div className="pagecard">
            <div className="pc-head">
              <b>第 {idx + 1} 页</b>
              <span className="muted">
                块 {p.start + 1}–{p.end} · id {String(model.blocks[p.start].id)} →{' '}
                {String(model.blocks[p.end - 1].id)}
              </span>
            </div>
            <div className="pc-bar">
              <div className="pc-used" style={{ width: `${(p.used / model.pageHeight) * 100}%` }} />
            </div>
            <div className="muted small">
              已用 {p.used} / {model.pageHeight} · 剩余 {p.remaining} · 剩余² {p.remaining * p.remaining}
            </div>
          </div>
        )}
      />
    </div>
  );
}
