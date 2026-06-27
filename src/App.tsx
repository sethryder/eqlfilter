import { Component } from 'react'

// Ported 1:1 from the design prototype (EQL Filter.dc.html). The prototype built
// inline style *strings*; React wants style *objects*, so css() parses one into the
// other at the JSX boundary — this keeps all the dynamic style-builder logic intact.
function css(s: string): React.CSSProperties {
  const o: Record<string, string> = {}
  for (const part of s.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    let k = part.slice(0, i).trim()
    let v = part.slice(i + 1).trim()
    if (!k) continue
    // Font sizes ship as rem so they scale with the user's browser font setting.
    // px stays the authoring unit (the design spec is pixel-precise); only
    // font-size is converted, here at the one style boundary. 16px = 1rem.
    if (k === 'font-size') v = v.replace(/^([\d.]+)px$/, (_, n) => +(parseFloat(n) / 16).toFixed(5) + 'rem')
    if (!k.startsWith('--')) k = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    o[k] = v
  }
  return o as React.CSSProperties
}

// UTF-8-safe base64 for share links. (Replaces the old escape()/unescape() trick —
// those are deprecated globals.) Filter payloads are tiny, so the spread is fine.
function b64encode(s: string) { return btoa(String.fromCharCode(...new TextEncoder().encode(s))) }
function b64decode(b: string) { return new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))) }

// Arrow-key navigation for a radiogroup: move selection AND focus to the
// adjacent radio (wrapping). The radios must be the direct children of the
// element with role="radiogroup", which they are at every call site.
function onRadioKey(e: React.KeyboardEvent<HTMLButtonElement>, values: string[], idx: number, pick: (v: string) => void) {
  let next = idx
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % values.length
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + values.length) % values.length
  else return
  e.preventDefault()
  pick(values[next])
  ;(e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus()
}

// Fixed-height windowed list: only the rows in view (+overscan) are rendered, so a
// 3k-row list costs the same as a 30-row one — kills both the browser layout cost and
// React's per-row reconcile. Each row MUST be exactly rowH px tall (border-box makes
// padding/borders fit inside). resetKey scrolls back to top when it changes (new search).
// ponytail: fixed-height windowing; swap for a measuring lib only if rows go variable-height.
class VList extends Component<{
  rowH: number; count: number; resetKey?: string
  row: (i: number) => React.ReactNode
  className?: string; style?: React.CSSProperties
}, { top: number; vh: number }> {
  state = { top: 0, vh: 600 }
  el: HTMLDivElement | null = null
  ro?: ResizeObserver
  measure = () => { const e = this.el; if (e) this.setState({ top: e.scrollTop, vh: e.clientHeight }) }
  componentDidMount() {
    this.measure()
    // The footer is drag-resizable, so the list height changes without a scroll — re-measure on resize.
    if (this.el && 'ResizeObserver' in window) { this.ro = new ResizeObserver(this.measure); this.ro.observe(this.el) }
  }
  componentWillUnmount() { this.ro?.disconnect() }
  componentDidUpdate(prev: VList['props']) {
    if (prev.resetKey !== this.props.resetKey && this.el) { this.el.scrollTop = 0; this.measure() }
  }
  render() {
    const { rowH, count, row } = this.props
    const over = 6
    const top = Math.min(this.state.top, Math.max(0, count * rowH - this.state.vh)) // clamp so a shrunk list never blanks
    const start = Math.max(0, Math.floor(top / rowH) - over)
    const end = Math.min(count, Math.ceil((top + this.state.vh) / rowH) + over)
    const out: React.ReactNode[] = []
    for (let i = start; i < end; i++) out.push(row(i))
    return (
      <div ref={e => { this.el = e }} onScroll={this.measure} className={this.props.className} style={this.props.style}>
        <div style={{ height: count * rowH, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * rowH, left: 0, right: 0 }}>{out}</div>
        </div>
      </div>
    )
  }
}

type Rule = { name: string; action: string }
type Item = { id: string; name: string; type: string; slot: string; zones: string[]; flags: string[]; icon?: number }
type Saved = { id: string; name: string; rules: Rule[]; updated: number }

type Props = { skin?: string; density?: string }
type State = {
  name: string
  query: string
  cat: string
  zone: string
  rules: Rule[]
  panel: 'ini' | 'import' | 'share'
  importText: string
  copied: string
  ruleFilter: string
  addAction: string
  ioHeight: number
  ioMax: boolean
  mode: 'dark' | 'light' | null
  saved: Saved[]
  currentId: string | null
  menuOpen: boolean
  customItems: Item[]   // user-added items, merged into the catalog; persisted locally
  addOpen: boolean      // the "add item to library" form
  fName: string
  fType: string
  fZone: string
  fSlot: string
}

export default class App extends Component<Props, State> {
  catalog: Item[]
  actionKeys = ['Loot', 'Merge', 'Store', 'Sell']
  STORE_KEY = 'eqlfilter.saved.v1'
  DRAFT_KEY = 'eqlfilter.draft.v1'
  MODE_KEY = 'eqlfilter.mode.v1'
  _draftReady = false
  _lastDraft = ''
  _ct: ReturnType<typeof setTimeout> | undefined
  _onDocDown!: (e: MouseEvent) => void
  _onKey!: (e: KeyboardEvent) => void

  constructor(props: Props) {
    super(props)
    // Real items sourced from the EQL Wiki (eqlwiki.com) zone "Known Loot" tables.
    // Inline fallback so the builder always renders even if eql-items.json can't load.
    const raw: [string, string, string, string][] = [
      ['Gnoll Hide Lariat', 'Weapon', '1H Slash', 'Blackburrow'],
      ['Keg Mallet', 'Weapon', '1H Blunt', 'Blackburrow'],
      ['Runed Totem Staff', 'Weapon', '2H Blunt', 'Blackburrow'],
      ['Sabertooth Short Bow', 'Weapon', 'Range', 'Blackburrow'],
      ['Sharp Claws', 'Weapon', 'Hand to Hand', 'Blackburrow'],
      ['Wooden Totem', 'Weapon', 'Primary', 'Blackburrow'],
      ['Clay Totem', 'Weapon', 'Primary', 'Blackburrow'],
      ['Crude Arrow', 'Weapon', 'Ammo', 'Blackburrow'],
      ['Balanced Rat Tooth', 'Weapon', 'Ammo', 'Blackburrow'],
      ['Bark Splinted Shoulderpads', 'Armor', 'Shoulders', 'Blackburrow'],
      ['Dark Runed Leggings', 'Armor', 'Legs', 'Blackburrow'],
      ['Darkpaw Sash', 'Armor', 'Waist', 'Blackburrow'],
      ['Hardened Bark Breastplate', 'Armor', 'Chest', 'Blackburrow'],
      ['Ill-Fitting Robes', 'Armor', 'Chest', 'Blackburrow'],
      ['Ill-Fitting Slippers', 'Armor', 'Feet', 'Blackburrow'],
      ['Pub Pants', 'Armor', 'Legs', 'Blackburrow'],
      ['Raw-Hide Arm Guard', 'Armor', 'Wrist', 'Blackburrow'],
      ['Refugee Shroud', 'Armor', 'Shoulders', 'Blackburrow'],
      ['Runed Sabertooth Girdle', 'Armor', 'Waist', 'Blackburrow'],
      ['Runed Shawl', 'Armor', 'Shoulders', 'Blackburrow'],
      ['Rusty Spiked Shoulderpads', 'Armor', 'Shoulders', 'Blackburrow'],
      ["Sharpshooter's Bandana", 'Armor', 'Head', 'Blackburrow'],
      ["Vagrant's Tunic", 'Armor', 'Chest', 'Blackburrow'],
      ['Well Worn Boots', 'Armor', 'Feet', 'Blackburrow'],
      ['Wicked Sallet', 'Armor', 'Head', 'Blackburrow'],
      ['An Elven Charm Necklace', 'Jewelry', 'Neck', 'Blackburrow'],
      ['Elven Charm Necklace', 'Jewelry', 'Neck', 'Blackburrow'],
      ['Onyx Earring', 'Jewelry', 'Ear', 'Blackburrow'],
      ['Rat Paw Talisman', 'Jewelry', 'Neck', 'Blackburrow'],
      ['Spiked Collar', 'Jewelry', 'Neck', 'Blackburrow'],
      ['Studded Leather Collar', 'Jewelry', 'Neck', 'Blackburrow'],
      ['Burrowing Goggles', 'Jewelry', 'Face', 'Blackburrow'],
      ['Blackburrow Gnoll Pelt', 'Tradeskill', 'Pelt', 'Blackburrow'],
      ['Blackburrow Gnoll Skin', 'Tradeskill', 'Skin', 'Blackburrow'],
      ['Ruined Blackburrow Gnoll Pelt', 'Tradeskill', 'Pelt', 'Blackburrow'],
      ['Gnoll Fang', 'Tradeskill', 'Turn-in', 'Blackburrow'],
      ['Patch of Gnoll Fur', 'Tradeskill', 'Quest', 'Blackburrow'],
      ['Gnoll Pup Scalp', 'Tradeskill', 'Quest', 'Blackburrow'],
      ['Blackburrow Cask', 'Container', 'Container', 'Blackburrow'],
      ['Baby Joseph Sayer', 'Misc', 'Quest', 'Blackburrow'],
      ['Gnoll Head', 'Misc', 'Quest', 'Blackburrow'],
      ['Gnoll Pelvis', 'Misc', 'Quest', 'Blackburrow'],
    ]
    this.catalog = raw.map((r, i) => ({ id: 'i' + i, name: r[0], type: r[1], slot: r[2], zones: [r[3]], flags: [] }))
  }

  state: State = {
    name: 'My Loot Filter',
    query: '',
    cat: 'All',
    zone: 'All',
    rules: [
      { name: 'Rusty Battle Axe', action: 'Loot' },
      { name: 'Raw-hide Boots', action: 'Loot' },
      { name: 'Blackburrow Gnoll Pelt', action: 'Store' },
      { name: 'Onyx Earring', action: 'Sell' },
    ],
    panel: 'ini',
    importText: '',
    copied: '',
    ruleFilter: 'All',
    addAction: 'Loot',
    ioHeight: 140,
    ioMax: false,
    mode: null,
    saved: [],
    currentId: null,
    menuOpen: false,
    customItems: [],
    addOpen: false,
    fName: '',
    fType: 'Misc',
    fZone: '',
    fSlot: '',
  }

  // Replace the catalog with the generated item database (eql-items.json).
  setCatalog(list: any[]) {
    if (!Array.isArray(list) || !list.length) return
    this.catalog = list.map((c, i) => ({
      id: 'j' + i, name: c.name, type: c.type || 'Misc', slot: c.slot || '',
      // Accept the new zones[] shape or an older single zone string.
      zones: Array.isArray(c.zones) ? c.zones : (c.zone ? [c.zone] : []),
      flags: Array.isArray(c.flags) ? c.flags : [],
      icon: c.icon || 0,
    }))
    this.forceUpdate()
  }

  ITEMS_KEY = 'eqlfilter.items.v1'
  _idx?: { items: Item[]; byName: Map<string, Item>; zones: string[]; catRef: Item[]; custRef: Item[] }

  // Memoized view of the catalog: deduped list (custom first so a custom entry
  // overrides a catalog entry of the same name), a name→item index for findCat,
  // and the sorted zone list. Recomputed only when catalog or customItems are
  // replaced — both are swapped by reference, so identity is a free cache key.
  // Without this, render redid all of it (over ~3k items, findCat per rule) on
  // every keystroke.
  index() {
    if (!this._idx || this._idx.catRef !== this.catalog || this._idx.custRef !== this.state.customItems) {
      const seen = new Set<string>(), items: Item[] = []
      for (const it of this.state.customItems.concat(this.catalog)) {
        const k = it.name.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k); items.push(it)
      }
      const byName = new Map(items.map(it => [it.name.toLowerCase(), it]))
      const zones = Array.from(new Set(items.flatMap(c => c.zones))).filter(Boolean).sort()
      this._idx = { items, byName, zones, catRef: this.catalog, custRef: this.state.customItems }
    }
    return this._idx
  }
  allItems(): Item[] { return this.index().items }
  loadItems(): Item[] {
    try {
      const a = JSON.parse(localStorage.getItem(this.ITEMS_KEY) || '[]')
      if (!Array.isArray(a)) return []
      // Normalize older saved items that used a single zone string.
      return a.map((c: any) => ({ ...c, zones: Array.isArray(c.zones) ? c.zones : (c.zone ? [c.zone] : []) }))
    } catch (e) { return [] }
  }
  persistItems(items: Item[]) { try { localStorage.setItem(this.ITEMS_KEY, JSON.stringify(items)) } catch (e) {} }

  addLibraryItem() {
    const name = this.state.fName.trim()
    if (!name) return
    if (this.state.customItems.some(c => c.name.toLowerCase() === name.toLowerCase())) return
    const item: Item = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name, type: this.state.fType || 'Misc', slot: this.state.fSlot.trim(),
      zones: this.state.fZone.trim() ? [this.state.fZone.trim()] : [], flags: [],
    }
    this.setState(s => {
      const customItems = [item, ...s.customItems]
      this.persistItems(customItems)
      return { customItems, fName: '', fZone: '', fSlot: '' } // keep type + panel open for repeated adds
    })
  }
  removeLibraryItem(id: string) {
    this.setState(s => {
      const customItems = s.customItems.filter(c => c.id !== id)
      this.persistItems(customItems)
      return { customItems }
    })
  }

  loadSaved(): Saved[] {
    try {
      const raw = localStorage.getItem(this.STORE_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr : []
    } catch (e) { return [] }
  }
  persist(saved: Saved[]) {
    try { localStorage.setItem(this.STORE_KEY, JSON.stringify(saved)) } catch (e) {}
  }
  newId() { return 'flt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

  saveCurrent() {
    this.setState(s => {
      const entry = { name: s.name || 'Untitled Filter', rules: s.rules.map(r => ({ name: r.name, action: r.action })), updated: Date.now() }
      let saved = s.saved.slice()
      const idx = s.currentId ? saved.findIndex(f => f.id === s.currentId) : -1
      let id = s.currentId
      if (idx >= 0) {
        saved[idx] = { ...saved[idx], ...entry }
      } else {
        id = this.newId()
        saved = [{ id, ...entry }, ...saved]
      }
      this.persist(saved)
      return { saved, currentId: id, menuOpen: false }
    })
  }
  loadFilter(id: string) {
    const f = this.state.saved.find(x => x.id === id)
    if (!f) return
    this.setState({ name: f.name, rules: f.rules.map(r => ({ name: r.name, action: r.action })), currentId: id, menuOpen: false })
  }
  deleteFilter(id: string) {
    this.setState(s => {
      const saved = s.saved.filter(f => f.id !== id)
      this.persist(saved)
      return { saved, currentId: s.currentId === id ? null : s.currentId }
    })
  }
  newFilter() {
    this.setState({ name: 'New Filter', rules: [], currentId: null, menuOpen: false, query: '' })
  }
  toggleMenu() { this.setState(s => ({ menuOpen: !s.menuOpen })) }

  startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = this.state.ioHeight
    const MIN = 90, MAX = 620
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(MIN, Math.min(MAX, startH + (startY - ev.clientY)))
      this.setState({ ioHeight: h, ioMax: false })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  toggleIoMax() { this.setState(s => ({ ioMax: !s.ioMax })) }

  currentMode(): 'dark' | 'light' {
    if (this.state.mode) return this.state.mode
    return this.props.skin === 'Parchment' ? 'light' : 'dark'
  }
  toggleMode() {
    const next = this.currentMode() === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(this.MODE_KEY, next) } catch (e) {}
    this.setState({ mode: next })
  }

  componentDidMount() {
    this.setState({ saved: this.loadSaved(), customItems: this.loadItems() })
    try {
      const m = localStorage.getItem(this.MODE_KEY)
      if (m === 'dark' || m === 'light') this.setState({ mode: m })
    } catch (e) {}
    fetch('./eql-items.json')
      .then(r => (r.ok ? r.json() : null))
      .then(list => {
        if (list) this.setCatalog(list)
        // dev only: ?seed=3000 fills the filter with N real items to test long-list perf.
        const n = import.meta.env.DEV ? +(new URLSearchParams(location.search).get('seed') || 0) : 0
        if (n > 0) this.setState({ rules: this.allItems().slice(0, n).map(c => ({ name: c.name, action: 'Loot' })) })
      })
      .catch(() => {})

    // Priority: shared link > saved draft > defaults.
    let restored = false
    try {
      const m = (window.location.hash || '').match(/[#&]f=([^&]+)/)
      if (m) {
        const json = b64decode(decodeURIComponent(m[1]))
        const d = JSON.parse(json)
        this.setState({
          name: d.n || 'My Loot Filter',
          currentId: null,
          rules: (d.r || []).map((x: any) => ({ name: x.n, action: this.actionKeys.includes(x.a) ? x.a : 'Loot' })),
        })
        restored = true
      }
    } catch (e) {}
    if (!restored) {
      try {
        const d = JSON.parse(localStorage.getItem(this.DRAFT_KEY) || 'null')
        if (d && Array.isArray(d.rules)) {
          this.setState({
            name: d.name || 'My Loot Filter',
            currentId: d.currentId || null,
            rules: d.rules.map((x: any) => ({ name: x.name, action: this.actionKeys.includes(x.action) ? x.action : 'Loot' })),
          })
        }
      } catch (e) {}
    }

    this._onDocDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement
      if (this.state.menuOpen && !(t.closest && t.closest('[data-filter-menu]'))) {
        this.setState({ menuOpen: false })
      }
    }
    this._onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && this.state.menuOpen) this.setState({ menuOpen: false }) }
    document.addEventListener('mousedown', this._onDocDown)
    document.addEventListener('keydown', this._onKey)
    this._draftReady = true
  }

  persistDraft() {
    if (!this._draftReady) return
    try {
      const payload = JSON.stringify({ name: this.state.name, currentId: this.state.currentId, rules: this.state.rules })
      if (payload !== this._lastDraft) {
        this._lastDraft = payload
        localStorage.setItem(this.DRAFT_KEY, payload)
      }
    } catch (e) {}
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this._onDocDown)
    document.removeEventListener('keydown', this._onKey)
  }

  onSearchKey(e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return
    const q = this.state.query.trim()
    if (!q) return
    const items = this.allItems()
    const exact = items.find(c => c.name.toLowerCase() === q.toLowerCase())
    const first = items.find(c => this.matchesFilter(c) && !this.state.rules.some(r => r.name.toLowerCase() === c.name.toLowerCase()))
    this.addItem((exact || first || { name: q }).name)
  }

  themes(): Record<string, any> {
    return {
      'Command Deck': { bg: '#15171b', panel: '#1d2026', panel2: '#252932', border: '#343a44', text: '#e8e4da', muted: '#9b968c', accent: '#c9a45a', accentText: '#15171b', danger: '#d9694a', radius: '8px', fd: "'Cinzel', serif", fu: "'IBM Plex Sans', sans-serif", fm: "'IBM Plex Mono', monospace", aLoot: '#4fae6b', aMerge: '#a472cf', aStore: '#5b8dd9', aSell: '#d6a94a' },
      'Parchment': { bg: '#e3d7bd', panel: '#f1e8d4', panel2: '#e8ddc3', border: '#cabf9d', text: '#2f2920', muted: '#7a6e54', accent: '#7c5a2c', accentText: '#f1e8d4', danger: '#9c3f2b', radius: '6px', fd: "'Cinzel', serif", fu: "'IBM Plex Sans', sans-serif", fm: "'IBM Plex Mono', monospace", aLoot: '#3f7d4f', aMerge: '#7a4f9c', aStore: '#3f5f9c', aSell: '#9c6f2b' },
      'Terminal': { bg: '#0b0e0c', panel: '#11150f', panel2: '#161b14', border: '#27322a', text: '#cfe8d6', muted: '#6f8a78', accent: '#5fd08a', accentText: '#0b0e0c', danger: '#e87a6f', radius: '2px', fd: "'IBM Plex Mono', monospace", fu: "'IBM Plex Mono', monospace", fm: "'IBM Plex Mono', monospace", aLoot: '#5fd08a', aMerge: '#c08adf', aStore: '#6fb0e8', aSell: '#e8c46f' },
    }
  }

  typeColor(t: string): string {
    return ({ Weapon: '#c2603f', Armor: '#5b8dd9', Jewelry: '#a472cf', Tradeskill: '#c9a45a', Container: '#4f9e8f', Misc: '#8a8f98', Custom: '#7f8896' } as Record<string, string>)[t] || '#7f8896'
  }
  glyph(n: string) { return (n || '?').trim().charAt(0).toUpperCase() }
  findCat(n: string) { return this.index().byName.get((n || '').toLowerCase()) }

  matchesFilter(c: Item) {
    const q = this.state.query.trim().toLowerCase()
    return (this.state.cat === 'All' || c.type === this.state.cat) &&
      (this.state.zone === 'All' || c.zones.includes(this.state.zone)) &&
      (!q || c.name.toLowerCase().indexOf(q) >= 0)
  }

  addItem(n: string) {
    if (this.state.rules.some(r => r.name.toLowerCase() === n.toLowerCase())) return
    this.setState(s => ({ rules: [...s.rules, { name: n, action: s.addAction }] }))
  }
  removeItem(n: string) { this.setState(s => ({ rules: s.rules.filter(r => r.name !== n) })) }
  setAction(n: string, a: string) { this.setState(s => ({ rules: s.rules.map(r => r.name === n ? { name: r.name, action: a } : r) })) }
  clearAll() { this.setState({ rules: [] }) }

  addAllAs(action: string) {
    const matches = this.allItems().filter(c => this.matchesFilter(c))
    this.setState(s => {
      const map = new Map(s.rules.map(r => [r.name.toLowerCase(), { name: r.name, action: r.action }]))
      matches.forEach(c => { map.set(c.name.toLowerCase(), { name: c.name, action }) })
      return { rules: Array.from(map.values()) }
    })
  }

  buildIni() {
    const s = this.state
    let o = '; EverQuest Legends Loot Filter\n; Created with EQLFilter — eqlfilter.com\n; In-game: Advanced Loot > Filters, set each item to Loot / Merge / Store / Sell.\n\n[Filter]\nName=' + s.name + '\n\n[Rules]\n'
    s.rules.forEach(r => { o += r.name + '=' + r.action + '\n' })
    return o
  }
  parseIni(text: string) {
    const lines = (text || '').split(/\r?\n/)
    let name: string | null = null, section = ''
    const rules: Rule[] = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.charAt(0) === ';' || line.charAt(0) === '#') continue
      if (line.charAt(0) === '[') { section = line.replace(/[\[\]]/g, '').trim().toLowerCase(); continue }
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim()
      if (section === 'filter') {
        if (k.toLowerCase() === 'name') name = v
      } else if (section === 'rules') {
        const action = this.actionKeys.find(a => a.toLowerCase() === v.toLowerCase()) || 'Loot'
        rules.push({ name: k, action })
      }
    }
    return { name, rules }
  }
  doImport() {
    const p = this.parseIni(this.state.importText)
    this.setState(s => ({
      name: p.name || s.name,
      rules: p.rules.length ? p.rules : s.rules,
      panel: 'ini' as const,
      importText: '',
    }))
  }
  shareUrl() {
    try {
      const d = { n: this.state.name, r: this.state.rules.map(r => ({ n: r.name, a: r.action })) }
      const b = b64encode(JSON.stringify(d))
      const base = (window.location.href || '').split('#')[0]
      return base + '#f=' + encodeURIComponent(b)
    } catch (e) { return '' }
  }
  downloadIni() {
    const safe = (this.state.name || 'loot-filter').trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'loot-filter'
    const blob = new Blob([this.buildIni()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = safe + '.ini'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  copy(text: string, key: string) {
    try { navigator.clipboard.writeText(text) } catch (e) {}
    this.setState({ copied: key })
    clearTimeout(this._ct)
    this._ct = setTimeout(() => this.setState({ copied: '' }), 1600)
  }

  // Persist the working draft after each committed update — not during render,
  // which must stay side-effect free. The _lastDraft guard de-dupes writes.
  componentDidUpdate() {
    this.persistDraft()
  }

  render() {
    const T = this.themes()
    const mode = this.currentMode()
    const skinName = (this.props.skin === 'Terminal' && !this.state.mode) ? 'Terminal' : (mode === 'light' ? 'Parchment' : 'Command Deck')
    const th = T[skinName] || T['Command Deck']
    const rowpad = (this.props.density === 'Compact') ? '7px 18px' : '12px 18px'
    // Exact rule-row height — VList windows on it, so each row must be this tall (border-box).
    const rowH = (this.props.density === 'Compact') ? 46 : 56
    const rootStyle =
      '--bg:' + th.bg + ';--panel:' + th.panel + ';--panel2:' + th.panel2 + ';--border:' + th.border +
      ';--text:' + th.text + ';--muted:' + th.muted + ';--accent:' + th.accent + ';--accentText:' + th.accentText +
      ';--danger:' + th.danger + ';--radius:' + th.radius + ';--rowpad:' + rowpad +
      ';--font-display:' + th.fd + ';--font-ui:' + th.fu + ';--font-mono:' + th.fm +
      ';height:100vh;display:flex;flex-direction:column;overflow:hidden;background:' + th.bg + ';color:' + th.text + ';font-family:' + th.fu + ';'

    const dot = (c: string) => 'flex:none;width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-family:' + th.fm + ';font-weight:600;font-size:13px;color:#fff;background:' + c + ';box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12);'

    const taken = new Set(this.state.rules.map(r => r.name.toLowerCase()))
    const { items, zones } = this.index()
    const matching = items.filter(c => this.matchesFilter(c))
    const filtered = matching.filter(c => !taken.has(c.name.toLowerCase()))
    // One zone reads plainly; many would overflow the subtitle, so summarize as "N zones".
    const zoneLabel = (c: Item) => c.zones.length === 1 ? c.zones[0] : c.zones.length > 1 ? c.zones.length + ' zones' : ''
    const subOf = (c: Item) => [zoneLabel(c), c.slot].concat(c.flags || []).filter(Boolean).join(' · ')
    // Real item icon from the EQ Legends dragitem*.dds sheets (extracted to public/icons/,
    // see tools/extract-icons.mjs for the layout). Falls back to the lettered type dot.
    const iconBadge = (item: Item | undefined, type: string, name: string) => {
      const id = item?.icon || 0
      if (id < 500) return <span style={css(dot(this.typeColor(type)))}>{this.glyph(name)}</span>
      const rel = id - 500, sheet = Math.floor(rel / 36) + 1, cell = rel % 36
      const col = Math.floor(cell / 6), row = cell % 6
      return <span aria-hidden="true" style={{ flex: 'none', width: 30, height: 30, borderRadius: 7,
        backgroundImage: 'url(./icons/dragitem' + sheet + '.png)', backgroundRepeat: 'no-repeat',
        backgroundSize: '192px 192px', backgroundPosition: '-' + col * 30 + 'px -' + row * 30 + 'px' }} />
    }
    const q = this.state.query.trim().toLowerCase()
    const canAddCustom = q.length > 0 &&
      !items.some(c => c.name.toLowerCase() === q) &&
      !taken.has(q)

    const actionColors: Record<string, string> = { Loot: th.aLoot, Merge: th.aMerge, Store: th.aStore, Sell: th.aSell }
    const actBtn = (color: string, active: boolean) => active
      ? 'font-family:' + th.fu + ';font-size:11.5px;font-weight:600;letter-spacing:0.02em;padding:7px 0;border-radius:6px;cursor:pointer;border:1px solid ' + color + ';background:' + color + ';color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.25);'
      : 'font-family:' + th.fu + ';font-size:11.5px;font-weight:500;letter-spacing:0.02em;padding:7px 0;border-radius:6px;cursor:pointer;border:1px solid ' + th.border + ';background:transparent;color:' + th.muted + ';'

    const rf = this.state.ruleFilter
    const visibleRules = this.state.rules.filter(r => rf === 'All' || r.action === rf)

    const counts: Record<string, number> = { Loot: 0, Merge: 0, Store: 0, Sell: 0 }
    this.state.rules.forEach(r => { counts[r.action] = (counts[r.action] || 0) + 1 })
    const chipStyle = (active: boolean) => 'display:inline-flex;align-items:center;gap:6px;font-family:' + th.fu + ';font-size:11.5px;cursor:pointer;color:' + th.text + ';background:' + (active ? th.panel2 : 'transparent') + ';border:1px solid ' + (active ? th.accent : th.border) + ';border-radius:20px;padding:3px 10px;'
    const toggleRuleFilter = (k: string) => this.setState(s => ({ ruleFilter: s.ruleFilter === k ? 'All' : k }))
    const summary = this.actionKeys.map(k => ({
      key: k, label: k, count: counts[k], color: actionColors[k],
      active: this.state.ruleFilter === k,
      style: chipStyle(this.state.ruleFilter === k),
      onClick: () => toggleRuleFilter(k),
    }))
    const totalStyle = 'font-family:' + th.fu + ';font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid ' + th.border + ';color:' + th.muted + ';background:transparent;'

    const cats = ['All', 'Weapon', 'Armor', 'Jewelry', 'Tradeskill', 'Container', 'Misc']
    const catBtn = (active: boolean) => active
      ? 'font-family:' + th.fu + ';font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:20px;cursor:pointer;border:1px solid ' + th.accent + ';background:' + th.accent + ';color:' + th.accentText + ';'
      : 'font-family:' + th.fu + ';font-size:11.5px;font-weight:500;padding:5px 11px;border-radius:20px;cursor:pointer;border:1px solid ' + th.border + ';background:transparent;color:' + th.muted + ';'
    const categories = cats.map(c => ({ key: c, active: this.state.cat === c, style: catBtn(this.state.cat === c), onClick: () => this.setState({ cat: c }) }))

    const zoneOptions = [{ value: 'All', label: 'All Zones' }].concat(zones.map(z => ({ value: z, label: z })))

    const bulkBtn = (color: string) => 'font-family:' + th.fu + ';font-size:11px;font-weight:600;flex:1;padding:5px 0;border-radius:6px;cursor:pointer;border:1px solid ' + color + ';background:transparent;color:' + color + ';'
    const bulkActions = this.actionKeys.map(k => ({ key: k, label: k, style: bulkBtn(actionColors[k]), onClick: () => this.addAllAs(k) }))

    const addAsBtn = (color: string, active: boolean) => active
      ? 'font-family:' + th.fu + ';font-size:11px;font-weight:600;flex:1;padding:5px 0;border-radius:6px;cursor:pointer;border:1px solid ' + color + ';background:' + color + ';color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.25);'
      : 'font-family:' + th.fu + ';font-size:11px;font-weight:500;flex:1;padding:5px 0;border-radius:6px;cursor:pointer;border:1px solid ' + th.border + ';background:transparent;color:' + th.muted + ';'
    const addAsActions = this.actionKeys.map(k => ({ key: k, label: k, active: this.state.addAction === k, style: addAsBtn(actionColors[k], this.state.addAction === k), onClick: () => this.setState({ addAction: k }) }))

    const tabDefs: [State['panel'], string][] = [['ini', 'INI Export'], ['import', 'Import'], ['share', 'Share Link']]
    const tabBtn = (active: boolean) => 'font-family:' + th.fu + ';font-size:13px;font-weight:' + (active ? '600' : '500') + ';padding:13px 18px;cursor:pointer;background:transparent;border:none;border-bottom:2px solid ' + (active ? th.accent : 'transparent') + ';color:' + (active ? th.text : th.muted) + ';'
    const tabs = tabDefs.map(t => ({ key: t[0], label: t[1], style: tabBtn(this.state.panel === t[0]), onClick: () => this.setState({ panel: t[0] }) }))

    const fmtAgo = (ts: number) => {
      const d = Math.max(0, Date.now() - ts), m = 60000, h = 3600000, day = 86400000
      if (d < m) return 'just now'
      if (d < h) return Math.floor(d / m) + 'm ago'
      if (d < day) return Math.floor(d / h) + 'h ago'
      return Math.floor(d / day) + 'd ago'
    }
    const cur = this.state.currentId ? this.state.saved.find(f => f.id === this.state.currentId) : null
    const sameRules = (a: Rule[], b: Rule[]) => a.length === b.length && a.every((r, i) => b[i] && b[i].name === r.name && b[i].action === r.action)
    const dirty = !cur || cur.name !== this.state.name || !sameRules(this.state.rules, cur.rules)
    const rowBase = 'display:flex; align-items:center; gap:8px; padding:8px 9px; border-radius:7px; margin-bottom:2px;'
    const savedList = this.state.saved.map(f => ({
      id: f.id, name: f.name,
      meta: (f.rules ? f.rules.length : 0) + ' items · ' + fmtAgo(f.updated),
      isCurrent: f.id === this.state.currentId,
      rowStyle: rowBase + (f.id === this.state.currentId ? 'background:' + th.panel2 + ';' : ''),
      load: () => this.loadFilter(f.id),
      remove: () => this.deleteFilter(f.id),
    }))

    const addBadgeStyle = 'flex:none;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:' + actionColors[this.state.addAction] + ';border:1px solid ' + actionColors[this.state.addAction] + ';border-radius:5px;padding:3px 7px;opacity:0.95;'
    const ioHeightPx = (this.state.ioMax ? 560 : this.state.ioHeight) + 'px'
    const taStyle = 'width:100%; height:' + ioHeightPx + '; resize:none; font-family:' + th.fm + '; font-size:12.5px; line-height:1.55; color:' + th.text + '; background:' + th.bg + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:12px 14px;'
    const year = new Date().getFullYear()
    const projects = [{ label: 'EQNTA', title: 'Norrath Transit Authority', href: 'https://eqnta.com' }]
    const fieldStyle = 'font-family:' + th.fu + '; font-size:13px; color:' + th.text + '; background:' + th.panel2 + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:8px 11px;'
    const canAddLib = this.state.fName.trim().length > 0

    return (
      <div style={css(rootStyle)}>
        {/* Descriptive copy for crawlers / AI search — visually hidden, the UI speaks for itself. */}
        <p className="sr-only">EQLFilter is a free loot filter builder for EverQuest Legends (EQL). Search the in-game item catalog and assign Loot, Merge, Store, or Sell to each item, then export your filter as an INI file or a shareable link — no account, runs entirely in your browser.</p>
        {/* HEADER */}
        <header style={css('display:flex; align-items:center; gap:18px; padding:14px 22px; border-bottom:1px solid ' + th.border + '; background:' + th.panel + '; flex:none;')}>
          <div style={css('display:flex; align-items:center; gap:12px;')}>
            <div style={css('width:30px; height:30px; transform:rotate(45deg); border:2px solid ' + th.accent + '; background:linear-gradient(135deg, ' + th.accent + ' 0%, transparent 60%); border-radius:5px;')}></div>
            <div style={css('display:flex; flex-direction:column; line-height:1;')}>
              <div style={css('display:flex; align-items:center; gap:9px;')}>
                <h1 style={css('margin:0; font-family:' + th.fd + '; font-weight:700; font-size:20px; letter-spacing:0.06em; color:' + th.text + ';')}>EQL&nbsp;FILTER</h1>
                <span title="Item data and INI format are still being finalized" style={css('font-family:' + th.fu + '; font-size:9px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:' + th.accent + '; border:1px solid ' + th.accent + '; border-radius:4px; padding:2px 6px; line-height:1;')}>Beta</span>
              </div>
              <div style={css('font-family:' + th.fu + '; font-size:10px; letter-spacing:0.22em; text-transform:uppercase; color:' + th.muted + '; margin-top:4px;')}>EverQuest Legends · Loot Filter Builder</div>
            </div>
          </div>

          <div style={css('flex:1;')}></div>

          <div data-filter-menu="1" style={css('position:relative; display:flex; align-items:center; gap:8px;')}>
            <span style={css('font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:' + th.muted + ';')}>Filter</span>
            <input className="eqi" value={this.state.name} onChange={e => this.setState({ name: e.target.value })} placeholder="Filter name"
              style={css('font-family:' + th.fu + '; font-size:14px; font-weight:500; color:' + th.text + '; background:' + th.panel2 + '; border-top:1px solid ' + th.border + '; border-bottom:1px solid ' + th.border + '; border-left:1px solid ' + th.border + '; border-right:none; border-radius:' + th.radius + ' 0 0 ' + th.radius + '; padding:9px 13px; width:200px;')} />
            <button onClick={() => this.toggleMenu()} title="Saved filters"
              style={css('display:flex; align-items:center; gap:6px; font-family:' + th.fm + '; font-size:12px; color:' + th.muted + '; background:' + th.panel2 + '; border-top:1px solid ' + th.border + '; border-bottom:1px solid ' + th.border + '; border-right:1px solid ' + th.border + '; border-left:none; border-radius:0 ' + th.radius + ' ' + th.radius + ' 0; padding:9px 11px; cursor:pointer; height:38px; margin-left:-8px;')}>
              <span>{this.state.saved.length}</span>
              <span style={css('font-size:9px;')}>▾</span>
            </button>

            {this.state.menuOpen && (
              <div style={css('position:absolute; top:46px; right:0; width:300px; background:' + th.panel + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; box-shadow:0 18px 50px rgba(0,0,0,0.5); z-index:50; overflow:hidden;')}>
                <div style={css('padding:11px 14px; border-bottom:1px solid ' + th.border + '; display:flex; align-items:center; justify-content:space-between;')}>
                  <span style={css('font-family:' + th.fu + '; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:' + th.muted + ';')}>Saved Filters</span>
                  <span style={css('font-family:' + th.fm + '; font-size:11px; color:' + th.muted + ';')}>{this.state.saved.length} saved</span>
                </div>
                <div className="eqs" style={css('max-height:280px; overflow-y:auto; padding:6px;')}>
                  {savedList.map(f => (
                    <div key={f.id} style={css(f.rowStyle)}>
                      <button onClick={f.load} style={css('flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:left; background:transparent; border:none; cursor:pointer; padding:0;')}>
                        <span style={css('font-family:' + th.fu + '; font-size:13.5px; color:' + th.text + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{f.name}</span>
                        <span style={css('font-family:' + th.fu + '; font-size:10.5px; color:' + th.muted + ';')}>{f.meta}</span>
                      </button>
                      {f.isCurrent && (
                        <span style={css('font-size:9px; font-weight:700; letter-spacing:0.08em; color:' + th.accentText + '; background:' + th.accent + '; border-radius:4px; padding:3px 6px; white-space:nowrap;')}>CURRENT</span>
                      )}
                      <button className="eq-del" onClick={f.remove} title="Delete" style={css('flex:none; width:26px; height:26px; border-radius:5px; cursor:pointer; font-size:13px;')}>×</button>
                    </div>
                  ))}
                  {this.state.saved.length === 0 && (
                    <div style={css('text-align:center; padding:18px 12px; color:' + th.muted + '; font-size:12.5px; font-family:' + th.fu + ';')}>No saved filters yet. Hit <strong style={css('color:' + th.text + ';')}>Save</strong> to keep this one.</div>
                  )}
                </div>
                <div style={css('padding:9px; border-top:1px solid ' + th.border + '; display:flex; gap:7px;')}>
                  <button onClick={() => this.saveCurrent()} style={css('flex:1; font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.accentText + '; background:' + th.accent + '; border:none; border-radius:6px; padding:8px 0; cursor:pointer;')}>{cur ? (dirty ? 'Save changes' : 'Saved ✓') : 'Save filter'}</button>
                  <button onClick={() => this.newFilter()} style={css('flex:1; font-family:' + th.fu + '; font-size:12.5px; font-weight:500; color:' + th.text + '; background:transparent; border:1px solid ' + th.border + '; border-radius:6px; padding:8px 0; cursor:pointer;')}>New filter</button>
                </div>
              </div>
            )}
          </div>

          <button onClick={() => this.toggleMode()} title={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            style={css('display:flex; align-items:center; justify-content:center; width:38px; height:38px; font-size:16px; line-height:1; color:' + th.text + '; background:' + th.panel2 + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; cursor:pointer;')}>{mode === 'light' ? '☾' : '☀'}</button>

          <button onClick={() => this.clearAll()} style={css('font-family:' + th.fu + '; font-size:13px; font-weight:500; color:' + th.muted + '; background:transparent; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:9px 14px; cursor:pointer;')}>Clear items</button>
        </header>

        {/* MAIN */}
        <main style={css('flex:1; min-height:0; display:grid; grid-template-columns:380px 1fr; gap:18px; padding:18px 22px;')}>
          {/* LIBRARY */}
          <section style={css('display:flex; flex-direction:column; min-height:0; background:' + th.panel + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + ';')}>
            <div style={css('padding:14px 16px 12px; border-bottom:1px solid ' + th.border + ';')}>
              <div style={css('display:flex; align-items:center; justify-content:space-between; margin-bottom:11px;')}>
                <h2 style={css('margin:0; font-family:' + th.fd + '; font-weight:600; font-size:15px; letter-spacing:0.05em; color:' + th.text + ';')}>Item Library</h2>
                <span style={css('font-family:' + th.fm + '; font-size:11px; color:' + th.muted + ';')}>{filtered.length} items</span>
              </div>
              <input className="eqi" value={this.state.query} onChange={e => this.setState({ query: e.target.value })} onKeyDown={e => this.onSearchKey(e)} placeholder="Search items…"
                style={css('width:100%; font-family:' + th.fu + '; font-size:14px; color:' + th.text + '; background:' + th.panel2 + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:10px 13px;')} />
              <select value={this.state.zone} onChange={e => this.setState({ zone: e.target.value })} className="eqi"
                style={css('width:100%; margin-top:9px; font-family:' + th.fu + '; font-size:13px; color:' + th.text + '; background:' + th.panel2 + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:9px 12px; cursor:pointer;')}>
                {zoneOptions.map(z => <option key={z.value} value={z.value} style={{ color: '#15171b' }}>{z.label}</option>)}
              </select>
              <div role="radiogroup" aria-label="Filter library by category" style={css('display:flex; flex-wrap:wrap; gap:6px; margin-top:11px;')}>
                {categories.map((c, i) => (
                  <button key={c.key} role="radio" aria-checked={c.active} tabIndex={c.active ? 0 : -1}
                    onClick={c.onClick} onKeyDown={e => onRadioKey(e, cats, i, v => this.setState({ cat: v }))}
                    style={css(c.style)}>{c.key}</button>
                ))}
              </div>
              <div style={css('display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid ' + th.border + ';')}>
                <span style={css('font-size:10.5px; letter-spacing:0.1em; text-transform:uppercase; color:' + th.muted + '; white-space:nowrap;')}>New items add as →</span>
                <div role="radiogroup" aria-label="Action for newly added items" style={css('display:flex; gap:5px; flex:1;')}>
                  {addAsActions.map((a, i) => (
                    <button key={a.key} role="radio" aria-checked={a.active} tabIndex={a.active ? 0 : -1}
                      onClick={a.onClick} onKeyDown={e => onRadioKey(e, this.actionKeys, i, v => this.setState({ addAction: v }))}
                      style={css(a.style)}>{a.label}</button>
                  ))}
                </div>
              </div>
              <div style={css('display:flex; align-items:center; gap:8px; margin-top:9px;')}>
                <span style={css('font-size:10.5px; letter-spacing:0.1em; text-transform:uppercase; color:' + th.muted + '; white-space:nowrap;')}>Apply to all {matching.length} →</span>
                <div style={css('display:flex; gap:5px; flex:1;')}>
                  {bulkActions.map(b => <button key={b.key} onClick={b.onClick} style={css(b.style)}>{b.label}</button>)}
                </div>
              </div>

              {/* Add a missing item to the local library — persists + merges into the catalog */}
              <div style={css('margin-top:12px; padding-top:12px; border-top:1px solid ' + th.border + ';')}>
                <button onClick={() => this.setState(s => ({ addOpen: !s.addOpen }))} aria-expanded={this.state.addOpen}
                  style={css('display:flex; align-items:center; gap:7px; width:100%; font-family:' + th.fu + '; font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:' + th.muted + '; background:transparent; border:none; padding:0; cursor:pointer;')}>
                  <span style={css('font-size:13px; line-height:1;')}>{this.state.addOpen ? '−' : '+'}</span>
                  <span>Add item to library</span>
                  {this.state.customItems.length > 0 && <span style={css('font-family:' + th.fm + '; letter-spacing:0; text-transform:none; color:' + th.muted + ';')}>· {this.state.customItems.length} custom</span>}
                </button>

                {this.state.addOpen && (
                  <div style={css('margin-top:10px; display:flex; flex-direction:column; gap:8px;')}>
                    <input className="eqi" value={this.state.fName} onChange={e => this.setState({ fName: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') this.addLibraryItem() }} placeholder="Item name" aria-label="New item name" style={css(fieldStyle)} />
                    <div style={css('display:flex; gap:8px;')}>
                      <select className="eqi" value={this.state.fType} onChange={e => this.setState({ fType: e.target.value })} aria-label="Item type" style={css(fieldStyle + 'flex:1; min-width:0; cursor:pointer;')}>
                        {['Weapon', 'Armor', 'Jewelry', 'Tradeskill', 'Container', 'Misc'].map(t => <option key={t} value={t} style={{ color: '#15171b' }}>{t}</option>)}
                      </select>
                      <input className="eqi" value={this.state.fZone} onChange={e => this.setState({ fZone: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') this.addLibraryItem() }} placeholder="Zone (optional)" aria-label="Item zone" style={css(fieldStyle + 'flex:1; min-width:0;')} />
                    </div>
                    <div style={css('display:flex; gap:8px;')}>
                      <input className="eqi" value={this.state.fSlot} onChange={e => this.setState({ fSlot: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') this.addLibraryItem() }} placeholder="Slot (optional)" aria-label="Item slot" style={css(fieldStyle + 'flex:1; min-width:0;')} />
                      <button onClick={() => this.addLibraryItem()} disabled={!canAddLib}
                        style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.accentText + '; background:' + th.accent + '; border:none; border-radius:6px; padding:8px 16px; cursor:' + (canAddLib ? 'pointer' : 'not-allowed') + '; white-space:nowrap;' + (canAddLib ? '' : 'opacity:0.5;'))}>Add to library</button>
                    </div>
                    {this.state.customItems.length > 0 && (
                      <div className="eqs" style={css('margin-top:2px; display:flex; flex-direction:column; gap:3px; max-height:120px; overflow-y:auto;')}>
                        {this.state.customItems.map(ci => (
                          <div key={ci.id} style={css('display:flex; align-items:center; gap:8px; padding:2px 0;')}>
                            <span style={css('flex:1; min-width:0; font-family:' + th.fu + '; font-size:12px; color:' + th.text + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{ci.name} <span style={css('color:' + th.muted + ';')}>· {ci.type}{ci.zones.length ? ' · ' + ci.zones[0] : ''}</span></span>
                            <button className="eq-del" onClick={() => this.removeLibraryItem(ci.id)} title={'Remove ' + ci.name} aria-label={'Remove ' + ci.name} style={css('flex:none; width:22px; height:22px; border-radius:5px; cursor:pointer; font-size:12px; line-height:1;')}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div style={css('flex:1; min-height:0; display:flex; flex-direction:column; padding:8px;')}>
              {canAddCustom && (
                <button onClick={() => this.addItem(this.state.query.trim())} style={css('flex:none; width:100%; display:flex; align-items:center; gap:10px; text-align:left; background:transparent; border:1px dashed ' + th.accent + '; border-radius:' + th.radius + '; padding:10px 12px; margin-bottom:6px; cursor:pointer; color:' + th.accent + '; font-family:' + th.fu + '; font-size:13px;')}>
                  <span style={css('font-size:15px; line-height:1;')}>+</span>
                  <span>Add custom item “<strong>{this.state.query}</strong>”</span>
                </button>
              )}
              {filtered.length === 0 && !canAddCustom && (
                <div style={css('text-align:center; padding:30px 16px; color:' + th.muted + '; font-size:13px; font-family:' + th.fu + ';')}>No matching items.</div>
              )}
              {filtered.length > 0 && (
                <VList className="eqs" rowH={50} count={filtered.length} resetKey={q + '|' + this.state.zone + '|' + this.state.cat}
                  style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
                  row={i => {
                    const c = filtered[i]
                    return (
                      <button key={c.id} className="eq-res" onClick={() => this.addItem(c.name)} style={css('width:100%; height:50px; display:flex; align-items:center; gap:11px; text-align:left; border-radius:' + th.radius + '; padding:8px 10px; cursor:pointer;')}>
                        {iconBadge(c, c.type, c.name)}
                        <span style={css('flex:1; min-width:0; display:flex; flex-direction:column; gap:2px;')}>
                          <span style={css('font-family:' + th.fu + '; font-size:13.5px; color:' + th.text + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{c.name}</span>
                          <span style={css('font-family:' + th.fu + '; font-size:10.5px; letter-spacing:0.04em; color:' + th.muted + ';')}>{subOf(c)}</span>
                        </span>
                        <span style={css(addBadgeStyle)}>+ {this.state.addAction}</span>
                      </button>
                    )
                  }} />
              )}
            </div>
          </section>

          {/* FILTER */}
          <section style={css('display:flex; flex-direction:column; min-height:0; background:' + th.panel + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + ';')}>
            <div style={css('padding:14px 18px; border-bottom:1px solid ' + th.border + '; display:flex; align-items:center; gap:14px;')}>
              <h2 style={css('margin:0; font-family:' + th.fd + '; font-weight:600; font-size:15px; letter-spacing:0.05em; color:' + th.text + ';')}>Your Filter</h2>
              <div style={css('display:flex; gap:7px; flex-wrap:wrap;')}>
                {summary.map(s => (
                  <button key={s.key} aria-pressed={s.active} aria-label={'Show only ' + s.label + ' rules'} onClick={s.onClick} style={css(s.style)}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, display: 'inline-block' }}></span>
                    {s.label} <strong style={css('font-family:' + th.fm + ';')}>{s.count}</strong>
                  </button>
                ))}
              </div>
              <div style={css('flex:1;')}></div>
              <span style={css(totalStyle)}>{this.state.rules.length} rules</span>
            </div>

            <div style={css('display:grid; grid-template-columns:1fr 280px 34px; gap:12px; padding:9px 18px; border-bottom:1px solid ' + th.border + '; background:' + th.panel2 + ';')}>
              <span style={css('font-size:10.5px; letter-spacing:0.14em; text-transform:uppercase; color:' + th.muted + ';')}>Item</span>
              <span style={css('font-size:10.5px; letter-spacing:0.14em; text-transform:uppercase; color:' + th.muted + '; text-align:center;')}>Action</span>
              <span></span>
            </div>

            <div style={css('flex:1; min-height:0; display:flex; flex-direction:column;')}>
              {this.state.rules.length === 0 && (
                <div style={css('flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:40px; text-align:center;')}>
                  <div style={css('width:46px; height:46px; transform:rotate(45deg); border:2px dashed ' + th.border + '; border-radius:6px;')}></div>
                  <div style={css('font-family:' + th.fd + '; font-size:16px; color:' + th.text + ';')}>No items yet</div>
                  <div style={css('font-family:' + th.fu + '; font-size:13px; color:' + th.muted + '; max-width:320px;')}>Search the library on the left and add items one at a time, or use <strong style={css('color:' + th.text + ';')}>Apply to all</strong> to set an action for a whole category at once.</div>
                </div>
              )}
              {this.state.rules.length > 0 && visibleRules.length === 0 && (
                <div style={css('display:flex; align-items:center; justify-content:center; gap:10px; padding:34px; text-align:center; font-family:' + th.fu + '; font-size:13px; color:' + th.muted + ';')}>
                  <span>No <strong style={css('color:' + th.text + ';')}>{rf}</strong> rules.</span>
                  <button onClick={() => this.setState({ ruleFilter: 'All' })} style={css('font-family:' + th.fu + '; font-size:12px; font-weight:600; color:' + th.accent + '; background:transparent; border:1px solid ' + th.border + '; border-radius:6px; padding:5px 11px; cursor:pointer;')}>Show all</button>
                </div>
              )}
              {visibleRules.length > 0 && (
                <VList className="eqs" rowH={rowH} count={visibleRules.length} resetKey={rf}
                  style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
                  row={i => {
                    const r = visibleRules[i]
                    const cat = this.findCat(r.name)
                    const type = cat ? cat.type : 'Custom'
                    return (
                      <div key={r.name} style={css('display:grid; grid-template-columns:1fr 280px 34px; gap:12px; align-items:center; height:' + rowH + 'px; padding:' + rowpad + '; border-bottom:1px solid ' + th.border + ';')}>
                        <div style={css('display:flex; align-items:center; gap:11px; min-width:0;')}>
                          {iconBadge(cat, type, r.name)}
                          <span style={css('display:flex; flex-direction:column; gap:2px; min-width:0;')}>
                            <span style={css('font-family:' + th.fu + '; font-size:14px; color:' + th.text + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{r.name}</span>
                            <span style={css('font-family:' + th.fu + '; font-size:10.5px; letter-spacing:0.04em; color:' + th.muted + ';')}>{cat ? subOf(cat) : 'Custom item'}</span>
                          </span>
                        </div>
                        <div role="radiogroup" aria-label={'Action for ' + r.name} style={css('display:grid; grid-template-columns:repeat(4,1fr); gap:5px;')}>
                          {this.actionKeys.map((k, ai) => (
                            <button key={k} role="radio" aria-checked={r.action === k} tabIndex={r.action === k ? 0 : -1}
                              onClick={() => this.setAction(r.name, k)} onKeyDown={e => onRadioKey(e, this.actionKeys, ai, v => this.setAction(r.name, v))}
                              style={css(actBtn(actionColors[k], r.action === k))}>{k}</button>
                          ))}
                        </div>
                        <button className="eq-del" onClick={() => this.removeItem(r.name)} title="Remove" style={css('width:30px; height:30px; border-radius:6px; cursor:pointer; font-size:15px; line-height:1;')}>×</button>
                      </div>
                    )
                  }} />
              )}
            </div>
          </section>
        </main>

        {/* IO FOOTER */}
        <footer style={css('flex:none; border-top:1px solid ' + th.border + '; background:' + th.panel + ';')}>
          <div onMouseDown={e => this.startResize(e)} title="Drag to resize" style={css('height:9px; cursor:ns-resize; display:flex; align-items:center; justify-content:center; background:' + th.panel2 + '; border-bottom:1px solid ' + th.border + ';')}>
            <div style={css('width:42px; height:3px; border-radius:3px; background:' + th.border + ';')}></div>
          </div>
          <div style={css('display:flex; align-items:stretch; gap:0; padding:0 22px; border-bottom:1px solid ' + th.border + ';')}>
            {tabs.map(t => <button key={t.key} onClick={t.onClick} style={css(t.style)}>{t.label}</button>)}
            <div style={css('flex:1;')}></div>
            <button onClick={() => this.toggleIoMax()} title={this.state.ioMax ? 'Collapse panel' : 'Expand panel'} style={css('display:flex; align-items:center; gap:7px; font-family:' + th.fu + '; font-size:12px; font-weight:500; color:' + th.muted + '; background:transparent; border:none; padding:0 4px; cursor:pointer;')}>
              <span style={css('font-size:13px; line-height:1;')}>{this.state.ioMax ? '⤓' : '⤢'}</span><span>{this.state.ioMax ? 'Collapse' : 'Expand'}</span>
            </button>
          </div>

          <div style={css('padding:14px 22px 18px;')}>
            {this.state.panel === 'ini' && (
              <div style={css('display:flex; gap:16px; align-items:flex-start;')}>
                <div style={css('flex:1; min-width:0;')}>
                  <div style={css('display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;')}>
                    <span style={css('font-family:' + th.fu + '; font-size:12px; letter-spacing:0.1em; text-transform:uppercase; color:' + th.muted + ';')}>filter.ini · placeholder format</span>
                    <div style={css('display:flex; gap:8px;')}>
                      <button onClick={() => this.downloadIni()} style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.text + '; background:transparent; border:1px solid ' + th.border + '; border-radius:6px; padding:7px 16px; cursor:pointer;')}>Download .ini</button>
                      <button onClick={() => this.copy(this.buildIni(), 'ini')} style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.accentText + '; background:' + th.accent + '; border:none; border-radius:6px; padding:7px 16px; cursor:pointer;')}>{this.state.copied === 'ini' ? 'Copied!' : 'Copy INI'}</button>
                    </div>
                  </div>
                  <textarea className="eqs" readOnly value={this.buildIni()} style={css(taStyle)}></textarea>
                </div>
              </div>
            )}
            {this.state.panel === 'import' && (
              <div>
                <div style={css('display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;')}>
                  <span style={css('font-family:' + th.fu + '; font-size:12px; letter-spacing:0.1em; text-transform:uppercase; color:' + th.muted + ';')}>Choose a .ini file or paste one below</span>
                  <div style={css('display:flex; gap:8px;')}>
                    <label style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.text + '; background:transparent; border:1px solid ' + th.border + '; border-radius:6px; padding:7px 16px; cursor:pointer;')}>
                      Choose file…
                      <input type="file" accept=".ini,.txt" style={{ display: 'none' }}
                        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) f.text().then(t => this.setState({ importText: t }, () => this.doImport())) }} />
                    </label>
                    <button onClick={() => this.doImport()} style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.accentText + '; background:' + th.accent + '; border:none; border-radius:6px; padding:7px 16px; cursor:pointer;')}>Load filter</button>
                  </div>
                </div>
                <textarea className="eqs eqi" value={this.state.importText} onChange={e => this.setState({ importText: e.target.value })}
                  placeholder={'[Filter]\nName=My Loot Filter\n\n[Rules]\nGnoll Fang=Sell\nBlackburrow Gnoll Pelt=Store'} style={css(taStyle)}></textarea>
              </div>
            )}
            {this.state.panel === 'share' && (
              <div>
                <div style={css('font-family:' + th.fu + '; font-size:12px; letter-spacing:0.1em; text-transform:uppercase; color:' + th.muted + '; margin-bottom:8px;')}>Anyone with this link gets your exact filter loaded</div>
                <div style={css('display:flex; gap:10px;')}>
                  <input className="eqi" readOnly value={this.shareUrl()} style={css('flex:1; min-width:0; font-family:' + th.fm + '; font-size:12.5px; color:' + th.text + '; background:' + th.bg + '; border:1px solid ' + th.border + '; border-radius:' + th.radius + '; padding:11px 14px;')} />
                  <button onClick={() => this.copy(this.shareUrl(), 'share')} style={css('font-family:' + th.fu + '; font-size:12.5px; font-weight:600; color:' + th.accentText + '; background:' + th.accent + '; border:none; border-radius:6px; padding:0 20px; cursor:pointer; white-space:nowrap;')}>{this.state.copied === 'share' ? 'Copied!' : 'Copy link'}</button>
                </div>
              </div>
            )}
          </div>
        </footer>

        {/* SITE FOOTER */}
        <div style={css('flex:none; display:flex; align-items:center; gap:18px; flex-wrap:wrap; padding:11px 22px; border-top:1px solid ' + th.border + '; background:' + th.bg + ';')}>
          <span style={css('font-family:' + th.fu + '; font-size:11.5px; color:' + th.muted + '; white-space:nowrap;')}>© {year} EQLFilter · eqlfilter.com</span>
          <span style={css('font-family:' + th.fu + '; font-size:11.5px; line-height:1.5; color:' + th.muted + '; flex:1; min-width:240px; opacity:0.85;')}>EverQuest is a registered trademark of Daybreak Game Company LLC. EQLFilter is an unofficial fan project, not affiliated with or endorsed by Daybreak.</span>
          <div style={css('display:flex; align-items:center; gap:7px; flex-wrap:wrap;')}>
            <span style={css('font-family:' + th.fu + '; font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:' + th.muted + '; white-space:nowrap;')}>More projects</span>
            {projects.map(p => (
              <a key={p.href} className="eq-pill" href={p.href} target="_blank" rel="noopener" title={p.title} style={css('display:inline-flex; align-items:center; gap:6px; font-family:' + th.fu + '; font-size:11.5px; font-weight:600; text-decoration:none; border-radius:20px; padding:5px 12px;')}>
                <span style={css('width:6px; height:6px; border-radius:50%; background:' + th.accent + ';')}></span>{p.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    )
  }
}
