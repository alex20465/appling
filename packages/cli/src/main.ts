#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createApplingServices, print } from '@appling/lang';

const USAGE = 'Usage: appling <check|fmt> [files or folders...]';

async function main([command, ...paths]: string[]): Promise<number> {
    if (command !== 'check' && command !== 'fmt') {
        console.error(USAGE);
        return 2;
    }
    const files = (paths.length ? paths : ['.']).flatMap(p => applingFiles(resolve(p)));
    const { shared } = createApplingServices(NodeFileSystem);
    const documents = await Promise.all(files.map(f => shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(f))));
    await shared.workspace.DocumentBuilder.build(documents, { validation: command === 'check' });
    return command === 'check' ? check(documents) : format(documents);
}

function check(documents: LangiumDocument[]): number {
    let errors = 0;
    for (const doc of documents) {
        for (const d of doc.diagnostics ?? []) {
            const severity = d.severity === 1 ? 'error' : 'warning';
            if (severity === 'error') errors++;
            console.log(`${relative('.', doc.uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severity} ${d.message}`);
        }
    }
    console.log(`${documents.length} file(s), ${errors} error(s)`);
    return errors ? 1 : 0;
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
