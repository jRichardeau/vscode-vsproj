"use strict";

import { OutputChannel, window } from "vscode";

export class VsProjOutput {
   private static _outputChannel: OutputChannel;

   public static async CreateChannel(): Promise<OutputChannel> {
      if (VsProjOutput._outputChannel !== undefined) {
         return VsProjOutput._outputChannel;
      }

      VsProjOutput._outputChannel = window.createOutputChannel("VSPROJ");
      return VsProjOutput._outputChannel;
   }

   public static AppendLine(...args: any[]) {
      const argumentsArray = Array.from(args);
      if (VsProjOutput._outputChannel) {
         VsProjOutput._outputChannel.append(argumentsArray.join(" ") + "\n");
      }
      console.log(...argumentsArray);
   }

   public static Show() {
      if (VsProjOutput._outputChannel) {
         VsProjOutput._outputChannel.show();
      }
   }
}
