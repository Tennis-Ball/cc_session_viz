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
  /**
   * How far the viewer has pulled back from the fitted framing. 1 is home.
   *
   * `zoom` is the camera's own, which is the *fit* times this — and the fit
   * changes with the angle, with the window and with how many desks are out, so
   * it says nothing about what the viewer asked for. Anything that means "the
   * office has become a map", rather than "the camera happens to be steep",
   * wants this one.
   */
  reach: 1,
};
