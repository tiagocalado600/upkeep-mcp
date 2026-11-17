import { describe, expect, it } from 'vitest';
import { sentence } from '../../src/lib/text.js';

describe('sentence', () => {
  it('adds a full stop to a sentence without one', () => {
    expect(sentence('Registrar: Example Registrar')).toBe('Registrar: Example Registrar.');
  });

  it('does not double the full stop a name already ends in', () => {
    expect(sentence('Registrar: Example Registrar Inc.')).toBe('Registrar: Example Registrar Inc.');
  });

  it('leaves other terminal punctuation alone', () => {
    expect(sentence('Issued by Example!')).toBe('Issued by Example!');
  });
});
