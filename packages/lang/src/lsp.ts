import { AstUtils, inject, URI, type AstNode, type LangiumDocument, type Module } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule, DefaultDocumentUpdateHandler, MultilineCommentHoverProvider,
    type DefaultSharedModuleContext, type Formatter, type LangiumServices, type LangiumSharedServices, type PartialLangiumServices,
    type PartialLangiumSharedServices, type WorkspaceSymbolProvider
} from 'langium/lsp';
import { TextEdit, type WorkspaceSymbol, type WorkspaceSymbolParams } from 'vscode-languageserver';
import { ApplingGeneratedModule, ApplingGeneratedSharedModule } from './generated/module.js';
import { isModule } from './generated/ast.js';
import { ApplingModule } from './appling-module.js';
import { print } from './appling-printer.js';
import { modulePath } from './appling-scope.js';
import { LAYER_OF, registerValidationChecks } from './appling-validator.js';

/** Formats the whole document into canonical form, the same as `appling fmt`. */
export class ApplingFormatter implements Formatter {

    formatDocument(document: LangiumDocument): TextEdit[] {
        const { lexerErrors, parserErrors } = document.parseResult;
        if (lexerErrors.length || parserErrors.length) return [];
        const text = document.textDocument.getText();
        const printed = print(document.parseResult.value);
        if (text === printed) return [];
        const range = { start: document.textDocument.positionAt(0), end: document.textDocument.positionAt(text.length) };
        return [TextEdit.replace(range, printed)];
    }

    formatDocumentRange(document: LangiumDocument): TextEdit[] {
        return this.formatDocument(document);
    }

    formatDocumentOnType(): TextEdit[] {
        return [];
    }

    get formatOnTypeOptions(): undefined {
        return undefined;
    }
}

/** Shows the kind, qualified name and layer of an element, followed by its doc comment. */
export class ApplingHoverProvider extends MultilineCommentHoverProvider {

    protected override async getAstNodeHoverContent(node: AstNode): Promise<string | undefined> {
        const qn = qualifiedName(node);
        if (!qn) return super.getAstNodeHoverContent(node);
        const summary = `${node.$type} \`${qn}\`, ${layerOf(node)} layer`;
        const comment = await super.getAstNodeHoverContent(node);
        return comment ? `${summary}\n\n${comment}` : summary;
    }
}

/**
 * Keeps one document per file when the workspace is also reachable through another path, such as a symlink:
 * the path the editor opened replaces the copy read from disk, or every declaration would exist twice.
 */
export class ApplingDocumentUpdateHandler extends DefaultDocumentUpdateHandler {

    constructor(private readonly services: LangiumSharedServices, private readonly realPath: (uri: URI) => string) {
        super(services);
    }

    protected override fireDocumentUpdate(changed: URI[], deleted: URI[]): void {
        this.workspaceManager.ready.then(() => {
            const opened = new Map(this.services.workspace.TextDocuments.keys().map(uri => [this.realPath(URI.parse(uri)), uri]));
            const copy = (uri: URI) => (opened.get(this.realPath(uri)) ?? uri.toString()) !== uri.toString();
            const copies = this.services.workspace.LangiumDocuments.all.map(d => d.uri).filter(copy).toArray();
            super.fireDocumentUpdate(changed.filter(uri => !copy(uri)), [...deleted, ...copies]);
        });
    }
}

/**
 * Every named element by its qualified name (`sales.Order.status`), for the editor's Go to Symbol in Workspace; the
 * default provider lists only the index, which holds just the exported elements.
 */
export class ApplingWorkspaceSymbolProvider implements WorkspaceSymbolProvider {
    constructor(private readonly shared: LangiumSharedServices) {}

    getSymbols(params: WorkspaceSymbolParams): WorkspaceSymbol[] {
        const { NodeKindProvider } = this.shared.lsp;
        const query = params.query.toLowerCase();
        // the query's letters in order; the editor ranks the matches itself
        const matches = (name: string) => {
            let at = 0;
            for (const char of name.toLowerCase()) if (char === query[at]) at++;
            return at === query.length;
        };
        return this.shared.workspace.LangiumDocuments.all.flatMap(document => AstUtils.streamAst(document.parseResult.value).flatMap(node => {
            const name = qualifiedName(node);
            const segment = name ? this.shared.ServiceRegistry.getServices(document.uri).references.NameProvider.getNameNode(node) : undefined;
            if (!name || !segment || !matches(name)) return [];
            return [{ name, kind: NodeKindProvider.getSymbolKind(node), location: { uri: document.uri.toString(), range: segment.range } }];
        })).toArray();
    }
}

export const ApplingLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        Formatter: () => new ApplingFormatter(),
        HoverProvider: services => new ApplingHoverProvider(services)
    }
};

/** With `realPath`, the real file path of a URI, the server keeps one document per file across symlinked paths. */
export function createApplingLspServices(context: DefaultSharedModuleContext & { realPath?: (uri: URI) => string }): {
    shared: LangiumSharedServices,
    Appling: LangiumServices
} {
    const { realPath } = context;
    const documents: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
        lsp: {
            WorkspaceSymbolProvider: services => new ApplingWorkspaceSymbolProvider(services),
            ...realPath ? { DocumentUpdateHandler: (services: LangiumSharedServices) => new ApplingDocumentUpdateHandler(services, realPath) } : {}
        }
    };
    const shared = inject(createDefaultSharedModule(context), ApplingGeneratedSharedModule, documents);
    const Appling = inject(createDefaultModule({ shared }), ApplingGeneratedModule, ApplingModule, ApplingLspModule);
    shared.ServiceRegistry.register(Appling);
    registerValidationChecks(Appling);
    if (!context.connection) shared.workspace.ConfigurationProvider.initialized({});
    return { shared, Appling };
}

function qualifiedName(node: AstNode): string | undefined {
    const names: string[] = [];
    for (let current: AstNode | undefined = node; current; current = current.$container) {
        if (isModule(current)) return [modulePath(current), ...names].join('.');
        const name = (current as { name?: unknown }).name;
        if (typeof name !== 'string') return undefined;
        names.unshift(name);
    }
    return undefined;
}

function layerOf(node: AstNode): string {
    let member = node;
    while (member.$container && !isModule(member.$container)) member = member.$container;
    return LAYER_OF[member.$type] ?? 'cross';
}
