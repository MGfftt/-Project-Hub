/**
 * Frozen IPC channel names (§7.7).
 *
 * Every entry is `namespace:verb`. The preload bridge and the main-process router
 * both import this object, so a typo becomes a type error instead of a silently
 * dead channel. Nothing here is a path into a user folder — see `ipc/isolation.ts`
 * for the small, explicit list of native paths the renderer may hand us.
 */
export const CH = {
  roots: {
    add: 'roots:add',
    list: 'roots:list',
    remove: 'roots:remove',
    rescan: 'roots:rescan',
    pick: 'roots:pick',
    setEnabled: 'roots:setEnabled'
  },
  nodes: {
    tree: 'nodes:tree',
    update: 'nodes:update',
    move: 'nodes:move',
    createGroup: 'nodes:createGroup',
    remove: 'nodes:remove',
    detail: 'nodes:detail',
    stats: 'nodes:stats',
    setDisplayName: 'nodes:setDisplayName',
    setIcon: 'nodes:setIcon',
    importIcon: 'nodes:importIcon',
    relocate: 'nodes:relocate',
    thumb: 'nodes:thumb',
    listChildren: 'nodes:listChildren'
  },
  shell: {
    openFolder: 'shell:openFolder',
    revealFolder: 'shell:revealFolder',
    copyPath: 'shell:copyPath',
    openFile: 'shell:openFile'
  },
  events: {
    list: 'events:list',
    syncAllGit: 'events:syncAllGit',
    heatmap: 'events:heatmap'
  },
  icons: {
    listBuiltin: 'icons:listBuiltin',
    listCustom: 'icons:listCustom',
    removeCustom: 'icons:removeCustom',
    gcUnused: 'icons:gcUnused',
    store: 'icons:store',
    defs: 'icons:defs'
  },
  search: {
    query: 'search:query'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    all: 'settings:all',
    background: {
      current: 'settings:background:current',
      choose: 'settings:background:choose',
      clear: 'settings:background:clear'
    }
  },
  background: {
    pause: 'background:pause',
    resume: 'background:resume',
    status: 'background:status',
    runNow: 'background:runNow'
  },
  export: {
    json: 'export:json',
    writeFile: 'export:writeFile'
  },
  app: {
    info: 'app:info',
    quit: 'app:quit',
    hideWindow: 'app:hideWindow',
    showWindow: 'app:showWindow',
    setAutoLaunch: 'app:setAutoLaunch'
  },
  /** Main -> renderer push channels. */
  broadcast: {
    treeUpdated: 'tree:updated',
    eventsAppended: 'events:appended',
    scanProgress: 'scan:progress',
    taskStatus: 'task:status',
    windowVisibility: 'window:visibility',
    trayState: 'tray:state'
  }
} as const

export type BroadcastChannel = (typeof CH.broadcast)[keyof typeof CH.broadcast]
