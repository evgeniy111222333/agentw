import { AvailableAction, SemanticElement } from '../../common/types';
import { riskScoreForAction } from '../../common/AuditLog';

export class ActionDiscovery {
  discover(elements: SemanticElement[]): AvailableAction[] {
    const actions: AvailableAction[] = [];

    for (const el of elements) {
      if (el.disabled) continue;

      if (el.type === 'button' || el.type === 'menu_item') {
        actions.push(this.targeted('click', el, el.label || el.text || 'Activate control'));
      } else if (el.type === 'link' && el.url) {
        actions.push(
          this.targeted('navigate', el, el.label || el.text || 'Open link', {
            url: el.url,
          })
        );
        if (el.download !== undefined || /download/i.test(`${el.label ?? ''} ${el.text ?? ''}`)) {
          actions.push(
            this.targeted('download', el, el.label || el.text || 'Download file', {
              schema: {
                file_name: 'string?',
                timeout_ms: 'number?',
              },
            })
          );
        }
      } else if (el.type === 'input' || el.type === 'textarea') {
        const inputType = el.input_type ?? 'text';
        if (inputType === 'file') {
          actions.push(
            this.targeted('upload', el, el.label || el.placeholder || 'Upload file', {
              schema: {
                file_path: 'string?',
                file_paths: 'string[]?',
                file_content: 'string?',
                file_name: 'string?',
                files: 'object[]?',
              },
            })
          );
        } else if (['checkbox', 'radio'].includes(inputType)) {
          actions.push(this.targeted('click', el, el.label || 'Toggle option'));
        } else {
          actions.push(
            this.targeted('type', el, el.label || el.placeholder || 'Enter text', {
              schema: {
                text: 'string',
                clear: 'boolean?',
                press_enter: 'boolean?',
              },
            })
          );
          if (inputType === 'search' || /search/i.test(`${el.label ?? ''} ${el.placeholder ?? ''} ${el.name ?? ''}`)) {
            actions.push(
              this.targeted('search_and_paginate', el, el.label || el.placeholder || 'Search', {
                schema: {
                  query: 'string',
                  submit: 'boolean?',
                  collect_all_pages: 'boolean?',
                  max_pages: 'number?',
                  next_id: 'string?',
                },
              })
            );
          }
        }
      } else if (el.type === 'select') {
        actions.push(
          this.targeted('select', el, el.label || 'Select option', {
            schema: { value: 'string?', label: 'string?' },
            options: el.options,
          })
        );
      } else if (el.type === 'form') {
        actions.push(this.targeted('submit', el, el.label || 'Submit form'));
        actions.push(
          this.targeted('fill_form', el, el.label || 'Fill form', {
            schema: {
              fields: 'object',
              submit: 'boolean?',
              rollback: 'boolean?',
              on_failure: 'continue|rollback|fail?',
            },
            fields: el.fields,
          })
        );
        actions.push(
          this.targeted('fill_and_verify', el, el.label || 'Fill and verify form', {
            schema: {
              fields: 'object',
              on_failure: 'continue|rollback?',
            },
            fields: el.fields,
          })
        );
      } else if (el.type === 'embed' || el.type === 'iframe') {
        if (['content', 'payment', 'captcha', 'auth'].includes(String(el.iframe_type))) {
          actions.push(
            this.targeted('interact', el, el.label || el.embed_type || el.iframe_type || 'Interact with embedded content', {
              schema: {
                timeout_ms: 'number?',
              },
            })
          );
        }
      } else if (el.type === 'pagination') {
        for (const page of (el.pages ?? []).slice(0, 12)) {
          if (page.disabled || page.current) continue;
          actions.push(this.targeted(page.url ? 'navigate' : 'click', { ...el, id: page.id, label: page.label, url: page.url }, page.label || `Page ${page.page ?? ''}`, page.url ? { url: page.url } : undefined));
        }
      } else if (el.type === 'accordion') {
        for (const section of (el.sections ?? []).slice(0, 12)) {
          actions.push(this.targeted('click', { ...el, id: section.id, label: section.title }, section.expanded ? `Collapse ${section.title ?? 'section'}` : `Expand ${section.title ?? 'section'}`));
        }
      } else if (el.type === 'carousel') {
        for (const actionId of (el.actions ?? []).slice(0, 4)) {
          actions.push(this.targeted('click', { ...el, id: actionId }, el.label || 'Carousel control'));
        }
      } else if (el.type === 'video' || el.type === 'audio') {
        actions.push(
          this.targeted('media_control', el, el.label || `${el.type} controls`, {
            schema: {
              command: 'play|pause|seek|mute|unmute|set_volume|set_playback_rate|fullscreen?',
              time_seconds: 'number?',
              volume: 'number?',
              rate: 'number?',
            },
          })
        );
      } else if (el.type === 'chart') {
        actions.push(this.targeted('screenshot', el, el.label || el.data_summary || 'Capture chart', { element_id: el.id }));
      }

      if (el.in_viewport === false) {
        actions.push({
          action_id: `scroll_to_element_${el.id}`,
          action: 'scroll_to_element',
          target: el.id,
          label: `Scroll to ${el.label || el.text || el.type}`,
          preconditions: ['element_exists'],
          risk: 'low',
        });
      }
    }

    actions.push(
      {
        action_id: 'go_back',
        action: 'go_back',
        label: 'Go back',
        risk: 'low',
      },
      {
        action_id: 'go_forward',
        action: 'go_forward',
        label: 'Go forward',
        risk: 'low',
      },
      {
        action_id: 'refresh',
        action: 'refresh',
        label: 'Refresh page',
        risk: 'low',
      },
      {
        action_id: 'open_tab',
        action: 'open_tab',
        label: 'Open new tab',
        params: { schema: { url: 'string?' } },
        risk: 'low',
      },
      {
        action_id: 'list_tabs',
        action: 'list_tabs',
        label: 'List tabs',
        risk: 'low',
      },
      {
        action_id: 'scroll_down',
        action: 'scroll',
        label: 'Scroll down',
        params: { direction: 'down', amount: 720, schema: { direction: 'up|down|left|right?', amount: 'number?', mode: 'auto_scroll?', max_items: 'number?', stall_timeout_ms: 'number?' } },
        risk: 'low',
      },
      {
        action_id: 'scroll_up',
        action: 'scroll',
        label: 'Scroll up',
        params: { direction: 'up', amount: 720 },
        risk: 'low',
      },
      {
        action_id: 'wait',
        action: 'wait',
        label: 'Wait for page changes',
        params: { ms: 500 },
        risk: 'low',
      },
      {
        action_id: 'wait_for',
        action: 'wait_for',
        label: 'Wait for condition',
        params: {
          schema: {
            condition: 'object',
            timeout_ms: 'number?',
            poll_interval_ms: 'number?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'poll',
        action: 'poll',
        label: 'Poll async operation',
        params: { schema: { operation_id: 'string' } },
        risk: 'low',
      },
      {
        action_id: 'cancel',
        action: 'cancel',
        label: 'Cancel async operation',
        params: { schema: { operation_id: 'string' } },
        risk: 'medium',
      },
      {
        action_id: 'snapshot',
        action: 'snapshot',
        label: 'Take semantic snapshot',
        params: { schema: { max_elements: 'number?' } },
        risk: 'low',
      },
      {
        action_id: 'set_viewport',
        action: 'set_viewport',
        label: 'Set viewport',
        params: {
          schema: {
            profile: 'desktop|tablet|mobile?',
            width: 'number?',
            height: 'number?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'screenshot',
        action: 'screenshot',
        label: 'Take screenshot',
        params: { full_page: true },
        risk: 'medium',
      },
      {
        action_id: 'screenshot_file',
        action: 'screenshot_file',
        label: 'Save screenshot',
        params: { full_page: true, file_name: 'page.png' },
        risk: 'medium',
      },
      {
        action_id: 'pdf',
        action: 'pdf',
        label: 'Save PDF',
        params: { file_name: 'page.pdf', format: 'A4' },
        risk: 'medium',
      },
      {
        action_id: 'fs',
        action: 'fs',
        label: 'Use session files',
        params: {
          schema: {
            operation: 'list|read|write|delete',
            path: 'string?',
            content: 'string?',
            base64: 'string?',
          },
        },
        risk: 'medium',
      },
      {
        action_id: 'invalidate_cache',
        action: 'invalidate_cache',
        label: 'Invalidate semantic cache',
        risk: 'medium',
      },
      // Concept §5.6: Compound actions
      {
        action_id: 'multi_click',
        action: 'multi_click',
        label: 'Click multiple targets',
        params: {
          schema: {
            element_ids: 'string[]',
            on_failure: 'continue|fail?',
            continue_on_error: 'boolean?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'sequence',
        action: 'sequence',
        label: 'Run action sequence',
        params: {
          schema: {
            steps: 'object[]',
            stop_on_error: 'boolean?',
          },
        },
        risk: 'medium',
      },
      {
        action_id: 'parallel',
        action: 'parallel',
        label: 'Run safe actions in parallel',
        params: {
          schema: {
            steps: 'object[]',
            continue_on_error: 'boolean?',
          },
        },
        risk: 'medium',
      },
      {
        action_id: 'if',
        action: 'if',
        label: 'Run conditional action',
        params: {
          schema: {
            condition: 'object',
            then: 'object?',
            else: 'object?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'loop',
        action: 'loop',
        label: 'Run bounded loop',
        params: {
          schema: {
            while: 'object',
            do: 'object',
            max_iterations: 'number?',
            delay_ms: 'number?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'navigate_and_extract',
        action: 'navigate_and_extract',
        label: 'Navigate and extract content',
        params: {
          schema: {
            url: 'string',
            extract_selector: 'string?',
            wait_ms: 'number?',
          },
        },
        risk: 'medium',
      },
      {
        action_id: 'login_flow',
        action: 'login_flow',
        label: 'Multi-step login',
        params: {
          schema: {
            url: 'string',
            credentials: 'object',
            form_id: 'string?',
            submit_id: 'string?',
            success_url: 'string?',
            success_element: 'string?',
          },
        },
        risk: 'medium',
      },
      // Concept §5.7: Async actions
      {
        action_id: 'async_navigate',
        action: 'async_navigate',
        label: 'Navigate in background',
        params: {
          schema: {
            url: 'string',
            timeout_ms: 'number?',
            estimated_time_ms: 'number?',
          },
        },
        risk: 'medium',
      },
      // Concept §5.8: Script system
      {
        action_id: 'define_script',
        action: 'define_script',
        label: 'Define reusable script',
        params: {
          schema: {
            name: 'string',
            steps: 'object[]',
            params: 'string[]?',
          },
        },
        risk: 'low',
      },
      {
        action_id: 'call_script',
        action: 'call_script',
        label: 'Call named script',
        params: {
          schema: {
            name: 'string',
            args: 'object?',
          },
        },
        risk: 'medium',
      },
      {
        action_id: 'try',
        action: 'try',
        label: 'Try-catch error handling',
        params: {
          schema: {
            do: 'object',
            catch: 'object|object[]?',
          },
        },
        risk: 'low',
      }
    );

    return actions.map((action) => {
      const risk_score = action.risk_score ?? riskScoreForAction(action.action);
      return {
        ...action,
        risk: risk_score >= 70 ? 'high' : risk_score >= 30 ? 'medium' : 'low',
        risk_score,
      };
    });
  }

  private targeted(action: string, element: SemanticElement, label: string, params?: Record<string, any>): AvailableAction {
    const riskScore = riskScoreForAction(action);
    const actionParams = params ?? (action === 'click'
      ? { schema: { button: 'left|right|middle?', click_count: 'number?', timeout_ms: 'number?' } }
      : undefined);
    return {
      action_id: `${action}_${element.id}`,
      action,
      target: element.id,
      label,
      params: actionParams,
      preconditions: preconditionsFor(action),
      risk: riskScore >= 70 ? 'high' : riskScore >= 30 ? 'medium' : 'low',
      risk_score: riskScore,
    };
  }
}

function preconditionsFor(action: string): string[] {
  if (action === 'navigate' || action === 'download') {
    return ['element_visible', 'element_enabled', 'element_stable', 'no_modal_open', 'page_loaded'];
  }
  if (action === 'submit' || action === 'fill_form' || action === 'fill_and_verify') {
    return ['element_visible', 'element_enabled', 'element_stable', 'no_modal_open', 'page_loaded'];
  }
  if (action === 'scroll_to_element') {
    return ['element_exists', 'page_loaded'];
  }
  return ['element_visible', 'element_enabled', 'element_stable', 'no_modal_open', 'page_loaded'];
}
