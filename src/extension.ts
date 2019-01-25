'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import { Vsproj, ActionArgs, ItemType } from './types'
import * as VsprojUtil from './vsproj'
import * as StatusBar from './statusbar'

const { window, commands, workspace } = vscode
const debounce = require('lodash.debounce')

const [YES, NO, NEVER] = ['Yes', 'Not Now', 'Never For This File']
const _debounceDeleteTime = 2000

let _vsprojRemovals: string[] = []
let workspaceParentFolders: string[];

export function activate(context: vscode.ExtensionContext) {
   const config = getGlobalConfig()
   //Gobal activation
   if (!config.get<boolean>('enabled', true))
      return;

   //Workspace activation
   if (!config.get<boolean>('activate', false))
      return;

   const projExt = config.get<string>('projExtension', 'njsproj')

   console.log('extension.vsproj#activate for', projExt);

   const vsprojWatcher = workspace.createFileSystemWatcher(`**/*.${ projExt }`)
   const deleteFileWatcher = workspace.createFileSystemWatcher('**/*', true, true, false)
   const createAndChangeFileWatcher = workspace.createFileSystemWatcher('**/*', false, false, true)

   context.subscriptions.push(
      commands.registerCommand('extension.vsproj.add',
         vsprojAddCommand.bind(context)),
      commands.registerCommand('extension.vsproj.remove',
         vsprojRemoveCommand.bind(context)),
      commands.registerCommand('extension.vsproj.clearIgnoredPaths',
         clearIgnoredPathsCommand.bind(context)),

      workspace.onDidSaveTextDocument(async (e: vscode.TextDocument) => {
         if (ignoreEvent(context, e.uri)) return;

         await commands.executeCommand('extension.vsproj.add', e.uri);
      }),

      window.onDidChangeActiveTextEditor(async (e: vscode.TextEditor) => {
         if (!e) return

         if (ignoreEvent(context, e.document.uri)) return;

         await commands.executeCommand('extension.vsproj.add', e.document.uri);
      }),

      vsprojWatcher.onDidChange((uri: vscode.Uri) => {
         // Clear cache entry if file is modified
         VsprojUtil.invalidate(uri.fsPath);
      }),

      createAndChangeFileWatcher.onDidCreate(async (uri: vscode.Uri) => {
         if (ignoreEvent(context, uri)) return;
         await commands.executeCommand('extension.vsproj.add', uri);
      }),

      createAndChangeFileWatcher.onDidChange(async (uri: vscode.Uri) => {
         if (ignoreEvent(context, uri)) return;
         const isFileExisting = await fileExists(uri.fsPath);
         if (!isFileExisting) {
            //File has been renamed, so remove it
            await commands.executeCommand('extension.vsproj.remove', uri);
         }
      }),


      deleteFileWatcher.onDidDelete(handleFileDeletion),

      vsprojWatcher, deleteFileWatcher,

      StatusBar.createItem()
   )
}

function getWorkspaceParentFolders() {
   if (workspaceParentFolders) {
      return (workspaceParentFolders);
   }
   workspaceParentFolders = [];
   if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
      return (workspaceParentFolders);
   }

   workspace.workspaceFolders.forEach(f => {
      workspaceParentFolders.push(path.resolve(f.uri.fsPath, '..'));
   });

   return (workspaceParentFolders);
}

export function deactivate() {
   console.log('extension.vsproj#deactivate')
   VsprojUtil.invalidateAll()
   StatusBar.hideItem()
}

function ignoreEvent(context: vscode.ExtensionContext, uri: vscode.Uri) {
   if (!isDesiredFile(context.globalState, uri.fsPath))
      return true;

   return false;
}

function getGlobalConfig() {
   return workspace.getConfiguration("vsproj");
}

const getProjExtension = (): string => {
   return getGlobalConfig().get<string>('projExtension', 'njsproj');
}

async function vsprojAddCommand(
   this: vscode.ExtensionContext,
   // Use file path from context or fall back to active document
   uri: vscode.Uri | null = window.activeTextEditor ? window.activeTextEditor.document.uri : null,
   bulkMode = false
): Promise<Vsproj | void> {
   if (!uri || !uri.fsPath) return

   const fsPath = uri.fsPath;

   const projExt = getProjExtension();

   // Skip if we're saving a *proj file, or we are a standalone file without a path.
   if (fsPath.endsWith(`.${ projExt }`) || !/(\/|\\)/.test(fsPath))
      return

   if (isDirectory(fsPath)) {
      return await vsprojAddDirectory.call(this, fsPath)
   }

   return await processAddCommand.call(this, fsPath, bulkMode);
}

async function processAddCommand(
   this: vscode.ExtensionContext,
   fsPath: string,
   bulkMode = false) {

   const fileName = path.basename(fsPath)
   console.log(`extension.vsproj#trigger(${ fileName })#add`)

   try {
      const vsproj = await getVsprojForFile(fsPath);
      if (!vsproj) return;

      if (VsprojUtil.hasFile(vsproj, fsPath)) {
         console.log(`extension.vsproj#trigger(${ fileName }): already in proj file`)
         return;
      }

      const added = await runAction({
         filePath: fsPath,
         fileName,
         bulkMode,
         vsproj,
         globalState: this.globalState
      });

      if (added) return vsproj;

   } catch (err) {
      if (!(err instanceof VsprojUtil.NoVsprojError)) {
         window.showErrorMessage(err.toString())
         console.trace(err)
      } else {
         console.log(`extension.vsproj#trigger(${ fileName }): no project file found`)
      }
   }
};

async function runAction({ filePath, fileName, vsproj, bulkMode }: ActionArgs) {
   const config = workspace.getConfiguration("vsproj")
   const itemType = config.get<ItemType>('itemType', {
      '*': 'Content',
      '.js': 'Compile',
      '.ts': 'TypeScriptCompile'
   })
   VsprojUtil.addFile(vsproj, filePath, getTypeForFile(fileName, itemType))
   if (!bulkMode) {
      await VsprojUtil.persist(vsproj)
   }
   return true;
}

async function vsprojAddDirectory(this: vscode.ExtensionContext, fsPath: string) {
   const changedVsprojs: Vsproj[] = []

   if (!isDesiredFile(this.globalState, fsPath)) {
      return;
   }

   const relativePattern = new vscode.RelativePattern(fsPath, '**/*');

   const files = await workspace.findFiles(relativePattern, '**/node_modules/**');

   const hasFiles = files.length > 0;

   //Add directory itself
   let vsproj: Vsproj = await processAddCommand.call(this, fsPath, false, hasFiles);
   if (vsproj) {
      changedVsprojs.push(vsproj);
   }

   //Add files/directories inside directory
   for (const file of files.filter(file => isDesiredFile(this.globalState, file.fsPath))) {
      vsproj = await vsprojAddCommand.call(this, file, true)
      if (vsproj) {
         if (!changedVsprojs.find(_vsproj => _vsproj.fsPath === vsproj.fsPath))
            changedVsprojs.push(vsproj)
      }
   }

   for (const vsproj of changedVsprojs)
      VsprojUtil.persist(vsproj);
}

// How do we actually tell if a directory or file was deleted?
function wasDirectory(fsPath: string) {
   return path.extname(fsPath) === '';
}

function isDirectory(fsPath: string) {
   return (fs.lstatSync(fsPath).isDirectory());
}

async function fileExists(fsPath: string) {
   return new Promise<Boolean>((resolve) => {
      fs.access(fsPath, fs.constants.F_OK, (err) => {
         if (err) {
            resolve(false);
         } else {
            resolve(true);
         }
      });
   });
}

async function handleFileDeletion({ fsPath }: vscode.Uri) {
   try {
      const vsproj = await getVsprojForFile(fsPath);
      if (!vsproj) return;
      if (!wasDirectory(fsPath) && !VsprojUtil.hasFile(vsproj, fsPath))
         return

      _vsprojRemovals.push(fsPath);

      await debouncedRemoveFromVsproj(
         _vsprojRemovals,
         () => { _vsprojRemovals = [] }
      )
   } catch (err) {
      console.trace(err)
   }
}

const debouncedRemoveFromVsproj = debounce(
   async (removals: string[], onCall: Function) => {
      onCall();

      for (let filePath of removals) {
         await commands.executeCommand('extension.vsproj.remove',
            { fsPath: filePath });
      }
   },
   _debounceDeleteTime
)

function getTypeForFile(fileName: string, itemType: ItemType): string {
   const extension = path.extname(fileName)
   return typeof itemType === 'string'
      ? itemType
      : !extension ? "Folder" : (itemType[extension] || itemType['*'] || 'Content')
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

async function vsprojRemoveCommand(
   this: vscode.ExtensionContext,
   // Use file path from context or fall back to active document
   uri: vscode.Uri | null = window.activeTextEditor ? window.activeTextEditor.document.uri : null,
   bulkMode = false
): Promise<Vsproj | void> {
   if (!uri || !uri.fsPath) {
      return;
   }

   const fsPath = uri.fsPath;

   const vsproj = await getVsprojForFile(fsPath);

   if (!vsproj) return;

   const wasDir = wasDirectory(fsPath);
   const fileName = path.basename(fsPath);
   console.log(`extension.vsproj#remove(${ fsPath })`)

   try {
      const removed = await VsprojUtil.removeFile(vsproj, fsPath, wasDir)
      await VsprojUtil.persist(vsproj)
      if (!removed && !bulkMode) {
         window.showWarningMessage(`${ fileName } was not found in ${ vsproj.name }`)
      }
   } catch (err) {
      window.showErrorMessage(err.toString())
      console.trace(err)
   }
}

async function getVsprojForFile(fsPath: string) {
   try {
      const projExt = getProjExtension();
      return await VsprojUtil.getProjforFile(fsPath, projExt, getWorkspaceParentFolders());
   } catch (err) {
      if (err instanceof VsprojUtil.NoVsprojError) {
         const fileName = path.basename(fsPath)
         await window.showErrorMessage(`Unable to locate vsproj for file: ${ fileName }`)
      } else {
         console.trace(err)
      }
      return
   }
}
