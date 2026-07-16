const assert = require('assert');
const {
  pointerOffsetForPose,
  poseFromDelta,
  resolveCompanionBox,
  resolvePointerPoseCandidate,
  resolvePointerPoseCandidates,
  resolvePointerRegion,
  resolvePointerPoseConfig,
} = require('../dist/core/screen-target-alignment');

function testOffsetsUseSpriteFingertipsByDefault() {
  const size = { width: 250, height: 350 };
  assert.deepStrictEqual(pointerOffsetForPose('point-left_up', size), { x: 53, y: 202 });
  assert.deepStrictEqual(pointerOffsetForPose('point-right_up', size), { x: 192, y: 201 });
  assert.deepStrictEqual(pointerOffsetForPose('point-right_down', size), { x: 199, y: 304 });
  assert.deepStrictEqual(pointerOffsetForPose('point-left_down', size), { x: 59, y: 300 });
  assert.deepStrictEqual(pointerOffsetForPose('point-left', size), { x: 46, y: 251 });
  assert.deepStrictEqual(pointerOffsetForPose('point-right', size), { x: 205, y: 254 });
  assert.deepStrictEqual(pointerOffsetForPose('point-up', size), { x: 75, y: 191 });
  assert.deepStrictEqual(pointerOffsetForPose('point-down', size), { x: 130, y: 333 });
}

function testOffsetsScaleWithAppearanceWindowSize() {
  const size = { width: 350, height: 450 };
  assert.deepStrictEqual(pointerOffsetForPose('point-right_up', size), { x: 275, y: 226 });
  assert.deepStrictEqual(pointerOffsetForPose('point-down', size), { x: 183, y: 424 });
}

function testCompanionBoxMatchesRendererWindowLayout() {
  assert.deepStrictEqual(resolveCompanionBox({ width: 250, height: 350 }), { left: 25, top: 150, size: 200 });
  assert.deepStrictEqual(resolveCompanionBox({ width: 350, height: 450 }), { left: 25, top: 150, size: 300 });
}

function testPointerRegionFallbackCanStillUseInsetOrDisableIt() {
  const size = { width: 250, height: 350 };
  const noInset = { useSpriteFingertips: false, regionInsetRatio: 0, minRegionInsetPx: 0, maxRegionInsetPx: 0 };
  assert.deepStrictEqual(resolvePointerRegion(size, noInset), {
    left: 0,
    top: 0,
    right: 250,
    bottom: 350,
    centerX: 125,
    centerY: 175,
  });
  assert.deepStrictEqual(pointerOffsetForPose('point-right_up', size, noInset), { x: 250, y: 0 });
  assert.deepStrictEqual(pointerOffsetForPose('point-right_up', size, { useSpriteFingertips: false }), { x: 230, y: 26 });
}

function testPoseUsesAxisSignsForDiagonalMovement() {
  assert.strictEqual(poseFromDelta(160, -120, 20), 'point-right_up');
  assert.strictEqual(poseFromDelta(-160, -120, 20), 'point-left_up');
  assert.strictEqual(poseFromDelta(160, 120, 20), 'point-right_down');
  assert.strictEqual(poseFromDelta(-160, 120, 20), 'point-left_down');
}

function testPoseFallsBackToSingleAxisWhenOtherAxisIsTiny() {
  assert.strictEqual(poseFromDelta(160, -8, 20), 'point-right');
  assert.strictEqual(poseFromDelta(8, -160, 20), 'point-up');
}

function testResolvePoseConfigCombinesPoseAndCornerOffset() {
  const bounds = { x: 100, y: 100, width: 250, height: 350 };
  const result = resolvePointerPoseConfig({ x: 430, y: 40 }, bounds);
  assert.deepStrictEqual(result, {
    pose: 'point-right_up',
    pointerOffset: { x: 192, y: 201 },
  });
}

function testCandidateReportsExactAlignmentWithoutClamp() {
  const bounds = { x: 100, y: 100, width: 250, height: 350 };
  const result = resolvePointerPoseCandidate({ x: 430, y: 40 }, bounds);
  assert.strictEqual(result.pose, 'point-right_up');
  assert.deepStrictEqual(result.pointerOffset, { x: 192, y: 201 });
  assert.deepStrictEqual(result.desiredTopLeft, { x: 238, y: -161 });
  assert.deepStrictEqual(result.clampedTopLeft, { x: 238, y: -161 });
  assert.deepStrictEqual(result.actualPoint, { x: 430, y: 40 });
  assert.strictEqual(result.errorPx, 0);
}

function testCandidateKeepsPreferredPoseWhenAllPosesCanAlign() {
  const bounds = { x: 100, y: 100, width: 250, height: 350 };
  const result = resolvePointerPoseCandidate(
    { x: 430, y: 40 },
    bounds,
    { preferredPose: 'point-left_down' }
  );
  assert.strictEqual(result.pose, 'point-left_down');
  assert.strictEqual(result.errorPx, 0);
}

function testCandidateChoosesLowestActualErrorAfterClamp() {
  const bounds = { x: 200, y: 200, width: 100, height: 100 };
  const noInset = {
    useSpriteFingertips: false,
    regionInsetRatio: 0,
    minRegionInsetPx: 0,
    maxRegionInsetPx: 0,
    preferredPose: 'point-right_down',
    posePreferenceTolerancePx: 0,
    clampTopLeft: () => ({ x: 0, y: 0 }),
  };
  const candidates = resolvePointerPoseCandidates({ x: 10, y: 10 }, bounds, noInset);
  const result = resolvePointerPoseCandidate({ x: 10, y: 10 }, bounds, noInset);
  assert.strictEqual(candidates.length, 8);
  assert.strictEqual(result.pose, 'point-left_up');
  assert.deepStrictEqual(result.pointerOffset, { x: 0, y: 0 });
  assert.deepStrictEqual(result.clampedTopLeft, { x: 0, y: 0 });
  assert.deepStrictEqual(result.actualPoint, { x: 0, y: 0 });
  assert.ok(result.errorPx < 15);
}

testOffsetsUseSpriteFingertipsByDefault();
testOffsetsScaleWithAppearanceWindowSize();
testCompanionBoxMatchesRendererWindowLayout();
testPointerRegionFallbackCanStillUseInsetOrDisableIt();
testPoseUsesAxisSignsForDiagonalMovement();
testPoseFallsBackToSingleAxisWhenOtherAxisIsTiny();
testResolvePoseConfigCombinesPoseAndCornerOffset();
testCandidateReportsExactAlignmentWithoutClamp();
testCandidateKeepsPreferredPoseWhenAllPosesCanAlign();
testCandidateChoosesLowestActualErrorAfterClamp();

console.log('screen-target-alignment-contract tests passed');
