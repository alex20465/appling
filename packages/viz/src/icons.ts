import { icons } from 'lucide';

/** The shapes of an icon, drawn on a 24 by 24 box with a stroke and no fill. */
export type Icon = [tag: string, attributes: Record<string, string | number>][];

/** The Lucide icon of this name as lucide.dev lists it, such as `shopping-cart`; undefined when there is none. */
export function iconOf(name: string): Icon | undefined {
    return (icons as Record<string, Icon>)[name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')];
}
