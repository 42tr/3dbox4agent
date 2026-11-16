'use strict';

const fs = require('node:fs');
const {spawn} = require('node:child_process');

const suite = process.argv[2];
if (!suite) {
  console.error('Usage: node scripts/run-tests.js <suite-file> [--jobs N]');
  process.exit(2);
}
const jobsIndex = process.argv.indexOf('--jobs');
const jobs = jobsIndex === -1 ? 1 : Number(process.argv[jobsIndex + 1]);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
  console.error('--jobs must be an integer from 1 to 16');
  process.exit(2);
}
const commands = fs.readFileSync(suite, 'utf8').split('\n')
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
if (!commands.length) throw Error('empty test suite');

let cursor = 0;
const failures = [];
const started = Date.now();

function execute(index) {
  const command = commands[index];
  return new Promise(resolve => {
    const child = spawn(command, {shell: true, stdio: 'inherit', env: process.env});
    child.on('error', error => {
      failures.push({index, command, error: error.message});
      resolve();
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) failures.push({index, command, error: signal || `exit ${code}`});
      resolve();
    });
  });
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= commands.length) return;
    await execute(index);
  }
}

Promise.all(Array.from({length: Math.min(jobs, commands.length)}, worker)).then(() => {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!failures.length) {
    console.log(`\n${commands.length} test commands passed in ${seconds}s (${jobs} worker${jobs === 1 ? '' : 's'})`);
    return;
  }
  console.error(`\n${failures.length} of ${commands.length} test commands failed in ${seconds}s:`);
  for (const failure of failures) {
    console.error(`  #${failure.index + 1} [${failure.error}] ${failure.command}`);
  }
  process.exitCode = 1;
});
