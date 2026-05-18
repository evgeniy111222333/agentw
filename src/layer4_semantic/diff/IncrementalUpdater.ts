import { SemanticSnapshot, SemanticElement } from '../../common/types';
import { globalEventBus } from '../../common/EventBus';
import { DOMTraverser } from '../traverser/DOMTraverser';
import { ElementClassifier } from '../classifier/ElementClassifier';
import { ContentExtractor } from '../extractor/ContentExtractor';
import { Page } from 'playwright';

export class IncrementalUpdater {
  private activeSnapshots: Map<string, SemanticSnapshot> = new Map();
  private pageMap: Map<string, Page> = new Map();
  private traverser: DOMTraverser;
  private classifier: ElementClassifier;
  private extractor: ContentExtractor;

  constructor(traverser: DOMTraverser, classifier: ElementClassifier, extractor: ContentExtractor) {
    this.traverser = traverser;
    this.classifier = classifier;
    this.extractor = extractor;
    this.setupSubscriptions();
  }

  private setupSubscriptions() {
    globalEventBus.subscribe('form_state_updated', this.handleFormStateUpdated.bind(this));
    globalEventBus.subscribe('dom_mutated', this.handleDomMutated.bind(this));
  }

  public registerSession(sessionId: string, page: Page, initialSnapshot: SemanticSnapshot) {
    this.activeSnapshots.set(sessionId, initialSnapshot);
    this.pageMap.set(sessionId, page);
  }

  public getSnapshot(sessionId: string): SemanticSnapshot | undefined {
    return this.activeSnapshots.get(sessionId);
  }

  public updateSnapshot(sessionId: string, snapshot: SemanticSnapshot) {
    this.activeSnapshots.set(sessionId, snapshot);
  }

  private async handleFormStateUpdated(payload: any) {
    const { session_id, data } = payload;
    const snapshot = this.activeSnapshots.get(session_id);
    if (!snapshot) return;

    const el = snapshot.elements.find(e => e.id === data.elementId);
    if (el) {
      if (data.type === 'checkbox' || data.type === 'radio') {
        el.value = data.value;
      } else {
        el.value = data.value;
      }
      snapshot.timestamp = new Date().toISOString();
      this.activeSnapshots.set(session_id, snapshot);
    }
  }

  private async handleDomMutated(payload: any) {
    const { session_id, mutations } = payload;
    const snapshot = this.activeSnapshots.get(session_id);
    const page = this.pageMap.get(session_id);
    if (!snapshot || !page) return;

    let modified = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        if (mutation.target && typeof mutation.target === 'string') {
          try {
             if (this.traverser.traverseNode) {
               const newNodes = await this.traverser.traverseNode(page, mutation.target);
               const newElements = newNodes.nodes.map(node => {
                  const type = this.classifier.classify(node);
                  const content = this.extractor.extract(node, type);
                  return {
                    id: node.id,
                    type,
                    role: node.role,
                    ...content,
                  } as SemanticElement;
               });
               
               snapshot.elements = snapshot.elements.filter(e => e.parent_id !== mutation.target);
               snapshot.elements.push(...newElements);
               modified = true;
             }
          } catch (e) {
          }
        }
      }
    }

    if (modified) {
       snapshot.timestamp = new Date().toISOString();
       this.activeSnapshots.set(session_id, snapshot);
    }
  }
}
