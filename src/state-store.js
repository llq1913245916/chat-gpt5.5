import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class FileStateStore {
  constructor(rootDir = 'sessions') {
    this.rootDir = rootDir;
  }

  async createSession({ task, source }) {
    const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const dir = join(this.rootDir, sessionId);
    await mkdir(join(dir, 'versions'), { recursive: true });
    await mkdir(join(dir, 'reviews'), { recursive: true });
    await writeJson(join(dir, 'source-of-truth.json'), { task, source });
    return sessionId;
  }

  async recordVersion(sessionId, version, payload) {
    const file = join(this.rootDir, sessionId, 'versions', `v${String(version).padStart(2, '0')}.json`);
    await writeJson(file, payload);
  }

  async recordReview(sessionId, round, payload) {
    const file = join(this.rootDir, sessionId, 'reviews', `round-${String(round).padStart(2, '0')}.json`);
    await writeJson(file, payload);
  }

  async recordResult(sessionId, payload) {
    await writeJson(join(this.rootDir, sessionId, 'result.json'), payload);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
