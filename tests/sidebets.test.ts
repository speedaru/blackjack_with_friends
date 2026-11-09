import { describe, expect, it } from 'vitest';
import type { Card, Rank, Suit } from '../shared/types.js';
import { evaluate21Plus3, evaluatePairs, evaluateSideBet } from '../server/sidebets.js';

/** Builds cards from short text like "AS KH 7D". */
function cards(text: string): Card[] {
  return text.split(' ').map((t) => ({ rank: t.slice(0, -1) as Rank, suit: t.slice(-1) as Suit }));
}

describe('evaluatePairs', () => {
  it('pays 25:1 for a perfect pair (same suit)', () => {
    expect(evaluatePairs(cards('8H 8H'))).toEqual({ name: 'Perfect pair', multiplier: 25 });
  });

  it('pays 12:1 for a colored pair (same color, other suit)', () => {
    expect(evaluatePairs(cards('8H 8D'))).toEqual({ name: 'Colored pair', multiplier: 12 });
    expect(evaluatePairs(cards('KS KC'))).toEqual({ name: 'Colored pair', multiplier: 12 });
  });

  it('pays 5:1 for a mixed pair (other color)', () => {
    expect(evaluatePairs(cards('8H 8S'))).toEqual({ name: 'Mixed pair', multiplier: 5 });
  });

  it('loses when the ranks differ, even if both are worth 10', () => {
    expect(evaluatePairs(cards('KH QH'))).toBeNull();
    expect(evaluatePairs(cards('2C 9C'))).toBeNull();
  });
});

describe('evaluate21Plus3', () => {
  it('pays 100:1 for suited trips', () => {
    expect(evaluate21Plus3(cards('7D 7D'), cards('7D')[0]!)).toEqual({ name: 'Suited trips', multiplier: 100 });
  });

  it('pays 40:1 for a straight flush', () => {
    expect(evaluate21Plus3(cards('9S 10S'), cards('JS')[0]!)).toEqual({ name: 'Straight flush', multiplier: 40 });
  });

  it('pays 30:1 for three of a kind', () => {
    expect(evaluate21Plus3(cards('7D 7S'), cards('7H')[0]!)).toEqual({ name: 'Three of a kind', multiplier: 30 });
  });

  it('pays 10:1 for a straight, with the ace low or high', () => {
    expect(evaluate21Plus3(cards('5H 3S'), cards('4C')[0]!)).toEqual({ name: 'Straight', multiplier: 10 });
    expect(evaluate21Plus3(cards('AH 2S'), cards('3C')[0]!)).toEqual({ name: 'Straight', multiplier: 10 });
    expect(evaluate21Plus3(cards('QH KS'), cards('AC')[0]!)).toEqual({ name: 'Straight', multiplier: 10 });
  });

  it('does not wrap a straight around the ace', () => {
    expect(evaluate21Plus3(cards('KH AS'), cards('2C')[0]!)).toBeNull();
  });

  it('pays 5:1 for a flush', () => {
    expect(evaluate21Plus3(cards('2H 9H'), cards('KH')[0]!)).toEqual({ name: 'Flush', multiplier: 5 });
  });

  it('loses on a pair or nothing', () => {
    expect(evaluate21Plus3(cards('7D 7S'), cards('9H')[0]!)).toBeNull();
    expect(evaluate21Plus3(cards('2D 7S'), cards('9H')[0]!)).toBeNull();
  });
});

describe('evaluateSideBet', () => {
  it('picks the evaluator for the kind', () => {
    expect(evaluateSideBet('pairs', cards('8H 8H'), cards('2C')[0]!)?.multiplier).toBe(25);
    expect(evaluateSideBet('plus3', cards('2H 9H'), cards('KH')[0]!)?.multiplier).toBe(5);
  });
});
