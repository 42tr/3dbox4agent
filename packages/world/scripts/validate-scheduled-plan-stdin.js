'use strict';
const fs=require('node:fs'),Plan=require('../src/scheduled-plan');
try{const raw=fs.readFileSync(0);if(raw.length>60000)throw Error('plan exceeds 60 KB');const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));process.stdout.write(JSON.stringify(Plan.validate(input)))}catch(error){console.error(error.message);process.exitCode=1}
