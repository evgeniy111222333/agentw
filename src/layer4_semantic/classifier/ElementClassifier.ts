import { ElementType } from '../../common/types';

export class ElementClassifier {
  classify(node: any): ElementType {
    const role = normalize(node.role ?? node.attributes?.role);
    const tagName = normalize(node.tagName);
    const attributes = node.attributes ?? {};

    const roleType = this.classifyByRole(role);
    if (roleType) return roleType;

    const tagType = this.classifyByTag(tagName, attributes);
    if (tagType) return tagType;

    if (attributes.onclick || attributes['data-semantic-action'] || attributes.tabindex === '0') {
      return 'button';
    }

    if (node.label && !node.text) {
      return 'badge';
    }

    return 'text';
  }

  private classifyByRole(role?: string): ElementType | undefined {
    switch (role) {
      case 'alert':
      case 'status':
        return 'notification';
      case 'button':
      case 'switch':
      case 'checkbox':
      case 'radio':
        return 'button';
      case 'combobox':
      case 'listbox':
        return 'select';
      case 'dialog':
        return 'modal';
      case 'grid':
      case 'table':
        return 'table';
      case 'link':
        return 'link';
      case 'menu':
        return 'menu';
      case 'menuitem':
        return 'menu_item';
      case 'navigation':
        return 'navigation';
      case 'progressbar':
        return 'progress';
      case 'searchbox':
      case 'textbox':
        return 'input';
      case 'separator':
        return 'separator';
      case 'tablist':
        return 'tab_group';
      case 'tooltip':
        return 'tooltip';
      default:
        return undefined;
    }
  }

  private classifyByTag(tagName: string | undefined, attributes: Record<string, string>): ElementType | undefined {
    switch (tagName) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'a':
        return attributes.href ? 'link' : 'button';
      case 'button':
      case 'summary':
        return 'button';
      case 'input':
      case 'textarea':
        return attributes.type === 'submit' || attributes.type === 'button' ? 'button' : 'input';
      case 'select':
        return 'select';
      case 'form':
        return 'form';
      case 'table':
        return 'table';
      case 'ul':
      case 'ol':
        return 'list';
      case 'img':
      case 'svg':
      case 'canvas':
      case 'figure':
        return 'image';
      case 'nav':
        return 'navigation';
      case 'article':
      case 'main':
        return 'article';
      case 'iframe':
        return 'iframe';
      case 'video':
        return 'video';
      case 'dialog':
        return 'modal';
      case 'progress':
        return 'progress';
      case 'hr':
        return 'separator';
      default:
        return undefined;
    }
  }
}

function normalize(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}
