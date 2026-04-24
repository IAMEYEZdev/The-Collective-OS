import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  const context = contexts[0];

  // Find existing Google Calendar tab or create new one
  let page = null;
  for (const p of context.pages()) {
    if (p.url().includes('calendar.google.com')) {
      page = p;
      console.log('Found existing Calendar tab');
      break;
    }
  }

  if (!page) {
    page = await context.newPage();
    console.log('Opening new Calendar tab...');
    await page.goto('https://calendar.google.com', { timeout: 60000, waitUntil: 'load' });
    await page.waitForTimeout(5000);
  }

  console.log('URL:', page.url());
  await page.screenshot({ path: 'C:/Users/windows/AppData/Local/Temp/cal-step1.png' });
  console.log('Step 1 screenshot saved');

  // === EVENT 1: Thursday Group Coaching ===
  console.log('\n--- Creating Event 1: Thursday Group Coaching ---');

  // Click the create button (the + or "Create" button)
  try {
    // Try the floating action button first
    const createBtn = page.locator('[data-action="create"], [aria-label="Create"], button:has-text("Create")').first();
    await createBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log('Create button not found via selector, trying keyboard shortcut');
    await page.keyboard.press('c'); // Google Calendar shortcut
    await page.waitForTimeout(1500);
  }

  await page.screenshot({ path: 'C:/Users/windows/AppData/Local/Temp/cal-step2-create.png' });

  // Type title
  await page.keyboard.type('Prolific AI - Group Coaching (Dar Holdsworth)');
  await page.waitForTimeout(500);

  // Click "More options" to get full form
  try {
    const moreOpts = page.locator('button:has-text("More options"), [aria-label="More options"]').first();
    await moreOpts.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    console.log('More options not found:', e.message);
  }

  await page.screenshot({ path: 'C:/Users/windows/AppData/Local/Temp/cal-step3-form.png' });
  console.log('Event form screenshot saved');

  // Close this page so Jackson can work
  // We'll report screenshots for manual verification
  console.log('\nScreenshots saved. Check C:/Users/windows/AppData/Local/Temp/cal-step*.png');
  console.log('Done.');
}

main().catch(e => console.error('Fatal:', e.message));
