'use strict';

const {createPolicy, normalizeDecision} = require('./agent-runtime');
const {ACTION_TYPES} = require('@42tr/3dbox4agent-control/contracts');

const ACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requestId', 'type', 'targetTick', 'expiresTick'],
        properties: {
          requestId: {type: 'string'},
          type: {type: 'string', enum: ACTION_TYPES},
          targetTick: {type: 'integer'},
          expiresTick: {type: 'integer'},
          target: {type: 'object'},
          taskId: {type: 'string'},
          targetAgentId: {type: 'string'},
          observedTick: {type: 'integer'},
          faultGeneration: {type: 'integer'},
        },
      },
    },
  },
  required: ['actions'],
});

function byteLength(value) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(encoded === undefined ? '' : encoded, 'utf8');
}

function parseModelOutput(value, maxActions) {
  if (typeof value === 'string') {
    if (byteLength(value) > 64 * 1024) throw new Error('llm_output_too_large');
    try { value = JSON.parse(value); } catch { throw new Error('llm_invalid_json'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'actions') || !Array.isArray(value.actions)) throw new Error('llm_invalid_action_envelope');
  if (value.actions.length > maxActions) throw new Error('llm_action_limit');
  return normalizeDecision(value.actions);
}

function createLlmPolicy({complete, instructions = '', timeoutMs = 10_000, maxActions = 4, maxOutputBytes = 64 * 1024} = {}) {
  if (typeof complete !== 'function') throw new TypeError('LLM policy requires complete');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('invalid LLM timeout');
  if (!Number.isSafeInteger(maxActions) || maxActions < 0 || maxActions > 4) throw new TypeError('invalid LLM action limit');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new TypeError('invalid LLM output limit');
  return createPolicy(async (observation, context) => {
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        complete({observation, context, instructions, responseSchema: ACTION_SCHEMA, signal: controller.signal}),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('llm_timeout')); }, timeoutMs); }),
      ]);
      if (byteLength(result) > maxOutputBytes) throw new Error('llm_output_too_large');
      return parseModelOutput(result, maxActions);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

module.exports = {ACTION_SCHEMA, createLlmPolicy, parseModelOutput};
