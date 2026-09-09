/**
 * Poornima Oracle - IndexedDB-backed multi-conversation store
 */
import { HISTORY_STORAGE_KEY } from '../config.js';

export class ConversationStore {
    constructor() {
        this.dbName = 'poornima-oracle-db';
        this.storeName = 'conversations';
        this.db = null;
        this._fallback = false;
    }

    async init() {
        try {
            this.db = await this._openDB();
        } catch (e) {
            console.warn('[Oracle] IndexedDB unavailable, using localStorage fallback:', e);
            this._fallback = true;
        }
    }

    _openDB() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                return reject(new Error('IndexedDB not supported'));
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const os = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    os.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    generateId() {
        return `conv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    }

    generateTitle(message) {
        if (!message) return 'New Chat';
        const maxLen = 45;
        const text = String(message).trim().replace(/\s+/g, ' ');
        if (text.length <= maxLen) return text;
        const truncated = text.substring(0, maxLen);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 15 ? truncated.substring(0, lastSpace) : truncated) + '\u2026';
    }

    async saveConversation(conv) {
        if (!conv || !conv.id) return;
        conv.updatedAt = Date.now();
        if (this._fallback || !this.db) {
            this._fbSave(conv);
            return;
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(conv);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async getConversation(id) {
        if (this._fallback || !this.db) {
            return this._fbLoad().find((c) => c.id === id) || null;
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).get(id);
            req.onsuccess = (e) => resolve(e.target.result || null);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async getAllConversations() {
        if (this._fallback || !this.db) {
            return this._fbLoad().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const req = tx.objectStore(this.storeName).index('updatedAt').getAll();
            req.onsuccess = (e) => resolve((e.target.result || []).reverse());
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async deleteConversation(id) {
        if (this._fallback || !this.db) {
            const all = this._fbLoad().filter((c) => c.id !== id);
            localStorage.setItem('poornimaOracleConversations', JSON.stringify(all));
            return;
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    _fbSave(conv) {
        const all = this._fbLoad();
        const idx = all.findIndex((c) => c.id === conv.id);
        if (idx >= 0) all[idx] = conv;
        else all.unshift(conv);
        localStorage.setItem('poornimaOracleConversations', JSON.stringify(all));
    }

    _fbLoad() {
        try {
            return JSON.parse(localStorage.getItem('poornimaOracleConversations') || '[]');
        } catch (e) {
            return [];
        }
    }
}

export async function migrateOldHistory(store) {
    if (typeof localStorage === 'undefined') return null;
    const oldData = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!oldData) return null;
    try {
        const messages = JSON.parse(oldData);
        if (!Array.isArray(messages) || messages.length === 0) {
            localStorage.removeItem(HISTORY_STORAGE_KEY);
            return null;
        }
        const firstUserMsg = messages.find((m) => m.role === 'user');
        const conv = {
            id: store.generateId(),
            title: store.generateTitle(firstUserMsg ? firstUserMsg.content : 'Previous Chat'),
            titled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages,
        };
        await store.saveConversation(conv);
        localStorage.removeItem(HISTORY_STORAGE_KEY);
        console.log('[Oracle] Migrated old history to IndexedDB.');
        return conv.id;
    } catch (e) {
        console.warn('[Oracle] Migration failed:', e);
        return null;
    }
}

export function saveConversationHistory(store, activeConversation) {
    if (!activeConversation || !store) return;
    store.saveConversation(activeConversation).catch((e) => console.warn('[Oracle] Save failed:', e));
}
