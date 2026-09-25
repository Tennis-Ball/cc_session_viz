import { describe, expect, it } from 'vitest';
import { boxCorners, fitView, screenBasis, type Point } from '@renderer/office/camera/fit';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { levelY } from '@renderer/office/world/campusTemplate';

const VIEWPORT = { width: 1440, height: 828 };
const POLAR = 0.955;

/** Where a world point lands on screen, in pixels from the window centre. */
function project(point: Point, centre: Point, azimuth: number, polar: number, zoom: number) {
  const { right, up } = screenBasis(azimuth, polar);
  const d: Point = [point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]];
  return {
    x: (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * zoom,
    y: (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * zoom,
  };
}

/** The same frame the office builds: one box per platform, with headroom. */
function campusFrame(deskCount: number): Point[] {
  const desks: DeskRequest[] = Array.from({ length: deskCount }, (_, i) => ({
    id: `s${i}`,
    label: `s${i}`,
    colorIndex: i,
    seats: 1,
  }));
  const campus = buildCampus(desks);
  const points: Point[] = [];
  for (const platform of campus.platforms) {
    const y = levelY(platform.level);
    points.push(
      ...boxCorners(
        [platform.position[0] - platform.size[0] / 2 - 1, y - 1.2, platform.position[1] - platform.size[1] / 2 - 1],
        [platform.position[0] + platform.size[0] / 2 + 1, y + 2.6, platform.position[1] + platform.size[1] / 2 + 1.4],
      ),
    );
  }
  return points;
}

describe('camera fit', () => {
  it('keeps the whole campus on screen from every angle', () => {
    for (const deskCount of [0, 1, 6, 30]) {
      const frame = campusFrame(deskCount);
      for (let step = 0; step < 16; step++) {
        const azimuth = (step * Math.PI) / 8;
        const { zoom, centre } = fitView(frame, azimuth, POLAR, VIEWPORT);
        for (const point of frame) {
          const p = project(point, centre, azimuth, POLAR, zoom);
          expect(Math.abs(p.x), `${deskCount} desks @ ${step}`).toBeLessThanOrEqual(VIEWPORT.width / 2 + 0.5);
          expect(Math.abs(p.y), `${deskCount} desks @ ${step}`).toBeLessThanOrEqual(VIEWPORT.height / 2 + 0.5);
        }
      }
    }
  });

  it('fills the window instead of leaving it half empty', () => {
    for (const deskCount of [1, 4, 12]) {
      const frame = campusFrame(deskCount);
      for (let step = 0; step < 8; step++) {
        const azimuth = (step * Math.PI) / 8;
        const { zoom, centre } = fitView(frame, azimuth, POLAR, VIEWPORT);
        let widest = 0;
        let tallest = 0;
        for (const point of frame) {
          const p = project(point, centre, azimuth, POLAR, zoom);
          widest = Math.max(widest, Math.abs(p.x) * 2);
          tallest = Math.max(tallest, Math.abs(p.y) * 2);
        }
        const fill = Math.max(widest / VIEWPORT.width, tallest / VIEWPORT.height);
        expect(fill, `${deskCount} desks @ ${step}`).toBeGreaterThan(0.85);
      }
    }
  });

  it('centres the campus rather than parking it in a corner', () => {
    const frame = campusFrame(6);
    for (let step = 0; step < 8; step++) {
      const azimuth = (step * Math.PI) / 8;
      const { zoom, centre } = fitView(frame, azimuth, POLAR, VIEWPORT);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const point of frame) {
        const p = project(point, centre, azimuth, POLAR, zoom);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      expect(Math.abs(minX + maxX), `x @ ${step}`).toBeLessThan(1);
      expect(Math.abs(minY + maxY), `y @ ${step}`).toBeLessThan(1);
    }
  });

  it('pulls back as the office grows, never in', () => {
    const small = fitView(campusFrame(1), Math.PI * 0.25, POLAR, VIEWPORT).zoom;
    const big = fitView(campusFrame(24), Math.PI * 0.25, POLAR, VIEWPORT).zoom;
    expect(big).toBeLessThan(small);
  });

  it('does not swing wildly as the camera orbits', () => {
    // The fit is tighter at some angles than others; the camera eases between
    // them. A big spread would read as the office pulsing while you rotate.
    for (const deskCount of [0, 4, 12, 30]) {
      const frame = campusFrame(deskCount);
      const zooms = Array.from(
        { length: 16 },
        (_, step) => fitView(frame, (step * Math.PI) / 8, POLAR, VIEWPORT).zoom,
      );
      // The plan is wider than it is deep, so turning it genuinely changes how
      // much room it needs. The camera eases between the two over about a
      // second, which is why this much is unnoticeable and much more is not.
      expect(Math.max(...zooms) / Math.min(...zooms), `${deskCount} desks`).toBeLessThan(1.5);
    }
  });
});
