export type OperationGuideAction = 'click' | 'scroll' | 'input' | 'wait' | 'open' | 'confirm';

export interface OperationGuideStep {
  id: string;
  action: OperationGuideAction;
  target: string;
  instruction: string;
  expectedChange?: string;
}

export interface OperationGuidePlan {
  softwareName: string;
  sourceSummary: string;
  steps: OperationGuideStep[];
}

export interface OperationGuideSource {
  title: string;
  url: string;
  snippet: string;
}

export type OperationGuideStatus =
  | 'idle'
  | 'planning'
  | 'locating'
  | 'pointing'
  | 'waiting'
  | 'completed'
  | 'error';

export interface OperationGuideSnapshot {
  active: boolean;
  status: OperationGuideStatus;
  softwareName?: string;
  currentIndex: number;
  totalSteps: number;
  currentStep?: OperationGuideStep;
  message: string;
  canNext: boolean;
  canReidentify: boolean;
  canExit: boolean;
  error?: string;
}
