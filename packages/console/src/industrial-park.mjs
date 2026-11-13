import * as THREE from 'three';
import layout from '../../world/scenes/industrial-park-v2-layout.json' with {type:'json'};
import campusScene from '../../world/scenes/industrial-park-v2.json' with {type:'json'};

function gate(axis, beforeId, afterId, label) {
  const before = campusScene.obstacles.find(o => o.id === beforeId);
  const after = campusScene.obstacles.find(o => o.id === afterId);
  if (axis === 'y') {
    const start = before.x + before.w;
    return {axis, label, x: (start + after.x) / 2, y: before.y + before.h / 2, width: after.x - start};
  }
  const start = before.y + before.h;
  return {axis, label, x: before.x + before.w / 2, y: (start + after.y) / 2, width: after.y - start};
}
const campus = {...layout, gates: [
  gate('y', 'wall-south-west', 'wall-south-east', '工业园区'),
  gate('x', 'wall-east-north', 'wall-east-south', '货运入口'),
]};

export {campus as industrialCampusLayout};

export function isIndustrialPark(sceneId) {
  return sceneId === 'industrial-park-v1' || sceneId?.startsWith('industrial-park-');
}

export const industrialParkSize = 212;
export const industrialGroundSize = 1600;
const yardEdge = 50;
const ring = 56;
const ringWidth = 7;
const outerRoad = 102;
const outerRoadWidth = 8;
const fenceLine = 112;
const entranceRoadEnd = 146;
const parkingWidth = 4.5;
const steel = 0x435461;
const asphalt = 0x3a4651;
const concrete = 0x909c9d;
const white = 0xdde4e2;
const yellow = 0xffbd52;
const blue = 0x437da4;
const glass = 0x254b61;
const teal = 0x59948b;
const orange = 0xbb6744;
const buildings = new Map([
  ['warehouse', {color: blue, label: 'WAREHOUSE'}],
  ['workshop', {color: orange, label: 'WORKSHOP'}],
  ['equipment', {color: teal, label: 'EQUIPMENT'}],
  ['control', {color: steel, label: 'CONTROL'}],
]);

// The outer districts are outside the simulation's 100 × 100 working area.
export const industrialDistricts = [
  {type: 'logistics', buildings: [[-77, -41, 22, 25, 9], [-77, -16, 22, 16, 8], [-76, 37, 25, 33, 8]]},
  {type: 'production', buildings: [[78, -40, 27, 33, 13], [77, 49, 24, 25, 11], [78, -14, 25, 13, 10]]},
  {type: 'utilities', buildings: [[-45, -80, 18, 23, 8], [-22, -82, 19, 21, 10], [19, -79, 15, 18, 7], [43, -83, 23, 19, 8]]},
  {type: 'offices', buildings: [[-48, 81, 23, 23, 15], [-22, 72, 17, 18, 8], [23, 73, 18, 18, 9], [50, 84, 22, 18, 11]]},
];
export const industrialEntrances = [
  {side: 'south', width: 18, center: 0, label: '工业园区'},
  {side: 'east', width: 14, center: 24, label: '货运入口'},
];

export function createIndustrialPark(scene, {modern=false}={}) {
  const center = modern ? campusScene.worldSize / 2 : 50;
  const groundGeometry = new THREE.PlaneGeometry(industrialGroundSize, industrialGroundSize, 160, 160);
  groundGeometry.rotateX(-Math.PI / 2);
  const positions = groundGeometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const grass = new THREE.Color(0x667d73);
  const shade = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const outskirts = THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), entranceRoadEnd + 4, 235);
    const relief = Math.sin(x * .035) * Math.cos(z * .03) + .4 * Math.sin((x + z) * .065);
    positions.setY(i, -.11 + outskirts * relief * 5);
    shade.copy(grass).multiplyScalar(1 + outskirts * relief * .14).toArray(colors, i * 3);
  }
  groundGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeometry.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeometry, new THREE.MeshStandardMaterial({vertexColors: true, roughness: 1}));
  ground.receiveShadow = true;
  ground.visible = false;
  scene.add(ground);

  const yard = new THREE.Group();
  scene.add(yard);
  yard.visible = false;
  const siteModels = new THREE.Group();
  yard.add(siteModels);

  const cube = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(.5, .5, 1, 16);
  const materials = new Map();
  let yardKey = '';

  function material(color) {
    if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({color, roughness: .86}));
    return materials.get(color);
  }

  // Batch repeated painted markings and facade details by material and shape.
  function model(root, {receiveShadow=true}={}) {
    const groups = new Map();
    return {
      box(color, w, h, d, x, y, z, detail = false, angle = 0, geometry = cube) {
        const key = [color, detail, geometry.id].join(':');
        if (!groups.has(key)) groups.set(key, {color, detail, geometry, transforms: []});
        groups.get(key).transforms.push({w, h, d, x, y, z, angle});
      },
      build() {
        const transform = new THREE.Object3D();
        for (const {color, detail, geometry, transforms} of groups.values()) {
          const mesh = new THREE.InstancedMesh(geometry, material(color), transforms.length);
          transforms.forEach(({w, h, d, x, y, z, angle}, i) => {
            transform.position.set(x, y, z);
            transform.rotation.set(0, angle, 0);
            transform.scale.set(w, h, d);
            transform.updateMatrix();
            mesh.setMatrixAt(i, transform.matrix);
          });
          mesh.userData.industrialInstances = true;
          mesh.userData.decorative = detail;
          mesh.castShadow = root !== yard;
          mesh.receiveShadow = receiveShadow;
          root.add(mesh);
        }
      },
    };
  }

  function buildDistricts() {
    const districtModels = new THREE.Group();
    districtModels.name = 'Industrial districts';
    siteModels.add(districtModels);
    const {box: place, build} = model(districtModels);
    const styles = {logistics: blue, production: orange, utilities: teal, offices: steel};
    for (const {type, buildings} of industrialDistricts) {
      for (const [x, z, width, depth, h] of buildings) {
        const sideStreet = type === 'logistics' || type === 'production';
        const axis = sideStreet ? x : z;
        const direction = Math.sign(axis);
        const angle = sideStreet ? direction * Math.PI / 2 : direction > 0 ? 0 : Math.PI;
        const w = sideStreet ? depth : width;
        const d = sideStreet ? width : depth;
        const sin = Math.sin(angle), cos = Math.cos(angle);
        function box(color, width, height, depth, left, y, forward, detail = false, geometry) {
          place(color, width, height, depth, x + left * cos + forward * sin, y,
            z - left * sin + forward * cos, detail, angle, geometry);
        }
        const front = d / 2;
        const accessLength = outerRoad - outerRoadWidth / 2 - Math.abs(axis) - front;
        box(concrete, sideStreet ? w : 7, .04, accessLength, 0, -.05, front + accessLength / 2);
        box(styles[type], w, h, d, 0, h / 2, 0);
        box(concrete, w + .35, .35, d + .35, 0, h, 0);
        if (sideStreet) {
          for (const offset of [-.28, 0, .28]) {
            box(glass, w * .18, h * .47, .16, w * offset, h * .245, front + .09);
            box(yellow, w * .18, .19, .23, w * offset, h * .5, front + .09, true);
            box(type === 'logistics' ? steel : glass, w * .17, .55, d * .57, w * offset, h + .40, 0);
            box(yellow, .12, .01, accessLength * .73, w * offset, -.021, front + accessLength / 2, true);
          }
        } else if (type === 'utilities') {
          for (const offset of [-.25, .25]) {
            box(white, w * .26, 2.7, d * .27, w * offset, h + 1.48, -d * .17, false, cylinder);
            box(steel, w * .26, .55, d * .17, w * offset, h + .40, d * .23);
          }
          box(glass, w * .73, h * .25, .2, 0, h * .59, front + .12);
          box(steel, 3.4, 3.2, .22, 0, 1.6, front + .12);
        } else {
          box(glass, w * .86, h * .66, .16, 0, h * .49, front + .09);
          box(glass, .16, h * .66, d * .86, w / 2 + .09, h * .49, 0);
          for (const floor of [.30, .52, .74]) {
            box(white, w * .86, .16, .20, 0, h * floor, front + .09, true);
            box(white, .20, .16, d * .86, w / 2 + .09, h * floor, 0, true);
          }
          box(blue, w * .59, .45, d * .43, 0, h + .39, -d * .14);
          box(white, 4.2, .27, 1.55, 0, 3, front + .74);
          box(glass, 3.05, 2.7, .25, 0, 1.35, front + .11);
        }
      }
    }
    build();
  }
  if(!modern) buildDistricts();

  function buildPublicSpaces() {
    const spaces = new THREE.Group();
    spaces.name = 'Industrial public spaces';
    siteModels.add(spaces);
    const {box, build} = model(spaces);
    const paving = 0xb2aaa0;
    const lawn = 0x658b73;
    const canopy = 0x4a7358;
    const crown = new THREE.IcosahedronGeometry(.5, 1);
    for (const side of [-1, 1]) {
      box(paving, 22, .06, 16, side * 20, -.031, 91);
      for (const x of [14, 29]) box(lawn, 4, .07, 10, side * x, .02, 91);
      box(paving, 4.4, .03, 38.5, side * 9.2, -.027, 78.75);
      for (const z of [66, 75, 84, 94]) {
        const x = side * 10.9;
        box(steel, .62, 2.8, .62, x, 1.4, z);
        box(canopy, 3.5, 4.3, 3.5, x, 3.65, z, false, 0, crown);
      }
      for (const x of [14, 29]) {
        box(steel, .6, 2.5, .6, side * x, 1.25, 91);
        box(canopy, 4.7, 4.6, 4.7, side * x, 3.72, 91, false, 0, crown);
      }
    }
    box(paving, 2.1, .07, 25, 0, .025, 82);
    for (const z of [72, 78, 84, 90]) {
      box(lawn, 1.44, .1, 3.9, 0, .075, z);
    }
    for (const x of [-6, -4, -2, 0, 2, 4, 6]) {
      box(white, .83, .01, 2, x, .027, 97);
    }

    // Truck staging beside the offset freight gate.
    box(steel, 33, .06, 21, 81.5, -.03, 24);
    for (const z of [16, 21, 27, 32]) {
      box(yellow, 13, .01, .17, 77.5, .009, z);
      box(white, .18, .01, 3.5, 71.2, .009, z + 1.75, true);
    }
    for (const [z, color] of [[19, blue], [30, orange]]) {
      box(color, 7.5, 2.3, 2.75, 77, 1.6, z);
      box(white, 2.3, 2.05, 2.5, 82.1, 1.37, z);
      box(steel, 8.3, .42, 2.18, 77.7, .54, z);
    }
    // Utility compound and solar arrays face the northern service road.
    box(concrete, 20, .06, 29, -73, -.03, -78);
    for (const z of [-88, -80, -72, -64]) {
      box(steel, 13.6, .2, .24, -73, .92, z);
      for (const x of [-77, -69]) {
        box(glass, 7.7, .22, 4.7, x, 1.03, z);
        for (const offset of [-1.2, .65, 2.5]) box(blue, .15, .03, 4.5, x + offset, 1.16, z, true);
      }
    }
    build();
  }
  if(!modern) buildPublicSpaces();

  function labelMesh(root, text, color, width, x, y, z) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 65px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 66, 480);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 4), new THREE.MeshBasicMaterial({map}));
    label.position.set(x, y, z);
    label.userData.industrialLabel = text;
    root.add(label);
    return label;
  }

  function roofLabel(root, text, color, width, x, y, z) {
    labelMesh(root, text, color, width, x, y, z).rotation.x = -Math.PI / 2;
  }

  function buildPerimeter() {
    const perimeter = new THREE.Group();
    perimeter.name = 'Industrial entrances and fence';
    siteModels.add(perimeter);
    const {box, build} = model(perimeter);
    const wall = 0x849091;
    for (const [side, angle] of [['south', 0], ['east', Math.PI / 2], ['north', Math.PI], ['west', -Math.PI / 2]]) {
      const entrance = industrialEntrances.find(item => item.side === side);
      const sin = Math.sin(angle), cos = Math.cos(angle);
      function place(color, w, h, d, x, y, z, detail = false) {
        box(color, w, h, d, x * cos + z * sin, y, z * cos - x * sin, detail, angle);
      }
      function fence(start, end) {
        const length = end - start;
        const center = (start + end) / 2;
        place(wall, length, .92, .65, center, .46, fenceLine);
        for (const y of [1.17, 2.03]) place(steel, length, .13, .22, center, y, fenceLine);
        const spans = Math.ceil(length / 9);
        for (let index = 0; index < spans; index++) {
          const x = start + index * length / spans;
          place(steel, .29, 2.22, .44, x, 1.11, fenceLine);
          for (const fraction of [.23, .46, .69, .92]) {
            place(steel, .09, 1.15, .13, x + fraction * length / spans, 1.48, fenceLine, true);
          }
        }
      }
      if (!entrance) {
        fence(-fenceLine, fenceLine);
        continue;
      }
      const halfWidth = entrance.width / 2;
      const center = side === 'east' ? -entrance.center : entrance.center;
      fence(-fenceLine, center - halfWidth);
      fence(center + halfWidth, fenceLine);
      function gateBox(color, w, h, d, x, y, z, detail = false) {
        place(color, w, h, d, center + x, y, z, detail);
      }
      const portalHeight = side === 'south' ? 7.5 : 6.3;
      for (const sign of [-1, 1]) {
        gateBox(steel, 1.25, portalHeight, 1.8, sign * (halfWidth + .65), portalHeight / 2, fenceLine);
        gateBox(yellow, .28, 1.25, .35, sign * (halfWidth - .65), .625, fenceLine + 1.65);
      }
      gateBox(blue, entrance.width + 3.7, 2.3, 2.1, 0, portalHeight - .3, fenceLine);
      const signFront = fenceLine + 1.07;
      const sign = labelMesh(perimeter, entrance.label, '#25445a', entrance.width - 1,
        signFront * sin + center * cos, portalHeight - .27, signFront * cos - center * sin);
      sign.rotation.y = angle;
      sign.scale.y = .58;
      const canopySign = sign.clone();
      canopySign.position.set(fenceLine * sin + center * cos, portalHeight + .87, fenceLine * cos - center * sin);
      canopySign.rotation.set(-Math.PI / 2, 0, -angle);
      canopySign.scale.y = .48;
      perimeter.add(canopySign);

      const boothX = -(halfWidth + 4.6), boothZ = fenceLine - 3.6;
      gateBox(concrete, 5.5, 3.4, 4.8, boothX, 1.7, boothZ);
      gateBox(glass, 4.55, 1.25, .16, boothX, 2.17, boothZ + 2.44);
      gateBox(glass, .16, 1.25, 3.55, boothX + 2.78, 2.17, boothZ);
      gateBox(steel, 6.1, .37, 5.35, boothX, 3.55, boothZ);
      for (let stripe = -2; stripe <= 2; stripe++) {
        gateBox(white, 1.3, .01, .28, stripe * 1.68, .026, fenceLine + 3.7, true);
      }
      for (const lane of [-.26, .26]) {
        const x = lane * entrance.width;
        gateBox(steel, .36, .95, .5, x - 1.7, .48, fenceLine + 1.15);
        gateBox(white, 3.6, .13, .15, x, 1.02, fenceLine + 1.15);
        for (const offset of [-1.3, -.5, .3, 1.1]) {
          gateBox(orange, .39, .14, .16, x + offset, 1.02, fenceLine + 1.15, true);
        }
      }
    }
    build();
  }
  if(!modern) buildPerimeter();
  else {
    const streets=new THREE.Group();
    siteModels.add(streets);
    const {box,build}=model(streets);
    const groundRect=(color,[x,z,w,d],y)=>box(color,w,.02,d,x+w/2-center,y,z+d/2-center);
    for(const rect of campus.yards)groundRect(0xaba89e,rect,-.065);
    for(const rect of campus.walks)groundRect(0xc3b8a6,rect,-.05);
    for(const rect of campus.roads){
      groundRect(asphalt,rect,-.035);
      const [x,z,w,d]=rect;
      const horizontal=w>d;
      for(let i=9;i<(horizontal?w:d)-7;i+=9){
        if(!horizontal&&z===136&&z+i>=175&&z+i<=210)continue;
        box(white,horizontal?3:.18,.01,horizontal?.18:3,
          (horizontal?x+i:x+w/2)-center,-.018,(horizontal?z+d/2:z+i)-center,true);
      }
    }
    const [crossX,crossZ,crossW,crossD]=campus.crossing;
    for(let x=crossX+1;x<crossX+crossW-1;x+=1.55){
      groundRect(white,[x,crossZ,.8,crossD],-.019);
    }
    for(const [x,z] of campus.truckBays){
      for(const shift of [-2.1,2.1])box(yellow,.17,.015,8,x+shift-center,-.047,z-center);
      box(yellow,4.2,.015,.17,x-center,-.046,z+4-center);
    }
    const crown=new THREE.IcosahedronGeometry(.5,1);
    for(const [x,z] of campus.trees){
      box(0x736657,.55,2.6,.55,x-center,1.3,z-center);
      box(0x527959,4.3,5.0,4.3,x-center,3.7,z-center,false,0,crown);
    }
    for(const gate of campus.gates){
      const east=gate.axis==='x',x=gate.x-center,z=gate.y-center;
      box(blue,east?1.05:gate.width,1.4,east?gate.width:1.05,x,5.7,z);
      for(const side of [-1,1]){
        const offset=side*(gate.width/2+.36);
        box(steel,east?.82:.72,5.1,east?.72:.82,x+(east?0:offset),2.55,z+(east?offset:0));
      }
      const sign=labelMesh(streets,gate.label,'#34586e',gate.width*.87,x+(east?.55:0),5.7,z+(east?0:.55));
      sign.rotation.y=east?Math.PI/2:0;
      sign.scale.y=.35;
    }
    build();
  }

  function building({id, x, y, w, h: d, height: h}) {
    const spec=modern?campus.buildings[id]:null;
    const kind=spec?.style??id;
    if(modern&&(id.startsWith('wall-')||id.endsWith('-booth')||id.startsWith('median-'))){
      const root=new THREE.Group(),{box,build}=model(root);
      root.position.set(x+w/2-center,0,y+d/2-center);
      root.userData.obstacleId=id;
      root.userData.industrial=true;
      if(id.startsWith('median-')){
        box(concrete,w,.23,d,0,.115,0);
        box(0x60845e,w-.25,h-.23,d-.25,0,(h+.23)/2,0);
      }else if(id.startsWith('wall-')){
        box(concrete,w,1.12,d,0,.56,0);
        const horizontal=w>d;
        for(const level of [1.45,2.72])box(steel,horizontal?w:.2,.17,horizontal?.2:d,0,level,0);
        const length=horizontal?w:d;
        for(let i=1;i<length;i+=3.8){
          const at=i-length/2;
          box(steel,.25,1.93,.25,horizontal?at:0,2.035,horizontal?0:at,true);
        }
      }else{
        box(concrete,w,h,d,0,h/2,0);
        box(glass,w*.75,1.15,.1,0,h*.68,d/2-.015);
      }
      build();scene.add(root);return root;
    }
    const style = buildings.get(kind);
    if (!style) return null;
    const root = new THREE.Group();
    root.position.set(x + w / 2 - center, 0, y + d / 2 - center);
    root.rotation.y=spec?.angle??0;
    root.userData.obstacleId = id;
    root.userData.industrial = true;
    const m = model(root,{receiveShadow:!modern});
    const {box} = m;
    const facadeColor=modern?({warehouse:0x8293a0,workshop:0x8c837a,equipment:0x78897c,control:0x68757d})[kind]:style.color;
    box(facadeColor, w - .14, h * .78, d - .14, 0, h * .39, 0);
    box(modern?0xb7b1a9:concrete, w, h * .14, d, 0, h * .85, 0);
    box(steel, w, h * .07, .35, 0, h * .965, d / 2 - .175);
    box(steel, .35, h * .07, d, w / 2 - .175, h * .965, 0);
    box(steel, w, h * .07, .35, 0, h * .965, -d / 2 + .175);
    box(steel, .35, h * .07, d, -w / 2 + .175, h * .965, 0);
    const front = d / 2 - .2;
    const side = w / 2 - .2;

    if (kind === 'warehouse' || kind === 'workshop') {
      const bays=modern?[-.37,-.185,0,.185,.37]:[-.29,0,.29];
      const bayWidth=modern?.145:.23;
      for (const fraction of bays) {
        const door = w * fraction;
        box(steel, w * bayWidth, h * .57, .2, door, h * .285, front + .045);
        box(kind === 'warehouse' ? white : glass, w * bayWidth*.74, h * .43, .12, door, h * .25, front + .11);
        box(yellow, w * bayWidth*.87, h * .045, .16, door, h * .58, front + .11);
        for (const row of [.16, .25, .34]) {
          box(kind === 'warehouse' ? concrete : blue, w * bayWidth*.69, .07, .14, door, h * row, front + .12, true);
        }
      }
      box(glass, .2, h * .18, d * .74, side + .065, h * .69, 0);
      for (const f of [-.32, -.16, 0, .16, .32]) {
        box(white, .18, h * .18, .1, side + .09, h * .69, d * f, true);
      }
      if (kind === 'warehouse') {
        for (let i = -2; i <= 2; i++) box(steel, .09, .08, d * .79, i * w * .17, h * .963, 0, true);
      } else if(modern) {
        const span=d-.82;
        const rise=h*.057;
        const pitch=Math.atan2(rise,span/2);
        for(const side of [-1,1]){
          const panel=new THREE.Mesh(new THREE.PlaneGeometry(w-.82,Math.hypot(span/2,rise)),material(side>0?0xc3bcb0:0xa8aeb0));
          panel.position.set(0,h*.923+rise/2,side*span/4);
          panel.rotation.x=-Math.PI/2+side*pitch;
          panel.castShadow=true;
          panel.userData.industrialRoof=true;
          root.add(panel);
        }
        box(steel,w-.82,.12,.26,0,h*.982,0);
        for(const f of [-.27,0,.27]){
          box(glass,w*.12,h*.018,d*.12,w*f,h*.978,-d*.12);
        }
      } else {
        for (const f of [-.26, 0, .26]) {
          box(glass, w * .14, h * .065, d * .23, w * f, h * .965, -d * .21);
        }
      }
    } else if (kind === 'equipment') {
      // Plant housings and pipes sit on the recessed roof within the obstacle bounds.
      for (const f of [-.28, 0, .28]) {
        box(white, w * .19, h * .18, d * .23, w * f, h * .91, -d * .21, false, 0, cylinder);
        box(blue, w * .15, h * .10, d * .07, w * f, h * .89, d * .02, true);
      }
      box(yellow, w * .76, h * .065, .25, 0, h * .96, -d * .36);
      for (const f of [-.33, -.11, .11, .33]) {
        box(steel, w * .16, h * .34, .20, w * f, h * .40, front + .07);
        for (const row of [.29, .38, .47]) box(white, w * .13, .07, .12, w * f, h * row, front + .13, true);
      }
      box(white, .14, h * .32, d * .60, side + .09, h * .42, 0);
    } else {
      if(modern){
        box(steel,w*.65,h*.26,d*.53,0,h*.87,-d*.17);
        box(glass,w*.58,h*.16,.13,0,h*.85,d*.095);
      }
      box(glass, w * .86, h * .33, .16, 0, h * .57, front + .12);
      box(glass, .18, h * .33, d * .86, side + .11, h * .57, 0);
      for (const f of [-.34, -.17, 0, .17, .34]) {
        box(white, .10, h * .33, .15, w * f, h * .57, front + .125, true);
        box(white, .17, h * .33, .10, side + .115, h * .57, d * f, true);
      }
      box(white, w * .15, h * .35, .14, w * .3, h * .175, front + .11);
      box(blue, w * .33, h * .075, d * .26, -w * .2, h * .96, -d * .16);
    }
    m.build();
    roofLabel(root, spec?.label??style.label, '#263641', w * (modern?.48:.75), 0, h * (modern&&kind==='workshop'?.983:.945), d * (modern?.27:.20));
    scene.add(root);
    return root;
  }

  function dispose(root) {
    for (const child of [...root.children]) {
      if (child === siteModels) continue;
      if (child.userData.industrialInstances) child.dispose();
      if (child.userData.industrialRoof) child.geometry.dispose();
      if (child.userData.industrialLabel) {
        child.geometry.dispose();
        child.material.map.dispose();
        child.material.dispose();
      }
      child.removeFromParent();
    }
  }

  function updateYard(charger, worksite) {
    const key = JSON.stringify([charger, worksite]);
    if (key === yardKey) return;
    yardKey = key;
    dispose(yard);
    const m = model(yard);
    const {box} = m;
    if(!modern){
    box(concrete, yardEdge * 2, .08, yardEdge * 2, 0, -.07, 0);
    box(asphalt, 100, .018, 12, 0, .001, 0);
    for (const side of [-1, 1]) box(asphalt, 10, .018, 44, 0, .001, side * 28);
    for (const side of [-1, 1]) {
      const crossSpan = ring * 2 + ringWidth;
      const sideSpan = ring * 2 - ringWidth;
      box(asphalt, crossSpan, .018, ringWidth, 0, .001, side * ring);
      box(asphalt, ringWidth, .018, sideSpan, side * ring, .001, 0);
      const connector = ring - ringWidth / 2 - yardEdge;
      box(asphalt, connector, .018, 12, side * (yardEdge + connector / 2), .001, 0);
      box(asphalt, 10, .018, connector, 0, .001, side * (yardEdge + connector / 2));
      const parking = side * (ring + ringWidth / 2 + parkingWidth / 2);
      for (const offset of [-27, 27]) {
        box(steel, parkingWidth, .018, 18, parking, .001, offset);
        for (let stripe = -8; stripe <= 8; stripe += 4) {
          box(white, 3.7, .01, .15, parking, .019, offset + stripe, true);
        }
      }
      for (let dash = -48; dash <= 48; dash += 8) {
        if (Math.abs(dash) < 8) continue;
        box(yellow, 3.3, .01, .18, dash, .019, side * ring);
        box(yellow, .18, .01, 3.3, side * ring, .019, dash);
      }
      const lane = 26.5 * side;
      for (const half of [-1, 1]) {
        box(white, 44, .01, .15, half * 27.5, .014, side * 48.9);
        box(white, .15, .01, 43, side * 48.9, .016, half * 28);
      }
      box(white, 45, .01, .17, lane + side, .027, 5.5);
      box(white, 45, .01, .17, lane + side, .027, -5.5);
      box(white, .17, .01, 44, 4.55, .027, lane + side * 1.5);
      box(white, .17, .01, 44, -4.55, .027, lane + side * 1.5);
      for (let n = 10; n <= 47; n += 7.2) {
        box(yellow, 3.3, .01, .18, n * side, .027, 0);
        box(yellow, .18, .01, 3.3, 0, .027, n * side);
      }
      for (let n = -3; n <= 3; n++) {
        box(white, .33, .01, 1.9, n * 1.03, .031, side * 8.7, true);
        box(white, 1.9, .01, .33, side * 7.7, .031, n * 1.21, true);
      }
      const extensionStart = ring + ringWidth / 2;
      const extensionLength = outerRoad - outerRoadWidth / 2 - extensionStart;
      const extensionCenter = side * (extensionStart + extensionLength / 2);
      box(asphalt, extensionLength, .018, 12, extensionCenter, .001, 0);
      box(asphalt, side > 0 ? 14 : 10, .018, extensionLength, 0, .001, extensionCenter);
      box(asphalt, industrialParkSize, .018, outerRoadWidth, 0, .001, side * outerRoad);
      box(asphalt, outerRoadWidth, .018, outerRoad * 2 - outerRoadWidth, side * outerRoad, .001, 0);
      for (let dash = 9; dash < outerRoad - 9; dash += 10) {
        for (const direction of [-1, 1]) {
          box(yellow, 4.1, .01, .18, direction * dash, .027, side * outerRoad);
          box(yellow, .18, .01, 4.1, side * outerRoad, .027, direction * dash);
        }
      }
      for (const dash of [67, 76, 85, 94]) {
        box(yellow, 3.9, .01, .18, side * dash, .027, 0);
        box(yellow, .18, .01, 3.9, 0, .027, side * dash);
      }
    }
    for (const {side, width, center: lateralCenter} of industrialEntrances) {
      const start = outerRoad + outerRoadWidth / 2;
      const length = entranceRoadEnd - start;
      const center = start + length / 2;
      const east = side === 'east';
      box(asphalt, east ? length : width, .018, east ? width : length,
        east ? center : lateralCenter, .001, east ? lateralCenter : center);
      for (const lateral of [-1, 1]) {
        const edge = lateralCenter + lateral * (width / 2 - .65);
        box(white, east ? length - 1 : .17, .01, east ? .17 : length - 1,
          east ? center : edge, .024, east ? edge : center);
      }
      for (const distance of [119, 126, 133, 140]) {
        box(yellow, east ? 3.9 : .17, .01, east ? .17 : 3.9,
          east ? distance : lateralCenter, .024, east ? lateralCenter : distance);
      }
    }
    }
    const apron = (point, w, d, color) => {
      if (!point) return;
      const [x, z] = point.map(n => n - center);
      box(steel, w, .01, d, x, .04, z);
      for (const side of [-1, 1]) {
        box(color, w, .01, .24, x, .05, z + side * (d / 2 - .12));
        box(color, .24, .01, d, x + side * (w / 2 - .12), .05, z);
        for (let n = -2; n <= 2; n++) {
          box(color, .24, .01, 1.15, x + n * .77, .051, z + side * (d / 2 - .75), true, .58);
        }
      }
    };
    apron(charger, 9, 6, 0x86c6ed);
    apron(worksite, 8.5, 7, yellow);
    m.build();
    if (charger) roofLabel(yard, modern?'备件领取':'SUPPLY', '#2f5874', 7.5, charger[0] - center, .058, charger[1] - center + 1.75);
    if (worksite) roofLabel(yard, modern?'维修作业':'SERVICE', '#87592e', 7.5, worksite[0] - center, .058, worksite[1] - center + 2.1);
  }

  function setDetail(root, enabled) {
    root.traverse(child => {
      if (child.userData.decorative) child.visible = enabled;
    });
  }

  return {ground, yard, building, dispose, updateYard, setDetail};
}
