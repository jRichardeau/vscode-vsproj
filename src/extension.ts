'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import { VsprojAndFile, Vsproj, ActionArgs, ItemType } from './types'
import * as VsprojUtil from './vsproj'
import * as StatusBar from './statusbar'
import { sourceControl } from "./source-control";

const { window, commands, workspace } = vscode
const debounce = require('lodash.debounce')

const [YES, NO, NEVER] = ['Yes', 'Not Now', 'Never For This File']
const _debounceDeleteTime = 2000

let _vsprojRemovals: VsprojAndFile[] = []

export function activate(context: vscode.ExtensionContext) {
   const config = getConfig()
   if (!config.get<boolean>('enabled', true))
      return

   const projExt = config.get<string>('projExtension', 'njsproj')

   console.log('extension.vsproj#activate for', projExt)

   const vsprojWatcher = workspace.createFileSystemWatcher(`**/*.${projExt}`)
   const deleteFileWatcher = workspace.createFileSystemWatcher('**/*', true, true, false)

   context.subscriptions.push(
      commands.registerCommand('extension.vsproj.add',
         vsprojCommand.bind(context)),
      commands.registerCommand('extension.vsproj.remove',
         vsprojRemoveCommand.bind(context)),
      commands.registerCommand('extension.vsproj.clearIgnoredPaths',
         clearIgnoredPathsCommand.bind(context)),

      workspace.onDidSaveTextDocument(async (e: vscode.TextDocument) => {
         if (ignoreEvent(context, e.uri)) return

         await commands.executeCommand('extension.vsproj.add',
            e.uri, true)
      }),

      window.onDidChangeActiveTextEditor(async (e: vscode.TextEditor) => {
         if (!e) return

         StatusBar.hideItem()
         if (ignoreEvent(context, e.document.uri)) return

         await commands.executeCommand('extension.vsproj.add',
            e.document.uri, true)
      }),

      vsprojWatcher.onDidChange(uri => {
         // Clear cache entry if file is modified
         VsprojUtil.invalidate(uri.fsPath)
      }),

      deleteFileWatcher.onDidDelete(handleFileDeletion),

      vsprojWatcher, deleteFileWatcher,

      StatusBar.createItem()
   )
}

export function deactivate() {
   console.log('extension.vsproj#deactivate')
   VsprojUtil.invalidateAll()
   StatusBar.hideItem()
}

function ignoreEvent(context: vscode.ExtensionContext, uri: vscode.Uri) {
   if (!isDesiredFile(context.globalState, uri.fsPath))
      return true

   if (StatusBar.isVisible())
      return true

   return false
}

function getConfig() {
   return workspace.getConfiguration("vsproj")
}

const getProjExtension = (): string => {
   return getConfig().get<string>('projExtension', 'njsproj');
}

async function vsprojCommand(
   this: vscode.ExtensionContext,
   // Use file path from context or fall back to active document
   { fsPath }: vscode.Uri = window.activeTextEditor.document.uri,
   promptAction = false,
   bulkMode = false
): Promise<Vsproj | void> {
   if (!fsPath) return

   const projExt = getProjExtension();

   // Skip if we're saving a *proj file, or we are a standalone file without a path.
   if (fsPath.endsWith(`.${projExt}`) || !/(\/|\\)/.test(fsPath))
      return

   if (fs.lstatSync(fsPath).isDirectory()) {
      return await vsprojAddDirectory.call(this, fsPath)
   }

   const fileName = path.basename(fsPath)
   console.log(`extension.vsproj#trigger(${fileName})`)

   try {
      const vsproj = await getVsprojForFile(fsPath)
      if (!vsproj) return;

      if (VsprojUtil.hasFile(vsproj, fsPath)) {
         StatusBar.displayItem(vsproj.name, true)
         if (!promptAction && !bulkMode) {
            window.showWarningMessage(`${fileName} is already in ${vsproj.name}`)
         }
         console.log(`extension.vsproj#trigger(${fileName}): already in .${projExt}`)
         return
      }

      let pickResult = (promptAction === true)
         ? await window.showInformationMessage(
            `${fileName} is not in ${vsproj.name}, would you like to add it?`,
            YES, NEVER)
         : YES

      // Default to "No" action if user blurs the picker
      const added = await (pickActions[pickResult] || pickActions[NO])({
         filePath: fsPath,
         fileName,
         bulkMode,
         vsproj,
         globalState: this.globalState
      })

      if (added) return vsproj

   } catch (err) {
      if (!(err instanceof VsprojUtil.NoVsprojError)) {
         window.showErrorMessage(err.toString())
         console.trace(err)
      } else {
         console.log(`extension.vsproj#trigger(${fileName}): no .${projExt} found`)
      }
   }
}

const pickActions = {
   async [YES]({ filePath, fileName, vsproj, bulkMode }: ActionArgs) {
      const config = workspace.getConfiguration("vsproj")
      const itemType = config.get<ItemType>('itemType', {
         '*': 'Content',
         '.js': 'Compile',
         '.ts': 'TypeScriptCompile'
      })
      VsprojUtil.addFile(vsproj, filePath, getTypeForFile(fileName, itemType))
      if (!bulkMode) {
         await VsprojUtil.persist(vsproj)
         StatusBar.displayItem(vsproj.name, true)
         // window.showInformationMessage(`Added ${fileName} to ${csproj.name}`)
      }
      //Add file to source control
      await sourceControl.add(filePath);

      return true
   },
   [NO]({ vsproj }: ActionArgs) {
      StatusBar.displayItem(vsproj.name, false)
   },
   async [NEVER]({ filePath, globalState, fileName }: ActionArgs) {
      await updateIgnoredPaths(globalState, filePath)

      StatusBar.hideItem()
      window.showInformationMessage(
         `Added ${fileName} to ignore list, to clear list, ` +
         `run the "vsproj: Clear ignored paths"`)
   }
}

async function vsprojAddDirectory(this: vscode.ExtensionContext, fsPath: string) {
   const changedVsprojs: Vsproj[] = []

   const files = await workspace.findFiles(
      path.join(workspace.asRelativePath(fsPath), '**/*'),
      ''
   )
   for (const file of files.filter(file => isDesiredFile(this.globalState, file.fsPath))) {
      const vsproj: Vsproj = await vsprojCommand.call(this, file, false, true)
      if (vsproj) {
         if (!changedVsprojs.find(_vsproj => _vsproj.fsPath === vsproj.fsPath))
            changedVsprojs.push(vsproj)
      }
   }

   for (const vsproj of changedVsprojs)
      VsprojUtil.persist(vsproj)
}

// How do we actually tell if a directory or file was deleted?
function wasDirectory(fsPath: string) {
   return path.extname(fsPath) === ''
}

async function handleFileDeletion({ fsPath }: vscode.Uri) {
   try {
      const vsproj = await getVsprojForFile(fsPath)
      if (!vsproj) return;
      if (!wasDirectory(fsPath) && !VsprojUtil.hasFile(vsproj, fsPath))
         return

      _vsprojRemovals.push({ vsproj, filePath: fsPath })
      await debouncedRemoveFromVsproj(
         _vsprojRemovals,
         () => { _vsprojRemovals = [] }
      )
   } catch (err) {
      console.trace(err)
   }
}

const debouncedRemoveFromVsproj = debounce(
   async (removals: VsprojAndFile[], onCall: Function) => {
      onCall()

      const message = removals.length > 1
         ? multiDeleteMessage(removals.map(rem => rem.filePath))
         : singleDeleteMessage(removals[0].vsproj, removals[0].filePath)

      if (getConfig().get('silentDeletion', false)
         || await window.showWarningMessage(message, YES) !== YES) {
         return
      }

      for (const { filePath, vsproj } of removals) {
         await commands.executeCommand('extension.vsproj.remove',
            { fsPath: filePath }, vsproj, true)
      }
   },
   _debounceDeleteTime
)

function getTypeForFile(fileName: string, itemType: ItemType): string {
   const extension = path.extname(fileName)
   return typeof itemType === 'string'
      ? itemType
      : itemType[extension] || itemType['*'] || 'Content'
}

function isDesiredFile(globalState: vscode.Memento, queryPath: string) {
   const config = workspace.getConfiguration('vsproj')

   const ignorePaths = globalState.get<string[]>('vsproj.ignorePaths') || []
   if (ignorePaths.indexOf(queryPath) > -1)
      return false

   const includeRegex = config.get('includeRegex', '.*')
   const excludeRegex = config.get('excludeRegex', null)

   if (includeRegex != null && !new RegExp(includeRegex).test(queryPath))
      return false

   if (excludeRegex != null && new RegExp(excludeRegex).test(queryPath))
      return false

   return true
}

function clearIgnoredPathsCommand(this: vscode.ExtensionContext) {
   this.globalState.update('vsproj.ignorePaths', [])
}

async function updateIgnoredPaths(globalState: vscode.Memento, addPath: string) {
   const list = globalState.get<string[]>('vsproj.ignorePaths') || []
   list.push(addPath)
   await globalState.update('vsproj.ignorePaths', list)
}

function singleDeleteMessage(vsproj: Vsproj, filePath: string) {
   const fileName = path.basename(filePath)
   return `${fileName} was deleted. Remove it from ${vsproj.name}?`
}

function multiDeleteMessage(filePaths: string[]) {
   return `${filePaths.length} files were deleted. Remove them from vsproj?`
}

async function vsprojRemoveCommand(
   this: vscode.ExtensionContext,
   // Use file path from context or fall back to active document
   { fsPath }: vscode.Uri = window.activeTextEditor.document.uri,
   vsproj?: Vsproj,
   bulkMode = false
): Promise<Vsproj | void> {
   const wasDir = wasDirectory(fsPath)
   const fileName = path.basename(fsPath)
   console.log(`extension.vsproj#remove(${fileName})`)

   const vsprojProvided = !!vsproj
   if (vsproj) {
      vsproj = VsprojUtil.ensureValid(vsproj)
   } else {
      vsproj = await getVsprojForFile(fsPath)
   }

   if (!vsproj) return

   try {
      const removed = await VsprojUtil.removeFile(vsproj, fsPath, wasDir)
      await VsprojUtil.persist(vsproj)
      if (!removed && !bulkMode) {
         window.showWarningMessage(`${fileName} was not found in ${vsproj.name}`)
      }
   } catch (err) {
      window.showErrorMessage(err.toString())
      console.trace(err)
   }
}

async function getVsprojForFile(fsPath: string) {
   try {
      const projExt = getProjExtension();
      return await VsprojUtil.forFile(fsPath, projExt);
   } catch (err) {
      if (err instanceof VsprojUtil.NoVsprojError) {
         const fileName = path.basename(fsPath)
         await window.showErrorMessage(`Unable to locate vsproj for file: ${fileName}`)
      } else {
         console.trace(err)
      }
      return
   }
}