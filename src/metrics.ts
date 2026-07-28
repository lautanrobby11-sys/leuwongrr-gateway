import type { RouteId } from './policy/allowlist.js';

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

const LATENCY_BUCKETS_MS = Object.freeze([5, 25, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);

function statusClass(status: number): StatusClass {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

interface RouteSeries {
  counts: Map<StatusClass, number>;
  buckets: number[];
  sumMs: number;
  total: number;
}

/**
 * Deliberately in-process and label-poor. A series is identified by the
 * allowlist route identifier and a status class only: never a tenant, account,
 * API key, or raw path. That keeps the series set finite no matter what a
 * caller sends, and keeps a scrape from revealing who is using the gateway.
 */
export class MetricsRegistry {
  private readonly series = new Map<RouteId, RouteSeries>();
  private readonly startedAt = Date.now();

  observe(route: RouteId, status: number, durationMs: number): void {
    let entry = this.series.get(route);
    if (!entry) {
      entry = {
        counts: new Map<StatusClass, number>(),
        buckets: LATENCY_BUCKETS_MS.map(() => 0),
        sumMs: 0,
        total: 0
      };
      this.series.set(route, entry);
    }
    const klass = statusClass(status);
    entry.counts.set(klass, (entry.counts.get(klass) ?? 0) + 1);
    entry.total += 1;
    entry.sumMs += Number.isFinite(durationMs) ? durationMs : 0;
    for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
      if (durationMs <= (LATENCY_BUCKETS_MS[index] ?? 0)) {
        entry.buckets[index] = (entry.buckets[index] ?? 0) + 1;
      }
    }
  }

  /** Prometheus text exposition, version 0.0.4. */
  render(): string {
    const lines: string[] = [
      '# HELP leuwongrr_uptime_seconds Seconds since the gateway process started.',
      '# TYPE leuwongrr_uptime_seconds gauge',
      `leuwongrr_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      '# HELP leuwongrr_requests_total Completed requests by allowlisted route and status class.',
      '# TYPE leuwongrr_requests_total counter'
    ];
    for (const [route, entry] of this.series) {
      for (const [klass, value] of entry.counts) {
        lines.push(`leuwongrr_requests_total{route="${route}",status="${klass}"} ${value}`);
      }
    }
    lines.push('# HELP leuwongrr_request_duration_ms Request latency by allowlisted route.');
    lines.push('# TYPE leuwongrr_request_duration_ms histogram');
    for (const [route, entry] of this.series) {
      for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
        const bound = LATENCY_BUCKETS_MS[index] ?? 0;
        const value = entry.buckets[index] ?? 0;
        lines.push(`leuwongrr_request_duration_ms_bucket{route="${route}",le="${bound}"} ${value}`);
      }
      lines.push(`leuwongrr_request_duration_ms_bucket{route="${route}",le="+Inf"} ${entry.total}`);
      lines.push(`leuwongrr_request_duration_ms_sum{route="${route}"} ${Math.round(entry.sumMs)}`);
      lines.push(`leuwongrr_request_duration_ms_count{route="${route}"} ${entry.total}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
