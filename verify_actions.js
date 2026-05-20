const fs = require('fs');
const src = fs.readFileSync('src/mcp/McpServer.ts', 'utf8');

console.log('=== New Actions in List ===');
const newActions = [
  'screenshot_file',
  'noop',
  'async_navigate',
  'poll',
  'cancel',
  'search_and_paginate',
  'pdf',
  'fs'
];

let allFound = true;
for (const action of newActions) {
  const inList = src.includes(action);
  console.log(`  ${inList ? '✅' : '❌'} ${action}:`, inList ? 'found' : 'MISSING');
  if (!inList) allFound = false;
}

console.log('\n=== Params for Flow Control ===');
const flowParams = [
  'multi_click: {clicks:',
  'sequence: {steps:',
  'parallel: {actions:',
  'loop: {max_iterations:',
  'if: {condition:',
  'try: {try_steps:',
  'noop: {}',
  'fill_and_verify: {fields:',
  'navigate_and_extract: {url:',
  'login_flow: {username_field:',
  'define_script: {name:',
  'call_script: {name:',
  'async_navigate: {url:',
  'poll: {operation_id:',
  'cancel: {operation_id:',
  'search_and_paginate: {search_input_id:',
  'pdf: {file_name:',
  'fs: {operation:'
];

for (const param of flowParams) {
  const found = src.includes(param);
  console.log(`  ${found ? '✅' : '❌'} ${param.split(':')[0]}: ${found ? 'params OK' : 'MISSING'}`);
  if (!found) allFound = false;
}

console.log('\n' + (allFound ? '=== ALL CHECKS PASSED ===' : '=== SOME CHECKS FAILED ==='));