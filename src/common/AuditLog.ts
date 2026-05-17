import { randomUUID } from 'crypto';
import { ConfigurationManager } from '../config/ConfigurationManager';

export type AuditCategory = 'ACTION' | 'SECURITY' | 'SESSION' | 'SYSTEM';

export interface AuditEvent {
  timestamp: string;
  event_id: string;
  category: AuditCategory;
  session_id?: string;
  action?: string;
  target?: string;
  result: 'success' | 'error' | 'blocked';
  duration_ms?: number;
  request_id?: string;
  risk_score: number;
  error_code?: string;
  message?: string;
  metadata?: Record<string, any>;
}

export class AuditLog {
  private events: AuditEvent[] = [];

  record(event: Omit<AuditEvent, 'timestamp' | 'event_id'>): AuditEvent | undefined {
    const config = ConfigurationManager.getInstance().getConfig();
    if (!config.monitoring.audit_enabled) return undefined;

    const fullEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      event_id: randomUUID(),
      ...event,
    };
    this.events.push(fullEvent);
    this.events = this.events.slice(-config.monitoring.audit_retention_events);
    return fullEvent;
  }

  list(filter: { session_id?: string; category?: AuditCategory } = {}): AuditEvent[] {
    return this.events.filter((event) => {
      if (filter.session_id && event.session_id !== filter.session_id) return false;
      if (filter.category && event.category !== filter.category) return false;
      return true;
    });
  }
}

export const globalAuditLog = new AuditLog();

export function riskScoreForAction(action: string): number {
  if (['download', 'fs', 'file_system', 'pdf', 'pdf_generate', 'screenshot', 'screenshot_file', 'screenshot_to_file', 'submit', 'type', 'upload'].includes(action)) return 60;
  if (['navigate', 'keyboard'].includes(action)) return 50;
  if (['click', 'select', 'hover'].includes(action)) return 30;
  return 10;
}
