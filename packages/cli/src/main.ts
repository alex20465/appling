#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print, type Model } from '@appling/lang';
import { buildGraph, dependencies } from '@appling/model';

const USAGE = 'Usage: appling <check|fmt|graph> [files or folders...]';

async function main([command, ...paths]: string[]): Promise<number> {
    if (command !== 'check' && command !== 'fmt' && command !== 'graph') {
        console.error(USAGE);
        return 2;
    }
    const files = (paths.length ? paths : ['.']).flatMap(p => applingFiles(resolve(p)));
    const { shared } = createApplingServices(NodeFileSystem);
    const documents = await Promise.all(files.map(f => shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(f))));
    await shared.workspace.DocumentBuilder.build(documents, { validation: command !== 'fmt' });
    if (command === 'fmt') return format(documents);
    if (command === 'graph') return graph(documents);
    const errors = report(documents, console.log);
    console.log(`${documents.length} file(s), ${errors} error(s)`);
    return errors ? 1 : 0;
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

function graph(documents: LangiumDocument[]): number {
    if (report(documents, console.error)) return 1;
    const result = buildGraph(documents.map(doc => doc.parseResult.value as Model));
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

function applingFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .flatMap(e => e.isDirectory() ? applingFiles(join(path, e.name)) : e.name.endsWith('.appling') ? [join(path, e.name)] : []);
}

main(process.argv.slice(2)).then(code => process.exit(code));
