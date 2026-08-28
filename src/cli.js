import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DualAIReviewController } from './controller.js';
import { FileStateStore } from './state-store.js';
import { parseJsonObject } from './protocol.js';
import { PlaywrightChatAgent } from './adapters/playwright-agent.js';

const args = parseArgs(process.argv.slice(2));
if (!args.task && !args['task-file']) {
  printUsage();
  process.exit(1);
}

const task = args.task ?? await readFile(resolve(args['task-file']), 'utf8');
const source = args['source-file'] ? await readFile(resolve(args['source-file']), 'utf8') : '';
const sitesPath = resolve(args.sites ?? 'config/sites.json');
const sites = JSON.parse(await readFile(sitesPath, 'utf8'));
const aPolicy = await readFile(new URL('../prompts/agent-a.md', import.meta.url), 'utf8');
const bPolicy = await readFile(new URL('../prompts/reviewer-b.md', import.meta.url), 'utf8');

const agentA = new PlaywrightChatAgent(sites.a);
const agentB = new PlaywrightChatAgent(sites.b);

try {
  await agentA.open();
  await agentB.open();

  const author = {
    async draft({ truth }) {
      return agentA.send(`${aPolicy}\n\nMODE: DRAFT\n\nORIGINAL TASK:\n${truth.task}\n\nSOURCE OF TRUTH:\n${truth.source || '[none provided]'}\n\nProduce the best complete answer.`);
    },

    async revise({ truth, candidate, review }) {
      const response = await agentA.send(`${aPolicy}\n\nMODE: REVISION\n\nORIGINAL TASK:\n${truth.task}\n\nSOURCE OF TRUTH:\n${truth.source || '[none provided]'}\n\nCURRENT ANSWER:\n${candidate}\n\nREVIEWER B JSON:\n${JSON.stringify(review, null, 2)}\n\nReturn JSON only with this shape:\n{"answer":"complete revised answer","decisions":[{"issueId":"B-1","verdict":"ACCEPT|REJECT|PARTIAL","reason":"...","sourceBasis":"..."}]}`);
      return parseJsonObject(response);
    },
  };

  const reviewer = {
    async review({ truth, candidate, round }) {
      const response = await agentB.send(`${bPolicy}\n\nROUND: ${round}\n\nORIGINAL TASK:\n${truth.task}\n\nSOURCE OF TRUTH:\n${truth.source || '[none provided]'}\n\nCANDIDATE ANSWER:\n${candidate}\n\nReturn JSON only with this shape:\n{"status":"PASS|REVISE","score":0,"summary":"...","issues":[{"id":"B-1","severity":"critical|major|minor","confidence":0.0,"claim":"...","evidence":"...","suggestion":"..."}],"uncertainties":[]}`);
      return parseJsonObject(response);
    },
  };

  const controller = new DualAIReviewController({
    author,
    reviewer,
    store: new FileStateStore(args['sessions-dir'] ?? 'sessions'),
    maxRounds: Number(args['max-rounds'] ?? 3),
    disagreementLimit: Number(args['disagreement-limit'] ?? 2),
  });

  const result = await controller.run({ task, source });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await Promise.allSettled([agentA.close(), agentB.close()]);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      i += 1;
    }
  }
  return result;
}

function printUsage() {
  console.log('Usage: npm start -- --task "..." [--source-file source.md] [--sites config/sites.json] [--max-rounds 3]');
}
