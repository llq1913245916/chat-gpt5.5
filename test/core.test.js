import test from 'node:test';
import assert from 'node:assert/strict';
import { DualAIReviewController } from '../src/controller.js';
import { validateReview } from '../src/protocol.js';

test('review protocol rejects evidence-free actionable issues', () => {
  assert.throws(() => validateReview({
    status: 'REVISE',
    score: 70,
    summary: 'needs work',
    issues: [{
      id: 'B-1',
      severity: 'major',
      confidence: 0.9,
      claim: 'something is wrong',
      evidence: '',
      suggestion: 'change it',
    }],
    uncertainties: [],
  }), /evidence is required/);
});

test('controller returns PASS without unnecessary revision', async () => {
  const author = {
    async draft() { return 'draft'; },
    async revise() { throw new Error('should not revise'); },
  };
  const reviewer = {
    async review() {
      return { status: 'PASS', score: 96, summary: 'ok', issues: [], uncertainties: [] };
    },
  };

  const result = await new DualAIReviewController({ author, reviewer }).run({ task: 'test' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.answer, 'draft');
});

test('repeated rejected critique escalates instead of forcing A to comply', async () => {
  const author = {
    async draft() { return 'source-grounded answer'; },
    async revise({ candidate, review }) {
      return {
        answer: candidate,
        decisions: review.issues.map((issue) => ({
          issueId: issue.id,
          verdict: 'REJECT',
          reason: 'Reviewer claim conflicts with the supplied source.',
          sourceBasis: 'source paragraph 1',
        })),
      };
    },
  };

  let round = 0;
  const reviewer = {
    async review() {
      round += 1;
      return {
        status: 'REVISE',
        score: 70,
        summary: 'same critique again',
        issues: [{
          id: `B-${round}`,
          severity: 'major',
          confidence: 0.9,
          claim: 'The same disputed factual claim should be changed.',
          evidence: 'Reviewer cites a reading that A says conflicts with source paragraph 1.',
          suggestion: 'Re-check source paragraph 1.',
        }],
        uncertainties: [],
      };
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 5,
    disagreementLimit: 2,
  }).run({ task: 'test', source: 'authoritative source paragraph 1' });

  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.rounds, 2);
  assert.equal(result.answer, 'source-grounded answer');
});
