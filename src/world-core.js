'use strict';

// Compatibility entry point. The implementation lives in packages/world.
if (typeof module !== 'undefined') module.exports = require('../packages/world/src/world-core');
else if (typeof globalThis !== 'undefined') globalThis.SandboxEngine = globalThis.SandboxWorldCore;
