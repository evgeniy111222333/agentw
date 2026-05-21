import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export type EventCallback = (payload: any) => void | Promise<void>;

export interface EventEnvelope {
  event_id: string;
  type: string;
  timestamp: string;
  payload: any;
  critical: boolean;
  sequence: number;
}

export interface EventBusSnapshot {
  events: EventEnvelope[];
  dropped_events: number;
  subscriber_errors: number;
  slow_subscriber_events: number;
  persisted_path?: string;
  last_sequence: number;
}

const CRITICAL_EVENTS = new Set(['action_requested', 'action_completed', 'action_failed']);

export class EventBus {
  private subscribers: Map<string, EventCallback[]> = new Map();
  private events: EventEnvelope[] = [];
  private droppedEvents = 0;
  private subscriberErrors = 0;
  private slowSubscriberEvents = 0;
  private sequence = 0;
  private maxEvents: number;
  private persistPath?: string;
  private readonly subscriberTimeoutMs: number;

  constructor(options: { maxEvents?: number; persistPath?: string | null } = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? Number(process.env.PRISM_EVENT_BUFFER_SIZE ?? process.env.LLM_BROWSER_EVENT_BUFFER_SIZE ?? 10000));
    this.subscriberTimeoutMs = Math.max(50, Number(process.env.PRISM_EVENT_SUBSCRIBER_TIMEOUT_MS ?? process.env.LLM_BROWSER_EVENT_SUBSCRIBER_TIMEOUT_MS ?? 1000));
    const configuredPath = options.persistPath === null
      ? undefined
      : options.persistPath ?? process.env.PRISM_EVENT_LOG_PATH ?? process.env.LLM_BROWSER_EVENT_LOG_PATH ?? path.join(process.cwd(), '.prism', 'events', 'events.jsonl');
    this.persistPath = configuredPath;
    this.loadPersisted();
  }

  subscribe(eventType: string, callback: EventCallback): void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, []);
    }
    this.subscribers.get(eventType)!.push(callback);
  }

  unsubscribe(eventType: string, callback: EventCallback): void {
    const callbacks = this.subscribers.get(eventType);
    if (callbacks) {
      this.subscribers.set(
        eventType,
        callbacks.filter((cb) => cb !== callback)
      );
    }
  }

  async publish(eventType: string, payload: any): Promise<void> {
    const envelope = this.envelope(eventType, payload);
    this.store(envelope);
    if (envelope.critical) await this.persist(envelope);

    const callbacks = this.subscribers.get(eventType);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          await withTimeout(Promise.resolve(callback(payload)), this.subscriberTimeoutMs);
        } catch (error) {
          this.subscriberErrors += 1;
          if (/timed out/i.test(String((error as Error).message))) this.slowSubscriberEvents += 1;
          console.error(`Error processing event ${eventType}:`, error);
        }
      }
    }
  }

  list(filter: { type?: string; session_id?: string; limit?: number } = {}): EventEnvelope[] {
    let result = this.events;
    if (filter.type) result = result.filter((event) => event.type === filter.type);
    if (filter.session_id) result = result.filter((event) => event.payload?.session_id === filter.session_id);
    return result.slice(-(filter.limit ?? result.length));
  }

  snapshot(filter: { session_id?: string; limit?: number } = {}): EventBusSnapshot {
    return {
      events: this.list(filter),
      dropped_events: this.droppedEvents,
      subscriber_errors: this.subscriberErrors,
      slow_subscriber_events: this.slowSubscriberEvents,
      persisted_path: this.persistPath,
      last_sequence: this.sequence,
    };
  }

  clear(): void {
    this.events = [];
    this.droppedEvents = 0;
    this.subscriberErrors = 0;
    this.slowSubscriberEvents = 0;
    this.sequence = 0;
  }

  private envelope(eventType: string, payload: any): EventEnvelope {
    const timestamp = payload?.timestamp ?? new Date().toISOString();
    return {
      event_id: payload?.event_id ?? randomUUID(),
      type: eventType,
      timestamp,
      payload,
      critical: CRITICAL_EVENTS.has(eventType),
      sequence: ++this.sequence,
    };
  }

  private store(event: EventEnvelope): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      const overflow = this.events.length - this.maxEvents;
      this.events.splice(0, overflow);
      this.droppedEvents += overflow;
    }
  }

  private async persist(event: EventEnvelope): Promise<void> {
    if (!this.persistPath) return;
    try {
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.promises.appendFile(this.persistPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      console.error('Failed to persist event bus entry:', error);
    }
  }

  private loadPersisted(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const lines = fs.readFileSync(this.persistPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-this.maxEvents);
      for (const line of lines) {
        const event = JSON.parse(line) as EventEnvelope;
        this.events.push(event);
        this.sequence = Math.max(this.sequence, Number(event.sequence ?? 0));
      }
    } catch {
      this.events = [];
    }
  }
}

export const globalEventBus = new EventBus();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Event subscriber timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
