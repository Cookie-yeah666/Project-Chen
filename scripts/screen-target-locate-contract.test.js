const assert = require('assert');
const { ScreenAnalyzer } = require('../dist/core/screen-analyzer');
const { ScreenTargetPointer } = require('../dist/core/screen-target-pointer');

const frame = {
  imageDataUri: '',
  origin: { x: 0, y: 0 },
  screenSize: { width: 1920, height: 1080 },
  imageSize: { width: 1920, height: 1080 },
};

function createAnalyzer() {
  return new ScreenAnalyzer({ get: () => ({}) });
}

function parseLocate(raw) {
  return createAnalyzer().parseLocateResult(raw, frame);
}

function testBestCandidateCanRecoverFromFoundFalse() {
  const result = parseLocate(JSON.stringify({
    found: false,
    confidence: 0,
    label: 'Download',
    candidates: [
      {
        label: 'Install Steam',
        confidence: 0.52,
        targetKind: 'button',
        matchType: 'partial_text',
        box: { left: 10, top: 20, right: 110, bottom: 60 },
      },
    ],
  }));

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.label, 'Install Steam');
  assert.strictEqual(result.confidence, 0.52);
  assert.deepStrictEqual(result.box, { x: 10, y: 20, width: 100, height: 40 });
  assert.deepStrictEqual(result.point, { x: 60, y: 40 });
  assert.strictEqual(result.targetKind, 'button');
  assert.strictEqual(result.matchType, 'partial_text');
}

function testBoxArrayFallsBackToCenterPoint() {
  const result = parseLocate(JSON.stringify({
    found: true,
    label: 'Search input',
    confidence: 0.76,
    bbox: [100, 200, 300, 40],
  }));

  assert.strictEqual(result.found, true);
  assert.deepStrictEqual(result.box, { x: 100, y: 200, width: 300, height: 40 });
  assert.deepStrictEqual(result.point, { x: 250, y: 220 });
}

function testBoxArrayCanUseLeftTopRightBottomShape() {
  const result = parseLocate(JSON.stringify({
    found: true,
    label: 'Install button',
    confidence: 0.8,
    bbox: [100, 200, 400, 240],
  }));

  assert.strictEqual(result.found, true);
  assert.deepStrictEqual(result.box, { x: 100, y: 200, width: 300, height: 40 });
  assert.deepStrictEqual(result.point, { x: 250, y: 220 });
}

function testVeryWeakPointDoesNotBecomeFound() {
  const result = parseLocate(JSON.stringify({
    found: false,
    label: 'Unknown',
    confidence: 0.2,
    point: { x: 200, y: 300 },
  }));

  assert.strictEqual(result.found, false);
  assert.deepStrictEqual(result.point, { x: 200, y: 300 });
}

function testPointerIntentCoversChineseAndEnglishTargetRequests() {
  const pointer = new ScreenTargetPointer({
    mainWindow: {},
    screenAnalyzer: {},
    moveController: {},
    bubbleOrchestrator: {},
    windowActivityService: {},
  });

  assert.strictEqual(pointer.isPointerRequest('Download 在哪里'), true);
  assert.strictEqual(pointer.isPointerRequest('这个页面该点哪里'), true);
  assert.strictEqual(pointer.isPointerRequest('show me where to click'), true);
  assert.strictEqual(pointer.isPointerRequest('总结这个页面'), false);
}

function testAlgorithm3RefinementCropKeepsTargetWithContext() {
  const analyzer = createAnalyzer();
  const crop = analyzer.resolveRefinementCropBox(frame, {
    found: true,
    label: 'small text button',
    confidence: 0.66,
    point: { x: 560, y: 320 },
    box: { x: 500, y: 300, width: 120, height: 40 },
  });

  assert.ok(crop);
  assert.ok(crop.width >= 280);
  assert.ok(crop.height >= 280);
  assert.ok(crop.x <= 500);
  assert.ok(crop.y <= 300);
  assert.ok(crop.x + crop.width >= 620);
  assert.ok(crop.y + crop.height >= 340);
}

function testAlgorithm3MapsCropCoordinatesBackToFullFrame() {
  const analyzer = createAnalyzer();
  const mapped = analyzer.mapRefinedResultToParentFrame(
    {
      found: true,
      label: 'Download',
      confidence: 0.64,
      point: { x: 550, y: 320 },
      box: { x: 500, y: 300, width: 120, height: 40 },
      targetKind: 'button',
    },
    {
      found: true,
      label: 'Download now',
      confidence: 0.88,
      point: { x: 300, y: 140 },
      box: { x: 250, y: 110, width: 180, height: 60 },
      targetKind: 'button',
      matchType: 'exact_text',
      reason: 'confirmed in zoom crop',
    },
    {
      imageDataUri: '',
      cropBox: { x: 400, y: 250, width: 400, height: 280 },
      imageSize: { width: 800, height: 560 },
      scale: 2,
    }
  );

  assert.strictEqual(mapped.found, true);
  assert.strictEqual(mapped.label, 'Download now');
  assert.strictEqual(mapped.confidence, 0.88);
  assert.deepStrictEqual(mapped.point, { x: 550, y: 320 });
  assert.deepStrictEqual(mapped.box, { x: 525, y: 305, width: 90, height: 30 });
  assert.strictEqual(mapped.matchType, 'exact_text');
}

function testAlgorithm3RefinesSmallTextLikeTargets() {
  const analyzer = createAnalyzer();
  assert.strictEqual(analyzer.shouldRefineLocateResult({
    found: true,
    label: 'Settings',
    confidence: 0.84,
    point: { x: 100, y: 100 },
    box: { x: 70, y: 90, width: 80, height: 24 },
    targetKind: 'text',
  }, frame), true);

  assert.strictEqual(analyzer.shouldRefineLocateResult({
    found: true,
    label: 'Large panel',
    confidence: 0.95,
    point: { x: 500, y: 400 },
    box: { x: 100, y: 100, width: 900, height: 600 },
    targetKind: 'region',
  }, frame), false);
}

testBestCandidateCanRecoverFromFoundFalse();
testBoxArrayFallsBackToCenterPoint();
testBoxArrayCanUseLeftTopRightBottomShape();
testVeryWeakPointDoesNotBecomeFound();
testPointerIntentCoversChineseAndEnglishTargetRequests();
testAlgorithm3RefinementCropKeepsTargetWithContext();
testAlgorithm3MapsCropCoordinatesBackToFullFrame();
testAlgorithm3RefinesSmallTextLikeTargets();

console.log('screen-target-locate-contract tests passed');
