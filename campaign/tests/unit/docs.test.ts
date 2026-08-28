/**
 * Documentation that drifts from the code is worse than none: it sends the
 * next person down a path that no longer exists. These checks are cheap and
 * they catch the two ways it happens in practice.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(process.cwd(), '..');
const envExample = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
const environmentDoc = readFileSync(join(REPO_ROOT, 'docs', 'ENVIRONMENT.md'), 'utf8');

function declaredVariables(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

describe('docs/ENVIRONMENT.md', () => {
  it('documents every variable in .env.example', () => {
    const undocumented = declaredVariables(envExample).filter(
      (name) => !environmentDoc.includes(name),
    );
    expect(undocumented).toEqual([]);
  });
});

describe('the documentation set', () => {
  const expected = [
    'ARCHITECTURE.md', 'INSTALL.md', 'DEPLOY.md', 'ENVIRONMENT.md',
    'GRAPH-SETUP.md', 'SOP.md', 'RECOVERY.md', 'SECURITY.md', 'N8N-SETUP.md',
  ];

  it.each(expected)('includes %s', (name) => {
    expect(existsSync(join(REPO_ROOT, 'docs', name))).toBe(true);
  });

  it('links every document from the index', () => {
    const index = readFileSync(join(REPO_ROOT, 'docs', 'README.md'), 'utf8');
    const unlinked = expected.filter((name) => !index.includes(name));
    expect(unlinked).toEqual([]);
  });
});

describe('scripts referenced by the docs exist', () => {
  const referenced = [
    ['npm run migrate', 'scripts/migrate.ts'],
    ['npm run verify-env', 'scripts/verify-env.ts'],
    ['npm run verify-graph', 'scripts/verify-graph.ts'],
    ['npm run create-owner', 'scripts/create-owner.ts'],
    ['npm run db:up', 'scripts/pg-local.sh'],
  ] as const;

  it.each(referenced)('%s resolves to %s', (_command, path) => {
    expect(existsSync(join(process.cwd(), path))).toBe(true);
  });

  it('declares each of those npm scripts', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['migrate', 'verify-env', 'verify-graph', 'create-owner', 'db:up', 'test', 'build']) {
      expect(pkg.scripts[name], `package.json is missing the "${name}" script`).toBeDefined();
    }
  });
});

describe('the Windows deployment scripts', () => {
  it.each(['install-service.ps1', 'uninstall-service.ps1', 'health-check.ps1', 'backup.ps1'])(
    'ships %s',
    (name) => {
      expect(existsSync(join(process.cwd(), 'scripts', 'windows', name))).toBe(true);
    },
  );
});
