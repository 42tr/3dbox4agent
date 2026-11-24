import React, {useState} from 'react';
import {ArrowUpRight, BatteryCharging, Scan} from '@phosphor-icons/react';
import {
  assignedTaskActionBlock, canDeviceScan, deviceBlock, deviceMessage, deviceReason, deviceTaskMovePoint,
  type Device, type DeviceContext, type DeviceDraft, type DeviceResult, type DeviceTask,
} from './device-actions';

type TaskType = Pick<DeviceTask, 'capability' | 'behavior'>;
type CardDevice = Device & {rescue?: {workTicks: number}};
type Props = {
  agent: CardDevice;
  tasks: DeviceTask[];
  taskTypes?: TaskType[];
  context?: DeviceContext;
  invoke: (agentId: string, draft: DeviceDraft) => Promise<DeviceResult>;
  openControls: (rescue?: boolean) => void;
};

const capabilityLabels = new Map([
  ['inspect', '巡检'], ['survey', '勘测'], ['confirm', '异常确认'], ['verify', '维修复核'],
  ['sample', '采样'], ['deliver', '取件与交付'], ['transport', '物资运输'], ['repair', '现场维修'],
  ['relay', '部署中继'], ['build', '设施建造'], ['guide', '引导接应'], ['rescue', '现场救援'],
]);

function taskCapability(task: TaskType): string | undefined {
  if (task.capability === 'confirm' && task.behavior === 'verify') return 'verify';
  if (task.capability === 'inspect' && task.behavior === 'survey') return 'survey';
  return task.capability;
}

const actionStatus = new Map([
  ['pending', '已入队'], ['accepted', '执行中'], ['completed', '已完成'],
  ['rejected', '已拒绝'], ['failed', '执行失败'], ['cancelled', '已取消'],
]);

export function DeviceCapabilities({agent, tasks, taskTypes = tasks, context, invoke, openControls}: Props) {
  const [pending, setPending] = useState(false);
  const [submission, setSubmission] = useState<{text: string; requestId?: string}>();
  const declared = new Set(agent.capabilities);
  const capabilities = new Set(declared);
  for (const task of taskTypes) {
    if (!task.capability || !declared.has(task.capability)) continue;
    const capability = taskCapability(task);
    if (capability) capabilities.add(capability);
  }

  const task = tasks.find(t => t.assignee === agent.id && t.status === 'active');
  const activeCapability = task && taskCapability(task);
  if (activeCapability) capabilities.add(activeCapability);
  const ownActions = context?.actions.filter(a => a.agentId === agent.id && ['pending', 'accepted'].includes(a.status)) ?? [];
  const lock = context ? deviceBlock(context) : 'context_changed';
  const showControls = context && !context.observer && !context.imported && context.latest;
  const blocked = !!lock || pending || agent.disabled;
  const mode = context?.mode ?? 'auto';
  const taskIntent = mode === 'primitive' ? 'work_task' : 'execute_task';
  const taskAction = ownActions.find(a => a.taskId === task?.id && a.type === taskIntent);
  const taskBlock = assignedTaskActionBlock(mode, agent, task, ownActions);
 const work = mode === 'primitive' ? task?.workOperation : undefined;
  const point = taskBlock === 'out_of_reach' ? deviceTaskMovePoint(task, context?.worldSize) : null;
  const moving = ownActions.some(a => a.type === 'move');
  const canStart = !!task && !taskBlock;
  const canApproach = !!point && !ownActions.length;
  const taskStatus = taskAction?.status === 'pending' ? '已排队'
    : taskAction?.status === 'accepted' || agent.status === 'working' ? '执行中'
    : moving ? '前往作业点'
    : mode === 'auto' ? '自动调度'
    : taskBlock === 'out_of_reach' ? (point ? '距作业点过远' : '作业点不可达')
    : canStart ? '待执行' : '已分配';
  const scanBlock = agent.battery <= 5 ? '电量不足' : agent.status !== 'idle' ? '空闲时可扫描' : '';
  const chargeBlock = agent.battery >= 80 ? '电量低于 80% 时可补能'
    : agent.status !== 'idle' && !(mode !== 'auto' && agent.status === 'assigned' && task) ? '设备当前无法返站' : '';
  const recorded = submission?.requestId && context?.actions.find(a => a.agentId === agent.id && a.requestId === submission.requestId);
  const feedback = recorded && recorded.status !== 'pending'
    ? `${actionStatus.get(recorded.status) ?? recorded.status}。${recorded.reason ? deviceReason(recorded.reason) : ''}`
    : submission?.text;

  async function submit(draft: DeviceDraft) {
    if (blocked || ownActions.length) return;
    setPending(true);
    setSubmission({text: '正在提交…'});
    try {
      const result = await invoke(agent.id, draft);
      const text = result.ok
        ? (result.refreshPending ? '已入队，状态同步中。' : `已入队，目标步 T+${result.targetTick}。`)
        : deviceMessage(result.reason);
      setSubmission({text, requestId: result.ok ? result.requestId : undefined});
    } catch {
      setSubmission({text: deviceMessage()});
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mc-capabilities" aria-label={`${agent.id} 的能力`} onClick={event => event.stopPropagation()}>
      <h3>任务能力</h3>
      {capabilities.size ? (
        <ul className="mc-capability-list">
          {Array.from(capabilities, capability => (
            <li className={capability === activeCapability ? 'active' : undefined} key={capability} data-capability={capability}>
              {capabilityLabels.get(capability) ?? capability}
            </li>
          ))}
        </ul>
      ) : <p className="mc-capability-empty">未配置专用任务能力</p>}
      {task && (
        <div className="mc-capability-task">
          <strong>{task.name || task.id}</strong>
          <span>{taskStatus}</span>
          {showControls && (canStart || canApproach) && (
            <button type="button" className="mc-capability-command primary"
              disabled={blocked || agent.battery <= 5 || !!ownActions.length}
              title={agent.battery <= 5 ? '电量不足' : undefined}
              onClick={() => void submit(point ? {type: 'move', x: String(point[0]), y: String(point[1])} : {type: taskIntent, taskId: task.id, operation: work?.operation})}>
              {point ? '前往作业点' : work ? work.label : mode === 'primitive' ? '开始作业' : '启动任务'}
            </button>
          )}
        </div>
      )}
      {showControls && (
        <div className="mc-capability-controls">
          <div className="mc-capability-shortcuts">
            {canDeviceScan(agent) && (
              <button type="button" className="mc-capability-command" disabled={blocked || !!scanBlock || !!ownActions.length}
                title={scanBlock || '扫描本机感知范围'} onClick={() => void submit({type: 'scan'})}>
                <Scan size={13} aria-hidden="true"/>扫描周边
              </button>
            )}
            <button type="button" className="mc-capability-command" disabled={blocked || !!chargeBlock || !!ownActions.length}
              title={chargeBlock || '前往充电站补能'} onClick={() => void submit({type: 'charge'})}>
              <BatteryCharging size={13} aria-hidden="true"/>返站补能
            </button>
            {agent.rescue && <button type="button" className="mc-capability-command" onClick={() => openControls(true)}>救援目标</button>}
          </div>
          <button type="button" className="mc-capability-command mc-capability-options" aria-label={`${agent.id} 的设备操作`}
            title="设备操作与动作记录" onClick={() => openControls()}>
            <ArrowUpRight size={14} aria-hidden="true"/>
          </button>
        </div>
      )}
      <p className="mc-capability-feedback" role="status">{showControls ? feedback : ''}</p>
    </section>
  );
}
