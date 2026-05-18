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

const ACTION_RISK_SCORE: Record<string, number> = {
  snapshot: 0,
  list_tabs: 0,
  wait: 0,
  wait_for: 0,
  poll: 0,
  scroll: 5,
  scroll_to_element: 5,
  set_viewport: 5,
  hover: 5,
  click: 10,
  go_back: 10,
  go_forward: 10,
  keyboard: 10,
  invalidate_cache: 10,
  new_tab: 10,
  open_tab: 10,
  screenshot: 10,
  screenshot_file: 15,
  screenshot_to_file: 15,
  pdf: 15,
  pdf_generate: 15,
  refresh: 15,
  type: 15,
  select: 15,
  close_tab: 15,
  interact: 20,
  loop: 20,
  multi_click: 20,
  try: 20,
  search_and_paginate: 25,
  parallel: 25,
  call_script: 30,
  define_script: 5,
  fs: 30,
  file_system: 30,
  navigate: 30,
  async_navigate: 30,
  navigate_and_extract: 35,
  fill_form: 35,
  fill_and_verify: 35,
  submit: 40,
  upload: 40,
  download: 40,
  login_flow: 75,
};

export function riskScoreForAction(action: string): number {
  return ACTION_RISK_SCORE[action] ?? 50;
}
