#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print, type ApplingServices, type Model } from '@appling/lang';
import {
    BASELINE, checkPrerequisites, describe, loadExtension, mergeGeneration, pendingChanges, plan, planMigrations, readApplied, readConfig, readRegistry,
    runMigrations, runPlan, type Plan
} from '@appling/codegen';
import { buildGraph, dependencies, findApplingFiles, Simulator, writeRelease, type Graph } from '@appling/model';

const USAGE = [
    'Usage: appling <check|fmt|graph> [files or folders...]',
    '       appling release <version> [files or folders...]',
    '       appling generate [--plan | --migrate | --sync] [files or folders...]',
    '       appling simulate <reach <machine> <state> | actors <action> | risks <action>> [files or folders...]'
].join('\n');

async function main([command, ...args]: string[]): Promise<number> {
    const question = command === 'simulate' ? args.slice(0, args[0] === 'reach' ? 3 : 2) : [];
    if (!['check', 'fmt', 'graph', 'release', 'generate', 'simulate'].includes(command) || (command === 'release' && !args[0])
        || (command === 'simulate' && (!['reach', 'actors', 'risks'].includes(question[0]) || question.some(a => !a)))) {
        console.error(USAGE);
        return 2;
    }
    const mode = command === 'generate' && ['--plan', '--migrate', '--sync'].includes(args[0]) ? args[0] : undefined;
    const [version, paths] = command === 'release' ? [args[0], args.slice(1)] : ['', args.slice(mode ? 1 : question.length)];
    const files = (paths.length ? paths : ['.']).flatMap(p => findApplingFiles(resolve(p)));
    const { shared, Appling } = createApplingServices(NodeFileSystem);
    const documents = await Promise.all(files.map(f => shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(f))));
    await shared.workspace.DocumentBuilder.build(documents, { validation: command !== 'fmt' });
    if (command === 'fmt') return format(documents);
    if (command === 'graph') return graph(documents, Appling);
    if (command === 'release') return release(documents, Appling, version);
    if (command === 'generate') return generate(documents, Appling, mode);
    if (command === 'simulate') return simulate(documents, Appling, question);
    const errors = report(documents, console.log);
    console.log(`${documents.length} file(s), ${errors} error(s)`);
    return errors ? 1 : 0;
}

function simulate(documents: LangiumDocument[], services: ApplingServices, [question, target, state]: string[]): number {
    if (report(documents, console.error)) return 1;
    const simulator = new Simulator(buildGraph(documents.map(doc => doc.parseResult.value as Model), services));
    try {
        if (question === 'reach') {
            const reach = simulator.reach(target, state);
            console.log(reach
                ? [`${state} is reachable from ${reach.from}:`, ...reach.path.map(p => `  ${p.trigger} -> ${p.to}${p.guarded ? ' (guarded)' : ''}`)].join('\n')
                : `${state} is not reachable`);
        } else if (question === 'actors') {
            for (const { actor, verdict } of simulator.actors(target)) console.log(`${actor}: ${verdict === 'depends' ? 'depends on the data' : verdict}`);
        } else {
            const risks = simulator.risks(target);
            console.log(risks.length ? risks.map(r => `${r.invariant} (reads ${r.fields.join(', ')})`).join('\n') : 'no invariant reads a field this action changes');
        }
        return 0;
    } catch (error) {
        console.error((error as Error).message);
        return 1;
    }
}

async function generate(documents: LangiumDocument[], services: ApplingServices, mode: string | undefined): Promise<number> {
    if (report(documents, console.error)) return 1;
    const targets = readConfig('.').generate ?? [];
    if (!targets.length) {
        console.error('No targets: add "generate": [{ "extension": "...", "out": "..." }] to appling.config.json.');
        return 1;
    }
    const graph = buildGraph(documents.map(doc => doc.parseResult.value as Model), services);
    for (const target of targets) {
        const failed = mode === '--migrate' ? await migrateTarget(graph, target.extension, target.out, target.options ?? {})
            : mode === '--sync' ? await syncTarget(graph, target.extension, target.out, target.options ?? {})
            : await generateTarget(graph, target.extension, target.out, target.options ?? {}, mode === '--plan');
        if (failed) return 1;
    }
    return 0;
}

/**
 * Brings a generated project up to the current model: applies pending migration steps, generates the model
 * afresh in a temporary folder and merges it three ways with the project. Returns true when it failed.
 */
async function syncTarget(graph: Graph, name: string, out: string, options: Record<string, unknown>): Promise<boolean> {
    if (!readRegistry(out) || !existsSync(join(out, BASELINE))) {
        console.error(`${out} has no generation baseline. Generate it with this version of appling first.`);
        return true;
    }
    const extension = await loadExtension(name, '.');
    if (extension.migrate && await migrateTarget(graph, name, out, options)) return true;
    const missing = checkPrerequisites(extension.prerequisites ?? [], graph);
    if (missing.length) {
        missing.forEach(m => console.error(m));
        return true;
    }
    const temp = mkdtempSync(join(tmpdir(), 'appling-sync-'));
    try {
        const next = join(temp, basename(resolve(out)));
        runPlan(plan(graph, extension, String(options.name ?? basename(resolve(out))), options), next, line => console.log(`  ${line}`));
        const report = mergeGeneration(out, next, extension.syncExclude ?? []);
        for (const [label, files] of Object.entries(report)) if (files.length) console.log(`${label}: ${files.join(', ')}`);
        console.log(`${out}: synced${report.conflicts.length ? `, ${report.conflicts.length} file(s) with conflict markers (registry tasks)` : ''}`);
        return false;
    } catch (error) {
        console.error((error as Error).message);
        return true;
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

/** Carries the model's migration steps that a generated project has not applied yet into it. Returns true when it failed. */
async function migrateTarget(graph: Graph, name: string, out: string, options: Record<string, unknown>): Promise<boolean> {
    if (!readRegistry(out)) {
        console.error(`${out} was not generated yet. Run "appling generate" first.`);
        return true;
    }
    const extension = await loadExtension(name, '.');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const changes = pendingChanges(graph, readApplied(out), stamp);
    if (!changes.length) {
        console.log(`${out}: no pending migration steps`);
        return false;
    }
    try {
        const plan = planMigrations(graph, extension, String(options.name ?? basename(resolve(out))), options, out, changes);
        runMigrations(out, plan, changes, line => console.log(line));
        console.log(`${out}: ${changes.length} migration step(s) applied, ${plan.tasks.length} task(s) added to the registry`);
        return false;
    } catch (error) {
        console.error((error as Error).message);
        return true;
    }
}

/** Returns true when the target failed. */
async function generateTarget(graph: Graph, name: string, out: string, options: Record<string, unknown>, onlyPlan: boolean): Promise<boolean> {
    const extension = await loadExtension(name, '.');
    const result = plan(graph, extension, String(options.name ?? basename(resolve(out))), options);
    if (onlyPlan) {
        console.log(`${name} -> ${out}`);
        for (const { node, step } of result.steps) console.log(`  ${node}: ${describe(step)}`);
        console.log(summary(result));
        return false;
    }
    const missing = checkPrerequisites(extension.prerequisites ?? [], graph);
    if (missing.length) {
        missing.forEach(m => console.error(m));
        return true;
    }
    if (existsSync(out) && readdirSync(out).length) {
        console.error(`${out} is not empty. Generation creates a new draft project once.`);
        return true;
    }
    try {
        runPlan(result, out, line => console.log(line));
    } catch (error) {
        console.error((error as Error).message);
        return true;
    }
    console.log(summary(result));
    return false;
}

function summary(result: Plan): string {
    const count = (status: string) => result.entries.filter(e => e.status === status).length;
    return `${result.entries.length} element(s): ${count('generated')} generated, ${count('partial')} partial, ${count('todo')} todo`;
}

function release(documents: LangiumDocument[], services: ApplingServices, version: string): number {
    if (report(documents, console.error)) return 1;
    try {
        const file = writeRelease('.', version, buildGraph(documents.map(doc => doc.parseResult.value as Model), services));
        console.log(`released ${version} to ${relative('.', file)}`);
        return 0;
    } catch (error) {
        console.error((error as Error).message);
        return 1;
    }
}

/** Prints every diagnostic and returns the number of errors. */
function report(documents: LangiumDocument[], log: (line: string) => void): number {
    let errors = 0;
    for (const doc of documents) {
        for (const d of doc.diagnostics ?? []) {
            const severity = d.severity === 1 ? 'error' : 'warning';
            if (severity === 'error') errors++;
            log(`${relative('.', doc.uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity} ${d.message}`);
        }
    }
    return errors;
}

function graph(documents: LangiumDocument[], services: ApplingServices): number {
    if (report(documents, console.error)) return 1;
    const result = buildGraph(documents.map(doc => doc.parseResult.value as Model), services);
    console.log(JSON.stringify({ ...result, dependencies: dependencies(result) }, null, 2));
    return 0;
}

function format(documents: LangiumDocument[]): number {
    let failed = 0;
    for (const doc of documents) {
        const { lexerErrors, parserErrors } = doc.parseResult;
        if (lexerErrors.length || parserErrors.length) {
            failed++;
            console.error(`${relative('.', doc.uri.fsPath)}: not formatted, fix syntax errors first (run "appling check")`);
            continue;
        }
        const text = print(doc.parseResult.value);
        if (text !== doc.textDocument.getText()) {
            writeFileSync(doc.uri.fsPath, text);
            console.log(`formatted ${relative('.', doc.uri.fsPath)}`);
        }
    }
    return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(code => process.exit(code));
