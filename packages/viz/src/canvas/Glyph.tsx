import { createElement } from 'react';
import { iconOf } from '../icons.js';

/** A Lucide icon by its name, drawn in the colour of the text around it. */
export function Glyph({ name, size = 16 }: { name: string, size?: number }) {
    return (
        <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {iconOf(name)?.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
        </svg>
    );
}
