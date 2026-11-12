'use strict';

/** Layer 3 transport adapter for a scoped HTTP Agent credential. */
class AgentControlError extends Error {
  constructor(status, code, body) {
    super(`agent control request failed (${status}): ${code}`);
    this.name = 'AgentControlError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function createHttpAgentClient({baseUrl = 'http://127.0.0.1:8787', sessionId, agentId, token, fetchImpl = globalThis.fetch} = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' && origin.pathname !== '' || origin.search || origin.hash) throw new TypeError('baseUrl must be an HTTP loopback origin');
  if (typeof fetchImpl !== 'function') throw new TypeError('Agent HTTP client requires fetch');
  if (![sessionId, agentId, token].every(value => typeof value === 'string' && value.length > 0)) throw new TypeError('sessionId, agentId and token are required');
  const root = origin.toString().replace(/\/$/, ''), session = encodeURIComponent(sessionId), agent = encodeURIComponent(agentId);
  async function request(method, path, payload) {
    const response = await fetchImpl(root + path, {
      method,
      headers: {'authorization': `Bearer ${token}`, 'content-type': 'application/json'},
      ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {error: 'invalid_json_response'}; }
    if (!response.ok) throw new AgentControlError(response.status, body.error || 'http_error', body);
    return body;
  }
  return Object.freeze({
    observe: () => request('GET', `/sessions/${session}/observations/${agent}`),
    submitAction: action => request('POST', `/sessions/${session}/agents/${agent}/actions`, action),
    cancelAction: requestId => request('POST', `/sessions/${session}/agents/${agent}/actions/cancel`, {requestId}),
    sendMessage: ({to, text, via, requestId} = {}) => request('POST', `/sessions/${session}/agents/${agent}/messages`, {to, text, ...(via === undefined ? {} : {via}), ...(requestId === undefined ? {} : {requestId})}),
  });
}

module.exports = {AgentControlError, createHttpAgentClient};
