const assert = require('assert');
const {
  buildFallbackPlan,
  parseGuidePlan,
} = require('../dist/core/operation-guide-planner');
const {
  extractOperationGuideSoftwareName,
  getOperationGuideControlCommand,
} = require('../dist/core/operation-guide-intent');
const {
  parseProgressEvaluation,
} = require('../dist/core/operation-guide-progress-evaluator');

function testParseGuidePlanFromJsonEnvelope() {
  const raw = [
    'Here is the plan:',
    JSON.stringify({
      softwareName: 'Claude',
      sourceSummary: 'official docs',
      steps: [
        {
          id: 'step-1',
          action: 'click',
          target: 'Download button',
          instruction: 'Click Download.',
          expectedChange: 'Download starts',
        },
        {
          id: 'step-2',
          action: 'input',
          target: 'Email input',
          instruction: 'Type your email.',
        },
      ],
    }),
  ].join('\n');

  const plan = parseGuidePlan(raw, 'Fallback');
  assert.strictEqual(plan.softwareName, 'Claude');
  assert.strictEqual(plan.steps.length, 2);
  assert.deepStrictEqual(plan.steps[0], {
    id: 'step-1',
    action: 'click',
    target: 'Download button',
    instruction: 'Click Download.',
    expectedChange: 'Download starts',
  });
}

function testParseGuidePlanFallsBackForInvalidJson() {
  const plan = parseGuidePlan('not json', 'TestApp');
  assert.strictEqual(plan.softwareName, 'TestApp');
  assert.ok(plan.steps.length >= 4);
  assert.ok(plan.steps.every(step => step.target && step.instruction));
}

function testFallbackPlanUsesSoftwareNameInBeginnerSteps() {
  const plan = buildFallbackPlan('Claude');
  assert.strictEqual(plan.softwareName, 'Claude');
  assert.ok(plan.steps.some(step => step.instruction.includes('Claude')));
  assert.ok(plan.steps.some(step => step.target.toLowerCase().includes('download')));
}

function testFallbackPlanUsesOfficialUrlWhenAvailable() {
  const plan = buildFallbackPlan('Steam', [
    {
      title: 'Steam official download',
      url: 'https://store.steampowered.com/about/',
      snippet: 'Download Steam for Windows',
    },
  ]);

  assert.strictEqual(plan.steps[0].action, 'open');
  assert.ok(plan.steps[0].instruction.includes('https://store.steampowered.com/about/'));
  assert.ok(plan.steps[1].target.includes('Download'));
  assert.ok(plan.steps[1].target.includes('下载'));
}

function testNaturalGuideIntentStartsGuide() {
  assert.strictEqual(extractOperationGuideSoftwareName('我想下载 Steam，下一步怎么做？'), 'Steam');
  assert.strictEqual(extractOperationGuideSoftwareName('怎么下载 Codex？'), 'Codex');
  assert.strictEqual(extractOperationGuideSoftwareName('.我想安装 Claude 客户端，下一步怎么做？'), 'Claude 客户端');
  assert.strictEqual(extractOperationGuideSoftwareName('怎么设置 VS Code'), 'VS Code');
}

function testGuideControlCommands() {
  assert.strictEqual(getOperationGuideControlCommand('我完成了'), 'next');
  assert.strictEqual(getOperationGuideControlCommand('重新识别'), 'reidentify');
  assert.strictEqual(getOperationGuideControlCommand('退出教程'), 'exit');
  assert.strictEqual(getOperationGuideControlCommand('我想下载 Steam'), null);
}

function testParseProgressEvaluation() {
  const result = parseProgressEvaluation('JSON:\n{"completed":true,"confidence":0.83,"currentStage":"搜索结果页","nextTargetVisible":true,"reason":"已看到官网结果"}');
  assert.strictEqual(result.completed, true);
  assert.strictEqual(result.confidence, 0.83);
  assert.strictEqual(result.currentStage, '搜索结果页');
  assert.strictEqual(result.nextTargetVisible, true);

  const fallback = parseProgressEvaluation('not json');
  assert.strictEqual(fallback.completed, false);
  assert.strictEqual(fallback.confidence, 0);
}

testParseGuidePlanFromJsonEnvelope();
testParseGuidePlanFallsBackForInvalidJson();
testFallbackPlanUsesSoftwareNameInBeginnerSteps();
testFallbackPlanUsesOfficialUrlWhenAvailable();
testNaturalGuideIntentStartsGuide();
testGuideControlCommands();
testParseProgressEvaluation();

console.log('operation-guide-contract tests passed');
