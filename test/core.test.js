import test from 'node:test';
import assert from 'node:assert/strict';
import { DualAIReviewController } from '../src/controller.js';
import {
  issueKey,
  projectReviewForAuthor,
  validateControllerLimits,
  validateReview,
} from '../src/protocol.js';

function issue(overrides = {}) {
  return {
    id: 'B-1',
    severity: 'major',
    confidence: 0.9,
    target: 'answer:claim-1',
    claim: 'The source does not support X.',
    basis: {
      type: 'source',
      locator: 'source:p1',
      evidence: 'Paragraph 1 states condition Y.',
    },
    suggestion: 'Re-check the condition.',
    ...overrides,
  };
}

function reviewWith(oneIssue) {
  return {
    status: 'REVISE',
    score: 70,
    summary: 'needs work',
    issues: [oneIssue],
    uncertainties: [],
  };
}

function decisionFor(issueId, verdict, overrides = {}) {
  const residualDispute = verdict !== 'ACCEPT';
  return {
    issueId,
    verdict,
    reason: 'Checked independently.',
    basis: {
      type: 'source',
      locator: 'source:p1',
      evidence: 'Paragraph 1 is controlling.',
    },
    residualDispute,
    ...(verdict === 'PARTIAL'
      ? { acceptedPart: 'formatting concern', rejectedPart: 'factual change' }
      : {}),
    ...overrides,
  };
}

test('review protocol rejects source basis without source of truth', () => {
  assert.throws(() => validateReview(reviewWith(issue()), { hasSource: false }), /requires a Source of Truth/);
});

test('review protocol requires structured basis and stable target', () => {
  assert.throws(() => validateReview(reviewWith(issue({ target: '' }))), /target is required/);
  assert.throws(() => validateReview(reviewWith(issue({
    basis: { type: 'source', locator: '', evidence: 'x' },
  }))), /locator is required/);
});

test('issue identity is based on target and basis, not claim wording', () => {
  const a = issue({ claim: 'The source does not support X.' });
  const b = issue({ id: 'B-2', claim: 'X lacks support in the supplied material.' });
  assert.equal(issueKey(a), issueKey(b));
});

test('reviewer suggestion is removed before A sees review data', () => {
  const projected = projectReviewForAuthor(reviewWith(issue({
    suggestion: 'Change the answer to Y immediately.',
  })));
  assert.equal(projected.issues[0].suggestion, undefined);
  assert.equal(projected.summary, undefined);
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

test('DISAGREEMENT returns last trusted checkpoint, not disputed revision', async () => {
  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review, round }) {
      return {
        answer: `drifted toward B in round ${round}`,
        decisions: review.issues.map((item) => decisionFor(item.id, 'REJECT')),
      };
    },
  };

  let round = 0;
  const reviewer = {
    async review() {
      round += 1;
      return reviewWith(issue({
        id: `B-${round}`,
        claim: round === 1
          ? 'The source does not support X.'
          : 'X lacks support in the supplied material.',
      }));
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 5,
    disagreementLimit: 2,
  }).run({ task: 'test', source: 'authoritative source p1' });

  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.rounds, 2);
  assert.equal(result.answer, 'trusted draft');
  assert.equal(result.disputedRevision, 'drifted toward B in round 2');
});

test('reject-accept-reject is not treated as consecutive disagreement', async () => {
  let revisionRound = 0;
  const author = {
    async draft() { return 'v0'; },
    async revise({ review }) {
      revisionRound += 1;
      const verdict = revisionRound === 2 ? 'ACCEPT' : 'REJECT';
      return {
        answer: `v${revisionRound}`,
        decisions: review.issues.map((item) => decisionFor(item.id, verdict)),
      };
    },
  };

  let reviewRound = 0;
  const reviewer = {
    async review() {
      reviewRound += 1;
      if (reviewRound === 4) {
        return { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
      }
      return reviewWith(issue({ id: `B-${reviewRound}` }));
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 4,
    disagreementLimit: 2,
  }).run({ task: 'test', source: 'source p1' });

  assert.equal(result.status, 'PASS');
});

test('repeated PARTIAL residual dispute escalates', async () => {
  const author = {
    async draft() { return 'v0'; },
    async revise({ review, round }) {
      return {
        answer: `v${round}`,
        decisions: review.issues.map((item) => decisionFor(item.id, 'PARTIAL')),
      };
    },
  };

  const reviewer = {
    async review({ round }) {
      return reviewWith(issue({ id: `B-${round}` }));
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 3,
    disagreementLimit: 2,
  }).run({ task: 'test', source: 'source p1' });

  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.answer, 'v0');
});

test('controller limits reject unsafe values', () => {
  for (const bad of [NaN, Infinity, 0, -1, 1.5, 13]) {
    assert.throws(() => validateControllerLimits({ maxRounds: bad, disagreementLimit: 1 }));
  }
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: NaN }));
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: 4 }));
});
