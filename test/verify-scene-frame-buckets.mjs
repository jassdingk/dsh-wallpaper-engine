#!/usr/bin/env node
/**
 * verify-scene-frame-buckets.mjs — GPU 抓帧缓存**按视口比分桶**的行为自检。
 *
 * ── 为什么需要它（这条判据的来历）────────────────────────────────────────────
 * 一张壁纸可以被多个窗口同时实时渲染（每个加载了客户端的窗口各挂一层；Electron
 * 跨窗口不共享 WebGL 面 ⇒ 各画各的），而各窗口视口比不同 ⇒ 各自的"正确构图"不同。
 * 单槽时代（`<key>_gpu.png`）两个视比不同的窗口会在每轮轮播到访时**互相清写**对方的
 * 帧（实测 60s 一轮永不收敛，diag 里 `gpu-frame-stale` 乒乓）。修复 = 槽位按视比
 * 分桶（`<key>_ar<b>_gpu.png`，b = round(视比×100)，桶号由 PNG 的 IHDR 推导）：
 *   · HEAD 带 `?ar=` 只认**本视比桶**（跨桶回退会让"我的桶缺了"判不出来 ⇒ 客户端
 *     不再回填自己的形状）；
 *   · GET（展示）才做最近桶回退（显示按 cover 裁切，相近构图好过没有）；
 *   · DELETE 带 `?ar=` 只删本桶 —— **别的桶属于别的窗口，谁也不踢谁**（本文件 3/7/8
 *     三条就是这条不变量的正面 + 负对照）。
 *
 * 判据走公开面（真 `apply()` + mock webServer + 真 PUT/HEAD/GET/DELETE 字节流），
 * 隔离同 verify-scene.mjs：`DSH_WE_DATA_DIR` / `DSH_WE_STEAM_ROOT` 指向
 * `.test-cache/`，全程不碰真实 `~/.dsh-wallpaper-engine`。
 *
 * Usage:  node test/verify-scene-frame-buckets.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ISO = join(root, '.test-cache', 'scene-frame-buckets');
const DATA_DIR = join(ISO, 'data');
const TEST_FRAMES_DIR = join(ISO, 'data', 'cache', 'frames');

rmSync(ISO, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
process.env.DSH_WE_DATA_DIR = DATA_DIR;
delete process.env.DSH_WE_CACHE_DIR;
delete process.env.DSH_WE_UPLOAD_DIR;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};

// ── 合成 Steam 库（同 verify-scene.mjs 的 fixture：32×32 噪声场景） ───────────
function pngChunkCrc32(type, payload) {
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const pngHeadFor = (w, h) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunkCrc32('IHDR', b),
  ]);
};
const makePng = (w, h, fill = 7, payloadBytes = 4096) => Buffer.concat([
  pngHeadFor(w, h),
  pngChunkCrc32('IDAT', Buffer.alloc(payloadBytes, fill)),
  pngChunkCrc32('IEND', Buffer.alloc(0)),
]);

function buildPkg(entries) {
  const parts = [];
  const index = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    index.push({ path, offset, length: bytes.length });
    parts.push(bytes);
    offset += bytes.length;
  }
  const headerSize = 12 + 8 + index.reduce((n, e) => n + 4 + Buffer.byteLength(e.path, 'utf8') + 8, 0);
  const header = Buffer.alloc(headerSize);
  let p = 0;
  header.writeInt32LE(8, p); p += 4;
  header.write('PKGV0001', p, 'ascii'); p += 8;
  header.writeInt32LE(index.length, p); p += 4;
  for (const e of index) {
    header.writeInt32LE(Buffer.byteLength(e.path, 'utf8'), p); p += 4;
    header.write(e.path, p, 'utf8'); p += Buffer.byteLength(e.path, 'utf8');
    header.writeUInt32LE(e.offset, p); p += 4;
    header.writeUInt32LE(e.length, p); p += 4;
  }
  return Buffer.concat([header.subarray(0, p), ...parts]);
}
function buildTexRgba(width, height, rgbaBytes) {
  const mip = Buffer.alloc(4 * 5 + rgbaBytes.length);
  mip.writeInt32LE(width, 0);
  mip.writeInt32LE(height, 4);
  mip.writeInt32LE(0, 8);
  mip.writeInt32LE(0, 12);
  mip.writeInt32LE(rgbaBytes.length, 16);
  rgbaBytes.copy(mip, 20);
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2 + 4);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4;
  header.writeInt32LE(1, p); p += 4;
  return Buffer.concat([header.subarray(0, p), mip]);
}

const fixtureLib = join(ISO, 'steamlib');
const fixtureItemDir = join(fixtureLib, 'steamapps', 'workshop', 'content', '431960', '990002');
{
  mkdirSync(fixtureItemDir, { recursive: true });
  mkdirSync(join(fixtureLib, 'steamapps', 'common', 'wallpaper_engine'), { recursive: true });
  const W = 32;
  const rgba = Buffer.alloc(W * W * 4);
  let seed = 0x12345678;
  for (let i = 0; i < W * W; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba[i * 4] = seed & 0xff;
    rgba[i * 4 + 1] = (seed >> 8) & 0xff;
    rgba[i * 4 + 2] = (seed >> 16) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: buildTexRgba(W, W, rgba) },
  ]);
  writeFileSync(join(fixtureItemDir, 'scene.pkg'), pkg);
  writeFileSync(join(fixtureItemDir, 'project.json'), JSON.stringify({
    title: 'Bucket Fixture Scene', type: 'scene', file: 'scene.pkg', preview: 'preview.jpg',
    contentrating: 'Everyone',
  }));
  writeFileSync(join(fixtureItemDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  process.env.DSH_WE_STEAM_ROOT = [process.env.DSH_WE_STEAM_ROOT, fixtureLib].filter(Boolean).join(',');
}

// ── Boot: real host apply() + mock webServer ────────────────────────────────
const routes = [];
const mockCtx = {
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    tapIndex() { return () => {}; },
  },
};
const hostMod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
const host = hostMod.default || hostMod;
const apply = host.apply || (host.inject && host.apply);
apply(mockCtx);
const sceneRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame');
const gpuRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame-cache');
check('scene-frame / scene-frame-cache 路由已注册', Boolean(sceneRoute && gpuRoute));
// 结构锚：分桶语义只实现一次（`bucketPath` 唯一构造点 + HEAD 精确桶语义），锚在路由源码上，
// 防"实现漂回单槽"——漂了行为判据会红，这条让红得更早、更可读。
{
  const routeSrc = readFileSync(join(root, 'lib', 'routes', 'scene-frame.js'), 'utf8');
  check('路由源码带着分桶不变量（bucketPath 唯一构造 + HEAD 精确桶）',
    routeSrc.includes('bucketPath(ar)') && routeSrc.includes('gpuFrameFileFor(slot, ar)'));
}

function fakeRes() {
  const state = { status: 200, headers: {}, body: Buffer.alloc(0), ended: false };
  const res = new Writable({
    write(chunk, enc, cb) { state.body = Buffer.concat([state.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); cb(); },
    final(cb) { state.ended = true; cb(); },
  });
  res.setHeader = (k, v) => { state.headers[k] = v; };
  res.writeHead = (s, h) => { state.status = s; if (h) Object.assign(state.headers, h); };
  Object.defineProperty(res, 'statusCode', { get: () => state.status, set: (v) => { state.status = v; } });
  res.__state = state;
  return res;
}
async function runHandler(route, url, method = 'GET') {
  const res = fakeRes();
  const done = route.handler({ url, headers: {}, method }, res);
  if (done && typeof done.then === 'function') await done;
  if (!res.__state.ended) {
    await new Promise((resolveFn) => {
      const t = setTimeout(resolveFn, 8000);
      res.on('finish', () => { clearTimeout(t); resolveFn(); });
    });
  }
  return res;
}
async function runHead(url) { return runHandler(sceneRoute, url, 'HEAD'); }
async function runPut(url, body) {
  const req = new Readable({ read() {} });
  req.url = url; req.method = 'PUT'; req.headers = { 'content-type': 'image/png' };
  const res = fakeRes();
  gpuRoute.handler(req, res);
  req.push(body); req.push(null);
  await new Promise((resolveFn) => {
    const t = setTimeout(resolveFn, 8000);
    res.on('finish', () => { clearTimeout(t); resolveFn(); });
    if (res.__state.ended) { clearTimeout(t); resolveFn(); }
  });
  return res;
}
async function runClear(url, method = 'DELETE') {
  const res = fakeRes();
  gpuRoute.handler({ url, headers: {}, method }, res);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

const invRoute = routes.find((r) => r.path === '/wallpaper-engine/inventory');
const invRes = await runHandler(invRoute, '/wallpaper-engine/inventory');
const invBody = JSON.parse(invRes.__state.body.toString('utf8'));
const scene = (invBody.wallpapers || []).find((w) => w.id === '990002' && w.frameUrl);
const token = scene ? scene.frameUrl.split('/').pop() : null;
check('inventory 给出 fixture 场景的 frame token', Boolean(token), token || 'missing');

if (token) {
  const keyVersion = (/LIVE_FRAME_KEY_VERSION = '([^']+)'/.exec(
    readFileSync(resolve(root, 'lib', 'index.js'), 'utf8')) || [])[1] || 'lf';
  const curKey = keyVersion + '_' + token + '_' + Math.round(statSync(join(fixtureItemDir, 'scene.pkg')).mtimeMs);
  const bucketFile = (b) => join(TEST_FRAMES_DIR, curKey + '_ar' + b + '_gpu.png');
  const B1 = 100;  // 64×64 → ar 1.00（主屏形状的替身）
  const B2 = 150;  // 1440×960 → ar 1.50（副屏/小窗形状的替身）
  const png1 = makePng(64, 64, 1);
  const png2 = makePng(1440, 960, 2);

  // ── 1. 两个形状先后落桶：都 200，两份文件共存（单槽时代第二发必 409/互踢）──
  const put1 = await runPut('/wallpaper-engine/scene-frame-cache/' + token, png1);
  const put2 = await runPut('/wallpaper-engine/scene-frame-cache/' + token, png2);
  check('两个视比先后 PUT → 都 200（分桶：第二形状不再被 409 挡住）',
    put1.__state.status === 200 && put2.__state.status === 200,
    'p1=' + put1.__state.status + ' p2=' + put2.__state.status);
  check('两份桶文件都在盘上（<key>_ar100/_ar150_gpu.png）',
    existsSync(bucketFile(B1)) && existsSync(bucketFile(B2)),
    bucketFile(B1) + ' | ' + bucketFile(B2));
  check('PUT 200 回包带桶号视比（ar 字段，诊断用）',
    JSON.parse(put2.__state.body.toString('utf8')).ar === 1.5,
    String(put2.__state.body));

  // ── 2. HEAD ?ar= 只认本桶（精确命中）──────────────────────────────────────
  const h1 = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.0');
  const h2 = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.5');
  check('HEAD ?ar=1.0 → 204 + 本桶几何 1.0000',
    h1.__state.status === 204 && h1.__state.headers['X-WE-GPU'] === '1' && h1.__state.headers['X-WE-GPU-AR'] === '1.0000',
    'status=' + h1.__state.status + ' ar=' + h1.__state.headers['X-WE-GPU-AR']);
  check('HEAD ?ar=1.5 → 204 + 本桶几何 1.5000',
    h2.__state.status === 204 && h2.__state.headers['X-WE-GPU-AR'] === '1.5000',
    'ar=' + h2.__state.headers['X-WE-GPU-AR']);

  // ── 3. HEAD 无桶形状 ⇒ 404（**不跨桶回退**——回退会让"我的桶缺了"判不出来）──
  const hMiss = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.6');
  check('HEAD ?ar=1.6（无此桶）⇒ 404，即使别的桶有帧（负对照：跨桶回退不许长回 HEAD）',
    hMiss.__state.status === 404 && hMiss.__state.headers['X-WE-GPU'] === undefined,
    'status=' + hMiss.__state.status + ' gpu=' + String(hMiss.__state.headers['X-WE-GPU']));

  // ── 4. GET 展示回退：精确桶 → 最近桶（cover 裁切，相近构图好过没有）────────
  const g1 = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token + '?ar=1.0');
  const gNear = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token + '?ar=1.6');
  check('GET ?ar=1.0 → 精确桶字节', g1.__state.status === 200 && g1.__state.body.equals(png1), g1.__state.body.length + 'B');
  check('GET ?ar=1.6 → 最近桶（1.5 比 1.0 近）字节 = 1440×960 那份',
    gNear.__state.status === 200 && gNear.__state.body.equals(png2), gNear.__state.body.length + 'B');

  // ── 5. DELETE ?ar= 只删本桶：另一个桶（= 别的窗口的帧）毫发无损 ────────────
  const clr1 = await runClear('/wallpaper-engine/scene-frame-cache/' + token + '?ar=1.0');
  check('DELETE ?ar=1.0 → 200 removed:true', clr1.__state.status === 200 && /"removed":true/.test(String(clr1.__state.body)),
    'status=' + clr1.__state.status);
  check('本桶文件已删、**另一形状的桶还在**（互踢死结的正面反证）',
    !existsSync(bucketFile(B1)) && existsSync(bucketFile(B2)));
  const clr1Again = await runClear('/wallpaper-engine/scene-frame-cache/' + token + '?ar=1.0');
  check('重复 DELETE ?ar=1.0 → 幂等成功（removed:false）',
    clr1Again.__state.status === 200 && /"removed":false/.test(String(clr1Again.__state.body)),
    String(clr1Again.__state.body));
  const h1After = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.0');
  const h2After = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.5');
  check('清完本桶 HEAD ?ar=1.0 → 404（客户端据此回填自己的桶）',
    h1After.__state.status === 404, 'status=' + h1After.__state.status);
  check('HEAD ?ar=1.5 仍 204（别的形状没有被本窗口的清除波及）',
    h2After.__state.status === 204 && h2After.__state.headers['X-WE-GPU'] === '1',
    'status=' + h2After.__state.status);

  // ── 6. 并发写：异桶并行互不阻塞；同桶唯一性闸照旧 ─────────────────────────
  await runClear('/wallpaper-engine/scene-frame-cache/' + token); // 清场：两桶都空
  const racedDiff = await Promise.all([
    runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(64, 64, 3)),
    runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(1440, 960, 4)),
  ]);
  check('两个不同视比并发 PUT → 都 200（异桶不互斥）',
    racedDiff.every((r) => r.__state.status === 200),
    racedDiff.map((r) => r.__state.status).join(','));
  await runClear('/wallpaper-engine/scene-frame-cache/' + token + '?ar=1.0'); // 只清 ar100
  const racedSame = await Promise.all([
    runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(64, 64, 5)),
    runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(64, 64, 6)),
  ]);
  const sameCodes = racedSame.map((r) => r.__state.status).sort().join(',');
  check('同桶并发 PUT → 恰好一 200 一 409（唯一性闸在同桶临界区内）',
    sameCodes === '200,409', 'codes=' + sameCodes);
  check('同桶并发未留 .tmp 垃圾',
    readdirSync(TEST_FRAMES_DIR).filter((f) => f.startsWith(curKey + '_ar' + B1 + '_gpu.png.tmp')).length === 0);

  // ── 7. 无几何字节不落桶（黑户帧永远命中不了 HEAD）─────────────────────────
  const noIhdr = await runPut('/wallpaper-engine/scene-frame-cache/' + token,
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]));
  check('PUT 魔数对但无 IHDR → 415（解析不出几何就不给落桶）', noIhdr.__state.status === 415,
    'status=' + noIhdr.__state.status);
  check('拒绝后没有产生任何新桶文件',
    readdirSync(TEST_FRAMES_DIR).filter((f) => f.startsWith(curKey + '_ar')).length === 2,
    readdirSync(TEST_FRAMES_DIR).filter((f) => f.startsWith(curKey + '_ar')).join(', '));

  // ── 8. 旧单槽（升级前产物）＝只读回退：GET 兜得住，HEAD 不冒充本桶 ────────
  await runClear('/wallpaper-engine/scene-frame-cache/' + token); // 全清（不带 ar）
  check('不带 ar 的 DELETE = 全清（桶全没了）',
    !existsSync(bucketFile(B1)) && !existsSync(bucketFile(B2)));
  const legacyPath = join(TEST_FRAMES_DIR, curKey + '_gpu.png');
  writeFileSync(legacyPath, png1); // 模拟升级前留下的单槽帧
  const gLegacy = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token + '?ar=1.0');
  check('只有旧单槽时 GET ?ar=1.0 → 回落旧帧（不 404，升级期显示不断档）',
    gLegacy.__state.status === 200 && gLegacy.__state.body.equals(png1), gLegacy.__state.body.length + 'B');
  const hLegacy = await runHead('/wallpaper-engine/scene-frame/' + token + '?ar=1.0');
  check('但 HEAD ?ar=1.0 ⇒ 404（旧单槽不冒充本视比桶 ⇒ 客户端会回填出真正的桶帧）',
    hLegacy.__state.status === 404, 'status=' + hLegacy.__state.status);
  const putAfterLegacy = await runPut('/wallpaper-engine/scene-frame-cache/' + token, png1);
  check('旧单槽在场时 PUT 本桶 → 200（旧文件不挡新桶的写入）', putAfterLegacy.__state.status === 200,
    'status=' + putAfterLegacy.__state.status);
  const fullClear = await runClear('/wallpaper-engine/scene-frame-cache/' + token);
  check('不带 ar 的 DELETE = 全清：旧单槽与本视比桶一起消失',
    fullClear.__state.status === 200 && /"removed":true/.test(String(fullClear.__state.body))
    && !existsSync(legacyPath) && !existsSync(bucketFile(B1)),
    'status=' + fullClear.__state.status);
} else {
  failed++;
  console.log('  ✗ 无法取得 token，分桶行为断言全部未执行');
}

console.log('');
console.log(failed === 0 ? 'BUCKETS PASSED (' + passed + ' checks)' : failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
