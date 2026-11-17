import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

// Deterministic variation keeps every replay and thumbnail visually stable.
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function crownGeometry() {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const radius = 1 + .055 * Math.sin(x * 8.7 + y * 5.1) + .04 * Math.cos(z * 9.2 - x * 3.7);
    positions.setXYZ(index, x * radius, y * radius, z * radius);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a group of broadleaf trees with tapered trunks, visible branches and
 * overlapping, irregular crown clusters. Each group needs only two draw calls.
 * Locations are [x, z] pairs in the parent's coordinate system.
 */
export function createTreeModel(locations, {scale = 1, seed = 1} = {}) {
  const group = new THREE.Group();
  group.name = 'Broadleaf trees';
  group.userData.treeCount = locations.length;
  const random = randomSource(seed);
  const woodMatrices = [], crownMatrices = [], crownColors = [];
  const dummy = new THREE.Object3D();
  const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3();
  const palette = [new THREE.Color(0x416b4e), new THREE.Color(0x557e57), new THREE.Color(0x709363)];

  for (const [x, z] of locations) {
    const size = scale * (.9 + random() * .18);
    const yaw = random() * Math.PI * 2;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const leanX = (random() - .5) * .22, leanZ = (random() - .5) * .22;
    const point = ([px, py, pz]) => new THREE.Vector3(
      x + (px * cos + pz * sin) * size,
      py * size,
      z + (-px * sin + pz * cos) * size,
    );

    function branch(from, to, thickness) {
      start.copy(point(from));
      end.copy(point(to));
      direction.subVectors(end, start);
      dummy.position.copy(start).add(end).multiplyScalar(.5);
      dummy.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
      dummy.scale.set(thickness * size, direction.length(), thickness * size);
      dummy.updateMatrix();
      woodMatrices.push(dummy.matrix.clone());
    }

    branch([0, 0, 0], [leanX, 3.45, leanZ], .58);
    // Buttress roots keep the trunk from reading as a pole pushed into a box.
    for (let index = 0; index < 3; index++) {
      const angle = index * Math.PI * 2 / 3 + .25;
      branch([0, .28, 0], [Math.cos(angle) * .48, .035, Math.sin(angle) * .48], .25);
    }

    const lowerCrowns = [];
    for (let index = 0; index < 4; index++) {
      const angle = index * Math.PI / 2 + .28 + (random() - .5) * .24;
      const radius = .91 + random() * .17;
      const center = [Math.cos(angle) * radius, 3.48 + random() * .3, Math.sin(angle) * radius];
      lowerCrowns.push(center);
      branch([leanX * .55, 1.7 + index * .15, leanZ * .55], center, .27);
    }

    function crown(center, radii, tone) {
      dummy.position.copy(point(center));
      dummy.rotation.set((random() - .5) * .35, random() * Math.PI * 2, (random() - .5) * .35);
      dummy.scale.set(radii[0] * size, radii[1] * size, radii[2] * size);
      dummy.updateMatrix();
      crownMatrices.push(dummy.matrix.clone());
      crownColors.push(palette[tone].clone().multiplyScalar(.94 + random() * .12));
    }

    // A darker core connects the outer lobes; staggered tiers avoid a single
    // spherical silhouette while keeping the canopy full from every viewpoint.
    crown([leanX, 4.13, leanZ], [1.48, 1.58, 1.43], 0);
    for (const center of lowerCrowns) {
      crown(center, [1.13 + random() * .13, 1.08 + random() * .18, 1.12 + random() * .14], 1);
    }
    for (let index = 0; index < 3; index++) {
      const angle = index * Math.PI * 2 / 3 + yaw * .17;
      crown([Math.cos(angle) * .68 + leanX, 4.78 + random() * .22, Math.sin(angle) * .68 + leanZ],
        [1.04, 1.14 + random() * .12, 1.04], 1);
    }
    crown([leanX * 1.2, 5.42, leanZ * 1.2], [.91, 1.01, .9], 2);
  }

  const wood = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(.36, .6, 1, 7),
    new THREE.MeshStandardMaterial({color: 0x685441, roughness: 1}),
    woodMatrices.length,
  );
  wood.name = 'Tree trunks, roots and branches';
  woodMatrices.forEach((matrix, index) => wood.setMatrixAt(index, matrix));
  wood.instanceMatrix.needsUpdate = true;
  wood.castShadow = wood.receiveShadow = true;
  wood.computeBoundingSphere();
  group.add(wood);

  const crowns = new THREE.InstancedMesh(
    crownGeometry(),
    new THREE.MeshStandardMaterial({color: 0xffffff, roughness: .96}),
    crownMatrices.length,
  );
  crowns.name = 'Layered tree crown clusters';
  crownMatrices.forEach((matrix, index) => {
    crowns.setMatrixAt(index, matrix);
    crowns.setColorAt(index, crownColors[index]);
  });
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  crowns.castShadow = crowns.receiveShadow = true;
  crowns.computeBoundingSphere();
  group.add(crowns);
  return group;
}
