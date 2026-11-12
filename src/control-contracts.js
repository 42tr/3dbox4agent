'use strict';

/** Shared Layer 2/3 contracts. Keep these independent from the world engine. */
const ACTION_TYPES = Object.freeze(['move', 'scan', 'charge', 'execute_task', 'work_task', 'rescue']);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function validRequestId(value) { return typeof value === 'string' && REQUEST_ID.test(value); }

function validateActionEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok: false, reason: 'invalid_action'};
  if (!validRequestId(input.requestId) || !ACTION_TYPES.includes(input.type)) return {ok: false, reason: 'invalid_action'};
  if (!Number.isSafeInteger(input.targetTick) || !Number.isSafeInteger(input.expiresTick)) return {ok: false, reason: 'invalid_action'};
  return {ok: true};
}

function validateObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return {ok: false, reason: 'invalid_observation'};
  if (!Number.isSafeInteger(observation.tick) || observation.tick < 0) return {ok: false, reason: 'invalid_observation'};
  if (!observation.self || typeof observation.self !== 'object' || typeof observation.self.id !== 'string' || !observation.self.id) return {ok: false, reason: 'invalid_observation'};
  return {ok: true};
}

module.exports = {ACTION_TYPES, validRequestId, validateActionEnvelope, validateObservation};
