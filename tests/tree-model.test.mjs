import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createTreeModel} from '../packages/console/src/tree-model.mjs';

const locations = [[0, 0], [8, 3], [-5, 7]];
const trees = createTreeModel(locations, {seed: 42});
assert.equal(trees.userData.treeCount, locations.length);
assert.equal(trees.children.length, 2, 'wood and foliage are batched separately');
assert(trees.children.every(child => child.isInstancedMesh), 'each tree group uses two draw calls');

const [wood, crowns] = trees.children;
assert.equal(wood.count, locations.length * 8, 'each tree has a trunk, three roots and four branches');
assert.equal(crowns.count, locations.length * 9, 'each crown has a core, two outer tiers and a top cluster');
assert(wood.castShadow && crowns.castShadow && crowns.receiveShadow);
assert(crowns.instanceColor, 'crown clusters carry natural color variation');
const colors = new Set();
for (let index = 0; index < crowns.count; index++) {
  const color = crowns.getColorAt(index, new THREE.Color());
  colors.add(color.getHex());
  assert(Number.isFinite(color.r + color.g + color.b));
}
assert(colors.size > locations.length, 'foliage is not a single flat color');

const matrix = new THREE.Matrix4();
for (const mesh of trees.children) {
  for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, matrix);
    assert(matrix.elements.every(Number.isFinite), `${mesh.name} has finite transforms`);
  }
}
const bounds = new THREE.Box3().setFromObject(trees);
assert(bounds.min.y < .1 && bounds.min.y > -.2, 'roots meet the ground');
assert(bounds.max.y > 6 && bounds.max.y < 8, 'tree proportions remain consistent with the site');

const repeated = createTreeModel(locations, {seed: 42});
for (let part = 0; part < trees.children.length; part++) {
  for (let index = 0; index < trees.children[part].count; index++) {
    trees.children[part].getMatrixAt(index, matrix);
    assert(matrix.equals(new THREE.Matrix4().fromArray(repeated.children[part].instanceMatrix.array, index * 16)),
      'tree variation is deterministic across replays');
  }
}

console.log('Tree models have tapered wood, layered organic crowns, stable variation, and two instanced draw calls');
