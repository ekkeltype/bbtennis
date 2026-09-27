import { describe, expect, it } from 'vitest';
import { POWER_TEXT } from '../../src/ui/screens/howTo';

describe('How to Play: the power meter (power-meter spec §6)', () => {
  it('explains filling, the insane word and what empties the meter', () => {
    for (const phrase of ['POWER METER', 'four', 'INSANE', 'wrong key', 'losing a point']) {
      expect(POWER_TEXT, phrase).toContain(phrase);
    }
  });
});
