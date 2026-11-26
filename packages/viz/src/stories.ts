import type { ModelView } from './views.js';

/** One angle of a view on one element of the repository's `examples/`: the stories page and the landing site draw it. */
export interface Story {
    id: string;
    view: ModelView;
    /** The element the view starts from: the declaration unfolded on the level canvas (from its own level), the machine, the actor. */
    element: string;
    title: string;
    question: string;
    text: string;
}

export const STORIES: Story[] = [
    {
        id: 'placeorder-levels',
        view: 'levels',
        element: 'sales.PlaceOrder',
        title: 'Levels',
        question: 'What rests on what?',
        text: 'The PlaceOrder action unfolded: the Order it rests on below, the use cases, interfaces and access that rest on it above, each in the band of its level.'
    },
    {
        id: 'order-states',
        view: 'states',
        element: 'sales.OrderFlow',
        title: 'States',
        question: 'How does it change?',
        text: 'The state diagram of OrderFlow: its states, and every transition with the action or event that drives it and its guard.'
    },
    {
        id: 'shopper-usecases',
        view: 'usecases',
        element: 'sales.Shopper',
        title: 'Use cases',
        question: 'Who does what?',
        text: 'What the Shopper may start, and what each of those use cases includes.'
    },
    {
        id: 'shopper-screens',
        view: 'screens',
        element: 'sales.Shopper',
        title: 'Screens',
        question: 'What does it look like?',
        text: 'A clickable mockup of the application as the Shopper sees it: its menu, its pages and the next buttons along its flows.'
    }
];
