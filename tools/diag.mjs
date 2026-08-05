import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, resp) => {
  const url = new URL(req.url, 'http://localhost');
  let p = join(ROOT, decodeURIComponent(url.pathname));
  if (!existsSync(p) || url.pathname === '/') p = join(ROOT, 'index.html');
  try {
    const b = await readFile(p);
    resp.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
    resp.end(b);
  } catch {
    resp.writeHead(404);
    resp.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const COMBOS = [
  { name: 'baseline-swiftshader', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--no-sandbox'] },
  { name: 'gpu-vulkan-lavapipe', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--no-sandbox'] },
  { name: 'newheadless-gpu', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--no-sandbox', '--enable-gpu', '--headless=new'] },
  { name: 'swiftshader-webgl-only', args: ['--use-angle=swiftshader', '--no-sandbox', '--disable-features=WebGPU'] },
];

for (const combo of COMBOS) {
  let browser;
  try {
    browser = await chromium.launch({ args: combo.args });
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(6000);
    const info = await page.evaluate(async () => {
      const c = document.getElementById('stage');
      // Ask the page itself what non-black pixels it can see, two different ways.
      let domToDataUrlLen = -1;
      try {
        domToDataUrlLen = c.toDataURL('image/png').length;
      } catch (e) {
        domToDataUrlLen = -2;
      }
      return {
        spike: window.__SPIKE__,
        canvasW: c.width,
        canvasH: c.height,
        domToDataUrlLen,
      };
    });
    const shot = await page.screenshot();
    // Count non-near-black pixels in the PNG by decoding through the page.
    const nonBlack = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 25 || d[i + 1] > 25 || d[i + 2] > 25) n++;
      return n;
    }, shot.toString('base64'));
    console.log(combo.name, '=>', JSON.stringify({ ...info, screenshotNonBlackPx: nonBlack, errs: errs.slice(0, 2) }));
  } catch (e) {
    console.log(combo.name, '=> LAUNCH/RUN FAIL:', e.message.split('\n')[0]);
  } finally {
    await browser?.close().catch(() => {});
  }
}
server.close();
