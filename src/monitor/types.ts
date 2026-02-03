export type TelemetryEvent = {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
};

export type FocusEvent = {
  timestamp: string;
  app: string;
  pid: number;
  isOracleChrome: boolean;
};

export type FocusReport = {
  totalEvents: number;
  violations: FocusEvent[];
  durationMs: number;
};

export type WindowEvent = {
  timestamp: string;
  windowId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
  visible: boolean;
};

export type WindowReport = {
  totalEvents: number;
  violations: WindowEvent[];
  durationMs: number;
};
