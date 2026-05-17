import { AvailableAction, SemanticElement } from '../../common/types';

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
      } else if (el.type === 'input') {
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
            schema: { value: 'string' },
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
            },
            fields: el.fields,
          })
        );
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
        params: { direction: 'down', amount: 720 },
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
      }
    );

    return actions;
  }

  private targeted(action: string, element: SemanticElement, label: string, params?: Record<string, any>): AvailableAction {
    return {
      action_id: `${action}_${element.id}`,
      action,
      target: element.id,
      label,
      params,
      preconditions: ['element_visible', 'element_enabled'],
      risk: action === 'navigate' || action === 'submit' ? 'medium' : 'low',
    };
  }
}
