/* Terrain measurements and access points recorded by a ground rover. */
(function (root) {
'use strict';

const Device = typeof module !== 'undefined' ? require('./device-capabilities') : root.SandboxDeviceCapabilities;
const Elevation = typeof module !== 'undefined' ? require('./elevation') : root.SandboxElevation;
const Sensors = typeof module !== 'undefined' ? require('./sensors') : root.SandboxSensors;
const offsets = [0, -15, 15, -30, 30];
const stepM = 2;
const minimumM = 2;
const requestId = /^[A-Za-z0-9_-]{1,64}$/;

const supported = agent => agent.role === 'rover' && Device.mobility(agent) === 'ground' &&
  agent.capabilities.some(capability => ['inspect', 'confirm', 'guide', 'sample'].includes(capability));
const maximumM = (world, agent) => Math.min(30, agent.sensorRange ?? world.sensorRange);

function input(value, world, agent) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) return null;
  const {mode, bearingDeg, radiusM, scanRequestId, pointIndex} = value;
  if (mode === 'terrain_scan' && Number.isFinite(bearingDeg) && bearingDeg >= 0 && bearingDeg < 360 &&
      Number.isFinite(radiusM) && radiusM >= minimumM && radiusM <= maximumM(world, agent)) return {mode, bearingDeg, radiusM};
  if (mode === 'mark_access_point' && typeof scanRequestId === 'string' && requestId.test(scanRequestId) &&
      Number.isInteger(pointIndex) && pointIndex >= 0 && pointIndex < 75) return {mode, scanRequestId, pointIndex};
  return null;
}

function rayPosition(origin, bearingDeg, radiusM) {
  const [x, y] = Device.directionTarget({x: origin[0], y: origin[1]}, {bearingDeg, distanceM: radiusM});
  return [x, y];
}

function scan(world, agent, survey, obstacles, traversable) {
  const origin = [agent.x, agent.y];
  const mounted = Sensors.position(agent, world.heightfield);
  const size = world.worldSize ?? 100;
  const points = [];
  for (const offset of offsets) {
    for (let i = 1; i <= Math.ceil(survey.radiusM / stepM); i++) {
      const [x, y] = rayPosition(origin, survey.bearingDeg + offset, Math.min(i * stepM, survey.radiusM));
      if (x < 0 || y < 0 || x > size || y > size) break;
      const {height, slopeDegrees} = Elevation.surface(world.heightfield, x, y);
      if (!Sensors.visible(mounted, {x, y, z: height + .05}, survey.radiusM + 1e-8, obstacles, world.heightfield)) break;
      const position = [x, y];
      points.push({position, elevationM: height, slopeDeg: slopeDegrees, traversable: traversable(origin, position)});
    }
  }
  return {kind: 'terrain_scan', origin, observedTick: world.tick, points};
}

function markSource(actions, agentId, survey) {
  const scan = actions.find(action => action.agentId === agentId && action.requestId === survey.scanRequestId &&
    action.status === 'completed' && action.result?.kind === 'terrain_scan');
  return {scan, point: scan?.result.points?.[survey.pointIndex]};
}

function mark(world, agent, survey, traversable) {
  const {point} = markSource(world.actions, agent.id, survey);
  if (!point?.traversable) return {reason: 'survey_point_unavailable'};
  if (Math.hypot(point.position[0] - agent.x, point.position[1] - agent.y) > maximumM(world, agent) + 1e-8) {
    return {reason: 'survey_point_out_of_range'};
  }
  if (!traversable([agent.x, agent.y], point.position)) return {reason: 'survey_point_blocked'};
  return {result: {kind: 'access_point', position: point.position.slice(), elevationM: point.elevationM, observedTick: world.tick}};
}

const api = {supported, minimumM, maximumM, input, scan, markSource, mark};
if (typeof module !== 'undefined') module.exports = api;
else root.SandboxRoverSurvey = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
