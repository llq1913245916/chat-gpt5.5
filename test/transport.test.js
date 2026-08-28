import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransportConfig } from '../src/adapters/playwright-agent.js';

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

test('transport rejects unverified conversation reuse by default', () => {
  const config = baseConfig();
  delete config.session.newConversationSelector;
  assert.throws(() => validateTransportConfig(config), /freshConversationUrl or session.newConversationSelector/);
});

test('transport rejects text-stability-only completion unless explicitly opted in', () => {
  const config = baseConfig();
  delete config.completion.generatingSelector;
  assert.throws(() => validateTransportConfig(config), /authoritative completion signal/);

  config.completion.allowStabilityFallback = true;
  assert.doesNotThrow(() => validateTransportConfig(config));
});
