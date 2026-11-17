'use strict';

const {hashPassword} = require('./console-auth');
(async () => {
  let password = '';
  for await (const chunk of process.stdin) {
    password += chunk;
    if (password.length > 1026) throw Error('Password must be 12–1024 characters');
  }
  password = password.replace(/\r?\n$/, '');
  if (password.length < 12 || password.length > 1024) throw Error('Password must be 12–1024 characters');
  process.stdout.write(await hashPassword(password) + '\n');
})().catch(error => {console.error(error.message); process.exitCode = 1;});
