const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('dashboard.html', 'utf8');
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

while ((match = scriptRegex.exec(html)) !== null) {
  const content = match[1];
  // Skip external scripts with src attribute
  if (!content.trim()) continue;
  count++;
  console.log(`Checking script block ${count}... (length: ${content.length} characters)`);
  try {
    // Parse script with vm.Script to verify syntax without executing DOM operations
    new vm.Script(content);
    console.log(`Script block ${count} syntax is valid!`);
  } catch (err) {
    console.error(`Syntax error in script block ${count}:`, err.message);
    process.exit(1);
  }
}
console.log(`All ${count} inline script blocks checked and valid!`);
