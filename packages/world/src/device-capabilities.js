/* Device capability parameters shared by execution and scoped observations. */
(function (root) {
'use strict';

const distances = new Map([
  ['drone', [1, 60]], ['scout', [1, 60]], ['rover', [0.5, 30]],
  ['vehicle', [0.5, 40]], ['robot', [0.2, 15]], ['boat', [1, 50]], ['relay', [0.5, 25]],
]);

function mobility(agent) {
  return agent.mobility ?? (agent.role === 'drone' ? 'air' : 'ground');
}

function directionRange(agent) {
  const [minimum, maximum] = distances.get(agent.role) ??
    (mobility(agent) === 'air' ? [1, 60] : mobility(agent) === 'water' ? [1, 50] : [0.5, 25]);
  return {minimum, maximum};
}

function validDirection(agent, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Number.isFinite(input.bearingDeg) ||
      input.bearingDeg < 0 || input.bearingDeg >= 360 || !Number.isFinite(input.distanceM)) return false;
  const {minimum, maximum} = directionRange(agent);
  return input.distanceM >= minimum && input.distanceM <= maximum;
}

function directionTarget(start, {bearingDeg, distanceM}, fraction = 1) {
  const rad = bearingDeg * Math.PI / 180;
  const delta = distanceM * fraction;
  return [start.x + Math.sin(rad) * delta, start.y - Math.cos(rad) * delta];
}

const api = {mobility, directionRange, validDirection, directionTarget};
if (typeof module !== 'undefined') module.exports = api;
else root.SandboxDeviceCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
