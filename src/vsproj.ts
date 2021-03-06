import * as fs from 'mz/fs'
import * as path from 'path'

import { Vsproj, XML } from './types'

const etree = require('@azz/elementtree')
const stripBom = require('strip-bom')

export class NoVsprojError extends Error { }

let _cacheXml: { [path: string]: XML } = Object.create(null)

export async function getProjPath(fileDir: string, projectFileExtension: string, rootPaths: string[], walkUp = true): Promise<string> {
   if (!path.isAbsolute(fileDir))
      fileDir = path.resolve(fileDir)

   const files = await fs.readdir(fileDir)
   const vsproj = files.find((file: any) => file.endsWith(`.${ projectFileExtension }`))
   if (vsproj)
      return path.resolve(fileDir, vsproj)
   if (walkUp) {
      const parent = path.resolve(fileDir, '..');
      if (rootPaths.indexOf(parent) >= 0 || parent === fileDir) {
         throw new NoVsprojError(`Reached fs root, no ${ projectFileExtension } found`);
      }
      return getProjPath(parent, projectFileExtension, rootPaths);
   }
   throw new NoVsprojError(`No ${ projectFileExtension } found in current directory: ${ fileDir }`)
}

export function hasFile(vsproj: Vsproj, filePath: string) {
   const filePathRel = relativeTo(vsproj, filePath)
   const project = vsproj.xml.getroot()
   const match = project.find(`./ItemGroup/*[@Include='${ filePathRel }']`)
   return !!match
}

export function relativeTo(vsproj: Vsproj, filePath: string, addFinalSlashToFolders: boolean = false) {
   let relativePath = path.relative(path.dirname(vsproj.fsPath), filePath)
      .replace(/\//g, '\\') // use Windows style paths for consistency

   if (addFinalSlashToFolders && path.extname(filePath) === '') {
      const fileName = path.basename(filePath);
      if (!fileName.startsWith(".")) {
         //Add final \ for directories
         relativePath += "\\";
      }
   }
   return relativePath;
}

export function addFile(vsproj: Vsproj, filePath: string, itemType: string) {
   const itemGroups = vsproj.xml.getroot().findall(`./ItemGroup/${ itemType }/..`)
   const itemGroup = itemGroups.length
      ? itemGroups[itemGroups.length - 1]
      : etree.SubElement(vsproj.xml.getroot(), 'ItemGroup')
   const itemElement = etree.SubElement(itemGroup, itemType)
   itemElement.set('Include', relativeTo(vsproj, filePath, true))
}

export async function removeFile(vsproj: Vsproj, filePath: string, directory = false): Promise<boolean> {
   const root = vsproj.xml.getroot();
   const filePathRel = relativeTo(vsproj, filePath);
   const itemGroups = root.findall('./ItemGroup');
   let found: boolean = false;
   itemGroups.forEach(itemGroup => {
      let elements = directory
         ? itemGroup.findall(`./*[@Include]`).filter(element => {
            return (
               //Directory itself
               element.attrib['Include'] === filePathRel ||
               //Sub directories
               element.attrib['Include'].startsWith(filePathRel + "\\")
            );
         })
         : itemGroup.findall(`./*[@Include='${ filePathRel }']`);

      for (const element of elements) {
         itemGroup.remove(element)
      }
      if (!found) {
         found = elements.length > 0;
      }
   })
   return found;
}

async function readFile(path: string): Promise<string> {
   return stripBom(await fs.readFile(path, 'utf8'))
}

function getProjFileXmlEncoding(encoding: string) {
   return encoding === "ascii" ? "Windows-1252" : "utf-8";
}

export async function persist(vsproj: Vsproj, encoding: string = "ascii", indent = 2) {
   const xmlString = vsproj.xml.write({ indent, encoding: getProjFileXmlEncoding(encoding) })

   // no newline at end of file
   const xmlFinal = (xmlString)
      .replace(/(\r)?(\n)+$/, '');
      //Error with this replace, is it usefull ?
      // .replace(/(?<!\r)>\n/g, '\r\n') // use CRLF

   //Removing Visual Studio read-only flag on this file so that we can write on it
   await fs.chmod(vsproj.fsPath, "777");

   //Explicitly synchronous to avoid concurrent writes
   fs.writeFileSync(vsproj.fsPath, xmlFinal, { encoding });

   // Ensure that that cached XML is up-to-date
   _cacheXml[vsproj.fsPath] = vsproj.xml
}

export async function getProjforFile(filePath: string, projectFileExtension: string, rootPaths: string[]): Promise<Vsproj> {
   const fsPath = await getProjPath(path.dirname(filePath), projectFileExtension, rootPaths);
   const name = path.basename(fsPath)
   const xml = await load(fsPath)
   return { fsPath, name, xml }
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
