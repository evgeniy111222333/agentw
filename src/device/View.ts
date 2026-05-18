import { ViewportState } from '../common/types';
import { BrowserConfig } from '../config/ConfigurationManager';

export const viewProfiles: Record<string, ViewportState> = {
  desktop: {
    width: 1280,
    height: 720,
    device_scale_factor: 1,
    is_mobile: false,
    has_touch: false,
    profile: 'desktop',
  },
  mobile: {
    width: 390,
    height: 844,
    device_scale_factor: 3,
    is_mobile: true,
    has_touch: true,
    profile: 'mobile',
    user_agent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  tablet: {
    width: 820,
    height: 1180,
    device_scale_factor: 2,
    is_mobile: true,
    has_touch: true,
    profile: 'tablet',
    user_agent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

export function defaultView(config: BrowserConfig): ViewportState {
  return normalizeView(
    {
      width: config.viewport.width,
      height: config.viewport.height,
      device_scale_factor: 1,
      is_mobile: false,
      has_touch: false,
      user_agent: config.user_agent,
      profile: 'desktop',
    },
    viewProfiles.desktop
  );
}

export function normalizeView(input: unknown, fallback: ViewportState): ViewportState {
  const raw = typeof input === 'string' ? { profile: input } : objectValue(input);
  const profileName = stringValue(raw.profile ?? raw.device ?? raw.name);
  const profile = profileName ? viewProfiles[profileName.toLowerCase()] : undefined;
  const base = {
    ...fallback,
    ...(profile ?? {}),
  };
  const width = numberValue(raw.width, base.width);
  const height = numberValue(raw.height, base.height);
  const deviceScaleFactor = numberValue(raw.device_scale_factor ?? raw.deviceScaleFactor ?? raw.scale, base.device_scale_factor ?? 1);
  const userAgent = stringValue(raw.user_agent ?? raw.userAgent) ?? base.user_agent;

  return dropUndefined({
    width: clamp(Math.round(width), 240, 7680),
    height: clamp(Math.round(height), 240, 4320),
    device_scale_factor: clamp(Number(deviceScaleFactor.toFixed(2)), 0.5, 5),
    is_mobile: boolValue(raw.is_mobile ?? raw.isMobile, base.is_mobile),
    has_touch: boolValue(raw.has_touch ?? raw.hasTouch, base.has_touch),
    user_agent: userAgent,
    profile: profileName ?? base.profile,
    mode: base.mode,
  });
}

export function viewSignature(viewport?: ViewportState): string {
  if (!viewport) return 'viewport:none';
  return [
    viewport.width,
    viewport.height,
    viewport.device_scale_factor ?? 1,
    viewport.is_mobile ? 1 : 0,
    viewport.has_touch ? 1 : 0,
    viewport.profile ?? '',
  ].join('x');
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value: unknown, fallback: boolean | undefined): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return Boolean(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dropUndefined<T extends Record<string, any>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
