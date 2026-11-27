import React from 'react';
import {assignedTaskActionBlock,deviceTaskMovePoint,type Device,type DeviceContext,type DeviceTask} from './device-actions';

type TaskType = Pick<DeviceTask, 'capability' | 'behavior'>;
type Props = {agent:Device; tasks:DeviceTask[]; taskTypes?:TaskType[]; context?:DeviceContext};

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

export function DeviceCapabilities({agent, tasks, taskTypes = tasks, context}: Props) {
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
  const mode = context?.mode ?? 'auto';
  const taskIntent = mode === 'primitive' ? 'work_task' : 'execute_task';
  const taskAction = ownActions.find(a => a.taskId === task?.id && a.type === taskIntent);
  const taskBlock = assignedTaskActionBlock(mode, agent, task, ownActions);
  const point = taskBlock === 'out_of_reach' ? deviceTaskMovePoint(task, context?.worldSize) : null;
  const moving = ownActions.some(a => a.type === 'move');
  const canStart = !!task && !taskBlock;
  const taskStatus = taskAction?.status === 'pending' ? '已排队'
    : taskAction?.status === 'accepted' || agent.status === 'working' ? '执行中'
    : moving ? '前往作业点'
    : mode === 'auto' ? '自动调度'
    : taskBlock === 'out_of_reach' ? (point ? '距作业点过远' : '作业点不可达')
    : canStart ? '待执行' : '已分配';
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
        </div>
      )}
    </section>
  );
}
