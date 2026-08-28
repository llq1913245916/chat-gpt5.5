import test from 'node:test';
import assert from 'node:assert/strict';
import { DualAIReviewController } from '../src/controller.js';
import {
  projectReviewForAuthor,
  validateControllerLimits,
  validateReview,
} from '../src/protocol.js';

const SOURCE = 'Paragraph 1 states condition Y. Paragraph 2 states condition Z.';

function issue(overrides = {}) {
  return {
    id: 'B-1',
    relatedDisputeId: null,
    severity: 'major',
    confidence: 0.9,
    target: 'answer:claim-1',
    claim: 'The source does not support X.',
    basis: {
      type: 'source',
      locator: 'source:p1',
      quote: 'Paragraph 1 states condition Y.',
      evidence: 'The quoted paragraph controls the claim.',
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
      quote: 'Paragraph 1 states condition Y.',
      evidence: 'The quoted paragraph is controlling.',
    },
    residualDispute,
    ...(verdict === 'PARTIAL'
      ? { acceptedPart: 'formatting concern', rejectedPart: 'factual change' }
      : {}),
    ...overrides,
  };
}

test('review protocol rejects source basis without source of truth', () => {
  assert.throws(
    () => validateReview(reviewWith(issue()), { sourceText: '', candidateText: 'candidate' }),
    /requires a Source of Truth/,
  );
});

test('review protocol rejects nonexistent source quote', () => {
  assert.throws(
    () => validateReview(
      reviewWith(issue({
        basis: {
          type: 'source',
          locator: 'source:p999',
          quote: 'This sentence does not exist.',
          evidence: 'fabricated',
        },
      })),
      { sourceText: SOURCE, candidateText: 'candidate' },
    ),
    /does not resolve in Source of Truth/,
  );
});

test('review protocol rejects nonexistent candidate quote', () => {
  assert.throws(
    () => validateReview(
      reviewWith(issue({
        basis: {
          type: 'candidate',
          locator: 'answer:p99',
          quote: 'not in candidate',
          evidence: 'fabricated',
        },
      })),
      { sourceText: SOURCE, candidateText: 'actual candidate text' },
    ),
    /does not resolve in candidate answer/,
  );
});

test('reviewer suggestion, summary, severity and confidence are removed before A sees review data', () => {
  const review = reviewWith({
    ...issue({ suggestion: 'Change the answer to Y immediately.' }),
    disputeId: 'D-0001',
  });
  const projected = projectReviewForAuthor(review);
  assert.equal(projected.issues[0].suggestion, undefined);
  assert.equal(projected.summary, undefined);
  assert.equal(projected.issues[0].severity, undefined);
  assert.equal(projected.issues[0].confidence, undefined);
  assert.equal(projected.issues[0].disputeId, 'D-0001');
});

test('controller returns PASS without unnecessary revision', async () => {
  const author = {
    async draft() { return 'trusted draft'; },
    async revise() { throw new Error('should not revise'); },
  };
  const reviewer = {
    async review() {
      return { status: 'PASS', score: 96, summary: 'ok', issues: [], uncertainties: [] };
    },
  };

  const result = await new DualAIReviewController({ author, reviewer }).run({
    task: 'test',
    source: SOURCE,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.answer, 'trusted draft');
});

test('REJECT + drift cannot be laundered by next-round PASS', async () => {
  const seenCandidates = [];
  let reviewRound = 0;

  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review }) {
      return {
        answer: 'drifted toward B',
        decisions: review.issues.map((item) => decisionFor(item.id, 'REJECT')),
      };
    },
  };

  const reviewer = {
    async review({ candidate, priorDisputes }) {
      seenCandidates.push(candidate);
      reviewRound += 1;

      if (reviewRound === 1) return reviewWith(issue());
      assert.equal(priorDisputes.length, 1);
      return { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 2,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });

  assert.deepEqual(seenCandidates, ['trusted draft', 'trusted draft']);
  assert.equal(result.status, 'PASS');
  assert.equal(result.answer, 'trusted draft');
});

test('REJECT + drift cannot be laundered when old issue disappears and unrelated issue is accepted', async () => {
  const seenCandidates = [];
  let reviewRound = 0;

  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review, round }) {
      const verdict = round === 1 ? 'REJECT' : 'ACCEPT';
      return {
        answer: round === 1 ? 'drifted branch' : 'trusted draft plus safe fix',
        decisions: review.issues.map((item) => decisionFor(item.id, verdict)),
      };
    },
  };

  const reviewer = {
    async review({ candidate }) {
      seenCandidates.push(candidate);
      reviewRound += 1;
      if (reviewRound === 1) return reviewWith(issue());
      if (reviewRound === 2) {
        return reviewWith(issue({
          id: 'B-2',
          target: 'answer:format',
          claim: 'A formatting issue exists.',
          basis: {
            type: 'candidate',
            locator: 'answer:whole',
            quote: 'trusted draft',
            evidence: 'The trusted answer lacks the requested suffix.',
          },
        }));
      }
      return { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 3,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });

  assert.deepEqual(seenCandidates, ['trusted draft', 'trusted draft', 'trusted draft plus safe fix']);
  assert.equal(result.status, 'PASS');
  assert.equal(result.answer, 'trusted draft plus safe fix');
});

test('controller-managed dispute id tracks same issue even when target and locator wording change', async () => {
  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review, round }) {
      return {
        answer: `discarded drift ${round}`,
        decisions: review.issues.map((item) => decisionFor(item.id, 'REJECT')),
      };
    },
  };

  const reviewer = {
    async review({ round, priorDisputes }) {
      if (round === 1) return reviewWith(issue());

      assert.equal(priorDisputes.length, 1);
      return reviewWith(issue({
        id: 'B-2',
        relatedDisputeId: priorDisputes[0].disputeId,
        target: 'answer:claim-moved-to-paragraph-4',
        claim: 'Same substantive support dispute, different wording.',
        basis: {
          type: 'source',
          locator: 'source:paragraph-one',
          quote: 'Paragraph 1 states condition Y.',
          evidence: 'Same controlling source span.',
        },
      }));
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 3,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });

  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.rounds, 2);
  assert.equal(result.answer, 'trusted draft');
  assert.equal(result.disputedIssue.disputeId, 'D-0001');
});

test('different claims sharing target and locator receive distinct controller dispute ids', async () => {
  const observed = [];

  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review }) {
      observed.push(review.issues.map((item) => item.disputeId));
      return {
        answer: 'discarded branch',
        decisions: review.issues.map((item) => decisionFor(item.id, 'REJECT')),
      };
    },
  };

  const reviewer = {
    async review({ round }) {
      if (round === 1) {
        return {
          status: 'REVISE',
          score: 70,
          summary: 'two distinct issues',
          issues: [
            issue({ id: 'B-1', claim: 'First substantive claim.' }),
            issue({ id: 'B-2', claim: 'Second substantive claim.' }),
          ],
          uncertainties: [],
        };
      }
      return { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 2,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });

  assert.deepEqual(observed[0], ['D-0001', 'D-0002']);
  assert.equal(result.answer, 'trusted draft');
});

test('unknown relatedDisputeId is rejected by controller', async () => {
  const author = {
    async draft() { return 'trusted draft'; },
    async revise() { throw new Error('should not revise'); },
  };
  const reviewer = {
    async review() {
      return reviewWith(issue({ relatedDisputeId: 'D-9999' }));
    },
  };

  await assert.rejects(
    () => new DualAIReviewController({ author, reviewer }).run({ task: 'test', source: SOURCE }),
    /unknown relatedDisputeId/,
  );
});

test('repeated PARTIAL residual dispute escalates without promoting the partial branch', async () => {
  const author = {
    async draft() { return 'trusted draft'; },
    async revise({ review, round }) {
      return {
        answer: `partial branch ${round}`,
        decisions: review.issues.map((item) => decisionFor(item.id, 'PARTIAL')),
      };
    },
  };

  const reviewer = {
    async review({ round, priorDisputes }) {
      return reviewWith(issue({
        id: `B-${round}`,
        relatedDisputeId: round === 1 ? null : priorDisputes[0].disputeId,
      }));
    },
  };

  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 3,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });

  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.answer, 'trusted draft');
});

test('controller limits reject unsafe values', () => {
  for (const bad of [NaN, Infinity, 0, -1, 1.5, 13]) {
    assert.throws(() => validateControllerLimits({ maxRounds: bad, disagreementLimit: 1 }));
  }
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: NaN }));
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: 4 }));
});
