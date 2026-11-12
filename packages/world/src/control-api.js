'use strict';

/**
 * Layer 2: semantic control and capability boundary.
 *
 * The world runtime owns truth and performs the authoritative validation. This
 * layer only validates the transport envelope and exposes semantic operations
 * for UI clients, SDKs and Agent runtimes.
 */
const Contracts = require('@42tr/3dbox4agent-control/contracts');
const {ACTION_TYPES, validRequestId, validateActionEnvelope} = Contracts;

function createControlApi({runtime} = {}) {
  if (!runtime || typeof runtime.observe !== 'function') throw new TypeError('control API requires a world runtime');
  const api = {
    observe(world, agentId) {
      return runtime.observe(world, agentId);
    },
    submitAction(world, agentId, input) {
      const envelope = validateActionEnvelope(input);
      return envelope.ok ? runtime.submitAction(world, agentId, input) : envelope;
    },
    cancelAction(world, agentId, requestId) {
      return runtime.cancelAction(world, agentId, requestId);
    },
    sendMessage(world, from, to, text, via, requestId) {
      return runtime.sendMessage(world, from, to, text, via, requestId);
    },
    submitEvidence(world, agentId, input) {
      return runtime.submitEvidence(world, agentId, input);
    },
    submitSampleReport(world, agentId, input) {
      return runtime.submitSampleReport(world, agentId, input);
    },
    assign(world, taskId, agentId) {
      return runtime.assign(world, taskId, agentId);
    },
    withCoordinator(world, coordinatorId, requestId, operation) {
      return runtime.call('withCoordinator', world, coordinatorId, requestId, operation);
    },
    proposeSurvey(world, input) {
      return runtime.call('proposeSurvey', world, input);
    },
    revokeTask(world, input) {
      return runtime.call('revokeTask', world, input);
    },
    submitExternalDecision(world, input) {
      return runtime.call('submitExternalDecision', world, input);
    },
    setDispatchMode(world, mode) {
      return runtime.call('setDispatchMode', world, mode);
    },
    fault(world) {
      return runtime.call('fault', world);
    },
    injectFault(world, input) {
      return runtime.call('injectFault', world, input);
    },
    injectLowEnergy(world, agentId, level) {
      return runtime.call('injectLowEnergy', world, agentId, level);
    },
    injectRoadblock(world, rect, duration) {
      return runtime.call('injectRoadblock', world, rect, duration);
    },
    injectTerrainEffect(world, zoneId, duration, speedFactor, energyFactor) {
      return runtime.call('injectTerrainEffect', world, zoneId, duration, speedFactor, energyFactor);
    },
    interruptCommunication(world, agentId, duration) {
      return runtime.call('interruptCommunication', world, agentId, duration);
    },
  };
  return Object.freeze(api);
}

module.exports = {...Contracts, createControlApi};
