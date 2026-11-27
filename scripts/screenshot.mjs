#!/usr/bin/env node
// The screenshots in the README: the demo vault (docs/demo) with its "Damped pendulum" note open.
//   docs/screenshot.png          the desktop app, with the backlinks beside the note
//   docs/screenshot-phone.png    the phone layout, as on Android (the same interface, at the
//                                width of a phone; without the system's bars)
//
// Usage: pnpm screenshot [--phone] [out.png]   (builds the desktop app first; needs Playwright)
//
// The vault is copied to a temporary folder, and the app runs with a profile of its own, so
// neither the repository nor your own Pumice settings are changed.
import { _electron as electron } from 'playwright';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const phone = args.includes('--phone');
const given = args.find((a) => !a.startsWith('--'));
const out = resolve(
  given ?? join(root, phone ? 'docs/screenshot-phone.png' : 'docs/screenshot.png'),
);
const desktop = join(root, 'apps/desktop');
const electronPath = createRequire(join(desktop, 'package.json'))('electron');

const work = realpathSync(mkdtempSync(join(tmpdir(), 'pumice-screenshot-')));
const vault = join(work, 'Demo');
cpSync(join(root, 'docs/demo'), vault, { recursive: true });

const app = await electron.launch({
  executablePath: electronPath,
  args: [desktop, `--user-data-dir=${join(work, 'profile')}`],
  env: { ...process.env, PUMICE_VAULT: vault, PUMICE_NO_UPDATES: '1' },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  // Desktop: 1560 × 1130 points (3024 × 1898 pixels of content on a Retina screen).
  // Phone: the content of a 412 × 892 point phone screen, the size of a common Android phone.
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (size.content) window.setContentSize(size.width, size.height);
      else window.setSize(size.width, size.height);
      window.center();
    },
    phone ? { width: 412, height: 892, content: true } : { width: 1560, height: 1130 },
  );
  await page.waitForSelector('.pm-ribbon', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');
  if (phone) {
    // The note, as a phone opens it (the file list is a drawer there).
    await page.waitForSelector('.pm-layout-phone', { timeout: 10000 });
    const files = page.locator('.pm-sidebar');
    const note = files.getByText('Damped pendulum', { exact: true });
    if (!(await note.isVisible().catch(() => false)))
      await page.locator('.pm-phone-bar button[aria-label="Files"]').click();
    await note.click();
  } else {
    const files = page.locator('.pm-sidebar');
    await files.getByText('Notes', { exact: true }).click();
    await files.getByText('Damped pendulum', { exact: true }).click();
  }
  await page.waitForSelector('.pm-markdown-page .cm-content');
  // The backlinks, beside the note.
  if (!phone) {
    if (
      !(await page
        .locator('.pm-sidebar-right')
        .isVisible()
        .catch(() => false))
    )
      await page.locator('.pm-ribbon button[title="Toggle right sidebar"]').click();
    await page.locator('.pm-sidebar-right .pm-panel-tabs button[title="Backlinks"]').click();
  }
  // Formulas, pictures and the drawing are drawn by then.
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(phone ? 5 : 700, phone ? 5 : 1120);
  await page.waitForTimeout(500);
  await page.screenshot({ path: out });
  console.log(`Written: ${out}`);
} finally {
  await app.close().catch(() => app.process().kill('SIGKILL'));
  rmSync(work, { recursive: true, force: true });
}
