import bser from 'bser'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import Watchman, { FileChangeItem, isValidWatchRoot } from '../../core/watchman'
import helper from '../helper'
import { Disposable } from 'vscode-languageserver-protocol'
import Configurations from '../../configuration/index'
import WorkspaceFolderController from '../../core/workspaceFolder'
import FileSystemWatcher from '../../core/fileSystemWatcher'
import { disposeAll } from '../../util'
import { URI } from 'vscode-uri'

let server: net.Server
let client: net.Socket
const cwd = process.cwd()
const sockPath = path.join(os.tmpdir(), `watchman-fake`)
process.env.WATCHMAN_SOCK = sockPath

let workspaceFolder: WorkspaceFolderController
let configurations: Configurations
let disposables: Disposable[] = []
let watcher: FileSystemWatcher

function wait(ms: number): Promise<any> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(undefined)
    }, ms)
  })
}

function createFileChange(file: string, isNew = true, exists = true): FileChangeItem {
  return {
    size: 1,
    name: file,
    exists,
    new: isNew,
    type: 'f',
    mtime_ms: Date.now()
  }
}

function sendResponse(data: any): void {
  client.write(bser.dumpToBuffer(data))
}
function sendSubscription(uid: string, root: string, files: FileChangeItem[]): void {
  client.write(bser.dumpToBuffer({
    subscription: uid,
    root,
    files
  }))
}

function createWatcher(pattern: string, ignoreCreateEvents = false, ignoreChangeEvents = false, ignoreDeleteEvents = false): FileSystemWatcher {
  return new FileSystemWatcher(
    workspaceFolder,
    '',
    helper.createNullChannel(),
    pattern,
    ignoreCreateEvents,
    ignoreChangeEvents,
    ignoreDeleteEvents
  )
}

let capabilities: any
let watchResponse: any
beforeAll(done => {
  let userConfigFile = path.join(process.env.COC_VIMCONFIG, 'coc-settings.json')
  configurations = new Configurations(userConfigFile, {
    $removeConfigurationOption: () => {},
    $updateConfigurationOption: () => {},
    workspaceConfigFile: ''
  })
  workspaceFolder = new WorkspaceFolderController(configurations)
  // create a mock sever for watchman
  server = net.createServer(c => {
    client = c
    c.on('data', data => {
      let obj = bser.loadFromBuffer(data)
      if (obj[0] == 'watch-project') {
        sendResponse(watchResponse || { watch: obj[1], warning: 'warning' })
      } else if (obj[0] == 'unsubscribe') {
        sendResponse({ path: obj[1] })
      } else if (obj[0] == 'clock') {
        sendResponse({ clock: 'clock' })
      } else if (obj[0] == 'version') {
        let { optional, required } = obj[1]
        let res = {}
        for (let key of optional) {
          res[key] = true
        }
        for (let key of required) {
          res[key] = true
        }
        sendResponse({ capabilities: capabilities || res })
      } else if (obj[0] == 'subscribe') {
        sendResponse({ subscribe: obj[2] })
      } else {
        sendResponse({})
      }
    })
  })
  server.on('error', err => {
    throw err
  })
  server.listen(sockPath, () => {
    done()
  })
})

afterEach(async () => {
  disposeAll(disposables)
  await Watchman.dispose()
  capabilities = undefined
  watchResponse = undefined
  workspaceFolder.reset()
  if (watcher) {
    watcher.dispose()
    watcher = null
  }
})

afterAll(() => {
  if (client) {
    client.unref()
    client.removeAllListeners()
    client.destroy()
  }
  server.removeAllListeners()
  server.unref()
  server.close()
  if (fs.existsSync(sockPath)) {
    fs.unlinkSync(sockPath)
  }
})

describe('watchman', () => {
  it('should throw error when not watching', async () => {
    let client = new Watchman(null)
    disposables.push(client)
    let fn = async () => {
      await client.subscribe('**/*', () => {})
    }
    await expect(fn()).rejects.toThrow(/not watching/)
  })

  it('should checkCapability', async () => {
    let client = new Watchman(null)
    disposables.push(client)
    let res = await client.checkCapability()
    expect(res).toBe(true)
    client.dispose()
    capabilities = { relative_root: false }
    res = await client.checkCapability()
    expect(res).toBe(false)
  })

  it('should watchProject', async () => {
    let client = new Watchman(null)
    disposables.push(client)
    let res = await client.watchProject(__dirname)
    expect(res).toBe(true)
    client.dispose()
  })

  it('should unsubscribe', async () => {
    let client = new Watchman(null)
    disposables.push(client)
    await client.watchProject(process.cwd())
    let fn = jest.fn()
    let disposable = await client.subscribe(`${process.cwd()}/*`, fn)
    disposable.dispose()
    client.dispose()
  })
})

describe('Watchman#subscribe', () => {

  it('should subscribe file change', async () => {
    let client = new Watchman(null, helper.createNullChannel())
    disposables.push(client)
    await client.watchProject(cwd)
    let fn = jest.fn()
    let disposable = await client.subscribe(`${cwd}/*`, fn)
    let changes: FileChangeItem[] = [createFileChange(`${cwd}/a`)]
    sendSubscription(disposable.subscribe, cwd, changes)
    await wait(30)
    expect(fn).toBeCalled()
    let call = fn.mock.calls[0][0]
    disposable.dispose()
    expect(call.root).toBe(cwd)
    client.dispose()
  })

  it('should subscribe with relative_path', async () => {
    let client = new Watchman(null, helper.createNullChannel())
    watchResponse = { watch: cwd, relative_path: 'foo' }
    await client.watchProject(cwd)
    let fn = jest.fn()
    let disposable = await client.subscribe(`${cwd}/*`, fn)
    let changes: FileChangeItem[] = [createFileChange(`${cwd}/a`)]
    sendSubscription(disposable.subscribe, cwd, changes)
    await wait(30)
    expect(fn).toBeCalled()
    let call = fn.mock.calls[0][0]
    disposable.dispose()
    expect(call.root).toBe(path.join(cwd, 'foo'))
    client.dispose()
  })

  it('should not subscribe invalid response', async () => {
    let c = new Watchman(null, helper.createNullChannel())
    disposables.push(c)
    watchResponse = { watch: cwd, relative_path: 'foo' }
    await c.watchProject(cwd)
    let fn = jest.fn()
    let disposable = await c.subscribe(`${cwd}/*`, fn)
    let changes: FileChangeItem[] = [createFileChange(`${cwd}/a`)]
    sendSubscription('uuid', cwd, changes)
    await wait(10)
    sendSubscription(disposable.subscribe, cwd, [])
    await wait(10)
    client.write(bser.dumpToBuffer({
      subscription: disposable.subscribe,
      root: cwd
    }))
    await wait(10)
    expect(fn).toBeCalledTimes(0)
  })
})

describe('Watchman#createClient', () => {
  it('should not create client when capabilities not match', async () => {
    capabilities = { relative_root: false }
    let client = await Watchman.createClient(null, process.cwd())
    expect(client).toBe(null)
  })

  it('should not create when watch failed', async () => {
    watchResponse = {}
    let client = await Watchman.createClient(null, process.cwd())
    expect(client).toBe(null)
  })

  it('should create client', async () => {
    let client = await Watchman.createClient(null, process.cwd())
    expect(client).toBeDefined()
  })

  it('should resue client for same root', async () => {
    let client = await Watchman.createClient(null, process.cwd())
    expect(client).toBeDefined()
    let other = await Watchman.createClient(null, process.cwd())
    expect(client).toBe(other)
    client.dispose()
  })

  it('should not create client for root', async () => {
    let client = await Watchman.createClient(null, '/')
    expect(client).toBeNull()
  })
})

describe('isValidWatchRoot()', () => {
  it('should check valid root', async () => {
    expect(isValidWatchRoot('/')).toBe(false)
    expect(isValidWatchRoot(os.homedir())).toBe(false)
    expect(isValidWatchRoot('/tmp/a/b/c')).toBe(false)
    expect(isValidWatchRoot(os.tmpdir())).toBe(false)
  })
})

describe('fileSystemWatcher', () => {
  it('should create without workspace folders', async () => {
    expect(workspaceFolder.workspaceFolders.length).toBe(0)
    watcher = createWatcher('**/*')
    expect(watcher).toBeDefined()
  })

  it('should create for invalid folder', async () => {
    workspaceFolder.addWorkspaceFolder('', false)
    watcher = createWatcher('**/*')
    expect(watcher).toBeDefined()
    workspaceFolder.addWorkspaceFolder('/a/b', false)
    await helper.wait(30)
  })

  it('should watch for file create', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*', false, true, true)
    let uri: URI
    watcher.onDidCreate(e => {
      uri = e
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [createFileChange(`a`)]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(uri.fsPath).toEqual(path.join(cwd, 'a'))
  })

  it('should watch for file delete', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*', true, true, false)
    let uri: URI
    watcher.onDidDelete(e => {
      uri = e
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [createFileChange(`a`, false, false)]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(uri.fsPath).toEqual(path.join(cwd, 'a'))
  })

  it('should watch for file change', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*', false, false, false)
    let uri: URI
    watcher.onDidChange(e => {
      uri = e
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [createFileChange(`a`, false, true)]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(uri.fsPath).toEqual(path.join(cwd, 'a'))
  })

  it('should watch for file rename', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*', false, false, false)
    let uri: URI
    watcher.onDidRename(e => {
      uri = e.newUri
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [
      createFileChange(`a`, false, false),
      createFileChange(`b`, true, true),
    ]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(uri.fsPath).toEqual(path.join(cwd, 'b'))
  })

  it('should not watch for events', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*', true, true, true)
    let called = false
    let onChange = () => {
      called = true
    }
    watcher.onDidCreate(onChange)
    watcher.onDidChange(onChange)
    watcher.onDidDelete(onChange)
    await helper.wait(50)
    let changes: FileChangeItem[] = [
      createFileChange(`a`, false, false),
      createFileChange(`b`, true, true),
      createFileChange(`c`, false, true),
    ]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(called).toBe(false)
  })

  it('should watch for folder rename', async () => {
    workspaceFolder.addWorkspaceFolder(process.cwd(), false)
    watcher = createWatcher('**/*')
    let newFiles: string[] = []
    watcher.onDidRename(e => {
      newFiles.push(e.newUri.fsPath)
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [
      createFileChange(`a/1`, false, false),
      createFileChange(`a/2`, false, false),
      createFileChange(`b/1`, true, true),
      createFileChange(`b/2`, true, true),
    ]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(newFiles.length).toBe(2)
  })

  it('should watch for new folder', async () => {
    workspaceFolder.addWorkspaceFolder('', false)
    watcher = createWatcher('**/*')
    expect(watcher).toBeDefined()
    await helper.wait(50)
    workspaceFolder.addWorkspaceFolder(process.cwd(), true)
    let uri: URI
    watcher.onDidCreate(e => {
      uri = e
    })
    await helper.wait(50)
    let changes: FileChangeItem[] = [createFileChange(`a`)]
    sendSubscription(watcher.subscribe, cwd, changes)
    await helper.wait(50)
    expect(uri.fsPath).toEqual(path.join(cwd, 'a'))
  })
})
