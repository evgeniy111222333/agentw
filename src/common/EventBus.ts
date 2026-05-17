export type EventCallback = (payload: any) => void | Promise<void>;

export class EventBus {
  private subscribers: Map<string, EventCallback[]> = new Map();

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
    const callbacks = this.subscribers.get(eventType);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          await callback(payload);
        } catch (error) {
          console.error(`Error processing event ${eventType}:`, error);
        }
      }
    }
  }
}

export const globalEventBus = new EventBus();
