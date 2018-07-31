import {Memento} from 'vscode'

export interface Vsproj {
    fsPath: string
    name: string
    xml: XML
}

export interface VsprojAndFile {
    vsproj: Vsproj
    filePath: string
}

export interface ActionArgs extends VsprojAndFile {
    fileName: string
    bulkMode: boolean
    globalState: Memento
}

export type ItemType = string | { [extension: string]: string }

export interface XMLElement {
    find(xpath: string): XMLElement
    findall(xpath: string): XMLElement[]
    remove(child: XMLElement): void

    attrib: { [attribute: string]: string }
}

export interface XML {
    getroot(): XMLElement
    write(opts: any): string
}
