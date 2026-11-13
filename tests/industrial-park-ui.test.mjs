import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as THREE from 'three';
import {createIndustrialPark, industrialCampusLayout, industrialDistricts, industrialEntrances, industrialGroundSize, industrialParkSize, isIndustrialPark} from '../packages/console/src/industrial-park.mjs';

const require = createRequire(import.meta.url);
const world = require('../packages/world/src/world-core.js').create();
globalThis.document = {createElement: () => ({getContext: () => ({fillRect() {}, fillText() {}})})};

const park = createIndustrialPark(new THREE.Scene());
assert.equal(world.sceneId, 'industrial-park-v1');
assert(isIndustrialPark(world.sceneId));
assert(isIndustrialPark('industrial-park-parallel-v1'));
assert(!isIndustrialPark('lunar-outpost-v1'));
assert(!isIndustrialPark('shore-coordination-v1'));

const modernScene = require('../packages/world/src/world-core.js').getScene('industrial-park-v2');
const modernPark = createIndustrialPark(new THREE.Scene(), {modern: true});
const modernBounds = modernScene.obstacles.map(obstacle => {
  const group = modernPark.building(obstacle);
  assert(group, obstacle.id);
  return new THREE.Box3().setFromObject(group);
});
assert.equal(modernScene.worldSize, 224);
for (const gate of industrialCampusLayout.gates) {
  const point = new THREE.Vector3(gate.x - 112, 1, gate.y - 112);
  assert(!modernBounds.some(bounds => bounds.containsPoint(point)), gate.label + ' is open');
  const shoulder = new THREE.Vector3(gate.axis === 'y' ? gate.width / 2 + 1 : 0, 0, gate.axis === 'x' ? gate.width / 2 + 1 : 0);
  for (const side of [-1, 1]) {
    assert(modernBounds.some(bounds => bounds.containsPoint(point.clone().addScaledVector(shoulder, side))), gate.label + ' joins the fence');
  }
  assert(industrialCampusLayout.roads.some(([x,y,w,h]) => gate.axis === 'y'
    ? gate.y > y && gate.y < y + h && gate.x - gate.width / 2 === x && w === gate.width
    : gate.x > x && gate.x < x + w && gate.y - gate.width / 2 === y && h === gate.width
  ), gate.label + ' matches its road');
}
const groundBounds = new THREE.Box3().setFromObject(park.ground);
assert.equal(groundBounds.min.x, -industrialGroundSize / 2);
assert.equal(groundBounds.max.z, industrialGroundSize / 2);
assert(groundBounds.max.y - groundBounds.min.y > 5, 'distant terrain has relief');
const groundVertices = park.ground.geometry.attributes.position;
for (let i = 0; i < groundVertices.count; i++) {
  if (Math.abs(groundVertices.getX(i)) <= industrialParkSize / 2 && Math.abs(groundVertices.getZ(i)) <= industrialParkSize / 2) {
    assert(Math.abs(groundVertices.getY(i) + .11) < .0001, 'yard and ring road sit on flat terrain');
  }
}
const districtBuildings = industrialDistricts.flatMap(district => district.buildings);
assert.equal(districtBuildings.length, 14);
for (const [i, [x, z, w, d]] of districtBuildings.entries()) {
  assert(Math.abs(x) - w / 2 >= 50 || Math.abs(z) - d / 2 >= 50, 'outer buildings stay out of the simulation');
  assert(Math.abs(x) + w / 2 < industrialParkSize / 2 && Math.abs(z) + d / 2 < industrialParkSize / 2);
  for (const [otherX, otherZ, otherW, otherD] of districtBuildings.slice(i + 1)) {
    assert(Math.abs(x - otherX) >= (w + otherW) / 2 || Math.abs(z - otherZ) >= (d + otherD) / 2,
      'outer building footprints do not overlap');
  }
}
const siteModels = park.yard.children[0];
const districtModels = siteModels.getObjectByName('Industrial districts');
const perimeter = siteModels.getObjectByName('Industrial entrances and fence');
const publicSpaces = siteModels.getObjectByName('Industrial public spaces');
assert(publicSpaces.children.length > 0);
assert(districtModels.children.length > 0);
const districtGeometry = new THREE.Box3().setFromObject(districtModels);
assert(districtGeometry.min.x < -90 && districtGeometry.max.x > 90);
assert(districtGeometry.min.z < -90 && districtGeometry.max.z > 90);
const entrances = perimeter.children.filter(child => child.userData.industrialLabel);
assert.equal(entrances.filter(child => child.userData.industrialLabel === '工业园区').length, 2);
assert.equal(entrances.filter(child => child.userData.industrialLabel === '货运入口').length, 2);
const southGateSign = entrances.find(child => child.userData.industrialLabel === '工业园区' && child.rotation.x < 0);
const wallLine = southGateSign.position.z;
perimeter.updateWorldMatrix(true, true);
const ray = new THREE.Raycaster();
function perimeterAt(x, z) {
  ray.set(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0));
  return ray.intersectObject(perimeter, true).length > 0;
}
assert(!perimeterAt(0, wallLine), 'south driveway is clear below the portal');
const eastGate = industrialEntrances.find(entrance => entrance.side === 'east');
assert(!perimeterAt(wallLine, eastGate.center), 'east driveway is clear below the portal');
assert(perimeterAt(36, wallLine) && perimeterAt(wallLine, 0), 'fence continues beside both driveways');
assert(perimeterAt(0, -wallLine) && perimeterAt(-wallLine, 0), 'other fence lines are closed');

const colors = new Set();
for (const obstacle of world.obstacles) {
  const group = park.building(obstacle);
  const bounds = new THREE.Box3().setFromObject(group);
  const {x, y, w, h, height} = obstacle;
  assert(bounds.min.distanceTo(new THREE.Vector3(x - 50, 0, y - 50)) < .001, obstacle.id);
  assert(bounds.max.distanceTo(new THREE.Vector3(x + w - 50, height, y + h - 50)) < .001, obstacle.id);
  colors.add(group.children[0].material.color.getHex());
  assert(group.children.some(child => child.userData.industrialLabel));
  const details = group.children.filter(child => child.userData.decorative);
  assert(details.length > 0);
  park.setDetail(group, false);
  assert(details.every(child => !child.visible));
  park.setDetail(group, true);
  assert(details.every(child => child.visible));
  park.dispose(group);
  assert.equal(group.children.length, 0);
}
assert.equal(colors.size, world.obstacles.length);
assert.equal(park.building({...world.obstacles[0], id: 'custom-obstacle'}), null);

park.updateYard(world.chargingStation, world.part.site);
const yardSize = new THREE.Box3().setFromObject(park.yard).getSize(new THREE.Vector3());
assert(yardSize.x > industrialParkSize && yardSize.z > industrialParkSize);
for (const [name, point] of [['SUPPLY', world.chargingStation], ['SERVICE', world.part.site]]) {
  const label = park.yard.children.find(child => child.userData.industrialLabel === name);
  assert.equal(label.position.x, point[0] - 50);
  assert(Math.abs(label.position.z - (point[1] - 50)) < 3);
}
const children = [...park.yard.children];
park.updateYard(world.chargingStation, world.part.site);
assert.deepEqual(park.yard.children, children);
park.updateYard([20, 50], [80, 38]);
assert.equal(siteModels.parent, park.yard);
assert(children.filter(child => child !== siteModels).every(child => child.parent === null));

console.log('Industrial park models match obstacle bounds, use distinct styles, and follow snapshot worksite positions');
