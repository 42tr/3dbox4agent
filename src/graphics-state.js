'use strict';

// Graphics availability is independent of the simulation and its state.
function createContext(canvas) {
  const context=canvas.getContext('webgl2',{alpha:false,antialias:true,depth:true,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:false,powerPreference:'default',failIfMajorPerformanceCaveat:false});
  if(context)return context;
  const error=new Error('WebGL 2 context unavailable');
  error.code='WEBGL2_UNAVAILABLE';
  throw error;
}

function failure(error) {
  if(error?.code==='WEBGL2_UNAVAILABLE')return {
    code:'webgl2-unavailable',title:'已切换二维态势',
    body:'当前图形环境未提供 WebGL 2，无法显示三维场景。',
    help:'任务运行和设备操作仍可使用。可在系统浏览器中打开同一地址检查三维效果。'
  };
  if(error?.code==='WEBGL_CONTEXT_LOST')return {
    code:'context-lost',title:'三维图形连接已中断',
    body:'已切换二维态势，当前任务继续运行。',
    help:'需要恢复三维时，请先保存需要的回放，再刷新页面。'
  };
  return {
    code:'initialization-failed',title:'三维场景未能载入',
    body:'已切换二维态势，任务运行和设备操作仍可使用。',
    help:'可刷新页面重试；若仍失败，请查看浏览器控制台中的场景错误。'
  };
}

module.exports={createContext,failure};
