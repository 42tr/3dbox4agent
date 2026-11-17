'use strict';

// Domain catalogue and command surface for the modern industrial-park scene.
// This layer deliberately stays separate from the deterministic physics world:
// it gives clients a stable object/task API without changing replay snapshots.

const DEFAULT_SCENE_ID = 'industrial-park-v2';

const OBJECT_TYPES = Object.freeze({
  SCENE: 'scene',
  ZONE: 'zone',
  BUILDING: 'building',
  WAREHOUSE: 'warehouse',
  PRODUCTION_LINE: 'production_line',
  WORKSTATION: 'workstation',
  EQUIPMENT: 'equipment',
  DEVICE: 'device',
  VEHICLE: 'vehicle',
  AGV: 'agv',
  MATERIAL: 'material',
  RESOURCE: 'resource',
  UTILITY: 'utility',
  SENSOR: 'sensor',
  CAMERA: 'camera',
  ALARM: 'alarm',
  PERSON: 'person',
  ORGANIZATION: 'organization',
  RULE: 'rule',
  BARRIER: 'barrier',
  DOCK: 'dock',
  TASK: 'task',
  ORDER: 'order',
  BATCH: 'batch',
  EVENT: 'event',
});

const TASK_TYPES = Object.freeze({
  SCENE_SETUP: 'scene_setup',
  INSPECTION: 'inspection',
  CONFIRMATION: 'confirmation',
  MATERIAL_RECEIVING: 'material_receiving',
  PRODUCTION: 'production',
  LOGISTICS: 'logistics',
  MAINTENANCE: 'maintenance',
  QUALITY: 'quality',
  PERSONNEL_ACCESS: 'personnel_access',
  ENERGY_OPTIMIZATION: 'energy_optimization',
  EMERGENCY_RESPONSE: 'emergency_response',
});

const OPERATION_CATALOG = Object.freeze({
  scene: ['getState', 'getCapabilities', 'queryObjects', 'startSimulation', 'pauseSimulation', 'advanceTime', 'snapshot', 'restoreSnapshot'],
  zone: ['getState', 'getOccupancy', 'setAccessPolicy', 'reserve', 'release', 'lockdown', 'unlockdown'],
  building: ['getState', 'open', 'close', 'setHVAC', 'getOccupancy', 'runInspection'],
  warehouse: ['getState', 'getInventory', 'reserve', 'release', 'putAway', 'pick', 'move', 'cycleCount'],
  production_line: ['getState', 'start', 'pause', 'resume', 'stop', 'setRecipe', 'schedule', 'getProgress', 'getOEE'],
  workstation: ['getState', 'start', 'pause', 'stop', 'setMode', 'inspect'],
  equipment: ['getState', 'powerOn', 'powerOff', 'start', 'pause', 'resume', 'stop', 'setMode', 'execute', 'diagnose', 'reportFault', 'resetAlarm', 'createMaintenanceOrder'],
  device: ['getState', 'getTelemetry', 'getPosition', 'move', 'inspect', 'confirm', 'dispatch', 'start', 'pause', 'resume', 'stop', 'charge', 'emergencyStop', 'diagnose', 'repair', 'test'],
  vehicle: ['getState', 'getPosition', 'checkIn', 'checkOut', 'weigh', 'load', 'unload', 'dispatch', 'stop', 'emergencyStop'],
  agv: ['getState', 'getPosition', 'dispatch', 'pause', 'resume', 'cancel', 'charge', 'dock', 'emergencyStop'],
  material: ['getState', 'reserve', 'release', 'move', 'consume', 'split', 'merge', 'trace', 'quarantine'],
  resource: ['getState', 'reserve', 'release', 'getAvailability'],
  utility: ['getState', 'read', 'switchSupply', 'setLoad', 'isolate', 'getConsumption'],
  sensor: ['getState', 'read', 'calibrate', 'setSampling', 'subscribeThreshold'],
  camera: ['getState', 'read', 'setView', 'capture'],
  alarm: ['getState', 'raise', 'acknowledge', 'escalate', 'suppress', 'close'],
  person: ['getState', 'authenticate', 'enter', 'exit', 'acceptTask', 'startWork', 'finishWork', 'reportIncident', 'getLocation'],
  organization: ['getState', 'listMembers', 'assignTask'],
  rule: ['getState', 'activate', 'deactivate', 'evaluate'],
  barrier: ['getState', 'open', 'close', 'lockdown', 'unlockdown'],
  dock: ['getState', 'reserve', 'release', 'open', 'close', 'assignVehicle'],
  task: ['getState', 'assign', 'reserveResources', 'start', 'pause', 'resume', 'cancel', 'retry', 'complete', 'fail'],
  order: ['getState', 'release', 'hold', 'cancel', 'complete'],
  batch: ['getState', 'split', 'merge', 'quarantine', 'release'],
});

const TASK_TEMPLATES = Object.freeze({
  [TASK_TYPES.SCENE_SETUP]: {name: '场景初始化', requiredCapability: 'configure', steps: ['load', 'validate', 'activate']},
  [TASK_TYPES.INSPECTION]: {name: '设备巡检', requiredCapability: 'inspect', steps: ['inspect', 'record']},
  [TASK_TYPES.CONFIRMATION]: {name: '异常确认', requiredCapability: 'confirm', steps: ['observe', 'confirm', 'record']},
  [TASK_TYPES.MATERIAL_RECEIVING]: {name: '物料接收入库', requiredCapability: 'receive', steps: ['checkIn', 'unload', 'inspect', 'putAway']},
  [TASK_TYPES.PRODUCTION]: {name: '生产执行', requiredCapability: 'produce', steps: ['reserveMaterial', 'start', 'monitor', 'complete']},
  [TASK_TYPES.LOGISTICS]: {name: '园区物流配送', requiredCapability: 'deliver', steps: ['reserve', 'dispatch', 'load', 'unload', 'confirm']},
  [TASK_TYPES.MAINTENANCE]: {name: '设备维修', requiredCapability: 'repair', steps: ['diagnose', 'repair', 'test', 'release']},
  [TASK_TYPES.QUALITY]: {name: '质量检验', requiredCapability: 'inspect', steps: ['sample', 'inspect', 'approve']},
  [TASK_TYPES.PERSONNEL_ACCESS]: {name: '人员入场', requiredCapability: 'authorize', steps: ['authenticate', 'authorize', 'enter']},
  [TASK_TYPES.ENERGY_OPTIMIZATION]: {name: '能源优化', requiredCapability: 'optimize_energy', steps: ['read', 'plan', 'apply', 'verify']},
  [TASK_TYPES.EMERGENCY_RESPONSE]: {name: '应急处置', requiredCapability: 'emergency', steps: ['raiseAlarm', 'isolate', 'dispatch', 'evacuate', 'close']},
});

const BUILDING_SUBTYPES = Object.freeze({
  warehouse: 'warehouse',
  'warehouse-annex': 'warehouse',
  workshop: 'production',
  assembly: 'production',
  equipment: 'production',
  power: 'utility',
  control: 'control',
  office: 'office',
  'south-booth': 'gatehouse',
  'east-booth': 'gatehouse',
});

const ZONES = Object.freeze([
  {id: 'zone-logistics', name: '物流仓储区', subtype: 'logistics', bounds: {x: 20, y: 45, w: 75, h: 105}},
  {id: 'zone-production', name: '生产制造区', subtype: 'production', bounds: {x: 120, y: 45, w: 90, h: 110}},
  {id: 'zone-utilities', name: '动力能源区', subtype: 'utilities', bounds: {x: 85, y: 155, w: 65, h: 55}},
  {id: 'zone-admin', name: '办公管理区', subtype: 'administration', bounds: {x: 20, y: 155, w: 65, h: 55}},
]);

const DEVICE_ZONE = Object.freeze({drone: 'zone-production', vehicle: 'zone-logistics', robot: 'zone-production'});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(message);
}

function operationList(type) {
  return OPERATION_CATALOG[type] ? OPERATION_CATALOG[type].slice() : ['getState'];
}

function addObject(objects, spec) {
  if (objects.some(object => object.id === spec.id)) throw Error('duplicate industrial-park object: ' + spec.id);
  objects.push({
    id: spec.id,
    type: spec.type,
    subtype: spec.subtype,
    name: spec.name,
    parentId: spec.parentId ?? 'park-1',
    zoneId: spec.zoneId,
    location: spec.location ? clone(spec.location) : undefined,
    state: spec.state ?? 'idle',
    capabilities: Array.from(new Set(spec.capabilities ?? [])),
    operations: operationList(spec.type),
    permissions: Array.from(new Set(spec.permissions ?? ['operator', 'maintainer', 'admin'])),
    properties: clone(spec.properties ?? {}),
  });
}

function zoneForObstacle(id) {
  if (['warehouse', 'warehouse-annex', 'south-booth'].includes(id)) return 'zone-logistics';
  if (['workshop', 'assembly', 'equipment', 'east-booth'].includes(id)) return 'zone-production';
  if (id === 'power') return 'zone-utilities';
  if (id === 'control' || id === 'office') return 'zone-admin';
  return undefined;
}

function createObjects(scene) {
  assertObject(scene, 'industrial-park scene must be an object');
  if (scene.id !== DEFAULT_SCENE_ID) throw Error('industrial-park domain requires scene ' + DEFAULT_SCENE_ID);
  const objects = [];
  addObject(objects, {
    id: 'park-1', type: OBJECT_TYPES.SCENE, name: scene.name || '现代工业园区',
    state: 'ready', properties: {worldSize: scene.worldSize, sensorRange: scene.sensorRange},
  });
  for (const zone of ZONES) addObject(objects, {
    ...zone, type: OBJECT_TYPES.ZONE, parentId: 'park-1', location: zone.bounds,
    state: 'open', capabilities: ['access_control'],
  });

  for (const obstacle of scene.obstacles ?? []) {
    const isBarrier = /^(wall|median)-/.test(obstacle.id);
    const type = isBarrier ? OBJECT_TYPES.BARRIER : (BUILDING_SUBTYPES[obstacle.id] === 'warehouse' ? OBJECT_TYPES.WAREHOUSE : OBJECT_TYPES.BUILDING);
    addObject(objects, {
      id: obstacle.id,
      type,
      subtype: isBarrier ? (obstacle.id.startsWith('wall-') ? 'fence' : 'median') : (BUILDING_SUBTYPES[obstacle.id] || 'facility'),
      name: obstacle.id,
      zoneId: zoneForObstacle(obstacle.id),
      location: {x: obstacle.x, y: obstacle.y, w: obstacle.w, h: obstacle.h, height: obstacle.height},
      state: isBarrier ? 'closed' : 'open',
      properties: {obstacleId: obstacle.id, height: obstacle.height ?? 0},
    });
  }

  addObject(objects, {id: 'dock-west', type: OBJECT_TYPES.DOCK, subtype: 'receiving', name: '西侧收货月台', zoneId: 'zone-logistics', location: {x: 62, y: 101}, state: 'open'});
  addObject(objects, {id: 'dock-east', type: OBJECT_TYPES.DOCK, subtype: 'maintenance', name: '东侧维修月台', zoneId: 'zone-production', location: {x: 164, y: 120}, state: 'open'});
  addObject(objects, {id: 'line-assembly-1', type: OBJECT_TYPES.PRODUCTION_LINE, subtype: 'assembly', name: '总装生产线 1', zoneId: 'zone-production', location: {x: 164, y: 77}, capabilities: ['produce'], state: 'idle'});
  addObject(objects, {id: 'equipment-main', type: OBJECT_TYPES.EQUIPMENT, subtype: 'repair_target', name: '维修场主设备', zoneId: 'zone-production', location: {x: 164, y: 120}, capabilities: ['diagnose', 'repair'], state: 'fault', properties: {diagnosis: 'unknown'}});
  addObject(objects, {id: 'stock-maintenance-parts', type: OBJECT_TYPES.MATERIAL, subtype: 'spare_parts', name: '维修备件库存', zoneId: 'zone-logistics', location: {x: 62, y: 101}, capabilities: ['reserve', 'move', 'consume'], properties: {quantity: 100, unit: 'kit'}});
  addObject(objects, {id: 'power-grid-main', type: OBJECT_TYPES.UTILITY, subtype: 'power_grid', name: '园区主电网', zoneId: 'zone-utilities', capabilities: ['optimize_energy'], state: 'online'});
  addObject(objects, {id: 'resource-warehouse-capacity', type: OBJECT_TYPES.RESOURCE, subtype: 'warehouse_capacity', name: '仓储容量资源', zoneId: 'zone-logistics', capabilities: ['reserve'], state: 'available', properties: {capacity: 1000, used: 0, unit: 'pallet'}});
  addObject(objects, {id: 'workstation-maintenance-01', type: OBJECT_TYPES.WORKSTATION, subtype: 'maintenance', name: '维修工位 01', zoneId: 'zone-production', location: {x: 164, y: 120}, capabilities: ['repair'], state: 'idle'});
  addObject(objects, {id: 'agv-1', type: OBJECT_TYPES.AGV, subtype: 'warehouse_transport', name: '仓储 AMR 1', zoneId: 'zone-logistics', location: {x: 62, y: 101}, capabilities: ['deliver'], state: 'idle', properties: {battery: 92}});
  addObject(objects, {id: 'camera-gate-east', type: OBJECT_TYPES.CAMERA, subtype: 'access_control', name: '东侧货运门摄像机', zoneId: 'zone-logistics', location: {x: 215, y: 120}, state: 'online'});
  addObject(objects, {id: 'sensor-equipment-health', type: OBJECT_TYPES.SENSOR, subtype: 'equipment_health', name: '设备健康传感器', parentId: 'equipment-main', zoneId: 'zone-production', capabilities: ['read'], state: 'online', properties: {metrics: ['temperature', 'vibration', 'load']}});
  addObject(objects, {id: 'alarm-safety-main', type: OBJECT_TYPES.ALARM, subtype: 'safety', name: '园区安全告警', zoneId: 'zone-production', capabilities: ['emergency'], state: 'clear'});
  addObject(objects, {id: 'person-supervisor-1', type: OBJECT_TYPES.PERSON, subtype: 'supervisor', name: '生产主管 1', zoneId: 'zone-admin', capabilities: ['authorize', 'configure'], state: 'onsite'});
  addObject(objects, {id: 'team-maintenance', type: OBJECT_TYPES.ORGANIZATION, subtype: 'maintenance_team', name: '设备维修班组', zoneId: 'zone-production', capabilities: ['repair'], state: 'available'});
  addObject(objects, {id: 'order-production-001', type: OBJECT_TYPES.ORDER, subtype: 'production', name: '生产订单 001', zoneId: 'zone-production', capabilities: ['produce'], state: 'released', properties: {quantity: 100, product: 'industrial-module'}});
  addObject(objects, {id: 'batch-maintenance-parts-001', type: OBJECT_TYPES.BATCH, subtype: 'spare_parts', name: '维修备件批次 001', parentId: 'stock-maintenance-parts', zoneId: 'zone-logistics', state: 'available', properties: {quantity: 100, unit: 'kit'}});
  addObject(objects, {id: 'rule-access-default', type: OBJECT_TYPES.RULE, subtype: 'access_control', name: '默认区域门禁规则', zoneId: 'zone-admin', state: 'active', properties: {allowedRoles: ['operator', 'maintainer', 'admin']}});

  for (const spec of scene.agents ?? []) {
    for (let index = 1; index <= spec.count; index++) {
      const id = `${spec.role}-${index}`;
      addObject(objects, {
        id,
        type: spec.role === 'vehicle' ? OBJECT_TYPES.VEHICLE : OBJECT_TYPES.DEVICE,
        subtype: spec.role,
        name: `${spec.label || spec.role} ${index}`,
        zoneId: DEVICE_ZONE[spec.role],
        location: spec.spawnArea ? {x: spec.spawnArea.x, y: spec.spawnArea.y, w: spec.spawnArea.w, h: spec.spawnArea.h} : undefined,
        state: 'idle',
        capabilities: spec.capabilities,
        properties: {speed: spec.speed, mobility: spec.mobility ?? (spec.role === 'drone' ? 'air' : 'ground')},
      });
    }
  }
  return objects;
}

function sceneTaskType(task) {
  return ({detect: TASK_TYPES.INSPECTION, confirm: TASK_TYPES.CONFIRMATION, deliver: TASK_TYPES.LOGISTICS, repair: TASK_TYPES.MAINTENANCE, verify: TASK_TYPES.QUALITY})[task.behavior] || TASK_TYPES.INSPECTION;
}

function taskTemplatesForScene(scene) {
  return (scene.tasks ?? []).map(task => ({
    id: task.id,
    type: sceneTaskType(task),
    name: task.name,
    requiredCapability: task.capability,
    role: task.role,
    target: clone(task.target),
    duration: task.duration,
    dependsOn: clone(task.dependsOn ?? []),
  }));
}

function createCatalog(scene) {
  const objects = createObjects(scene);
  return {
    version: 1,
    sceneId: scene.id,
    sceneName: scene.name,
    objectTypes: clone(OBJECT_TYPES),
    taskTypes: clone(TASK_TYPES),
    operationCatalog: clone(OPERATION_CATALOG),
    objects,
    taskTemplates: {
      generic: Object.entries(TASK_TEMPLATES).map(([type, template]) => ({type, ...clone(template)})),
      scene: taskTemplatesForScene(scene),
    },
  };
}

class IndustrialParkDomain {
  constructor(scene, {clock = () => Date.now()} = {}) {
    assertObject(scene, 'industrial-park scene must be an object');
    this.scene = clone(scene);
    this.clock = clock;
    this.objects = new Map(createObjects(this.scene).map(object => [object.id, object]));
    this.tasks = new Map();
    this.history = [];
    this.events = [];
    this.subscribers = new Set();
    this.commands = new Map();
    this.sequence = 0;
  }

  catalog() { return createCatalog(this.scene); }

  listObjects(filter = {}) {
    return Array.from(this.objects.values()).filter(object =>
      (filter.type === undefined || object.type === filter.type) &&
      (filter.subtype === undefined || object.subtype === filter.subtype) &&
      (filter.zoneId === undefined || object.zoneId === filter.zoneId) &&
      (filter.state === undefined || object.state === filter.state) &&
      (filter.capability === undefined || object.capabilities.includes(filter.capability)),
    ).map(clone);
  }

  getObject(id) { return clone(this.objects.get(id) ?? null); }

  getObjectHandle(id) {
    if (!this.objects.has(id)) return null;
    const handle = {
      ...this.getObject(id),
      getState: () => this.getObject(id)?.state ?? null,
      getCapabilities: () => this.getObject(id)?.operations ?? [],
      invoke: (operation, params, context) => this.execute(id, operation, params, context),
    };
    for (const operation of handle.operations) {
      if (handle[operation] !== undefined) continue;
      handle[operation] = (params, context) => this.execute(id, operation, params, context);
    }
    return handle;
  }

  object(id) { return this.getObjectHandle(id); }

  subscribe(listener) {
    if (typeof listener !== 'function') throw Error('listener must be a function');
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  emit(event) {
    this.events.push(event);
    for (const listener of this.subscribers) listener(clone(event));
  }

  _record(object, operation, params, context, result) {
    const event = {
      id: `park-event-${++this.sequence}`,
      timestamp: this.clock(),
      objectId: object.id,
      objectType: object.type,
      operation,
      actorId: context.actorId ?? null,
      taskId: context.taskId ?? null,
      params: clone(params),
      result: clone(result),
    };
    this.history.push(event);
    this.emit(event);
    return event;
  }

  execute(objectId, operation, params = {}, context = {}) {
    const object = this.objects.get(objectId);
    if (!object) throw Object.assign(Error('object_not_found'), {code: 'object_not_found'});
    if (typeof operation !== 'string' || !object.operations.includes(operation)) throw Object.assign(Error('operation_not_supported'), {code: 'operation_not_supported', objectId, operation});
    assertObject(params, 'operation params must be an object');
    assertObject(context, 'operation context must be an object');
    const requestId = context.requestId ?? params.requestId;
    const signature = JSON.stringify({objectId, operation, params, actorId: context.actorId ?? null, taskId: context.taskId ?? null});
    if (requestId !== undefined) {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128) throw Error('invalid requestId');
      const prior = this.commands.get(requestId);
      if (prior) {
        if (prior.signature !== signature) throw Object.assign(Error('request_id_conflict'), {code: 'request_id_conflict'});
        return clone(prior.result);
      }
    }

    let result;
    if (object.type === OBJECT_TYPES.TASK && operation !== 'getState' && operation !== 'getCapabilities') {
      result = this._executeTaskOperation(objectId, operation, params);
    } else {
    switch (operation) {
      case 'getState': result = {state: object.state, properties: clone(object.properties)}; break;
      case 'getCapabilities': result = {operations: object.operations.slice(), capabilities: object.capabilities.slice()}; break;
      case 'getPosition': result = {location: clone(object.location)}; break;
      case 'getTelemetry':
      case 'read': result = {state: object.state, telemetry: clone(object.properties.telemetry ?? {})}; break;
      case 'getOccupancy': result = {occupancy: object.properties.occupancy ?? 0}; break;
      case 'getAvailability': result = {available: object.state !== 'locked' && object.state !== 'fault'}; break;
      case 'getInventory': result = {quantity: object.properties.quantity ?? 0, reservations: clone(object.properties.reservations ?? [])}; break;
      case 'getProgress': result = {progress: object.properties.progress ?? 0}; break;
      case 'getOEE': result = clone(object.properties.oee ?? {availability: 1, performance: 1, quality: 1, value: 1}); break;
      case 'trace': result = {objectId: object.id, history: this.history.filter(event => event.objectId === object.id).map(clone)}; break;
      case 'snapshot': result = this.snapshot(); break;
      case 'queryObjects': result = {objects: this.listObjects(params.filter ?? {})}; break;
      default:
        result = this._applyCommand(object, operation, params);
    }
    }
    const event = this._record(object, operation, params, context, result);
    const response = {accepted: true, object: clone(object), result: clone(result), event};
    if (requestId !== undefined) this.commands.set(requestId, {signature, result: response});
    return clone(response);
  }

  _executeTaskOperation(taskId, operation, params) {
    if (operation === 'assign') return this.assignTask(taskId, params.actorId);
    if (operation === 'reserveResources') return this._setTaskState(taskId, 'assigned', ['assigned', 'active']);
    if (operation === 'start') return this.startTask(taskId);
    if (operation === 'pause') return this.pauseTask(taskId);
    if (operation === 'resume') return this.resumeTask(taskId);
    if (operation === 'cancel') return this.cancelTask(taskId);
    if (operation === 'retry') {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'failed') throw Error('task_not_retryable');
      task.status = 'pending'; task.currentStep = 0; task.result = null; task.updatedAt = this.clock();
      this._syncTaskObject(task);
      return clone(task);
    }
    if (operation === 'complete') {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'active') throw Error('task_not_active');
      task.status = 'completed'; task.currentStep = task.steps.length; task.result = clone(params.result ?? null); task.updatedAt = this.clock();
      this._syncTaskObject(task);
      return clone(task);
    }
    if (operation === 'fail') return this._setTaskState(taskId, 'failed', ['active']);
    throw Error('task_operation_not_supported');
  }

  _applyCommand(object, operation, params) {
    const stateMap = {
      open: 'open', close: 'closed', start: 'running', resume: 'running', pause: 'paused', stop: 'idle',
      powerOn: 'online', powerOff: 'offline', dispatch: 'dispatched', cancel: 'cancelled', charge: 'charging',
      emergencyStop: 'emergency_stopped', lockdown: 'locked', unlockdown: 'open', isolate: 'isolated',
      acknowledge: 'acknowledged', suppress: 'suppressed', activate: 'active', release: 'released',
      deactivate: 'inactive', quarantine: 'quarantined', complete: 'completed', fail: 'failed', resetAlarm: 'idle',
      hold: 'held', enter: 'onsite', exit: 'offsite', authenticate: 'authenticated',
    };
    if (stateMap[operation]) object.state = stateMap[operation];
    if (operation === 'setMode' || operation === 'setHVAC' || operation === 'setRecipe' || operation === 'setSampling' || operation === 'setLoad' || operation === 'setView' || operation === 'switchSupply') {
      object.properties = {...object.properties, [operation]: clone(params)};
    }
    if (operation === 'move' || operation === 'dispatch') {
      if (params.target !== undefined) object.location = clone(params.target);
      if (params.route !== undefined) object.properties.route = clone(params.route);
    }
    if (operation === 'reportFault' || operation === 'diagnose') object.properties = {...object.properties, diagnosis: params.code ?? params.result ?? 'unknown'};
    if (operation === 'reserve') {
      const amount = Number.isFinite(params.quantity) ? params.quantity : 1;
      const reservations = Array.isArray(object.properties.reservations) ? object.properties.reservations.slice() : [];
      reservations.push({actorId: params.actorId ?? null, quantity: amount, taskId: params.taskId ?? null});
      object.properties = {...object.properties, reservations, quantity: Math.max(0, (object.properties.quantity ?? 0) - amount)};
      object.state = 'reserved';
    }
    if (operation === 'release') object.properties = {...object.properties, reservations: []};
    if (operation === 'consume') object.properties = {...object.properties, quantity: Math.max(0, (object.properties.quantity ?? 0) - (params.quantity ?? 1))};
    if (operation === 'calibrate') object.properties = {...object.properties, calibratedAt: this.clock()};
    if (operation === 'raise') object.properties = {...object.properties, level: params.level ?? 'warning', message: params.message ?? ''};
    if (operation === 'load' || operation === 'unload' || operation === 'putAway' || operation === 'pick' || operation === 'inspect' || operation === 'confirm' || operation === 'repair' || operation === 'test' || operation === 'verify' || operation === 'execute' || operation === 'capture' || operation === 'runInspection') object.properties = {...object.properties, lastOperation: {name: operation, params: clone(params), at: this.clock()}};
    return {state: object.state, operation, properties: clone(object.properties)};
  }

  listTaskTemplates() {
    return {
      generic: Object.entries(TASK_TEMPLATES).map(([type, template]) => ({type, ...clone(template)})),
      scene: taskTemplatesForScene(this.scene),
    };
  }

  createSceneTask(sceneTaskId, input = {}) {
    const source = (this.scene.tasks ?? []).find(task => task.id === sceneTaskId);
    if (!source) throw Error('scene_task_not_found');
    return this.createTask({
      ...input,
      id: input.id ?? source.id,
      type: sceneTaskType(source),
      name: input.name ?? source.name,
      requiredCapability: source.capability,
      dependsOn: input.dependsOn ?? source.dependsOn,
      input: {...(input.input ?? {}), target: clone(source.target), duration: source.duration},
    });
  }

  createTask(typeOrInput, input = {}) {
    const spec = typeof typeOrInput === 'string' ? {type: typeOrInput, ...input} : {...typeOrInput};
    const template = TASK_TEMPLATES[spec.type];
    if (!template) throw Object.assign(Error('task_type_not_supported'), {code: 'task_type_not_supported'});
    let suffix = this.tasks.size + 1;
    let id = spec.id ?? `park-task-${suffix}`;
    if (spec.id === undefined) while (this.tasks.has(id) || this.objects.has(id)) id = `park-task-${++suffix}`;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(id) || this.tasks.has(id)) throw Error('invalid or duplicate task id');
    const task = {
      id, type: spec.type, name: spec.name ?? template.name, status: 'pending', assignee: null,
      requiredCapability: spec.requiredCapability ?? template.requiredCapability,
      steps: clone(spec.steps ?? template.steps), currentStep: 0,
      dependsOn: clone(spec.dependsOn ?? []), targetObjectId: spec.targetObjectId ?? null,
      input: clone(spec.input ?? {}), result: null, createdAt: this.clock(), updatedAt: this.clock(),
    };
    this.tasks.set(id, task);
    addObject(Array.from(this.objects.values()), {id: task.id, type: OBJECT_TYPES.TASK, name: task.name, state: task.status, capabilities: [task.requiredCapability]});
    this.objects.set(task.id, {
      id: task.id, type: OBJECT_TYPES.TASK, subtype: task.type, name: task.name,
      parentId: 'park-1', state: task.status, capabilities: [task.requiredCapability],
      operations: operationList(OBJECT_TYPES.TASK), permissions: ['operator', 'coordinator', 'admin'],
      properties: {requiredCapability: task.requiredCapability},
    });
    return clone(task);
  }

  getTask(id) { return clone(this.tasks.get(id) ?? null); }
  listTasks(filter = {}) { return Array.from(this.tasks.values()).filter(task => filter.status === undefined || task.status === filter.status).map(clone); }

  assignTask(taskId, actorId) {
    const task = this.tasks.get(taskId), actor = this.objects.get(actorId);
    if (!task) throw Error('task_not_found');
    if (!actor) throw Error('assignee_not_found');
    if (!actor.capabilities.includes(task.requiredCapability)) throw Error('assignee_missing_capability');
    if (!['pending', 'paused'].includes(task.status)) throw Error('task_not_assignable');
    task.assignee = actorId; task.status = 'assigned'; task.updatedAt = this.clock();
    this._syncTaskObject(task);
    return clone(task);
  }

  startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw Error('task_not_found');
    if (task.dependsOn.some(id => this.tasks.get(id)?.status !== 'completed')) throw Error('task_dependencies_incomplete');
    if (!task.assignee) throw Error('task_unassigned');
    if (!['assigned', 'paused'].includes(task.status)) throw Error('task_not_startable');
    task.status = 'active'; task.updatedAt = this.clock();
    this._syncTaskObject(task);
    return clone(task);
  }

  advanceTask(taskId, {result} = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw Error('task_not_found');
    if (task.status !== 'active') throw Error('task_not_active');
    task.currentStep += 1;
    if (task.currentStep >= task.steps.length) { task.status = 'completed'; task.result = clone(result); }
    task.updatedAt = this.clock();
    this._syncTaskObject(task);
    return clone(task);
  }

  pauseTask(taskId) { return this._setTaskState(taskId, 'paused', ['active']); }
  resumeTask(taskId) { return this._setTaskState(taskId, 'active', ['paused']); }
  cancelTask(taskId) { return this._setTaskState(taskId, 'cancelled', ['pending', 'assigned', 'active', 'paused']); }

  _setTaskState(taskId, state, allowed) {
    const task = this.tasks.get(taskId);
    if (!task) throw Error('task_not_found');
    if (!allowed.includes(task.status)) throw Error('task_state_conflict');
    task.status = state; task.updatedAt = this.clock();
    this._syncTaskObject(task);
    return clone(task);
  }

  _syncTaskObject(task) {
    const object = this.objects.get(task.id);
    if (object) {
      object.state = task.status;
      object.properties = {...object.properties, assignee: task.assignee, currentStep: task.currentStep, stepCount: task.steps.length};
    }
  }

  snapshot() {
    return {
      version: 1,
      sceneId: this.scene.id,
      objects: this.listObjects(),
      tasks: this.listTasks(),
      events: clone(this.events),
    };
  }
}

function loadIndustrialParkScene() {
  // Lazy loading keeps the catalogue usable by tooling that only imports the
  // constants and avoids a world-core initialization cycle.
  return require('../scenes/industrial-park-v2.json');
}

function resolveScene(scene) {
  if (scene === undefined || scene === null) return loadIndustrialParkScene();
  if (typeof scene === 'string') {
    if (scene !== DEFAULT_SCENE_ID) throw Error('industrial-park scene not found: ' + scene);
    return loadIndustrialParkScene();
  }
  return scene;
}

function createIndustrialParkDomain(scene, options) {
  return new IndustrialParkDomain(resolveScene(scene), options);
}

function industrialParkCatalog(scene) {
  return createCatalog(resolveScene(scene));
}

module.exports = {
  DEFAULT_SCENE_ID,
  OBJECT_TYPES,
  TASK_TYPES,
  OPERATION_CATALOG,
  TASK_TEMPLATES,
  createObjects,
  createCatalog: industrialParkCatalog,
  IndustrialParkDomain,
  createIndustrialParkDomain,
};
