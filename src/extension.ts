'use strict';

import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import { Vsproj, ActionArgs, ItemType } from './types'
import * as VsprojUtil from './vsproj'
import * as StatusBar from './statusbar'
import { VsProjOutput } from "./vsprojOutput";

const { window, commands, workspace } = vscode
const debounce = require('lodash.debounce')

const _debounceDeleteTime = 2000

let _vsprojRemovals: string[] = []
let workspaceParentFolders: string[];

const _disposables: vscode.Disposable[] = [];

export async function activate(context: vscode.ExtensionContext) {
   const config = getGlobalConfig()
   //Gobal activation
   if (!config.get<boolean>('enabled', true))
      return;

   //Workspace activation
   if (!config.get<boolean>('activate', false))
      return;

   if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
      return;
   }

   _disposables.push(await VsProjOutput.CreateChannel());

   const projExt = config.get<string>('projExtension', 'njsproj')

   VsProjOutput.AppendLine('extension.vsproj#activate for', projExt);

   const vsprojWatcher = workspace.createFileSystemWatcher(`**/*.${ projExt }`);
   const deleteFileWatcher = workspace.createFileSystemWatcher('**/*', true, true, false);
   const createAndChangeFileWatcher = workspace.createFileSystemWatcher('**/*', false, false, true);

   context.subscriptions.push(
      commands.registerCommand('extension.vsproj.output',
         () => {
            //Show debug output console
            VsProjOutput.Show()
         }),
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

      deleteFileWatcher.onDidDelete(async (uri: vscode.Uri) => {
         if (ignoreEvent(context, uri)) return;
         await handleFileDeletion(uri);
      }),

      vsprojWatcher, deleteFileWatcher,

      StatusBar.createItem(projExt, workspace.workspaceFolders)
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
   VsProjOutput.AppendLine('extension.vsproj#deactivate');
   VsprojUtil.invalidateAll();
   StatusBar.hideItem();
   _disposables.forEach(d => d.dispose());
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

   removeFromPendingDelete(fsPath);

   if (isDirectory(fsPath)) {
      return await vsprojAddDirectory.call(this, fsPath)
   }

   return await processAddCommand.call(this, fsPath, bulkMode);
}

/**
 * Prevent removing a file that is delete then added in the same process (with SCM for instance)
 * @param fsPath - Path to remove from pending delete
 */
function removeFromPendingDelete(fsPath: string) {
   const index = _vsprojRemovals.findIndex(path => path === fsPath);
   if (index >= 0) {
      _vsprojRemovals.splice(index, 1);
   }
}

async function processAddCommand(
   this: vscode.ExtensionContext,
   fsPath: string,
   bulkMode = false) {

   const fileName = path.basename(fsPath)
   VsProjOutput.AppendLine(`extension.vsproj#trigger(${ fileName })#add`);

   try {
      const vsproj = await getVsprojForFile(fsPath);
      if (!vsproj) return;

      if (VsprojUtil.hasFile(vsproj, fsPath)) {
         VsProjOutput.AppendLine(`extension.vsproj#trigger(${ fileName }): already in proj file`);
         return;
      }

      VsProjOutput.AppendLine(`extension.vsproj#trigger(${ fileName }): add file`);

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
         console.trace(err)
         VsProjOutput.AppendLine(err);
      } else {
         VsProjOutput.AppendLine(`extension.vsproj#trigger(${ fileName }): no project file found`)
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
   return path.extname(fsPath) === '' && !fsPath.startsWith(".");
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

      const fileName = path.basename(fsPath);
      VsProjOutput.AppendLine(`extension.vsproj#trigger(${ fileName }) : will be deleted`);

      if (!wasDirectory(fsPath) && !VsprojUtil.hasFile(vsproj, fsPath))
         return

      _vsprojRemovals.push(fsPath);

      await debouncedRemoveFromVsproj(
         _vsprojRemovals,
         () => { _vsprojRemovals = [] }
      )
   } catch (err) {
      console.trace(err);
      VsProjOutput.AppendLine(err);
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
   const extension = path.extname(fileName) || (fileName.startsWith(".") ? "file" : "");
   return typeof itemType === 'string'
      ? itemType
      : !extension ? "Folder" : (itemType[extension] || itemType['*'] || 'Content')
}

function isDesiredFile(globalState: vscode.Memento, queryPath: string) {
   const config = workspace.getConfiguration('vsproj')

   const ignorePaths = globalState.get<string[]>('vsproj.ignorePaths') || []
   if (ignorePaths.indexOf(queryPath) > -1)
      return false

   const includeRegex = config.get('includeRegex', '.*');
   //Global exclusions
   const excludeRegex = config.get('excludeRegex', null);

   if (includeRegex != null && !new RegExp(includeRegex).test(queryPath))
      return false

   if (excludeRegex != null && new RegExp(excludeRegex).test(queryPath))
      return false

   //Exclusions by workspace
   const excludeList = config.get('exclude', []);

   return excludeList.every(excludeValue => {
      return !new RegExp(excludeValue).test(queryPath);
   });
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
   VsProjOutput.AppendLine(`extension.vsproj#remove(${ fsPath })`);

   try {
      const removed = await VsprojUtil.removeFile(vsproj, fsPath, wasDir)
      await VsprojUtil.persist(vsproj)
      if (!removed && !bulkMode) {
         VsProjOutput.AppendLine(`${ fileName } was not found in ${ vsproj.name }`);
      }
   } catch (err) {
      console.trace(err);
      VsProjOutput.AppendLine(err);
   }
}

async function getVsprojForFile(fsPath: string) {
   try {
      const projExt = getProjExtension();
      return await VsprojUtil.getProjforFile(fsPath, projExt, getWorkspaceParentFolders());
   } catch (err) {
      if (err instanceof VsprojUtil.NoVsprojError) {
         const fileName = path.basename(fsPath)
         VsProjOutput.AppendLine(`Unable to locate vsproj for file: ${ fileName }`);
      } else {
         console.trace(err);
         VsProjOutput.AppendLine(err);
      }
      return
   }
}
