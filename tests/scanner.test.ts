import { describe, expect, it } from 'vitest';
import { combineConfirmations } from '../src/scanner.js';

describe('positive confirmation gate', () => {
  it('keeps a positive only when both decisions agree', () => {
    expect(
      combineConfirmations(
        { detected: true, diceProbability: 0.99, lookalikeProbability: 0.01 },
        { detected: true, diceProbability: 0.97, lookalikeProbability: 0.03 },
      ),
    ).toEqual({ detected: true, diceProbability: 0.97, lookalikeProbability: 0.03 });
  });

  it('rejects an unstable first-pass false positive', () => {
    expect(
      combineConfirmations(
        { detected: true, diceProbability: 0.98, lookalikeProbability: 0.02 },
        { detected: false, diceProbability: 0.12, lookalikeProbability: 0.91 },
      ),
    ).toEqual({ detected: false, diceProbability: 0.12, lookalikeProbability: 0.91 });
  });
});
