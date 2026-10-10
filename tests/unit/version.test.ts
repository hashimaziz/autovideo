import { describe, expect, it } from 'vitest';

import { VERSION, VERSION_PATTERN } from '../../src/version.js';

describe('version', () => {
  it('is a valid semantic version', () => {
    expect(VERSION).toMatch(VERSION_PATTERN);
  });

  it('is not the placeholder value', () => {
    // A shipped package whose manifest says "0.0.0" or "0.1.0-alpha" forever makes
    // every reproducibility claim about it unverifiable. This fails loudly instead.
    expect(VERSION).not.toBe('0.0.0');
  });
});
