const fs = require('fs');
const src = fs.readFileSync('src/mcp/McpServer.ts', 'utf8');

console.log('=== All Actions in List ===');
const actions = ['click', 'type', 'submit', 'select', 'hover', 'scroll', 'keyboard', 'interact',
  'fill_form', 'reset_form', 'clear_form', 'validate_form',
  'check', 'clear', 'clear_search', 'append', 'set_value', 'set_color', 'set_date',
  'go_back', 'go_forward', 'refresh',
  'screenshot', 'screenshot_file', 'media_control',
  'open_tab', 'switch_tab', 'close_tab', 'set_viewport',
  'upload', 'download', 'wait', 'wait_for', 'evaluate',
  'multi_click', 'sequence', 'parallel', 'loop', 'if', 'try', 'noop',
  'fill_and_verify', 'navigate_and_extract', 'login_flow',
  'define_script', 'call_script',
  'async_navigate', 'poll', 'cancel',
  'search_and_paginate', 'pdf', 'fs',
  'invalidate_cache', 'visual'];

let count = 0;
for (const a of actions) {
  const inList = src.includes("' " + a + ",") || src.includes(a + ",");
  console.log((inList ? "✅" : "❌") + " " + a);
  if (inList) count++;
}
console.log("\n" + count + "/" + actions.length + " actions documented");
console.log("\n=== TypeScript compilation ===");
try {
  const ts = require('typescript');
  const result = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
  console.log("✅ TypeScript: OK (output " + result.outputText.length + " chars)");
} catch (e) {
  console.log("❌ TypeScript: FAILED - " + e.message);
}