'use strict';

// Compatibility entry point. The headless simulation implementation lives in
// world-core.js; existing Node consumers keep requiring ./engine.
if (typeof module !== 'undefined') module.exports = require('./world-core');
else if (typeof globalThis !== 'undefined') globalThis.SandboxEngine = globalThis.SandboxWorldCore;
