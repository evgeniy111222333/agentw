export type ElementType =
  | 'heading' | 'text' | 'link' | 'button' | 'input' | 'select' | 'textarea' | 'form'
  | 'table' | 'list' | 'image' | 'navigation' | 'article' | 'card' | 'pagination'
  | 'modal' | 'tab_group' | 'accordion' | 'notification' | 'video' | 'breadcrumb'
  | 'progress' | 'chart' | 'iframe' | 'embed' | 'shadow_host' | 'dialog' | 'menu' | 'menu_item' | 'badge'
  | 'tooltip' | 'separator' | 'carousel' | 'rating' | 'stepper' | 'skeleton' | 'audio'
  // IMPROVED: Additional form-related types for better classification
  | 'form_group' | 'form_label' | 'suggestion_list' | 'form_output';

export interface SemanticElement {
  id: string;
  type: ElementType;
  role?: string;
  label?: string;
  text?: string;
  visible?: boolean;
  disabled?: boolean;
  required?: boolean;
  parent_id?: string;
  [key: string]: any;
}

export interface ActionParam {
  [key: string]: any;
}

export type ActionStatus = 'requested' | 'success' | 'error';

export interface AvailableAction {
  action_id?: string;
  action: string;
  target?: string;
  label: string;
  params?: ActionParam;
  preconditions?: string[];
  risk?: 'low' | 'medium' | 'high';
  risk_score?: number;
  source?: {
    type: 'core' | 'plugin' | 'sam';
    plugin?: string;
    standard?: string;
  };
  execution?: {
    action: string;
    target?: string;
    params?: ActionParam;
  };
}

export interface SessionInfo {
  session_id: string;
  tab_id: string;
  tabs_count: number;
  history_length: number;
  cookies_count: number;
  viewport?: ViewportState;
}

export interface TabState {
  tab_id: string;
  url: string;
  title: string;
  active: boolean;
  viewport?: ViewportState;
  snapshot_id?: string;
  form_states?: Record<string, FormState>;
}

export interface FormState {
  form_id: string;
  fields: Record<string, any>;
  errors: string[];
  is_dirty: boolean;
  is_valid: boolean;
  completion_percentage: number;
  updated_at?: string;
}

export interface ScrollState {
  position: number;
  left: number;
  viewport_height: number;
  viewport_width: number;
  total_height: number;
  total_width: number;
  percentage: number;
  horizontal_percentage: number;
  lazy_count?: number;
  lazy_unloaded_count?: number;
  infinite_scroll?: {
    detected: boolean;
    sentinel_id?: string;
    reason?: string;
  };
}

export interface ViewportState {
  width: number;
  height: number;
  device_scale_factor?: number;
  is_mobile?: boolean;
  has_touch?: boolean;
  user_agent?: string;
  profile?: string;
  mode?: 'context' | 'page';
}

export interface SnapshotMeta {
  page_load_time?: number;
  action_time?: number;
  total_time?: number;
  extraction_time?: number;
  dom_nodes_count?: number;
  semantic_nodes_count?: number;
  semantic_nodes_total?: number;
  max_elements?: number;
  max_elements_requested?: number;
  raw_dom_bytes?: number;
  snapshot_bytes?: number;
  token_estimate?: number;
  compression_ratio?: number;
  // MCP-specific metadata
  truncated?: number;
  cache_status?: 'hit' | 'miss' | 'disabled';
  cache_key?: string;
  cache_age_ms?: number;
  cache_entries?: number;
  incremental_extraction?: boolean;
  incremental_cached_nodes?: number;
  incomplete?: boolean;
  trace_id?: string;
  viewport?: ViewportState;
  scroll?: ScrollState;
  encapsulation?: {
    iframe_count: number;
    iframe_in_output_count?: number;
    iframe_extracted_count: number;
    iframe_skipped_ads: number;
    iframe_depth_limited: number;
    shadow_root_count: number;
    closed_shadow_roots: number;
    max_frame_depth: number;
  };
  plugin_contributions?: {
    actions: number;
    elements: number;
    warnings: number;
    plugins: Record<string, any>;
  };
  budget?: {
    estimated_tokens: number;
    budget_used_pct: number;
    pruned_elements: number;
    pruning_applied: boolean;
  };
  privacy?: PrivacyStats;
  filter?: {
    actionable_only?: boolean;
    affordances?: string[];
    include_types?: string[];
    exclude_types?: string[];
    before_elements: number;
    after_elements: number;
    before_actions: number;
    after_actions: number;
    dropped_elements: number;
  };
  bouncer?: {
    attempted: boolean;
    closed: number;
    duration_ms?: number;
    actions?: Array<{ text: string; reason: string; selector?: string }>;
  };
  visual?: {
    cursor?: { x: number; y: number; action: string; updated_at: string };
    headless?: boolean;
  };
}

export interface PrivacyStats {
  masked: number;
  kinds: Record<string, number>;
}

export interface SemanticDeltaOperation {
  op:
    | 'element_add'
    | 'element_remove'
    | 'element_update'
    | 'update_attr'
    | 'actions_replace'
    | 'action_add'
    | 'action_remove'
    | 'metadata_update';
  element_id?: string;
  element?: SemanticElement;
  before?: Partial<SemanticElement>;
  after?: Partial<SemanticElement>;
  changes?: Array<{ attr: string; old_value: any; new_value: any }>;
  after_id?: string;
  before_id?: string;
  actions?: AvailableAction[];
  action?: AvailableAction;
  metadata?: Record<string, any>;
}

export interface SemanticDelta {
  from_snapshot_id?: string;
  to_snapshot_id: string;
  timestamp: string;
  checksum?: string;
  operations: SemanticDeltaOperation[];
  stats: {
    added: number;
    removed: number;
    updated: number;
    actions_changed: boolean;
  };
}

export interface SemanticSnapshot {
  snapshot_id?: string;
  version: string;
  url: string;
  title: string;
  timestamp: string;
  elements: SemanticElement[];
  available_actions: AvailableAction[];
  session: SessionInfo;
  checksum?: string;
  meta?: SnapshotMeta;
  forms?: any[];
  alerts?: any[];
  navigation?: any;
  auth?: AuthState;
  delta?: SemanticDelta;
}

export interface AuthCookieInfo {
  name: string;
  domain?: string;
  path?: string;
  expires_at?: string;
  http_only?: boolean;
  secure?: boolean;
  same_site?: string;
}

export interface OAuthState {
  detected: boolean;
  provider?: string;
  stage?: 'authorize' | 'callback' | 'unknown';
  has_state?: boolean;
  has_code?: boolean;
}

export interface AuthState {
  authenticated: boolean;
  confidence: number;
  method?: 'cookie' | 'oauth' | 'token' | 'basic' | 'form' | 'unknown';
  session_expires_at?: string;
  user_identity?: string;
  indicators: string[];
  cookies: AuthCookieInfo[];
  oauth?: OAuthState;
  login_form_detected?: boolean;
  updated_at: string;
}

export type RuntimeEventKind =
  | 'request'
  | 'response'
  | 'request_failed'
  | 'console'
  | 'page_error'
  | 'navigation'
  | 'dialog'
  | 'download';

export type StreamEventType =
  | RuntimeEventKind
  | 'runtime_event'
  | 'page_changed'
  | 'action_completed'
  | 'action_retry'
  | 'action_failed'
  | 'error'
  | 'security'
  | 'heartbeat';

export interface RuntimeEvent {
  event_id: string;
  session_id: string;
  tab_id: string;
  kind: RuntimeEventKind;
  timestamp: string;
  url?: string;
  method?: string;
  resource_type?: string;
  request_id?: string;
  status?: number;
  status_text?: string;
  ok?: boolean;
  duration_ms?: number;
  level?: string;
  text?: string;
  title?: string;
  dialog_type?: string;
  default_value?: string;
  handled?: string;
  file_name?: string;
  page_url?: string;
  location?: {
    url?: string;
    line?: number;
    column?: number;
  };
  error?: string;
}

export interface RuntimeEventStats {
  total: number;
  by_kind: Record<RuntimeEventKind, number>;
  recent_errors: number;
}

export interface StreamEvent {
  event_id: string;
  type: StreamEventType;
  timestamp: string;
  session_id?: string;
  tab_id?: string;
  data?: Record<string, any>;
}

export interface SessionState {
  session_id: string;
  created_at: string;
  updated_at: string;
  status: 'active' | 'idle' | 'closed' | 'suspended' | 'expired';
  current_url: string;
  tabs: TabState[];
  cookies: any[];
  localStorage: Record<string, string>;
  history: Array<{ url: string; timestamp: string; navigation_type?: string; referrer?: string }>;
  configuration: any;
  viewport?: ViewportState;
  auth?: AuthState;
  form_states?: Record<string, FormState>;
  checkpoint?: {
    last_checkpoint_at?: string;
    checkpoint_path?: string;
    checkpoint_reason?: string;
  };
}

export interface ActionRecord {
  action_id: string;
  session_id: string;
  action: string;
  target_id?: string;
  params?: ActionParam;
  status: ActionStatus;
  requested_at: string;
  completed_at?: string;
  duration_ms?: number;
  error_code?: string;
  error_message?: string;
  trace_id?: string;
  token_estimate?: number;
}
