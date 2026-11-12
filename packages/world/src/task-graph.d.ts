export function layout(tasks:{id:string;dependsOn:string[]}[]):{nodes:{id:string;level:number;x:number;y:number;width:number;height:number}[];edges:{from:string;to:string;x1:number;y1:number;x2:number;y2:number}[];width:number;height:number};
export function describe(world:unknown,task:unknown):string;
