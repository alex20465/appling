// Eyes are [x, y, radius] in pixels of each artwork, where the painted eyes were removed
export const BOTS = {
  sprout: { w: 474, h: 560, eyes: [[262, 191, 11], [322, 189, 11]] },
  inspect: { w: 429, h: 560, eyes: [[216, 193, 15], [262, 196, 15]] },
} satisfies Record<string, { w: number; h: number; eyes: [number, number, number][] }>;

export type BotName = keyof typeof BOTS;
