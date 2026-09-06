interface Size {
  width: number;
  height: number;
}

/** DOM rectangles include preview transforms; CSS lengths do not. */
export function getCompositorCoordinateScales(
  displayed: Size,
  logical: Size,
  output: Size = { width: 1920, height: 1080 }
) {
  if (![displayed.width, displayed.height, logical.width, logical.height, output.width, output.height]
    .every((value) => Number.isFinite(value) && value > 0)) return null;

  return {
    displayScaleX: output.width / displayed.width,
    displayScaleY: output.height / displayed.height,
    logicalScaleX: output.width / logical.width,
    logicalScaleY: output.height / logical.height,
  };
}
