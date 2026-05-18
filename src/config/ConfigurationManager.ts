export interface BrowserConfig {
  chromium_path?: string;
  viewport: { width: number; height: number };
  user_agent: string;
  ignore_https_errors: boolean;
  max_tabs_per_session: number;
  memory_limit_mb: number;
}

export interface SemanticConfig {
  max_elements: number;
  max_elements_hard_limit: number;
  adaptive_max_elements: boolean;
  max_text_length: number;
  visible_only: boolean;
  include_shadow_dom: boolean;
  include_iframes: boolean;
  max_frame_depth: number;
  group_similar: boolean;
  extraction_timeout_ms: number;
  stabilization_ms: number;
  cache_enabled: boolean;
  cache_ttl_ms: number;
  cache_max_entries: number;
  token_budget: {
    max_tokens: number;
  };
}

export interface SecurityConfig {
  rate_limit_per_minute: number;
  navigate_rate_limit_per_minute: number;
  screenshot_rate_limit_per_minute: number;
  domain_whitelist: string[];
  domain_blacklist: string[];
  session_timeout_seconds: number;
  max_actions_per_session: number;
  degradation_level: 'normal' | 'moderate' | 'severe';
}

export interface MonitoringConfig {
  audit_enabled: boolean;
  audit_retention_events: number;
}

export interface PluginRegistryConfig {
  enabled: boolean;
  plugins_dir: string;
  hot_reload_enabled: boolean;
  sam_enabled: boolean;
}

export interface FileConfig {
  root_dir: string;
  max_file_bytes: number;
  allow_delete: boolean;
}

export interface AppConfig {
  server: {
    port: number;
    workers: number;
    timeout_ms: number;
    max_sessions: number;
  };
  browser: BrowserConfig;
  semantic: SemanticConfig;
  security: SecurityConfig;
  monitoring: MonitoringConfig;
  plugin_registry: PluginRegistryConfig;
  file: FileConfig;
}

export class ConfigurationManager {
  private static instance: ConfigurationManager;
  private config: AppConfig;

  private constructor() {
    this.config = this.getDefaultConfig();
  }

  public static getInstance(): ConfigurationManager {
    if (!ConfigurationManager.instance) {
      ConfigurationManager.instance = new ConfigurationManager();
    }
    return ConfigurationManager.instance;
  }

  private getDefaultConfig(): AppConfig {
    return {
      server: {
        port: envNumber('LLM_BROWSER_PORT', 3001),
        workers: envNumber('LLM_BROWSER_WORKERS', 4),
        timeout_ms: envNumber('LLM_BROWSER_TIMEOUT_MS', 30000),
        max_sessions: envNumber('LLM_BROWSER_MAX_SESSIONS', 8),
      },
      browser: {
        viewport: { width: 1280, height: 720 },
        user_agent: 'LLM-Browser/1.0',
        ignore_https_errors: false,
        max_tabs_per_session: envNumber('LLM_BROWSER_MAX_TABS_PER_SESSION', 5),
        memory_limit_mb: envNumber('LLM_BROWSER_MEMORY_LIMIT_MB', 2048),
      },
      semantic: {
        max_elements: envNumber('LLM_BROWSER_MAX_ELEMENTS', 300),
        max_elements_hard_limit: envNumber('LLM_BROWSER_MAX_ELEMENTS_HARD_LIMIT', 1000),
        adaptive_max_elements: envBoolean('LLM_BROWSER_ADAPTIVE_MAX_ELEMENTS', true),
        max_text_length: 10000,
        visible_only: true,
        include_shadow_dom: envBoolean('LLM_BROWSER_INCLUDE_SHADOW_DOM', true),
        include_iframes: envBoolean('LLM_BROWSER_INCLUDE_IFRAMES', true),
        max_frame_depth: envNumber('LLM_BROWSER_MAX_FRAME_DEPTH', 3),
        group_similar: true,
        extraction_timeout_ms: 2000,
        stabilization_ms: envNumber('LLM_BROWSER_SEMANTIC_STABILIZATION_MS', 150),
        cache_enabled: envBoolean('LLM_BROWSER_SEMANTIC_CACHE_ENABLED', true),
        cache_ttl_ms: envNumber('LLM_BROWSER_SEMANTIC_CACHE_TTL_MS', 30000),
        cache_max_entries: envNumber('LLM_BROWSER_SEMANTIC_CACHE_MAX_ENTRIES', 250),
        token_budget: {
          max_tokens: envNumber('LLM_BROWSER_MAX_TOKENS', 8000),
        },
      },
      security: {
        rate_limit_per_minute: envNumber('LLM_BROWSER_RATE_LIMIT_PER_MINUTE', 60),
        navigate_rate_limit_per_minute: envNumber('LLM_BROWSER_NAVIGATE_RATE_LIMIT_PER_MINUTE', 10),
        screenshot_rate_limit_per_minute: envNumber('LLM_BROWSER_SCREENSHOT_RATE_LIMIT_PER_MINUTE', 30),
        domain_whitelist: envCsv('LLM_BROWSER_DOMAIN_WHITELIST'),
        domain_blacklist: envCsv('LLM_BROWSER_DOMAIN_BLACKLIST'),
        session_timeout_seconds: envNumber('LLM_BROWSER_SESSION_TIMEOUT_SECONDS', 1800),
        max_actions_per_session: envNumber('LLM_BROWSER_MAX_ACTIONS_PER_SESSION', 1000),
        degradation_level: envEnum('LLM_BROWSER_DEGRADATION_LEVEL', ['normal', 'moderate', 'severe'], 'normal'),
      },
      monitoring: {
        audit_enabled: envBoolean('LLM_BROWSER_AUDIT_ENABLED', true),
        audit_retention_events: envNumber('LLM_BROWSER_AUDIT_RETENTION_EVENTS', 1000),
      },
      plugin_registry: {
        enabled: envBoolean('LLM_BROWSER_PLUGINS_ENABLED', true),
        plugins_dir: process.env.LLM_BROWSER_PLUGINS_DIR ?? './plugins',
        hot_reload_enabled: envBoolean('LLM_BROWSER_PLUGIN_HOT_RELOAD', false),
        sam_enabled: envBoolean('LLM_BROWSER_SAM_ENABLED', true),
      },
      file: {
        root_dir: process.env.LLM_BROWSER_FILE_ROOT ?? './.llm-browser/files',
        max_file_bytes: envNumber('LLM_BROWSER_MAX_FILE_BYTES', 25 * 1024 * 1024),
        allow_delete: envBoolean('LLM_BROWSER_FILE_DELETE_ENABLED', true),
      },
    };
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  public updateConfig(newConfig: Partial<AppConfig>): void {
    this.config = deepMerge(this.config, newConfig);
  }
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envCsv(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name]?.toLowerCase();
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const result: Record<string, any> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(result[key] ?? {}, value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
