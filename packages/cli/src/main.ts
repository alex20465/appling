#!/usr/bin/env node
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print, type ApplingServices, type Model } from '@appling/lang';
import { checkPrerequisites, describe, loadExtension, plan, readConfig, runPlan, type Plan } from '@appling/codegen';
import { buildGraph, dependencies, findApplingFiles, writeRelease, type Graph } from '@appling/model';

const USAGE = [
    'Usage: appling <check|fmt|graph> [files or folders...]',
    '       appling release <version> [files or folders...]',
    '       appling generate [--plan] [files or folders...]'
].join('\n');

async function main([command, ...args]: string[]): Promise<number> {
    if (!['check', 'fmt', 'graph', 'release', 'generate'].includes(command) || (command === 'release' && !args[0])) {
        console.error(USAGE);
        return 2;
    }
    const onlyPlan = command === 'generate' && args[0] === '--plan';
    const [version, paths] = command === 'release' ? [args[0], args.slice(1)] : ['', args.slice(onlyPlan ? 1 : 0)];
    const files = (paths.length ? paths : ['.']).flatMap(p => findApplingFiles(resolve(p)));
    const { shared, Appling } = createApplingServices(NodeFileSystem);
    const documents = await Promise.all(files.map(f => shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(f))));
    await shared.workspace.DocumentBuilder.build(documents, { validation: command !== 'fmt' });
    if (command === 'fmt') return format(documents);
    if (command === 'graph') return graph(documents, Appling);
    if (command === 'release') return release(documents, Appling, version);
    if (command === 'generate') return generate(documents, Appling, onlyPlan);
    const errors = report(documents, console.log);
    console.log(`${documents.length} file(s), ${errors} error(s)`);
    return errors ? 1 : 0;
}

async function generate(documents: LangiumDocument[], services: ApplingServices, onlyPlan: boolean): Promise<number> {
    if (report(documents, console.error)) return 1;
    const targets = readConfig('.').generate ?? [];
    if (!targets.length) {
        console.error('No targets: add "generate": [{ "extension": "...", "out": "..." }] to appling.config.json.');
        return 1;
    }
    const graph = buildGraph(documents.map(doc => doc.parseResult.value as Model), services);
    for (const target of targets) {
        if (await generateTarget(graph, target.extension, target.out, target.options ?? {}, onlyPlan)) return 1;
    }
    return 0;
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
    const missing = checkPrerequisites(extension.prerequisites ?? []);
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
