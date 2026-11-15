'use strict';

// Deterministic, dependency-free simulation camera renderer. The world owns the
// frame and the console only displays it. SVG keeps the server image transport
// portable in Node and small enough for retained snapshots and replay archives.

const DEFAULT_CAMERA = Object.freeze({
  enabled: false,
  mount: [0, 1.5, 0.8],
  yaw: 0,
  pitch: -8,
  fov: 72,
  range: 60,
  updateTicks: 10,
  resolution: [320, 180],
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]));
}

function configFor(agent) {
  const source = agent?.camera;
  if (!source?.enabled) return null;
  const resolution = Array.isArray(source.resolution) && source.resolution.length === 2
    ? source.resolution : DEFAULT_CAMERA.resolution;
  return {
    ...DEFAULT_CAMERA,
    ...source,
    mount: Array.isArray(source.mount) && source.mount.length === 3 ? source.mount : DEFAULT_CAMERA.mount,
    resolution: [clamp(Math.round(resolution[0]), 160, 640), clamp(Math.round(resolution[1]), 90, 360)],
    yaw: Number.isFinite(source.yaw) ? source.yaw : DEFAULT_CAMERA.yaw,
    pitch: Number.isFinite(source.pitch) ? source.pitch : DEFAULT_CAMERA.pitch,
    fov: Number.isFinite(source.fov) ? clamp(source.fov, 30, 120) : DEFAULT_CAMERA.fov,
    range: Number.isFinite(source.range) ? clamp(source.range, 1, 1000) : DEFAULT_CAMERA.range,
    updateTicks: Number.isInteger(source.updateTicks) ? clamp(source.updateTicks, 1, 1000) : DEFAULT_CAMERA.updateTicks,
  };
}

function projection(agent, camera, options = {}) {
  const yaw = Number.isFinite(options.yaw) ? options.yaw : camera.yaw;
  const pitch = Number.isFinite(options.pitch) ? options.pitch : camera.pitch;
  const fov = Number.isFinite(options.fov) ? clamp(options.fov, 30, 120) : camera.fov;
  const air = (agent.mobility ?? (agent.role === 'drone' ? 'air' : 'ground')) === 'air';
  const baseHeight = air ? 16 : 1.5;
  const mount = camera.mount;
  const origin = {x: agent.x + mount[0], y: agent.y + mount[2], z: baseHeight + mount[1]};
  const angle = yaw * Math.PI / 180;
  const forward = {x: Math.cos(angle), y: Math.sin(angle)};
  const right = {x: -forward.y, y: forward.x};
  const focal = 1 / Math.tan(fov * Math.PI / 360);
  return {yaw, pitch, fov, origin, forward, right, focal};
}

function projectPoint(point, pose, width, height) {
  const dx = point.x - pose.origin.x;
  const dy = point.y - pose.origin.y;
  const depth = dx * pose.forward.x + dy * pose.forward.y;
  if (depth <= 0.25) return null;
  const lateral = dx * pose.right.x + dy * pose.right.y;
  const horizontal = lateral / depth * pose.focal;
  if (Math.abs(horizontal) > 1.25) return null;
  const vertical = ((point.z - pose.origin.z) / depth * pose.focal) - Math.tan(pose.pitch * Math.PI / 180);
  return {
    x: width / 2 + horizontal * width / 2,
    y: height / 2 - vertical * height / 2,
    depth,
  };
}

function polygon(points) {
  return points.filter(Boolean).map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function visibleInCamera(point, agent, pose, range) {
  const dx = point.x - agent.x;
  const dy = point.y - agent.y;
  return Math.hypot(dx, dy) <= range && dx * pose.forward.x + dy * pose.forward.y > 0;
}

function renderCameraFrame(world, agent, options = {}) {
  const camera = configFor(agent);
  if (!camera) return null;
  const width = clamp(Math.round(options.width ?? camera.resolution[0]), 160, 640);
  const height = clamp(Math.round(options.height ?? camera.resolution[1]), 90, 360);
  const pose = projection(agent, camera, options);
  const obstacles = Array.isArray(world.obstacles) ? world.obstacles : [];
  const agents = Array.isArray(world.agents) ? world.agents : [];
  const roadblocks = Array.isArray(world.roadblocks) ? world.roadblocks : [];
  const wallMarkup = [];
  for (const obstacle of obstacles) {
    const center = {x: obstacle.x + obstacle.w / 2, y: obstacle.y + obstacle.h / 2};
    if (!visibleInCamera(center, agent, pose, camera.range + Math.max(obstacle.w, obstacle.h))) continue;
    const top = [
      projectPoint({x: obstacle.x, y: obstacle.y, z: obstacle.height}, pose, width, height),
      projectPoint({x: obstacle.x + obstacle.w, y: obstacle.y, z: obstacle.height}, pose, width, height),
      projectPoint({x: obstacle.x + obstacle.w, y: obstacle.y + obstacle.h, z: obstacle.height}, pose, width, height),
      projectPoint({x: obstacle.x, y: obstacle.y + obstacle.h, z: obstacle.height}, pose, width, height),
    ];
    const base = [
      projectPoint({x: obstacle.x, y: obstacle.y, z: 0}, pose, width, height),
      projectPoint({x: obstacle.x + obstacle.w, y: obstacle.y, z: 0}, pose, width, height),
      projectPoint({x: obstacle.x + obstacle.w, y: obstacle.y + obstacle.h, z: 0}, pose, width, height),
      projectPoint({x: obstacle.x, y: obstacle.y + obstacle.h, z: 0}, pose, width, height),
    ];
    const topPoints = polygon(top);
    const basePoints = polygon(base);
    if (topPoints) wallMarkup.push(`<polygon points="${topPoints}" fill="#6f7f8b" fill-opacity=".82" stroke="#c8d4dc" stroke-opacity=".38"/>`);
    if (basePoints) wallMarkup.push(`<polygon points="${basePoints}" fill="#1f2b35" fill-opacity=".28" stroke="#a9bac5" stroke-opacity=".2"/>`);
  }
  for (const block of roadblocks) {
    const center = {x: block.x + block.w / 2, y: block.y + block.h / 2};
    if (!visibleInCamera(center, agent, pose, camera.range)) continue;
    const points = polygon([
      projectPoint({x: block.x, y: block.y, z: block.height ?? 4}, pose, width, height),
      projectPoint({x: block.x + block.w, y: block.y, z: block.height ?? 4}, pose, width, height),
      projectPoint({x: block.x + block.w, y: block.y + block.h, z: block.height ?? 4}, pose, width, height),
      projectPoint({x: block.x, y: block.y + block.h, z: block.height ?? 4}, pose, width, height),
    ]);
    if (points) wallMarkup.push(`<polygon points="${points}" fill="#b56d51" fill-opacity=".9" stroke="#f3b29a" stroke-opacity=".75"/>`);
  }
  const agentMarkup = [];
  for (const other of agents) {
    if (other.id === agent.id || !visibleInCamera(other, agent, pose, camera.range)) continue;
    const heightAt = (other.mobility ?? (other.role === 'drone' ? 'air' : 'ground')) === 'air' ? 16 : 1.5;
    const point = projectPoint({x: other.x, y: other.y, z: heightAt}, pose, width, height);
    if (!point) continue;
    const color = other.disabled ? '#d67875' : other.status === 'working' ? '#88d3be' : '#bbc7e5';
    agentMarkup.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" fill="${color}" stroke="#ffffff" stroke-opacity=".7"/><text x="${(point.x + 6).toFixed(1)}" y="${(point.y - 5).toFixed(1)}" fill="#ecf3f7" font-size="7">${escapeXml(other.id)}</text>`);
  }
  const disabled = agent.disabled;
  const status = disabled ? 'OFFLINE' : `T+${world.tick}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#243a4b"/><stop offset=".58" stop-color="#557b86"/><stop offset=".59" stop-color="#24332f"/><stop offset="1" stop-color="#10191d"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#sky)"/><path d="M0 ${height * .59} H${width}" stroke="#9dc0c4" stroke-opacity=".24"/>
${wallMarkup.join('')}${agentMarkup.join('')}
<path d="M${width / 2 - 9} ${height / 2} h18 M${width / 2} ${height / 2 - 9} v18" stroke="#e5f1ea" stroke-opacity=".68" stroke-width="1"/>
<rect x="5" y="5" width="${width - 10}" height="${height - 10}" rx="3" fill="none" stroke="#d7e7e8" stroke-opacity=".24"/>
<rect x="7" y="${height - 22}" width="${width - 14}" height="15" rx="2" fill="#0b1116" fill-opacity=".68"/>
<text x="12" y="${height - 12}" fill="#d7e8e7" font-size="8" font-family="monospace">SIM CAM · ${escapeXml(agent.id)} · ${status}</text>
<text x="${width - 12}" y="${height - 12}" text-anchor="end" fill="#b9c9d2" font-size="7" font-family="monospace">${pose.yaw.toFixed(0)}° / ${pose.pitch.toFixed(0)}° · F${pose.fov.toFixed(0)}</text>
</svg>`;
  return {
    version: 1,
    agentId: agent.id,
    tick: world.tick,
    width,
    height,
    mimeType: 'image/svg+xml',
    yaw: pose.yaw,
    pitch: pose.pitch,
    fov: pose.fov,
    svg,
  };
}

function cameraConfig(agent) {
  return configFor(agent);
}

module.exports = {DEFAULT_CAMERA, cameraConfig, renderCameraFrame};
