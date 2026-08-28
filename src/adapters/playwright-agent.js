import { chromium } from 'playwright';

export function validateTransportConfig(config) {
  const name = config?.name || 'agent';
  if (!config?.profileDir || !config?.url) {
    throw new Error(`${name} requires profileDir and url`);
  }
  if (!config?.selectors?.input || !config?.selectors?.assistantMessage) {
    throw new Error(`${name} selectors.input and selectors.assistantMessage are required`);
  }

  const session = config.session ?? {};
  const hasFreshConversationAction = Boolean(
    session.freshConversationUrl || session.newConversationSelector,
  );
  if (!hasFreshConversationAction && !session.allowUnverifiedConversation) {
    throw new Error(`${name} must configure session.freshConversationUrl or session.newConversationSelector`);
  }

  const completion = config.completion ?? {};
  const hasAuthoritativeCompletion = Boolean(
    completion.generatingSelector || completion.doneSelector,
  );
  if (!hasAuthoritativeCompletion && completion.allowStabilityFallback !== true) {
    throw new Error(`${name} must configure an authoritative completion signal or explicitly allow the unsafe stability fallback`);
  }
  if (
    completion.generatingSelector
    && completion.allowMissingGenerationStart === true
    && completion.allowStabilityFallback !== true
  ) {
    throw new Error(`${name} allowMissingGenerationStart requires allowStabilityFallback=true`);
  }
}

export function armGenerationLifecycle({
  page,
  completion = {},
  timeoutMs,
  name = 'agent',
}) {
  if (!completion.generatingSelector) return null;
  const generating = page.locator(completion.generatingSelector).first();

  return (async () => {
    await generating.waitFor({
      state: 'hidden',
      timeout: completion.idleTimeoutMs ?? 3000,
    });
    await generating.waitFor({
      state: 'visible',
      timeout: completion.startTimeoutMs ?? 10000,
    });
    await generating.waitFor({ state: 'hidden', timeout: timeoutMs });
    return { ok: true };
  })().catch((error) => ({ ok: false, error, name }));
}

export async function resolveGenerationLifecycle({
  watch,
  response,
  completion = {},
  responseStableMs,
  timeoutMs,
  waitForStableText,
  name = 'agent',
}) {
  if (!watch) return;
  const result = await watch;
  if (result.ok) return;

  if (completion.allowMissingGenerationStart !== true) {
    throw new Error(
      `${name} generation lifecycle was not observed; refusing to return a potentially partial response`,
      { cause: result.error },
    );
  }

  await waitForStableText(response, responseStableMs, timeoutMs);
}

export function validateAssistantNodeDelta({
  beforeCount,
  afterCount,
  requireSingleAssistantNode = true,
  name = 'agent',
}) {
  const delta = afterCount - beforeCount;
  if (delta < 1) {
    throw new Error(`${name} did not produce a new assistant response node`);
  }
  if (requireSingleAssistantNode && delta !== 1) {
    throw new Error(
      `${name} produced ${delta} assistant nodes; configure assistantMessage to identify exactly one response container per turn`,
    );
  }
}

export async function sendChatTurn({
  page,
  selectors,
  completion = {},
  message,
  responseStableMs,
  timeoutMs,
  waitForStableText,
  name = 'agent',
}) {
  const messages = page.locator(selectors.assistantMessage);
  const beforeCount = await messages.count();
  const input = page.locator(selectors.input).first();
  await input.fill(message);

  const generationWatch = completion.generatingSelector
    ? armGenerationLifecycle({ page, completion, timeoutMs, name })
    : null;

  if (selectors.send) {
    await page.locator(selectors.send).first().click();
  } else {
    await input.press('Enter');
  }

  if (generationWatch) {
    const provisionalResponse = messages.nth(beforeCount);
    await resolveGenerationLifecycle({
      watch: generationWatch,
      response: provisionalResponse,
      completion,
      responseStableMs,
      timeoutMs,
      waitForStableText,
      name,
    });
  }

  await page.waitForFunction(
    ({ selector, before }) => document.querySelectorAll(selector).length > before,
    { selector: selectors.assistantMessage, before: beforeCount },
    { timeout: timeoutMs },
  );

  const response = messages.nth(beforeCount);
  await response.waitFor({ state: 'visible' });

  if (completion.doneSelector) {
    await response.locator(completion.doneSelector).first().waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
  } else if (!generationWatch) {
    await waitForStableText(response, responseStableMs, timeoutMs);
  }

  const afterCount = await messages.count();
  validateAssistantNodeDelta({
    beforeCount,
    afterCount,
    requireSingleAssistantNode: completion.requireSingleAssistantNode !== false,
    name,
  });

  const text = (await response.innerText()).trim();
  if (!text) throw new Error(`${name} returned an empty assistant response`);
  return text;
}

export class PlaywrightChatAgent {
  constructor(config) {
    this.config = {
      headless: false,
      timeoutMs: 120000,
      responseStableMs: 1800,
      ...config,
    };
    validateTransportConfig(this.config);
    this.context = null;
    this.page = null;
    this.sessionId = null;
  }

  async open() {
    const { profileDir, headless } = this.config;
    this.context = await chromium.launchPersistentContext(profileDir, { headless });
    return this;
  }

  async startSession(sessionId) {
    if (!this.context) throw new Error('Agent is not open');
    const { url, timeoutMs, session = {} } = this.config;

    await this.page?.close().catch(() => {});
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(timeoutMs);

    const targetUrl = session.freshConversationUrl || url;
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    if (session.newConversationSelector) {
      await this.page.locator(session.newConversationSelector).first().click();
    }

    if (session.readySelector) {
      await this.page.locator(session.readySelector).first().waitFor({ state: 'visible' });
    }

    this.sessionId = sessionId;
    return this;
  }

  async send(message) {
    if (!this.page || !this.sessionId) throw new Error('Agent session is not started');
    const { selectors, completion = {}, responseStableMs, timeoutMs } = this.config;
    return sendChatTurn({
      page: this.page,
      selectors,
      completion,
      message,
      responseStableMs,
      timeoutMs,
      waitForStableText: this.#waitForStableText.bind(this),
      name: this.config.name || 'agent',
    });
  }

  async #waitForStableText(locator, stableMs, timeoutMs) {
    const started = Date.now();
    let lastText = '';
    let stableSince = Date.now();

    while (Date.now() - started < timeoutMs) {
      const text = (await locator.innerText()).trim();
      if (text && text === lastText) {
        if (Date.now() - stableSince >= stableMs) return;
      } else {
        lastText = text;
        stableSince = Date.now();
      }
      await this.page.waitForTimeout(400);
    }

    throw new Error(`${this.config.name || 'agent'} response did not stabilize before timeout`);
  }

  async close() {
    await this.page?.close().catch(() => {});
    await this.context?.close();
    this.context = null;
    this.page = null;
    this.sessionId = null;
  }
}
