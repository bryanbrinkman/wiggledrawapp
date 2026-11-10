// Generates v2/index.html from index.html: the same app plus the in-page ABX mint module.
// Run after editing index.html:  node scripts/build-v2.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const must = (from, to) => { if (!html.includes(from)) throw new Error('build-v2: anchor missing: ' + from); html = html.replace(from, to); };
must('<title>ChainPainter</title>', '<title>ChainPainter v2</title>\n<meta name="robots" content="noindex,nofollow">');
must('src="tip-qr.png"', 'src="../tip-qr.png"');
// Cache-bust mint.js by content hash so browsers pick up a new version right after each deploy.
const ver = createHash('sha256').update(readFileSync(new URL('../v2/mint.js', import.meta.url))).digest('hex').slice(0, 8);
must('</body>', '<script src="mint.js?v=' + ver + '" defer></script>\n</body>');
writeFileSync(new URL('../v2/index.html', import.meta.url), html);
console.log('v2/index.html written (' + (html.length / 1024).toFixed(0) + ' KB)');
