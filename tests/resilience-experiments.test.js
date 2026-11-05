'use strict';
const assert = require('node:assert/strict');
const X = require('../src/experiments');

const config = {startSeed:42,count:5,policy:'nearest',maxTicks:1000,outageTick:1,outageDuration:10,target:'first_dispatch'};
const report = X.runResilienceBatch(config);
assert.deepEqual(report, X.runResilienceBatch(config));
assert.equal(report.format,'3dbox-resilience-v1');
assert.deepEqual(report.config, config);
assert.equal(report.pairs.length,5);
assert.equal(report.summary[0].outagesInjected,0);
assert.equal(report.summary[1].outagesInjected,5);
for (const pair of report.pairs) {
  assert.equal(pair.seed,pair.control.seed);
  assert.equal(pair.seed,pair.outage.seed);
  assert.equal(pair.control.policy,pair.outage.policy);
  assert(pair.outage.outageInjected);
  const sent = pair.outage.events.find(e=>e.kind==='dispatch_sent');
  assert.equal(sent.agentId,pair.outage.outageAgent);
  assert(pair.outage.events.some(e=>e.kind==='dispatch_failed'&&e.reason==='interrupted'&&e.agentId===sent.agentId));
  for (const run of [pair.control,pair.outage]) {
    assert.equal(run.metrics.dispatchSent,run.events.filter(e=>e.kind==='dispatch_sent').length);
    assert.equal(run.metrics.dispatchFailed,run.events.filter(e=>e.kind==='dispatch_failed').length);
  }
}
const both = report.pairs.filter(p=>p.control.status==='completed'&&p.outage.status==='completed');
assert.equal(report.paired.bothCompleted,both.length);
assert.deepEqual(report.paired.completionTickDifference,X.stats(both.map(p=>p.outage.metrics.ticks-p.control.metrics.ticks)));
assert.deepEqual(report.paired.dispatchFailureDifference,X.stats(report.pairs.map(p=>p.outage.metrics.dispatchFailed-p.control.metrics.dispatchFailed)));
const timedOut = X.runResilienceBatch({...config,count:1,maxTicks:1});
assert.equal(timedOut.paired.bothCompleted,0);
assert.equal(timedOut.paired.completionTickDifference.mean,null);
assert.throws(()=>X.runResilienceBatch({...config,target:'not-an-agent'}));
assert.throws(()=>X.runResilienceBatch({...config,outageDuration:0}));
const fixed = X.runResilienceBatch({...config,count:1,target:'drone-1'});
assert.equal(fixed.pairs[0].outage.outageAgent,'drone-1');
console.log('resilience experiment tests passed');
