import { Page } from 'playwright';
import { globalEventBus } from '../../common/EventBus';

export class FormTracker {
  static async inject(page: Page, sessionId: string) {
    await page.exposeFunction('reportFormChange', (data: any) => {
      globalEventBus.publish('form_state_updated', { session_id: sessionId, data, timestamp: new Date().toISOString() });
    });

    await page.addInitScript(() => {
      document.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (!target) return;
        
        let value = target.value;
        if (target.type === 'checkbox' || target.type === 'radio') {
          value = (target as HTMLInputElement).checked.toString();
        }

        (window as any).reportFormChange({
          elementId: target.id || target.name,
          tagName: target.tagName,
          type: target.type,
          value: value
        });
      }, { capture: true });
    });
  }
}
