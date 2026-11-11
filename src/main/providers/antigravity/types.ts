export interface AntigravityServerInfo {
  pid: number;
  port: number;
  protocol: 'http' | 'https';
  csrfToken: string;
  workspaceId?: string;
  processStartedAtMs?: number;
}

export interface AntigravityModelConfig {
  label?: string;
  modelId?: string;
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

export interface AntigravityQuotaSummaryBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string | number;
}

export interface AntigravityQuotaSummaryGroup {
  displayName?: string;
  buckets?: AntigravityQuotaSummaryBucket[];
}

export interface AntigravityQuotaSummaryResponse {
  response?: {
    groups?: AntigravityQuotaSummaryGroup[];
  };
  groups?: AntigravityQuotaSummaryGroup[];
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
