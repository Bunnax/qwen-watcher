// patch-tg-v11.js - additive hardening: publisher self-logging, html no-store,
// reject counter, arg-less telegram commands pick first asset with a snapshot.
const fs = require('fs');

let b = fs.readFileSync('qwen-backend.js', 'utf8');
if (b.indexOf('canonRejects') === -1) {
  const a1 = 'const publisherSockets = new Set();';
  const a2 = '      const v = validateSnapshot(f);\n      if (!v) return;\n';
  const a4 = "    res.writeHead(200, { 'Content-Type': ct });";
  if (b.indexOf(a1) === -1 || b.indexOf(a2) === -1 || b.indexOf(a4) === -1) { console.error('ABORT: backend anchor missing'); process.exit(1); }
  b = b.replace(a1, a1 + '\nlet canonRejects = 0;');
  b = b.replace(a2, '      const v = validateSnapshot(f);\n      if (!v) { canonRejects++; return; }\n');
  b = b.replace('{ publishers: publisherSockets.size, assets:', '{ publishers: publisherSockets.size, rejects: canonRejects, assets:');
  b = b.replace(a4, "    res.writeHead(200, ct === 'text/html' ? { 'Content-Type': ct, 'Cache-Control': 'no-store, must-revalidate' } : { 'Content-Type': ct });");
  fs.writeFileSync('qwen-backend.js', b);
  console.log('backend v1.1 OK: no-store html + reject counter');
} else console.log('backend already v1.1');

let t = fs.readFileSync('qwen-telegram.js', 'utf8');
const t1 = 'return arg ? k.indexOf(arg) === 0 : false;';
if (t.indexOf(t1) !== -1) {
  t = t.replace(t1, 'return arg ? k.indexOf(arg) === 0 : !!canon[k].state;');
  fs.writeFileSync('qwen-telegram.js', t);
  console.log('telegram v1.1 OK: arg-less commands auto-pick first asset with snapshot');
} else console.log('telegram already v1.1 (or custom) - skipped');

let h = fs.readFileSync('qwen-watcher.html', 'utf8');
const START = '<script>\n/* QWEN WATCHER Telegram publisher';
const sIdx = h.indexOf(START);
if (sIdx === -1) { console.error('ABORT: publisher block not found in html'); process.exit(1); }
const eIdx = h.indexOf('</script>', sIdx);
if (eIdx === -1) { console.error('ABORT: publisher block end not found'); process.exit(1); }
const NEWPUB = fs.readFileSync('publisher-block-v11.txt', 'utf8').trim() + '\n';
h = h.slice(0, sIdx) + NEWPUB + h.slice(eIdx + '</script>'.length);
if (h.indexOf('PUBLISHER live') === -1) { console.error('ABORT: new publisher not in place'); process.exit(1); }
fs.writeFileSync('qwen-watcher.html', h);
console.log('frontend v1.1 OK: self-logging publisher replaced (0 other lines touched)');
