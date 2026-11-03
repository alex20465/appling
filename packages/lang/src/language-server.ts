#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createApplingLspServices } from './lsp.js';

const connection = createConnection(ProposedFeatures.all);
const realPath = (uri: { fsPath: string }) => existsSync(uri.fsPath) ? realpathSync(uri.fsPath) : uri.fsPath;
startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem, realPath }).shared);
