export type PointerPose =
  | 'point-right'
  | 'point-right_down'
  | 'point-down'
  | 'point-left_down'
  | 'point-left'
  | 'point-left_up'
  | 'point-up'
  | 'point-right_up';

export interface PointerPoseConfig {
  pose: PointerPose;
  pointerOffset: { x: number; y: number };
}

export interface PointerPoseCandidate extends PointerPoseConfig {
  desiredTopLeft: { x: number; y: number };
  clampedTopLeft: { x: number; y: number };
  actualPoint: { x: number; y: number };
  errorPx: number;
  isPreferredPose: boolean;
}

export interface PointerWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PointerTopLeftClamp = (
  topLeft: { x: number; y: number },
  windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>
) => { x: number; y: number };

export interface PointerAlignmentOptions {
  useSpriteFingertips?: boolean;
  spriteCalibrations?: Partial<Record<PointerPose, PointerSpriteCalibration>>;
  regionInsetRatio?: number;
  minRegionInsetPx?: number;
  maxRegionInsetPx?: number;
  preferredPose?: PointerPose;
  posePreferenceTolerancePx?: number;
  clampTopLeft?: PointerTopLeftClamp;
}

export interface PointerSpriteCalibration {
  imageWidth: number;
  imageHeight: number;
  fingertip: { x: number; y: number };
}

export interface PointerRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

const MIN_AXIS_THRESHOLD_PX = 12;
const MAX_AXIS_THRESHOLD_PX = 32;
const AXIS_THRESHOLD_RATIO = 0.08;
const DEFAULT_REGION_INSET_RATIO = 0.08;
const DEFAULT_MIN_REGION_INSET_PX = 8;
const DEFAULT_MAX_REGION_INSET_PX = 26;
const WINDOW_EXTRA_WIDTH_PX = 50;
const WINDOW_EXTRA_HEIGHT_PX = 80;
const DEFAULT_POSE_PREFERENCE_TOLERANCE_PX = 0.75;

export const POINTER_POSES: readonly PointerPose[] = [
  'point-right',
  'point-right_down',
  'point-down',
  'point-left_down',
  'point-left',
  'point-left_up',
  'point-up',
  'point-right_up',
];

const DEFAULT_SPRITE_CALIBRATIONS: Record<PointerPose, PointerSpriteCalibration> = {
  'point-right': { imageWidth: 311, imageHeight: 376, fingertip: { x: 305, y: 195 } },
  'point-right_down': { imageWidth: 321, imageHeight: 376, fingertip: { x: 300, y: 289 } },
  'point-down': { imageWidth: 311, imageHeight: 376, fingertip: { x: 165, y: 344 } },
  'point-left_down': { imageWidth: 305, imageHeight: 376, fingertip: { x: 29, y: 282 } },
  'point-left': { imageWidth: 321, imageHeight: 387, fingertip: { x: 8, y: 195 } },
  'point-left_up': { imageWidth: 311, imageHeight: 387, fingertip: { x: 17, y: 101 } },
  'point-up': { imageWidth: 305, imageHeight: 387, fingertip: { x: 55, y: 79 } },
  'point-right_up': { imageWidth: 311, imageHeight: 387, fingertip: { x: 285, y: 98 } },
};

export function resolvePointerPoseConfig(
  screenPoint: { x: number; y: number },
  windowBounds: PointerWindowBounds,
  options?: PointerAlignmentOptions
): PointerPoseConfig {
  const candidate = resolvePointerPoseCandidate(screenPoint, windowBounds, options);
  return {
    pose: candidate.pose,
    pointerOffset: candidate.pointerOffset,
  };
}

export function resolvePointerPoseCandidate(
  screenPoint: { x: number; y: number },
  windowBounds: PointerWindowBounds,
  options?: PointerAlignmentOptions
): PointerPoseCandidate {
  const windowCenterX = windowBounds.x + windowBounds.width / 2;
  const windowCenterY = windowBounds.y + windowBounds.height / 2;
  const dx = screenPoint.x - windowCenterX;
  const dy = screenPoint.y - windowCenterY;
  const threshold = resolveAxisThreshold(windowBounds);
  const preferredPose = options?.preferredPose ?? poseFromDelta(dx, dy, threshold);
  const candidates = resolvePointerPoseCandidates(screenPoint, windowBounds, {
    ...options,
    preferredPose,
  });
  return selectBestPointerPoseCandidate(
    candidates,
    preferredPose,
    options?.posePreferenceTolerancePx
  );
}

export function resolvePointerPoseCandidates(
  screenPoint: { x: number; y: number },
  windowBounds: PointerWindowBounds,
  options: PointerAlignmentOptions = {}
): PointerPoseCandidate[] {
  const preferredPose = options.preferredPose;
  return POINTER_POSES.map((pose) => {
    const pointerOffset = pointerOffsetForPose(pose, windowBounds, options);
    const desiredTopLeft = roundPoint(
      screenPoint.x - pointerOffset.x,
      screenPoint.y - pointerOffset.y
    );
    const clampedTopLeft = options.clampTopLeft
      ? roundPointFrom(options.clampTopLeft(desiredTopLeft, windowBounds))
      : desiredTopLeft;
    const actualPoint = roundPoint(
      clampedTopLeft.x + pointerOffset.x,
      clampedTopLeft.y + pointerOffset.y
    );

    return {
      pose,
      pointerOffset,
      desiredTopLeft,
      clampedTopLeft,
      actualPoint,
      errorPx: distanceBetween(actualPoint, screenPoint),
      isPreferredPose: pose === preferredPose,
    };
  });
}

export function pointerOffsetForPose(
  pose: PointerPose,
  windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>,
  options?: PointerAlignmentOptions
): { x: number; y: number } {
  const calibration = options?.spriteCalibrations?.[pose] ?? DEFAULT_SPRITE_CALIBRATIONS[pose];
  if (options?.useSpriteFingertips !== false && calibration) {
    return pointerOffsetForSpriteFingertip(calibration, windowBounds);
  }

  const region = resolvePointerRegion(windowBounds, options);

  switch (pose) {
    case 'point-right':
      return roundPoint(region.right, region.centerY);
    case 'point-right_down':
      return roundPoint(region.right, region.bottom);
    case 'point-down':
      return roundPoint(region.centerX, region.bottom);
    case 'point-left_down':
      return roundPoint(region.left, region.bottom);
    case 'point-left':
      return roundPoint(region.left, region.centerY);
    case 'point-left_up':
      return roundPoint(region.left, region.top);
    case 'point-up':
      return roundPoint(region.centerX, region.top);
    case 'point-right_up':
      return roundPoint(region.right, region.top);
  }
}

export function pointerOffsetForSpriteFingertip(
  calibration: PointerSpriteCalibration,
  windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>
): { x: number; y: number } {
  const box = resolveCompanionBox(windowBounds);
  const imageWidth = finiteNonNegative(calibration.imageWidth);
  const imageHeight = finiteNonNegative(calibration.imageHeight);
  const imageMaxSide = Math.max(imageWidth, imageHeight);
  if (box.size <= 0 || imageMaxSide <= 0) return roundPoint(box.left, box.top);

  const scale = box.size / imageMaxSide;
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const imageLeft = box.left + (box.size - renderedWidth) / 2;
  const imageTop = box.top + (box.size - renderedHeight) / 2;

  return roundPoint(
    imageLeft + calibration.fingertip.x * scale,
    imageTop + calibration.fingertip.y * scale
  );
}

export function poseFromDelta(dx: number, dy: number, axisThresholdPx: number): PointerPose {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'point-right';

  const threshold = Math.max(0, axisThresholdPx);
  const horizontal = dx > threshold ? 'right' : dx < -threshold ? 'left' : '';
  const vertical = dy > threshold ? 'down' : dy < -threshold ? 'up' : '';

  if (horizontal && vertical) return `point-${horizontal}_${vertical}` as PointerPose;
  if (horizontal) return `point-${horizontal}` as PointerPose;
  if (vertical) return `point-${vertical}` as PointerPose;
  return 'point-right';
}

export function resolvePointerRegion(
  windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>,
  options: PointerAlignmentOptions = {}
): PointerRegion {
  const width = finiteNonNegative(windowBounds.width);
  const height = finiteNonNegative(windowBounds.height);
  const insetX = resolveRegionInset(width, options);
  const insetY = resolveRegionInset(height, options);
  const left = insetX;
  const top = insetY;
  const right = Math.max(left, width - insetX);
  const bottom = Math.max(top, height - insetY);

  return {
    left,
    top,
    right,
    bottom,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  };
}

export function resolveCompanionBox(
  windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>
): { left: number; top: number; size: number } {
  const width = finiteNonNegative(windowBounds.width);
  const height = finiteNonNegative(windowBounds.height);
  const derivedWidth = width > WINDOW_EXTRA_WIDTH_PX ? width - WINDOW_EXTRA_WIDTH_PX : width;
  const derivedHeight = height > WINDOW_EXTRA_HEIGHT_PX ? height - WINDOW_EXTRA_HEIGHT_PX : height;
  const size = Math.max(0, Math.min(derivedWidth, derivedHeight));
  return {
    left: (width - size) / 2,
    top: height - size,
    size,
  };
}

function resolveAxisThreshold(windowBounds: Pick<PointerWindowBounds, 'width' | 'height'>): number {
  const shortestSide = Math.min(
    finiteNonNegative(windowBounds.width),
    finiteNonNegative(windowBounds.height)
  );
  if (shortestSide <= 0) return MIN_AXIS_THRESHOLD_PX;
  return Math.min(
    MAX_AXIS_THRESHOLD_PX,
    Math.max(MIN_AXIS_THRESHOLD_PX, shortestSide * AXIS_THRESHOLD_RATIO)
  );
}

function resolveRegionInset(size: number, options: PointerAlignmentOptions): number {
  if (size <= 0) return 0;
  const ratio = numberOrDefault(options.regionInsetRatio, DEFAULT_REGION_INSET_RATIO);
  const minPx = numberOrDefault(options.minRegionInsetPx, DEFAULT_MIN_REGION_INSET_PX);
  const maxPx = numberOrDefault(options.maxRegionInsetPx, DEFAULT_MAX_REGION_INSET_PX);
  const rawInset = size * Math.max(0, ratio);
  const inset = Math.min(maxPx, Math.max(minPx, rawInset));
  return Math.min(inset, size / 2);
}

function numberOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x), y: Math.round(y) };
}

function roundPointFrom(point: { x: number; y: number }): { x: number; y: number } {
  return roundPoint(point.x, point.y);
}

function distanceBetween(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function selectBestPointerPoseCandidate(
  candidates: PointerPoseCandidate[],
  preferredPose: PointerPose,
  posePreferenceTolerancePx: number | undefined
): PointerPoseCandidate {
  if (candidates.length === 0) {
    const pointerOffset = { x: 0, y: 0 };
    const origin = { x: 0, y: 0 };
    return {
      pose: preferredPose,
      pointerOffset,
      desiredTopLeft: origin,
      clampedTopLeft: origin,
      actualPoint: origin,
      errorPx: 0,
      isPreferredPose: true,
    };
  }

  const lowestError = candidates.reduce(
    (best, candidate) => Math.min(best, candidate.errorPx),
    Number.POSITIVE_INFINITY
  );
  const tolerance = Math.max(
    0,
    numberOrDefault(posePreferenceTolerancePx, DEFAULT_POSE_PREFERENCE_TOLERANCE_PX)
  );
  const eligible = candidates.filter(candidate => candidate.errorPx <= lowestError + tolerance);
  return eligible.find(candidate => candidate.pose === preferredPose)
    ?? eligible.slice().sort((a, b) => a.errorPx - b.errorPx)[0]
    ?? candidates[0];
}
