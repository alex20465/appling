#!/usr/bin/env node
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createApplingLspServices } from './lsp.js';

const connection = createConnection(ProposedFeatures.all);
startLanguageServer(createApplingLspServices({ connection, ...NodeFileSystem }).shared);
