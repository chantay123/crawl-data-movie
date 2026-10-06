const fs = require('fs');
const c = fs.readFileSync('src/services/TrailerService.js', 'utf8');
let inString = false;
let stringChar = null;
let inBlockComment = false;
let inLineComment = false;
let line = 1;
let col = 0;
for (let i = 0; i < c.length; i++) {
  const ch = c[i];
  const next = c[i+1];
  col++;
  if (ch === '\n') { line++; col = 0; inLineComment = false; continue; }
  if (inLineComment) continue;
  if (inBlockComment) {
    if (ch === '*' && next === '/') {
      inBlockComment = false;
      i++;
      col++;
    }
    continue;
  }
  if (inString) {
    if (ch === '\\') { i++; col++; continue; }
    if (ch === stringChar) inString = false;
    continue;
  }
  if (ch === '/' && next === '/') { inLineComment = true; i++; col++; continue; }
  if (ch === '/' && next === '*') {
    inBlockComment = true;
    i++; col++; continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    inString = true;
    stringChar = ch;
    continue;
  }
}
console.log('Final state:', { inString, stringChar, inBlockComment, inLineComment, line, col });