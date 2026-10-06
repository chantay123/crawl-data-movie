const fs = require('fs');
const c = fs.readFileSync('src/services/TrailerService.js', 'utf8');
const re = /\*\//g;
let match;
while ((match = re.exec(c)) !== null) {
  const before = c.slice(0, match.index);
  const line = before.split('\n').length;
  const col = match.index - before.lastIndexOf('\n');
  console.log('Line', line, 'Col', col, ':', JSON.stringify(c.slice(Math.max(0, match.index-15), match.index+5)));
}