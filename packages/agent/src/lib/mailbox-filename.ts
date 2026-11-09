export function isMailboxMessageFile(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(".json") && !name.includes("/") && !name.includes("\\");
}
