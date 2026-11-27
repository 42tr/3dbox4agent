import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

const rotorOffset = .44;
const guardRadius = .205;
const guardThickness = .052;
const rotorSpan = 2 * (rotorOffset + 1.06 * (guardRadius + guardThickness));
const displaySizes = {
  drone: {span: rotorSpan, targetPixels: 14, maxScale: 2.85},
  truck: {span: 2.94, targetPixels: 16, maxScale: 1.62},
  repair: {span: 1.86, targetPixels: 14, maxScale: 2.02},
};
const truckDeckHeight = .72;
export const truckCargo = {x: -.64, height: truckDeckHeight, size: [1.12, .64, 1.02]};

export function industrialDeviceScale(kind, depth, viewportHeight, verticalProjection) {
  if (depth <= 0 || viewportHeight <= 0 || verticalProjection <= 0) return 1;
  const {span, targetPixels, maxScale} = displaySizes[kind];
  const projectedSpan = span * viewportHeight * verticalProjection / (2 * depth);
  return THREE.MathUtils.clamp(targetPixels / projectedSpan, 1, maxScale);
}

export function createIndustrialDeviceModels() {
  const shared = geometry => {
    geometry.userData.sharedAgentAsset = true;
    return geometry;
  };
  const body = shared(new RoundedBoxGeometry(1, 1, 1, 2, .1));
  const guard = shared(new THREE.TorusGeometry(guardRadius, guardThickness, 8, 24));
  const cylinder = shared(new THREE.CylinderGeometry(.5, .5, 1, 12));
  const lens = shared(new THREE.SphereGeometry(.5, 12, 8));
  const shadowPlane = shared(new THREE.PlaneGeometry(1, 1));
  const material = (color, roughness = .65) => new THREE.MeshStandardMaterial({color, roughness});
  const graphite = material(0x19242d);
  const shell = material(0xffad22, .44);
  const ivory = material(0xe4ebee, .46);
  const glass = material(0x395e73, .26);
  const blue = material(0x2689ef, .5);
  const orange = material(0xf15b32, .5);
  const steel = material(0x778b9a);
  const sensor = material(0x71ecf6, .34);
  const rubber = material(0x202629, .91);

  // A soft contact shadow follows the display scale without changing the sun's shadow map.
  const resolution = 32;
  const pixels = new Uint8Array(resolution * resolution * 4);
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const distance = Math.hypot((2 * x + 1) / resolution - 1, (2 * y + 1) / resolution - 1);
      pixels[(y * resolution + x) * 4 + 3] = Math.round(150 * (1 - THREE.MathUtils.smoothstep(distance, .32, 1)));
    }
  }
  const shadowMap = new THREE.DataTexture(pixels, resolution, resolution);
  shadowMap.magFilter = shadowMap.minFilter = THREE.LinearFilter;
  shadowMap.needsUpdate = true;
  const contactShadow = new THREE.MeshBasicMaterial({map: shadowMap, transparent: true, depthWrite: false});

  function addParts(group) {
    return function part(geometry, material, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.set(rx, ry, rz);
      mesh.receiveShadow = true;
      group.add(mesh);
    };
  }

  function drone(group) {
    const part = addParts(group);
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
  }

  function truck(group) {
    const part = addParts(group);
    part(shadowPlane, contactShadow, .09, .044, .08, 3.62, 2.25, 1, -Math.PI / 2);
    part(body, graphite, 0, .39, 0, 2.86, .3, 1.38);
    part(body, blue, .03, .57, 0, 2.74, .33, 1.44);
    part(body, ivory, .76, 1.025, 0, 1.1, .85, 1.38);
    part(body, glass, 1.31, 1.14, 0, .068, .41, 1.18, 0, 0, .16);
    part(body, blue, .74, 1.46, 0, 1.16, .12, 1.42);
    part(body, steel, -.64, truckDeckHeight - .05, 0, 1.48, .1, 1.34);
    part(body, blue, -1.36, .86, 0, .13, .32, 1.43);
    part(body, graphite, 1.37, .52, 0, .2, .2, 1.45);
    part(body, graphite, 1.334, .736, 0, .05, .13, .63);
    for (const side of [-1, 1]) {
      part(body, glass, .72, 1.135, side * .693, .77, .34, .042);
      part(body, graphite, -.61, .855, side * .682, 1.42, .28, .078);
      part(body, ivory, -.61, .9, side * .722, .95, .072, .024);
      part(body, ivory, 1.356, .755, side * .49, .087, .156, .23);
      part(body, orange, -1.431, .67, side * .52, .056, .12, .18);
      for (const x of [-.92, .95]) {
        part(cylinder, rubber, x, .335, side * .714, .67, .265, .67, Math.PI / 2);
        part(cylinder, steel, x, .335, side * .847, .33, .03, .33, Math.PI / 2);
      }
    }
  }

  function repair(group) {
    const part = addParts(group);
    part(shadowPlane, contactShadow, .12, .044, .08, 2.35, 2.24, 1, -Math.PI / 2);
    for (const side of [-1, 1]) {
      part(body, rubber, 0, .231, side * .588, 1.45, .462, .39);
      part(body, steel, 0, .285, side * .793, 1.02, .205, .045);
      for (const x of [-.44, 0, .44]) {
        part(cylinder, graphite, x, .232, side * .795, .29, .065, .29, Math.PI / 2);
      }
    }
    part(body, graphite, -.08, .405, 0, 1.47, .17, 1.23);
    part(body, orange, -.15, .705, 0, 1.21, .51, 1.13);
    part(body, ivory, -.43, .97, 0, .61, .11, .94);
    part(body, graphite, -.346, 1.18, 0, .29, .46, .34);
    part(body, orange, -.31, 1.525, 0, .57, .27, .77);
    part(body, glass, -.018, 1.52, 0, .055, .19, .63);
    part(body, sensor, .011, 1.535, 0, .018, .067, .46);
    part(cylinder, graphite, .21, .99, .08, .48, .25, .48);
    part(body, steel, .24, 1.19, .08, .24, .48, .27);
    part(cylinder, graphite, .29, 1.403, .08, .31, .37, .31, Math.PI / 2);
    part(body, orange, .553, 1.278, .08, .63, .187, .27, 0, 0, -.47);
    part(body, graphite, .827, 1.132, .08, .222, .204, .319);
    for (const z of [-.058, .218]) part(body, ivory, .962, 1.066, z, .236, .133, .073, 0, 0, -.26);
  }

  return {drone, truck, repair};
}
