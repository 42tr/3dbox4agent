'use strict';
const X = require('../src/experiments');

// count, first seed, policy, duration, target (first_dispatch or agent id), maximum ticks
try {
  const [count='20', startSeed='42', policy='nearest', duration='10', target='first_dispatch', maxTicks='1000'] = process.argv.slice(2);
  const config = {count:Number(count), startSeed:Number(startSeed), policy, maxTicks:Number(maxTicks), outageTick:1, outageDuration:Number(duration), target};
  process.stdout.write(JSON.stringify(X.runResilienceBatch(config),null,2)+'\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
