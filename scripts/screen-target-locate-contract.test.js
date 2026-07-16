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

testBestCandidateCanRecoverFromFoundFalse();
testBoxArrayFallsBackToCenterPoint();
testBoxArrayCanUseLeftTopRightBottomShape();
testVeryWeakPointDoesNotBecomeFound();
testPointerIntentCoversChineseAndEnglishTargetRequests();

console.log('screen-target-locate-contract tests passed');
