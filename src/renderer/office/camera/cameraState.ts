/**
 * Where the camera is looking, shared outside React.
 *
 * Anything that has to face the viewer — labels, billboards — reads this in its
 * own frame loop. Passing it through props would re-render the scene sixty
 * times a second to move some text.
 */
export const cameraState = {
  /** Radians. 0 looks down −Z; increasing swings anticlockwise. */
  azimuth: Math.PI * 0.25,
  polar: 0.955,
  zoom: 24,
};
