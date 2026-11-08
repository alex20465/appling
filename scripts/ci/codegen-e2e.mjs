#!/usr/bin/env node
// Generates a model with one codegen extension and builds the result with the target's real toolchain.
//
//   node scripts/ci/codegen-e2e.mjs <django|ash|go|rust> [examples|constructs ...] [--out <folder>]
//
// Each model (default: both) is copied into its own workspace under --out (default: a new temp folder) with an
// appling.config.json for the target, generated with the built CLI (packages/cli/out/main.js) and then built.
// Needs the workspace built (`pnpm build`) and the target's toolchain on PATH: uv (Django), Elixir with Mix and
// Postgres on localhost (Ash), Go, or Rust. scripts/ci/codegen-e2e-docker.sh runs it in the official images.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
        ]
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
        env: { MIX_ENV: 'test' }
    },
    go: {
        checks: [
            ['go', 'build', './...'],
            ['go', 'vet', './...'],
            ['go', 'test', './...']
        ]
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
    for (const check of config.checks) {
        if (!ok) break;
        group(`${target}: ${model}: ${check.join(' ')}`);
        ok = run(check, join(workspace, name), config.env);
    }
    endGroup();
    if (!ok) failed.push(model);
}

console.log(`\n${target}: ${failed.length ? `failed for ${failed.join(', ')}` : 'every model generated and built'} (projects in ${root})`);
process.exit(failed.length ? 1 : 0);

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
