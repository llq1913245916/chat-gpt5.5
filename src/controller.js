import { issueKey, REVIEW_STATUS, validateReview, validateRevision } from './protocol.js';

function normalizeDraft(value) {
  if (typeof value === 'string' && value.trim()) return { answer: value.trim() };
  if (value && typeof value.answer === 'string' && value.answer.trim()) return { ...value, answer: value.answer.trim() };
  throw new Error('Author draft must be a non-empty string or { answer } object');
}

export class DualAIReviewController {
  constructor({ author, reviewer, store = null, maxRounds = 3, disagreementLimit = 2 } = {}) {
    if (!author?.draft || !author?.revise) throw new Error('author must implement draft() and revise()');
    if (!reviewer?.review) throw new Error('reviewer must implement review()');
    this.author = author;
    this.reviewer = reviewer;
    this.store = store;
    this.maxRounds = maxRounds;
    this.disagreementLimit = disagreementLimit;
  }

  async run({ task, source = '' }) {
    if (!task?.trim()) throw new Error('task is required');

    const truth = Object.freeze({ task: task.trim(), source });
    const sessionId = this.store ? await this.store.createSession(truth) : null;
    const rejectionCounts = new Map();

    let version = 0;
    let current = normalizeDraft(await this.author.draft({ truth, round: 0 }));
    await this.store?.recordVersion(sessionId, version, {
      version,
      round: 0,
      kind: 'draft',
      answer: current.answer,
    });

    for (let round = 1; round <= this.maxRounds; round += 1) {
      const review = validateReview(await this.reviewer.review({
        truth,
        candidate: current.answer,
        round,
      }));

      await this.store?.recordReview(sessionId, round, review);

      if (review.status === REVIEW_STATUS.PASS) {
        return this.#finish(sessionId, {
          status: 'PASS',
          rounds: round,
          answer: current.answer,
          review,
        });
      }

      const revision = validateRevision(await this.author.revise({
        truth,
        candidate: current.answer,
        review,
        round,
      }), review);

      for (const decision of revision.decisions) {
        if (decision.verdict !== 'REJECT') continue;
        const issue = review.issues.find((item) => item.id === decision.issueId);
        const key = issueKey(issue);
        rejectionCounts.set(key, (rejectionCounts.get(key) ?? 0) + 1);
      }

      version += 1;
      current = { answer: revision.answer };
      await this.store?.recordVersion(sessionId, version, {
        version,
        round,
        kind: 'revision',
        answer: current.answer,
        decisions: revision.decisions,
      });

      const repeatedRejectedIssue = review.issues.find((issue) =>
        (rejectionCounts.get(issueKey(issue)) ?? 0) >= this.disagreementLimit,
      );

      if (repeatedRejectedIssue) {
        return this.#finish(sessionId, {
          status: 'DISAGREEMENT',
          rounds: round,
          answer: current.answer,
          disputedIssue: repeatedRejectedIssue,
          message: 'A repeatedly rejected the same evidence-grounded critique. Escalate to the user or a third judge instead of forcing another revision.',
        });
      }
    }

    return this.#finish(sessionId, {
      status: 'MAX_ROUNDS',
      rounds: this.maxRounds,
      answer: current.answer,
      message: 'Maximum review rounds reached. Keep the history and compare versions before continuing.',
    });
  }

  async #finish(sessionId, result) {
    if (this.store && sessionId) await this.store.recordResult(sessionId, result);
    return { sessionId, ...result };
  }
}
