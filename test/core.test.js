import test from 'node:test';
import assert from 'node:assert/strict';
import { DualAIReviewController } from '../src/controller.js';
import {
  MAX_ACTIONABLE_ISSUES,
  groundingFingerprint,
  projectReviewForAuthor,
  validateControllerLimits,
  validateReview,
} from '../src/protocol.js';

const SOURCE = 'Paragraph 1 states condition Y.\nParagraph 2 states condition Z.';
const CANDIDATE = 'Trusted claim one.\nTrusted claim two.';

function sourceBasis(overrides = {}) {
  return {
    type: 'source',
    locator: 'source:L1',
    quote: 'Paragraph 1 states condition Y.',
    evidence: 'The quoted source line controls the claim.',
    ...overrides,
  };
}

function candidateBasis(overrides = {}) {
  return {
    type: 'candidate',
    locator: 'candidate:L1',
    quote: 'Trusted claim one.',
    evidence: 'The candidate contains this statement.',
    ...overrides,
  };
}

function logicBasis(overrides = {}) {
  return {
    type: 'logic',
    locator: 'logic:step-1',
    premises: [
      { type: 'source', locator: 'source:L1', quote: 'Paragraph 1 states condition Y.' },
      { type: 'candidate', locator: 'candidate:L1', quote: 'Trusted claim one.' },
    ],
    evidence: 'Given the source condition and candidate claim, the conclusion follows.',
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    id: 'B-1',
    relatedDisputeId: null,
    severity: 'major',
    confidence: 0.9,
    target: 'answer:claim-1',
    claim: 'The source does not support X.',
    basis: sourceBasis(),
    suggestion: 'Re-check the condition.',
    ...overrides,
  };
}

function reviewWith(...issues) {
  return {
    status: 'REVISE',
    score: 70,
    summary: 'needs work',
    issues,
    uncertainties: [],
  };
}

function decisionFor(issueId, verdict, overrides = {}) {
  return {
    issueId,
    verdict,
    reason: 'Checked independently.',
    basis: sourceBasis({ evidence: 'Independent source check.' }),
    residualDispute: verdict !== 'ACCEPT',
    ...(verdict === 'PARTIAL'
      ? { acceptedPart: 'formatting concern', rejectedPart: 'factual change' }
      : {}),
    ...overrides,
  };
}

test('source/candidate locators are machine-resolved to the quoted line range', () => {
  assert.doesNotThrow(() => validateReview(reviewWith(issue()), {
    sourceText: SOURCE,
    candidateText: CANDIDATE,
  }));

  assert.throws(() => validateReview(reviewWith(issue({
    basis: sourceBasis({ locator: 'source:L99' }),
  })), { sourceText: SOURCE, candidateText: CANDIDATE }), /locator does not resolve/);

  assert.throws(() => validateReview(reviewWith(issue({
    basis: sourceBasis({ locator: 'source:L2' }),
  })), { sourceText: SOURCE, candidateText: CANDIDATE }), /quote does not resolve at source:L2/);
});

test('free-form logic assertion is rejected; grounded logic premises are accepted', () => {
  assert.throws(() => validateReview(reviewWith(issue({
    basis: {
      type: 'logic',
      locator: 'logic:security',
      evidence: 'Deprecated protocols should not be used.',
    },
  })), { sourceText: SOURCE, candidateText: CANDIDATE }), /premises is required/);

  assert.doesNotThrow(() => validateReview(reviewWith(issue({ basis: logicBasis() })), {
    sourceText: SOURCE,
    candidateText: CANDIDATE,
  }));
});

test('logic grounding fingerprint depends on anchored premises', () => {
  const a = groundingFingerprint(logicBasis());
  const b = groundingFingerprint(logicBasis({
    premises: [{ type: 'source', locator: 'source:L2', quote: 'Paragraph 2 states condition Z.' }],
  }));
  assert.notEqual(a, b);
});

test('review rejects exact duplicate actionable issues even under unique IDs', () => {
  assert.throws(() => validateReview(reviewWith(
    issue({ id: 'B-1' }),
    issue({ id: 'B-2' }),
  ), { sourceText: SOURCE, candidateText: CANDIDATE }), /duplicate actionable issue content/);
});

test('review limits actionable issue count', () => {
  const issues = Array.from({ length: MAX_ACTIONABLE_ISSUES + 1 }, (_, index) => issue({
    id: `B-${index + 1}`,
    claim: `Distinct claim ${index + 1}`,
  }));
  assert.throws(() => validateReview(reviewWith(...issues), {
    sourceText: SOURCE,
    candidateText: CANDIDATE,
  }), /cannot exceed/);
});

test('reviewer persuasion metadata is removed before A sees review data', () => {
  const review = reviewWith({
    ...issue({ suggestion: 'Change immediately.', severity: 'critical', confidence: 1 }),
    disputeId: 'D-0001',
  });
  const projected = projectReviewForAuthor(review);
  assert.equal(projected.issues[0].suggestion, undefined);
  assert.equal(projected.summary, undefined);
  assert.equal(projected.issues[0].severity, undefined);
  assert.equal(projected.issues[0].confidence, undefined);
  assert.equal(projected.issues[0].disputeId, 'D-0001');
});

test('controller returns PASS on trusted candidate without revision', async () => {
  const author = {
    async draft() { return CANDIDATE; },
    async revise() { throw new Error('should not revise'); },
  };
  const reviewer = {
    async review() { return { status: 'PASS', score: 96, summary: 'ok', issues: [], uncertainties: [] }; },
  };
  const result = await new DualAIReviewController({ author, reviewer }).run({ task: 'test', source: SOURCE });
  assert.equal(result.answer, CANDIDATE);
});

test('REJECT drift cannot be laundered by later PASS', async () => {
  const seen = [];
  let round = 0;
  const author = {
    async draft() { return CANDIDATE; },
    async revise({ review }) {
      return { answer: 'drifted branch', decisions: review.issues.map((x) => decisionFor(x.id, 'REJECT')) };
    },
  };
  const reviewer = {
    async review({ candidate }) {
      seen.push(candidate);
      round += 1;
      return round === 1
        ? reviewWith(issue())
        : { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
    },
  };
  const result = await new DualAIReviewController({ author, reviewer, maxRounds: 2 }).run({ task: 'test', source: SOURCE });
  assert.deepEqual(seen, [CANDIDATE, CANDIDATE]);
  assert.equal(result.answer, CANDIDATE);
});

test('compatible dispute binding increments consecutive disagreement', async () => {
  const author = {
    async draft() { return CANDIDATE; },
    async revise({ review, round }) {
      return { answer: `discarded ${round}`, decisions: review.issues.map((x) => decisionFor(x.id, 'REJECT')) };
    },
  };
  const reviewer = {
    async review({ round, priorDisputes }) {
      if (round === 1) return reviewWith(issue());
      const prior = priorDisputes[0];
      return reviewWith(issue({
        id: 'B-2',
        relatedDisputeId: prior.disputeId,
        target: prior.target,
        claim: prior.claim,
        basis: prior.basis,
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
  assert.equal(result.answer, CANDIDATE);
});

test('incompatible reuse of a valid disputeId is rebound as a new dispute and cannot false-trigger disagreement', async () => {
  const observedIds = [];
  const author = {
    async draft() { return CANDIDATE; },
    async revise({ review }) {
      observedIds.push(review.issues[0].disputeId);
      return { answer: 'discarded', decisions: review.issues.map((x) => decisionFor(x.id, 'REJECT')) };
    },
  };
  const reviewer = {
    async review({ round, priorDisputes }) {
      if (round === 1) return reviewWith(issue());
      return reviewWith(issue({
        id: 'B-2',
        relatedDisputeId: priorDisputes[0].disputeId,
        target: 'answer:unrelated',
        claim: 'A completely unrelated dispute.',
        basis: candidateBasis(),
      }));
    },
  };
  const result = await new DualAIReviewController({
    author,
    reviewer,
    maxRounds: 2,
    disagreementLimit: 2,
  }).run({ task: 'test', source: SOURCE });
  assert.deepEqual(observedIds, ['D-0001', 'D-0002']);
  assert.equal(result.status, 'MAX_ROUNDS');
  assert.equal(result.answer, CANDIDATE);
});

test('different claims sharing same anchor remain distinct disputes', async () => {
  const ids = [];
  const author = {
    async draft() { return CANDIDATE; },
    async revise({ review }) {
      ids.push(...review.issues.map((x) => x.disputeId));
      return { answer: 'discarded', decisions: review.issues.map((x) => decisionFor(x.id, 'REJECT')) };
    },
  };
  const reviewer = {
    async review({ round }) {
      if (round === 1) return reviewWith(
        issue({ id: 'B-1', claim: 'First substantive claim.' }),
        issue({ id: 'B-2', claim: 'Second substantive claim.' }),
      );
      return { status: 'PASS', score: 95, summary: 'ok', issues: [], uncertainties: [] };
    },
  };
  await new DualAIReviewController({ author, reviewer, maxRounds: 2 }).run({ task: 'test', source: SOURCE });
  assert.deepEqual(ids, ['D-0001', 'D-0002']);
});

test('unknown relatedDisputeId is rejected', async () => {
  const author = { async draft() { return CANDIDATE; }, async revise() { throw new Error('no'); } };
  const reviewer = { async review() { return reviewWith(issue({ relatedDisputeId: 'D-9999' })); } };
  await assert.rejects(
    () => new DualAIReviewController({ author, reviewer }).run({ task: 'test', source: SOURCE }),
    /unknown relatedDisputeId/,
  );
});

test('repeated PARTIAL stays off trusted lineage', async () => {
  const author = {
    async draft() { return CANDIDATE; },
    async revise({ review, round }) {
      return { answer: `partial ${round}`, decisions: review.issues.map((x) => decisionFor(x.id, 'PARTIAL')) };
    },
  };
  const reviewer = {
    async review({ round, priorDisputes }) {
      if (round === 1) return reviewWith(issue());
      const prior = priorDisputes[0];
      return reviewWith(issue({ id: `B-${round}`, relatedDisputeId: prior.disputeId, target: prior.target, claim: prior.claim, basis: prior.basis }));
    },
  };
  const result = await new DualAIReviewController({ author, reviewer, maxRounds: 3, disagreementLimit: 2 }).run({ task: 'test', source: SOURCE });
  assert.equal(result.status, 'DISAGREEMENT');
  assert.equal(result.answer, CANDIDATE);
});

test('controller limits reject unsafe values', () => {
  for (const bad of [NaN, Infinity, 0, -1, 1.5, 13]) {
    assert.throws(() => validateControllerLimits({ maxRounds: bad, disagreementLimit: 1 }));
  }
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: NaN }));
  assert.throws(() => validateControllerLimits({ maxRounds: 3, disagreementLimit: 4 }));
});
