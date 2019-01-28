import * as vscode from 'vscode'

let _statusBarItem: vscode.StatusBarItem

export function hideItem() {
   _statusBarItem.text = '';
   _statusBarItem.hide();
}

export function createItem(projExt: string, workspaceFolders: vscode.WorkspaceFolder[]) {
   const folders = workspaceFolders.map(f => f.name);

   const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
   item.text = projExt;
   item.tooltip = `vsproj enabled for "${ projExt }" in folders ${ folders.join(", ") }`;
   item.show();
   _statusBarItem = item;
   return item;
}
