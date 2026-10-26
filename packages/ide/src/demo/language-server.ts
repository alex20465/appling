import { EmptyFileSystem } from 'langium';
import { startLanguageServer } from 'langium/lsp';
import { BrowserMessageReader, BrowserMessageWriter, createConnection } from 'vscode-languageserver/browser';
import { createApplingLspServices } from '@appling/lang/lsp';

const connection = createConnection(new BrowserMessageReader(self), new BrowserMessageWriter(self));
startLanguageServer(createApplingLspServices({ connection, ...EmptyFileSystem }).shared);
