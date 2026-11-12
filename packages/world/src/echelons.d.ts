export type EchelonConfig={id:string;name:string;taskIds:string[]};
export function validate(groups:unknown,tasks:unknown):true;
export function normalize(groups:EchelonConfig[],tasks:unknown):EchelonConfig[];
declare const api:{validate:typeof validate;normalize:typeof normalize};
export default api;
