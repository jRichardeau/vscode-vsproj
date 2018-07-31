import * as vscode from 'vscode'
import * as fs from 'mz/fs'
import * as path from 'path'

import { Vsproj, XML } from './types'
const { workspace } = vscode

const etree = require('@azz/elementtree')
const stripBom = require('strip-bom')

export class NoVsprojError extends Error { }

let _cacheXml: { [path: string]: XML } = Object.create(null)

const getProjExtension = (): string => {
   return workspace.getConfiguration("vsproj").get<string>('projExtension', 'njsproj');
}

export async function getPath(fileDir: string, walkUp = true): Promise<string> {
   if (!path.isAbsolute(fileDir))
      fileDir = path.resolve(fileDir)

   const projExt = getProjExtension();
   const files = await fs.readdir(fileDir)
   const vsproj = files.find((file:any) => file.endsWith(`.${projExt}`))
   if (vsproj)
      return path.resolve(fileDir, vsproj)
   if (walkUp) {
      const parent = path.resolve(fileDir, '..')
      if (parent === fileDir)
         throw new NoVsprojError(`Reached fs root, no ${projExt} found`)
      return getPath(parent)
   }
   throw new NoVsprojError(`No ${projExt} found in current directory: ${fileDir}`)
}

export function hasFile(vsproj: Vsproj, filePath: string) {
   const filePathRel = relativeTo(vsproj, filePath)
   const project = vsproj.xml.getroot()
   const match = project.find(`./ItemGroup/*[@Include='${filePathRel}']`)
   return !!match
}

export function relativeTo(vsproj: Vsproj, filePath: string) {
   return path.relative(path.dirname(vsproj.fsPath), filePath)
      .replace(/\//g, '\\') // use Windows style paths for consistency
}

export function addFile(vsproj: Vsproj, filePath: string, itemType: string) {
   const itemGroups = vsproj.xml.getroot().findall(`./ItemGroup/${itemType}/..`)
   const itemGroup = itemGroups.length
      ? itemGroups[itemGroups.length - 1]
      : etree.SubElement(vsproj.xml.getroot(), 'ItemGroup')
   const itemElement = etree.SubElement(itemGroup, itemType)
   itemElement.set('Include', relativeTo(vsproj, filePath))
}

export function removeFile(vsproj: Vsproj, filePath: string, directory = false): boolean {
   const root = vsproj.xml.getroot()
   const filePathRel = relativeTo(vsproj, filePath)
   const itemGroups = root.findall('./ItemGroup')
   const found = itemGroups.some(itemGroup => {
      const elements = directory
         ? itemGroup.findall(`./*[@Include]`).filter(element => element.attrib['Include'].startsWith(filePathRel))
         : itemGroup.findall(`./*[@Include='${filePathRel}']`)
      for (const element of elements) {
         itemGroup.remove(element)
      }
      return elements.length > 0
   })
   return found
}

async function readFile(path: string): Promise<string> {
   return stripBom(await fs.readFile(path, 'utf8'))
}

export async function persist(vsproj: Vsproj, indent = 2) {
   const xmlString = vsproj.xml.write({ indent })

   // Add byte order mark.
   const xmlFinal = ('\ufeff' + xmlString)
      // .replace(/(?<!\r)>\n/g, '\r\n') // use CRLF
      .replace(/(\r)?(\n)+$/, '') // no newline at end of file

   await fs.chmod(vsproj.fsPath, "777");

   await fs.writeFile(vsproj.fsPath, xmlFinal)

   // Ensure that that cached XML is up-to-date
   _cacheXml[vsproj.fsPath] = vsproj.xml
}

export async function forFile(filePath: string): Promise<Vsproj> {
   const fsPath = await getPath(path.dirname(filePath))
   const name = path.basename(fsPath)
   const xml = await load(fsPath)
   return { fsPath, name, xml }
}

export function ensureValid(vsproj: Vsproj) {
   return Object.assign({}, vsproj, {
      xml: _cacheXml[vsproj.fsPath]
   })
}

async function load(vsprojPath: string) {
   if (!(vsprojPath in _cacheXml)) {
      const vsprojContent = await readFile(vsprojPath)
      _cacheXml[vsprojPath] = <XML>etree.parse(vsprojContent)
   }
   return _cacheXml[vsprojPath]
}

let _doInvalidation = true

export function invalidate(filePath: string) {
   if (_doInvalidation)
      delete _cacheXml[filePath]
}

export function invalidateAll() {
   _cacheXml = Object.create(null)
}
