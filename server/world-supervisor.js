'use strict';
// Compatibility entry point. The World supervisor lives in packages/world/server.
const WorldSupervisor = require('../packages/world/server/world-supervisor');
module.exports = WorldSupervisor;
if (require.main === module) WorldSupervisor.run();
