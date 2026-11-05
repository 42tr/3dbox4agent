'use strict';
const {createSupervisor}=require('../server/world-supervisor');
const server=createSupervisor({maxWorkers:1});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',message=>{if(message==='workers')process.send({workers:server.inspectWorkers()})});
process.on('disconnect',()=>server.close(()=>process.exit(0)));
