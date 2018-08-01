import * as vscode from 'vscode'
const tfs = require('tfs');

const getFileNameFromPath = (path: string): string => {
   let consitPath = path.replace(/\//g, '\\') // use Windows style paths for consistency
   return consitPath.substr(consitPath.lastIndexOf('\\') + 1);
}

const tfsCallback = (itemspec: string, successMsg: string, resolve: Function) => {
   return (responseError: any, response: any) => {
      if (responseError) {
         vscode.window.setStatusBarMessage('');
         vscode.window.showErrorMessage('TFS: ' + responseError.error);
         resolve();
         return;
      }
      const fileName = getFileNameFromPath(itemspec);
      const msg = `TFS: "${fileName}" ${successMsg}`;

      vscode.window.setStatusBarMessage(msg);
      vscode.window.showInformationMessage(msg);
      resolve();
   }
}

const addToTFS = (itemspec: string) => {
   vscode.window.setStatusBarMessage('TFS: Adding...');
   return new Promise((resolve) => {
      tfs('add', itemspec, null, tfsCallback(itemspec, 'successfully added.', resolve));
   });
}

const checkOutTFS = (itemspec: string) => {
   vscode.window.setStatusBarMessage('TFS: Updating...');
   return new Promise((resolve) => {
      tfs('checkout', itemspec, null,
         tfsCallback(itemspec, 'has been automatically checked out for editing', resolve));
   });
}

const deleteTFS = (itemspec: string) => {
   return new Promise((resolve) => {
      const fileName = getFileNameFromPath(itemspec);
      vscode.window.showWarningMessage(`TFS: "${fileName}" has not been removed from TFS, you have to do it in VS`);
      resolve();
   });
   //Not implemeted
   /*
   Should be
      > status(itemspec)
         if not updated
            > delete(itemspec)
         else
            if added
               > undo(itemspec)
            else {
               > undo(itemspec)
               > delete(itemspec)
            }
   But 'delete' is buggy on 'TFS' package, and 'status' only work with TFS in english :/
   */
}

export const sourceControl = {
   add: addToTFS,
   update: checkOutTFS,
   remove: deleteTFS
}
