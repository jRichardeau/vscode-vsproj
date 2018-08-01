# VS Code `.*proj` Extension + TFS

This extension will helps you keep your *proj files in sync when using VS Code.
This is useful if you work in a team that uses both VS Code and Visual Studio.

This extension updates TFS status when a file is added (to couple with TFS extension to detect file update)

* [Install TFS extension](https://marketplace.visualstudio.com/items?itemName=ivangabriele.vscode-tfs)

## /!\ /!\ /!\

Extension do not update TFS status when file is removed (do it with VS)

## FORK FROM :

* [GitHub Repository](https://github.com/azz/vscode-csproj)
* [Marketplace Entry](https://marketplace.visualstudio.com/items?itemName=lucasazzola.vscode-csproj)


## Demo

### Adding Files to a Project

![DemoGif](img/demo.gif "Demonstration")

### Removing Files from a Project

| **Single File Deletion**  | **Multiple File Deletion**
|---------------------------|--------------------------------
| ![Single deletion example](img/demo-single-delete.gif) | ![Multiple deletion example](img/demo-multi-delete.gif)

## How it Works

When you switch to or save a file not in the nearest `.*proj` up the file system tree, you will prompted.

![Prompt](img/demo-prompt.png "Prompt")

Choosing "Close" will add an item to the status bar and stop asking you while you have the file open.

| **File Not in vsproj** | **File Contained in vsproj**
|------------------------|------------------------------
| ![Add to vsproj](img/demo-status-bar.png) | ![Contained in vsproj](img/demo-status-bar-contained.png)

You can add a file to vsproj via the command palette:

![Command Palette](img/demo-command.png "Command Palette")

Or via the context menu in the file explorer:

![Context Menu](img/demo-context-menu.png "Context Menu")

## Extension Settings

This extension contributes the following settings:

| **Setting Key**         | **Description**
|-------------------------|-----------------
| `vsproj.enable`         | Enable/disable this extension.
| `vsproj.projExtension`  | VS project file to watch and update. Defaults: "njsproj"
| `vsproj.itemType`       | Mapping from file extension to vsproj XML element. Defaults to: <br/> `{ "*": "Content", ".ts": "TypeScriptCompile" }`
| `vsproj.silentDeletion` | Silently delete items from vsproj when their corresponding files are removed. Default: `false`.
| `vsproj.includeRegex`   | Regular expression to match files you want to add to vsproj.
| `vsproj.excludeRegex`   | Regular expression to exclude files you do not want to add to vsproj.


These regular expressions will prevent unwanted prompts. If a file matches `includeRegex` *and* `excludeRegex`, it will be excluded.

The regular expressions will prevent this extension from prompting for action, but it intentionally will not
prevent you from adding via the command palette or a context menu. _However_, if you click "Include in Project" on
a directory, `files.exclude`, your saved ignore list, `vsproj.includeRegex` and `vsproj.excludeRegex` will be honored.

## Links

* [GitHub Repository](https://github.com/jRichardeau/vscode-vsproj)

## Release Notes

### Most Recent Release (0.0.1)

Features:

* Change TFS status when a file is added
* Change TFS status of vsproj file when updated (file added)

### See GitHub for [full release history](https://github.com/DerFlatulator/vscode-csproj/releases)

## License

MIT
