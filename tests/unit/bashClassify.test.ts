import { describe, expect, it } from 'vitest';
import { classifyBash } from '@engine/parse/bashClassify';

describe('wrappers', () => {
  it('sees past a leading cd', () => {
    expect(classifyBash('cd /Users/x/repo && npm run typecheck')).toBe('build');
    expect(classifyBash('cd /Users/x/repo && rg -n "classifyBash" src')).toBe('search');
    expect(classifyBash('(cd packages/engine && go test ./...)')).toBe('test');
  });

  it('sees past env assignments and privilege wrappers', () => {
    expect(classifyBash('env NODE_ENV=test npx vitest run')).toBe('test');
    expect(classifyBash('NODE_ENV=production npm run build')).toBe('build');
    expect(classifyBash('sudo rm -rf /tmp/atrium-cache')).toBe('other');
    expect(classifyBash('command ls -la src')).toBe('search');
    expect(classifyBash('time make')).toBe('build');
  });

  it('sees past timeout and its flags', () => {
    expect(classifyBash('timeout 120 npm test')).toBe('test');
    expect(classifyBash('timeout -k 5 30 cargo test')).toBe('test');
  });

  it('sees past package runners', () => {
    expect(classifyBash('npx tsc --noEmit')).toBe('build');
    expect(classifyBash('npx -y playwright test tests/e2e')).toBe('test');
    expect(classifyBash('bunx vitest run')).toBe('test');
    expect(classifyBash('pnpm dlx prettier --write src')).toBe('build');
    expect(classifyBash('bundle exec rspec spec/models')).toBe('test');
    expect(classifyBash('uv run pytest -q')).toBe('test');
  });

  it('joins line continuations', () => {
    expect(classifyBash("rg -n 'foo' \\\n  src")).toBe('search');
  });
});

describe('pipelines and operators', () => {
  it('classifies every stage and keeps the loudest', () => {
    expect(classifyBash('rg -n "foo" src | head -20')).toBe('search');
    expect(classifyBash('cat package.json | jq .scripts')).toBe('read');
    expect(classifyBash('git status | head')).toBe('git');
    expect(classifyBash('ls -la | wc -l')).toBe('search');
    expect(classifyBash('find . -name "*.ts" | xargs grep -l classifyBash')).toBe('search');
  });

  it('does not split inside quotes', () => {
    expect(classifyBash('echo "a && npm test"')).toBe('other');
    expect(classifyBash('echo "npm test | forge build"')).toBe('other');
  });

  it('does not mistake a redirection for an operator', () => {
    expect(classifyBash('npm run build 2>&1 | tail -40')).toBe('build');
  });
});

describe('priority', () => {
  it('lets the publishing step win', () => {
    expect(classifyBash('npm run build && git push')).toBe('publish');
    expect(classifyBash('git add -A && git commit -m "wip" && git push origin main')).toBe('publish');
    expect(classifyBash('git tag -a v1.0.0 -m "cut" && git push --tags')).toBe('publish');
  });

  it('ranks test over build and build over git', () => {
    expect(classifyBash('npm run lint && npm test')).toBe('test');
    expect(classifyBash('cargo build && cargo test')).toBe('test');
    expect(classifyBash('git pull && npm ci && npm run build')).toBe('build');
  });

  it('ranks net over read', () => {
    expect(classifyBash('curl -s https://api.github.com/repos/x/y | jq .name')).toBe('net');
  });
});

describe('read', () => {
  it('covers the file-printing verbs', () => {
    expect(classifyBash("sed -n '1,40p' src/engine/main.ts")).toBe('read');
    expect(classifyBash('cat README.md')).toBe('read');
    expect(classifyBash('tail -n 50 /tmp/atrium.log')).toBe('read');
    expect(classifyBash('wc -l src/shared/*.ts')).toBe('read');
    expect(classifyBash('defaults read com.apple.finder')).toBe('read');
    expect(classifyBash('open src/renderer/index.html')).toBe('read');
  });

  it('treats an in-place sed as an edit, not a read', () => {
    expect(classifyBash("sed -i '' 's/foo/bar/' src/shared/format.ts")).toBe('other');
  });
});

describe('search', () => {
  it('covers the lookup verbs', () => {
    expect(classifyBash('rg -n "classifyBash" src')).toBe('search');
    expect(classifyBash('git grep -n TODO')).toBe('search');
    expect(classifyBash('fd -e ts . src')).toBe('search');
    expect(classifyBash('which node')).toBe('search');
    expect(classifyBash('tree -L 2 src')).toBe('search');
    expect(classifyBash('ls src/engine/**/*.ts')).toBe('search');
  });
});

describe('test', () => {
  it('covers the runners across ecosystems', () => {
    expect(classifyBash('forge test -vvv --match-test testClassify')).toBe('test');
    expect(classifyBash('pytest tests/ -k parse')).toBe('test');
    expect(classifyBash('go test ./... -run TestFoo')).toBe('test');
    expect(classifyBash('dotnet test')).toBe('test');
    expect(classifyBash('swift test')).toBe('test');
    expect(classifyBash('make test')).toBe('test');
    expect(classifyBash('npx vitest run tests/unit/bashClassify.test.ts')).toBe('test');
    expect(classifyBash('npm run test:e2e')).toBe('test');
    expect(classifyBash('bun run test -- --reporter dot')).toBe('test');
    expect(classifyBash('python -m pytest -q')).toBe('test');
  });
});

describe('build', () => {
  it('covers compilers and the check tooling beside them', () => {
    expect(classifyBash('tsc -p tsconfig.node.json --noEmit')).toBe('build');
    expect(classifyBash('npm run typecheck')).toBe('build');
    expect(classifyBash('npm run lint')).toBe('build');
    expect(classifyBash('docker build -t atrium .')).toBe('build');
    expect(classifyBash('./gradlew assembleDebug')).toBe('build');
    expect(classifyBash('mvn -DskipTests package')).toBe('build');
    expect(classifyBash('vite build')).toBe('build');
    expect(classifyBash('cargo clippy --all-targets')).toBe('build');
  });
});

describe('git', () => {
  it('covers local history work', () => {
    expect(classifyBash('git status')).toBe('git');
    expect(classifyBash('git log --oneline -20')).toBe('git');
    expect(classifyBash('git -C /Users/x/repo diff --stat')).toBe('git');
    expect(classifyBash('gh pr view 42')).toBe('git');
    expect(classifyBash('jj st')).toBe('git');
  });

  it('keeps an unpushed annotated tag local', () => {
    expect(classifyBash('git tag -a v1.0.0 -m "cut"')).toBe('git');
  });
});

describe('net', () => {
  it('covers calls that leave the machine', () => {
    expect(classifyBash('curl -s https://api.github.com/repos/x/y')).toBe('net');
    expect(classifyBash('gh api repos/x/y/pulls --jq .[].title')).toBe('net');
    expect(classifyBash('ssh build-box "npm test"')).toBe('net');
    expect(classifyBash('rsync -av ./dist user@host:/srv/atrium')).toBe('net');
    expect(classifyBash('aws s3 ls s3://atrium-builds')).toBe('net');
  });

  it('keeps a local rsync out of the network zone', () => {
    expect(classifyBash('rsync -a ./out ./backup')).toBe('other');
  });
});

describe('publish', () => {
  it('covers the outward-facing commands', () => {
    expect(classifyBash('git push -u origin feature/bash-classify')).toBe('publish');
    expect(classifyBash('gh pr create --fill')).toBe('publish');
    expect(classifyBash('gh pr merge 42 --squash')).toBe('publish');
    expect(classifyBash('gh release create v1.2.3 --generate-notes')).toBe('publish');
    expect(classifyBash('gh issue create -t "bug" -b "repro"')).toBe('publish');
    expect(classifyBash('npm publish --access public')).toBe('publish');
    expect(classifyBash('cargo publish')).toBe('publish');
  });
});

describe('other', () => {
  it('covers housekeeping and script runs', () => {
    expect(classifyBash('mkdir -p src/engine/parse')).toBe('other');
    expect(classifyBash('echo "hello"')).toBe('other');
    expect(classifyBash('node scripts/seed.js')).toBe('other');
    expect(classifyBash('npm install --save-dev vitest')).toBe('other');
    expect(classifyBash('sleep 2')).toBe('other');
    expect(classifyBash('npm run dev')).toBe('other');
  });
});

describe('malformed input', () => {
  it('never throws and falls back to other', () => {
    expect(classifyBash('')).toBe('other');
    expect(classifyBash('   \n\t  ')).toBe('other');
    expect(classifyBash('>>>&&||;;')).toBe('other');
    expect(classifyBash('"unterminated quote')).toBe('other');
  });

  it('treats a heredoc body as payload, not as commands', () => {
    const command = ["cat <<'EOF' > /tmp/note.md", '# notes', 'git push origin main', 'EOF'].join('\n');
    expect(classifyBash(command)).toBe('other');
  });
});

describe('description fallback', () => {
  it('speaks only when the command says nothing', () => {
    expect(classifyBash('./scripts/ci.sh', 'Run the unit tests')).toBe('test');
    expect(classifyBash('./scripts/ci.sh', 'Search for stale usages')).toBe('search');
    expect(classifyBash('./scripts/ci.sh', 'Build the renderer bundle')).toBe('build');
    expect(classifyBash('./scripts/ci.sh', 'Take a nap')).toBe('other');
    expect(classifyBash('./scripts/deploy.sh')).toBe('other');
  });

  it('never overrides a confident command match', () => {
    expect(classifyBash('rg -n "foo" src', 'Build the app')).toBe('search');
    expect(classifyBash('cat package.json', 'Run the test suite')).toBe('read');
  });
});
