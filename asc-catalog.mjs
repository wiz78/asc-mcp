import api from "./catalog/api.json" with { type: "json" };
import cli from "./catalog/cli.json" with { type: "json" };

export const apiCatalog = api;
export const apiOperations = new Map(api.operations.map(operation => [operation.name, {
  ...operation, mode: operation.method === "GET" ? "read" : "write"
}]));
export const knownCommands = cli.commands.map(command => ({
  category: command.category, command: command.path, mode: "read"
}));
