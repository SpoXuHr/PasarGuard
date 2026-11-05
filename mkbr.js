const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = process.argv[2] || '.';
const MAX = Number(process.argv[3] || 600000);
let made = 0;
let saved = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|mjs|css|html|json|svg|txt|webmanifest)$/.test(entry.name)) continue;
    const data = fs.readFileSync(full);
    if (data.length < 2048 || data.length > MAX) continue;
    if (fs.existsSync(full + '.br')) continue;
    try {
      const packed = zlib.brotliCompressSync(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      if (packed.length < data.length) {
        fs.writeFileSync(full + '.br', packed);
        made += 1;
        saved += data.length - packed.length;
      }
    } catch (e) {}
  }
};
walk(root);
console.log('br files:', made, 'saved bytes:', saved);
