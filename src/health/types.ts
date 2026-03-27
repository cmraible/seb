export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface HealthCheckResult {
  checker: string;
  status: HealthStatus;
  details?: string;
  timestamp: string;
}

export interface HealthChecker {
  name: string;
  check(): Promise<HealthCheckResult>;
}

export interface HealthState {
  [checkerName: string]: {
    status: HealthStatus;
    details?: string;
    lastChecked: string;
    lastTransition: string;
  };
}
