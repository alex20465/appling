#!/usr/bin/env node
// Generates a model with one codegen extension and builds the result with the target's real toolchain.
//
//   node scripts/ci/codegen-e2e.mjs <django|ash|go|rust> [examples|constructs ...] [--out <folder>]
//
// Each model (default: both) is copied into its own workspace under --out (default: a new temp folder) with an
// appling.config.json for the target, generated with the built CLI (packages/cli/out/main.js) and then built.
// Needs the workspace built (`pnpm build`) and the target's toolchain on PATH: uv (Django), Elixir with Mix and
// Postgres on localhost (Ash), Go and Postgres on localhost (Go), or Rust. scripts/ci/codegen-e2e-docker.sh runs it in the official images.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'packages/cli/out/main.js');
const MODELS = {
    examples: join(ROOT, 'examples'),
    constructs: join(ROOT, 'packages/lang/test/fixtures/constructs')
};

/** The checks run in the generated project, after `appling generate`. */
const TARGETS = {
    django: {
        checks: [
            ['uv', 'run', 'python', 'manage.py', 'check'],
            ['uv', 'run', 'python', 'manage.py', 'makemigrations', '--check', '--dry-run'],
            ['uv', 'run', 'python', 'manage.py', 'migrate'],
            ['uv', 'run', 'python', 'manage.py', 'test']
        ],
        // Must stop and name the variable when a secret is not set.
        withoutSecrets: ['uv', 'run', 'python', 'manage.py', 'check']
    },
    ash: {
        // The archives igniter.new and phx.new are user level Mix installs; the extension checks for them first.
        prepare: [
            ['mix', 'local.hex', '--force', '--if-missing'],
            ['mix', 'local.rebar', '--force', '--if-missing'],
            ['mix', 'archive.install', 'hex', 'igniter_new', '--force'],
            ['mix', 'archive.install', 'hex', 'phx_new', '--force']
        ],
        checks: [
            ['mix', 'compile', '--warnings-as-errors'],
            ['mix', 'test']
        ],
        withoutSecrets: ['mix', 'run', '--no-start', '-e', ':ok'],
        env: { MIX_ENV: 'test' }
    },
    go: {
        checks: [
            ['go', 'build', './...'],
            ['go', 'vet', './...'],
            ['go', 'test', './...']
        ],
        // The store tests migrate a fresh schema each; without DATABASE_URL they skip.
        env: { DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable' }
    },
    rust: {
        checks: [
            ['cargo', 'check', '--all-targets'],
            ['cargo', 'test']
        ],
        // The generated crates compile without warnings; keep it that way.
        env: { RUSTFLAGS: '-D warnings' }
    }
};

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outRoot = outAt >= 0 ? resolve(args.splice(outAt, 2)[1]) : undefined;
const [target, ...models] = args;
if (!TARGETS[target] || models.some(m => !MODELS[m])) {
    console.error(`Usage: node scripts/ci/codegen-e2e.mjs <${Object.keys(TARGETS).join('|')}> [${Object.keys(MODELS).join('|')} ...] [--out <folder>]`);
    process.exit(2);
}
if (!existsSync(CLI)) {
    console.error(`${CLI} is missing: run "pnpm build" first.`);
    process.exit(2);
}

const config = TARGETS[target];
const root = outRoot ?? mkdtempSync(join(tmpdir(), `appling-e2e-${target}-`));
mkdirSync(root, { recursive: true });
const failed = [];

for (const step of config.prepare ?? []) {
    if (!run(step, root)) process.exit(1);
}
for (const model of models.length ? models : Object.keys(MODELS)) {
    const name = `${model}_app`;
    const workspace = join(root, model);
    if (existsSync(workspace) && readdirSync(workspace).length) {
        console.error(`${workspace} is not empty; pass another --out.`);
        process.exit(2);
    }
    group(`${target}: generate ${model}`);
    cpSync(MODELS[model], workspace, { recursive: true, filter: source => basename(source) !== '.appling' });
    const extension = `@appling/codegen-${target}`;
    writeFileSync(join(workspace, 'appling.config.json'), JSON.stringify({ generate: [{ extension, out: name }] }, null, 2) + '\n');
    // The extension resolves from the workspace's appling.config.json, so link the built package next to it.
    mkdirSync(join(workspace, 'node_modules/@appling'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', `codegen-${target}`), join(workspace, 'node_modules', extension), 'dir');
    let ok = run([process.execPath, CLI, 'generate'], workspace);
    const keys = ok ? envKeys(join(workspace, name, '.env.example')) : [];
    const secrets = keys.filter(k => k.secret).map(k => k.name);
    // Every key gets a placeholder, the way a developer fills .env from .env.example ('0' parses as Int and Bool too).
    const env = { ...config.env, ...Object.fromEntries(keys.map(k => [k.name, '0'])) };
    for (const check of config.checks) {
        if (!ok) break;
        group(`${target}: ${model}: ${check.join(' ')}`);
        ok = run(check, join(workspace, name), env);
    }
    // After the checks, so the compile check above sees a clean build.
    if (ok && config.withoutSecrets && secrets.length) {
        group(`${target}: ${model}: without ${secrets.join(', ')}`);
        ok = failsNaming(config.withoutSecrets, join(workspace, name), config.env, secrets);
    }
    endGroup();
    if (!ok) failed.push(model);
}

console.log(`\n${target}: ${failed.length ? `failed for ${failed.join(', ')}` : 'every model generated and built'} (projects in ${root})`);
process.exit(failed.length ? 1 : 0);

/** The keys `.env.example` lists, each with whether the comment above it marks a secret. */
function envKeys(file) {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n');
    return lines.flatMap((line, i) => {
        const key = /^([A-Z0-9_]+)=$/.exec(line);
        return key ? [{ name: key[1], secret: (lines[i - 1] ?? '').startsWith('# secret of ') }] : [];
    });
}

/** Runs a command with the secrets unset and expects it to fail with a message naming the first one. */
function failsNaming([command, ...rest], cwd, env, secrets) {
    console.log(`$ ${[command, ...rest].join(' ')}   (in ${cwd}, without ${secrets.join(', ')})`);
    const clean = { ...process.env, ...env };
    for (const name of secrets) delete clean[name];
    const result = spawnSync(command, rest, { cwd, encoding: 'utf8', env: clean });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 && secrets.some(name => output.includes(name))) {
        console.log(`stopped as expected: ${output.trim().split('\n').filter(l => secrets.some(n => l.includes(n))).at(-1)}`);
        return true;
    }
    console.error(output.slice(-4000));
    console.error(result.status === 0 ? 'expected the app to stop without its secrets, but it started' : 'the app failed without naming the missing secret');
    return false;
}

function run([command, ...rest], cwd, env = {}) {
    console.log(`$ ${[command, ...rest].join(' ')}   (in ${cwd})`);
    const result = spawnSync(command, rest, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) console.error(`exit ${result.status ?? result.signal}: ${[command, ...rest].join(' ')}`);
    return result.status === 0;
}

function group(title) {
    endGroup();
    console.log(process.env.GITHUB_ACTIONS ? `::group::${title}` : `\n== ${title}`);
    group.open = true;
}

function endGroup() {
    if (group.open && process.env.GITHUB_ACTIONS) console.log('::endgroup::');
    group.open = false;
}
