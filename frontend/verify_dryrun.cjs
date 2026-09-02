const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bboxes = {};           // label -> bbox string, harvested from /api request URLs
const apiErrors = [];

function recordBbox(url) {
  const m = url.match(/[?&]bbox=([^&]+)/);
  if (m) {
    const [minLon, minLat, maxLon, maxLat] = decodeURIComponent(m[1]).split(',').map(Number);
    return { raw: m[1], spanLon: +(maxLon - minLon).toFixed(1), spanLat: +(maxLat - minLat).toFixed(1) };
  }
  return null;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let lastBbox = null;
  page.on('request', r => { const b = recordBbox(r.url()); if (b) lastBbox = b; });
  page.on('response', r => { if (r.status() >= 500 && r.url().includes('/api/')) apiErrors.push(`HTTP ${r.status()} ${r.url().split('/api/')[1].split('?')[0]}`); });
  page.on('console', m => { if (/error/i.test(m.text()) && !/Failed to load resource/.test(m.text())) console.log('  page-err:', m.text().slice(0, 160)); });

  const region = async () => (await page.locator('text=/📍/').allTextContents()).filter(s => !/Click on globe/.test(s));
  const back = async () => { const b = page.locator('button:has-text("Back to Globe")'); if (await b.count()) { await b.click(); await sleep(1500); } };
  const wsOpen = async () => (await page.locator('text=/Volume Workspace|Isosurface Workspace/').count()) > 0;

  await page.goto('http://localhost/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const el = document.querySelector('#var-select'); return el && el.value; }, { timeout: 60000 });
  console.log('var:', await page.locator('#var-select').inputValue());

  const cb = await page.locator('#tarang-canvas').boundingBox();
  const cx = cb.x + cb.width / 2, cy = cb.y + cb.height / 2;

  async function renderAll(tag) {
    for (const mode of ['slice', 'volume', 'isosurface']) {
      await page.click(`#render-mode-${mode}`);
      await sleep(mode === 'slice' ? 9000 : 20000);
      if (mode !== 'slice') {
        console.log(`  ${tag} ${mode}: workspace open =`, await wsOpen(), '  bbox', JSON.stringify(lastBbox));
        await page.screenshot({ path: `dry_${tag}_${mode}.png` });
        await back();
        console.log(`  ${tag} ${mode}: workspace closed =`, !(await wsOpen()));
      } else {
        console.log(`  ${tag} slice rendered (bbox ${JSON.stringify(lastBbox)})`);
        await page.screenshot({ path: `dry_${tag}_slice.png` });
      }
    }
  }

  // ─── REGION 1: name search ───────────────────────────────────────
  await page.fill('#region-search-input', 'bay of bengal');
  await page.press('#region-search-input', 'Enter');
  await sleep(8000);
  console.log('REGION 1 (search):', JSON.stringify(await region()), 'bbox', JSON.stringify(lastBbox));
  await renderAll('search');

  // ─── REGION 2: large drag (must clamp) ──────────────────────────
  await page.click('#render-mode-slice'); await sleep(500);
  await page.click('#map-select-drag'); await sleep(300);
  await page.mouse.move(cx - 150, cy - 140); await page.mouse.down();
  await page.mouse.move(cx - 30, cy - 20, { steps: 14 });
  await page.mouse.move(cx + 160, cy + 150, { steps: 14 });
  await page.mouse.up();
  await sleep(4000);
  console.log('REGION 2 (drag):', JSON.stringify(await region()), 'bbox', JSON.stringify(lastBbox));
  await renderAll('drag');

  // ─── click clamp check ─────────────────────────────────────────
  await page.click('#render-mode-slice'); await sleep(500);
  await page.click('#map-select-click'); await sleep(300);
  await page.mouse.click(cx - 20, cy - 10);
  await sleep(3500);
  console.log('CLICK region:', JSON.stringify(await region()), 'bbox', JSON.stringify(lastBbox));

  // ─── search overrides custom pick ──────────────────────────────
  await page.fill('#region-search-input', 'arabian sea');
  await page.press('#region-search-input', 'Enter');
  await sleep(4000);
  console.log('after "arabian sea" ENTER:', JSON.stringify(await region()));

  console.log('\nAPI 5xx errors:', apiErrors.length ? JSON.stringify([...new Set(apiErrors)]) : 'none');
  await browser.close();
})();
