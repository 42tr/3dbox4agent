import React, {useEffect, useRef, useState} from 'react';

type Capabilities = {
  scenes: string[];
  physics: string[];
  faults: string[];
  strategies: string[];
  maxCoordinators: number;
  concurrency: number;
};

type Runner = {
  runnerId: string;
  label: string;
  online: boolean;
  capabilities: Capabilities | null;
};

type RunConfig = {
  sceneId: string;
  seed: number;
  physics: string;
  coordinators: number;
  fault: string;
  maxTicks: number;
  timeoutSeconds: number;
  strategy: string;
};

type Run = {
  runId: string;
  runnerId: string;
  config: RunConfig;
  status: string;
  reason: string | null;
  progress: {tick: number; completedTasks: number; totalTasks: number} | null;
  canObserve: boolean;
  hasReplay: boolean;
  replayError: string | null;
};

const defaults: RunConfig = {
  sceneId: 'industrial-park-parallel-v1', seed: 42, physics: 'rapier',
  coordinators: 1, fault: 'none', maxTicks: 1000, timeoutSeconds: 45, strategy: 'planner',
};

const statuses: Record<string, string> = {
  queued: '排队中', starting: '启动中', running: '运行中', stopping: '正在收尾',
  completed: '已完成', cancelled: '已停止', failed: '失败', timeout: '达到运行上限',
};

const optionLabels: Record<string, string> = {
  'industrial-park-v1': '工业园区',
  'industrial-park-parallel-v1': '工业园区并行巡检',
  'industrial-park-fixed-sensor-v1': '工业园区固定传感器',
  'lunar-base-v1': '月球基地', 'lunar-terrain-v1': '月面地形',
  'lunar-sampling-v1': '月面采样', 'lunar-outpost-v1': '月面基地设施协作',
  'shore-coordination-v1': '海岸协同', 'shore-surface-v1': '海岸地表',
  'shore-sea-state-v1': '海况扰动', 'shore-echelons-v1': '海岸梯队',
  'shore-rescue-v1': '海岸救援', planner: '内置规划器',
  none: '无', transport: '运输设备故障', recoverable: '可恢复故障', resident: '驻留设备故障',
  rapier: 'Rapier', kinematic: '运动学',
};

const errors: Record<string, string> = {
  runner_unauthorized: '请输入有效的 Runner 管理令牌。',
  runner_operator_token_required: '请先在 Control 中配置 Runner 管理令牌，再创建外部 Runner。',
  runner_offline: '所选 Runner 已离线。',
  runner_unsupported_config: '所选 Runner 不支持这组配置。',
  runner_world_incomplete: 'World 尚未完成场景。',
  runner_world_unavailable: 'World 会话已不可用，未能归档回放。',
  runner_lease_expired: 'Runner 已断开，运行已回收。',
  runner_registration_revoked: '外部 Runner 的接入权限已撤销。',
  runner_replay_unavailable: '回放尚不可用。',
  runner_archive_failed: '回放归档失败。',
  world_worker_limit: 'World 并发已满，请释放一个会话后再试。',
  runner_queue_full: '运行队列已满，请稍后再试。',
  runner_experiment_error: 'Runner 执行实验时遇到错误。',
  worker_exited: '实验子进程提前退出。',
  tick_limit: '已达到仿真步数上限。',
  wall_timeout: '已达到运行时间上限。',
  runner_timeout: '已达到运行时间上限。',
  fault_not_injected: '场景结束前未触发指定故障。',
};

function message(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return errors[code] || code;
}

function matchingConfig(config: RunConfig, caps: Capabilities): RunConfig {
  return {
    ...config,
    sceneId: caps.scenes.includes(config.sceneId) ? config.sceneId : caps.scenes[0],
    physics: caps.physics.includes(config.physics) ? config.physics : caps.physics[0],
    fault: caps.faults.includes(config.fault) ? config.fault : caps.faults[0],
    strategy: caps.strategies.includes(config.strategy) ? config.strategy : caps.strategies[0],
    coordinators: Math.min(config.coordinators, caps.maxCoordinators),
  };
}

type ObserverAccess = {format: string; sessionId: string; observerToken: string};

export function RunnerPanel({
  active, canObserve, openReplay, openObserver,
}: {
  active: boolean;
  canObserve: boolean;
  openReplay: (load: () => Promise<unknown>) => Promise<void>;
  openObserver: (access: ObserverAccess) => Promise<void>;
}) {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runnerId, setRunnerId] = useState('');
  const [config, setConfig] = useState(defaults);
  const [operator, setOperator] = useState('');
  const [needsOperator, setNeedsOperator] = useState(false);
  const [operatorDraft, setOperatorDraft] = useState('');
  const [label, setLabel] = useState('');
  const [revoking, setRevoking] = useState('');
  const [enrollment, setEnrollment] = useState<{runnerId: string; runnerToken: string}>();
  const [problem, setProblem] = useState('');
  const [actionProblem, setActionProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingStart = useRef<{signature: string; requestId: string} | null>(null);
  const runner = runners.find(item => item.runnerId === runnerId);
  const caps = runner?.capabilities;

  async function request<T>(route: string, options: RequestInit = {}): Promise<T> {
    if (location.protocol === 'file:') throw Error('请通过在线 Console 使用 Runner。');
    const response = await fetch('/control/runners/v1' + route, {
      ...options, cache: 'no-store',
      headers: {
        ...(operator ? {Authorization: 'Bearer ' + operator} : {}),
        ...(options.body ? {'Content-Type': 'application/json'} : {}),
      },
    });
    if (!response.ok) {
      const info = await response.json().catch(() => ({}));
      if (response.status === 404 && route === '/runners') throw Error('当前 Control 未启用 Runner。');
      if (response.status === 401) setNeedsOperator(true);
      throw Error(info.error || 'Runner 请求失败（' + response.status + '）');
    }
    return response.json();
  }

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [registry, history] = await Promise.all([
          request<{runners: Runner[]}>('/runners', {signal: controller.signal}),
          request<{runs: Run[]}>('/runs', {signal: controller.signal}),
        ]);
        if (controller.signal.aborted) return;
        setRunners(registry.runners);
        setRuns(history.runs);
        setProblem('');
        setRunnerId(current => registry.runners.some(item => item.runnerId === current)
          ? current : registry.runners.find(item => item.online)?.runnerId || registry.runners[0]?.runnerId || '');
      } catch (error) {
        if (!controller.signal.aborted) setProblem(message(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, operator]);

  async function perform(task: () => Promise<void>) {
    setBusy(true);
    setActionProblem('');
    try {
      await task();
    } catch (error) {
      setActionProblem(message(error));
    } finally {
      setBusy(false);
    }
  }

  function upsert(run: Run) {
    setRuns(current => [run, ...current.filter(item => item.runId !== run.runId)]);
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (!caps || !runner?.online || busy) return;
    const draft = {runnerId, config: matchingConfig(config, caps)};
    const signature = JSON.stringify(draft);
    if (pendingStart.current?.signature !== signature) {
      const requestId = globalThis.crypto.randomUUID?.()
        ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      pendingStart.current = {signature, requestId};
    }
    const requestId = pendingStart.current.requestId;
    await perform(async () => {
      const result = await request<Run>('/runs', {
        method: 'POST', body: JSON.stringify({...draft, requestId}),
      });
      pendingStart.current = null;
      upsert(result);
    });
  }

  function stop(run: Run) {
    return perform(async () => upsert(await request<Run>('/runs/' + run.runId + '/cancel', {method: 'POST'})));
  }

  function replay(run: Run, download: boolean) {
    return perform(async () => {
      const load = () => request<unknown>('/runs/' + run.runId + '/report');
      if (!download) {
        await openReplay(load);
        return;
      }
      const report = await load();
      const url = URL.createObjectURL(new Blob([JSON.stringify(report)], {type: 'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = '3dbox-runner-' + run.runId + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function observe(run: Run) {
    return perform(async () => openObserver(await request<ObserverAccess>(
      '/runs/' + run.runId + '/observer', {method: 'POST'})));
  }

  async function enroll(event: React.FormEvent) {
    event.preventDefault();
    await perform(async () => {
      setEnrollment(await request('/runners', {method: 'POST', body: JSON.stringify({label})}));
      setLabel('');
    });
  }

  const shown = caps && matchingConfig(config, caps);
  return <section className="mc-runner-panel" aria-label="Runner 实验">
    <form className="mc-runner-form" onSubmit={start}>
      <label>Runner<select value={runnerId} onChange={event => setRunnerId(event.target.value)} disabled={!runners.length}>
        {!runners.length && <option value="">暂无 Runner</option>}
        {runners.map(item => <option value={item.runnerId} key={item.runnerId}>
          {item.label} · {item.online ? '在线' : '离线'}
        </option>)}
      </select></label>
      {shown && caps && <>
        {([
          ['场景', 'sceneId', caps.scenes], ['物理模式', 'physics', caps.physics],
          ['调度策略', 'strategy', caps.strategies], ['故障模式', 'fault', caps.faults],
        ] as const).map(([name, field, choices]) => <label key={field}>{name}
          <select value={shown[field]} onChange={event => setConfig({...shown, [field]: event.target.value})}>
            {choices.map(choice => <option value={choice} key={choice}>{optionLabels[choice] || choice}</option>)}
          </select>
        </label>)}
        {([
          ['种子', 'seed', 0, 4294967295], ['协调器数量', 'coordinators', 1, caps.maxCoordinators],
          ['最大步数', 'maxTicks', 1, 10000], ['时间上限（秒）', 'timeoutSeconds', 2, 300],
        ] as const).map(([name, field, min, max]) => <label key={field}>{name}
          <input required type="number" min={min} max={max} value={Number.isNaN(shown[field]) ? '' : shown[field]}
            onChange={event => setConfig({...shown, [field]: event.target.valueAsNumber})}/>
        </label>)}
      </>}
      <button type="submit" className="mc-pill violet" disabled={busy || !runner?.online || !!problem}>启动实验</button>
    </form>
    {problem && <p role="status">{problem}</p>}
    {actionProblem && <p role="alert">{actionProblem}</p>}
    <h2>运行记录</h2>
    {runs.length === 0 && <p>暂无运行记录。</p>}
    <ul className="mc-runner-runs">{runs.map(run => <li key={run.runId}>
      <div><strong>{optionLabels[run.config.sceneId] || run.config.sceneId}</strong>
        <small>{runners.find(item => item.runnerId === run.runnerId)?.label || run.runnerId} · {run.runId.slice(0, 8)}</small>
      </div>
      <div><span>{statuses[run.status] || run.status}</span>
        {run.progress && <small>第 {run.progress.tick} 步 · 任务 {run.progress.completedTasks}/{run.progress.totalTasks}</small>}
        {run.reason && <small>{errors[run.reason] || run.reason}</small>}
        {run.replayError && run.replayError !== run.reason && <small>{errors[run.replayError] || run.replayError}</small>}
      </div>
      <div className="mc-runner-actions">
        {['queued', 'starting', 'running'].includes(run.status) &&
          <button type="button" className="mc-pill" disabled={busy} onClick={() => void stop(run)}>停止</button>}
        {run.canObserve && <button type="button" className="mc-pill" disabled={busy || !canObserve}
          onClick={() => void observe(run)}>查看实时仿真</button>}
        {run.hasReplay && <>
          <button type="button" className="mc-pill" disabled={busy} onClick={() => void replay(run, false)}>打开回放</button>
          <button type="button" className="mc-pill" disabled={busy} onClick={() => void replay(run, true)}>下载回放</button>
        </>}
      </div>
    </li>)}</ul>
    <details key={String(needsOperator)} open={needsOperator || undefined}>
      <summary>管理令牌与外部 Runner</summary>
      <form className="mc-runner-form" onSubmit={event => {
        event.preventDefault();
        setOperator(operatorDraft.trim());
        setOperatorDraft('');
        setNeedsOperator(false);
      }}>
        <label>管理令牌<input type="password" autoComplete="off" value={operatorDraft}
          onChange={event => setOperatorDraft(event.target.value)}/></label>
        <button type="submit" className="mc-pill">应用令牌</button>
      </form>
      <form className="mc-runner-form" onSubmit={enroll}>
        <label>Runner 名称<input required maxLength={60} value={label}
          onChange={event => setLabel(event.target.value)}/></label>
        <button type="submit" className="mc-pill" disabled={busy || !operator}>签发接入凭据</button>
      </form>
      {!!operator && runners.some(item => item.runnerId !== 'builtin') && <ul className="mc-runner-runs">
        {runners.filter(item => item.runnerId !== 'builtin').map(item => <li key={item.runnerId}>
          <div><strong>{item.label}</strong><small>{item.online ? '在线' : '离线'}</small></div>
          {revoking === item.runnerId ? <div className="mc-runner-actions">
            <span>撤销会停止该 Runner 的当前实验。</span>
            <button type="button" className="mc-pill" disabled={busy} onClick={() => void perform(async () => {
              await request('/runners/' + item.runnerId, {method: 'DELETE'});
              setRunners(current => current.filter(runner => runner.runnerId !== item.runnerId));
              if (enrollment?.runnerId === item.runnerId) setEnrollment(undefined);
              setRevoking('');
            })}>确认撤销</button>
            <button type="button" className="mc-pill" onClick={() => setRevoking('')}>返回</button>
          </div> : <button type="button" className="mc-pill" onClick={() => setRevoking(item.runnerId)}>撤销接入</button>}
        </li>)}
      </ul>}
      {enrollment && <div>
        <p>请将这组凭据配置在外部 Runner 上。</p>
        <label>Runner ID<input readOnly value={enrollment.runnerId}/></label>
        <label>Runner Token<input readOnly value={enrollment.runnerToken}/></label>
        <button type="button" className="mc-pill" onClick={() => setEnrollment(undefined)}>关闭凭据</button>
      </div>}
    </details>
  </section>;
}
