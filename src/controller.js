import { randomUUID } from 'node:crypto';
import {
  REVIEW_STATUS,
  groundingFingerprint,
  normalizeProtocolText,
  validateControllerLimits,
  validateReview,
  validateRevision,
} from './protocol.js';

function normalizeDraft(value) {
  if (typeof value === 'string' && value.trim()) return { answer: value.trim() };
  if (value && typeof value.answer === 'string' && value.answer.trim()) {
    return { ...value, answer: value.answer.trim() };
  }
  throw new Error('Author draft must be a non-empty string or { answer } object');
}

function isUnresolvedDecision(decision) {
  return decision.verdict === 'REJECT'
    || (decision.verdict === 'PARTIAL' && decision.residualDispute === true);
}

function continuityRecord(issue) {
  return {
    target: normalizeProtocolText(issue.target),
    claim: normalizeProtocolText(issue.claim),
    grounding: groundingFingerprint(issue.basis),
  };
}

function isCompatibleRelatedIssue(issue, state) {
  const current = continuityRecord(issue);
  return current.target === state.continuity.target
    && current.claim === state.continuity.claim
    && current.grounding === state.continuity.grounding;
}

function publicDisputeRegistry(registry) {
  return [...registry.values()]
    .filter((state) => state.lastUnresolved === true)
    .map((state) => ({
      disputeId: state.disputeId,
      target: state.continuity.target,
      claim: state.continuity.claim,
      basis: state.canonicalIssue.basis,
    }));
}

export class DualAIReviewController {
  constructor({ author, reviewer, store = null, maxRounds = 3, disagreementLimit = 2 } = {}) {
    if (!author?.draft || !author?.revise) throw new Error('author must implement draft() and revise()');
    if (!reviewer?.review) throw new Error('reviewer must implement review()');
    validateControllerLimits({ maxRounds, disagreementLimit });

    this.author = author;
    this.reviewer = reviewer;
    this.store = store;
    this.maxRounds = maxRounds;
    this.disagreementLimit = disagreementLimit;
  }

  async run({ task, source = '' }) {
    if (!task?.trim()) throw new Error('task is required');

    const truth = Object.freeze({ task: task.trim(), source });
    const sessionId = this.store ? await this.store.createSession(truth) : randomUUID();
    const disputeRegistry = new Map();
    let nextDisputeNumber = 1;

    const allocateDisputeId = () => {
      const id = `D-${String(nextDisputeNumber).padStart(4, '0')}`;
      nextDisputeNumber += 1;
      return id;
    };

    let version = 0;
    let current = normalizeDraft(await this.author.draft({ truth, round: 0, sessionId }));
    let trusted = {
      version,
      answer: current.answer,
      reason: 'initial-author-draft',
    };
    let latestDisputed = null;

    await this.store?.recordVersion(sessionId, version, {
      version,
      round: 0,
      kind: 'draft',
      trust: 'trusted-checkpoint',
      answer: current.answer,
    });

    for (let round = 1; round <= this.maxRounds; round += 1) {
      const priorDisputes = publicDisputeRegistry(disputeRegistry);
      const rawReview = await this.reviewer.review({
        truth,
        candidate: current.answer,
        round,
        sessionId,
        priorDisputes,
      });

      const review = validateReview(rawReview, {
        sourceText: truth.source,
        candidateText: current.answer,
      });

      const boundReview = {
        ...review,
        issues: review.issues.map((issue) => {
          const requestedDisputeId = issue.relatedDisputeId ?? null;
          let disputeId = requestedDisputeId;
          let bindingRejectedFrom;

          if (requestedDisputeId) {
            const state = disputeRegistry.get(requestedDisputeId);
            if (!state) {
              throw new Error(`Protocol error: unknown relatedDisputeId: ${requestedDisputeId}`);
            }

            if (!isCompatibleRelatedIssue(issue, state)) {
              bindingRejectedFrom = requestedDisputeId;
              disputeId = allocateDisputeId();
            }
          } else {
            disputeId = allocateDisputeId();
          }

          return {
            ...issue,
            disputeId,
            ...(bindingRejectedFrom ? { bindingRejectedFrom } : {}),
          };
        }),
      };

      const boundIds = new Set(boundReview.issues.map((issue) => issue.disputeId));
      if (boundIds.size !== boundReview.issues.length) {
        throw new Error('Protocol error: multiple review issues cannot bind to the same disputeId');
      }

      await this.store?.recordReview(sessionId, round, boundReview);

      if (boundReview.status === REVIEW_STATUS.PASS) {
        return this.#finish(sessionId, {
          status: 'PASS',
          rounds: round,
          answer: current.answer,
          answerTrust: 'reviewer-pass-on-trusted-checkpoint',
          review: boundReview,
        });
      }

      const revision = validateRevision(
        await this.author.revise({
          truth,
          candidate: current.answer,
          review: boundReview,
          round,
          sessionId,
        }),
        boundReview,
        {
          sourceText: truth.source,
          candidateText: current.answer,
        },
      );

      const seenDisputeIds = new Set();
      let hasUnresolvedDispute = false;

      for (const issue of boundReview.issues) {
        const decision = revision.decisions.find((item) => item.issueId === issue.id);
        const disputeId = issue.disputeId;
        seenDisputeIds.add(disputeId);

        const previous = disputeRegistry.get(disputeId);
        const unresolved = isUnresolvedDecision(decision);
        hasUnresolvedDispute ||= unresolved;

        const consecutiveUnresolved = unresolved
          ? (
              previous?.lastSeenRound === round - 1
              && previous?.lastUnresolved === true
                ? previous.consecutiveUnresolved + 1
                : 1
            )
          : 0;

        disputeRegistry.set(disputeId, {
          disputeId,
          canonicalIssue: previous?.canonicalIssue ?? issue,
          continuity: previous?.continuity ?? continuityRecord(issue),
          lastSeenRound: round,
          lastVerdict: decision.verdict,
          lastUnresolved: unresolved,
          consecutiveUnresolved,
          issue,
        });
      }

      for (const [disputeId, state] of disputeRegistry.entries()) {
        if (!seenDisputeIds.has(disputeId) && state.lastSeenRound < round) {
          disputeRegistry.set(disputeId, {
            ...state,
            lastUnresolved: false,
            consecutiveUnresolved: 0,
          });
        }
      }

      version += 1;
      const proposed = { answer: revision.answer };

      await this.store?.recordVersion(sessionId, version, {
        version,
        round,
        kind: hasUnresolvedDispute ? 'disputed-revision' : 'revision',
        trust: hasUnresolvedDispute ? 'untrusted-discarded-branch' : 'trusted-checkpoint',
        answer: proposed.answer,
        baseTrustedVersion: trusted.version,
        decisions: revision.decisions,
      });

      const repeatedDispute = [...disputeRegistry.values()].find(
        (state) => state.consecutiveUnresolved >= this.disagreementLimit,
      );

      if (repeatedDispute) {
        return this.#finish(sessionId, {
          status: 'DISAGREEMENT',
          rounds: round,
          answer: trusted.answer,
          answerTrust: 'last-trusted-checkpoint',
          trustedVersion: trusted.version,
          disputedRevision: proposed.answer,
          disputedVersion: version,
          disputedIssue: repeatedDispute.issue,
          message: 'The same mechanically continuous dispute remains unresolved across consecutive rounds. Returning the last trusted checkpoint; incompatible dispute-ID rebindings never increment this counter.',
        });
      }

      if (hasUnresolvedDispute) {
        latestDisputed = { version, answer: proposed.answer };
        continue;
      }

      current = proposed;
      trusted = {
        version,
        answer: current.answer,
        reason: 'all-review-issues-resolved',
      };
      latestDisputed = null;
    }

    return this.#finish(sessionId, {
      status: 'MAX_ROUNDS',
      rounds: this.maxRounds,
      answer: trusted.answer,
      answerTrust: 'last-trusted-checkpoint',
      trustedVersion: trusted.version,
      disputedRevision: latestDisputed?.answer,
      disputedVersion: latestDisputed?.version,
      message: 'Maximum review rounds reached. Returning the last trusted checkpoint; unresolved branches remain separate.',
    });
  }

  async #finish(sessionId, result) {
    if (this.store && sessionId) await this.store.recordResult(sessionId, result);
    return { sessionId, ...result };
  }
}
