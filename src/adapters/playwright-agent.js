import { chromium } from 'playwright';

export class PlaywrightChatAgent {
  constructor(config) {
    this.config = {
      headless: false,
      timeoutMs: 120000,
      responseStableMs: 1800,
      ...config,
    };
    this.context = null;
    this.page = null;
  }

  async open() {
    const { profileDir, headless, url, timeoutMs } = this.config;
    if (!profileDir || !url) throw new Error(`${this.config.name || 'agent'} requires profileDir and url`);

    this.context = await chromium.launchPersistentContext(profileDir, { headless });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(timeoutMs);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    return this;
  }

  async send(message) {
    if (!this.page) throw new Error('Agent is not open');
    const { selectors, responseStableMs, timeoutMs } = this.config;
    if (!selectors?.input || !selectors?.assistantMessage) {
      throw new Error(`${this.config.name || 'agent'} selectors.input and selectors.assistantMessage are required`);
    }

    const messages = this.page.locator(selectors.assistantMessage);
    const beforeCount = await messages.count();
    const input = this.page.locator(selectors.input).first();
    await input.fill(message);

    if (selectors.send) {
      await this.page.locator(selectors.send).first().click();
    } else {
      await input.press('Enter');
    }

    await this.page.waitForFunction(
      ({ selector, before }) => document.querySelectorAll(selector).length > before,
      { selector: selectors.assistantMessage, before: beforeCount },
      { timeout: timeoutMs },
    );

    const latest = messages.last();
    const started = Date.now();
    let lastText = '';
    let stableSince = Date.now();

    while (Date.now() - started < timeoutMs) {
      const text = (await latest.innerText()).trim();
      if (text && text === lastText) {
        if (Date.now() - stableSince >= responseStableMs) return text;
      } else {
        lastText = text;
        stableSince = Date.now();
      }
      await this.page.waitForTimeout(400);
    }

    throw new Error(`${this.config.name || 'agent'} response did not stabilize before timeout`);
  }

  async close() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
