import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class FormTracker {
  static async inject(page: Page, sessionId: string): Promise<void> {
    await exposeOnce(page, 'reportFormChange', async (data: any) => {
      const timestamp = data.timestamp ?? new Date().toISOString();
      await globalEventBus.publish('form_state_updated', { session_id: sessionId, data, timestamp });
      if (data.changed_field) {
        await globalEventBus.publish('field_changed', {
          session_id: sessionId,
          form_id: data.form_id,
          field: data.changed_field,
          value: data.fields?.[data.changed_field],
          timestamp,
        });
      }
      for (const error of data.errors ?? []) {
        await globalEventBus.publish('validation_error', {
          session_id: sessionId,
          form_id: data.form_id,
          error,
          timestamp,
        });
      }
    });

    await page.addInitScript(formTrackerScript, sessionId);
    await page.evaluate(formTrackerScript, sessionId).catch(() => undefined);
  }
}

async function exposeOnce(page: Page, name: string, fn: (...args: any[]) => any): Promise<void> {
  try {
    await page.exposeFunction(name, fn);
  } catch (error) {
    if (!/already exists|has been already registered|Function .* has been already registered/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

function formTrackerScript(sessionId: string): void {
  const win = window as any;
  const key = '__llmBrowserFormTracker';
  if (win[key]?.sessionId === sessionId) return;

  const semanticIdAttr = 'data-llm-browser-id';
  const controlSelector = 'input, select, textarea';
  const mask = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: any): any => {
    if (field instanceof HTMLInputElement && ['password', 'hidden'].includes(field.type)) return value ? '[masked]' : value;
    return value;
  };
  const fieldValue = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): any => {
    if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked;
    if (field instanceof HTMLInputElement && field.type === 'radio') return field.checked ? field.value : false;
    if (field instanceof HTMLSelectElement && field.multiple) return Array.from(field.selectedOptions).map((option) => option.value);
    return field.value;
  };
  const fieldKey = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string =>
    field.name || field.id || field.getAttribute(semanticIdAttr) || field.tagName.toLowerCase();
  const visualErrors = (field: HTMLElement): string[] => {
    const messages: string[] = [];
    const roots = [
      field.closest('.error, .invalid, [aria-invalid="true"]'),
      field.parentElement,
      field.closest('label'),
    ].filter(Boolean) as Element[];
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll('.error, .invalid, .field-error, [role="alert"], [aria-live]')).slice(0, 5)) {
        const text = el.textContent?.replace(/\s+/g, ' ').trim();
        if (text) messages.push(text.slice(0, 220));
      }
    }
    return messages;
  };
  const formId = (form: HTMLFormElement): string =>
    form.getAttribute(semanticIdAttr) || form.id || form.getAttribute('name') || `form-${Array.from(document.forms).indexOf(form) + 1}`;
  const initialKey = 'llmInitialValue';
  const captureInitial = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void => {
    if (field.dataset[initialKey] !== undefined) return;
    field.dataset[initialKey] = String(fieldValue(field));
    field.setAttribute('data-llm-initial-value', String(fieldValue(field)));
  };
  const stateFor = (form: HTMLFormElement, changedField?: string) => {
    const fields: Record<string, any> = {};
    const errors: string[] = [];
    let dirty = false;
    let required = 0;
    let completed = 0;
    const controls = Array.from(form.querySelectorAll(controlSelector))
      .filter((field): field is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement
      );
    for (const field of controls) {
      captureInitial(field);
      const key = fieldKey(field);
      const value = fieldValue(field);
      fields[key] = mask(field, value);
      if (String(value) !== String(field.dataset[initialKey] ?? '')) dirty = true;
      if (field.required) {
        required += 1;
        if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) {
          if (field.checked) completed += 1;
        } else if (String(value ?? '').trim()) {
          completed += 1;
        }
      }
      if (!field.validity.valid && field.validationMessage) errors.push(`${key}: ${field.validationMessage}`);
      if (field.getAttribute('aria-invalid') === 'true') errors.push(`${key}: invalid`);
      for (const message of visualErrors(field)) errors.push(`${key}: ${message}`);
    }
    return {
      form_id: formId(form),
      fields,
      errors: Array.from(new Set(errors)).slice(0, 20),
      is_dirty: dirty,
      is_valid: errors.length === 0 && controls.every((field) => field.validity.valid),
      completion_percentage: required > 0 ? Math.round((completed / required) * 100) : 100,
      changed_field: changedField,
      timestamp: new Date().toISOString(),
    };
  };
  const report = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLElement)) return;
    const field = target.closest(controlSelector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    const form = field?.form ?? target.closest('form');
    if (!(form instanceof HTMLFormElement)) return;
    win.reportFormChange?.(stateFor(form, field ? fieldKey(field) : undefined));
  };
  const reportAll = (): void => {
    for (const form of Array.from(document.forms)) {
      for (const field of Array.from(form.querySelectorAll(controlSelector))) {
        if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
          captureInitial(field);
        }
      }
      win.reportFormChange?.(stateFor(form));
    }
  };

  document.addEventListener('input', (event) => report(event.target), { capture: true });
  document.addEventListener('change', (event) => report(event.target), { capture: true });
  document.addEventListener('blur', (event) => report(event.target), { capture: true });
  document.addEventListener('submit', (event) => report(event.target), { capture: true });
  reportAll();
  win[key] = { sessionId, reportAll };
}
