'use strict';

const {validateActionEnvelope, validateObservation} = require('./control-contracts');

/**
 * Layer 3: policy execution. A policy sees an observation and returns a
 * semantic action (or an array of actions). It never receives the world or a
 * renderer, so rules, planners and LLM adapters share the same boundary.
 */
function normalizeDecision(decision) {
  if (decision === null || decision === undefined) return [];
  const actions = Array.isArray(decision) ? decision : [decision];
  if (actions.some(action => !action || typeof action !== 'object' || Array.isArray(action) || !validateActionEnvelope(action).ok)) {
    throw new TypeError('Agent policy returned an invalid action');
  }
  return actions;
}

function createPolicy(decide) {
  if (typeof decide !== 'function') throw new TypeError('Agent policy requires decide');
  return Object.freeze({decide});
}

function createAgentRuntime({observe, dispatch, policy, onError} = {}) {
  if (typeof observe !== 'function') throw new TypeError('Agent runtime requires observe');
  if (typeof dispatch !== 'function') throw new TypeError('Agent runtime requires dispatch');
  if (!policy || typeof policy.decide !== 'function') throw new TypeError('Agent runtime requires a policy');

  return Object.freeze({
    async runOnce(context) {
      const observation = await observe(context);
      const observationCheck = validateObservation(observation);
      if (!observationCheck.ok) throw new TypeError('Agent runtime received an invalid observation');
      let decision;
      try {
        decision = await policy.decide(observation, context);
      } catch (error) {
        onError?.(error, {phase: 'decide', observation});
        throw error;
      }
      const actions = normalizeDecision(decision);
      const results = [];
      for (const action of actions) {
        try {
          results.push(await dispatch(action, observation, context));
        } catch (error) {
          onError?.(error, {phase: 'dispatch', action, observation});
          throw error;
        }
      }
      return {observation, actions, results};
    },
  });
}

function createClientAgentRuntime({client, policy, onError} = {}) {
  if (!client || typeof client.observe !== 'function' || typeof client.submitAction !== 'function') throw new TypeError('Agent runtime requires a control client');
  return createAgentRuntime({observe: () => client.observe(), dispatch: action => client.submitAction(action), policy, onError});
}

module.exports = {normalizeDecision, createPolicy, createAgentRuntime, createClientAgentRuntime};
