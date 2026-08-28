import { randomUUID } from 'node:crypto';
import {
  issueKey,
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
    const disputeStates = new Map();

    let version = 0;
    let current = normalizeDraft(await this.author.draft({ truth, round: 0, sessionId }));
    let trusted = {
      version,
      answer: current.answer,
      reason: 'initial-author-draft',
    };

    await this.store?.recordVersion(sessionId, version, {
      version,
      round: 0,
      kind: 'draft',
      trust: 'trusted-checkpoint',
      answer: current.answer,
    });

    for (let round = 1; round <= this.maxRounds; round += 1) {
      const review = validateReview(await this.reviewer.review({
        truth,
        candidate: current.answer,
        round,
        sessionId,
      }), { hasSource: Boolean(truth.source?.trim()) });

      await this.store?.recordReview(sessionId, round, review);

      if (review.status === REVIEW_STATUS.PASS) {
        trusted = {
          version,
          answer: current.answer,
          reason: 'reviewer-pass',
        };
        return this.#finish(sessionId, {
          status: 'PASS',
          rounds: round,
          answer: current.answer,
          answerTrust: 'reviewer-pass',
          review,
        });
      }

      const preRevision = {
        version,
        answer: current.answer,
      };

      const revision = validateRevision(await this.author.revise({
        truth,
        candidate: current.answer,
        review,
        round,
        sessionId,
      }), review, { hasSource: Boolean(truth.source?.trim()) });

      const seenKeys = new Set();
      let hasUnresolvedDispute = false;

      for (const issue of review.issues) {
        const decision = revision.decisions.find((item) => item.issueId === issue.id);
        const key = issueKey(issue);
        seenKeys.add(key);

        const previous = disputeStates.get(key);
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

        disputeStates.set(key, {
          lastSeenRound: round,
          lastVerdict: decision.verdict,
          lastUnresolved: unresolved,
          consecutiveUnresolved,
          issue,
        });
      }

      for (const [key, state] of disputeStates.entries()) {
        if (!seenKeys.has(key) && state.lastSeenRound < round) {
          disputeStates.set(key, {
            ...state,
            lastUnresolved: false,
            consecutiveUnresolved: 0,
          });
        }
      }

      version += 1;
      const next = { answer: revision.answer };

      await this.store?.recordVersion(sessionId, version, {
        version,
        round,
        kind: hasUnresolvedDispute ? 'disputed-revision' : 'revision',
        trust: hasUnresolvedDispute ? 'untrusted-pending-dispute' : 'trusted-checkpoint',
        answer: next.answer,
        previousVersion: preRevision.version,
        decisions: revision.decisions,
      });

      const repeatedDispute = [...disputeStates.values()].find(
        (state) => state.consecutiveUnresolved >= this.disagreementLimit,
      );

      if (repeatedDispute) {
        return this.#finish(sessionId, {
          status: 'DISAGREEMENT',
          rounds: round,
          answer: trusted.answer,
          answerTrust: 'last-trusted-checkpoint',
          trustedVersion: trusted.version,
          disputedRevision: next.answer,
          disputedVersion: version,
          disputedIssue: repeatedDispute.issue,
          message: 'The same grounded issue remains unresolved across consecutive rounds. Returning the last trusted checkpoint and surfacing the disputed revision separately.',
        });
      }

      current = next;

      if (!hasUnresolvedDispute) {
        trusted = {
          version,
          answer: current.answer,
          reason: 'all-review-issues-resolved',
        };
      }
    }

    const latestIsTrusted = current.answer === trusted.answer;
    return this.#finish(sessionId, {
      status: 'MAX_ROUNDS',
      rounds: this.maxRounds,
      answer: trusted.answer,
      answerTrust: 'last-trusted-checkpoint',
      trustedVersion: trusted.version,
      candidate: latestIsTrusted ? undefined : current.answer,
      candidateTrust: latestIsTrusted ? undefined : 'untrusted-pending-dispute',
      message: 'Maximum review rounds reached. Returning the last trusted checkpoint; inspect the recorded candidate/history before continuing.',
    });
  }

  async #finish(sessionId, result) {
    if (this.store && sessionId) await this.store.recordResult(sessionId, result);
    return { sessionId, ...result };
  }
}
