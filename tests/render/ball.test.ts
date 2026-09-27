import { describe, expect, it } from 'vitest';
import { flightBall } from '../../src/render/ball';
import { flight } from '../core/turnFixtures';

describe('the insane ball trail (power-meter spec §6)', () => {
  it('marks an insane flight hot with a 4-sample trail; other tiers keep 2 samples', () => {
    const hot = flightBall(flight({ tier: 'insane' }), 500, 1);
    expect(hot.kind === 'air' && hot.hot).toBe(true);
    expect(hot.kind === 'air' && hot.trail).toHaveLength(4);
    const plain = flightBall(flight({ tier: 'medium' }), 500, 1);
    expect(plain.kind === 'air' && plain.hot).toBe(false);
    expect(plain.kind === 'air' && plain.trail).toHaveLength(2);
  });
});
