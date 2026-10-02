import { describe, expect, it } from 'vitest';
import { HIT_DROP, HIT_HEIGHT, HIT_RADIUS } from '@renderer/office/scene/Figures';
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

describe('the hitbox', () => {
  /**
   * The pointer's shape has to contain the drawn one, for every role.
   *
   * "Clickable" used to mean the model itself, which is a cone thirty
   * centimetres across with a ball balanced above it — a target a few pixels
   * wide at the zoom the office is usually watched at, with a gap between the
   * shoulders and the head that the ray went straight through. Every role is a
   * different silhouette, so the only way to know the capsule covers all of
   * them is to measure all of them.
   */
  it('encloses every silhouette the office draws', () => {
    for (const role of FIGURE_ROLES) {
      const geometry = figureGeometry(role);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      expect(box, role).not.toBeNull();

      const reach = Math.max(
        Math.abs(box!.min.x),
        Math.abs(box!.max.x),
        Math.abs(box!.min.z),
        Math.abs(box!.max.z),
      );
      expect(reach, `${role} is wider than the hitbox`).toBeLessThanOrEqual(HIT_RADIUS);
      expect(box!.max.y, `${role} is taller than the hitbox`).toBeLessThanOrEqual(HIT_HEIGHT - HIT_DROP);
      // And its feet are inside the bottom of it.
      expect(box!.min.y, `${role} hangs below the hitbox`).toBeGreaterThanOrEqual(-HIT_DROP);
    }
  });
});
