import React, {useEffect,useRef,useState} from 'react';
import {CaretRight} from '@phosphor-icons/react';
import {
  defaultWorldSettings, settingsBlock, settingsMessage, settingsOptions, validateSettings,
  type SettingField, type SettingSelect, type SettingsContext, type SettingsResult,
} from './world-settings';

type Operation = 'restart' | 'dispatch';
type Props = {
  context?: SettingsContext;
  standalone: boolean;
  runtimeControls?: React.ReactNode;
  edit: (key:string,field:SettingField,value:string) => SettingsResult;
  submit: (key:string,operation:Operation) => Promise<SettingsResult>;
  global: () => void;
  live: () => void;
};

const sceneGroups = [
  ['工业园区', 'industrial-park-'],
  ['月球基地', 'lunar-'],
  ['海岸演练', 'shore-'],
] as const;
const groupedScenarios = sceneGroups.map(([name,prefix]) => ({
  name,
  options:settingsOptions.scenario.filter(([id]) => id.startsWith(prefix)),
}));
const otherScenarios = settingsOptions.scenario.filter(([id]) =>
  !sceneGroups.some(([,prefix]) => id.startsWith(prefix)));
const settingsLabel = (key:SettingSelect,value:string) =>
  settingsOptions[key].find(([option]) => option === value)?.[1] || value;
const advancedFields = [
  'policy', 'routePolicy', 'riskPolicy', 'linkProfile', 'radioVisibility', 'bandwidthProfile',
] as const;

export function WorldSettingControls({context,standalone,runtimeControls,edit,submit,global,live}:Props) {
  const [pending,setPending] = useState<Operation | null>(null);
  const [feedback,setFeedback] = useState<{message:string; error?:boolean}>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {alive.current = false};
  },[]);
  if (!context) return null;

  const {key,current,values,rays} = context;
  const block = settingsBlock(context,'edit');
  const disabled = !!block || pending !== null;
  const invalid = validateSettings(context);
  const dispatchChanged = values.dispatchMode !== current.dispatchMode;
  const dispatchBlock = settingsBlock(context,'dispatch');
  const seedError = invalid === 'invalid_seed' && !block;
  const advancedOverrides = advancedFields.filter(field => values[field] !== defaultWorldSettings[field]).length
    + (context.server ? Number(values.physicsMode !== defaultWorldSettings.physicsMode)
      + Number(values.sensorMode !== defaultWorldSettings.sensorMode) : 0);
  const validation = invalid && !block ? settingsMessage(invalid) : '';
  const status = feedback?.message || context.notice || (context.busy ? '正在处理世界操作…' : '');

  function change(field:SettingField,value:string) {
    const result = edit(key,field,value);
    setFeedback(result.ok ? undefined : {message:settingsMessage(result.reason),error:true});
  }

  async function send(operation:Operation) {
    if (disabled) return;
    if (operation === 'restart' ? invalid : dispatchBlock || !dispatchChanged) return;
    setPending(operation);
    setFeedback({message:operation === 'restart' ? '正在创建新的运行…' : '正在切换指挥方式…'});
    try {
      const result = await submit(key,operation);
      if (alive.current) setFeedback(result.ok
        ? {message:operation === 'restart' ? '新的运行已就绪。' : '指挥方式已切换。'}
        : {message:settingsMessage(result.reason),error:true});
    } catch {
      if (alive.current) setFeedback({message:settingsMessage(),error:true});
    } finally {
      if (alive.current) setPending(null);
    }
  }

  function field(id:SettingSelect,title:string) {
    const rayError = id === 'sensorMode' && invalid === 'ray_requires_rapier' && !block;
    return <label>{title}
      <select name={id} value={values[id]} onChange={event => change(id,event.target.value)}
        aria-invalid={rayError || undefined} aria-describedby={rayError ? 'world-settings-validation' : undefined}>
        {settingsOptions[id].map(([value,name]) => <option key={value} value={value}
          disabled={id === 'sensorMode' && value === 'rapier' && !rays}>{name}</option>)}
      </select>
    </label>;
  }

  return <section className="mc-world-settings" id="world-settings" data-anchor="world-settings" aria-label="场景与世界设置">
    <form noValidate onSubmit={event => {event.preventDefault();void send('restart')}}>
      <div className="mc-settings-content">
        {!standalone && <h2 className="mc-settings-title" tabIndex={-1}>场景与世界设置</h2>}
        <section className="mc-settings-current" aria-labelledby="world-current-title">
          <div className="mc-settings-current-head">
            <div>
              <h3 id="world-current-title">当前运行</h3>
              <p>{current.name}</p>
            </div>
            <code>T+{current.tick}</code>
          </div>
          <dl>
            <div><dt>种子</dt><dd>{current.seed}</dd></div>
            <div><dt>执行</dt><dd>{settingsLabel('executionMode',current.executionMode)}</dd></div>
            <div><dt>指挥</dt><dd>{settingsLabel('dispatchMode',current.dispatchMode)}</dd></div>
            <div><dt>分配</dt><dd>{settingsLabel('policy',current.policy)}</dd></div>
            <div><dt>物理</dt><dd>{settingsLabel('physicsMode',current.physicsMode)}</dd></div>
          </dl>
          {context.networkSummary && <p className="mc-settings-note">{context.networkSummary}</p>}
          {runtimeControls}
        </section>

        <div className="mc-settings-next">
          <h3 id="world-next-title" tabIndex={-1}>下次运行</h3>
          {block && block !== 'busy' && <p className="mc-settings-notice">
            {settingsMessage(block)}
            {block === 'agent_view' && <button type="button" className="mc-pill" onClick={global}>返回全局视图</button>}
          </p>}
          <fieldset className="mc-settings-grid mc-settings-basic" disabled={disabled} aria-labelledby="world-next-title">
            <label>任务场景
              <select name="scenario" value={values.scenario} onChange={event => change('scenario',event.target.value)}>
                {groupedScenarios.map(({name,options}) => <optgroup key={name} label={name}>
                  {options.map(([value,label]) => <option key={value} value={value}>{label}</option>)}
                </optgroup>)}
                {otherScenarios.map(([value,label]) => <option key={value} value={value}>{label}</option>)}
                {context.customLabel && <option value="_custom">{context.customLabel}</option>}
              </select>
            </label>
            <label>随机种子
              <input name="seed" type="number" min="0" max="4294967295" step="1" value={values.seed}
                aria-invalid={seedError || undefined}
                aria-describedby={seedError ? 'world-settings-validation' : undefined}
                onChange={event => change('seed',event.target.value)}/>
            </label>
            {field('executionMode','执行方式')}
            {field('dispatchMode','指挥方式')}
          </fieldset>
          {dispatchChanged && !block && <div className="mc-settings-dispatch">
            <p>{dispatchBlock ? settingsMessage(dispatchBlock) : '切换当前指挥方式会取消在途任务指令，已分配的任务继续执行。'}</p>
            {dispatchBlock === 'history_view'
              ? <button type="button" className="mc-pill" onClick={live}>返回实时视图</button>
              : !dispatchBlock && <button type="button" className="mc-pill" disabled={disabled}
                onClick={() => void send('dispatch')}>仅切换当前指挥方式</button>}
          </div>}

          <details className="mc-settings-advanced">
            <summary>
              <CaretRight size={14} aria-hidden="true"/>
              <span>高级设置</span>
              <span className="mc-settings-advanced-meta">
                {advancedOverrides ? advancedOverrides + ' 项非默认' : '分配、导航、通信与物理'}
              </span>
            </summary>
            <fieldset disabled={disabled}>
              <legend>分配与导航</legend>
              <div className="mc-settings-grid">
                {field('policy','分配策略')}
                {field('routePolicy','地面寻路')}
                {field('riskPolicy','风险区域')}
              </div>
            </fieldset>
            <fieldset disabled={disabled}>
              <legend>通信模拟</legend>
              <div className="mc-settings-grid">
                {field('linkProfile','链路配置')}
                {field('radioVisibility','设备通信遮挡')}
                {field('bandwidthProfile','设备消息带宽')}
              </div>
              {values.linkProfile === 'long' && <p className="mc-settings-note">
                指令延迟 12 步，有效期 40 步。状态每 10 步上报，有效期 60 步。丢包率沿用场景配置。
              </p>}
            </fieldset>
            {context.server ? <fieldset disabled={disabled}>
              <legend>服务端仿真</legend>
              <div className="mc-settings-grid">
                {field('physicsMode','服务仿真')}
                {field('sensorMode','服务端感知')}
              </div>
            </fieldset> : <p className="mc-settings-note mc-settings-offline">
              当前使用浏览器运动学预览。从本机世界服务地址访问，可配置服务端碰撞与感知。
            </p>}
          </details>
        </div>
      </div>

      <footer className="mc-settings-apply">
        <p id="world-settings-validation" className="mc-settings-status is-error" role="status">{validation}</p>
        <p className={'mc-settings-status' + (feedback?.error ? ' is-error' : '')} role="status">{status}</p>
        <div>
          <p id="world-restart-note">新运行从 T+0 开始。需要保留本次过程时，请先导出回放。</p>
          <button className="mc-pill violet" type="submit" disabled={disabled || !!invalid} aria-describedby="world-restart-note">
            {pending === 'restart' ? '正在重新开始…' : '应用并重新开始'}
          </button>
        </div>
      </footer>
    </form>
  </section>;
}
