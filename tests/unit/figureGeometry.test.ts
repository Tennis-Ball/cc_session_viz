import { describe, expect, it } from 'vitest';
import { figureGeometry, FIGURE_ROLES, scaleForTier } from '@renderer/office/figures/geometry';

describe('figure geometry', () => {
  it('builds every role', () => {
    // Every role has to build. One that throws takes the whole renderer with
    // it, and the roles most likely to break are the rarest ones to appear.
    for (const role of FIGURE_ROLES) {
      const geometry = figureGeometry(role);
      expect(geometry.getAttribute('position').count, role).toBeGreaterThan(0);
      expect(geometry.getAttribute('normal'), role).toBeTruthy();
      // The shader reads these; a missing one renders black.
      expect(geometry.getAttribute('aGrad'), role).toBeTruthy();
      expect(geometry.getAttribute('aEmissive'), role).toBeTruthy();
      expect(geometry.getAttribute('aGrad').count, role).toBe(geometry.getAttribute('position').count);
    }
  });

  it('gives a bigger model a bigger presence', () => {
    expect(scaleForTier(0)).toBeLessThan(scaleForTier(3));
  });
});
