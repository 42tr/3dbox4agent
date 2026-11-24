import React, {useEffect,useRef,useState} from 'react';

export type LidarScan = {
  tick:number;
  worldRevision:number;
  maxRange:number;
  distances:(number|null)[];
};

type Props = {
  agentId:string;
  unavailable:string;
  read:(agentId:string,signal:AbortSignal)=>Promise<LidarScan>;
};

export function DeviceLidar({agentId,unavailable,read}:Props) {
  const [scan,setScan] = useState<LidarScan>();
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => () => {request.current?.abort()},[]);
  useEffect(() => {
    if (!scan) return;
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const center = 120, radius = 105;
    ctx.clearRect(0,0,240,240);
    ctx.strokeStyle = '#586679';
    ctx.beginPath();
    ctx.arc(center,center,radius,0,2*Math.PI);
    ctx.stroke();
    scan.distances.forEach((distance,index) => {
      const angle = index*2*Math.PI/scan.distances.length;
      const length = radius*(distance===null?1:distance/scan.maxRange);
      ctx.strokeStyle = distance===null?'#3b4757':'#89d5c4';
      ctx.beginPath();
      ctx.moveTo(center,center);
      ctx.lineTo(center+Math.cos(angle)*length,center+Math.sin(angle)*length);
      ctx.stroke();
    });
    ctx.fillStyle = '#f4aa89';
    ctx.beginPath();
    ctx.arc(center,center,3,0,2*Math.PI);
    ctx.fill();
  },[scan]);

  async function measure() {
    if (request.current || unavailable) return;
    const controller = new AbortController();
    request.current = controller;
    setScan(undefined);
    setError('');
    setPending(true);
    try {
      const result = await read(agentId,controller.signal);
      if (!controller.signal.aborted) setScan(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error?error.message:'无法读取测距。');
    } finally {
      request.current = undefined;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <>
    <button type="button" className="mc-device-open mc-lidar-button" disabled={pending||!!unavailable}
      onClick={()=>void measure()}>{pending?'正在读取测距…':'读取 360° 测距'}</button>
    {(unavailable||error)&&<p className={'mc-lidar-status'+(error?' is-error':'')} role={error?'alert':undefined}>
      {unavailable||error}
    </p>}
    {scan&&!unavailable&&<div className="mc-lidar-result">
      <p className="mc-lidar-status" role="status">{agentId} · T+{scan.tick} · 版本 {scan.worldRevision} · 量程 {scan.maxRange} m</p>
      <canvas ref={canvas} width="240" height="240" role="img" aria-label={agentId+' 的水平测距图'}/>
      <details>
        <summary>各方向距离</summary>
        <p>0° 朝东，90° 朝南。</p>
        <p>{scan.distances.map((distance,index) =>
          Math.round(index*360/scan.distances.length)+'° '+(distance===null?'未命中':distance.toFixed(1)+' m')).join(' · ')}</p>
      </details>
    </div>}
  </>;
}
