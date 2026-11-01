'use strict';
// Persistent state: spaces, groups, tabs (serializable parts), settings, notes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  autoSleepMinutes: 30,
  theme: 'dark',
  newTab: { wave: 'teal', animate: true, showShortcuts: false, shortcuts: [
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'Gmail', url: 'https://mail.google.com' },
  ] },
  mobileDevice: 'iphone-15-pro',
  mcp: { enabled: true, port: 9420, token: '' },
};

function defaultState() {
  const personal = { id: 'space_personal', name: 'Personal', icon: { type: 'letter', value: 'P' }, color: '#1fc7b6' };
  const work = { id: 'space_work', name: 'Work', icon: { type: 'symbol', value: 'briefcase' }, color: '#3b82f6' };
  const g1 = { id: uid('group'), spaceId: personal.id, name: 'Browse', icon: { type: 'letter', value: 'B' }, color: '#1fc7b6', activeTabId: null, split: null };
  const g2 = { id: uid('group'), spaceId: personal.id, name: 'Google', icon: { type: 'letter', value: 'G' }, color: '#64748b', activeTabId: null, split: null };
  const g3 = { id: uid('group'), spaceId: work.id, name: 'Main', icon: { type: 'letter', value: 'M' }, color: '#3b82f6', activeTabId: null, split: null };
  const t1 = { id: uid('tab'), groupId: g1.id, url: 'izi://newtab/', title: 'New tab', favicon: null, pinned: false };
  const t2 = { id: uid('tab'), groupId: g2.id, url: 'https://www.google.com/', title: 'Google', favicon: null, pinned: false };
  const t3 = { id: uid('tab'), groupId: g3.id, url: 'izi://newtab/', title: 'New tab', favicon: null, pinned: false };
  g1.activeTabId = t1.id; g2.activeTabId = t2.id; g3.activeTabId = t3.id;
  personal.activeGroupId = g1.id; work.activeGroupId = g3.id;
  return {
    version: 1,
    spaces: [personal, work],
    groups: [g1, g2, g3],
    tabs: [t1, t2, t3],
    activeSpaceId: personal.id,
    settings: structuredClone(DEFAULT_SETTINGS),
    notes: {},
  };
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], extra[k]) : extra[k];
  }
  return out;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'devspace-state.json');
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw.spaces?.length || !raw.groups) throw new Error('invalid');
      raw.settings = deepMerge(DEFAULT_SETTINGS, raw.settings || {});
      raw.notes = raw.notes || {};
      raw.tabs = raw.tabs || [];
      return raw;
    } catch {
      return defaultState();
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] save failed', err);
    }
  }
}

module.exports = { Store, uid, DEFAULT_SETTINGS };
