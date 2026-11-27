import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

const rotorOffset = .44;
const guardRadius = .205;
const guardThickness = .052;
const rotorSpan = 2 * (rotorOffset + 1.06 * (guardRadius + guardThickness));

export function overviewDroneScale(depth, viewportHeight, verticalProjection) {
  if (depth <= 0 || viewportHeight <= 0 || verticalProjection <= 0) return 1;
  const projectedSpan = rotorSpan * viewportHeight * verticalProjection / (2 * depth);
  return THREE.MathUtils.clamp(14 / projectedSpan, 1, 2.85);
}

export function createIndustrialDroneFactory() {
  const shared = geometry => {
    geometry.userData.sharedAgentAsset = true;
    return geometry;
  };
  const body = shared(new RoundedBoxGeometry(1, 1, 1, 2, .1));
  const guard = shared(new THREE.TorusGeometry(guardRadius, guardThickness, 8, 24));
  const cylinder = shared(new THREE.CylinderGeometry(.5, .5, 1, 12));
  const lens = shared(new THREE.SphereGeometry(.5, 12, 8));
  const material = (color, roughness = .65) => new THREE.MeshStandardMaterial({color, roughness});
  const graphite = material(0x19242d);
  const shell = material(0xffad22, .44);
  const ivory = material(0xe4ebee, .46);
  const glass = material(0x395e73, .26);

  return function buildDrone(group) {
    function part(geometry, material, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(rx, ry, 0);
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    part(body, graphite, 0, -.035, 0, .73, .21, .43);
    part(body, shell, 0, .097, 0, .68, .17, .39);
    part(body, ivory, .223, .18, 0, .13, .016, .22);
    part(body, graphite, .277, -.145, 0, .25, .17, .27);
    part(lens, glass, .39, -.145, 0, .087, .111, .111);
    for (const x of [-rotorOffset, rotorOffset]) {
      for (const z of [-rotorOffset, rotorOffset]) {
        const yaw = -Math.atan2(z, x);
        part(body, graphite, x * .52, .024, z * .52, .62, .09, .115, 0, yaw);
        part(guard, graphite, x, .062, z, 1.06, 1.06, 1.12, Math.PI / 2);
        part(guard, x > 0 ? shell : ivory, x, .102, z, 1, 1, .68, Math.PI / 2);
        part(cylinder, graphite, x, .081, z, .115, .095, .115);
        part(body, graphite, x, .13, z, .31, .021, .053, 0, yaw);
      }
    }
    for (const z of [-.14, .14]) part(body, graphite, -.06, -.171, z, .37, .036, .039);
  };
}
