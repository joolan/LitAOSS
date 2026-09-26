// 预览渲染自检（开发用）：
//   1. 先启动前端 dev server（npm run dev）
//   2. 运行 node previewTest.mjs
// 校验 XLSX/DOCX/PDF 查看器渲染、cmaps 静态资源与控制台错误，输出 preview-harness.png 截图
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3000';
const report = { checks: [], errors: [] };

function check(name, ok, detail = '') {
  report.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
page.on('pageerror', (e) => report.errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') report.errors.push('console.error: ' + m.text());
});

try {
  await page.goto(`${BASE}/preview-harness.html`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#status', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready', null, { timeout: 30000 });
  check('harness status = ready', true);

  // ---- XLSX ----
  await page.waitForSelector('#panel-xlsx table tbody tr', { timeout: 15000 });
  const sheetTabs = await page.$$eval('#panel-xlsx button', (btns) => btns.map((b) => b.textContent?.trim()));
  check('xlsx sheet tabs', sheetTabs.join(',') === '员工,财务', sheetTabs.join(','));
  const firstRow = await page.$eval('#panel-xlsx table tbody tr', (tr) => tr.textContent);
  check('xlsx row content', firstRow.includes('研发部') && firstRow.includes('25000'), firstRow);
  const headerRow = await page.$eval('#panel-xlsx table thead tr:nth-child(2)', (tr) => tr.textContent);
  check('xlsx header row', headerRow.includes('姓名') && headerRow.includes('薪资'), headerRow);
  await page.click('#panel-xlsx button:nth-of-type(2)');
  await page.waitForFunction(() => document.querySelector('#panel-xlsx table tbody')?.textContent?.includes('150万'), null, { timeout: 5000 });
  check('xlsx sheet switch (财务)', true);
  await page.click('#panel-xlsx button:nth-of-type(1)');

  // ---- DOCX ----
  await page.waitForSelector('#panel-docx .docx-wrapper', { timeout: 20000 });
  const docxText = await page.$eval('#panel-docx', (el) => el.textContent || '');
  check('docx text render', docxText.includes('LitAOSS Document Preview Test'), docxText.slice(0, 200));
  check('docx paragraph count', (await page.$$('#panel-docx .docx-wrapper p')).length >= 3);

  // ---- PDF ----
  await page.waitForSelector('#panel-pdf canvas', { timeout: 30000 });
  const pdfText = await page.$eval('#panel-pdf', (el) => el.textContent || '');
  check('pdf page indicator', /第 1 \/ 1 页/.test(pdfText), pdfText.slice(0, 120));
  const textLayer = await page
    .$eval('#panel-pdf .react-pdf__Page__textContent', (el) => el.textContent || '')
    .catch(() => '');
  check('pdf text layer', textLayer.includes('LitAOSS PDF Preview Test'), textLayer.slice(0, 200));
  const canvasStats = await page.$eval('#panel-pdf canvas', (c) => {
    const ctx = c.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
    }
    return { width, height, nonWhite };
  });
  check('pdf canvas non-blank', canvasStats.nonWhite > 50, JSON.stringify(canvasStats));

  // ---- cMaps served ----
  const cmapStatus = await page.evaluate(async () => {
    try {
      const r = await fetch('/cmaps/UniGB-UCS2-H.bcmap');
      return r.status;
    } catch (e) {
      return 'error: ' + e.message;
    }
  });
  check('cmaps served (/cmaps/*.bcmap)', cmapStatus === 200, 'status=' + cmapStatus);

  // ---- PPTX（窗口化渲染：仅挂载滚动可见的幻灯片，需滚动逐页验证）----
  await page.waitForFunction(
    () => (document.querySelector('#panel-pptx')?.textContent || '').includes('R0C2'),
    null,
    { timeout: 60000 },
  );
  const pptxTop = await page.$eval('#panel-pptx', (el) => el.textContent || '');
  check('pptx 第1-2页（标题/要点/表格/中文）', pptxTop.includes('PPTX Preview Test') && pptxTop.includes('First bullet item') && pptxTop.includes('中文内容测试') && pptxTop.includes('R2C2'), pptxTop.slice(0, 150));

  await page.$eval('#panel-pptx .overflow-auto', (el) => el.scrollTo({ top: el.scrollHeight * 0.55 }));
  await page.waitForFunction(
    () => (document.querySelector('#panel-pptx')?.textContent || '').includes('Chart Slide'),
    null,
    { timeout: 30000 },
  );
  await page
    .waitForFunction(
      () => document.querySelectorAll('#panel-pptx [data-slide-index="2"] canvas, #panel-pptx [data-slide-index="2"] svg').length > 0,
      null,
      { timeout: 30000 },
    )
    .catch(() => {});
  const chartFigs = await page.$$eval('#panel-pptx [data-slide-index="2"] canvas, #panel-pptx [data-slide-index="2"] svg', (els) => els.length);
  check('pptx 第3页图表渲染', chartFigs > 0, 'chart elements=' + chartFigs);

  await page.$eval('#panel-pptx .overflow-auto', (el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForFunction(
    () => (document.querySelector('#panel-pptx')?.textContent || '').includes('Shapes Slide'),
    null,
    { timeout: 30000 },
  );
  const pptxBottom = await page.$eval('#panel-pptx', (el) => el.textContent || '');
  check('pptx 第4页图形', pptxBottom.includes('Shapes Slide') && pptxBottom.includes('Rounded Rectangle'), pptxBottom.slice(-150));

  await page.screenshot({ path: 'preview-harness.png', fullPage: true });
} catch (e) {
  report.errors.push('fatal: ' + (e && e.message ? e.message : e));
  try {
    await page.screenshot({ path: 'preview-harness-fail.png', fullPage: true });
  } catch {}
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
const failed = report.checks.filter((c) => !c.ok).length + (report.errors.length ? 1 : 0);
process.exit(failed ? 1 : 0);
