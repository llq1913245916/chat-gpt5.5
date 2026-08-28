import { randomUUID } from 'node:crypto';
import {
  REVIEW_STATUS,
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

function publicDisputeRegistry(registry) {
  return [...registry.values()]
    .filter((state) => state.lastUnresolved === true)
    .map((state) => ({
      disputeId: state.disputeId,
      target: state.issue.target,
      claim: state.issue.claim,
      basis: {
        type: state.issue.basis.type,
        locator: state.issue.basis.locator,
      },
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
          let disputeId = issue.relatedDisputeId ?? null;

          if (disputeId) {
            if (!disputeRegistry.has(disputeId)) {
              throw new Error(`Protocol error: unknown relatedDisputeId: ${disputeId}`);
            }
          } else {
            disputeId = `D-${String(nextDisputeNumber).padStart(4, '0')}`;
            nextDisputeNumber += 1;
          }

          return { ...issue, disputeId };
        }),
      };

      const boundIds = new Set(boundReview.issues.map((issue) => issue.disputeId));
      if (boundIds.size !== boundReview.issues.length) {
        throw new Error('Protocol error: multiple review issues cannot bind to the same disputeId');
      }

      await this.store?.recordReview(sessionId, round, boundReview);

      // Invariant: current is always a trusted checkpoint.
      // Therefore a PASS can never launder a disputed descendant.
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
          message: 'The same controller-managed dispute remains unresolved across consecutive rounds. Returning the last trusted checkpoint; the disputed branch is never promoted automatically.',
        });
      }

      if (hasUnresolvedDispute) {
        // Fail-safe: do not continue from a descendant of a rejected/partial critique.
        // The next reviewer round receives the unchanged trusted checkpoint plus the
        // controller-managed prior dispute registry.
        latestDisputed = {
          version,
          answer: proposed.answer,
        };
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
