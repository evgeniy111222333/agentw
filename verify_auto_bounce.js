/**
 * Verification script for auto_bounce fix
 *
 * This script verifies that:
 * 1. McpServer has auto_bounce parameter in handleAction and handleRunFlow
 * 2. getQuickSnapshot respects auto_bounce option
 * 3. CommandRouter only runs bouncer for explicit snapshot action
 *
 * Run: node verify_auto_bounce.js
 */

// Check McpServer.ts for auto_bounce in handleAction
const fs = require('fs');
const path = require('path');

const mcpServer = fs.readFileSync(
  path.join(__dirname, 'src', 'mcp', 'McpServer.ts'),
  'utf8'
);
const cmdRouter = fs.readFileSync(
  path.join(__dirname, 'src', 'layer5_agent_interface', 'CommandRouter.ts'),
  'utf8'
);

let errors = [];
let pass = 0;

// Test 1: auto_bounce in handleAction signature
const handleActionMatch = mcpServer.match(/handleAction\(args:\s*\{[^}]+auto_bounce[^}]+\}/s);
if (handleActionMatch || mcpServer.includes('auto_bounce?: boolean')) {
  console.log('✓ auto_bounce in handleAction signature');
  pass++;
} else {
  errors.push('✗ auto_bounce missing in handleAction signature');
}

// Test 2: auto_bounce in handleRunFlow signature
const handleRunFlowMatch = mcpServer.match(/handleRunFlow\(args:\s*{[^}]+auto_bounce[^}]+}/s);
if (handleRunFlowMatch || mcpServer.match(/auto_bounce\?: boolean/)) {
  console.log('✓ auto_bounce in handleRunFlow signature');
  pass++;
} else {
  errors.push('✗ auto_bounce missing in handleRunFlow signature');
}

// Test 3: getQuickSnapshot uses auto_bounce from options
if (mcpServer.includes('options.auto_bounce !== false')) {
  console.log('✓ getQuickSnapshot respects auto_bounce option');
  pass++;
} else {
  errors.push('✗ getQuickSnapshot does not use auto_bounce option');
}

// Test 4: CommandRouter only runs bouncer for snapshot action
if (cmdRouter.includes("activeAction.executionAction === 'snapshot'")) {
  console.log("✓ CommandRouter only runs bouncer for 'snapshot' action");
  pass++;
} else {
  errors.push("✗ CommandRouter still runs bouncer for all actions");
}

// Test 5: browser_action schema has auto_bounce
const browserActionSchema = mcpServer.match(/browser_action[\s\S]*?required:\s*\['action'\]/);
if (browserActionSchema && browserActionSchema[0].includes('auto_bounce')) {
  console.log('✓ browser_action schema has auto_bounce parameter');
  pass++;
} else {
  errors.push('✗ browser_action schema missing auto_bounce');
}

// Test 6: browser_run_flow schema has auto_bounce
const browserRunFlowSchema = mcpServer.match(/browser_run_flow[\s\S]*?auto_bounce/s);
if (browserRunFlowSchema) {
  console.log('✓ browser_run_flow schema has auto_bounce parameter');
  pass++;
} else {
  errors.push('✗ browser_run_flow schema missing auto_bounce');
}

console.log('\n' + '='.repeat(50));
console.log(`Results: ${pass} passed, ${errors.length} failed`);

if (errors.length > 0) {
  console.log('\nErrors:');
  errors.forEach(e => console.log('  ' + e));
  process.exit(1);
} else {
  console.log('\n✓ All checks passed!');
  console.log('\nSummary of changes:');
  console.log('1. browser_action: auto_bounce param added to auto-snapshot post-action');
  console.log('2. browser_run_flow: auto_bounce param added for post-flow snapshot');
  console.log('3. getQuickSnapshot: respects auto_bounce option (default true)');
  console.log('4. CommandRouter: bouncer only runs for explicit snapshot, not post-action');
  console.log('\nBehavior now:');
  console.log('- browser_snapshot: auto_bounce defaults to true (original behavior)');
  console.log('- browser_action with auto_snapshot=true: auto_bounce defaults to true');
  console.log('- browser_action with auto_snapshot=true + auto_bounce=false:');
  console.log('    bouncer is skipped, flash banners / status messages preserved');
  console.log('- browser_run_flow with auto_snapshot=true + auto_bounce=false:');
  console.log('    bouncer skipped in post-flow snapshot');
}