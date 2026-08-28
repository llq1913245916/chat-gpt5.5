import test from 'node:test';
import assert from 'node:assert/strict';
import {
  armGenerationLifecycle,
  resolveGenerationLifecycle,
  sendChatTurn,
  validateAssistantNodeDelta,
  validateTransportConfig,
} from '../src/adapters/playwright-agent.js';

function baseConfig() {
  return {
    name: 'test',
    url: 'https://example.invalid',
    profileDir: '.profile',
    selectors: { input: 'textarea', assistantMessage: '.assistant' },
    session: { newConversationSelector: '.new-chat' },
    completion: { generatingSelector: '.generating' },
  };
}

test('transport requires fresh conversation and authoritative completion by default', () => {
  const noFresh = baseConfig();
  delete noFresh.session.newConversationSelector;
  assert.throws(() => validateTransportConfig(noFresh), /freshConversationUrl or session.newConversationSelector/);

  const noSignal = baseConfig();
  delete noSignal.completion.generatingSelector;
  assert.throws(() => validateTransportConfig(noSignal), /authoritative completion signal/);
  noSignal.completion.allowStabilityFallback = true;
  assert.doesNotThrow(() => validateTransportConfig(noSignal));
});

test('missing generation start requires explicit unsafe fallback', async () => {
  const config = baseConfig();
  config.completion.allowMissingGenerationStart = true;
  assert.throws(() => validateTransportConfig(config), /requires allowStabilityFallback=true/);

  const fakePage = {
    locator() {
      return { first() { return { async waitFor({ state }) { if (state === 'visible') throw new Error('not seen'); } }; } };
    },
  };
  const watch = armGenerationLifecycle({ page: fakePage, completion: { generatingSelector: '.g', startTimeoutMs: 1 }, timeoutMs: 10 });
  await assert.rejects(() => resolveGenerationLifecycle({
    watch,
    response: {},
    completion: { generatingSelector: '.g' },
    responseStableMs: 1,
    timeoutMs: 10,
    waitForStableText: async () => {},
    name: 'test',
  }), /generation lifecycle was not observed/);
});

test('generation lifecycle is armed before send and may finish before final-only response node appears', async () => {
  const events = [];
  let messageCount = 0;
  let hiddenCalls = 0;

  const generating = {
    async waitFor({ state }) {
      if (state === 'hidden') {
        hiddenCalls += 1;
        if (hiddenCalls === 1) events.push('idle-hidden');
        else {
          events.push('generation-ended');
          messageCount = 1;
        }
        return;
      }
      if (state === 'visible') {
        events.push('generation-start-observed');
        return;
      }
    },
  };

  const response = {
    async waitFor() { events.push('response-visible'); },
    async innerText() { return 'complete answer'; },
    locator() { throw new Error('no done selector'); },
  };
  const input = {
    async fill() { events.push('filled'); },
    async press() { events.push('pressed'); },
  };
  const sendButton = {
    async click() { events.push('clicked'); },
  };
  const messages = {
    async count() { return messageCount; },
    nth() { return response; },
  };

  const page = {
    locator(selector) {
      if (selector === '.assistant-final') return messages;
      if (selector === 'textarea') return { first() { return input; } };
      if (selector === 'button.send') return { first() { return sendButton; } };
      if (selector === '.generating') return { first() { return generating; } };
      throw new Error(`unexpected selector ${selector}`);
    },
    async waitForFunction() {
      events.push('wait-final-response-node');
      assert.equal(messageCount, 1, 'final response should only appear after generation ended');
    },
  };

  const text = await sendChatTurn({
    page,
    selectors: { input: 'textarea', send: 'button.send', assistantMessage: '.assistant-final' },
    completion: { generatingSelector: '.generating' },
    message: 'hello',
    responseStableMs: 1,
    timeoutMs: 50,
    waitForStableText: async () => { throw new Error('should not use fallback'); },
    name: 'test',
  });

  assert.equal(text, 'complete answer');
  assert.ok(events.indexOf('generation-start-observed') < events.indexOf('wait-final-response-node'));
  assert.ok(events.indexOf('generation-ended') < events.indexOf('wait-final-response-node'));
  assert.ok(events.indexOf('clicked') < events.indexOf('generation-start-observed'));
});

test('assistant node delta rejects stale or multi-node append by default', () => {
  assert.throws(() => validateAssistantNodeDelta({ beforeCount: 2, afterCount: 4, name: 'test' }), /produced 2 assistant nodes/);
  assert.doesNotThrow(() => validateAssistantNodeDelta({ beforeCount: 2, afterCount: 3, name: 'test' }));
});
