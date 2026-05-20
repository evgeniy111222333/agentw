const fs = require('fs');
const src = fs.readFileSync('src/mcp/McpServer.ts', 'utf8');

console.log('=== Verification Results ===');

// Check 1: getRateLimitForTool has browser_open_tab
const check1 = src.includes("case 'browser_open_tab':");
console.log('1. getRateLimitForTool has browser_open_tab:', check1);

// Check 2: handleOpenTab uses checkRateLimit('browser_open_tab')
const check2 = src.includes("checkRateLimit('browser_open_tab')");
console.log('2. handleOpenTab checkRateLimit uses browser_open_tab:', check2);

// Check 3: browser_open_tab description mentions shared rate limit
const check3 = src.includes('Shares rate limit bucket with browser_navigate');
console.log('3. browser_open_tab has shared bucket note:', check3);

// Check 4: browser_snapshot auto_bounce has cookie/newsletter details
const check4 = src.includes('cookie consent') && src.includes('newsletter');
console.log('4. auto_bounce mentions cookie and newsletter:', check4);

// Check 5: browser_element_search mentions placeholder and ariaLabel
const check5 = src.includes('placeholder') && src.includes('ariaLabel');
console.log('5. element_search mentions placeholder and ariaLabel:', check5);

// Check 6: browser_paginate item_container is CSS selector note
const check6 = src.includes('CSS selector') && src.includes('not an element ID');
console.log('6. paginate item_container CSS selector note:', check6);

// Check 7: browser_wait_for has element_enabled and element_stable
const check7 = src.includes('element_enabled') && src.includes('element_stable');
console.log('7. wait_for has element_enabled and element_stable:', check7);

// Summary
const allPassed = check1 && check2 && check3 && check4 && check5 && check6 && check7;
console.log('\n=== All ' + (allPassed ? 'PASSED' : 'FAILED') + ' ===');