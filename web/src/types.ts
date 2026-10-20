export type EntryKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice' | 'error' | 'system';

export interface Entry {
  kind: EntryKind | string;
  text?: string;
  command?: string;
  result?: string;
  tool?: string;
  running?: boolean;
  preparing?: boolean;
  tone?: 'info' | 'warn' | 'error';
  durationMs?: number;
  eventId?: string;
  turnId?: string;
  at?: number;
  imageCount?: number;
  source?: string;
}

export interface ApprovalRequest {
  id: string;
  toolName?: string;
  summary?: string;
  detail?: string;
  reason?: string;
}

export interface PendingQuestion {
  id: string;
  question?: string;
  options?: string[];
}

export interface RuntimeInfo {
  modelName?: string;
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number;
  approvalMode?: string | null;
  showReasoningDefault?: boolean;
  reasoningVariants?: Array<{ id: string; label: string }>;
  reasoningDefault?: string;
  workspaceRoot?: string;
}

export interface SessionPayload {
  reset: boolean;
  entries: Entry[];
  updated: { index: number; entry: Entry }[];
  from: number;
  totalEntries: number;
  busy: boolean;
  queuedMessageCount: number;
  pendingApproval: ApprovalRequest | null;
  pendingQuestion: PendingQuestion | null;
  contextTokens?: number | null;
  runtime?: RuntimeInfo;
  session: { id: string; title: string };
}

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt?: number | string;
  preview?: string | null;
  workspaceRoot?: string;
}

export interface ModelChoice {
  providerId: string;
  modelId: string;
  name: string;
}

export interface DraftImage {
  id: string;
  name: string;
  dataUrl: string;
  base64: string;
  mediaType: 'image/png';
}
