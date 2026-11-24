'use strict';

const Device = require('./device-capabilities');
const Elevation = require('./elevation');
const Sensors = require('./sensors');
const Flight = require('./flight');
const Survey = require('./rover-survey');
const Operations = require('./task-operations');

const active = action => action.status === 'pending' || action.status === 'accepted';

function pose(world, agent, previous) {
  const point = {x: agent.x, y: agent.y};
  if (Sensors.isAir(agent)) {
    point.z = Sensors.position(agent, world.heightfield).z;
    point.heightAboveGroundM = point.z - Elevation.height(world.heightfield, agent.x, agent.y);
  } else if (world.heightfield && Device.mobility(agent) === 'ground') {
    point.z = Elevation.height(world.heightfield, agent.x, agent.y);
    point.slopeDeg = Elevation.surface(world.heightfield, agent.x, agent.y).slopeDegrees;
  }
  const prior = previous?.agents.find(a => a.id === agent.id);
  const elapsed = prior ? world.tick - previous.tick : 0;
  if (elapsed > 0) {
    const dx = agent.x - prior.x;
    const dy = agent.y - prior.y;
    const distance = Math.hypot(dx, dy);
    point.speedMPerTick = Math.max(0, agent.distance - prior.distance) / elapsed;
    if (point.z !== undefined && Sensors.isAir(agent)) {
      point.verticalSpeedMPerTick = (point.z - Sensors.position(prior, previous.heightfield).z) / elapsed;
    }
    if (distance > 1e-6) point.courseDeg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  }
  return point;
}

function waterConditions(world, agent) {
  const contains = area => agent.x >= area.x && agent.x <= area.x + area.w &&
    agent.y >= area.y && agent.y <= area.y + area.h;
  const region = world.surfaceDomain?.water.find(contains);
  const zones = (world.terrain ?? []).filter(contains).map(zone => {
    const effect = world.terrainEffects?.find(item => item.zoneId === zone.id);
    return {id: zone.id, name: zone.name, speedFactor: zone.speedFactor * (effect?.speedFactor ?? 1),
      energyFactor: zone.energyFactor * (effect?.energyFactor ?? 1), effectUntilTick: effect?.untilTick ?? null};
  });
  return {source: 'simulation', region: region ? {id: region.id, name: region.name} : null, zones};
}

function availableActions(world, agent, view, task, {directional, roverSurvey}) {
  const size = world.worldSize ?? 100;
  const assigned = agent.status === 'assigned' && !!task;
  const queued = view.actions.some(active);
  const unavailable = view.sessionError || (world.done ? 'world_finished' : agent.disabled ? 'agent_unavailable' : null);
  const base = unavailable || (queued ? 'action_pending' : null);
  const mobile = agent.status === 'idle' || assigned && world.executionMode === 'primitive';
  const flightState = Sensors.isAir(agent) ? Flight.flightState(world,agent) : null;
  const move = base || (!mobile ? 'agent_unavailable' : agent.battery <= 5 ? 'low_battery' : null);
  const airborneMove = move || (flightState && flightState !== 'airborne' ? 'takeoff_required' : null);
  const xy = {minimum: 0, maximum: size};
  const actions = [];
  const add = (name, type, parameters, reason) => actions.push({name, type, parameters, available: !reason, ...(reason ? {reason} : {})});
  add('move_to', 'move', {target: {x: xy, y: xy}}, airborneMove);
  if (directional) add('move_direction', 'move', {direction: {bearingDeg: {minimum: 0, exclusiveMaximum: 360}, distanceM: Device.directionRange(agent)}}, airborneMove);
  if (directional && Sensors.isAir(agent)) {
    const {minimumDeltaM: minimum, ascendM: ascend, descendM: descend, altitudeRange} = Flight.movementLimits(world, agent);
    add('ascend', 'move', {vertical: {deltaM: {minimum, maximum: Math.max(minimum,ascend)}}},
      airborneMove || (ascend < minimum ? 'flight_height_limit' : null));
    add('descend', 'move', {vertical: {deltaM: {minimum: -Math.max(minimum,descend), maximum: -minimum}}},
      airborneMove || (descend < minimum ? 'flight_height_limit' : null));
    add('move_to_3d', 'move', {target: {x: xy, y: xy, z: altitudeRange}}, airborneMove);
    add('takeoff', 'move', {flightControl: {mode: 'takeoff', heightM: Flight.takeoffHeight}},
      move || (flightState === 'airborne' ? 'already_airborne' : null));
    add('land', 'move', {flightControl: {mode: 'land', x: xy, y: xy}},
      base || (!mobile ? 'agent_unavailable' : agent.battery <= 0 ? 'low_battery' : flightState === 'landed' ? 'takeoff_required' : null));
    add('hover', 'move', {flightControl: {mode: 'hover', durationTicks: Flight.hoverDuration}},
      move || (flightState === 'landed' ? 'takeoff_required' : null));
  }
  const stationary = base || (agent.status !== 'idle' ? 'agent_unavailable' : agent.battery <= 5 ? 'low_battery' : null);
  if (agent.capabilities.includes('inspect') || agent.capabilities.includes('confirm')) {
    add('scan', 'scan', {}, stationary);
  }
  if (roverSurvey && Survey.supported(agent)) {
    const minimum = Survey.minimumM, maximum = Survey.maximumM(world, agent);
    add('scan_terrain', 'scan', {survey: {mode: 'terrain_scan', bearingDeg: {minimum: 0, exclusiveMaximum: 360},
      radiusM: {minimum, maximum}}}, stationary || (maximum < minimum ? 'survey_range_unavailable' : null));
    const latest = view.actions.filter(action => action.result?.kind === 'terrain_scan').sort((a,b)=>b.updatedTick-a.updatedTick)[0];
    const pointIndices = latest?.result.points.flatMap((p,index)=>p.traversable?[index]:[]) ?? [];
    add('mark_access_point', 'scan', {survey: {mode: 'mark_access_point', scanRequestId: latest?.requestId ?? null, pointIndices}},
      stationary || (!pointIndices.length ? 'survey_point_unavailable' : null));
  }
  const canCharge = agent.status === 'idle' || assigned && world.executionMode !== 'auto';
  add('charge', 'charge', {}, base || (!canCharge ? 'agent_unavailable' : agent.battery >= 80 ? 'battery_sufficient'
    : agent.landed&&!Flight.landedAtStation(world,agent) ? 'takeoff_required' : null));

  if (['agent', 'primitive'].includes(world.executionMode)) {
    const primitive = world.executionMode === 'primitive';
    const type = primitive ? 'work_task' : 'execute_task';
    const reason = !assigned ? 'task_not_assigned' : agent.battery <= 5 ? 'low_battery' : primitive && !task.withinReach ? 'out_of_reach' : null;
    const work = primitive ? task?.workOperation : null;
    if (work) {
      add(work.operation, type, {taskId: {values: [task.id]}, operation: {values: [work.operation]}},
        base || reason || work.reason);
    }
    add(type, type, {taskId: {values: task ? [task.id] : []}}, base || reason ||
      (work?.reason === 'sample_slots_full' ? work.reason : work?.completed ? 'operation_required' : null));
  }
  if (agent.rescue) {
    const contacts = view.memory.filter(contact => contact.kind === 'agent' && contact.status === 'fault' && contact.faultGeneration > 0);
    const targets = contacts.map(({id, observedTick, faultGeneration, x, y}) => ({
      targetAgentId: id, observedTick, faultGeneration, distanceM: Math.hypot(agent.x - x, agent.y - y),
    }));
    const reason = agent.status !== 'idle' ? 'agent_unavailable' : agent.battery <= 5 ? 'low_battery'
      : !targets.length ? 'fault_not_observed' : targets.every(target => target.distanceM > 4) ? 'out_of_reach' : null;
    add('rescue', 'rescue', {targets}, base || reason);
  }
  add('cancel_action', 'cancel', {requestId: {values: view.actions.filter(active).map(a => a.requestId)}},
    unavailable || (queued ? null : 'action_not_cancellable'));
  return actions;
}

function deviceSnapshot(world, previous, view, {directional, revision, roverSurvey, taskOperations}) {
  const agent = world.agents.find(a => a.id === view.self.id);
  const observedTask = view.assignedTasks.find(task => task.status === 'active');
  const ownTask = observedTask && world.tasks.find(task => task.id === observedTask.id && task.assignee === agent.id);
  const task = ownTask ? {
    ...observedTask, capability: ownTask.capability, behavior: ownTask.behavior, phase: ownTask.phase ?? null,
    workTicks: agent.work, requiredWorkTicks: ownTask.duration,
  } : null;
  const pendingAction = view.actions.find(action => action.status === 'accepted') ?? view.actions.find(active);
  const load = world.part.carrierId === agent.id ? {kind: 'spare_part', quantity: 1} : null;
  const samples = view.samples ?? [];
  const sampleStorage = taskOperations && Operations.canSample(agent) ? {
    capacity: Operations.sampleCapacity, used: samples.length, available: Math.max(0, Operations.sampleCapacity - samples.length),
  } : null;
  const components = {
    ...(agent.camera?.enabled ? {camera: agent.camera} : {}),
    ...(agent.deployableRelay ? {relay: true} : {}),
    ...(agent.rescue ? {rescue: agent.rescue} : {}),
    ...(agent.thermal ? {thermalProtection: true} : {}),
  };

  return structuredClone({
    version: 1,
    observedTick: view.tick,
    worldRevision: revision,
    source: 'self',
    coordinateFrame: {x: 'east', y: 'south', z: 'up', distanceUnit: 'm', bearingZero: 'north', bearingDirection: 'clockwise'},
    profile: {
      id: agent.id, name: agent.name, role: agent.role, mobility: Device.mobility(agent),
      maxSpeedMPerTick: agent.speed, sensorRangeM: view.self.sensorRange, communicationRangeM: view.self.communicationRange,
      taskCapabilities: agent.capabilities, components,
      ...(Sensors.isAir(agent) && (directional
        ? {flight: {clearanceAboveGroundM: Flight.clearance, maxVerticalSpeedMPerTick: Flight.verticalSpeed}}
        : {fixedFlightZ: Sensors.position(agent, world.heightfield).z})),
      ...(agent.role === 'vehicle' ? {sparePartSlots: 1} : {}),
    },
    pose: pose(world, agent, previous),
    status: {
      state: agent.status, disabled: agent.disabled, batteryPct: agent.battery,
      ...(Sensors.isAir(agent) ? {flightState: Flight.flightState(world,agent)} : {}),
      charging: pendingAction?.type === 'charge' && pendingAction.phase === 'charging',
      communicationInterrupted: view.self.communicationInterrupted,
      returnEnergyEstimate: view.self.returnEnergyEstimate,
      ...(view.self.thermal ? {thermal: view.self.thermal} : {}),
      ...(view.sessionError ? {sessionError: view.sessionError} : {}),
      task, activeActionId: pendingAction?.requestId ?? null,
    },
    availableActions: availableActions(world, agent, view, task, {directional, roverSurvey}),
    observations: view.memory.map(contact => {
      const {x, y} = contact;
      const dx = x - agent.x;
      const dy = y - agent.y;
      const distanceM = Math.hypot(dx, dy);
      return {...contact, source: contact.source ?? 'device_sensor', distanceM,
        ...(distanceM > 1e-6 ? {bearingDeg: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360} : {})};
    }),
    actions: view.actions,
    ...(agent.role === 'vehicle' || load ? {cargo: {load, reserved: !!task && world.part.reservedBy === task.id,
      ...(task?.workOperation?.completed === 'unload' ? {awaitingHandoff: true} : {})}} : {}),
    ...(agent.capabilities.includes('sample') ? {samples} : {}),
    ...(sampleStorage ? {sampleStorage} : {}),
    ...(view.self.materialReservations ? {materialReservations: view.self.materialReservations} : {}),
    ...(Device.mobility(agent) === 'water' ? {waterConditions: waterConditions(world, agent)} : {}),
    ...(agent.deployableRelay ? {relay: view.self.relayState, receivedMessages: view.inbox} : {}),
  });
}

function fixedSensorSnapshots(world) {
  return (world.fixedSensors ?? []).map(sensor => {
    const reading = world.fixedSensorState?.reports[sensor.id] ?? null;
    return {
      id: sensor.id, name: sensor.name, source: 'fixed_sensor_report', observedTick: reading?.observedTick ?? null,
      pose: {x: sensor.x, y: sensor.y, z: sensor.height + Elevation.height(world.heightfield, sensor.x, sensor.y)},
      profile: {rangeM: sensor.range, intervalTicks: sensor.interval, mountHeightM: sensor.height},
      reading: structuredClone(reading),
    };
  });
}

module.exports = {deviceSnapshot, fixedSensorSnapshots};
