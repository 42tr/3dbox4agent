// Original 3DBox presentation assets. These shapes do not define simulation physics.
// Run with: node scripts/build-outpost-assets.mjs
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// GLTFExporter uses this browser primitive for binary Blob conversion only.
global.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); });
  }
};

const output = new URL('../assets/mission-control/codex-outpost/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const materials = Object.fromEntries(Object.entries({
  ivory: [0xd7d7c9, .19, .66],
  metal: [0xa2aba9, .56, .48],
  dark: [0x373e40, .21, .74],
  tire: [0x292c2b, .04, .96],
  glass: [0x344d55, .34, .23],
  teal: [0x5c8179, .17, .57],
  ochre: [0xb3a17b, .15, .72],
}).map(([name, [color, metalness, roughness]]) => [name,
  new T.MeshStandardMaterial({ name, color, metalness, roughness })]));

function mesh(parent, geometry, material, x = 0, y = 0, z = 0, rotation = null) {
  const object = new T.Mesh(geometry, materials[material]);
  object.position.set(x, y, z);
  if (rotation) object.rotation.set(...rotation);
  parent.add(object);
  return object;
}
function box(parent, w, h, d, material, x, y, z, radius = .035) {
  return mesh(parent, radius > .055 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)) : new T.BoxGeometry(w, h, d), material, x, y, z);
}
function rod(parent, from, to, radius = .035, material = 'metal') {
  const a = new T.Vector3(...from), b = new T.Vector3(...to), direction = b.clone().sub(a);
  const object = mesh(parent, new T.CylinderGeometry(radius, radius, direction.length(), 10), material);
  object.position.copy(a.add(b).multiplyScalar(.5));
  object.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), direction.normalize());
  return object;
}
function wheel(parent, x, z, radius = .32, width = .21) {
  const g = new T.Group(); g.position.set(x, radius + .025, z); parent.add(g);
  mesh(g, new T.CylinderGeometry(radius, radius, width, 28), 'tire', 0, 0, 0, [Math.PI / 2, 0, 0]);
  for (const side of [-1, 1]) {
    mesh(g, new T.TorusGeometry(radius * .84, .027, 6, 28), 'dark', 0, 0, side * width * .48);
    mesh(g, new T.CylinderGeometry(radius * .51, radius * .51, .035, 24), 'metal', 0, 0, side * width * .52, [Math.PI / 2, 0, 0]);
    mesh(g, new T.CylinderGeometry(radius * .18, radius * .18, .045, 16), 'dark', 0, 0, side * width * .64, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      mesh(g, new T.SphereGeometry(.018, 6, 4), 'ivory', Math.sin(a) * radius * .35, Math.cos(a) * radius * .35, side * width * .64);
    }
  }
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    const tread = box(g, .065, .025, width * .95, 'dark', Math.sin(a) * radius, Math.cos(a) * radius, 0, .006);
    tread.rotation.z = -a;
  }
}
function lights(parent, x, y, width) {
  for (const side of [-1, 1]) {
    box(parent, .035, .13, .2, 'metal', x, y, side * width);
    box(parent, .045, .065, .12, 'ivory', x + .025, y, side * width);
  }
}
function chassis(parent, length, width, sixWheels = true, radius = .3) {
  box(parent, length * .88, .23, width * .76, 'dark', 0, .48, 0);
  box(parent, length * .92, .12, width * .89, 'metal', 0, .64, 0);
  for (const side of [-1, 1]) {
    const wheelZ = side * (width / 2 - .11);
    const axleXs = sixWheels ? [-length * .32, 0, length * .32] : [-length * .32, length * .32];
    for (const x of axleXs) {
      wheel(parent, x, wheelZ, radius);
      rod(parent, [x, .44, side * width * .28], [x, radius + .025, wheelZ], .055, 'metal');
    }
    for (let i = 1; i < axleXs.length; i++)
      rod(parent, [axleXs[i - 1], radius + .12, wheelZ * .7], [axleXs[i], radius + .2, wheelZ * .7], .045, 'metal');
  }
}

function scout() {
  const g = new T.Group(); g.name = 'Scout rover / front +X';
  chassis(g, 2.65, 1.8);
  box(g, 1.65, .64, 1.28, 'ivory', .15, 1.04, 0, .16);
  box(g, .62, .58, 1.2, 'ivory', .81, 1.12, 0, .19);
  box(g, .035, .27, .88, 'glass', 1.13, 1.2, 0, .025);
  for (const side of [-1, 1]) {
    box(g, .66, .25, .025, 'glass', .47, 1.25, side * .645);
    rod(g, [-.38, .73, side * .68], [.83, .73, side * .68], .025, 'metal');
    box(g, .38, .035, .15, 'metal', .12, .72, side * .72);
    box(g, .43, .045, .035, 'teal', -.23, 1.12, side * .66);
  }
  box(g, .48, .42, .89, 'ivory', -.91, .94, 0, .06);
  for (let i = 0; i < 7; i++) box(g, .3, .015, .035, 'metal', -.91, 1.16, (i - 3) * .1);
  rod(g, [-.28, 1.37, -.26], [-.28, 1.92, -.26], .035, 'metal');
  box(g, .38, .19, .27, 'ivory', -.25, 1.91, -.26);
  for (const z of [-.33, -.19]) mesh(g, new T.CylinderGeometry(.044, .044, .04, 16), 'glass', -.045, 1.92, z, [0, 0, -Math.PI / 2]);
  rod(g, [-.9, 1.17, .25], [-.9, 1.78, .25], .013, 'dark');
  lights(g, 1.31, .77, .54);
  box(g, .07, .12, 1.3, 'metal', 1.32, .61, 0);
  return g;
}
function carrier() {
  const g = new T.Group(); g.name = 'Cargo carrier / front +X';
  chassis(g, 3.1, 1.85);
  box(g, .83, .79, 1.28, 'ivory', .93, 1.09, 0, .12);
  box(g, .035, .32, 1.02, 'glass', 1.36, 1.22, 0);
  for (const side of [-1, 1]) {
    box(g, .4, .3, .025, 'glass', 1.0, 1.23, side * .65);
    box(g, 1.8, .1, .075, 'metal', -.45, .81, side * .74);
    for (const x of [-1.28, .42]) rod(g, [x, .71, side * .74], [x, 1.06, side * .74], .025, 'metal');
    rod(g, [-1.28, 1.06, side * .74], [.42, 1.06, side * .74], .025, 'metal');
  }
  box(g, 1.82, .09, 1.45, 'metal', -.45, .74, 0);
  // Secured equipment cases are a role cue, not the simulated task's consumable part.
  for (const [x, z] of [[-.96, -.37], [-.96, .37], [-.26, -.37], [-.26, .37]]) {
    box(g, .6, .42, .57, 'ivory', x, 1.0, z, .035);
    box(g, .62, .05, .59, 'ochre', x, 1.22, z);
    box(g, .19, .035, .055, 'dark', x, 1.26, z);
  }
  lights(g, 1.49, .77, .52);
  return g;
}
function service() {
  const g = new T.Group(); g.name = 'Service robot / front +X';
  chassis(g, 1.72, 1.35, false, .24);
  box(g, 1.3, .4, .88, 'ivory', -.05, .89, 0, .085);
  box(g, .55, .18, .67, 'teal', -.36, 1.16, 0, .035);
  const joints = [[.25, 1.05, 0], [.2, 1.66, 0], [.66, 1.92, 0], [.9, 1.57, 0]];
  for (let i = 1; i < joints.length; i++) rod(g, joints[i - 1], joints[i], .075, 'ivory');
  for (const p of joints.slice(0, -1)) mesh(g, new T.CylinderGeometry(.11, .11, .2, 20), 'metal', ...p, [Math.PI / 2, 0, 0]);
  box(g, .12, .15, .26, 'dark', .91, 1.54, 0);
  for (const side of [-1, 1]) rod(g, [.91, 1.53, side * .1], [1.04, 1.38, side * .15], .025, 'metal');
  rod(g, [-.53, 1.06, -.3], [-.53, 1.62, -.3], .025, 'metal');
  box(g, .24, .15, .2, 'ivory', -.5, 1.65, -.3);
  box(g, .03, .07, .12, 'glass', -.365, 1.65, -.3);
  lights(g, .82, .73, .35);
  return g;
}

function powerUnit() {
  const g=new T.Group();g.name='Power service unit';
  box(g,5.8,.3,6.8,'metal',0,.15,0,.07);
  box(g,5.25,2.08,5.9,'ivory',0,1.25,0,.1);
  box(g,4.5,.32,4.8,'teal',0,2.4,0,.07);
  for(let i=0;i<13;i++)box(g,.075,.25,4.65,'metal',(i-6)*.32,2.66,0,.01);
  for(const side of [-1,1]){
    for(let i=0;i<9;i++)box(g,.9,.08,.04,'dark',side*1.6,.65+i*.13,side*2.97,.006);
    box(g,1.05,.16,.09,'ochre',side*1.6,.38,side*2.99,.01);
  }
  box(g,1.4,1.3,.12,'metal',0,1.3,3.02);
  box(g,.94,.45,.04,'dark',0,1.53,3.1);
  for(const x of [-.25,0,.25])box(g,.08,.08,.05,'teal',x,1.07,3.11,.01);
  for(const side of [-1,1])rod(g,[side*2.63,.5,1.8],[side*2.63,1.8,1.8],.045,'metal');
  return g;
}
function commsDish() {
  const g=new T.Group();g.name='Parabolic communications dish';
  box(g,2.4,.22,2.4,'metal',0,.11,0,.07);
  rod(g,[0,.2,0],[0,3.9,0],.13,'ivory');
  for(let i=0;i<3;i++){
    const a=i*2*Math.PI/3;rod(g,[Math.cos(a)*1.05,.2,Math.sin(a)*1.05],[0,2.3,0],.055,'metal');
  }
  const dish=new T.Group();dish.position.y=4.05;dish.rotation.z=-.48;dish.rotation.y=.3;g.add(dish);
  const profile=[];
  for(let i=0;i<=16;i++){const r=i/8;profile.push(new T.Vector2(r,r*r/6.4))}
  for(let i=16;i>=0;i--){const r=i/8;profile.push(new T.Vector2(r,r*r/6.4-.06))}
  mesh(dish,new T.LatheGeometry(profile,64),'ivory');
  const rim=mesh(dish,new T.TorusGeometry(2,.045,6,64),'metal',0,.625,0,[Math.PI/2,0,0]);
  for(let i=0;i<3;i++){
    const a=i*2*Math.PI/3;rod(dish,[Math.cos(a)*1.83,.52,Math.sin(a)*1.83],[0,1.35,0],.025,'metal');
  }
  mesh(dish,new T.CylinderGeometry(.12,.2,.28,20),'metal',0,1.38,0);
  mesh(dish,new T.CylinderGeometry(.09,.09,.035,20),'dark',0,1.54,0);
  return g;
}

function bake(source) {
  // One mesh per material keeps cloning twelve devices and their cameras cheap.
  source.updateMatrixWorld(true);
  const groups = new Map();
  source.traverse(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    geometry.deleteAttribute('uv');
    const key = object.material.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(geometry.index ? geometry.toNonIndexed() : geometry);
  });
  const result = new T.Group(); result.name = source.name;
  for (const [name, geometries] of groups) {
    const geometry = mergeVertices(mergeGeometries(geometries), 1e-5);
    const object = new T.Mesh(geometry, materials[name]);
    object.name = name; result.add(object);
    for (const old of geometries) old.dispose();
  }
  const bounds = new T.Box3().setFromObject(result);
  result.position.y = -bounds.min.y;
  return result;
}
const records = [];
for (const [name, create] of [['scout-rover', scout], ['cargo-carrier', carrier], ['service-robot', service], ['power-unit',powerUnit], ['comms-dish',commsDish]]) {
  const scene = new T.Scene(), model = bake(create()); scene.add(model);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, copyright: 'Original 3DBox presentation assets' });
  const buffer = Buffer.from(data); await fs.writeFile(new URL(name + '.glb', output), buffer);
  const bounds = new T.Box3().setFromObject(model), size = bounds.getSize(new T.Vector3());
  let triangles = 0; model.traverse(o => { if (o.isMesh) triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  records.push({ name: name + '.glb', bytes: buffer.byteLength, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), meshes: model.children.length, triangles, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: size.toArray() } });
}
await fs.writeFile(new URL('provenance.json', output), JSON.stringify({
  author: 'Codex for 3DBox', source: 'scripts/build-outpost-assets.mjs',
  kind: 'Original code-authored 3D meshes; no external source models or image textures',
  purpose: 'Interactive presentation only; simulation state, capabilities and simplified colliders remain authoritative',
  forwardAxis: '+X', files: records,
}, null, 2) + '\n');
console.log(JSON.stringify(records.map(({ name, bytes, triangles, meshes }) => ({ name, bytes, triangles, meshes })), null, 2));
