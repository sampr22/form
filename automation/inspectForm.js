// Inspection-only utility. Never clicks Submit.

import { chromium } from 'playwright';

const FORM_URL =
  process.env.FORM_URL ||
  'https://forms.cloud.microsoft/pages/responsepage.aspx?id=0AXnVXRck0GwwTa-4NQ-bvGJJtgnRZ5Fseet11Dp2IdUNDM3UUNaSVQySjBDSzc5WExJUzVOM0lLNS4u&origin=lprLink&route=shorturl';

const WAIT_MS = Number(process.env.INSPECT_WAIT_MS || 120000);

async function inspectForm() {
  console.log('[FORM] Launching browser (headed)');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('[FORM] Opening Microsoft Forms');
    await page.goto(FORM_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    const textboxes = await page.getByRole('textbox').all();
    console.log(`\n[FORM] Found ${textboxes.length} textbox fields:`);

    for (let i = 0; i < textboxes.length; i++) {
      const questionText = await textboxes[i].evaluate((node) => {
        let current = node;
        for (let depth = 0; depth < 8 && current; depth++) {
          current = current.parentElement;
          if (!current) break;
          const heading = current.querySelector('[role="heading"], h1, h2, h3, h4, h5, label');
          if (heading?.innerText?.trim()) return heading.innerText.trim();
        }
        return null;
      });
      console.log(`  [text ${i}] question: "${questionText || '(not found)'}"`);
    }

    const radios = await page.getByRole('radio').all();
    console.log(`\n[FORM] Found ${radios.length} radio options:`);

    const checkboxes = await page.getByRole('checkbox').all();
    console.log(`\n[FORM] Found ${checkboxes.length} checkbox options:`);

    const selects = await page.getByRole('combobox').all();
    console.log(`\n[FORM] Found ${selects.length} dropdown/combobox fields:`);

    const submitBtn = page.getByRole('button', { name: /submit/i });
    console.log(`[FORM] Submit button detected: ${await submitBtn.count() > 0 ? 'YES' : 'NO'}`);
    console.log('[FORM] Submission intentionally NOT triggered.');

    console.log(`\n[FORM] Browser staying open for ${Math.round(WAIT_MS / 1000)} seconds.`);
    await page.waitForTimeout(WAIT_MS);
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}

inspectForm().catch((err) => {
  console.error('[ERROR]', err.message || err);
  process.exit(1);
});
