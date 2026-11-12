'use strict';
// Compatibility entry point. The World application lives in packages/world/server.
const WorldServer = require('../packages/world/server/world-server');
module.exports = WorldServer;
if (require.main === module) WorldServer.run();
