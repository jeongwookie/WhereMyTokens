export interface AntigravityServerInfo {
  pid: number;
  port: number;
  csrfToken: string;
  workspaceId?: string;
  processStartedAtMs?: number;
}

export interface AntigravityModelConfig {
  label?: string;
  modelOrAlias?: {
    model?: string;
  };
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string | number;
  };
  supportsImages?: boolean;
}

export interface AntigravityUserStatusResponse {
  userStatus?: {
    email?: string;
    name?: string;
    planStatus?: {
      planInfo?: {
        planName?: string;
      };
    };
    cascadeModelConfigData?: {
      clientModelConfigs?: AntigravityModelConfig[];
    };
  };
}

export interface AntigravityTrajectorySummary {
  summary?: string;
  createdTime?: string | number;
  lastModifiedTime?: string | number;
  stepCount?: number;
  status?: string;
  runStatus?: string;
  lastGeneratorModelUid?: string;
  workspaces?: Array<{
    workspaceFolderAbsoluteUri?: string;
  }>;
}

export interface AntigravityTrajectorySummariesResponse {
  trajectorySummaries?: Record<string, AntigravityTrajectorySummary>;
}

export interface AntigravityTrajectoryResponse {
  trajectory?: {
    steps?: unknown[];
    generatorMetadata?: Record<string, unknown>[];
  };
}

export interface AntigravityGeneratorMetadataResponse {
  generatorMetadata?: Record<string, unknown>[];
}
