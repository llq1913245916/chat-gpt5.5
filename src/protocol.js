export const REVIEW_STATUS = Object.freeze({
  PASS: 'PASS',
  REVISE: 'REVISE',
});

export const VERDICTS = new Set(['ACCEPT', 'REJECT', 'PARTIAL']);
export const SEVERITIES = new Set(['critical', 'major', 'minor']);
export const BASIS_TYPES = new Set(['source', 'candidate', 'logic']);
export const MAX_ROUNDS_HARD_LIMIT = 12;

function assert(condition, message) {
  if (!condition) throw new Error(`Protocol error: ${message}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeIdentity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}:._/ -]/gu, '')
    .trim();
}

export function issueKey(issue) {
  return [
    normalizeIdentity(issue.target),
    normalizeIdentity(issue.basis?.type),
    normalizeIdentity(issue.basis?.locator),
  ].join('|');
}

export function validateBasis(basis, label, { hasSource = true } = {}) {
  assert(basis && typeof basis === 'object' && !Array.isArray(basis), `${label}.basis must be an object`);
  assert(BASIS_TYPES.has(basis.type), `${label}.basis.type must be source, candidate, or logic`);
  assert(nonEmptyString(basis.locator), `${label}.basis.locator is required`);
  assert(nonEmptyString(basis.evidence), `${label}.basis.evidence is required`);
  if (basis.type === 'source') {
    assert(hasSource, `${label}.basis.type=source requires a Source of Truth`);
  }
  return basis;
}

export function validateReview(input, { hasSource = true } = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'review must be an object');
  assert(Object.values(REVIEW_STATUS).includes(input.status), 'status must be PASS or REVISE');
  assert(Number.isFinite(input.score) && input.score >= 0 && input.score <= 100, 'score must be 0..100');
  assert(nonEmptyString(input.summary), 'summary is required');
  assert(Array.isArray(input.issues), 'issues must be an array');

  if (input.status === REVIEW_STATUS.PASS) {
    assert(input.issues.length === 0, 'PASS cannot contain actionable issues');
  } else {
    assert(input.issues.length > 0, 'REVISE must contain at least one actionable issue');
  }

  const seenIds = new Set();
  const seenKeys = new Set();

  for (const issue of input.issues) {
    assert(issue && typeof issue === 'object', 'each issue must be an object');
    assert(nonEmptyString(issue.id), 'issue.id is required');
    assert(!seenIds.has(issue.id), `duplicate issue id: ${issue.id}`);
    seenIds.add(issue.id);
    assert(SEVERITIES.has(issue.severity), `invalid severity for ${issue.id}`);
    assert(Number.isFinite(issue.confidence) && issue.confidence >= 0 && issue.confidence <= 1, `confidence must be 0..1 for ${issue.id}`);
    assert(nonEmptyString(issue.target), `target is required for ${issue.id}`);
    assert(nonEmptyString(issue.claim), `claim is required for ${issue.id}`);
    assert(nonEmptyString(issue.suggestion), `suggestion is required for ${issue.id}`);
    validateBasis(issue.basis, `issue ${issue.id}`, { hasSource });

    const key = issueKey(issue);
    assert(key && !key.startsWith('||'), `stable issue identity is required for ${issue.id}`);
    assert(!seenKeys.has(key), `duplicate semantic issue target/basis in one review: ${issue.id}`);
    seenKeys.add(key);
  }

  if (input.uncertainties !== undefined) {
    assert(Array.isArray(input.uncertainties), 'uncertainties must be an array when present');
  }

  return {
    ...input,
    uncertainties: input.uncertainties ?? [],
  };
}

export function validateRevision(input, review, { hasSource = true } = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'revision must be an object');
  assert(nonEmptyString(input.answer), 'revision.answer is required');
  assert(Array.isArray(input.decisions), 'revision.decisions must be an array');

  const requiredIds = new Set(review.issues.map((issue) => issue.id));
  const decidedIds = new Set();

  for (const decision of input.decisions) {
    assert(decision && typeof decision === 'object', 'each decision must be an object');
    assert(requiredIds.has(decision.issueId), `unknown issueId: ${decision.issueId}`);
    assert(!decidedIds.has(decision.issueId), `duplicate decision for: ${decision.issueId}`);
    decidedIds.add(decision.issueId);
    assert(VERDICTS.has(decision.verdict), `invalid verdict for ${decision.issueId}`);
    assert(nonEmptyString(decision.reason), `reason is required for ${decision.issueId}`);
    validateBasis(decision.basis, `decision ${decision.issueId}`, { hasSource });
    assert(typeof decision.residualDispute === 'boolean', `residualDispute is required for ${decision.issueId}`);

    if (decision.verdict === 'ACCEPT') {
      assert(decision.residualDispute === false, `ACCEPT cannot retain residualDispute for ${decision.issueId}`);
    }
    if (decision.verdict === 'REJECT') {
      assert(decision.residualDispute === true, `REJECT must retain residualDispute for ${decision.issueId}`);
    }
    if (decision.verdict === 'PARTIAL') {
      assert(nonEmptyString(decision.acceptedPart), `PARTIAL requires acceptedPart for ${decision.issueId}`);
      assert(nonEmptyString(decision.rejectedPart), `PARTIAL requires rejectedPart for ${decision.issueId}`);
      assert(decision.residualDispute === true, `PARTIAL must retain residualDispute for ${decision.issueId}`);
    }
  }

  for (const id of requiredIds) {
    assert(decidedIds.has(id), `missing decision for issue: ${id}`);
  }

  return input;
}

export function projectReviewForAuthor(review) {
  return {
    status: review.status,
    issues: review.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      confidence: issue.confidence,
      target: issue.target,
      claim: issue.claim,
      basis: issue.basis,
    })),
  };
}

export function validateControllerLimits({ maxRounds, disagreementLimit }) {
  assert(Number.isInteger(maxRounds) && Number.isFinite(maxRounds), 'maxRounds must be a finite integer');
  assert(maxRounds >= 1 && maxRounds <= MAX_ROUNDS_HARD_LIMIT, `maxRounds must be 1..${MAX_ROUNDS_HARD_LIMIT}`);
  assert(Number.isInteger(disagreementLimit) && Number.isFinite(disagreementLimit), 'disagreementLimit must be a finite integer');
  assert(disagreementLimit >= 1, 'disagreementLimit must be >= 1');
  assert(disagreementLimit <= maxRounds, 'disagreementLimit cannot exceed maxRounds');
}

export function parseJsonObject(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const unfenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      return JSON.parse(unfenced);
    } catch {
      const start = unfenced.indexOf('{');
      const end = unfenced.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
      throw new Error('Protocol error: response does not contain a valid JSON object');
    }
  }
}
