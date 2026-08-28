export const REVIEW_STATUS = Object.freeze({
  PASS: 'PASS',
  REVISE: 'REVISE',
});

export const VERDICTS = new Set(['ACCEPT', 'REJECT', 'PARTIAL']);
export const SEVERITIES = new Set(['critical', 'major', 'minor']);
export const BASIS_TYPES = new Set(['source', 'candidate', 'logic']);
export const MAX_ROUNDS_HARD_LIMIT = 12;
export const MAX_ACTIONABLE_ISSUES = 8;
export const MAX_LOGIC_PREMISES = 4;

function assert(condition, message) {
  if (!condition) throw new Error(`Protocol error: ${message}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeProtocolText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeFingerprintText(value) {
  return normalizeProtocolText(value).toLowerCase();
}

function lineRangeFor(locator, expectedPrefix, label) {
  const match = /^(source|candidate):L(\d+)(?:-L?(\d+))?$/i.exec(String(locator ?? '').trim());
  assert(match, `${label}.locator must use ${expectedPrefix}:Lx or ${expectedPrefix}:Lx-Ly`);
  assert(match[1].toLowerCase() === expectedPrefix, `${label}.locator must use ${expectedPrefix}: prefix`);

  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  assert(Number.isInteger(start) && start >= 1, `${label}.locator start line must be >= 1`);
  assert(Number.isInteger(end) && end >= start, `${label}.locator end line must be >= start line`);
  return { start, end };
}

function textAtLineRange(text, range, label) {
  const lines = String(text ?? '').split(/\r?\n/);
  assert(range.end <= lines.length, `${label}.locator does not resolve in supplied text`);
  return lines.slice(range.start - 1, range.end).join('\n');
}

function quoteExists(haystack, quote) {
  const normalizedHaystack = normalizeProtocolText(haystack);
  const normalizedQuote = normalizeProtocolText(quote);
  return normalizedQuote.length > 0 && normalizedHaystack.includes(normalizedQuote);
}

function validateQuotedAnchor(anchor, label, { sourceText = '', candidateText = '' } = {}) {
  assert(anchor && typeof anchor === 'object' && !Array.isArray(anchor), `${label} must be an object`);
  assert(anchor.type === 'source' || anchor.type === 'candidate', `${label}.type must be source or candidate`);
  assert(nonEmptyString(anchor.locator), `${label}.locator is required`);
  assert(nonEmptyString(anchor.quote), `${label}.quote is required`);

  const text = anchor.type === 'source' ? sourceText : candidateText;
  assert(nonEmptyString(text), `${label}.type=${anchor.type} requires supplied ${anchor.type} text`);

  const range = lineRangeFor(anchor.locator, anchor.type, label);
  const scopedText = textAtLineRange(text, range, label);
  assert(
    quoteExists(scopedText, anchor.quote),
    `${label}.quote does not resolve at ${anchor.locator}`,
  );
  return anchor;
}

export function validateBasis(
  basis,
  label,
  { sourceText = '', candidateText = '' } = {},
) {
  assert(basis && typeof basis === 'object' && !Array.isArray(basis), `${label}.basis must be an object`);
  assert(BASIS_TYPES.has(basis.type), `${label}.basis.type must be source, candidate, or logic`);
  assert(nonEmptyString(basis.locator), `${label}.basis.locator is required`);
  assert(nonEmptyString(basis.evidence), `${label}.basis.evidence is required`);

  if (basis.type === 'source' || basis.type === 'candidate') {
    validateQuotedAnchor(basis, `${label}.basis`, { sourceText, candidateText });
  }

  if (basis.type === 'logic') {
    assert(Array.isArray(basis.premises), `${label}.basis.premises is required for logic grounding`);
    assert(
      basis.premises.length >= 1 && basis.premises.length <= MAX_LOGIC_PREMISES,
      `${label}.basis.premises must contain 1..${MAX_LOGIC_PREMISES} grounded premises`,
    );
    basis.premises.forEach((premise, index) => {
      validateQuotedAnchor(premise, `${label}.basis.premises[${index}]`, { sourceText, candidateText });
    });
  }

  return basis;
}

export function groundingFingerprint(basis) {
  if (basis.type === 'source' || basis.type === 'candidate') {
    return [
      basis.type,
      normalizeFingerprintText(basis.locator),
      normalizeFingerprintText(basis.quote),
    ].join('|');
  }

  const premises = (basis.premises ?? []).map((premise) => [
    premise.type,
    normalizeFingerprintText(premise.locator),
    normalizeFingerprintText(premise.quote),
  ].join('|'));
  return ['logic', normalizeFingerprintText(basis.locator), ...premises].join('||');
}

export function issueFingerprint(issue) {
  return [
    normalizeFingerprintText(issue.target),
    normalizeFingerprintText(issue.claim),
    groundingFingerprint(issue.basis),
  ].join('|||');
}

export function validateReview(
  input,
  { sourceText = '', candidateText = '' } = {},
) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'review must be an object');
  assert(Object.values(REVIEW_STATUS).includes(input.status), 'status must be PASS or REVISE');
  assert(Number.isFinite(input.score) && input.score >= 0 && input.score <= 100, 'score must be 0..100');
  assert(nonEmptyString(input.summary), 'summary is required');
  assert(Array.isArray(input.issues), 'issues must be an array');
  assert(input.issues.length <= MAX_ACTIONABLE_ISSUES, `issues cannot exceed ${MAX_ACTIONABLE_ISSUES} actionable items per round`);

  if (input.status === REVIEW_STATUS.PASS) {
    assert(input.issues.length === 0, 'PASS cannot contain actionable issues');
  } else {
    assert(input.issues.length > 0, 'REVISE must contain at least one actionable issue');
  }

  const seenIds = new Set();
  const relatedIds = new Set();
  const seenFingerprints = new Set();

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

    if (issue.relatedDisputeId !== null && issue.relatedDisputeId !== undefined) {
      assert(nonEmptyString(issue.relatedDisputeId), `relatedDisputeId must be null or non-empty for ${issue.id}`);
      assert(!relatedIds.has(issue.relatedDisputeId), `duplicate relatedDisputeId in one review: ${issue.relatedDisputeId}`);
      relatedIds.add(issue.relatedDisputeId);
    }

    validateBasis(issue.basis, `issue ${issue.id}`, { sourceText, candidateText });
    const fingerprint = issueFingerprint(issue);
    assert(!seenFingerprints.has(fingerprint), `duplicate actionable issue content: ${issue.id}`);
    seenFingerprints.add(fingerprint);
  }

  if (input.uncertainties !== undefined) {
    assert(Array.isArray(input.uncertainties), 'uncertainties must be an array when present');
  }

  return { ...input, uncertainties: input.uncertainties ?? [] };
}

export function validateRevision(
  input,
  review,
  { sourceText = '', candidateText = '' } = {},
) {
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
    validateBasis(decision.basis, `decision ${decision.issueId}`, { sourceText, candidateText });
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

  for (const id of requiredIds) assert(decidedIds.has(id), `missing decision for issue: ${id}`);
  return input;
}

export function projectReviewForAuthor(review) {
  return {
    status: review.status,
    issues: review.issues.map((issue) => ({
      id: issue.id,
      disputeId: issue.disputeId,
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
    const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
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
