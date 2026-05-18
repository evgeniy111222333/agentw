import { Browser, chromium, Page } from 'playwright';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { ActionExecutor } from '../../src/layer2_action_execution/ActionExecutor';
import { SemanticLayer } from '../../src/layer4_semantic/SemanticLayer';

jest.setTimeout(30000);

describe('iframe and Shadow DOM encapsulation', () => {
  const configManager = ConfigurationManager.getInstance();
  const originalSemantic = { ...configManager.getConfig().semantic };
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
  });

  beforeEach(async () => {
    configManager.updateConfig({
      semantic: {
        ...configManager.getConfig().semantic,
        cache_enabled: false,
        include_iframes: true,
        include_shadow_dom: true,
        max_frame_depth: 3,
      },
    });
    page = await browser!.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(shadowHook);
    await page.evaluate(shadowHook);
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  afterAll(async () => {
    configManager.updateConfig({ semantic: originalSemantic });
    await browser?.close();
    browser = undefined;
  });

  it('extracts open and captured closed Shadow DOM with origins, hosts, and slot links', async () => {
    await page!.setContent(`<!doctype html>
      <shadow-card id="card"><span id="light-label" slot="label">Light Label</span></shadow-card>
      <closed-card id="closed"></closed-card>
      <script>
        customElements.define('shadow-card', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<button id="shadow-save">Shadow Save</button><slot name="label"></slot>';
          }
        });
        customElements.define('closed-card', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'closed' });
            root.innerHTML = '<label>Closed Secret <input id="closed-input" value="inside"></label>';
          }
        });
      </script>`);

    const snap = await snapshot(page!);

    const host = snap.elements.find((element) => element.id === 'card');
    expect(host).toEqual(expect.objectContaining({
      type: 'shadow_host',
      origin: 'main',
      shadow: expect.objectContaining({ has_shadow: true, mode: 'open' }),
    }));

    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'scard:shadow-save',
      type: 'button',
      origin: 'shadow:card',
      parent_id: 'card',
      text: 'Shadow Save',
      context: expect.objectContaining({ type: 'shadow', shadow_host_id: 'card', shadow_mode: 'open' }),
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'light-label',
      slotted_in: 'shadow:card#slot:label',
    }));
    expect(snap.elements).toContainEqual(expect.objectContaining({
      id: 'sclosed:closed-input',
      type: 'input',
      origin: 'shadow:closed',
      context: expect.objectContaining({ type: 'shadow', shadow_host_id: 'closed', shadow_mode: 'closed' }),
    }));
    expect(snap.meta?.encapsulation).toEqual(expect.objectContaining({
      shadow_root_count: 2,
      closed_shadow_roots: 1,
    }));
  });

  it('classifies iframe categories, extracts same-origin iframe content, and executes actions inside frames', async () => {
    await page!.setContent(`<!doctype html>
      <iframe id="profile-frame" title="Profile frame" srcdoc="
        <button id='frame-save' onclick='document.body.dataset.clicked = &quot;yes&quot;'>Frame Save</button>
        <label>Frame Email <input id='frame-email' type='email'></label>
      "></iframe>
      <iframe id="ad-frame" width="300" height="250" data-ad-client="ca-pub-1" src="https://googleads.g.doubleclick.net/pagead/ads"></iframe>
      <iframe id="video-frame" title="Demo video" src="https://www.youtube.com/embed/abc123"></iframe>
      <iframe id="payment-frame" title="Card details" src="https://js.stripe.com/v3/elements-inner-card.html"></iframe>`);
    await page!.frameLocator('#profile-frame').locator('#frame-save').waitFor();

    const first = await snapshot(page!);
    const frameButton = first.elements.find((element) => element.text === 'Frame Save');
    const frameInput = first.elements.find((element) => element.id.endsWith('frame-email'));

    expect(frameButton).toEqual(expect.objectContaining({
      type: 'button',
      origin: expect.stringContaining('iframe:'),
      parent_id: 'profile-frame',
      context: expect.objectContaining({ type: 'iframe', frame_depth: 1 }),
    }));
    expect(frameInput).toEqual(expect.objectContaining({
      type: 'input',
      origin: expect.stringContaining('iframe:'),
    }));
    expect(first.elements.some((element) => element.id === 'ad-frame')).toBe(false);
    expect(first.elements).toContainEqual(expect.objectContaining({
      id: 'video-frame',
      type: 'embed',
      embed_type: 'youtube',
      video_id: 'abc123',
      status: 'metadata_only',
    }));
    expect(first.elements).toContainEqual(expect.objectContaining({
      id: 'payment-frame',
      type: 'iframe',
      iframe_type: 'payment',
      status: 'metadata_only',
      available_actions: expect.arrayContaining([expect.objectContaining({ action: 'interact' })]),
    }));
    expect(first.meta?.encapsulation).toEqual(expect.objectContaining({
      iframe_count: 4,
      iframe_extracted_count: 1,
      iframe_skipped_ads: 1,
    }));

    const executor = new ActionExecutor({ getPage: () => page } as any);
    await executor.executeAction('session', 'type', frameInput!.id, { text: 'inside@example.com' });
    await executor.executeAction('session', 'click', frameButton!.id);

    await expect(page!.frameLocator('#profile-frame').locator('#frame-email').inputValue()).resolves.toBe('inside@example.com');
    await expect(page!.frameLocator('#profile-frame').locator('body').getAttribute('data-clicked')).resolves.toBe('yes');
  });
});

async function snapshot(page: Page) {
  const layer = new SemanticLayer();
  return layer.createSnapshot(page, {
    session: {
      session_id: 'session',
      tab_id: 'tab-1',
      tabs_count: 1,
      history_length: 0,
      cookies_count: 0,
    },
  });
}

function shadowHook(): void {
  const key = '__llmBrowserShadowRoots';
  const win = window as any;
  if (win[key]?.installed) return;
  const original = Element.prototype.attachShadow;
  const roots: Array<{ host: Element; root: ShadowRoot; mode: string }> = [];
  Object.defineProperty(win, key, {
    value: {
      installed: true,
      roots,
      rootFor(host: Element) {
        return roots.find((entry) => entry.host === host)?.root;
      },
      modeFor(host: Element) {
        return roots.find((entry) => entry.host === host)?.mode;
      },
    },
  });
  Element.prototype.attachShadow = function patchedAttachShadow(init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    roots.push({ host: this, root, mode: init.mode });
    return root;
  };
}
