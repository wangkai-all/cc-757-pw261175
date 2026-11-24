/**
 * Local-only headless browser driver for manual verification and screenshots.
 * Not part of the app; not run by `npm test`.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const URL = process.env.APP_URL || 'http://127.0.0.1:4173/';
const OUT = process.env.OUT_DIR || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1020 }, deviceScaleFactor: 2 });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/01-initial.png`, fullPage: false });

console.log('TITLE', await page.title());
console.log('SAMPLES', await page.locator('.sample-card').count());

// Solve the default sample.
await page.getByRole('button', { name: /^求解$/ }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/02-solved.png` });
const statusText = await page.locator('.status-chip').innerText();
console.log('STATUS', statusText);
console.log('SVG', await page.locator('svg.tree-canvas').count());
console.log('BODY', (await page.locator('.pane-right').innerText()).slice(0, 1200));

// Hover an edge to show the tooltip
const hit = page.locator('path.hit').first();
if (await hit.count()) {
  await hit.hover({ force: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/03-hover.png` });
}

// Switch to candidate trees tab
await page.getByRole('tab', { name: /候选树/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/04-ties.png` });

// Toggle ordered/unordered in cost editor
await page.getByRole('tab', { name: /特征与代价/ }).first().click();
await page.waitForTimeout(200);
await page.locator('.feature-tab').nth(1).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/05-costs-ordered.png` });

// Missing cell edit: open a cell select and pick 未观测
await page.locator('table.matrix tbody tr').first().locator('td.cell button').first().click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/06-cell-edit.png` });
await page.keyboard.press('Escape');

// Conflict sample: expect an explicit refusal
await page.locator('.sample-card', { hasText: '互斥锁定样例' }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/07-conflict.png` });
console.log('CONFLICT_BODY', (await page.locator('.pane-left').innerText()).slice(0, 900));

// Equal-cost sample
await page.locator('.sample-card', { hasText: '同代价多解演示' }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /^求解$/ }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/08-equal.png` });

console.log('ERRORS', errors);
await browser.close();
