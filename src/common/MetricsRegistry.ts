type MetricSeries = {
  count: number;
  sum: number;
  max: number;
};

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private timings = new Map<string, MetricSeries>();

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  observe(name: string, value: number): void {
    const current = this.timings.get(name) ?? { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += value;
    current.max = Math.max(current.max, value);
    this.timings.set(name, current);
  }

  // Alias for histogram-like functionality
  histogram(name: string, value: number, labels?: Record<string, string>): void {
    // Labels are ignored in basic implementation but stored for future use
    this.observe(name, value);
  }

  // Get counter value
  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  // Get histogram/timing statistics
  getHistogram(name: string): MetricSeries | undefined {
    return this.timings.get(name);
  }

  snapshot(): Record<string, any> {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    for (const [name, series] of this.timings) {
      lines.push(`# TYPE ${name}_milliseconds summary`);
      lines.push(`${name}_milliseconds_count ${series.count}`);
      lines.push(`${name}_milliseconds_sum ${series.sum}`);
      lines.push(`${name}_milliseconds_max ${series.max}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

export const globalMetrics = new MetricsRegistry();
