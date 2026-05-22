# Prism MCP Agent Instructions

This document provides guidelines, best practices, and detailed parameter specifications for AI agents interacting with the Prism MCP Server.

---

## 1. Core Workflow (Recommended Pattern)

To interact with pages reliably, follow this sequence:
1. **Navigate**: Call `browser_navigate` to open the target URL.
2. **Observe**: Call `browser_snapshot` to fetch the semantic structure of the page, including elements, interactive controls, and available actions.
3. **Target**: Locate the target elements in the snapshot.
   - Prefer using exact `target_id` values returned in the snapshot elements.
   - Alternatively, use `target_semantic` for zero-shot natural language targeting (e.g., `"button with text Submit"`).
4. **Act**: Use `browser_action` to perform interactions like `click`, `type`, `select`, or page-level actions like `scroll` and `go_back`.
5. **Verify**: If `auto_snapshot` is enabled (default `true` on actions), the action call will return the updated page snapshot immediately. Review it to confirm the expected state change before executing the next action.

---

## 2. Dynamic Content & Popup Management (`auto_bounce`)

By default, Prism uses an `auto_bounce` mechanism to automatically dismiss safe modal popups, cookie consent banners, and promotional overlays when taking page snapshots.
- **Keep `auto_bounce: true` (default)** for normal browsing to prevent banners from obscuring interactive controls.
- **Set `auto_bounce: false`** when you need to inspect or interact with temporary overlays, flash banners, toast notifications, or dynamic status messages that appear after an action.

---

## 3. Element Targeting: ID vs. Semantic Queries

- **`target_id`**: Always prefer using the `id` property from the list of elements returned in a prior `browser_snapshot`. This is fast, precise, and avoids ambiguity.
- **`target_semantic`**: Use this when you want to execute a quick zero-shot action without loading a full snapshot first. Examples:
  - String target: `"button with text Add to Cart"`
  - Object target: `{"type": "input", "label": "Email"}`

---

## 4. Parameter Specs for Complex Actions

The `browser_action` tool accepts a generic `params` object whose structure depends on the selected `action`. Below are detailed specifications and JSON examples for the most complex actions.

### A. Form Interactions (`fill_form`)
Fills multiple fields in a single step and optionally submits the form.
- **Params Schema**:
  ```json
  {
    "form_id": "string (optional)",
    "fields": {
      "field_name_or_id": "value_to_fill"
    },
    "submit": true
  }
  ```
- **Example**:
  ```json
  {
    "action": "fill_form",
    "params": {
      "fields": {
        "email": "user@example.com",
        "password": "securepassword123"
      },
      "submit": true
    }
  }
  ```

### B. Form Verification (`fill_and_verify`)
Fills form fields, submits or triggers verification, and rolls back if the specified text/state is not verified.
- **Params Schema**:
  ```json
  {
    "fields": {
      "field_name_or_id": "value"
    },
    "submit": true,
    "verify_text": "string (text expected on success page)"
  }
  ```
- **Example**:
  ```json
  {
    "action": "fill_and_verify",
    "params": {
      "fields": {
        "promo_code": "DISCOUNT50"
      },
      "submit": true,
      "verify_text": "Promo code applied successfully"
    }
  }
  ```

### C. Automated Login Flows (`login_flow`)
Performs form filling, submission, and verification for authentication forms.
- **Params Schema**:
  ```json
  {
    "username_field": "selector or ID",
    "password_field": "selector or ID",
    "username": "email/username",
    "password": "password",
    "submit_button": "selector or ID (optional)"
  }
  ```
- **Example**:
  ```json
  {
    "action": "login_flow",
    "params": {
      "username_field": "input-email",
      "password_field": "input-password",
      "username": "agent@prism.dev",
      "password": "correct_horse_battery_staple",
      "submit_button": "btn-login"
    }
  }
  ```

### D. Search and Paginate (`search_and_paginate`)
Inputs a search query, submits, and traverses results page-by-page.
- **Params Schema**:
  ```json
  {
    "search_input_id": "element_id (optional)",
    "query": "search query string",
    "submit_id": "element_id (optional)",
    "next_id": "element_id of Next button",
    "max_pages": 3
  }
  ```
- **Example**:
  ```json
  {
    "action": "search_and_paginate",
    "params": {
      "query": "mechanical keyboard",
      "next_id": "pagination-next-btn",
      "max_pages": 2
    }
  }
  ```

### E. Script Definition and Invocation (`define_script` / `call_script`)
You can define a sequence of actions as a named script and invoke it later with dynamic arguments.
- **Define Script Example**:
  ```json
  {
    "action": "define_script",
    "params": {
      "name": "accept_cookies_and_search",
      "script": [
        { "action": "click", "target_id": "cookie-consent-accept" },
        { "action": "type", "target_id": "search-box", "params": { "text": "$query", "press_enter": true } }
      ]
    }
  }
  ```
- **Call Script Example**:
  ```json
  {
    "action": "call_script",
    "params": {
      "name": "accept_cookies_and_search",
      "args": {
        "query": "Prism Browser"
      }
    }
  }
  ```

---

## 5. Tab and Window Management

Prism sessions support multiple isolated tabs.
- Use `browser_list_tabs` to see all open tabs and find the currently active tab ID (`active: true`).
- Use `browser_open_tab` to open a new URL in a separate tab context.
- Use `browser_switch_tab` with a specific `tab_id` to switch the focus of subsequent actions and snapshots to that tab.
- Use `browser_close_tab` to clean up tabs and conserve server memory.

---

## 6. Waiting & Synchronization

For modern Single Page Applications (SPAs) or pages loading content dynamically via WebSockets, polling, or Fetch:
- Set `wait_until: "networkidle"` on `browser_navigate` to ensure the initial dynamic requests have settled.
- Use `browser_wait_for` to wait for specific DOM states:
  ```json
  {
    "condition": "element_visible",
    "element_id": "dashboard-loaded-indicator",
    "timeout_ms": 10000
  }
  ```

---

## 7. CAPTCHA Handling & Human-in-the-Loop (HITL)

Prism features a 3-level CAPTCHA bypass system.

### A. Evasion & Human Simulation (Automatic)
Level 1 is fully automatic. Prism mocks browser fingerprints (WebGl, navigator plugins, languages, webdriver flag) and simulates natural human keyboard delays and Bezier mouse movements. No agent action is required.

### B. Automated Token Solving (`solve_captcha`)
If a CAPTCHA (reCAPTCHA, hCaptcha, Cloudflare Turnstile) is detected on the page, call the `solve_captcha` action to attempt automated token-based resolution.

- **Action Name**: `solve_captcha`
- **Params Schema**:
  ```json
  {
    "provider": "string (optional, '2captcha' | 'capmonster' | 'anticaptcha')",
    "api_key": "string (optional, API key for the chosen provider)",
    "timeout_ms": "number (optional, default 120000)"
  }
  ```
- **Example**:
  ```json
  {
    "action": "solve_captcha",
    "params": {
      "provider": "2captcha",
      "timeout_ms": 60000
    }
  }
  ```
- **Response**:
  - Success: `{ "solved": true, "type": "recaptcha", "provider": "2captcha" }`
  - No CAPTCHA found: `{ "solved": false, "reason": "No CAPTCHA detected" }`

### C. Human-in-the-Loop (HITL) Fallback (`SESSION_PAUSED`)
If automated solving fails, or if no API keys are configured, Prism pauses the session.
- **Error Response**: The server will reject actions with a `SESSION_PAUSED` error code (HTTP `409 Conflict`).
- **Required Agent Action**:
  1. Inform the user/client application that execution is paused for human CAPTCHA solving.
  2. Wait for the user/client to solve the CAPTCHA and call the resume endpoint:
     `POST /api/v2/sessions/:id/resume`
  3. Once resumed (which emits a WebSocket `session_resumed` event and sets status back to `active`), you may proceed with browsing.

