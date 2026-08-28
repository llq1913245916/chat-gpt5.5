export const REVIEW_STATUS = Object.freeze({
  PASS: 'PASS',
  REVISE: 'REVISE',
});

export const VERDICTS = new Set(['ACCEPT', 'REJECT', 'PARTIAL']);
export const SEVERITIES = new Set(['critical', 'major', 'minor']);

function assert(condition, message) {
  if (!condition) throw new Error(`Protocol error: ${message}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function issueKey(issue) {
  return String(issue.claim || issue.id || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

export function validateReview(input) {
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

  const seen = new Set();
  for (const issue of input.issues) {
    assert(issue && typeof issue === 'object', 'each issue must be an object');
    assert(nonEmptyString(issue.id), 'issue.id is required');
    assert(!seen.has(issue.id), `duplicate issue id: ${issue.id}`);
    seen.add(issue.id);
    assert(SEVERITIES.has(issue.severity), `invalid severity for ${issue.id}`);
    assert(Number.isFinite(issue.confidence) && issue.confidence >= 0 && issue.confidence <= 1, `confidence must be 0..1 for ${issue.id}`);
    assert(nonEmptyString(issue.claim), `claim is required for ${issue.id}`);
    assert(nonEmptyString(issue.evidence), `evidence is required for ${issue.id}`);
    assert(nonEmptyString(issue.suggestion), `suggestion is required for ${issue.id}`);
  }

  if (input.uncertainties !== undefined) {
    assert(Array.isArray(input.uncertainties), 'uncertainties must be an array when present');
  }

  return {
    ...input,
    uncertainties: input.uncertainties ?? [],
  };
}

export function validateRevision(input, review) {
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
    assert(nonEmptyString(decision.sourceBasis), `sourceBasis is required for ${decision.issueId}`);
  }

  for (const id of requiredIds) {
    assert(decidedIds.has(id), `missing decision for issue: ${id}`);
  }

  return input;
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
