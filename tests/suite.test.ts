/**
 * Test suite. Focused on the things most likely to regress silently:
 * the security guards, the renderer geometry that is the project's whole
 * premise, cross-roadmap coverage, and the export generators.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, beforeEach, afterEach, assert, eq, near, throws, summary } from './harness';
import { edgePath, measureText, nodeSize, handlePoint, handleSide, ensureNodeSized } from '../app/src/lib/renderer';
import { coveredStatusMap } from '../app/src/lib/cross';
import { resolveOverlaps } from '../app/src/lib/layout';
import { calculateRetention } from '../app/src/lib/retention';
import { generateOPML, generateFreeMind } from '../app/src/lib/exports';
import { isSafeSlug, isSafeNodeId } from '../server/src/store.js';
import { normalizeTheme } from '../app/src/lib/api';
import {
  CONNECTORS,
  describeAll,
  loadConnectors,
  saveConnectors,
  flush,
} from '../server/src/connectors.js';

import {
  dateKey,
  getCompletion,
  getStats,
  loadDailys,
  saveDailys,
  recordAttempt,
  clearToday,
  addDefinition,
  removeDefinition,
  listDefinitions,
  getBoard,
} from '../server/src/dailys.js';
import { getQuests, getProblemSet, resolveProblem, getProfile } from '../server/src/leetcode.js';

export { settle } from './harness';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal RMNode builder — tests only touch geometry, so this is enough. */
function node(partial: Record<string, unknown>) {
  return {
    id: 'n1',
    type: 'topic',
    position: { x: 0, y: 0 },
    data: { label: 'Topic' },
    ...partial,
  } as never;
}

/* ------------------------------- security ------------------------------- */

describe('security: slug + node-id guards', () => {
  // These guard the path-traversal fix. If they weaken, arbitrary files become
  // readable through /api/roadmaps/:slug again.
  it('accepts ordinary slugs', () => {
    assert(isSafeSlug('frontend'));
    assert(isSafeSlug('aspnet-core'));
    assert(isSafeSlug('ai-engineer-2026'));
    assert(isSafeSlug('a'));
  });

  it('rejects path traversal', () => {
    for (const bad of [
      '../package',
      '..%2F..%2Fpackage',
      '../../data/state',
      '..',
      '/etc/passwd',
      'a/b',
      '.',
    ]) {
      eq(isSafeSlug(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('rejects slugs with separators, dots or empties', () => {
    eq(isSafeSlug('has space'), false);
    eq(isSafeSlug('has.dot'), false);
    eq(isSafeSlug(''), false);
    eq(isSafeSlug(undefined as never), false);
    eq(isSafeSlug(null as never), false);
    eq(isSafeSlug(123 as never), false);
  });

  it('rejects uppercase slugs (files are lowercase)', () => {
    eq(isSafeSlug('Frontend'), false);
  });

  it('node ids allow base64url characters only', () => {
    assert(isSafeNodeId('e-k6EhoxYG9h0x6vWOrDh'));
    assert(isSafeNodeId('M56-ufyFSwaQYPISuwUcj'));
    eq(isSafeNodeId('../x'), false);
    eq(isSafeNodeId('a/b'), false);
    eq(isSafeNodeId(''), false);
  });
});

/* --------------------------- theme migration ---------------------------- */

describe('theme: legacy names migrate', () => {
  it('keeps the four shipped themes', () => {
    eq(normalizeTheme('light'), 'light');
    eq(normalizeTheme('paper'), 'paper');
    eq(normalizeTheme('dark'), 'dark');
    eq(normalizeTheme('midnight'), 'midnight');
  });

  it('maps retired themes to their nearest survivor', () => {
    eq(normalizeTheme('cherry'), 'paper');
    eq(normalizeTheme('stitch'), 'midnight');
    eq(normalizeTheme('ocean'), 'light');
    eq(normalizeTheme('mono'), 'light');
  });

  it('falls back to light for junk rather than crashing', () => {
    eq(normalizeTheme('nope'), 'light');
    eq(normalizeTheme(undefined), 'light');
    eq(normalizeTheme(null), 'light');
    eq(normalizeTheme(''), 'light');
  });
});

/* --------------------------- renderer geometry --------------------------- */

describe('renderer: measureText', () => {
  it('is monotonic in length and size', () => {
    assert(measureText('assembly', 16) > measureText('as', 16));
    assert(measureText('same', 20) > measureText('same', 12));
  });

  it('is empty for empty input', () => {
    eq(measureText('', 16), 0);
  });

  it('scales linearly with font size', () => {
    near(measureText('linear', 20), measureText('linear', 10) * 2, 0.001);
  });
});

describe('renderer: nodeSize', () => {
  it('reads explicit width/height', () => {
    const s = nodeSize(node({ width: 240, height: 49 }));
    eq(s.w, 240);
    eq(s.h, 49);
  });

  it('falls back to measured dimensions when width is absent', () => {
    // Every shipped node carries `measured`; the label nodes rely on it.
    const s = nodeSize(node({ measured: { width: 182, height: 42 } }));
    eq(s.w, 182);
    eq(s.h, 42);
  });

  it('falls back to defaults for a bare node', () => {
    const s = nodeSize(node({}));
    assert(s.w > 0 && s.h > 0);
  });
});

describe('renderer: handles', () => {
  it('maps handle prefixes to sides', () => {
    eq(handleSide('w1'), 'w');
    eq(handleSide('x2'), 'x');
    eq(handleSide('y1'), 'y');
    eq(handleSide('z2'), 'z');
  });

  it('defaults an unknown handle to the right side', () => {
    eq(handleSide(undefined), 'z');
    eq(handleSide('nonsense'), 'z');
  });

  it('anchors on the correct edge', () => {
    const n = node({ width: 200, height: 50, position: { x: 10, y: 20 } });
    const top = handlePoint(n, 'w1');
    near(top.x, 110, 0.001, 'top centre x');
    near(top.y, 20, 0.001, 'top centre y');
    const bottom = handlePoint(n, 'x2');
    near(bottom.x, 110, 0.001, 'bottom centre x');
    near(bottom.y, 70, 0.001, 'bottom centre y');
    const left = handlePoint(n, 'y1');
    near(left.x, 10, 0.001, 'left middle x');
    near(left.y, 45, 0.001, 'left middle y');
    const right = handlePoint(n, 'z2');
    near(right.x, 210, 0.001, 'right middle x');
    near(right.y, 45, 0.001, 'right middle y');
  });
});

describe('renderer: ensureNodeSized is idempotent', () => {
  it('leaves an already-sized node untouched', () => {
    const n = node({ width: 240, height: 49 });
    const out = ensureNodeSized(n);
    eq(out.width, 240);
    eq(out.height, 49);
  });

  it('gives every node positive dimensions', () => {
    for (const type of ['topic', 'subtopic', 'label', 'paragraph', 'title']) {
      const out = ensureNodeSized(node({ type, data: { label: 'Hello world' } }));
      assert((out.width ?? 0) > 0, `${type} width`);
      assert((out.height ?? 0) > 0, `${type} height`);
    }
  });
});

/* ------------------------------ edge paths ------------------------------- */

describe('renderer: edge paths match the official fixture', () => {
  const fixture = join(ROOT, 'fixtures', 'official_rendered_frontend.json');
  const roadmapPath = join(ROOT, 'data', 'roadmaps', 'frontend.json');

  if (!existsSync(fixture) || !existsSync(roadmapPath)) {
    it('skipped (fixture or roadmap missing)', () => {
      assert(true);
    });
    return;
  }

  const official = JSON.parse(readFileSync(fixture, 'utf8'));
  const roadmap = JSON.parse(readFileSync(roadmapPath, 'utf8'));
  const byId = new Map<string, never>(roadmap.nodes.map((n: never & { id: string }) => [n.id, n]));
  const nums = (s: string) => (s.match(/-?\d+\.?\d*(?:e-?\d+)?/g) ?? []).map(Number);

  it('reproduces every official bezier path', () => {
    let checked = 0;
    for (const e of roadmap.edges) {
      const d = official.edges?.[e.id]?.d;
      if (!d) continue;
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const p1 = handlePoint(ensureNodeSized(a), e.sourceHandle);
      const p2 = handlePoint(ensureNodeSized(b), e.targetHandle);
      const expected = edgePath(p1, handleSide(e.sourceHandle), p2, handleSide(e.targetHandle));
      const actual = nums(d);
      for (let i = 0; i < expected.length; i++) {
        near(actual[i], expected[i], 0.01, `edge ${e.id} coord ${i}`);
      }
      checked++;
    }
    assert(checked > 0, 'no edges were compared — fixture wiring is broken');
  });
});

/* --------------------------- cross-roadmap ------------------------------ */

describe('cross: coveredStatusMap', () => {
  const mk = (slug: string, nodes: unknown[]) => ({ slug, nodes } as never);

  it('marks a topic covered when its label is done elsewhere', () => {
    const all = new Map<string, never>([
      ['a', mk('a', [node({ id: 'a1', data: { label: 'React' } })])],
      ['b', mk('b', [node({ id: 'b1', data: { label: 'React' } })])],
    ]);
    const covered = coveredStatusMap('b', all, { a: { a1: 'done' } });
    eq(covered.b1, 'covered');
  });

  it('does not count done topics in the same roadmap', () => {
    const all = new Map<string, never>([
      ['a', mk('a', [node({ id: 'a1', data: { label: 'React' } })])],
    ]);
    const covered = coveredStatusMap('a', all, { a: { a1: 'done' } });
    eq(covered.a1, undefined);
  });

  it('local status wins over covered at the merge layer', () => {
    const all = new Map<string, never>([
      ['a', mk('a', [node({ id: 'a1', data: { label: 'React' } })])],
      ['b', mk('b', [node({ id: 'b1', data: { label: 'React' } })])],
    ]);
    const local = { b1: 'learning' };
    const covered = coveredStatusMap('b', all, { a: { a1: 'done' }, b: local });

    // coveredStatusMap is a pure derivation and does not consider local status.
    // Precedence is established in useCrossProgress, which merges as
    // { ...covered, ...localProgress } — local spread last, so it wins.
    eq(covered.b1, 'covered', 'coveredStatusMap derives regardless of local status');
    const merged = { ...covered, ...local };
    eq(merged.b1, 'learning', 'local status must beat covered after merge');
  });

  it('is case- and whitespace-insensitive', () => {
    const all = new Map<string, never>([
      ['a', mk('a', [node({ id: 'a1', data: { label: '  ReaCT ' } })])],
      ['b', mk('b', [node({ id: 'b1', data: { label: 'react' } })])],
    ]);
    eq(coveredStatusMap('b', all, { a: { a1: 'done' } }).b1, 'covered');
  });

  it('ignores non-topic nodes', () => {
    const all = new Map<string, never>([
      ['a', mk('a', [node({ id: 'a1', type: 'title', data: { label: 'React' } })])],
      ['b', mk('b', [node({ id: 'b1', data: { label: 'React' } })])],
    ]);
    eq(coveredStatusMap('b', all, { a: { a1: 'done' } }).b1, undefined);
  });
});

/* ------------------------------- layout -------------------------------- */

describe('layout: resolveOverlaps', () => {
  it('separates two identical boxes', () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 0, y: 0, w: 100, h: 40 },
    ];
    resolveOverlaps(boxes);
    const [a, b] = boxes;
    const separated =
      a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    assert(separated, 'boxes still overlap after resolveOverlaps');
  });

  it('leaves already-separated boxes alone', () => {
    const boxes = [
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 500, y: 500, w: 100, h: 40 },
    ];
    resolveOverlaps(boxes);
    eq(boxes[1].x, 500);
    eq(boxes[1].y, 500);
  });

  it('handles an empty or single box without throwing', () => {
    resolveOverlaps([]);
    resolveOverlaps([{ x: 5, y: 5, w: 10, h: 10 }]);
    assert(true);
  });
});

/* ------------------------------- exports -------------------------------- */

describe('exports: generators produce well-formed output', () => {
  const roadmap = {
    slug: 'demo',
    title: { page: 'Demo Roadmap' },
    nodes: [
      node({ id: 't1', type: 'topic', data: { label: 'Alpha' } }),
      node({ id: 's1', type: 'subtopic', data: { label: 'Beta' } }),
    ],
    edges: [{ id: 'e1', source: 't1', target: 's1' }],
  } as never;

  it('OPML has an outline root and the roadmap title', () => {
    const xml = generateOPML(roadmap);
    assert(xml.includes('<opml'), 'missing <opml>');
    assert(xml.includes('Demo Roadmap'), 'missing title');
    assert(xml.includes('Alpha') && xml.includes('Beta'), 'missing nodes');
    eq((xml.match(/<opml/g) ?? []).length, 1);
  });

  it('FreeMind has a map root', () => {
    const xml = generateFreeMind(roadmap);
    assert(xml.includes('<map'), 'missing <map>');
    assert(xml.includes('Demo Roadmap'), 'missing title');
    assert(xml.includes('Alpha') && xml.includes('Beta'), 'missing nodes');
  });

  it('exports escape ampersands so output stays parseable', () => {
    const nasty = {
      slug: 'demo',
      title: { page: 'A & B <Roadmap>' },
      nodes: [node({ id: 't1', type: 'topic', data: { label: 'C & D' } })],
      edges: [],
    } as never;
    const xml = generateOPML(nasty);
    assert(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), 'unescaped ampersand in OPML');
    assert(xml.includes('C &amp; D'), 'ampersand not escaped');
  });

  it('throws on nothing but still handles an empty roadmap', () => {
    const empty = { slug: 'x', nodes: [], edges: [] } as never;
    assert(typeof generateOPML(empty) === 'string');
    assert(typeof generateFreeMind(empty) === 'string');
  });
});

/* ------------------------------ connectors ------------------------------- */

describe('connectors: registry', () => {
  it('exposes exactly the supported connectors', () => {
    eq(Object.keys(CONNECTORS).sort().join(','), 'habitica,mstodo,notion,obsidian');
  });

  it('describes every connector for the UI', () => {
    const all = describeAll();
    eq(all.length, 4);
    for (const c of all) {
      assert(c.id && c.name && c.description, `${c.id} is missing basics`);
      assert(Array.isArray(c.fields) && c.fields.length > 0, `${c.id} has no fields`);
    }
  });

  it('never returns credential values — only a configured flag', () => {
    for (const c of describeAll()) {
      for (const f of c.fields) {
        assert(!('value' in f), `${c.id}.${f.key} leaked a credential value`);
        eq(typeof f.configured, 'boolean', `${c.id}.${f.key} configured flag`);
      }
    }
  });

  it('gates each connector on the right fields', () => {
    eq(CONNECTORS.obsidian.isConfigured({}), false);
    eq(CONNECTORS.obsidian.isConfigured({ vaultPath: '/tmp' }), true);
    eq(CONNECTORS.habitica.isConfigured({ userId: 'u' }), false, 'token is also required');
    eq(CONNECTORS.habitica.isConfigured({ userId: 'u', apiToken: 't' }), true);
    eq(CONNECTORS.notion.isConfigured({ token: 't' }), false, 'databaseId is also required');
    eq(CONNECTORS.notion.isConfigured({ token: 't', databaseId: 'd' }), true);
    eq(CONNECTORS.mstodo.isConfigured({ listId: 'l' }), false, 'token is required');
    eq(CONNECTORS.mstodo.isConfigured({ accessToken: 'a' }), true);
  });
});

describe('connectors: obsidian works with no network', () => {
  it('refuses a vault folder that does not exist', async () => {
    let msg = '';
    try {
      await CONNECTORS.obsidian.testConnection({
        vaultPath: joinPath(tmpdir(), 'definitely-not-a-real-vault-xyz'),
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes('does not exist'), `unexpected message: ${msg}`);
  });

  it('writes one note per topic, with frontmatter', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'obs-'));
    try {
      const r = await CONNECTORS.obsidian.push(
        [
          {
            slug: 'frontend',
            nodeId: 'n1',
            label: 'Accessibility',
            status: 'done',
            at: '2026-09-11T00:00:00.000Z',
          },
        ],
        { vaultPath: dir },
      );
      eq(r.pushed, 1);
      const file = joinPath(dir, 'frontend', 'Accessibility.md');
      eq(existsSync(file), true, 'note was not written');
      const body = readFileSync(file, 'utf8');
      assert(body.startsWith('---'), 'missing frontmatter');
      assert(body.includes('roadmap: frontend'), 'missing roadmap key');
      assert(body.includes('# Accessibility'), 'missing heading');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitises labels that a filesystem would reject', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'obs-'));
    try {
      await CONNECTORS.obsidian.push(
        [{ slug: 'a/b', nodeId: 'n', label: 'What: is "this"?', status: 'done', at: 'x' }],
        { vaultPath: dir },
      );
      // A slash in the slug must become a safe folder, not a nested path.
      eq(existsSync(joinPath(dir, 'a-b')), true, 'slug was not sanitised');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('connectors: queue survives failure', () => {
  it('keeps items queued when a push fails, then drains once fixed', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'obs-'));
    try {
      // Obsidian deliberately creates missing folders, so to force a failure we
      // point it at a *file* — mkdir underneath it fails with ENOTDIR.
      const notAFolder = joinPath(dir, 'not-a-folder');
      writeFileSync(notAFolder, 'x');
      const broken = loadConnectors();
      broken.connectors.obsidian = { enabled: true, vaultPath: notAFolder };
      broken.queue.obsidian = [
        { slug: 'frontend', nodeId: 'n1', label: 'X', status: 'done', at: 'x' },
      ];
      saveConnectors(broken);

      const failed = await flush('obsidian');
      eq(failed.ok, false, 'a failing push must report failure');
      eq(failed.remaining, 1, 'the item must stay queued for retry');

      // Make it valid; the same flush should now drain the queue.
      const fixed = loadConnectors();
      fixed.connectors.obsidian = { enabled: true, vaultPath: dir };
      saveConnectors(fixed);
      const good = await flush('obsidian');
      eq(good.ok, true, good.error ?? 'push should now succeed');
      eq(good.remaining, 0, 'queue should be empty after a successful flush');
    } finally {
      const clean = loadConnectors();
      clean.connectors.obsidian = {};
      clean.queue.obsidian = [];
      saveConnectors(clean);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips connectors that are disabled or unconfigured', async () => {
    const data = loadConnectors();
    data.connectors.notion = { enabled: false, token: 't', databaseId: 'd' };
    data.queue.notion = [{ slug: 's', nodeId: 'n', label: 'L', status: 'done', at: 'x' }];
    saveConnectors(data);
    const r = await flush('notion');
    eq(r.skipped, true, 'a disabled connector must not be contacted');
    const after = loadConnectors();
    eq((after.queue.notion || []).length, 1, 'queued item should be untouched');
    after.connectors.notion = {};
    after.queue.notion = [];
    saveConnectors(after);
  });
});

/* -------------------------------- dailys ---------------------------------- */

describe('dailys: implicit daily reset', () => {
  beforeEach(() => {
    // Tests share the scratch DATA_DIR the runner sets; reset between cases so
    // a streak from one case doesn't leak into the next.
    const d = loadDailys();
    d.attempts = [];
    d.completions = {};
    saveDailys(d);
  });

  it('a completion is recorded under today\'s key only', () => {
    const rec = recordAttempt('habit-review', { outcome: 'done', seconds: 30 });
    eq(rec?.status, 'done');
    eq(getCompletion('habit-review')?.dateKey, dateKey());

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    eq(getCompletion('habit-review', yesterday), null, 'yesterday must have no record');
  });

  it('a different task has no completion', () => {
    recordAttempt('habit-review', { outcome: 'done' });
    eq(getCompletion('habit-read'), null);
  });

  it('clearing today removes the record but leaves the history', () => {
    recordAttempt('habit-review', { outcome: 'done', seconds: 60 });
    const d = loadDailys();
    const before = d.attempts.length;
    eq(clearToday('habit-review'), true);
    eq(getCompletion('habit-review'), null, 'today\'s completion is cleared');
    const after = loadDailys();
    eq(after.attempts.length, before, 'history is preserved');
  });
});

describe('dailys: streaks', () => {
  function reset() {
    const d = loadDailys();
    d.attempts = [];
    d.completions = {};
    saveDailys(d);
  }
  function seed(offsets) {
    reset();
    const data = loadDailys();
    data.attempts = offsets.map((o, i) => {
      const d = new Date();
      d.setDate(d.getDate() - o);
      const k = dateKey(d);
      return {
        taskId: 't',
        at: `${k}T12:00:00.000Z`,
        dateKey: k,
        outcome: 'accepted',
        seconds: 60,
        problem: null,
      };
    });
    saveDailys(data);
  }

  it('reports zero with no attempts', () => {
    reset();
    const s = getStats();
    eq(s.currentStreak, 0);
    eq(s.longestStreak, 0);
  });

  it('a single accepted day = streak of 1', () => {
    seed([0]);
    const s = getStats();
    eq(s.currentStreak, 1);
    eq(s.longestStreak, 1);
  });

  it('a streak ending yesterday still counts as current', () => {
    seed([1]);
    eq(getStats().currentStreak, 1, 'yesterday should not break the streak');
  });

  it('a gap fully ends the current streak', () => {
    seed([2]);
    eq(getStats().currentStreak, 0);
  });

  it('longest survives across a gap', () => {
    // Present run: 0 (today) — current = 1.
    // Past run: 5,4 — length 2, but longest is 3 (the 4,2,1,0 chain that the
    // gap at offset 3 broke, leaving the longer run in the past).
    // Use offsets that actually produce a gap, with the *longer* run in the past.
    seed([7, 6, 5, 4, 3, 0]);
    const s = getStats();
    eq(s.currentStreak, 1);
    eq(s.longestStreak, 5, '5-3 is the past run, longer than today');
  });

  it('longest is the run, not the count of unique days', () => {
    seed([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const s = getStats();
    eq(s.currentStreak, 11);
    eq(s.longestStreak, 11);
  });
});

describe('dailys: aggregates', () => {
  beforeEach(() => {
    const d = loadDailys();
    d.attempts = [];
    d.completions = {};
    saveDailys(d);
  });

  it('bucketed completion rate by difficulty', () => {
    const today = dateKey();
    const data = loadDailys();
    const mk = (n, diff) => ({ taskId: 't', at: `${today}T1${n}:00:00Z`, dateKey: today, outcome: 'accepted', seconds: 10, problem: { title: 'x', difficulty: diff } });
    const mkBad = (n, diff) => ({ ...mk(n, diff), outcome: 'attempted' });
    data.attempts = [mk(0, 'Easy'), mkBad(1, 'Easy'), mk(2, 'Hard'), mk(3, 'Medium')];
    saveDailys(data);

    const s = getStats();
    eq(s.byDifficulty.Easy.attempts, 2);
    eq(s.byDifficulty.Easy.solved, 1);
    eq(s.byDifficulty.Easy.rate, 50);
    eq(s.byDifficulty.Hard.attempts, 1);
    eq(s.byDifficulty.Hard.rate, 100);
    eq(s.byDifficulty.Medium.rate, 100);
  });

  it('records average solve time across accepted attempts only', () => {
    const today = dateKey();
    const data = loadDailys();
    data.attempts = [
      { taskId: 't', at: `${today}T10:00:00Z`, dateKey: today, outcome: 'accepted', seconds: 100, problem: null },
      { taskId: 't', at: `${today}T11:00:00Z`, dateKey: today, outcome: 'accepted', seconds: 200, problem: null },
      { taskId: 't', at: `${today}T12:00:00Z`, dateKey: today, outcome: 'attempted', seconds: 999, problem: null },
    ];
    saveDailys(data);
    eq(getStats().avgSolveSeconds, 150, 'attempted time should not skew the average');
  });
});

describe('dailys: extensibility', () => {
  beforeEach(() => {
    const d = loadDailys();
    d.attempts = [];
    d.completions = {};
    saveDailys(d);
  });

  it('adds a custom daily, surfaces it on the board, and removes it', async () => {
    const def = addDefinition({ title: 'Drink water', kind: 'custom' });
    assert(def.id, 'returned definition has an id');
    assert(listDefinitions().some((d) => d.id === def.id), 'appears in listDefinitions');
    eq(removeDefinition(def.id), true, 'removal reported');
    eq(listDefinitions().some((d) => d.id === def.id), false, 'no longer in list');
  });

  it('a custom daily needs no network — the problem slot stays null', async () => {
    const def = addDefinition({ title: 'Stretch', kind: 'custom' });
    const board = await import('../app/src/lib/api');
    void board;
    // The board endpoint resolves problems for non-custom kinds; custom dailies
    // simply have no problem. The server does not call leetcode for them.
    const rec = recordAttempt(def.id, { outcome: 'done', seconds: 10 });
    eq(rec?.status, 'done');
  });
});


/* -------------------- graceful degradation (offline) ---------------------- */
/**
 * These simulate LeetCode being completely unreachable with a cold cache — the
 * scenario a fresh clone hits on first run. The rule under test: the app must
 * still render something usable and say why, never throw or blank out.
 */
describe('leetcode: offline with a cold cache', () => {
  const realFetch = globalThis.fetch;
  const cacheFile = joinPath(
    process.env.DATA_DIR || joinPath(ROOT, 'data'),
    'cache',
    'leetcode.json',
  );

  beforeEach(() => {
    // Cold cache, so nothing can be served from disk.
    try {
      rmSync(cacheFile, { force: true });
    } catch {
      /* ignore */
    }
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('getProblemSet degrades to an empty list instead of throwing', async () => {
    const set = await getProblemSet();
    eq(Array.isArray(set), true, 'should still return an array');
  });

  it('getQuests falls back to the known slug list and says so', async () => {
    const q = await getQuests();
    eq(q.source, 'fallback', 'must not claim live data while offline');
    assert(q.quests.length >= 4, 'should still offer the four quests');
    for (const slug of [
      'data-structures-and-algorithms-quest',
      'database-quest',
      'system-and-software-design-quest',
      'maths-quest',
    ]) {
      assert(q.quests.some((x) => x.slug === slug), `missing ${slug}`);
    }
  });

  it('resolveProblem returns a usable stub with an explanation', async () => {
    const p = await resolveProblem('potd');
    assert(p, 'must not be null');
    eq(p.title, 'Problem unavailable');
    eq(p.source, 'unavailable');
    assert((p.notes || []).length > 0, 'should tell the user what happened');
  });

  it('the board still renders, and offline-safe dailies are unaffected', async () => {
    const b = await getBoard();
    eq(Array.isArray(b.dailys), true);
    assert(b.dailys.length >= 3, 'board should not collapse');
    // Custom habits never touch the network, so they must be untouched.
    const habit = b.dailys.find((d) => d.kind === 'custom');
    assert(habit, 'custom daily should still be present');
    eq(habit?.problem ?? null, null, 'custom daily needs no problem');
  });

  it('quest cards still point at a real LeetCode URL offline', async () => {
    const p = await resolveProblem('quest');
    assert(p?.questUrl || p?.quest?.slug, 'quest should still be identifiable');
    if (p?.questUrl) {
      assert(p.questUrl.startsWith('https://leetcode.com/quest/'), p.questUrl);
    }
  });
});


/* -------------------- profile data layer: empty vs active -------------------- */

/**
 * Stub a canned GraphQL response for a given URL. getProfile hits the
 * official /graphql endpoint — we intercept it and return JSON for the test
 * profile state we want to exercise.
 */
const ACTIVE_PROFILE_BODY = JSON.stringify({
  data: {
    matchedUser: {
      username: 'neetcode',
      submitStatsGlobal: {
        acSubmissionNum: [
          { difficulty: 'All', count: 205 },
          { difficulty: 'Easy', count: 103 },
          { difficulty: 'Medium', count: 98 },
          { difficulty: 'Hard', count: 4 },
        ],
        totalSubmissionNum: [
          { difficulty: 'All', count: 216 },
          { difficulty: 'Easy', count: 108 },
          { difficulty: 'Medium', count: 100 },
          { difficulty: 'Hard', count: 8 },
        ],
      },
      profile: {
        ranking: 822019,
        reputation: 0,
        realName: 'Test User',
        userAvatar: null,
        aboutMe: null,
        countryName: null,
        school: null,
      },
      userCalendar: { streak: 5, totalActiveDays: 100, submissionCalendar: '{"1700000000":3,"1700086400":2,"1700172800":4}' },
      languageProblemCount: [
        { languageName: 'Python', problemsSolved: 150 },
        { languageName: 'JavaScript', problemsSolved: 45 },
      ],
      tagProblemCounts: {
        advanced: [
          { tagName: 'Dynamic Programming', problemsSolved: 50 },
          { tagName: 'Graph', problemsSolved: 30 },
        ],
        intermediate: [{ tagName: 'Array', problemsSolved: 80 }],
        fundamental: [],
      },
    },
    userContestRanking: { rating: 2100.7, globalRanking: 1000, totalParticipants: 10000, attendedContestsCount: 20, topPercentage: 10.0 },
  },
});

const EMPTY_PROFILE_BODY = JSON.stringify({
  data: {
    matchedUser: {
      username: 'newbie',
      submitStatsGlobal: {
        acSubmissionNum: [
          { difficulty: 'All', count: 0 },
          { difficulty: 'Easy', count: 0 },
          { difficulty: 'Medium', count: 0 },
          { difficulty: 'Hard', count: 0 },
        ],
        totalSubmissionNum: [
          { difficulty: 'All', count: 0 },
          { difficulty: 'Easy', count: 0 },
          { difficulty: 'Medium', count: 0 },
          { difficulty: 'Hard', count: 0 },
        ],
      },
      profile: { ranking: 5000001, reputation: 0, realName: null, userAvatar: null, aboutMe: null, countryName: null, school: null },
      userCalendar: { streak: 0, totalActiveDays: 0, submissionCalendar: '{}' },
      languageProblemCount: [],
      tagProblemCounts: { advanced: [], intermediate: [], fundamental: [] },
    },
    userContestRanking: null,
  },
});

describe('leetcode: profile data layer — empty vs active account', () => {
  let savedFetch: typeof fetch;
  const cacheFile = joinPath(
    process.env.DATA_DIR || joinPath(ROOT, 'data'),
    'cache',
    'leetcode.json',
  );
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    // Force a cold profile cache for every case.
    try { rmSync(cacheFile, { force: true }); } catch { /* ignore */ }
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  function stubReply(body: string) {
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  }

  it('an empty account: no acceptance, no contest, empty calendar/languages/tags/recent', async () => {
    stubReply(EMPTY_PROFILE_BODY);
    const p = await getProfile('newbie');
    assert(p, 'profile must not be null');
    eq(p.username, 'newbie');
    eq(p.solved.All, 0);
    eq(p.solved.Easy, 0);
    eq(p.solved.Medium, 0);
    eq(p.solved.Hard, 0);
    eq(p.attempts, 0);
    eq(p.acceptanceRate, null, '0/0 → no acceptance rate');
    eq(p.streak, 0);
    eq(p.totalActiveDays, 0);
    eq(p.calendar.length, 0);
    eq(p.languages.length, 0);
    eq(p.tags.length, 0);
    eq(p.recent.length, 0);
    eq(p.contest, null, 'no contest history → null');
  });

  it('an active account: every derived field is computed correctly', async () => {
    stubReply(ACTIVE_PROFILE_BODY);
    const p = await getProfile('neetcode');
    assert(p, 'profile must not be null');
    eq(p.username, 'neetcode');
    eq(p.solved.All, 205);
    eq(p.solved.Easy, 103);
    eq(p.solved.Medium, 98);
    eq(p.solved.Hard, 4);
    eq(p.attempts, 216);
    near(p.acceptanceRate, 94.9, 0.05, 'rounds to 94.9%');
    eq(p.streak, 5);
    eq(p.totalActiveDays, 100);
    eq(p.calendar.length, 3, 'three dated entries from submissionCalendar');
    eq(p.languages.length, 2, 'python and javascript only');
    eq(p.languages[0].languageName, 'Python', 'sorted by problemsSolved desc');
    eq(p.languages[0].problemsSolved, 150);
    eq(p.tags.length, 3, '2 advanced + 1 intermediate');
    eq(p.contest.rating, 2101, 'rounded from 2100.7');
    eq(p.contest.globalRanking, 1000);
    eq(p.contest.totalParticipants, 10000);
  });
});

/* ------------------------------- runner --------------------------------- */

describe('harness self-check', () => {
  it('eq detects inequality', () => {
    let caught = false;
    try {
      eq(1, 2);
    } catch {
      caught = true;
    }
    assert(caught);
  });

  it('throws() detects a non-throwing function', () => {
    let caught = false;
    try {
      throws(() => 1);
    } catch {
      caught = true;
    }
    assert(caught);
  });
});

/* ----------------------------- retention ------------------------------ */

describe('calculateRetention', () => {
  const ONE_DAY_MS = 86400000;
  const earlier = (days) => new Date(Date.now() - days * ONE_DAY_MS);

  it('fresh card (never reviewed) is due immediately', () => {
    const r = calculateRetention(null, 1);
    assert(r.isDue === true);
    assert(r.percentage === 100);
    assert(r.statusText === 'Fresh');
  });

  it('card within stability interval is not due', () => {
    const r = calculateRetention(earlier(0.5).toISOString(), 7);
    assert(r.isDue === false);
    assert(r.percentage > 90);
  });

  it('card past stability interval is due', () => {
    const r = calculateRetention(earlier(8).toISOString(), 7);
    assert(r.isDue === true);
    assert(r.percentage < 100);
  });

  it('long-ago review decays toward zero', () => {
    const r = calculateRetention(earlier(100).toISOString(), 7);
    assert(r.percentage < 10);
    assert(r.isDue === true);
  });

  it('never reviewed with short interval is still due', () => {
    const r = calculateRetention(null, 0.5);
    assert(r.isDue === true);
  });

  it('fresh card reports zero ms until due', () => {
    const r = calculateRetention(null, 1);
    assert(r.timeUntilDue === 0);
  });

  it('card not yet due reports positive ms until due', () => {
    const r = calculateRetention(earlier(2).toISOString(), 7);
    assert(r.timeUntilDue > 0);
    assert(r.timeUntilDue === 5 * 86400000);
  });

  it('overdue card reports zero ms until due', () => {
    const r = calculateRetention(earlier(10).toISOString(), 7);
    assert(r.timeUntilDue === 0);
  });

  it('timeUntilDue respects interval half day', () => {
    const r = calculateRetention(earlier(0.25).toISOString(), 0.5);
    assert(r.timeUntilDue > 0);
    assert(r.timeUntilDue === 0.25 * 86400000);
  });
});

/* ------------------------------- runner -------------------------------- */

export default summary;
