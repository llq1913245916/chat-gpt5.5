import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAssistantNodeDelta,
  validateTransportConfig,
  waitForCompletionSignal,
} from '../src/adapters/playwright-agent.js';

function baseConfig() {
  return {
    name: 'test',
    url: 'https://example.invalid',
    profileDir: '.profile',
    selectors: {
      input: 'textarea',
      assistantMessage: '.assistant',
    },
    session: {
      newConversationSelector: '.new-chat',
    },
    completion: {
      generatingSelector: '.generating',
    },
  };
}

function fakePageWithGenerating(waitForImpl) {
  const generating = { waitFor: waitForImpl };
  return {
    locator() {
      return {
        first() { return generating; },
      };
    },
  };
}

test('transport rejects unverified conversation reuse by default', () => {
  const config = baseConfig();
  delete config.session.newConversationSelector;
  assert.throws(
    () => validateTransportConfig(config),
    /freshConversationUrl or session.newConversationSelector/,
  );
});

test('transport rejects text-stability-only completion unless explicitly opted in', () => {
  const config = baseConfig();
  delete config.completion.generatingSelector;
  assert.throws(() => validateTransportConfig(config), /authoritative completion signal/);

  config.completion.allowStabilityFallback = true;
  assert.doesNotThrow(() => validateTransportConfig(config));
});

test('allowMissingGenerationStart requires explicit unsafe stability fallback', () => {
  const config = baseConfig();
  config.completion.allowMissingGenerationStart = true;
  assert.throws(() => validateTransportConfig(config), /requires allowStabilityFallback=true/);

  config.completion.allowStabilityFallback = true;
  assert.doesNotThrow(() => validateTransportConfig(config));
});

test('generatingSelector fails closed when generation start is never observed', async () => {
  const page = fakePageWithGenerating(async ({ state }) => {
    if (state === 'visible') throw new Error('not found');
  });

  await assert.rejects(
    () => waitForCompletionSignal({
      page,
      response: {},
      completion: { generatingSelector: '.generating', startTimeoutMs: 5 },
      responseStableMs: 5,
      timeoutMs: 50,
      waitForStableText: async () => {},
      name: 'test',
    }),
    /generation-start signal was not observed/,
  );
});

test('generatingSelector may use explicit unsafe fallback only when configured', async () => {
  let fallbackCalled = false;
  const page = fakePageWithGenerating(async ({ state }) => {
    if (state === 'visible') throw new Error('not found');
  });

  await waitForCompletionSignal({
    page,
    response: {},
    completion: {
      generatingSelector: '.generating',
      allowMissingGenerationStart: true,
      allowStabilityFallback: true,
      startTimeoutMs: 5,
    },
    responseStableMs: 5,
    timeoutMs: 50,
    waitForStableText: async () => { fallbackCalled = true; },
    name: 'test',
  });

  assert.equal(fallbackCalled, true);
});

test('generatingSelector requires visible start before hidden completion', async () => {
  const states = [];
  const page = fakePageWithGenerating(async ({ state }) => {
    states.push(state);
  });

  await waitForCompletionSignal({
    page,
    response: {},
    completion: { generatingSelector: '.generating' },
    responseStableMs: 5,
    timeoutMs: 50,
    waitForStableText: async () => {},
    name: 'test',
  });

  assert.deepEqual(states, ['visible', 'hidden']);
});

test('assistant node correlation rejects stale/multi-node append by default', () => {
  assert.throws(
    () => validateAssistantNodeDelta({
      beforeCount: 2,
      afterCount: 4,
      requireSingleAssistantNode: true,
      name: 'test',
    }),
    /produced 2 assistant nodes/,
  );

  assert.doesNotThrow(() => validateAssistantNodeDelta({
    beforeCount: 2,
    afterCount: 3,
    requireSingleAssistantNode: true,
    name: 'test',
  }));
});
