// PDF : le HTML est imprimé par Chromium (Playwright). Firefox ne sait pas produire de PDF.
import { chromium } from 'playwright';
import { UserError } from './config.ts';

const FOOTER = `<div style="font: 8pt system-ui, sans-serif; color: #666; width: 100%; text-align: center;">
<span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

/**
 * Un PDF par page HTML, avec un seul navigateur pour tous. Le contenu venant d'utilisateurs de Docs, la page
 * n'exécute aucun script et ne charge rien par le réseau (les images sont déjà intégrées en `data:`).
 * `DOCS_CHROME_PATH` : navigateur Chrome/Chromium déjà installé (poste où Playwright ne peut rien télécharger).
 */
export async function renderPdfs(pages: string[]): Promise<Buffer[]> {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.DOCS_CHROME_PATH || undefined });
  } catch (e) {
    const message = (e as Error).message;
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      throw new UserError(
        "Chromium n'est pas installé pour Playwright (le PDF ne se fait pas avec Firefox) : dans le clone de " +
          'docs-cli, `vp exec playwright install chromium`, ou DOCS_CHROME_PATH=/chemin/vers/chrome dans le .env.\n' +
          message.split('\n')[0],
      );
    }
    throw e;
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const out: Buffer[] = [];
    for (const html of pages) {
      const page = await context.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load' });
        out.push(
          await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: FOOTER,
            outline: true,
            tagged: true,
          }),
        );
      } finally {
        await page.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
