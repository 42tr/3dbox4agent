'use strict';
// JSON and a data-only YAML subset share the same validator after parsing.
const YAML=require('yaml');
function parseData(text,filename='scene.json'){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>60000)throw Error('场景文件超过 60 KB');
 if(!/\.ya?ml$/i.test(filename))return JSON.parse(text);
 const doc=YAML.parseDocument(text,{uniqueKeys:true,strict:true});
 if(doc.errors.length||doc.warnings.length)throw Error('YAML 格式无效或包含不支持的标签');
 YAML.visit(doc,(_key,node)=>{
  if(YAML.isAlias(node)||node?.tag||node?.anchor)throw Error('YAML 不支持标签、锚点或引用');
  if(YAML.isPair(node)&&(!YAML.isScalar(node.key)||typeof node.key.value!=='string'))throw Error('YAML 映射键必须是字符串');
 });
 const value=doc.toJS({maxAliasCount:0});
 function validate(item,depth){
  if(depth>100)throw Error('场景嵌套过深');
  if(item===null||typeof item==='string'||typeof item==='boolean')return;
  if(typeof item==='number'){if(!Number.isFinite(item))throw Error('场景数字必须有限');return}
  if(Array.isArray(item)){for(const child of item)validate(child,depth+1);return}
  if(typeof item==='object'&&Object.getPrototypeOf(item)===Object.prototype){for(const [key,child] of Object.entries(item)){if(['__proto__','constructor','prototype'].includes(key))throw Error('场景包含无效键');validate(child,depth+1)}return}
  throw Error('场景包含不支持的数据类型');
 }
 validate(value,0);return value;
}
const PACKAGE_FORMAT='3dbox-scene-package-v1';
function unpack(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('场景必须是对象');
 if(!Object.prototype.hasOwnProperty.call(value,'format'))return {scene:value,manifest:null};
 if(value.format!==PACKAGE_FORMAT||Object.keys(value).some(k=>!['format','manifest','scene'].includes(k)))throw Error('不支持的场景包格式或字段');
 const m=value.manifest;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['version','description'].includes(k))||typeof m.version!=='string'||!/^\d+\.\d+\.\d+$/.test(m.version)||m.version.length>32||typeof m.description!=='string'||m.description.length>500)throw Error('场景包清单无效');
 if(!value.scene||typeof value.scene!=='object'||Array.isArray(value.scene))throw Error('场景包缺少场景');
 return {scene:value.scene,manifest:{version:m.version,description:m.description}};
}
function parseScene(text,filename='scene.json'){return unpack(parseData(text,filename)).scene}
function parsePackage(text,filename='scene.json'){const result=unpack(parseData(text,filename));if(!result.manifest)throw Error('不是场景包');return result}
function stringifyPackage(scene,manifest={version:'1.0.0',description:''}){
 const data={format:PACKAGE_FORMAT,manifest,scene};unpack(data);
 const output=JSON.stringify(data,null,2)+'\n';parsePackage(output);return output;
}
function stringifyScene(scene){
 const output=YAML.stringify(scene,{lineWidth:100,aliasDuplicateObjects:false});
 // Ensure every exported file satisfies the same parser and size rules as imports.
 parseScene(output,'scene.yaml');
 return output;
}
module.exports={parseScene,parsePackage,stringifyScene,stringifyPackage,PACKAGE_FORMAT};
