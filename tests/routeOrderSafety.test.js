const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const routesDir = path.resolve(__dirname, '..', 'backend', 'routes');

function routePatternToRegExp(routePath) {
  const parts = routePath.split('/').map((part) => {
    if (part.startsWith(':')) return '[^/]+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

test('named routes must not be shadowed by an earlier :parameter route', () => {
  const problems = [];
  for (const filename of fs.readdirSync(routesDir).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(routesDir, filename), 'utf8');
    const declarations = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)]
      .map((match) => ({ method: match[1], path: match[2], offset: match.index }));
    for (let i = 0; i < declarations.length; i++) {
      const dynamic = declarations[i];
      if (!dynamic.path.includes(':')) continue;
      const matcher = routePatternToRegExp(dynamic.path);
      for (let j = i + 1; j < declarations.length; j++) {
        const named = declarations[j];
        if (dynamic.method === named.method && !named.path.includes(':') && matcher.test(named.path)) {
          problems.push(`${filename}: ${dynamic.method.toUpperCase()} ${dynamic.path} shadows ${named.path}`);
        }
      }
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});
