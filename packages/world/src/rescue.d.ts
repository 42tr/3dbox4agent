export type RescueProfile={workTicks:number};
export function validateProfile(scene:unknown):void;
export function fields(agent:unknown):{recoverableFault?:true;rescue?:RescueProfile};
export function faultAt(events:unknown[],targetId:string,observedTick?:number):any;
export function reason(world:unknown,agent:unknown,action:unknown,reachable:boolean):string|null;
export function validateWorld(world:unknown,expected:unknown):true;
