export type LoginStatus =
  | "idle"
  | "running"
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "failed"
  | "cancelled";

export type HistoryDirection = "inbound" | "outbound" | "system";
export type StreamEventType =
  | "login"
  | "message"
  | "monitor"
  | "error"
  | "sessionExpired";
export type HistoryEventType = StreamEventType | "typing";

export interface SessionFile {
  accountId?: string;
  token?: string;
  baseUrl?: string;
  userId?: string;
  loginStatus: LoginStatus;
  lastQRCodeUrl?: string;
  lastMessage?: string;
  loginStartedAt?: string;
  loginFinishedAt?: string;
}

export interface HistoryEntry {
  id: string;
  direction: HistoryDirection;
  createdAt: string;
  eventType: HistoryEventType;
  userId?: string;
  messageId?: string;
  summary: string;
  payload: unknown;
}

export interface MonitorState {
  running: boolean;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastError?: string;
}

export function createEmptySession(): SessionFile {
  return { loginStatus: "idle" };
}

export interface UserRecord {
  userId: string;
  apiKey: string;
  createdAt: string;
  lastLoginAt: string;
  session: SessionFile;
}
