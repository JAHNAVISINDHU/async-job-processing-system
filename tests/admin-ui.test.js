const puppeteer = require('puppeteer');

jest.setTimeout(30000);

const isCI = !!process.env.CI;
const adminUser = process.env.ADMIN_USER;
const adminPass = process.env.ADMIN_PASS;

if (isCI && !(adminUser && adminPass)) {
  // In CI without admin credentials configured, skip this E2E auth test to avoid flakiness.
  test.skip('admin UI loads and shows Failed Jobs heading (skipped in CI - ADMIN_USER/ADMIN_PASS not set)', async () => {});
} else {
  test('admin UI loads and shows Failed Jobs heading', async () => {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    // Read admin creds from env if present and set Basic Auth header
    if (adminUser && adminPass) {
      await page.setExtraHTTPHeaders({ Authorization: 'Basic ' + Buffer.from(`${adminUser}:${adminPass}`).toString('base64') });
    }

    await page.goto('http://localhost:3000/admin/ui', { waitUntil: 'networkidle0' });
    const h1 = await page.$eval('h1', el => el.innerText);
    expect(h1).toMatch(/Failed Jobs/i);

    // Ensure table exists
    const tableExists = await page.$('table') !== null;
    expect(tableExists).toBe(true);

    await browser.close();
  });
}