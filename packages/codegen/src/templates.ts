import { resolve } from 'node:path';
import nunjucks from 'nunjucks';
import type { CodegenExtension } from './contract.js';

/** Renders one template with its data; the result has no blank lines before or after it, so a template may start with a comment. */
export type Render = (template: string, data: object) => string;

/** The project folder whose templates replace the extension's own by path: the target option `templates`, else `.appling/templates/<target>`. */
export function overrideFolder(root: string, extension: CodegenExtension, options: Record<string, unknown>): string {
    const target = extension.name.split('/').pop()!.replace(/^codegen-/, '');
    return resolve(root, typeof options.templates === 'string' ? options.templates : `.appling/templates/${target}`);
}

/** The prefix that names the extension's own template, so an override can extend the template it replaces. */
export const ORIGINAL = 'original:';

/**
 * A Nunjucks renderer that looks a template up in the project's override folder first, then in the extension's
 * `templates` folder; `original:<path>` always names the extension's own template.
 */
export function templateRenderer(root: string, extension: CodegenExtension, options: Record<string, unknown>): Render {
    const own = new nunjucks.FileSystemLoader(extension.templates ? [extension.templates] : []);
    const original = { getSource: (name: string) => name.startsWith(ORIGINAL) ? own.getSource(name.slice(ORIGINAL.length)) : null };
    const loaders = [new nunjucks.FileSystemLoader(overrideFolder(root, extension, options)), own, original as unknown as nunjucks.ILoader];
    const env = new nunjucks.Environment(loaders, { autoescape: false, throwOnUndefined: true, trimBlocks: true, lstripBlocks: true });
    return (template, data) => env.render(template, data).replace(/^\n+|\n+$/g, '');
}
